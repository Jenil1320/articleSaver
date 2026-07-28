# Putting Folio on your phone

Folio is a web app that installs to your Android home screen. It behaves like a normal
app: its own icon, no browser bars, and it opens with no signal.

There is one rule Android enforces, and it decides which of the routes below you want:

> A web app can only install to the home screen, and only read with no network, if it
> is served over **https**.

Plain `http://192.168.…` will load and work while you have a connection, but Android
will not let it install and will not open it offline. That is a browser rule, not a
limitation of Folio.

---

## Route A — same network, nothing to install (2 minutes)

Good for trying it out.

On the PC:

```bash
python backend/run.py --lan
```

It prints something like `Network http://192.168.1.24:8765`. Open that on the Pixel.

You get: the full library, reading, highlighting, notes, bookmarks, progress, themes,
search, the reading queue.

You do not get: a home-screen icon, or reading with no signal.

The PC must be on and on the same Wi-Fi.

---

## Route B — a proper installed app, reachable anywhere (recommended, 10 minutes)

A Cloudflare Tunnel puts an https address in front of the app. No account is needed for
a quick tunnel, no router settings change, and nothing is exposed except this one app.

**1. Get `cloudflared`** on the PC — download the Windows build from
Cloudflare's `cloudflared` releases page, or:

```bash
winget install --id Cloudflare.cloudflared
```

**2. Start Folio:**

```bash
python backend/run.py --port 8765
```

**3. In a second terminal, open the tunnel:**

```bash
cloudflared tunnel --url http://localhost:8765
```

It prints an address like `https://tidy-otter-nine.trycloudflare.com`.

**4. On the Pixel**, open that address in Chrome. Then use the ⋮ menu and choose
**Add to Home screen** (it may say *Install app*).

Folio is now an app. Open it with no signal and everything you have saved is still
there.

**5. Tell Folio its public address**, so links in the email digest work:

```bash
set FOLIO_PUBLIC_URL=https://tidy-otter-nine.trycloudflare.com
```

A quick tunnel gets a new address each time it starts. If you want one that does not
change, create a named tunnel on a free Cloudflare account and point it at
`localhost:8765`.

**The PC must be running** for saving new links, because fetching and parsing a page
happens there. Reading what you have already saved needs nothing.

---

## Sharing into Folio from your phone

Once installed (Route B), Folio appears in the Android share sheet.

In Chrome, X, WhatsApp or anywhere else, tap **Share** and choose **Folio**. The link is
saved straight away.

This is also the answer for any site that blocks automated fetching: open it in Chrome
where it loads normally, then share it. For a PDF, download it in Chrome and share the
file, or use **Save → File** inside the app.

---

## Email reminders

The *Up next* list needs no setup. The daily email digest needs a mail server.

Set these before starting Folio. With a Gmail account you must use an **app password**,
not your normal password.

```bash
set FOLIO_SMTP_HOST=smtp.gmail.com
set FOLIO_SMTP_PORT=587
set FOLIO_SMTP_USER=you@gmail.com
set FOLIO_SMTP_PASSWORD=your-16-character-app-password
set FOLIO_DIGEST_TO=you@gmail.com
set FOLIO_PUBLIC_URL=https://your-tunnel-address
```

Restart Folio. In **Settings**, turn on *Daily email digest*, pick the hour, and press
**Send one now** to check it.

The digest lists what is unfinished, how far through you are, and why each item
resurfaced. Each entry links straight into the app.

---

## All the settings

| Variable | Default | What it does |
|---|---|---|
| `FOLIO_DATA_DIR` | `./data` | Where the database, figures and originals live |
| `FOLIO_DB` | `./data/folio.db` | Database file |
| `FOLIO_PUBLIC_URL` | `http://localhost:8765` | Address used in digest links |
| `FOLIO_WPM` | `230` | Reading speed used for time estimates |
| `FOLIO_FINISH_THRESHOLD` | `0.95` | Share of words that counts as finished |
| `FOLIO_BROWSER_FALLBACK` | `1` | Use headless Chromium when a plain fetch is blocked |
| `FOLIO_FETCH_TIMEOUT` | `45` | Seconds before a fetch gives up |
| `FOLIO_MAX_BYTES` | `41943040` | Largest file accepted (40 MB) |
| `FOLIO_SMTP_HOST` | — | Mail server for the digest |
| `FOLIO_SMTP_PORT` | `587` | `465` switches to implicit TLS |
| `FOLIO_SMTP_USER` | — | Mail username |
| `FOLIO_SMTP_PASSWORD` | — | Mail password or app password |
| `FOLIO_DIGEST_TO` | — | Where the digest is sent |

---

## Backing it up

Everything is in `data/`: the SQLite database, the rendered figures, and the original
PDFs. Copy that folder and you have copied your library, your highlights and your
notes.

---

## Bringing in your saved tweets

Open **Save → Many**, paste your tweet links one per line, and press **Import all**.
Progress is shown per link, and anything that fails says why. Duplicates are detected,
so running it twice is safe.
