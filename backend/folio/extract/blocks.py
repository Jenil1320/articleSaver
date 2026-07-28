"""The normalised document format shared by every extractor.

A document is a flat list of blocks. Each block carries the running word offset of
its first word, so any word in the document has one stable global index. That single
choice makes two features exact rather than approximate:

  * reading progress, measured word by word;
  * highlight anchors, stored as (block, start_word, end_word) instead of DOM offsets,
    so they survive re-rendering, font changes and reflow.
"""
from __future__ import annotations

import re

# Blocks that hold prose and therefore count towards reading progress.
PROSE_TYPES = {"p", "li", "quote", "h1", "h2", "h3", "h4"}

_WORD_RE = re.compile(r"\S+")


def count_words(text: str) -> int:
    return len(_WORD_RE.findall(text or ""))


def make_block(btype: str, text: str = "", **extra) -> dict:
    b = {"type": btype, "text": text}
    b.update(extra)
    return b


def finalise(blocks: list[dict]) -> tuple[list[dict], int, str]:
    """Assign word offsets and indices. Returns (blocks, total_words, plain_text)."""
    cleaned: list[dict] = []
    for b in blocks:
        text = (b.get("text") or "").strip()
        if b["type"] in PROSE_TYPES and not text:
            continue
        if b["type"] == "code" and not text:
            continue
        b["text"] = text
        cleaned.append(b)

    # Collapse runs of duplicate headings/rules that survive extraction.
    deduped: list[dict] = []
    for b in cleaned:
        if (
            deduped
            and b["type"] == deduped[-1]["type"]
            and b["type"] in ("hr", "h1", "h2", "h3")
            and b["text"] == deduped[-1]["text"]
        ):
            continue
        deduped.append(b)

    total = 0
    for i, b in enumerate(deduped):
        b["i"] = i
        if b["type"] in PROSE_TYPES:
            n = count_words(b["text"])
            b["start"] = total
            b["words"] = n
            total += n
        else:
            b["start"] = total
            b["words"] = 0

    plain = "\n\n".join(b["text"] for b in deduped if b["type"] in PROSE_TYPES and b["text"])
    return deduped, total, plain


def excerpt_from(blocks: list[dict], limit: int = 280) -> str:
    for b in blocks:
        if b["type"] == "p" and len(b["text"]) > 80:
            text = b["text"]
            return text[: limit - 1].rstrip() + "…" if len(text) > limit else text
    for b in blocks:
        if b["type"] in PROSE_TYPES and b["text"]:
            text = b["text"]
            return text[: limit - 1].rstrip() + "…" if len(text) > limit else text
    return ""
