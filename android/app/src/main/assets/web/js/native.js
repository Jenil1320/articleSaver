/* The bridge to the Android side.

   Only four things genuinely need native code: reaching a website the page did not
   come from, receiving what another app shares, holding the screen awake, and handing
   a file to another app. Everything else — parsing, storing, reading — happens in
   the page itself. */

const N = window.FolioNative || null;

export const available = !!N;

/* ── request plumbing ────────────────────────────────────────────────── */

const waiting = new Map();
let counter = 0;

window.__folioNative = {
  on(event, json) {
    let payload;
    try { payload = JSON.parse(json); } catch { payload = { raw: json }; }

    if (event === 'resolve') {
      const entry = waiting.get(payload.requestId);
      if (!entry) return;
      waiting.delete(payload.requestId);
      clearTimeout(entry.timer);
      entry.resolve(payload);
      return;
    }
    for (const fn of listeners[event] || []) {
      try { fn(payload); } catch (err) { console.error(`${event} handler failed`, err); }
    }
  },
};

const listeners = {};

export function on(event, fn) {
  (listeners[event] = listeners[event] || []).push(fn);
}

function request(timeoutMs, start) {
  counter += 1;
  const id = `r${counter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, error: 'That took too long and was stopped.' });
    }, timeoutMs);
    waiting.set(id, { resolve, timer });
    try {
      start(id);
    } catch (err) {
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || 'The app could not start that request.' });
    }
  });
}

/* ── the network ─────────────────────────────────────────────────────── */

/**
 * Fetch a URL natively. The body lands in a file the page can then read back, so
 * a large PDF is never turned into a JavaScript string.
 */
export function fetchUrl(url, accept = '', timeoutMs = 90000, referer = '') {
  if (!N) return Promise.resolve({ ok: false, error: 'Folio is not running as an app.' });
  return request(timeoutMs, (id) => N.fetchUrl(id, url, accept, referer));
}

/**
 * Load a page in a real but invisible browser and take the document its own scripts
 * built. Slower than a plain fetch, so it is only used when the cheap path fails.
 */
export function renderUrl(url, timeoutMs = 60000) {
  if (!N) return Promise.resolve({ ok: false, error: 'Folio is not running as an app.' });
  return request(timeoutMs, (id) => N.renderUrl(id, url));
}

const CHARSET_RE = /charset=["']?([\w-]+)/i;

/** Decode a fetched body as text, honouring whatever encoding the site declared. */
export async function readText(result) {
  const buffer = await readBytes(result);
  let charset = (CHARSET_RE.exec(result.contentType || '') || [])[1];

  if (!charset) {
    // No header, so read the declaration inside the document itself.
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(buffer.slice(0, 4096));
    charset = (CHARSET_RE.exec(head) || [])[1];
  }
  const label = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

export async function readBytes(result) {
  const res = await fetch(result.url, { cache: 'no-store' });
  if (!res.ok) throw new Error('The downloaded file could not be read back.');
  return res.arrayBuffer();
}

export async function readBlob(result) {
  const res = await fetch(result.url, { cache: 'no-store' });
  if (!res.ok) throw new Error('The downloaded file could not be read back.');
  return res.blob();
}

/** Throw away a working file once its contents have been taken. */
export function release(result) {
  if (result && result.path) deleteFile(result.path);
}

/* ── files ───────────────────────────────────────────────────────────── */

export function keepOriginal(relativePath, itemId, extension) {
  if (!N) return '';
  return N.keepOriginal(relativePath, itemId, extension) || '';
}

export function openOriginal(relativePath, mime) {
  if (N) N.openOriginal(relativePath, mime || 'application/pdf');
}

export function deleteFile(relativePath) {
  if (N && relativePath) N.deleteFile(relativePath);
}

export function exportBackup(json, filename) {
  if (!N) return Promise.resolve({ ok: false, error: 'Not available.' });
  return request(60000, (id) => N.exportBackup(id, json, filename));
}

/* ── device ──────────────────────────────────────────────────────────── */

export const setChrome = (dark) => { if (N) N.setChrome(!!dark); };
export const keepAwake = (on_) => { if (N) N.keepAwake(!!on_); };
export const vibrate = (ms) => { if (N) N.vibrate(ms | 0); };
export const openExternal = (url) => {
  if (N) N.openExternal(url);
  else window.open(url, '_blank', 'noopener');
};
export const shareText = (text) => { if (N) N.shareText(text); };
export const version = () => (N ? N.version() : 'web');
