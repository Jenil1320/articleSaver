# 05 — Furniture is separated, not deleted

**What to build:** Comment threads, share rails, author bios, related-story strips,
newsletter cards, paywall pricing and job listings stop appearing in the middle of
articles. Anything the classifier is not sure about is kept and collapsed behind a
tap, never dropped.

**Why:** Scoring only lowers a chrome block's score, and a demoted block inside the
winning subtree still lands in the saved article. The Nature fixture is the worst
case: the extractor preferred the page furniture to the article and saved share
buttons, subscription prices, six related headlines, a subject list, a news feed and
nine job adverts, while the article itself is one paragraph behind a paywall. Ars
Technica leaks the author bio, the Verge leaks a related-story card, NPR leaks a
related-story link.

**Design decision:** two phases, because the constraint is asymmetric. Filtering must
be strict, but core content must never be lost, and one pass cannot honour both.

Phase one, inside `cleanTree`, removes only the unambiguous: explicit advertisement
markers, comment threads named as such, hidden elements, share rails.

Phase two runs after flattening, over the flat block list, where the shape of the
document is finally visible. It finds the **body span** — the stretch between the
first and the last substantial paragraph — and protects everything inside it. Only
the head, the tail, and isolated interlopers are judged, on link density, block
length and phrase signature. A confident verdict drops the block. Anything short of
confident is marked as an aside, and the reader collapses it behind a tap.

**Blocked by:** None — can start immediately.

**Status:** done — verified 2026-08-22 on a Pixel 7

- [x] The body span is found, and everything inside it is protected from the tail rules
- [x] Share rails, navigation labels and consent lines are dropped outright
- [x] Newsletter pitches, sponsor blocks, bios, related rails and pricing become asides
- [x] The reader shows an aside as one collapsed line that expands on a tap
- [x] No fixture loses a phrase it kept before the change
