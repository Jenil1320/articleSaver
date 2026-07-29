# Folio

A private reading library. Save an article, a paper, a PDF, a tweet or a LinkedIn
post; read it later, offline, in one clean place; highlight it, note it, bookmark it,
and be reminded of what you have not finished.

Built to replace the habit of messaging links to yourself.

---

## What it does

**Saves four ways.** A link, an uploaded file, pasted text, or a batch of links pasted
one per line. On Android you can also share straight into it from Chrome, WhatsApp or
X, because it registers as a share target.

**Reads what it saves properly.** Web pages go through a Readability-style scoring pass
that finds the prose and discards the navigation, the newsletter box and the footer.
PDFs are rebuilt from print layout: the body font size is measured, larger lines become
headings, running headers and page numbers are stripped, paragraphs are rejoined across
line and page breaks, and words split by a hyphen are repaired using the document's own
vocabulary — so `English-to-German` stays hyphenated while `col-` `lectively` is put
back together.

**Keeps the charts and the tables.** A PDF's figures are found, rendered and placed back
in the reading flow with their captions, because a report's charts are the argument.
Decorative banner photographs are left out. Tap a figure to see it full screen.

**Separates tools from reading.** Product and platform pages — the ones you saved to
look at, not to read — go on their own shelf, so they never pad your reading queue.

**Suggests a theme.** Offline keyword rules file each item on a shelf such as
*Energy & Grid* or *AI & Machine Learning*. No API key, no network call, same answer
every time. Change it whenever you like; a change you make is never overwritten.

**Tracks reading word by word.** Progress is measured in words, not pixels. Whole
blocks you have scrolled past count in full, the block at the bottom of the screen
counts pro rata, and a bookmark moves progress to the word it sits on. Progress never
goes backwards, and an article resumes exactly where you left it.

**Marks up.** Select any text to highlight it in one of four colours, attach a note, or
drop a bookmark. Every mark is stored as *(block, start word, end word)*, not as a
position in the page, so it survives a font change, a reflow, a different screen and a
re-render. All marks are collected in one list; tap one to jump back to its source.

**Works with no network.** The whole library is mirrored on the device. Marks made
offline are queued and replayed when the connection returns.

**Reminds you.** *Up next* resurfaces anything unread for a week or part-read and
untouched for three days, with the reason shown. An optional daily email digest sends
the same list.

**Keeps you reading.** A focus session (10, 15 or 25 minutes) holds the screen awake
and pauses the moment you switch to another app — a finished session is what counts.
Five read minutes a day builds a quiet streak, shown as one line in the library.
The reading bar shows minutes left in the article, Kindle-style. Appearance is a
setting: system, light or dark.

---

## Running it

Needs Python 3.11 or newer. Nothing else.

```bash
python -m pip install -r requirements.txt
```

Then, for the headless-browser fallback used on pages that render client-side:

```bash
python -m playwright install chromium
```

Start it:

```bash
python backend/run.py
```

Open <http://localhost:8765>.

To reach it from your phone on the same network:

```bash
python backend/run.py --lan
```

The address to use on the phone is printed on start-up. For putting it on your phone
properly — installed to the home screen and readable with no signal — see
[SETUP.md](SETUP.md).

---

## Testing

```bash
python -m pytest tests/test_backend.py -q
```

37 tests covering extraction, classification, the word-offset model, storage,
progress rules, annotations and the reading queue. No network, no server.

```bash
python backend/run.py --port 8765          # in one terminal
python -m pytest tests/test_ui.py -q       # in another
```

25 tests driving a real browser at Pixel 7 size: saving, filtering, searching,
reading, PDF figures, highlighting, notes, bookmarks, progress, offline reading,
offline marks replaying on reconnect, the manifest and the share target.

---

## How it is put together

```
backend/
  folio/
    api.py           HTTP API and static hosting
    ingest.py        URL / file / text  ->  a saved item
    classify.py      offline rules for kind and theme
    store.py         reads and writes over SQLite
    db.py            schema and connections
    reminders.py     the email digest
    extract/
      fetch.py       HTTP, escalating to a headless browser
      html.py        Readability-style article extraction
      pdf.py         print layout  ->  readable blocks
      figures.py     charts and tables out of a PDF
      social.py      X and LinkedIn posts
      blocks.py      the normalised document format
frontend/            no build step, no framework, no web fonts
  js/app.js          shell, routing, library, save flows
  js/reader.js       reading view, anchoring, progress
  js/db.js           IndexedDB mirror and outbox
  js/api.js          server calls and offline rules
  sw.js              service worker
```

The server is the source of truth. The phone keeps a full mirror and an outbox. Every
row carries `updated_at` and a `deleted` flag, so the phone pulls a delta and deletes
propagate instead of resurrecting.

### The one idea worth knowing

A document is a flat list of blocks, and each block records the running word offset of
its first word. Every word in a document therefore has one stable index. That single
choice is what makes progress exact and highlight anchors durable.

---

## Known limits

- **Scanned PDFs.** Text is read, not recognised. A PDF that is photographs of pages
  has no text to extract, and Folio says so rather than saving something empty.
- **Sites behind a bot check.** Some publishers block every automated fetch, including
  a real headless browser. Folio explains this and points you at upload or share
  instead — both work, because the file or the page reaches it from your own browser.
- **Very long reports.** Figure capture stops at 80 per document; the message on the
  item says when that happened. All the text is always kept, and the original PDF is
  stored and downloadable.
- **Equations and multi-column layouts.** Rebuilt as prose, so heavy mathematics reads
  less well than the original. The original PDF is one tap away.
