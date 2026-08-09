# Setup

Folio is a single Android app. Nothing to configure, nothing to keep running.

---

## Before you build

- **JDK 17+ and the Android SDK.** Android Studio installs both.
- **Android 8.0 or newer** on the phone.
- **USB debugging on**: Settings → About phone → tap *Build number* seven times, then
  Settings → System → Developer options → USB debugging.

Check the phone is connected:

```bash
adb devices
```

---

## Build and install

```bash
cd android
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

If Gradle cannot find the SDK, create `android/local.properties` with one line. Use
forward slashes, even on Windows:

```
sdk.dir=C:/Users/you/Android/Sdk
```

This is a debug build, which installs over `adb` without signing set-up. Sign a
release build with your own key if you want to install it without a cable.

---

## Saving things

**From inside the app**, the plus button offers four tabs:

| Tab | For |
|---|---|
| **Link** | An article, paper, PDF, or a post on X or LinkedIn |
| **File** | A PDF, HTML, Markdown or text file on the phone |
| **Text** | Anything you paste, kept word for word |
| **Many** | A list of links, one per line |

**From any other app**, tap Share and choose Folio:

- A **link** from Chrome, X or WhatsApp saves straight away.
- A **PDF** is copied in, read, and kept so you can reopen the original.
- **Selected text** arrives in the Text tab, ready to save.

Saving shows what it is doing, because a long report takes a while. If it fails it
says why and offers to try again.

---

## When a site will not open

Folio retries awkward pages in a real but invisible browser on the phone, which
clears most script-built pages and bot checks.

It cannot clear a paywall or a login wall, because the text is never sent. Copy what
you can see and use **Save → Text**.

---

## Backups

- **Settings → Save a backup** hands a JSON file to the share sheet. Put it anywhere.
- **Settings → Restore from a backup** reads it back. Same items are overwritten, nothing else is touched.
- Pictures are not included, to keep the file small.

`data/folio-old-library.json` is your library from the previous, server-based version,
converted to this format. A copy is on the phone at `Download/folio-old-library.json`,
so you can restore it from Settings. Its pictures did not come across.

---

## If something looks wrong

The app logs everything, including what the page itself reports:

```bash
adb logcat -s Folio
```

A save that dropped pictures says so on the item, under **When this was saved**.
