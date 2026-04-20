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
  arr.sort((a, b) => b.created_at - a.created_at);
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

async function addTask(text) {
  return db.tasks.add({
    icon: 'circle-dashed',
    text,
    deadline: null,
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

// ---------- render ----------

function greeting() {
  const h = new Date().getHours();
  if (h >= 6 && h < 11) return 'Доброе утро!';
  if (h >= 11 && h < 18) return 'Добрый день!';
  if (h >= 18 && h < 23) return 'Добрый вечер!';
  return 'Доброй ночи!';
}

const DEFAULT_ICON = 'circle-dashed';
const CURATED_ICONS = [
  'circle-dashed',
  'shopping-bag', 'home', 'briefcase', 'phone',
  'mail', 'calendar', 'book-open', 'pencil', 'target',
  'dumbbell', 'pill', 'heart', 'coffee', 'apple',
  'utensils', 'car', 'wallet', 'music', 'star',
];

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
  let startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    firedLong = false;
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
    if (!timer) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (dx*dx + dy*dy > 100) cancel();
  });
  el.addEventListener('pointerup', (e) => {
    const wasLong = firedLong;
    cancel();
    if (!wasLong) onTap?.(e);
  });
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function cardBase(task) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = String(task.id);
  el.appendChild(iconNode(task.icon));
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = task.text;
  el.appendChild(text);
  return el;
}

function activeCardNode(task) {
  const el = cardBase(task);
  attachLongPress(el, {
    onTap: async () => {
      if (el.classList.contains('removing')) return;
      el.classList.add('removing');
      try {
        await markDone(task.id);
        setTimeout(() => { renderMain().catch(showError); }, 200);
      } catch (e) {
        el.classList.remove('removing');
        if (isIdbDisconnectError(e)) { await recoverDb(); return; }
        showError(e);
      }
    },
    onLongPress: () => openSheet({ task }),
  });
  return el;
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

function journalCardNode(task) {
  const el = cardBase(task);
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

async function renderMain() {
  const root = document.getElementById('app');
  root.replaceChildren();

  const screen = document.createElement('div');
  screen.className = 'screen';

  const header = document.createElement('div');
  header.className = 'header';
  const h1 = document.createElement('h1');
  h1.textContent = greeting();
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = 'вот твои задачи на сегодня.';
  header.append(h1, sub);
  screen.appendChild(header);

  const [active, journal] = await Promise.all([listActive(), listJournal()]);

  if (active.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Пока пусто. Добавь первую задачу снизу.';
    screen.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'grid';
    active.forEach(t => grid.appendChild(activeCardNode(t)));
    screen.appendChild(grid);
  }

  if (journal.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'divider';
    const label = document.createElement('span');
    label.className = 'divider-label';
    label.textContent = 'ЖУРНАЛ';
    divider.appendChild(label);
    screen.appendChild(divider);

    const jgrid = document.createElement('div');
    jgrid.className = 'grid journal-grid';
    journal.forEach(t => jgrid.appendChild(journalCardNode(t)));
    screen.appendChild(jgrid);
  }

  root.appendChild(screen);
  root.appendChild(inputBarNode());
  renderLucide();
}

function inputBarNode() {
  const wrapOuter = document.createElement('div');
  wrapOuter.className = 'input-bar';
  const wrap = document.createElement('button');
  wrap.className = 'wrap';
  wrap.type = 'button';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Новая задача';
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+';
  wrap.append(hint, plus);
  wrap.addEventListener('click', () => openSheet({ task: null }));
  wrapOuter.appendChild(wrap);
  return wrapOuter;
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
    deadline: task?.deadline || null,
  };

  // handle
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.appendChild(handle);

  // text
  const textInput = document.createElement('textarea');
  textInput.className = 'sheet-text';
  textInput.placeholder = 'Задача';
  textInput.rows = 2;
  textInput.value = draft.text;
  textInput.autocapitalize = 'sentences';
  textInput.addEventListener('input', () => { draft.text = textInput.value; });
  sheet.appendChild(textInput);

  // icons section
  const iconSection = document.createElement('div');
  iconSection.className = 'sheet-section';
  const iconLabel = document.createElement('div');
  iconLabel.className = 'sheet-label';
  iconLabel.textContent = 'ИКОНКА';
  const iconGrid = document.createElement('div');
  iconGrid.className = 'sheet-icons';

  const iconButtons = [];
  CURATED_ICONS.forEach(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-icon';
    b.setAttribute('data-icon-name', name);
    if (name === draft.icon) b.classList.add('selected');
    b.appendChild(iconNode(name));
    b.addEventListener('click', () => {
      draft.icon = name;
      iconButtons.forEach(btn => btn.classList.toggle('selected', btn.getAttribute('data-icon-name') === name));
    });
    iconButtons.push(b);
    iconGrid.appendChild(b);
  });
  iconSection.append(iconLabel, iconGrid);
  sheet.appendChild(iconSection);

  // deadline
  const dlSection = document.createElement('div');
  dlSection.className = 'sheet-section';
  const dlLabel = document.createElement('div');
  dlLabel.className = 'sheet-label';
  dlLabel.textContent = 'ДЕДЛАЙН';
  const dlInput = document.createElement('input');
  dlInput.type = 'date';
  dlInput.className = 'sheet-deadline';
  if (draft.deadline) dlInput.value = draft.deadline;
  dlInput.addEventListener('change', () => {
    draft.deadline = dlInput.value || null;
  });
  dlSection.append(dlLabel, dlInput);
  sheet.appendChild(dlSection);

  // delete (edit mode only)
  if (isEdit) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sheet-delete';
    del.textContent = 'Удалить';
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
    const text = draft.text.trim();
    try {
      if (isEdit) {
        // empty text on existing task = no-op (keep original). Only the Delete
        // button deletes, to keep close-as-autosave non-destructive.
        if (text) {
          await db.tasks.update(task.id, {
            text,
            icon: draft.icon || DEFAULT_ICON,
            deadline: draft.deadline || null,
          });
        }
      } else if (text) {
        await db.tasks.add({
          icon: draft.icon || DEFAULT_ICON,
          text,
          deadline: draft.deadline || null,
          created_at: Date.now(),
          done_at: 0,
        });
      }
    } catch (e) {
      if (isIdbDisconnectError(e)) await recoverDb();
      else showError(e);
    }
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeSheet(backdrop, { commit });
    }
  });

  document.body.appendChild(backdrop);
  renderLucide();

  // animate in
  requestAnimationFrame(() => backdrop.classList.add('open'));

  // focus text field for new tasks
  if (!isEdit) {
    setTimeout(() => textInput.focus(), 50);
  }
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

// ---------- boot ----------

async function boot(retry = 0) {
  try {
    await ensureDbOpen();
    await renderMain();
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
