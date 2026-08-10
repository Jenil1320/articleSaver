/* Figures and tables from a PDF.

   Text extraction alone loses the charts, diagrams and ruled tables that carry much of
   the meaning in a report. This module finds those regions and renders them as images,
   which are then placed back into the reading flow at the point where they appear.

   Method: collect every non-text drawing primitive from a page, discard page-sized
   background boxes, cluster what remains by proximity, keep clusters large enough to be
   a real figure, then render each region from the page.

   A ruled table is a dense cluster of thin lines, so it survives as a picture of the
   table while its text stays in the prose blocks — searchable and highlightable.

   Decorative artwork is deliberately excluded, on either of two tests:

     * text inside the region — axis labels, a legend, cell values;
     * a caption beside it — "Figure 3:", "Table 2", "Source:".

   A chart drawn with live text passes the first. A diagram exported as one flat image,
   with its labels baked into the pixels, passes the second. A banner photograph across
   the top of a section passes neither, which is the point.

   All coordinates here are device coordinates at scale 1: the same units as PDF
   points, but with y measured downwards from the top of the page, matching how the
   text lines are measured. */

const CAPTION_RE = /^\s*(figure|fig\.?|table|chart|exhibit|diagram|box|plate|source|note)\b\s*[\dIVXivx]*\s*[.:)\-–—]?/i;

const CAPTION_GAP = 46;       // points; a caption sits close to what it describes
const MIN_W = 90;             // points; narrower than this is a rule or an icon
const MIN_H = 60;
const MIN_AREA_SHARE = 0.030; // of the page
// Above this share of the page, a box is a background tint, not a figure. Ember
// reports paint one at 91.6% of the page: with a laxer cutoff it survives, the
// cluster pass merges every chart on the page into it, and the result is either
// a full-page "figure" (the old failure) or, once rejected, no figure at all
// (the charts vanish inside the merged region). A true full-page plate is lost
// to this cutoff, but a full-page render is exactly what a reader complains of.
const MAX_AREA_SHARE = 0.85;
const MERGE_GAP = 14;         // points; primitives closer than this belong together
export const MAX_FIGURES = 80;
const RENDER_SCALE = 2.0;
const PAD = 6;                // points of breathing room around a region
const MIN_LABELS = 2;         // text runs inside a region before it counts as explanatory
const MAX_PIXELS = 1500;      // cap the long edge; a phone never needs more
const JPEG_ABOVE = 320 * 1024; // switch a heavy PNG to JPEG rather than fill the device

/* ── reading the drawing operators ───────────────────────────────────── */

/* Matrix helpers written out rather than borrowed from pdf.js, so a change to its
   internal helper signatures cannot quietly change what a figure's bounds mean. */

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

const point = (x, y, m) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** An axis-aligned box, mapped through a matrix and re-squared. */
function mapBox(box, matrix) {
  const [x0, y0, x1, y1] = box;
  const corners = [
    point(x0, y0, matrix), point(x1, y0, matrix),
    point(x1, y1, matrix), point(x0, y1, matrix),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const out = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return out.every(Number.isFinite) ? out : null;
}

/**
 * Every drawing primitive on a page, as boxes in device coordinates.
 *
 * Text is skipped: it is read by the text pass, and treating it as artwork would
 * make a candidate figure out of every paragraph.
 *
 * pdf.js hands each path over with its own bounding box already measured, in the
 * user space current at the time it was built, so the work here is to keep track of
 * the transform stack and map that box into the page.
 */
export async function graphicsOnPage(page, pdfjs) {
  const { OPS } = pdfjs;
  const viewport = page.getViewport({ scale: 1 });
  const list = await page.getOperatorList();

  const boxes = [];
  const imageBoxes = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];

  for (let n = 0; n < list.fnArray.length; n += 1) {
    const fn = list.fnArray[n];
    const args = list.argsArray[n];

    switch (fn) {
      case OPS.save:
        stack.push(ctm.slice());
        break;
      case OPS.restore:
        ctm = stack.pop() || ctm;
        break;
      case OPS.transform:
        ctm = mul(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm.slice());
        if (args && args[0]) ctm = mul(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() || ctm;
        break;
      case OPS.constructPath: {
        // args = [paintOperator, [pathBuffer], [minX, minY, maxX, maxY] | null]
        const minMax = args && args[2];
        if (minMax && minMax.length === 4) {
          const box = mapBox(minMax, mul(viewport.transform, ctm));
          if (box) boxes.push(box);
        }
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat: {
        // An image is drawn into the unit square, then placed by the current matrix.
        const box = mapBox([0, 0, 1, 1], mul(viewport.transform, ctm));
        if (box) {
          boxes.push(box);
          imageBoxes.push(box);
        }
        break;
      }
      default:
        break;
    }
  }
  return { boxes, imageBoxes, width: viewport.width, height: viewport.height };
}

/* ── turning primitives into figures ─────────────────────────────────── */

/** Merge boxes that touch or nearly touch into single regions. */
function cluster(boxes, gap = MERGE_GAP) {
  let regions = boxes.map((b) => b.slice());
  let changed = true;
  let guard = 0;
  while (changed && regions.length > 1 && guard < 40) {
    guard += 1;
    changed = false;
    const out = [];
    for (const box of regions) {
      let merged = false;
      for (const existing of out) {
        if (box[0] <= existing[2] + gap && existing[0] <= box[2] + gap
          && box[1] <= existing[3] + gap && existing[1] <= box[3] + gap) {
          existing[0] = Math.min(existing[0], box[0]);
          existing[1] = Math.min(existing[1], box[1]);
          existing[2] = Math.max(existing[2], box[2]);
          existing[3] = Math.max(existing[3], box[3]);
          merged = true;
          changed = true;
          break;
        }
      }
      if (!merged) out.push(box.slice());
    }
    regions = out;
  }
  return regions;
}

function mostlyInside(t, region) {
  const [rx0, ry0, rx1, ry1] = region;
  const area = Math.max(1e-6, (t.x1 - t.x0) * (t.y1 - t.y0));
  const ox = Math.max(0, Math.min(t.x1, rx1) - Math.max(t.x0, rx0));
  const oy = Math.max(0, Math.min(t.y1, ry1) - Math.max(t.y0, ry0));
  return (ox * oy) / area >= 0.6;
}

/** How many text runs sit mostly within this region. */
function labelsInside(texts, region) {
  let count = 0;
  for (const t of texts) {
    if (mostlyInside(t, region)) {
      count += 1;
      if (count >= MIN_LABELS) break;
    }
  }
  return count;
}

/**
 * What the text inside a region reads as. A chart's text is axis values, legend
 * entries and tick labels — short. A passage of the document is sentences — long.
 * The split tells a real figure from a page of prose that happens to sit inside
 * drawing primitives: a border, a background tint, a "Box 2" sidebar.
 */
function textCharacter(texts, region) {
  let inside = 0;
  let sentences = 0;
  for (const t of texts) {
    if (!t.text || !mostlyInside(t, region)) continue;
    inside += 1;
    if (t.text.split(/\s+/).filter(Boolean).length >= 7) sentences += 1;
  }
  return { inside, sentences };
}

/**
 * The caption belonging to this region, if there is one. A caption may sit below the
 * figure, above it (usual for tables), or inside the region's own bounding box, which
 * happens whenever the drawing primitives wrap around it.
 */
// A designator names the thing ("Table 3", "Figure 2"); an attribution annotates
// it ("Source:", "Note:"). When both sit beside a region, the designator is the
// caption, however much closer the attribution line happens to fall.
const DESIGNATOR_RE = /^\s*(figure|fig\.?|table|chart|exhibit|diagram|box|plate)\b/i;

function captionFor(texts, region) {
  const [rx0, ry0, rx1, ry1] = region;
  let best = '';
  let bestGap = CAPTION_GAP + 1;
  let bestRank = 2;

  for (const t of texts) {
    if (!t.text || !CAPTION_RE.test(t.text)) continue;
    // It has to line up with the figure horizontally to belong to it.
    const overlap = Math.min(t.x1, rx1) - Math.max(t.x0, rx0);
    if (overlap < Math.min(60, (rx1 - rx0) * 0.25)) continue;

    let gap;
    if (t.y0 > ry1) gap = t.y0 - ry1;        // wholly below the region
    else if (t.y1 < ry0) gap = ry0 - t.y1;   // wholly above it
    else gap = 0;                            // overlapping, so already part of the plate

    const rank = DESIGNATOR_RE.test(t.text) ? 0 : 1;
    if (gap <= CAPTION_GAP && (rank < bestRank || (rank === bestRank && gap < bestGap))) {
      best = t.text;
      bestGap = gap;
      bestRank = rank;
    }
  }
  return best.slice(0, 400);
}

// A raster image below these bounds is an icon, a logo or a thin banner strip
// rather than a chart or a plate.
const MIN_IMAGE_W = 200;
const MIN_IMAGE_H = 150;
const MIN_IMAGE_SHARE = 0.08;

/** The figure regions on one page, in reading order. */
export function regionsOnPage({ boxes, imageBoxes = [], texts, width, height }) {
  const pageArea = Math.max(1, width * height);
  if (!boxes.length) return [];

  // Drop page-sized boxes first, or every primitive merges into one region.
  const usable = [];
  for (const [x0, y0, x1, y1] of boxes) {
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0.4 || h <= 0.4) continue;
    if ((w * h) / pageArea > MAX_AREA_SHARE) continue;
    usable.push([x0, y0, x1, y1]);
  }
  if (!usable.length) return [];

  const found = [];
  for (const box of cluster(usable)) {
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    const share = (w * h) / pageArea;
    if (w < MIN_W || h < MIN_H) continue;
    if (share < MIN_AREA_SHARE || share > MAX_AREA_SHARE) continue;

    const caption = captionFor(texts, box);
    if (!caption && labelsInside(texts, box) < MIN_LABELS) continue;  // artwork, not a chart

    // A region whose text is mostly sentences is a passage of the document — a
    // bordered page, a shaded panel, a "Box" sidebar — not a chart. Its words are
    // already in the prose flow, and rendering it too would show the reader the
    // same text twice, once as a picture. Two exceptions are trusted: a ruled
    // table (kept as an image by design, cells searchable in the text), and a
    // caption that formally numbers a figure — "Figure 4:", "Chart 1 —" — which
    // an author only writes under a real figure. A passing mention in prose
    // ("Figure 3 shows…") has no delimiter after the number and is not trusted.
    if (!/^\s*(table\b|(figure|fig\.?|chart|exhibit|diagram|plate)\s*[\dIVXivx]+\s*[.:)\-–—])/i.test(caption)) {
      const { inside, sentences } = textCharacter(texts, box);
      if (inside >= 3 && sentences >= 3 && sentences / inside >= 0.5) continue;
    }
    found.push({ box, caption });
  }

  // A large raster image is a figure in its own right. A chart or a diagram
  // exported as pixels carries its labels inside the image, so no live text and
  // often no caption will ever vouch for it — the tests above reject it, and the
  // reader is left with prose pointing at a picture that is not there.
  for (const box of imageBoxes) {
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    const share = (w * h) / pageArea;
    if (w < MIN_IMAGE_W || h < MIN_IMAGE_H) continue;
    if (share < MIN_IMAGE_SHARE || share > MAX_AREA_SHARE) continue;
    const alreadyKept = found.some((f) => {
      const ox = Math.max(0, Math.min(f.box[2], box[2]) - Math.max(f.box[0], box[0]));
      const oy = Math.max(0, Math.min(f.box[3], box[3]) - Math.max(f.box[1], box[1]));
      return (ox * oy) / Math.max(1e-6, w * h) >= 0.5;
    });
    if (alreadyKept) continue;
    // fromImage marks that the region's labels live inside the pixels: any live
    // text overlapping it is overlay text — a title across a cover picture — and
    // the caller must not drop it as a chart label.
    found.push({ box: box.slice(), caption: captionFor(texts, box), fromImage: true });
  }

  // Reading order: top of the page first.
  found.sort((a, b) => a.box[1] - b.box[1]);
  return found;
}

/* ── rendering ───────────────────────────────────────────────────────── */

const toBlob = (canvas, type, quality) => new Promise((resolve) => {
  canvas.toBlob(resolve, type, quality);
});

/** Render one region of a page to an image blob. */
export async function renderRegion(page, box, pageWidth, pageHeight) {
  const left = Math.max(0, box[0] - PAD);
  const top = Math.max(0, box[1] - PAD);
  const right = Math.min(pageWidth, box[2] + PAD);
  const bottom = Math.min(pageHeight, box[3] + PAD);
  if (right - left < 8 || bottom - top < 8) return null;

  let scale = RENDER_SCALE;
  const longEdge = Math.max(right - left, bottom - top) * scale;
  if (longEdge > MAX_PIXELS) scale *= MAX_PIXELS / longEdge;

  const viewport = page.getViewport({
    scale,
    offsetX: -left * scale,
    offsetY: -top * scale,
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((right - left) * scale));
  canvas.height = Math.max(1, Math.round((bottom - top) * scale));
  const context = canvas.getContext('2d', { alpha: false });
  // A transparent chart on a dark page would vanish; PDFs assume white paper.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;

  let blob = await toBlob(canvas, 'image/png');
  let type = 'png';
  // Photographic regions compress badly as PNG. Keep the device usable.
  if (blob && blob.size > JPEG_ABOVE) {
    const jpeg = await toBlob(canvas, 'image/jpeg', 0.82);
    if (jpeg && jpeg.size < blob.size) {
      blob = jpeg;
      type = 'jpg';
    }
  }
  const width = canvas.width;
  const height = canvas.height;
  // Release the backing store now rather than waiting for a collection: a long
  // report renders dozens of these.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  return { blob, type, width, height };
}
