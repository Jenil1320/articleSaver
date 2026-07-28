"""Backend tests: extraction, classification, storage, progress and the reading queue.

These need no network and no running server. Run with:

    python -m pytest tests/test_backend.py -v
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

# Each run gets its own database, so tests never touch the real library.
_TMP = tempfile.mkdtemp(prefix="folio-tests-")
os.environ["FOLIO_DATA_DIR"] = _TMP
os.environ["FOLIO_DB"] = str(Path(_TMP) / "test.db")

from folio import classify, db, ingest, store              # noqa: E402
from folio.extract import html as html_extract             # noqa: E402
from folio.extract.blocks import count_words, finalise, make_block  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    db.init()
    db.execute("DELETE FROM items")
    db.execute("DELETE FROM annotations")
    db.execute("DELETE FROM themes")
    yield


# ─────────────────────────────────────────── block model

def test_word_offsets_are_contiguous():
    blocks, total, plain = finalise([
        make_block("h1", "A heading here"),          # 3
        make_block("p", "One two three four five"),  # 5
        make_block("p", "Six seven"),                # 2
    ])
    assert total == 10
    assert [b["start"] for b in blocks] == [0, 3, 8]
    assert [b["words"] for b in blocks] == [3, 5, 2]
    assert "One two three four five" in plain


def test_non_prose_blocks_do_not_consume_words():
    blocks, total, _ = finalise([
        make_block("p", "One two"),
        make_block("image", "", src="/media/x.png"),
        make_block("p", "Three four"),
    ])
    assert total == 4
    assert blocks[1]["words"] == 0
    # The paragraph after an image still starts where the first one ended.
    assert blocks[2]["start"] == 2


def test_empty_prose_blocks_are_dropped():
    blocks, total, _ = finalise([
        make_block("p", "   "),
        make_block("p", "Real text"),
    ])
    assert len(blocks) == 1
    assert total == 2


def test_count_words():
    assert count_words("one  two\tthree\nfour") == 4
    assert count_words("") == 0


# ─────────────────────────────────────────── html extraction

SAMPLE = """
<html><head>
  <title>A Test Article | Example Site</title>
  <meta property="og:title" content="A Test Article">
  <meta property="og:site_name" content="Example Site">
  <meta property="og:type" content="article">
  <meta name="author" content="By Jane Doe">
  <meta property="article:published_time" content="2026-03-04T10:00:00Z">
  <link rel="canonical" href="https://example.com/real-url">
</head><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <article>
    <h1>A Test Article</h1>
    <p>The opening paragraph carries enough words to be scored as real prose,
       with commas, clauses and length.</p>
    <h2>A section</h2>
    <p>A second substantial paragraph, also long enough to count towards the
       score that picks the content container.</p>
    <ul><li>First point</li><li>Second point</li></ul>
    <blockquote>A quoted line.</blockquote>
    <pre><code>print("hello")</code></pre>
  </article>
  <aside class="related"><p>Related posts you might like</p></aside>
  <footer><p>Copyright notice</p></footer>
</body></html>
"""


def test_html_metadata():
    r = html_extract.extract(SAMPLE, "https://example.com/a?utm_source=x")
    assert r["title"] == "A Test Article"
    assert r["byline"] == "Jane Doe"          # the "By " prefix is stripped
    assert r["site_name"] == "Example Site"
    assert r["published_at"].startswith("2026-03-04")
    assert r["canonical_url"] == "https://example.com/real-url"


def test_html_keeps_prose_and_drops_chrome():
    r = html_extract.extract(SAMPLE, "https://example.com/a")
    text = r["text_plain"]
    assert "opening paragraph" in text
    assert "second substantial paragraph" in text
    assert "Home" not in text and "About" not in text
    assert "Copyright notice" not in text
    types = {b["type"] for b in r["content"]}
    assert {"p", "h2", "li", "quote", "code"} <= types


def test_html_drops_the_duplicated_title():
    r = html_extract.extract(SAMPLE, "https://example.com/a")
    headings = [b["text"] for b in r["content"] if b["type"].startswith("h")]
    assert "A Test Article" not in headings, "the reader renders the title itself"


# ─────────────────────────────────────────── classification

def _blocks(paragraphs, headings=0):
    out = [make_block("h2", f"Heading {i}") for i in range(headings)]
    out += [make_block("p", p) for p in paragraphs]
    return finalise(out)[0]


def test_long_essay_is_an_article():
    body = "This essay explores a question at length. " * 90
    kind, _ = classify.classify_kind(
        url="https://example.com/blog/thing", title="An essay",
        blocks=_blocks([body]), word_count=1400, text_plain=body,
        signals={"og_type": "article", "ld_types": ["Article"]},
    )
    assert kind == "article"


def test_marketing_page_is_a_product():
    body = ("Our platform helps teams. Book a demo today. Pricing starts low. "
            "Trusted by leading companies. Get started free.")
    kind, _ = classify.classify_kind(
        url="https://acme.com/product", title="Acme Platform",
        blocks=_blocks([body], headings=6), word_count=120, text_plain=body,
        signals={"og_type": "website", "ld_types": []},
    )
    assert kind == "product"


def test_paper_is_recognised():
    body = ("Abstract. In this paper we propose a method. Related work is reviewed. "
            "References follow. doi: 10.1000/xyz")
    kind, _ = classify.classify_kind(
        url="https://arxiv.org/abs/1234", title="A method",
        blocks=_blocks([body]), word_count=6000, text_plain=body,
        kind_hint="paper", page_count=14,
    )
    assert kind == "paper"


def test_pasted_text_is_never_a_product():
    """Short pasted notes were once classified as marketing pages."""
    kind, _ = classify.classify_kind(
        url="", title="Quick note", blocks=_blocks(["A short thought."]),
        word_count=12, text_plain="A short thought.", kind_hint="text",
    )
    assert kind == "article"


def test_theme_suggestion_for_energy():
    text = ("The grid must integrate more solar and wind. Curtailment rises when "
            "transmission is constrained. Battery storage and demand response help "
            "balance the power system. Dispatch of renewable energy needs forecasting.")
    theme, options = classify.suggest_theme(title="Grid integration", text_plain=text)
    assert theme == "Energy & Grid"
    assert "Energy & Grid" in options


def test_theme_falls_back_to_unsorted():
    theme, _ = classify.suggest_theme(title="Hello", text_plain="Just setting up my twttr")
    assert theme == "Unsorted"


# ─────────────────────────────────────────── ingest

def test_pasted_markdown_becomes_blocks():
    item = ingest.from_text(
        "# Title\n\nA paragraph of text.\n\n- one\n- two\n\n## Later\n\nMore text.",
        title="My note",
    )
    types = [b["type"] for b in item["content"]]
    assert "h1" in types and "li" in types and "p" in types
    assert item["kind"] == "article"
    assert item["word_count"] > 5


def test_url_normalisation_strips_tracking():
    out = ingest.normalise_url(
        "https://example.com/a?utm_source=share&utm_medium=member_android&id=7")
    assert "utm_source" not in out and "utm_medium" not in out
    assert "id=7" in out


def test_url_normalisation_adds_scheme():
    assert ingest.normalise_url("example.com/x").startswith("https://")


def test_url_normalisation_rejects_rubbish():
    with pytest.raises(ValueError):
        ingest.normalise_url("")


# ─────────────────────────────────────────── store

def _make_item(**over):
    data = {
        "url": "https://example.com/x", "canonical_url": "https://example.com/x",
        "kind": "article", "title": "An item", "byline": "", "site_name": "Example",
        "excerpt": "", "word_count": 1000, "content": [make_block("p", "word " * 1000)],
        "text_plain": "word " * 1000, "theme": "Energy & Grid", "theme_options": ["Energy & Grid"],
        "source": "url", "warnings": [],
    }
    data.update(over)
    return store.create_item(data)


def test_create_and_read_item():
    item_id = _make_item()
    item = store.get_item(item_id)
    assert item["title"] == "An item"
    assert item["status"] == "unread"
    assert item["reading_minutes"] >= 1
    assert item["theme"] == "Energy & Grid"


def test_duplicate_detection():
    _make_item()
    assert store.find_by_url("https://example.com/x") is not None
    assert store.find_by_url("https://example.com/other") is None


def test_progress_only_moves_forward():
    item_id = _make_item()
    store.record_progress(item_id, progress_words=400)
    assert store.get_item(item_id)["progress_words"] == 400
    store.record_progress(item_id, progress_words=120)
    assert store.get_item(item_id)["progress_words"] == 400, "progress must not regress"


def test_progress_marks_finished_at_the_threshold():
    item_id = _make_item()
    store.record_progress(item_id, progress_words=960)     # 96% of 1000
    item = store.get_item(item_id)
    assert item["status"] == "finished"
    assert item["finished_at"]


def test_progress_is_capped_at_the_word_count():
    item_id = _make_item()
    store.record_progress(item_id, progress_words=99999)
    assert store.get_item(item_id)["progress_words"] == 1000


def test_marking_unread_resets_progress():
    item_id = _make_item()
    store.record_progress(item_id, progress_words=900)
    store.update_item(item_id, {"status": "unread"})
    item = store.get_item(item_id)
    assert item["progress_words"] == 0 and item["status"] == "unread"


def test_user_theme_is_recorded_as_a_choice():
    item_id = _make_item()
    store.update_item(item_id, {"theme": "My Own Shelf"})
    row = db.one("SELECT theme, theme_source FROM items WHERE id=?", (item_id,))
    assert row["theme"] == "My Own Shelf"
    assert row["theme_source"] == "user", "a human decision must not be overwritten later"


# ─────────────────────────────────────────── annotations

def test_annotation_round_trip():
    item_id = _make_item()
    ann = store.create_annotation(item_id, {
        "kind": "highlight", "block_index": 0, "start_word": 10, "end_word": 20,
        "quote": "some words", "colour": "green",
    })
    assert ann["colour"] == "green"
    assert len(store.list_annotations(item_id)) == 1

    store.update_annotation(ann["id"], {"note": "a thought"})
    assert store.list_annotations(item_id)[0]["note"] == "a thought"

    store.delete_annotation(ann["id"])
    assert store.list_annotations(item_id) == []


def test_bookmark_advances_progress():
    """A bookmark says how far the reader got, so it moves progress with it."""
    item_id = _make_item()
    store.create_annotation(item_id, {
        "kind": "bookmark", "block_index": 0, "start_word": 500, "end_word": 501,
        "quote": "here",
    })
    assert store.get_item(item_id)["progress_words"] == 500


def test_rejects_unknown_annotation_kind():
    item_id = _make_item()
    with pytest.raises(ValueError):
        store.create_annotation(item_id, {"kind": "scribble"})


def test_deleting_an_item_hides_its_marks():
    item_id = _make_item()
    store.create_annotation(item_id, {"kind": "highlight", "block_index": 0,
                                      "start_word": 0, "end_word": 3, "quote": "x"})
    store.delete_item(item_id)
    assert store.list_annotations(item_id) == []
    assert all(a["item_id"] != item_id for a in store.all_annotations())


# ─────────────────────────────────────────── queue and filtering

def _age_item(item_id: str, days: int, *, opened: bool = False):
    when = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    column = "last_opened_at" if opened else "saved_at"
    db.execute(f"UPDATE items SET {column}=? WHERE id=?", (when, item_id))


def test_queue_surfaces_stale_unread_items():
    fresh = _make_item(title="Saved today")
    old = _make_item(url="https://example.com/old", canonical_url="https://example.com/old",
                     title="Saved long ago")
    _age_item(old, 20)

    queue = store.reading_queue()
    titles = [i["title"] for i in queue]
    assert "Saved long ago" in titles
    assert "Saved today" not in titles, "something saved today is not overdue"
    assert fresh


def test_queue_skips_products():
    old = _make_item(kind="product", title="A tool")
    _age_item(old, 30)
    assert all(i["title"] != "A tool" for i in store.reading_queue())


def test_queue_respects_a_snooze():
    old = _make_item(title="Snoozed")
    _age_item(old, 30)
    later = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    store.update_item(old, {"snoozed_until": later})
    assert all(i["title"] != "Snoozed" for i in store.reading_queue())


def test_queue_skips_finished_items():
    old = _make_item(title="Done already")
    _age_item(old, 30)
    store.update_item(old, {"status": "finished"})
    assert all(i["title"] != "Done already" for i in store.reading_queue())


def test_list_items_filters():
    a = _make_item(title="Energy piece", theme="Energy & Grid")
    _make_item(url="https://example.com/b", canonical_url="https://example.com/b",
               title="A tool", kind="product", theme="Software & Engineering")

    assert len(store.list_items(kind="readable")) == 1
    assert len(store.list_items(kind="product")) == 1
    assert len(store.list_items(theme="Energy & Grid")) == 1
    assert len(store.list_items(q="energy")) == 1
    store.update_item(a, {"status": "finished"})
    assert len(store.list_items(status="finished")) == 1
    assert len(store.list_items(status="unfinished")) == 1


def test_rename_theme_moves_every_item():
    _make_item(theme="Old Name")
    _make_item(url="https://example.com/2", canonical_url="https://example.com/2",
               theme="Old Name")
    changed = store.rename_theme("Old Name", "New Name")
    assert changed == 2
    assert len(store.list_items(theme="New Name")) == 2


def test_sync_delta_reports_changes():
    before = db.now()
    item_id = _make_item()
    delta = store.changes_since(before)
    assert any(i["id"] == item_id for i in delta["items"])
    assert delta["items"][0]["content"], "the mirror needs the full text to read offline"


def test_deletes_propagate_through_sync():
    item_id = _make_item()
    marker = db.now()
    store.delete_item(item_id)
    delta = store.changes_since(marker)
    deleted = [i for i in delta["items"] if i["id"] == item_id]
    assert deleted and deleted[0]["deleted"] is True, "a delete must reach the phone"


def test_stats():
    _make_item()
    s = store.stats()
    assert s["total"] == 1 and s["unread"] == 1


# ─────────────────────────────────────────── email digest

def test_digest_lists_what_is_waiting():
    from folio import reminders

    old = _make_item(title="An unfinished report")
    _age_item(old, 14)
    store.record_progress(old, progress_words=300)      # 30% read

    queue = store.reading_queue()
    assert queue, "the digest needs something to report"
    subject, text, html = reminders.build_digest(queue, store.stats())

    assert "Folio" in subject
    assert "An unfinished report" in text and "An unfinished report" in html
    assert "30% read" in text
    assert queue[0]["reason"] in text, "the digest should say why an item resurfaced"
    assert html.strip().startswith("<!doctype html>")
    assert f"/?open={old}" in html, "each entry should link into the app"


def test_digest_refuses_politely_without_a_mail_server():
    from folio import config, reminders

    if config.smtp_configured():
        pytest.skip("a mail server is configured in this environment")
    ok, message = reminders.send_digest(force=True)
    assert ok is False
    assert "FOLIO_SMTP_HOST" in message, "the message should say what is missing"
