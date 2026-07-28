"""Fetching a URL, with escalation.

Three tiers, cheapest first:
  1. plain HTTP via requests            - handles most sites
  2. headless Chromium via Playwright   - handles JS-rendered pages and JS challenges
  3. give up, and say why                - the caller then offers upload / paste

Tier 2 is optional: if Playwright is not installed the fetcher degrades to tier 1
rather than failing to import.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import requests

from .. import config


@dataclass
class Fetched:
    url: str                 # final URL after redirects
    status: int
    content_type: str
    body: bytes
    text: str = ""
    method: str = "http"     # http | browser
    warnings: list[str] = field(default_factory=list)

    @property
    def is_pdf(self) -> bool:
        return "application/pdf" in self.content_type.lower() or self.body[:5].startswith(b"%PDF")

    @property
    def is_html(self) -> bool:
        return "html" in self.content_type.lower() or bool(
            re.search(rb"<html|<!doctype html", self.body[:2048], re.I)
        )


BASE_HEADERS = {
    "User-Agent": config.BROWSER_UA,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/pdf,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-GB,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

# Markers that mean "this is a bot wall, not the article".
CHALLENGE_MARKERS = (
    "just a moment",
    "enable javascript and cookies to continue",
    "checking your browser",
    "cf-browser-verification",
    "_cf_chl_opt",
    "attention required! | cloudflare",
    "px-captcha",
)

# Sites that always need a real browser: they render client-side or gate on JS.
BROWSER_FIRST_HOSTS = ("x.com", "twitter.com", "mobile.twitter.com")


def _looks_challenged(status: int, text: str) -> bool:
    if status in (403, 429, 503):
        return True
    head = text[:6000].lower()
    return any(m in head for m in CHALLENGE_MARKERS)


def fetch_http(url: str) -> Fetched:
    with requests.Session() as s:
        s.headers.update(BASE_HEADERS)
        r = s.get(url, timeout=config.FETCH_TIMEOUT, allow_redirects=True, stream=True)
        chunks, total = [], 0
        for chunk in r.iter_content(65536):
            chunks.append(chunk)
            total += len(chunk)
            if total > config.MAX_DOWNLOAD_BYTES:
                r.close()
                raise ValueError(
                    f"File is larger than the {config.MAX_DOWNLOAD_BYTES // (1024*1024)} MB limit."
                )
        body = b"".join(chunks)
        ctype = r.headers.get("content-type", "")
        text = ""
        if "html" in ctype.lower() or "text" in ctype.lower() or "json" in ctype.lower():
            enc = r.encoding or "utf-8"
            text = body.decode(enc, errors="replace")
        return Fetched(url=r.url, status=r.status_code, content_type=ctype, body=body, text=text)


def fetch_browser(url: str) -> Fetched:
    """Render with headless Chromium. Also catches a PDF served as a download."""
    from playwright.sync_api import sync_playwright  # imported lazily: optional dependency

    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
        )
        ctx = browser.new_context(
            user_agent=config.BROWSER_UA,
            viewport={"width": 1280, "height": 1800},
            locale="en-GB",
            accept_downloads=True,
        )
        # Hide the most obvious automation tell.
        ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        )
        page = ctx.new_page()
        captured: dict[str, bytes] = {}

        def on_response(resp):
            try:
                ct = (resp.headers or {}).get("content-type", "")
                if "application/pdf" in ct.lower() and resp.url not in captured:
                    captured[resp.url] = resp.body()
            except Exception:
                pass

        page.on("response", on_response)

        final_url, status, ctype, body, text = url, 0, "", b"", ""
        try:
            resp = page.goto(url, timeout=config.FETCH_TIMEOUT * 1000, wait_until="domcontentloaded")
            if resp:
                status = resp.status
                ctype = (resp.headers or {}).get("content-type", "")
            # Give a JS challenge time to clear itself.
            for _ in range(3):
                content = page.content()
                if not any(m in content[:6000].lower() for m in CHALLENGE_MARKERS):
                    break
                page.wait_for_timeout(3500)
            try:
                page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
            final_url = page.url
            text = page.content()
            body = text.encode("utf-8", errors="replace")
            if not ctype:
                ctype = "text/html"
        except Exception as exc:
            msg = str(exc)
            # Chromium refuses to render PDFs; the response hook still captured the bytes.
            if "net::ERR_ABORTED" not in msg and not captured:
                raise
        finally:
            # A PDF response beats the HTML shell.
            for pdf_url, pdf_bytes in captured.items():
                if pdf_bytes[:5].startswith(b"%PDF"):
                    final_url, ctype, body, text = pdf_url, "application/pdf", pdf_bytes, ""
                    status = status or 200
                    break
            ctx.close()
            browser.close()

        return Fetched(
            url=final_url, status=status or 200, content_type=ctype,
            body=body, text=text, method="browser",
        )


def fetch(url: str) -> Fetched:
    """Fetch `url`, escalating to a real browser when the cheap path is blocked."""
    host = re.sub(r"^www\.", "", (re.split(r"/+", url)[1] if "//" in url else url)).lower()
    warnings: list[str] = []

    if config.USE_BROWSER_FALLBACK and any(host.endswith(h) for h in BROWSER_FIRST_HOSTS):
        try:
            return fetch_browser(url)
        except Exception as exc:
            warnings.append(f"Browser render failed ({type(exc).__name__}); used a plain fetch.")

    try:
        res = fetch_http(url)
    except Exception as exc:
        if not config.USE_BROWSER_FALLBACK:
            raise
        res = fetch_browser(url)
        res.warnings.extend(warnings + [f"Plain fetch failed ({type(exc).__name__})."])
        return res

    blocked = _looks_challenged(res.status, res.text) if not res.is_pdf else res.status >= 400
    if blocked and config.USE_BROWSER_FALLBACK:
        try:
            better = fetch_browser(url)
            if better.status < 400 and not _looks_challenged(better.status, better.text):
                better.warnings.extend(warnings)
                return better
            res.warnings.append(
                "The site is behind a bot check that the reader could not clear."
            )
        except Exception as exc:
            res.warnings.append(f"Browser fallback failed ({type(exc).__name__}).")

    res.warnings.extend(warnings)
    if res.status >= 400:
        raise PermissionError(
            f"The site refused the request (HTTP {res.status}). "
            "Open it in your browser and use Share to Folio, or upload the file."
        )
    return res
