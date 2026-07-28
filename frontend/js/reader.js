/* The reading view.

   Anchoring: a mark is stored as (block index, start word, end word) rather than a DOM
   range or a character offset. Word positions survive a font change, a reflow, a
   different screen and a re-render, which DOM offsets do not.

   Progress: measured in words, not pixels or percent. Whole blocks scrolled past count
   in full; the block straddling the bottom of the screen counts pro rata. Progress only
   ever increases — scrolling back up is not un-reading. */

import * as api from './api.js';
import * as store from './db.js';

const PROSE = new Set(['p', 'li', 'quote', 'h1', 'h2', 'h3', 'h4']);

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Character spans of each word, so word indices map to text positions. */
function wordSpans(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

function blockHTML(text, ranges) {
  if (!ranges || !ranges.length) return esc(text);
  const spans = wordSpans(text);
  if (!spans.length) return esc(text);

  const marks = ranges.map((r) => {
    const s = Math.max(0, Math.min(r.start_word, spans.length - 1));
    const e = Math.max(s, Math.min(r.end_word - 1, spans.length - 1));
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
  if (item.site_name) bits.push(esc(item.site_name));
  if (item.published_at) {
    const d = new Date(item.published_at);
    if (!Number.isNaN(d.getTime())) {
      bits.push(d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
    }
  }
  if (item.word_count) bits.push(`${item.reading_minutes || Math.max(1, Math.round(item.word_count / 230))} min read`);
  return bits.join(' <span class="item__sep">·</span> ');
}

export class Reader {
  constructor(root, endRoot, hooks = {}) {
    this.root = root;
    this.endRoot = endRoot;
    this.hooks = hooks;
    this.item = null;
    this.annotations = [];
    this.objectUrls = [];
    this.progressWords = 0;
    this.saveTimer = null;
    this.onScroll = this.handleScroll.bind(this);
  }

  async load(item) {
    this.teardown();
    this.item = item;
    this.annotations = (item.annotations || []).filter((a) => !a.deleted);
    this.progressWords = item.progress_words || 0;
    this.resumeWords = item.resume_words || 0;
    this.render();
    await this.resolveImages();
    this.restorePosition();
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.handleScroll();
    api.sendProgress(item.id, this.progressWords, item.resume_words || 0, true).catch(() => {});
  }

  teardown() {
    window.removeEventListener('scroll', this.onScroll);
    clearTimeout(this.saveTimer);
    this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    this.objectUrls = [];
    // The measured block list belongs to the article being left. Kept across a load,
    // its elements are detached from the document and every height reads as zero, so
    // the next article looks entirely scrolled past and is marked finished on sight.
    this._prose = null;
  }

  /* ── rendering ───────────────────────────────────────────────────── */

  render() {
    const item = this.item;
    const byBlock = new Map();
    for (const a of this.annotations) {
      if (a.kind === 'bookmark') continue;
      if (!byBlock.has(a.block_index)) byBlock.set(a.block_index, []);
      byBlock.get(a.block_index).push(a);
    }
    const bookmarks = new Set(
      this.annotations.filter((a) => a.kind === 'bookmark').map((a) => a.block_index),
    );

    const parts = [];
    parts.push(`<header class="reader__head">
      <div class="reader__kicker">${esc(item.theme || 'Unsorted')}${
        item.kind === 'product' ? ' · Tool' : item.kind === 'paper' ? ' · Paper'
        : item.kind === 'post' ? ' · Post' : ''}</div>
      <h1 class="reader__title">${esc(item.title)}</h1>
      <div class="reader__byline">${metaLine(item)}</div>
    </header><div class="reader__rule"></div>`);

    (item.content || []).forEach((b, i) => {
      const marks = byBlock.get(i) || [];
      const flag = bookmarks.has(i)
        ? '<span class="bookmark-flag"><svg class="ic" viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></span>'
        : '';
      const page = b.page ? ` data-page="${b.page}"` : '';
      const attrs = `class="blk" data-i="${i}"${page}`;

      if (b.type === 'image') {
        if (!b.src) return;
        const fig = b.figure ? ' fig' : '';
        parts.push(`<figure class="blk${fig}" data-i="${i}"${page}>`
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
        const rows = (b.rows || []).map((r, ri) => '<tr>' + r.map((c) =>
          (ri === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('') + '</tr>').join('');
        parts.push(`<div class="tablewrap ${attrs.slice(7)}"><table>${rows}</table></div>`);
        return;
      }

      const inner = flag + blockHTML(b.text, marks);
      if (b.type === 'quote') parts.push(`<blockquote ${attrs}>${inner}</blockquote>`);
      else if (b.type === 'li') parts.push(`<li ${attrs}>${inner}</li>`);
      else if (PROSE.has(b.type) && b.type.startsWith('h')) parts.push(`<${b.type} ${attrs}>${inner}</${b.type}>`);
      else parts.push(`<p ${attrs}>${inner}</p>`);
    });

    this.root.innerHTML = parts.join('');
    this.renderEnd();
  }

  renderEnd() {
    const item = this.item;
    const done = item.status === 'finished';
    const src = item.url
      ? `<a class="btn" href="${esc(item.url)}" target="_blank" rel="noopener">
           <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-open"/></svg> Open the original</a>`
      : '';
    const pdf = item.original_file
      ? `<a class="btn" href="/api/items/${item.id}/original" target="_blank" rel="noopener">
           <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-file"/></svg> The original PDF</a>`
      : '';
    this.endRoot.innerHTML = `
      <div class="reader__rule"></div>
      <button class="btn ${done ? '' : 'btn--primary'}" id="btn-finish">
        <svg class="ic ic--sm" viewBox="0 0 24 24"><use href="#i-check"/></svg>
        ${done ? 'Mark as unread' : 'Mark as finished'}
      </button>
      <div style="height:10px"></div>${src}${src && pdf ? '<div style="height:10px"></div>' : ''}${pdf}`;

    const btn = this.endRoot.querySelector('#btn-finish');
    if (btn) {
      btn.onclick = async () => {
        const next = done ? 'unread' : 'finished';
        await api.patchItem(this.item.id, { status: next });
        this.item.status = next;
        this.item.progress_words = next === 'finished' ? this.item.word_count : 0;
        this.progressWords = this.item.progress_words;
        this.renderEnd();
        this.paintProgress();
        if (this.hooks.onChange) this.hooks.onChange();
      };
    }
  }

  /** Show images from local storage when the network is not available. */
  async resolveImages() {
    const imgs = [...this.root.querySelectorAll('img[data-msrc]')];
    await Promise.all(imgs.map(async (img) => {
      const url = img.getAttribute('data-msrc');
      try {
        const blob = await store.getMedia(url);
        if (blob) {
          const objectUrl = URL.createObjectURL(blob);
          this.objectUrls.push(objectUrl);
          img.src = objectUrl;
          return;
        }
      } catch { /* fall through to the network copy */ }
      img.src = url;
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

  handleScroll() {
    const total = this.item.word_count || 0;
    if (!total) return;
    const blocks = this.proseBlocks();
    // A detached first block means the cache outlived its article. Measuring it would
    // report every block as scrolled past.
    if (!blocks.length || !blocks[0].el.isConnected) {
      this._prose = null;
      return;
    }
    const bottom = window.scrollY + window.innerHeight;

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
      } else {
        break;
      }
    }

    if (words > this.progressWords) {
      this.progressWords = Math.min(words, total);
      this.paintProgress();
      this.scheduleSave();
    }
    this.resumeWords = words;
  }

  paintProgress() {
    const total = this.item.word_count || 1;
    const pct = Math.max(0, Math.min(100, Math.round((100 * this.progressWords) / total)));
    if (this.hooks.onProgress) this.hooks.onProgress(pct, this.progressWords, total);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api.sendProgress(this.item.id, this.progressWords, this.resumeWords || 0)
        .then(() => { if (this.hooks.onChange) this.hooks.onChange(); })
        .catch(() => {});
    }, 900);
  }

  flush() {
    clearTimeout(this.saveTimer);
    if (!this.item) return Promise.resolve();
    return api.sendProgress(this.item.id, this.progressWords, this.resumeWords || 0)
      .catch(() => {});
  }

  restorePosition() {
    const resume = this.item.resume_words || 0;
    if (resume < 20) return;
    const target = this.proseBlocks().find(({ block }) => block.start + block.words >= resume);
    if (target) {
      const y = target.el.offsetTop - 90;
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
    }
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
    let endChar = startChar + range.toString().length;

    // A selection dragged past the end of this block stops at its end.
    endChar = Math.min(endChar, text.length);
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
    return { block_index: index, start_word: startWord, end_word: endWord, quote, rect: range.getBoundingClientRect() };
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

  /** Where in the article, in words, is a block-relative position. */
  absoluteWord(blockIndex, startWord) {
    const block = this.item.content[blockIndex];
    return block ? (block.start || 0) + startWord : 0;
  }

  applyAnnotations(list) {
    this.annotations = list.filter((a) => !a.deleted);
    const scrollY = window.scrollY;
    this._prose = null;
    this.render();
    this.resolveImages();
    window.scrollTo({ top: scrollY, behavior: 'auto' });
  }
}
