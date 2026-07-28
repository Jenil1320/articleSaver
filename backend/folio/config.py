"""Runtime configuration. Everything has a working default so the app runs with no setup."""
from __future__ import annotations

import os
from pathlib import Path

# Repository root (…/articleSaver)
ROOT = Path(__file__).resolve().parents[2]

DATA_DIR = Path(os.environ.get("FOLIO_DATA_DIR", ROOT / "data"))
MEDIA_DIR = DATA_DIR / "media"
ORIGINALS_DIR = DATA_DIR / "originals"
DB_PATH = Path(os.environ.get("FOLIO_DB", DATA_DIR / "folio.db"))
FRONTEND_DIR = Path(os.environ.get("FOLIO_FRONTEND", ROOT / "frontend"))

for _d in (DATA_DIR, MEDIA_DIR, ORIGINALS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --- Fetching -------------------------------------------------------------
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
FETCH_TIMEOUT = int(os.environ.get("FOLIO_FETCH_TIMEOUT", "45"))
MAX_DOWNLOAD_BYTES = int(os.environ.get("FOLIO_MAX_BYTES", str(40 * 1024 * 1024)))
# Headless-browser fallback for pages behind JS challenges or rendered client-side.
USE_BROWSER_FALLBACK = os.environ.get("FOLIO_BROWSER_FALLBACK", "1") not in ("0", "false", "")

# --- Reading --------------------------------------------------------------
WORDS_PER_MINUTE = int(os.environ.get("FOLIO_WPM", "230"))
# An item counts as finished once this share of its words has been passed.
FINISH_THRESHOLD = float(os.environ.get("FOLIO_FINISH_THRESHOLD", "0.95"))

# --- Email digest ---------------------------------------------------------
SMTP_HOST = os.environ.get("FOLIO_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("FOLIO_SMTP_PORT", "587"))
SMTP_USER = os.environ.get("FOLIO_SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("FOLIO_SMTP_PASSWORD", "")
SMTP_STARTTLS = os.environ.get("FOLIO_SMTP_STARTTLS", "1") not in ("0", "false", "")
DIGEST_FROM = os.environ.get("FOLIO_DIGEST_FROM", SMTP_USER)
DIGEST_TO = os.environ.get("FOLIO_DIGEST_TO", "")
PUBLIC_URL = os.environ.get("FOLIO_PUBLIC_URL", "http://localhost:8765")


def smtp_configured() -> bool:
    return bool(SMTP_HOST and DIGEST_TO and DIGEST_FROM)
