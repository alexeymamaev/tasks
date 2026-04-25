'use strict';

// ---------- visible status overlay ----------

function errBar() {
  let bar = document.getElementById('err-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'err-bar';
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

function showBanner(msg, { variant = 'info', autoHide = 0 } = {}) {
  const bar = errBar();
  bar.style.background = variant === 'ok' ? '#2d6a4f' : '#3b5a80';
  bar.textContent = msg;
  if (autoHide) {
    const snapshot = msg;
    setTimeout(() => {
      const b = document.getElementById('err-bar');
      if (b && b.textContent === snapshot) b.remove();
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
    showBanner('База снова на связи. Повтори действие.', { variant: 'ok', autoHide: 4000 });
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

async function listActive() {
  const arr = await db.tasks.where('done_at').equals(0).toArray();
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
//      OR (deadline = today AND now >= 16:00 AND task NOT created today)
// Tasks created today are always fresh on their own deadline day — they
// haven't had a chance to buksovat yet, even if the day is winding down.
function isStuckNow(task, now = new Date()) {
  if (!task.deadline) return false;
  const today = todayISO();
  if (task.deadline < today) return true;
  if (task.deadline === today && now.getHours() >= STUCK_HOUR) {
    if (task.created_at >= startOfTodayMs()) return false;
    return true;
  }
  return false;
}

// fresh = deadline = today AND (now < 16:00 OR created today)
function isFreshForToday(task, now = new Date()) {
  if (!task.deadline) return false;
  const today = todayISO();
  if (task.deadline !== today) return false;
  if (now.getHours() < STUCK_HOUR) return true;
  if (task.created_at >= startOfTodayMs()) return true;
  return false;
}

function daysBetweenIso(fromIso, toIso) {
  const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const a = toDate(fromIso), b = toDate(toIso);
  return Math.round((b - a) / 86400000);
}

async function listTodayStuck() {
  const active = await listActive();
  const now = new Date();
  return active.filter(t => isStuckNow(t, now))
    .sort((a, b) => {
      // Oldest first_stuck_at first (most stuck on top)
      const af = a.first_stuck_at || todayISO();
      const bf = b.first_stuck_at || todayISO();
      if (af !== bf) return af < bf ? -1 : 1;
      // tiebreaker: oldest created first
      return a.created_at - b.created_at;
    });
}

async function listTodayFresh() {
  const active = await listActive();
  const now = new Date();
  return active.filter(t => isFreshForToday(t, now))
    .sort((a, b) => a.created_at - b.created_at);
}

// Interpretation C: sticky first_stuck_at, set once when task first transitions
// into stuck state. Sweep on every Today render to catch newly-stuck tasks.
// Also: clean up misfired "first_stuck_at=today" for tasks that turned out fresh
// (e.g., created today but briefly misclassified by a buggy earlier rule).
async function sweepStuckTimestamps() {
  const active = await listActive();
  const now = new Date();
  const today = todayISO();
  const updates = [];
  for (const t of active) {
    const stuck = isStuckNow(t, now);
    if (stuck && !t.first_stuck_at) {
      updates.push(db.tasks.update(t.id, { first_stuck_at: today }));
    } else if (!stuck && t.first_stuck_at === today) {
      updates.push(db.tasks.update(t.id, { first_stuck_at: null }));
    }
  }
  if (updates.length) await Promise.all(updates);
}

async function listJournal() {
  const start = startOfTodayMs();
  const arr = await db.tasks
    .where('done_at').above(0)
    .filter(t => t.done_at >= start)
    .toArray();
  arr.sort((a, b) => b.done_at - a.done_at);
  return arr;
}

async function listAllDone() {
  const arr = await db.tasks.where('done_at').above(0).toArray();
  arr.sort((a, b) => b.done_at - a.done_at);
  return arr;
}

async function deleteAllDone() {
  await db.tasks.where('done_at').above(0).delete();
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

async function addTask(text) {
  return db.tasks.add({
    icon: 'circle-dashed',
    text,
    notes: '',
    deadline: null,
    track_id: null,
    created_at: Date.now(),
    done_at: 0,
    first_stuck_at: null,
    bump_count: 0,
    blocker: null,
  });
}

async function markDone(id) {
  await db.tasks.update(id, { done_at: Date.now(), first_stuck_at: null });
}

async function undoDone(id) {
  await db.tasks.update(id, { done_at: 0, first_stuck_at: null });
}

// ---------- tracks ----------

async function listTracks() {
  const arr = await db.tracks.toArray();
  arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return arr;
}

async function addTrack({ name, icon, category = 'personal' }) {
  const all = await db.tracks.toArray();
  const maxPos = all.reduce((m, t) => Math.max(m, t.position ?? 0), 0);
  return db.tracks.add({
    name: name.trim(),
    icon: icon || DEFAULT_ICON,
    category,
    position: maxPos + 1,
    created_at: Date.now(),
  });
}

async function deleteTrack(id) {
  await db.transaction('rw', db.tracks, db.tasks, async () => {
    await db.tracks.delete(id);
    const linked = await db.tasks.where('track_id').equals(id).toArray();
    for (const t of linked) {
      await db.tasks.update(t.id, { track_id: null });
    }
  });
}

async function updateTrack(id, patch) {
  await db.tracks.update(id, patch);
}

// Progress for a track = done / (done + active) over the track's lifetime.
async function trackStats(trackId) {
  const linked = await db.tasks.where('track_id').equals(trackId).toArray();
  let done = 0;
  for (const t of linked) if (t.done_at) done++;
  return { done, total: linked.length };
}

async function listTasksByTrack(trackId) {
  return db.tasks.where('track_id').equals(trackId).toArray();
}

const TRACK_CATEGORIES = ['work', 'personal', 'inactive'];
const TRACK_CATEGORY_LABELS = { work: 'Работа', personal: 'Личное', inactive: 'Неактивные' };

// ---------- render ----------

function greeting() {
  const h = new Date().getHours();
  if (h >= 6 && h < 11) return 'Доброе утро!';
  if (h >= 11 && h < 18) return 'Добрый день!';
  if (h >= 18 && h < 23) return 'Добрый вечер!';
  return 'Доброй ночи!';
}

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
const ICON_ROW_SIZE = 8;
const RECENTS_KEY = 'tasks.recentIcons';
const RECENTS_MAX = 20;

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

function iconNode(name) {
  const el = document.createElement('i');
  el.className = 'icon';
  el.setAttribute('data-lucide', name || DEFAULT_ICON);
  return el;
}

function renderLucide() {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }
}

function attachLongPress(el, { onLongPress, onTap, ms = 500 }) {
  let timer = null;
  let firedLong = false;
  let moved = false;
  let pressed = false;
  let startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
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
  el.addEventListener('pointermove', (e) => {
    if (!pressed) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (dx*dx + dy*dy > 100) {
      moved = true;
      cancel();
    }
  });
  el.addEventListener('pointerup', (e) => {
    if (!pressed) return;
    const wasLong = firedLong;
    const wasMoved = moved;
    pressed = false;
    cancel();
    if (!wasLong && !wasMoved) onTap?.(e);
  });
  const bail = () => { pressed = false; cancel(); };
  el.addEventListener('pointercancel', bail);
  el.addEventListener('pointerleave', bail);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
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

function cardBase(task, tracksById) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = String(task.id);

  const iconRow = document.createElement('div');
  iconRow.className = 'icon-row';
  iconRow.appendChild(iconNode(task.icon));
  if (task.notes && task.notes.trim()) {
    const mark = document.createElement('div');
    mark.className = 'notes-mark';
    mark.appendChild(iconNode('notebook-pen'));
    iconRow.appendChild(mark);
  }
  el.appendChild(iconRow);

  const fmt = formatDeadline(task.deadline);
  if (fmt) {
    const dl = document.createElement('div');
    dl.className = 'deadline ' + fmt.kind;
    dl.textContent = fmt.text;
    el.appendChild(dl);
  }

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = task.text;
  el.appendChild(text);

  const track = task.track_id && tracksById ? tracksById.get(task.track_id) : null;
  if (track) {
    const mark = document.createElement('div');
    mark.className = 'track-mark';
    mark.appendChild(iconNode(track.icon || DEFAULT_ICON));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = track.name;
    mark.appendChild(name);
    el.appendChild(mark);
  }

  return el;
}

function playStampImpact(cardEl, task) {
  return new Promise(resolve => {
    const finalRot = ((task.id * 13) % 15) - 7;

    const shockwave = document.createElement('div');
    shockwave.className = 'stamp-shockwave';
    cardEl.appendChild(shockwave);

    const badge = document.createElement('div');
    badge.className = 'stamp-badge';
    badge.style.setProperty('--final-rot', finalRot + 'deg');
    badge.appendChild(checkBadgeSvg());
    cardEl.appendChild(badge);

    cardEl.classList.add('stamping');

    setTimeout(() => resolve(), 280);
  });
}

function activeCardNode(task, tracksById) {
  const el = cardBase(task, tracksById);
  attachLongPress(el, {
    onTap: () => openSheet({ task }),
    onLongPress: async () => {
      if (el.classList.contains('stamping') || el.classList.contains('removing')) return;
      try {
        await playStampImpact(el, task);
        await markDone(task.id);
        showUndoSnackbar(task.id);
        setTimeout(() => { renderMain().catch(showError); }, 60);
      } catch (e) {
        el.classList.remove('stamping');
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
  });
  return el;
}

// ---------- undo snackbar ----------

let snackbarTimer = null;
let editingBlockerTaskId = null;
let splittingTaskId = null;

function showSnackbar({ label: labelText, onUndo }) {
  if (snackbarTimer) { clearTimeout(snackbarTimer); snackbarTimer = null; }
  document.querySelectorAll('.snackbar').forEach(el => el.remove());

  const sb = document.createElement('div');
  sb.className = 'snackbar';

  const label = document.createElement('span');
  label.className = 'snackbar-label';
  label.textContent = labelText;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'snackbar-action';
  btn.textContent = 'Отменить';
  btn.addEventListener('click', async () => {
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
  });

  sb.append(label, btn);
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

function journalCardNode(task, tracksById) {
  const el = cardBase(task, tracksById);
  el.classList.add('done');
  const badge = document.createElement('div');
  badge.className = 'check-badge';
  const rot = ((task.id * 13) % 15) - 7; // deterministic -7..+7, stable across re-renders
  badge.style.setProperty('--rot', rot + 'deg');
  badge.appendChild(checkBadgeSvg());
  el.appendChild(badge);
  attachLongPress(el, {
    onTap: () => openSheet({ task }),
    onLongPress: async () => {
      if (el.classList.contains('removing')) return;
      el.classList.add('removing');
      try {
        await undoDone(task.id);
        setTimeout(() => { renderMain().catch(showError); }, 200);
      } catch (e) {
        el.classList.remove('removing');
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
  });
  return el;
}

// ---------- pager (Сегодня ↔ Morning ↔ Calendar ↔ Tracks) ----------

const PAGE_COUNT = 4;
const PAGE_WIDTH_PCT = 100 / PAGE_COUNT; // 25
let currentPage = 1; // 0 = сегодня, 1 = morning (default), 2 = calendar, 3 = tracks
let pagerEl = null;
let inputBarEl = null;

async function renderApp() {
  const root = document.getElementById('app');
  root.replaceChildren();
  root.classList.add('app-root');

  pagerEl = document.createElement('div');
  pagerEl.className = 'pager';

  const pToday = document.createElement('section');
  pToday.className = 'page page-today';
  const pMorning = document.createElement('section');
  pMorning.className = 'page page-morning';
  const pCalendar = document.createElement('section');
  pCalendar.className = 'page page-calendar';
  const pTracks = document.createElement('section');
  pTracks.className = 'page page-tracks';
  pagerEl.append(pToday, pMorning, pCalendar, pTracks);

  root.appendChild(pagerEl);

  inputBarEl = document.createElement('div');
  inputBarEl.className = 'input-bar';
  root.appendChild(inputBarEl);

  attachPagerSwipe(pagerEl);
  await Promise.all([renderToday(), renderMorning(), renderCalendar(), renderTracks()]);
  setPage(currentPage, false);
}

function setPage(idx, animate = true) {
  currentPage = Math.max(0, Math.min(PAGE_COUNT - 1, idx));
  if (!animate) pagerEl.classList.add('no-anim');
  pagerEl.style.transform = `translateX(${-currentPage * PAGE_WIDTH_PCT}%)`;
  if (!animate) requestAnimationFrame(() => pagerEl.classList.remove('no-anim'));
  updateInputBar();
  updatePagePill();
  // Calendar always opens with today as the leftmost visible column
  if (currentPage === 2) requestAnimationFrame(scrollCalendarToToday);
}

function updateInputBar() {
  if (!inputBarEl) return;
  inputBarEl.replaceChildren();
  if (currentPage === 0 || currentPage === 2) {
    // Сегодня и Календарь — read-only, без input-bar
    inputBarEl.style.display = 'none';
    return;
  }
  inputBarEl.style.display = '';
  const wrap = document.createElement('button');
  wrap.className = 'wrap';
  wrap.type = 'button';
  wrap.append(iconNode('plus'));
  const label = document.createElement('span');
  if (currentPage === 1) {
    label.textContent = 'Добавить задачу';
    wrap.addEventListener('click', () => openSheet({ task: null }));
  } else {
    label.textContent = 'Добавить трек';
    wrap.addEventListener('click', () => openTrackSheet({ track: null }));
  }
  wrap.append(label);
  inputBarEl.appendChild(wrap);
  renderLucide();
}

function updatePagePill() {
  document.querySelectorAll('.page-pill-half').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.page) === currentPage);
  });
}

function pagePillNode() {
  const wrap = document.createElement('div');
  wrap.className = 'page-pill';
  wrap.setAttribute('data-no-swipe', '');
  const mkHalf = (label, idx) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'page-pill-half' + (idx === currentPage ? ' active' : '');
    el.textContent = label;
    el.dataset.page = String(idx);
    el.addEventListener('click', () => setPage(idx));
    return el;
  };
  wrap.append(mkHalf('Сегодня', 0), mkHalf('Задачи', 1), mkHalf('План', 2), mkHalf('Треки', 3));
  return wrap;
}

function sectionDivider(label, opts) {
  const d = document.createElement('div');
  d.className = 'divider' + (label ? '' : ' plain');
  if (label) {
    const l = document.createElement('span');
    l.className = 'divider-label';
    l.textContent = label;
    d.appendChild(l);
  }
  if (opts?.link) {
    d.classList.add('has-link');
    const line = document.createElement('span');
    line.className = 'divider-line';
    d.appendChild(line);
    const link = document.createElement('span');
    link.className = 'divider-link';
    link.textContent = opts.link.text;
    link.addEventListener('click', (e) => { e.stopPropagation(); opts.link.onClick(); });
    d.appendChild(link);
  }
  return d;
}

// Horizontal swipe between pages. A move is considered a swipe only if the
// pointer moves horizontally > vertically past a small threshold, so vertical
// scroll inside a page is never hijacked. Drag handles on track strips
// stopPropagation to own their gestures.
function attachPagerSwipe(el) {
  let startX = 0, startY = 0, dragging = false, active = false, baseTx = 0;
  let multiTouch = false;
  // Lock the gesture to the first pointerId so a second finger landing
  // mid-swipe can't overwrite startX/baseTx and produce a wild dx at end.
  let trackingId = null;
  // Remember the dominant direction during drag, so a final stray sample
  // (palec slightly bouncing back) can't flip the chosen page.
  let maxRight = 0, maxLeft = 0;
  const W = () => window.innerWidth;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      multiTouch = true;
      if (active) {
        active = false;
        if (dragging) {
          dragging = false;
          el.classList.remove('dragging');
          el.style.transform = `translateX(${-currentPage * PAGE_WIDTH_PCT}%)`;
        }
      }
    }
  }, { passive: true });
  const releaseMulti = (e) => { if (e.touches.length === 0) multiTouch = false; };
  el.addEventListener('touchend', releaseMulti, { passive: true });
  el.addEventListener('touchcancel', releaseMulti, { passive: true });

  el.addEventListener('pointerdown', (e) => {
    if (multiTouch) return;
    if (e.target.closest('[data-no-swipe]')) return;
    if (trackingId !== null) return;
    trackingId = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch {}
    active = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    maxRight = 0;
    maxLeft = 0;
    baseTx = -currentPage * W();
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== trackingId) return;
    if (multiTouch) { active = false; return; }
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.3) {
        dragging = true;
        el.classList.add('dragging');
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
    el.style.transform = `translateX(${tx}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== trackingId) return;
    trackingId = null;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    if (!active) return;
    active = false;
    if (!dragging) return;
    el.classList.remove('dragging');
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
    el.style.transform = '';
    setPage(next, true);
    dragging = false;
  };
  el.addEventListener('pointerup', end);
  // pointercancel fires when the OS hijacks the gesture — its clientX is
  // not trustworthy, so snap back rather than computing dx.
  el.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== trackingId) return;
    trackingId = null;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    if (!active) return;
    active = false;
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el.style.transform = '';
    setPage(currentPage, true);
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerId !== trackingId) return;
    if (active && dragging) end(e);
  });
}

// ---------- render: Morning (main) ----------

async function renderMorning() {
  const page = document.querySelector('.page-morning');
  if (!page) return;
  page.replaceChildren();

  const screen = document.createElement('div');
  screen.className = 'screen';

  const topRegion = document.createElement('div');
  topRegion.className = 'top-region';

  const header = document.createElement('div');
  header.className = 'header';
  const headerRow = document.createElement('div');
  headerRow.className = 'header-row';
  const h1 = document.createElement('h1');
  h1.textContent = greeting();
  headerRow.append(h1, pagePillNode());
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = 'давай займемся делом –';
  header.append(headerRow, sub);
  topRegion.appendChild(header);

  const [active, journal, tracks] = await Promise.all([listActive(), listJournal(), listTracks()]);
  const tracksById = new Map(tracks.map(t => [t.id, t]));

  if (active.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Пока пусто. Добавь первую задачу снизу.';
    topRegion.appendChild(empty);
  } else {
    const buckets = { work: [], personal: [], rest: [] };
    active.forEach(t => {
      const track = t.track_id ? tracksById.get(t.track_id) : null;
      if (track && track.category === 'work') buckets.work.push(t);
      else if (track && track.category === 'personal') buckets.personal.push(t);
      else buckets.rest.push(t);
    });
    const nonEmpty = ['work', 'personal', 'rest'].filter(k => buckets[k].length > 0);

    if (nonEmpty.length >= 2) {
      const wrap = document.createElement('div');
      wrap.className = 'active-grouped';
      const sections = [
        { key: 'work', label: 'РАБОТА' },
        { key: 'personal', label: 'ЛИЧНОЕ' },
        { key: 'rest', label: null },
      ];
      for (const { key, label } of sections) {
        const list = buckets[key];
        if (!list.length) continue;
        wrap.appendChild(sectionDivider(label));
        const grid = document.createElement('div');
        grid.className = 'grid';
        list.forEach(t => grid.appendChild(activeCardNode(t, tracksById)));
        wrap.appendChild(grid);
      }
      topRegion.appendChild(wrap);
    } else {
      const grid = document.createElement('div');
      grid.className = 'grid active-grid';
      active.forEach(t => grid.appendChild(activeCardNode(t, tracksById)));
      topRegion.appendChild(grid);
    }
  }

  screen.appendChild(topRegion);

  if (journal.length > 0) {
    screen.appendChild(sectionDivider('ЖУРНАЛ', {
      link: { text: 'Весь журнал', onClick: openHistorySheet },
    }));
    const jgrid = document.createElement('div');
    jgrid.className = 'grid journal-grid';
    journal.forEach(t => jgrid.appendChild(journalCardNode(t, tracksById)));
    screen.appendChild(jgrid);
  }

  page.appendChild(screen);
  renderLucide();
}

// Existing task-mutation call sites use renderMain() after the mutation.
// It now refreshes all four pages so cards/stats stay in sync.
async function renderMain() {
  await Promise.all([renderToday(), renderMorning(), renderCalendar(), renderTracks()]);
}

// ---------- render: Сегодня ----------

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}

function todaySubtitle(stuckCount, freshCount) {
  if (stuckCount === 0 && freshCount === 0) return 'на сегодня пусто.';
  const parts = [];
  if (stuckCount) parts.push(`застрявших ${stuckCount}`);
  if (freshCount) parts.push(`свежих ${freshCount}`);
  return parts.join(' · ');
}

function ageColorVar(days) {
  if (days >= 8) return 'var(--age-4)';
  if (days >= 4) return 'var(--age-3)';
  if (days >= 2) return 'var(--age-2)';
  return 'var(--age-1)';
}

function stuckBlockNode(task, tracksById) {
  const days = task.first_stuck_at
    ? Math.max(1, daysBetweenIso(task.first_stuck_at, todayISO()))
    : 1;
  const word = pluralizeDays(days).toUpperCase();
  const track = task.track_id && tracksById ? tracksById.get(task.track_id) : null;
  const isEditingBlocker = editingBlockerTaskId === task.id;
  const isSplitting = splittingTaskId === task.id;

  const el = document.createElement('div');
  el.className = 'stuck-card-d';
  el.dataset.id = String(task.id);
  el.style.setProperty('--card-age', ageColorVar(days));

  // Left: 4px age stripe
  const stripe = document.createElement('div');
  stripe.className = 'stuck-stripe';
  el.appendChild(stripe);

  // Age block: number + word + flame
  const ageBlock = document.createElement('div');
  ageBlock.className = 'stuck-age-block';
  const num = document.createElement('div');
  num.className = 'stuck-age-num';
  num.textContent = String(days);
  const wordEl = document.createElement('div');
  wordEl.className = 'stuck-age-word';
  wordEl.textContent = word;
  const flame = iconNode('flame');
  flame.classList.add('stuck-age-flame');
  ageBlock.append(num, wordEl, flame);
  el.appendChild(ageBlock);

  // Main column
  const main = document.createElement('div');
  main.className = 'stuck-main';

  // Top section: meta + title (+ optional note) on left, ellipsis on right
  const top = document.createElement('div');
  top.className = 'stuck-top-d';
  const left = document.createElement('div');
  left.className = 'stuck-left-d';

  // Meta line: date · project (только то, что есть)
  const meta = document.createElement('div');
  meta.className = 'stuck-meta-d';
  const metaParts = [];
  if (task.deadline) metaParts.push(formatDateShort(task.deadline));
  if (track) metaParts.push(track.name);
  metaParts.forEach((txt, i) => {
    if (i > 0) {
      const dot = document.createElement('span');
      dot.className = 'meta-d-dot';
      dot.textContent = '·';
      meta.appendChild(dot);
    }
    const span = document.createElement('span');
    span.textContent = txt;
    meta.appendChild(span);
  });
  if (metaParts.length) left.appendChild(meta);

  // Title
  const title = document.createElement('div');
  title.className = 'stuck-title-d';
  title.textContent = task.text;
  left.appendChild(title);

  // Optional blocker chip — hidden during blocker edit or split
  if (task.blocker && !isEditingBlocker && !isSplitting) {
    const note = document.createElement('button');
    note.type = 'button';
    note.className = 'stuck-note';
    note.appendChild(iconNode('lock'));
    const noteText = document.createElement('span');
    noteText.textContent = task.blocker;
    note.appendChild(noteText);
    const xBtn = document.createElement('button');
    xBtn.type = 'button';
    xBtn.className = 'stuck-note-x';
    xBtn.setAttribute('aria-label', 'Снять блокер');
    xBtn.appendChild(iconNode('x'));
    xBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await db.tasks.update(task.id, { blocker: null });
        renderMain().catch(showError);
      } catch (e) {
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    });
    note.appendChild(xBtn);
    note.addEventListener('click', (ev) => {
      if (ev.target.closest('.stuck-note-x')) return;
      ev.stopPropagation();
      editingBlockerTaskId = task.id;
      renderMain().catch(showError);
    });
    left.appendChild(note);
  }

  top.appendChild(left);
  main.appendChild(top);

  // Bottom: split-bar / blocker edit-bar / segmented action bar
  if (isSplitting) {
    main.appendChild(buildSplitBar(task));
  } else if (isEditingBlocker) {
    main.appendChild(buildBlockerEditBar(task));
  } else {
    const segbar = document.createElement('div');
    segbar.className = 'stuck-segbar';
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
          if (el.classList.contains('stamping') || el.classList.contains('removing')) return;
          try {
            await playStampImpact(el, task);
            await markDone(task.id);
            showUndoSnackbar(task.id);
            setTimeout(() => { renderMain().catch(showError); }, 60);
          } catch (e) {
            el.classList.remove('stamping');
            if (isIdbDisconnectError(e)) { await recoverDb(); return; }
            showError(e);
          }
        },
      },
    ];
    segs.forEach((s, i) => {
      if (i > 0) {
        const div = document.createElement('div');
        div.className = 'stuck-seg-divider';
        segbar.appendChild(div);
      }
      segbar.appendChild(s.kind === 'date' ? stuckSegDateBtn(s) : stuckSegBtn(s));
    });
    main.appendChild(segbar);
  }

  el.appendChild(main);

  // Tap outside buttons → open edit sheet (suspended while editing blocker / splitting)
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    if (ev.target.closest('.stuck-seg')) return;
    if (ev.target.closest('.stuck-edit-bar')) return;
    if (ev.target.closest('.stuck-split-bar')) return;
    if (isEditingBlocker || isSplitting) return;
    openSheet({ task });
  });

  return el;
}

function buildBlockerEditBar(task) {
  const bar = document.createElement('div');
  bar.className = 'stuck-edit-bar';

  const inputRow = document.createElement('div');
  inputRow.className = 'stuck-edit-input-row';
  inputRow.appendChild(iconNode('lock'));

  const inputBox = document.createElement('div');
  inputBox.className = 'stuck-edit-input-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = task.blocker || '';
  input.placeholder = 'что мешает?';
  input.className = 'stuck-edit-input';
  input.maxLength = 120;
  input.autocomplete = 'off';
  inputBox.appendChild(input);
  inputRow.appendChild(inputBox);
  bar.appendChild(inputRow);

  const actions = document.createElement('div');
  actions.className = 'stuck-edit-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'stuck-edit-cancel';
  cancel.textContent = 'отмена';
  cancel.addEventListener('click', (ev) => {
    ev.stopPropagation();
    editingBlockerTaskId = null;
    renderMain().catch(showError);
  });

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'stuck-edit-save';
  save.appendChild(iconNode('check'));
  const saveLabel = document.createElement('span');
  saveLabel.textContent = 'сохранить';
  save.appendChild(saveLabel);
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
  save.addEventListener('click', (ev) => {
    ev.stopPropagation();
    commit();
  });

  actions.append(cancel, save);
  bar.appendChild(actions);

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel.click();
    }
  });

  setTimeout(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 30);

  return bar;
}

const SPLIT_MAX_ROWS = 5;

function buildSplitBar(task) {
  const bar = document.createElement('div');
  bar.className = 'stuck-split-bar';

  const rows = document.createElement('div');
  rows.className = 'stuck-split-rows';
  bar.appendChild(rows);

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'stuck-split-plus';
  plusBtn.appendChild(iconNode('plus'));
  const plusLbl = document.createElement('span');
  plusLbl.textContent = 'добавить шаг';
  plusBtn.appendChild(plusLbl);
  bar.appendChild(plusBtn);

  const actions = document.createElement('div');
  actions.className = 'stuck-split-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'stuck-edit-cancel';
  cancelBtn.textContent = 'отмена';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'stuck-split-save';
  saveBtn.appendChild(iconNode('split'));
  const saveLbl = document.createElement('span');
  saveLbl.textContent = 'разделить';
  saveBtn.appendChild(saveLbl);
  actions.append(cancelBtn, saveBtn);
  bar.appendChild(actions);

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
            first_stuck_at: null,
            bump_count: 0,
            blocker: null,
          });
          newIds.push(id);
        }
        await db.tasks.delete(task.id);
      });
      splittingTaskId = null;
      showSnackbar({
        label: `Разделено на ${values.length}`,
        onUndo: async () => {
          await db.transaction('rw', db.tasks, async () => {
            for (const id of newIds) {
              try { await db.tasks.delete(id); } catch {}
            }
            await db.tasks.add(orig);
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
    const row = document.createElement('div');
    row.className = 'stuck-split-row';

    const inputBox = document.createElement('div');
    inputBox.className = 'stuck-split-input-box';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'stuck-split-input';
    input.placeholder = rows.children.length === 0 ? 'что сделать сначала?' : 'дальше…';
    input.maxLength = 120;
    input.autocomplete = 'off';
    inputBox.appendChild(input);
    row.appendChild(inputBox);

    const xBtn = document.createElement('button');
    xBtn.type = 'button';
    xBtn.className = 'stuck-split-row-x';
    xBtn.setAttribute('aria-label', 'Удалить шаг');
    xBtn.appendChild(iconNode('x'));
    xBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      row.remove();
      updateXVisibility();
      updatePlusVisibility();
      updateSaveState();
    });
    row.appendChild(xBtn);

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
  const wrap = document.createElement('label');
  wrap.className = 'stuck-seg stuck-seg-date';
  wrap.appendChild(iconNode(icon));
  const lbl = document.createElement('span');
  lbl.className = 'stuck-seg-label';
  lbl.textContent = label;
  wrap.appendChild(lbl);
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'stuck-seg-date-input';
  input.value = value || '';
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('change', (ev) => {
    ev.stopPropagation();
    if (input.value) onChange(input.value);
  });
  wrap.appendChild(input);
  return wrap;
}

function stuckSegBtn({ icon, label, onClick, accent }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'stuck-seg' + (accent ? ' stuck-seg-accent' : '');
  btn.appendChild(iconNode(icon));
  const lbl = document.createElement('span');
  lbl.className = 'stuck-seg-label';
  lbl.textContent = label;
  btn.appendChild(lbl);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

function freshRowNode(task, tracksById) {
  const el = document.createElement('div');
  el.className = 'fresh-row';
  el.dataset.id = String(task.id);

  const icon = iconNode(task.icon || DEFAULT_ICON);
  const text = document.createElement('span');
  text.className = 'fresh-text';
  text.textContent = task.text;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'fresh-check';
  check.setAttribute('aria-label', 'Завершить');
  check.appendChild(iconNode('check'));
  check.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (el.classList.contains('removing')) return;
    check.classList.add('filling');
    renderLucide();
    try {
      await new Promise(r => setTimeout(r, 220));
      el.classList.add('removing');
      await markDone(task.id);
      showUndoSnackbar(task.id);
      setTimeout(() => { renderMain().catch(showError); }, 200);
    } catch (e) {
      el.classList.remove('removing');
      check.classList.remove('filling');
      if (isIdbDisconnectError(e)) { await recoverDb(); return; }
      showError(e);
    }
  });

  el.append(icon, text, check);
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    openSheet({ task });
  });
  return el;
}

async function renderToday() {
  const page = document.querySelector('.page-today');
  if (!page) return;
  page.replaceChildren();

  // Sweep first_stuck_at for newly-stuck tasks
  try {
    await sweepStuckTimestamps();
  } catch (e) {
    if (isIdbDisconnectError(e)) { await recoverDb(); }
  }

  const screen = document.createElement('div');
  screen.className = 'screen';

  const [stuck, fresh, tracks] = await Promise.all([
    listTodayStuck(),
    listTodayFresh(),
    listTracks(),
  ]);
  const tracksById = new Map(tracks.map(t => [t.id, t]));

  // Header
  const header = document.createElement('div');
  header.className = 'header';
  const headerRow = document.createElement('div');
  headerRow.className = 'header-row';
  const h1 = document.createElement('h1');
  h1.textContent = greeting();
  headerRow.append(h1, pagePillNode());
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = todaySubtitle(stuck.length, fresh.length);
  header.append(headerRow, sub);
  screen.appendChild(header);

  // Stuck blocks
  if (stuck.length) {
    const stuckList = document.createElement('div');
    stuckList.className = 'stuck-list';
    for (const t of stuck) {
      stuckList.appendChild(stuckBlockNode(t, tracksById));
    }
    screen.appendChild(stuckList);
  }

  // Fresh section — compact rows (icon + text + check circle)
  if (fresh.length) {
    const freshLabel = document.createElement('div');
    freshLabel.className = 'today-section-label';
    freshLabel.textContent = 'СВЕЖИЕ · СЕГОДНЯ';
    screen.appendChild(freshLabel);
    const freshList = document.createElement('div');
    freshList.className = 'fresh-list';
    for (const t of fresh) {
      freshList.appendChild(freshRowNode(t, tracksById));
    }
    screen.appendChild(freshList);
  }

  // Empty state
  if (stuck.length === 0 && fresh.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'На сегодня ничего. Отдыхай.';
    screen.appendChild(empty);
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
  const el = document.createElement('div');
  el.className = 'cal-card' + (isClosed ? ' is-closed' : '');
  el.dataset.id = String(task.id);

  const iconRow = document.createElement('div');
  iconRow.className = 'icon-row';
  iconRow.appendChild(iconNode(task.icon || DEFAULT_ICON));
  if (task.notes) {
    const notes = document.createElement('span');
    notes.className = 'notes-mark';
    notes.appendChild(iconNode('notebook-pen'));
    iconRow.appendChild(notes);
  }
  el.appendChild(iconRow);

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = task.text;
  el.appendChild(text);

  const pill = document.createElement('div');
  pill.className = 'deadline';
  if (isClosed) {
    const d = new Date(task.done_at);
    pill.textContent = `${d.getDate()} ${CAL_MONTHS[d.getMonth()].toLowerCase()}`;
    el.appendChild(pill);
    const badge = document.createElement('div');
    badge.className = 'check-badge';
    const rot = -16 + ((task.id * 7) % 16);
    badge.style.setProperty('--rot', `${rot}deg`);
    badge.appendChild(iconNode('check'));
    el.appendChild(badge);
  } else {
    const dl = task.deadline;
    if (dl === todayIso) {
      pill.textContent = 'сегодня';
      pill.classList.add('today');
      el.appendChild(pill);
    } else if (dl && dl < todayIso) {
      pill.textContent = 'overdue';
      pill.classList.add('overdue');
      el.appendChild(pill);
    } else if (dl) {
      const d = isoToDate(dl);
      pill.textContent = `${d.getDate()} ${CAL_MONTHS[d.getMonth()].toLowerCase()}`;
      el.appendChild(pill);
    }
  }

  el.addEventListener('click', () => openSheet({ task }));
  return el;
}

async function renderCalendar() {
  const page = document.querySelector('.page-calendar');
  if (!page) return;
  page.replaceChildren();

  const screen = document.createElement('div');
  screen.className = 'screen-cal';

  // Header
  const header = document.createElement('div');
  header.className = 'header';
  const headerRow = document.createElement('div');
  headerRow.className = 'header-row';
  const h1 = document.createElement('h1');
  h1.textContent = 'Календарь';
  headerRow.append(h1, pagePillNode());
  header.appendChild(headerRow);
  const sub = document.createElement('div');
  sub.className = 'sub cal-quote';
  sub.textContent = 'Меня не интересует почему «нет», меня интересует, что вы сделали, чтобы было «да».';
  header.appendChild(sub);
  screen.appendChild(header);

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
  const stripWrap = document.createElement('div');
  stripWrap.className = 'cal-strip-wrap';

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

  const strip = document.createElement('div');
  strip.className = 'cal-strip';

  let todayColEl = null;
  for (let i = 0; i < days.length; i++) {
    const dateIso = days[i];
    const col = document.createElement('div');
    col.className = 'cal-col' + (dateIso === today ? ' is-today' : '');
    if (dateIso === today) todayColEl = col;

    const title = document.createElement('div');
    title.className = 'cal-day-title';
    title.textContent = calDayLabel(dateIso, today);
    col.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'cal-day-sub';
    sub.textContent = calWeekday(dateIso);
    col.appendChild(sub);

    const headerHd = document.createElement('div');
    headerHd.className = 'cal-hdiv';
    col.appendChild(headerHd);

    const bucket = buckets.get(dateIso);
    if (bucket) {
      // Active first, then closed
      bucket.active.sort((a, b) => a.created_at - b.created_at);
      bucket.closed.sort((a, b) => b.done_at - a.done_at);
      const items = [...bucket.active, ...bucket.closed.map(t => ({ ...t, _closed: true }))];
      items.forEach((t, idx) => {
        if (idx > 0) {
          const hd = document.createElement('div');
          hd.className = 'cal-hdiv';
          col.appendChild(hd);
        }
        col.appendChild(calCardNode(t, t._closed === true || t.done_at > 0, today));
      });
    }

    strip.appendChild(col);

    if (i < days.length - 1) {
      const vd = document.createElement('div');
      vd.className = 'cal-vdiv';
      strip.appendChild(vd);
    }
  }
  stripWrap.appendChild(strip);
  screen.appendChild(stripWrap);

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

  const screen = document.createElement('div');
  screen.className = 'screen';

  const header = document.createElement('div');
  header.className = 'header';
  const headerRow = document.createElement('div');
  headerRow.className = 'header-row';
  const h1 = document.createElement('h1');
  h1.textContent = 'Треки';
  headerRow.append(h1, pagePillNode());
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = 'направления деятельности.';
  header.append(headerRow, sub);
  screen.appendChild(header);

  const tracks = await listTracks();
  const byCat = { work: [], personal: [], inactive: [] };
  tracks.forEach(t => {
    const cat = TRACK_CATEGORIES.includes(t.category) ? t.category : 'personal';
    byCat[cat].push(t);
  });

  // compute stats for all in parallel
  const statsMap = new Map();
  await Promise.all(tracks.map(async t => {
    statsMap.set(t.id, await trackStats(t.id));
  }));

  if (tracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Пока нет треков. Добавь первый снизу.';
    screen.appendChild(empty);
  } else {
    for (const cat of TRACK_CATEGORIES) {
      const list = byCat[cat];
      const sec = document.createElement('section');
      sec.className = 'track-section track-section-' + cat;
      sec.dataset.category = cat;

      const divider = document.createElement('div');
      divider.className = 'track-divider' + (cat === 'inactive' ? ' inactive' : '');
      const lbl = document.createElement('span');
      lbl.className = 'track-divider-label';
      lbl.textContent = TRACK_CATEGORY_LABELS[cat];
      divider.appendChild(lbl);
      sec.appendChild(divider);

      list.forEach(t => sec.appendChild(trackStripNode(t, statsMap.get(t.id) || { done: 0, total: 0 })));
      screen.appendChild(sec);
    }
  }

  page.appendChild(screen);
  renderLucide();
}

function trackStripNode(track, stats) {
  const strip = document.createElement('div');
  strip.className = 'track-strip';
  strip.dataset.id = String(track.id);
  strip.dataset.category = track.category || 'personal';
  if (track.category === 'inactive') strip.classList.add('inactive');

  // progress fill — gradient stops at done/total ratio
  const ratio = stats.total > 0 ? stats.done / stats.total : 0;
  if (track.category !== 'inactive') {
    strip.style.setProperty('--progress', (ratio * 100).toFixed(1) + '%');
  }

  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'track-grip';
  grip.dataset.noSwipe = '1';
  grip.setAttribute('aria-label', 'Перетащить');
  grip.appendChild(iconNode('grip-vertical'));

  const icon = iconNode(track.icon || DEFAULT_ICON);
  icon.classList.add('track-icon');

  const name = document.createElement('span');
  name.className = 'track-name';
  name.textContent = track.name;

  const meta = document.createElement('span');
  meta.className = 'track-meta';
  meta.textContent = `задач: ${stats.done}/${stats.total}`;

  strip.append(grip, icon, name, meta);

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

function openSheet({ task }) {
  if (sheetOpen) return;
  sheetOpen = true;
  const isEdit = !!task;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  backdrop.appendChild(sheet);

  // draft state — all edits accumulate here, committed on close
  const draft = {
    text: task?.text || '',
    icon: task?.icon || DEFAULT_ICON,
    notes: task?.notes || '',
    deadline: isEdit ? (task?.deadline || null) : todayISO(),
    track_id: task?.track_id ?? null,
  };

  // When user is mid-creation of a new track (inline input open) and taps
  // backdrop/Готово, input.blur starts an async addTrack while closeSheet
  // starts the task commit. Task commit must wait for the track's id to
  // land in draft.track_id, otherwise the task saves with the stale null.
  let pendingTrackInput = null;

  // handle
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.appendChild(handle);

  // header: title + Готово
  const header = document.createElement('div');
  header.className = 'sheet-header';
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = isEdit ? 'Редактирование' : 'Новая задача';
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'sheet-done';
  doneBtn.textContent = 'Готово';
  header.append(title, doneBtn);
  sheet.appendChild(header);

  // input row: icon box + input container with textarea
  const inputRow = document.createElement('div');
  inputRow.className = 'sheet-input-row';

  const iconBox = document.createElement('button');
  iconBox.type = 'button';
  iconBox.className = 'sheet-iconbox';
  const renderIconBox = () => {
    iconBox.replaceChildren(iconNode(draft.icon || DEFAULT_ICON));
    renderLucide();
  };
  renderIconBox();

  const inputWrap = document.createElement('div');
  inputWrap.className = 'sheet-input-wrap';
  const textInput = document.createElement('textarea');
  textInput.className = 'sheet-text';
  textInput.placeholder = 'Задача';
  textInput.rows = 1;
  textInput.value = draft.text;
  textInput.autocapitalize = 'sentences';
  // iOS Safari otherwise shows a URL-autofill pill (site domain) in the
  // keyboard accessory bar — kill all autofill/autocorrect hints on this field.
  textInput.autocomplete = 'off';
  textInput.setAttribute('autocorrect', 'off');
  textInput.spellcheck = false;
  textInput.addEventListener('input', () => { draft.text = textInput.value; });
  // auto-grow up to max-height (CSS clamps, JS sets precise height)
  const autoResize = () => {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 94) + 'px';
  };
  textInput.addEventListener('input', autoResize);
  inputWrap.appendChild(textInput);

  inputRow.append(iconBox, inputWrap);
  sheet.appendChild(inputRow);

  // icons section — suggestions row + "Все иконки" link
  const iconSection = document.createElement('div');
  iconSection.className = 'sheet-section';
  const iconLabel = document.createElement('div');
  iconLabel.className = 'sheet-label';
  iconLabel.textContent = 'ЧАСТО';
  const iconRow = document.createElement('div');
  iconRow.className = 'sheet-icon-row';

  const renderSuggestions = () => {
    iconRow.replaceChildren();
    const slots = buildIconRow(draft.text, draft.icon);
    slots.forEach(slot => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet-icon';
      if (slot.kind === 'prediction') b.classList.add('prediction');
      b.appendChild(iconNode(slot.icon));
      b.addEventListener('click', () => {
        draft.icon = slot.icon;
        pushRecentIcon(slot.icon);
        renderIconBox();
        renderSuggestions();
      });
      iconRow.appendChild(b);
    });
    renderLucide();
  };

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'sheet-icons-all';
  allBtn.textContent = 'Все иконки';
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
  allBtn.addEventListener('click', openPicker);
  iconBox.addEventListener('click', openPicker);

  iconSection.append(iconLabel, iconRow, allBtn);
  sheet.appendChild(iconSection);
  renderSuggestions();

  // track section: horizontal chip row [— / track / track / +]. Tap chip =
  // select (or deselect if tapping the current). "+" swaps itself for an
  // inline input — no secondary picker sheet.
  const trackSection = document.createElement('div');
  trackSection.className = 'sheet-section';
  const trackLabel = document.createElement('div');
  trackLabel.className = 'sheet-label';
  trackLabel.textContent = 'ТРЕК';
  const trackRow = document.createElement('div');
  trackRow.className = 'sheet-track-row';
  trackSection.append(trackLabel, trackRow);
  sheet.appendChild(trackSection);

  const renderTrackChips = async () => {
    let tracks = [];
    try {
      tracks = await listTracks();
    } catch (e) {
      if (isIdbDisconnectError(e)) { await recoverDb(); return; }
      showError(e);
    }
    trackRow.replaceChildren();

    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'track-chip track-chip-none';
    if (!draft.track_id) none.classList.add('selected');
    none.textContent = '—';
    none.addEventListener('click', () => {
      draft.track_id = null;
      renderTrackChips();
    });
    trackRow.appendChild(none);

    tracks.forEach(t => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'track-chip';
      if (t.id === draft.track_id) b.classList.add('selected');
      b.appendChild(iconNode(t.icon));
      const label = document.createElement('span');
      label.textContent = t.name;
      b.appendChild(label);
      b.addEventListener('click', () => {
        draft.track_id = (draft.track_id === t.id) ? null : t.id;
        renderTrackChips();
      });
      trackRow.appendChild(b);
    });

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'track-chip track-chip-plus';
    plus.appendChild(iconNode('plus'));
    plus.addEventListener('click', () => swapPlusForInput(plus));
    trackRow.appendChild(plus);

    renderLucide();
  };

  const swapPlusForInput = (plusChip) => {
    const wrap = document.createElement('div');
    wrap.className = 'track-chip track-chip-input';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Новый трек';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    wrap.appendChild(input);
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
  const notesLabel = document.createElement('div');
  notesLabel.className = 'sheet-label';
  notesLabel.textContent = 'ЗАМЕТКИ';
  const notesWrap = document.createElement('div');
  notesWrap.className = 'sheet-notes-wrap';
  const notesInput = document.createElement('textarea');
  notesInput.className = 'sheet-notes';
  notesInput.placeholder = 'Заметки (опционально)';
  notesInput.rows = 2;
  notesInput.value = draft.notes;
  notesInput.autocomplete = 'off';
  notesInput.setAttribute('autocorrect', 'off');
  notesInput.spellcheck = false;
  const autoResizeNotes = () => {
    notesInput.style.height = 'auto';
    notesInput.style.height = notesInput.scrollHeight + 'px';
  };
  notesInput.addEventListener('input', () => {
    draft.notes = notesInput.value;
    autoResizeNotes();
  });
  notesWrap.appendChild(notesInput);
  sheet.append(notesLabel, notesWrap);

  // deadline row: "Дедлайн" label on the left, small date-input pill on the right
  const dlRow = document.createElement('div');
  dlRow.className = 'sheet-dl-row';
  const dlLabel = document.createElement('div');
  dlLabel.className = 'label';
  dlLabel.textContent = 'Дедлайн';
  const dlInput = document.createElement('input');
  dlInput.type = 'date';
  dlInput.className = 'sheet-deadline';
  dlInput.autocomplete = 'off';
  if (draft.deadline) dlInput.value = draft.deadline;
  dlInput.addEventListener('change', () => {
    draft.deadline = dlInput.value || null;
  });
  dlRow.append(dlLabel, dlInput);
  sheet.appendChild(dlRow);

  // finish + delete (edit mode only) — divider between them for clear separation
  if (isEdit) {
    const finish = document.createElement('button');
    finish.type = 'button';
    finish.className = 'sheet-finish';
    finish.appendChild(iconNode('check'));
    const finishLbl = document.createElement('span');
    finishLbl.textContent = 'Завершить';
    finish.appendChild(finishLbl);
    finish.addEventListener('click', async () => {
      sheetOpen = false;
      try {
        await markDone(task.id);
        showUndoSnackbar(task.id);
      } catch (e) {
        if (isIdbDisconnectError(e)) await recoverDb();
        else showError(e);
      }
      closeSheet(backdrop, { skipCommit: true });
    });
    sheet.appendChild(finish);

    const dvd = document.createElement('hr');
    dvd.className = 'sheet-divider';
    sheet.appendChild(dvd);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sheet-delete';
    del.textContent = 'Удалить задачу';
    del.addEventListener('click', async () => {
      sheetOpen = false;
      try { await db.tasks.delete(task.id); } catch (e) {
        if (isIdbDisconnectError(e)) await recoverDb();
        else showError(e);
      }
      closeSheet(backdrop, { skipCommit: true });
    });
    sheet.appendChild(del);
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
          await db.tasks.update(task.id, {
            text,
            icon: draft.icon || DEFAULT_ICON,
            notes,
            deadline: draft.deadline || null,
            track_id: draft.track_id || null,
          });
        }
      } else if (text) {
        await db.tasks.add({
          icon: draft.icon || DEFAULT_ICON,
          text,
          notes,
          deadline: draft.deadline || null,
          track_id: draft.track_id || null,
          created_at: Date.now(),
          done_at: 0,
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

  // animate in + size textareas for any pre-filled content
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    autoResize();
    autoResizeNotes();
  });
}

// ---------- full icon picker (stacked above edit sheet) ----------

function openIconPicker({ current, onSelect }) {
  const all = (typeof CURATED_FULL !== 'undefined' ? CURATED_FULL : ['circle-dashed']);

  const backdrop = document.createElement('div');
  backdrop.className = 'picker-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'picker-sheet';
  backdrop.appendChild(sheet);

  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.appendChild(handle);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'picker-search';
  search.placeholder = 'Поиск (по англ. имени Lucide)';
  search.autocomplete = 'off';
  sheet.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  sheet.appendChild(grid);

  const renderGrid = (filter) => {
    grid.replaceChildren();
    const q = (filter || '').trim().toLowerCase();
    const list = q ? all.filter(n => n.includes(q)) : all;
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = 'Нет совпадений. Можно задать иконку, введя точное Lucide-имя в поиск и нажав Enter.';
      grid.appendChild(empty);
    } else {
      list.forEach(name => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sheet-icon';
        if (name === current) b.classList.add('selected');
        b.appendChild(iconNode(name));
        b.addEventListener('click', () => {
          onSelect?.(name);
          close();
        });
        grid.appendChild(b);
      });
    }
    renderLucide();
  };

  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
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
  const backdrop = document.createElement('div');
  backdrop.className = 'picker-backdrop history-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'picker-sheet history-sheet';
  backdrop.appendChild(sheet);

  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.appendChild(handle);

  const header = document.createElement('div');
  header.className = 'history-header';
  const title = document.createElement('div');
  title.className = 'history-title';
  title.textContent = 'Весь журнал';
  const clearAll = document.createElement('span');
  clearAll.className = 'history-clear-all';
  clearAll.textContent = 'Очистить всё';
  header.append(title, clearAll);
  sheet.appendChild(header);

  const content = document.createElement('div');
  content.className = 'history-content';
  sheet.appendChild(content);

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
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'Пока пусто — ещё ничего не выполнено.';
      content.appendChild(empty);
      return;
    }
    const groups = groupByDay(tasks);
    for (const g of groups) {
      const gWrap = document.createElement('div');
      gWrap.className = 'history-group';
      const lbl = document.createElement('div');
      lbl.className = 'history-day';
      lbl.textContent = g.label;
      gWrap.appendChild(lbl);
      const grid = document.createElement('div');
      grid.className = 'grid journal-grid';
      g.tasks.forEach(t => {
        const card = cardBase(t, tracksById);
        card.classList.add('done');
        const badge = document.createElement('div');
        badge.className = 'check-badge';
        const rot = ((t.id * 13) % 15) - 7;
        badge.style.setProperty('--rot', rot + 'deg');
        badge.appendChild(checkBadgeSvg());
        card.appendChild(badge);
        attachLongPress(card, {
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
        });
        grid.appendChild(card);
      });
      gWrap.appendChild(grid);
      content.appendChild(gWrap);
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
  // Build target category list, excluding the dragged track
  const inCat = tracks.filter(t => (t.category || 'personal') === targetCat && t.id !== trackId);
  // Insert at targetIndex
  const reorder = inCat.slice(0, targetIndex).concat([{ id: trackId }]).concat(inCat.slice(targetIndex));
  await db.transaction('rw', db.tracks, async () => {
    await db.tracks.update(trackId, { category: targetCat });
    for (let i = 0; i < reorder.length; i++) {
      await db.tracks.update(reorder[i].id, { position: i + 1 });
    }
  });
}

// ---------- track sheet (create / edit) ----------

let trackSheetOpen = false;

function openTrackSheet({ track }) {
  if (trackSheetOpen) return;
  trackSheetOpen = true;
  const isEdit = !!track;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  backdrop.appendChild(sheet);

  const draft = {
    name: track?.name || '',
    icon: track?.icon || DEFAULT_ICON,
    // Editing an inactive track still exposes a work/personal toggle — tapping
    // it reactivates into that category.
    category: (track?.category === 'inactive' ? 'personal' : (track?.category || 'personal')),
  };

  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.appendChild(handle);

  const header = document.createElement('div');
  header.className = 'sheet-header';
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = isEdit ? 'Редактирование' : 'Новый трек';
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'sheet-done';
  doneBtn.textContent = isEdit ? 'Готово' : 'Создать';
  header.append(title, doneBtn);
  sheet.appendChild(header);

  // input row: iconbox + name input
  const inputRow = document.createElement('div');
  inputRow.className = 'sheet-input-row';

  const iconBox = document.createElement('button');
  iconBox.type = 'button';
  iconBox.className = 'sheet-iconbox';
  const renderIconBox = () => {
    iconBox.replaceChildren(iconNode(draft.icon || DEFAULT_ICON));
    renderLucide();
  };
  renderIconBox();

  const inputWrap = document.createElement('div');
  inputWrap.className = 'sheet-input-wrap';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'sheet-text';
  nameInput.placeholder = 'Название трека';
  nameInput.value = draft.name;
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('autocorrect', 'off');
  nameInput.spellcheck = false;
  nameInput.autocapitalize = 'sentences';
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
  inputWrap.appendChild(nameInput);

  inputRow.append(iconBox, inputWrap);
  sheet.appendChild(inputRow);

  // category toggle (Работа / Личное)
  const catSection = document.createElement('div');
  catSection.className = 'sheet-section';
  const catLabel = document.createElement('div');
  catLabel.className = 'sheet-label';
  catLabel.textContent = 'КАТЕГОРИЯ';
  const toggle = document.createElement('div');
  toggle.className = 'category-toggle';
  const renderToggle = () => {
    toggle.replaceChildren();
    for (const cat of ['work', 'personal']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'category-toggle-btn' + (draft.category === cat ? ' selected' : '');
      b.textContent = TRACK_CATEGORY_LABELS[cat];
      b.addEventListener('click', () => { draft.category = cat; renderToggle(); });
      toggle.appendChild(b);
    }
  };
  renderToggle();
  catSection.append(catLabel, toggle);
  sheet.appendChild(catSection);

  // icon suggestions + Все иконки
  const iconSection = document.createElement('div');
  iconSection.className = 'sheet-section';
  const iconLabel = document.createElement('div');
  iconLabel.className = 'sheet-label';
  iconLabel.textContent = 'ЧАСТО';
  const iconRow = document.createElement('div');
  iconRow.className = 'sheet-icon-row';
  const renderSuggestions = () => {
    iconRow.replaceChildren();
    const slots = buildIconRow(draft.name, draft.icon);
    slots.forEach(slot => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet-icon';
      if (slot.kind === 'prediction') b.classList.add('prediction');
      b.appendChild(iconNode(slot.icon));
      b.addEventListener('click', () => {
        draft.icon = slot.icon;
        pushRecentIcon(slot.icon);
        renderIconBox();
        renderSuggestions();
      });
      iconRow.appendChild(b);
    });
    renderLucide();
  };
  renderSuggestions();

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'sheet-icons-all';
  allBtn.textContent = 'Все иконки';
  const openPicker = () => openIconPicker({
    current: draft.icon,
    onSelect: (name) => { draft.icon = name; pushRecentIcon(name); renderSuggestions(); renderIconBox(); },
  });
  allBtn.addEventListener('click', openPicker);
  iconBox.addEventListener('click', openPicker);

  iconSection.append(iconLabel, iconRow, allBtn);
  sheet.appendChild(iconSection);

  // Re-render suggestions when name changes (debounced)
  let suggTimer = null;
  nameInput.addEventListener('input', () => {
    if (suggTimer) clearTimeout(suggTimer);
    suggTimer = setTimeout(renderSuggestions, 250);
  });

  // Tasks list (edit mode) — active + done-today, tap = open task sheet
  if (isEdit) {
    const tasksLabel = document.createElement('div');
    tasksLabel.className = 'sheet-label';
    tasksLabel.textContent = 'ЗАДАЧИ';
    sheet.appendChild(tasksLabel);

    const tasksBlock = document.createElement('div');
    tasksBlock.className = 'track-tasks-list';
    sheet.appendChild(tasksBlock);

    (async () => {
      const all = await listTasksByTrack(track.id);
      const todayStart = startOfTodayMs();
      const filtered = all.filter(t => !t.done_at || t.done_at >= todayStart);
      filtered.sort((a, b) => (a.done_at ? a.done_at : Infinity) - (b.done_at ? b.done_at : Infinity));
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'track-tasks-empty';
        empty.textContent = 'Пока нет задач в этом треке.';
        tasksBlock.appendChild(empty);
      } else {
        filtered.forEach(t => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'track-task-row' + (t.done_at ? ' done' : '');
          const ib = document.createElement('span');
          ib.className = 'track-task-icon';
          ib.appendChild(iconNode(t.icon || DEFAULT_ICON));
          const tx = document.createElement('span');
          tx.className = 'track-task-text';
          tx.textContent = t.text;
          row.append(ib, tx);
          row.addEventListener('click', () => {
            closeTrackSheet(backdrop, { skipCommit: true });
            setTimeout(() => openSheet({ task: t }), 220);
          });
          tasksBlock.appendChild(row);
        });
      }
      renderLucide();
    })().catch(showError);

    const dvd = document.createElement('hr');
    dvd.className = 'sheet-divider';
    sheet.appendChild(dvd);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sheet-delete';
    const delIcon = iconNode('trash-2');
    const delTxt = document.createElement('span');
    delTxt.textContent = 'Удалить трек';
    del.append(delIcon, delTxt);
    del.addEventListener('click', async () => {
      try { await deleteTrack(track.id); }
      catch (e) {
        if (isIdbDisconnectError(e)) await recoverDb();
        else showError(e);
      }
      closeTrackSheet(backdrop, { skipCommit: true });
    });
    sheet.appendChild(del);
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
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
