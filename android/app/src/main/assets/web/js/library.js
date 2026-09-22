/* Everything the library knows how to do to itself: create, update, delete, measure
   progress, work out what should resurface, and keep the reading streak.

   These were server rules once. They are the same rules, now running beside the data
   they act on, which is why the app needs nothing switched on anywhere else. */

import * as db from './db.js';
import * as native from './native.js';
import { PROSE_TYPES } from './extract/blocks.js';

export const WORDS_PER_MINUTE = 230;
export const FINISH_THRESHOLD = 0.95;

// When nothing has been read for this long, the item resurfaces in the queue.
const STALE_UNREAD_DAYS = 7;
const STALE_READING_DAYS = 3;

// A day counts towards the streak once this much reading is logged. Low on purpose:
// a bar you clear daily builds the habit; a bar you miss kills it.
export const STREAK_THRESHOLD_SECONDS = 300;

export const VALID_STATUS = ['unread', 'reading', 'finished', 'archived'];
export const VALID_KIND = ['article', 'paper', 'post', 'product'];
export const VALID_ANNOTATION = ['highlight', 'note', 'bookmark'];

const now = () => new Date().toISOString();

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const parseTime = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Everything derived rather than stored, added on the way out. */
export function decorate(item) {
  const total = item.wordCount || 0;
  const read = Math.min(item.progressWords || 0, total || Infinity) || 0;
  return {
    ...item,
    progressPct: total ? Math.round((100 * read) / total) : 0,
    readingMinutes: total ? Math.max(1, Math.round(total / WORDS_PER_MINUTE)) : 0,
    minutesLeft: total ? Math.max(0, Math.round((total - read) / WORDS_PER_MINUTE)) : 0,
  };
}

/* ── items ───────────────────────────────────────────────────────────── */

export async function createItem(data) {
  const id = newId();
  const ts = now();
  const item = {
    id,
    url: data.url || '',
    canonicalUrl: data.canonicalUrl || data.url || '',
    kind: data.kind || 'article',
    title: (data.title || 'Untitled').trim().slice(0, 400),
    byline: (data.byline || '').trim().slice(0, 200),
    siteName: (data.siteName || '').trim().slice(0, 120),
    publishedAt: data.publishedAt || null,
    savedAt: ts,
    excerpt: data.excerpt || '',
    leadImage: data.leadImage || null,
    wordCount: data.wordCount || 0,
    content: data.content || [],
    textPlain: data.textPlain || '',
    theme: data.theme || 'Unsorted',
    themeSource: 'auto',
    themeOptions: data.themeOptions || [],
    status: 'unread',
    progressWords: 0,
    resumeWords: 0,
    favourite: false,
    source: data.source || 'url',
    originalPath: data.originalPath || null,
    originalMime: data.originalMime || null,
    extractMethod: data.extractMethod || '',
    warnings: data.warnings || [],
    pageCount: data.pageCount || 0,
    lastOpenedAt: null,
    finishedAt: null,
    remindAfter: null,
    snoozedUntil: null,
    updatedAt: ts,
  };
  await db.putItem(item);
  return item;
}

export async function findByUrl(url) {
  if (!url) return null;
  const items = await db.allItems();
  return items.find((i) => i.url === url || i.canonicalUrl === url) || null;
}

export async function getItem(id) {
  const item = await db.getItem(id);
  if (!item) return null;
  const annotations = await db.annotationsFor(id);
  return { ...decorate(item), annotations };
}

export async function listItems() {
  const items = await db.allItems();
  return items.map(decorate);
}

export async function updateItem(id, patch) {
  const item = await db.getItem(id);
  if (!item) return null;

  if (patch.theme && String(patch.theme).trim()) {
    item.theme = String(patch.theme).trim().slice(0, 80);
    item.themeSource = 'user';
  }
  if (patch.kind && VALID_KIND.includes(patch.kind)) item.kind = patch.kind;
  if (patch.title && String(patch.title).trim()) {
    item.title = String(patch.title).trim().slice(0, 400);
  }
  if (patch.status && VALID_STATUS.includes(patch.status)) {
    item.status = patch.status;
    if (patch.status === 'finished') {
      item.finishedAt = now();
      item.progressWords = item.wordCount;
    } else if (patch.status === 'unread') {
      item.finishedAt = null;
      item.progressWords = 0;
      item.resumeWords = 0;
    }
  }
  if ('favourite' in patch) item.favourite = !!patch.favourite;
  for (const key of ['remindAfter', 'snoozedUntil']) {
    if (key in patch) item[key] = patch[key] || null;
  }

  item.updatedAt = now();
  await db.putItem(item);
  return decorate(item);
}

/** A direct field write, for bookkeeping the save pipeline does after creating an item. */
export async function updateItemRaw(id, fields) {
  const item = await db.getItem(id);
  if (!item) return null;
  Object.assign(item, fields, { updatedAt: now() });
  await db.putItem(item);
  return decorate(item);
}

/* Pictures land in the media store before the item that will reference them exists,
   so a sweep that runs while a save is still storing them would delete them. Saves
   announce themselves here; a sweep asked for while one runs waits until none are. */
let savesInFlight = 0;
let sweepDeferred = false;
let sweepRunning = null;

export function sweepWhenIdle() {
  if (savesInFlight > 0) {
    sweepDeferred = true;
    return Promise.resolve();
  }
  if (!sweepRunning) {
    sweepRunning = db.sweepMedia().finally(() => { sweepRunning = null; });
  }
  return sweepRunning;
}

export async function beginSave() {
  while (sweepRunning) {
    try { await sweepRunning; } catch { /* a failed sweep still ends */ }
  }
  savesInFlight += 1;
}

export function endSave() {
  savesInFlight = Math.max(0, savesInFlight - 1);
  if (!savesInFlight && sweepDeferred) {
    sweepDeferred = false;
    sweepWhenIdle().catch(() => {});
  }
}

export async function removeItem(id) {
  const item = await db.getItem(id);
  if (!item) return false;
  if (item.originalPath) native.deleteFile(item.originalPath);
  await db.deleteAnnotationsFor(id);
  await db.deleteItem(id);
  await sweepWhenIdle();
  return true;
}

/* ── reading an item in again ────────────────────────────────────────── */

/**
 * Re-attach one mark to freshly extracted text. The anchor is the quote itself:
 * wherever those words now live is where the mark belongs. A mark whose words no
 * longer exist is kept — its quote still reads in the Marks list — but flagged
 * `detached` so the reader does not paint it over the wrong text.
 */
function reanchor(annotation, blocks) {
  const squash = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');
  const quote = squash(annotation.quote);
  const quoteWords = quote ? quote.split(' ').length : 0;

  const tryFind = (needle) => {
    if (needle.length < 8) return false;
    for (const b of blocks) {
      if (!PROSE_TYPES.has(b.type) || !b.text) continue;
      const idx = b.text.indexOf(needle);
      if (idx < 0) continue;
      const before = b.text.slice(0, idx).match(/\S+/g);
      const start = before ? before.length : 0;
      annotation.blockIndex = b.i;
      annotation.startWord = start;
      annotation.endWord = Math.max(start + 1, Math.min(start + quoteWords, b.words));
      delete annotation.detached;
      return true;
    }
    return false;
  };

  if (quote && (tryFind(quote) || tryFind(quote.split(' ').slice(0, 8).join(' ')))) return true;
  annotation.detached = true;
  return false;
}

/**
 * Replace an item's extracted content while keeping its identity: id, saved date,
 * status, favourite, progress, and any theme the reader filed by hand. Marks are
 * re-attached by their quoted text; pictures no longer referenced are swept.
 */
export async function applyRefresh(id, data) {
  const item = await db.getItem(id);
  if (!item) return null;

  item.title = (data.title || item.title || 'Untitled').trim().slice(0, 400);
  item.byline = (data.byline || '').trim().slice(0, 200);
  item.siteName = (data.siteName || item.siteName || '').trim().slice(0, 120);
  item.publishedAt = data.publishedAt || item.publishedAt;
  item.canonicalUrl = data.canonicalUrl || item.canonicalUrl;
  item.excerpt = data.excerpt || item.excerpt;
  item.leadImage = data.leadImage || item.leadImage;
  item.content = data.content;
  item.wordCount = data.wordCount;
  item.textPlain = data.textPlain;
  item.pageCount = data.pageCount || item.pageCount;
  item.extractMethod = data.method;
  item.warnings = data.warnings || [];
  // The shelf is the reader's own filing; only an automatic choice is re-filed.
  if (item.themeSource !== 'user') {
    item.theme = data.verdict.theme;
    item.themeOptions = data.verdict.themeOptions;
  }
  // What an item is can change on a re-read — a bare post that turns out to carry
  // a whole article. Tools stay put: that filing is the reader's own.
  if (item.kind !== 'product' && VALID_KIND.includes(data.verdict.kind)) {
    item.kind = data.verdict.kind;
  }

  const total = item.wordCount || 0;
  item.progressWords = Math.min(item.progressWords || 0, total);
  item.resumeWords = Math.min(item.resumeWords || 0, total);
  if (item.status === 'finished') item.progressWords = total;

  item.updatedAt = now();
  await db.putItem(item);

  const marks = await db.annotationsFor(id);
  for (const a of marks) {
    reanchor(a, item.content || []);
    a.updatedAt = now();
    await db.putAnnotation(a);
  }

  await sweepWhenIdle();
  return decorate(item);
}

/**
 * Progress only ever moves forward; scrolling back up is not un-reading.
 * `resumeWords` is separate, because that is where the reader actually is.
 */
export async function recordProgress(id, { progressWords, resumeWords, opened = false } = {}) {
  const item = await db.getItem(id);
  if (!item) return null;

  const total = item.wordCount || 0;
  let furthest = Math.max(item.progressWords || 0, Math.floor(progressWords || 0));
  if (total) furthest = Math.min(furthest, total);

  let resume = resumeWords == null ? (item.resumeWords || 0) : Math.floor(resumeWords);
  resume = Math.max(resume, 0);
  if (total) resume = Math.min(resume, total);

  if (item.status !== 'archived') {
    if (total && furthest >= total * FINISH_THRESHOLD) {
      item.status = 'finished';
      item.finishedAt = item.finishedAt || now();
    } else if (furthest > 0) {
      item.status = 'reading';
      item.finishedAt = null;
    }
  }

  item.progressWords = furthest;
  item.resumeWords = resume;
  if (opened) item.lastOpenedAt = now();
  item.updatedAt = now();
  await db.putItem(item);
  return decorate(item);
}

/* ── annotations ─────────────────────────────────────────────────────── */

export async function addAnnotation(itemId, data) {
  const item = await db.getItem(itemId);
  if (!item) return null;
  if (!VALID_ANNOTATION.includes(data.kind)) throw new Error(`Unknown mark ${data.kind}.`);

  const record = {
    id: data.id || newId(),
    itemId,
    kind: data.kind,
    blockIndex: Math.floor(data.blockIndex || 0),
    startWord: Math.floor(data.startWord || 0),
    endWord: Math.floor(data.endWord || 0),
    quote: (data.quote || '').slice(0, 4000),
    note: (data.note || '').slice(0, 8000),
    colour: data.colour || 'yellow',
    createdAt: data.createdAt || now(),
    updatedAt: now(),
  };
  await db.putAnnotation(record);

  // A bookmark marks how far the reader got, so it moves progress with it.
  if (record.kind === 'bookmark') {
    const block = (item.content || [])[record.blockIndex];
    if (block) {
      await recordProgress(itemId, { progressWords: (block.start || 0) + record.startWord });
    }
  }
  return record;
}

export async function updateAnnotation(id, patch) {
  const all = await db.allAnnotations();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  if ('note' in patch) found.note = (patch.note || '').slice(0, 8000);
  if ('colour' in patch) found.colour = patch.colour || 'yellow';
  found.updatedAt = now();
  await db.putAnnotation(found);
  return found;
}

export const removeAnnotation = (id) => db.deleteAnnotation(id);

/* ── themes ──────────────────────────────────────────────────────────── */

export async function renameTheme(from, to) {
  const target = (to || '').trim().slice(0, 80);
  if (!target || !from) return 0;
  const items = await db.allItems();
  let n = 0;
  for (const item of items) {
    if (item.theme === from) {
      item.theme = target;
      item.themeSource = 'user';
      item.updatedAt = now();
      await db.putItem(item);
      n += 1;
    }
  }
  return n;
}

/* ── the queue ───────────────────────────────────────────────────────── */

/** Items worth resurfacing, most pressing first. */
export async function readingQueue(limit = 40) {
  const items = await db.allItems();
  const nowMs = Date.now();
  const due = [];

  for (const raw of items) {
    if (!['unread', 'reading'].includes(raw.status)) continue;
    if (!['article', 'paper', 'post'].includes(raw.kind)) continue;

    const snoozed = parseTime(raw.snoozedUntil);
    if (snoozed && snoozed > nowMs) continue;

    const item = decorate(raw);
    const reference = parseTime(raw.lastOpenedAt) || parseTime(raw.savedAt) || nowMs;
    const idleDays = Math.max(0, (nowMs - reference) / 86400000);
    const explicit = parseTime(raw.remindAfter);

    let reason;
    let score;
    if (explicit && explicit <= nowMs) {
      reason = 'You asked to be reminded';
      score = 1000 + idleDays;
    } else if (raw.status === 'reading' && idleDays >= STALE_READING_DAYS) {
      reason = `Part-read, untouched for ${Math.floor(idleDays)} days`;
      score = 500 + idleDays + item.progressPct;
    } else if (raw.status === 'unread' && idleDays >= STALE_UNREAD_DAYS) {
      reason = `Saved ${Math.floor(idleDays)} days ago, not started`;
      score = 200 + idleDays;
    } else {
      continue;
    }

    due.push({ ...item, reason, idleDays: Math.round(idleDays * 10) / 10, score });
  }

  due.sort((a, b) => b.score - a.score);
  return due.slice(0, limit).map(({ score, ...rest }) => rest);
}

/* ── the reading habit ───────────────────────────────────────────────── */

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Add read time to a calendar day. The phone's midnight is the one that matters. */
export async function logReading(seconds, day = localDay()) {
  const add = Math.max(0, Math.min(Math.floor(seconds || 0), 600));  // at most 10 min per call
  if (!add) return readingStats();
  const current = (await db.getDay(day)) || 0;
  await db.setDay(day, current + add);
  return readingStats();
}

export async function readingStats() {
  const days = await db.allDays();
  const byDay = new Map(days.map((d) => [d.day, d.seconds]));
  const todayKey = localDay();

  // Today extends the streak once past the threshold; until then it neither counts
  // nor breaks what was built up to yesterday.
  let streak = (byDay.get(todayKey) || 0) >= STREAK_THRESHOLD_SECONDS ? 1 : 0;
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 1);
  while ((byDay.get(localDay(cursor)) || 0) >= STREAK_THRESHOLD_SECONDS) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    todaySeconds: byDay.get(todayKey) || 0,
    todayMinutes: Math.round((byDay.get(todayKey) || 0) / 60),
    streakDays: streak,
    streakThresholdMinutes: Math.round(STREAK_THRESHOLD_SECONDS / 60),
    days: days.sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30),
  };
}

/* ── backup ──────────────────────────────────────────────────────────── */

/**
 * Everything except the pictures, which would multiply the size many times over.
 * The text, the marks and the progress are what cannot be fetched again.
 */
export async function buildBackup() {
  const [items, annotations, days] = await Promise.all([
    db.allItems(), db.allAnnotations(), db.allDays(),
  ]);
  return JSON.stringify({
    folio: 1,
    exportedAt: now(),
    items: items.map(({ content, ...rest }) => ({ ...rest, content })),
    annotations,
    reading: days,
  });
}

export async function restoreBackup(json) {
  const data = JSON.parse(json);
  if (!data || data.folio !== 1) throw new Error('That is not a Folio backup.');

  // A backup is outside data: fields the reader treats as numbers must be numbers,
  // and every item needs the title the rest of the app takes for granted.
  const asNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  let restored = 0;
  for (const item of data.items || []) {
    if (!item || !item.id) continue;
    item.title = String(item.title || 'Untitled');
    item.wordCount = asNumber(item.wordCount) || 0;
    // Pictures are not in a backup — but on the phone that wrote one they are still
    // in the media store, so a reference that still resolves is kept. Only a block
    // whose picture is genuinely gone loses its source rather than showing a
    // broken frame.
    const content = [];
    for (const b of item.content || []) {
      const block = { ...b };
      for (const key of ['page', 'num', 'depth']) {
        if (block[key] != null) {
          const n = asNumber(block[key]);
          if (n == null) delete block[key];
          else block[key] = n;
        }
      }
      // A source is either a key into this phone's own store or it is nothing. An
      // address that survived a hand-edited or foreign backup would be handed to the
      // reader, which would look it up, find nothing, and quietly drop the figure.
      for (const key of ['src', 'poster']) {
        if (!block[key]) continue;
        if (!block[key].startsWith('media:') || !(await db.getMedia(block[key]))) {
          block[key] = '';
        }
      }
      content.push(block);
    }
    item.content = content;
    if (item.leadImage && (!item.leadImage.startsWith('media:')
      || !(await db.getMedia(item.leadImage)))) {
      item.leadImage = null;
    }
    // The original file is likewise kept when it still answers on this phone.
    if (item.originalPath) {
      let answers = false;
      if (native.available) {
        try {
          answers = (await fetch(native.fileUrl(item.originalPath), { cache: 'no-store' })).ok;
        } catch { answers = false; }
      }
      if (!answers) item.originalPath = null;
    }
    await db.putItem(item);
    restored += 1;
  }
  for (const a of data.annotations || []) {
    if (!a || !a.id) continue;
    a.itemId = String(a.itemId || '');
    for (const key of ['blockIndex', 'startWord', 'endWord']) {
      const n = asNumber(a[key]);
      a[key] = n == null ? 0 : n;
    }
    await db.putAnnotation(a);
  }
  for (const d of data.reading || []) {
    if (d && d.day) await db.setDay(d.day, d.seconds || 0);
  }
  return restored;
}

/* ── stats ───────────────────────────────────────────────────────────── */

export async function stats() {
  const [items, annotations, habit] = await Promise.all([
    db.allItems(), db.allAnnotations(), readingStats(),
  ]);
  const readable = items.filter((i) => i.kind !== 'product');
  return {
    total: items.length,
    toRead: readable.filter((i) => ['unread', 'reading'].includes(i.status)).length,
    finished: items.filter((i) => i.status === 'finished').length,
    marks: annotations.length,
    products: items.filter((i) => i.kind === 'product').length,
    words: items.reduce((n, i) => n + (i.wordCount || 0), 0),
    wordsRead: items.reduce((n, i) => n + (i.progressWords || 0), 0),
    todayMinutes: habit.todayMinutes,
    streakDays: habit.streakDays,
  };
}
