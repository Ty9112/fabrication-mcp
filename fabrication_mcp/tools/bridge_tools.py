"""Live bridge MCP tools — 15 tools that call the FabricationSample HTTP API.

Requires AutoCAD 2024 running with FabricationSample plugin loaded.
"""

import urllib.request
from collections import defaultdict
from typing import Optional

from fabrication_mcp import mcp
from fabrication_mcp.bridge import _bridge_get, _bridge_post
from fabrication_mcp.mutation_policy import guard
from fabrication_mcp.cache import _get_item_data, _profiles, SearchIndex
import fabrication_mcp.cache as _cache_mod

_BRIDGE_UNAVAILABLE = {"error": "Bridge unavailable — AutoCAD not running or plugin not loaded."}


# ── Tool: Live status ────────────────────────────────────────────────────────

@mcp.tool()
def get_live_status() -> dict:
    """
    Check if the Fabrication CADmep MCP bridge is running in AutoCAD.
    Returns connection status, live database record counts, and timestamp.
    Use this to confirm AutoCAD is running with the FabricationSample plugin loaded
    before calling any live_* tools.

    If AutoCAD is not running, use the CSV-based tools (search_products, get_product_by_id, etc.)
    which work from the last exported data files.
    """
    result = _bridge_get("/api/status")
    if result is None:
        return {
            "bridge_running": False,
            "message": (
                "AutoCAD bridge is not available. "
                "Start AutoCAD 2024 with FabricationSample loaded, or use CSV-based tools."
            ),
        }
    result["bridge_running"] = True
    return result


# ── Tool: Live product search ────────────────────────────────────────────────

@mcp.tool()
def live_search_products(
    query: str = None,
    manufacturer: str = None,
    material: str = None,
    install_type: str = None,
    limit: int = 25,
) -> dict:
    """
    Search the live Fabrication ProductDatabase in AutoCAD (no CSV required).
    Returns real-time data directly from the open Fabrication job/database.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.
    Use get_live_status() first to verify bridge is up.
    Fall back to search_products() if bridge is unavailable.

    Parameters:
    - query: free-text match against description, product name, size
    - manufacturer: e.g. 'Nibco', 'Anvil', 'Shaw', 'Victaulic'
    - material: e.g. 'Stainless Steel', 'Carbon Steel', 'Cast Iron'
    - install_type: e.g. 'Welded', 'Threaded', 'Grooved', 'Press'
    - limit: max results (default 25)
    """
    params = {
        k: v for k, v in {
            "q": query,
            "manufacturer": manufacturer,
            "material": material,
            "install_type": install_type,
            "limit": limit,
        }.items() if v is not None
    }
    result = _bridge_get("/api/products", params)
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return {"products": result, "count": len(result)}


# ── Tool: Live product by ID ────────────────────────────────────────────────

@mcp.tool()
def live_get_product(product_id: str) -> dict:
    """
    Retrieve a single live Fabrication product by its database ID from AutoCAD.
    Returns full product definition including supplier IDs (Harrison code, Ferguson code, etc.).

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    Example product IDs: 'MDSK_ALL1_000007-0001', 'ADSK_PIPE_000123-0002'
    """
    result = _bridge_get(f"/api/products/{urllib.request.quote(product_id)}")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    if "error" in result:
        return result
    return result


# ── Tool: Live services ─────────────────────────────────────────────────────

@mcp.tool()
def live_get_services() -> dict:
    """
    List all Fabrication services from the live AutoCAD database.
    Returns service name, service type, and template for each service.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.
    """
    result = _bridge_get("/api/services")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return {"services": result, "count": len(result)}


# ── Tool: Live price lists ──────────────────────────────────────────────────

@mcp.tool()
def live_get_price_lists(
    supplier_group: str = None,
    limit: int = 100,
) -> dict:
    """
    List price lists from the live Fabrication database in AutoCAD.
    Returns supplier group name, list name, and entry count for each price list.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    - supplier_group: filter by supplier group name (partial match)
    - limit: max results (default 100)
    """
    params = {k: v for k, v in {"supplier_group": supplier_group, "limit": limit}.items() if v is not None}
    result = _bridge_get("/api/price-lists", params)
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return {"price_lists": result, "count": len(result)}


# ── Tool: Live install times ────────────────────────────────────────────────

@mcp.tool()
def live_get_install_times(limit: int = 100) -> dict:
    """
    List installation times tables from the live Fabrication database in AutoCAD.
    Returns table name, group, type (simple vs breakpoint), and entry count.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.
    """
    result = _bridge_get("/api/install-times", {"limit": limit})
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return {"install_times_tables": result, "count": len(result)}


# ── Tool: Live job items ────────────────────────────────────────────────────

@mcp.tool()
def live_get_job_items(
    service: str = None,
    status: str = None,
    section: str = None,
    q: str = None,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """
    List items placed in the current AutoCAD drawing (the active Fabrication job).
    Returns product description, size, service, section, status, and cost/labor data
    for each placed item.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded and a job open.

    Optional filters:
    - service: filter by service name (partial match)
    - status: filter by item status (partial match)
    - section: filter by section name (partial match)
    - q: search across name, cid, and unique_id fields
    - limit: max results (default 200; use 0 for all)
    - offset: pagination offset (default 0)
    """
    params = {
        k: v for k, v in {
            "service": service,
            "status": status,
            "section": section,
            "q": q,
            "limit": limit,
            "offset": offset,
        }.items() if v is not None
    }
    result = _bridge_get("/api/job/items", params)
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    # Bridge returns {"cache_ready": bool, "total": int, "offset": int, "limit": int, "data": [...]}
    return result


# ── Tool: Live job item detail ──────────────────────────────────────────────

@mcp.tool()
def live_get_job_item(unique_id: str) -> dict:
    """
    Retrieve a single placed job item from the current AutoCAD drawing by its unique ID.
    Returns full item detail including product data, position, service, and cost/labor.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded and a job open.

    - unique_id: the item's uniqueId from live_get_job_items results
    """
    result = _bridge_get(f"/api/job/items/{urllib.request.quote(unique_id)}")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


# ── Tool: Live product detail ───────────────────────────────────────────────

@mcp.tool()
def live_get_product_detail(product_id: str) -> dict:
    """
    Retrieve full product detail with prices and install times from the live
    AutoCAD Fabrication database. Combines product definition, price list entries,
    and install time entries into a single response.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    Example product IDs: 'MDSK_ALL1_000007-0001', 'ADSK_PIPE_000123-0002'
    """
    encoded_id = urllib.request.quote(product_id)

    # Fetch basic product info
    product = _bridge_get(f"/api/products/{encoded_id}")
    if product is None:
        return dict(_BRIDGE_UNAVAILABLE)
    if "error" in product:
        return product

    # Fetch related price entries for this product
    price_entries = _bridge_get("/api/price-lists/entries", {"q": product_id, "limit": 50})

    # Fetch related install time entries for this product
    install_entries = _bridge_get("/api/install-times/entries", {"q": product_id, "limit": 50})

    result = {
        "product": product,
        "price_entries": price_entries.get("data", price_entries) if isinstance(price_entries, dict) else (price_entries or []),
        "install_entries": install_entries.get("data", install_entries) if isinstance(install_entries, dict) else (install_entries or []),
    }
    return result


# ── Tool: Live price list entries ───────────────────────────────────────────

@mcp.tool()
def live_search_price_entries(
    supplier_group: str = None,
    list_name: str = None,
    q: str = None,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """
    Search individual price list entries from the live Fabrication database.
    Returns product_id, description, manufacturer, size, harrison_code,
    supplier_group, list_name, cost, discount_code, units, date, and status per entry.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    - supplier_group: filter by supplier/price-group name
    - list_name: filter by specific price list name
    - q: free-text search across product_id, description, harrison_code
    - limit: max results (default 200; use 0 for all)
    - offset: pagination offset
    """
    params = {k: v for k, v in {
        "supplier_group": supplier_group, "list_name": list_name,
        "q": q, "limit": limit, "offset": offset,
    }.items() if v is not None}
    result = _bridge_get("/api/price-lists/entries", params)
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


# ── Tool: Live install time entries ─────────────────────────────────────────

@mcp.tool()
def live_search_install_entries(
    table_name: str = None,
    group: str = None,
    q: str = None,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """
    Search individual install time entries from the live Fabrication database.
    Returns product_id, description, manufacturer, size, harrison_code,
    table_name, group, labor_rate, units, and status per entry.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    - table_name: filter by install time table name
    - group: filter by group (e.g. "Piping", "Plumbing")
    - q: free-text search across product_id, description, harrison_code
    - limit: max results (default 200; use 0 for all)
    - offset: pagination offset
    """
    params = {k: v for k, v in {
        "table_name": table_name, "group": group,
        "q": q, "limit": limit, "offset": offset,
    }.items() if v is not None}
    result = _bridge_get("/api/install-times/entries", params)
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


# ── Helper: Enrich bridge service items ─────────────────────────────────────

def _enrich_items_from_bridge(result: dict) -> None:
    """Best-effort enrichment of bridge service items with item_folder context.

    Attaches item_folder from the first item in each button to the button dict
    for downstream matching against ProductInfo paths.
    """
    for tab in result.get("tabs", []):
        for btn in tab.get("buttons", []):
            item_folder = ""
            for item in btn.get("items", []):
                if item.get("item_folder"):
                    item_folder = item["item_folder"]
                    break
            if item_folder:
                btn["item_folder"] = item_folder


# ── Tool: Live service template tree ────────────────────────────────────────

@mcp.tool()
def live_get_service_template_tree(service_name: str) -> dict:
    """
    Get the full hierarchical template tree for a Fabrication service.
    Returns the complete structure: service -> templates -> tabs -> buttons -> items -> conditions.
    Useful for understanding service configuration, available fittings, and button layouts.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    - service_name: exact service name (use live_get_services to get valid names)
    """
    encoded = urllib.request.quote(service_name, safe="")
    result = _bridge_get(f"/api/service-templates/{encoded}/tree")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    _enrich_items_from_bridge(result)
    return result


@mcp.tool()
def live_get_service_items(
    service: Optional[str] = None,
    limit: int = 500,
    offset: int = 0,
) -> dict:
    """
    Get catalog items available within Fabrication services (template buttons/conditions).
    This is the service CATALOG — not the current job. Returns entries like:
    service_name, template_name, button_name, item_path, entry_name, condition_desc.

    Use live_get_job_items to see items placed in the current open drawing.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    - service: filter by service name (partial match OK)
    - limit: max items to return (default 500, 0 = no limit)
    - offset: pagination offset
    """
    params = {k: v for k, v in {"service": service, "limit": limit, "offset": offset}.items() if v is not None}
    result = _bridge_get("/api/services/items", params)
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


# ── Tool: CSV-backed service buttons (offline) ──────────────────────────────

@mcp.tool()
def get_service_buttons(
    service_name: Optional[str] = None,
    button_name: Optional[str] = None,
    include_items: bool = False,
    limit: int = 200,
) -> dict:
    """
    Get service button definitions with their items from CSV export.
    Works offline (no AutoCAD/bridge needed). Filters by service and/or button name.
    Data comes from the ExportItemData CSV export.

    - service_name: filter by service name (partial match, case-insensitive)
    - button_name: filter by button name (partial match, case-insensitive)
    - include_items: if True, include individual items per button (capped at 50 per button)
    - limit: max buttons to return (default 200)
    """
    items = _get_item_data()
    if not items:
        return {"error": "No ItemData CSV found. Run ExportItemData from AutoCAD first, "
                "and configure item_data in hub-manifest.json."}

    filtered = items
    if service_name:
        sn = service_name.lower()
        filtered = [r for r in filtered if sn in r.get("service_name", "").lower()]
    if button_name:
        bn = button_name.lower()
        filtered = [r for r in filtered if bn in r.get("button_name", "").lower()]

    # Group by service -> button
    svc_buttons: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for r in filtered:
        svc_buttons[r["service_name"]][r["button_name"]].append(r)

    results = []
    count = 0
    for svc, buttons in sorted(svc_buttons.items()):
        svc_entry: dict = {"service_name": svc, "buttons": []}
        for btn, btn_items in sorted(buttons.items()):
            btn_entry: dict = {"button_name": btn, "item_count": len(btn_items)}
            if include_items:
                btn_entry["items"] = btn_items[:50]
            svc_entry["buttons"].append(btn_entry)
            count += 1
            if count >= limit:
                break
        results.append(svc_entry)
        if count >= limit:
            break

    return {
        "services": results,
        "total_buttons": count,
        "total_items": len(filtered),
    }


@mcp.tool()
def live_get_materials() -> dict:
    """
    Get all materials configured in the Fabrication database.
    Returns name, group, and gauge count for each material.
    Useful for filtering products by material and understanding database configuration.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.
    """
    result = _bridge_get("/api/materials")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


@mcp.tool()
def live_get_sections() -> dict:
    """
    Get all sections configured in the Fabrication database.
    Sections are used to categorise job items (e.g. by floor or area).
    Returns index and description for each section.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.
    """
    result = _bridge_get("/api/sections")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


@mcp.tool()
def live_get_specifications() -> dict:
    """
    Get all specifications configured in the Fabrication database.
    Specifications define pipe/duct standards (e.g. Sch 40, CPVC, etc.).
    Returns name for each specification.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.
    """
    result = _bridge_get("/api/specifications")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


# ── Write tools ─────────────────────────────────────────────────────────────

@mcp.tool()
def live_export_cache(dry_run: bool = False) -> dict:
    """
    Trigger a fresh CSV export from the live Fabrication database, then reload
    the MCP server's in-memory caches so subsequent CSV-based queries reflect
    the latest data.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded.

    Pass dry_run=true to preview the action without executing it.

    Returns the bridge export status and the cache reload result.
    """
    verdict = guard("live_export_cache", dry_run=dry_run,
                    detail={"action": "export CSVs from live database + reload server caches"})
    if verdict is not None:
        return verdict
    result = _bridge_post("/api/cache/export")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)

    # Reload MCP caches from the freshly-exported CSV files
    from fabrication_mcp.tools.csv_tools import refresh_cache
    try:
        cache_result = refresh_cache()
    except (OSError, ValueError, RuntimeError) as e:
        cache_result = {"error": f"Cache refresh failed: {e}"}

    return {
        "export": result,
        "cache_refresh": cache_result,
    }


@mcp.tool()
def live_swap_job_item(unique_id: str, new_product_id: str,
                       confirm: bool = False, dry_run: bool = False) -> dict:
    """
    Swap a placed job item to a different product in the active AutoCAD drawing.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded and a job open.

    WARNING: This modifies the active AutoCAD drawing. The item identified by
    unique_id will be replaced with the product specified by new_product_id.
    Use live_undo_swap to reverse the operation if needed.

    Parameters:
    - unique_id: the item's uniqueId (from live_get_job_items results)
    - new_product_id: the database ID of the product to swap to
      (e.g. 'MDSK_ALL1_000007-0001')
    - confirm: GUARDED mutation — must be true to execute. Ask the user first.
    - dry_run: preview the swap without executing it.
    """
    verdict = guard("live_swap_job_item", confirm=confirm, dry_run=dry_run,
                    detail={"unique_id": unique_id, "new_product_id": new_product_id})
    if verdict is not None:
        return verdict
    result = _bridge_post(
        f"/api/job/items/{urllib.request.quote(unique_id)}/swap",
        {"new_product_id": new_product_id},
    )
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result


@mcp.tool()
def live_undo_swap(dry_run: bool = False) -> dict:
    """
    Undo the last item swap operation performed via live_swap_job_item.

    REQUIRES AutoCAD 2024 running with FabricationSample plugin loaded and a job open.

    Pass dry_run=true to preview the action without executing it.

    Returns the undo result from the bridge, including the item that was restored
    to its previous product.
    """
    verdict = guard("live_undo_swap", dry_run=dry_run,
                    detail={"action": "undo the most recent item swap"})
    if verdict is not None:
        return verdict
    result = _bridge_post("/api/job/items/undo")
    if result is None:
        return dict(_BRIDGE_UNAVAILABLE)
    return result
