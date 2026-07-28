"""Figures and tables from a PDF.

Text extraction alone loses the charts, diagrams and ruled tables that carry much of
the meaning in a report. This module finds those regions and renders them as images,
which are then placed back into the reading flow at the point where they appear.

Method: collect every non-text drawing primitive from a page, discard page-sized
background boxes, cluster what remains by proximity, keep clusters large enough to be
a real figure, then render each region from the page at print resolution.

A ruled table is a dense cluster of thin lines, so it survives as a picture of the
table while its text stays in the prose blocks — searchable and highlightable.

Decorative artwork is deliberately excluded, on either of two tests:

  * text inside the region — axis labels, a legend, cell values;
  * a caption beside it — "Figure 3:", "Table 2", "Source:".

A chart drawn with live text passes the first. A diagram exported as one flat image,
with its labels baked into the pixels, passes the second. A banner photograph across
the top of a section passes neither, which is the point. Captions found this way are
kept and shown under the figure.
"""
from __future__ import annotations

import io
import re

from pdfminer.layout import (
    LAParams, LTCurve, LTFigure, LTImage, LTLine, LTRect, LTTextContainer,
)

CAPTION_RE = re.compile(
    r"^\s*(figure|fig\.?|table|chart|exhibit|diagram|box|plate|source|note)\b\s*"
    r"[\dIVXivx]*\s*[.:)\-–—]?",
    re.I,
)
CAPTION_GAP = 46.0      # points; a caption sits close to what it describes

MIN_W = 90.0            # points; narrower than this is a rule or an icon
MIN_H = 60.0
MIN_AREA_SHARE = 0.030  # of the page
MAX_AREA_SHARE = 0.92   # above this it is a page background, not a figure
MERGE_GAP = 14.0        # points; primitives closer than this belong together
MAX_FIGURES = 80
RENDER_SCALE = 2.0
PAD = 6.0               # points of breathing room around a region
MIN_LABELS = 2          # text runs inside a region before it counts as explanatory
MAX_PIXELS = 1500       # cap the long edge; a phone never needs more
JPEG_ABOVE = 320 * 1024  # switch a heavy PNG to JPEG rather than fill the device


def _boxes_on_page(layout) -> tuple[list[tuple], list[tuple]]:
    """Return (graphic boxes, text boxes) for one page, in PDF coordinates."""
    graphics: list[tuple] = []
    texts: list[tuple] = []

    def walk(container, depth=0):
        for el in container:
            if isinstance(el, LTTextContainer):
                texts.append((el.x0, el.y0, el.x1, el.y1,
                              " ".join((el.get_text() or "").split())))
                continue
            if isinstance(el, (LTImage,)):
                graphics.append((el.x0, el.y0, el.x1, el.y1))
                continue
            if isinstance(el, LTFigure):
                # A figure groups its own primitives; descend so nested text is
                # recognised as text rather than swallowed into the drawing.
                if depth < 4:
                    walk(el, depth + 1)
                else:
                    graphics.append((el.x0, el.y0, el.x1, el.y1))
                continue
            if isinstance(el, (LTCurve, LTRect, LTLine)):
                graphics.append((el.x0, el.y0, el.x1, el.y1))

    walk(layout)
    return graphics, texts


def _cluster(boxes: list[tuple], gap: float = MERGE_GAP) -> list[tuple]:
    """Merge boxes that touch or nearly touch into single regions."""
    regions = [list(b) for b in boxes]
    changed = True
    while changed and len(regions) > 1:
        changed = False
        out: list[list[float]] = []
        for box in regions:
            merged = False
            for existing in out:
                if (box[0] <= existing[2] + gap and existing[0] <= box[2] + gap
                        and box[1] <= existing[3] + gap and existing[1] <= box[3] + gap):
                    existing[0] = min(existing[0], box[0])
                    existing[1] = min(existing[1], box[1])
                    existing[2] = max(existing[2], box[2])
                    existing[3] = max(existing[3], box[3])
                    merged = True
                    changed = True
                    break
            if not merged:
                out.append(list(box))
        regions = out
    return [tuple(r) for r in regions]


def _labels_inside(texts: list[tuple], region: tuple) -> int:
    """How many text runs sit mostly within this region."""
    rx0, ry0, rx1, ry1 = region
    count = 0
    for (x0, y0, x1, y1, _t) in texts:
        area = max(1e-6, (x1 - x0) * (y1 - y0))
        ox = max(0.0, min(x1, rx1) - max(x0, rx0))
        oy = max(0.0, min(y1, ry1) - max(y0, ry0))
        if (ox * oy) / area >= 0.6:
            count += 1
            if count >= MIN_LABELS:
                break
    return count


def _caption_for(texts: list[tuple], region: tuple) -> str:
    """The caption belonging to this region, if there is one.

    A caption may sit below the figure, above it (usual for tables), or within the
    region's own bounding box — which happens whenever the drawing primitives wrap
    around the caption, as they do on a full-page plate.
    """
    rx0, ry0, rx1, ry1 = region
    best, best_gap = "", CAPTION_GAP + 1

    for (x0, y0, x1, y1, text) in texts:
        if not text or not CAPTION_RE.match(text):
            continue
        # It has to line up with the figure horizontally to belong to it.
        overlap = min(x1, rx1) - max(x0, rx0)
        if overlap < min(60.0, (rx1 - rx0) * 0.25):
            continue

        if y1 < ry0:
            gap = ry0 - y1            # wholly below the region
        elif y0 > ry1:
            gap = y0 - ry1            # wholly above it
        else:
            gap = 0.0                 # overlapping, so already part of the plate

        if gap <= CAPTION_GAP and gap < best_gap:
            best, best_gap = text, gap
    return best[:400]


def find_regions(data: bytes) -> dict[int, list[tuple]]:
    """Map page number (1-based) to the figure regions found on it."""
    from pdfminer.high_level import extract_pages

    found: dict[int, list[tuple]] = {}
    laparams = LAParams(line_margin=0.35, char_margin=2.0, word_margin=0.12, boxes_flow=0.5)

    for pno, layout in enumerate(extract_pages(io.BytesIO(data), laparams=laparams), start=1):
        page_area = max(1.0, (layout.width or 612) * (layout.height or 792))
        graphics, texts = _boxes_on_page(layout)
        if not graphics:
            continue

        # Drop page-sized boxes first, or every primitive merges into one region.
        usable = []
        for (x0, y0, x1, y1) in graphics:
            w, h = x1 - x0, y1 - y0
            if w <= 0.4 or h <= 0.4:
                continue
            if (w * h) / page_area > MAX_AREA_SHARE:
                continue
            usable.append((x0, y0, x1, y1))
        if not usable:
            continue

        regions = []
        for (x0, y0, x1, y1) in _cluster(usable):
            w, h = x1 - x0, y1 - y0
            area_share = (w * h) / page_area
            if w < MIN_W or h < MIN_H:
                continue
            if area_share < MIN_AREA_SHARE or area_share > MAX_AREA_SHARE:
                continue
            box = (x0, y0, x1, y1)
            caption = _caption_for(texts, box)
            if not caption and _labels_inside(texts, box) < MIN_LABELS:
                continue      # artwork, not a chart or a table
            regions.append((box, caption))

        if regions:
            # Reading order: top of the page first.
            regions.sort(key=lambda r: -r[0][3])
            found[pno] = regions
    return found


def render_regions(data: bytes, regions_by_page: dict[int, list[tuple]],
                   limit: int = MAX_FIGURES) -> list[dict]:
    """Render each region to PNG bytes. Returns dicts with page, top and image data."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return []

    out: list[dict] = []
    pdf = pdfium.PdfDocument(data)
    try:
        for pno in sorted(regions_by_page):
            if len(out) >= limit:
                break
            try:
                page = pdf[pno - 1]
            except IndexError:
                continue
            width, height = page.get_size()

            for (x0, y0, x1, y1), caption in regions_by_page[pno]:
                if len(out) >= limit:
                    break
                left = max(0.0, x0 - PAD)
                bottom = max(0.0, y0 - PAD)
                right = max(0.0, width - min(width, x1 + PAD))
                top = max(0.0, height - min(height, y1 + PAD))
                if width - left - right < 8 or height - bottom - top < 8:
                    continue
                try:
                    bitmap = page.render(scale=RENDER_SCALE, crop=(left, bottom, right, top))
                    image = bitmap.to_pil().convert("RGB")
                except Exception:
                    continue

                if max(image.size) > MAX_PIXELS:
                    from PIL import Image
                    ratio = MAX_PIXELS / max(image.size)
                    image = image.resize(
                        (max(1, int(image.width * ratio)), max(1, int(image.height * ratio))),
                        Image.LANCZOS,
                    )

                buf = io.BytesIO()
                image.save(buf, format="PNG", optimize=True)
                payload, suffix = buf.getvalue(), ".png"
                # Photographic regions compress badly as PNG. Keep the device usable.
                if len(payload) > JPEG_ABOVE:
                    jbuf = io.BytesIO()
                    image.save(jbuf, format="JPEG", quality=82, optimize=True, progressive=True)
                    if jbuf.tell() < len(payload):
                        payload, suffix = jbuf.getvalue(), ".jpg"

                out.append({
                    "page": pno,
                    # Distance from the top of the page, matching how text lines are measured.
                    "top": height - y1,
                    "bottom": height - y0,
                    "png": payload,
                    "suffix": suffix,
                    "caption": caption,
                })
    finally:
        try:
            pdf.close()
        except Exception:
            pass
    return out


def extract_figures(data: bytes) -> list[dict]:
    regions = find_regions(data)
    if not regions:
        return []
    return render_regions(data, regions)
