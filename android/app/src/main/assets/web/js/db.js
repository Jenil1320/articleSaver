/* The library, held on the device.

   This is the whole store, not a mirror of one. There is no server to fall back to and
   nothing to sync, so a write here is the write. Everything the reader has saved —
   the text, the figures, the highlights, the progress — lives in this database and in
   the app's own file storage.

   Pictures are kept as blobs under a content hash, so the same chart saved twice costs
   the device once. */

const DB_NAME = 'folio';
const DB_VERSION = 1;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('savedAt', 'savedAt');
        s.createIndex('status', 'status');
        s.createIndex('theme', 'theme');
      }
      if (!db.objectStoreNames.contains('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' });
        s.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('reading')) db.createObjectStore('reading');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const getAll = (store, index, key) => open().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction(store, 'readonly');
  const s = t.objectStore(store);
  const r = index ? s.index(index).getAll(key) : s.getAll();
  r.onsuccess = () => resolve(r.result || []);
  r.onerror = () => reject(r.error);
}));

/* ── items ─────────────────────────────────────────────────────────── */
export const putItem = (item) => tx('items', 'readwrite', (s) => s.put(item));
export const getItem = (id) => tx('items', 'readonly', (s) => req(s.get(id)));
export const allItems = () => getAll('items');
export const deleteItem = (id) => tx('items', 'readwrite', (s) => s.delete(id));

/* ── annotations ───────────────────────────────────────────────────── */
export const putAnnotation = (a) => tx('annotations', 'readwrite', (s) => s.put(a));
export const deleteAnnotation = (id) => tx('annotations', 'readwrite', (s) => s.delete(id));
export const annotationsFor = (itemId) => getAll('annotations', 'itemId', itemId);
export const allAnnotations = () => getAll('annotations');

export const deleteAnnotationsFor = (itemId) => annotationsFor(itemId)
  .then((list) => tx('annotations', 'readwrite', (s) => list.forEach((a) => s.delete(a.id))));

/* ── key/value ─────────────────────────────────────────────────────── */
export const getMeta = (k) => tx('meta', 'readonly', (s) => req(s.get(k)));
export const setMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));

/* ── the reading log ───────────────────────────────────────────────── */
export const getDay = (day) => tx('reading', 'readonly', (s) => req(s.get(day)));
export const setDay = (day, seconds) => tx('reading', 'readwrite', (s) => s.put(seconds, day));
export const allDays = () => open().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction('reading', 'readonly');
  const s = t.objectStore('reading');
  const out = [];
  const cursor = s.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) { resolve(out); return; }
    out.push({ day: c.key, seconds: c.value });
    c.continue();
  };
  cursor.onerror = () => reject(cursor.error);
}));

/* ── pictures ──────────────────────────────────────────────────────── */

export const putMedia = (key, blob) => tx('media', 'readwrite', (s) => s.put(blob, key));
export const getMedia = (key) => tx('media', 'readonly', (s) => req(s.get(key)));
export const deleteMedia = (key) => tx('media', 'readwrite', (s) => s.delete(key));
export const mediaKeys = () => tx('media', 'readonly', (s) => req(s.getAllKeys()));

/** Content-addressed, so the same picture saved twice is stored once. */
export async function storeBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = [...new Uint8Array(digest)].slice(0, 10)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `media:${hex}`;
  const existing = await getMedia(key);
  if (!existing) await putMedia(key, blob);
  return key;
}

/**
 * Delete pictures no surviving item refers to. Called after a removal, because a
 * chart is only worth its space while something still shows it.
 */
export async function sweepMedia() {
  const [items, keys] = await Promise.all([allItems(), mediaKeys()]);
  const live = new Set();
  for (const item of items) {
    if (item.leadImage && item.leadImage.startsWith('media:')) live.add(item.leadImage);
    for (const b of item.content || []) {
      if (b.src && b.src.startsWith('media:')) live.add(b.src);
    }
  }
  let freed = 0;
  for (const key of keys) {
    if (!live.has(key)) { await deleteMedia(key); freed += 1; }
  }
  return freed;
}

export async function estimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}

export async function clearAll() {
  const db = await open();
  await Promise.all(['items', 'annotations', 'meta', 'media', 'reading'].map((name) =>
    new Promise((res) => {
      const t = db.transaction(name, 'readwrite');
      t.objectStore(name).clear();
      t.oncomplete = res;
      t.onerror = res;
    })));
}
