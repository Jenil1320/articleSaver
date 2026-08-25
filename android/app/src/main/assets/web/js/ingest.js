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
  // A plain #fragment names a heading in the same page. #! and #/ are routes:
  // on a hash-routed site the fragment is the only part that says which page
  // this is, and the browser fallback needs it to load the right one.
  if (!/^#[!/]/.test(parsed.hash)) parsed.hash = '';
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
 * What a downloaded file really is, read from its first bytes.
 *
 * Some image hosts answer with `binary/octet-stream`, and the local copy reads back
 * as octet-stream too, so neither the header nor the file could name the type and a
 * perfectly good picture was thrown away as "not a picture".
 */
async function sniffImageType(blob) {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const at = (i, ...bytes) => bytes.every((v, k) => b[i + k] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  // "ftyp" alone is the ISO container an mp4 also uses, so the brand has to say avif.
  if (at(4, 0x66, 0x74, 0x79, 0x70)
    && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
  if (at(0, 0x3c, 0x73, 0x76, 0x67) || at(0, 0x3c, 0x3f, 0x78, 0x6d)) return 'image/svg+xml';
  return '';
}

/** The stored type of a fetched picture, or '' when it is not a picture at all. */
async function imageTypeOf(result, blob) {
  const declared = mimeOf(result, blob);
  if (declared.startsWith('image/')) return declared;
  return sniffImageType(blob);
}

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

/** Storage full is the phone's condition, not the page's. Folding it into "the
    pictures could not be saved" sends the reader after the wrong culprit, so it
    stops the save with its own name. */
function quotaStop(err) {
  if (err && err.name === 'QuotaExceededError') {
    throw new Error('The phone’s storage is full, so nothing more can be saved. '
      + 'Delete some saved items to make room.');
  }
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

    // A picture embedded in the page itself: there is no host to ask, the bytes
    // are already in the address.
    if (src.startsWith('data:')) {
      try {
        const blob = await (await fetch(src)).blob();
        if (!blob.size || blob.size > MAX_IMAGE_BYTES
          || !(blob.type || '').toLowerCase().startsWith('image/')) {
          throw new Error('not a picture');
        }
        const key = await db.storeBlob(blob);
        seen.set(src, key);
        block.src = key;
        saved += 1;
      } catch (err) {
        quotaStop(err);
        console.debug('picture skipped', src.slice(0, 40), err && err.message);
        block.src = '';
      }
      continue;
    }

    // A short pause between pictures. Twenty requests in two seconds is what makes a
    // media host start refusing them, and waiting here is cheaper than backing off
    // after the refusal.
    if (saved > 0) await wait(120);

    try {
      const absolute = new URL(src, baseUrl || undefined).href;
      const res = await fetchPicture(absolute, baseUrl || '');
      try {
        if ((res.size || 0) > MAX_IMAGE_BYTES) throw new Error('larger than 6 MB');
        const blob = await native.readBlob(res);
        // The downloaded file is read back from local storage, which reports every file
        // as application/octet-stream. What the site said it sent is the answer, and
        // the blob is retyped so the reader can show it later.
        const type = await imageTypeOf(res, blob);
        if (!blob.size || !type) throw new Error('not a picture');
        const key = await db.storeBlob(new Blob([blob], { type }));
        seen.set(src, key);
        block.src = key;
        saved += 1;
      } finally {
        native.release(res);
      }
    } catch (err) {
      quotaStop(err);
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
    // The same backing off as the body pictures: the lead is often the one request
    // a media host refuses, and it is the picture the reader sees first.
    const res = await fetchPicture(lead, baseUrl || '');
    try {
      if ((res.size || 0) > MAX_IMAGE_BYTES) return null;
      const blob = await native.readBlob(res);
      const type = await imageTypeOf(res, blob);
      if (!blob.size || !type) return null;
      return await db.storeBlob(new Blob([blob], { type }));
    } finally {
      native.release(res);
    }
  } catch (err) {
    quotaStop(err);
    void warnings;
    return null;
  }
}

/* ── the common tail of every save ───────────────────────────────────── */

/** Localise the pictures, finalise the blocks and classify — for a new item or a re-read. */
async function prepare(extracted, { url = '', warnings = [], onStage = null }) {
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

  return { notes, blocks, words, plain, lead, verdict };
}

async function finish(extracted, {
  url = '', source = 'url', method = '', warnings = [], originalPath = null,
  originalMime = null, onStage = null,
}) {
  const p = await prepare(extracted, { url, warnings, onStage });

  return library.createItem({
    url,
    canonicalUrl: extracted.canonicalUrl || url,
    kind: p.verdict.kind,
    title: extracted.title || 'Untitled',
    byline: extracted.byline || '',
    siteName: extracted.siteName || '',
    publishedAt: extracted.publishedAt || null,
    excerpt: extracted.excerpt || excerptFrom(p.blocks),
    leadImage: p.lead,
    wordCount: p.words,
    content: p.blocks,
    textPlain: p.plain,
    theme: p.verdict.theme,
    themeOptions: p.verdict.themeOptions,
    source,
    extractMethod: method,
    originalPath,
    originalMime,
    warnings: p.notes,
    pageCount: extracted.pageCount || 0,
  });
}

/* ── from a link ─────────────────────────────────────────────────────── */

/**
 * Fetch a URL and extract whatever it turns out to be. Shared by a first save and
 * by a re-read of an already saved item.
 *
 * Returns { data, method, pdfPath } — pdfPath is set when the link served a PDF,
 * so the caller can keep the original file.
 */
const X_ARTICLE_MESSAGE = 'That is a direct X Article link, which X only shows to '
  + 'signed-in readers. Share the post that announced the article instead — its '
  + 'x.com/…/status/… link — and Folio can save the whole article from there.';

/**
 * The destination a page names in a meta refresh, if any. t.co answers a normal
 * GET with HTTP 200 and a tiny interstitial — the real address only appears in a
 * <meta http-equiv="refresh"> inside <noscript> — so an HTTP-level redirect
 * follower never sees it.
 */
function metaRefreshTarget(html, baseUrl) {
  const head = (html || '').slice(0, 4000);
  const tag = /<meta[^>]*refresh[^>]*>/i.exec(head);
  if (!tag) return '';
  const m = /url\s*=\s*["']?([^"'>\s;]+)/i.exec(tag[0]);
  if (!m) return '';
  try {
    return new URL(m[1].replace(/&amp;/g, '&'), baseUrl || undefined).href;
  } catch {
    return '';
  }
}

async function extractFromWeb(url, warnings, onStage) {
  if (social.isTweet(url)) {
    if (onStage) onStage('fetching');
    return { data: await social.extractTweet(url), method: 'tweet', pdfPath: null };
  }
  if (social.isXArticle(url)) throw new Error(X_ARTICLE_MESSAGE);

  let fetched = await fetchDocument(url, { onStage });
  warnings.push(...fetched.warnings);

  // One hop through a meta refresh, so a shortened link resolves to what it
  // actually points at rather than to the shortener's interstitial page. A page
  // naming its own address — live pages reload themselves this way — is not a
  // redirect, and finalUrl is the address to compare against: after an HTTP
  // redirect it is no longer the url that was asked for.
  if (fetched.kind === 'html') {
    const target = metaRefreshTarget(fetched.text, fetched.finalUrl);
    if (target && target !== url && target !== fetched.finalUrl) {
      if (social.isTweet(target)) {
        if (onStage) onStage('fetching');
        return { data: await social.extractTweet(target), method: 'refresh+tweet', pdfPath: null };
      }
      if (social.isXArticle(target)) throw new Error(X_ARTICLE_MESSAGE);
      const hop = await fetchDocument(target, { onStage });
      warnings.push(...hop.warnings);
      fetched = hop;
    }
  }

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
    return { data, method: fetched.method, pdfPath: fetched.path };
  }

  // A shortened address — t.co and friends — only shows what it points at after
  // the redirect. A post saved by its short link used to fall through to page
  // scraping and keep the bare address as its title.
  if (social.isTweet(fetched.finalUrl || '')) {
    if (onStage) onStage('fetching');
    return {
      data: await social.extractTweet(fetched.finalUrl),
      method: `${fetched.method}+tweet`,
      pdfPath: null,
    };
  }
  if (social.isXArticle(fetched.finalUrl || '')) throw new Error(X_ARTICLE_MESSAGE);

  if (social.isLinkedInPost(url)) {
    try {
      return {
        data: social.extractLinkedIn(fetched.text, fetched.finalUrl),
        method: `${fetched.method}+linkedin`,
        pdfPath: null,
      };
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

  return { data, method: fetched.method, pdfPath: null };
}

export async function fromUrl(rawUrl, { onStage = null } = {}) {
  const url = normaliseUrl(rawUrl);

  const existing = await library.findByUrl(url);
  if (existing) return { item: library.decorate(existing), duplicate: true };

  const warnings = [];
  const got = await extractFromWeb(url, warnings, onStage);
  const item = await finish(got.data, {
    url, source: 'url', method: got.method, warnings, onStage,
  });

  if (got.pdfPath) {
    // The original is kept so it can be reopened in a PDF viewer.
    const stored = native.keepOriginal(got.pdfPath, item.id, '.pdf');
    if (stored) {
      await library.updateItemRaw(item.id, { originalPath: stored, originalMime: 'application/pdf' });
      item.originalPath = stored;
    }
  }
  return { item, duplicate: false };
}

/* ── reading a saved item in again ───────────────────────────────────── */

/**
 * Re-run the reader over an already saved item, in place. The item keeps its
 * identity — id, saved date, status, progress, favourite, a theme the reader chose
 * by hand — and its marks are re-attached wherever their quoted text still exists.
 *
 * The stored original PDF is preferred over the network: it is the exact document,
 * and it works offline.
 */
export async function refreshItem(id, { onStage = null } = {}) {
  const raw = await db.getItem(id);
  if (!raw) throw new Error('That item is no longer here.');

  const warnings = [];
  let data = null;
  let method = '';

  if (raw.originalPath && /pdf/i.test(raw.originalMime || 'application/pdf') && native.available) {
    try {
      if (onStage) onStage('reading');
      const res = await fetch(native.fileUrl(raw.originalPath), { cache: 'no-store' });
      if (res.ok) {
        const { extract } = await pdfExtract();
        data = await extract(await res.arrayBuffer(), {
          url: raw.url || '',
          filename: `${raw.title || 'document'}.pdf`,
          onProgress: (p) => { if (onStage) onStage(p.stage, p); },
        });
        method = 'reread+original';
      }
    } catch {
      data = null;   // fall back to the network below
    }
  }

  if (!data) {
    const source = raw.url || raw.canonicalUrl;
    if (!source) {
      throw new Error('This was pasted in, so there is no source to read it from again.');
    }
    const got = await extractFromWeb(source, warnings, onStage);
    data = got.data;
    method = `reread+${got.method}`;
    if (got.pdfPath) {
      if (raw.originalPath) native.deleteFile(got.pdfPath);
      else {
        const stored = native.keepOriginal(got.pdfPath, raw.id, '.pdf');
        if (stored) {
          await library.updateItemRaw(raw.id, {
            originalPath: stored, originalMime: 'application/pdf',
          });
        }
      }
    }
  }

  const p = await prepare(data, { url: raw.url || '', warnings, onStage });

  // A page that has since gone behind a login would replace a good saved copy
  // with a stub. Keeping what we have is always the better trade.
  if (p.words < 50 && (raw.wordCount || 0) > 300) {
    throw new Error('The source now returns almost nothing, so the saved copy was kept.');
  }

  return library.applyRefresh(id, {
    title: data.title,
    byline: data.byline,
    siteName: data.siteName,
    publishedAt: data.publishedAt,
    canonicalUrl: data.canonicalUrl,
    excerpt: data.excerpt || excerptFrom(p.blocks),
    leadImage: p.lead,
    content: p.blocks,
    wordCount: p.words,
    textPlain: p.plain,
    pageCount: data.pageCount || 0,
    verdict: p.verdict,
    method,
    warnings: p.notes,
  });
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
