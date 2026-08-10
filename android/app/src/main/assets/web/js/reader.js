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

function blockHTML(text, ranges) {
  if (!ranges || !ranges.length) return esc(text);
  const spans = wordSpans(text);
  if (!spans.length) return esc(text);

  const marks = ranges.map((r) => {
    const s = Math.max(0, Math.min(r.startWord, spans.length - 1));
    const e = Math.max(s, Math.min(r.endWord - 1, spans.length - 1));
    return { from: spans[s][0], to: spans[e][1], ...r };
  }).sort((a, b) => a.from - b.from || b.to - a.to);

  let html = '';
  let pos = 0;
  for (const m of marks) {
    if (m.to <= pos) continue;                 // fully inside a mark already drawn
    const from = Math.max(m.from, pos);
    html += esc(text.slice(pos, from));
    html += `<mark class="hl${m.note ? ' has-note' : ''}" data-colour="${esc(m.colour || 'yellow')}"`
      + ` data-ann="${esc(m.id)}">${esc(text.slice(from, m.to))}</mark>`;
    pos = m.to;
  }
  html += esc(text.slice(pos));
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
    this.onScroll = this.handleScroll.bind(this);
  }

  async load(item) {
    this.teardown();
    this.item = item;
    this.annotations = item.annotations || [];
    this.progressWords = item.progressWords || 0;
    this.resumeWords = item.resumeWords || 0;
    this.container.scrollTop = 0;
    this.render();
    await this.resolveImages();
    this.restorePosition();
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    this.handleScroll();
    library.recordProgress(item.id, {
      progressWords: this.progressWords,
      resumeWords: this.resumeWords,
      opened: true,
    }).catch(() => {});
  }

  teardown() {
    this.container.removeEventListener('scroll', this.onScroll);
    this._skipNext = false;
    clearTimeout(this.saveTimer);
    this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    this.objectUrls = [];
    // The measured block list belongs to the article being left. Kept across a load,
    // its elements are detached and every height reads as zero, so the next article
    // looks entirely scrolled past and is marked finished on sight.
    this._prose = null;
  }

  /* ── rendering ───────────────────────────────────────────────────── */

  render() {
    const item = this.item;
    const byBlock = new Map();
    for (const a of this.annotations) {
      if (a.kind === 'bookmark') continue;
      if (!byBlock.has(a.blockIndex)) byBlock.set(a.blockIndex, []);
      byBlock.get(a.blockIndex).push(a);
    }
    const bookmarks = new Set(
      this.annotations.filter((a) => a.kind === 'bookmark').map((a) => a.blockIndex),
    );

    const kindLabel = { product: ' · Tool', paper: ' · Paper', post: ' · Post' }[item.kind] || '';
    const parts = [`<header class="reader__head">
      <div class="reader__kicker">${esc(item.theme || 'Unsorted')}${kindLabel}</div>
      <h1 class="reader__title">${esc(item.title)}</h1>
      <div class="reader__byline">${metaLine(item)}</div>
    </header><div class="reader__rule"></div>`];

    const { inRefs, heads: refHeads } = referenceSpans(item.content || []);

    // Consecutive list items render inside one real list, so bullets indent and
    // space as a list rather than as a run of loose paragraphs.
    let listOpen = false;
    const openList = () => { if (!listOpen) { parts.push('<ul class="blkl">'); listOpen = true; } };
    const closeList = () => { if (listOpen) { parts.push('</ul>'); listOpen = false; } };

    (item.content || []).forEach((b, i) => {
      const marks = byBlock.get(i) || [];
      const flag = bookmarks.has(i)
        ? '<span class="bookmark-flag"><svg class="ic" viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></span>'
        : '';
      const page = b.page ? ` data-page="${b.page}"` : '';
      const ref = inRefs.has(i) ? ' ref' : '';
      const attrs = `class="blk${ref}" data-i="${i}"${page}`;

      if (b.type !== 'li') closeList();

      if (b.type === 'image') {
        if (!b.src) return;
        parts.push(`<figure class="blk${b.figure ? ' fig' : ''}" data-i="${i}"${page}>`
          + `<img data-msrc="${esc(b.src)}" alt="${esc(b.text || '')}" loading="lazy">`
          + (b.text ? `<figcaption>${esc(b.text)}</figcaption>` : '') + '</figure>');
        return;
      }
      if (b.type === 'hr') { parts.push(`<hr ${attrs}>`); return; }
      if (b.type === 'code') {
        parts.push(`<pre ${attrs}>${flag}<code>${esc(b.text)}</code></pre>`);
        return;
      }
      if (b.type === 'table') {
        const rows = (b.rows || []).map((r, ri) => `<tr>${r.map((c) => (ri === 0
          ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('');
        parts.push(`<div class="tablewrap blk" data-i="${i}"><table>${rows}</table></div>`);
        return;
      }

      const inner = flag + blockHTML(b.text, marks);
      if (b.type === 'quote') parts.push(`<blockquote ${attrs}>${inner}</blockquote>`);
      else if (b.type === 'li') { openList(); parts.push(`<li ${attrs}>${inner}</li>`); }
      else if (b.type.startsWith('h')) {
        const head = refHeads.has(i) ? ' refhead' : '';
        parts.push(`<${b.type} class="blk${ref}${head}" data-i="${i}"${page}>${inner}</${b.type}>`);
      } else parts.push(`<p ${attrs}>${inner}</p>`);
    });
    closeList();

    this.root.innerHTML = parts.join('');
    this.renderEnd();
  }

  /** The document's headings, for the contents sheet. */
  outline() {
    const out = [];
    (this.item && this.item.content ? this.item.content : []).forEach((b, i) => {
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
    if (target) this.container.scrollTop = Math.max(0, target.el.offsetTop - 90);
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
    // A selection dragged past the end of this block stops at its end.
    const endChar = Math.min(startChar + range.toString().length, text.length);

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
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let count = 0;
    let n = walker.nextNode();
    while (n) {
      if (n === node) return count + offset;
      // The bookmark flag is interface, not article text.
      if (!n.parentElement.closest('.bookmark-flag')) count += n.nodeValue.length;
      n = walker.nextNode();
    }
    return count;
  }

  /** Where in the article, in words, a block-relative position sits. */
  absoluteWord(blockIndex, startWord) {
    const block = this.item.content[blockIndex];
    return block ? (block.start || 0) + startWord : 0;
  }

  applyAnnotations(list) {
    this.annotations = list;
    const y = this.container.scrollTop;
    this._prose = null;
    this.render();
    this.resolveImages();
    this.container.scrollTop = y;
  }
}
