"""The email digest of unfinished reading.

The in-app queue is the primary reminder and needs no configuration. This adds an
optional daily email. Without SMTP settings it stays dormant and says so, rather
than failing quietly.
"""
from __future__ import annotations

import html
import smtplib
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage

from . import config, db, store


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def build_digest(queue: list[dict], stats: dict) -> tuple[str, str, str]:
    today = datetime.now().strftime("%A %d %B")
    subject = f"Folio — {_plural(len(queue), 'article waiting', 'articles waiting')}"

    lines = [f"Your reading queue, {today}", ""]
    for item in queue[:12]:
        pct = item.get("progress_pct", 0)
        state = f"{pct}% read" if pct else "not started"
        lines.append(f"• {item['title']}")
        lines.append(f"    {item.get('site_name') or item.get('kind')} — "
                     f"{item.get('reading_minutes', 0)} min, {state}")
        lines.append(f"    {item.get('reason', '')}")
        lines.append(f"    {config.PUBLIC_URL}/?open={item['id']}")
        lines.append("")
    lines.append(f"Library: {stats.get('total', 0)} saved, "
                 f"{stats.get('finished', 0)} finished, {stats.get('queue', 0)} waiting.")
    text = "\n".join(lines)

    rows = []
    for item in queue[:12]:
        pct = int(item.get("progress_pct", 0))
        state = f"{pct}% read" if pct else "not started"
        rows.append(f"""
        <tr><td style="padding:14px 0;border-bottom:1px solid #e7e4de">
          <a href="{config.PUBLIC_URL}/?open={item['id']}"
             style="color:#14110f;font:600 16px/1.35 Georgia,serif;text-decoration:none">
             {html.escape(item['title'])}</a>
          <div style="margin-top:5px;font:400 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#6b645c">
            {html.escape(item.get('site_name') or item.get('kind', ''))} ·
            {item.get('reading_minutes', 0)} min · {state}
          </div>
          <div style="margin-top:3px;font:400 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#98908544">
            <span style="color:#8d857a">{html.escape(item.get('reason', ''))}</span>
          </div>
        </td></tr>""")

    body = f"""<!doctype html><html><body style="margin:0;background:#faf9f7;padding:28px 16px">
    <div style="max-width:560px;margin:0 auto;background:#fffdfa;border:1px solid #e7e4de;
                border-radius:10px;padding:28px 26px">
      <div style="font:600 12px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.14em;
                  text-transform:uppercase;color:#a8a096">Folio</div>
      <h1 style="margin:10px 0 2px;font:400 25px/1.25 Georgia,serif;color:#14110f">
        Still on your shelf</h1>
      <p style="margin:0 0 6px;font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b645c">
        {today}</p>
      <table style="width:100%;border-collapse:collapse">{''.join(rows)}</table>
      <p style="margin:22px 0 0;font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#8d857a">
        {stats.get('total', 0)} saved · {stats.get('finished', 0)} finished ·
        {stats.get('queue', 0)} waiting</p>
    </div></body></html>"""

    return subject, text, body


def send_digest(force: bool = False) -> tuple[bool, str]:
    if not config.smtp_configured():
        return False, (
            "Email is not configured. Set FOLIO_SMTP_HOST, FOLIO_SMTP_USER, "
            "FOLIO_SMTP_PASSWORD and FOLIO_DIGEST_TO, then restart Folio."
        )

    queue = store.reading_queue(limit=12)
    if not queue and not force:
        return False, "Nothing is waiting to be read."

    recipient = db.get_setting("digest_to", "") or config.DIGEST_TO
    subject, text, body = build_digest(queue, store.stats())

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = config.DIGEST_FROM
    message["To"] = recipient
    message.set_content(text)
    message.add_alternative(body, subtype="html")

    try:
        if config.SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
        else:
            server = smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
        with server:
            server.ehlo()
            if config.SMTP_STARTTLS and config.SMTP_PORT != 465:
                server.starttls()
                server.ehlo()
            if config.SMTP_USER:
                server.login(config.SMTP_USER, config.SMTP_PASSWORD)
            server.send_message(message)
    except Exception as exc:
        return False, f"The email could not be sent. {type(exc).__name__}: {exc}"

    db.set_setting("digest_last_sent", db.now())
    return True, f"Digest sent to {recipient} ({len(queue)} waiting)."


def _scheduler_loop() -> None:
    """Send at most one digest a day, at the configured local hour."""
    while True:
        try:
            if db.get_setting("digest_enabled", "0") == "1" and config.smtp_configured():
                hour = int(db.get_setting("digest_hour", "8"))
                now = datetime.now()
                last = db.get_setting("digest_last_sent", "")
                sent_today = False
                if last:
                    try:
                        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
                        sent_today = last_dt.astimezone().date() == now.date()
                    except ValueError:
                        pass
                if now.hour >= hour and not sent_today:
                    send_digest()
        except Exception:
            pass          # a scheduler fault must never take the server down
        time.sleep(300)


def start_scheduler() -> None:
    threading.Thread(target=_scheduler_loop, daemon=True, name="folio-digest").start()
