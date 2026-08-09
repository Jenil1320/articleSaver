/* Turn a link, a file or pasted text into a saved item.

   Pictures are copied into the device's own storage at save time. A reader that still
   points at the original host is not offline: the words would come from the phone and
   the pictures would not. */

import * as db from './db.js';
import * as native from './native.js';
import * as library from './library.js';
import { analyse } from './extract/classify.js';
import { excerptFrom, finalise, makeBlock } from './extract/blocks.js';
import { fetchDocument, renderInstead } from './extract/fetch.js';
import * as htmlExtract from './extract/html.js';
import * as social from './extract/social.js';

const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Load the PDF reader only when a PDF actually turns up. */
const pdfExtract = () => import('./extract/pdf.js');

export function normaliseUrl(raw) {
  let url = (raw || '').trim();
  if (!url) throw new Error('No link was given.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, '')}`;

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`“${raw}” is not a valid link.`); }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    throw new Error(`“${raw}” is not a valid link.`);
  }

  // Strip the tracking parameters that arrive with shared links.
  const drop = (key) => key.startsWith('utm_') || key.startsWith('mc_')
    || ['fbclid', 'gclid', 'igshid', 'rcm', 'originaltracking', 'ref', 'ref_src', 'share', 'si']
      .includes(key);
  for (const key of [...parsed.searchParams.keys()]) {
    if (drop(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  return parsed.toString();
}

/* ── pictures ────────────────────────────────────────────────────────── */

/** What a fetched file really is, preferring the server's word over the local file's. */
function mimeOf(result, blob) {
  const declared = (result.contentType || '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  const local = (blob.type || '').toLowerCase();
  return local === 'application/octet-stream' ? '' : local;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one picture, backing off when the host asks us to.
 *
 * An article can reference twenty images, and a media host reasonably reads twenty
 * requests in two seconds as impolite: Wikimedia answers 429 to about a third of
 * them. Waiting and asking again costs a moment and saves the picture.
 */
async function fetchPicture(url, referer) {
  let waitMs = 700;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await native.fetchUrl(url, 'image/*', 30000, referer);
    if (res.ok) return res;
    if (res.status !== 429 && res.status !== 503) {
      throw new Error(res.error || `HTTP ${res.status || 0}`);
    }
    await wait(waitMs);
    waitMs *= 2;
  }
  throw new Error('the picture host kept asking us to slow down');
}

/** Download referenced pictures and repoint the blocks at the local copies. */
async function localiseImages(blocks, baseUrl, warnings) {
  const seen = new Map();
  let saved = 0;

  for (const block of blocks) {
    if (block.type !== 'image') continue;

    // Figures rendered out of a PDF arrive as blobs rather than as a URL.
    if (block.blob) {
      block.src = await db.storeBlob(block.blob);
      block.figure = true;
      delete block.blob;
      delete block.imageType;
      saved += 1;
      continue;
    }

    const src = block.src || '';
    if (!src || src.startsWith('media:')) continue;
    if (seen.has(src)) { block.src = seen.get(src); continue; }
    if (saved >= MAX_IMAGES) { block.src = ''; continue; }

    // A short pause between pictures. Twenty requests in two seconds is what makes a
    // media host start refusing them, and waiting here is cheaper than backing off
    // after the refusal.
    if (saved > 0) await wait(120);

    try {
      const absolute = new URL(src, baseUrl || undefined).href;
      const res = await fetchPicture(absolute, baseUrl || '');
      if ((res.size || 0) > MAX_IMAGE_BYTES) throw new Error('larger than 6 MB');
      const blob = await native.readBlob(res);
      native.release(res);
      // The downloaded file is read back from local storage, which reports every file
      // as application/octet-stream. What the site said it sent is the answer, and
      // the blob is retyped so the reader can show it later.
      const type = mimeOf(res, blob);
      if (!blob.size || !type.startsWith('image/')) throw new Error('not a picture');
      const key = await db.storeBlob(new Blob([blob], { type }));
      seen.set(src, key);
      block.src = key;
      saved += 1;
    } catch (err) {
      // Left in on purpose: when a site's pictures do not come through, this is the
      // only way to find out which ones and why.
      console.debug('picture skipped', src, err && err.message);
      block.src = '';   // the reader skips pictures with no source
    }
  }

  const dropped = blocks.filter((b) => b.type === 'image' && !b.src).length;
  if (dropped) warnings.push(`${dropped} picture(s) could not be saved for offline reading.`);
}

async function localiseLead(lead, warnings, baseUrl = '') {
  if (!lead || lead.startsWith('media:')) return lead || null;
  try {
    const res = await native.fetchUrl(lead, 'image/*', 25000, baseUrl);
    if (!res.ok || (res.size || 0) > MAX_IMAGE_BYTES) return null;
    const blob = await native.readBlob(res);
    native.release(res);
    const type = mimeOf(res, blob);
    if (!blob.size || !type.startsWith('image/')) return null;
    return await db.storeBlob(new Blob([blob], { type }));
  } catch {
    void warnings;
    return null;
  }
}

/* ── the common tail of every save ───────────────────────────────────── */

async function finish(extracted, {
  url = '', source = 'url', method = '', warnings = [], originalPath = null,
  originalMime = null, onStage = null,
}) {
  const notes = [...warnings, ...(extracted.warnings || [])];
  if (onStage) onStage('pictures');

  const base = extracted.canonicalUrl || url || '';
  await localiseImages(extracted.content || [], base, notes);
  const { blocks, words, plain } = finalise(extracted.content || []);
  const lead = await localiseLead(extracted.leadImage, notes, base);

  if (onStage) onStage('filing');
  const verdict = analyse({
    url: base,
    title: extracted.title || '',
    blocks,
    wordCount: words,
    textPlain: plain,
    signals: extracted.signals,
    kindHint: extracted.kindHint || '',
    pageCount: extracted.pageCount || 0,
  });

  return library.createItem({
    url,
    canonicalUrl: extracted.canonicalUrl || url,
    kind: verdict.kind,
    title: extracted.title || 'Untitled',
    byline: extracted.byline || '',
    siteName: extracted.siteName || '',
    publishedAt: extracted.publishedAt || null,
    excerpt: extracted.excerpt || excerptFrom(blocks),
    leadImage: lead,
    wordCount: words,
    content: blocks,
    textPlain: plain,
    theme: verdict.theme,
    themeOptions: verdict.themeOptions,
    source,
    extractMethod: method,
    originalPath,
    originalMime,
    warnings: notes,
    pageCount: extracted.pageCount || 0,
  });
}

/* ── from a link ─────────────────────────────────────────────────────── */

export async function fromUrl(rawUrl, { onStage = null } = {}) {
  const url = normaliseUrl(rawUrl);

  const existing = await library.findByUrl(url);
  if (existing) return { item: library.decorate(existing), duplicate: true };

  const warnings = [];

  if (social.isTweet(url)) {
    if (onStage) onStage('fetching');
    const data = await social.extractTweet(url);
    const item = await finish(data, { url, source: 'url', method: 'oembed', warnings, onStage });
    return { item, duplicate: false };
  }

  const fetched = await fetchDocument(url, { onStage });
  warnings.push(...fetched.warnings);

  if (fetched.kind === 'pdf') {
    if (onStage) onStage('reading');
    const filename = (() => {
      try { return new URL(fetched.finalUrl).pathname.split('/').pop() || 'document.pdf'; }
      catch { return 'document.pdf'; }
    })();
    const { extract } = await pdfExtract();
    const data = await extract(fetched.bytes, {
      url: fetched.finalUrl,
      filename,
      onProgress: (p) => { if (onStage) onStage(p.stage, p); },
    });
    const item = await finish(data, {
      url, source: 'url', method: fetched.method, warnings, onStage,
    });
    // The original is kept so it can be reopened in a PDF viewer.
    const stored = native.keepOriginal(fetched.path, item.id, '.pdf');
    if (stored) {
      await library.updateItemRaw(item.id, { originalPath: stored, originalMime: 'application/pdf' });
      item.originalPath = stored;
    }
    return { item, duplicate: false };
  }

  if (social.isLinkedInPost(url)) {
    try {
      const data = social.extractLinkedIn(fetched.text, fetched.finalUrl);
      const item = await finish(data, {
        url, source: 'url', method: `${fetched.method}+linkedin`, warnings, onStage,
      });
      return { item, duplicate: false };
    } catch (err) {
      warnings.push(err.message);
    }
  }

  if (onStage) onStage('reading');
  let data = htmlExtract.extract(fetched.text, fetched.finalUrl);

  // Almost nothing came out. The page probably builds itself with scripts, so give
  // it a real browser before telling the reader it cannot be saved.
  if (data.wordCount < 60 && fetched.method.startsWith('http')) {
    if (onStage) onStage('rendering');
    const again = await renderInstead(url, warnings);
    if (again) {
      const better = htmlExtract.extract(again.text, again.finalUrl);
      if (better.wordCount > data.wordCount) data = better;
    }
  }
  if (data.wordCount < 25) {
    warnings.push('Very little text was found. The page may need a login.');
  }

  const item = await finish(data, {
    url, source: 'url', method: `${fetched.method}`, warnings, onStage,
  });
  return { item, duplicate: false };
}

/* ── from a file ─────────────────────────────────────────────────────── */

export async function fromFile(blob, filename, { onStage = null, nativePath = null } = {}) {
  const name = (filename || 'file').split('/').pop();
  const lower = name.toLowerCase();
  const warnings = [];

  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  const isPdf = lower.endsWith('.pdf')
    || (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46);

  if (isPdf) {
    if (onStage) onStage('reading');
    const { extract } = await pdfExtract();
    const data = await extract(await blob.arrayBuffer(), {
      url: '',
      filename: name,
      onProgress: (p) => { if (onStage) onStage(p.stage, p); },
    });
    const item = await finish(data, {
      url: '', source: 'file', method: 'file+pdf', warnings, onStage,
    });
    if (nativePath) {
      const stored = native.keepOriginal(nativePath, item.id, '.pdf');
      if (stored) {
        await library.updateItemRaw(item.id, {
          originalPath: stored, originalMime: 'application/pdf',
        });
        item.originalPath = stored;
      }
    }
    return { item, duplicate: false };
  }

  const text = await blob.text();

  if (/\.(html?|mhtml)$/.test(lower)) {
    if (onStage) onStage('reading');
    const data = htmlExtract.extract(text, '');
    if (!data.title) data.title = name.replace(/\.[^.]*$/, '');
    const item = await finish(data, {
      url: '', source: 'file', method: 'file+html', warnings, onStage,
    });
    return { item, duplicate: false };
  }

  if (/\.(txt|md|markdown|text)$/.test(lower) || !lower.includes('.')) {
    return fromText(text, { title: name.replace(/\.[^.]*$/, ''), source: 'file', onStage });
  }

  throw new Error('Folio can open PDF, HTML, Markdown and plain text files.');
}

/* ── from pasted text ────────────────────────────────────────────────── */

export async function fromText(text, { title = '', url = '', source = 'paste', onStage = null } = {}) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks = [];
  let buf = [];

  const flush = () => {
    if (buf.length) {
      blocks.push(makeBlock('p', buf.join(' ').split(/\s+/).filter(Boolean).join(' ')));
      buf = [];
    }
  };

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { flush(); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(stripped);
    if (heading) {
      flush();
      blocks.push(makeBlock(`h${Math.min(heading[1].length, 4)}`, heading[2].trim()));
      continue;
    }
    const bullet = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(stripped);
    if (bullet) {
      flush();
      blocks.push(makeBlock('li', bullet[2].trim()));
      continue;
    }
    buf.push(stripped);
  }
  flush();

  if (!blocks.length) throw new Error('There was no text to save.');

  const finalised = finalise(blocks);
  let heading = title;
  if (!heading) {
    const first = finalised.blocks.find((b) => b.text)?.text || 'Note';
    heading = first.slice(0, 90) + (first.length > 90 ? '…' : '');
  }

  const item = await finish({
    title: heading,
    byline: '',
    siteName: source === 'file' ? 'File' : 'Pasted',
    publishedAt: null,
    leadImage: null,
    canonicalUrl: url,
    content: finalised.blocks,
    wordCount: finalised.words,
    textPlain: finalised.plain,
    excerpt: excerptFrom(finalised.blocks),
    kindHint: 'text',
    signals: { ldTypes: [], ogType: '', description: '' },
  }, { url, source, method: 'text', warnings: [], onStage });

  return { item, duplicate: false };
}
