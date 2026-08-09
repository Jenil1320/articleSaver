/* One place that knows how to start pdf.js, and the page-reading primitives the
   PDF and figure passes both need.

   pdf.js is bundled with the app. Nothing is fetched from a network to read a PDF,
   including the character maps and the standard font data, so a document opens the
   same with no signal. */

const BASE = '/assets/web/vendor/pdfjs/';

let libPromise = null;

export function lib() {
  if (!libPromise) {
    libPromise = import(`${BASE}pdf.min.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
      return pdfjs;
    });
  }
  return libPromise;
}

export async function openDocument(data) {
  const pdfjs = await lib();
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    // A phone has neither the memory nor the need for an eval-based fast path.
    isEvalSupported: false,
    disableFontFace: false,
  });
  return task.promise;
}

/**
 * Every text run on a page, in device coordinates with y measured downwards from
 * the top. Working in device space means a rotated page needs no special case:
 * the viewport transform has already put the text the right way up.
 */
export async function pageRuns(page, pdfjs, { fontNames = null } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: false });

  const runs = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string' || !item.str.length) continue;
    const t = pdfjs.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 1;
    // Text set sideways is a preprint's identifier strip or a rotated table label.
    const skew = Math.abs(t[1]) / size;
    runs.push({
      text: item.str,
      x: t[4],
      y: t[5],
      size,
      width: item.width || 0,
      upright: skew < 0.3,
      font: fontNames ? (fontNames.get(item.fontName) || '') : '',
      eol: !!item.hasEOL,
    });
  }
  return { runs, width: viewport.width, height: viewport.height };
}

/**
 * Raw font names, so a heading set in bold can be told from body text of the same
 * size. pdf.js only fills these in once a page's operator list has been built.
 */
export function fontNamesFor(page) {
  const map = new Map();
  const objs = page.commonObjs;
  if (!objs || !objs._objs) return map;
  for (const key of Object.keys(objs._objs)) {
    try {
      const data = objs._objs[key] && objs._objs[key].data;
      if (data && typeof data.name === 'string') map.set(key, data.name.toLowerCase());
      else if (data && typeof data.loadedName === 'string') map.set(key, data.loadedName.toLowerCase());
    } catch {
      // A font that will not describe itself simply reads as not bold.
    }
  }
  return map;
}
