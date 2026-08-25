/* Readable-article extraction from HTML.

   A scoring pass in the spirit of Readability: find the subtree that holds the prose,
   throw away chrome, then flatten what survives into normalised blocks.

   Three passes, in this order, because each needs what the one before it produced:

     1. clean    — remove what is unambiguously not the article: scripts, chrome,
                   hidden elements, advertising units, comment threads.
     2. flatten  — walk the winning subtree and emit blocks, keeping the structure the
                   author wrote: heading levels, list numbering and nesting, line
                   breaks, quotations, tables, pictures, and the marks inside a
                   paragraph.
     3. sift     — judge the flat list, where the shape of the document is finally
                   visible, and separate the publisher's furniture from the prose.

   The split matters. Cleaning cannot tell a related-story rail from a paragraph,
   because in the markup they look alike; only once the blocks are in a row is it clear
   that one of them sits past the end of the article. And sifting cannot be trusted to
   delete, so it drops only what it is certain of and marks the rest as an aside for
   the reader to open.

   This runs inside the app on the phone. The page arrives through the native fetch,
   is parsed here, and never leaves the device. */

import { excerptFrom, finalise, makeBlock } from './blocks.js';
import { BLOCKISH, inlineFrom } from './inline.js';
import { sift } from './boilerplate.js';

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

// Advertising, spelled out. NEGATIVE_RE only lowers a score; anything matching this
// is removed outright, because an advert that survives scoring brings its pictures
// with it into the saved article.
const AD_RE = new RegExp(
  '(^|[-_ ])(ad|ads|advert|adverts|advertisement|advertising|adsense|adslot|'
  + 'ad-slot|ad-wrapper|ad-container|ad-banner|sponsor|sponsors|sponsored|'
  + 'sponsorship|promo|promoted|taboola|outbrain|mgid|revcontent|dianomi|'
  + 'zergnet|doubleclick|googlead|dfp|gpt-ad|paid-content|partner-content|'
  + 'commercial-unit)([-_ 0-9]|$)', 'i');

// Hosts and paths that serve adverts and tracking beacons rather than pictures
// that belong to the article.
const AD_SRC_RE = new RegExp(
  '(doubleclick\\.net|googlesyndication|googleadservices|adsystem|adservice|'
  + 'adserver|adsafeprotected|amazon-adsystem|taboola|outbrain|criteo|moatads|'
  + 'scorecardresearch|quantserve|chartbeat|zedo|adroll|smartadserver|'
  + 'teads\\.tv|/ads?/|[?&]utm_campaign=ads?([&#]|$)|1x1\\.(gif|png)|pixel\\.(gif|png)|'
  + 'spacer\\.(gif|png)|blank\\.(gif|png)|transparent\\.(gif|png))', 'i');

// Containers whose pictures are site furniture, not the article's own figures:
// related-story strips, newsletter cards, share bars, author boxes. Bare "widget"
// is deliberately absent — page builders wrap the article's own images in
// "*-widget-image" classes — only the furniture compounds are listed.
const NOISE_IMAGE_RE = new RegExp(
  '(^|[-_ ])(related|recommend|recommended|recommendation|newsletter|subscribe|'
  + 'signup|sidebar|widget-area|sidebar-widget|footer-widget|popup|modal|share|'
  + 'social|author-bio|avatar|profile-pic|comment|footer-)([-_ 0-9]|$)', 'i');

// Comment threads, named as such by the platforms that host them. Removed outright,
// behind a guard: a page whose comments hold most of its words is a discussion
// thread, and taking them would leave nothing to read.
const COMMENT_SELECTOR = '#comments, #disqus_thread, #respond, #comment-list, '
  + '.comments-area, .comment-list, .comments-wrapper, .comment-respond, '
  + '[id^="comments-"], [class*="disqus"], [class*="livefyre"], [class*="coral-"], '
  + '[data-component="comments"], [data-testid*="comment-"], section[id*="comment"]';

// Interface that sits inside articles but is not the article: share rails, paywall
// cards, sign-up forms, the skip link every accessible site opens with.
const FURNITURE_SELECTOR = '[class*="share-tools"], [class*="share-bar"], '
  + '[class*="sharetools"], [class*="social-share"], [data-component="share"], '
  + '[aria-label*="Share this" i], [class*="paywall"], [id*="paywall"], '
  + '[class*="newsletter-signup"], [class*="signup-form"], [class*="skip-link"], '
  + '[class*="skip-to"], dialog, [role="alertdialog"], [class*="cookie-banner"], '
  + '[class*="consent-banner"], [data-testid*="cookie" i]';

const BLOCK_LEVEL = {
  p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4',
  blockquote: 'quote', pre: 'code', li: 'li', figure: 'figure',
  hr: 'hr', img: 'image', table: 'table',
};

// Where a lazily loaded picture keeps its real address. `src` comes last on purpose:
// a lazy image's src is a placeholder, and reading it first is what used to lose the
// picture — the placeholder was taken, rejected for being inline, and never retried.
const IMAGE_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-original-src',
  'data-full-src', 'data-hi-res-src', 'data-image-src', 'data-echo', 'src'];
const IMAGE_SET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset'];
const LAZY_ATTRS = [...IMAGE_SET_ATTRS, 'data-src', 'data-lazy-src', 'data-original'];

const isInline = (value) => /^(data:|about:|javascript:)/i.test(value);

const squash = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');
const tagOf = (el) => (el && el.tagName ? el.tagName.toLowerCase() : '');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function absolute(base, href) {
  try { return new URL(href, base).href; } catch { return href; }
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
        byline = squash(found.textContent).slice(0, 120);
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

/* ---------------------------------------------------------------- cleaning */

/**
 * A lazy-loading page parks the real <img> inside a <noscript> and ships a
 * placeholder in its place. `cleanTree` removes every <noscript>, so the picture went
 * with the tag. Lift those pictures out before the cleaning starts.
 *
 * Only markup that is nothing but pictures is lifted. "This site needs JavaScript" is
 * a message to a reader who will never see it here, not a figure.
 */
function liftNoscriptImages(doc) {
  for (const ns of [...doc.querySelectorAll('noscript')]) {
    // Parsed with scripting disabled, a <noscript> holds real elements. Parsed the
    // other way it holds its markup as text, so both are worth a look.
    let source = ns;
    if (!ns.querySelector('img')) {
      const raw = ns.textContent || '';
      if (!/<img\b/i.test(raw)) continue;
      source = new DOMParser().parseFromString(raw, 'text/html').body;
      if (!source || !source.querySelector('img')) continue;
    }
    if ((source.textContent || '').trim().length > 60) continue;

    const holder = doc.createElement('span');
    for (const img of source.querySelectorAll('img')) {
      holder.appendChild(doc.importNode(img, true));
    }
    if (holder.children.length) ns.replaceWith(holder);
  }
}

/** How many words a subtree holds, for the guards that stop a removal going too far. */
const wordsIn = (el) => ((el.textContent || '').match(/\S+/g) || []).length;

function cleanTree(doc) {
  const total = doc.body ? wordsIn(doc.body) : 0;

  for (const tag of STRIP_TAGS) {
    // Images are handled separately, and link/meta are metadata rather than chrome.
    if (['img', 'link', 'meta'].includes(tag)) continue;
    for (const el of [...doc.querySelectorAll(tag)]) {
      // A page's masthead is chrome; an article's own <header> is where its lead
      // picture usually sits. Removing both took the lead picture with it.
      if (tag === 'header' && el.closest('article')) continue;
      el.remove();
    }
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
  // The advertising units themselves. Scoring only demotes them, and a demoted
  // advert inside the winning subtree still lands in the saved article — with its
  // photographs. The text-length guard keeps a container that merely mentions
  // adverts in its class name ("ad-free-content") from taking the article with it.
  for (const el of [...doc.querySelectorAll(
    'ins.adsbygoogle, amp-ad, amp-embed, [data-ad-slot], [data-ad-client], [data-ad-unit], '
    + '[id^="google_ads_"], [id^="div-gpt-ad"], [id^="taboola-"]')]) {
    el.remove();
  }
  for (const el of [...doc.querySelectorAll('[class], [id]')]) {
    if (!el.isConnected) continue;
    const sig = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    if (!AD_RE.test(sig)) continue;
    if ((el.textContent || '').trim().length > 400) continue;
    el.remove();
  }

  // Comment threads. The guard matters: on a discussion page the comments are the
  // read, and removing them would leave an empty article behind.
  for (const el of [...doc.querySelectorAll(COMMENT_SELECTOR)]) {
    if (!el.isConnected) continue;
    if (total && wordsIn(el) > total * 0.5) continue;
    el.remove();
  }

  // Share rails, paywall cards, sign-up forms, consent banners. Each is small by
  // nature, so a large match is a false positive and is left alone.
  for (const el of [...doc.querySelectorAll(FURNITURE_SELECTOR)]) {
    if (!el.isConnected) continue;
    if (wordsIn(el) > 120) continue;
    el.remove();
  }
}

/* ---------------------------------------------------------------- pictures */

/** One address a picture offers, with the width it claims for it. */
function fromSrcset(value) {
  // Not a split on commas: CDN addresses carry commas inside the path
  // (…/w_400,h_300,c_fill/photo.jpg). An address runs to the next whitespace;
  // a comma only separates candidates when it trails the address or follows
  // the descriptor.
  const out = [];
  const s = String(value || '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i += 1;
    if (i >= s.length) break;
    const from = i;
    while (i < s.length && !/\s/.test(s[i])) i += 1;
    let url = s.slice(from, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const at = i;
      while (i < s.length && s[i] !== ',') i += 1;
      descriptor = s.slice(at, i).trim().split(/\s+/)[0] || '';
      i += 1;
    }
    if (!url || isInline(url)) continue;
    const n = parseFloat(descriptor) || 0;
    // "2x" is a pixel density, not a width. Scaling it by a typical phone width puts
    // both kinds of descriptor on one comparable scale.
    out.push({ url, width: /x$/i.test(descriptor) ? n * 640 : n });
  }
  return out;
}

function collectSources(el, out) {
  if (!el || !el.getAttribute) return;
  for (const name of IMAGE_SET_ATTRS) out.push(...fromSrcset(el.getAttribute(name)));
  for (const name of IMAGE_SRC_ATTRS) {
    const value = (el.getAttribute(name) || '').trim();
    if (value && !isInline(value)) out.push({ url: value, width: 0 });
  }
}

// An address embedded in the page never competes with a real one: in a lazy
// loader it is the placeholder. But when it is all the picture has, and it is
// too big to be a spacer or an icon, it is the picture itself, inlined.
const DATA_URI_MIN = 1024;

function inlineImageSource(el) {
  if (!el || !el.getAttribute) return '';
  for (const name of IMAGE_SRC_ATTRS) {
    const value = (el.getAttribute(name) || '').trim();
    if (/^data:image\//i.test(value) && value.length >= DATA_URI_MIN) return value;
  }
  return '';
}

/**
 * Where a picture really lives, at the best size the page offers.
 *
 * A modern article rarely says `src="photo.jpg"`. It ships a responsive `srcset`, a
 * `<picture>` with a `<source>` per breakpoint, or a one-pixel placeholder in `src`
 * with the true address parked in a data attribute for a lazy loader to pick up.
 *
 * Every candidate is gathered and the widest wins. Taking the first non-empty one
 * instead — which is what this used to do — meant the `<img>` element's own mobile
 * srcset beat the 1920-pixel `<source>` sitting beside it, and articles were saved
 * with 465-pixel photographs.
 */
function pickImageSource(el, baseUrl) {
  if (!el) return '';
  const all = [];
  collectSources(el, all);

  const picture = el.closest ? el.closest('picture') : null;
  if (picture) {
    for (const source of picture.querySelectorAll('source')) {
      const type = (source.getAttribute('type') || '').toLowerCase();
      if (type && !type.startsWith('image/')) continue;
      collectSources(source, all);
    }
  }
  if (!all.length) return inlineImageSource(el);

  // Where nothing declares a width, the first listed address wins: that is the
  // page's own preferred one, and the lazy-loading attributes are listed first.
  let best = all[0];
  for (const c of all) if (c.width > best.width) best = c;
  return absolute(baseUrl, best.url);
}

/** True when a picture is an advert, a tracking pixel, or site furniture. */
function isNoiseImage(el, src, root) {
  if (AD_SRC_RE.test(src)) return true;
  const alt = (el.getAttribute('alt') || '').toLowerCase();
  if (alt.includes('advertisement')) return true;

  // A declared size this small is an icon or a beacon, never a figure — unless the
  // picture also offers alternatives. Nobody ships a srcset or a lazy address for a
  // favicon or a tracking pixel, and a small width/height pair on one of those is an
  // aspect ratio or a placeholder rather than a size.
  if (!LAZY_ATTRS.some((name) => el.hasAttribute(name))) {
    const w = parseInt(el.getAttribute('width') || '', 10);
    const h = parseInt(el.getAttribute('height') || '', 10);
    if ((w && w <= 40) || (h && h <= 40)) return true;
  }

  // Climb only as far as the flattening root: a picture inside an advert or a
  // related-story strip belongs to the strip. The page shell above the root is
  // out of bounds — a "has-sidebar" class on <body> says nothing about this image.
  let node = el.parentElement;
  for (let depth = 0; node && node !== root && depth < 12; depth += 1) {
    const sig = `${node.getAttribute('class') || ''} ${node.getAttribute('id') || ''}`;
    if (AD_RE.test(sig) || NOISE_IMAGE_RE.test(sig)) return true;
    node = node.parentElement;
  }
  return false;
}

/* ---------------------------------------------------------------- scoring */

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

  const tag = tagOf(el);
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

// A site that names its own article body is telling us where the prose is, and it is
// always a better answer than a score. Checked before scoring, and only trusted when
// the named element actually holds an article's worth of words.
const BODY_SELECTOR = '[itemprop="articleBody"], [class*="article-body"], '
  + '[class*="article__body"], [class*="articleBody"], [class*="post-content"], '
  + '[class*="post-body"], [class*="entry-content"], [class*="story-body"], '
  + '[class*="storyBody"], [class*="c-article-body"], [data-component="text-block"]';

export function findContentRoot(doc) {
  let named = null;
  for (const el of doc.querySelectorAll(BODY_SELECTOR)) {
    const count = wordsIn(el);
    if (count < 200) continue;
    if (!named) { named = el; continue; }
    // Several matches usually nest; the outermost holds the whole article. Two that
    // do not overlap at all are rare, and then the longer one is the article.
    if (el.contains(named)) named = el;
    else if (!named.contains(el) && count > wordsIn(named)) named = el;
  }
  if (named) return named;

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
    while (parent && !['body', 'html'].includes(tagOf(parent))) {
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

// One or two characters of Latin text is never a paragraph, but a single
// ideograph can be a whole word, so the short-text rule is a per-script rule.
// Bare punctuation — a stray ×, », © left over from cleaning — carries no
// ideograph and still falls to it.
const CJK_RE = /[\u2E80-\u2FDF\u3005\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]/;

function isBoilerplate(text) {
  const t = text.trim().toLowerCase();
  if (t.length < 3 && !CJK_RE.test(t)) return true;
  return BOILERPLATE.has(t);
}

const PROSE = new Set(['p', 'li', 'quote', 'h1', 'h2', 'h3', 'h4']);
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'body',
  'figcaption', 'header', 'span', 'tbody', 'thead', 'tr', 'td', 'th']);
const OWN_TEXT_CONTAINERS = new Set(['div', 'section', 'article', 'main', 'body']);
const NESTING_CHILDREN = new Set(['p', 'ul', 'ol', 'div', 'blockquote', 'figure', 'pre', 'table', 'dl']);

/** Walk the chosen subtree in document order and emit normalised blocks. */
export function flatten(root, baseUrl, dropTitle = '') {
  const blocks = [];
  let lastProse = null;
  const normTitle = squash(dropTitle).toLowerCase();

  /** `piece` is either a plain string or the { text, spans } an inline read returns. */
  function emit(type, piece = '', extra = {}) {
    const text = typeof piece === 'string' ? piece : (piece.text || '');
    const spans = typeof piece === 'string' ? null : piece.spans;

    if (PROSE.has(type)) {
      if (isBoilerplate(text)) return;
      // The same text twice in a row is one passage read twice — a container's
      // stray words re-read through a child, a page carrying a second copy of
      // its markup. A refrain or a repeated answer further down is the author's,
      // so only neighbours are compared, and on their whole text: two long
      // paragraphs may honestly share an opening.
      const key = text.toLowerCase();
      if (key === lastProse) return;
      // The page title is rendered separately in the reader header.
      if (type.startsWith('h') && squash(text).toLowerCase() === normTitle) return;
      lastProse = key;
    }
    blocks.push(makeBlock(type, text, spans && spans.length ? { ...extra, spans } : extra));
  }

  const read = (el, stopAt = null) => inlineFrom(el, baseUrl, stopAt);

  /** One picture, if it is a picture worth keeping. */
  function emitImage(img, caption, extra = {}) {
    const src = pickImageSource(img, baseUrl);
    if (!src || isNoiseImage(img, src, root)) return false;
    let text = caption != null ? caption : (img.getAttribute('alt') || '').trim();
    // An alt that is just the file's own name — "Mac-Mini-preorder-featured" —
    // describes nothing; publishers leave it behind when nobody wrote a real one.
    if (text && !/\s/.test(text) && src.toLowerCase().includes(
      text.toLowerCase().replace(/\s+/g, ''))) {
      text = '';
    }
    emit('image', text, { ...extra, src });
    return true;
  }

  /* ctx carries what an element cannot see for itself: which list it is inside, how
     deep, and whether a quotation is open around it. */
  function walk(el, ctx) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = tagOf(el);

    /* ── lists ─────────────────────────────────────────────────────── */

    if (tag === 'ul' || tag === 'ol') {
      const start = parseInt(el.getAttribute('start') || '', 10);
      const list = {
        ordered: tag === 'ol',
        depth: ctx.list ? ctx.list.depth + 1 : 0,
        n: Number.isFinite(start) ? start : 1,
      };
      for (const child of el.children) walk(child, { ...ctx, list });
      return;
    }

    if (tag === 'dl') {
      // A definition list reads as a list of terms, each with its meaning indented
      // beneath it. Nothing else in the format carries that shape.
      const list = { ordered: false, depth: ctx.list ? ctx.list.depth + 1 : 0, n: 1 };
      for (const child of el.children) walk(child, { ...ctx, list });
      return;
    }

    if (tag === 'li' || tag === 'dt' || tag === 'dd') {
      const list = ctx.list || { ordered: false, depth: 0, n: 1 };
      const extra = { depth: list.depth + (tag === 'dd' ? 1 : 0) };
      if (tag === 'dt') extra.term = true;
      if (tag === 'li' && list.ordered) {
        extra.ordered = true;
        extra.num = list.n;
        list.n += 1;
      }
      const own = read(el, BLOCKISH);
      if (own.text) emit(ctx.quote ? 'quote' : 'li', own, extra);
      for (const child of el.children) {
        if (NESTING_CHILDREN.has(tagOf(child))) walk(child, ctx);
      }
      for (const picture of el.querySelectorAll(':scope > img, :scope > amp-img')) {
        emitImage(picture, null);
      }
      return;
    }

    /* ── quotations ────────────────────────────────────────────────── */

    if (tag === 'blockquote') {
      // A quotation of several paragraphs stays a quotation throughout. Recursing
      // without saying so emitted its paragraphs as ordinary prose, and the
      // attribution below it read as if the article had said it.
      const nested = [...el.children].some((c) => NESTING_CHILDREN.has(tagOf(c)));
      if (!nested) {
        emit('quote', read(el));
        return;
      }
      const own = read(el, BLOCKISH);
      if (own.text) emit('quote', own);
      for (const child of el.children) walk(child, { ...ctx, quote: true });
      return;
    }

    /* ── pictures ──────────────────────────────────────────────────── */

    if (tag === 'img' || tag === 'amp-img') {
      emitImage(el, null);
      return;
    }

    if (tag === 'figure') {
      const cap = el.querySelector(':scope > figcaption') || el.querySelector('figcaption');
      const caption = cap ? read(cap) : null;
      const pictures = [...el.querySelectorAll('img, amp-img')];
      let placed = 0;
      for (const img of pictures) {
        // The caption describes the plate as a whole, so it goes with the first
        // picture that survives; the rest keep their own alt text.
        const kept = placed === 0 && caption
          ? emitImage(img, caption)
          : emitImage(img, null);
        if (kept) placed += 1;
      }
      // A figure can wrap a table or a code listing instead of a photograph.
      for (const child of el.children) {
        if (['table', 'pre', 'blockquote'].includes(tagOf(child))) walk(child, ctx);
      }
      if (!placed && caption && caption.text) emit('p', caption);
      return;
    }

    /* ── everything else ───────────────────────────────────────────── */

    if (tag === 'pre') {
      const code = el.textContent || '';
      if (code.trim()) blocks.push(makeBlock('code', code.replace(/\s+$/, '')));
      return;
    }

    if (tag === 'table') {
      const rows = [];
      let headerRows = 0;
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [...tr.children].filter((c) => ['td', 'th'].includes(tagOf(c)));
        if (!cells.length) continue;
        const texts = cells.map((c) => read(c).text);
        if (!texts.some(Boolean)) continue;
        // The header is what the markup says it is. Assuming the first row was one
        // put a data row in bold on every table that opens without a <th>.
        const isHeader = cells.every((c) => tagOf(c) === 'th');
        if (isHeader && rows.length === headerRows) headerRows += 1;
        rows.push(texts);
      }
      if (rows.length) {
        const cap = el.querySelector(':scope > caption');
        blocks.push(makeBlock('table', '', {
          rows,
          headerRows,
          ...(cap && cap.textContent.trim() ? { caption: squash(cap.textContent) } : {}),
        }));
      }
      return;
    }

    if (tag === 'hr') { emit('hr'); return; }

    if (CONTAINERS.has(tag)) {
      // Container: recurse, but capture stray text that has no element of its own.
      if (OWN_TEXT_CONTAINERS.has(tag)) {
        const own = read(el, BLOCKISH);
        if (own.text.length > 60) emit(ctx.quote ? 'quote' : 'p', own);
      }
      for (const child of el.children) walk(child, ctx);
      return;
    }

    if (BLOCK_LEVEL[tag]) {
      let type = BLOCK_LEVEL[tag];
      if (type === 'p' && ctx.quote) type = 'quote';
      // A paragraph that itself wraps block content: recurse instead.
      const nested = [...el.children].some((c) => NESTING_CHILDREN.has(tagOf(c)));
      if (nested) {
        const own = read(el, BLOCKISH);
        if (own.text) emit(type, own);
        for (const child of el.children) walk(child, ctx);
        return;
      }
      // A picture wrapped in a paragraph — which is what `![alt](src)` on its own
      // line compiles to, so it is how most sites publish one. The text stays with
      // the paragraph and the picture becomes its own block; recursing instead would
      // drop any words sitting after the picture.
      emit(type, read(el));
      for (const picture of el.querySelectorAll('img, amp-img')) emitImage(picture, null);
      return;
    }

    // Anything else: descend.
    for (const child of el.children) walk(child, ctx);
  }

  walk(root, { list: null, quote: false });
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

  liftNoscriptImages(doc);
  cleanTree(doc);
  const root = findContentRoot(doc);
  let { blocks, words, plain } = finalise(sift(root ? flatten(root, url, info.title) : []));

  // If scoring produced almost nothing, fall back to every paragraph on the page.
  if (words < 60) {
    const doc2 = parser.parseFromString(htmlText, 'text/html');
    liftNoscriptImages(doc2);
    cleanTree(doc2);
    if (doc2.body) {
      const fb = finalise(sift(flatten(doc2.body, url, info.title)));
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
