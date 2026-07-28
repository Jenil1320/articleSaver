"""Turn a URL, an uploaded file or pasted text into a saved item.

Images are copied to local storage at save time. A reader that still points at the
original host is not offline: the words would load from the phone and the pictures
would not.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import re
from urllib.parse import urljoin, urlparse

import requests

from . import classify, config, db
from .extract import html as html_extract
from .extract import pdf as pdf_extract
from .extract import social
from .extract.blocks import excerpt_from, finalise, make_block
from .extract.fetch import fetch

MAX_IMAGES = 40
MAX_IMAGE_BYTES = 6 * 1024 * 1024
IMAGE_EXT = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg",
}


def _store_bytes(data: bytes, suffix: str) -> str:
    digest = hashlib.sha256(data).hexdigest()[:20]
    name = f"{digest}{suffix}"
    path = config.MEDIA_DIR / name
    if not path.exists():
        path.write_bytes(data)
    return f"/media/{name}"


def localise_images(blocks: list[dict], base_url: str, warnings: list[str]) -> None:
    """Download referenced images and repoint the blocks at local copies."""
    seen: dict[str, str] = {}
    downloaded = 0
    for block in blocks:
        if block.get("type") != "image":
            continue

        # Figures rendered out of a PDF arrive as raw bytes rather than a URL.
        png = block.pop("_png", None)
        suffix = block.pop("_suffix", ".png")
        if png:
            block["src"] = _store_bytes(png, suffix)
            block["figure"] = True
            downloaded += 1
            continue

        src = block.get("src") or ""
        if not src or src.startswith("/media/"):
            continue
        if src in seen:
            block["src"] = seen[src]
            continue
        if downloaded >= MAX_IMAGES:
            block["src"] = ""
            continue
        try:
            absolute = urljoin(base_url, src)
            r = requests.get(
                absolute,
                headers={"User-Agent": config.BROWSER_UA, "Referer": base_url},
                timeout=25,
                stream=True,
            )
            if not r.ok:
                raise OSError(f"HTTP {r.status_code}")
            payload = b""
            for chunk in r.iter_content(65536):
                payload += chunk
                if len(payload) > MAX_IMAGE_BYTES:
                    raise OSError("image too large")
            ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
            suffix = IMAGE_EXT.get(ctype) or mimetypes.guess_extension(ctype or "") or ".img"
            local = _store_bytes(payload, suffix)
            seen[src] = local
            block["src"] = local
            downloaded += 1
        except Exception:
            block["src"] = ""      # the reader skips images with no source
    dropped = sum(1 for b in blocks if b.get("type") == "image" and not b.get("src"))
    if dropped:
        warnings.append(f"{dropped} image(s) could not be saved for offline use.")


def _persist_original(data: bytes, suffix: str) -> str:
    digest = hashlib.sha256(data).hexdigest()[:20]
    name = f"{digest}{suffix}"
    path = config.ORIGINALS_DIR / name
    if not path.exists():
        path.write_bytes(data)
    return name


def _finish(extracted: dict, *, url: str, source: str, method: str,
            warnings: list[str], original_file: str | None = None,
            lead_image_local: bool = True) -> dict:
    warnings.extend(extracted.get("warnings") or [])
    blocks = extracted.get("content") or []
    localise_images(blocks, extracted.get("canonical_url") or url or "", warnings)
    blocks, words, plain = finalise(blocks)

    lead = extracted.get("lead_image")
    if lead and lead_image_local and not str(lead).startswith("/media/"):
        try:
            r = requests.get(lead, headers={"User-Agent": config.BROWSER_UA}, timeout=20)
            if r.ok and len(r.content) <= MAX_IMAGE_BYTES:
                ctype = (r.headers.get("content-type") or "").split(";")[0].lower()
                lead = _store_bytes(r.content, IMAGE_EXT.get(ctype, ".jpg"))
            else:
                lead = None
        except Exception:
            lead = None

    verdict = classify.analyse(
        url=extracted.get("canonical_url") or url or "",
        title=extracted.get("title", ""),
        blocks=blocks,
        word_count=words,
        text_plain=plain,
        signals=extracted.get("signals"),
        kind_hint=extracted.get("kind_hint", ""),
        page_count=extracted.get("page_count", 0),
    )

    return {
        "url": url,
        "canonical_url": extracted.get("canonical_url") or url,
        "kind": verdict["kind"],
        "title": (extracted.get("title") or "Untitled").strip()[:400],
        "byline": (extracted.get("byline") or "").strip()[:200],
        "site_name": (extracted.get("site_name") or "").strip()[:120],
        "published_at": extracted.get("published_at"),
        "excerpt": extracted.get("excerpt") or excerpt_from(blocks),
        "lead_image": lead,
        "word_count": words,
        "content": blocks,
        "text_plain": plain,
        "theme": verdict["theme"],
        "theme_options": verdict["theme_options"],
        "kind_confidence": verdict["kind_confidence"],
        "source": source,
        "extract_method": method,
        "original_file": original_file,
        "warnings": warnings,
        "page_count": extracted.get("page_count", 0),
    }


def normalise_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise ValueError("No link was given.")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url.lstrip("/")
    parsed = urlparse(url)
    if not parsed.netloc:
        raise ValueError(f"{raw!r} is not a valid link.")
    # Strip the tracking parameters that arrive with shared links.
    if parsed.query:
        keep = []
        for part in parsed.query.split("&"):
            key = part.split("=")[0].lower()
            if key.startswith(("utm_", "fbclid", "gclid", "mc_", "igshid", "rcm", "originaltracking")):
                continue
            if key in ("ref", "ref_src", "share", "si"):
                continue
            keep.append(part)
        url = url.split("?")[0] + (("?" + "&".join(keep)) if keep else "")
    return url


def from_url(raw_url: str) -> dict:
    url = normalise_url(raw_url)
    warnings: list[str] = []

    if social.is_tweet(url):
        data = social.extract_tweet(url)
        return _finish(data, url=url, source="url", method="oembed", warnings=warnings)

    result = fetch(url)
    warnings.extend(result.warnings)

    if result.is_pdf:
        original = _persist_original(result.body, ".pdf")
        data = pdf_extract.extract(result.body, url=result.url,
                                   filename=urlparse(result.url).path.rsplit("/", 1)[-1])
        return _finish(data, url=url, source="url", method=f"{result.method}+pdf",
                       warnings=warnings, original_file=original)

    if social.is_linkedin_post(url):
        try:
            data = social.extract_linkedin(result.text, result.url)
            return _finish(data, url=url, source="url", method=f"{result.method}+linkedin",
                           warnings=warnings)
        except LookupError as exc:
            warnings.append(str(exc))

    if not result.is_html:
        raise ValueError("That link is not a web page or a PDF.")

    data = html_extract.extract(result.text, result.url)
    if data["word_count"] < 25:
        warnings.append(
            "Very little text was found. The page may need JavaScript or a login."
        )
    return _finish(data, url=url, source="url", method=f"{result.method}+html", warnings=warnings)


def from_upload(filename: str, data: bytes) -> dict:
    warnings: list[str] = []
    name = (filename or "file").rsplit("/", 1)[-1]
    lower = name.lower()

    if data[:5].startswith(b"%PDF") or lower.endswith(".pdf"):
        original = _persist_original(data, ".pdf")
        extracted = pdf_extract.extract(data, url="", filename=name)
        return _finish(extracted, url="", source="upload", method="upload+pdf",
                       warnings=warnings, original_file=original)

    if lower.endswith((".html", ".htm", ".mhtml")):
        text = data.decode("utf-8", errors="replace")
        extracted = html_extract.extract(text, "")
        if not extracted.get("title"):
            extracted["title"] = name.rsplit(".", 1)[0]
        return _finish(extracted, url="", source="upload", method="upload+html",
                       warnings=warnings)

    if lower.endswith((".txt", ".md", ".markdown")):
        text = data.decode("utf-8", errors="replace")
        return from_text(text, title=name.rsplit(".", 1)[0], source="upload")

    raise ValueError("Folio can open PDF, HTML, Markdown and plain text files.")


def from_text(text: str, *, title: str = "", url: str = "", source: str = "paste") -> dict:
    lines = [ln.rstrip() for ln in (text or "").replace("\r\n", "\n").split("\n")]
    blocks: list[dict] = []
    buf: list[str] = []

    def flush():
        nonlocal buf
        if buf:
            blocks.append(make_block("p", " ".join(" ".join(buf).split())))
            buf = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        heading = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading:
            flush()
            level = min(len(heading.group(1)), 4)
            blocks.append(make_block(f"h{level}", heading.group(2).strip()))
            continue
        bullet = re.match(r"^\s*([-*•]|\d+[.)])\s+(.*)$", stripped)
        if bullet:
            flush()
            blocks.append(make_block("li", bullet.group(2).strip()))
            continue
        buf.append(stripped)
    flush()

    if not blocks:
        raise ValueError("There was no text to save.")

    blocks, words, plain = finalise(blocks)
    if not title:
        first = next((b["text"] for b in blocks if b["text"]), "Note")
        title = first[:90] + ("…" if len(first) > 90 else "")

    extracted = {
        "title": title, "byline": "", "site_name": "Pasted", "published_at": None,
        "lead_image": None, "canonical_url": url, "content": blocks,
        "word_count": words, "text_plain": plain, "excerpt": excerpt_from(blocks),
        "kind_hint": "text",
        "signals": {"ld_types": [], "og_type": "", "description": ""},
    }
    return _finish(extracted, url=url, source=source, method="text", warnings=[])
