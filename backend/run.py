"""Start Folio.

    python backend/run.py                 # localhost only
    python backend/run.py --lan           # also reachable from your phone on the same network
"""
from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn

from folio import config, db, reminders


def lan_address() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))          # no packet is sent; this just picks the route
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Folio reading library.")
    parser.add_argument("--host", default=None, help="Address to bind to.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan", action="store_true",
                        help="Bind to every interface so other devices can reach it.")
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    host = args.host or ("0.0.0.0" if args.lan else "127.0.0.1")

    db.init()
    reminders.start_scheduler()

    print(f"  Folio — data in {config.DATA_DIR}")
    print(f"  Local     http://localhost:{args.port}")
    if args.lan:
        print(f"  Network   http://{lan_address()}:{args.port}   (open this on your phone)")
    print()

    uvicorn.run("folio.api:app", host=host, port=args.port, reload=args.reload,
                log_level="info")


if __name__ == "__main__":
    main()
