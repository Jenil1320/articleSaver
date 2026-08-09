/* Fetching a URL, with escalation.

   Three tiers, cheapest first:
     1. a plain HTTP request                 - handles most sites
     2. a real, invisible browser on device  - handles JS-built pages and JS challenges
     3. give up, and say why                 - the reader is then offered share or paste

   All three run on the phone. Nothing is sent to a server to be fetched on our behalf. */

import * as native from '../native.js';

// Markers that mean "this is a bot wall, not the article".
const CHALLENGE_MARKERS = [
  'just a moment',
  'enable javascript and cookies to continue',
  'checking your browser',
  'cf-browser-verification',
  '_cf_chl_opt',
  'attention required! | cloudflare',
  'px-captcha',
];

// Sites that always need a real browser: they render client-side or gate on JS.
const BROWSER_FIRST = ['x.com', 'twitter.com', 'mobile.twitter.com', 'medium.com', 'threads.net'];

const looksChallenged = (status, text) => {
  if ([403, 429, 503].includes(status)) return true;
  const head = (text || '').slice(0, 6000).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => head.includes(m));
};

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** True when the first bytes are a PDF header, whatever the site claimed. */
function sniffPdf(buffer) {
  const head = new Uint8Array(buffer.slice(0, 5));
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
}

function looksHtml(text) {
  return /<html|<!doctype html/i.test((text || '').slice(0, 2048));
}

/**
 * Fetch a URL, escalating to a real browser when the cheap path is blocked.
 *
 * Returns { kind: 'pdf' | 'html', bytes?, text?, finalUrl, method, warnings }.
 * The caller owns nothing on disk afterwards: working files are released here.
 */
export async function fetchDocument(url, { onStage = null } = {}) {
  const warnings = [];
  const say = (stage) => { if (onStage) onStage(stage); };

  const browserFirst = BROWSER_FIRST.some((h) => hostOf(url) === h || hostOf(url).endsWith(`.${h}`));

  if (browserFirst) {
    say('rendering');
    const rendered = await native.renderUrl(url);
    if (rendered.ok) return finishHtml(rendered, 'browser', warnings);
    warnings.push('The page was read without running its scripts.');
  }

  say('fetching');
  const plain = await native.fetchUrl(url);

  if (!plain.ok) {
    say('rendering');
    const rendered = await native.renderUrl(url);
    if (rendered.ok) {
      warnings.push('A plain request failed, so the page was opened in a browser.');
      return finishHtml(rendered, 'browser', warnings);
    }
    throw new Error(plain.error || 'That link could not be fetched.');
  }

  const contentType = (plain.contentType || '').toLowerCase();
  const bytes = await native.readBytes(plain);

  if (contentType.includes('application/pdf') || sniffPdf(bytes)) {
    // The file is kept where it landed so it can become the item's stored original.
    return {
      kind: 'pdf',
      bytes,
      path: plain.path,
      finalUrl: plain.finalUrl || url,
      method: 'http+pdf',
      warnings,
    };
  }

  const text = await decode(bytes, plain.contentType);
  native.release(plain);

  if (looksChallenged(plain.status, text)) {
    say('rendering');
    const rendered = await native.renderUrl(url);
    if (rendered.ok) {
      const better = await finishHtml(rendered, 'browser', warnings);
      if (!looksChallenged(200, better.text)) return better;
    }
    warnings.push('The site is behind a bot check that Folio could not clear.');
  }

  if (!contentType.includes('html') && !contentType.includes('text') && !looksHtml(text)) {
    throw new Error('That link is not a web page or a PDF.');
  }

  return {
    kind: 'html',
    text,
    finalUrl: plain.finalUrl || url,
    method: 'http+html',
    warnings,
  };
}

async function finishHtml(result, method, warnings) {
  const text = await native.readText(result);
  native.release(result);
  return {
    kind: 'html',
    text,
    finalUrl: result.finalUrl,
    method: `${method}+html`,
    warnings,
  };
}

const CHARSET_RE = /charset=["']?([\w-]+)/i;

async function decode(buffer, contentType) {
  let charset = (CHARSET_RE.exec(contentType || '') || [])[1];
  if (!charset) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, 4096));
    charset = (CHARSET_RE.exec(head) || [])[1];
  }
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase(), { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/** A second chance for a page whose extraction came out almost empty. */
export async function renderInstead(url, warnings) {
  const rendered = await native.renderUrl(url);
  if (!rendered.ok) return null;
  warnings.push('The page needed its scripts run before it could be read.');
  return finishHtml(rendered, 'browser', warnings);
}
