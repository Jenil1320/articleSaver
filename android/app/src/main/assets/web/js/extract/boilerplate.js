/* Telling the article from the publisher's furniture.

   This runs after flattening, on the finished list of blocks, and that is the whole
   point of it. In the markup a related-story rail and a paragraph look alike — both
   are a div holding text — so the cleaning pass cannot separate them without risking
   the article. Laid out in a row, they are obvious: the article is a long run of
   substantial paragraphs, and the rails, the bios, the sign-up cards and the job
   adverts sit before it or after it.

   Two constraints pull against each other. Advertising and marketing must be filtered
   strictly. Core content must never be deleted. They are reconciled by making the
   pass say how sure it is:

     drop   — certain. A row of share buttons, a navigation label, a consent line.
              Nothing a reader would miss, and each is recognised outright.
     aside  — not certain. A newsletter pitch, a sponsor line, an author bio, a
              related-story link, paywall pricing. Kept in the document, marked with
              why, and shown by the reader as one collapsed line to tap open.
     keep   — everything else, and everything inside the body of the article, which
              is protected from the tail rules however it reads.

   So the strict half is strict, and the uncertain half costs the reader one line
   instead of costing them a paragraph. */

const words = (s) => (String(s || '').match(/\S+/g) || []).length;

const PROSE = new Set(['p', 'li', 'quote']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4']);

// A paragraph this long is the article talking, not a caption or a label.
const SUBSTANTIAL = 25;

/* ── certain: dropped outright ───────────────────────────────────────── */

// One social network or share verb, alone in a block. A row of these is the share
// rail; the run test below is what stops a lone "Save" in prose being taken for one.
const SHARE_WORD_RE = new RegExp('^(share|share this|email|e-mail|print|copy link|copy|'
  + 'facebook|x|twitter|bluesky|threads|linkedin|reddit|whatsapp|telegram|pinterest|'
  + 'tumblr|mastodon|pocket|flipboard|messenger|sms|gift|gift article|save|saved|'
  + 'listen|follow|following|comment|comments|more)$', 'i');

// Navigation words, which say nothing on their own. Matched against the whole block
// and nothing less: an earlier version matched them as a prefix, which quietly deleted
// any paragraph opening "Register your interest…" or "Search for a term…".
const NAV_EXACT_RE = new RegExp('^(sign in|sign up|log in|login|log out|register|'
  + 'menu|home|search|more|next|previous|back|close|open|toggle|show more|show less|'
  + 'read more|see all|view all|load more)\\s*[.:>]?$', 'i');

// Whole phrases that can only be interface, so a prefix match is safe. The length
// guard keeps a sentence that happens to begin this way out of it.
const NAV_PHRASE_RE = new RegExp('^(expand\\/collapse submenu|collapse submenu|'
  + 'skip to |jump to |back to top|scroll to top|'
  + 'accept( all)? cookies|reject( all)? cookies|manage (cookies|preferences)|'
  + 'we use cookies|this (site|website) uses cookies|cookie (policy|settings|preferences)|'
  + 'keyboard shortcuts for|enable javascript|please enable)', 'i');

// A label a publisher puts above a paid slot.
const AD_LABEL_RE = /^(advertisement|advert|ad|sponsored( content| by)?|paid (post|content)|promoted( content)?|partner content)\s*[:.]?$/i;

/* ── uncertain: kept, collapsed ──────────────────────────────────────── */

const PITCH_RE = new RegExp('(sign up (for|to)|subscribe (to|now|today)|'
  + 'join (our|the) (newsletter|mailing)|(free|daily|weekly|morning) (newsletter|briefing|digest)|'
  + 'delivered (to your inbox|every)|straight to your inbox|to your inbox|'
  + 'become a (member|subscriber|supporter)|support (our|independent) journalism|'
  + 'enter your email|get the (newsletter|briefing)|read distraction-free|'
  + 'added to your daily email digest|follow this (topic|author)|'
  + 'download the app|get our app)', 'i');

const SPONSOR_RE = new RegExp('(sponsored by|in partnership with|paid for by|'
  + 'brought to you by|this (article|post|series) (is|was) (sponsored|supported)|'
  + 'is supported by|advertisement feature|promoted by)', 'i');

const BIO_RE = new RegExp('\\b(is (a|an|the) (reporter|writer|journalist|editor|'
  + 'correspondent|contributor|columnist|analyst|professor|researcher)\\b|'
  + 'joined [A-Z][^.]{0,40} in (19|20)\\d\\d|writes about|has (a|an) (BSc|MSc|PhD|MA|BA)\\b|'
  + 'you can (follow|reach) (him|her|them) )', 'i');

const PRICE_RE = /(?:[£$€]\s?\d|(?:\d+[.,]\d\d))/;
const PRICE_CONTEXT_RE = new RegExp('(per (year|month|issue)|\\/ ?\\d+ days|cancel any time|'
  + 'prices? (may|vary)|subject to local taxes|rent or buy|buy this article|'
  + 'online access|print issues|best-value|only \\S+ per)', 'i');

// A heading that opens a section of furniture. What follows it, to the next heading
// at the same depth or shallower, is furniture too.
const TAIL_HEAD_RE = new RegExp('^(related( (articles?|stories|posts?|reading|content))?|'
  + 'more (from|on|in|like this|stories)|latest( on)?|most (read|popular|viewed|shared)|'
  + 'popular|trending|recommended( for you)?|you (may|might) (also )?like|'
  + 'read (next|more)|up next|editor.s picks?|from our partners?|around the web|'
  + 'promoted stories|jobs?|careers?|subjects?|topics?|tags?|share this|'
  + 'access options|subscription options|newsletters?|sign up|follow us|'
  + 'about the author|advertisement)\\s*:?$', 'i');

// Apparatus, not furniture. A reference list is part of the document and the reader
// already sets it as such — it must never be swept up by the tail rules.
const APPARATUS_HEAD_RE = new RegExp('^(references?|bibliography|works cited|citations?|'
  + 'sources|notes|endnotes|footnotes|further reading|see also|external links|'
  + 'appendix|acknowledge?ments?|methodology|data availability)\\b', 'i');

/* ── shape of the document ───────────────────────────────────────────── */

/**
 * Where the article proper begins and ends: the first and the last block long enough
 * to be the author talking. Everything between them is protected, whatever it reads
 * like — a one-line paragraph in the middle of an essay is still the essay.
 */
function bodySpan(blocks) {
  const solid = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if ((b.type === 'p' || b.type === 'quote') && words(b.text) >= SUBSTANTIAL) solid.push(i);
  }
  if (solid.length >= 2) return { from: solid[0], to: solid[solid.length - 1] };

  // A short piece, a photo essay, or a page that is mostly list. Fall back to any
  // prose at all rather than protecting nothing.
  const any = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (PROSE.has(blocks[i].type) && words(blocks[i].text) >= 8) any.push(i);
  }
  if (!any.length) return { from: 0, to: blocks.length - 1 };
  return { from: any[0], to: any[any.length - 1] };
}

/** How much of a block's text sits inside a link. */
function linkShare(block) {
  const text = block.text || '';
  if (!text || !block.spans) return 0;
  let covered = 0;
  for (const span of block.spans) if (span.k === 'a') covered += span.e - span.s;
  return covered / text.length;
}

/** Which blocks belong to a furniture section opened by a heading past the body. */
function tailSections(blocks, bodyEnd) {
  const marked = new Map();
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!HEADING.has(b.type)) continue;
    const text = (b.text || '').trim();
    if (APPARATUS_HEAD_RE.test(text)) continue;
    if (!TAIL_HEAD_RE.test(text)) continue;
    // A "Related" heading inside the article is a signpost the author wrote; only
    // one past the last real paragraph opens a section of furniture.
    if (i <= bodyEnd) continue;

    const level = Number(b.type[1]);
    marked.set(i, 'section');
    for (let j = i + 1; j < blocks.length; j += 1) {
      const next = blocks[j];
      if (HEADING.has(next.type)) {
        const nextText = (next.text || '').trim();
        if (Number(next.type[1]) <= level) {
          if (APPARATUS_HEAD_RE.test(nextText)) break;
          if (!TAIL_HEAD_RE.test(nextText)) break;
        }
      }
      marked.set(j, 'section');
    }
  }
  return marked;
}

/**
 * Which blocks belong to the document's own apparatus — its references, its notes,
 * its further reading, its external links.
 *
 * These sit past the last paragraph and read exactly like a related-story rail: short
 * entries that are mostly link. They are not one. They are the end of the document,
 * the author put them there, and the reader already sets them as apparatus. Marking
 * the span keeps the tail rules off them.
 */
function apparatusSpans(blocks) {
  const inside = new Set();
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!HEADING.has(b.type) || !APPARATUS_HEAD_RE.test((b.text || '').trim())) continue;
    const level = Number(b.type[1]);
    inside.add(i);
    for (let j = i + 1; j < blocks.length; j += 1) {
      const next = blocks[j];
      if (HEADING.has(next.type) && Number(next.type[1]) <= level
        && !APPARATUS_HEAD_RE.test((next.text || '').trim())) break;
      inside.add(j);
    }
  }
  return inside;
}

/** Runs of two or more blocks that are each a single share word. */
function shareRuns(blocks) {
  const drop = new Set();
  let run = [];
  const flush = () => {
    if (run.length >= 2) for (const i of run) drop.add(i);
    run = [];
  };
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (PROSE.has(b.type) && SHARE_WORD_RE.test((b.text || '').trim())) run.push(i);
    else flush();
  }
  flush();
  return drop;
}

/* ── the pass ────────────────────────────────────────────────────────── */

/**
 * Judge a flat block list and return it with furniture separated.
 *
 * Blocks judged certain are removed. Blocks judged uncertain gain `aside`, naming why,
 * and stay exactly where they were so the reader can open them.
 */
export function sift(blocks) {
  if (!blocks || blocks.length < 4) return blocks || [];

  const { from: bodyStart, to: bodyEnd } = bodySpan(blocks);
  const sections = tailSections(blocks, bodyEnd);
  const apparatus = apparatusSpans(blocks);
  const shares = shareRuns(blocks);
  const out = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const text = (b.text || '').trim();
    const n = words(text);
    const inBody = i >= bodyStart && i <= bodyEnd;

    /* certain — removed */
    if (shares.has(i)) continue;
    if (PROSE.has(b.type) && NAV_EXACT_RE.test(text)) continue;
    if (PROSE.has(b.type) && n <= 14 && NAV_PHRASE_RE.test(text)) continue;
    if (PROSE.has(b.type) && n <= 4 && AD_LABEL_RE.test(text)) continue;

    // A reference list, a notes section, further reading, external links: the end of
    // the document rather than a rail beside it. Every one of them is short, sits
    // past the last paragraph, and is mostly link — which is to say it trips every
    // tail rule below and is none of the things they look for.
    if (apparatus.has(i)) { out.push(b); continue; }

    /* uncertain — kept and collapsed */
    let why = '';

    if (SPONSOR_RE.test(text) && n < 60) why = 'sponsor';
    else if (PITCH_RE.test(text) && n < 80) why = 'promo';
    else if (PRICE_RE.test(text) && PRICE_CONTEXT_RE.test(text) && n < 60) why = 'promo';
    else if (sections.get(i)) why = 'related';
    else if (!inBody && i > bodyEnd) {
      // Past the article. A short block that is mostly a link is a related-story
      // rail; a bio is a bio; anything longer is left alone.
      if (BIO_RE.test(text) && n < 90) why = 'bio';
      else if (PROSE.has(b.type) && n < SUBSTANTIAL && linkShare(b) > 0.6) why = 'related';
    } else if (!inBody && i < bodyStart) {
      // Before the article: kickers, datelines, author names, tool rails. A real
      // standfirst is longer than this and survives.
      if (BIO_RE.test(text) && n < 90) why = 'bio';
      else if (PROSE.has(b.type) && b.type !== 'p' && n < 10) why = 'meta';
      else if (b.type === 'p' && n < 10 && linkShare(b) > 0.6) why = 'meta';
    } else if (HEADING.has(b.type) && linkShare(b) > 0.9) {
      // A heading an author wrote names a section of their own article and links
      // nowhere. A heading that is entirely one link is a card the publisher dropped
      // into the flow — "Middle East conflict", then the story it points at.
      why = 'related';
    } else if (inBody && PROSE.has(b.type) && n < 20 && linkShare(b) > 0.9) {
      // An interloper: a related-story link dropped into the middle of the prose.
      // The whole block is one link and it says almost nothing, so it is a rail —
      // but it is inside the article, so it is only ever collapsed, never removed.
      why = 'related';
    }

    out.push(why ? { ...b, aside: why } : b);
  }

  return out;
}
