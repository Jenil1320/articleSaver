"""PDF to readable blocks.

Reports and papers are laid out for print, so the raw text stream is not readable
prose. This pass rebuilds it: measure the body font size, promote larger lines to
headings, drop the running header and footer, rejoin lines broken by the page
width, and repair words split across a line break.

Every block keeps its page number, so a bookmark can name a page.
"""
from __future__ import annotations

import io
import logging
import re
from collections import Counter, defaultdict

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTTextContainer
from pdfminer.pdfparser import PDFSyntaxError

from .blocks import excerpt_from, finalise, make_block

BULLET_RE = re.compile(r"^\s*([•‣◦⁃∙\-\*·▪●]|\(?\d{1,2}[.)])\s+")
PAGE_NUM_RE = re.compile(r"^\s*(page\s+)?\d{1,4}(\s*(/|of)\s*\d{1,4})?\s*$", re.I)
HYPHEN_BREAK_RE = re.compile(r"([A-Za-zÀ-ɏ])-$")


class Line:
    __slots__ = ("text", "size", "bold", "x0", "top", "page")

    def __init__(self, text, size, bold, x0, top, page):
        self.text = text
        self.size = size
        self.bold = bold
        self.x0 = x0
        self.top = top
        self.page = page


def _is_junk_line(text: str) -> bool:
    """Reject artefacts such as the rotated identifier strip down the side of a preprint."""
    if len(text) <= 1:
        return True
    tokens = text.split()
    # Text set sideways decomposes into a column of single characters.
    if len(tokens) >= 3 and sum(len(t) == 1 for t in tokens) / len(tokens) > 0.75:
        return True
    if not re.search(r"[A-Za-z0-9]", text):
        return True
    return False


def _collect_lines(data: bytes) -> tuple[list[Line], int]:
    # word_margin drives where pdfminer inserts the virtual spaces between words.
    laparams = LAParams(line_margin=0.35, char_margin=2.0, word_margin=0.12, boxes_flow=0.5)
    lines: list[Line] = []
    page_count = 0
    for pno, layout in enumerate(extract_pages(io.BytesIO(data), laparams=laparams), start=1):
        page_count = pno
        page_height = layout.height or 792
        for element in layout:
            if not isinstance(element, LTTextContainer):
                continue
            for text_line in element:
                if not hasattr(text_line, "get_text"):
                    continue
                # get_text() includes the LTAnno spaces that mark word boundaries;
                # reading LTChar alone would run every word together.
                text = " ".join((text_line.get_text() or "").split())
                if not text or _is_junk_line(text):
                    continue
                chars = [c for c in text_line if isinstance(c, LTChar)]
                if not chars:
                    continue
                # Ignore glyphs rotated away from the horizontal.
                upright = [c for c in chars if abs(getattr(c, "matrix", (1, 0, 0, 1, 0, 0))[1]) < 0.3]
                if len(upright) < max(1, len(chars) * 0.5):
                    continue
                size = Counter(round(c.size, 1) for c in upright).most_common(1)[0][0]
                fonts = " ".join({c.fontname for c in upright}).lower()
                bold = "bold" in fonts or "black" in fonts or "heavy" in fonts or "semib" in fonts
                top = page_height - text_line.y1
                lines.append(Line(text, size, bold, round(text_line.x0, 1), round(top, 1), pno))
    return lines, page_count


def _drop_running_marginalia(lines: list[Line], page_count: int) -> list[Line]:
    """Remove text that repeats near the top or bottom edge of many pages."""
    if page_count < 3:
        return [ln for ln in lines if not PAGE_NUM_RE.match(ln.text)]

    by_norm: dict[str, set[int]] = defaultdict(set)
    for ln in lines:
        key = re.sub(r"\d+", "#", ln.text.lower()).strip()
        if len(key) > 3:
            by_norm[key].add(ln.page)

    repeated = {k for k, pages in by_norm.items() if len(pages) >= max(3, page_count * 0.4)}

    page_extent = max((ln.top for ln in lines), default=800)
    margin_top = page_extent * 0.08
    margin_bottom = page_extent * 0.90

    kept = []
    for ln in lines:
        key = re.sub(r"\d+", "#", ln.text.lower()).strip()
        near_edge = ln.top <= margin_top or ln.top >= margin_bottom
        if PAGE_NUM_RE.match(ln.text):
            continue
        if key in repeated and near_edge:
            continue
        kept.append(ln)
    return kept


def _body_size(lines: list[Line]) -> float:
    weights: Counter[float] = Counter()
    for ln in lines:
        weights[ln.size] += len(ln.text)
    return weights.most_common(1)[0][0] if weights else 10.0


def _heading_level(size: float, body: float, bold: bool, text: str) -> str | None:
    ratio = size / body if body else 1.0
    if ratio >= 1.55:
        return "h1"
    if ratio >= 1.28:
        return "h2"
    if ratio >= 1.12:
        return "h3"
    # Same size but bold and short reads as a run-in heading.
    if bold and ratio >= 1.0 and len(text) < 90 and not text.endswith((".", ";", ",")):
        return "h3"
    return None


TOKEN_RE = re.compile(r"[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*")


def build_vocabulary(lines: list["Line"]) -> set[str]:
    """Every word the document uses, for deciding what a line-ending hyphen means."""
    vocab: set[str] = set()
    for ln in lines:
        for tok in TOKEN_RE.findall(ln.text):
            vocab.add(tok.lower())
    return vocab


def _join_lines(parts: list[str], vocab: set[str] | None = None) -> str:
    """Join wrapped lines, repairing words the layout split across the line break.

    A hyphen at the end of a line is ambiguous. It may be a soft break inserted by
    the typesetter ("col-" + "lectively"), or a real hyphen in a compound that simply
    fell at the margin ("English-" + "to-German"). Removing it blindly corrupts the
    second kind, which is how "English-to-German" becomes "Englishto-German".

    The document itself settles it: whichever form the text uses elsewhere is the
    form that is meant. With no evidence either way, a soft break is far more common.
    """
    out = ""
    for part in parts:
        if not out:
            out = part
            continue
        if HYPHEN_BREAK_RE.search(out):
            head = TOKEN_RE.findall(out)
            tail = TOKEN_RE.findall(part)
            merged_ok = True
            if vocab and head and tail:
                stem = head[-1].rstrip("-").lower()
                nxt = tail[0].lower()
                if f"{stem}{nxt}" not in vocab and f"{stem}-{nxt}" in vocab:
                    merged_ok = False
            out = (out[:-1] if merged_ok else out) + part
        else:
            out = out + " " + part
    return out


def _assemble(lines: list[Line], body: float, vocab: set[str] | None = None) -> list[dict]:
    blocks: list[dict] = []
    buf: list[str] = []
    buf_page = 1
    buf_top = 0.0

    def flush(btype: str = "p"):
        nonlocal buf
        if not buf:
            return
        text = _join_lines(buf, vocab).strip()
        text = re.sub(r"\s+([,.;:!?])", r"\1", text)
        text = re.sub(r"\s{2,}", " ", text)
        if text:
            # `top` is kept only long enough to interleave the figures, then dropped.
            blocks.append(make_block(btype, text, page=buf_page, top=buf_top))
        buf = []

    # A heading wider than the column is set over several lines; collect them so the
    # reader shows one heading rather than a stack of fragments.
    head_buf: list[str] = []
    head_level: str | None = None
    head_page = 1
    head_prev: Line | None = None

    head_top = 0.0

    def flush_head():
        nonlocal head_buf, head_level, head_prev
        if head_buf and head_level:
            text = _join_lines(head_buf, vocab).strip()
            if text:
                blocks.append(make_block(head_level, text, page=head_page, top=head_top))
        head_buf = []
        head_level = None
        head_prev = None

    prev: Line | None = None
    pending_bullet = False

    for ln in lines:
        level = _heading_level(ln.size, body, ln.bold, ln.text)
        is_bullet = bool(BULLET_RE.match(ln.text))

        if level:
            flush("li" if pending_bullet else "p")
            pending_bullet = False
            continues = (
                head_level == level
                and head_prev is not None
                and ln.page == head_prev.page
                and abs(ln.size - head_prev.size) < 0.6
                and 0 <= (ln.top - head_prev.top) <= ln.size * 2.2
            )
            if not continues:
                flush_head()
                head_level, head_page, head_top = level, ln.page, ln.top
            head_buf.append(ln.text)
            head_prev = ln
            prev = ln
            continue

        flush_head()

        if is_bullet:
            flush("li" if pending_bullet else "p")
            pending_bullet = True
            buf = [BULLET_RE.sub("", ln.text)]
            buf_page, buf_top = ln.page, ln.top
            prev = ln
            continue

        # Decide whether this line continues the current paragraph.
        starts_new = False
        if prev is None:
            starts_new = True
        else:
            gap = ln.top - prev.top
            same_page = ln.page == prev.page
            if not same_page:
                # A page break usually continues a sentence rather than ending one.
                starts_new = prev.text.endswith((".", "!", "?", ":", "”", '"'))
            elif gap > ln.size * 2.1:
                starts_new = True
            elif ln.x0 - prev.x0 > 12 and prev.text.endswith((".", "!", "?")):
                starts_new = True
            elif prev.text.endswith((".", "!", "?")) and ln.text[:1].isupper() and gap > ln.size * 1.6:
                starts_new = True

        if starts_new and buf:
            flush("li" if pending_bullet else "p")
            pending_bullet = False

        if not buf:
            buf_page, buf_top = ln.page, ln.top

        buf.append(ln.text)
        prev = ln

    flush_head()
    flush("li" if pending_bullet else "p")
    return blocks


SMALL_WORDS = {
    "a", "an", "the", "and", "or", "but", "nor", "for", "of", "on", "in", "to",
    "from", "by", "with", "at", "as", "into", "over", "per", "via", "vs",
}


def tidy_shouty_title(title: str) -> str:
    """Cover pages are often set in capitals. A library of shouting titles reads badly.

    Only titles that are almost entirely capitals are touched, and words holding a
    digit are left alone so codes and years survive.
    """
    letters = [c for c in title if c.isalpha()]
    if len(letters) < 12:
        return title
    if sum(c.isupper() for c in letters) / len(letters) < 0.85:
        return title

    def cap(word: str) -> str:
        # Hyphenated compounds get each part capitalised: RENEWABLE-POWERED.
        return "-".join(p[:1].upper() + p[1:].lower() if p else p for p in word.split("-"))

    words = title.split()
    out = []
    for i, word in enumerate(words):
        if any(ch.isdigit() for ch in word):
            out.append(word)
            continue
        stripped = word.strip(":;,.()[]—–-").lower()
        if i > 0 and stripped in SMALL_WORDS:
            out.append(word.lower())
        else:
            out.append(cap(word))
    return " ".join(out)


def _merge_figures(blocks: list[dict], data: bytes, notes: list[str]) -> list[dict]:
    """Place rendered figures into the text flow at the position they occupy on the page.

    A chart or a ruled table is meaning, not decoration. Dropping it would leave the
    reader with prose that refers to something they cannot see.
    """
    try:
        from .figures import extract_figures
        figures = extract_figures(data)
    except Exception:
        # The text is the point; a figure pass that fails must not cost the reader
        # the document. Log it rather than swallow it, or real faults stay invisible.
        logging.getLogger(__name__).warning("Figure extraction failed", exc_info=True)
        notes.append("The charts and tables in this PDF could not be captured.")
        return blocks
    if not figures:
        return blocks

    from .figures import MAX_FIGURES
    if len(figures) >= MAX_FIGURES:
        notes.append(
            f"Only the first {MAX_FIGURES} charts and tables were kept. "
            "The full document is stored, and the text is complete."
        )

    merged: list[dict] = []
    remaining = list(figures)

    # A caption is now shown under its figure, so the same line must not also stand as
    # a paragraph of its own.
    captions = {
        " ".join((f.get("caption") or "").lower().split())
        for f in figures if f.get("caption")
    }
    captions.discard("")

    def emit_figure(fig: dict) -> None:
        merged.append(make_block("image", fig.get("caption", ""), src="",
                                 page=fig["page"], _png=fig["png"],
                                 _suffix=fig.get("suffix", ".png")))

    for block in blocks:
        page = block.get("page", 0)
        top = block.get("top", 0.0)
        # Anything that sits above this block on the same page, or on an earlier
        # page, belongs before it.
        while remaining and (
            remaining[0]["page"] < page
            or (remaining[0]["page"] == page and remaining[0]["top"] <= top)
        ):
            emit_figure(remaining.pop(0))

        if " ".join((block.get("text") or "").lower().split()) in captions:
            continue
        merged.append(block)

    for fig in remaining:
        emit_figure(fig)
    return merged


def extract(data: bytes, url: str = "", filename: str = "",
            with_figures: bool = True) -> dict:
    try:
        lines, page_count = _collect_lines(data)
    except PDFSyntaxError as exc:
        raise ValueError(f"That file is not a readable PDF ({exc}).") from exc


    if not lines:
        raise ValueError(
            "No text could be read from this PDF. It is probably a scan of a printed page, "
            "which needs optical character recognition."
        )

    lines = _drop_running_marginalia(lines, page_count)
    body = _body_size(lines)
    vocab = build_vocabulary(lines)
    blocks = _assemble(lines, body, vocab)

    # Title: the largest text on page one, else the file name.
    title = ""
    page1 = [ln for ln in lines if ln.page == 1]
    if page1:
        biggest = max(ln.size for ln in page1)
        if biggest > body * 1.15:
            parts = [ln.text for ln in page1 if ln.size >= biggest - 0.6][:3]
            title = " ".join(parts).strip()
    if len(title) > 220 or len(title) < 4:
        title = ""
    if not title:
        title = re.sub(r"[-_]+", " ", (filename or "Document").rsplit(".", 1)[0]).strip()
    title = tidy_shouty_title(title)

    # The reader renders the title itself, so a body block repeating it is noise.
    # It is not always first: an arXiv page puts a permission notice above it.
    norm = " ".join(title.lower().split())
    cleaned: list[dict] = []
    for i, block in enumerate(blocks):
        if (i < 12 and block["type"] in ("h1", "h2", "h3")
                and " ".join(block["text"].lower().split()) == norm):
            continue
        cleaned.append(block)
    blocks = cleaned

    # A "heading" that runs to sentence length and ends with a full stop is body
    # text set large or bold, not a heading. Rendering it as one shouts.
    for block in blocks:
        if (block["type"] in ("h2", "h3") and len(block["text"]) > 110
                and block["text"].rstrip().endswith((".", "!", "?"))):
            block["type"] = "p"

    notes: list[str] = []
    if with_figures:
        blocks = _merge_figures(blocks, data, notes)

    # `top` was only needed to place the figures.
    for b in blocks:
        b.pop("top", None)

    blocks, words, plain = finalise(blocks)

    # A paper's own summary beats whichever paragraph happens to come first —
    # page one often opens with permission notices and author affiliations.
    excerpt = excerpt_from(blocks)
    for i, block in enumerate(blocks):
        if block["type"].startswith("h") and block["text"].strip().lower() in (
                "abstract", "summary", "executive summary"):
            follows = next((b for b in blocks[i + 1:]
                            if b["type"] == "p" and b["words"] > 20), None)
            if follows:
                text = follows["text"]
                excerpt = text[:279].rstrip() + "…" if len(text) > 280 else text
            break

    return {
        "title": title[:300],
        "byline": "",
        "site_name": (url.split("/")[2].replace("www.", "") if url.startswith("http") else "PDF"),
        "published_at": None,
        "lead_image": None,
        "canonical_url": url,
        "content": blocks,
        "word_count": words,
        "text_plain": plain,
        "excerpt": excerpt,
        "page_count": page_count,
        "kind_hint": "paper",
        "warnings": notes,
        "signals": {"ld_types": [], "og_type": "", "description": ""},
    }

