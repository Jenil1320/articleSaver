/* Server calls, plus the rules for what happens when the server is not there.

   Reads fall back to the local mirror. Writes are applied locally at once and queued
   for replay, so marking up an article on a train behaves exactly like doing it at a
   desk. Saving a new link is the one action that genuinely needs the network, because
   the page has to be fetched and parsed. */

import * as store from './db.js';

export const online = () => navigator.onLine;

class ApiError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra || {});
  }
}

async function call(path, { method = 'GET', body, form, timeout = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: form ? undefined : (body ? { 'Content-Type': 'application/json' } : undefined),
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!res.ok) {
      const detail = (data && data.detail) || {};
      const message = detail.message || (data && data.message) || `Request failed (${res.status})`;
      throw new ApiError(message, res.status, { recoverable: detail.recoverable });
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('That took too long and was stopped.', 0);
    if (err instanceof ApiError) throw err;
    throw new ApiError('Folio cannot reach the server.', 0, { offline: true });
  } finally {
    clearTimeout(timer);
  }
}

/* ── saving ────────────────────────────────────────────────────────── */
export const saveUrl = (url) => call('/items', { method: 'POST', body: { url } });
export const saveText = (text, title) => call('/items', { method: 'POST', body: { text, title } });
export const saveBulk = (urls) => call('/items/bulk', { method: 'POST', body: { urls } });
export const jobStatus = (id) => call(`/jobs/${id}`, { timeout: 20000 });

export function saveFile(file, title = '') {
  const form = new FormData();
  form.append('file', file);
  form.append('title', title);
  return call('/items/upload', { method: 'POST', form, timeout: 240000 });
}

/* ── reading ───────────────────────────────────────────────────────── */

/** Full item with content. Falls back to the local copy when offline. */
export async function getItem(id) {
  try {
    const item = await call(`/items/${id}`, { timeout: 25000 });
    const local = await store.getItem(id);
    // Keep any local progress that has not reached the server yet.
    if (local && (local.progress_words || 0) > (item.progress_words || 0)) {
      item.progress_words = local.progress_words;
      item.resume_words = local.resume_words || item.resume_words;
    }
    await store.putItem(item);
    await store.putAnnotations(item.annotations || []);
    store.cacheMediaFor(item);
    return item;
  } catch (err) {
    const local = await store.getItem(id);
    if (local) {
      local.annotations = (await store.annotationsFor(id)).filter((a) => !a.deleted);
      return local;
    }
    throw err;
  }
}

/* ── mutations: local first, then queued ───────────────────────────── */

async function mutate(localFn, remote) {
  await localFn();
  if (!online()) { await store.queue(remote); return { queued: true }; }
  try {
    return await call(remote.path, { method: remote.method, body: remote.body, timeout: 20000 });
  } catch (err) {
    if (err.status === 0) { await store.queue(remote); return { queued: true }; }
    throw err;
  }
}

export function patchItem(id, patch) {
  return mutate(async () => {
    const item = await store.getItem(id);
    if (item) {
      Object.assign(item, patch);
      if (patch.status === 'finished') item.progress_words = item.word_count;
      if (patch.status === 'unread') { item.progress_words = 0; item.resume_words = 0; }
      item.progress_pct = item.word_count
        ? Math.round((100 * (item.progress_words || 0)) / item.word_count) : 0;
      await store.putItem(item);
    }
  }, { path: `/items/${id}`, method: 'PATCH', body: patch });
}

export function deleteItem(id) {
  return mutate(() => store.deleteItem(id),
    { path: `/items/${id}`, method: 'DELETE' });
}

export function sendProgress(id, progressWords, resumeWords, opened = false) {
  const body = { progress_words: progressWords, resume_words: resumeWords, opened };
  return mutate(async () => {
    const item = await store.getItem(id);
    if (!item) return;
    item.progress_words = Math.max(item.progress_words || 0, progressWords || 0);
    item.resume_words = resumeWords ?? item.resume_words;
    const total = item.word_count || 0;
    item.progress_pct = total ? Math.round((100 * item.progress_words) / total) : 0;
    if (total && item.progress_words >= total * 0.95) item.status = 'finished';
    else if (item.progress_words > 0 && item.status === 'unread') item.status = 'reading';
    await store.putItem(item);
  }, { path: `/items/${id}/progress`, method: 'POST', body });
}

export function addAnnotation(itemId, ann) {
  const id = ann.id || `l${Math.random().toString(36).slice(2, 12)}`;
  const record = {
    ...ann,
    id,
    item_id: itemId,
    created_at: ann.created_at || new Date().toISOString(),
    deleted: 0,
  };
  return mutate(() => store.putAnnotation(record),
    { path: `/items/${itemId}/annotations`, method: 'POST', body: record })
    .then(() => record);
}

export function updateAnnotation(id, patch) {
  return mutate(async () => {
    const all = await store.allAnnotations();
    const found = all.find((a) => a.id === id);
    if (found) await store.putAnnotation({ ...found, ...patch });
  }, { path: `/annotations/${id}`, method: 'PATCH', body: patch });
}

export function removeAnnotation(id) {
  return mutate(() => store.deleteAnnotation(id),
    { path: `/annotations/${id}`, method: 'DELETE' });
}

/* ── settings and library metadata ─────────────────────────────────── */
export const getSettings = () => call('/settings', { timeout: 15000 });
export const putSettings = (body) => call('/settings', { method: 'POST', body, timeout: 15000 });
export const testDigest = () => call('/digest/test', { method: 'POST', timeout: 60000 });
export const renameTheme = (from, to) =>
  call('/themes/rename', { method: 'POST', body: { from, to }, timeout: 20000 });

/* ── sync ──────────────────────────────────────────────────────────── */

/** Replay queued writes, then pull everything changed since the last sync. */
export async function sync({ full = false } = {}) {
  if (!online()) return { ok: false, reason: 'offline' };

  const queued = await store.pending();
  let replayed = 0;
  for (const op of queued.sort((a, b) => a.seq - b.seq)) {
    try {
      await call(op.path, { method: op.method, body: op.body, timeout: 20000 });
      await store.dequeue(op.seq);
      replayed += 1;
    } catch (err) {
      if (err.status === 0) return { ok: false, reason: 'offline', replayed };
      // A write the server rejects (for example, an item deleted elsewhere) must not
      // block the queue forever.
      await store.dequeue(op.seq);
    }
  }

  const since = full ? '' : ((await store.getMeta('last_sync')) || '');
  let data;
  try {
    data = await call(`/sync?since=${encodeURIComponent(since)}`, { timeout: 90000 });
  } catch (err) {
    return { ok: false, reason: err.status === 0 ? 'offline' : 'error', replayed };
  }

  await store.putItems(data.items || []);
  await store.putAnnotations(data.annotations || []);
  await store.setMeta('last_sync', data.server_time);

  return { ok: true, replayed, items: (data.items || []).length };
}

/** Download every image so the whole library reads with no network. */
export async function cacheEverything(onProgress) {
  const items = await store.allItems();
  let done = 0;
  for (const item of items) {
    await store.cacheMediaFor(item);
    done += 1;
    if (onProgress) onProgress(done, items.length);
  }
  return done;
}

export { ApiError };
