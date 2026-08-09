/* The normalised document format shared by every extractor.

   A document is a flat list of blocks. Each block carries the running word offset of
   its first word, so any word in the document has one stable global index. That single
   choice makes two features exact rather than approximate:

     * reading progress, measured word by word;
     * highlight anchors, stored as (block, start word, end word) instead of DOM
       offsets, so they survive re-rendering, font changes and reflow. */

export const PROSE_TYPES = new Set(['p', 'li', 'quote', 'h1', 'h2', 'h3', 'h4']);

export function countWords(text) {
  const m = String(text || '').match(/\S+/g);
  return m ? m.length : 0;
}

export function makeBlock(type, text = '', extra = {}) {
  return { type, text, ...extra };
}

/** Assign word offsets and indices. Returns { blocks, words, plain }. */
export function finalise(blocks) {
  const cleaned = [];
  for (const b of blocks) {
    const text = (b.text || '').trim();
    if (PROSE_TYPES.has(b.type) && !text) continue;
    if (b.type === 'code' && !text) continue;
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
    if (PROSE_TYPES.has(b.type)) {
      b.words = countWords(b.text);
      total += b.words;
    } else {
      b.words = 0;
    }
  });

  const plain = deduped
    .filter((b) => PROSE_TYPES.has(b.type) && b.text)
    .map((b) => b.text)
    .join('\n\n');

  return { blocks: deduped, words: total, plain };
}

export function excerptFrom(blocks, limit = 280) {
  const clip = (text) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
  for (const b of blocks) {
    if (b.type === 'p' && b.text.length > 80) return clip(b.text);
  }
  for (const b of blocks) {
    if (PROSE_TYPES.has(b.type) && b.text) return clip(b.text);
  }
  return '';
}
