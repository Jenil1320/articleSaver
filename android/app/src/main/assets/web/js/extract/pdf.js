/* PDF to readable blocks.

   Reports and papers are laid out for print, so the raw text stream is not readable
   prose. This pass rebuilds it: measure the body font size, promote larger lines to
   headings, drop the running header and footer, rejoin lines broken by the page
   width, and repair words split across a line break.

   Every block keeps its page number, so a bookmark can name a page.

   The whole pass runs on the phone. pdf.js reads the file, and the layout reasoning
   below is what turns its text runs back into paragraphs. */

import { excerptFrom, finalise, makeBlock } from './blocks.js';
import { lib, openDocument, pageRuns, fontNamesFor } from './pdfjs.js';
import { graphicsOnPage, regionsOnPage, renderRegion, MAX_FIGURES } from './figures.js';

const BULLET_RE = /^\s*([•‣◦⁃∙\-*·▪●]|\(?\d{1,2}[.)])\s+/;
const PAGE_NUM_RE = /^\s*(page\s+)?\d{1,4}(\s*(\/|of)\s*\d{1,4})?\s*$/i;
const HYPHEN_BREAK_RE = /([A-Za-zÀ-ɏ])-$/;
const TOKEN_RE = /[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*/g;

const squash = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');

/** Reject artefacts such as the rotated identifier strip down the side of a preprint. */
function isJunkLine(text) {
  if (text.length <= 1) return true;
  const tokens = text.split(/\s+/).filter(Boolean);
  // Text set sideways decomposes into a column of single characters.
  if (tokens.length >= 3 && tokens.filter((t) => t.length === 1).length / tokens.length > 0.75) {
    return true;
  }
  return !/[A-Za-z0-9]/.test(text);
}

/* ── page geometry ───────────────────────────────────────────────────── */

/**
 * A two-column page read straight across interleaves the columns. Look for a clear
 * gutter: a vertical line near the middle that almost no text run crosses.
 */
function splitColumns(runs, pageWidth) {
  if (runs.length < 40) return [runs];
  let best = null;
  for (let f = 0.40; f <= 0.601; f += 0.02) {
    const x0 = pageWidth * f;
    let straddle = 0;
    let left = 0;
    let right = 0;
    for (const r of runs) {
      const end = r.x + r.width;
      if (r.x < x0 - 2 && end > x0 + 2) straddle += 1;
      else if (end <= x0) left += 1;
      else right += 1;
    }
    const total = runs.length;
    if (straddle / total <= 0.02 && left / total >= 0.25 && right / total >= 0.25) {
      const balance = Math.abs(left - right);
      if (!best || balance < best.balance) best = { x0, balance };
    }
  }
  if (!best) return [runs];
  return [
    runs.filter((r) => (r.x + r.width) <= best.x0),
    runs.filter((r) => (r.x + r.width) > best.x0),
  ];
}

function lineFrom(group, page) {
  const items = [...group.items].sort((a, b) => a.x - b.x);
  let text = '';
  let prevEnd = null;
  for (const it of items) {
    if (prevEnd !== null) {
      const gap = it.x - prevEnd;
      if (gap > it.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.text)) text += ' ';
    }
    text += it.text;
    prevEnd = it.x + it.width;
  }
  text = squash(text);
  if (!text || isJunkLine(text)) return null;

  // The size that most of the characters are set in, not the largest one present.
  const weights = new Map();
  for (const it of items) {
    const key = Math.round(it.size * 10) / 10;
    weights.set(key, (weights.get(key) || 0) + it.text.length);
  }
  let size = items[0].size;
  let bestWeight = -1;
  for (const [value, weight] of weights) {
    if (weight > bestWeight) { bestWeight = weight; size = value; }
  }

  const fonts = items.map((it) => it.font).join(' ');
  const bold = /bold|black|heavy|semib/.test(fonts);

  const left = Math.min(...items.map((it) => it.x));
  const right = Math.max(...items.map((it) => it.x + it.width));

  return {
    text,
    size,
    bold,
    x0: Math.round(left * 10) / 10,
    x1: Math.round(right * 10) / 10,
    top: Math.round(group.y * 10) / 10,
    page,
  };
}

function linesFromColumn(runs, page) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  let current = null;
  for (const r of sorted) {
    if (current && Math.abs(r.y - current.y) <= Math.max(1.5, current.size * 0.45)) {
      current.items.push(r);
      if (r.size > current.size) current.size = r.size;
    } else {
      current = { y: r.y, size: r.size, items: [r] };
      groups.push(current);
    }
  }
  return groups.map((g) => lineFrom(g, page)).filter(Boolean);
}

/**
 * Axis labels, legend entries and tick values sit inside a chart. The picture already
 * shows them, and read back as prose they arrive as a stack of two-word fragments —
 * one of which then becomes a heading, because it is short and set in bold.
 *
 * A ruled table is left completely alone: its cells are the data, and keeping them in
 * the text is what makes a table searchable and highlightable.
 */
function dropChartLabels(lines, regions) {
  const charts = regions
    .filter((r) => !/^\s*table/i.test(r.caption || ''))
    .map((r) => r.box);
  if (!charts.length) return lines;

  return lines.filter((ln) => {
    if (ln.text.split(/\s+/).length >= 5) return true;   // a real sentence, not a label
    const midX = (ln.x0 + ln.x1) / 2;
    return !charts.some(([x0, y0, x1, y1]) =>
      midX >= x0 && midX <= x1 && ln.top >= y0 && ln.top <= y1);
  });
}

/* ── page pass ───────────────────────────────────────────────────────── */

async function readPages(doc, pdfjs, { withFigures, onProgress }) {
  const lines = [];
  const figurePages = [];
  const pageCount = doc.numPages;

  for (let n = 1; n <= pageCount; n += 1) {
    const page = await doc.getPage(n);
    let graphics = null;
    let fonts = null;
    try {
      if (withFigures) {
        // The operator list is needed for the drawings, and it is also what makes
        // pdf.js load the fonts, which is how a bold run-in heading is recognised.
        graphics = await graphicsOnPage(page, pdfjs);
        fonts = fontNamesFor(page);
      }

      const { runs, width, height } = await pageRuns(page, pdfjs, { fontNames: fonts });
      const upright = runs.filter((r) => r.upright && r.text.trim());

      let pageLines = [];
      for (const column of splitColumns(upright, width)) {
        pageLines.push(...linesFromColumn(column, n));
      }

      if (graphics && graphics.boxes.length) {
        // Caption matching works on whole lines. A caption runs to two or three of
        // them, and matching against single text runs would only ever catch the
        // first fragment.
        const texts = pageLines.map((ln) => ({
          x0: ln.x0,
          y0: ln.top - ln.size,
          x1: ln.x1,
          y1: ln.top + ln.size * 0.25,
          text: ln.text,
        }));
        const regions = regionsOnPage({ boxes: graphics.boxes, texts, width, height });
        if (regions.length) {
          figurePages.push({ page: n, regions, width, height });
          pageLines = dropChartLabels(pageLines, regions);
        }
      }
      lines.push(...pageLines);
    } finally {
      page.cleanup();
    }
    if (onProgress) onProgress(n, pageCount);
  }
  return { lines, pageCount, figurePages };
}

/* ── cleaning up the line stream ─────────────────────────────────────── */

/** Remove text that repeats near the top or bottom edge of many pages. */
function dropRunningMarginalia(lines, pageCount) {
  if (pageCount < 3) return lines.filter((ln) => !PAGE_NUM_RE.test(ln.text));

  const byNorm = new Map();
  for (const ln of lines) {
    const key = ln.text.toLowerCase().replace(/\d+/g, '#').trim();
    if (key.length > 3) {
      if (!byNorm.has(key)) byNorm.set(key, new Set());
      byNorm.get(key).add(ln.page);
    }
  }
  const threshold = Math.max(3, pageCount * 0.4);
  const repeated = new Set([...byNorm.entries()]
    .filter(([, pages]) => pages.size >= threshold)
    .map(([key]) => key));

  const extent = lines.reduce((m, ln) => Math.max(m, ln.top), 0) || 800;
  const marginTop = extent * 0.08;
  const marginBottom = extent * 0.90;

  return lines.filter((ln) => {
    if (PAGE_NUM_RE.test(ln.text)) return false;
    const key = ln.text.toLowerCase().replace(/\d+/g, '#').trim();
    const nearEdge = ln.top <= marginTop || ln.top >= marginBottom;
    return !(repeated.has(key) && nearEdge);
  });
}

function bodySize(lines) {
  const weights = new Map();
  for (const ln of lines) weights.set(ln.size, (weights.get(ln.size) || 0) + ln.text.length);
  let best = 10;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) { bestWeight = weight; best = size; }
  }
  return best;
}

function headingLevel(size, body, bold, text) {
  const ratio = body ? size / body : 1;
  if (ratio >= 1.55) return 'h1';
  if (ratio >= 1.28) return 'h2';
  if (ratio >= 1.12) return 'h3';
  // Same size but bold and short reads as a run-in heading.
  if (bold && ratio >= 1.0 && text.length < 90 && !/[.;,]$/.test(text)) return 'h3';
  return null;
}

/** Every word the document uses, for deciding what a line-ending hyphen means. */
function buildVocabulary(lines) {
  const vocab = new Set();
  for (const ln of lines) {
    const found = ln.text.match(TOKEN_RE);
    if (found) for (const tok of found) vocab.add(tok.toLowerCase());
  }
  return vocab;
}

/**
 * Join wrapped lines, repairing words the layout split across the line break.
 *
 * A hyphen at the end of a line is ambiguous. It may be a soft break inserted by
 * the typesetter ("col-" + "lectively"), or a real hyphen in a compound that simply
 * fell at the margin ("English-" + "to-German"). Removing it blindly corrupts the
 * second kind, which is how "English-to-German" becomes "Englishto-German".
 *
 * The document itself settles it: whichever form the text uses elsewhere is the form
 * that is meant. With no evidence either way, a soft break is far more common.
 */
function joinLines(parts, vocab) {
  let out = '';
  for (const part of parts) {
    if (!out) { out = part; continue; }
    if (HYPHEN_BREAK_RE.test(out)) {
      const head = out.match(TOKEN_RE);
      const tail = part.match(TOKEN_RE);
      let mergedOk = true;
      if (vocab && head && tail) {
        const stem = head[head.length - 1].replace(/-+$/, '').toLowerCase();
        const next = tail[0].toLowerCase();
        if (!vocab.has(`${stem}${next}`) && vocab.has(`${stem}-${next}`)) mergedOk = false;
      }
      out = (mergedOk ? out.slice(0, -1) : out) + part;
    } else {
      out = `${out} ${part}`;
    }
  }
  return out;
}

function assemble(lines, body, vocab) {
  const blocks = [];
  let buf = [];
  let bufPage = 1;
  let bufTop = 0;

  const flush = (type = 'p') => {
    if (!buf.length) return;
    let text = joinLines(buf, vocab).trim();
    text = text.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ');
    // `top` is kept only long enough to interleave the figures, then dropped.
    if (text) blocks.push(makeBlock(type, text, { page: bufPage, top: bufTop }));
    buf = [];
  };

  // A heading wider than the column is set over several lines; collect them so the
  // reader shows one heading rather than a stack of fragments.
  let headBuf = [];
  let headLevel = null;
  let headPage = 1;
  let headTop = 0;
  let headPrev = null;

  const flushHead = () => {
    if (headBuf.length && headLevel) {
      const text = joinLines(headBuf, vocab).trim();
      if (text) blocks.push(makeBlock(headLevel, text, { page: headPage, top: headTop }));
    }
    headBuf = [];
    headLevel = null;
    headPrev = null;
  };

  let prev = null;
  let pendingBullet = false;

  for (const ln of lines) {
    const level = headingLevel(ln.size, body, ln.bold, ln.text);
    const isBullet = BULLET_RE.test(ln.text);

    if (level) {
      flush(pendingBullet ? 'li' : 'p');
      pendingBullet = false;
      const continues = headLevel === level && headPrev
        && ln.page === headPrev.page
        && Math.abs(ln.size - headPrev.size) < 0.6
        && (ln.top - headPrev.top) >= 0 && (ln.top - headPrev.top) <= ln.size * 2.2;
      if (!continues) {
        flushHead();
        headLevel = level;
        headPage = ln.page;
        headTop = ln.top;
      }
      headBuf.push(ln.text);
      headPrev = ln;
      prev = ln;
      continue;
    }

    flushHead();

    if (isBullet) {
      flush(pendingBullet ? 'li' : 'p');
      pendingBullet = true;
      buf = [ln.text.replace(BULLET_RE, '')];
      bufPage = ln.page;
      bufTop = ln.top;
      prev = ln;
      continue;
    }

    // Decide whether this line continues the current paragraph.
    let startsNew = false;
    if (!prev) {
      startsNew = true;
    } else {
      const gap = ln.top - prev.top;
      if (ln.page !== prev.page) {
        // A page break usually continues a sentence rather than ending one.
        startsNew = /[.!?:”"]$/.test(prev.text);
      } else if (gap > ln.size * 2.1) {
        startsNew = true;
      } else if (ln.x0 - prev.x0 > 12 && /[.!?]$/.test(prev.text)) {
        startsNew = true;
      } else if (/[.!?]$/.test(prev.text) && /^[A-Z]/.test(ln.text) && gap > ln.size * 1.6) {
        startsNew = true;
      }
    }

    if (startsNew && buf.length) {
      flush(pendingBullet ? 'li' : 'p');
      pendingBullet = false;
    }
    if (!buf.length) { bufPage = ln.page; bufTop = ln.top; }

    buf.push(ln.text);
    prev = ln;
  }

  flushHead();
  flush(pendingBullet ? 'li' : 'p');
  return blocks;
}

/* ── titles ──────────────────────────────────────────────────────────── */

const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'of', 'on',
  'in', 'to', 'from', 'by', 'with', 'at', 'as', 'into', 'over', 'per', 'via', 'vs']);

/**
 * Cover pages are often set in capitals. A library of shouting titles reads badly.
 * Only titles that are almost entirely capitals are touched, and words holding a digit
 * are left alone so codes and years survive.
 */
export function tidyShoutyTitle(title) {
  const letters = [...title].filter((c) => /[a-z]/i.test(c));
  if (letters.length < 12) return title;
  if (letters.filter((c) => c === c.toUpperCase()).length / letters.length < 0.85) return title;

  const cap = (word) => word.split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join('-');

  return title.split(/\s+/).map((word, i) => {
    if (/\d/.test(word)) return word;
    const stripped = word.replace(/^[:;,.()[\]—–-]+|[:;,.()[\]—–-]+$/g, '').toLowerCase();
    if (i > 0 && SMALL_WORDS.has(stripped)) return word.toLowerCase();
    return cap(word);
  }).join(' ');
}

/* ── figures back into the flow ──────────────────────────────────────── */

/**
 * Place rendered figures into the text flow at the position they occupy on the page.
 * A chart or a ruled table is meaning, not decoration. Dropping it would leave the
 * reader with prose that refers to something they cannot see.
 */
function mergeFigures(blocks, figures) {
  const merged = [];
  const remaining = [...figures];
  const norm = (s) => squash(s || '').toLowerCase();

  // A caption is shown under its figure, so the same words must not also stand as a
  // paragraph. The caption found on the page is often only the first line of it, so
  // the match is a prefix either way round — and the fuller of the two wins, which is
  // how the figure ends up captioned with the whole sentence.
  // A figure's caption sits below it; a table's usually sits above. The match has to
  // work whichever side it falls on, so each figure keeps a slot that can be filled
  // before or after the picture itself is placed.
  const slots = figures.map((f) => ({
    fig: f, key: norm(f.caption), best: f.caption || '', block: null, taken: false,
  }));

  const emit = (fig) => {
    const slot = slots.find((s) => s.fig === fig);
    const block = makeBlock('image', slot.best.slice(0, 400), {
      src: '',
      page: fig.page,
      figure: true,
      blob: fig.blob,
      imageType: fig.type,
    });
    slot.block = block;
    merged.push(block);
  };

  for (const block of blocks) {
    const page = block.page || 0;
    const top = block.top || 0;
    // Anything that sits above this block on the same page, or on an earlier page,
    // belongs before it.
    while (remaining.length && (remaining[0].page < page
      || (remaining[0].page === page && remaining[0].top <= top))) {
      emit(remaining.shift());
    }

    const text = norm(block.text);
    let isCaption = false;
    if (text.length > 12) {
      for (const slot of slots) {
        if (slot.taken || slot.key.length < 12) continue;
        if (!text.startsWith(slot.key) && !slot.key.startsWith(text)) continue;
        slot.taken = true;
        if (block.text.length > slot.best.length) {
          slot.best = block.text;
          if (slot.block) slot.block.text = slot.best.slice(0, 400);
        }
        isCaption = true;
        break;
      }
    }
    if (!isCaption) merged.push(block);
  }

  for (const fig of remaining) emit(fig);
  return merged;
}

async function renderFigures(doc, figurePages, notes, onProgress) {
  const out = [];
  const planned = figurePages.reduce((n, p) => n + p.regions.length, 0);
  if (planned >= MAX_FIGURES) {
    notes.push(`Only the first ${MAX_FIGURES} charts and tables were kept. `
      + 'The full document is stored, and the text is complete.');
  }

  let done = 0;
  for (const entry of figurePages) {
    if (out.length >= MAX_FIGURES) break;
    const page = await doc.getPage(entry.page);
    try {
      for (const region of entry.regions) {
        if (out.length >= MAX_FIGURES) break;
        try {
          const image = await renderRegion(page, region.box, entry.width, entry.height);
          if (image) {
            out.push({
              page: entry.page,
              top: region.box[1],
              caption: region.caption,
              blob: image.blob,
              type: image.type,
            });
          }
        } catch {
          // One region that will not draw must not cost the reader the rest.
        }
        done += 1;
        if (onProgress) onProgress(done, planned);
      }
    } finally {
      page.cleanup();
    }
  }
  return out;
}

/* ── entry point ─────────────────────────────────────────────────────── */

export async function extract(data, {
  url = '', filename = '', withFigures = true, onProgress = null,
} = {}) {
  const pdfjs = await lib();
  let doc;
  try {
    doc = await openDocument(data);
  } catch (err) {
    if (String(err && err.name) === 'PasswordException') {
      throw new Error('That PDF is password protected, so Folio cannot read it.');
    }
    throw new Error('That file is not a readable PDF.');
  }

  const notes = [];
  let result;
  try {
    const say = (stage, done, total) => {
      if (onProgress) onProgress({ stage, done, total });
    };

    const { lines: rawLines, pageCount, figurePages } = await readPages(doc, pdfjs, {
      withFigures,
      onProgress: (n, total) => say('reading', n, total),
    });

    if (!rawLines.length) {
      throw new Error('No text could be read from this PDF. It is probably a scan of a '
        + 'printed page, which needs optical character recognition.');
    }

    const lines = dropRunningMarginalia(rawLines, pageCount);
    const body = bodySize(lines);
    const vocab = buildVocabulary(lines);
    let blocks = assemble(lines, body, vocab);

    // Title: the largest text on page one, else the file name.
    let title = '';
    const page1 = lines.filter((ln) => ln.page === 1);
    if (page1.length) {
      const biggest = Math.max(...page1.map((ln) => ln.size));
      if (biggest > body * 1.15) {
        title = page1.filter((ln) => ln.size >= biggest - 0.6)
          .slice(0, 3).map((ln) => ln.text).join(' ').trim();
      }
    }
    if (title.length > 220 || title.length < 4) title = '';
    if (!title) {
      title = (filename || 'Document').replace(/\.[^.]*$/, '').replace(/[-_]+/g, ' ').trim();
    }
    title = tidyShoutyTitle(title);

    // The reader renders the title itself, so a body block repeating it is noise.
    // It is not always first: an arXiv page puts a permission notice above it.
    const norm = squash(title).toLowerCase();
    blocks = blocks.filter((block, i) => !(i < 12 && ['h1', 'h2', 'h3'].includes(block.type)
      && squash(block.text).toLowerCase() === norm));

    // A "heading" that runs to sentence length and ends with a full stop is body text
    // set large or bold, not a heading. Rendering it as one shouts.
    for (const block of blocks) {
      if (['h2', 'h3'].includes(block.type) && block.text.length > 110
        && /[.!?]$/.test(block.text.trimEnd())) {
        block.type = 'p';
      }
    }

    if (withFigures && figurePages.length) {
      try {
        const figures = await renderFigures(doc, figurePages, notes,
          (done, total) => say('figures', done, total));
        if (figures.length) blocks = mergeFigures(blocks, figures);
      } catch (err) {
        // The text is the point; a figure pass that fails must not cost the reader
        // the document.
        console.warn('Figure extraction failed', err);
        notes.push('The charts and tables in this PDF could not be captured.');
      }
    }

    // `top` was only needed to place the figures.
    for (const b of blocks) delete b.top;

    const finalised = finalise(blocks);

    // A paper's own summary beats whichever paragraph happens to come first — page one
    // often opens with permission notices and author affiliations.
    let excerpt = excerptFrom(finalised.blocks);
    for (let i = 0; i < finalised.blocks.length; i += 1) {
      const block = finalised.blocks[i];
      if (block.type.startsWith('h')
        && ['abstract', 'summary', 'executive summary'].includes(block.text.trim().toLowerCase())) {
        const follows = finalised.blocks.slice(i + 1).find((b) => b.type === 'p' && b.words > 20);
        if (follows) {
          excerpt = follows.text.length > 280
            ? `${follows.text.slice(0, 279).trimEnd()}…` : follows.text;
        }
        break;
      }
    }

    let siteName = 'PDF';
    if (url.startsWith('http')) {
      try { siteName = new URL(url).hostname.replace(/^www\./, ''); } catch { siteName = 'PDF'; }
    }

    result = {
      title: title.slice(0, 300),
      byline: '',
      siteName,
      publishedAt: null,
      leadImage: null,
      canonicalUrl: url,
      content: finalised.blocks,
      wordCount: finalised.words,
      textPlain: finalised.plain,
      excerpt,
      pageCount,
      kindHint: 'paper',
      warnings: notes,
      signals: { ldTypes: [], ogType: '', description: '' },
    };
  } finally {
    try { await doc.destroy(); } catch { /* already gone */ }
  }
  return result;
}
