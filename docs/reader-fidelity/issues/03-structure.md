# 03 — Lists, breaks and quotes keep their shape

**What to build:** A numbered list reads as numbered. A nested list reads as nested.
A line break inside a paragraph stays a line break. A multi-paragraph quotation stays
a quotation all the way down.

**Why:** Every list item is emitted as a bare `li`, so an ordered list and an
unordered list are indistinguishable and every nesting level is flattened to one.
`squash()` turns a `<br>` into a space, so an address, a verse or a stanza becomes
one run-on line. A `<blockquote>` holding several paragraphs recurses and emits them
as ordinary paragraphs, losing the quotation entirely. This is most of what "reads
like continuous lines of text" means.

**Blocked by:** 01

**Status:** done — verified 2026-08-22 on a Pixel 7

- [x] A list item carries whether it is ordered, its depth, and its number
- [x] The reader renders a real ordered list for ordered runs, and indents by depth
- [x] A `<br>` becomes a newline in the block text
- [x] A blockquote with several paragraphs stays quoted throughout
- [x] A definition list survives as its terms and definitions
- [x] A table with a real `<thead>` takes its header row from the markup, not position
- [x] A figure holding several pictures emits all of them
- [x] A picture caption is part of the article's searchable text
