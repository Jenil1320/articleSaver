"""Read and write operations over the SQLite store."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from . import config, db

VALID_STATUS = ("unread", "reading", "finished", "archived")
VALID_KIND = ("article", "paper", "post", "product")
VALID_ANNOTATION = ("highlight", "note", "bookmark")

# When nothing has been read for this long, the item resurfaces in the queue.
STALE_UNREAD_DAYS = 7
STALE_READING_DAYS = 3


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# --------------------------------------------------------------- items

def create_item(data: dict) -> str:
    item_id = db.new_id()
    ts = db.now()
    theme = data.get("theme") or "Unsorted"
    db.execute(
        """
        INSERT INTO items (
            id, url, canonical_url, kind, title, byline, site_name, published_at,
            saved_at, excerpt, lead_image, word_count, content_json, text_plain,
            theme, theme_source, theme_options, status, progress_words, resume_words,
            favourite, source, original_file, extract_method, warnings, deleted, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
        """,
        (
            item_id, data.get("url") or "", data.get("canonical_url") or "",
            data.get("kind") or "article", data.get("title") or "Untitled",
            data.get("byline") or "", data.get("site_name") or "",
            data.get("published_at"), ts, data.get("excerpt") or "",
            data.get("lead_image"), int(data.get("word_count") or 0),
            json.dumps(data.get("content") or [], ensure_ascii=False),
            data.get("text_plain") or "", theme, "auto",
            json.dumps(data.get("theme_options") or [], ensure_ascii=False),
            "unread", 0, 0, 0, data.get("source") or "url",
            data.get("original_file"), data.get("extract_method") or "",
            json.dumps(data.get("warnings") or [], ensure_ascii=False), ts,
        ),
    )
    db.touch_theme(theme)
    return item_id


def find_by_url(url: str) -> dict | None:
    if not url:
        return None
    row = db.one(
        "SELECT * FROM items WHERE deleted=0 AND (url=? OR canonical_url=?) LIMIT 1",
        (url, url),
    )
    return db.row_to_item(row, with_content=False) if row else None


def get_item(item_id: str, *, with_content: bool = True) -> dict | None:
    row = db.one("SELECT * FROM items WHERE id=?", (item_id,))
    if not row:
        return None
    item = db.row_to_item(row, with_content=with_content)
    item["annotations"] = list_annotations(item_id)
    return item


def list_items(*, status: str = "", kind: str = "", theme: str = "", q: str = "",
               sort: str = "recent", limit: int = 200, offset: int = 0) -> list[dict]:
    where = ["deleted=0"]
    params: list = []

    if status == "unfinished":
        where.append("status IN ('unread','reading')")
    elif status in VALID_STATUS:
        where.append("status=?")
        params.append(status)
    else:
        where.append("status != 'archived'")

    if kind in VALID_KIND:
        where.append("kind=?")
        params.append(kind)
    elif kind == "readable":
        where.append("kind IN ('article','paper','post')")

    if theme:
        where.append("theme=?")
        params.append(theme)

    if q:
        like = f"%{q.lower()}%"
        where.append("(LOWER(title) LIKE ? OR LOWER(text_plain) LIKE ? "
                     "OR LOWER(site_name) LIKE ? OR LOWER(byline) LIKE ?)")
        params.extend([like, like, like, like])

    order = {
        "recent": "saved_at DESC",
        "oldest": "saved_at ASC",
        "title": "title COLLATE NOCASE ASC",
        "longest": "word_count DESC",
        "shortest": "word_count ASC",
        "progress": "CAST(progress_words AS REAL)/MAX(word_count,1) DESC",
        "opened": "COALESCE(last_opened_at,'') DESC",
    }.get(sort, "saved_at DESC")

    rows = db.query(
        f"SELECT * FROM items WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    return [db.row_to_item(r, with_content=False) for r in rows]


def update_item(item_id: str, patch: dict) -> dict | None:
    row = db.one("SELECT * FROM items WHERE id=?", (item_id,))
    if not row:
        return None

    sets, params = [], []

    if "theme" in patch and patch["theme"]:
        theme = str(patch["theme"]).strip()[:80]
        sets += ["theme=?", "theme_source=?"]
        params += [theme, "user"]
        db.touch_theme(theme)

    if "kind" in patch and patch["kind"] in VALID_KIND:
        sets.append("kind=?")
        params.append(patch["kind"])

    if "title" in patch and str(patch["title"]).strip():
        sets.append("title=?")
        params.append(str(patch["title"]).strip()[:400])

    if "status" in patch and patch["status"] in VALID_STATUS:
        sets.append("status=?")
        params.append(patch["status"])
        if patch["status"] == "finished":
            sets += ["finished_at=?", "progress_words=word_count"]
            params.append(db.now())
        elif patch["status"] == "unread":
            sets += ["finished_at=NULL", "progress_words=0", "resume_words=0"]

    if "favourite" in patch:
        sets.append("favourite=?")
        params.append(1 if patch["favourite"] else 0)

    for key in ("remind_after", "snoozed_until"):
        if key in patch:
            sets.append(f"{key}=?")
            params.append(patch[key] or None)

    if not sets:
        return get_item(item_id, with_content=False)

    sets.append("updated_at=?")
    params.append(db.now())
    params.append(item_id)
    db.execute(f"UPDATE items SET {', '.join(sets)} WHERE id=?", params)
    return get_item(item_id, with_content=False)


def delete_item(item_id: str) -> bool:
    row = db.one("SELECT id FROM items WHERE id=?", (item_id,))
    if not row:
        return False
    ts = db.now()
    db.execute("UPDATE items SET deleted=1, updated_at=? WHERE id=?", (ts, item_id))
    db.execute("UPDATE annotations SET deleted=1, updated_at=? WHERE item_id=?", (ts, item_id))
    return True


def record_progress(item_id: str, *, progress_words: int | None = None,
                    resume_words: int | None = None, opened: bool = False) -> dict | None:
    row = db.one("SELECT * FROM items WHERE id=? AND deleted=0", (item_id,))
    if not row:
        return None

    total = row["word_count"] or 0
    # Progress only ever moves forward; scrolling back up is not un-reading.
    furthest = max(row["progress_words"] or 0, int(progress_words or 0))
    furthest = min(furthest, total) if total else furthest
    resume = int(resume_words) if resume_words is not None else (row["resume_words"] or 0)
    resume = min(max(resume, 0), total) if total else max(resume, 0)

    status = row["status"]
    finished_at = row["finished_at"]
    if status != "archived":
        if total and furthest >= total * config.FINISH_THRESHOLD:
            status = "finished"
            finished_at = finished_at or db.now()
        elif furthest > 0:
            status = "reading"
            finished_at = None

    db.execute(
        "UPDATE items SET progress_words=?, resume_words=?, status=?, finished_at=?, "
        "last_opened_at=?, updated_at=? WHERE id=?",
        (furthest, resume, status, finished_at,
         db.now() if opened else row["last_opened_at"], db.now(), item_id),
    )
    return get_item(item_id, with_content=False)


# --------------------------------------------------------------- annotations

def list_annotations(item_id: str) -> list[dict]:
    rows = db.query(
        "SELECT * FROM annotations WHERE item_id=? AND deleted=0 "
        "ORDER BY block_index ASC, start_word ASC",
        (item_id,),
    )
    return [dict(r) | {"deleted": bool(r["deleted"])} for r in rows]


def create_annotation(item_id: str, data: dict) -> dict | None:
    if not db.one("SELECT id FROM items WHERE id=? AND deleted=0", (item_id,)):
        return None
    kind = data.get("kind")
    if kind not in VALID_ANNOTATION:
        raise ValueError(f"Unknown annotation type {kind!r}.")

    ann_id = data.get("id") or db.new_id()
    ts = db.now()
    db.execute(
        "INSERT OR REPLACE INTO annotations "
        "(id,item_id,kind,block_index,start_word,end_word,quote,note,colour,"
        " created_at,deleted,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)",
        (
            ann_id, item_id, kind, int(data.get("block_index") or 0),
            int(data.get("start_word") or 0), int(data.get("end_word") or 0),
            (data.get("quote") or "")[:4000], (data.get("note") or "")[:8000],
            data.get("colour") or "yellow", data.get("created_at") or ts, ts,
        ),
    )

    # A bookmark marks how far the reader got, so it moves progress with it.
    if kind == "bookmark":
        row = db.one("SELECT content_json FROM items WHERE id=?", (item_id,))
        blocks = json.loads(row["content_json"] or "[]") if row else []
        idx = int(data.get("block_index") or 0)
        if 0 <= idx < len(blocks):
            absolute = int(blocks[idx].get("start", 0)) + int(data.get("start_word") or 0)
            record_progress(item_id, progress_words=absolute)

    return db.one("SELECT * FROM annotations WHERE id=?", (ann_id,)) and dict(
        db.one("SELECT * FROM annotations WHERE id=?", (ann_id,))
    )


def update_annotation(ann_id: str, patch: dict) -> dict | None:
    row = db.one("SELECT * FROM annotations WHERE id=?", (ann_id,))
    if not row:
        return None
    sets, params = [], []
    if "note" in patch:
        sets.append("note=?")
        params.append((patch["note"] or "")[:8000])
    if "colour" in patch:
        sets.append("colour=?")
        params.append(patch["colour"] or "yellow")
    if not sets:
        return dict(row)
    sets.append("updated_at=?")
    params += [db.now(), ann_id]
    db.execute(f"UPDATE annotations SET {', '.join(sets)} WHERE id=?", params)
    return dict(db.one("SELECT * FROM annotations WHERE id=?", (ann_id,)))


def delete_annotation(ann_id: str) -> bool:
    if not db.one("SELECT id FROM annotations WHERE id=?", (ann_id,)):
        return False
    db.execute("UPDATE annotations SET deleted=1, updated_at=? WHERE id=?", (db.now(), ann_id))
    return True


def all_annotations(*, kind: str = "", limit: int = 500) -> list[dict]:
    where = ["a.deleted=0", "i.deleted=0"]
    params: list = []
    if kind in VALID_ANNOTATION:
        where.append("a.kind=?")
        params.append(kind)
    rows = db.query(
        f"""SELECT a.*, i.title AS item_title, i.theme AS item_theme, i.kind AS item_kind
            FROM annotations a JOIN items i ON i.id=a.item_id
            WHERE {' AND '.join(where)}
            ORDER BY a.created_at DESC LIMIT ?""",
        (*params, limit),
    )
    return [dict(r) for r in rows]


# --------------------------------------------------------------- themes, queue, stats

def list_themes() -> list[dict]:
    rows = db.query(
        """SELECT theme AS name, COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('unread','reading') THEN 1 ELSE 0 END) AS unfinished
           FROM items WHERE deleted=0 AND status!='archived'
           GROUP BY theme ORDER BY total DESC, name ASC"""
    )
    return [dict(r) for r in rows]


def rename_theme(old: str, new: str) -> int:
    new = (new or "").strip()[:80]
    if not new or not old:
        return 0
    cur = db.execute(
        "UPDATE items SET theme=?, theme_source='user', updated_at=? WHERE theme=? AND deleted=0",
        (new, db.now(), old),
    )
    db.touch_theme(new)
    db.execute("DELETE FROM themes WHERE name=?", (old,))
    return cur.rowcount


def reading_queue(limit: int = 40) -> list[dict]:
    """Items worth resurfacing, most pressing first."""
    now = datetime.now(timezone.utc)
    rows = db.query(
        "SELECT * FROM items WHERE deleted=0 AND status IN ('unread','reading') "
        "AND kind IN ('article','paper','post')"
    )

    due = []
    for row in rows:
        snoozed = _parse(row["snoozed_until"])
        if snoozed and snoozed > now:
            continue

        item = db.row_to_item(row, with_content=False)
        saved = _parse(row["saved_at"]) or now
        opened = _parse(row["last_opened_at"])
        reference = opened or saved
        idle_days = max(0.0, (now - reference).total_seconds() / 86400)

        explicit = _parse(row["remind_after"])
        if explicit and explicit <= now:
            reason, score = "You asked to be reminded", 1000 + idle_days
        elif row["status"] == "reading" and idle_days >= STALE_READING_DAYS:
            reason = f"Part-read, untouched for {int(idle_days)} days"
            score = 500 + idle_days + item["progress_pct"]
        elif row["status"] == "unread" and idle_days >= STALE_UNREAD_DAYS:
            reason = f"Saved {int(idle_days)} days ago, not started"
            score = 200 + idle_days
        elif explicit:
            continue
        else:
            continue

        item["reason"] = reason
        item["idle_days"] = round(idle_days, 1)
        item["_score"] = score
        due.append(item)

    due.sort(key=lambda i: i["_score"], reverse=True)
    for i in due:
        i.pop("_score", None)
    return due[:limit]


def stats() -> dict:
    row = db.one(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status='unread'   THEN 1 ELSE 0 END) AS unread,
                  SUM(CASE WHEN status='reading'  THEN 1 ELSE 0 END) AS reading,
                  SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS finished,
                  SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) AS archived,
                  SUM(CASE WHEN kind='product'    THEN 1 ELSE 0 END) AS products,
                  SUM(word_count) AS words,
                  SUM(progress_words) AS words_read
           FROM items WHERE deleted=0"""
    )
    out = {k: (row[k] or 0) for k in row.keys()}
    ann = db.one(
        """SELECT SUM(CASE WHEN kind='highlight' THEN 1 ELSE 0 END) AS highlights,
                  SUM(CASE WHEN kind='note'      THEN 1 ELSE 0 END) AS notes,
                  SUM(CASE WHEN kind='bookmark'  THEN 1 ELSE 0 END) AS bookmarks
           FROM annotations WHERE deleted=0"""
    )
    out.update({k: (ann[k] or 0) for k in ann.keys()})
    out["minutes_read"] = round((out.get("words_read") or 0) / config.WORDS_PER_MINUTE)
    out["queue"] = len(reading_queue(limit=200))
    return out


def changes_since(since: str) -> dict:
    """Delta pull for the offline mirror on the phone."""
    since = since or "1970-01-01T00:00:00+00:00"
    # `>=`, not `>`: a row written in the same instant as the previous sync must not be
    # skipped. Re-sending a boundary row is harmless, because the client stores by id.
    items = db.query(
        "SELECT * FROM items WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 500", (since,)
    )
    anns = db.query(
        "SELECT * FROM annotations WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 5000",
        (since,),
    )
    return {
        "items": [db.row_to_item(r, with_content=True) for r in items],
        "annotations": [dict(r) for r in anns],
        "server_time": db.now(),
    }

