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

    const done = (value) => {
      // Cleared first: closeSheets() consults it, and a dialog that answered itself
      // would recurse.
      dialogResolve = null;
      closeSheets();
      okBtn.onclick = null;
      $('#ask-cancel').onclick = null;
      resolve(value);
    };
    okBtn.onclick = () => done(input == null ? true : field.value.trim());
    $('#ask-cancel').onclick = () => done(null);
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

function paintStreak() {
  const habit = state.habit;
  const sub = $('#library-sub');
  const base = sub.dataset.base || sub.textContent;
  if (!habit) return;
  const bits = [];
  if (habit.streakDays >= 2) bits.push(`${habit.streakDays}-day streak`);
  if (habit.todayMinutes >= 1) bits.push(`${habit.todayMinutes} min today`);
  sub.textContent = bits.length ? `${base} · ${bits.join(' · ')}` : base;
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
  const streak = state.habit && state.habit.streakDays >= 2
    ? ` · ${state.habit.streakDays}-day streak` : '';
  toast(`Session complete${streak}. Well read.`);
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
  if (view === 'library') refreshLibrary();
  if (view === 'queue') refreshQueue();
  if (view === 'marks') refreshMarks();
  if (view === 'settings') refreshSettings();
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
  const meta = [];
  if (item.siteName) meta.push(`<b>${esc(item.siteName)}</b>`);
  if (item.kind !== 'article') meta.push(esc(KIND_LABEL[item.kind] || item.kind));
  if (item.readingMinutes) meta.push(`${item.readingMinutes} min`);
  meta.push(relativeDay(item.savedAt));

  const thumb = item.leadImage
    ? `<img class="item__thumb" data-msrc="${esc(item.leadImage)}" alt="">` : '';

  // A short post's excerpt is its title again; repeating it is clutter.
  const titleNorm = item.title.replace(/…$/, '').trim().toLowerCase();
  const excerptNorm = (item.excerpt || '').trim().toLowerCase();
  const duplicate = !excerptNorm
    || (excerptNorm.startsWith(titleNorm) && excerptNorm.length < titleNorm.length + 40);

  const flags = [];
  if (item.theme && item.theme !== 'Unsorted') flags.push(`<span class="tag">${esc(item.theme)}</span>`);
  if (item.status === 'finished') flags.push('<span class="tag tag--done">Finished</span>');
  else if (pct > 0) flags.push(`<span class="tag">${pct}% · ${item.minutesLeft} min left</span>`);
  if (item.favourite) flags.push('<span class="tag">★</span>');
  if ((item.warnings || []).length) flags.push('<span class="tag">Note</span>');

  return `<div class="item" data-id="${item.id}" role="button" tabindex="0">
    <div class="item__top">
      <div class="item__main">
        <h3 class="item__title">${esc(item.title)}</h3>
        <div class="item__meta">${meta.filter(Boolean).join('<span class="item__sep">·</span>')}</div>
      </div>${thumb}
    </div>
    ${duplicate ? '' : `<p class="item__excerpt">${esc(item.excerpt)}</p>`}
    <div class="item__meta" style="margin-top:8px;padding-right:38px">${flags.join('')}${extra}</div>
    ${pct > 0 && item.status !== 'finished' ? `<div class="item__bar"><i style="width:${pct}%"></i></div>` : ''}
    <button class="item__more" data-more="${item.id}" aria-label="Options for ${esc(item.title.slice(0, 40))}">
      <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-more"/></svg>
    </button>
  </div>`;
}

async function paintThumbs(root) {
  await Promise.all($$('img[data-msrc]', root).map(async (img) => {
    const key = img.getAttribute('data-msrc');
    img.removeAttribute('data-msrc');
    try {
      const blob = await db.getMedia(key);
      if (blob) { img.src = URL.createObjectURL(blob); return; }
    } catch { /* fall through */ }
    img.remove();
  }));
}

let cachedItems = [];

async function refreshLibrary() {
  const all = await library.listItems();
  cachedItems = all;
  const visible = sortItems(all.filter(matches));

  renderFilters(all);

  const shelf = all.filter((i) => i.status !== 'archived');
  const unfinished = shelf.filter((i) => ['unread', 'reading'].includes(i.status)
    && i.kind !== 'product').length;
  const sub = $('#library-sub');
  sub.dataset.base = shelf.length
    ? `${shelf.length} saved · ${unfinished} still to read`
    : 'Your reading library';
  sub.textContent = sub.dataset.base;
  paintStreak();

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
    return `<button class="mark" data-item="${a.itemId}" data-block="${a.blockIndex}" data-colour="${esc(a.colour || 'yellow')}">
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
  $('#save-error').hidden = false;
  $('#save-error-text').textContent = message;
  state.lastSave = retry;
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
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

async function runSave(btn, label, work) {
  busy(btn, true, label);
  $('#save-error').hidden = true;
  try {
    const result = await work();
    await afterSave(result);
  } catch (err) {
    saveFailed(err.message || 'That could not be saved.', () => runSave(btn, label, work));
  } finally {
    busy(btn, false);
  }
}

function saveUrl() {
  const input = $('#add-url');
  const url = input.value.trim();
  if (!url) { toast('Paste a link first.', true); return; }
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

  busy(btn, false);
  $('#save-progress').hidden = true;
  listBox.hidden = false;
  toast(`Saved ${ok} of ${urls.length}.`, ok === 0);
  if (ok) $('#add-bulk').value = '';
  await refreshLibrary();
  await refreshQueue();
}

/* ── item options ───────────────────────────────────────────────────── */

function openItemSheet(item) {
  $('#item-sheet-title').textContent = item.title.slice(0, 70);
  const rows = [];

  rows.push(`<button class="sheetrow" data-act="read">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-library"/></svg>
    <span>Read<small>${item.progressPct || 0}% done · ${item.minutesLeft || item.readingMinutes || 0} min left</small></span></button>`);

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

  if (action === 'favourite') {
    await library.updateItem(id, { favourite: !item.favourite });
    toast(item.favourite ? 'Removed from favourites' : 'Added to favourites');
  } else if (action === 'status') {
    const next = item.status === 'finished' ? 'unread' : 'finished';
    await library.updateItem(id, { status: next });
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
    if (state.view === 'reader') show('library');
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
  state.current = item;
  show('reader');
  await reader.load(item);
  if (scrollToBlock != null) {
    const el = $(`.blk[data-i="${scrollToBlock}"]`, $('#reader-body'));
    if (el) readerView.scrollTop = Math.max(0, el.offsetTop - 90);
  }
  reader.paintProgress();
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
  show('library');
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
  $('#btn-add').onclick = () => {
    saveIdle();
    $('#save-error').hidden = true;
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

  $('#dropzone').onclick = () => $('#add-file').click();
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
  $('#search-input').oninput = (e) => { state.q = e.target.value.trim(); refreshLibrary(); };
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
  $('#btn-focus').onclick = async () => {
    if (focus.active) {
      const yes = await ask({ title: 'End your focus session early?', ok: 'End it', danger: true });
      if (yes) endFocus();
      return;
    }
    openSheet('sheet-focus');
  };
  $('#sheet-focus').onclick = (e) => {
    const btn = e.target.closest('[data-focus]');
    if (btn) startFocus(Number(btn.dataset.focus));
  };
  $('#btn-reader-bookmark').onclick = bookmarkHere;
  $('#btn-reader-menu').onclick = async () => {
    const item = await library.getItem(state.current.id);
    if (item) openItemSheet(item);
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

  // Tap a chart to see it full screen; tap a highlight to act on it.
  $('#reader-body').onclick = async (e) => {
    const figImg = e.target.closest('figure img');
    if (figImg) {
      const zoom = document.createElement('div');
      zoom.className = 'fig-zoom';
      const big = document.createElement('img');
      big.src = figImg.src;
      zoom.appendChild(big);
      zoom.onclick = () => zoom.remove();
      document.body.appendChild(zoom);
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

/* The Android back button. Returning false lets the press leave the app. */
window.__folioBack = () => {
  if (!$('#seltool').hidden) { hideSelTool(); window.getSelection().removeAllRanges(); return true; }
  if (anySheetOpen()) { closeSheets(); return true; }
  if (state.view === 'reader') { leaveReader(); return true; }
  if (state.view !== 'library') { show('library'); return true; }
  return false;
};

/* ── start ──────────────────────────────────────────────────────────── */

async function main() {
  wire();
  applyTheme(themePref());
  applyTextSize(Number(localStorage.getItem('folio-textsize') || 100));
  $('#textsize').value = String(Number(localStorage.getItem('folio-textsize') || 100));

  await refreshLibrary();
  await refreshQueue();
  await refreshStreak();
}

main().catch((err) => {
  console.error(err);
  toast('Folio could not start cleanly. Restart the app.', true);
});
