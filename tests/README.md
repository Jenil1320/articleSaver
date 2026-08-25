# Tests

No build step and no package manager. The tests are pages, and they run in a real
browser so that `DOMParser`, `CSS.escape` and module loading behave exactly as they do
inside the app's WebView.

```bash
python tests/serve.py 8125
```

| Page | What it does |
|---|---|
| `unit.html` | 74 assertions over the pieces that have to be exactly right: character offsets, mark nesting, list numbering and depth, picture choice, and every rule that decides whether a block is the publisher's furniture. |
| `bench.html` | The 15 saved pages in `fixtures/` run through both Folio and Mozilla Readability, scored on word coverage and on the per-page phrases in `expect.js` that must survive and must not leak. |
| `seed.html` | Extracts one saved page into the app's own IndexedDB with stand-in pictures, so the reading view can be looked at on a desktop without a phone. |

## Two traps worth knowing

**Use a fresh port for every run.** A browser caches an ES module for the life of an
origin and ignores `Cache-Control: no-store`; a new tab does not clear it and neither
does a query string on the page. A new port is a new origin, and therefore a new cache
key. `serve.py` sends `no-store` anyway, which is enough for most browsers but not for
the one embedded in the tooling.

**Assertions must be real.** A `mustContain` phrase that is not on the page is a broken
test; a `mustNotContain` phrase that is not on the page passes vacuously and tests
nothing. Check both against the fixture before adding them — three of the original six
"failures" turned out to be wrong assertions rather than wrong extraction.

## The fixtures

`fixtures/` holds 4.5 MB of saved HTML: fifteen articles from fifteen different
publishing stacks — news (Guardian, BBC, NPR, The Verge, Ars Technica), science
(Nature), reference (Wikipedia, MDN), and blogs on WordPress, Ghost, Substack, Medium
and a hand-rolled site, plus a GitHub README.

They are third-party pages kept verbatim so the benchmark is reproducible. They are
saved copies for local testing, not redistribution. To refresh one, fetch it with a
normal browser user agent:

```bash
curl -sSL --compressed -A "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36" \
  -o tests/fixtures/<name>.html "<url>"
```

Then update the matching entry in `expect.js`, because the phrases will have moved.

`vendor/Readability.js` is Mozilla Readability (Apache 2.0), used only as an
independent second opinion on word count — not as a target to match. Readability keeps
chrome that Folio deliberately drops, so a ratio above 1.0 is normal and a ratio far
below it is the signal worth chasing.
