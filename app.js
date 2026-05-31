'use strict';

// ---------- visible status overlay ----------

function errBar() {
  let bar = document.getElementById('err-bar');
  if (!bar) {
    bar = el('div', { id: 'err-bar' });
    document.body.appendChild(bar);
  }
  return bar;
}

function showError(e) {
  const bar = errBar();
  bar.style.background = '#a13030';
  const msg = e && e.stack ? e.stack : String(e);
  bar.textContent = (bar.textContent ? bar.textContent + '\n\n' : '') + msg;
}

// Transient status (sync result, DB reconnect) → a compact pill floating above
// the tabbar. Distinct from showError, which dumps multi-line stack traces into
// the full-width #err-bar that a pill can't hold.
function showBanner(msg, { variant = 'info', autoHide = 0 } = {}) {
  let pill = document.getElementById('status-pill');
  if (!pill) {
    pill = el('div', { id: 'status-pill' });
    document.body.appendChild(pill);
  }
  if (pill._hideTimer) { clearTimeout(pill._hideTimer); pill._hideTimer = null; }
  if (pill._removeTimer) { clearTimeout(pill._removeTimer); pill._removeTimer = null; }
  pill.classList.toggle('ok', variant === 'ok');
  pill.classList.toggle('info', variant !== 'ok');
  pill.textContent = msg;
  // rAF so a freshly inserted element transitions in from opacity:0 instead of
  // snapping straight to the shown state.
  requestAnimationFrame(() => pill.classList.add('show'));
  if (autoHide) {
    const snapshot = msg;
    pill._hideTimer = setTimeout(() => {
      const p = document.getElementById('status-pill');
      if (!p || p.textContent !== snapshot) return;
      p.classList.remove('show');
      p._removeTimer = setTimeout(() => {
        if (p.textContent === snapshot) p.remove();
      }, 260);
    }, autoHide);
  }
}

// WebKit drops the IndexedDB connection when the page spends time in background.
// The next DB call then fails with "Connection to Indexed Database server lost".
// Detect that specific error and route it to a soft recovery path.
function isIdbDisconnectError(e) {
  if (!e) return false;
  const name = e.name || '';
  const msg = String(e.message || e);
  if (name === 'DatabaseClosedError') return true;
  return /Connection to Indexed Database server lost/i.test(msg);
}

// ---------- DOM helper ----------

// el(tag, props?, children?) — terse element builder. Replaces the
// createElement → set className → set text → appendChild boilerplate.
//   props keys:
//     class            → className
//     text             → textContent (always treated as text, never HTML)
//     style: {...}      → Object.assign(node.style, …)
//     dataset: {...}    → Object.assign(node.dataset, …)
//     onclick/on…       → addEventListener(type, fn)
//     anything that is a DOM property (type, value, id, href, disabled…) → set as property
//     anything else (aria-*, data-*, autocorrect, role…) → setAttribute
//   children: a node / string / number, or an array of them. Null/false/undefined
//             entries are skipped, so `cond && el(…)` works inline.
// Props can be omitted: el('div', [a, b]) or el('span', 'text').
// No `html` key by design — there is no innerHTML anywhere, keep it that way.
function el(tag, props, children) {
  if (props == null || Array.isArray(props) || props instanceof Node
      || typeof props === 'string' || typeof props === 'number') {
    children = props;
    props = null;
  }
  const node = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      // Skip only null/undefined — a literal `false` is a valid value for a
      // boolean DOM property (e.g. spellcheck: false). The false-skip applies
      // to children below, where `cond && el(...)` is the conditional idiom.
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        // setProperty (not assignment) for CSS custom props (--x); plain props otherwise.
        for (const sk in v) {
          if (sk.startsWith('--')) node.style.setProperty(sk, v[sk]);
          else node.style[sk] = v[sk];
        }
      }
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
  }
  if (children != null) {
    for (const c of (Array.isArray(children) ? children : [children])) {
      if (c == null || c === false) continue;
      node.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    }
  }
  return node;
}

async function handleGlobalError(rawErr, ev) {
  if (isIdbDisconnectError(rawErr)) {
    ev?.preventDefault?.();
    await recoverDb();
    return;
  }
  showError(rawErr);
}
window.addEventListener('error', (e) => handleGlobalError(e.error || e.message, e));
window.addEventListener('unhandledrejection', (e) => handleGlobalError(e.reason || e, e));

// ---------- DB ----------

const db = new Dexie('tasks-v1');

db.version(1).stores({
  tasks: '++id, done_at, created_at',
});
db.version(2).stores({
  tasks: '++id, done_at, created_at, track_id',
  tracks: '++id, category',
});
db.version(3).stores({
  tasks: '++id, done_at, created_at, track_id',
  tracks: '++id, category, last_used_at',
}).upgrade(async tx => {
  const tasks = await tx.table('tasks').toArray();
  const lastUsed = new Map();
  for (const t of tasks) {
    if (!t.track_id) continue;
    const cur = lastUsed.get(t.track_id) || 0;
    if (t.created_at > cur) lastUsed.set(t.track_id, t.created_at);
  }
  await tx.table('tracks').toCollection().modify(track => {
    track.last_used_at = lastUsed.get(track.id) ?? track.created_at ?? 0;
  });
});
// v4: wiki sync — external_id (correlation), updated_at (last-write-wins),
// deleted_at (soft-delete tombstone, propagated to wiki on next sync).
db.version(4).stores({
  tasks: '++id, done_at, created_at, track_id, external_id, deleted_at',
  tracks: '++id, category, last_used_at',
}).upgrade(async tx => {
  await tx.table('tasks').toCollection().modify(t => {
    if (t.updated_at == null) t.updated_at = t.created_at || Date.now();
    if (t.deleted_at == null) t.deleted_at = 0;
  });
});

// True while syncWithWiki is applying inbound changes to db.tasks. The mutation
// hooks check it so a sync's own writes don't schedule another push → no loop.
let syncWriting = false;

// Auto-bump updated_at on every task mutation. Sync code passes an explicit
// updated_at to skip the bump (so inbound merges don't loop back as outbound
// changes on the next sync). User-driven mutations (syncWriting === false) also
// schedule a debounced push so local edits propagate to the wiki without a
// manual sync.
db.tasks.hook('creating', (_primKey, obj) => {
  if (obj.updated_at == null) obj.updated_at = Date.now();
  if (obj.deleted_at == null) obj.deleted_at = 0;
  if (!syncWriting) scheduleSyncPush();
});
db.tasks.hook('updating', (mods) => {
  if (!syncWriting) scheduleSyncPush();
  if (!('updated_at' in mods)) {
    return { ...mods, updated_at: Date.now() };
  }
  return mods;
});

async function ensureDbOpen() {
  if (db.isOpen()) return;
  await db.open();
}

let recovering = false;
async function recoverDb() {
  if (recovering) return;
  recovering = true;
  showBanner('Переподключение к базе…');
  try {
    try { db.close(); } catch {}
    await db.open();
    showBanner('База снова на связи.', { variant: 'ok', autoHide: 2500 });
    // Refresh the visible page — DOM was likely showing stale data from the
    // dropped connection, and the user shouldn't have to "повтори действие"
    // just to see the world again.
    renderMain().catch(() => {});
  } catch (e) {
    showError(e);
  } finally {
    recovering = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ensureDbOpen().catch(() => {});
});
window.addEventListener('pageshow', () => { ensureDbOpen().catch(() => {}); });

// ---------- data ops ----------

// Soft-deleted tasks are kept in the table as tombstones for sync but excluded
// from every UI read path. Once sync confirms the deletion has propagated to
// wiki, a future cleanup job can prune old tombstones.
const isLive = t => !t.deleted_at;

async function listActive() {
  const arr = await db.tasks.where('done_at').equals(0).filter(isLive).toArray();
  arr.sort((a, b) => {
    const ad = a.deadline || '';
    const bd = b.deadline || '';
    if (ad && bd) {
      if (ad !== bd) return ad < bd ? -1 : 1;
    } else if (ad) {
      return -1;
    } else if (bd) {
      return 1;
    }
    return b.created_at - a.created_at;
  });
  return arr;
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------- stuck/fresh classification for Today screen ----------

const STUCK_HOUR = 16;

// Pure: is task currently stuck given a specific moment?
// stuck = deadline < today
//      OR (deadline = today AND now >= 16:00 AND not engaged today)
// "Engaged today" (updated_at >= start of today) means the task was created,
// edited, or had its deadline shifted onto today *today* — it just got placed
// here, so give it grace until end of day instead of nagging it as stuck.
function isStuckNow(task, now = new Date()) {
  if (!task.deadline) return false;
  const today = todayISO();
  if (task.deadline < today) return true;
  if (task.deadline === today && now.getHours() >= STUCK_HOUR) {
    if ((task.updated_at || task.created_at) >= startOfTodayMs()) return false;
    return true;
  }
  return false;
}

// fresh = deadline = today AND (now < 16:00 OR engaged today)
function isFreshForToday(task, now = new Date()) {
  if (!task.deadline) return false;
  const today = todayISO();
  if (task.deadline !== today) return false;
  if (now.getHours() < STUCK_HOUR) return true;
  if ((task.updated_at || task.created_at) >= startOfTodayMs()) return true;
  return false;
}

function daysBetweenIso(fromIso, toIso) {
  // Use UTC math: local-time subtraction breaks by ±1h on DST transitions
  // and Math.round usually saves us, but UTC removes the failure mode entirely.
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

// Pure derivations from a pre-loaded active list — renderToday calls listActive
// once and feeds the result through these instead of re-scanning the table per
// section.

function stuckFromActive(active, now = new Date()) {
  return active.filter(t => isStuckNow(t, now))
    .sort((a, b) => {
      // Oldest deadline first (most overdue on top).
      const ad = a.deadline || '9999-12-31';
      const bd = b.deadline || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.created_at - b.created_at;
    });
}

function freshFromActive(active, now = new Date()) {
  return active.filter(t => isFreshForToday(t, now))
    .sort((a, b) => a.created_at - b.created_at);
}

async function listJournal() {
  const start = startOfTodayMs();
  const arr = await db.tasks
    .where('done_at').above(0)
    .filter(t => isLive(t) && t.done_at >= start)
    .toArray();
  arr.sort((a, b) => b.done_at - a.done_at);
  return arr;
}

async function listAllDone() {
  const arr = await db.tasks.where('done_at').above(0).filter(isLive).toArray();
  arr.sort((a, b) => b.done_at - a.done_at);
  return arr;
}

async function deleteAllDone() {
  // Soft-delete so wiki sync propagates the removal. Hook bumps updated_at.
  const now = Date.now();
  await db.tasks.where('done_at').above(0).modify({ deleted_at: now });
}

function dayKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ts) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'СЕГОДНЯ';
  if (diff === 1) return 'ВЧЕРА';
  const weekdays = ['ВС','ПН','ВТ','СР','ЧТ','ПТ','СБ'];
  const wd = weekdays[d.getDay()];
  const short = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    .replace('.', '').toUpperCase();
  return `${wd} · ${short}`;
}

function groupByDay(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const k = dayKey(t.done_at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()].map(([ts, items]) => ({ ts, label: dayLabel(ts), tasks: items }));
}

async function markDone(id) {
  await db.tasks.update(id, { done_at: Date.now() });
}

async function undoDone(id) {
  await db.tasks.update(id, { done_at: 0 });
}

// ---------- tracks ----------

async function listTracks() {
  const arr = await db.tracks.toArray();
  arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return arr;
}

// Sort by last_used_at desc — drives the chip row in the task sheet so the
// track you just used floats to the front. Fallback to created_at then 0
// keeps pre-migration tracks ordered sensibly. Stable tiebreaker on id keeps
// the chip order from flickering when two tracks share a timestamp (common
// just after the v3 backfill, where last_used_at = created_at and several
// tracks were created in the same ms).
async function listTracksByRecency() {
  const arr = await db.tracks.toArray();
  arr.sort((a, b) => {
    const tsA = a.last_used_at ?? a.created_at ?? 0;
    const tsB = b.last_used_at ?? b.created_at ?? 0;
    if (tsA !== tsB) return tsB - tsA;
    return b.id - a.id;
  });
  return arr;
}

async function addTrack({ name, icon, category = 'personal' }) {
  const all = await db.tracks.toArray();
  const maxPos = all.reduce((m, t) => Math.max(m, t.position ?? 0), 0);
  const now = Date.now();
  return db.tracks.add({
    name: name.trim(),
    icon: icon || DEFAULT_ICON,
    category,
    position: maxPos + 1,
    created_at: now,
    last_used_at: now,
  });
}

async function deleteTrack(id) {
  await db.transaction('rw', db.tracks, db.tasks, async () => {
    await db.tracks.delete(id);
    // Bulk-clear track_id on all linked tasks in one collection-modify pass
    // instead of N individual updates.
    await db.tasks.where('track_id').equals(id).modify({ track_id: null });
  });
}

async function updateTrack(id, patch) {
  await db.tracks.update(id, patch);
}

// Progress per track = done / (done + active) over the track's lifetime.
// Single-scan version: one toArray over tasks, group by track_id. Replaces an
// N+1 pattern (trackStats per track) on the Tracks page.
async function trackStatsAll() {
  const tasks = await db.tasks.filter(isLive).toArray();
  const stats = new Map();
  for (const t of tasks) {
    if (!t.track_id) continue;
    let s = stats.get(t.track_id);
    if (!s) { s = { done: 0, total: 0 }; stats.set(t.track_id, s); }
    s.total += 1;
    if (t.done_at) s.done += 1;
  }
  return stats;
}

async function listTasksByTrack(trackId) {
  return db.tasks.where('track_id').equals(trackId).filter(isLive).toArray();
}

// Active tasks with no track. Dexie indexes don't include null/undefined,
// so we pull active and filter in JS — fine for the small dataset.
async function listUnassignedActive() {
  const active = await db.tasks.where('done_at').equals(0).filter(isLive).toArray();
  return active.filter(t => !t.track_id).sort((a, b) => b.created_at - a.created_at);
}

const TRACK_CATEGORIES = ['work', 'personal', 'inactive'];
const TRACK_CATEGORY_LABELS = { work: 'Работа', personal: 'Личное', inactive: 'Неактивные' };

// ---------- render ----------

const DEFAULT_ICON = 'circle-dashed';

// Match task text against config/icons.js ICON_KEYWORDS. Returns up to `limit`
// unique icon names. Matching: per-word (min length 2), exact first, then
// prefix either way (word starts with keyword, or keyword starts with word)
// so simple stems work without listing every inflection.
function matchIcons(text, limit = 8) {
  if (!text || typeof ICON_KEYWORDS === 'undefined') return [];
  const words = (text.toLowerCase().match(/\p{L}+/gu) || []).filter(w => w.length >= 2);
  const out = [];
  const seen = new Set();
  const add = (icon) => {
    if (!icon || seen.has(icon)) return;
    seen.add(icon);
    out.push(icon);
  };
  for (const word of words) {
    if (out.length >= limit) break;
    if (ICON_KEYWORDS[word]) { add(ICON_KEYWORDS[word]); continue; }
    for (const kw in ICON_KEYWORDS) {
      if (word === kw) continue;
      if (word.startsWith(kw) || (kw.length >= 3 && kw.startsWith(word) && word.length >= 2)) {
        add(ICON_KEYWORDS[kw]);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

// Icon row = iPhone emoji keyboard pattern:
//   slot 0 = prediction from text (only if it differs from current pick —
//     otherwise it's already in the icon-box, no point duplicating),
//   rest   = MRU recents, then curated fallback to always fill 8 slots.
// Tap = apply + push to recents. No selected/toggle state: the icon-box
// beside the input is the single source of truth for the current pick.
const ICON_ROW_SIZE = 20;
const RECENTS_KEY = 'tasks.recentIcons';
const RECENTS_MAX = 24;

function getRecentIcons() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

function pushRecentIcon(name) {
  if (!name) return;
  const cur = getRecentIcons().filter(x => x !== name);
  cur.unshift(name);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(cur.slice(0, RECENTS_MAX))); } catch {}
}

function buildIconRow(text, currentIcon) {
  const predicted = matchIcons(text, 1)[0] || null;
  const showPrediction = predicted && predicted !== currentIcon;

  const slots = [];
  const seen = new Set();
  const push = (name, kind) => {
    if (!name || seen.has(name)) return false;
    seen.add(name);
    slots.push({ icon: name, kind });
    return true;
  };

  if (showPrediction) push(predicted, 'prediction');

  getRecentIcons().forEach(n => {
    if (slots.length >= ICON_ROW_SIZE) return;
    push(n, 'recent');
  });

  const defaults = (typeof CURATED_FULL !== 'undefined' ? CURATED_FULL : [DEFAULT_ICON]);
  for (const n of defaults) {
    if (slots.length >= ICON_ROW_SIZE) break;
    push(n, 'default');
  }

  return slots.slice(0, ICON_ROW_SIZE);
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TODAY_FILTER_KEY = 'tasks.today_filter';
function isTodayFilterOn() {
  return localStorage.getItem(TODAY_FILTER_KEY) === '1';
}
function setTodayFilter(on) {
  localStorage.setItem(TODAY_FILTER_KEY, on ? '1' : '0');
}
// Filter to today+overdue: deadline set AND deadline <= today.
// No-date tasks hidden (per design 2026-05-27).
function filterTodayOverdue(tasks) {
  const today = todayISO();
  return tasks.filter(t => t.deadline && t.deadline <= today);
}

function iconNode(name) {
  return el('i', { class: 'icon', 'data-lucide': name || DEFAULT_ICON });
}

function renderLucide() {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }
}

function attachLongPress(node, { onLongPress, onTap, ms = 500 }) {
  let timer = null;
  let firedLong = false;
  let moved = false;
  let pressed = false;
  let startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  node.addEventListener('pointerdown', (e) => {
    pressed = true;
    firedLong = false;
    moved = false;
    startX = e.clientX; startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      firedLong = true;
      timer = null;
      if (navigator.vibrate) navigator.vibrate(10);
      onLongPress?.(e);
    }, ms);
  });
  node.addEventListener('pointermove', (e) => {
    if (!pressed) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (dx*dx + dy*dy > 100) {
      moved = true;
      cancel();
    }
  });
  node.addEventListener('pointerup', (e) => {
    if (!pressed) return;
    const wasLong = firedLong;
    const wasMoved = moved;
    pressed = false;
    cancel();
    if (!wasLong && !wasMoved) onTap?.(e);
  });
  const bail = () => { pressed = false; cancel(); };
  node.addEventListener('pointercancel', bail);
  node.addEventListener('pointerleave', bail);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
}

function pluralizeDays(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

function formatDeadline(isoDate) {
  if (!isoDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d)) return null;
  const diffDays = Math.round((d - today) / 86400000);
  if (diffDays === 0) return { text: 'сегодня', kind: 'today' };
  if (diffDays === -1) return { text: 'вчера', kind: 'overdue' };
  if (diffDays < -1 && diffDays >= -14) {
    const n = -diffDays;
    return { text: '−' + n + ' ' + pluralizeDays(n), kind: 'overdue' };
  }
  const short = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  return { text: short, kind: diffDays < 0 ? 'overdue' : 'future' };
}

function groupByTrack(list, tracksById) {
  const map = new Map();
  for (const t of list) {
    const key = t.track_id || 'none';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  const groups = [];
  for (const [key, tasks] of map) {
    const track = key === 'none' ? null : (tracksById.get(key) || null);
    let newest = 0;
    for (const t of tasks) {
      if (t.created_at && t.created_at > newest) newest = t.created_at;
    }
    groups.push({ track, tasks, newest });
  }
  // Порядок треков = position со страницы Треки (детерминированно, один-в-один
  // с тем, как ты их расставил драг-дропом). «Без трека» — в конец. Свежесть
  // больше НЕ двигает порядок — она подсвечивает иконку (см. trackSubsectionNode);
  // newest оставлен только как стабильный тай-брейк при равных position.
  groups.sort((a, b) => {
    const pa = a.track ? (a.track.position ?? Infinity) : Infinity;
    const pb = b.track ? (b.track.position ?? Infinity) : Infinity;
    if (pa !== pb) return pa - pb;
    return b.newest - a.newest;
  });
  return groups;
}

// Окно подсветки иконки трека после добавления задачи. Тентативно 5 мин —
// крутится одной константой. По истечении гаснет (таймер в trackSubsectionNode).
const FRESH_TRACK_MS = 5 * 60 * 1000;

// Порядок категорий на экране «Сегодня». View-preference в localStorage
// (per-device, как collapse-состояния). Дефолт — Личное сверху (как было).
function workFirst() {
  return localStorage.getItem('tasks_work_first') === '1';
}

function trackSubsectionNode(track, tasks, tracksById) {
  const collapseKey = `tasks_morning_collapsed_track_${track ? track.id : 'null'}`;

  const chev = iconNode('chevron-down');
  chev.classList.add('track-subsection-chevron');

  // Свежесть: трек, в который только что (< FRESH_TRACK_MS) упала задача,
  // временно подсвечивает иконку. Класс на стабильном span (а не на самой
  // иконке) — lucide заменяет <i> на <svg>, ссылка бы протухла; CSS красит
  // иконку через потомка. Таймер снимает класс на живом узле по истечении окна.
  const nameSpan = el('span', { class: 'track-subsection-name' }, [
    iconNode(track ? (track.icon || DEFAULT_ICON) : 'circle-dashed'),
    el('span', { text: track ? track.name : 'Без трека' }),
  ]);
  if (track) {
    let newest = 0;
    for (const t of tasks) if (t.created_at && t.created_at > newest) newest = t.created_at;
    const age = Date.now() - newest;
    if (newest && age < FRESH_TRACK_MS) {
      nameSpan.classList.add('fresh');
      setTimeout(() => nameSpan.classList.remove('fresh'), FRESH_TRACK_MS - age);
    }
  }

  const sub = el('div', {
    class: 'track-subsection',
    dataset: { trackId: track ? String(track.id) : 'null' },
  }, [
    el('div', { class: 'track-subsection-header' }, [
      el('button', {
        type: 'button', class: 'track-subsection-toggle',
        onclick: () => {
          const next = !sub.classList.contains('collapsed');
          sub.classList.toggle('collapsed', next);
          localStorage.setItem(collapseKey, next ? '1' : '0');
          sub.dispatchEvent(new CustomEvent('track-collapse-changed', { bubbles: true }));
        },
      }, [
        chev,
        nameSpan,
        el('span', { class: 'track-subsection-counter', text: String(tasks.length) }),
      ]),
      el('button', {
        type: 'button', class: 'track-subsection-add',
        'aria-label': `Новая задача${track ? ` в «${track.name}»` : ''}`,
        onclick: (e) => {
          e.stopPropagation();
          openSheet({ task: null, presetTrackId: track ? track.id : null });
        },
      }, [iconNode('plus')]),
    ]),
    el('div', { class: 'grid' }, tasks.map(t => activeCardNode(t, tracksById, { hideTrack: true }))),
  ]);

  if (localStorage.getItem(collapseKey) === '1') sub.classList.add('collapsed');
  return sub;
}

function cardBase(task, tracksById, opts) {
  opts = opts || {};
  const iconRow = el('div', { class: 'icon-row' }, [iconNode(task.icon)]);
  if (task.notes && task.notes.trim()) {
    iconRow.append(el('div', { class: 'notes-mark' }, [iconNode('notebook-pen')]));
  }

  const fmt = formatDeadline(task.deadline);
  const track = task.track_id && tracksById ? tracksById.get(task.track_id) : null;

  return el('div', { class: 'card', dataset: { id: String(task.id) } }, [
    iconRow,
    fmt && el('div', { class: 'deadline ' + fmt.kind, text: fmt.text }),
    el('div', { class: 'text', text: task.text }),
    (track && !opts.hideTrack) && el('div', { class: 'track-mark' }, [
      iconNode(track.icon || DEFAULT_ICON),
      el('span', { class: 'name', text: track.name }),
    ]),
  ]);
}

function playStampImpact(cardEl, task) {
  return new Promise(resolve => {
    const finalRot = ((task.id * 13) % 15) - 7;
    cardEl.append(el('div', { class: 'stamp-shockwave' }));
    cardEl.append(el('div', {
      class: 'stamp-badge', style: { '--final-rot': finalRot + 'deg' },
    }, [checkBadgeSvg()]));
    cardEl.classList.add('stamping');
    setTimeout(() => resolve(), 280);
  });
}

function activeCardNode(task, tracksById, opts) {
  const card = cardBase(task, tracksById, opts);
  attachLongPress(card, {
    onTap: () => openSheet({ task }),
    onLongPress: async () => {
      if (card.classList.contains('stamping') || card.classList.contains('removing')) return;
      try {
        await playStampImpact(card, task);
        await markDone(task.id);
        showUndoSnackbar(task.id);
        setTimeout(() => { renderMain().catch(showError); }, 60);
      } catch (e) {
        card.classList.remove('stamping');
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
  });
  return card;
}

// ---------- undo snackbar ----------

let snackbarTimer = null;
let editingBlockerTaskId = null;
let splittingTaskId = null;

function showSnackbar({ label: labelText, onUndo }) {
  if (snackbarTimer) { clearTimeout(snackbarTimer); snackbarTimer = null; }
  document.querySelectorAll('.snackbar').forEach(n => n.remove());

  const sb = el('div', { class: 'snackbar' }, [
    el('span', { class: 'snackbar-label', text: labelText }),
    el('button', {
      type: 'button', class: 'snackbar-action', text: 'Отменить',
      onclick: async () => {
        if (snackbarTimer) { clearTimeout(snackbarTimer); snackbarTimer = null; }
        sb.classList.remove('open');
        try {
          await onUndo();
        } catch (e) {
          if (isIdbDisconnectError(e)) { await recoverDb(); return; }
          showError(e);
        } finally {
          setTimeout(() => sb.remove(), 200);
        }
      },
    }),
  ]);
  document.body.appendChild(sb);
  requestAnimationFrame(() => sb.classList.add('open'));

  snackbarTimer = setTimeout(() => {
    sb.classList.remove('open');
    setTimeout(() => sb.remove(), 220);
    snackbarTimer = null;
  }, 4000);
}

function showUndoSnackbar(taskId) {
  showSnackbar({
    label: 'Задача выполнена',
    onUndo: async () => {
      await undoDone(taskId);
      await renderMain();
    },
  });
}

async function commitMoveDeadline(task, next) {
  if (!next || next === task.deadline) return;
  const prev = task.deadline || null;
  try {
    await db.tasks.update(task.id, { deadline: next });
    showSnackbar({
      label: 'Перенесено',
      onUndo: async () => {
        await db.tasks.update(task.id, { deadline: prev });
        await renderMain();
      },
    });
    await renderMain();
  } catch (e) {
    if (isIdbDisconnectError(e)) { await recoverDb(); return; }
    showError(e);
  }
}

function checkBadgeSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', '20 6 9 17 4 12');
  svg.appendChild(poly);
  return svg;
}

// Shared builder for done-cards. Used by the Morning journal grid (with the
// `removing` guard so a held-down card can't fire undoDone twice) and by the
// History sheet (passes its own onTap/onLongPress).
function doneCardNode(task, tracksById, { onTap, onLongPress }) {
  const card = cardBase(task, tracksById);
  card.classList.add('done');
  const rot = ((task.id * 13) % 15) - 7; // deterministic -7..+7, stable across re-renders
  card.append(el('div', { class: 'check-badge', style: { '--rot': rot + 'deg' } }, [checkBadgeSvg()]));
  attachLongPress(card, { onTap, onLongPress });
  return card;
}

function journalCardNode(task, tracksById) {
  let card;
  card = doneCardNode(task, tracksById, {
    onTap: () => openSheet({ task }),
    onLongPress: async () => {
      if (card.classList.contains('removing')) return;
      card.classList.add('removing');
      try {
        await undoDone(task.id);
        setTimeout(() => { renderMain().catch(showError); }, 200);
      } catch (e) {
        card.classList.remove('removing');
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
  });
  return card;
}

// ---------- pager (Сегодня ↔ Morning ↔ Calendar ↔ Tracks) ----------

const PAGE_COUNT = 4;
const PAGE_WIDTH_PCT = 100 / PAGE_COUNT; // 25
let currentPage = 1; // 0 = сегодня, 1 = morning (default), 2 = calendar, 3 = tracks
let pagerEl = null;
let tabbarEl = null;
let plusBtnEl = null;

// Dirty-tracking — invalidatePages() marks all four as needing a refresh, but
// only the visible page is rendered immediately. Off-screen pages are
// re-rendered lazily when the user swipes to them. Cuts work after every
// task mutation from "render 4 pages" to "render 1 page now + 0..3 later".
const pagesDirty = [false, false, false, false];

async function renderPage(idx) {
  pagesDirty[idx] = false;
  switch (idx) {
    case 0: return renderToday();
    case 1: return renderMorning();
    case 2: return renderCalendar();
    case 3: return renderTracks();
  }
}

async function renderApp() {
  const root = document.getElementById('app');
  root.replaceChildren();
  root.classList.add('app-root');

  pagerEl = el('div', { class: 'pager' }, [
    el('section', { class: 'page page-today' }),
    el('section', { class: 'page page-morning' }),
    el('section', { class: 'page page-calendar' }),
    el('section', { class: 'page page-tracks' }),
  ]);
  root.appendChild(pagerEl);

  // Floating tabbar (Liquid Glass capsule + coral plus button) — sits above
  // the pager, doesn't move on swipe. Plus is shown only on Tasks/Tracks
  // pages where adding makes sense; on read-only pages (Today/Calendar) it
  // fades out, capsule stays put for muscle memory.
  tabbarEl = tabbarNode();
  root.appendChild(tabbarEl);

  plusBtnEl = plusBtnNode();
  root.appendChild(plusBtnEl);

  attachPagerSwipe(pagerEl);
  // Render only the initial page; mark the rest as dirty so they refresh on
  // first swipe-in. Boot is faster, off-screen DOM is tiny until needed.
  for (let i = 0; i < PAGE_COUNT; i++) pagesDirty[i] = i !== currentPage;
  await renderPage(currentPage);
  setPage(currentPage, false);
}

function setPage(idx, animate = true) {
  currentPage = Math.max(0, Math.min(PAGE_COUNT - 1, idx));
  if (!animate) pagerEl.classList.add('no-anim');
  pagerEl.style.transform = `translateX(${-currentPage * PAGE_WIDTH_PCT}%)`;
  if (!animate) requestAnimationFrame(() => pagerEl.classList.remove('no-anim'));
  updateTabbarActive();
  updatePlusButton();
  // Defer destination-page render past the transform commit. Without this,
  // a dirty page rebuilds DOM on the same tick as the swipe transform,
  // blocking paint and stretching tab tap → motion to ~1s.
  if (pagesDirty[currentPage]) {
    requestAnimationFrame(() => {
      renderPage(currentPage).catch(showError);
    });
  } else if (currentPage === 2) {
    // Calendar always opens with today as the leftmost visible column. Skip
    // when we just rendered (renderCalendar handles the scroll itself).
    requestAnimationFrame(scrollCalendarToToday);
  }
}

const TABBAR_TABS = [
  { idx: 0, icon: 'sun',       label: 'Сегодня' },
  { idx: 1, icon: 'list-todo', label: 'Задачи' },
  { idx: 2, icon: 'calendar',  label: 'План' },
  { idx: 3, icon: 'target',    label: 'Треки' },
];

function tabbarNode() {
  const wrap = el('div', { class: 'tabbar-capsule', 'data-no-swipe': '' },
    TABBAR_TABS.map(t => el('button', {
      type: 'button',
      class: 'tabbar-tab' + (t.idx === currentPage ? ' active' : ''),
      dataset: { page: String(t.idx) },
      onpointerdown: () => setPage(t.idx),
    }, [iconNode(t.icon), el('span', { text: t.label })])),
  );
  renderLucide();
  return wrap;
}

function todaySegmentedNode(counts = {}) {
  const on = isTodayFilterOn();
  const countFor = { all: counts.all, today: counts.today };
  return el('div', { class: 'today-segmented', 'data-no-swipe': '' },
    [['all', 'Все'], ['today', 'Сегодня']].map(([val, label]) => {
      const isActive = (val === 'today') === on;
      const n = countFor[val];
      return el('button', {
        type: 'button',
        class: 'today-seg-btn' + (isActive ? ' active' : ''),
        onclick: () => {
          const want = val === 'today';
          if (want === isTodayFilterOn()) return;
          setTodayFilter(want);
          renderMain().catch(showError);
        },
      }, [
        el('span', { text: label }),
        (typeof n === 'number') && el('span', { class: 'today-seg-count', text: String(n) }),
      ]);
    }),
  );
}

function plusBtnNode() {
  const btn = el('button', {
    type: 'button', class: 'tabbar-plus', 'data-no-swipe': '',
    onclick: () => {
      if (currentPage === 3) openTrackSheet({ track: null });
      else openSheet({ task: null });
    },
  }, [iconNode('plus')]);
  renderLucide();
  return btn;
}

function updateTabbarActive() {
  if (!tabbarEl) return;
  tabbarEl.querySelectorAll('.tabbar-tab').forEach(t => {
    t.classList.toggle('active', Number(t.dataset.page) === currentPage);
  });
}

function updatePlusButton() {
  if (!plusBtnEl) return;
  plusBtnEl.classList.add('visible');
}

function sectionDivider(label, opts) {
  const d = el('div', { class: 'divider' + (label ? '' : ' plain') },
    label ? [el('span', { class: 'divider-label', text: label })] : []);
  if (opts?.link) {
    d.classList.add('has-link');
    d.append(
      el('span', { class: 'divider-line' }),
      el('span', {
        class: 'divider-link', text: opts.link.text,
        onclick: (e) => { e.stopPropagation(); opts.link.onClick(); },
      }),
    );
  }
  return d;
}

// Horizontal swipe between pages. A move is considered a swipe only if the
// pointer moves horizontally > vertically past a small threshold, so vertical
// scroll inside a page is never hijacked. Drag handles on track strips
// stopPropagation to own their gestures.
function attachPagerSwipe(node) {
  let startX = 0, startY = 0, dragging = false, active = false, baseTx = 0;
  let multiTouch = false;
  // Lock the gesture to the first pointerId so a second finger landing
  // mid-swipe can't overwrite startX/baseTx and produce a wild dx at end.
  let trackingId = null;
  // Remember the dominant direction during drag, so a final stray sample
  // (palec slightly bouncing back) can't flip the chosen page.
  let maxRight = 0, maxLeft = 0;
  const W = () => window.innerWidth;

  node.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      multiTouch = true;
      if (active) {
        active = false;
        if (dragging) {
          dragging = false;
          node.classList.remove('dragging');
          node.style.transform = `translateX(${-currentPage * PAGE_WIDTH_PCT}%)`;
        }
      }
    }
  }, { passive: true });
  const releaseMulti = (e) => { if (e.touches.length === 0) multiTouch = false; };
  node.addEventListener('touchend', releaseMulti, { passive: true });
  node.addEventListener('touchcancel', releaseMulti, { passive: true });

  node.addEventListener('pointerdown', (e) => {
    if (multiTouch) return;
    if (e.target.closest('[data-no-swipe]')) return;
    if (trackingId !== null) return;
    trackingId = e.pointerId;
    try { node.setPointerCapture(e.pointerId); } catch {}
    active = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    maxRight = 0;
    maxLeft = 0;
    baseTx = -currentPage * W();
  });
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== trackingId) return;
    if (multiTouch) { active = false; return; }
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.3) {
        dragging = true;
        node.classList.add('dragging');
      } else {
        active = false;
        return;
      }
    }
    if (dx > maxRight) maxRight = dx;
    if (-dx > maxLeft) maxLeft = -dx;
    let tx = baseTx + dx;
    const maxTx = 0;
    const minTx = -W() * (PAGE_COUNT - 1);
    if (tx > maxTx) tx = maxTx + (tx - maxTx) * 0.3;
    if (tx < minTx) tx = minTx + (tx - minTx) * 0.3;
    node.style.transform = `translateX(${tx}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== trackingId) return;
    trackingId = null;
    try { node.releasePointerCapture(e.pointerId); } catch {}
    if (!active) return;
    active = false;
    if (!dragging) return;
    node.classList.remove('dragging');
    const dxFinal = e.clientX - startX;
    const threshold = W() * 0.2;
    // Pick page based on the dominant direction during the gesture, not
    // just the final sample. If the user dragged 80px right then bounced
    // back 5px, the choice should still be "right".
    let next = currentPage;
    const dominant = maxRight > maxLeft ? maxRight : -maxLeft;
    const decisive = Math.abs(dominant) > threshold ? dominant : dxFinal;
    if (decisive < -threshold && currentPage < PAGE_COUNT - 1) next = currentPage + 1;
    else if (decisive > threshold && currentPage > 0) next = currentPage - 1;
    node.style.transform = '';
    setPage(next, true);
    dragging = false;
  };
  node.addEventListener('pointerup', end);
  // pointercancel fires when the OS hijacks the gesture — its clientX is
  // not trustworthy, so snap back rather than computing dx.
  node.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== trackingId) return;
    trackingId = null;
    try { node.releasePointerCapture(e.pointerId); } catch {}
    if (!active) return;
    active = false;
    if (!dragging) return;
    dragging = false;
    node.classList.remove('dragging');
    node.style.transform = '';
    setPage(currentPage, true);
  });
  node.addEventListener('pointerleave', (e) => {
    if (e.pointerId !== trackingId) return;
    if (active && dragging) end(e);
  });
}

// ---------- render: Morning (main) ----------

async function renderMorning() {
  const page = document.querySelector('.page-morning');
  if (!page) return;
  page.replaceChildren();

  const [active, journal, tracks] = await Promise.all([listActive(), listJournal(), listTracks()]);
  const tracksById = new Map(tracks.map(t => [t.id, t]));

  const todayFilter = isTodayFilterOn();
  const todayList = filterTodayOverdue(active);
  const visible = todayFilter ? todayList : active;

  const screen = el('div', { class: 'screen' });
  const topRegion = el('div', { class: 'top-region' });

  const collapseAll = el('button', { type: 'button', class: 'header-collapse-all' });
  const gear = el('button', {
    type: 'button', class: 'header-gear', 'aria-label': 'Настройки',
    onclick: () => openSettings(),
  }, [iconNode('settings')]);

  topRegion.append(el('div', { class: 'header', 'data-no-swipe': '' }, [
    el('div', { class: 'header-row' }, [
      el('h1', { text: 'Задачи' }),
      todaySegmentedNode({ all: active.length, today: todayList.length }),
      collapseAll,
      gear,
    ]),
  ]));

  let wrap = null;

  if (visible.length === 0) {
    topRegion.append(el('div', {
      class: 'empty',
      text: (todayFilter && active.length > 0)
        ? 'На сегодня и в просрочке — пусто.'
        : 'Пока пусто. Добавь первую задачу снизу.',
    }));
  } else {
    const buckets = { work: [], personal: [], rest: [] };
    visible.forEach(t => {
      const track = t.track_id ? tracksById.get(t.track_id) : null;
      if (track && track.category === 'work') buckets.work.push(t);
      else if (track && track.category === 'personal') buckets.personal.push(t);
      else buckets.rest.push(t);
    });
    const nonEmpty = ['personal', 'work', 'rest'].filter(k => buckets[k].length > 0);

    wrap = el('div', { class: 'active-grouped' });
    const showCategoryDividers = nonEmpty.length >= 2;
    const catSections = workFirst()
      ? [{ key: 'work', label: 'РАБОТА' }, { key: 'personal', label: 'ЛИЧНОЕ' }]
      : [{ key: 'personal', label: 'ЛИЧНОЕ' }, { key: 'work', label: 'РАБОТА' }];
    const sections = [...catSections, { key: 'rest', label: null }];
    for (const { key, label } of sections) {
      const list = buckets[key];
      if (!list.length) continue;
      if (showCategoryDividers && label) wrap.append(sectionDivider(label));
      for (const group of groupByTrack(list, tracksById)) {
        wrap.append(trackSubsectionNode(group.track, group.tasks, tracksById));
      }
    }
    topRegion.append(wrap);
  }

  const updateCollapseAllIcon = () => {
    if (!wrap) { collapseAll.style.display = 'none'; return; }
    const subs = wrap.querySelectorAll('.track-subsection');
    if (!subs.length) { collapseAll.style.display = 'none'; return; }
    collapseAll.style.display = '';
    const hasExpanded = Array.from(subs).some(s => !s.classList.contains('collapsed'));
    collapseAll.replaceChildren(iconNode(hasExpanded ? 'chevrons-down-up' : 'chevrons-up-down'));
    collapseAll.setAttribute('aria-label', hasExpanded ? 'Свернуть все' : 'Развернуть все');
    renderLucide();
  };
  collapseAll.addEventListener('click', () => {
    if (!wrap) return;
    const subs = wrap.querySelectorAll('.track-subsection');
    const targetCollapsed = Array.from(subs).some(s => !s.classList.contains('collapsed'));
    for (const s of subs) {
      s.classList.toggle('collapsed', targetCollapsed);
      const key = `tasks_morning_collapsed_track_${s.dataset.trackId}`;
      localStorage.setItem(key, targetCollapsed ? '1' : '0');
    }
    updateCollapseAllIcon();
  });
  if (wrap) wrap.addEventListener('track-collapse-changed', updateCollapseAllIcon);
  updateCollapseAllIcon();

  screen.appendChild(topRegion);

  if (journal.length > 0) {
    screen.append(sectionDivider('ЖУРНАЛ', {
      link: { text: 'Весь журнал', onClick: openHistorySheet },
    }));
    screen.append(el('div', { class: 'grid journal-grid' },
      journal.map(t => journalCardNode(t, tracksById))));
  }

  page.appendChild(screen);
  renderLucide();
}

// Existing task-mutation call sites use renderMain() after the mutation.
// It marks all four pages dirty but only re-renders the visible one; the
// other three refresh lazily on first swipe-in. See pagesDirty above.
async function renderMain() {
  for (let i = 0; i < PAGE_COUNT; i++) pagesDirty[i] = true;
  await renderPage(currentPage);
}

// ---------- render: Сегодня ----------

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}

function ageColorVar(days) {
  if (days >= 8) return 'var(--age-4)';
  if (days >= 4) return 'var(--age-3)';
  if (days >= 2) return 'var(--age-2)';
  return 'var(--age-1)';
}

function stuckBlockNode(task, tracksById) {
  const days = task.deadline
    ? Math.max(1, daysBetweenIso(task.deadline, todayISO()))
    : 1;
  const word = pluralizeDays(days).toUpperCase();
  const track = task.track_id && tracksById ? tracksById.get(task.track_id) : null;
  const isEditingBlocker = editingBlockerTaskId === task.id;
  const isSplitting = splittingTaskId === task.id;

  const card = el('div', {
    class: 'stuck-card-d',
    dataset: { id: String(task.id) },
    style: { '--card-age': ageColorVar(days) },
  });

  // Left: 4px age stripe
  card.append(el('div', { class: 'stuck-stripe' }));

  // Age block: number + word + flame
  const flame = iconNode('flame');
  flame.classList.add('stuck-age-flame');
  card.append(el('div', { class: 'stuck-age-block' }, [
    el('div', { class: 'stuck-age-num', text: String(days) }),
    el('div', { class: 'stuck-age-word', text: word }),
    flame,
  ]));

  // Main column
  const main = el('div', { class: 'stuck-main' });

  // Title row: task icon + title (icon top-aligned with title)
  const taskIcon = iconNode(task.icon || DEFAULT_ICON);
  taskIcon.classList.add('stuck-task-icon-d');
  const left = el('div', { class: 'stuck-left-d' }, [
    el('div', { class: 'stuck-title-row-d' }, [
      taskIcon,
      el('div', { class: 'stuck-title-d', text: task.text }),
    ]),
  ]);

  // Track pill (replaces meta line; date dropped)
  if (track) {
    left.append(el('div', { class: 'stuck-track-pill-d' }, [
      iconNode(track.icon || 'layers'),
      el('span', { text: track.name }),
    ]));
  }

  // Optional blocker chip — hidden during blocker edit or split
  if (task.blocker && !isEditingBlocker && !isSplitting) {
    const xBtn = el('button', {
      type: 'button', class: 'stuck-note-x', 'aria-label': 'Снять блокер',
      onclick: async (ev) => {
        ev.stopPropagation();
        try {
          await db.tasks.update(task.id, { blocker: null });
          renderMain().catch(showError);
        } catch (e) {
          if (isIdbDisconnectError(e)) { await recoverDb(); return; }
          showError(e);
        }
      },
    }, [iconNode('x')]);
    left.append(el('button', {
      type: 'button', class: 'stuck-note',
      onclick: (ev) => {
        if (ev.target.closest('.stuck-note-x')) return;
        ev.stopPropagation();
        editingBlockerTaskId = task.id;
        renderMain().catch(showError);
      },
    }, [iconNode('lock'), el('span', { text: task.blocker }), xBtn]));
  }

  // Trash button (top-right) — soft-delete without confirmation
  const trash = el('button', {
    type: 'button', class: 'stuck-trash-d', 'aria-label': 'Удалить',
    onclick: async (ev) => {
      ev.stopPropagation();
      try {
        await db.tasks.update(task.id, { deleted_at: Date.now() });
        renderMain().catch(showError);
      } catch (e) {
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
  }, [iconNode('trash-2')]);

  main.append(el('div', { class: 'stuck-top-d' }, [left, trash]));

  // Bottom: split-bar / blocker edit-bar / segmented action bar
  if (isSplitting) {
    main.append(buildSplitBar(task));
  } else if (isEditingBlocker) {
    main.append(buildBlockerEditBar(task));
  } else {
    const segs = [
      {
        icon: 'lock', label: 'Блокер',
        onClick: () => {
          editingBlockerTaskId = task.id;
          renderMain().catch(showError);
        },
      },
      {
        icon: 'calendar', label: 'Сдвинуть', kind: 'date',
        value: task.deadline || todayISO(),
        onChange: (next) => commitMoveDeadline(task, next),
      },
      {
        icon: 'split', label: 'Разделить',
        onClick: () => {
          splittingTaskId = task.id;
          renderMain().catch(showError);
        },
      },
      {
        icon: 'check', label: 'Завершить', accent: true,
        onClick: async () => {
          if (card.classList.contains('stamping') || card.classList.contains('removing')) return;
          try {
            await playStampImpact(card, task);
            await markDone(task.id);
            showUndoSnackbar(task.id);
            setTimeout(() => { renderMain().catch(showError); }, 60);
          } catch (e) {
            card.classList.remove('stamping');
            if (isIdbDisconnectError(e)) { await recoverDb(); return; }
            showError(e);
          }
        },
      },
    ];
    const segbar = el('div', { class: 'stuck-segbar' });
    segs.forEach((s, i) => {
      if (i > 0) segbar.append(el('div', { class: 'stuck-seg-divider' }));
      segbar.append(s.kind === 'date' ? stuckSegDateBtn(s) : stuckSegBtn(s));
    });
    main.append(segbar);
  }

  card.append(main);

  // Tap outside buttons → open edit sheet (suspended while editing blocker / splitting)
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    if (ev.target.closest('.stuck-seg')) return;
    if (ev.target.closest('.stuck-edit-bar')) return;
    if (ev.target.closest('.stuck-split-bar')) return;
    if (isEditingBlocker || isSplitting) return;
    openSheet({ task });
  });

  return card;
}

function buildBlockerEditBar(task) {
  const input = el('input', {
    type: 'text', class: 'stuck-edit-input', value: task.blocker || '',
    placeholder: 'что мешает?', maxLength: 120, autocomplete: 'off',
  });

  const commit = async () => {
    const value = input.value.trim();
    try {
      await db.tasks.update(task.id, { blocker: value || null });
      editingBlockerTaskId = null;
      renderMain().catch(showError);
    } catch (e) {
      if (isIdbDisconnectError(e)) { await recoverDb(); return; }
      showError(e);
    }
  };

  const cancel = el('button', {
    type: 'button', class: 'stuck-edit-cancel', text: 'отмена',
    onclick: (ev) => {
      ev.stopPropagation();
      editingBlockerTaskId = null;
      renderMain().catch(showError);
    },
  });

  const save = el('button', {
    type: 'button', class: 'stuck-edit-save',
    onclick: (ev) => { ev.stopPropagation(); commit(); },
  }, [iconNode('check'), el('span', { text: 'сохранить' })]);

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel.click();
    }
  });

  const bar = el('div', { class: 'stuck-edit-bar' }, [
    el('div', { class: 'stuck-edit-input-row' }, [
      iconNode('lock'),
      el('div', { class: 'stuck-edit-input-box' }, [input]),
    ]),
    el('div', { class: 'stuck-edit-actions' }, [cancel, save]),
  ]);

  setTimeout(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 30);

  return bar;
}

const SPLIT_MAX_ROWS = 5;

function buildSplitBar(task) {
  const rows = el('div', { class: 'stuck-split-rows' });
  const plusBtn = el('button', { type: 'button', class: 'stuck-split-plus' },
    [iconNode('plus'), el('span', { text: 'добавить шаг' })]);
  const cancelBtn = el('button', { type: 'button', class: 'stuck-edit-cancel', text: 'отмена' });
  const saveBtn = el('button', { type: 'button', class: 'stuck-split-save' },
    [iconNode('split'), el('span', { text: 'разделить' })]);
  const bar = el('div', { class: 'stuck-split-bar' }, [
    rows,
    plusBtn,
    el('div', { class: 'stuck-split-actions' }, [cancelBtn, saveBtn]),
  ]);

  const updateXVisibility = () => {
    const count = rows.children.length;
    [...rows.children].forEach(r => {
      const x = r.querySelector('.stuck-split-row-x');
      if (x) x.style.display = count > 2 ? '' : 'none';
    });
  };
  const updatePlusVisibility = () => {
    plusBtn.style.display = rows.children.length < SPLIT_MAX_ROWS ? '' : 'none';
  };
  const updateSaveState = () => {
    const filled = [...rows.children].filter(r => r.querySelector('input').value.trim()).length;
    const enabled = filled >= 2;
    saveBtn.disabled = !enabled;
    saveBtn.classList.toggle('disabled', !enabled);
  };

  const cancel = () => {
    splittingTaskId = null;
    renderMain().catch(showError);
  };
  cancelBtn.addEventListener('click', (ev) => { ev.stopPropagation(); cancel(); });

  const doSave = async () => {
    if (saveBtn.disabled) return;
    const values = [...rows.children]
      .map(r => r.querySelector('input').value.trim())
      .filter(Boolean);
    if (values.length < 2) return;
    try {
      const orig = await db.tasks.get(task.id);
      if (!orig) { splittingTaskId = null; await renderMain(); return; }
      const newIds = [];
      const now = Date.now();
      await db.transaction('rw', db.tasks, async () => {
        for (const text of values) {
          const id = await db.tasks.add({
            icon: orig.icon || DEFAULT_ICON,
            text,
            notes: '',
            deadline: orig.deadline || null,
            track_id: orig.track_id || null,
            created_at: now,
            done_at: 0,
            blocker: null,
          });
          newIds.push(id);
        }
        await db.tasks.update(task.id, { deleted_at: now });
      });
      splittingTaskId = null;
      showSnackbar({
        label: `Разделено на ${values.length}`,
        onUndo: async () => {
          const undoTs = Date.now();
          await db.transaction('rw', db.tasks, async () => {
            for (const id of newIds) {
              try { await db.tasks.update(id, { deleted_at: undoTs }); } catch {}
            }
            // Restore the original by clearing its tombstone instead of re-adding.
            await db.tasks.update(orig.id, { deleted_at: 0 });
          });
          await renderMain();
        },
      });
      await renderMain();
    } catch (e) {
      if (isIdbDisconnectError(e)) { await recoverDb(); return; }
      showError(e);
    }
  };
  saveBtn.addEventListener('click', (ev) => { ev.stopPropagation(); doSave(); });

  const addRow = (focus = false) => {
    if (rows.children.length >= SPLIT_MAX_ROWS) return null;
    const input = el('input', {
      type: 'text', class: 'stuck-split-input',
      placeholder: rows.children.length === 0 ? 'что сделать сначала?' : 'дальше…',
      maxLength: 120, autocomplete: 'off',
    });
    const row = el('div', { class: 'stuck-split-row' }, [
      el('div', { class: 'stuck-split-input-box' }, [input]),
      el('button', {
        type: 'button', class: 'stuck-split-row-x', 'aria-label': 'Удалить шаг',
        onclick: (ev) => {
          ev.stopPropagation();
          row.remove();
          updateXVisibility();
          updatePlusVisibility();
          updateSaveState();
        },
      }, [iconNode('x')]),
    ]);

    input.addEventListener('input', updateSaveState);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const isLast = row === rows.lastElementChild;
        if (isLast) {
          if (rows.children.length < SPLIT_MAX_ROWS) {
            addRow(true);
          } else {
            doSave();
          }
        } else {
          row.nextElementSibling.querySelector('input').focus();
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });

    rows.appendChild(row);
    updateXVisibility();
    updatePlusVisibility();
    updateSaveState();
    if (focus) setTimeout(() => input.focus(), 30);
    return input;
  };
  plusBtn.addEventListener('click', (ev) => { ev.stopPropagation(); addRow(true); });

  const firstInput = addRow();
  addRow();

  setTimeout(() => {
    if (firstInput) firstInput.focus();
    bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 30);

  return bar;
}

function stuckSegDateBtn({ icon, label, value, onChange }) {
  const input = el('input', {
    type: 'date', class: 'stuck-seg-date-input', value: value || '',
    onclick: (ev) => ev.stopPropagation(),
    onchange: (ev) => { ev.stopPropagation(); if (input.value) onChange(input.value); },
  });
  return el('label', { class: 'stuck-seg stuck-seg-date' }, [
    iconNode(icon),
    el('span', { class: 'stuck-seg-label', text: label }),
    input,
  ]);
}

function stuckSegBtn({ icon, label, onClick, accent }) {
  return el('button', {
    type: 'button', class: 'stuck-seg' + (accent ? ' stuck-seg-accent' : ''),
    onclick: (ev) => { ev.stopPropagation(); onClick(); },
  }, [iconNode(icon), el('span', { class: 'stuck-seg-label', text: label })]);
}

function freshRowNode(task, tracksById) {
  const row = el('div', { class: 'fresh-row', dataset: { id: String(task.id) } });
  const check = el('button', {
    type: 'button', class: 'fresh-check', 'aria-label': 'Завершить',
    onclick: async (ev) => {
      ev.stopPropagation();
      if (row.classList.contains('removing')) return;
      check.classList.add('filling');
      renderLucide();
      try {
        await new Promise(r => setTimeout(r, 220));
        row.classList.add('removing');
        await markDone(task.id);
        showUndoSnackbar(task.id);
        setTimeout(() => { renderMain().catch(showError); }, 200);
      } catch (e) {
        row.classList.remove('removing');
        check.classList.remove('filling');
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
  }, [iconNode('check')]);
  row.append(iconNode(task.icon || DEFAULT_ICON), el('span', { class: 'fresh-text', text: task.text }), check);
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    openSheet({ task });
  });
  return row;
}

async function renderToday() {
  const page = document.querySelector('.page-today');
  if (!page) return;
  page.replaceChildren();

  const now = new Date();
  let active, tracks;
  try {
    [active, tracks] = await Promise.all([listActive(), listTracks()]);
  } catch (e) {
    if (isIdbDisconnectError(e)) { await recoverDb(); return; }
    showError(e);
    return;
  }
  const stuck = stuckFromActive(active, now);
  const fresh = freshFromActive(active, now);
  const tracksById = new Map(tracks.map(t => [t.id, t]));

  const screen = el('div', { class: 'screen' }, [
    el('div', { class: 'header', 'data-no-swipe': '' }, [
      el('div', { class: 'header-row' }, [el('h1', { text: 'Сегодня' })]),
    ]),
  ]);

  // Stuck blocks
  if (stuck.length) {
    screen.append(
      el('div', { class: 'today-section-label', text: 'В ОЖИДАНИИ' }),
      el('div', { class: 'stuck-list' }, stuck.map(t => stuckBlockNode(t, tracksById))),
    );
  }

  // Fresh section — compact rows (icon + text + check circle)
  if (fresh.length) {
    screen.append(
      el('div', { class: 'today-section-label', text: 'СВЕЖИЕ · СЕГОДНЯ' }),
      el('div', { class: 'fresh-list' }, fresh.map(t => freshRowNode(t, tracksById))),
    );
  }

  // Empty state
  if (stuck.length === 0 && fresh.length === 0) {
    screen.append(el('div', { class: 'empty', text: 'На сегодня ничего. Отдыхай.' }));
  }

  page.appendChild(screen);
  renderLucide();
}

// ---------- render: Calendar ----------

function isoFromMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const CAL_MONTHS = ['ЯНВ','ФЕВ','МАР','АПР','МАЙ','ИЮН','ИЮЛ','АВГ','СЕН','ОКТ','НОЯ','ДЕК'];
const CAL_WEEKDAYS = ['ВС','ПН','ВТ','СР','ЧТ','ПТ','СБ'];

function calDayLabel(iso, todayIso) {
  if (iso === todayIso) return 'СЕГОДНЯ';
  const today = isoToDate(todayIso);
  const d = isoToDate(iso);
  const diff = Math.round((d - today) / 86400000);
  if (diff === -1) return 'ВЧЕРА';
  if (diff === 1) return 'ЗАВТРА';
  return `${d.getDate()} ${CAL_MONTHS[d.getMonth()]}`;
}

function calWeekday(iso) {
  return CAL_WEEKDAYS[isoToDate(iso).getDay()];
}

function calCardNode(task, isClosed, todayIso) {
  const card = el('div', {
    class: 'cal-card' + (isClosed ? ' is-closed' : ''),
    dataset: { id: String(task.id) },
  });

  const iconRow = el('div', { class: 'icon-row' }, [iconNode(task.icon || DEFAULT_ICON)]);
  if (task.notes) {
    iconRow.append(el('span', { class: 'notes-mark' }, [iconNode('notebook-pen')]));
  }
  card.append(iconRow, el('div', { class: 'text', text: task.text }));

  if (isClosed) {
    const d = new Date(task.done_at);
    const rot = -16 + ((task.id * 7) % 16);
    card.append(
      el('div', { class: 'deadline', text: `${d.getDate()} ${CAL_MONTHS[d.getMonth()].toLowerCase()}` }),
      el('div', { class: 'check-badge', style: { '--rot': `${rot}deg` } }, [iconNode('check')]),
    );
  } else {
    const dl = task.deadline;
    if (dl === todayIso) {
      card.append(el('div', { class: 'deadline today', text: 'сегодня' }));
    } else if (dl && dl < todayIso) {
      card.append(el('div', { class: 'deadline overdue', text: 'overdue' }));
    } else if (dl) {
      const d = isoToDate(dl);
      card.append(el('div', { class: 'deadline', text: `${d.getDate()} ${CAL_MONTHS[d.getMonth()].toLowerCase()}` }));
    }
  }

  if (isClosed) {
    card.addEventListener('click', () => openSheet({ task }));
  } else {
    attachLongPress(card, {
      onTap: () => openSheet({ task }),
      onLongPress: async () => {
        if (card.classList.contains('stamping')) return;
        try {
          await playStampImpact(card, task);
          await markDone(task.id);
          showUndoSnackbar(task.id);
          setTimeout(() => { renderMain().catch(showError); }, 60);
        } catch (e) {
          card.classList.remove('stamping');
          if (isIdbDisconnectError(e)) { await recoverDb(); return; }
          showError(e);
        }
      },
    });
  }
  return card;
}

async function renderCalendar() {
  const page = document.querySelector('.page-calendar');
  if (!page) return;
  page.replaceChildren();

  const screen = el('div', { class: 'screen-cal' }, [
    el('div', { class: 'header', 'data-no-swipe': '' }, [
      el('div', { class: 'header-row' }, [el('h1', { text: 'План' })]),
    ]),
  ]);

  // Buckets
  const [active, allDone] = await Promise.all([listActive(), listAllDone()]);
  const today = todayISO();
  const now = new Date();
  const buckets = new Map();
  const ensure = iso => {
    if (!buckets.has(iso)) buckets.set(iso, { active: [], closed: [] });
    return buckets.get(iso);
  };
  for (const t of active) {
    let bucketDate;
    if (!t.deadline || isStuckNow(t, now)) bucketDate = today;
    else bucketDate = t.deadline;
    ensure(bucketDate).active.push(t);
  }
  for (const t of allDone) {
    if (!t.done_at) continue;
    ensure(isoFromMs(t.done_at)).closed.push(t);
  }

  // Date range: at least today ±7, expanded to cover all buckets
  const todayDate = isoToDate(today);
  let minDate = new Date(todayDate); minDate.setDate(minDate.getDate() - 7);
  let maxDate = new Date(todayDate); maxDate.setDate(maxDate.getDate() + 7);
  for (const k of buckets.keys()) {
    const d = isoToDate(k);
    if (d < minDate) minDate = d;
    if (d > maxDate) maxDate = d;
  }
  const days = [];
  for (let d = new Date(minDate); d <= maxDate; d.setDate(d.getDate() + 1)) {
    days.push(isoFromDate(d));
  }

  // Strip
  const stripWrap = el('div', { class: 'cal-strip-wrap' });

  // Two-finger horizontal scroll. The pager owns 1-finger horizontal swipes,
  // so we expose Calendar scroll on the 2-finger gesture. preventDefault
  // disables pinch-zoom on the strip while two fingers are down.
  let csActive = false, csStartX = 0, csStartScroll = 0;
  stripWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      csActive = true;
      csStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      csStartScroll = stripWrap.scrollLeft;
    }
  }, { passive: true });
  stripWrap.addEventListener('touchmove', (e) => {
    if (!csActive || e.touches.length < 2) return;
    e.preventDefault();
    const x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    stripWrap.scrollLeft = csStartScroll - (x - csStartX);
  }, { passive: false });
  const csEnd = (e) => { if (e.touches.length < 2) csActive = false; };
  stripWrap.addEventListener('touchend', csEnd, { passive: true });
  stripWrap.addEventListener('touchcancel', csEnd, { passive: true });

  // 1-finger vertical scroll. touch-action:none blocks native scroll so the
  // pager can claim horizontal swipes without pointercancel races. We
  // emulate vertical pan in JS, scrolling the parent .page-calendar. Lock
  // direction after first 8px so a horizontal-leaning gesture stays free
  // for the pager to pick up via bubbling pointer events.
  let vsActive = false, vsLocked = null, vsStartY = 0, vsStartX = 0, vsStartScroll = 0;
  stripWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    vsActive = true;
    vsLocked = null;
    vsStartY = e.touches[0].clientY;
    vsStartX = e.touches[0].clientX;
    const pageEl = stripWrap.closest('.page');
    vsStartScroll = pageEl ? pageEl.scrollTop : 0;
  }, { passive: true });
  stripWrap.addEventListener('touchmove', (e) => {
    if (!vsActive || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - vsStartY;
    const dx = e.touches[0].clientX - vsStartX;
    if (vsLocked === null) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      vsLocked = Math.abs(dy) > Math.abs(dx) * 1.3 ? 'y' : 'x';
    }
    if (vsLocked === 'y') {
      e.preventDefault();
      const pageEl = stripWrap.closest('.page');
      if (pageEl) pageEl.scrollTop = vsStartScroll - dy;
    }
  }, { passive: false });
  const vsEnd = () => { vsActive = false; vsLocked = null; };
  stripWrap.addEventListener('touchend', vsEnd, { passive: true });
  stripWrap.addEventListener('touchcancel', vsEnd, { passive: true });

  const strip = el('div', { class: 'cal-strip' });

  let todayColEl = null;
  for (let i = 0; i < days.length; i++) {
    const dateIso = days[i];
    const col = el('div', { class: 'cal-col' + (dateIso === today ? ' is-today' : '') }, [
      el('div', { class: 'cal-day-title', text: calDayLabel(dateIso, today) }),
      el('div', { class: 'cal-day-sub', text: calWeekday(dateIso) }),
      el('div', { class: 'cal-hdiv' }),
    ]);
    if (dateIso === today) todayColEl = col;

    const bucket = buckets.get(dateIso);
    if (bucket) {
      // Active first, then closed
      bucket.active.sort((a, b) => b.created_at - a.created_at);
      bucket.closed.sort((a, b) => b.done_at - a.done_at);
      const items = [...bucket.active, ...bucket.closed.map(t => ({ ...t, _closed: true }))];
      items.forEach((t, idx) => {
        if (idx > 0) col.append(el('div', { class: 'cal-hdiv' }));
        col.append(calCardNode(t, t._closed === true || t.done_at > 0, today));
      });
    }

    strip.append(col);
    if (i < days.length - 1) strip.append(el('div', { class: 'cal-vdiv' }));
  }
  stripWrap.append(strip);
  screen.append(stripWrap);

  page.appendChild(screen);

  if (todayColEl) {
    requestAnimationFrame(() => {
      stripWrap.scrollLeft = todayColEl.offsetLeft - TODAY_PEEK_OFFSET;
    });
  }

  renderLucide();
}

// Сдвиг скролла, чтобы у левого края торчали 13px вчерашней колонки
// (4px gap между колонками + 13px видимого края = 17px).
const TODAY_PEEK_OFFSET = 17;

function scrollCalendarToToday() {
  const wrap = document.querySelector('.page-calendar .cal-strip-wrap');
  if (!wrap) return;
  const today = wrap.querySelector('.cal-col.is-today');
  if (!today) return;
  wrap.scrollLeft = today.offsetLeft - TODAY_PEEK_OFFSET;
}

// ---------- render: Tracks ----------

async function renderTracks() {
  const page = document.querySelector('.page-tracks');
  if (!page) return;
  page.replaceChildren();

  const screen = el('div', { class: 'screen' }, [
    el('div', { class: 'header', 'data-no-swipe': '' }, [
      el('div', { class: 'header-row' }, [el('h1', { text: 'Треки' })]),
    ]),
  ]);

  const tracks = await listTracks();
  const byCat = { work: [], personal: [], inactive: [] };
  tracks.forEach(t => {
    const cat = TRACK_CATEGORIES.includes(t.category) ? t.category : 'personal';
    byCat[cat].push(t);
  });

  const statsMap = await trackStatsAll();

  if (tracks.length === 0) {
    screen.append(el('div', { class: 'empty', text: 'Пока нет треков. Добавь первый снизу.' }));
  } else {
    for (const cat of TRACK_CATEGORIES) {
      const list = byCat[cat];
      const sec = el('section', {
        class: 'track-section track-section-' + cat,
        dataset: { category: cat },
      }, [
        el('div', { class: 'track-divider' + (cat === 'inactive' ? ' inactive' : '') }, [
          el('span', { class: 'track-divider-label', text: TRACK_CATEGORY_LABELS[cat] }),
        ]),
      ]);
      list.forEach(t => sec.append(trackStripNode(t, statsMap.get(t.id) || { done: 0, total: 0 })));
      screen.append(sec);
    }
  }

  page.appendChild(screen);
  renderLucide();
}

function trackStripNode(track, stats) {
  const grip = el('button', {
    type: 'button', class: 'track-grip', dataset: { noSwipe: '1' },
    'aria-label': 'Перетащить',
  }, [iconNode('grip-vertical')]);

  const icon = iconNode(track.icon || DEFAULT_ICON);
  icon.classList.add('track-icon');

  const strip = el('div', {
    class: 'track-strip' + (track.category === 'inactive' ? ' inactive' : ''),
    dataset: { id: String(track.id), category: track.category || 'personal' },
  }, [
    grip,
    icon,
    el('span', { class: 'track-name', text: track.name }),
    el('span', { class: 'track-meta', text: `задач: ${stats.done}/${stats.total}` }),
  ]);

  // progress fill — gradient stops at done/total ratio
  const ratio = stats.total > 0 ? stats.done / stats.total : 0;
  if (track.category !== 'inactive') {
    strip.style.setProperty('--progress', (ratio * 100).toFixed(1) + '%');
  }

  strip.addEventListener('click', (e) => {
    // Ignore clicks while drag just happened; handled in drag state
    if (strip.classList.contains('was-dragged')) {
      strip.classList.remove('was-dragged');
      return;
    }
    if (e.target.closest('.track-grip')) return;
    openTrackSheet({ track });
  });

  attachTrackDrag(strip, grip);
  return strip;
}

// ---------- bottom sheet (create / edit) ----------

let sheetOpen = false;

// Stateless leaf builders for openSheet — extracted to keep the main function
// focused on draft state + commit orchestration.

function buildDeadlineRow(initialIso, onChange) {
  // Stacked block matching the «ЗАМЕТКИ» section: caps label, then the
  // control row below as a separate sheet child (inherits the .sheet 18px gap).
  const label = el('div', { class: 'sheet-label', text: 'ДЕДЛАЙН' });

  let current = initialIso || null;
  const today = todayISO();
  const tomorrow = tomorrowISO();

  const todayBtn = el('button', { type: 'button', class: 'dl-seg-btn', text: 'Сегодня' });
  const tomorrowBtn = el('button', { type: 'button', class: 'dl-seg-btn', text: 'Завтра' });

  // «Дата» is a button with the native date input overlaid transparently —
  // tapping anywhere on the cell opens iOS's picker (more reliable than
  // showPicker() on a hidden input). Label shows the chosen custom date.
  const dateLabel = el('span', { class: 'dl-date-label' });
  const input = el('input', {
    type: 'date', class: 'dl-date-input', autocomplete: 'off', 'aria-label': 'Выбрать дату',
  });
  const dateCell = el('div', { class: 'dl-seg-btn dl-seg-date' }, [dateLabel, input]);

  const sync = () => {
    const isToday = current === today;
    const isTomorrow = current === tomorrow;
    const isCustom = !!current && !isToday && !isTomorrow;
    todayBtn.classList.toggle('active', isToday);
    tomorrowBtn.classList.toggle('active', isTomorrow);
    dateCell.classList.toggle('active', isCustom);
    dateLabel.textContent = isCustom ? formatDateShort(current) : 'Дата';
    input.value = current || '';
  };

  const set = (next) => {
    current = next || null;
    sync();
    onChange(current);
  };

  todayBtn.addEventListener('click', () => set(today));
  tomorrowBtn.addEventListener('click', () => set(tomorrow));
  input.addEventListener('change', () => set(input.value || null));

  const group = el('div', { class: 'dl-seg' }, [todayBtn, tomorrowBtn, dateCell]);
  sync();

  const frag = document.createDocumentFragment();
  frag.append(label, group);
  return frag;
}

function buildEditFooter({ onFinish, onDelete }) {
  const frag = document.createDocumentFragment();
  frag.append(
    el('button', { type: 'button', class: 'sheet-finish', onclick: onFinish },
      [iconNode('check'), el('span', { text: 'Завершить' })]),
    el('hr', { class: 'sheet-divider' }),
    el('button', { type: 'button', class: 'sheet-delete', text: 'Удалить задачу', onclick: onDelete }),
  );
  return frag;
}

function openSheet({ task, presetTrackId }) {
  if (sheetOpen) return;
  sheetOpen = true;
  const isEdit = !!task;

  const sheet = el('div', { class: 'sheet' });
  const backdrop = el('div', { class: 'sheet-backdrop' }, [sheet]);

  // draft state — all edits accumulate here, committed on close
  const draft = {
    text: task?.text || '',
    icon: task?.icon || DEFAULT_ICON,
    notes: task?.notes || '',
    deadline: isEdit ? (task?.deadline || null) : tomorrowISO(),
    track_id: task?.track_id ?? (presetTrackId ?? null),
  };

  // When user is mid-creation of a new track (inline input open) and taps
  // backdrop/Готово, input.blur starts an async addTrack while closeSheet
  // starts the task commit. Task commit must wait for the track's id to
  // land in draft.track_id, otherwise the task saves with the stale null.
  let pendingTrackInput = null;

  // handle
  sheet.append(el('div', { class: 'sheet-handle' }));

  // header: title + Готово
  const doneBtn = el('button', { type: 'button', class: 'sheet-done', text: 'Готово' });
  sheet.append(el('div', { class: 'sheet-header' }, [
    el('div', { class: 'sheet-title', text: isEdit ? 'Редактирование' : 'Новая задача' }),
    doneBtn,
  ]));

  // input row: icon box + input container with textarea
  const iconBox = el('button', { type: 'button', class: 'sheet-iconbox' });
  const renderIconBox = () => {
    iconBox.replaceChildren(iconNode(draft.icon || DEFAULT_ICON));
    renderLucide();
  };
  renderIconBox();

  const textInput = el('textarea', {
    class: 'sheet-text', placeholder: 'Задача', rows: 1, value: draft.text,
    autocapitalize: 'sentences',
    // iOS Safari otherwise shows a URL-autofill pill (site domain) in the
    // keyboard accessory bar — kill all autofill/autocorrect hints on this field.
    autocomplete: 'off', autocorrect: 'off', spellcheck: false,
  });
  // auto-grow up to max-height (CSS clamps, JS sets precise height)
  const autoResize = () => {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 94) + 'px';
  };
  textInput.addEventListener('input', () => {
    draft.text = textInput.value;
    autoResize();
  });

  sheet.append(el('div', { class: 'sheet-input-row' }, [
    iconBox,
    el('div', { class: 'sheet-input-wrap' }, [textInput]),
  ]));

  // icons section — suggestions row + "Все иконки" link
  const iconRow = el('div', { class: 'sheet-icon-row' });

  const renderSuggestions = () => {
    iconRow.replaceChildren();
    buildIconRow(draft.text, draft.icon).forEach(slot => {
      iconRow.append(el('button', {
        type: 'button',
        class: 'sheet-icon' + (slot.kind === 'prediction' ? ' prediction' : ''),
        onclick: () => {
          draft.icon = slot.icon;
          pushRecentIcon(slot.icon);
          renderIconBox();
          renderSuggestions();
        },
      }, [iconNode(slot.icon)]));
    });
    renderLucide();
  };

  const openPicker = () => {
    openIconPicker({
      current: draft.icon,
      onSelect: (name) => {
        draft.icon = name;
        pushRecentIcon(name);
        renderSuggestions();
        renderIconBox();
      },
    });
  };
  const allBtn = el('button', {
    type: 'button', class: 'sheet-icons-all', text: 'Все иконки', onclick: openPicker,
  });
  iconBox.addEventListener('click', openPicker);

  sheet.append(el('div', { class: 'sheet-section' }, [
    el('div', { class: 'sheet-label', text: 'ЧАСТО' }),
    iconRow,
    allBtn,
  ]));
  renderSuggestions();

  // track section: horizontal chip row [— / track / track / +]. Tap chip =
  // select (or deselect if tapping the current). "+" swaps itself for an
  // inline input — no secondary picker sheet.
  const trackRow = el('div', { class: 'sheet-track-row' });
  sheet.append(el('div', { class: 'sheet-section' }, [
    el('div', { class: 'sheet-label', text: 'ТРЕК' }),
    trackRow,
  ]));

  const renderTrackChips = async () => {
    let tracks = [];
    try {
      tracks = await listTracksByRecency();
    } catch (e) {
      if (isIdbDisconnectError(e)) { await recoverDb(); return; }
      showError(e);
    }
    trackRow.replaceChildren();

    trackRow.append(el('button', {
      type: 'button',
      class: 'track-chip track-chip-none' + (!draft.track_id ? ' selected' : ''),
      text: '—',
      onclick: () => { draft.track_id = null; renderTrackChips(); },
    }));

    tracks.forEach(t => {
      trackRow.append(el('button', {
        type: 'button',
        class: 'track-chip' + (t.id === draft.track_id ? ' selected' : ''),
        onclick: () => {
          draft.track_id = (draft.track_id === t.id) ? null : t.id;
          renderTrackChips();
        },
      }, [iconNode(t.icon), el('span', { text: t.name })]));
    });

    const plus = el('button', {
      type: 'button', class: 'track-chip track-chip-plus',
      onclick: () => swapPlusForInput(plus),
    }, [iconNode('plus')]);
    trackRow.append(plus);

    renderLucide();
  };

  const swapPlusForInput = (plusChip) => {
    const input = el('input', {
      type: 'text', placeholder: 'Новый трек',
      autocomplete: 'off', autocorrect: 'off', spellcheck: false,
    });
    const wrap = el('div', { class: 'track-chip track-chip-input' }, [input]);
    plusChip.replaceWith(wrap);
    input.focus();
    // ensure the input is visible even with keyboard up
    wrap.scrollIntoView({ inline: 'end', block: 'nearest' });

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (!name) { renderTrackChips(); return; }
      const matched = matchIcons(name, 1);
      const icon = matched[0] || DEFAULT_ICON;
      try {
        const id = await addTrack({ name, icon });
        draft.track_id = id;
      } catch (e) {
        if (isIdbDisconnectError(e)) await recoverDb();
        else showError(e);
      }
      renderTrackChips();
    };

    input.addEventListener('blur', () => {
      const p = commit();
      pendingTrackInput = p;
      p.finally(() => { if (pendingTrackInput === p) pendingTrackInput = null; });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; input.blur(); }
    });
  };

  renderTrackChips();

  // Debounced re-render of suggestions on text input — long enough that a
  // partial word ("док" → "документ") doesn't flash through 3 matches before
  // settling.
  let suggTimer = null;
  textInput.addEventListener('input', () => {
    if (suggTimer) clearTimeout(suggTimer);
    suggTimer = setTimeout(renderSuggestions, 250);
  });

  // notes section: label + textarea box (auto-grow, no max-height; the sheet
  // itself scrolls internally if it overflows).
  const notesInput = el('textarea', {
    class: 'sheet-notes', placeholder: 'Заметки (опционально)', rows: 2, value: draft.notes,
    autocomplete: 'off', autocorrect: 'off', spellcheck: false,
  });
  const autoResizeNotes = () => {
    notesInput.style.height = 'auto';
    notesInput.style.height = notesInput.scrollHeight + 'px';
  };
  notesInput.addEventListener('input', () => {
    draft.notes = notesInput.value;
    autoResizeNotes();
  });
  sheet.append(
    el('div', { class: 'sheet-label', text: 'ЗАМЕТКИ' }),
    el('div', { class: 'sheet-notes-wrap' }, [notesInput]),
  );

  sheet.appendChild(buildDeadlineRow(draft.deadline, (next) => { draft.deadline = next; }));

  if (isEdit) {
    sheet.appendChild(buildEditFooter({
      onFinish: async () => {
        sheetOpen = false;
        try {
          await markDone(task.id);
          showUndoSnackbar(task.id);
        } catch (e) {
          if (isIdbDisconnectError(e)) await recoverDb();
          else showError(e);
        }
        closeSheet(backdrop, { skipCommit: true });
      },
      onDelete: async () => {
        sheetOpen = false;
        try {
          await db.tasks.update(task.id, { deleted_at: Date.now() });
        } catch (e) {
          if (isIdbDisconnectError(e)) await recoverDb();
          else showError(e);
        }
        closeSheet(backdrop, { skipCommit: true });
      },
    }));
  }

  const commit = async () => {
    // If a new-track inline input is mid-flight (async addTrack → draft.track_id),
    // wait for it so the task saves with the resolved id instead of stale null.
    if (pendingTrackInput) {
      try { await pendingTrackInput; } catch {}
    }
    const text = draft.text.trim();
    const notes = (draft.notes || '').trim();
    try {
      if (isEdit) {
        // empty text on existing task = no-op (keep original). Only the Delete
        // button deletes, to keep close-as-autosave non-destructive.
        if (text) {
          const newTrackId = draft.track_id || null;
          // Single transaction so a parallel reader never sees the task
          // attached to a track whose last_used_at hasn't been bumped yet.
          await db.transaction('rw', db.tasks, db.tracks, async () => {
            await db.tasks.update(task.id, {
              text,
              icon: draft.icon || DEFAULT_ICON,
              notes,
              deadline: draft.deadline || null,
              track_id: newTrackId,
            });
            // Recency signal only on actual track change — re-saving an
            // unchanged task shouldn't shuffle the chip row.
            if (newTrackId && newTrackId !== task.track_id) {
              await db.tracks.update(newTrackId, { last_used_at: Date.now() });
            }
          });
        }
      } else if (text) {
        const newTrackId = draft.track_id || null;
        await db.transaction('rw', db.tasks, db.tracks, async () => {
          await db.tasks.add({
            icon: draft.icon || DEFAULT_ICON,
            text,
            notes,
            deadline: draft.deadline || null,
            track_id: newTrackId,
            created_at: Date.now(),
            done_at: 0,
          });
          if (newTrackId) {
            await db.tracks.update(newTrackId, { last_used_at: Date.now() });
          }
        });
      }
    } catch (e) {
      if (isIdbDisconnectError(e)) await recoverDb();
      else showError(e);
    }
  };

  doneBtn.addEventListener('click', () => {
    closeSheet(backdrop, { commit });
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeSheet(backdrop, { commit });
    }
  });

  document.body.appendChild(backdrop);
  renderLucide();

  // Focus synchronously while still inside the click gesture chain — iOS
  // Safari won't raise the keyboard if focus() runs from a setTimeout/rAF
  // after the gesture. Transform-off-screen doesn't prevent focus.
  if (!isEdit) {
    textInput.focus();
  }

  // iOS Safari quirk: focus() on a textarea while the sheet is still at
  // translateY(100%) (off-screen) makes WebKit scroll the layout viewport up
  // to "reveal" the focused element. That residual scroll persists after the
  // sheet slides in and pulls the fixed backdrop under the notch. Re-pin
  // window.scrollY=0 while the sheet is open, on every visual-viewport
  // resize/scroll (keyboard show/hide).
  const pinTop = () => window.scrollTo(0, 0);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', pinTop);
    window.visualViewport.addEventListener('scroll', pinTop);
    backdrop._unpinTop = () => {
      window.visualViewport.removeEventListener('resize', pinTop);
      window.visualViewport.removeEventListener('scroll', pinTop);
    };
  }

  // animate in + size textareas for any pre-filled content
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    autoResize();
    autoResizeNotes();
    pinTop();
  });
}

// ---------- full icon picker (stacked above edit sheet) ----------

function openIconPicker({ current, onSelect }) {
  const groups = (typeof CURATED_GROUPS !== 'undefined' ? CURATED_GROUPS : null);
  const all = (typeof CURATED_FULL !== 'undefined' ? CURATED_FULL : ['circle-dashed']);

  const search = el('input', {
    type: 'search', class: 'picker-search',
    placeholder: 'Поиск (по англ. имени Lucide)', autocomplete: 'off',
  });
  const grid = el('div', { class: 'picker-grid' });
  const sheet = el('div', { class: 'picker-sheet' }, [
    el('div', { class: 'sheet-handle' }),
    search,
    grid,
  ]);
  const backdrop = el('div', { class: 'picker-backdrop' }, [sheet]);

  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
  };

  const iconButton = (name) => el('button', {
    type: 'button',
    class: 'sheet-icon' + (name === current ? ' selected' : ''),
    onclick: () => { onSelect?.(name); close(); },
  }, [iconNode(name)]);

  const renderGrid = (filter) => {
    grid.replaceChildren();
    const q = (filter || '').trim().toLowerCase();
    if (q) {
      const list = all.filter(n => n.includes(q));
      if (list.length === 0) {
        grid.append(el('div', { class: 'picker-empty', text: 'Нет совпадений. Можно задать иконку, введя точное Lucide-имя в поиск и нажав Enter.' }));
      } else {
        list.forEach(name => grid.append(iconButton(name)));
      }
    } else if (groups) {
      groups.forEach((g, i) => {
        grid.append(el('div', { class: 'picker-section-label' + (i === 0 ? ' first' : ''), text: g.label }));
        g.icons.forEach(name => grid.append(iconButton(name)));
      });
    } else {
      all.forEach(name => grid.append(iconButton(name)));
    }
    renderLucide();
  };

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  search.addEventListener('input', () => renderGrid(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = search.value.trim().toLowerCase();
      if (q) {
        // Accept any Lucide name from the full set or the query itself as a
        // fallback — user can always type a name we didn't curate.
        onSelect?.(q);
        close();
      }
    }
  });

  document.body.appendChild(backdrop);
  renderGrid();
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

function openHistorySheet() {
  const clearAll = el('span', { class: 'history-clear-all', text: 'Очистить всё' });
  const content = el('div', { class: 'history-content' });
  const sheet = el('div', { class: 'picker-sheet history-sheet' }, [
    el('div', { class: 'sheet-handle' }),
    el('div', { class: 'history-header' }, [
      el('div', { class: 'history-title', text: 'Весь журнал' }),
      clearAll,
    ]),
    content,
  ]);
  const backdrop = el('div', { class: 'picker-backdrop history-backdrop' }, [sheet]);

  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
  };

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const render = async () => {
    content.replaceChildren();
    const [tasks, tracks] = await Promise.all([listAllDone(), listTracks()]);
    const tracksById = new Map(tracks.map(t => [t.id, t]));
    if (tasks.length === 0) {
      content.append(el('div', { class: 'history-empty', text: 'Пока пусто — ещё ничего не выполнено.' }));
      return;
    }
    const groups = groupByDay(tasks);
    for (const g of groups) {
      const grid = el('div', { class: 'grid journal-grid' });
      g.tasks.forEach(t => {
        grid.append(doneCardNode(t, tracksById, {
          onTap: () => { close(); setTimeout(() => openSheet({ task: t }), 220); },
          onLongPress: async () => {
            try {
              await undoDone(t.id);
              await render();
              await renderMain();
            } catch (e) {
              if (isIdbDisconnectError(e)) { await recoverDb(); return; }
              showError(e);
            }
          },
        }));
      });
      content.append(el('div', { class: 'history-group' }, [
        el('div', { class: 'history-day', text: g.label }),
        grid,
      ]));
    }
    renderLucide();
  };

  clearAll.addEventListener('click', async () => {
    if (!confirm('Удалить все выполненные задачи? Отменить нельзя.')) return;
    try {
      await deleteAllDone();
      await render();
      await renderMain();
    } catch (e) {
      if (isIdbDisconnectError(e)) { await recoverDb(); return; }
      showError(e);
    }
  });

  document.body.appendChild(backdrop);
  render().catch(showError);
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

async function closeSheet(backdrop, { commit, skipCommit } = {}) {
  if (!sheetOpen && !skipCommit) return;
  sheetOpen = false;
  backdrop.classList.remove('open');
  if (backdrop._unpinTop) backdrop._unpinTop();
  if (commit) await commit();
  setTimeout(() => {
    backdrop.remove();
    renderMain().catch(showError);
  }, 200);
}

// ---------- track drag-drop ----------

// Drag a track strip between category sections by its grip handle. Long-press
// starts the drag; horizontal/vertical movement is captured (touch-action:none
// on the grip prevents the pager swipe and page scroll). On release, snap the
// strip into the section it was dropped over and persist category+position.
function attachTrackDrag(strip, grip) {
  let pressTimer = null;
  let dragging = false;
  let startX = 0, startY = 0;
  let pointerId = null;
  let ghost = null;
  let originRect = null;

  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      startDrag(e);
    }, 220);
  });

  grip.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    if (!dragging) {
      // Movement > 10px before long-press fires cancels it (user is scrolling/panning)
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (dx * dx + dy * dy > 100) cancelPress();
      return;
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    highlightDropTarget(e.clientY);
  });

  const releaseHandler = async (e) => {
    if (e.pointerId !== pointerId) return;
    cancelPress();
    if (!dragging) { pointerId = null; return; }
    dragging = false;
    try {
      const targetCat = sectionAtY(e.clientY);
      const targetIndex = dropIndexAt(targetCat, e.clientY);
      await commitDragDrop(strip, targetCat, targetIndex);
    } catch (err) {
      if (isIdbDisconnectError(err)) await recoverDb();
      else showError(err);
    } finally {
      tearDownGhost();
      strip.classList.add('was-dragged');
      setTimeout(() => strip.classList.remove('was-dragged'), 300);
      await renderTracks();
    }
    pointerId = null;
  };
  grip.addEventListener('pointerup', releaseHandler);
  grip.addEventListener('pointercancel', releaseHandler);

  function startDrag(e) {
    dragging = true;
    if (navigator.vibrate) navigator.vibrate(12);
    grip.setPointerCapture?.(pointerId);

    originRect = strip.getBoundingClientRect();
    ghost = strip.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = originRect.width + 'px';
    ghost.style.height = originRect.height + 'px';
    ghost.style.left = originRect.left + 'px';
    ghost.style.top = originRect.top + 'px';
    document.body.appendChild(ghost);

    strip.classList.add('drag-origin');
    moveGhost(e.clientX, e.clientY);
  }

  function moveGhost(clientX, clientY) {
    if (!ghost || !originRect) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    ghost.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function highlightDropTarget(y) {
    document.querySelectorAll('.track-section.drop-target').forEach(el => el.classList.remove('drop-target'));
    const cat = sectionAtY(y);
    if (cat) {
      const sec = document.querySelector(`.track-section-${cat}`);
      sec?.classList.add('drop-target');
    }
  }

  function tearDownGhost() {
    if (ghost) { ghost.remove(); ghost = null; }
    strip.classList.remove('drag-origin');
    document.querySelectorAll('.track-section.drop-target').forEach(el => el.classList.remove('drop-target'));
  }
}

function sectionAtY(y) {
  for (const cat of TRACK_CATEGORIES) {
    const sec = document.querySelector(`.track-section-${cat}`);
    if (!sec) continue;
    const r = sec.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) return cat;
  }
  // Outside any section — pick the nearest by vertical distance
  let best = null, bestDist = Infinity;
  for (const cat of TRACK_CATEGORIES) {
    const sec = document.querySelector(`.track-section-${cat}`);
    if (!sec) continue;
    const r = sec.getBoundingClientRect();
    const center = (r.top + r.bottom) / 2;
    const d = Math.abs(y - center);
    if (d < bestDist) { bestDist = d; best = cat; }
  }
  return best;
}

// Index where the dragged strip should land within its target section.
function dropIndexAt(category, y) {
  const sec = document.querySelector(`.track-section-${category}`);
  if (!sec) return 0;
  const strips = Array.from(sec.querySelectorAll('.track-strip:not(.drag-origin)'));
  for (let i = 0; i < strips.length; i++) {
    const r = strips[i].getBoundingClientRect();
    const mid = (r.top + r.bottom) / 2;
    if (y < mid) return i;
  }
  return strips.length;
}

async function commitDragDrop(strip, targetCat, targetIndex) {
  const trackId = Number(strip.dataset.id);
  const tracks = await listTracks();
  const dragged = tracks.find(t => t.id === trackId);
  if (!dragged) return;
  const inCat = tracks.filter(t => (t.category || 'personal') === targetCat && t.id !== trackId);
  const reorder = inCat.slice(0, targetIndex).concat([dragged]).concat(inCat.slice(targetIndex));
  // bulkPut in one round-trip instead of (1 + N) updates inside a transaction.
  const updated = reorder.map((t, i) => ({
    ...t,
    category: t.id === trackId ? targetCat : t.category,
    position: i + 1,
  }));
  await db.tracks.bulkPut(updated);
}

// ---------- track sheet (create / edit) ----------

let trackSheetOpen = false;

function openTrackSheet({ track }) {
  if (trackSheetOpen) return;
  trackSheetOpen = true;
  const isEdit = !!track;

  const sheet = el('div', { class: 'sheet' });
  const backdrop = el('div', { class: 'sheet-backdrop' }, [sheet]);

  const draft = {
    name: track?.name || '',
    icon: track?.icon || DEFAULT_ICON,
    // Editing an inactive track still exposes a work/personal toggle — tapping
    // it reactivates into that category.
    category: (track?.category === 'inactive' ? 'personal' : (track?.category || 'personal')),
  };

  // handle
  sheet.append(el('div', { class: 'sheet-handle' }));

  const doneBtn = el('button', { type: 'button', class: 'sheet-done', text: isEdit ? 'Готово' : 'Создать' });
  sheet.append(el('div', { class: 'sheet-header' }, [
    el('div', { class: 'sheet-title', text: isEdit ? 'Редактирование' : 'Новый трек' }),
    doneBtn,
  ]));

  // input row: iconbox + name input
  const iconBox = el('button', { type: 'button', class: 'sheet-iconbox' });
  const renderIconBox = () => {
    iconBox.replaceChildren(iconNode(draft.icon || DEFAULT_ICON));
    renderLucide();
  };
  renderIconBox();

  const nameInput = el('input', {
    type: 'text', class: 'sheet-text', placeholder: 'Название трека', value: draft.name,
    autocomplete: 'off', autocorrect: 'off', spellcheck: false, autocapitalize: 'sentences',
  });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; });

  sheet.append(el('div', { class: 'sheet-input-row' }, [
    iconBox,
    el('div', { class: 'sheet-input-wrap' }, [nameInput]),
  ]));

  // category toggle (Работа / Личное)
  const toggle = el('div', { class: 'category-toggle' });
  const renderToggle = () => {
    toggle.replaceChildren();
    for (const cat of ['work', 'personal']) {
      toggle.append(el('button', {
        type: 'button',
        class: 'category-toggle-btn' + (draft.category === cat ? ' selected' : ''),
        text: TRACK_CATEGORY_LABELS[cat],
        onclick: () => { draft.category = cat; renderToggle(); },
      }));
    }
  };
  renderToggle();
  sheet.append(el('div', { class: 'sheet-section' }, [
    el('div', { class: 'sheet-label', text: 'КАТЕГОРИЯ' }),
    toggle,
  ]));

  // icon suggestions + Все иконки
  const iconRow = el('div', { class: 'sheet-icon-row' });
  const renderSuggestions = () => {
    iconRow.replaceChildren();
    buildIconRow(draft.name, draft.icon).forEach(slot => {
      iconRow.append(el('button', {
        type: 'button',
        class: 'sheet-icon' + (slot.kind === 'prediction' ? ' prediction' : ''),
        onclick: () => {
          draft.icon = slot.icon;
          pushRecentIcon(slot.icon);
          renderIconBox();
          renderSuggestions();
        },
      }, [iconNode(slot.icon)]));
    });
    renderLucide();
  };
  renderSuggestions();

  const openPicker = () => openIconPicker({
    current: draft.icon,
    onSelect: (name) => { draft.icon = name; pushRecentIcon(name); renderSuggestions(); renderIconBox(); },
  });
  const allBtn = el('button', {
    type: 'button', class: 'sheet-icons-all', text: 'Все иконки', onclick: openPicker,
  });
  iconBox.addEventListener('click', openPicker);

  sheet.append(el('div', { class: 'sheet-section' }, [
    el('div', { class: 'sheet-label', text: 'ЧАСТО' }),
    iconRow,
    allBtn,
  ]));

  // Re-render suggestions when name changes (debounced)
  let suggTimer = null;
  nameInput.addEventListener('input', () => {
    if (suggTimer) clearTimeout(suggTimer);
    suggTimer = setTimeout(renderSuggestions, 250);
  });

  // Tasks list (edit mode) — active + completed (collapsed) + БЕЗ ТРЕКА section
  if (isEdit) {
    const tasksLabel = el('div', { class: 'sheet-label' });
    const tasksBlock = el('div', { class: 'track-tasks-list' });
    sheet.append(tasksLabel, tasksBlock);

    // Completed tasks — collapsed by default so a long history doesn't bloat
    // the sheet. Collapse state persists per track.
    const doneCollapseKey = `tasks_tracksheet_done_collapsed_${track.id}`;
    let doneCollapsed = localStorage.getItem(doneCollapseKey) !== '0';

    const doneToggle = el('button', { type: 'button', class: 'track-done-toggle' });
    const doneBlock = el('div', { class: 'track-tasks-list' });
    sheet.append(doneToggle, doneBlock);

    const renderDoneToggle = (count) => {
      const chev = iconNode(doneCollapsed ? 'chevron-right' : 'chevron-down');
      chev.classList.add('track-done-chevron');
      doneToggle.replaceChildren(
        chev,
        el('span', { text: 'ЗАВЕРШЁННЫЕ' }),
        el('span', { class: 'track-done-count', text: `· ${count}` }),
      );
      renderLucide();
    };
    doneToggle.addEventListener('click', () => {
      doneCollapsed = !doneCollapsed;
      localStorage.setItem(doneCollapseKey, doneCollapsed ? '1' : '0');
      doneBlock.style.display = doneCollapsed ? 'none' : '';
      renderDoneToggle(doneBlock.childElementCount);
    });

    const unassignedLabel = el('div', { class: 'sheet-label' });
    const unassignedBlock = el('div', { class: 'track-tasks-list' });
    sheet.append(unassignedLabel, unassignedBlock);

    const makeTaskRow = (t, action) => {
      const main = el('button', {
        type: 'button', class: 'track-task-main',
        onclick: () => {
          closeTrackSheet(backdrop, { skipCommit: true });
          setTimeout(() => openSheet({ task: t }), 220);
        },
      }, [
        el('span', { class: 'track-task-icon' }, [iconNode(t.icon || DEFAULT_ICON)]),
        el('span', { class: 'track-task-text', text: t.text }),
      ]);

      const actBtn = el('button', {
        type: 'button',
        class: 'track-task-action ' + (action === 'detach' ? 'detach' : 'attach'),
        'aria-label': action === 'detach' ? 'Отвязать от трека' : 'Прикрепить к треку',
        onclick: async (e) => {
          e.stopPropagation();
          const prevTrackId = t.track_id ?? null;
          const nextTrackId = action === 'detach' ? null : track.id;
          try { await db.tasks.update(t.id, { track_id: nextTrackId }); }
          catch (err) {
            if (isIdbDisconnectError(err)) await recoverDb();
            else { showError(err); return; }
          }
          showSnackbar({
            label: action === 'detach' ? 'Задача отвязана' : 'Прикреплено',
            onUndo: async () => {
              try { await db.tasks.update(t.id, { track_id: prevTrackId }); }
              catch (err) { showError(err); }
              await renderTrackTasksSections();
            },
          });
          await renderTrackTasksSections();
        },
      }, [iconNode(action === 'detach' ? 'x' : 'plus')]);

      return el('div', { class: 'track-task-row' + (t.done_at ? ' done' : '') }, [main, actBtn]);
    };

    const renderTrackTasksSections = async () => {
      const [currentAll, unassigned] = await Promise.all([
        listTasksByTrack(track.id),
        listUnassignedActive(),
      ]);
      const active = currentAll.filter(t => !t.done_at)
        .sort((a, b) => b.created_at - a.created_at);
      const done = currentAll.filter(t => t.done_at)
        .sort((a, b) => b.done_at - a.done_at);

      tasksLabel.textContent = active.length ? `ЗАДАЧИ · ${active.length}` : 'ЗАДАЧИ';
      tasksBlock.replaceChildren();
      if (active.length === 0) {
        tasksBlock.append(el('div', { class: 'track-tasks-empty', text: 'Пока нет задач в этом треке.' }));
      } else {
        active.forEach(t => tasksBlock.appendChild(makeTaskRow(t, 'detach')));
      }

      if (done.length === 0) {
        doneToggle.style.display = 'none';
        doneBlock.style.display = 'none';
      } else {
        doneToggle.style.display = '';
        doneBlock.replaceChildren();
        done.forEach(t => doneBlock.appendChild(makeTaskRow(t, 'detach')));
        doneBlock.style.display = doneCollapsed ? 'none' : '';
        renderDoneToggle(done.length);
      }

      if (unassigned.length === 0) {
        unassignedLabel.style.display = 'none';
        unassignedBlock.style.display = 'none';
      } else {
        unassignedLabel.style.display = '';
        unassignedBlock.style.display = '';
        unassignedLabel.textContent = `БЕЗ ТРЕКА · ${unassigned.length}`;
        unassignedBlock.replaceChildren();
        unassigned.forEach(t => unassignedBlock.appendChild(makeTaskRow(t, 'attach')));
      }
      renderLucide();
    };

    renderTrackTasksSections().catch(showError);

    sheet.append(
      el('hr', { class: 'sheet-divider' }),
      el('button', {
        type: 'button', class: 'sheet-delete',
        onclick: async () => {
          try { await deleteTrack(track.id); }
          catch (e) {
            if (isIdbDisconnectError(e)) await recoverDb();
            else showError(e);
          }
          closeTrackSheet(backdrop, { skipCommit: true });
        },
      }, [iconNode('trash-2'), el('span', { text: 'Удалить трек' })]),
    );
  }

  const commit = async () => {
    const name = draft.name.trim();
    try {
      if (isEdit) {
        if (name) {
          await updateTrack(track.id, { name, icon: draft.icon || DEFAULT_ICON, category: draft.category });
        }
      } else if (name) {
        await addTrack({ name, icon: draft.icon || DEFAULT_ICON, category: draft.category });
      }
    } catch (e) {
      if (isIdbDisconnectError(e)) await recoverDb();
      else showError(e);
    }
  };

  doneBtn.addEventListener('click', () => closeTrackSheet(backdrop, { commit }));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeTrackSheet(backdrop, { commit });
  });

  document.body.appendChild(backdrop);
  renderLucide();
  if (!isEdit) nameInput.focus();
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

async function closeTrackSheet(backdrop, { commit, skipCommit } = {}) {
  if (!trackSheetOpen && !skipCommit) return;
  trackSheetOpen = false;
  backdrop.classList.remove('open');
  if (commit) await commit();
  setTimeout(() => {
    backdrop.remove();
    renderMain().catch(showError);
  }, 200);
}

// ---------- settings ----------

async function readVersion() {
  try {
    if (!('caches' in window)) return '?';
    const keys = await caches.keys();
    const c = keys.find(k => k.startsWith('tasks-v'));
    if (!c) return '?';
    return c.replace('tasks-v', '').replace('-', '.');
  } catch {
    return '?';
  }
}

let settingsOpen = false;
function openSettings() {
  if (settingsOpen) return;
  settingsOpen = true;

  const overlay = el('div', { class: 'settings-overlay' });
  overlay.append(el('div', { class: 'settings-navbar' }, [
    el('button', {
      type: 'button', class: 'settings-back', 'aria-label': 'Назад',
      onclick: () => closeSettings(overlay),
    }, [iconNode('arrow-left')]),
    el('div', { class: 'settings-title', text: 'Настройки' }),
    el('div', { class: 'settings-back-spacer' }),
  ]));

  const content = el('div', { class: 'settings-content' });

  // Section: ДАННЫЕ
  const dataSec = settingsSection('ДАННЫЕ');
  const dataCard = settingsCard();
  dataCard.appendChild(settingsRow({
    icon: 'download',
    label: 'Экспорт в JSON',
    chevron: true,
    onClick: openExportSheet,
  }));
  dataCard.appendChild(settingsDivider());
  dataCard.appendChild(settingsRow({
    icon: 'upload',
    label: 'Импорт из JSON',
    chevron: true,
    onClick: openImportSheet,
  }));
  dataSec.appendChild(dataCard);
  dataSec.appendChild(el('div', { class: 'settings-hint', text: 'Полная резервная копия. Перенести между устройствами или восстановить.' }));
  content.appendChild(dataSec);

  // Section: WIKI
  const wikiSec = settingsSection('WIKI');
  const wikiCard = settingsCard();
  const tokenRow = settingsRow({
    icon: 'key-round',
    label: 'GitHub токен',
    rightText: getWikiToken() ? '••••' : 'не задан',
    chevron: true,
    onClick: () => openWikiTokenSheet(() => {
      const r = tokenRow.querySelector('.settings-row-right');
      if (r) r.textContent = getWikiToken() ? '••••' : 'не задан';
    }),
  });
  wikiCard.appendChild(tokenRow);
  wikiCard.appendChild(settingsDivider());
  let syncing = false;
  let syncRow;
  const handleSyncClick = async () => {
    if (syncing) return;
    syncing = true;
    const lbl = syncRow ? syncRow.querySelector('.settings-row-label') : null;
    const original = lbl ? lbl.textContent : 'Синк с вики';
    if (lbl) lbl.textContent = 'Синхронизирую…';
    showBanner('Запускаю синк…', { variant: 'info', autoHide: 3000 });
    try {
      await syncWithWiki();
    } catch (e) {
      showError(e);
    } finally {
      syncing = false;
      if (lbl) lbl.textContent = original;
    }
  };
  syncRow = settingsRow({
    icon: 'refresh-cw',
    label: 'Синк с вики',
    chevron: true,
    onClick: handleSyncClick,
  });
  wikiCard.appendChild(syncRow);
  wikiSec.appendChild(wikiCard);
  wikiSec.appendChild(el('div', { class: 'settings-hint', text: 'Двусторонняя синхронизация с daily/daily-tasks.md в вики через GitHub API. Last-write-wins по updated_at.' }));
  content.appendChild(wikiSec);

  // Section: ВНЕШНИЙ ВИД
  const themeSec = settingsSection('ВНЕШНИЙ ВИД');
  const themeCard = settingsCard();
  themeCard.appendChild(settingsRow({
    icon: 'palette',
    label: 'Тема',
    rightText: 'Тёмная',
    chevron: true,
    onClick: () => {},
  }));
  themeCard.appendChild(settingsDivider());
  let catOrderRow;
  catOrderRow = settingsRow({
    icon: 'arrow-up-down',
    label: 'Сверху на «Сегодня»',
    rightText: workFirst() ? 'Работа' : 'Личное',
    onClick: () => {
      localStorage.setItem('tasks_work_first', workFirst() ? '0' : '1');
      const r = catOrderRow.querySelector('.settings-row-right');
      if (r) r.textContent = workFirst() ? 'Работа' : 'Личное';
      renderMain().catch(showError);
    },
  });
  themeCard.appendChild(catOrderRow);
  themeSec.appendChild(themeCard);
  themeSec.appendChild(el('div', { class: 'settings-hint', text: 'Какая категория показывается выше на экране «Сегодня».' }));
  content.appendChild(themeSec);

  // Section: О ПРИЛОЖЕНИИ
  const aboutSec = settingsSection('О ПРИЛОЖЕНИИ');
  const aboutCard = settingsCard();
  const versionRow = settingsRow({ label: 'Версия', rightText: '…' });
  aboutCard.appendChild(versionRow);
  aboutSec.appendChild(aboutCard);
  content.appendChild(aboutSec);

  overlay.appendChild(content);

  document.body.appendChild(overlay);
  renderLucide();
  requestAnimationFrame(() => overlay.classList.add('open'));

  readVersion().then(v => {
    const right = versionRow.querySelector('.settings-row-right');
    if (right) right.textContent = v;
  });

  attachSettingsSwipeBack(overlay);
}

// Swipe-right on Settings to dismiss. Touch events (rather than pointer
// events) — iOS dispatches them more reliably for this case, especially
// when the gesture starts near the screen edge or over scrollable
// content. Horizontal-dominant motion engages drag; once dragging,
// preventDefault() blocks vertical scroll so the gesture can't be
// hijacked. Release past 80px or with rightward velocity > 0.5 px/ms
// closes, otherwise snaps back.
function attachSettingsSwipeBack(overlay) {
  const DIST_THRESHOLD = 80;
  const VELOCITY_THRESHOLD = 0.5; // px/ms

  let startX = 0, startY = 0, startT = 0;
  let active = false, dragging = false;

  const onStart = (e) => {
    if (!document.body.contains(overlay)) return;
    if (e.touches.length !== 1) { active = false; return; }
    if (e.target.closest('.settings-sheet-backdrop')) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startT = performance.now();
    active = true;
    dragging = false;
  };

  const onMove = (e) => {
    if (!active) return;
    if (e.touches.length !== 1) { active = false; return; }
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dx <= 0 || Math.abs(dx) <= Math.abs(dy)) { active = false; return; }
      dragging = true;
      overlay.classList.add('dragging');
    }
    const offset = Math.max(0, dx);
    overlay.style.transform = `translateX(${offset}px)`;
    e.preventDefault();
  };

  const onEnd = (e) => {
    if (!active) return;
    const last = (e.changedTouches && e.changedTouches[0]) || null;
    const endX = last ? last.clientX : startX;
    const dx = Math.max(0, endX - startX);
    const dt = Math.max(1, performance.now() - startT);
    const v = dx / dt;
    const wasDragging = dragging;
    overlay.classList.remove('dragging');
    overlay.style.transform = '';
    if (wasDragging && (dx > DIST_THRESHOLD || v > VELOCITY_THRESHOLD)) {
      closeSettings(overlay);
    }
    active = false;
    dragging = false;
  };

  overlay.addEventListener('touchstart', onStart, { passive: true });
  overlay.addEventListener('touchmove', onMove, { passive: false });
  overlay.addEventListener('touchend', onEnd);
  overlay.addEventListener('touchcancel', onEnd);
}

function closeSettings(overlay) {
  if (!settingsOpen) return;
  settingsOpen = false;
  overlay.classList.remove('open');
  setTimeout(() => overlay.remove(), 240);
}

function settingsSection(label) {
  return el('div', { class: 'settings-section' }, [
    el('div', { class: 'settings-section-label', text: label }),
  ]);
}

function settingsCard() {
  return el('div', { class: 'settings-card' });
}

function settingsDivider() {
  return el('div', { class: 'settings-row-divider' });
}

function settingsRow({ icon, label, rightText, chevron, onClick }) {
  const right = el('div', { class: 'settings-row-right-wrap' });
  if (rightText !== undefined) {
    right.append(el('span', { class: 'settings-row-right', text: rightText }));
  }
  if (chevron) {
    const ch = iconNode('chevron-right');
    ch.classList.add('settings-row-chevron');
    right.append(ch);
  }
  return el(onClick ? 'button' : 'div', {
    type: onClick ? 'button' : undefined,
    class: 'settings-row',
    onclick: onClick || undefined,
  }, [
    el('div', { class: 'settings-row-left' }, [
      icon && iconNode(icon),
      el('div', { class: 'settings-row-label', text: label }),
    ]),
    right,
  ]);
}

// ---------- export / import ----------

function attachSheetSwipeDown(sheet, close) {
  let startY = null;
  let lastDy = 0;
  let dragging = false;
  let dragStarted = false;
  const ACTIVATE_PX = 6;
  const CLOSE_PX = 80;
  const isInteractive = (el) => !!(el && el.closest && el.closest('button, input, textarea, a, [role="button"]'));

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (sheet.scrollTop > 0) return;
    if (isInteractive(e.target)) return;
    startY = e.touches[0].clientY;
    lastDy = 0;
    dragging = true;
    dragStarted = false;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!dragging || startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      if (dragStarted) {
        sheet.style.transition = '';
        sheet.style.transform = '';
        dragStarted = false;
      }
      lastDy = 0;
      return;
    }
    if (!dragStarted && dy < ACTIVATE_PX) {
      lastDy = dy;
      return;
    }
    if (!dragStarted) {
      dragStarted = true;
      sheet.style.transition = 'none';
    }
    lastDy = dy;
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (dragStarted) {
      sheet.style.transition = '';
      if (lastDy > CLOSE_PX) {
        close();
      } else {
        sheet.style.transform = '';
      }
    }
    startY = null;
    lastDy = 0;
    dragStarted = false;
  };

  sheet.addEventListener('touchend', finish);
  sheet.addEventListener('touchcancel', finish);
}

function todayFilenameISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function buildExportPayload() {
  const [tasks, tracks] = await Promise.all([
    db.tasks.toArray(),
    db.tracks.toArray(),
  ]);
  return {
    schema: 'tasks-v1',
    exported_at: Date.now(),
    tasks,
    tracks,
  };
}

async function openExportSheet() {
  if (document.querySelector('.settings-sheet-backdrop')) return;

  const counts = el('div', { class: 'settings-counts' });
  const cta = el('button', { type: 'button', class: 'sheet-finish' },
    [iconNode('download'), el('span', { text: 'Скачать' })]);
  const sheet = el('div', { class: 'picker-sheet settings-sheet' }, [
    el('div', { class: 'sheet-handle' }),
    el('div', { class: 'settings-sheet-head' }, [
      el('div', { class: 'settings-sheet-title', text: 'Экспорт' }),
      el('div', { class: 'settings-sheet-sub', text: 'Полная резервная копия в JSON' }),
    ]),
    counts,
    el('div', { class: 'settings-file-row' }, [
      iconNode('file-text'),
      el('span', { text: `tasks-${todayFilenameISO()}.json` }),
    ]),
    cta,
  ]);
  const backdrop = el('div', { class: 'picker-backdrop settings-sheet-backdrop' }, [sheet]);

  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const payload = await buildExportPayload();
  const journalCount = payload.tasks.filter(t => t.done_at && t.done_at > 0).length;
  counts.replaceChildren(
    countRow('Задачи', String(payload.tasks.length - journalCount)),
    countDivider(),
    countRow('Треки', String(payload.tracks.length)),
    countDivider(),
    countRow('Журнал выполненного', String(journalCount)),
  );

  cta.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `tasks-${todayFilenameISO()}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    close();
  });

  document.body.appendChild(backdrop);
  attachSheetSwipeDown(sheet, close);
  renderLucide();
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

function countRow(label, value) {
  return el('div', { class: 'settings-count-row' }, [
    el('span', { text: label }),
    el('span', { class: 'settings-count-value', text: value }),
  ]);
}

function countDivider() {
  return el('div', { class: 'settings-count-divider' });
}

async function openImportSheet() {
  if (document.querySelector('.settings-sheet-backdrop')) return;
  const sheet = el('div', { class: 'picker-sheet settings-sheet' });
  const backdrop = el('div', { class: 'picker-backdrop settings-sheet-backdrop' }, [sheet]);

  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const renderPick = () => {
    const cta = el('button', { type: 'button', class: 'sheet-finish' },
      [iconNode('file-up'), el('span', { text: 'Выбрать файл' })]);
    const fileInput = el('input', {
      type: 'file', accept: '.json,application/json', style: { display: 'none' },
    });

    sheet.replaceChildren(
      el('div', { class: 'sheet-handle' }),
      el('div', { class: 'settings-sheet-head' }, [
        el('div', { class: 'settings-sheet-title', text: 'Импорт' }),
        el('div', { class: 'settings-sheet-sub', text: 'Восстановить из резервной копии JSON' }),
      ]),
      el('div', { class: 'settings-warning' }, [
        iconNode('triangle-alert'),
        el('span', { text: 'Импорт заменит все текущие задачи и треки. Это действие нельзя отменить.' }),
      ]),
      cta,
      el('button', { type: 'button', class: 'settings-cancel', text: 'Отмена', onclick: close }),
      fileInput,
    );

    cta.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.tracks)) {
          throw new Error('Неверный формат файла');
        }
        const current = await buildExportPayload();
        renderPreview(file, parsed, current);
      } catch (e) {
        renderError(e.message || String(e));
      }
    });

    renderLucide();
  };

  const renderError = (msg) => {
    sheet.replaceChildren(
      el('div', { class: 'sheet-handle' }),
      el('div', { class: 'settings-sheet-head' }, [
        el('div', { class: 'settings-sheet-title', text: 'Не получилось' }),
      ]),
      el('div', { class: 'settings-warning' }, [
        iconNode('triangle-alert'),
        el('span', { text: msg }),
      ]),
      el('button', { type: 'button', class: 'sheet-finish', onclick: renderPick },
        [el('span', { text: 'Выбрать другой файл' })]),
      el('button', { type: 'button', class: 'settings-cancel', text: 'Отмена', onclick: close }),
    );
    renderLucide();
  };

  const renderPreview = (file, parsed, current) => {
    const exportedAt = parsed.exported_at ? new Date(parsed.exported_at) : null;
    const curJournal = current.tasks.filter(t => t.done_at && t.done_at > 0).length;
    const fileJournal = parsed.tasks.filter(t => t.done_at && t.done_at > 0).length;

    sheet.replaceChildren(
      el('div', { class: 'sheet-handle' }),
      el('div', { class: 'settings-sheet-head' }, [
        el('div', { class: 'settings-sheet-title', text: 'Импорт' }),
        el('div', {
          class: 'settings-sheet-sub',
          text: exportedAt
            ? `Резервная копия от ${exportedAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`
            : 'Резервная копия',
        }),
      ]),
      el('div', { class: 'settings-file-chip' }, [
        iconNode('file-text'),
        el('span', { text: file.name }),
        el('button', { type: 'button', class: 'settings-file-chip-x', onclick: renderPick }, [iconNode('x')]),
      ]),
      el('div', { class: 'settings-compare' }, [
        compareCol('СЕЙЧАС', false, [
          `${current.tasks.length - curJournal} ${plzTask(current.tasks.length - curJournal)}`,
          `${current.tracks.length} ${plzTrack(current.tracks.length)}`,
          `${curJournal} в журнале`,
        ]),
        compareCol('В ФАЙЛЕ', true, [
          `${parsed.tasks.length - fileJournal} ${plzTask(parsed.tasks.length - fileJournal)}`,
          `${parsed.tracks.length} ${plzTrack(parsed.tracks.length)}`,
          `${fileJournal} в журнале`,
        ]),
      ]),
      el('button', {
        type: 'button', class: 'sheet-finish',
        onclick: async () => {
          try {
            await db.transaction('rw', db.tasks, db.tracks, async () => {
              await db.tasks.clear();
              await db.tracks.clear();
              if (parsed.tracks.length) await db.tracks.bulkAdd(parsed.tracks);
              if (parsed.tasks.length) await db.tasks.bulkAdd(parsed.tasks);
            });
            location.reload();
          } catch (e) {
            renderError('Не удалось записать данные: ' + (e.message || String(e)));
          }
        },
      }, [el('span', { text: 'Заменить' })]),
      el('button', { type: 'button', class: 'settings-cancel', text: 'Отмена', onclick: close }),
    );
    renderLucide();
  };

  document.body.appendChild(backdrop);
  attachSheetSwipeDown(sheet, close);
  renderPick();
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

function compareCol(label, accent, lines) {
  return el('div', { class: 'settings-compare-col' + (accent ? ' accent' : '') }, [
    el('div', { class: 'settings-compare-label', text: label }),
    ...lines.map(t => el('div', { class: 'settings-compare-row', text: t })),
  ]);
}

function plzTask(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'задач';
  if (m10 === 1) return 'задача';
  if (m10 >= 2 && m10 <= 4) return 'задачи';
  return 'задач';
}
function plzTrack(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'треков';
  if (m10 === 1) return 'трек';
  if (m10 >= 2 && m10 <= 4) return 'трека';
  return 'треков';
}

// ---------- wiki sync ----------

const WIKI_REPO = 'alexeymamaev/tasks';
const WIKI_FEED_PATH = 'data/tasks-feed.json';
const WIKI_TOKEN_KEY = 'tasks.wiki_pat';

function getWikiToken() {
  try { return localStorage.getItem(WIKI_TOKEN_KEY) || ''; } catch { return ''; }
}
function setWikiToken(v) {
  try {
    if (v) localStorage.setItem(WIKI_TOKEN_KEY, v);
    else localStorage.removeItem(WIKI_TOKEN_KEY);
  } catch {}
}

// ms timestamp → 'YYYY-MM-DD'. Used for feed-shaped tasks (wiki cares about
// the day, not the exact moment).
function msToIsoDate(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' → ms (start of local day). Inverse of msToIsoDate, lossy
// (drops time of day) — fine since the feed never carried it.
function isoDateToMs(s) {
  if (!s) return 0;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Convert a feed task (canonical, ISO dates) into a local Dexie record.
function feedToLocal(fe, trackByName) {
  const track = fe.track_name ? trackByName.get(fe.track_name) : null;
  return {
    icon: matchIcons(fe.text, 1)[0]?.name || DEFAULT_ICON,
    text: fe.text,
    notes: fe.notes || '',
    deadline: fe.deadline || null,
    track_id: track ? track.id : null,
    created_at: isoDateToMs(fe.created_at) || Date.now(),
    done_at: isoDateToMs(fe.done_at) || 0,
    deleted_at: isoDateToMs(fe.deleted_at) || 0,
    blocker: null,
    external_id: fe.id,
    updated_at: fe.updated_at || Date.now(),
  };
}

// Same shape, returned as a partial patch for db.tasks.update().
function feedToLocalPatch(fe, trackByName) {
  const track = fe.track_name ? trackByName.get(fe.track_name) : null;
  return {
    text: fe.text,
    notes: fe.notes || '',
    deadline: fe.deadline || null,
    track_id: track ? track.id : null,
    done_at: isoDateToMs(fe.done_at) || 0,
    deleted_at: isoDateToMs(fe.deleted_at) || 0,
    external_id: fe.id,
    updated_at: fe.updated_at || Date.now(),
  };
}

// Local Dexie record → feed-shaped task. Used when PWA-side wins.
function localToFeed(lo, tracksById) {
  const track = lo.track_id ? tracksById.get(lo.track_id) : null;
  return {
    id: lo.external_id,
    text: lo.text,
    track_name: track ? track.name : null,
    deadline: lo.deadline || null,
    created_at: msToIsoDate(lo.created_at) || msToIsoDate(Date.now()),
    done_at: msToIsoDate(lo.done_at) || null,
    deleted_at: msToIsoDate(lo.deleted_at) || null,
    notes: lo.notes || '',
    updated_at: lo.updated_at || lo.created_at || Date.now(),
  };
}

// Stable-from-text fallback id (matches sync_wiki.py.stable_id_from_text).
async function sha1Hex12(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

async function syncWithWiki({ quiet = false } = {}) {
  const reportError = quiet ? (e) => console.warn('sync:', e) : showError;
  const pat = getWikiToken();
  if (!pat) {
    reportError(new Error('Сначала задай GitHub токен в Settings → WIKI'));
    return;
  }
  const apiUrl = `https://api.github.com/repos/${WIKI_REPO}/contents/${WIKI_FEED_PATH}`;
  const authHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // One GET → merge → PUT pass. Returns one of:
  //   { ok: true, counts }   — synced (or no-op, nothing to PUT)
  //   { conflict: true }     — PUT 409: feed sha went stale (another writer
  //                            landed between our GET and PUT) → caller retries
  //   { aborted: true }      — IDB connection lost mid-write, recovery kicked in
  //   { error: Error }       — anything else → caller reports and gives up
  async function attempt() {
    let getRes;
    try {
      getRes = await fetch(apiUrl, { headers: authHeaders });
    } catch (e) {
      return { error: new Error('Сеть: ' + e.message) };
    }
    if (!getRes.ok) {
      return { error: new Error(`GET feed: ${getRes.status} ${getRes.statusText}`) };
    }
    const meta = await getRes.json();
    let feed;
    try {
      feed = JSON.parse(base64ToUtf8(meta.content));
    } catch (e) {
      return { error: new Error('Неверный JSON фида: ' + e.message) };
    }
    const feedSha = meta.sha;

    // Load local raw (no isLive filter — we sync tombstones too)
    const [localTasks, localTracks] = await Promise.all([
      db.tasks.toArray(),
      db.tracks.toArray(),
    ]);
    let tracksByName = new Map(localTracks.map(t => [t.name, t]));
    let tracksById = new Map(localTracks.map(t => [t.id, t]));

    // Reconcile track definitions inbound (create-missing only). The feed
    // carries full track defs (name/category/icon/position); a track created on
    // another device arrives here as a name we don't have locally. Create it so
    // the task loop below can link by name instead of dropping track_id to null.
    // Add-only: renames/icon-changes/deletes are NOT propagated (tracks have no
    // updated_at — see wiki-sync.md "несколько устройств"). Idempotent across
    // 409 retries: localTracks is re-read each attempt, so already-created
    // tracks are present and skipped.
    const missingTracks = (feed.tracks || []).filter(
      ft => ft.name && !tracksByName.has(ft.name),
    );
    if (missingTracks.length) {
      const now = Date.now();
      await db.tracks.bulkAdd(missingTracks.map(ft => ({
        name: ft.name,
        icon: ft.icon || DEFAULT_ICON,
        category: ft.category || 'personal',
        position: ft.position || 0,
        created_at: now,
        last_used_at: now,
      })));
      const refreshed = await db.tracks.toArray();
      tracksByName = new Map(refreshed.map(t => [t.name, t]));
      tracksById = new Map(refreshed.map(t => [t.id, t]));
    }

    // Stamp external_id on any local task missing one (legacy v3 record).
    for (const t of localTasks) {
      if (!t.external_id && t.text) {
        t.external_id = await sha1Hex12(t.text);
      }
    }

    const localByExt = new Map();
    for (const t of localTasks) {
      if (t.external_id) localByExt.set(t.external_id, t);
    }

    const feedTasksOut = [];
    const localOps = []; // { kind, id?, task?, patch? }
    let added = 0, downloaded = 0, uploaded = 0;
    const seenExt = new Set();

    for (const fe of (feed.tasks || [])) {
      seenExt.add(fe.id);
      const lo = localByExt.get(fe.id);
      if (!lo) {
        added++;
        localOps.push({ kind: 'add', task: feedToLocal(fe, tracksByName) });
        feedTasksOut.push(fe);
        continue;
      }
      const lu = lo.updated_at || lo.created_at || 0;
      const fu = fe.updated_at || 0;
      if (fu > lu) {
        downloaded++;
        localOps.push({ kind: 'update', id: lo.id, patch: feedToLocalPatch(fe, tracksByName) });
        feedTasksOut.push(fe);
      } else if (lu > fu) {
        uploaded++;
        feedTasksOut.push(localToFeed(lo, tracksById));
      } else {
        feedTasksOut.push(fe);
      }
    }

    // Local tasks not represented in feed → push, and stamp external_id back
    for (const lo of localTasks) {
      if (!lo.external_id) continue;
      if (seenExt.has(lo.external_id)) continue;
      uploaded++;
      feedTasksOut.push(localToFeed(lo, tracksById));
      if (lo.external_id) {
        localOps.push({
          kind: 'update',
          id: lo.id,
          patch: { external_id: lo.external_id, updated_at: lo.updated_at || Date.now() },
        });
      }
    }

    // Apply local ops. syncWriting suppresses the mutation hooks' push-scheduling
    // so these inbound writes don't bounce back as a fresh outbound sync.
    syncWriting = true;
    try {
      await db.transaction('rw', db.tasks, async () => {
        for (const op of localOps) {
          if (op.kind === 'add') await db.tasks.add(op.task);
          else await db.tasks.update(op.id, op.patch);
        }
      });
    } catch (e) {
      if (isIdbDisconnectError(e)) { await recoverDb(); return { aborted: true }; }
      return { error: e };
    } finally {
      syncWriting = false;
    }

    // Build new feed payload
    const newFeed = {
      schema: 1,
      generated_at: new Date().toISOString().slice(0, 10),
      tasks: feedTasksOut,
      // Source from tracksById (refreshed after inbound create-missing) so a
      // track we just adopted from the feed isn't dropped on this same PUT.
      tracks: [...tracksById.values()].map(t => ({
        name: t.name,
        category: t.category || 'personal',
        icon: t.icon || null,
        position: t.position || 0,
      })),
    };

    // PUT updated feed (only if anything changed)
    const changed = uploaded > 0 || added > 0 || downloaded > 0;
    if (changed) {
      const putBody = {
        message: 'PWA sync',
        content: utf8ToBase64(JSON.stringify(newFeed, null, 2) + '\n'),
        sha: feedSha,
      };
      let putRes;
      try {
        putRes = await fetch(apiUrl, {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        });
      } catch (e) {
        return { error: new Error('Сеть PUT: ' + e.message) };
      }
      if (putRes.status === 409) return { conflict: true };
      if (!putRes.ok) {
        const text = await putRes.text().catch(() => '');
        return { error: new Error(`PUT feed: ${putRes.status} ${putRes.statusText} ${text}`) };
      }
    }

    return { ok: true, counts: { added, downloaded, uploaded } };
  }

  // Retry only on 409 (stale sha): re-GET, re-merge against current DB, re-PUT.
  // The merge is idempotent — already-applied inbound ops won't re-add, and
  // still-local changes re-upload — so each retry converges instead of clobbering.
  const MAX_ATTEMPTS = 3;
  let result;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    result = await attempt();
    if (!result.conflict) break;
  }
  if (result.aborted) return; // recoverDb already surfaced a banner
  if (result.error) { reportError(result.error); return; }
  if (result.conflict) {
    reportError(new Error('Синк: конфликт версий фида, попробуй ещё раз'));
    return;
  }

  await renderMain();
  const { added, downloaded, uploaded } = result.counts;
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (downloaded) parts.push(`↓${downloaded}`);
  if (uploaded) parts.push(`↑${uploaded}`);
  // Quiet auto-sync (cold-start): show banner only if something actually
  // changed — silent on no-op syncs to avoid a "ничего не изменилось"
  // banner on every app open.
  if (quiet && !parts.length) return;
  showBanner(
    parts.length ? `Синк: ${parts.join(' ')}` : 'Синк: всё в одном состоянии',
    { variant: 'ok', autoHide: 5000 },
  );
}

// ---------- auto-sync triggers (event-driven, no polling) ----------
//
// No interval timer. Sync fires on meaningful events instead:
//   - app comes to the foreground / a bfcache restore / connectivity returns
//     → throttled PULL (catches tasks added elsewhere, e.g. via Claude)
//   - a local edit settles (debounced) → PUSH (propagates your own changes)
// A throttle guards pulls so rapid focus-flapping can't spam GitHub, and a
// single in-flight guard coalesces overlapping auto-triggers. Concurrent-writer
// conflicts are handled by syncWithWiki's own 409 retry.

const SYNC_PULL_THROTTLE_MS = 45 * 1000; // skip foreground pulls within 45s of last sync
const PUSH_DEBOUNCE_MS = 4000;           // coalesce a burst of edits into one push
let lastSyncAt = 0;
let syncInFlight = false;
let pushDebounceTimer = null;

// Best-effort quiet sync. Silent on errors and no-op syncs. Coalesced via
// syncInFlight so two triggers landing together don't double-fire.
async function autoSync(reason) {
  if (!getWikiToken()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    await syncWithWiki({ quiet: true });
    lastSyncAt = Date.now();
  } catch (e) {
    console.warn(`auto-sync (${reason}) failed:`, e);
  } finally {
    syncInFlight = false;
  }
}

// Pull trigger, throttled — foreground / pageshow / online.
function autoSyncPull(reason) {
  if (Date.now() - lastSyncAt < SYNC_PULL_THROTTLE_MS) return;
  autoSync(reason);
}

// Push trigger, debounced — fired by the task mutation hooks on user edits.
// Waits for PUSH_DEBOUNCE_MS of quiet so a burst of edits becomes one sync.
function scheduleSyncPush() {
  if (!getWikiToken()) return;
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null;
    autoSync('push');
  }, PUSH_DEBOUNCE_MS);
}

// Cold-start sync: pull latest on app open (kept as a named entry point used by
// boot()). Always runs regardless of throttle — first sync of the session.
async function autoSyncOnBoot() {
  await autoSync('boot');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoSyncPull('foreground');
});
window.addEventListener('pageshow', () => autoSyncPull('pageshow'));
window.addEventListener('online', () => autoSync('online'));

function openWikiTokenSheet(onSaved) {
  if (document.querySelector('.settings-sheet-backdrop')) return;

  const input = el('input', {
    type: 'password', class: 'sheet-text', placeholder: 'ghp_…',
    autocomplete: 'off', spellcheck: false, value: getWikiToken(),
  });
  const cta = el('button', { type: 'button', class: 'sheet-finish' }, [el('span', { text: 'Сохранить' })]);
  const sheet = el('div', { class: 'picker-sheet settings-sheet' }, [
    el('div', { class: 'sheet-handle' }),
    el('div', { class: 'settings-sheet-head' }, [
      el('div', { class: 'settings-sheet-title', text: 'GitHub токен' }),
      el('div', {
        class: 'settings-sheet-sub',
        text: `Personal Access Token со scope «repo» — для чтения и записи ${WIKI_FEED_PATH}.`,
      }),
    ]),
    el('div', { class: 'sheet-input-wrap', style: { margin: '0 16px' } }, [input]),
    cta,
  ]);
  const backdrop = el('div', { class: 'picker-backdrop settings-sheet-backdrop' }, [sheet]);

  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  cta.addEventListener('click', () => {
    setWikiToken(input.value.trim());
    if (typeof onSaved === 'function') onSaved();
    close();
  });

  document.body.appendChild(backdrop);
  attachSheetSwipeDown(sheet, close);
  renderLucide();
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    input.focus();
  });
}

// ---------- boot ----------

async function boot(retry = 0) {
  try {
    await ensureDbOpen();
    await renderApp();
  } catch (e) {
    if (isIdbDisconnectError(e) && retry < 2) {
      await recoverDb();
      return boot(retry + 1);
    }
    showError(e);
    return;
  }
  // Fire-and-forget: pull latest feed from wiki after first paint.
  autoSyncOnBoot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
