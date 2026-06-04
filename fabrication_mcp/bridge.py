"""Bridge helpers — HTTP calls to the FabricationSample plugin at localhost:5050.

Imports: config only (plus cache/profiles for sync, accessed lazily).
"""

import json
import time
import urllib.error
import urllib.request
from typing import Optional

from fabrication_mcp.config import BRIDGE_URL, BRIDGE_TIMEOUT, BRIDGE_SYNC_INTERVAL, log
from fabrication_mcp.mutation_policy import check_bridge_post


# ── Bridge auto-sync state ───────────────────────────────────────────────────

_last_bridge_check: float = 0.0             # time.time() of last check
_last_bridge_db_path: Optional[str] = None  # last known bridge database_path


def _bridge_get(path: str, params: dict = None) -> Optional[dict | list]:
    """GET from the live bridge. Returns parsed JSON or None if bridge is down."""
    url = f"{BRIDGE_URL}{path}"
    if params:
        qs = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in params.items() if v is not None)
        if qs:
            url = f"{url}?{qs}"
    try:
        with urllib.request.urlopen(url, timeout=BRIDGE_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, TimeoutError):
        return None  # AutoCAD not running or bridge not started
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.warning(f"Bridge response parse error: {e}")
        return None


def _bridge_post(path: str, data: dict = None) -> Optional[dict | list]:
    """POST to the live bridge. Returns parsed JSON or None if bridge is down.

    Every POST passes the mutation-policy floor first — endpoints not declared
    in mutation-policy.json are rejected before any HTTP request is made.
    """
    verdict = check_bridge_post(path)
    if verdict is not None:
        return verdict
    url = f"{BRIDGE_URL}{path}"
    body = json.dumps(data).encode("utf-8") if data else b""
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=BRIDGE_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, TimeoutError):
        return None
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.warning(f"Bridge response parse error: {e}")
        return None


def _normalize_db_path(p: str) -> str:
    """Normalize a database path for comparison (forward slashes, lowercase, no trailing slash)."""
    return p.replace("\\", "/").rstrip("/").lower()


def _check_bridge_sync() -> Optional[dict]:
    """Check if bridge database has changed and auto-sync if needed.

    Returns sync info dict if a switch happened, None otherwise.
    Called automatically before CSV tool calls (throttled to BRIDGE_SYNC_INTERVAL).
    """
    global _last_bridge_check, _last_bridge_db_path

    # Lazy import to avoid circular dependency at module load time
    from fabrication_mcp.cache import _profiles, _get_active_cache
    from fabrication_mcp.profiles import get_active_profile_name, set_active_profile

    now = time.time()
    if now - _last_bridge_check < BRIDGE_SYNC_INTERVAL:
        return None  # Too soon, skip
    _last_bridge_check = now

    status = _bridge_get("/api/status")
    if status is None:
        return None  # Bridge offline, nothing to sync

    bridge_db = status.get("database_path", "")
    if not bridge_db:
        return None

    bridge_db_norm = _normalize_db_path(bridge_db)

    # First call -- just record, don't switch
    if _last_bridge_db_path is None:
        _last_bridge_db_path = bridge_db_norm
        return None

    # No change
    if bridge_db_norm == _last_bridge_db_path:
        return None

    # Database changed! Find matching profile
    _last_bridge_db_path = bridge_db_norm
    matched_profile = None
    for name, pcache in _profiles.items():
        if pcache.config.database_path and _normalize_db_path(pcache.config.database_path) == bridge_db_norm:
            matched_profile = name
            break

    result = {
        "bridge_database_changed": True,
        "new_database_path": bridge_db,
        "profile_name": status.get("profile_name", ""),
    }

    # Trigger bridge cache refresh
    refresh = _bridge_get("/api/cache/refresh")
    result["bridge_cache_refresh"] = refresh.get("status") if refresh else "bridge_unreachable"

    active_name = get_active_profile_name()
    if matched_profile and matched_profile != active_name:
        set_active_profile(matched_profile)
        cache = _get_active_cache()  # triggers lazy load
        result["mcp_profile_switched"] = matched_profile
        result["product_count"] = len(cache.pi_cache) if cache and cache.pi_cache else 0
        log.info(f"Auto-synced to profile '{matched_profile}' (bridge database changed)")
    elif matched_profile:
        result["mcp_profile_switched"] = None
        result["note"] = "Already on correct profile"
    else:
        result["mcp_profile_switched"] = None
        result["warning"] = f"No profile matches bridge database: {bridge_db}"

    return result
