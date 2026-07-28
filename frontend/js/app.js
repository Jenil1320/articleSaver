/* Folio — application shell: routing, the library, saving, and the reader's controls. */

import * as api from './api.js';
import * as store from './db.js';
import { Reader, esc } from './reader.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'library',
  kind: 'readable',
  status: '',
  theme: '',
  sort: 'recent',
  q: '',
  items: [],
  themes: [],
  markFilter: '',
  current: null,
  pendingSelection: null,
};

/* ── small helpers ──────────────────────────────────────────────────── */

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-bad', !!bad);
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), bad ? 4200 : 2200);
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

const KIND_LABEL = { article: 'Article', paper: 'Paper', post: 'Post', product: 'Tool' };

/* ── view routing ───────────────────────────────────────────────────── */

function show(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  $$('.tab[data-view]').forEach((t) => t.classList.toggle('is-on', t.dataset.view === view));
  document.body.classList.toggle('reading', view === 'reader');
  if (view !== 'reader') window.scrollTo({ top: 0, behavior: 'auto' });
  if (view === 'library') refreshLibrary();
  if (view === 'queue') refreshQueue();
  if (view === 'marks') refreshMarks();
  if (view === 'settings') refreshSettings();
}

/* ── library ────────────────────────────────────────────────────────── */

function matches(item) {
  if (item.deleted) return false;
  if (state.kind === 'product' && item.kind !== 'product') return false;
  if (state.kind === 'readable' && item.kind === 'product') return false;
  if (state.status === '' && item.status === 'archived') return false;
  if (state.status && item.status !== state.status) return false;
  if (state.theme && item.theme !== state.theme) return false;
  if (state.q) {
    const q = state.q.toLowerCase();
    const hay = `${item.title} ${item.site_name} ${item.byline} ${item.excerpt} ${item.theme}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sortItems(list) {
  const by = {
    recent: (a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''),
    oldest: (a, b) => (a.saved_at || '').localeCompare(b.saved_at || ''),
    title: (a, b) => (a.title || '').localeCompare(b.title || ''),
    longest: (a, b) => (b.word_count || 0) - (a.word_count || 0),
    shortest: (a, b) => (a.word_count || 0) - (b.word_count || 0),
    progress: (a, b) => (b.progress_pct || 0) - (a.progress_pct || 0),
  }[state.sort];
  return [...list].sort(by || by.recent);
}

function itemRow(item, extra = '') {
  const pct = item.word_count
    ? Math.round((100 * (item.progress_words || 0)) / item.word_count) : 0;
  const minutes = item.reading_minutes
    || (item.word_count ? Math.max(1, Math.round(item.word_count / 230)) : 0);

  const meta = [];
  if (item.site_name) meta.push(`<b>${esc(item.site_name)}</b>`);
  if (item.kind !== 'article') meta.push(esc(KIND_LABEL[item.kind] || item.kind));
  if (minutes) meta.push(`${minutes} min`);
  meta.push(relativeDay(item.saved_at));

  const thumb = item.lead_image
    ? `<img class="item__thumb" data-msrc="${esc(item.lead_image)}" alt="" loading="lazy">` : '';

  const bar = pct > 0 && item.status !== 'finished'
    ? `<div class="item__bar"><i style="width:${pct}%"></i></div>` : '';

  const flags = [];
  if (item.theme && item.theme !== 'Unsorted') flags.push(`<span class="tag tag--theme">${esc(item.theme)}</span>`);
  if (item.status === 'finished') flags.push('<span class="tag tag--done">Finished</span>');
  else if (pct > 0) flags.push(`<span class="tag">${pct}%</span>`);
  if (item.favourite) flags.push('<span class="item__flag"><svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-star"/></svg></span>');

  return `<button class="item ${item.status === 'finished' ? 'is-finished' : ''}" data-id="${item.id}">
    <div class="item__top">
      <div class="item__main">
        <h3 class="item__title">${esc(item.title)}</h3>
        <div class="item__meta">${meta.filter(Boolean).join('<span class="item__sep">·</span>')}</div>
      </div>${thumb}
    </div>
    ${item.excerpt ? `<p class="item__excerpt">${esc(item.excerpt)}</p>` : ''}
    <div class="item__meta" style="margin-top:8px">${flags.join('')}${extra}</div>
    ${bar}
  </button>`;
}

async function paintThumbs(root) {
  await Promise.all($$('img[data-msrc]', root).map(async (img) => {
    const url = img.getAttribute('data-msrc');
    img.removeAttribute('data-msrc');
    try {
      const blob = await store.getMedia(url);
      if (blob) { img.src = URL.createObjectURL(blob); return; }
    } catch { /* fall back to the network copy */ }
    img.src = url;
  }));
}

async function refreshLibrary() {
  const all = await store.allItems();
  state.items = all;
  const visible = sortItems(all.filter(matches));
  const list = $('#item-list');
  const empty = $('#library-empty');

  renderThemeChips(all);

  const total = all.filter((i) => !i.deleted && i.status !== 'archived').length;
  const unfinished = all.filter((i) => !i.deleted && ['unread', 'reading'].includes(i.status)
    && i.kind !== 'product').length;
  $('#library-sub').textContent = total
    ? `${total} saved · ${unfinished} still to read`
    : 'Your reading library';

  if (!visible.length) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = all.length
      ? `<h3>Nothing here</h3><p>No ${state.kind === 'product' ? 'tools' : 'articles'} match these filters.</p>`
      : `<h3>Your shelf is empty</h3><p>Tap the plus button to save a link, a PDF, a tweet or a note.</p>`;
    return;
  }
  empty.hidden = true;
  list.innerHTML = visible.map((i) => itemRow(i)).join('');
  paintThumbs(list);
}

function renderThemeChips(all) {
  const counts = new Map();
  all.filter((i) => !i.deleted && i.status !== 'archived'
    && (state.kind === 'product' ? i.kind === 'product' : i.kind !== 'product'))
    .forEach((i) => counts.set(i.theme || 'Unsorted', (counts.get(i.theme || 'Unsorted') || 0) + 1));

  const themes = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  state.themes = themes;
  const box = $('#theme-chips');
  if (themes.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = `<button class="chip ${state.theme ? '' : 'is-on'}" data-theme="">All themes</button>`
    + themes.map(([name, n]) =>
      `<button class="chip ${state.theme === name ? 'is-on' : ''}" data-theme="${esc(name)}">${esc(name)}<span class="chip__n">${n}</span></button>`).join('');
}

/* ── queue ──────────────────────────────────────────────────────────── */

async function refreshQueue() {
  let queue = [];
  try {
    queue = (await (await fetch('/api/queue')).json()).queue || [];
  } catch {
    // Offline: work the same rule out locally.
    const all = await store.allItems();
    const now = Date.now();
    queue = all.filter((i) => !i.deleted && ['unread', 'reading'].includes(i.status)
      && i.kind !== 'product')
      .map((i) => {
        const days = Math.floor((now - new Date(i.last_opened_at || i.saved_at).getTime()) / 86400000);
        return { ...i, idle_days: days, reason: i.status === 'reading'
          ? `Part-read, untouched for ${days} days` : `Saved ${days} days ago, not started` };
      })
      .filter((i) => (i.status === 'reading' ? i.idle_days >= 3 : i.idle_days >= 7))
      .sort((a, b) => b.idle_days - a.idle_days);
  }

  const badge = $('#queue-badge');
  badge.hidden = !queue.length;
  badge.textContent = queue.length > 99 ? '99+' : String(queue.length);

  const list = $('#queue-list');
  const empty = $('#queue-empty');
  if (!queue.length) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<h3>Nothing waiting</h3><p>Everything you have saved is either finished or still fresh.</p>';
    return;
  }
  empty.hidden = true;
  list.innerHTML = queue.map((i) =>
    itemRow(i, `<span class="tag tag--reason">${esc(i.reason || '')}</span>`)).join('');
  paintThumbs(list);
}

/* ── marks ──────────────────────────────────────────────────────────── */

async function refreshMarks() {
  const [anns, items] = await Promise.all([store.allAnnotations(), store.allItems()]);
  const byId = new Map(items.map((i) => [i.id, i]));
  let list = anns.filter((a) => !a.deleted && byId.has(a.item_id));
  if (state.markFilter) list = list.filter((a) => a.kind === state.markFilter);
  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const box = $('#marks-list');
  const empty = $('#marks-empty');
  if (!list.length) {
    box.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<h3>No marks yet</h3><p>Select any text while reading to highlight it, add a note or drop a bookmark.</p>';
    return;
  }
  empty.hidden = true;
  box.innerHTML = list.map((a) => {
    const item = byId.get(a.item_id);
    const label = a.kind === 'bookmark' ? 'Bookmark' : a.kind === 'note' ? 'Note' : 'Highlight';
    return `<button class="mark" data-item="${a.item_id}" data-block="${a.block_index}" data-colour="${esc(a.colour || 'yellow')}">
      ${a.quote ? `<p class="mark__quote">${esc(a.quote)}</p>` : ''}
      ${a.note ? `<p class="mark__note">${esc(a.note)}</p>` : ''}
      <div class="mark__src"><span class="tag">${label}</span>
        <span>${esc(item.title)}</span><span class="item__sep">·</span>
        <span>${relativeDay(a.created_at)}</span></div>
    </button>`;
  }).join('');
}

/* ── settings ───────────────────────────────────────────────────────── */

async function refreshSettings() {
  const items = await store.allItems();
  const anns = await store.allAnnotations();
  const live = items.filter((i) => !i.deleted);
  const readable = live.filter((i) => i.kind !== 'product');
  const wordsRead = live.reduce((n, i) => n + (i.progress_words || 0), 0);

  $('#stat-grid').innerHTML = [
    ['Saved', live.length],
    ['To read', readable.filter((i) => ['unread', 'reading'].includes(i.status)).length],
    ['Finished', live.filter((i) => i.status === 'finished').length],
    ['Tools', live.filter((i) => i.kind === 'product').length],
    ['Marks', anns.filter((a) => !a.deleted).length],
    ['Minutes read', Math.round(wordsRead / 230)],
  ].map(([label, n]) => `<div><b>${n}</b><span>${label}</span></div>`).join('');

  const hourSel = $('#digest-hour');
  if (!hourSel.options.length) {
    hourSel.innerHTML = Array.from({ length: 24 }, (_, h) =>
      `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
  }

  try {
    const s = await api.getSettings();
    $('#digest-enabled').checked = s.digest_enabled;
    $('#digest-hour').value = String(s.digest_hour);
    $('#digest-to').value = s.digest_to || '';
    $('#version').textContent = s.version || '';
    $('#smtp-state').textContent = s.smtp_configured
      ? 'Mail server ready.'
      : 'No mail server is configured yet. See SETUP.md for the four settings needed.';
  } catch {
    $('#smtp-state').textContent = 'Settings are unavailable while offline.';
  }

  const est = await store.estimate();
  const media = est && est.usage
    ? `${(est.usage / 1048576).toFixed(1)} MB stored on this device` : 'stored on this device';

  // A service worker only registers on a secure origin. Over plain http on a home
  // network it will not, so the app still reads from its local copy but cannot be
  // installed to the home screen or opened with no network at all. Say so plainly
  // rather than let it fail quietly.
  const installed = 'serviceWorker' in navigator
    && (await navigator.serviceWorker.getRegistrations()).length > 0;
  const secure = window.isSecureContext;

  $('#offline-state').innerHTML = installed
    ? `${live.length} items are held on this device, ${media}. Full offline reading is on.`
    : secure
      ? `${live.length} items are held on this device, ${media}. Offline support is starting up.`
      : `${live.length} items are held on this device, ${media}.<br><br>`
        + 'This page is served over plain <b>http</b>, so Android will not let it install '
        + 'to your home screen or open without a network. Serve Folio over <b>https</b> '
        + 'to turn that on — see SETUP.md.';

  const box = $('#theme-editor');
  const counts = new Map();
  live.forEach((i) => counts.set(i.theme || 'Unsorted', (counts.get(i.theme || 'Unsorted') || 0) + 1));
  box.innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<div class="row" data-theme="${esc(name)}">
      <span>${esc(name)}</span><span>${n} · rename</span></div>`).join('')
    || '<p class="panel__note">Themes appear once you save something.</p>';
}

/* ── sheets ─────────────────────────────────────────────────────────── */

function openSheet(id) {
  $('#scrim').hidden = false;
  $(`#${id}`).hidden = false;
}

function closeSheets() {
  $('#scrim').hidden = true;
  $$('.sheet').forEach((s) => { s.hidden = true; });
  state.pendingSelection = null;
}

/* ── saving ─────────────────────────────────────────────────────────── */

function busy(btn, on, label) {
  btn.classList.toggle('is-busy', on);
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

async function afterSave(result, what) {
  if (result.duplicate) {
    toast(`Already saved: ${result.item.title.slice(0, 40)}`);
  } else {
    const warn = (result.item.warnings || [])[0];
    toast(warn ? `Saved, but: ${warn}` : `Saved · ${result.item.theme}`, !!warn);
  }
  await api.sync();
  closeSheets();
  await refreshLibrary();
  await refreshQueue();
  void what;
}

async function saveUrl() {
  const input = $('#add-url');
  const url = input.value.trim();
  if (!url) { toast('Paste a link first.', true); return; }
  const btn = $('#btn-save-url');
  busy(btn, true, 'Fetching…');
  try {
    const result = await api.saveUrl(url);
    input.value = '';
    await afterSave(result, 'link');
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(btn, false);
  }
}

async function saveFile() {
  const input = $('#add-file');
  const file = input.files && input.files[0];
  if (!file) return;
  const btn = $('#btn-save-file');
  busy(btn, true, 'Reading…');
  try {
    const result = await api.saveFile(file);
    input.value = '';
    $('#file-label').textContent = 'Choose a PDF, HTML, Markdown or text file';
    $('#dropzone').classList.remove('is-set');
    btn.disabled = true;
    await afterSave(result, 'file');
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(btn, false);
  }
}

async function saveText() {
  const text = $('#add-text').value.trim();
  if (!text) { toast('Paste some text first.', true); return; }
  const btn = $('#btn-save-text');
  busy(btn, true, 'Saving…');
  try {
    const result = await api.saveText(text, $('#add-title').value.trim());
    $('#add-text').value = '';
    $('#add-title').value = '';
    await afterSave(result, 'text');
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(btn, false);
  }
}

async function saveBulk() {
  const raw = $('#add-bulk').value;
  const urls = raw.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s) || /\w\.\w/.test(s));
  if (!urls.length) { toast('No links found in that text.', true); return; }

  const btn = $('#btn-save-bulk');
  const statusBox = $('#bulk-status');
  busy(btn, true, 'Importing…');
  statusBox.hidden = false;
  statusBox.innerHTML = `<div><span>Starting ${urls.length} imports…</span></div>`;

  try {
    const { job } = await api.saveBulk(urls);
    let done = false;
    while (!done) {
      await new Promise((r) => setTimeout(r, 1200));
      const s = await api.jobStatus(job);
      done = s.finished;
      statusBox.innerHTML = `<div><span>${s.done} of ${s.total} done</span></div>`
        + s.results.slice().reverse().map((r) =>
          `<div><span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✕'}</span>`
          + `<span>${esc(r.ok ? (r.duplicate ? `${r.title} (already saved)` : r.title) : `${r.url} — ${r.error}`)}</span></div>`).join('');
    }
    const s = await api.jobStatus(job);
    const ok = s.results.filter((r) => r.ok).length;
    toast(`Imported ${ok} of ${s.total}.`, ok === 0);
    $('#add-bulk').value = '';
    await api.sync();
    await refreshLibrary();
    await refreshQueue();
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(btn, false);
  }
}

/* ── item options ───────────────────────────────────────────────────── */

function openItemSheet(item) {
  $('#item-sheet-title').textContent = item.title.slice(0, 70);
  const themeOptions = (item.theme_options || []).filter((t) => t !== item.theme);
  const rows = [];

  rows.push(`<button class="sheetrow" data-act="read">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-library"/></svg>
    <span>Read<small>${item.progress_pct || 0}% done · ${item.reading_minutes || 0} min</small></span></button>`);

  rows.push(`<button class="sheetrow" data-act="favourite">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>
    <span>${item.favourite ? 'Remove from favourites' : 'Add to favourites'}</span></button>`);

  rows.push(`<button class="sheetrow" data-act="status">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>
    <span>${item.status === 'finished' ? 'Mark as unread' : 'Mark as finished'}</span></button>`);

  rows.push(`<button class="sheetrow" data-act="kind">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-list"/></svg>
    <span>Move to ${item.kind === 'product' ? 'Reading' : 'Tools & platforms'}
      <small>Now filed as ${KIND_LABEL[item.kind] || item.kind}</small></span></button>`);

  rows.push(`<button class="sheetrow" data-act="theme">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-marks"/></svg>
    <span>Change theme<small>${esc(item.theme)}${
      themeOptions.length ? ` · suggested: ${esc(themeOptions.join(', '))}` : ''}</small></span></button>`);

  rows.push(`<button class="sheetrow" data-act="remind">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-clock"/></svg>
    <span>Remind me tomorrow</span></button>`);

  if (item.url) {
    rows.push(`<a class="sheetrow" href="${esc(item.url)}" target="_blank" rel="noopener">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-open"/></svg>
      <span>Open the original<small>${esc((item.site_name || item.url).slice(0, 46))}</small></span></a>`);
  }

  rows.push(`<button class="sheetrow sheetrow--danger" data-act="delete">
    <svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>
    <span>Remove from Folio</span></button>`);

  $('#item-sheet-body').innerHTML = rows.join('');
  $('#item-sheet-body').dataset.id = item.id;
  openSheet('sheet-item');
}

async function handleItemAction(action, id) {
  const item = await store.getItem(id);
  if (!item) return;

  if (action === 'read') { closeSheets(); openReader(id); return; }

  if (action === 'favourite') {
    await api.patchItem(id, { favourite: !item.favourite });
    toast(item.favourite ? 'Removed from favourites' : 'Added to favourites');
  } else if (action === 'status') {
    const next = item.status === 'finished' ? 'unread' : 'finished';
    await api.patchItem(id, { status: next });
    toast(next === 'finished' ? 'Marked as finished' : 'Marked as unread');
  } else if (action === 'kind') {
    const next = item.kind === 'product' ? 'article' : 'product';
    await api.patchItem(id, { kind: next });
    toast(next === 'product' ? 'Moved to Tools & platforms' : 'Moved to Reading');
  } else if (action === 'theme') {
    const suggestion = (item.theme_options || []).find((t) => t !== item.theme) || '';
    const next = window.prompt('Theme for this item', item.theme || suggestion);
    if (next && next.trim()) {
      await api.patchItem(id, { theme: next.trim() });
      toast(`Filed under ${next.trim()}`);
    }
  } else if (action === 'remind') {
    const when = new Date(Date.now() + 86400000).toISOString();
    await api.patchItem(id, { remind_after: when, snoozed_until: when });
    toast('It will resurface tomorrow');
  } else if (action === 'delete') {
    if (!window.confirm(`Remove “${item.title.slice(0, 60)}” from Folio?`)) return;
    await api.deleteItem(id);
    toast('Removed');
  }

  closeSheets();
  await refreshLibrary();
  await refreshQueue();
  if (state.view === 'marks') refreshMarks();
}

/* ── reader ─────────────────────────────────────────────────────────── */

const reader = new Reader($('#reader-body'), $('#reader-end'), {
  onProgress(pct) {
    $('#reader-progress-fill').style.width = `${pct}%`;
    $('#reader-progress-label').textContent = `${pct}%`;
  },
  onChange() { refreshLibrary(); refreshQueue(); },
});

async function openReader(id, scrollToBlock = null) {
  try {
    const item = await api.getItem(id);
    state.current = item;
    show('reader');
    // The window scroll is shared by every view. Without this the reader inherits
    // however far the library was scrolled, which reads as progress the reader
    // never made — and can mark an unread article as finished.
    window.scrollTo({ top: 0, behavior: 'auto' });
    await reader.load(item);
    if (scrollToBlock != null) {
      const el = $(`.blk[data-i="${scrollToBlock}"]`, $('#reader-body'));
      if (el) window.scrollTo({ top: Math.max(0, el.offsetTop - 90), behavior: 'auto' });
    }
    reader.paintProgress();
  } catch (err) {
    toast(err.message || 'That article could not be opened.', true);
  }
}

async function leaveReader() {
  await reader.flush();
  reader.teardown();
  hideSelTool();
  show('library');
}

/* ── selection toolbar ──────────────────────────────────────────────── */

function hideSelTool() { $('#seltool').hidden = true; }

function showSelTool(rect) {
  const tool = $('#seltool');
  tool.hidden = false;
  const width = tool.offsetWidth || 240;
  let left = rect.left + rect.width / 2 - width / 2 + window.scrollX;
  left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
  let top = rect.top + window.scrollY - tool.offsetHeight - 10;
  if (top < window.scrollY + 8) top = rect.bottom + window.scrollY + 10;
  tool.style.left = `${left}px`;
  tool.style.top = `${top}px`;
}

function onSelectionChange() {
  if (state.view !== 'reader') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { hideSelTool(); return; }
  const info = reader.readSelection();
  if (!info) { hideSelTool(); return; }
  state.pendingSelection = info;
  showSelTool(info.rect);
}

async function applySelectionAction(action, colour = 'yellow') {
  const info = state.pendingSelection;
  if (!info && action !== 'bookmark') { hideSelTool(); return; }

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
    openSheet('sheet-note');
    hideSelTool();
    return;
  }

  const payload = {
    kind: action === 'bookmark' ? 'bookmark' : 'highlight',
    block_index: info.block_index,
    start_word: info.start_word,
    end_word: info.end_word,
    quote: info.quote,
    colour,
  };
  await saveAnnotation(payload);
  window.getSelection().removeAllRanges();
  hideSelTool();
}

async function saveAnnotation(payload) {
  const record = await api.addAnnotation(state.current.id, payload);
  const list = await store.annotationsFor(state.current.id);
  reader.applyAnnotations(list);

  if (payload.kind === 'bookmark') {
    const absolute = reader.absoluteWord(payload.block_index, payload.start_word);
    reader.progressWords = Math.max(reader.progressWords, absolute);
    reader.paintProgress();
    await api.sendProgress(state.current.id, reader.progressWords, absolute);
    toast('Bookmarked');
  } else {
    toast(payload.note ? 'Note saved' : 'Highlighted');
  }
  refreshLibrary();
  return record;
}

/* ── bookmark the current position from the toolbar ─────────────────── */

async function bookmarkHere() {
  const blocks = reader.proseBlocks();
  const mid = window.scrollY + window.innerHeight * 0.35;
  let target = blocks[0];
  for (const b of blocks) { if (b.el.offsetTop <= mid) target = b; else break; }
  if (!target) { toast('Nothing to bookmark yet.', true); return; }
  const index = Number(target.el.dataset.i);
  await saveAnnotation({
    kind: 'bookmark',
    block_index: index,
    start_word: 0,
    end_word: 1,
    quote: (target.block.text || '').slice(0, 160),
    colour: 'yellow',
  });
}

/* ── wiring ─────────────────────────────────────────────────────────── */

function wire() {
  $$('.tab[data-view]').forEach((t) => { t.onclick = () => show(t.dataset.view); });
  $('#btn-add').onclick = () => { openSheet('sheet-add'); setTimeout(() => $('#add-url').focus(), 120); };
  $('#scrim').onclick = closeSheets;

  $$('#add-tabs .segmented__btn').forEach((b) => {
    b.onclick = () => {
      $$('#add-tabs .segmented__btn').forEach((x) => x.classList.toggle('is-on', x === b));
      $$('.addpane').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === b.dataset.add));
    };
  });

  $('#btn-save-url').onclick = saveUrl;
  $('#add-url').onkeydown = (e) => { if (e.key === 'Enter') saveUrl(); };
  $('#btn-save-file').onclick = saveFile;
  $('#btn-save-text').onclick = saveText;
  $('#btn-save-bulk').onclick = saveBulk;

  $('#dropzone').onclick = () => $('#add-file').click();
  $('#add-file').onchange = () => {
    const f = $('#add-file').files[0];
    if (!f) return;
    $('#file-label').textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
    $('#dropzone').classList.add('is-set');
    $('#btn-save-file').disabled = false;
  };

  $$('#kind-tabs .segmented__btn').forEach((b) => {
    b.onclick = () => {
      state.kind = b.dataset.kind;
      state.theme = '';
      $$('#kind-tabs .segmented__btn').forEach((x) => x.classList.toggle('is-on', x === b));
      refreshLibrary();
    };
  });

  $('#status-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.status = chip.dataset.status;
    $$('#status-chips .chip').forEach((c) => c.classList.toggle('is-on', c === chip));
    refreshLibrary();
  };

  $('#theme-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.theme = chip.dataset.theme;
    refreshLibrary();
  };

  $('#mark-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.markFilter = chip.dataset.mark;
    $$('#mark-chips .chip').forEach((c) => c.classList.toggle('is-on', c === chip));
    refreshMarks();
  };

  $('#sort-select').onchange = (e) => { state.sort = e.target.value; refreshLibrary(); };

  $('#btn-search').onclick = () => {
    const bar = $('#searchbar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#search-input').focus();
    else { state.q = ''; $('#search-input').value = ''; refreshLibrary(); }
  };
  $('#search-input').oninput = (e) => { state.q = e.target.value.trim(); refreshLibrary(); };
  $('#btn-search-clear').onclick = () => {
    $('#search-input').value = ''; state.q = ''; refreshLibrary(); $('#search-input').focus();
  };

  $('#btn-sync').onclick = async () => {
    const btn = $('#btn-sync');
    btn.classList.add('is-spinning');
    const res = await api.sync();
    btn.classList.remove('is-spinning');
    toast(res.ok ? 'Up to date' : 'Cannot reach the server', !res.ok);
    await refreshLibrary();
    await refreshQueue();
  };

  // Item lists
  ['#item-list', '#queue-list'].forEach((sel) => {
    $(sel).onclick = (e) => {
      const row = e.target.closest('.item');
      if (row) openReader(row.dataset.id);
    };
    let pressTimer;
    $(sel).addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.item');
      if (!row) return;
      pressTimer = setTimeout(async () => {
        const item = await store.getItem(row.dataset.id);
        if (item) { openItemSheet(item); }
      }, 480);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((ev) =>
      $(sel).addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));
  });

  $('#marks-list').onclick = (e) => {
    const row = e.target.closest('.mark');
    if (row) openReader(row.dataset.item, Number(row.dataset.block));
  };

  $('#item-sheet-body').onclick = (e) => {
    const row = e.target.closest('[data-act]');
    if (!row) return;
    handleItemAction(row.dataset.act, $('#item-sheet-body').dataset.id);
  };

  // Reader chrome
  $('#btn-reader-back').onclick = leaveReader;
  $('#btn-reader-bookmark').onclick = bookmarkHere;
  $('#btn-reader-menu').onclick = async () => {
    const item = await store.getItem(state.current.id);
    if (item) openItemSheet(item);
  };

  // Selection toolbar
  document.addEventListener('selectionchange', () => {
    clearTimeout(window.__selTimer);
    window.__selTimer = setTimeout(onSelectionChange, 180);
  });
  $('#seltool').onclick = (e) => {
    const dot = e.target.closest('.dot');
    if (dot) { applySelectionAction('highlight', dot.dataset.colour); return; }
    const btn = e.target.closest('[data-sel]');
    if (btn) applySelectionAction(btn.dataset.sel);
  };

  // Tap a chart or table to see it full screen; tap a highlight to act on it.
  $('#reader-body').onclick = async (e) => {
    const figImg = e.target.closest('figure.fig img');
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
    const list = await store.annotationsFor(state.current.id);
    const ann = list.find((a) => a.id === mark.dataset.ann);
    if (!ann) return;
    const message = ann.note ? `Note:\n\n${ann.note}\n\nRemove this mark?` : 'Remove this highlight?';
    if (window.confirm(message)) {
      await api.removeAnnotation(ann.id);
      reader.applyAnnotations(await store.annotationsFor(state.current.id));
      toast('Removed');
    }
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
      block_index: info.block_index,
      start_word: info.start_word,
      end_word: info.end_word,
      quote: info.quote,
      note: text,
      colour: 'yellow',
    });
    closeSheets();
    window.getSelection().removeAllRanges();
  };

  // Settings
  $('#digest-enabled').onchange = async (e) => {
    try { await api.putSettings({ digest_enabled: e.target.checked }); toast('Saved'); }
    catch { toast('Could not save that setting.', true); }
  };
  $('#digest-hour').onchange = async (e) => {
    try { await api.putSettings({ digest_hour: Number(e.target.value) }); toast('Saved'); }
    catch { toast('Could not save that setting.', true); }
  };
  $('#digest-to').onchange = async (e) => {
    try { await api.putSettings({ digest_to: e.target.value.trim() }); toast('Saved'); }
    catch { toast('Could not save that setting.', true); }
  };
  $('#btn-test-digest').onclick = async () => {
    const btn = $('#btn-test-digest');
    busy(btn, true, 'Sending…');
    try { const r = await api.testDigest(); toast(r.message); }
    catch (err) { toast(err.message, true); }
    finally { busy(btn, false); }
  };
  $('#btn-cache-all').onclick = async () => {
    const btn = $('#btn-cache-all');
    busy(btn, true, 'Downloading…');
    try {
      await api.sync({ full: true });
      const n = await api.cacheEverything((done, total) => {
        btn.textContent = `Downloading ${done} of ${total}…`;
      });
      toast(`${n} items ready to read offline.`);
    } catch { toast('Could not finish downloading.', true); }
    finally { busy(btn, false); refreshSettings(); }
  };
  $('#theme-editor').onclick = async (e) => {
    const row = e.target.closest('[data-theme]');
    if (!row) return;
    const from = row.dataset.theme;
    const to = window.prompt(`Rename “${from}” to`, from);
    if (!to || to.trim() === from) return;
    try {
      await api.renameTheme(from, to.trim());
      await api.sync({ full: true });
      toast('Theme renamed');
      refreshSettings(); refreshLibrary();
    } catch (err) { toast(err.message, true); }
  };

  // Android back button closes sheets and leaves the reader
  window.addEventListener('popstate', () => {
    if (!$('#scrim').hidden) { closeSheets(); history.pushState({}, ''); return; }
    if (state.view === 'reader') { leaveReader(); history.pushState({}, ''); }
  });

  window.addEventListener('online', async () => {
    const res = await api.sync();
    if (res.ok && res.replayed) toast(`${res.replayed} change(s) synced`);
    refreshLibrary();
  });
}

/* ── share target and deep links ────────────────────────────────────── */

async function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('share');
  const open = params.get('open');

  if (shared) {
    history.replaceState({}, '', '/');
    const match = shared.match(/https?:\/\/\S+/);
    openSheet('sheet-add');
    $('#add-url').value = match ? match[0] : shared;
    if (match) setTimeout(saveUrl, 200);
    return;
  }
  if (open) {
    history.replaceState({}, '', '/');
    openReader(open);
  }
}

/* ── start ──────────────────────────────────────────────────────────── */

async function main() {
  wire();
  history.pushState({}, '');

  await refreshLibrary();
  await refreshQueue();

  const res = await api.sync();
  if (res.ok) { await refreshLibrary(); await refreshQueue(); }
  await handleLaunchParams();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch { /* http on a LAN address has no service worker; the app still works */ }
  }
}

main();
