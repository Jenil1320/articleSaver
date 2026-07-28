"""Readable-article extraction from HTML.

A scoring pass in the spirit of Readability: find the subtree that holds the prose,
throw away chrome, then flatten what survives into normalised blocks.
"""
from __future__ import annotations

import json
import re
from urllib.parse import urljoin, urlparse

from lxml import etree, html as lhtml

from .blocks import excerpt_from, finalise, make_block

# Elements that never contain the article.
STRIP_TAGS = (
    "script style noscript svg canvas form button input select textarea "
    "nav footer header aside iframe object embed video audio map area link meta"
).split()

# Class/id substrings that mark site chrome.
NEGATIVE_RE = re.compile(
    r"(^|[-_ ])(comment|share|social|promo|banner|advert|advertisement|sponsor|"
    r"sidebar|widget|related|recommend|newsletter|subscribe|signup|popup|modal|"
    r"cookie|consent|nav|menu|breadcrumb|pagination|footer|masthead|toolbar|"
    r"metadata|byline|author-bio|tags|meta-tags|skip|screen-reader|sr-only|"
    r"hidden|disqus|utility|toc|table-of-contents|paywall|subnav|site-header)",
    re.I,
)
POSITIVE_RE = re.compile(
    r"(^|[-_ ])(article|post|entry|content|main|body|story|text|prose|markdown|"
    r"blog|page-content|rich-text|readme)",
    re.I,
)

BLOCK_LEVEL = {
    "p": "p", "h1": "h1", "h2": "h2", "h3": "h3", "h4": "h4", "h5": "h4", "h6": "h4",
    "blockquote": "quote", "pre": "code", "li": "li", "figure": "figure",
    "hr": "hr", "img": "image", "table": "table",
}

INLINE_OK = {"a", "b", "strong", "i", "em", "span", "code", "sup", "sub", "u", "mark", "small", "abbr", "time", "br"}


# ---------------------------------------------------------------- metadata

def _meta(doc, *names: str) -> str:
    for name in names:
        for attr in ("property", "name", "itemprop"):
            el = doc.find(f'.//meta[@{attr}="{name}"]')
            if el is not None:
                v = (el.get("content") or "").strip()
                if v:
                    return v
    return ""


def _ld_json(doc) -> list[dict]:
    out = []
    for el in doc.findall('.//script[@type="application/ld+json"]'):
        raw = (el.text or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        out.extend(data if isinstance(data, list) else [data])
    # Unwrap @graph containers.
    flat = []
    for d in out:
        if isinstance(d, dict) and isinstance(d.get("@graph"), list):
            flat.extend(x for x in d["@graph"] if isinstance(x, dict))
        elif isinstance(d, dict):
            flat.append(d)
    return flat


def _first_str(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return _first_str(value.get("name") or value.get("@id") or "")
    if isinstance(value, list) and value:
        return _first_str(value[0])
    return ""


def extract_metadata(doc, url: str) -> dict:
    ld = _ld_json(doc)
    art = next(
        (d for d in ld if _first_str(d.get("@type")).lower()
         in ("article", "newsarticle", "blogposting", "report", "scholarlyarticle",
             "techarticle", "socialmediaposting", "webpage")),
        {},
    )

    title = (
        _meta(doc, "og:title", "twitter:title")
        or _first_str(art.get("headline"))
        or (doc.findtext(".//title") or "").strip()
    )
    # Sites often append " | Site Name" to <title>; Open Graph is cleaner, so only trim
    # the tail when we fell back to <title>.
    site = _meta(doc, "og:site_name") or _first_str(art.get("publisher"))
    if site and title.endswith(f"| {site}"):
        title = title[: -len(f"| {site}")].strip()

    byline = (
        _meta(doc, "author", "article:author", "twitter:creator")
        or _first_str(art.get("author"))
    )
    if byline.startswith("http"):
        byline = ""
    if not byline:
        # `contains()` is XPath, not ElementPath, so these must go through .xpath().
        for xp in ('//*[@rel="author"]', '//*[contains(@class,"author-name")]',
                   '//*[contains(@class,"byline")]', '//*[@itemprop="author"]'):
            found = doc.xpath(xp)
            if found:
                byline = " ".join((found[0].text_content() or "").split())[:120]
                if byline:
                    break
    byline = re.sub(r"^(by|By)\s+", "", byline).strip()

    published = (
        _meta(doc, "article:published_time", "datePublished", "publishdate", "og:updated_time")
        or _first_str(art.get("datePublished"))
    )
    if not published:
        t = doc.find(".//time[@datetime]")
        if t is not None:
            published = (t.get("datetime") or "").strip()

    image = _meta(doc, "og:image", "twitter:image")
    if image:
        image = urljoin(url, image)

    if not site:
        site = urlparse(url).netloc.replace("www.", "")

    return {
        "title": title.strip(),
        "byline": byline.strip(),
        "site_name": site.strip(),
        "published_at": published.strip() or None,
        "lead_image": image or None,
        "ld_types": [_first_str(d.get("@type")) for d in ld if d.get("@type")],
        "og_type": _meta(doc, "og:type"),
        "description": _meta(doc, "og:description", "description", "twitter:description"),
    }


# ---------------------------------------------------------------- scoring

def _clean_tree(doc) -> None:
    for tag in STRIP_TAGS:
        for el in doc.findall(f".//{tag}"):
            # Keep the lead image out of harm's way; images are handled separately.
            if tag in ("img", "link", "meta"):
                continue
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
    # Elements explicitly hidden from users are not article text.
    for el in doc.xpath('//*[@aria-hidden="true"] | //*[contains(@style,"display:none")]'):
        p = el.getparent()
        if p is not None:
            p.remove(el)


def _node_signature(el) -> str:
    return f'{el.get("class", "")} {el.get("id", "")}'


def _score_node(el) -> float:
    text = el.text_content() or ""
    length = len(text.strip())
    if length < 25:
        return 0.0
    score = 1.0
    score += text.count(",") + text.count("،")
    score += min(length / 100.0, 12.0)
    sig = _node_signature(el)
    if NEGATIVE_RE.search(sig):
        score -= 25
    if POSITIVE_RE.search(sig):
        score += 12
    if el.tag == "article":
        score += 30
    if el.tag == "main":
        score += 18
    if el.get("role") == "main":
        score += 15
    # Link-dense blocks are navigation, not prose.
    link_text = sum(len(a.text_content() or "") for a in el.findall(".//a"))
    density = link_text / max(length, 1)
    if density > 0.5:
        score -= 20 * density
    # Reward real paragraphs over div soup.
    score += 3 * len([p for p in el.findall(".//p") if len((p.text_content() or "").strip()) > 60])
    return score


def find_content_root(doc):
    candidates = doc.xpath(
        "//article | //main | //*[@role='main'] | //div | //section | //td[@class]"
    )
    best, best_score = None, 0.0
    for el in candidates:
        s = _score_node(el)
        if s > best_score:
            best, best_score = el, s
    # A parent that scores nearly as well but holds more is usually the true container.
    if best is not None:
        parent = best.getparent()
        while parent is not None and parent.tag not in ("body", "html"):
            ps = _score_node(parent)
            if ps > best_score * 1.15:
                best, best_score = parent, ps
                parent = parent.getparent()
            else:
                break
    return best if best is not None else doc.find(".//body")


# ---------------------------------------------------------------- flattening

def _is_boilerplate(text: str) -> bool:
    t = text.strip().lower()
    if len(t) < 3:
        return True
    return t in {
        "share", "share this", "tweet", "advertisement", "related", "related posts",
        "read more", "continue reading", "subscribe", "sign up", "newsletter",
        "comments", "leave a comment", "table of contents", "contents", "menu",
        "skip to content", "cookie policy", "accept all cookies", "previous", "next",
    }


def _text_of(el) -> str:
    return " ".join((el.text_content() or "").split())


def flatten(root, base_url: str, drop_title: str = "") -> list[dict]:
    """Walk the chosen subtree in document order and emit normalised blocks."""
    blocks: list[dict] = []
    seen_text: set[str] = set()
    norm_title = " ".join(drop_title.lower().split())

    def emit(btype: str, text: str = "", **extra):
        if btype in ("p", "li", "quote", "h1", "h2", "h3", "h4"):
            if _is_boilerplate(text):
                return
            key = text.lower()[:180]
            if key in seen_text:
                return
            seen_text.add(key)
            # The page title is rendered separately in the reader header.
            if btype.startswith("h") and " ".join(text.lower().split()) == norm_title:
                return
        blocks.append(make_block(btype, text, **extra))

    def walk(el):
        tag = etree.QName(el).localname.lower() if isinstance(el.tag, str) else ""
        if not tag:
            return

        if tag in ("ul", "ol", "div", "section", "article", "main", "body", "dl",
                   "figcaption", "header", "span", "tbody", "thead", "tr", "td", "th"):
            # Container: recurse, but capture stray text that has no element of its own.
            if tag in ("div", "section", "article", "main", "body"):
                own = (el.text or "").strip()
                if len(own) > 60:
                    emit("p", " ".join(own.split()))
            for child in el:
                walk(child)
            return

        if tag == "img":
            src = el.get("src") or el.get("data-src") or el.get("data-original") or ""
            if src and not src.startswith("data:"):
                emit("image", el.get("alt", "").strip(), src=urljoin(base_url, src))
            return

        if tag == "figure":
            img = el.find(".//img")
            cap = el.find(".//figcaption")
            src = ""
            if img is not None:
                src = img.get("src") or img.get("data-src") or ""
            caption = _text_of(cap) if cap is not None else ""
            if src and not src.startswith("data:"):
                emit("image", caption, src=urljoin(base_url, src))
            elif caption:
                emit("p", caption)
            return

        if tag == "pre":
            code = el.text_content() or ""
            if code.strip():
                blocks.append(make_block("code", code.rstrip()))
            return

        if tag == "table":
            rows = []
            for tr in el.findall(".//tr"):
                cells = [_text_of(c) for c in tr.findall("./td") + tr.findall("./th")]
                if any(cells):
                    rows.append(cells)
            if rows:
                blocks.append(make_block("table", "", rows=rows))
            return

        if tag == "hr":
            emit("hr")
            return

        if tag in BLOCK_LEVEL:
            btype = BLOCK_LEVEL[tag]
            # A list item or paragraph that itself wraps block content: recurse instead.
            if el.findall("./p") or el.findall("./ul") or el.findall("./ol") or el.findall("./div"):
                nested = False
                for child in el:
                    ctag = etree.QName(child).localname.lower() if isinstance(child.tag, str) else ""
                    if ctag in ("p", "ul", "ol", "div", "blockquote", "figure", "pre", "table"):
                        nested = True
                if nested:
                    own = (el.text or "").strip()
                    if own:
                        emit(btype, " ".join(own.split()))
                    for child in el:
                        walk(child)
                    return
            emit(btype, _text_of(el))
            return

        # Anything else: descend.
        for child in el:
            walk(child)

    walk(root)
    return blocks


def extract(html_text: str, url: str) -> dict:
    doc = lhtml.document_fromstring(html_text)
    meta = extract_metadata(doc, url)

    canonical = url
    link = doc.find('.//link[@rel="canonical"]')
    if link is not None and link.get("href"):
        canonical = urljoin(url, link.get("href"))

    _clean_tree(doc)
    root = find_content_root(doc)
    blocks = flatten(root, url, drop_title=meta["title"]) if root is not None else []
    blocks, words, plain = finalise(blocks)

    # If scoring produced almost nothing, fall back to every paragraph on the page.
    if words < 60:
        doc2 = lhtml.document_fromstring(html_text)
        _clean_tree(doc2)
        body = doc2.find(".//body")
        if body is not None:
            fallback = flatten(body, url, drop_title=meta["title"])
            fb_blocks, fb_words, fb_plain = finalise(fallback)
            if fb_words > words:
                blocks, words, plain = fb_blocks, fb_words, fb_plain

    return {
        **{k: v for k, v in meta.items() if k not in ("ld_types", "og_type", "description")},
        "canonical_url": canonical,
        "content": blocks,
        "word_count": words,
        "text_plain": plain,
        "excerpt": excerpt_from(blocks) or meta.get("description", ""),
        "signals": {
            "ld_types": meta["ld_types"],
            "og_type": meta["og_type"],
            "description": meta["description"],
        },
    }
