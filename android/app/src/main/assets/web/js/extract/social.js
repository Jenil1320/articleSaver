/* Posts from LinkedIn and X/Twitter.

   Generic article scoring does badly on social pages: the post is a few hundred words
   surrounded by far more interface text. Both networks publish the post itself in a
   machine-readable form, so read that instead of scraping the page body.

     * X/Twitter - three tiers. X's own syndication CDN first, which carries the full
       text, the photos, the video stills and any quoted post. The fxtwitter mirror
       second, which is best for very long posts. The oEmbed endpoint last, which only
       ever held the text.
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
  return TWITTER_HOSTS.some((t) => h === t || h.endsWith(`.${t}`)) && /\/status(es)?\/\d/.test(url);
}

/** X's long-form Articles. Unlike posts, X shows these to signed-in readers only. */
export function isXArticle(url) {
  const h = hostOf(url);
  return TWITTER_HOSTS.some((t) => h === t || h.endsWith(`.${t}`)) && url.includes('/i/article/');
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

// One digit minimum, to agree with isTweet: the earliest posts have ids under 1000.
const tweetIdOf = (url) => (/\/status(?:es)?\/(\d{1,25})/.exec(url) || [])[1] || '';

async function fetchJson(url, timeoutMs = 30000) {
  const res = await native.fetchUrl(url, 'application/json', timeoutMs);
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status || 0}`);
  const text = await native.readText(res);
  native.release(res);
  return JSON.parse(text);
}

/** Slice by Unicode code points: the ranges X reports count astral characters as one. */
const sliceCodePoints = (text, from, to) => [...String(text || '')].slice(from, to).join('');

/**
 * The visible text of a post: cut at the display range (which drops the trailing
 * media link), then swap every surviving t.co address for the address it stands for.
 */
function visibleText(data) {
  let text = String(data.text || '');
  const range = data.display_text_range;
  if (Array.isArray(range) && range.length === 2) {
    text = sliceCodePoints(text, range[0], range[1]);
  }
  for (const u of (data.entities && data.entities.urls) || []) {
    if (u && u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  }
  // Any t.co address still standing points at media already shown as a picture.
  return text.replace(/https:\/\/t\.co\/\w+/g, ' ');
}

/** Image blocks for a post's pictures; a video contributes its still frame. */
function mediaBlocks(data) {
  const out = [];
  const seen = new Set();
  const push = (src, caption) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    out.push(makeBlock('image', caption, { src }));
  };
  for (const m of data.mediaDetails || []) {
    if (!m || !m.media_url_https) continue;
    if (m.type === 'photo') push(m.media_url_https, '');
    else push(m.media_url_https, m.type === 'animated_gif' ? 'Animation — watch on X' : 'Video — watch on X');
  }
  if (!out.length) {
    for (const p of data.photos || []) push(p && p.url, '');
    if (data.video && data.video.poster) push(data.video.poster, 'Video — watch on X');
  }
  return out;
}

function quoteBlocks(quoted) {
  if (!quoted || !quoted.text) return [];
  const name = (quoted.user && quoted.user.name) || '';
  const handle = (quoted.user && quoted.user.screen_name) || '';
  const who = [name, handle && `@${handle}`].filter(Boolean).join(' ');
  const paras = paraSplit(visibleText(quoted));
  return paras.map((p, i) => makeBlock('quote', i === 0 && who ? `${who}: ${p}` : p));
}

/** Tier one: X's own syndication CDN. No login, and it serves the media too. */
async function tweetFromSyndication(id) {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  const endpoint = 'https://cdn.syndication.twimg.com/tweet-result?'
    + new URLSearchParams({ id, token, lang: 'en' });
  const data = await fetchJson(endpoint);
  if (!data || data.error) throw new Error(data && data.error ? data.error : 'empty answer');
  if (data.tombstone || data.__typename === 'TweetTombstone') {
    throw new Error('That post has been deleted or made private.');
  }
  if (!data.text && !(data.photos || []).length) throw new Error('no post in the answer');

  const user = data.user || {};
  const paras = paraSplit(visibleText(data));
  const raw = paras.map((p) => makeBlock('p', p));
  raw.push(...mediaBlocks(data));
  raw.push(...quoteBlocks(data.quoted_tweet));

  return {
    paras,
    raw,
    author: (user.name || '').trim(),
    handle: user.screen_name ? `@${user.screen_name}` : '',
    publishedAt: data.created_at || null,
    canonicalUrl: user.screen_name ? `https://x.com/${user.screen_name}/status/${id}` : '',
    // A note-length post arrives cut short here; the ellipsis is the tell.
    truncated: /…$/.test((paras[paras.length - 1] || '').trim()),
    // An X Article rides on its announcing post. The syndication copy carries the
    // card — title, preview, cover — but never the body.
    article: data.article && (data.article.title || data.article.preview_text)
      ? data.article : null,
  };
}

/** Tier two: the fxtwitter mirror, which returns very long posts in full. */
async function tweetFromFx(id) {
  const data = await fetchJson(`https://api.fxtwitter.com/status/${id}`);
  if (!data || data.code !== 200 || !data.tweet) throw new Error('no post in the answer');
  const t = data.tweet;
  const author = t.author || {};

  const paras = paraSplit(t.text || '');
  const raw = paras.map((p) => makeBlock('p', p));

  const seen = new Set();
  for (const p of (t.media && t.media.photos) || []) {
    if (p && p.url && !seen.has(p.url)) { seen.add(p.url); raw.push(makeBlock('image', '', { src: p.url })); }
  }
  for (const v of (t.media && t.media.videos) || []) {
    if (v && v.thumbnail_url && !seen.has(v.thumbnail_url)) {
      seen.add(v.thumbnail_url);
      raw.push(makeBlock('image', 'Video — watch on X', { src: v.thumbnail_url }));
    }
  }
  if (t.quote && t.quote.text) {
    const who = [(t.quote.author || {}).name, (t.quote.author || {}).screen_name
      && `@${t.quote.author.screen_name}`].filter(Boolean).join(' ');
    paraSplit(t.quote.text).forEach((p, i) => {
      raw.push(makeBlock('quote', i === 0 && who ? `${who}: ${p}` : p));
    });
  }

  return {
    paras,
    raw,
    author: (author.name || '').trim(),
    handle: author.screen_name ? `@${author.screen_name}` : '',
    publishedAt: t.created_timestamp
      ? new Date(t.created_timestamp * 1000).toISOString() : null,
    canonicalUrl: t.url || '',
    truncated: false,
    // fxtwitter relays the article body itself, as the editor's block document.
    article: t.article && (t.article.title || t.article.preview_text) ? t.article : null,
  };
}

/* ------------------------------------------------------------- X Articles */

/* X's long-form Articles are written in a block editor, and fxtwitter relays that
   document as it is: a list of typed blocks, with bold, italics and links given as
   character ranges beside the text — the same shape Folio stores. The syndication
   CDN only ever carries the article's card (title, preview, cover). So an article
   is read card-first, body-second: the card names it, fxtwitter fills it, and when
   fxtwitter is down the card alone still makes an honest, clearly-partial item. */

const DRAFT_BLOCK_TYPE = {
  unstyled: 'p',
  'header-one': 'h2',
  'header-two': 'h3',
  'header-three': 'h4',
  blockquote: 'quote',
  'code-block': 'code',
  'ordered-list-item': 'li',
  'unordered-list-item': 'li',
};

const DRAFT_STYLE_KIND = {
  Bold: 'strong', Italic: 'em', Code: 'code', Strikethrough: 'strike',
};

/** The editor's ranges count code points; a block's spans count UTF-16 units. */
function draftSpans(block, entityOf) {
  const cu = [0];
  for (const ch of String(block.text || '')) cu.push(cu[cu.length - 1] + ch.length);
  const at = (cp) => cu[Math.max(0, Math.min(cp | 0, cu.length - 1))];

  const spans = [];
  for (const r of block.inlineStyleRanges || []) {
    const k = DRAFT_STYLE_KIND[r.style];
    if (!k) continue;
    const s = at(r.offset);
    const e = at(r.offset + r.length);
    if (e > s) spans.push({ s, e, k });
  }
  for (const r of block.entityRanges || []) {
    const ent = entityOf(r.key);
    if (!ent || ent.type !== 'LINK' || !ent.data || !ent.data.url) continue;
    const s = at(r.offset);
    const e = at(r.offset + r.length);
    if (e > s) spans.push({ s, e, k: 'a', href: ent.data.url });
  }
  return spans;
}

/** The body of an X Article as Folio blocks, from the document fxtwitter relays. */
function articleBodyBlocks(article) {
  const content = article.content || {};
  const entities = new Map();
  const rawMap = content.entityMap || {};
  for (const [key, value] of Array.isArray(rawMap)
    ? rawMap.map((e) => [e && e.key, e && e.value]) : Object.entries(rawMap)) {
    if (value) entities.set(String(key), value);
  }
  const mediaById = new Map();
  for (const m of article.media_entities || []) {
    if (m && m.media_id) mediaById.set(String(m.media_id), m.media_info || {});
  }

  const out = [];
  let ordinal = 0;
  for (const b of content.blocks || []) {
    // An atomic block is a placeholder; what it holds is named by its entity.
    if (b.type === 'atomic') {
      ordinal = 0;
      for (const r of b.entityRanges || []) {
        const ent = entities.get(String(r.key));
        if (!ent) continue;
        if (ent.type === 'DIVIDER') out.push(makeBlock('hr'));
        if (ent.type === 'MEDIA') {
          for (const item of (ent.data && ent.data.mediaItems) || []) {
            const info = mediaById.get(String(item && item.mediaId)) || {};
            if (!info.original_img_url) continue;
            const video = /video/i.test(info.__typename || '');
            out.push(makeBlock('image', video ? 'Video — watch on X' : '',
              { src: info.original_img_url, figure: true }));
          }
        }
      }
      continue;
    }

    const type = DRAFT_BLOCK_TYPE[b.type] || 'p';
    const block = makeBlock(type, String(b.text || ''));
    const spans = draftSpans(b, (k) => entities.get(String(k)));
    if (spans.length) block.spans = spans;
    if (type === 'li') {
      const ordered = b.type === 'ordered-list-item';
      block.ordered = ordered;
      if (ordered) {
        ordinal += 1;
        block.num = ordinal;
      } else ordinal = 0;
    } else ordinal = 0;
    out.push(block);
  }
  return out;
}

// Syndication names the article's id `rest_id`; fxtwitter names it `id` (and its
// syndication-style `id` is an opaque entity handle, so only a run of digits counts).
const articleUrlOf = (article, id) => {
  const own = article.rest_id
    || (/^\d+$/.test(String(article.id || '')) ? article.id : '');
  return `https://x.com/i/article/${own || id}`;
};

const articleCoverOf = (article) => {
  const info = article.cover_media && article.cover_media.media_info;
  return info && info.original_img_url ? info.original_img_url : '';
};

/**
 * A saved item for an X Article. The body comes from fxtwitter when it can; when it
 * cannot, the public card — title, cover, preview — is saved and says so plainly.
 */
async function articleResult(post, id) {
  let article = post.article;
  if (!(article.content && (article.content.blocks || []).length)) {
    try {
      const fx = await tweetFromFx(id);
      if (fx.article && fx.article.content) article = fx.article;
    } catch { /* the card alone still reads */ }
  }
  const full = !!(article.content && (article.content.blocks || []).length);

  const raw = [];
  if (full) raw.push(...articleBodyBlocks(article));
  else {
    const preview = paraSplit(article.preview_text || '');
    if (preview.length && !/[.!?…]$/.test(preview[preview.length - 1])) {
      preview[preview.length - 1] += '…';
    }
    raw.push(...preview.map((p) => makeBlock('p', p)));
    const label = 'Read the full article on X';
    raw.push(makeBlock('p', label,
      { spans: [{ s: 0, e: label.length, k: 'a', href: articleUrlOf(article, id) }] }));
  }

  const cover = articleCoverOf(article);
  const { blocks, words, plain } = finalise(raw);
  const firstImage = blocks.find((b) => b.type === 'image' && b.src);

  return {
    title: (article.title || '').trim() || 'X Article',
    byline: `${post.author} ${post.handle}`.trim(),
    siteName: 'X',
    publishedAt: article.created_at || post.publishedAt,
    leadImage: cover || (firstImage ? firstImage.src : null),
    canonicalUrl: articleUrlOf(article, id),
    content: blocks,
    wordCount: words,
    textPlain: plain,
    excerpt: excerptFrom(blocks),
    kindHint: 'article',
    signals: { ldTypes: ['Article'], ogType: 'article', description: plain.slice(0, 400) },
    warnings: full ? []
      : ['Only this article\'s public preview could be saved: X shows the rest to signed-in readers.'],
  };
}

/** Tier three: the oEmbed endpoint. Text only, but it has outlived everything else. */
async function tweetFromOembed(url) {
  const endpoint = 'https://publish.twitter.com/oembed?'
    + new URLSearchParams({ url, omit_script: '1', dnt: 'true', hide_thread: 'false' });
  const data = await fetchJson(endpoint, 45000);

  const doc = new DOMParser().parseFromString(data.html || '<div></div>', 'text/html');
  const paras = [];
  for (const p of doc.querySelectorAll('p')) {
    // <br> inside the post marks a real line break; everything after </p> is the
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

  let handle = '';
  const m = /(?:twitter|x)\.com\/([^/?#]+)/.exec(data.author_url || '');
  if (m) handle = `@${m[1]}`;

  return {
    paras,
    raw: paras.map((p) => makeBlock('p', p)),
    author: (data.author_name || '').trim(),
    handle,
    publishedAt: dateText || null,
    canonicalUrl: data.url || url,
    truncated: false,
  };
}

export async function extractTweet(url) {
  const id = tweetIdOf(url);

  let post = null;
  let unreadable = null;
  const tiers = id ? [() => tweetFromSyndication(id), () => tweetFromFx(id),
    () => tweetFromOembed(url)] : [() => tweetFromOembed(url)];

  for (const tier of tiers) {
    try {
      const got = await tier();
      if (!post) post = got;
      // The syndication copy of a very long post ends in an ellipsis; a later tier
      // that returns more of the text wins, and the pictures already found are kept.
      else if (got.paras.join(' ').length > post.paras.join(' ').length) {
        const pictures = post.raw.filter((b) => b.type !== 'p');
        post = { ...got, raw: [...got.raw.filter((b) => b.type === 'p'), ...pictures] };
      }
      if (!post.truncated) break;
    } catch (err) {
      if (/deleted or made private/.test(err.message || '')) unreadable = err;
    }
  }

  if (!post) {
    throw unreadable || new Error('That post could not be read. It may be deleted, private, '
      + 'or from a protected account.');
  }

  // A post that announces an X Article is only a link; the article is the content.
  if (post.article && id) return articleResult(post, id);

  const { paras, raw } = post;
  const body = raw.length ? raw : [makeBlock('p', '(This post has no text.)')];
  const { blocks, words, plain } = finalise(body);
  const title = paras.length
    ? paras[0].slice(0, 110) + (paras[0].length > 110 ? '…' : '')
    : 'Post';

  const firstImage = blocks.find((b) => b.type === 'image' && b.src);

  return {
    title,
    byline: `${post.author} ${post.handle}`.trim(),
    siteName: 'X',
    publishedAt: post.publishedAt,
    leadImage: firstImage ? firstImage.src : null,
    canonicalUrl: post.canonicalUrl || url,
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
