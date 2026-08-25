/* The marks an author wrote inside a paragraph.

   A block stores its words as one plain string, `text`, and its marks as `spans` —
   character ranges into that same string. A link is `{ s, e, k: 'a', href }`; bold is
   `{ s, e, k: 'strong' }`; and so on.

   Character ranges rather than a nested tree, on purpose. Reading progress, highlight
   anchors and search all index into `text` by word offset, and a highlight the reader
   makes can straddle a link the author wrote. Keeping `text` as the single spine means
   the two never fight, nothing already saved needs migrating, and the reader merges
   both kinds of mark in one pass.

   Whitespace is collapsed while the text is being built, not afterwards, so every
   offset recorded along the way still points at the right character at the end. */

// Which element becomes which mark. Anything not listed contributes its words and
// no mark of its own, which is what a <span> wrapper should do.
const MARK_TAGS = {
  a: 'a',
  strong: 'strong', b: 'strong',
  em: 'em', i: 'em', cite: 'em', dfn: 'em', var: 'em',
  code: 'code', kbd: 'code', samp: 'code', tt: 'code',
  del: 'strike', s: 'strike', strike: 'strike',
  sup: 'sup', sub: 'sub',
  mark: 'mark',
};

// Elements that carry no reading text. Pictures are pulled out as their own blocks by
// the caller, so an <img> inside a paragraph must not also contribute here.
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'canvas', 'img',
  'amp-img', 'picture', 'source', 'button', 'input', 'select', 'textarea', 'iframe',
  'video', 'audio', 'object', 'embed', 'template']);

// A page that builds every word out of its own <span> can produce thousands of ranges.
// Past this many the marks stop being information and start being weight.
const MAX_SPANS = 400;

/**
 * Collects text with HTML's whitespace rules already applied.
 *
 * `text()` folds any run of whitespace to a single space and never opens with one.
 * `lineBreak()` is a <br>: it eats the space before it and writes a real newline, so
 * an address or a verse keeps its lines instead of running together.
 */
function makeSink() {
  let out = '';
  let owed = false;

  return {
    get pos() { return out.length; },

    text(raw) {
      const s = String(raw == null ? '' : raw);
      if (!s) return;
      const parts = s.split(/\s+/);
      // An empty first or last part is whitespace at that end of the chunk.
      if (parts[0] === '') { owed = true; parts.shift(); }
      const trailing = parts.length > 0 && parts[parts.length - 1] === '';
      if (trailing) parts.pop();

      for (let k = 0; k < parts.length; k += 1) {
        // The whitespace that split one word from the next is owed as one space.
        if (k > 0) owed = true;
        if (owed && out && !out.endsWith('\n')) out += ' ';
        owed = false;
        out += parts[k];
      }
      if (trailing) owed = true;
    },

    lineBreak() {
      out = out.replace(/ +$/, '');
      if (out && !out.endsWith('\n')) out += '\n';
      owed = false;
    },

    finish() { return out.replace(/\s+$/, ''); },
  };
}

function absolute(base, href) {
  try { return new URL(href, base || undefined).href; } catch { return ''; }
}

/** The address a link points at, or '' when following it would go nowhere. */
function linkTarget(el, baseUrl) {
  const raw = (el.getAttribute('href') || '').trim();
  if (!raw || raw.startsWith('#')) return '';
  if (/^(javascript|mailto|tel|data|about):/i.test(raw)) return '';
  const url = absolute(baseUrl, raw);
  return /^https?:/i.test(url) ? url : '';
}

/**
 * Tidy the raw ranges into something a renderer can trust: inside the text, non-empty,
 * not padded with whitespace, and free of the duplicates that nesting produces.
 */
function tidy(spans, text) {
  const out = [];
  const seen = new Set();

  spans.forEach((span, order) => {
    let { s, e } = span;
    e = Math.min(e, text.length);
    // A mark that only ever covered whitespace marks nothing.
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e <= s) return;

    const key = `${s}:${e}:${span.k}:${span.href || ''}`;
    if (seen.has(key)) return;        // <strong> wrapped directly around <b>
    seen.add(key);
    out.push(span.href
      ? { s, e, k: span.k, href: span.href, order }
      : { s, e, k: span.k, order });
  });

  // Outermost first, so the renderer opens marks in the order the author nested them.
  // Marks are recorded on the way back up, so of two covering the same range the one
  // recorded later is the outer one.
  out.sort((a, b) => a.s - b.s || b.e - a.e || b.order - a.order);

  // Join marks of one kind that meet or overlap — a run of <em> words written as
  // several elements should read as one italic phrase, not as a stutter of them.
  const merged = [];
  for (const span of out) {
    const prev = merged.find((m) => m.k === span.k && (m.href || '') === (span.href || '')
      && span.s <= m.e && span.e >= m.s);
    if (prev) { prev.e = Math.max(prev.e, span.e); continue; }
    merged.push(span);
  }
  // `order` was only ever a sorting aid; it is not worth storing on every article.
  return merged.slice(0, MAX_SPANS).map(({ order, ...span }) => span);
}

/**
 * Read one element's children as marked-up text.
 *
 * Returns `{ text, spans }`. `spans` is left off entirely when the element held no
 * marks, so an ordinary paragraph costs nothing extra to store.
 */
export function inlineFrom(el, baseUrl = '', stopAt = null) {
  const sink = makeSink();
  const spans = [];

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { sink.text(node.nodeValue); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    // A list item's own words stop where its nested list begins; the caller walks
    // that separately so it keeps its own depth and numbering.
    if (stopAt && stopAt.has(tag)) return;
    if (tag === 'br') { sink.lineBreak(); return; }

    const kind = MARK_TAGS[tag];
    let href = '';
    if (kind === 'a') {
      href = linkTarget(node, baseUrl);
      // A link that goes nowhere is still text; it just stops being a link.
      if (!href) {
        for (const child of node.childNodes) walk(child);
        return;
      }
    }

    const start = sink.pos;
    for (const child of node.childNodes) walk(child);
    if (kind && sink.pos > start) {
      spans.push(href ? { s: start, e: sink.pos, k: kind, href } : { s: start, e: sink.pos, k: kind });
    }
  };

  if (el) for (const child of el.childNodes) walk(child);

  const text = sink.finish();
  const tidied = tidy(spans, text);
  return tidied.length ? { text, spans: tidied } : { text };
}

/** The same, for an element whose own text is wanted without any of its marks. */
export function plainFrom(el, stopAt = null) {
  return inlineFrom(el, '', stopAt).text;
}

/** Block-level tags: where an element's own inline text ends. */
export const BLOCKISH = new Set(['p', 'div', 'section', 'article', 'ul', 'ol', 'dl',
  'blockquote', 'figure', 'figcaption', 'pre', 'table', 'header', 'footer', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'dt', 'dd']);
