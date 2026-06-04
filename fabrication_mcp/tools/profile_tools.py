"""Profile management MCP tools — list, switch, get active, sync with bridge."""

from pathlib import Path
from typing import Optional

from fabrication_mcp import mcp
from fabrication_mcp.loaders import _latest_csv
from fabrication_mcp.cache import (
    _profiles, _get_active_cache,
    _estimate_caches, _estimate_by_dbid,
)
from fabrication_mcp.bridge import _bridge_get, _check_bridge_sync
from fabrication_mcp.mutation_policy import guard
import fabrication_mcp.bridge as _bridge_mod
from fabrication_mcp.profiles import (
    get_active_profile_name, set_active_profile,
)


@mcp.tool()
def list_profiles() -> dict:
    """
    List all registered data profiles with summary stats.
    Profiles represent different Fabrication database exports (e.g., a production
    database vs. a training copy). Each profile has its own set of ProductInfo, mappings, and
    discount data. Call switch_profile() to change which profile is active.

    If no profiles are registered, the server runs in legacy single-dataset mode.
    """
    if not _profiles:
        return {
            "mode": "legacy",
            "message": "No profiles registered. Server is using hardcoded paths (single-dataset mode).",
            "active_profile": None,
        }
    result = {
        "mode": "multi-profile",
        "active_profile": get_active_profile_name(),
        "profiles": {},
    }
    for name, cache in _profiles.items():
        info = {
            "display_name": cache.config.display_name,
            "loaded": cache.pi_cache is not None,
            "product_info_dir": str(cache.config.product_info_dir),
        }
        if cache.pi_cache is not None:
            info["product_count"] = len(cache.pi_cache)
            info["mapped_count"] = len(cache.mapped_cache) if cache.mapped_cache else 0
            info["loaded_at"] = cache.loaded_at.isoformat() if cache.loaded_at else None
        result["profiles"][name] = info
    return result


@mcp.tool()
def switch_profile(profile: str) -> dict:
    """
    Switch the active data context to a different profile.
    All subsequent CSV-based queries (search_products, get_product_by_id, etc.) will use
    this profile's data. Call list_profiles() first to see available profiles.

    The shared catalog is shared across all profiles. Live bridge tools always reflect
    whatever database CADmep has loaded (independent of active profile).
    """
    verdict = guard("switch_profile")
    if verdict is not None:
        return verdict
    if profile not in _profiles:
        available = list(_profiles.keys()) if _profiles else ["(none — no profiles registered)"]
        return {"error": f"Unknown profile: {profile}", "available": available}
    set_active_profile(profile)
    cache = _get_active_cache()  # triggers lazy load (before clearing estimate caches)
    # Clear estimate caches — they may reference models from the old profile
    # The shared catalog is not cleared — it is shared across all profiles
    _estimate_caches.clear()
    _estimate_by_dbid.clear()
    return {
        "status": f"Switched to profile: {profile}",
        "display_name": cache.config.display_name,
        "product_count": len(cache.pi_cache),
        "mapped_count": len(cache.mapped_cache) if cache.mapped_cache else 0,
        "discount_count": len(cache.discount_cache) if cache.discount_cache else 0,
    }


@mcp.tool()
def get_active_profile() -> dict:
    """
    Show which profile is currently active and its data summary.
    Returns the active profile name, display name, data counts, and data file paths.
    Also includes a bridge_database field showing which database the live bridge is
    serving, so you can verify the MCP profile matches the AutoCAD session.
    If no profile is active, returns legacy mode status.
    """
    active_name = get_active_profile_name()
    if not active_name or active_name not in _profiles:
        return {
            "mode": "legacy" if not _profiles else "multi-profile (no active)",
            "active_profile": None,
            "message": "Using hardcoded paths." if not _profiles else "Profiles registered but none active. Call switch_profile().",
        }
    cache = _profiles[active_name]
    pi_path = _latest_csv(
        cache.config.product_info_dir,
        cache.config.product_info_pattern,
        exclude=cache.config.product_info_exclude,
    )
    result = {
        "active_profile": active_name,
        "display_name": cache.config.display_name,
        "loaded": cache.pi_cache is not None,
        "product_info_file": pi_path.name if pi_path else None,
        "product_info_dir": str(cache.config.product_info_dir),
    }
    if cache.pi_cache is not None:
        result["product_count"] = len(cache.pi_cache)
        result["mapped_count"] = len(cache.mapped_cache) if cache.mapped_cache else 0
        result["discount_count"] = len(cache.discount_cache) if cache.discount_cache else 0
        result["loaded_at"] = cache.loaded_at.isoformat() if cache.loaded_at else None

    # Show which database the bridge is serving (helps verify MCP profile matches bridge)
    bridge_data = _bridge_get("/api/status")
    if bridge_data is not None:
        result["bridge_database"] = {
            "online": True,
            "database_name": bridge_data.get("database_name"),
            "database_path": bridge_data.get("database_path"),
            "profile_name": bridge_data.get("profile_name"),
        }
    else:
        result["bridge_database"] = {"online": False}

    return result


@mcp.tool()
def sync_profile_with_bridge() -> dict:
    """
    Check if the bridge database has changed and sync the MCP profile to match.
    Triggers a bridge cache refresh and switches to the matching MCP profile.
    This happens automatically every 30 seconds during normal tool use,
    but call this explicitly after switching AutoCAD profiles for immediate sync.
    """
    verdict = guard("sync_profile_with_bridge")
    if verdict is not None:
        return verdict
    _bridge_mod._last_bridge_check = 0  # force check
    result = _check_bridge_sync()
    if result is None:
        # Bridge offline or no change
        status = _bridge_get("/api/status")
        if status is None:
            return {"status": "bridge_offline", "message": "AutoCAD bridge is not running."}
        return {
            "status": "in_sync",
            "active_profile": get_active_profile_name(),
            "bridge_database": status.get("database_name", ""),
            "bridge_profile": status.get("profile_name", ""),
        }
    return result
