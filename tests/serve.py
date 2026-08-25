"""Static server for the benchmark, with caching turned off.

A browser caches an ES module for the life of the tab and revalidates lazily, so an
edited extractor kept reporting the previous run's numbers. Every response here says
no-store, which makes each reload measure the code actually on disk.
"""

import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8125
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
