# 01 — Inline marks survive extraction

**What to build:** A saved article keeps the marks its author wrote inside a
paragraph. A link is still a link, bold is still bold, italic is still italic,
inline code is still code, and struck-through text is still struck through.

**Why this first:** `flatten()` in `js/extract/html.js` calls `textOf(el)`, which is
`el.textContent`. Every link, every `<strong>`, every `<code>` is destroyed at the
moment of extraction, before anything is stored. Measured on 15 saved pages: 0 links
kept out of the 938 Readability finds, 0 emphasis runs, 0 code runs. No amount of
work in the reader can recover them, because the loss is upstream of storage.

**Design decision:** a block keeps `text` as a plain string, exactly as today, and
gains `spans` — an array of `{ s, e, k }` character ranges into that same string,
where `k` names the mark and a link also carries `href`.

The alternative, storing a nested tree per block, was rejected. Reading progress,
highlight anchors and search all index into `text` by word offset. Keeping `text` as
the single spine means none of those change and no saved article needs migrating.

**Blocked by:** None — can start immediately.

**Status:** done — verified 2026-08-22 on a Pixel 7

- [x] A new module turns an element's children into `{ text, spans }`
- [x] Whitespace is collapsed during the walk, so offsets stay true
- [x] `<a>` becomes a span carrying an absolute href; a relative one is resolved
- [x] strong, b, em, i, code, kbd, samp, del, s, sup, sub and mark all map to marks
- [x] Nested and adjacent marks come out flat, merged, and free of empty ranges
- [x] `text` is character-for-character what the old code produced, so word offsets hold
