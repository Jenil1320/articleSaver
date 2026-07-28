"""HTTP API and static hosting for Folio.

Endpoints that fetch a page are declared with `def`, not `async def`, so FastAPI runs
them in a worker thread. The headless-browser fallback drives Playwright's synchronous
API, which refuses to start inside a running event loop.
"""
from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, db, ingest, reminders, store

app = FastAPI(title="Folio", version=__version__, docs_url="/api/docs", redoc_url=None)

# The phone and the desktop may reach the server on different origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    db.init()


# --------------------------------------------------------------- helpers

def _fail(status: int, message: str, **extra):
    raise HTTPException(status_code=status, detail={"message": message, **extra})


def _save_ingested(data: dict) -> dict:
    existing = store.find_by_url(data.get("canonical_url") or data.get("url") or "")
    if existing:
        return {"item": existing, "duplicate": True}
    item_id = store.create_item(data)
    return {"item": store.get_item(item_id, with_content=False), "duplicate": False}


# --------------------------------------------------------------- saving

@app.post("/api/items")
def save_item(payload: dict = Body(...)):
    url = (payload.get("url") or "").strip()
    text = (payload.get("text") or "").strip()

    try:
        if url:
            data = ingest.from_url(url)
        elif text:
            data = ingest.from_text(text, title=(payload.get("title") or "").strip())
        else:
            _fail(400, "Give a link or some text to save.")
    except HTTPException:
        raise
    except PermissionError as exc:
        _fail(422, str(exc), recoverable=True)
    except LookupError as exc:
        _fail(422, str(exc), recoverable=True)
    except ValueError as exc:
        _fail(400, str(exc))
    except Exception as exc:                     # network faults, malformed documents
        _fail(502, f"That link could not be read. {type(exc).__name__}: {exc}")

    return _save_ingested(data)


@app.post("/api/items/upload")
def upload_item(file: UploadFile = File(...), title: str = Form("")):
    raw = file.file.read()
    if not raw:
        _fail(400, "That file is empty.")
    if len(raw) > config.MAX_DOWNLOAD_BYTES:
        _fail(413, "That file is too large.")
    try:
        data = ingest.from_upload(file.filename or "file", raw)
    except ValueError as exc:
        _fail(400, str(exc))
    except Exception as exc:
        _fail(500, f"That file could not be read. {type(exc).__name__}: {exc}")
    if title.strip():
        data["title"] = title.strip()
    item_id = store.create_item(data)
    return {"item": store.get_item(item_id, with_content=False), "duplicate": False}


# --- bulk import ----------------------------------------------------------
# Pasting a page of saved tweets should not hold the request open, so the work runs
# on a worker thread and the client polls for progress.

_JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


def _run_bulk(job_id: str, urls: list[str]) -> None:
    for raw in urls:
        entry = {"url": raw, "ok": False, "title": "", "error": "", "duplicate": False}
        try:
            data = ingest.from_url(raw)
            result = _save_ingested(data)
            entry.update(ok=True, title=result["item"]["title"],
                         duplicate=result["duplicate"], id=result["item"]["id"])
        except Exception as exc:
            entry["error"] = str(exc) or type(exc).__name__
        with _JOBS_LOCK:
            _JOBS[job_id]["results"].append(entry)
            _JOBS[job_id]["done"] += 1
    with _JOBS_LOCK:
        _JOBS[job_id]["finished"] = True


@app.post("/api/items/bulk")
def bulk_save(payload: dict = Body(...)):
    raw = payload.get("urls")
    if isinstance(raw, str):
        raw = raw.split()
    urls = [u.strip() for u in (raw or []) if u and u.strip()]
    # Keep only things that look like links, so pasted prose does not become 400 jobs.
    urls = [u for u in urls if "." in u][:400]
    if not urls:
        _fail(400, "No links were found in what you pasted.")

    job_id = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        _JOBS[job_id] = {"total": len(urls), "done": 0, "finished": False, "results": []}
    threading.Thread(target=_run_bulk, args=(job_id, urls), daemon=True).start()
    return {"job": job_id, "total": len(urls)}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            _fail(404, "That import is no longer available.")
        return dict(job)


# --------------------------------------------------------------- reading

@app.get("/api/items")
def get_items(status: str = "", kind: str = "", theme: str = "", q: str = "",
              sort: str = "recent", limit: int = Query(200, le=1000), offset: int = 0):
    return {"items": store.list_items(status=status, kind=kind, theme=theme, q=q,
                                      sort=sort, limit=limit, offset=offset)}


@app.get("/api/items/{item_id}")
def get_one(item_id: str):
    item = store.get_item(item_id, with_content=True)
    if not item or item["deleted"]:
        _fail(404, "That item is not in your library.")
    return item


@app.patch("/api/items/{item_id}")
def patch_item(item_id: str, payload: dict = Body(...)):
    item = store.update_item(item_id, payload)
    if not item:
        _fail(404, "That item is not in your library.")
    return item


@app.delete("/api/items/{item_id}")
def remove_item(item_id: str):
    if not store.delete_item(item_id):
        _fail(404, "That item is not in your library.")
    return {"ok": True}


@app.post("/api/items/{item_id}/progress")
def set_progress(item_id: str, payload: dict = Body(...)):
    item = store.record_progress(
        item_id,
        progress_words=payload.get("progress_words"),
        resume_words=payload.get("resume_words"),
        opened=bool(payload.get("opened")),
    )
    if not item:
        _fail(404, "That item is not in your library.")
    return item


@app.get("/api/items/{item_id}/original")
def original_file(item_id: str):
    row = db.one("SELECT original_file, title FROM items WHERE id=? AND deleted=0", (item_id,))
    if not row or not row["original_file"]:
        _fail(404, "No original file was stored for this item.")
    path = config.ORIGINALS_DIR / row["original_file"]
    if not path.exists():
        _fail(404, "The stored file is missing.")
    safe = "".join(c for c in (row["title"] or "document") if c.isalnum() or c in " -_")[:80]
    return FileResponse(path, media_type="application/pdf", filename=f"{safe.strip() or 'document'}.pdf")


# --------------------------------------------------------------- annotations

@app.post("/api/items/{item_id}/annotations")
def add_annotation(item_id: str, payload: dict = Body(...)):
    try:
        ann = store.create_annotation(item_id, payload)
    except ValueError as exc:
        _fail(400, str(exc))
    if not ann:
        _fail(404, "That item is not in your library.")
    return ann


@app.patch("/api/annotations/{ann_id}")
def patch_annotation(ann_id: str, payload: dict = Body(...)):
    ann = store.update_annotation(ann_id, payload)
    if not ann:
        _fail(404, "That mark no longer exists.")
    return ann


@app.delete("/api/annotations/{ann_id}")
def remove_annotation(ann_id: str):
    if not store.delete_annotation(ann_id):
        _fail(404, "That mark no longer exists.")
    return {"ok": True}


@app.get("/api/annotations")
def get_annotations(kind: str = "", limit: int = Query(500, le=2000)):
    return {"annotations": store.all_annotations(kind=kind, limit=limit)}


# --------------------------------------------------------------- library meta

@app.get("/api/themes")
def get_themes():
    return {"themes": store.list_themes()}


@app.post("/api/themes/rename")
def post_rename_theme(payload: dict = Body(...)):
    changed = store.rename_theme((payload.get("from") or "").strip(),
                                 (payload.get("to") or "").strip())
    return {"changed": changed, "themes": store.list_themes()}


@app.get("/api/queue")
def get_queue(limit: int = Query(40, le=200)):
    return {"queue": store.reading_queue(limit=limit)}


@app.get("/api/stats")
def get_stats():
    return store.stats()


@app.get("/api/sync")
def sync(since: str = ""):
    return store.changes_since(since)


@app.get("/api/settings")
def get_settings():
    return {
        "digest_enabled": db.get_setting("digest_enabled", "0") == "1",
        "digest_hour": int(db.get_setting("digest_hour", "8")),
        "digest_to": db.get_setting("digest_to", config.DIGEST_TO),
        "smtp_configured": config.smtp_configured(),
        "words_per_minute": config.WORDS_PER_MINUTE,
        "version": __version__,
    }


@app.post("/api/settings")
def post_settings(payload: dict = Body(...)):
    if "digest_enabled" in payload:
        db.set_setting("digest_enabled", "1" if payload["digest_enabled"] else "0")
    if "digest_hour" in payload:
        try:
            hour = max(0, min(23, int(payload["digest_hour"])))
        except (TypeError, ValueError):
            _fail(400, "The digest hour must be a number between 0 and 23.")
        db.set_setting("digest_hour", str(hour))
    if "digest_to" in payload:
        db.set_setting("digest_to", (payload.get("digest_to") or "").strip())
    return get_settings()


@app.post("/api/digest/test")
def digest_test():
    ok, message = reminders.send_digest(force=True)
    if not ok:
        _fail(400, message)
    return {"ok": True, "message": message}


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "items": store.stats()["total"]}


# --------------------------------------------------------------- static site

@app.get("/share")
def share_target(url: str = "", text: str = "", title: str = ""):
    """Android share sheet target. The page reads these values and opens the save sheet."""
    from urllib.parse import quote
    payload = quote(url or text or "", safe="")
    return RedirectResponse(f"/?share={payload}&title={quote(title or '', safe='')}", status_code=303)


def _run_share_upload(job_id: str, filename: str, data: bytes, title: str) -> None:
    entry = {"url": filename, "ok": False, "title": "", "error": "", "duplicate": False}
    try:
        item = ingest.from_upload(filename, data)
        if title.strip():
            item["title"] = title.strip()
        result = _save_ingested(item)
        entry.update(ok=True, title=result["item"]["title"],
                     duplicate=result["duplicate"], id=result["item"]["id"])
    except Exception as exc:
        entry["error"] = str(exc) or type(exc).__name__
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        job["results"].append(entry)
        job["done"] += 1
        job["finished"] = True


@app.post("/share")
def share_target_post(file: UploadFile | None = File(None), url: str = Form(""),
                      text: str = Form(""), title: str = Form("")):
    """The share sheet again, but for files.

    A shared link arrives as form text. A shared PDF arrives as a file, and a long
    report can take minutes to ingest, so the work runs on a worker thread and the
    redirect returns at once — the page then polls the job rather than leaving the
    phone staring at a blank tab.
    """
    from urllib.parse import quote
    if file is not None and (file.filename or "").strip():
        data = file.file.read()
        if not data:
            return RedirectResponse("/", status_code=303)
        if len(data) > config.MAX_DOWNLOAD_BYTES:
            return RedirectResponse("/?share_error=too_large", status_code=303)
        job_id = uuid.uuid4().hex[:12]
        with _JOBS_LOCK:
            _JOBS[job_id] = {"total": 1, "done": 0, "finished": False, "results": []}
        threading.Thread(target=_run_share_upload,
                         args=(job_id, file.filename or "file", data, title),
                         daemon=True).start()
        return RedirectResponse(f"/?upload_job={job_id}", status_code=303)

    payload = quote(url or text or "", safe="")
    return RedirectResponse(f"/?share={payload}&title={quote(title or '', safe='')}",
                            status_code=303)


if config.MEDIA_DIR.exists():
    app.mount("/media", StaticFiles(directory=str(config.MEDIA_DIR)), name="media")


@app.get("/manifest.webmanifest")
def manifest():
    path = config.FRONTEND_DIR / "manifest.webmanifest"
    return FileResponse(path, media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # Served from the root so its scope covers the whole app.
    return FileResponse(config.FRONTEND_DIR / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="frontend")
