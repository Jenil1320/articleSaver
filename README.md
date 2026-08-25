# Folio

A private reading library that runs entirely on your Android phone.

Save an article, a paper, a PDF or a post. Read it later, offline, and mark it up.
No server, no account, nothing leaves the device.

---

## Install

```bash
cd android
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Needs the Android SDK and a JDK. Point `android/local.properties` at your SDK, for
example `sdk.dir=C:/Users/you/Android/Sdk`. Android 8.0 or newer.

---

## What it does

- **Saves four ways** — a link, a file, pasted text, or a list of links.
- **Takes a share** — tap Share in any app and choose Folio.
- **Fetches for itself** — the app makes its own web requests, so there is no server.
- **Handles awkward pages** — a script-built page is loaded again in an invisible browser on the phone.
- **Says hello once** — a first run opens on a single screen that says what Folio is
  for, then hands you straight to saving something.
- **Cleans up articles** — a Readability-style pass keeps the prose and drops the navigation.
- **Keeps the marks an author wrote** — links stay links, bold stays bold, italic stays
  italic, inline code stays code. A tap on a link asks whether to open it in the
  browser or save it into Folio for later.
- **Keeps the shape an author gave it** — real heading levels, numbered lists that stay
  numbered, nested lists that stay nested, line breaks inside a paragraph, quotations
  that stay quoted across several paragraphs, and tables that take their header row
  from the markup rather than from position.
- **Separates the furniture without deleting it** — comment threads, share rails and
  advertisement slots go. A newsletter card, a sponsor line, an author bio, a
  related-story rail or a paywall price is *folded away* instead: one line saying what
  it was thought to be, and a tap to read it anyway. Nothing the reader could not be
  certain about is ever thrown out.
- **Finds the pictures anyway** — a picture on a Markdown-built site arrives wrapped in
  a paragraph, and on a news site it hides behind a placeholder and a lazy loader. Folio
  reaches inside the paragraph, reads the responsive sets and the data attributes, and
  scrolls a script-built page past itself so its own loader fires.
- **Rebuilds PDFs** — measures the body font, restores paragraphs, strips running headers, repairs hyphens.
- **Keeps the charts** — figures and tables are rendered back into the reading flow with their captions.
- **Saves the largest picture on offer** — every candidate address a page ships is
  measured, so a photograph arrives at the size the page reserved for a desktop rather
  than the one it reserved for a phone.
- **Opens a picture properly** — tap it for full screen, then pinch to zoom, drag to
  pan, double tap in and back out.
- **Files by theme** — offline keyword rules pick a shelf; your override is never overwritten.
- **Splits tools from reading** — product pages go on their own shelf.
- **Tracks progress in words** — exact, never backwards, resumes where you left off.
- **Marks up** — four highlight colours, notes and bookmarks, all listed in one place.
- **Reads offline** — text, pictures and the original PDF are on the device.
- **Resurfaces the forgotten** — *Up next* shows what is unread or half-read, and why.
- **Builds a habit** — focus sessions hold the screen awake; five minutes a day keeps a
  streak. A ring in the header shows how much of today is done and the streak it protects.
- **Shows the shape of a document** — a contents sheet jumps between sections, and
  references and footnotes are set as apparatus rather than as more paragraphs.
- **Reads posts properly** — an X post arrives with its full text, its pictures and
  any quoted post, not just the words the old embed endpoint chose to share.
- **Reads X Articles whole** — a post that announces one of X's long-form Articles
  saves the article itself: title, cover, headings, lists, figures and formatting,
  even though X shows the page only to signed-in readers.
- **Nudges** — an optional once-a-day notification, written light rather than stern.
- **Reads itself in again** — one tap re-runs the reader over a saved item, or over
  the whole library, after the reader improves. Marks and progress survive.

---

## How it is put together

One WebView served from the app's own assets, plus native code for the few things a
page cannot do for itself.

```
android/app/src/main/
  java/com/folio/reader/
    MainActivity.java   the WebView, window insets, share intents, back button
    Bridge.java         fetching, files, backup, wake lock — the JavaScript interface
    Renderer.java       the invisible browser, for pages that need their scripts run
    Storage.java        the app's own files: downloads, shared documents, originals
    ReminderReceiver.java  the daily nudge: alarm, notification, the wording
  res/                  adaptive launcher icon, light and dark themes
  assets/web/
    index.html          the shell
    css/app.css         the whole interface
    js/
      app.js            routing, library, saving, settings, reader controls
      reader.js         reading view, mark anchoring, progress
      library.js        items, progress rules, queue, streak, backup
      db.js             IndexedDB — the library itself, not a cache
      native.js         the bridge, seen from the page
      ingest.js         link / file / text  ->  a saved item
      extract/
        fetch.js        plain request, escalating to the invisible browser
        html.js         article extraction
        pdf.js          print layout  ->  readable blocks
        figures.js      charts and tables out of a PDF
        social.js       X and LinkedIn posts
        classify.js     offline rules for kind and theme
        inline.js       the marks inside a paragraph: links, bold, italic, code
        boilerplate.js  telling the article from the publisher's furniture
        blocks.js       the normalised document format
    vendor/pdfjs/       Mozilla pdf.js, bundled (Apache 2.0)
```

**The one idea worth knowing.** A document is a flat list of blocks, and each block
records the running word offset of its first word. Every word therefore has one stable
index. That is what makes progress exact and highlight anchors survive a reflow.

**The second one.** A block's `text` stays plain, and the marks its author wrote live
beside it in `spans` — character ranges into that same string. Because the spine never
changes shape, a word offset means the same thing whether or not a block turned out to
carry marks, and an article saved before marks existed still reads and still keeps its
highlights. The reader merges those ranges with its own highlight ranges in one pass,
which is what lets a highlight cross a link without either one breaking.

**And the third.** Deciding what is furniture happens *after* flattening, not during
cleaning. In the markup a related-story rail and a paragraph look alike. Laid out in a
row they do not: the article is a long run of substantial paragraphs, and the rails,
the bios and the sign-up cards sit before it or after it. Cleaning removes only the
unambiguous; the flat list is where the rest is judged, and where the judgement can
afford to be unsure.

---

## Your library

Held in the app's own storage: text and marks in IndexedDB, pictures beside them,
original PDFs as files.

- **Settings → Save a backup** writes a JSON file of the text, marks and progress.
- **Settings → Restore from a backup** reads one back.
- Pictures are left out of a backup, because they are most of the size and least of the value.
- Uninstalling deletes the library. Take a backup first.

---

## Known limits

- **Scanned PDFs** have no text to extract. Folio says so rather than saving something empty.
- **Paywalls and login walls** stop it, as they stop any reader. Copy the text and use Save → Text.
- **Figure capture stops at 80** per document. The text is always complete.
- **Equations and dense multi-column layouts** read less well as prose. The original PDF is one tap away.
- **Diagrams drawn as inline SVG** are not captured. Across fifteen saved pages from
  fifteen publishing stacks there were 1,455 inline SVG elements and effectively all of
  them were interface icons, so capturing them would add noise rather than pictures.
- **An article already saved keeps the copy it was saved with.** Settings → *Read every
  article in again* re-runs the current reader across the library; marks and progress
  survive it.

---

## Testing

No build step and no package manager: the tests are pages, and they run in a real
browser so that `DOMParser` and module loading behave as they do inside the WebView.

```
python tests/serve.py 8125
```

- `http://localhost:8125/tests/unit.html` — 74 assertions over the pieces that have to
  be exactly right: character offsets, mark nesting, list numbering, picture choice,
  and every rule that decides whether a block is furniture.
- `http://localhost:8125/tests/bench.html` — the same 15 saved pages run through both
  Folio and Mozilla Readability, scored on word coverage and on per-page phrases that
  must survive and phrases that must not leak.
- `http://localhost:8125/tests/seed.html` — extracts a saved page into the app's own
  database with stand-in pictures, so the reading view can be looked at without a phone.

`tests/README.md` has the details, including the two traps: a browser caches an ES
module per origin, so each run wants a fresh port; and an assertion naming a phrase
that is not on the page passes without testing anything.
