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

// Match task text against config/icons.js ICON_KEYWORDS. Returns up to `limit`
// unique icon names. Matching: per-word (min length 2), exact first, then
// prefix either way (word starts with keyword, or keyword starts with word)
// so simple stems work without listing every inflection.
function matchIcons(text, limit = 5) {
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

// Suggestions row: keyword matches first (so typing feels responsive), then
// the user's current pick (if they actually picked one — not the default),
// then defaults from the curated list. Always exactly 5 slots.
function suggestionIcons(text, selected) {
  const defaults = (typeof CURATED_FULL !== 'undefined' ? CURATED_FULL : ['circle-dashed']);
  const matched = matchIcons(text, 5);
  const out = [];
  const seen = new Set();
  const push = (n) => { if (n && !seen.has(n)) { seen.add(n); out.push(n); } };
  matched.forEach(push);
  if (selected && selected !== DEFAULT_ICON) push(selected);
  if (out.length === 0) push(DEFAULT_ICON);
  for (const n of defaults) {
    if (out.length >= 5) break;
    push(n);
  }
  return out.slice(0, 5);
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

function formatDeadline(isoDate) {
  if (!isoDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d)) return null;
  const diffDays = Math.round((d - today) / 86400000);
  if (diffDays === 0) return { text: 'сегодня', kind: 'today' };
  if (diffDays === -1) return { text: 'вчера', kind: 'overdue' };
  const short = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  return { text: short, kind: diffDays < 0 ? 'overdue' : 'future' };
}

function cardBase(task) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = String(task.id);
  el.appendChild(iconNode(task.icon));

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
        showUndoSnackbar(task.id);
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

  // top-region keeps header + active grid inside one flex column that is at
  // least viewport-height minus input-bar reserve; margin-top: auto on the
  // active grid pins it to the bottom of the region (above the input bar).
  // Journal lives outside top-region so it scrolls in from below.
  const topRegion = document.createElement('div');
  topRegion.className = 'top-region';

  const header = document.createElement('div');
  header.className = 'header';
  const h1 = document.createElement('h1');
  h1.textContent = greeting();
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = 'вот твои задачи на сегодня.';
  header.append(h1, sub);
  topRegion.appendChild(header);

  const [active, journal] = await Promise.all([listActive(), listJournal()]);

  if (active.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Пока пусто. Добавь первую задачу снизу.';
    topRegion.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'grid active-grid';
    active.forEach(t => grid.appendChild(activeCardNode(t)));
    topRegion.appendChild(grid);
  }

  screen.appendChild(topRegion);

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
  root.appendChild(inputBarNode({ highlighted: active.length === 0 }));
  renderLucide();
}

function inputBarNode({ highlighted = false } = {}) {
  const wrapOuter = document.createElement('div');
  wrapOuter.className = 'input-bar';
  const wrap = document.createElement('button');
  wrap.className = 'wrap' + (highlighted ? ' highlighted' : '');
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
  iconLabel.textContent = 'ПРЕДЛОЖЕНИЯ';
  const iconRow = document.createElement('div');
  iconRow.className = 'sheet-icon-row';

  const renderSuggestions = () => {
    iconRow.replaceChildren();
    const names = suggestionIcons(draft.text, draft.icon);
    names.forEach(name => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet-icon';
      if (name === draft.icon) b.classList.add('selected');
      b.appendChild(iconNode(name));
      b.addEventListener('click', () => {
        draft.icon = name;
        renderSuggestions();
        renderIconBox();
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

  // Debounced re-render of suggestions on text input.
  let suggTimer = null;
  textInput.addEventListener('input', () => {
    if (suggTimer) clearTimeout(suggTimer);
    suggTimer = setTimeout(renderSuggestions, 120);
  });

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

  // delete (edit mode only) — divider above for clear separation
  if (isEdit) {
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

  // animate in + size the textarea for any pre-filled content
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    autoResize();
  });

  // focus text field for new tasks
  if (!isEdit) {
    setTimeout(() => textInput.focus(), 50);
  }
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
