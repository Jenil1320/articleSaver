/* The reading view.

   Anchoring: a mark is stored as (block index, start word, end word) rather than a DOM
   range or a character offset. Word positions survive a font change, a reflow, a
   different screen and a re-render, which DOM offsets do not.

   Progress: measured in words, not pixels or percent. Whole blocks scrolled past count
   in full; the block straddling the bottom of the screen counts pro rata. Progress only
   ever increases — scrolling back up is not un-reading.

   The reader scrolls inside its own element rather than the window. Every view has its
   own scroll box, so opening an article can never inherit how far the library was
   scrolled and count it as reading. */

import * as db from './db.js';
import * as library from './library.js';

const PROSE = new Set(['p', 'li', 'quote', 'h1', 'h2', 'h3', 'h4']);

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Character spans of each word, so word indices map to text positions. */
function wordSpans(text) {
  const out = [];
  const re = /\S+/g;
  let m = re.exec(text);
  while (m) {
    out.push([m.index, m.index + m[0].length]);
    m = re.exec(text);
  }
  return out;
}

/* ── painting one block ──────────────────────────────────────────────── */

/** Text as HTML, with the line breaks the author wrote kept as breaks. */
const escLines = (s) => esc(s).replace(/\n/g, '<br>');

/**
 * The tags one mark opens and closes.
 *
 * A link keeps its href so it looks and long-presses like a link, but the reader
 * intercepts the tap: following it in place would replace the whole app with a web
 * page, and there would be no way back to the article.
 */
function markTags(m) {
  switch (m.k) {
    case 'a': return [`<a class="lnk" href="${esc(m.href)}">`, '</a>'];
    case 'strong': return ['<strong>', '</strong>'];
    case 'em': return ['<em>', '</em>'];
    case 'code': return ['<code class="inl">', '</code>'];
    case 'strike': return ['<s>', '</s>'];
    case 'sup': return ['<sup>', '</sup>'];
    case 'sub': return ['<sub>', '</sub>'];
    // The extractor writes this kind as 'mark'; saved articles carry both names.
    case 'mark':
    case 'srcmark': return ['<span class="srcmark">', '</span>'];
    case 'hl': return [
      `<mark class="hl${m.note ? ' has-note' : ''}" data-colour="${esc(m.colour || 'yellow')}"`
      + ` data-ann="${esc(m.id)}">`, '</mark>'];
    default: return ['', ''];
  }
}

/**
 * One block's HTML: the marks its author wrote and the highlights its reader made,
 * merged in a single pass.
 *
 * The two kinds arrive in different currencies — the author's as character ranges from
 * the extractor, the reader's as word ranges stored against the block — and they
 * overlap freely, because highlighting across a link is the most ordinary thing in the
 * world. Painting them in two passes would have one cut the other's tags in half.
 *
 * So every start and every end becomes a cut point, and the text is walked segment by
 * segment. Across one segment the set of open marks never changes.
 *
 * A stack carries the marks already open from one segment into the next, and only the
 * difference is written. That is what keeps a link that contains an italic word as one
 * link rather than two abutting ones — which looked identical but read as two links to
 * anything listening. Where a highlight genuinely crosses an author's mark, the stack
 * closes and re-opens it, so the markup stays properly nested either way.
 */
export function blockHTML(block, ranges) {
  const text = block.text || '';
  if (!text) return '';

  const marks = [];
  for (const span of block.spans || []) marks.push(span);

  if (ranges && ranges.length) {
    const words = wordSpans(text);
    if (words.length) {
      for (const r of ranges) {
        const s = Math.max(0, Math.min(r.startWord, words.length - 1));
        const e = Math.max(s, Math.min(r.endWord - 1, words.length - 1));
        marks.push({ s: words[s][0], e: words[e][1], k: 'hl', ...r });
      }
    }
  }

  if (!marks.length) return escLines(text);

  const cuts = new Set([0, text.length]);
  for (const m of marks) {
    if (m.s > 0 && m.s < text.length) cuts.add(m.s);
    if (m.e > 0 && m.e < text.length) cuts.add(m.e);
  }
  const points = [...cuts].sort((a, b) => a - b);

  let html = '';
  let stack = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    const want = marks.filter((m) => m.s <= from && m.e >= to)
      // Widest first: a mark covering several segments has to wrap the ones inside it.
      .sort((a, b) => a.s - b.s || b.e - a.e);

    let same = 0;
    while (same < stack.length && same < want.length && stack[same] === want[same]) same += 1;
    for (let k = stack.length - 1; k >= same; k -= 1) html += markTags(stack[k])[1];
    for (let k = same; k < want.length; k += 1) html += markTags(want[k])[0];
    html += escLines(text.slice(from, to));
    stack = want;
  }
  for (let k = stack.length - 1; k >= 0; k -= 1) html += markTags(stack[k])[1];
  return html;
}

function metaLine(item) {
  const bits = [];
  if (item.byline) bits.push(esc(item.byline));
  if (item.siteName) bits.push(esc(item.siteName));
  if (item.publishedAt) {
    const d = new Date(item.publishedAt);
    if (!Number.isNaN(d.getTime())) {
      bits.push(d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
    }
  }
  if (item.wordCount) bits.push(`${item.readingMinutes || 1} min read`);
  if (item.pageCount) bits.push(`${item.pageCount} page${item.pageCount === 1 ? '' : 's'}`);
  return bits.join(' <span class="item__sep">·</span> ');
}

/* ── document structure ──────────────────────────────────────────────── */

const HEADING_TYPES = new Set(['h1', 'h2', 'h3', 'h4']);

// What a collapsed section says about itself. The extractor was not certain these
// blocks were furniture, so the reader never hides them — it only folds them up, and
// says plainly what it thought they were.
const ASIDE_LABEL = {
  promo: 'Newsletter or subscription pitch',
  sponsor: 'Sponsored or paid content',
  related: 'Links to other stories',
  bio: 'About the author',
  meta: 'Page furniture',
};

// End-matter headings. What follows them is looked things up, not read things
// through, and the reader shows it compact so the article ends where it ends.
const REF_HEAD_RE = new RegExp(
  '^(?:[0-9]{1,2}[.):]?\\s+|[ivxlc]{1,5}[.)]\\s+)?'
  + '(references?|bibliography|works cited|citations?|sources|notes|endnotes|footnotes)\\s*:?$', 'i');

/**
 * Which blocks belong to a references or footnotes section: everything after a
 * matching heading, up to the next heading at the same depth or shallower.
 */
export function referenceSpans(content) {
  const inRefs = new Set();
  const heads = new Set();
  for (let i = 0; i < content.length; i += 1) {
    const b = content[i];
    if (!HEADING_TYPES.has(b.type) || !REF_HEAD_RE.test((b.text || '').trim())) continue;
    heads.add(i);
    const level = Number(b.type[1]);
    for (let j = i + 1; j < content.length; j += 1) {
      const next = content[j];
      if (HEADING_TYPES.has(next.type) && Number(next.type[1]) <= level) break;
      inRefs.add(j);
    }
  }
  return { inRefs, heads };
}

export class Reader {
  constructor(container, root, endRoot, hooks = {}) {
    this.container = container;
    this.root = root;
    this.endRoot = endRoot;
    this.hooks = hooks;
    this.item = null;
    this.annotations = [];
    this.objectUrls = [];
    this.progressWords = 0;
    this.resumeWords = 0;
    this.saveTimer = null;
    this._loadToken = 0;
    this.onScroll = this.handleScroll.bind(this);
  }

  /**
   * The library hands the reader fresh copies of its record, and a copy can arrive
   * with the counters rewound — marking the article unread on the end card does
   * exactly that, while the view still stands at the very end. Progress is
   * recomputed from the scroll position, so standing there would count the whole
   * article as read again on the next scroll. Rewinding therefore means adopting
   * the record's counters and going back to the top.
   */
  get item() { return this._item; }

  set item(record) {
    const previous = this._item;
    this._item = record;
    if (!record || !previous || record.id !== previous.id) return;
    if ((record.progressWords || 0) >= this.progressWords) return;
    this.progressWords = record.progressWords || 0;
    this.resumeWords = record.resumeWords || 0;
    if (this.container.scrollTop >= 1) this._skipNext = true;
    this.container.scrollTop = 0;
  }

  async load(item) {
    this.teardown();
    // Whatever an earlier load is still awaiting belongs to an article no longer
    // on screen. A stale token tells its continuation to stop before it writes
    // this article's positions against that article's id.
    this._loadToken += 1;
    const token = this._loadToken;
    this.item = item;
    this.annotations = item.annotations || [];
    this.progressWords = item.progressWords || 0;
    this.resumeWords = item.resumeWords || 0;
    this.container.scrollTop = 0;
    this.render();
    await this.resolveImages();
    if (token !== this._loadToken) return;
    // A picture has no height until its blob arrives and decodes, so measuring
    // the resume block's offset too early lands short by every picture above it.
    if (this.resumeWords >= 20) {
      await this.settleImages();
      if (token !== this._loadToken) return;
    }
    this.restorePosition();
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    // No measurement here: opening is not reading. The restore put the resume
    // block at the top of the screen, and measuring the bottom edge now would
    // count one unread screenful as read — on every open, for good, since
    // progress never goes back down.
    library.recordProgress(item.id, {
      progressWords: this.progressWords,
      resumeWords: this.resumeWords,
      opened: true,
    }).catch(() => {});
  }

  teardown() {
    this.container.removeEventListener('scroll', this.onScroll);
    this._skipNext = false;
    this._settling = false;
    clearTimeout(this.saveTimer);
    this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    this.objectUrls = [];
    // The measured block list belongs to the article being left. Kept across a load,
    // its elements are detached and every height reads as zero, so the next article
    // looks entirely scrolled past and is marked finished on sight.
    this._prose = null;
    // The item is what arms flush(). Left set, every app pause after leaving the
    // reader would save this article's counters again — undoing, for one, a
    // mark-as-unread made from the library in the meantime.
    this.item = null;
  }

  /* ── rendering ───────────────────────────────────────────────────── */

  render() {
    const item = this.item;
    const byBlock = new Map();
    for (const a of this.annotations) {
      // A detached mark's words no longer exist in the re-read text; painting it
      // anyway would highlight whatever now sits at its old position.
      if (a.kind === 'bookmark' || a.detached) continue;
      if (!byBlock.has(a.blockIndex)) byBlock.set(a.blockIndex, []);
      byBlock.get(a.blockIndex).push(a);
    }
    const bookmarks = new Set(
      this.annotations.filter((a) => a.kind === 'bookmark' && !a.detached).map((a) => a.blockIndex),
    );

    const kindLabel = { product: ' · Tool', paper: ' · Paper', post: ' · Post' }[item.kind] || '';

    // The opening picture, unless the article's first block is already that picture.
    const firstPicture = (item.content || []).find((b) => b.type === 'image' && b.src);
    const lead = item.leadImage && (!firstPicture || firstPicture.src !== item.leadImage)
      ? `<figure class="reader__lead"><img data-msrc="${esc(item.leadImage)}" alt=""></figure>`
      : '';

    const parts = [`<header class="reader__head">
      <div class="reader__kicker">${esc(item.theme || 'Unsorted')}${kindLabel}</div>
      <h1 class="reader__title">${esc(item.title)}</h1>
      <div class="reader__byline">${metaLine(item)}</div>
    </header><div class="reader__rule"></div>${lead}`];

    const { inRefs, heads: refHeads } = referenceSpans(item.content || []);

    // Consecutive list items render inside one real list, so bullets indent and
    // space as a list rather than as a run of loose paragraphs. A change of kind or
    // of depth starts a new one, which is what keeps a nested list looking nested.
    let list = null;
    const closeList = () => {
      if (list) { parts.push(list.ordered ? '</ol>' : '</ul>'); list = null; }
    };
    const openList = (b) => {
      const ordered = !!b.ordered;
      const depth = Number(b.depth) || 0;
      if (list && list.ordered === ordered && list.depth === depth) return;
      closeList();
      list = { ordered, depth };
      // `start` matters because a run can be broken by a figure and resume; without
      // it the numbering would restart at one halfway down the list.
      parts.push(ordered
        ? `<ol class="blkl" style="--d:${depth}" start="${Number(b.num) || 1}">`
        : `<ul class="blkl" style="--d:${depth}">`);
    };

    // A run of furniture collapses to one line rather than one line each: a related
    // rail of six headlines is one thing the reader chose not to read, not six.
    let aside = null;
    const closeAside = () => {
      if (aside) { parts.push('</div></section>'); aside = null; }
    };
    const openAside = (why) => {
      if (aside === why) return;
      closeAside();
      aside = why;
      parts.push(`<section class="aside" data-aside="${esc(why)}">`
        + `<button class="aside__tap" type="button" aria-expanded="false">`
        + `<span class="aside__what">${esc(ASIDE_LABEL[why] || 'Set aside')}</span>`
        + `<span class="aside__more">Show</span></button>`
        + '<div class="aside__body" hidden>');
    };

    (item.content || []).forEach((b, i) => {
      const marks = byBlock.get(i) || [];
      const flag = bookmarks.has(i)
        ? '<span class="bookmark-flag"><svg class="ic" viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></span>'
        : '';
      const page = b.page ? ` data-page="${Number(b.page) || 0}"` : '';
      const ref = inRefs.has(i) ? ' ref' : '';
      const attrs = `class="blk${ref}" data-i="${i}"${page}`;

      if (b.type !== 'li') closeList();
      // A list may not straddle the edge of a collapsed section, so crossing one
      // always closes it first.
      if ((b.aside || null) !== aside) {
        closeList();
        if (b.aside) openAside(b.aside); else closeAside();
      }

      if (b.type === 'image') {
        if (!b.src) return;
        parts.push(`<figure class="blk${b.figure ? ' fig' : ''}" data-i="${i}"${page}>`
          + `<img data-msrc="${esc(b.src)}" alt="${esc(b.text || '')}" loading="lazy">`
          + (b.text ? `<figcaption>${blockHTML(b, null)}</figcaption>` : '') + '</figure>');
        return;
      }
      if (b.type === 'hr') { parts.push(`<hr ${attrs}>`); return; }
      if (b.type === 'code') {
        parts.push(`<pre ${attrs}>${flag}<code>${esc(b.text)}</code></pre>`);
        return;
      }
      if (b.type === 'table') {
        const heads = b.headerRows || 0;
        const rows = (b.rows || []).map((r, ri) => `<tr>${r.map((c) => (ri < heads
          ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('');
        parts.push(`<div class="tablewrap blk" data-i="${i}">`
          + (b.caption ? `<div class="tablecap">${esc(b.caption)}</div>` : '')
          + `<table>${rows}</table></div>`);
        return;
      }

      const inner = flag + blockHTML(b, marks);
      if (b.type === 'quote') parts.push(`<blockquote ${attrs}>${inner}</blockquote>`);
      else if (b.type === 'li') {
        openList(b);
        parts.push(`<li class="blk${ref}${b.term ? ' term' : ''}" data-i="${i}"${page}>${inner}</li>`);
      } else if (b.type.startsWith('h')) {
        const head = refHeads.has(i) ? ' refhead' : '';
        parts.push(`<${b.type} class="blk${ref}${head}" data-i="${i}"${page}>${inner}</${b.type}>`);
      } else parts.push(`<p ${attrs}>${inner}</p>`);
    });
    closeList();
    closeAside();

    this.root.innerHTML = parts.join('');
    this.renderEnd();
  }

  /** The document's headings, for the contents sheet. */
  outline() {
    const out = [];
    (this.item && this.item.content ? this.item.content : []).forEach((b, i) => {
      // A heading inside a collapsed section names furniture, not a place to go.
      if (b.aside) return;
      if (['h1', 'h2', 'h3'].includes(b.type) && b.text) {
        out.push({ i, level: Number(b.type[1]), text: b.text, page: b.page || 0 });
      }
    });
    return out;
  }

  renderEnd() {
    const item = this.item;
    const done = item.status === 'finished';
    const source = item.url
      ? `<button class="btn" data-end="source">
           <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-open"/></svg> Open the original</button>`
      : '';
    const original = item.originalPath
      ? `<button class="btn" data-end="pdf">
           <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-file"/></svg> The original PDF</button>`
      : '';

    this.endRoot.innerHTML = `<div class="reader__rule"></div>
      <button class="btn ${done ? '' : 'btn--primary'}" data-end="finish">
        <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-check"/></svg>
        ${done ? 'Mark as unread' : 'Mark as finished'}
      </button>${source}${original}`;
  }

  /** Pictures live in this device's own store, never on a network. */
  async resolveImages() {
    const imgs = [...this.root.querySelectorAll('img[data-msrc]')];
    await Promise.all(imgs.map(async (img) => {
      const key = img.getAttribute('data-msrc');
      img.removeAttribute('data-msrc');
      try {
        const blob = await db.getMedia(key);
        if (blob) {
          const objectUrl = URL.createObjectURL(blob);
          this.objectUrls.push(objectUrl);
          img.src = objectUrl;
          return;
        }
      } catch { /* fall through */ }
      // Nothing stored: hide the frame rather than show a broken picture.
      const figure = img.closest('figure');
      if (figure) figure.remove();
    }));
  }

  /**
   * Wait for the pictures just handed their blobs to take their real height, so
   * that offsets measured next are measured against the settled page. Bounded:
   * a picture that will not decode must not hold the article shut.
   */
  async settleImages() {
    const pending = [...this.root.querySelectorAll('img[src]')].filter((img) => !img.complete);
    if (!pending.length) return;
    await Promise.race([
      Promise.all(pending.map((img) => img.decode().catch(() => {}))),
      new Promise((resolve) => { setTimeout(resolve, 1500); }),
    ]);
  }

  /* ── progress ────────────────────────────────────────────────────── */

  proseBlocks() {
    if (!this._prose) {
      this._prose = [...this.root.querySelectorAll('.blk')]
        .map((el) => ({ el, block: this.item.content[Number(el.dataset.i)] }))
        .filter((x) => x.block && PROSE.has(x.block.type) && x.block.words > 0);
    }
    return this._prose;
  }

  /**
   * Move to a block without reading anything. The jump's own scroll event must not
   * advance progress: tapping "References" in the contents sheet is navigation,
   * and counting everything skipped over would mark the article finished on the
   * spot. The resume position still moves, so leaving and returning works.
   */
  jumpTo(el) {
    const target = Math.max(0, el.offsetTop - 90);
    if (Math.abs(this.container.scrollTop - target) >= 1) this._skipNext = true;
    this.container.scrollTop = target;
  }

  handleScroll() {
    // While applyAnnotations is settling a re-render, the layout is collapsed and
    // any measurement of it is fiction.
    if (this._settling) return;
    const total = this.item ? this.item.wordCount || 0 : 0;
    if (!total) return;
    const blocks = this.proseBlocks();
    if (!blocks.length || !blocks[0].el.isConnected) { this._prose = null; return; }

    const bottom = this.container.scrollTop + this.container.clientHeight;

    let words = 0;
    for (const { el, block } of blocks) {
      const top = el.offsetTop;
      const height = el.offsetHeight || 1;
      if (bottom >= top + height) {
        words = block.start + block.words;
      } else if (bottom > top) {
        const fraction = Math.max(0, Math.min(1, (bottom - top) / height));
        words = Math.max(words, block.start + Math.floor(fraction * block.words));
        break;
      } else break;
    }

    this.resumeWords = words;
    if (this._skipNext) {
      this._skipNext = false;
      this.scheduleSave();
      return;
    }
    if (words > this.progressWords) {
      this.progressWords = Math.min(words, total);
      this.paintProgress();
      this.scheduleSave();
    }
  }

  paintProgress() {
    if (!this.item) return;
    const total = this.item.wordCount || 1;
    const pct = Math.max(0, Math.min(100, Math.round((100 * this.progressWords) / total)));
    if (this.hooks.onProgress) this.hooks.onProgress(pct, this.progressWords, total);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.flush(); }, 900);
  }

  flush() {
    clearTimeout(this.saveTimer);
    if (!this.item) return Promise.resolve();
    return library.recordProgress(this.item.id, {
      progressWords: this.progressWords,
      resumeWords: this.resumeWords,
    }).then(() => { if (this.hooks.onChange) this.hooks.onChange(); }).catch(() => {});
  }

  restorePosition() {
    const resume = this.item.resumeWords || 0;
    if (resume < 20) return;
    const target = this.proseBlocks().find(({ block }) => block.start + block.words >= resume);
    if (!target) return;
    const top = Math.max(0, target.el.offsetTop - 90);
    // The restore's own scroll event is navigation, not reading — without the
    // skip, the screenful below the resume mark would count as read on every open.
    if (Math.abs(this.container.scrollTop - top) >= 1) this._skipNext = true;
    this.container.scrollTop = top;
  }

  /* ── selection ───────────────────────────────────────────────────── */

  /** Work out which words the current selection covers. */
  readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);

    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    const blk = node.closest ? node.closest('.blk') : null;
    if (!blk || !this.root.contains(blk)) return null;

    const index = Number(blk.dataset.i);
    const block = this.item.content[index];
    if (!block || !PROSE.has(block.type)) return null;

    const text = block.text;
    const startChar = this.charOffset(blk, range.startContainer, range.startOffset);
    // Both ends are walked the same way so they agree on what a <br> is worth: the
    // range's own string gives a line break no length at all. A selection dragged
    // past the end of this block still stops at its end — the walk never meets a
    // node from another block, so it returns the whole text's length.
    const endChar = Math.min(this.charOffset(blk, range.endContainer, range.endOffset), text.length);

    const spans = wordSpans(text);
    if (!spans.length) return null;

    let startWord = spans.findIndex(([, e]) => e > startChar);
    if (startWord < 0) startWord = spans.length - 1;
    let endWord = spans.length;
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      if (spans[i][0] < endChar) { endWord = i + 1; break; }
    }
    if (endWord <= startWord) endWord = startWord + 1;

    const quote = text.slice(spans[startWord][0], spans[Math.min(endWord, spans.length) - 1][1]);
    return {
      blockIndex: index,
      startWord,
      endWord,
      quote,
      rect: range.getBoundingClientRect(),
    };
  }

  charOffset(root, node, offset) {
    // Marks already rendered mean the block is several text nodes; count across them.
    // A <br> is one newline in the stored text and no text node at all in the DOM, so
    // it has to be counted as it is passed or every offset after it comes out short.
    //
    // A selection can also anchor on an element rather than a text node — a desktop
    // triple-click anchors on the block itself — and then the offset counts child
    // nodes, not characters. That boundary sits just before the child the offset
    // points at, or, past the last child, just after the element itself.
    let target = node;
    let within = offset;
    if (node.nodeType === Node.ELEMENT_NODE) {
      within = 0;
      if (offset < node.childNodes.length) {
        target = node.childNodes[offset];
      } else {
        let after = node;
        while (after && after !== root && !after.nextSibling) after = after.parentNode;
        target = after && after !== root ? after.nextSibling : null;
      }
    }
    const walker = document.createTreeWalker(root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let count = 0;
    let n = walker.nextNode();
    while (n) {
      if (n === target) return count + within;
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'BR') count += 1;
      } else if (!n.parentElement.closest('.bookmark-flag')) {
        count += n.nodeValue.length;
      }
      n = walker.nextNode();
    }
    return count;
  }

  /** Where in the article, in words, a block-relative position sits. */
  absoluteWord(blockIndex, startWord) {
    const block = this.item.content[blockIndex];
    return block ? (block.start || 0) + startWord : 0;
  }

  async applyAnnotations(list) {
    this.annotations = list;
    const y = this.container.scrollTop;
    const token = this._loadToken;
    const settleId = this._settleId = (this._settleId || 0) + 1;
    // The block at the top of the screen, and how far into it. A raw pixel offset
    // is not enough to come back to: the fresh markup gives every picture no
    // height until its blob comes back and decodes, so for a moment the article is
    // far shorter than it was, and a position measured on the old page can lie
    // beyond the end of the new one.
    let anchor = null;
    for (const { el } of this.proseBlocks()) {
      if (el.offsetTop > y) break;
      if (el.offsetHeight) anchor = { i: el.dataset.i, delta: y - el.offsetTop };
    }
    this._prose = null;
    // While the layout is collapsed the scroll position clamps to the shrunken
    // end, and the clamp's scroll event would count everything up to there as
    // read. Measurement stays paused until the page has its height back and the
    // position has been put back where it was.
    this._settling = true;
    this.render();
    await this.resolveImages();
    await this.settleImages();
    if (token !== this._loadToken || settleId !== this._settleId) return;
    const el = anchor ? this.root.querySelector(`.blk[data-i="${anchor.i}"]`) : null;
    this.container.scrollTop = el ? el.offsetTop + anchor.delta : y;
    // The restore's own scroll event lands in the next frame; only after it may
    // measurement resume.
    requestAnimationFrame(() => {
      if (token === this._loadToken && settleId === this._settleId) this._settling = false;
    });
  }
}
