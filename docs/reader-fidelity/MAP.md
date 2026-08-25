# Map — reading fidelity

## Destination

An article saved from any source reads in Folio with the structure its author gave
it — headings, lists, emphasis, code, quotes, tables, pictures and working links —
set in Folio's own typography, with the publisher's furniture visibly separated from
the prose and never silently deleted.

## Notes

Domain: on-device article extraction (no server, no model). Everything runs in the
app's WebView, so every change has to hold up in a real browser.

Measured against `tests/bench.html`: 15 saved pages from 15 different publishing
stacks, scored on word coverage against Mozilla Readability, plus per-page phrases
that must survive and phrases that must not leak.

Decisions the user made before work started (2026-08-22):

- **Fidelity** — Folio's typography, the source's structure. Not the source's fonts.
- **Clutter** — both the reading page and the library are too heavy; reading page first.
- **Links** — tapping a link asks: open it in the browser, or save it to Folio.
- **Uncertain blocks** — kept, collapsed behind a tap. Never dropped silently.

## Measured, 2026-08-22

Both figures come from `tests/bench.html` over the same 15 saved pages, and from
`tests/unit.html` for the pieces that had to be exactly right.

| Signal | Before | After |
|---|---|---|
| Links preserved | 0 | 609 |
| Bold and italic runs | 0 | 202 |
| Inline code runs | 0 | 329 |
| Ordered list items numbered | 0 | 79 |
| Line breaks kept inside a paragraph | 0 | 63 |
| Boilerplate phrases leaking into the prose | 3 | 0 |
| Article phrases lost | 3 | 0 |
| Blocks folded away rather than deleted | — | 42 |
| Unit tests | none | 74, all passing |

Three of the original six failures turned out to be bad assertions rather than bad
extraction, and were corrected in `tests/expect.js`:

- The Verge's opening lines ("Only the British fleet stands before him") are the
  author's own device — the publisher's JSON-LD `articleBody` begins with them.
- Nature's "deception" appears only in the headline; the article itself is one
  paragraph behind a paywall.
- Stratechery's body says "generative AI", never "Gen AI".

Word coverage against Readability is 0.95 to 1.13 on every fixture except Nature,
which reads 0.73 because most of that page is furniture and is now folded away.
Two apparent shortfalls were the measurement, not the extraction: Readability counts
code listings as prose, and Folio does not, so the benchmark now counts them
separately.

## Decisions so far

- [01 — Inline marks survive extraction](issues/01-inline-marks.md) — a block keeps
  plain `text` as its spine and gains `spans`: character ranges naming links, bold,
  italic, code and strikethrough. Word offsets are untouched, so highlights and
  progress needed no migration and nothing already saved had to be rewritten.
  New file `js/extract/inline.js`.
- [02 — The reader paints marks and links](issues/02-render-marks.md) — one sweep
  over the block's cut points merges the author's marks with the reader's highlights,
  carrying open marks across on a stack so a link containing an italic word stays one
  link. Tapping a link asks whether to open it or save it. `js/reader.js`.
- [03 — Lists, breaks and quotes keep their shape](issues/03-structure.md) — list
  items carry whether they are ordered, their number and their depth; `<br>` becomes a
  newline; a multi-paragraph quotation stays quoted; a table takes its header row from
  the markup; a figure emits every picture it holds. `js/extract/html.js`.
- [04 — Pictures pick their largest source](issues/04-pictures.md) — every candidate
  address is measured and the widest wins, so a `<picture>` element's 1920-pixel
  source beats the `<img>` element's 465-pixel one. Pictures parked in `<noscript>`
  are lifted out before the tree is cleaned.
- [05 — Furniture is separated, not deleted](issues/05-boilerplate.md) — a second pass
  over the flat block list finds the body of the article, protects it and the
  apparatus that closes it, and judges only what falls outside. Certain furniture is
  dropped; anything less than certain is folded away with a label.
  New file `js/extract/boilerplate.js`.
- [06 — Pictures zoom](issues/06-zoom.md) — pinch about the midpoint, drag to pan
  within the picture's own edges, double tap in and back out. `js/app.js`.
- [07 — The reading page and the library breathe](issues/07-clutter.md) — the reading
  bar is down from six controls to four, with contents and focus moved into the menu
  where they are named rather than guessed at. Paragraph spacing now exceeds the line
  height, headings carry a rule above rather than a bar beside, and library cards drop
  the badges that repeated what the progress bar already said.

## Known and left alone

- Existing saved articles keep the copy they were saved with. Settings has
  **Read every article in again** to re-run the new reader across the library;
  progress and marks survive it.
- Wikimedia rate-limits picture requests hard. A long Wikipedia article still reports
  a few pictures it could not save, despite the existing back-off.

## Not yet specified

- Inline `<svg>` diagrams. Measured across the 15 saved pages: 1,455 inline `<svg>`
  elements, effectively all of them interface icons. Converting them would add noise,
  not pictures. Revisit only if a real chart is found lost this way.
- Same-page anchor links (Wikipedia footnote markers). They currently read as plain
  text. Making them jump within the reader is a separate piece of work.

## Out of scope

- Carrying the publisher's own CSS into the reader. Ruled out by the fidelity
  decision above: it breaks dark mode, the text-size slider, and the point of
  reading many sources in one place.
