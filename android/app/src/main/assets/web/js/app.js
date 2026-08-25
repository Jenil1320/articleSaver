/* Folio — the shell: routing, the library, saving, settings, and the reader's controls. */

import * as db from './db.js';
import * as library from './library.js';
import * as native from './native.js';
import * as ingest from './ingest.js';
import { Reader, esc } from './reader.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'library',
  cameFrom: 'library',
  shelf: 'readable',
  status: '',
  theme: '',
  sort: 'recent',
  q: '',
  markFilter: '',
  current: null,
  pendingSelection: null,
  habit: null,
  lastSave: null,
};

const KIND_LABEL = { article: 'Article', paper: 'Paper', post: 'Post', product: 'Tool' };

const SORTS = [
  ['recent', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['progress', 'Furthest through'],
  ['shortest', 'Shortest first'],
  ['longest', 'Longest first'],
  ['title', 'By title'],
];

/* ── small helpers ──────────────────────────────────────────────────── */

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-bad', !!bad);
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), bad ? 4600 : 2400);
}

/**
 * A toast reports; this celebrates. Kept for the two moments that are genuinely
 * earned — a focus session seen through, and the day's five minutes cleared — so
 * that it never becomes wallpaper.
 */
let cheerTimer;
function celebrate(title, sub = '') {
  $('#cheer-title').textContent = title;
  $('#cheer-sub').textContent = sub;
  $('#cheer').hidden = false;
  native.vibrate(18);
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => { $('#cheer').hidden = true; }, 1900);
}

function relativeDay(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} wk ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

/* ── appearance ─────────────────────────────────────────────────────── */

const themePref = () => localStorage.getItem('folio-theme') || 'system';

function applyTheme(pref) {
  localStorage.setItem('folio-theme', pref);
  const dark = pref === 'system'
    ? matchMedia('(prefers-color-scheme: dark)').matches : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  native.setChrome(dark);
  $$('#theme-mode-chips .chip').forEach((c) => c.classList.toggle('is-on', c.dataset.mode === pref));
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themePref() === 'system') applyTheme('system');
});

const TEXT_SIZE_LABELS = [[92, 'Compact'], [104, 'Comfortable'], [116, 'Large'], [999, 'Largest']];

function applyTextSize(percent) {
  localStorage.setItem('folio-textsize', String(percent));
  document.documentElement.style.setProperty('--reader-scale', String(percent / 100));
  const label = TEXT_SIZE_LABELS.find(([limit]) => percent <= limit)[1];
  const el = $('#textsize-label');
  if (el) el.textContent = label;
}

/* ── Folio's own dialogs ────────────────────────────────────────────── */

/**
 * The browser's confirm() and prompt() are system boxes: they look nothing like the
 * app, cannot be styled, and on Android they interrupt with a jarring grey slab.
 */
function ask({ title, body = '', input = null, options = null, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('#ask-title').textContent = title;
    $('#ask-body').textContent = body;
    $('#ask-body').hidden = !body;

    const field = $('#ask-input');
    field.hidden = input == null;
    field.value = input || '';

    const optionBox = $('#ask-options');
    optionBox.hidden = !options || !options.length;
    optionBox.innerHTML = (options || [])
      .map((o) => `<button class="chip" data-value="${esc(o)}">${esc(o)}</button>`).join('');
    optionBox.onclick = (e) => {
      const chip = e.target.closest('.chip');
      if (chip) field.value = chip.dataset.value;
    };

    const okBtn = $('#ask-ok');
    okBtn.textContent = ok;
    okBtn.classList.toggle('btn--danger', danger);

    // The sheet the dialog replaces. Cancel is a change of mind about the question,
    // not about that sheet, so Cancel puts it back; a scrim tap dismisses the lot.
    const behind = $$('.sheet').find((s) => !s.hidden && s.id !== 'sheet-ask');

    const done = (value, restore = false) => {
      // Cleared first: closeSheets() consults it, and a dialog that answered itself
      // would recurse.
      dialogResolve = null;
      closeSheets();
      okBtn.onclick = null;
      $('#ask-cancel').onclick = null;
      if (restore && behind) openSheet(behind.id);
      resolve(value);
    };
    okBtn.onclick = () => done(input == null ? true : field.value.trim());
    $('#ask-cancel').onclick = () => done(null, true);
    dialogResolve = () => done(null);

    // A dialog replaces whatever sheet asked for it rather than stacking on top.
    $$('.sheet').forEach((s) => { s.hidden = true; });
    openSheet('sheet-ask');
    if (input != null) setTimeout(() => field.focus(), 180);
  });
}

let dialogResolve = null;

/* ── sheets ─────────────────────────────────────────────────────────── */

function openSheet(id) {
  $('#scrim').hidden = false;
  $(`#${id}`).hidden = false;
}

function closeSheets() {
  const wasAsk = !$('#sheet-ask').hidden;
  $('#scrim').hidden = true;
  $$('.sheet').forEach((s) => { s.hidden = true; });
  state.pendingSelection = null;
  if (wasAsk && dialogResolve) {
    const fn = dialogResolve;
    dialogResolve = null;
    fn();
  }
}

const anySheetOpen = () => $$('.sheet').some((s) => !s.hidden);

/* ── reading time and streak ────────────────────────────────────────── */

let unloggedSeconds = 0;

function flushReading() {
  const seconds = unloggedSeconds;
  unloggedSeconds = 0;
  if (seconds > 0) library.logReading(seconds).then((h) => { state.habit = h; paintStreak(); });
}

setInterval(() => {
  if (state.view === 'reader' && !document.hidden) {
    unloggedSeconds += 15;
    if (unloggedSeconds >= 60) flushReading();
  }
}, 15000);

async function refreshStreak() {
  state.habit = await library.readingStats();
  paintStreak();
}

const GOAL_SECONDS = library.STREAK_THRESHOLD_SECONDS;
// The ring's circumference: 15.5 is the radius it is drawn at in the stylesheet.
const RING_LENGTH = 2 * Math.PI * 15.5;
// null until the first paint, so opening the app on a finished day is not a triumph.
let goalWasMet = null;

/** The header ring: how much of today's five minutes is done, and the streak it keeps. */
function paintStreak() {
  const habit = state.habit;
  if (!habit) return;
  const done = Math.min(1, (habit.todaySeconds || 0) / GOAL_SECONDS);
  const met = done >= 1;

  $('#goal-fill').style.strokeDashoffset = String(RING_LENGTH * (1 - done));
  $('#goal-n').textContent = String(habit.streakDays || 0);
  $('#btn-streak').classList.toggle('is-lit', met);
  $('#btn-streak').setAttribute('aria-label', met
    ? `Today's reading goal is met. ${habit.streakDays} day streak.`
    : `${habit.todayMinutes} of ${Math.round(GOAL_SECONDS / 60)} minutes read today.`);

  // Not while another celebration is on screen: a focus session that ends by
  // clearing the goal is one achievement, not two.
  if (met && goalWasMet === false && $('#cheer').hidden) {
    celebrate(`Day ${habit.streakDays}`, "Today's five minutes are in. Streak safe.");
  }
  goalWasMet = met;
}

/** The last seven days, oldest first, for the streak sheet. */
function weekDays(habit) {
  const seconds = new Map((habit.days || []).map((d) => [d.day, d.seconds]));
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 6);
  const out = [];
  for (let k = 0; k < 7; k += 1) {
    const key = library.localDay(cursor);
    out.push({
      letter: 'SMTWTFS'[cursor.getDay()],
      done: (seconds.get(key) || 0) >= GOAL_SECONDS,
      today: k === 6,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function openStreakSheet() {
  const habit = state.habit || { todaySeconds: 0, todayMinutes: 0, streakDays: 0, days: [] };
  const left = Math.ceil(Math.max(0, GOAL_SECONDS - (habit.todaySeconds || 0)) / 60);
  const days = habit.streakDays;

  const week = weekDays(habit).map((d) =>
    `<span class="week__d${d.done ? ' is-done' : ''}${d.today ? ' is-today' : ''}">`
    + `<b></b><i>${d.letter}</i></span>`).join('');

  $('#streak-body').innerHTML = `
    <p class="streak__lead"><b>${days}</b> ${days === 1 ? 'day in a row' : 'days in a row'}</p>
    <div class="week">${week}</div>
    <p class="hint">${left
      ? `${habit.todayMinutes} min read today. ${left} more keeps the streak.`
      : `${habit.todayMinutes} min read today — the day is already yours.`}</p>`;
  openSheet('sheet-streak');
}

/* ── focus sessions ─────────────────────────────────────────────────── */

const focus = { active: false, remaining: 0, timer: null, wasHidden: false };

function focusLabel() {
  const m = Math.floor(focus.remaining / 60);
  const s = String(focus.remaining % 60).padStart(2, '0');
  $('#reader-progress-label').textContent = `${m}:${s} · stay with it`;
}

function startFocus(minutes) {
  closeSheets();
  focus.active = true;
  focus.remaining = minutes * 60;
  document.body.classList.add('focusing');
  native.keepAwake(true);
  focusLabel();
  focus.timer = setInterval(() => {
    if (document.hidden) return;           // paused while away — time does not pass
    focus.remaining -= 1;
    if (focus.remaining <= 0) finishFocus();
    else focusLabel();
  }, 1000);
  toast(`${minutes} minutes. The screen stays on.`);
}

function endFocus(silent = false) {
  if (!focus.active) return;
  clearInterval(focus.timer);
  focus.active = false;
  focus.timer = null;
  document.body.classList.remove('focusing');
  native.keepAwake(false);
  reader.paintProgress();
  if (!silent) toast('Focus session ended');
}

function finishFocus() {
  endFocus(true);
  flushReading();
  native.vibrate(40);
  celebrate('Session complete', state.habit && state.habit.streakDays >= 2
    ? `${state.habit.streakDays}-day streak` : 'Well read.');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (focus.active) focus.wasHidden = true;
    flushReading();
    return;
  }
  if (focus.active && focus.wasHidden) {
    focus.wasHidden = false;
    toast('Paused while you were away — keep going');
  }
});

window.__folioPause = () => { flushReading(); reader.flush(); };

/* ── routing ────────────────────────────────────────────────────────── */

function show(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  $$('.tab[data-view]').forEach((t) => t.classList.toggle('is-on', t.dataset.view === view));
  document.body.classList.toggle('reading', view === 'reader');
  document.body.classList.toggle('onboarding', view === 'welcome');
  if (view === 'library') refreshLibrary();
  if (view === 'queue') refreshQueue();
  if (view === 'marks') refreshMarks();
  if (view === 'settings') refreshSettings();
}

/* ── first run ──────────────────────────────────────────────────────── */

const SEEN_WELCOME = 'folio-seen-welcome';

/** Leave the welcome screen for good, optionally straight into saving something. */
function leaveWelcome(saveNow) {
  localStorage.setItem(SEEN_WELCOME, '1');
  show('library');
  if (!saveNow) return;
  openSheet('sheet-add');
  setTimeout(() => $('#add-url').focus(), 260);
}

/* ── the library ────────────────────────────────────────────────────── */

function matches(item) {
  if (state.shelf === 'product' && item.kind !== 'product') return false;
  if (state.shelf === 'readable' && item.kind === 'product') return false;
  if (state.status === '' && item.status === 'archived') return false;
  if (state.status && item.status !== state.status) return false;
  if (state.theme && item.theme !== state.theme) return false;
  if (state.q) {
    const q = state.q.toLowerCase();
    const hay = `${item.title} ${item.siteName} ${item.byline} ${item.excerpt} ${item.theme} ${item.textPlain}`;
    if (!hay.toLowerCase().includes(q)) return false;
  }
  return true;
}

function sortItems(list) {
  const by = {
    recent: (a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''),
    oldest: (a, b) => (a.savedAt || '').localeCompare(b.savedAt || ''),
    title: (a, b) => (a.title || '').localeCompare(b.title || ''),
    longest: (a, b) => (b.wordCount || 0) - (a.wordCount || 0),
    shortest: (a, b) => (a.wordCount || 0) - (b.wordCount || 0),
    progress: (a, b) => (b.progressPct || 0) - (a.progressPct || 0),
  }[state.sort];
  return [...list].sort(by);
}

function itemRow(item, extra = '') {
  const pct = item.progressPct || 0;
  // One line of context, not two rows of badges. What is left is what actually helps
  // choose between two saved things: who wrote it, how long it is or how much is
  // left, and how long ago it was saved.
  const meta = [];
  if (item.siteName) meta.push(`<b>${esc(item.siteName)}</b>`);
  if (item.kind !== 'article') meta.push(esc(KIND_LABEL[item.kind] || item.kind));
  if (item.status === 'finished') meta.push('Finished');
  else if (pct > 0) meta.push(`${item.minutesLeft} min left`);
  else if (item.readingMinutes) meta.push(`${item.readingMinutes} min`);
  meta.push(relativeDay(item.savedAt));

  const thumb = item.leadImage
    ? `<img class="item__thumb" data-msrc="${esc(item.leadImage)}" alt="">` : '';

  // A short post's excerpt is its title again; repeating it is clutter.
  const titleNorm = item.title.replace(/…$/, '').trim().toLowerCase();
  const excerptNorm = (item.excerpt || '').trim().toLowerCase();
  const duplicate = !excerptNorm
    || (excerptNorm.startsWith(titleNorm) && excerptNorm.length < titleNorm.length + 40);

  // The progress bar already says how far along this is, and the meta line says how
  // much is left, so a percentage badge said it a third time. What is left here is
  // the shelf it is on and whether it is a favourite.
  const flags = [];
  if (item.theme && item.theme !== 'Unsorted') flags.push(`<span class="tag">${esc(item.theme)}</span>`);
  if (item.favourite) flags.push('<span class="tag tag--star">★</span>');
  const flagRow = flags.length || extra
    ? `<div class="item__meta item__flags">${flags.join('')}${extra}</div>` : '';

  return `<div class="item" data-id="${item.id}" role="button" tabindex="0">
    <div class="item__top">
      <div class="item__main">
        <h3 class="item__title">${esc(item.title)}</h3>
        <div class="item__meta">${meta.filter(Boolean).join('<span class="item__sep">·</span>')}</div>
      </div>${thumb}
    </div>
    ${duplicate ? '' : `<p class="item__excerpt">${esc(item.excerpt)}</p>`}
    ${flagRow}
    ${pct > 0 && item.status !== 'finished' ? `<div class="item__bar"><i style="width:${pct}%"></i></div>` : ''}
    <button class="item__more" data-more="${item.id}" aria-label="Options for ${esc(item.title.slice(0, 40))}">
      <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-more"/></svg>
    </button>
  </div>`;
}

/* One object URL per stored picture, held for the app's lifetime. The lists are
   rebuilt constantly — every search keystroke, every progress save — and a URL
   minted per rebuild would pin its blob with nothing left holding it to revoke. */
const thumbUrls = new Map();

async function paintThumbs(root) {
  await Promise.all($$('img[data-msrc]', root).map(async (img) => {
    const key = img.getAttribute('data-msrc');
    img.removeAttribute('data-msrc');
    try {
      let url = thumbUrls.get(key);
      if (!url) {
        const blob = await db.getMedia(key);
        if (blob) {
          url = URL.createObjectURL(blob);
          thumbUrls.set(key, url);
        }
      }
      if (url) { img.src = url; return; }
    } catch { /* fall through */ }
    img.remove();
  }));
}

let cachedItems = [];

async function refreshLibrary({ animate = true } = {}) {
  const all = await library.listItems();
  cachedItems = all;
  const visible = sortItems(all.filter(matches));

  renderFilters(all);

  const shelf = all.filter((i) => i.status !== 'archived');
  const unfinished = shelf.filter((i) => ['unread', 'reading'].includes(i.status)
    && i.kind !== 'product').length;
  // The streak lives in the header ring now, so the subtitle is only the shelf.
  $('#library-sub').textContent = shelf.length
    ? `${shelf.length} saved · ${unfinished} still to read`
    : 'Your reading library';
  paintStreak();

  // The nudge is composed natively while the app is asleep, so it is fed the two
  // facts it likes to joke about whenever they are recounted.
  native.updateReminderFacts(unfinished,
    state.habit ? state.habit.streakDays : 0);

  const list = $('#item-list');
  const empty = $('#library-empty');
  if (!visible.length) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = all.length
      ? `<h3>Nothing here</h3><p>No ${state.shelf === 'product' ? 'tools' : 'articles'} match these filters.</p>`
      : '<h3>Your shelf is empty</h3><p>Tap the plus button to save a link, a PDF or a note. '
        + 'You can also share into Folio from any other app.</p>';
    return;
  }
  empty.hidden = true;
  list.innerHTML = visible.map((i) => itemRow(i)).join('');
  // Typing narrows a list already on screen; replaying the cards' entry animation
  // on every keystroke turns filtering into flicker.
  if (!animate) $$('.item', list).forEach((el) => { el.style.animation = 'none'; });
  paintThumbs(list);
}

/** One scrolling row: status, then the shelf switch, then the themes in use. */
function renderFilters(all) {
  const onShelf = all.filter((i) => i.status !== 'archived'
    && (state.shelf === 'product' ? i.kind === 'product' : i.kind !== 'product'));

  const counts = new Map();
  for (const i of onShelf) counts.set(i.theme || 'Unsorted', (counts.get(i.theme || 'Unsorted') || 0) + 1);
  const themes = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const statusChips = [['', 'All'], ['unread', 'Unread'], ['reading', 'Reading'], ['finished', 'Finished']]
    .map(([value, label]) =>
      `<button class="chip ${state.status === value ? 'is-on' : ''}" data-status="${value}">${label}</button>`)
    .join('');

  const products = all.filter((i) => i.kind === 'product').length;
  const shelfChip = products
    ? `<span class="chip__sep"></span><button class="chip ${state.shelf === 'product' ? 'is-on' : ''}" data-shelf="toggle">
         <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-tools"/></svg>Tools<span class="chip__n">${products}</span></button>`
    : '';

  const themeChips = themes.length > 1
    ? '<span class="chip__sep"></span>'
      + `<button class="chip ${state.theme ? '' : 'is-on'}" data-theme="">All themes</button>`
      + themes.map(([name, n]) =>
        `<button class="chip ${state.theme === name ? 'is-on' : ''}" data-theme="${esc(name)}">${esc(name)}<span class="chip__n">${n}</span></button>`).join('')
    : '';

  $('#filters').innerHTML = statusChips + shelfChip + themeChips;
}

/* ── up next ────────────────────────────────────────────────────────── */

async function refreshQueue() {
  const queue = await library.readingQueue();
  const badge = $('#queue-badge');
  badge.hidden = !queue.length;
  badge.textContent = queue.length > 99 ? '99+' : String(queue.length);

  const list = $('#queue-list');
  const empty = $('#queue-empty');
  if (!queue.length) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<h3>Nothing waiting</h3><p>Everything you have saved is either '
      + 'finished or still fresh.</p>';
    return;
  }
  empty.hidden = true;
  list.innerHTML = queue.map((i) =>
    itemRow(i, `<span class="tag tag--reason">${esc(i.reason || '')}</span>`)).join('');
  paintThumbs(list);
}

/* ── marks ──────────────────────────────────────────────────────────── */

async function refreshMarks() {
  const [anns, items] = await Promise.all([db.allAnnotations(), db.allItems()]);
  const byId = new Map(items.map((i) => [i.id, i]));
  let list = anns.filter((a) => byId.has(a.itemId));
  if (state.markFilter) list = list.filter((a) => a.kind === state.markFilter);
  list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const box = $('#marks-list');
  const empty = $('#marks-empty');
  if (!list.length) {
    box.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<h3>No marks yet</h3><p>Select any text while reading to highlight it, '
      + 'add a note or drop a bookmark.</p>';
    return;
  }
  empty.hidden = true;
  box.innerHTML = list.map((a) => {
    const item = byId.get(a.itemId);
    const label = a.kind === 'bookmark' ? 'Bookmark' : a.kind === 'note' ? 'Note' : 'Highlight';
    return `<button class="mark" data-item="${esc(a.itemId)}" data-block="${esc(a.blockIndex)}" data-colour="${esc(a.colour || 'yellow')}">
      ${a.quote ? `<p class="mark__quote">${esc(a.quote)}</p>` : ''}
      ${a.note ? `<p class="mark__note">${esc(a.note)}</p>` : ''}
      <div class="mark__src"><span class="tag">${label}</span>
        <span>${esc(item.title)}</span><span class="item__sep">·</span>
        <span>${relativeDay(a.createdAt)}</span></div>
    </button>`;
  }).join('');
}

/* ── settings ───────────────────────────────────────────────────────── */

async function refreshSettings() {
  const s = await library.stats();
  $('#stat-grid').innerHTML = [
    ['Saved', s.total],
    ['To read', s.toRead],
    ['Finished', s.finished],
    ['Marks', s.marks],
    ['Min today', s.todayMinutes],
    ['Day streak', s.streakDays],
  ].map(([label, n]) => `<div><b>${n}</b><span>${label}</span></div>`).join('');

  $('#version').textContent = native.version();

  const est = await db.estimate();
  const used = est && est.usage ? `${(est.usage / 1048576).toFixed(1)} MB` : 'a little space';
  $('#storage-state').textContent =
    `${s.total} items and their pictures take ${used} on this phone. `
    + 'Nothing is stored anywhere else.';

  const items = await db.allItems();
  const counts = new Map();
  for (const i of items) counts.set(i.theme || 'Unsorted', (counts.get(i.theme || 'Unsorted') || 0) + 1);
  $('#theme-editor').innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<div class="row" data-theme="${esc(name)}">
      <span>${esc(name)}</span><span class="tag">${n} · rename</span></div>`).join('')
    || '<p class="panel__note">Themes appear once you save something.</p>';

  paintReminder();
}

/* ── the daily nudge ────────────────────────────────────────────────── */

function clockLabel(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function paintReminder() {
  const status = native.reminderStatus();
  const toggle = $('#reminder-toggle');
  if (!status) {
    toggle.disabled = true;
    $('#reminder-state').textContent = 'Only available in the app';
    return;
  }
  toggle.checked = !!status.enabled;
  $('#reminder-time-row').hidden = !status.enabled;
  $('#reminder-time').value =
    `${String(status.hour).padStart(2, '0')}:${String(status.minute).padStart(2, '0')}`;
  if (!status.enabled) {
    $('#reminder-state').textContent = 'Off';
  } else if (status.canNotify === false) {
    $('#reminder-state').textContent = 'Blocked — allow notifications for Folio in Android settings';
  } else {
    $('#reminder-state').textContent = `Around ${clockLabel(status.hour, status.minute)} each day`;
  }
}

function applyReminder() {
  const on = $('#reminder-toggle').checked;
  const [h, m] = ($('#reminder-time').value || '19:30').split(':').map(Number);
  native.configureReminder(Number.isFinite(h) ? h : 19, Number.isFinite(m) ? m : 30, on);
  // Enabling may pop the Android notification permission dialog; the state label
  // catches up when the settings view is next painted.
  setTimeout(paintReminder, 400);
  toast(on ? 'A daily nudge is set.' : 'No more nudges.');
}

/* ── saving ─────────────────────────────────────────────────────────── */

const STAGE_TEXT = {
  fetching: 'Fetching the page…',
  rendering: 'Letting the page build itself…',
  reading: 'Reading the document…',
  figures: 'Capturing the charts…',
  pictures: 'Saving the pictures…',
  filing: 'Working out where it belongs…',
};

function saveStage(stage, detail) {
  const box = $('#save-progress');
  box.hidden = false;
  $('#save-error').hidden = true;

  let text = STAGE_TEXT[stage] || 'Working…';
  let pct = { fetching: 8, rendering: 15, reading: 35, figures: 70, pictures: 85, filing: 95 }[stage] || 5;

  if (detail && detail.total) {
    if (stage === 'reading') {
      text = `Reading page ${detail.done} of ${detail.total}…`;
      pct = 20 + Math.round((detail.done / detail.total) * 45);
    } else if (stage === 'figures') {
      text = `Capturing chart ${detail.done} of ${detail.total}…`;
      pct = 65 + Math.round((detail.done / detail.total) * 20);
    }
  }
  $('#save-stage').textContent = text;
  $('#save-meter').style.width = `${pct}%`;
}

function saveIdle() {
  $('#save-progress').hidden = true;
  $('#save-meter').style.width = '0%';
  $('#bulk-list').hidden = true;
  $('#bulk-list').innerHTML = '';
}

function saveFailed(message, retry) {
  saveIdle();
  state.lastSave = retry;
  // A save keeps running after its sheet is dismissed — the share flow closes it
  // straight away — and an error painted into a hidden card is never seen.
  if ($('#sheet-add').hidden) { toast(message, true); return; }
  $('#save-error').hidden = false;
  $('#save-error-text').textContent = message;
}

async function afterSave(result) {
  saveIdle();
  const item = result.item;
  if (result.duplicate) {
    toast(`Already saved: ${item.title.slice(0, 40)}`);
  } else {
    const warning = (item.warnings || [])[0];
    toast(warning ? `Saved, but: ${warning}` : `Saved to ${item.theme}`, !!warning);
  }
  closeSheets();
  await refreshLibrary();
  await refreshQueue();
  return item;
}

function busy(btn, on, label) {
  btn.classList.toggle('is-busy', on);
  btn.disabled = on;
  // Captured only once: an overlapping call would otherwise capture 'Working…'
  // as the label to restore.
  if (on) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = label || 'Working…';
  } else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

async function runSave(btn, label, work) {
  busy(btn, true, label);
  $('#save-error').hidden = true;
  await library.beginSave();
  try {
    const result = await work();
    await afterSave(result);
  } catch (err) {
    saveFailed(err.message || 'That could not be saved.', () => runSave(btn, label, work));
  } finally {
    library.endSave();
    busy(btn, false);
  }
}

function saveUrl() {
  const input = $('#add-url');
  const url = input.value.trim();
  if (!url) { toast('Paste a link first.', true); return; }
  // The keyboard's Enter lands here directly; a second press mid-save would set
  // the same link saving twice.
  if ($('#btn-save-url').disabled) return;
  runSave($('#btn-save-url'), 'Saving…', async () => {
    const result = await ingest.fromUrl(url, { onStage: saveStage });
    input.value = '';
    return result;
  });
}

let chosenFile = null;

function saveFile() {
  if (!chosenFile) return;
  const file = chosenFile;
  runSave($('#btn-save-file'), 'Reading…', async () => {
    const result = await ingest.fromFile(file, file.name, { onStage: saveStage });
    chosenFile = null;
    $('#file-label').textContent = 'Choose a PDF, HTML, Markdown or text file';
    $('#dropzone').classList.remove('is-set');
    $('#btn-save-file').disabled = true;
    return result;
  });
}

function saveText() {
  const text = $('#add-text').value.trim();
  if (!text) { toast('Paste some text first.', true); return; }
  runSave($('#btn-save-text'), 'Saving…', async () => {
    const result = await ingest.fromText(text, {
      title: $('#add-title').value.trim(), onStage: saveStage,
    });
    $('#add-text').value = '';
    $('#add-title').value = '';
    return result;
  });
}

let bulkSaving = false;

async function saveBulk() {
  const raw = $('#add-bulk').value;
  const urls = raw.split(/\s+/).map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s) || /\w\.\w/.test(s));
  if (!urls.length) { toast('No links found in that text.', true); return; }

  const btn = $('#btn-save-bulk');
  busy(btn, true, 'Saving…');
  $('#save-error').hidden = true;
  const listBox = $('#bulk-list');
  listBox.hidden = false;
  listBox.innerHTML = '';

  let ok = 0;
  bulkSaving = true;
  await library.beginSave();
  try {
    for (let i = 0; i < urls.length; i += 1) {
      saveStage('fetching');
      $('#save-stage').textContent = `Link ${i + 1} of ${urls.length}…`;
      $('#save-meter').style.width = `${Math.round(((i + 1) / urls.length) * 100)}%`;
      try {
        const result = await ingest.fromUrl(urls[i], { onStage: () => {} });
        ok += 1;
        listBox.insertAdjacentHTML('afterbegin',
          `<div><span class="ok">✓</span><span>${esc(result.duplicate
            ? `${result.item.title} (already saved)` : result.item.title)}</span></div>`);
      } catch (err) {
        listBox.insertAdjacentHTML('afterbegin',
          `<div><span class="bad">✕</span><span>${esc(`${urls[i]} — ${err.message}`)}</span></div>`);
      }
    }
  } finally {
    bulkSaving = false;
    library.endSave();
  }

  busy(btn, false);
  $('#save-progress').hidden = true;
  listBox.hidden = false;
  toast(`Saved ${ok} of ${urls.length}.`, ok === 0);
  if (ok) $('#add-bulk').value = '';
  await refreshLibrary();
  await refreshQueue();
}

/* ── item options ───────────────────────────────────────────────────── */

/**
 * The options for one item.
 *
 * `fromReader` adds the two things that only mean anything while reading — the
 * contents and a focus session. They used to sit in the reading bar as icons of their
 * own, which made six competing controls across the top of every article. In here they
 * are named rather than guessed at, and the bar is down to what a thumb reaches for.
 */
function openItemSheet(item, fromReader = false) {
  $('#item-sheet-title').textContent = item.title.slice(0, 70);
  const rows = [];

  if (fromReader) {
    if (reader.outline().length >= 3) {
      rows.push(`<button class="sheetrow" data-act="contents">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-list"/></svg>
        <span>Contents<small>${reader.outline().length} sections</small></span></button>`);
    }
    rows.push(`<button class="sheetrow${focus.active ? ' sheetrow--on' : ''}" data-act="focus">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-clock"/></svg>
      <span>${focus.active ? 'End the focus session' : 'Start a focus session'}
        <small>Holds the screen awake</small></span></button>`);
  } else {
    rows.push(`<button class="sheetrow" data-act="read">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-library"/></svg>
      <span>Read<small>${item.progressPct || 0}% done · ${item.minutesLeft || item.readingMinutes || 0} min left</small></span></button>`);
  }

  rows.push(`<button class="sheetrow${item.favourite ? ' sheetrow--on' : ''}" data-act="favourite">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>
    <span>${item.favourite ? 'Remove from favourites' : 'Add to favourites'}</span></button>`);

  rows.push(`<button class="sheetrow" data-act="status">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>
    <span>${item.status === 'finished' ? 'Mark as unread' : 'Mark as finished'}</span></button>`);

  rows.push(`<button class="sheetrow" data-act="theme">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-marks"/></svg>
    <span>Change the theme<small>${esc(item.theme)}</small></span></button>`);

  rows.push(`<button class="sheetrow" data-act="kind">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-tools"/></svg>
    <span>Move to ${item.kind === 'product' ? 'Reading' : 'Tools'}
      <small>Now filed as ${KIND_LABEL[item.kind] || item.kind}</small></span></button>`);

  rows.push(`<button class="sheetrow" data-act="remind">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-clock"/></svg>
    <span>Remind me tomorrow</span></button>`);

  if (item.url || item.originalPath) {
    rows.push(`<button class="sheetrow" data-act="refresh">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-reread"/></svg>
      <span>Read it in again<small>Re-runs Folio's reader over the source</small></span></button>`);
  }

  if (item.originalPath) {
    rows.push(`<button class="sheetrow" data-act="original">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-file"/></svg>
      <span>Open the original PDF</span></button>`);
  }
  if (item.url) {
    rows.push(`<button class="sheetrow" data-act="source">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-open"/></svg>
      <span>Open in the browser<small>${esc((item.siteName || item.url).slice(0, 46))}</small></span></button>`);
    rows.push(`<button class="sheetrow" data-act="share">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-link"/></svg>
      <span>Share the link</span></button>`);
  }
  if ((item.warnings || []).length) {
    rows.push(`<div class="sheetrow" style="align-items:flex-start">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-note"/></svg>
      <span>When this was saved<small>${esc(item.warnings.join(' '))}</small></span></div>`);
  }

  rows.push(`<button class="sheetrow sheetrow--danger" data-act="delete">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>
    <span>Remove from Folio</span></button>`);

  $('#item-sheet-body').innerHTML = rows.join('');
  $('#item-sheet-body').dataset.id = item.id;
  openSheet('sheet-item');
}

async function handleItemAction(action, id) {
  const item = await library.getItem(id);
  if (!item) return;

  if (action === 'read') { closeSheets(); openReader(id); return; }
  if (action === 'contents') { closeSheets(); openContents(); return; }
  if (action === 'focus') {
    closeSheets();
    if (focus.active) {
      const yes = await ask({ title: 'End your focus session early?', ok: 'End it', danger: true });
      if (yes) endFocus();
    } else openSheet('sheet-focus');
    return;
  }

  if (action === 'favourite') {
    await library.updateItem(id, { favourite: !item.favourite });
    toast(item.favourite ? 'Removed from favourites' : 'Added to favourites');
  } else if (action === 'status') {
    const next = item.status === 'finished' ? 'unread' : 'finished';
    const updated = await library.updateItem(id, { status: next });
    // The open article must see the rewound counters, or its next scroll save
    // would put the old status straight back.
    if (updated && reader.item && reader.item.id === id) {
      reader.item = { ...reader.item, ...updated };
    }
    toast(next === 'finished' ? 'Marked as finished' : 'Marked as unread');
  } else if (action === 'kind') {
    const next = item.kind === 'product' ? 'article' : 'product';
    await library.updateItem(id, { kind: next });
    toast(next === 'product' ? 'Moved to Tools' : 'Moved to Reading');
  } else if (action === 'theme') {
    const options = [...new Set([...(item.themeOptions || []),
      ...cachedItems.map((i) => i.theme)])].filter(Boolean).slice(0, 8);
    const next = await ask({
      title: 'Change the theme',
      body: 'Pick one of these, or type your own.',
      input: item.theme || '',
      options,
      ok: 'File it',
    });
    if (next) {
      await library.updateItem(id, { theme: next });
      toast(`Filed under ${next}`);
    } else return;
  } else if (action === 'remind') {
    const when = new Date(Date.now() + 86400000).toISOString();
    await library.updateItem(id, { remindAfter: when, snoozedUntil: when });
    toast('It will resurface tomorrow');
  } else if (action === 'refresh') {
    closeSheets();
    toast('Reading it in again — a long PDF can take a minute.');
    await library.beginSave();
    try {
      const updated = await ingest.refreshItem(id, { onStage: () => {} });
      toast(`Updated: ${updated.title.slice(0, 44)}`);
      // The open article is stale the moment its content is replaced.
      if (state.view === 'reader' && state.current && state.current.id === id) {
        await openReader(id);
      }
    } catch (err) {
      toast(err.message || 'It could not be read in again.', true);
    } finally {
      library.endSave();
    }
    await refreshLibrary();
    await refreshQueue();
    return;
  } else if (action === 'original') {
    native.openOriginal(item.originalPath, item.originalMime);
    return;
  } else if (action === 'source') {
    native.openExternal(item.url);
    return;
  } else if (action === 'share') {
    native.shareText(item.url);
    return;
  } else if (action === 'delete') {
    const yes = await ask({
      title: 'Remove this?',
      body: `“${item.title.slice(0, 70)}” and its marks will be deleted from this phone.`,
      ok: 'Remove',
      danger: true,
    });
    if (!yes) return;
    await library.removeItem(id);
    toast('Removed');
    if (state.view === 'reader') {
      // The open article is gone, so the reader's exit cleanup runs here: the focus
      // session ends without asking — what it guarded no longer exists — and no
      // progress is flushed for a deleted item.
      endFocus(true);
      flushReading();
      reader.teardown();
      hideSelTool();
      show(state.cameFrom);
    }
  }

  closeSheets();
  await refreshLibrary();
  await refreshQueue();
  if (state.view === 'marks') refreshMarks();
}

/* ── the reader ─────────────────────────────────────────────────────── */

const readerView = $('#view-reader');
const reader = new Reader(readerView, $('#reader-body'), $('#reader-end'), {
  onProgress(pct, words, total) {
    $('#reader-progress-fill').style.width = `${pct}%`;
    if (focus.active) return;              // the countdown owns the label
    const left = total ? Math.max(0, Math.round((total - (words || 0)) / library.WORDS_PER_MINUTE)) : 0;
    $('#reader-progress-label').textContent =
      left > 0 && pct < 100 ? `${pct}% · ${left} min left` : `${pct}%`;
  },
  onChange() { refreshLibrary(); refreshQueue(); },
});

async function openReader(id, scrollToBlock = null) {
  const item = await library.getItem(id);
  if (!item) { toast('That article is no longer here.', true); return; }
  // The view underneath, so leaving the reader goes one level up, not sideways.
  if (state.view !== 'reader') state.cameFrom = state.view;
  state.current = item;
  show('reader');
  await reader.load(item);
  if (scrollToBlock != null) {
    const el = $(`.blk[data-i="${scrollToBlock}"]`, $('#reader-body'));
    if (el) reader.jumpTo(el);
  }
  reader.paintProgress();
}

/* ── contents ───────────────────────────────────────────────────────── */

function openContents() {
  const outline = reader.outline();
  if (!outline.length) return;

  // Mark the section the reader is currently in.
  const pos = readerView.scrollTop + 100;
  let here = -1;
  for (let k = 0; k < outline.length; k += 1) {
    const el = $(`.blk[data-i="${outline[k].i}"]`, $('#reader-body'));
    if (el && el.offsetTop <= pos) here = k;
    else break;
  }

  $('#contents-body').innerHTML = outline.map((h, k) =>
    `<button class="tocrow tocrow--l${h.level}${k === here ? ' is-here' : ''}" data-block="${h.i}">
      <span>${esc(h.text)}</span>${h.page ? `<em>p. ${h.page}</em>` : ''}
    </button>`).join('');
  openSheet('sheet-contents');
  const current = $('#contents-body .is-here');
  if (current) current.scrollIntoView({ block: 'center' });
}

async function leaveReader() {
  if (focus.active) {
    const yes = await ask({ title: 'End your focus session?', ok: 'End it', danger: true });
    if (!yes) return;
    endFocus(true);
  }
  flushReading();
  await reader.flush();
  reader.teardown();
  hideSelTool();
  show(state.cameFrom);
}

/* ── selection toolbar ──────────────────────────────────────────────── */

function hideSelTool() { $('#seltool').hidden = true; }

/* The toolbar's place is fixed in the stylesheet, at the bottom of the screen where
   Android's own selection menu never reaches. */
function showSelTool() {
  $('#seltool').hidden = false;
}

function onSelectionChange() {
  if (state.view !== 'reader') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { hideSelTool(); return; }
  const info = reader.readSelection();
  if (!info) { hideSelTool(); return; }
  state.pendingSelection = info;
  showSelTool();
}

async function applySelectionAction(action, colour = 'yellow') {
  const info = state.pendingSelection;
  if (!info) { hideSelTool(); return; }

  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(info.quote);
      toast('Copied');
    } catch { toast('Copying is not allowed here.', true); }
    window.getSelection().removeAllRanges();
    hideSelTool();
    return;
  }

  if (action === 'note') {
    $('#note-quote').textContent = info.quote;
    $('#note-text').value = '';
    hideSelTool();
    openSheet('sheet-note');
    // The selection is kept: closing the sheet is what clears it.
    state.pendingSelection = info;
    setTimeout(() => $('#note-text').focus(), 200);
    return;
  }

  await saveAnnotation({
    kind: action === 'bookmark' ? 'bookmark' : 'highlight',
    blockIndex: info.blockIndex,
    startWord: info.startWord,
    endWord: info.endWord,
    quote: info.quote,
    colour,
  });
  window.getSelection().removeAllRanges();
  hideSelTool();
}

async function saveAnnotation(payload) {
  const record = await library.addAnnotation(state.current.id, payload);
  const list = await db.annotationsFor(state.current.id);
  reader.applyAnnotations(list);

  if (payload.kind === 'bookmark') {
    const absolute = reader.absoluteWord(payload.blockIndex, payload.startWord);
    reader.progressWords = Math.max(reader.progressWords, absolute);
    reader.paintProgress();
    toast('Bookmarked');
  } else {
    toast(payload.note ? 'Note saved' : 'Highlighted');
  }
  refreshLibrary();
  return record;
}

async function bookmarkHere() {
  const blocks = reader.proseBlocks();
  if (!blocks.length) { toast('Nothing to bookmark yet.', true); return; }
  const mid = readerView.scrollTop + readerView.clientHeight * 0.35;
  let target = blocks[0];
  for (const b of blocks) { if (b.el.offsetTop <= mid) target = b; else break; }
  await saveAnnotation({
    kind: 'bookmark',
    blockIndex: Number(target.el.dataset.i),
    startWord: 0,
    endWord: 1,
    quote: (target.block.text || '').slice(0, 160),
    colour: 'yellow',
  });
}

/* ── what another app shares with us ────────────────────────────────── */

native.on('share', async (payload) => {
  if (!payload) return;
  // Someone who shares into a fresh install has already decided what Folio is for.
  if (state.view === 'welcome') leaveWelcome(false);

  if (payload.type === 'error') { toast(payload.message, true); return; }

  if (payload.type === 'text') {
    const match = /https?:\/\/\S+/.exec(payload.text || '');
    if (match) {
      openSheet('sheet-add');
      selectAddTab('link');
      $('#add-url').value = match[0];
      saveUrl();
      return;
    }
    // Not a link: it is something the reader wanted to keep verbatim.
    openSheet('sheet-add');
    selectAddTab('text');
    $('#add-text').value = payload.text || '';
    $('#add-title').value = payload.title || '';
    return;
  }

  if (payload.type === 'file') {
    openSheet('sheet-add');
    selectAddTab('file');
    $('#file-label').textContent = `${payload.name} · ${(payload.size / 1048576).toFixed(1)} MB`;
    $('#dropzone').classList.add('is-set');
    runSave($('#btn-save-file'), 'Reading…', async () => {
      const res = await fetch(payload.url, { cache: 'no-store' });
      const blob = await res.blob();
      const result = await ingest.fromFile(blob, payload.name, {
        onStage: saveStage, nativePath: payload.path,
      });
      $('#file-label').textContent = 'Choose a PDF, HTML, Markdown or text file';
      $('#dropzone').classList.remove('is-set');
      return result;
    });
  }
});

function selectAddTab(name) {
  $$('#add-tabs .segmented__btn').forEach((b) => b.classList.toggle('is-on', b.dataset.add === name));
  $$('.addpane').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === name));
}

/* ── wiring ─────────────────────────────────────────────────────────── */

function wire() {
  $$('.tab[data-view]').forEach((t) => { t.onclick = () => show(t.dataset.view); });
  $('#btn-welcome-start').onclick = () => leaveWelcome(true);
  $('#btn-welcome-skip').onclick = () => leaveWelcome(false);
  $('#btn-streak').onclick = openStreakSheet;
  $('#btn-add').onclick = () => {
    // A bulk run keeps going behind a dismissed sheet; reopening to check on it
    // must not wipe the log it is still writing.
    if (!bulkSaving) {
      saveIdle();
      $('#save-error').hidden = true;
    }
    openSheet('sheet-add');
    setTimeout(() => $('#add-url').focus(), 200);
  };
  $('#scrim').onclick = closeSheets;

  $('#add-tabs').onclick = (e) => {
    const b = e.target.closest('.segmented__btn');
    if (b) selectAddTab(b.dataset.add);
  };

  $('#btn-save-url').onclick = saveUrl;
  $('#add-url').onkeydown = (e) => { if (e.key === 'Enter') saveUrl(); };
  $('#btn-save-file').onclick = saveFile;
  $('#btn-save-text').onclick = saveText;
  $('#btn-save-bulk').onclick = saveBulk;
  $('#btn-error-dismiss').onclick = () => { $('#save-error').hidden = true; };
  $('#btn-error-retry').onclick = () => { if (state.lastSave) state.lastSave(); };

  // The app's own picker keeps the original file, so a PDF picked here can be
  // reopened and re-read later. The <input> chooser cannot; it is the fallback
  // for running in a plain browser.
  $('#dropzone').onclick = () => { if (!native.pickFile()) $('#add-file').click(); };
  $('#add-file').onchange = () => {
    const f = $('#add-file').files[0];
    if (!f) return;
    chosenFile = f;
    $('#file-label').textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
    $('#dropzone').classList.add('is-set');
    $('#btn-save-file').disabled = false;
  };

  $('#filters').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.shelf) {
      state.shelf = state.shelf === 'product' ? 'readable' : 'product';
      state.theme = '';
    } else if ('status' in chip.dataset) {
      state.status = chip.dataset.status;
    } else if ('theme' in chip.dataset) {
      state.theme = chip.dataset.theme;
    }
    refreshLibrary();
  };

  $('#mark-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.markFilter = chip.dataset.mark;
    $$('#mark-chips .chip').forEach((c) => c.classList.toggle('is-on', c === chip));
    refreshMarks();
  };

  $('#btn-sort').onclick = () => {
    $('#sort-body').innerHTML = SORTS.map(([value, label]) =>
      `<button class="sheetrow" data-sort="${value}">
        <svg class="ic" viewBox="0 0 24 24"><use href="#${state.sort === value ? 'i-check' : 'i-sort'}"/></svg>
        <span>${label}</span></button>`).join('');
    openSheet('sheet-sort');
  };
  $('#sort-body').onclick = (e) => {
    const row = e.target.closest('[data-sort]');
    if (!row) return;
    state.sort = row.dataset.sort;
    closeSheets();
    refreshLibrary();
  };

  $('#btn-search').onclick = () => {
    const bar = $('#searchbar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#search-input').focus();
    else { state.q = ''; $('#search-input').value = ''; refreshLibrary(); }
  };
  $('#search-input').oninput = (e) => {
    state.q = e.target.value.trim();
    refreshLibrary({ animate: false });
  };
  $('#btn-search-clear').onclick = () => {
    $('#search-input').value = '';
    state.q = '';
    refreshLibrary();
    $('#search-input').focus();
  };

  // Item lists: a tap reads, the visible button opens the options.
  ['#item-list', '#queue-list'].forEach((sel) => {
    $(sel).onclick = async (e) => {
      const more = e.target.closest('[data-more]');
      if (more) {
        const item = await library.getItem(more.dataset.more);
        if (item) openItemSheet(item);
        return;
      }
      const row = e.target.closest('.item');
      if (row) openReader(row.dataset.id);
    };
  });

  $('#marks-list').onclick = (e) => {
    const row = e.target.closest('.mark');
    if (row) openReader(row.dataset.item, Number(row.dataset.block));
  };

  $('#item-sheet-body').onclick = (e) => {
    const row = e.target.closest('[data-act]');
    if (row) handleItemAction(row.dataset.act, $('#item-sheet-body').dataset.id);
  };

  // Reader chrome
  $('#btn-reader-back').onclick = leaveReader;
  $('#sheet-focus').onclick = (e) => {
    const btn = e.target.closest('[data-focus]');
    if (btn) startFocus(Number(btn.dataset.focus));
  };
  $('#contents-body').onclick = (e) => {
    const row = e.target.closest('[data-block]');
    if (!row) return;
    closeSheets();
    const el = $(`.blk[data-i="${row.dataset.block}"]`, $('#reader-body'));
    // A navigation jump moves the resume position but reads nothing.
    if (el) reader.jumpTo(el);
  };
  $('#btn-reader-bookmark').onclick = bookmarkHere;
  $('#btn-reader-menu').onclick = async () => {
    const item = await library.getItem(state.current.id);
    if (item) openItemSheet(item, true);
  };

  $('#reader-end').onclick = async (e) => {
    const btn = e.target.closest('[data-end]');
    if (!btn) return;
    const item = state.current;
    if (btn.dataset.end === 'finish') {
      const next = item.status === 'finished' ? 'unread' : 'finished';
      const updated = await library.updateItem(item.id, { status: next });
      state.current = { ...item, ...updated };
      reader.item = state.current;
      reader.progressWords = updated.progressWords;
      reader.renderEnd();
      reader.paintProgress();
      refreshLibrary();
      refreshQueue();
    } else if (btn.dataset.end === 'source') {
      native.openExternal(item.url);
    } else if (btn.dataset.end === 'pdf') {
      native.openOriginal(item.originalPath, item.originalMime);
    }
  };

  // A link tapped inside an article: follow it, or keep it for later.
  $('#btn-link-open').onclick = () => {
    const url = pendingLink;
    closeSheets();
    if (url) native.openExternal(url);
  };
  $('#btn-link-save').onclick = async () => {
    const url = pendingLink;
    if (!url) return;
    const btn = $('#btn-link-save');
    busy(btn, true, 'Saving…');
    await library.beginSave();
    try {
      const result = await ingest.fromUrl(url, { onStage: () => {} });
      closeSheets();
      toast(result.duplicate
        ? `Already saved: ${result.item.title.slice(0, 36)}`
        : `Saved: ${result.item.title.slice(0, 36)}`);
      refreshLibrary().catch(() => {});
      refreshQueue().catch(() => {});
    } catch (err) {
      // The Save sheet's error card is not on screen here, so this has to be said
      // out loud, and the sheet stays open so the reader can try the browser instead.
      toast(err.message || 'That link could not be saved.', true);
    } finally {
      library.endSave();
      busy(btn, false);
    }
  };
  $('#btn-link-cancel').onclick = closeSheets;

  // Selection toolbar
  document.addEventListener('selectionchange', () => {
    clearTimeout(window.__selTimer);
    window.__selTimer = setTimeout(onSelectionChange, 200);
  });
  $('#seltool').onclick = (e) => {
    const dot = e.target.closest('.dot');
    if (dot) { applySelectionAction('highlight', dot.dataset.colour); return; }
    const btn = e.target.closest('[data-sel]');
    if (btn) applySelectionAction(btn.dataset.sel);
  };

  // Tap a picture to open it; a link to choose what to do with it; a folded-away
  // section to read it anyway; a highlight to act on it.
  $('#reader-body').onclick = async (e) => {
    const fold = e.target.closest('.aside__tap');
    if (fold) { toggleAside(fold); return; }

    const link = e.target.closest('a.lnk');
    if (link) {
      // Following it in place would replace the whole app with a web page.
      e.preventDefault();
      askAboutLink(link.getAttribute('href'));
      return;
    }

    const figImg = e.target.closest('figure img');
    if (figImg) {
      const cap = figImg.closest('figure')?.querySelector('figcaption');
      openZoom(figImg.currentSrc || figImg.src, cap ? cap.textContent : '');
      return;
    }
    const mark = e.target.closest('mark.hl');
    if (!mark) return;
    const list = await db.annotationsFor(state.current.id);
    const ann = list.find((a) => a.id === mark.dataset.ann);
    if (!ann) return;
    const yes = await ask({
      title: ann.note ? 'This note' : 'This highlight',
      body: ann.note ? ann.note : ann.quote,
      ok: 'Remove it',
      danger: true,
    });
    if (!yes) return;
    await library.removeAnnotation(ann.id);
    reader.applyAnnotations(await db.annotationsFor(state.current.id));
    toast('Removed');
  };

  // Note sheet
  $('#btn-note-cancel').onclick = () => { closeSheets(); window.getSelection().removeAllRanges(); };
  $('#btn-note-save').onclick = async () => {
    const info = state.pendingSelection;
    const text = $('#note-text').value.trim();
    if (!info) { closeSheets(); return; }
    if (!text) { toast('Write something first.', true); return; }
    await saveAnnotation({
      kind: 'note',
      blockIndex: info.blockIndex,
      startWord: info.startWord,
      endWord: info.endWord,
      quote: info.quote,
      note: text,
      colour: 'yellow',
    });
    closeSheets();
    window.getSelection().removeAllRanges();
  };

  // Settings
  $('#theme-mode-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    applyTheme(chip.dataset.mode);
  };
  $('#textsize').oninput = (e) => applyTextSize(Number(e.target.value));

  $('#reminder-toggle').onchange = applyReminder;
  $('#reminder-time').onchange = () => { if ($('#reminder-toggle').checked) applyReminder(); };

  $('#theme-editor').onclick = async (e) => {
    const row = e.target.closest('[data-theme]');
    if (!row) return;
    const from = row.dataset.theme;
    const to = await ask({ title: `Rename “${from}”`, input: from, ok: 'Rename' });
    if (!to || to === from) return;
    await library.renameTheme(from, to);
    toast('Theme renamed');
    refreshSettings();
    refreshLibrary();
  };

  $('#btn-refresh-all').onclick = async () => {
    const btn = $('#btn-refresh-all');
    const items = await db.allItems();
    const targets = items.filter((i) => i.url || i.originalPath);
    if (!targets.length) {
      toast('Nothing here was saved from a link or a PDF.', true);
      return;
    }
    const yes = await ask({
      title: 'Read every article in again?',
      body: `${targets.length} item(s) will be fetched and read again. `
        + 'Marks and progress are kept. This can take a few minutes.',
      ok: 'Go ahead',
    });
    if (!yes) return;

    busy(btn, true, 'Working…');
    let ok = 0;
    const failures = [];
    await library.beginSave();
    try {
      for (let i = 0; i < targets.length; i += 1) {
        btn.textContent = `Updating ${i + 1} of ${targets.length}…`;
        try {
          await ingest.refreshItem(targets[i].id, {});
          ok += 1;
        } catch (err) {
          failures.push(`${targets[i].title.slice(0, 40)} — ${err.message}`);
        }
      }
    } finally {
      library.endSave();
    }
    busy(btn, false);
    toast(failures.length
      ? `Updated ${ok}. ${failures.length} could not be re-read.`
      : `All ${ok} updated.`, false);
    if (failures.length) console.warn('Re-read failures:', failures);
    await refreshLibrary();
    await refreshQueue();
    await refreshSettings();
  };

  $('#btn-export').onclick = async () => {
    const btn = $('#btn-export');
    busy(btn, true, 'Preparing…');
    try {
      const json = await library.buildBackup();
      const stamp = library.localDay();
      const res = await native.exportBackup(json, `folio-${stamp}.json`);
      toast(res.ok ? 'Backup ready to save' : (res.error || 'The backup failed.'), !res.ok);
    } finally { busy(btn, false); }
  };

  $('#btn-import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async () => {
    const file = $('#import-file').files[0];
    if (!file) return;
    const yes = await ask({
      title: 'Restore this backup?',
      body: 'Anything with the same identity is overwritten. Nothing else is removed.',
      ok: 'Restore',
    });
    $('#import-file').value = '';
    if (!yes) return;
    try {
      const n = await library.restoreBackup(await file.text());
      toast(`${n} items restored`);
      refreshLibrary();
      refreshSettings();
    } catch (err) {
      toast(err.message || 'That backup could not be read.', true);
    }
  };

  $('#btn-wipe').onclick = async () => {
    const yes = await ask({
      title: 'Erase everything?',
      body: 'Every article, mark and note on this phone is deleted. This cannot be undone.',
      ok: 'Erase it all',
      danger: true,
    });
    if (!yes) return;
    await db.clearAll();
    // The database rows pointed at files on disk — kept originals, shared imports.
    // Erasing everything means those go too.
    native.clearAllFiles();
    toast('Everything erased');
    refreshLibrary();
    refreshSettings();
  };

  // Sticky-header shadow, so the list reads as scrolling under the bar.
  $$('.view').forEach((view) => {
    view.addEventListener('scroll', () => {
      const bar = $('.bar', view);
      if (bar) bar.classList.toggle('is-stuck', view.scrollTop > 4);
    }, { passive: true });
  });
}

/* ── the folded-away sections ───────────────────────────────────────── */

/**
 * Open or close a section the extractor set aside.
 *
 * Nothing here is ever deleted: when the reader could not be certain a block was the
 * publisher's furniture rather than the article, it folded it up and said what it
 * thought it was. This is how the reader disagrees.
 */
function toggleAside(button) {
  const body = button.parentElement.querySelector('.aside__body');
  if (!body) return;
  const open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', open ? 'false' : 'true');
  body.hidden = open;
  const more = button.querySelector('.aside__more');
  if (more) more.textContent = open ? 'Show' : 'Hide';
}

/* ── a link inside an article ───────────────────────────────────────── */

let pendingLink = '';

/** Host and a little of the path: enough to recognise where a link goes. */
function prettyUrl(href) {
  try {
    const u = new URL(href);
    const path = u.pathname === '/' ? '' : u.pathname;
    const text = u.hostname.replace(/^www\./, '') + path;
    return text.length > 64 ? `${text.slice(0, 63)}…` : text;
  } catch {
    return href;
  }
}

function askAboutLink(href) {
  if (!href) return;
  pendingLink = href;
  $('#link-url').textContent = prettyUrl(href);
  openSheet('sheet-link');
}

/* ── a picture, full screen ─────────────────────────────────────────── */

const ZOOM_MAX = 6;
const DOUBLE_TAP_SCALE = 2.6;

/**
 * Open a picture full screen, with the gestures a picture needs.
 *
 * The transform is `translate(tx, ty) scale(s)` about the centre of the stage, so a
 * point sitting `u` from the centre of the picture is drawn at `tx + s·u`. Holding a
 * point still under two moving fingers is then just solving that for the new
 * translation: `tx₁ = m − s₁·(m − tx₀)/s₀`, which is what keeps the picture from
 * sliding out from under a pinch.
 *
 * Panning is clamped so the picture's edges can never be dragged inside the screen,
 * and a pinch that ends below the fitted size springs back rather than leaving a
 * postage stamp adrift in the middle of a black field.
 */
function openZoom(src, caption = '') {
  const view = document.createElement('div');
  view.className = 'fig-zoom';
  view.innerHTML = '<div class="fig-zoom__stage"><img alt=""></div>'
    + '<button class="fig-zoom__close" type="button" aria-label="Close">'
    + '<svg class="ic" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
    + (caption ? `<figcaption class="fig-zoom__cap"></figcaption>` : '');

  const stage = view.querySelector('.fig-zoom__stage');
  const img = view.querySelector('img');
  img.src = src;
  if (caption) view.querySelector('.fig-zoom__cap').textContent = caption;
  document.body.appendChild(view);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;

  const paint = (animate = false) => {
    img.style.transition = animate ? 'transform .2s var(--ease, ease)' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    view.classList.toggle('is-zoomed', scale > 1.01);
  };

  /** How far the picture may be moved before an edge would come inside the screen. */
  const limits = () => {
    const box = stage.getBoundingClientRect();
    const w = img.clientWidth * scale;
    const h = img.clientHeight * scale;
    return { x: Math.max(0, (w - box.width) / 2), y: Math.max(0, (h - box.height) / 2) };
  };

  const clamp = () => {
    const max = limits();
    tx = Math.max(-max.x, Math.min(max.x, tx));
    ty = Math.max(-max.y, Math.min(max.y, ty));
  };

  /** Move the picture so the given screen point keeps showing what it showed. */
  const zoomAbout = (clientX, clientY, next) => {
    const box = stage.getBoundingClientRect();
    const mx = clientX - (box.left + box.width / 2);
    const my = clientY - (box.top + box.height / 2);
    tx = mx - ((mx - tx) * next) / scale;
    ty = my - ((my - ty) * next) / scale;
    scale = next;
    clamp();
  };

  const settle = () => {
    if (scale < 1) { scale = 1; tx = 0; ty = 0; }
    clamp();
    paint(true);
  };

  const mid = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  view.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.fig-zoom__close')) return;
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const m = mid();
      gesture = { kind: 'pinch', d: m.d, scale };
    } else if (pointers.size === 1) {
      gesture = { kind: 'drag', x: e.clientX, y: e.clientY, tx, ty, moved: 0 };
    }
  });

  view.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const m = mid();
      if (gesture.d > 0) {
        const next = Math.min(ZOOM_MAX, Math.max(0.6, (gesture.scale * m.d) / gesture.d));
        zoomAbout(m.x, m.y, next);
        paint();
      }
      return;
    }
    if (gesture.kind === 'drag' && scale > 1.01) {
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
      tx = gesture.tx + dx;
      ty = gesture.ty + dy;
      clamp();
      paint();
    } else if (gesture.kind === 'drag') {
      gesture.moved = Math.max(gesture.moved,
        Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y));
    }
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    const wasDrag = gesture && gesture.kind === 'drag';
    const moved = wasDrag ? gesture.moved : 99;
    if (pointers.size === 1) {
      // One finger lifted from a pinch: carry on as a drag from where it is.
      const [only] = [...pointers.values()];
      gesture = { kind: 'drag', x: only.x, y: only.y, tx, ty, moved: 99 };
      return;
    }
    if (pointers.size > 0) return;
    gesture = null;
    settle();

    if (moved > 8) return;                 // a drag, not a tap
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      if (scale > 1.01) { scale = 1; tx = 0; ty = 0; paint(true); }
      else { zoomAbout(e.clientX, e.clientY, DOUBLE_TAP_SCALE); paint(true); }
      return;
    }
    lastTap = now;
    // A single tap closes, but only once the wait for a second tap has passed.
    setTimeout(() => {
      if (lastTap === now && scale <= 1.01 && view.isConnected) view.remove();
    }, 300);
  };

  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);
  view.querySelector('.fig-zoom__close').onclick = () => view.remove();
  paint();
}

/* The Android back button. One level up at a time: a zoomed picture closes to its
   article, the article closes to the library, and only the library itself lets the
   press fall through and leave the app. Returning false is what lets it leave. */
window.__folioBack = () => {
  const zoom = $('.fig-zoom');
  if (zoom) { zoom.remove(); return true; }
  if (!$('#seltool').hidden) { hideSelTool(); window.getSelection().removeAllRanges(); return true; }
  if (anySheetOpen()) { closeSheets(); return true; }
  if (state.view === 'reader') { leaveReader(); return true; }
  // The welcome screen is the top of the app on a first run, not a level above it.
  if (state.view === 'welcome') return false;
  if (state.view !== 'library') { show('library'); return true; }
  return false;
};

/* ── start ──────────────────────────────────────────────────────────── */

async function main() {
  wire();
  applyTheme(themePref());
  applyTextSize(Number(localStorage.getItem('folio-textsize') || 100));
  $('#textsize').value = String(Number(localStorage.getItem('folio-textsize') || 100));

  // Decided before anything is awaited, so a first run never flashes the empty shelf.
  if (!localStorage.getItem(SEEN_WELCOME)) show('welcome');

  await refreshLibrary();
  await refreshQueue();
  await refreshStreak();

  // Reclaim any pictures an interrupted save left stored but unreferenced;
  // nothing else sweeps until something is deleted.
  library.sweepWhenIdle().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  toast('Folio could not start cleanly. Restart the app.', true);
});
