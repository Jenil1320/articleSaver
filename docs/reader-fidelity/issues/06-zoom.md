# 06 — Pictures zoom

**What to build:** Tapping a picture opens it full screen, and it can then be pinched
to zoom, dragged to pan, and double-tapped to zoom in and back out.

**Why:** The overlay already exists, but it paints one `object-fit: contain` image
with no gesture handling at all. A dense chart opens at exactly the size at which it
was already unreadable, which is the complaint.

**Blocked by:** None — can start immediately.

**Status:** done — verified 2026-08-22 on a Pixel 7

- [x] Pinching zooms about the midpoint between the two fingers
      *(the arithmetic is shared with the double tap, which was tested on the phone;
      a two-finger pinch itself cannot be driven over adb and was not)*
- [x] A double tap zooms in, and a second double tap returns to fit
- [x] Dragging pans, and panning stops at the picture's edges
- [x] Releasing below the fitted size springs back to it
- [x] The Android back button closes the viewer before it leaves the article
- [x] The caption stays legible over the picture
