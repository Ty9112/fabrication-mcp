"""Mutation policy engine — the Python interceptor (advisory smart layer).

Reads mutation-policy.json (the single source of truth, shared with the C#
bridge floor as write endpoints land there). Provides:

- guard(tool, ...)        — per-tool gate: confirm-token enforcement for
                            guarded/dangerous tiers, dry-run support, and
                            dirty-domain tracking. Called first in every
                            mutating MCP tool.
- check_bridge_post(path) — the _bridge_post floor: POSTs to endpoints not
                            declared in the policy are rejected before any
                            HTTP request is made.
- register_tool(...)      — extension hook so private builds can add their
                            own tools to the policy at boot (same pattern as
                            the cache loader hooks).

Threat model: this layer guards the LLM/agent path (hallucinated calls,
prompt injection, tool poisoning). It is advisory — the un-bypassable hard
boundary is the C# bridge floor, enforced incrementally as each write
endpoint ships. Dirty-domain marking is intent-based (marked on approved
intent, even if the bridge later reports unavailable): a false "dirty" is
safe, a false "clean" is not.
"""

import json
import re
from pathlib import Path
from typing import Optional

from fabrication_mcp.config import log

_POLICY_PATH = Path(__file__).parent / "mutation-policy.json"

_policy: Optional[dict] = None
_endpoint_patterns: Optional[list] = None  # [(compiled_regex, endpoint_key)]
_dirty_domains: set = set()


# ── Policy loading ───────────────────────────────────────────────────────────

def _load() -> dict:
    """Load and cache mutation-policy.json. Raises on missing/invalid file —
    a server without its policy must not silently run unguarded."""
    global _policy
    if _policy is None:
        with open(_POLICY_PATH, encoding="utf-8") as f:
            _policy = json.load(f)
    return _policy


def _endpoint_regexes() -> list:
    """Compile bridge endpoint templates ('{id}' segments → wildcards) once."""
    global _endpoint_patterns
    if _endpoint_patterns is None:
        _endpoint_patterns = []
        for key in _load().get("bridge_endpoints", {}):
            method, _, path = key.partition(" ")
            if method != "POST":
                continue
            pattern = "^" + re.sub(r"\{[^/]+\}", r"[^/]+", re.escape(path).replace(r"\{", "{").replace(r"\}", "}")) + "$"
            _endpoint_patterns.append((re.compile(pattern), key))
    return _endpoint_patterns


def register_tool(name: str, spec: dict) -> None:
    """Extension hook: private builds add their tools to the policy at boot."""
    _load()["tools"][name] = spec
    log.info(f"mutation_policy: registered extension tool '{name}' ({spec.get('risk', '?')})")


def register_endpoint(endpoint_key: str, spec: dict) -> None:
    """Extension hook: declare an additional bridge endpoint (e.g. 'POST /api/x')."""
    global _endpoint_patterns
    _load()["bridge_endpoints"][endpoint_key] = spec
    _endpoint_patterns = None  # recompile on next use


def get_tool_policy(name: str) -> Optional[dict]:
    return _load()["tools"].get(name)


# ── Dirty-domain tracking ────────────────────────────────────────────────────

def mark_dirty(domain: Optional[str]) -> None:
    if domain:
        _dirty_domains.add(domain)


def clear_dirty(domain: Optional[str] = None) -> None:
    """Clear one domain (after a confirmed Save) or all (None)."""
    if domain is None:
        _dirty_domains.clear()
    else:
        _dirty_domains.discard(domain)


def dirty_domains() -> list:
    return sorted(_dirty_domains)


# ── The per-tool gate ────────────────────────────────────────────────────────

def guard(tool: str, confirm: bool = False, dry_run: bool = False,
          detail: dict = None) -> Optional[dict]:
    """Gate a mutating tool call.

    Returns None to proceed, or a dict the tool must return instead
    (a dry-run plan or a friendly rejection).
    """
    spec = get_tool_policy(tool)
    if spec is None:
        # Unlisted mutator — FAIL CLOSED by default, matching the bridge-POST
        # floor. The enumeration test catches this in CI, but a forgotten
        # policy entry at runtime must deny, not silently proceed. Set
        # defaults.unlisted_tool to "warn" to opt into permissive mode.
        default = _load().get("defaults", {}).get("unlisted_tool", "reject")
        if default != "warn":
            log.error(f"mutation_policy: BLOCKED unlisted mutating tool '{tool}'")
            return {
                "blocked": True,
                "tool": tool,
                "reason": "Tool is not declared in mutation-policy.json.",
                "how_to_proceed": (
                    "Add the tool to mutation-policy.json (or register_tool() "
                    "at boot for private builds) with an appropriate risk tier."
                ),
            }
        log.warning(f"mutation_policy: unlisted mutating tool '{tool}' invoked (warn mode)")
        return None

    if dry_run:
        return {
            "dry_run": True,
            "executed": False,
            "tool": tool,
            "would_execute": detail or {},
            "policy": spec,
        }

    if spec.get("requires_confirm") and not confirm:
        return {
            "blocked": True,
            "tool": tool,
            "reason": (
                f"'{tool}' is classified {spec.get('risk', 'guarded')} — "
                f"{spec.get('note', 'it mutates state')} "
                "It requires explicit confirmation."
            ),
            "policy": spec,
            "how_to_proceed": (
                "Ask the user to approve this action, then re-call with "
                "confirm=true. Use dry_run=true first to preview the effect."
            ),
        }

    mark_dirty(spec.get("save_domain"))
    return None


# ── The _bridge_post floor ───────────────────────────────────────────────────

def check_bridge_post(path: str) -> Optional[dict]:
    """Floor under every bridge POST: unknown mutating endpoints are rejected
    BEFORE any HTTP request is made. Returns None to proceed, or the
    rejection dict to return to the caller."""
    for regex, key in _endpoint_regexes():
        if regex.match(path):
            spec = _load()["bridge_endpoints"][key]
            tool_spec = get_tool_policy(spec.get("tool", "")) or {}
            mark_dirty(tool_spec.get("save_domain"))
            return None

    if _load().get("defaults", {}).get("unlisted_bridge_post", "reject") == "reject":
        log.warning(f"mutation_policy: BLOCKED bridge POST to undeclared endpoint '{path}'")
        return {
            "blocked": True,
            "endpoint": path,
            "reason": "POST endpoint is not declared in mutation-policy.json.",
            "how_to_proceed": (
                "Declare the endpoint in the policy with a risk tier before "
                "calling it. Every mutating bridge endpoint must be classified."
            ),
        }
    return None
