/* Posts from LinkedIn and X/Twitter.

   Generic article scoring does badly on social pages: the post is a few hundred words
   surrounded by far more interface text. Both networks publish the post itself in a
   machine-readable form, so read that instead of scraping the page body.

     * X/Twitter - the public oEmbed endpoint, which needs no login.
     * LinkedIn  - JSON-LD `SocialMediaPosting`, which carries articleBody and comments. */

import { excerptFrom, finalise, makeBlock } from './blocks.js';
import * as native from '../native.js';

const TWITTER_HOSTS = ['twitter.com', 'x.com', 'mobile.twitter.com', 'vxtwitter.com', 'fxtwitter.com'];
const LINKEDIN_HOSTS = ['linkedin.com'];

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export function isTweet(url) {
  const h = hostOf(url);
  return TWITTER_HOSTS.some((t) => h === t || h.endsWith(`.${t}`)) && url.includes('/status/');
}

export function isLinkedInPost(url) {
  const h = hostOf(url);
  return LINKEDIN_HOSTS.some((t) => h === t || h.endsWith(`.${t}`))
    && (url.includes('/posts/') || url.includes('/feed/update/') || url.includes('/pulse/'));
}

export const isSocial = (url) => isTweet(url) || isLinkedInPost(url);

function paraSplit(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return clean.split(/\n+/)
    .map((p) => p.split(/\s+/).filter(Boolean).join(' '))
    .filter(Boolean);
}

/* ---------------------------------------------------------------- X / Twitter */

export async function extractTweet(url) {
  const endpoint = 'https://publish.twitter.com/oembed?'
    + new URLSearchParams({ url, omit_script: '1', dnt: 'true', hide_thread: 'false' });

  const res = await native.fetchUrl(endpoint, 'application/json', 45000);
  if (!res.ok) {
    throw new Error('That post could not be read. It may be deleted, private, '
      + 'or from a protected account.');
  }
  let data;
  try {
    data = JSON.parse(await native.readText(res));
  } catch {
    throw new Error('X returned something Folio could not read.');
  }

  const doc = new DOMParser().parseFromString(data.html || '<div></div>', 'text/html');
  const paras = [];
  for (const p of doc.querySelectorAll('p')) {
    // <br> inside the tweet marks a real line break; everything after </p> is the
    // oEmbed footer ("— author (@handle) date") and is not part of the post.
    const clone = p.cloneNode(true);
    for (const br of [...clone.querySelectorAll('br')]) {
      br.replaceWith(doc.createTextNode('\n'));
    }
    paras.push(...paraSplit(clone.textContent));
  }

  let dateText = '';
  for (const a of doc.querySelectorAll('a')) {
    const t = (a.textContent || '').trim();
    if (/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(t)) { dateText = t; break; }
  }

  const author = (data.author_name || '').trim();
  let handle = '';
  const m = /(?:twitter|x)\.com\/([^/?#]+)/.exec(data.author_url || '');
  if (m) handle = `@${m[1]}`;

  const raw = paras.length ? paras.map((p) => makeBlock('p', p))
    : [makeBlock('p', '(This post has no text.)')];
  const { blocks, words, plain } = finalise(raw);
  const title = paras.length
    ? paras[0].slice(0, 110) + (paras[0].length > 110 ? '…' : '')
    : 'Post';

  return {
    title,
    byline: `${author} ${handle}`.trim(),
    siteName: 'X',
    publishedAt: dateText || null,
    leadImage: null,
    canonicalUrl: data.url || url,
    content: blocks,
    wordCount: words,
    textPlain: plain,
    excerpt: excerptFrom(blocks),
    kindHint: 'post',
    signals: { ldTypes: ['SocialMediaPosting'], ogType: 'article', description: plain.slice(0, 400) },
  };
}

/* ---------------------------------------------------------------- LinkedIn */

function ldPosting(doc) {
  for (const el of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse((el.textContent || '').trim()); } catch { continue; }
    for (const d of Array.isArray(data) ? data : [data]) {
      if (d && typeof d === 'object' && String(d['@type'] || '').includes('SocialMediaPosting')) {
        return d;
      }
    }
  }
  return {};
}

export function extractLinkedIn(htmlText, url, { includeComments = true } = {}) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const post = ldPosting(doc);

  let body = (post.articleBody || '').trim();
  if (!body) {
    // Fall back to the rendered post body node.
    const node = doc.querySelector('[class*="attributed-text-segment-list__content"]');
    if (node) body = node.textContent || '';
  }
  if (!body.trim()) {
    throw new Error('This LinkedIn post could not be read without signing in. '
      + 'Copy the text and use Paste text instead.');
  }

  let author = '';
  const a = post.author;
  if (a && typeof a === 'object' && !Array.isArray(a)) author = (a.name || '').trim();
  else if (Array.isArray(a) && a.length && typeof a[0] === 'object') author = (a[0].name || '').trim();

  const raw = paraSplit(body).map((p) => makeBlock('p', p));

  let image = post.image;
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    image = image.url || image.contentUrl;
  }
  if (Array.isArray(image) && image.length) {
    image = typeof image[0] === 'object' ? image[0].url : image[0];
  }
  if (typeof image === 'string' && image.startsWith('http')) {
    raw.push(makeBlock('image', '', { src: image }));
  }

  const comments = post.comment;
  if (includeComments && Array.isArray(comments) && comments.length) {
    raw.push(makeBlock('hr'));
    raw.push(makeBlock('h3', `Comments (${comments.length})`));
    for (const c of comments) {
      if (!c || typeof c !== 'object') continue;
      const name = c.author && typeof c.author === 'object' ? (c.author.name || '').trim() : '';
      const text = String(c.text || '').split(/\s+/).filter(Boolean).join(' ');
      if (text) raw.push(makeBlock('quote', name ? `${name}: ${text}` : text));
    }
  }

  const { blocks, words, plain } = finalise(raw);
  const first = paraSplit(body)[0] || 'LinkedIn post';

  return {
    title: first.slice(0, 110) + (first.length > 110 ? '…' : ''),
    byline: author,
    siteName: 'LinkedIn',
    publishedAt: (post.datePublished || '').trim() || null,
    leadImage: typeof image === 'string' ? image : null,
    canonicalUrl: post['@id'] || url,
    content: blocks,
    wordCount: words,
    textPlain: plain,
    excerpt: excerptFrom(blocks),
    kindHint: 'post',
    signals: { ldTypes: ['SocialMediaPosting'], ogType: 'article', description: plain.slice(0, 400) },
  };
}
