"""SQLite store. The server is the source of truth; the phone keeps an offline mirror.

Every mutable row carries `updated_at` and a `deleted` flag so the client can pull
a delta since its last sync and so deletes propagate instead of resurrecting.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from . import config

_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS items (
    id              TEXT PRIMARY KEY,
    url             TEXT,
    canonical_url   TEXT,
    kind            TEXT NOT NULL DEFAULT 'article',
    title           TEXT NOT NULL DEFAULT '',
    byline          TEXT NOT NULL DEFAULT '',
    site_name       TEXT NOT NULL DEFAULT '',
    published_at    TEXT,
    saved_at        TEXT NOT NULL,
    excerpt         TEXT NOT NULL DEFAULT '',
    lead_image      TEXT,
    word_count      INTEGER NOT NULL DEFAULT 0,
    content_json    TEXT NOT NULL DEFAULT '[]',
    text_plain      TEXT NOT NULL DEFAULT '',
    theme           TEXT NOT NULL DEFAULT 'Unsorted',
    theme_source    TEXT NOT NULL DEFAULT 'auto',
    theme_options   TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'unread',
    progress_words  INTEGER NOT NULL DEFAULT 0,
    resume_words    INTEGER NOT NULL DEFAULT 0,
    favourite       INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL DEFAULT 'url',
    original_file   TEXT,
    extract_method  TEXT NOT NULL DEFAULT '',
    warnings        TEXT NOT NULL DEFAULT '[]',
    last_opened_at  TEXT,
    finished_at     TEXT,
    remind_after    TEXT,
    snoozed_until   TEXT,
    deleted         INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);
CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status, deleted);
CREATE INDEX IF NOT EXISTS idx_items_theme   ON items(theme, deleted);

CREATE TABLE IF NOT EXISTS annotations (
    id          TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,              -- highlight | note | bookmark
    block_index INTEGER NOT NULL DEFAULT 0,
    start_word  INTEGER NOT NULL DEFAULT 0,
    end_word    INTEGER NOT NULL DEFAULT 0,
    quote       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    colour      TEXT NOT NULL DEFAULT 'yellow',
    created_at  TEXT NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ann_item    ON annotations(item_id, deleted);
CREATE INDEX IF NOT EXISTS idx_ann_updated ON annotations(updated_at);

CREATE TABLE IF NOT EXISTS themes (
    name        TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- An earlier build carried a contentless FTS5 mirror. Search runs directly against
-- `items` instead, so the mirror is dropped where it still exists.
DROP TABLE IF EXISTS items_fts;
"""


def now() -> str:
    # Microseconds, not seconds: sync compares timestamps, and a one-second tick means
    # several edits share a stamp. Anything written in the same second as a sync would
    # then never be pulled.
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def init() -> None:
    conn = connect()
    with conn:
        conn.executescript(SCHEMA)


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    return connect().execute(sql, tuple(params)).fetchall()


def one(sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
    return connect().execute(sql, tuple(params)).fetchone()


def execute(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    conn = connect()
    with conn:
        return conn.execute(sql, tuple(params))


def row_to_item(row: sqlite3.Row, *, with_content: bool = True) -> dict:
    """Shape a DB row into the JSON the client consumes."""
    d = dict(row)
    d["favourite"] = bool(d.get("favourite"))
    d["deleted"] = bool(d.get("deleted"))
    d["theme_options"] = json.loads(d.get("theme_options") or "[]")
    d["warnings"] = json.loads(d.get("warnings") or "[]")
    content = json.loads(d.pop("content_json", "[]") or "[]")
    plain = d.pop("text_plain", "")
    if with_content:
        d["content"] = content
        d["text_plain"] = plain
    wc = d.get("word_count") or 0
    d["reading_minutes"] = max(1, round(wc / config.WORDS_PER_MINUTE)) if wc else 0
    d["progress_pct"] = round(100 * (d.get("progress_words") or 0) / wc) if wc else 0
    return d


def get_setting(key: str, default: str = "") -> str:
    row = one("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def touch_theme(name: str) -> None:
    if not name:
        return
    ts = now()
    execute(
        "INSERT INTO themes(name,created_at,updated_at) VALUES(?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at",
        (name, ts, ts),
    )


