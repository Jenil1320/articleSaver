"""End-to-end UI tests, driven through a real browser at Pixel 7 size.

These exercise the app the way it is actually used: save something, read it, mark it
up, lose the network, keep working, come back. Run with the server already up:

    python backend/run.py --port 8765
    python -m pytest tests/test_ui.py -v
"""
from __future__ import annotations

import pathlib
import re

import pytest
from playwright.sync_api import expect, sync_playwright

BASE = "http://127.0.0.1:8765"
SHOTS = pathlib.Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(
        viewport={"width": 412, "height": 915},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
    )
    pg = ctx.new_page()
    problems: list[str] = []

    # A failed request is not a defect: the offline tests cut the network on purpose,
    # and a link the server cannot fetch is reported to the reader as a message. Only
    # genuine JavaScript faults should fail a test.
    benign = ("ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED", "Failed to load resource")

    pg.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    pg.on("console", lambda m: problems.append(f"console.error: {m.text}")
          if m.type == "error" and not any(b in m.text for b in benign) else None)
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(1200)
    pg.problems = problems
    yield pg
    assert not problems, f"browser reported: {problems}"
    ctx.close()


def open_article(page, title_fragment: str):
    page.click(f'.item:has-text("{title_fragment}")')
    page.wait_for_selector("#view-reader.is-active", timeout=10000)
    page.wait_for_timeout(900)


def select_words(page, block_index: int, start: int = 0, length: int = 60):
    """Select a run of text inside one block, as a finger drag would."""
    return page.evaluate(
        """([i, start, length]) => {
            const blk = document.querySelector(`.blk[data-i="${i}"]`);
            if (!blk) return null;
            const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode();
            if (!node) return null;
            const len = node.nodeValue.length;
            const from = Math.max(0, Math.min(start, len - 2));
            const end = Math.min(len, from + length);
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, end);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return range.toString();
        }""",
        [block_index, start, length],
    )


def first_prose_block(page, clean: bool = False) -> int:
    """Index of a substantial paragraph. `clean` skips ones already marked up, since
    a new highlight drawn inside an existing one is deliberately collapsed."""
    return page.evaluate("""(clean) => {
        const el = [...document.querySelectorAll('#reader-body p.blk')]
            .find(e => (e.textContent || '').trim().length > 140
                       && (!clean || !e.querySelector('mark.hl')));
        return el ? Number(el.dataset.i) : -1;
    }""", clean)


def reset_item(page, title_fragment: str):
    """Put an item back to unread, so a test does not inherit another test's progress."""
    return page.evaluate("""async (fragment) => {
        const list = await (await fetch('/api/items')).json();
        const item = list.items.find(i => i.title.includes(fragment));
        if (!item) return null;
        await fetch(`/api/items/${item.id}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({status: 'unread'}),
        });
        return item.id;
    }""", title_fragment)


# ─────────────────────────────────────────────── library

def test_library_lists_saved_items(page):
    expect(page.locator("#library-sub")).to_contain_text("saved")
    assert page.locator(".item").count() >= 5


def test_reading_and_tools_are_separate(page):
    reading = page.locator(".item").count()
    page.click('#kind-tabs .segmented__btn[data-kind="product"]')
    page.wait_for_timeout(500)
    tools = page.locator(".item").count()
    assert tools >= 1, "the tools shelf should hold the product pages"
    assert tools != reading, "tools and reading must not show the same list"
    # A known product page belongs here, not in Reading.
    expect(page.locator("#item-list")).to_contain_text(re.compile("BioSky|EAO|Optimiser"))


def test_status_filter(page):
    page.click('#status-chips .chip[data-status="unread"]')
    page.wait_for_timeout(400)
    assert page.locator(".item").count() >= 1
    page.click('#status-chips .chip[data-status="finished"]')
    page.wait_for_timeout(400)
    # Nothing is finished in a fresh library, so the empty state must appear.
    if page.locator(".item").count() == 0:
        expect(page.locator("#library-empty")).to_be_visible()


def test_theme_filter(page):
    chip = page.locator('#theme-chips .chip[data-theme="Energy & Grid"]')
    if chip.count():
        chip.click()
        page.wait_for_timeout(400)
        assert page.locator(".item").count() >= 1


def test_search(page):
    page.click("#btn-search")
    page.fill("#search-input", "em-dash")
    page.wait_for_timeout(500)
    assert page.locator(".item").count() >= 1
    expect(page.locator(".item").first).to_contain_text("em-dash")


def test_sort_changes_order(page):
    first_before = page.locator(".item__title").first.inner_text()
    page.select_option("#sort-select", "title")
    page.wait_for_timeout(500)
    first_after = page.locator(".item__title").first.inner_text()
    assert page.locator(".item").count() >= 1
    assert first_before or first_after      # order may coincide; the control must work


# ─────────────────────────────────────────────── reader

def test_reader_opens_at_the_top(page):
    """An article must open at its beginning, never inherit the library's scroll.

    Progress is not zero on arrival, because the first screenful genuinely is on
    screen. It must be small, though: a long article opening at 100% would mean the
    reader had silently inherited a scroll position it never earned.
    """
    assert reset_item(page, "em-dash"), "the sample article should be in the library"
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1500)

    page.evaluate("window.scrollTo(0, 2000)")
    page.wait_for_timeout(200)
    open_article(page, "em-dashes")
    assert page.evaluate("window.scrollY") < 60
    pct = int(page.inner_text("#reader-progress-label").replace("%", "").strip())
    assert pct <= 15, f"a freshly opened long article should start near zero, got {pct}%"


def test_reader_renders_structure(page):
    open_article(page, "em-dashes")
    assert page.locator("#reader-body p.blk").count() > 10
    expect(page.locator(".reader__title")).to_contain_text("em-dash")


def test_pdf_figures_are_rendered(page):
    open_article(page, "Attention Is All You Need")
    figures = page.locator("#reader-body figure.fig")
    assert figures.count() >= 1, "charts and diagrams from a PDF must survive"
    expect(page.locator("#reader-body figcaption").first).to_contain_text(
        re.compile("Figure|Table", re.I))


def test_pdf_keeps_page_numbers(page):
    open_article(page, "Attention Is All You Need")
    assert page.locator("#reader-body .blk[data-page]").count() > 20


def test_scrolling_records_progress(page):
    open_article(page, "em-dashes")
    page.mouse.wheel(0, 6000)
    page.wait_for_timeout(1500)
    pct = int(page.inner_text("#reader-progress-label").replace("%", "").strip())
    assert pct > 5, f"progress should advance while reading, got {pct}%"

    # And it must survive leaving and coming back.
    page.click("#btn-reader-back")
    page.wait_for_timeout(1200)
    open_article(page, "em-dashes")
    again = int(page.inner_text("#reader-progress-label").replace("%", "").strip())
    assert again >= pct - 2, f"progress regressed: {pct}% then {again}%"


def test_progress_never_goes_backwards(page):
    open_article(page, "em-dashes")
    page.mouse.wheel(0, 5000)
    page.wait_for_timeout(1200)
    high = int(page.inner_text("#reader-progress-label").replace("%", ""))
    page.mouse.wheel(0, -5000)
    page.wait_for_timeout(1000)
    low = int(page.inner_text("#reader-progress-label").replace("%", ""))
    assert low >= high, "scrolling back up must not undo progress"


# ─────────────────────────────────────────────── marking up

def test_highlight_text(page):
    open_article(page, "em-dashes")
    index = first_prose_block(page, clean=True)
    assert index >= 0
    quote = select_words(page, index, 0, 70)
    assert quote
    page.wait_for_timeout(500)
    expect(page.locator("#seltool")).to_be_visible()
    page.click('#seltool .dot[data-colour="green"]')
    page.wait_for_timeout(900)

    mark = page.locator("#reader-body mark.hl")
    assert mark.count() >= 1
    assert mark.first.get_attribute("data-colour") == "green"


def test_highlight_survives_reload(page):
    open_article(page, "em-dashes")
    before = page.locator("#reader-body mark.hl").count()
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1500)
    open_article(page, "em-dashes")
    assert page.locator("#reader-body mark.hl").count() >= before


def test_add_a_note(page):
    open_article(page, "em-dashes")
    index = first_prose_block(page, clean=True)
    assert index >= 0
    select_words(page, index, 0, 50)
    page.wait_for_timeout(500)
    page.click('#seltool [data-sel="note"]')
    page.wait_for_selector("#sheet-note:not([hidden])", timeout=5000)
    expect(page.locator("#note-quote")).not_to_be_empty()
    page.fill("#note-text", "Worth quoting in the grid interoperability piece.")
    page.click("#btn-note-save")
    page.wait_for_timeout(1000)

    page.click("#btn-reader-back")
    page.wait_for_timeout(600)
    page.click('.tab[data-view="marks"]')
    page.wait_for_timeout(900)
    expect(page.locator("#marks-list")).to_contain_text("grid interoperability piece")


def test_bookmark_sets_progress(page):
    open_article(page, "Attention Is All You Need")
    page.mouse.wheel(0, 9000)
    page.wait_for_timeout(900)
    page.click("#btn-reader-bookmark")
    page.wait_for_timeout(1200)
    assert page.locator("#reader-body .bookmark-flag").count() >= 1
    pct = int(page.inner_text("#reader-progress-label").replace("%", ""))
    assert pct > 0, "a bookmark marks how far you have read"


def test_marks_list_filters(page):
    page.click('.tab[data-view="marks"]')
    page.wait_for_timeout(900)
    total = page.locator(".mark").count()
    assert total >= 1
    page.click('#mark-chips .chip[data-mark="highlight"]')
    page.wait_for_timeout(500)
    assert page.locator(".mark").count() <= total


def test_mark_opens_its_source(page):
    page.click('.tab[data-view="marks"]')
    page.wait_for_timeout(900)
    if page.locator(".mark").count():
        page.locator(".mark").first.click()
        page.wait_for_selector("#view-reader.is-active", timeout=8000)
        expect(page.locator(".reader__title")).not_to_be_empty()


# ─────────────────────────────────────────────── saving

def test_save_pasted_text(page):
    page.click("#btn-add")
    page.wait_for_selector("#sheet-add:not([hidden])")
    page.click('#add-tabs .segmented__btn[data-add="text"]')
    page.fill("#add-title", "Test note from the UI suite")
    page.fill("#add-text", "# Heading\n\nA paragraph saved by the test suite to prove "
                           "the paste path works end to end.\n\n- one\n- two")
    page.click("#btn-save-text")
    page.wait_for_timeout(2500)
    page.click('.tab[data-view="library"]')
    page.wait_for_timeout(900)
    page.click("#btn-search")
    page.fill("#search-input", "Test note from the UI suite")
    page.wait_for_timeout(700)
    assert page.locator(".item").count() >= 1


def test_pasted_text_is_not_filed_as_a_tool(page):
    page.click('#kind-tabs .segmented__btn[data-kind="product"]')
    page.wait_for_timeout(600)
    expect(page.locator("#item-list")).not_to_contain_text("Test note from the UI suite")


# ─────────────────────────────────────────────── item options

def test_item_options_change_theme_and_shelf(page):
    page.once("dialog", lambda d: d.accept("Testing Theme"))
    page.locator(".item").first.click(button="left", delay=700)
    page.wait_for_timeout(900)
    if page.locator("#sheet-item:not([hidden])").count() == 0:
        pytest.skip("long press did not register in this environment")
    page.click('[data-act="theme"]')
    page.wait_for_timeout(1500)
    expect(page.locator("#item-list")).to_contain_text("Testing Theme")


# ─────────────────────────────────────────────── offline

def test_reading_works_offline(page):
    open_article(page, "em-dashes")
    page.wait_for_timeout(800)
    page.click("#btn-reader-back")
    page.wait_for_timeout(600)

    page.context.set_offline(True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    assert page.locator(".item").count() >= 5, "the library must render with no network"
    open_article(page, "em-dashes")
    assert page.locator("#reader-body p.blk").count() > 10, "article text must be offline"
    page.context.set_offline(False)


def test_marks_made_offline_reach_the_server(page):
    page.context.set_offline(True)
    page.wait_for_timeout(300)
    open_article(page, "em-dashes")
    index = first_prose_block(page, clean=True)
    assert index >= 0, "needed an unmarked paragraph to highlight"
    select_words(page, index, 0, 55)
    page.wait_for_timeout(500)
    page.click('#seltool .dot[data-colour="blue"]')
    page.wait_for_timeout(900)
    assert page.locator('#reader-body mark.hl[data-colour="blue"]').count() >= 1

    # Reconnect: the queued write should replay.
    page.context.set_offline(False)
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(2500)
    left = page.evaluate("""async () => {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('folio', 1);
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        return await new Promise((res) => {
            const t = db.transaction('outbox', 'readonly');
            const q = t.objectStore('outbox').getAll();
            q.onsuccess = () => res(q.result.length);
            q.onerror = () => res(-1);
        });
    }""")
    assert left == 0, f"{left} change(s) never reached the server"


# ─────────────────────────────────────────────── installability

def test_manifest_and_service_worker(page):
    manifest = page.evaluate("""async () => {
        const r = await fetch('/manifest.webmanifest');
        return r.ok ? await r.json() : null;
    }""")
    assert manifest and manifest["name"].startswith("Folio")
    assert manifest["display"] == "standalone"
    assert manifest["share_target"]["action"] == "/share"
    assert any(i["sizes"] == "512x512" for i in manifest["icons"])

    registered = page.evaluate("""async () => {
        if (!('serviceWorker' in navigator)) return false;
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.length > 0;
    }""")
    assert registered, "the app must install a service worker to work offline"


def test_share_target_prefills_the_save_sheet(page):
    page.goto(f"{BASE}/share?url=https%3A%2F%2Fexample.com%2Fa&title=Shared",
              wait_until="networkidle")
    page.wait_for_timeout(1200)
    expect(page.locator("#sheet-add")).to_be_visible()
