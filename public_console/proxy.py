"""Console proxy sidecar — serves the public console and bridges it to the MCP server.

One process, one origin, zero extra dependencies beyond the server's own:

    python public_console/proxy.py [--port 8110]

* ``GET /``           — static files from public_console/ (the console UI)
* ``GET /rpc/tools``  — JSON list of available MCP tools (name, description, schema)
* ``POST /rpc``       — invoke an MCP tool: ``{"tool": "est_list_jobs", "arguments": {}}``
                        → ``{"ok": true, "tool": ..., "result": ...}``

The browser talks plain ``fetch()`` JSON to the same origin it loaded the page
from, so no CORS is involved. The proxy talks MCP to an in-memory client
session against the same server instance ``python server.py`` would run —
write-policy enforcement (mutation-policy.json) therefore applies unchanged.

Intended for localhost use. Tool error strings are passed through to the
browser verbatim (useful for local debugging) — if you bind beyond 127.0.0.1,
scrub them first. Long-running tools may outlive the console's 12s fetch
timeout; the proxy itself waits up to 120s and logs the real outcome.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

log = logging.getLogger("console-proxy")

MAX_BODY = 1 * 1024 * 1024  # 1 MB request-body ceiling

PUBLIC_DIR = Path(__file__).resolve().parent
REPO_ROOT = PUBLIC_DIR.parent

# Make ``import server`` work no matter where the proxy is launched from.
sys.path.insert(0, str(REPO_ROOT))

# Import the PUBLIC package first so its tool surface can be snapshotted
# BEFORE the server entry point fires the optional extension-load seam.
# The console ships with the public package, so its tool catalog
# (``GET /rpc/tools``) lists exactly the tools that ship with it. In a
# public build (no extension package present) the snapshot equals the
# full tool set and both filters are no-ops. Tool *calls* are gated to the
# same snapshot (see is_tool_allowed) so catalog and dispatch stay consistent.
import fabrication_mcp as _fabrication_mcp  # noqa: E402

from fastmcp import Client  # noqa: E402  (already a server dependency)

# ── MCP client on a dedicated event loop ─────────────────────────────────────
# One long-lived in-memory session shared by all HTTP threads; calls are
# marshaled onto this loop so the FastMCP session never crosses loops.
_loop = asyncio.new_event_loop()
threading.Thread(target=_loop.run_forever, name="mcp-loop", daemon=True).start()


def _await(coro, timeout: float = 120.0):
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout)


async def _list_tool_names(server) -> set:
    async with Client(server) as probe:
        return {t.name for t in await probe.list_tools()}


# Snapshot of the public tool surface — taken pre-seam (see note above).
# Standalone-process guarantee ONLY: if ``server`` was imported before this
# module (e.g. a test harness), the cached fabrication_mcp is already
# post-seam and the snapshot would include extension tools.
_PUBLIC_TOOL_NAMES = frozenset(_await(_list_tool_names(_fabrication_mcp.mcp)))

# Importing server bootstraps the MCP instance exactly like the production
# entry point (logging config + optional extension seam) — same ``mcp``
# instance the snapshot above was taken from.
from server import mcp  # noqa: E402


async def _open_client() -> Client:
    client = Client(mcp)
    await client.__aenter__()
    return client


_client = _await(_open_client())


def _normalize(result) -> object:
    """CallToolResult → JSON-friendly value (data → structured → text)."""
    data = getattr(result, "data", None)
    if data is not None:
        return data
    structured = getattr(result, "structured_content", None)
    if structured is not None:
        return structured
    parts = []
    for block in getattr(result, "content", []) or []:
        text = getattr(block, "text", None)
        if text is None:
            continue
        try:
            parts.append(json.loads(text))
        except (json.JSONDecodeError, ValueError):
            parts.append(text)
    if len(parts) == 1:
        return parts[0]
    return parts


def is_tool_allowed(name: str) -> bool:
    """Gate which MCP tools the HTTP surface will dispatch.

    Dispatch is narrowed to the public tool surface (the same pre-seam
    snapshot the ``GET /rpc/tools`` catalog uses) so the two stay
    consistent: over a private dev build, extension tools are neither
    listed nor callable here. No-op in public builds, where the snapshot
    equals the full set. Mutation POLICY (confirm/dry-run gating of
    declared mutators) remains the server engine's single enforcement
    point — this gate narrows the surface, not behavior. It is still the
    seam for further per-deployment narrowing (e.g. a read-only kiosk).
    """
    return name in _PUBLIC_TOOL_NAMES


# ── HTTP layer ───────────────────────────────────────────────────────────────
class ConsoleHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (http.server naming)
        # urlsplit: self.path is the RAW request target — "/rpc/tools?x=1"
        # would dodge a bare string compare and fall through to static serving
        if urlsplit(self.path).path.rstrip("/") == "/rpc/tools":
            # Catalog = public tool surface only (pre-seam snapshot); no-op
            # in public builds where the snapshot equals the full set.
            tools = [t for t in _await(_client.list_tools())
                     if t.name in _PUBLIC_TOOL_NAMES]
            self._send_json({
                "ok": True,
                "count": len(tools),
                "tools": [
                    {
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.inputSchema,
                        "allowed": is_tool_allowed(t.name),
                    }
                    for t in tools
                ],
            })
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        if urlsplit(self.path).path.rstrip("/") != "/rpc":
            self._send_json({"ok": False, "error": f"unknown endpoint {self.path}"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_BODY:
                self._send_json({"ok": False, "error": "request body too large"}, 413)
                return
            req = json.loads(self.rfile.read(length) or b"{}")
            tool = req["tool"]
            arguments = req.get("arguments")
            if arguments is None:  # NOT `or {}` — false/0/[] are legitimate values
                arguments = {}
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            self._send_json({"ok": False, "error": f"bad request: {exc}"}, 400)
            return
        if not is_tool_allowed(tool):
            self._send_json({"ok": False, "tool": tool, "error": "tool not exposed by this proxy"}, 403)
            return
        try:
            result = _await(_client.call_tool(tool, arguments))
        except Exception as exc:  # ToolError, validation, timeout — surface as envelope
            log.error("tool %s failed: %s", tool, exc)
            self._send_json({"ok": False, "tool": tool, "error": str(exc)})
            return
        self._send_json({"ok": True, "tool": tool, "result": _normalize(result)})

    def log_message(self, fmt, *args):  # quieter: one line per request, no per-asset noise
        if "/rpc" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description="Public console + MCP proxy")
    parser.add_argument("--port", type=int, default=8110)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    tools = _await(_client.list_tools())
    print(f"console+proxy ready on http://{args.bind}:{args.port}  ({len(tools)} MCP tools)")
    ThreadingHTTPServer((args.bind, args.port), ConsoleHandler).serve_forever()


if __name__ == "__main__":
    main()
