"""CSV-based public MCP tools — query the local ProductInfo database.

6 public tools: database summary, product search, lookup by id / harrison code, a thin
cost estimate, and cache refresh. Additional mapping and priced-estimate tools may be
provided by a private extension that loads via register(). No AutoCAD or live bridge
connection required.
"""

from typing import Optional

from fabrication_mcp import mcp
from fabrication_mcp.config import _safe_float
from fabrication_mcp.loaders import _latest_csv
from fabrication_mcp.cache import (
    _profiles, _get_active_cache,
    _products, _products_by_id, _products_by_harrison, _get_search_index,
    _mapped, _catalog,
    _estimate_caches, _estimate_by_dbid,
)
from fabrication_mcp.profiles import get_active_profile_name
from fabrication_mcp.bridge import _bridge_get, _check_bridge_sync
from fabrication_mcp.mutation_policy import guard
import fabrication_mcp.cache as _cache_mod


# ── Tool: Summary ────────────────────────────────────────────────────────────

@mcp.tool()
def get_database_summary() -> dict:
    """
    Returns a high-level summary of all available Fabrication database data:
    record counts, list of manufacturers, product groups, data sources,
    and data file timestamps. Always call this first in a new session to
    understand the scope of available data before querying.

    Also includes a bridge_status field showing whether the live AutoCAD bridge
    is available and which database it's serving (database_name, database_path,
    profile_name).

    Key count distinctions (N/A is NEVER a valid value — always treated as null/empty):
    - product_info_count: total raw rows in ProductInfo CSV (~236k)
    - listed_products_count: items where IsProductListed != "N/A" — these are
      the "real" products visible in the Fabrication product editor (~164k)
    - products_with_cost: products with non-zero Cost value
    - products_with_labor: products with non-zero LaborRate or BpLaborValue
    - products_with_harrison: products with a real harrison_code (not N/A)
    - products_with_discount: products with a discount code string assigned
    - mapped_product_count: validated mapped subset (~7.4k)
    """
    _check_bridge_sync()  # auto-detect profile switch
    p = _products()
    m = _mapped()

    manufacturers = sorted({
        r["manufacturer"] for r in p
        if r.get("manufacturer") and r["manufacturer"] not in {"(Generic)"}
    })
    product_groups = sorted({r["product_group"] for r in p if r.get("product_group")})
    materials = sorted({r["material"] for r in p if r.get("material")})
    mapper_sources = sorted({r.get("mapper_source") for r in m if r.get("mapper_source")})

    cache = _get_active_cache()
    pi_path = _latest_csv(
        cache.config.product_info_dir,
        cache.config.product_info_pattern,
        exclude=cache.config.product_info_exclude,
    )
    mapped_path = _latest_csv(cache.config.mapping_dir, "mapped_products_*.csv") if cache.config.mapping_dir else None

    # Count "real" products: IsProductListed is "Yes" or "No" (not "N/A" or blank)
    # NOTE: _val() already converts N/A to None, so truthy checks work correctly.
    listed_count = sum(
        1 for r in p
        if r.get("is_product_listed") and r["is_product_listed"].upper() != "N/A"
    )
    # N/A-aware counts -- N/A is never a valid value in any Fabrication field
    harrison_count = sum(1 for r in p if r.get("harrison_code"))
    discount_count = sum(1 for r in p if r.get("discount"))
    cost_count = sum(1 for r in p if _safe_float(r.get("cost")) > 0)
    labor_count = sum(
        1 for r in p
        if _safe_float(r.get("labor_rate")) > 0 or _safe_float(r.get("bp_labor_value")) > 0
    )

    result = {
        "product_info_count": len(p),
        "listed_products_count": listed_count,
        "products_with_cost": cost_count,
        "products_with_labor": labor_count,
        "products_with_harrison": harrison_count,
        "products_with_discount": discount_count,
        "mapped_product_count": len(m),
        "catalog_count": len(_catalog()),
        "product_info_file": pi_path.name if pi_path else None,
        "mapped_output_file": mapped_path.name if mapped_path else None,
        "manufacturers": manufacturers,
        "product_groups": product_groups,
        "materials": materials,
        "mapper_sources": mapper_sources,
    }
    if _profiles:
        result["active_profile"] = get_active_profile_name()
        result["available_profiles"] = list(_profiles.keys())

    # Check bridge availability and report which database it's serving
    bridge_data = _bridge_get("/api/status")
    if bridge_data is not None:
        result["bridge_status"] = {
            "online": True,
            "database_name": bridge_data.get("database_name"),
            "database_path": bridge_data.get("database_path"),
            "profile_name": bridge_data.get("profile_name"),
            "product_count": bridge_data.get("product_count"),
        }
    else:
        result["bridge_status"] = {"online": False}

    return result


# ── Tool: Search Products ────────────────────────────────────────────────────

@mcp.tool()
def search_products(
    query: str,
    manufacturer: str = None,
    material: str = None,
    product_group: str = None,
    install_type: str = None,
    price_status: str = None,
    is_product_listed: bool = None,
    limit: int = 25,
) -> list[dict]:
    """
    Search the Fabrication ProductInfo database (~236k raw rows; ~164k listed products)
    by free-text query matched against description, product name, size, specification,
    and harrison_code fields (case-insensitive).

    Optional filters:
    - manufacturer: e.g. 'Nibco', 'Anvil', 'Shaw', 'Victaulic', 'Weldbend'
    - material: e.g. 'Stainless Steel', 'Carbon Steel', 'Cast Iron', 'Copper'
    - product_group: e.g. 'Mechanical', 'Plumbing (DWV)', 'HVAC'
    - install_type: e.g. 'Welded', 'Threaded', 'Press', 'Grooved'
    - price_status: 'Active', 'PriceOnApplication', or 'Discontinued'
    - is_product_listed: True = has a product list entry, False = no product list

    Returns fields: pi_id, description, size, manufacturer, material, harrison_code,
    cost, price_units, price_status, labor_rate, labor_units, install_type, specification.
    """
    _check_bridge_sync()  # auto-detect profile switch
    q = query.lower()
    results = []
    mfr_q = manufacturer.lower() if manufacturer else None
    mat_q = material.lower() if material else None
    pg_q  = product_group.lower() if product_group else None
    it_q  = install_type.lower() if install_type else None
    ps_q  = price_status.lower() if price_status else None

    # Use token index for candidate narrowing when available
    idx = _get_search_index()
    candidates = idx.query(q) if idx else None
    by_id = _products_by_id() if candidates is not None else None

    # If index gave candidates, iterate only those; otherwise fall back to full scan
    if candidates is not None and by_id is not None:
        source = (by_id[pid] for pid in candidates if pid in by_id)
    else:
        source = _products()

    for r in source:
        # Skip items not in the product editor (IsProductListed = N/A -> None)
        # unless the caller explicitly passed is_product_listed=False
        listed_val = r.get("is_product_listed")
        if listed_val is None and is_product_listed is not False:
            continue
        if is_product_listed is not None:
            listed = (listed_val or "").lower() == "yes"
            if listed != is_product_listed:
                continue

        # Final substring check (index uses token matching, not substring)
        searchable = r.get("_search_text") or " ".join(filter(None, [
            r.get("description"), r.get("product_name"), r.get("size"),
            r.get("specification"), r.get("harrison_code"),
        ])).lower()
        if q not in searchable:
            continue
        if mfr_q and mfr_q not in (r.get("manufacturer") or "").lower():
            continue
        if mat_q and mat_q not in (r.get("material") or "").lower():
            continue
        if pg_q and pg_q not in (r.get("product_group") or "").lower():
            continue
        if it_q and it_q not in (r.get("install_type") or "").lower():
            continue
        if ps_q and ps_q not in (r.get("price_status") or "").lower():
            continue

        results.append({
            "pi_id": r["pi_id"],
            "description": r["description"],
            "size": r["size"],
            "manufacturer": r["manufacturer"],
            "material": r["material"],
            "product_group": r["product_group"],
            "specification": r["specification"],
            "install_type": r["install_type"],
            "is_product_listed": r["is_product_listed"],
            "harrison_code": r["harrison_code"],
            "cost": r["cost"],
            "price_units": r["price_units"],
            "price_status": r["price_status"],
            "labor_rate": r["labor_rate"],
            "labor_units": r["labor_units"],
        })
        if len(results) >= limit:
            break

    return results


# ── Tool: Get Product by ID ─────────────────────────────────────────────────

@mcp.tool()
def get_product_by_id(product_id: str) -> Optional[dict]:
    """
    Retrieve a single Fabrication product by its pi_id, e.g. 'MDSK_ALL1_000007-0001'
    or 'ADSK_PIPE_000123-0002'.
    Returns all available fields including pricing, labor, supplier codes,
    and breakpoint labor data. Returns null if not found.
    """
    _check_bridge_sync()  # auto-detect profile switch
    _products()  # ensure cache + index built
    return _products_by_id().get(product_id)


# ── Tool: Get Product by Harrison Code ───────────────────────────────────────

@mcp.tool()
def get_product_by_harrison_code(harrison_code: str) -> Optional[dict]:
    """
    Look up a Fabrication product by its harrison_code (a ProductInfo column).
    The harrison_code is the internal Fabrication database ID that appears in price lists.
    Returns null if not found.
    """
    _check_bridge_sync()  # auto-detect profile switch
    _products()  # ensure cache + index built
    return _products_by_harrison().get(harrison_code.strip().lower())


# ── Tool: Cost Estimate ─────────────────────────────────────────────────────

@mcp.tool()
def estimate_cost(
    product_ids: list[str],
    quantities: list[float] = None,
) -> dict:
    """
    Estimate material and labor cost for a list of Fabrication product IDs using the
    cost and labor_rate fields in your own Fabrication database (ProductInfo).

    This is the public foundation estimator: each item is priced straight from the
    Fabrication database, with no external price catalog, no net-price lookup, and no
    discount multipliers. Configure price lists inside your Fabrication database to
    control the cost values this reads.

    - product_ids: list of pi_id values (e.g. ['MDSK_ALL1_000007-0001', ...])
    - quantities: optional list of quantities (defaults to 1.0 each)

    Returns a line-by-line breakdown and total material + labor estimate.
    """
    _check_bridge_sync()  # auto-detect profile switch
    if quantities is None:
        quantities = [1.0] * len(product_ids)
    if len(quantities) != len(product_ids):
        return {"error": "product_ids and quantities must have the same length"}

    _products()  # ensure products index built
    pi_by_id = _products_by_id()

    lines = []
    total_material = 0.0
    total_labor = 0.0

    for pid, qty in zip(product_ids, quantities):
        pi = pi_by_id.get(pid)
        if not pi:
            lines.append({"pi_id": pid, "error": "product not found"})
            continue

        # Price straight from the user's own Fabrication database — no discount
        # multipliers. _safe_float treats N/A / missing / non-numeric as 0.0.
        price = _safe_float(pi.get("cost"))
        labor = _safe_float(pi.get("labor_rate"))

        line_material = price * qty
        line_labor = labor * qty
        total_material += line_material
        total_labor += line_labor

        lines.append({
            "pi_id": pid,
            "description": pi.get("description"),
            "size": pi.get("size"),
            "quantity": qty,
            "unit_price": round(price, 4),
            "unit_labor": labor,
            "line_material": round(line_material, 2),
            "line_labor_hrs": round(line_labor, 3),
            "price_source": "product_info",
            "harrison_code": pi.get("harrison_code"),
        })

    return {
        "lines": lines,
        "total_material": round(total_material, 2),
        "total_labor_hrs": round(total_labor, 3),
        "item_count": len(lines),
    }


# ── Tool: Cache Refresh ─────────────────────────────────────────────────────

@mcp.tool()
def refresh_cache(profile: str = None) -> dict:
    """
    Clears the in-memory CSV caches so the next query reloads from disk.
    Use this after running FabricationSample export commands or after the
    mapping pipeline has produced new output files.

    If profile is specified, only that profile's cache is cleared.
    If no profile specified, clears the active profile's cache.
    Also clears estimate caches (per-model) and the catalog cache (shared).
    """
    verdict = guard("refresh_cache")
    if verdict is not None:
        return verdict
    # Always clear estimate caches (per-model, not per-profile)
    _estimate_caches.clear()
    _estimate_by_dbid.clear()

    # Always clear the shared catalog cache — next access reloads via the loader hook.
    _cache_mod._catalog_cache = None
    _cache_mod._catalog_search_index = None
    catalog_note = "(catalog reloads on next access)"

    # Determine which profile to clear
    target = profile if profile and profile in _profiles else get_active_profile_name()
    if target and target in _profiles:
        cache = _profiles[target]
        cache.pi_cache = None
        cache.pi_by_id = None
        cache.pi_by_harrison = None
        cache.search_index = None
        cache.mapped_cache = None
        cache.mapped_by_id = None
        cache.discount_cache = None
        cache.item_data_cache = None
        cache.loaded_at = None
        return {"status": f"profile '{target}' cache cleared (+ estimate + catalog) — next query will reload from disk {catalog_note}"}
    return {"status": f"estimate + catalog caches cleared — next query will reload from disk {catalog_note}"}


