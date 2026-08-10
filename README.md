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
- **Cleans up articles** — a Readability-style pass keeps the prose and drops the navigation.
- **Rebuilds PDFs** — measures the body font, restores paragraphs, strips running headers, repairs hyphens.
- **Keeps the charts** — figures and tables are rendered back into the reading flow with their captions.
- **Files by theme** — offline keyword rules pick a shelf; your override is never overwritten.
- **Splits tools from reading** — product pages go on their own shelf.
- **Tracks progress in words** — exact, never backwards, resumes where you left off.
- **Marks up** — four highlight colours, notes and bookmarks, all listed in one place.
- **Reads offline** — text, pictures and the original PDF are on the device.
- **Resurfaces the forgotten** — *Up next* shows what is unread or half-read, and why.
- **Builds a habit** — focus sessions hold the screen awake; five minutes a day keeps a streak.
- **Shows the shape of a document** — a contents sheet jumps between sections, and
  references and footnotes are set as apparatus rather than as more paragraphs.
- **Reads posts properly** — an X post arrives with its full text, its pictures and
  any quoted post, not just the words the old embed endpoint chose to share.
- **Nudges, goofily** — an optional once-a-day notification that wants you to read
  but refuses to be serious about it.

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
    ReminderReceiver.java  the daily nudge: alarm, notification, goofy copy
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
        blocks.js       the normalised document format
    vendor/pdfjs/       Mozilla pdf.js, bundled (Apache 2.0)
```

**The one idea worth knowing.** A document is a flat list of blocks, and each block
records the running word offset of its first word. Every word therefore has one stable
index. That is what makes progress exact and highlight anchors survive a reflow.

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
