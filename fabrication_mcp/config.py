"""Configuration constants, column maps, and tiny helpers.

This is a leaf module with NO internal imports — everything else may depend on it.
"""

import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger("fabrication-mcp")


# ── Paths ───────────────────────────────────────────────────────────────
# Neutral defaults. Real deployments resolve per-profile paths from
# hub/hub-manifest.json (see profiles.py); these are only the no-manifest fallback.
DATA_ROOT = Path(os.environ.get("FABRICATION_DATA_ROOT", str(Path.home() / "fabrication-data")))

FAB_CONTENT_DIR = DATA_ROOT / "product-info"
MAPPING_TOOLS_DIR = DATA_ROOT / "mappings"
PRICING_DIR = DATA_ROOT / "pricing"

# Proprietary catalog config (snapshot CSV, per-manufacturer dir, SQLite DB) moved to the
# optional extension package (open-core split): the public build has no proprietary catalog
# and runs CSV-only. A private build installs a catalog loader via the cache hook at boot
# (see fabrication_mcp.cache._external_catalog_loader).

# Non-CSV product-source config moved to the optional extension package (open-core split):
# the public build is CSV-only. A private build installs an external product loader via
# the cache hook at boot (see fabrication_mcp.cache._external_product_loader).

# ── Server identity (parameterized for public/private open-core builds) ───────
# Private default = "fabrication-mcp". The public build overrides via
# MCP_SERVER_NAME=fabrication-mcp so the released package announces a neutral name.
SERVER_NAME = os.environ.get("MCP_SERVER_NAME", "fabrication-mcp")

# Hub manifest location (for multi-profile support)
HUB_MANIFEST_PATH = Path(__file__).resolve().parent.parent / "hub" / "hub-manifest.json"


# ── Bridge settings ───────────────────────────────────────────────────────────

BRIDGE_URL = os.environ.get("FABRICATION_BRIDGE_URL", "http://localhost:5050")
BRIDGE_TIMEOUT = 5  # seconds
BRIDGE_SYNC_INTERVAL = 30  # seconds between auto-checks


# ── ProductInfo column map ────────────────────────────────────────────────────
# The ProductInfo CSV has 3 duplicate "Id" columns — use csv.reader, not DictReader.

PI_COLS = {
    0:  "pi_id",
    1:  "is_product_listed",
    2:  "product_group",
    3:  "manufacturer",
    4:  "product_name",
    5:  "description",
    6:  "size",
    7:  "material",
    8:  "specification",
    9:  "install_type",
    10: "source",
    11: "range",
    12: "finish",
    # 13: skip
    14: "supplier_id",
    15: "ferguson_code",
    16: "upc_code",
    17: "manufacturer_code",
    18: "oem_code",
    19: "harrison_code",
    # 20: skip, 21: ignore supplier group, 22: ignore price list name
    23: "price_list_id",
    24: "cost",
    25: "discount",
    26: "price_units",
    27: "price_date",
    28: "price_status",
    # 29: skip, 30: ignore install table name
    31: "install_id",
    32: "labor_rate",
    33: "labor_units",
    34: "labor_status",
    35: "bp_install_table",
    36: "bp_labor_value",
}


# ── ItemData column map ──────────────────────────────────────────────────────

ITEM_DATA_COLS = {
    0: "service_name", 1: "service_template", 2: "button_name",
    3: "item_file_path", 4: "product_list_entry_name",
    5: "condition_description", 6: "greater_than", 7: "id",
    8: "less_than_equal_to",
}


# ── Sentinel values ──────────────────────────────────────────────────────────

_NA = {"", "N/A", "n/a", "(skip)", "(none)"}


# ── Tiny helpers ─────────────────────────────────────────────────────────────

def _val(v: str) -> Optional[str]:
    """Return None for blank/N/A values, otherwise the stripped string."""
    s = v.strip()
    return None if s in _NA else s


def _safe_float(v) -> float:
    """Convert a value to float, treating empty/dash/non-numeric as 0.0."""
    if v is None:
        return 0.0
    s = str(v).strip()
    if not s or s in ("-", "N/A", "n/a", ""):
        return 0.0
    try:
        return float(s.replace(",", ""))
    except (ValueError, TypeError):
        return 0.0
