"""Posts from LinkedIn and X/Twitter.

Generic article scoring does badly on social pages: the post is a few hundred words
surrounded by far more interface text. Both networks publish the post itself in a
machine-readable form, so read that instead of scraping the page body.

  * LinkedIn - JSON-LD `SocialMediaPosting`, which carries articleBody and comments.
  * X/Twitter - the public oEmbed endpoint, which needs no login.
"""
from __future__ import annotations

import html as htmllib
import json
import re
from urllib.parse import urlparse

import requests
from lxml import html as lhtml

from .. import config
from .blocks import excerpt_from, finalise, make_block

TWITTER_HOSTS = ("twitter.com", "x.com", "mobile.twitter.com", "vxtwitter.com", "fxtwitter.com")
LINKEDIN_HOSTS = ("linkedin.com",)


def host_of(url: str) -> str:
    return re.sub(r"^www\.", "", (urlparse(url).netloc or "").lower())


def is_tweet(url: str) -> bool:
    h = host_of(url)
    return any(h == t or h.endswith("." + t) for t in TWITTER_HOSTS) and "/status/" in url


def is_linkedin_post(url: str) -> bool:
    h = host_of(url)
    return any(h == t or h.endswith("." + t) for t in LINKEDIN_HOSTS) and (
        "/posts/" in url or "/feed/update/" in url or "/pulse/" in url
    )


def is_social(url: str) -> bool:
    return is_tweet(url) or is_linkedin_post(url)


def _para_split(text: str) -> list[str]:
    text = htmllib.unescape(text or "").replace("\r\n", "\n").replace("\r", "\n")
    parts = [" ".join(p.split()) for p in re.split(r"\n{1,}", text)]
    return [p for p in parts if p]


# ---------------------------------------------------------------- X / Twitter

def extract_tweet(url: str) -> dict:
    r = requests.get(
        "https://publish.twitter.com/oembed",
        params={"url": url, "omit_script": "1", "dnt": "true", "hide_thread": "false"},
        headers={"User-Agent": config.BROWSER_UA},
        timeout=config.FETCH_TIMEOUT,
    )
    if not r.ok:
        raise LookupError(
            "That post could not be read. It may be deleted, private, or from a protected account."
        )
    data = r.json()
    frag = lhtml.fragment_fromstring(data.get("html", "<div/>"), create_parent="div")

    paras: list[str] = []
    for p in frag.findall(".//p"):
        # <br> inside the tweet marks a real line break. with_tail=False matters:
        # oEmbed puts "— author (@handle) date" in the tail after </p>.
        raw = lhtml.tostring(p, encoding="unicode", with_tail=False)
        raw = re.sub(r"<br\s*/?>", "\n", raw)
        text = lhtml.fragment_fromstring(raw, create_parent="div").text_content()
        paras.extend(_para_split(text))

    date_text = ""
    for a in frag.findall(".//a"):
        t = (a.text_content() or "").strip()
        if re.match(r"^[A-Z][a-z]+ \d{1,2}, \d{4}$", t):
            date_text = t
            break

    author = (data.get("author_name") or "").strip()
    handle = ""
    m = re.search(r"(?:twitter|x)\.com/([^/?#]+)", data.get("author_url") or "")
    if m:
        handle = "@" + m.group(1)

    blocks = [make_block("p", p) for p in paras] or [make_block("p", "(This post has no text.)")]
    blocks, words, plain = finalise(blocks)
    title = paras[0][:110] + ("…" if paras and len(paras[0]) > 110 else "") if paras else "Post"

    return {
        "title": title,
        "byline": f"{author} {handle}".strip(),
        "site_name": "X",
        "published_at": date_text or None,
        "lead_image": None,
        "canonical_url": data.get("url") or url,
        "content": blocks,
        "word_count": words,
        "text_plain": plain,
        "excerpt": excerpt_from(blocks),
        "kind_hint": "post",
        "signals": {"ld_types": ["SocialMediaPosting"], "og_type": "article", "description": plain[:400]},
    }


# ---------------------------------------------------------------- LinkedIn

def _ld_posting(doc) -> dict:
    for el in doc.findall('.//script[@type="application/ld+json"]'):
        try:
            data = json.loads((el.text or "").strip())
        except Exception:
            continue
        for d in data if isinstance(data, list) else [data]:
            if isinstance(d, dict) and "SocialMediaPosting" in str(d.get("@type", "")):
                return d
    return {}


def extract_linkedin(html_text: str, url: str, *, include_comments: bool = True) -> dict:
    doc = lhtml.document_fromstring(html_text)
    post = _ld_posting(doc)

    body = (post.get("articleBody") or "").strip()
    if not body:
        # Fall back to the rendered post body node.
        nodes = doc.xpath('//*[contains(@class,"attributed-text-segment-list__content")]')
        if nodes:
            body = nodes[0].text_content()
    if not body:
        raise LookupError(
            "This LinkedIn post could not be read without signing in. "
            "Copy the text and use Paste text instead."
        )

    author = ""
    a = post.get("author")
    if isinstance(a, dict):
        author = (a.get("name") or "").strip()
    elif isinstance(a, list) and a and isinstance(a[0], dict):
        author = (a[0].get("name") or "").strip()

    blocks = [make_block("p", p) for p in _para_split(body)]

    image = post.get("image")
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl")
    if isinstance(image, list) and image:
        image = image[0].get("url") if isinstance(image[0], dict) else image[0]
    if isinstance(image, str) and image.startswith("http"):
        blocks.append(make_block("image", "", src=image))

    comments = post.get("comment") or []
    if include_comments and isinstance(comments, list) and comments:
        blocks.append(make_block("hr"))
        blocks.append(make_block("h3", f"Comments ({len(comments)})"))
        for c in comments:
            if not isinstance(c, dict):
                continue
            ca = c.get("author")
            cname = ca.get("name", "").strip() if isinstance(ca, dict) else ""
            ctext = " ".join((c.get("text") or "").split())
            if ctext:
                blocks.append(make_block("quote", f"{cname}: {ctext}" if cname else ctext))

    blocks, words, plain = finalise(blocks)
    first = _para_split(body)[0] if _para_split(body) else "LinkedIn post"
    title = first[:110] + ("…" if len(first) > 110 else "")

    return {
        "title": title,
        "byline": author,
        "site_name": "LinkedIn",
        "published_at": (post.get("datePublished") or "").strip() or None,
        "lead_image": image if isinstance(image, str) else None,
        "canonical_url": post.get("@id") or url,
        "content": blocks,
        "word_count": words,
        "text_plain": plain,
        "excerpt": excerpt_from(blocks),
        "kind_hint": "post",
        "signals": {"ld_types": ["SocialMediaPosting"], "og_type": "article", "description": plain[:400]},
    }
