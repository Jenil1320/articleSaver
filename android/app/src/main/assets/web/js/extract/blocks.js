/* The normalised document format shared by every extractor.

   A document is a flat list of blocks. Each block carries the running word offset of
   its first word, so any word in the document has one stable global index. That single
   choice makes two features exact rather than approximate:

     * reading progress, measured word by word;
     * highlight anchors, stored as (block, start word, end word) instead of DOM
       offsets, so they survive re-rendering, font changes and reflow.

   A block's `text` is plain. The marks its author wrote — links, bold, italic, code —
   live beside it in `spans`, as character ranges into that same string. Because the
   spine never changes shape, a word offset means the same thing whether or not the
   block turned out to carry marks, and an article saved before marks existed still
   reads and still keeps its highlights. */

export const PROSE_TYPES = new Set(['p', 'li', 'quote', 'h1', 'h2', 'h3', 'h4']);

export function countWords(text) {
  const m = String(text || '').match(/\S+/g);
  return m ? m.length : 0;
}

export function makeBlock(type, text = '', extra = {}) {
  return { type, text, ...extra };
}

/**
 * Move every character range by the same amount and clip it to the text.
 *
 * `finalise` trims a block's text, and an untrimmed leading space would otherwise
 * leave every mark in that block pointing one character too far to the right.
 */
function shiftSpans(spans, by, length) {
  const out = [];
  for (const span of spans) {
    const s = Math.max(0, span.s - by);
    const e = Math.min(length, span.e - by);
    if (e > s) out.push({ ...span, s, e });
  }
  return out;
}

/** Assign word offsets and indices. Returns { blocks, words, plain }. */
export function finalise(blocks) {
  const cleaned = [];
  for (const b of blocks) {
    const raw = b.text || '';
    const text = raw.trim();
    if (PROSE_TYPES.has(b.type) && !text) continue;
    if (b.type === 'code' && !text) continue;
    if (b.spans && b.spans.length && text !== raw) {
      const lead = raw.length - raw.replace(/^\s+/, '').length;
      b.spans = shiftSpans(b.spans, lead, text.length);
    }
    if (b.spans && !b.spans.length) delete b.spans;
    b.text = text;
    cleaned.push(b);
  }

  // Collapse runs of duplicate headings and rules that survive extraction.
  const deduped = [];
  for (const b of cleaned) {
    const prev = deduped[deduped.length - 1];
    if (prev && b.type === prev.type
      && ['hr', 'h1', 'h2', 'h3'].includes(b.type) && b.text === prev.text) continue;
    deduped.push(b);
  }

  let total = 0;
  deduped.forEach((b, i) => {
    b.i = i;
    b.start = total;
    // A block set aside as the publisher's furniture is still in the document and can
    // still be opened, but it is not the article. Counting its words would put a
    // newsletter card into the reading time and let a related-story rail push the
    // progress bar along on its own.
    if (PROSE_TYPES.has(b.type) && !b.aside) {
      b.words = countWords(b.text);
      total += b.words;
    } else {
      b.words = 0;
    }
  });

  // What search and the theme rules read. A picture's caption is part of what the
  // article says, so it belongs here even though it carries no reading progress.
  const plain = deduped
    .filter((b) => !b.aside && (PROSE_TYPES.has(b.type) || b.type === 'image') && b.text)
    .map((b) => b.text)
    .join('\n\n');

  return { blocks: deduped, words: total, plain };
}

export function excerptFrom(blocks, limit = 280) {
  const clip = (text) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
  for (const b of blocks) {
    if (b.type === 'p' && !b.aside && b.text.length > 80) return clip(b.text);
  }
  for (const b of blocks) {
    if (PROSE_TYPES.has(b.type) && !b.aside && b.text) return clip(b.text);
  }
  return '';
}
