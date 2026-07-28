/* Local mirror of the library, held on the device.
   The server is the source of truth, but everything needed to read is kept here so
   the app works with no network at all. Writes made offline queue in `outbox` and
   replay in order once the server is reachable again. */

const DB_NAME = 'folio';
const DB_VERSION = 1;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('saved_at', 'saved_at');
        s.createIndex('status', 'status');
        s.createIndex('theme', 'theme');
      }
      if (!db.objectStoreNames.contains('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' });
        s.createIndex('item_id', 'item_id');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      void e;
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

/* ── items ─────────────────────────────────────────────────────────── */
export const putItem = (item) => tx('items', 'readwrite', (s) => s.put(item));

export const putItems = (items) => tx('items', 'readwrite', (s) => {
  items.forEach((i) => (i.deleted ? s.delete(i.id) : s.put(i)));
});

export const getItem = (id) => tx('items', 'readonly', (s) => req(s.get(id))).then((r) => r);

export const allItems = () => open().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction('items', 'readonly');
  const r = t.objectStore('items').getAll();
  r.onsuccess = () => resolve(r.result || []);
  r.onerror = () => reject(r.error);
}));

export const deleteItem = (id) => tx('items', 'readwrite', (s) => s.delete(id));

/* ── annotations ───────────────────────────────────────────────────── */
export const putAnnotations = (list) => tx('annotations', 'readwrite', (s) => {
  list.forEach((a) => (a.deleted ? s.delete(a.id) : s.put(a)));
});

export const putAnnotation = (a) => tx('annotations', 'readwrite', (s) => s.put(a));

export const deleteAnnotation = (id) => tx('annotations', 'readwrite', (s) => s.delete(id));

export const annotationsFor = (itemId) => open().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction('annotations', 'readonly');
  const r = t.objectStore('annotations').index('item_id').getAll(itemId);
  r.onsuccess = () => resolve(r.result || []);
  r.onerror = () => reject(r.error);
}));

export const allAnnotations = () => open().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction('annotations', 'readonly');
  const r = t.objectStore('annotations').getAll();
  r.onsuccess = () => resolve(r.result || []);
  r.onerror = () => reject(r.error);
}));

/* ── key/value ─────────────────────────────────────────────────────── */
export const getMeta = (k) => tx('meta', 'readonly', (s) => req(s.get(k))).then((r) => r);
export const setMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));

/* ── outbox ────────────────────────────────────────────────────────── */
export const queue = (op) => tx('outbox', 'readwrite', (s) => s.add({ ...op, at: Date.now() }));

export const pending = () => open().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction('outbox', 'readonly');
  const r = t.objectStore('outbox').getAll();
  r.onsuccess = () => resolve(r.result || []);
  r.onerror = () => reject(r.error);
}));

export const dequeue = (seq) => tx('outbox', 'readwrite', (s) => s.delete(seq));

/* ── media blobs ───────────────────────────────────────────────────── */
export const putMedia = (url, blob) => tx('media', 'readwrite', (s) => s.put(blob, url));
export const getMedia = (url) => tx('media', 'readonly', (s) => req(s.get(url))).then((r) => r);

export const hasMedia = (url) => getMedia(url).then((b) => !!b);

/** Pull every image an item references into local storage. */
export async function cacheMediaFor(item) {
  const urls = new Set();
  if (item.lead_image && item.lead_image.startsWith('/media/')) urls.add(item.lead_image);
  (item.content || []).forEach((b) => {
    if (b.type === 'image' && b.src && b.src.startsWith('/media/')) urls.add(b.src);
  });
  let saved = 0;
  for (const url of urls) {
    try {
      if (await hasMedia(url)) { saved += 1; continue; }
      const res = await fetch(url);
      if (!res.ok) continue;
      await putMedia(url, await res.blob());
      saved += 1;
    } catch { /* an image that will not download is not worth failing the save for */ }
  }
  return saved;
}

export async function estimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}

export async function clearAll() {
  const db = await open();
  await Promise.all(['items', 'annotations', 'meta', 'outbox', 'media'].map((name) =>
    new Promise((res) => {
      const t = db.transaction(name, 'readwrite');
      t.objectStore(name).clear();
      t.oncomplete = res;
      t.onerror = res;
    })));
}
