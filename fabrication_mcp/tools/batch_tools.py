"""Batch operation tools — bulk lookups for products and harrison codes.

Provides 2 tools for efficient multi-item lookups in a single call.
"""

from fabrication_mcp import mcp
from fabrication_mcp.cache import _products_by_id, _products_by_harrison
from fabrication_mcp.config import _NA

_BATCH_CAP = 100


@mcp.tool()
def batch_product_lookup(product_ids: list[str]) -> dict:
    """
    Look up multiple products by pi_id in a single call.

    Returns found records, missing IDs, and total requested count.
    Capped at 100 IDs per call to prevent oversized responses.

    Args:
        product_ids: List of pi_id values to look up (max 100).
    """
    if not product_ids:
        return {"found": [], "not_found": [], "total_requested": 0}

    if len(product_ids) > _BATCH_CAP:
        return {
            "error": f"Too many IDs: {len(product_ids)}. Maximum is {_BATCH_CAP} per call.",
            "total_requested": len(product_ids),
        }

    index = _products_by_id()
    found = []
    not_found = []

    for pid in product_ids:
        record = index.get(pid)
        if record is not None:
            found.append(record)
        else:
            not_found.append(pid)

    return {
        "found": found,
        "not_found": not_found,
        "total_requested": len(product_ids),
    }


@mcp.tool()
def batch_harrison_lookup(harrison_codes: list[str]) -> dict:
    """
    Look up multiple harrison codes in a single call.

    N/A codes are automatically skipped (N/A is the Fabrication database's
    default empty placeholder, not a valid value).

    Returns found records, missing codes, and total requested count.
    Capped at 100 codes per call to prevent oversized responses.

    Args:
        harrison_codes: List of harrison_code values to look up (max 100).
    """
    if not harrison_codes:
        return {"found": [], "not_found": [], "total_requested": 0}

    if len(harrison_codes) > _BATCH_CAP:
        return {
            "error": f"Too many codes: {len(harrison_codes)}. Maximum is {_BATCH_CAP} per call.",
            "total_requested": len(harrison_codes),
        }

    index = _products_by_harrison()
    found = []
    not_found = []

    for code in harrison_codes:
        if code in _NA:
            continue  # Skip N/A — not a valid value
        record = index.get(code.lower())
        if record is not None:
            found.append(record)
        else:
            not_found.append(code)

    return {
        "found": found,
        "not_found": not_found,
        "total_requested": len(harrison_codes),
    }
