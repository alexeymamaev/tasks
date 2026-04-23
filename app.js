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
  });
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
  let startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
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
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (dx*dx + dy*dy > 100) {
      moved = true;
      cancel();
    }
  });
  el.addEventListener('pointerup', (e) => {
    const wasLong = firedLong;
    cancel();
    if (!wasLong && !moved) onTap?.(e);
  });
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
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

function activeCardNode(task, tracksById) {
  const el = cardBase(task, tracksById);
  attachLongPress(el, {
    onTap: () => openSheet({ task }),
    onLongPress: async () => {
      if (el.classList.contains('removing')) return;
      el.classList.add('removing');
      try {
        await markDone(task.id);
        showUndoSnackbar(task.id);
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

// ---------- undo snackbar ----------

let snackbarTimer = null;

function showUndoSnackbar(taskId) {
  if (snackbarTimer) { clearTimeout(snackbarTimer); snackbarTimer = null; }
  document.querySelectorAll('.snackbar').forEach(el => el.remove());

  const sb = document.createElement('div');
  sb.className = 'snackbar';

  const label = document.createElement('span');
  label.className = 'snackbar-label';
  label.textContent = 'Задача выполнена';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'snackbar-action';
  btn.textContent = 'Отменить';
  btn.addEventListener('click', async () => {
    if (snackbarTimer) { clearTimeout(snackbarTimer); snackbarTimer = null; }
    sb.classList.remove('open');
    try {
      await undoDone(taskId);
      await renderMain();
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

// ---------- pager (Morning ↔ Tracks) ----------

let currentPage = 0; // 0 = morning, 1 = tracks
let pagerEl = null;
let inputBarEl = null;

async function renderApp() {
  const root = document.getElementById('app');
  root.replaceChildren();
  root.classList.add('app-root');

  pagerEl = document.createElement('div');
  pagerEl.className = 'pager';

  const pMorning = document.createElement('section');
  pMorning.className = 'page page-morning';
  const pTracks = document.createElement('section');
  pTracks.className = 'page page-tracks';
  pagerEl.append(pMorning, pTracks);

  root.appendChild(pagerEl);

  inputBarEl = document.createElement('div');
  inputBarEl.className = 'input-bar';
  root.appendChild(inputBarEl);

  attachPagerSwipe(pagerEl);
  await Promise.all([renderMorning(), renderTracks()]);
  setPage(currentPage, false);
}

function setPage(idx, animate = true) {
  currentPage = Math.max(0, Math.min(1, idx));
  if (!animate) pagerEl.classList.add('no-anim');
  pagerEl.style.transform = `translateX(${-currentPage * 50}%)`;
  if (!animate) requestAnimationFrame(() => pagerEl.classList.remove('no-anim'));
  updateInputBar();
  updatePagePill();
}

function updateInputBar() {
  if (!inputBarEl) return;
  inputBarEl.replaceChildren();
  const wrap = document.createElement('button');
  wrap.className = 'wrap';
  wrap.type = 'button';
  wrap.append(iconNode('plus'));
  const label = document.createElement('span');
  if (currentPage === 0) {
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
  wrap.append(mkHalf('Задачи', 0), mkHalf('Треки', 1));
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
  const W = () => window.innerWidth;

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-no-swipe]')) return;
    active = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    // Pager width is 200% of parent (2*W). translateX(-50%) shifts it by 1*W px.
    // So at page N, px-equivalent of "-50*N %" is -W*N.
    baseTx = -currentPage * W();
  });
  el.addEventListener('pointermove', (e) => {
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
    // Clamp past bounds with resistance so you can't drag beyond end pages.
    let tx = baseTx + dx;
    const maxTx = 0;
    const minTx = -W(); // one full viewport = second page fully visible
    if (tx > maxTx) tx = maxTx + (tx - maxTx) * 0.3;
    if (tx < minTx) tx = minTx + (tx - minTx) * 0.3;
    el.style.transform = `translateX(${tx}px)`;
  });
  const end = (e) => {
    if (!active) return;
    active = false;
    if (!dragging) return;
    el.classList.remove('dragging');
    const dx = e.clientX - startX;
    const threshold = W() * 0.2;
    let next = currentPage;
    if (dx < -threshold && currentPage < 1) next = currentPage + 1;
    else if (dx > threshold && currentPage > 0) next = currentPage - 1;
    // Reset transform to % (setPage uses %)
    el.style.transform = '';
    setPage(next, true);
    dragging = false;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', (e) => { if (active && dragging) end(e); });
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
// It now refreshes both pages so track stats stay in sync with task state.
async function renderMain() {
  await Promise.all([renderMorning(), renderTracks()]);
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
