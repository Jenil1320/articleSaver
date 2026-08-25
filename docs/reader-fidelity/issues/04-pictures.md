# 04 — Pictures pick their largest source

**What to build:** A saved picture is the largest version the page offers, not the
smallest, and pictures parked inside `<noscript>` for readers without JavaScript are
found rather than thrown away.

**Why:** `pickImageSource` builds a list of candidates and returns the first that is
not empty. The `<img>` element's own srcset comes before the `<picture>` element's
source list, so a 465-pixel mobile variant wins over the 1920-pixel one sitting right
beside it in the same markup. Measured: the Guardian article saved all three of its
photographs at 465 pixels wide. Across the 15 saved pages there are 73 source
elements this affects, on the BBC, the Guardian, NPR, Medium, Substack and Wikipedia.

`cleanTree` removes every `<noscript>` before anything looks inside it. A lazy-loading
site that parks the real `<img>` there loses the picture outright.

**Blocked by:** None — can start immediately.

**Status:** done — verified 2026-08-22 on a Pixel 7

- [x] Every candidate address is measured, and the widest across all of them wins
- [x] A picture element's source list is considered even when the img has its own srcset
- [x] A noscript holding only image markup is unwrapped before the tree is cleaned
- [x] A tracking pixel or an advertisement image is still rejected
