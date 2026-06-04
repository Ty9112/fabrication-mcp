"""Profile management — register, switch, discover from hub manifest.

Imports: config, cache, loaders.
"""

import json
from pathlib import Path
from typing import Optional

from fabrication_mcp.config import FAB_CONTENT_DIR, HUB_MANIFEST_PATH, log
from fabrication_mcp.cache import (
    ProfileConfig, ProfileCache,
    _profiles, _get_active_cache, _load_profile_data,
)
import fabrication_mcp.cache as _cache_mod


def get_active_profile_name() -> Optional[str]:
    """Return the name of the currently active profile, or None."""
    return _cache_mod._active_profile


def register_profile(config: ProfileConfig) -> None:
    """Register a profile. Data loaded lazily on first access."""
    _profiles[config.name] = ProfileCache(config=config)
    log.info(f"Registered profile: {config.name} ({config.display_name})")


def set_active_profile(name: str) -> None:
    """Switch the active profile context."""
    if name not in _profiles:
        raise ValueError(f"Unknown profile: {name}. Available: {list(_profiles.keys())}")
    _cache_mod._active_profile = name
    log.info(f"Active profile: {name}")


def _register_default_profile() -> None:
    """Register a 'default' profile from hardcoded paths when no manifest exists.

    This ensures _get_active_cache() always returns a ProfileCache,
    eliminating the need for legacy global cache variables.
    """
    from fabrication_mcp.config import MAPPING_TOOLS_DIR, PRICING_DIR
    register_profile(ProfileConfig(
        name="default",
        display_name="Default (hardcoded paths)",
        product_info_dir=FAB_CONTENT_DIR,
        mapping_dir=MAPPING_TOOLS_DIR,
        pricing_dir=PRICING_DIR,
        database_path=str(FAB_CONTENT_DIR.parent),
    ))
    set_active_profile("default")


def _discover_profiles_from_manifest() -> None:
    """Read hub-manifest.json and register all profiles found.

    If no manifest exists or it has no profiles, registers a default profile
    from hardcoded paths so the profile system is always active.
    """
    if not HUB_MANIFEST_PATH.exists():
        _register_default_profile()
        return
    try:
        with open(HUB_MANIFEST_PATH, encoding="utf-8") as f:
            manifest = json.load(f)
        for name, profile in manifest.get("profiles", {}).items():
            exports = profile.get("exports", {})
            pi_info = exports.get("product_info", {})
            mapping_info = exports.get("mappings", {})
            sd_info = exports.get("supplier_discounts", {})
            id_info = exports.get("item_data", {})
            register_profile(ProfileConfig(
                name=name,
                display_name=profile.get("display_name", name),
                product_info_dir=Path(pi_info["directory"]) if pi_info.get("directory") else FAB_CONTENT_DIR,
                product_info_pattern=pi_info.get("pattern", "ProductInfo_*.csv"),
                product_info_exclude=pi_info.get("exclude", "DEMO"),
                mapping_dir=Path(mapping_info["directory"]) if mapping_info.get("directory") else None,
                pricing_dir=Path(sd_info["directory"]) if sd_info.get("directory") else None,
                item_data_dir=Path(id_info["directory"]) if id_info.get("directory") else None,
                item_data_pattern=id_info.get("pattern", "*_ItemData_*.csv"),
                database_path=profile.get("database_path"),
            ))
        if not _profiles:
            # Manifest exists but had no valid profiles — fall back to defaults
            _register_default_profile()
        else:
            default_profile = manifest.get("defaults", {}).get("active_profile")
            if default_profile and default_profile in _profiles:
                set_active_profile(default_profile)
            log.info(f"Discovered {len(_profiles)} profile(s) from hub manifest")
    except (json.JSONDecodeError, KeyError) as e:
        log.warning(f"Failed to parse hub manifest: {e}")
        if not _profiles:
            _register_default_profile()
