# 02 — The reader paints marks and links

**What to build:** The reading page shows the marks that survived extraction, and a
tap on a link asks whether to open it in the browser or save it to Folio.

**Why:** Highlights are painted from word ranges the reader owns. Inline marks arrive
from the extractor as character ranges. The two overlap freely — a reader highlights
across a link all the time — so they cannot be painted in two independent passes
without one corrupting the other.

**Design decision:** one boundary sweep. Every span start and end becomes a cut point,
and the text is walked segment by segment; across one segment the set of open marks
never changes.

A stack carries the marks already open from one segment into the next, and only the
difference is written. The first version re-opened every mark at every segment, which
was correct but turned a link containing an italic word into two abutting links —
identical on screen, two links to anything listening. Where a highlight genuinely
crosses an author's mark the stack closes and re-opens it, so the markup stays properly
nested either way.

**Blocked by:** 01

**Status:** done — verified 2026-08-22 on a Pixel 7

- [x] Highlight ranges and inline spans merge into one ordered list of cuts
- [x] A highlight that straddles a link renders both, correctly nested
- [x] A newline inside a block renders as a line break, not as a space
- [x] Tapping a link opens a sheet: open in the browser, or save to Folio
- [x] Selecting text for a highlight still reports the right word range
