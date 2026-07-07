"""Estimate data tools — 2 generic tools for Power BI integration via estimate.json sidecars.

Reads generic ESTmep fields only (no proprietary pricing data). The two pricing-variance
estimate-analysis tools live in the private extension package (private build only).
"""

from fabrication_mcp import mcp
from fabrication_mcp.config import _safe_float
from fabrication_mcp.cache import _estimate_items, _default_model_id


def _estimate_item_fields(r: dict) -> dict:
    """Extract the key fields from an estimate record for API output."""
    return {
        "GlobalId": r.get("GlobalId"),
        "dbid": r.get("dbid"),
        "CID": r.get("CID"),
        "Service": r.get("Service"),
        "ServiceAbbr": r.get("ServiceAbbr"),
        "ServiceType": r.get("ServiceType"),
        "Section": r.get("Section"),
        "Drawing": r.get("Drawing"),
        "Zone1": r.get("Zone1"),
        "Spool": r.get("Spool"),
        "ProductDescription": r.get("ProductDescription"),
        "ProductName": r.get("ProductName"),
        "ProductSize": r.get("ProductSize"),
        "ProductMaterial": r.get("ProductMaterial"),
        "Supplier": r.get("Supplier"),
        "FittingType": r.get("FittingType"),
        "InstallType": r.get("InstallType"),
        "Spec": r.get("Spec"),
        "M_Rate": r.get("M-Rate"),
        "ItemPriceListCost": r.get("ItemPriceListCost"),
        "FabTime": r.get("FabTime"),
        "FabCost": r.get("FabCost"),
        "InstallTime": r.get("InstallTime"),
        "FieldCost": r.get("FieldCost"),
        "Weight": r.get("Weight"),
        "Length": r.get("Length"),
        "Area": r.get("Area"),
        "Volume": r.get("Volume"),
        "Qty": r.get("Qty"),
        "BoughtOut": r.get("BoughtOut"),
    }


@mcp.tool()
def get_estimate_items(
    model_id: str = None,
    service: str = None,
    section: str = None,
    drawing: str = None,
    material: str = None,
    dbid: str = None,
    global_id: str = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """
    Query estimate data from a model's estimate.json sidecar file.
    Returns per-item cost/labor data keyed by IFC GlobalId — the same data
    that feeds ESTmep cost estimation and Power BI reports.

    This is job-level data: every placed item in a Fabrication job with its
    material cost (M-Rate), fabrication time (FabTime/FabCost), installation
    time (InstallTime/FieldCost), weight, length, area, volume, and service info.

    Parameters:
    - model_id: hub model identifier (default: first model in active profile)
    - service: filter by Service name (partial match, case-insensitive)
    - section: filter by Section (partial match)
    - drawing: filter by Drawing (partial match)
    - material: filter by ProductMaterial (partial match)
    - dbid: filter by exact DatabaseId (pi_id), e.g. 'MDSK_DEMO_000001-0001'
    - global_id: return a single item by its IFC GlobalId
    - limit: max results (default 100, 0 = no limit)
    - offset: pagination offset

    Key fields returned: GlobalId, dbid, CID, Service, ServiceAbbr, Section,
    Drawing, Zone1, ProductDescription, ProductSize, ProductMaterial, Supplier,
    M_Rate, FabTime, FabCost, InstallTime, FieldCost, Weight, Length, Area, Qty.
    """
    mid = model_id or _default_model_id()
    if not mid:
        return {"error": "No model_id specified and no default model available. Use list_profiles() to see available models."}

    records = _estimate_items(mid)
    if not records:
        return {"error": f"No estimate data found for model '{mid}'. Check hub-manifest.json model configuration."}

    # Single-item lookup by GlobalId
    if global_id:
        for r in records:
            if r.get("GlobalId") == global_id:
                return {"model_id": mid, "item": _estimate_item_fields(r)}
        return {"error": f"GlobalId '{global_id}' not found in model '{mid}'."}

    # Filtered scan
    results = []
    svc_q = service.lower() if service else None
    sec_q = section.lower() if section else None
    drw_q = drawing.lower() if drawing else None
    mat_q = material.lower() if material else None

    skipped = 0
    for r in records:
        if dbid and r.get("dbid") != dbid:
            continue
        if svc_q and svc_q not in (r.get("Service") or "").lower():
            continue
        if sec_q and sec_q not in (r.get("Section") or "").lower():
            continue
        if drw_q and drw_q not in (r.get("Drawing") or "").lower():
            continue
        if mat_q and mat_q not in (r.get("ProductMaterial") or "").lower():
            continue

        if skipped < offset:
            skipped += 1
            continue

        results.append(_estimate_item_fields(r))
        if limit and len(results) >= limit:
            break

    return {
        "model_id": mid,
        "total_in_model": len(records),
        "returned": len(results),
        "offset": offset,
        "items": results,
    }


@mcp.tool()
def get_estimate_summary(
    model_id: str = None,
    group_by: str = "service",
) -> dict:
    """
    Aggregate estimate data for a model into cost/labor summaries.
    Returns totals grouped by the specified dimension — ideal for Power BI
    dashboards, cost reports, and executive summaries.

    Parameters:
    - model_id: hub model identifier (default: first model in active profile)
    - group_by: dimension to group by — 'service', 'section', 'material',
      'supplier', 'fitting_type', 'service_type', or 'drawing' (default: 'service')

    Returns per-group: item_count, total_weight, total_length, total_material_cost,
    total_fab_cost, total_install_cost, total_cost (material + fab + install).
    Also returns grand totals across all groups.
    """
    mid = model_id or _default_model_id()
    if not mid:
        return {"error": "No model_id specified and no default model available."}

    records = _estimate_items(mid)
    if not records:
        return {"error": f"No estimate data found for model '{mid}'."}

    # Map group_by to field name
    field_map = {
        "service": "Service",
        "section": "Section",
        "material": "ProductMaterial",
        "supplier": "Supplier",
        "fitting_type": "FittingType",
        "drawing": "Drawing",
        "service_type": "ServiceType",
    }
    group_field = field_map.get(group_by, "Service")

    groups: dict[str, dict] = {}
    grand = {"item_count": 0, "total_weight": 0.0, "total_length": 0.0,
             "total_material_cost": 0.0, "total_fab_cost": 0.0, "total_install_cost": 0.0}

    for r in records:
        key = r.get(group_field) or "(unassigned)"
        if key not in groups:
            groups[key] = {"item_count": 0, "total_weight": 0.0, "total_length": 0.0,
                           "total_material_cost": 0.0, "total_fab_cost": 0.0,
                           "total_install_cost": 0.0}
        g = groups[key]
        weight = _safe_float(r.get("Weight"))
        length = _safe_float(r.get("Length"))
        m_rate = _safe_float(r.get("M-Rate"))
        fab_cost = _safe_float(r.get("FabCost"))
        field_cost = _safe_float(r.get("FieldCost"))

        g["item_count"] += 1
        g["total_weight"] += weight
        g["total_length"] += length
        g["total_material_cost"] += m_rate
        g["total_fab_cost"] += fab_cost
        g["total_install_cost"] += field_cost

        grand["item_count"] += 1
        grand["total_weight"] += weight
        grand["total_length"] += length
        grand["total_material_cost"] += m_rate
        grand["total_fab_cost"] += fab_cost
        grand["total_install_cost"] += field_cost

    # Add total_cost to each group and round
    for g in list(groups.values()) + [grand]:
        g["total_cost"] = g["total_material_cost"] + g["total_fab_cost"] + g["total_install_cost"]
        for k in ("total_weight", "total_length", "total_material_cost",
                   "total_fab_cost", "total_install_cost", "total_cost"):
            g[k] = round(g[k], 2)

    # Sort groups by total_cost descending
    sorted_groups = dict(sorted(groups.items(), key=lambda x: x[1]["total_cost"], reverse=True))

    return {
        "model_id": mid,
        "group_by": group_by,
        "group_field": group_field,
        "group_count": len(sorted_groups),
        "groups": sorted_groups,
        "grand_total": grand,
    }
