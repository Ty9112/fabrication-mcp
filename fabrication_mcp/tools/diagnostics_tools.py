"""Diagnostics tool — system health and status reporting.

Provides 1 tool for checking server health, cache state, and connectivity.
"""

import sys
import urllib.error
from pathlib import Path

from fabrication_mcp import mcp
from fabrication_mcp.cache import _profiles, _get_active_cache
from fabrication_mcp.bridge import _bridge_get
from fabrication_mcp.profiles import get_active_profile_name


@mcp.tool()
def get_diagnostics() -> dict:
    """
    Returns a comprehensive diagnostics report for the fabrication-mcp MCP server.

    Includes: Python version, FastMCP version, active profile info, bridge connectivity,
    EST database status, cache load times, and profile count.

    Useful for troubleshooting connectivity issues, verifying server state, and
    confirming data availability before running queries.
    """
    # Python version
    python_version = sys.version

    # FastMCP version
    try:
        import fastmcp
        fastmcp_version = getattr(fastmcp, "__version__", "unknown")
    except ImportError:
        fastmcp_version = "unknown"

    # Active profile info
    active_profile_name = get_active_profile_name()
    product_count = 0
    cache_loaded_at = None

    try:
        cache = _get_active_cache()
        product_count = len(cache.pi_cache) if cache.pi_cache else 0
        cache_loaded_at = cache.loaded_at.isoformat() if cache.loaded_at else None
    except RuntimeError:
        pass  # no active profile yet — leave defaults (0, None)

    # Bridge connectivity
    bridge_status = "disconnected"
    bridge_info = {}
    try:
        status = _bridge_get("/api/status")
        if status is not None:
            bridge_status = "connected"
            bridge_info = {
                "database_name": status.get("database_name"),
                "database_path": status.get("database_path"),
                "profile_name": status.get("profile_name"),
            }
    except (OSError, ValueError, urllib.error.URLError):
        bridge_status = "error"

    # EST database status
    est_db_path = Path(__file__).resolve().parent.parent.parent / "est" / "estimates.db"
    est_status = {}
    if est_db_path.exists():
        size_mb = est_db_path.stat().st_size / (1024 * 1024)
        est_status = {
            "exists": True,
            "path": str(est_db_path),
            "size_mb": round(size_mb, 2),
        }
    else:
        est_status = {
            "exists": False,
            "path": str(est_db_path),
        }

    # Number of profiles registered
    num_profiles = len(_profiles)

    return {
        "python_version": python_version,
        "fastmcp_version": fastmcp_version,
        "active_profile": active_profile_name,
        "product_count": product_count,
        "cache_loaded_at": cache_loaded_at,
        "bridge_status": bridge_status,
        "bridge_info": bridge_info,
        "est_database": est_status,
        "num_profiles": num_profiles,
    }
