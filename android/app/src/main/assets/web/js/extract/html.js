/* Readable-article extraction from HTML.

   A scoring pass in the spirit of Readability: find the subtree that holds the prose,
   throw away chrome, then flatten what survives into normalised blocks.

   This runs inside the app on the phone. The page arrives through the native fetch,
   is parsed here, and never leaves the device. */

import { excerptFrom, finalise, makeBlock } from './blocks.js';

// Elements that never contain the article.
const STRIP_TAGS = ('script style noscript svg canvas form button input select textarea '
  + 'nav footer header aside iframe object embed video audio map area link meta').split(' ');

// Class and id substrings that mark site chrome.
const NEGATIVE_RE = new RegExp(
  '(^|[-_ ])(comment|share|social|promo|banner|advert|advertisement|sponsor|'
  + 'sidebar|widget|related|recommend|newsletter|subscribe|signup|popup|modal|'
  + 'cookie|consent|nav|menu|breadcrumb|pagination|footer|masthead|toolbar|'
  + 'metadata|byline|author-bio|tags|meta-tags|skip|screen-reader|sr-only|'
  + 'hidden|disqus|utility|toc|table-of-contents|paywall|subnav|site-header)', 'i');

const POSITIVE_RE = new RegExp(
  '(^|[-_ ])(article|post|entry|content|main|body|story|text|prose|markdown|'
  + 'blog|page-content|rich-text|readme)', 'i');

const BLOCK_LEVEL = {
  p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4',
  blockquote: 'quote', pre: 'code', li: 'li', figure: 'figure',
  hr: 'hr', img: 'image', table: 'table',
};

const squash = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');
const textOf = (el) => squash(el ? el.textContent : '');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function absolute(base, href) {
  try { return new URL(href, base).href; } catch { return href; }
}

/** lxml's `.text`: whatever sits before the first child element. */
function leadingText(el) {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) break;
    if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
  }
  return out;
}

/* ---------------------------------------------------------------- metadata */

function meta(doc, ...names) {
  for (const name of names) {
    for (const attr of ['property', 'name', 'itemprop']) {
      const el = doc.querySelector(`meta[${attr}="${CSS.escape(name)}"]`);
      if (el) {
        const v = (el.getAttribute('content') || '').trim();
        if (v) return v;
      }
    }
  }
  return '';
}

function ldJson(doc) {
  const out = [];
  for (const el of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = (el.textContent || '').trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      out.push(...(Array.isArray(data) ? data : [data]));
    } catch {
      // A malformed block is common and never fatal; the page still reads.
    }
  }
  // Unwrap @graph containers.
  const flat = [];
  for (const d of out) {
    if (d && Array.isArray(d['@graph'])) flat.push(...d['@graph'].filter((x) => x && typeof x === 'object'));
    else if (d && typeof d === 'object') flat.push(d);
  }
  return flat;
}

function firstStr(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.length ? firstStr(value[0]) : '';
  if (value && typeof value === 'object') return firstStr(value.name || value['@id'] || '');
  return '';
}

export function extractMetadata(doc, url) {
  const ld = ldJson(doc);
  const art = ld.find((d) => [
    'article', 'newsarticle', 'blogposting', 'report', 'scholarlyarticle',
    'techarticle', 'socialmediaposting', 'webpage',
  ].includes(firstStr(d['@type']).toLowerCase())) || {};

  const fromOpenGraph = meta(doc, 'og:title', 'twitter:title');
  let title = fromOpenGraph
    || firstStr(art.headline)
    || (doc.querySelector('title')?.textContent || '').trim();

  let site = meta(doc, 'og:site_name') || firstStr(art.publisher);

  // Sites append their own name to the headline — "Grid energy storage - Wikipedia".
  // Wikipedia does it in og:title too, so the trim cannot be limited to the <title>
  // tag. It stays safe by only cutting a tail that is the publisher's own name, and
  // only when a real headline is left behind.
  if (title) {
    let hostLabel = '';
    try {
      const parts_ = new URL(url).hostname.replace(/^www\./, '').split('.');
      hostLabel = parts_.length > 1 ? parts_[parts_.length - 2] : parts_[0];
    } catch { hostLabel = ''; }

    for (const name of [site, hostLabel].filter((n) => n && n.length > 2)) {
      const re = new RegExp(`\\s*[|\\u2013\\u2014:-]\\s*${escapeRe(name)}\\s*$`, 'i');
      if (!re.test(title)) continue;
      const trimmed = title.replace(re, '').trim();
      if (trimmed.length >= 4) { title = trimmed; break; }
    }
  }

  let byline = meta(doc, 'author', 'article:author', 'twitter:creator') || firstStr(art.author);
  if (byline.startsWith('http')) byline = '';
  if (!byline) {
    for (const sel of ['[rel="author"]', '[class*="author-name"]', '[class*="byline"]', '[itemprop="author"]']) {
      const found = doc.querySelector(sel);
      if (found) {
        byline = textOf(found).slice(0, 120);
        if (byline) break;
      }
    }
  }
  byline = byline.replace(/^[Bb]y\s+/, '').trim();

  let published = meta(doc, 'article:published_time', 'datePublished', 'publishdate', 'og:updated_time')
    || firstStr(art.datePublished);
  if (!published) {
    const t = doc.querySelector('time[datetime]');
    if (t) published = (t.getAttribute('datetime') || '').trim();
  }

  let image = meta(doc, 'og:image', 'twitter:image');
  if (image) image = absolute(url, image);

  if (!site) {
    try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { site = ''; }
  }

  return {
    title: title.trim(),
    byline: byline.trim(),
    siteName: site.trim(),
    publishedAt: published.trim() || null,
    leadImage: image || null,
    ldTypes: ld.map((d) => firstStr(d['@type'])).filter(Boolean),
    ogType: meta(doc, 'og:type'),
    description: meta(doc, 'og:description', 'description', 'twitter:description'),
  };
}

/* ---------------------------------------------------------------- scoring */

function cleanTree(doc) {
  for (const tag of STRIP_TAGS) {
    // Images are handled separately, and link/meta are metadata rather than chrome.
    if (['img', 'link', 'meta'].includes(tag)) continue;
    for (const el of [...doc.querySelectorAll(tag)]) el.remove();
  }
  // Landmarks say what a region is for. A site that labels its own navigation and
  // sidebars is telling us exactly which parts are not the article.
  for (const el of [...doc.querySelectorAll(
    '[role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"], '
    + '[role="search"], [role="menu"], [role="menubar"], [role="tablist"], [role="dialog"]')]) {
    el.remove();
  }
  // Elements explicitly hidden from users are not article text.
  for (const el of [...doc.querySelectorAll('[aria-hidden="true"], [style*="display:none"], [style*="display: none"], [hidden]')]) {
    el.remove();
  }
}

function scoreNode(el) {
  const text = el.textContent || '';
  const length = text.trim().length;
  if (length < 25) return 0;

  let score = 1;
  score += (text.split(',').length - 1) + (text.split('،').length - 1);
  score += Math.min(length / 100, 12);

  const sig = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
  if (NEGATIVE_RE.test(sig)) score -= 25;
  if (POSITIVE_RE.test(sig)) score += 12;

  const tag = el.tagName.toLowerCase();
  if (tag === 'article') score += 30;
  if (tag === 'main') score += 18;
  if (el.getAttribute('role') === 'main') score += 15;

  // Link-dense blocks are navigation, not prose.
  let linkText = 0;
  for (const a of el.querySelectorAll('a')) linkText += (a.textContent || '').length;
  const density = linkText / Math.max(length, 1);
  if (density > 0.5) score -= 20 * density;

  // Reward real paragraphs over div soup.
  let solid = 0;
  for (const p of el.querySelectorAll('p')) {
    if ((p.textContent || '').trim().length > 60) solid += 1;
  }
  score += 3 * solid;
  return score;
}

export function findContentRoot(doc) {
  const candidates = doc.querySelectorAll('article, main, [role="main"], div, section, td[class]');
  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    const s = scoreNode(el);
    if (s > bestScore) { best = el; bestScore = s; }
  }
  // A parent that scores nearly as well but holds more is usually the true container.
  if (best) {
    let parent = best.parentElement;
    while (parent && !['body', 'html'].includes(parent.tagName.toLowerCase())) {
      const ps = scoreNode(parent);
      if (ps > bestScore * 1.15) {
        best = parent;
        bestScore = ps;
        parent = parent.parentElement;
      } else break;
    }
  }
  return best || doc.body;
}

/* ---------------------------------------------------------------- flattening */

const BOILERPLATE = new Set([
  'share', 'share this', 'tweet', 'advertisement', 'related', 'related posts',
  'read more', 'continue reading', 'subscribe', 'sign up', 'newsletter',
  'comments', 'leave a comment', 'table of contents', 'contents', 'menu',
  'skip to content', 'cookie policy', 'accept all cookies', 'previous', 'next',
]);

function isBoilerplate(text) {
  const t = text.trim().toLowerCase();
  if (t.length < 3) return true;
  return BOILERPLATE.has(t);
}

const CONTAINERS = new Set(['ul', 'ol', 'div', 'section', 'article', 'main', 'body', 'dl',
  'figcaption', 'header', 'span', 'tbody', 'thead', 'tr', 'td', 'th']);
const OWN_TEXT_CONTAINERS = new Set(['div', 'section', 'article', 'main', 'body']);
const NESTING_CHILDREN = new Set(['p', 'ul', 'ol', 'div', 'blockquote', 'figure', 'pre', 'table']);

/** Walk the chosen subtree in document order and emit normalised blocks. */
export function flatten(root, baseUrl, dropTitle = '') {
  const blocks = [];
  const seen = new Set();
  const normTitle = squash(dropTitle).toLowerCase();

  function emit(type, text = '', extra = {}) {
    if (['p', 'li', 'quote', 'h1', 'h2', 'h3', 'h4'].includes(type)) {
      if (isBoilerplate(text)) return;
      const key = text.toLowerCase().slice(0, 180);
      if (seen.has(key)) return;
      seen.add(key);
      // The page title is rendered separately in the reader header.
      if (type.startsWith('h') && squash(text).toLowerCase() === normTitle) return;
    }
    blocks.push(makeBlock(type, text, extra));
  }

  function walk(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = el.tagName.toLowerCase();

    if (CONTAINERS.has(tag)) {
      // Container: recurse, but capture stray text that has no element of its own.
      if (OWN_TEXT_CONTAINERS.has(tag)) {
        const own = leadingText(el).trim();
        if (own.length > 60) emit('p', squash(own));
      }
      for (const child of el.children) walk(child);
      return;
    }

    if (tag === 'img') {
      const src = el.getAttribute('src') || el.getAttribute('data-src')
        || el.getAttribute('data-original') || '';
      if (src && !src.startsWith('data:')) {
        emit('image', (el.getAttribute('alt') || '').trim(), { src: absolute(baseUrl, src) });
      }
      return;
    }

    if (tag === 'figure') {
      const img = el.querySelector('img');
      const cap = el.querySelector('figcaption');
      const src = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      const caption = cap ? textOf(cap) : '';
      if (src && !src.startsWith('data:')) emit('image', caption, { src: absolute(baseUrl, src) });
      else if (caption) emit('p', caption);
      return;
    }

    if (tag === 'pre') {
      const code = el.textContent || '';
      if (code.trim()) blocks.push(makeBlock('code', code.replace(/\s+$/, '')));
      return;
    }

    if (tag === 'table') {
      const rows = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll(':scope > td, :scope > th')].map(textOf);
        if (cells.some(Boolean)) rows.push(cells);
      }
      if (rows.length) blocks.push(makeBlock('table', '', { rows }));
      return;
    }

    if (tag === 'hr') { emit('hr'); return; }

    if (BLOCK_LEVEL[tag]) {
      const type = BLOCK_LEVEL[tag];
      // A list item or paragraph that itself wraps block content: recurse instead.
      const nested = [...el.children].some((c) => NESTING_CHILDREN.has(c.tagName.toLowerCase()));
      if (nested) {
        const own = leadingText(el).trim();
        if (own) emit(type, squash(own));
        for (const child of el.children) walk(child);
        return;
      }
      emit(type, textOf(el));
      return;
    }

    // Anything else: descend.
    for (const child of el.children) walk(child);
  }

  walk(root);
  return blocks;
}

/* ---------------------------------------------------------------- entry point */

export function extract(htmlText, url) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  const info = extractMetadata(doc, url);

  let canonical = url;
  const link = doc.querySelector('link[rel="canonical"]');
  if (link && link.getAttribute('href')) canonical = absolute(url, link.getAttribute('href'));

  cleanTree(doc);
  const root = findContentRoot(doc);
  let { blocks, words, plain } = finalise(root ? flatten(root, url, info.title) : []);

  // If scoring produced almost nothing, fall back to every paragraph on the page.
  if (words < 60) {
    const doc2 = parser.parseFromString(htmlText, 'text/html');
    cleanTree(doc2);
    if (doc2.body) {
      const fb = finalise(flatten(doc2.body, url, info.title));
      if (fb.words > words) ({ blocks, words, plain } = fb);
    }
  }

  return {
    title: info.title,
    byline: info.byline,
    siteName: info.siteName,
    publishedAt: info.publishedAt,
    leadImage: info.leadImage,
    canonicalUrl: canonical,
    content: blocks,
    wordCount: words,
    textPlain: plain,
    excerpt: excerptFrom(blocks) || info.description,
    signals: { ldTypes: info.ldTypes, ogType: info.ogType, description: info.description },
  };
}
