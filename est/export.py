"""
EST Pipeline Exporter — generates estimate.json sidecar files from SQLite.

Replaces the Node.js estimate-merger.js by reading directly from the SQLite
database produced by the ETL pipeline. Output format is identical to what
estimate-merger.js produces: a flat JSON object keyed by ItemGloballyUniqueIDBase64
(the IFC GlobalId), with ancillaries keyed as "ANC::{job}::{index}".

The viewer (grid-manager.ts, heatmap-manager.ts, index.ts) consumes ~30 fields
from estimate.json. This exporter includes only those actively used fields,
reducing file size significantly compared to the full 141-column dump.

Usage:
    python est/export.py --job "LCK 064" --output path/to/model.estimate.json
    python est/export.py --job "LCK 064"  # prints to stdout
    python est/export.py --db path/to/estimates.db --job "LCK 064" --output out.json

Programmatic:
    from est.export import export_estimate_json
    data = export_estimate_json(db_path, job_file_name)
"""

import argparse
import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Default database path (same as etl.py convention)
DEFAULT_DB_PATH = Path(__file__).parent / "estimates.db"


# ── Viewer-consumed fields ──────────────────────────────────────────────────
# These are the ~30 fields actively used by the 3D viewer sidecar consumers:
#   - grid-manager.ts ALL_COLUMNS + GROUP_BY_CANDIDATES
#   - heatmap-manager.ts DISCRETE_FIELDS / continuous numeric fields
#   - index.ts filter groups
#   - bridge-client.ts product lookups (dbid, ServiceAbbr)
#
# SQLite column name → estimate.json field name (original CSV header name)

ITEM_FIELD_MAP = {
    # Identity
    "item_guid":          "ItemGloballyUniqueIDBase64",
    "item_handle":        "ItemHandle",
    "item_number":        "ItemNumber",
    "dbid":               "dbid",
    "cid":                "CID",
    # Categorization / grouping
    "drawing":            "Drawing",
    "section":            "Section",
    "zone1":              "Zone1",
    "equipment_name":     "EquipmentName",
    "spool":              "Spool",
    "service_abbr":       "ServiceAbbr",
    "service":            "Service",
    "service_type":       "ServiceType",
    # Product info
    "product_name":       "ProductName",
    "product_desc":       "ProductDescription",
    "product_size":       "ProductSize",
    "spec":               "Spec",
    "material":           "Material",
    "supplier":           "Supplier",
    "fitting_type":       "FittingType",
    "install_type":       "InstallType",
    "alternate":          "Alternate",
    "bought_out":         "BoughtOut",
    "gauge":              "Gauge",
    "end_size_1":         "EndSize1",
    "end_size_2":         "EndSize2",
    # Job metadata (job_name lives in jobs table, populated separately)
    "job_file_name":      "JobFileName",
    # Geometry / quantities
    "qty":                "Qty",
    "weight":             "Weight",
    "length":             "Length",
    "area":               "Area",
    # ProductInfo enrichment
    "harrison_code":      "HarrisonCode",
    # Cost fields
    "price_list_cost":    "ItemPriceListCost",
    "fab_cost":           "FabCost",
    "field_cost":         "FieldCost",
    "discount":           "Discount",
    "m_rate":             "M-Rate",
    # Time fields (seconds)
    "fab_time":           "FabTime",
    "install_time":       "InstallTime",
    "alt_fab_time":       "AltFabTime",
    "alt_field_time":     "AltFieldTime",
    # Status
    "status":             "Status",
}

# Ancillary fields: SQLite column → viewer field name
# Ancillaries are normalized to use standard viewer field names
# (same mapping as estimate-merger.js ANC_FIELD_MAP)
ANCILLARY_FIELD_MAP = {
    "ancillary_name":  "ProductDescription",
    "ancillary_type":  "FittingType",
    "data_name":       "ProductName",
    "install_time":    "InstallTime",
    "fab_time":        "FabTime",
    "material_cost":   "ItemPriceListCost",
    "length":          "Length",
    "weight":          "Weight",
    "qty":             "Qty",
    "level_1":         "Level 1",
    "level_2":         "Level 2",
    "level_3":         "Level 3",
    "level_4":         "Level 4",
    "alternate":       "Alternate",
    "job_file_name":   "JobFileName",
}


def _str(value) -> str:
    """Convert a database value to the string format the viewer expects.

    The viewer parses all values as strings from JSON. Numeric values become
    their string representation; None becomes empty string.
    """
    if value is None:
        return ""
    if isinstance(value, float):
        # Avoid unnecessary decimal places for whole numbers
        try:
            if value == int(value):
                return str(int(value))
        except (OverflowError, ValueError):
            pass
        return str(value)
    return str(value)


def _query_items(conn: sqlite3.Connection, job_file_name: str) -> list[dict]:
    """Query estimate_items for a job (both 'estimate' and 'tfc' source types)."""
    cols_sql = ", ".join(ITEM_FIELD_MAP.keys())
    sql = f"SELECT {cols_sql}, source_type FROM estimate_items WHERE job_file_name = ?"
    cur = conn.execute(sql, (job_file_name,))
    col_names = [d[0] for d in cur.description]
    return [dict(zip(col_names, row)) for row in cur.fetchall()]


def _query_ancillaries(conn: sqlite3.Connection, job_file_name: str) -> list[dict]:
    """Query ancillaries for a job."""
    cols = list(ANCILLARY_FIELD_MAP.keys())
    cols_sql = ", ".join(cols)
    sql = f"SELECT {cols_sql} FROM ancillaries WHERE job_file_name = ?"
    cur = conn.execute(sql, (job_file_name,))
    col_names = [d[0] for d in cur.description]
    return [dict(zip(col_names, row)) for row in cur.fetchall()]


def export_estimate_json(
    db_path: str,
    job_file_name: str,
) -> dict:
    """Export a job's estimate data as a viewer-compatible JSON dict.

    Args:
        db_path: Path to the SQLite estimates database.
        job_file_name: The JobFileName to export (e.g., "LCK 064").

    Returns:
        Dict keyed by GlobalId (items/TFC) or "ANC::{job}::{index}" (ancillaries),
        matching the exact format that estimate-merger.js produces.

    Raises:
        FileNotFoundError: If db_path doesn't exist.
        ValueError: If job_file_name not found in database.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        # Verify job exists
        row = conn.execute(
            "SELECT job_file_name, job_name FROM jobs WHERE job_file_name = ?",
            (job_file_name,),
        ).fetchone()
        if not row:
            available = [
                r[0] for r in conn.execute("SELECT job_file_name FROM jobs").fetchall()
            ]
            raise ValueError(
                f"Job '{job_file_name}' not found in database. "
                f"Available jobs: {available}"
            )

        job_name = row[1] or job_file_name

        result = {}
        summary = {"estimate": 0, "ancillaries": 0, "estimateTFC": 0, "total": 0}

        # ── Export estimate + TFC items ─────────────────────────────────────
        items = _query_items(conn, job_file_name)
        for idx, item in enumerate(items):
            source_type = item.pop("source_type", "estimate")

            # Map SQLite columns to viewer field names
            row = {}
            for sqlite_col, viewer_field in ITEM_FIELD_MAP.items():
                row[viewer_field] = _str(item.get(sqlite_col))
            row["JobName"] = _str(job_name)

            # ── WAM shop weld labor reallocation ──────────────────────────
            # Only SHOP WELD joints get labor reallocated from field to fab.
            # ProPress, threaded, solvent, soldered, brazed, ACR, bolt sets,
            # gaskets, and other field connections stay as-is.
            #
            # Component Method bakes joint hours into fitting/pipe InstallTime,
            # so shop weld joint items are REFERENCE -- their hours must be
            # deducted from field totals and added to fab totals to avoid
            # double-counting.
            #
            # Shop welds:  FabTime = +hours (shop), InstallTime = -hours (deduct)
            #              FabCost = FieldCost (moved), FieldCost = -FieldCost (deduct)
            # Non-shop:    FabTime = 0, InstallTime = as-is
            #
            # Spool total: TotalHours = sum(FabTime) + sum(InstallTime)
            #              The negatives cancel the double-count.
            #
            # Shop weld families in the source database (example IDs):
            #   MDSK_JOINT_000043 -- Carbon Steel Shop Weld - Standard
            #   MDSK_JOINT_000047 -- Stainless Steel 316L Orbital Weld
            #   MDSK_JOINT_000049 -- Stainless Steel 304L Shop Weld - Standard
            #   MDSK_JOINT_000128 -- Stainless Steel 304L Shop Weld - Schedule 10S
            #
            # TODO: Replace hardcoded string matching with user-configurable
            # shop weld classification. See est/backlog.md "Configurable Shop
            # Weld Classification" for details.
            dbid_val = row.get("dbid", "")
            supplier_val = row.get("Supplier", "")
            product_desc_val = row.get("ProductDescription", "")
            is_joint = "_JOINT_" in dbid_val or supplier_val == "(Joints)"
            desc_lower = product_desc_val.lower()
            is_shop_weld = is_joint and (
                "shop weld" in desc_lower or "orbital weld" in desc_lower
            )
            if is_shop_weld:
                install = row.get("InstallTime", "0")
                field_cost = row.get("FieldCost", "0")
                try:
                    install_f = float(install) if install else 0.0
                except (ValueError, TypeError):
                    install_f = 0.0
                try:
                    field_cost_f = float(field_cost) if field_cost else 0.0
                except (ValueError, TypeError):
                    field_cost_f = 0.0
                # Hours: positive fab (shop), negative install (deduct)
                row["FabTime"] = _str(install_f)
                row["InstallTime"] = _str(-install_f)
                # Cost: FabCost = +FieldCost (shop), FieldCost = -FieldCost (deduct)
                row["FabCost"] = _str(field_cost_f)
                row["FieldCost"] = _str(-field_cost_f)
                row["_wamJointRealloc"] = "true"

            # Tag the source (viewer uses this to separate ancillaries)
            if source_type == "tfc":
                row["_estimateSource"] = "estimateTFC"
                summary["estimateTFC"] += 1
            else:
                row["_estimateSource"] = "estimate"
                summary["estimate"] += 1

            # Key by GlobalId
            guid = row.get("ItemGloballyUniqueIDBase64", "").strip()
            if guid:
                result[guid] = row
            else:
                # Fallback for items without GUID
                source_label = "estimateTFC" if source_type == "tfc" else "estimate"
                key = f"{source_label}::{row.get('dbid') or row.get('ItemHandle') or idx}"
                result[key] = row

        # ── Export ancillaries ──────────────────────────────────────────────
        anc_items = _query_ancillaries(conn, job_file_name)
        job_key = job_file_name.replace(" ", "_")[:40]

        for idx, anc in enumerate(anc_items):
            row = {}
            for sqlite_col, viewer_field in ANCILLARY_FIELD_MAP.items():
                row[viewer_field] = _str(anc.get(sqlite_col))

            # Standard ancillary defaults (matching estimate-merger.js)
            row["_estimateSource"] = "ancillaries"
            row["ServiceAbbr"] = "ANC"
            row["Service"] = row.get("FittingType") or row.get("AncillaryType", "") or "Ancillaries"
            row["Drawing"] = row.get("Level 2") or row.get("Level 1", "") or ""
            row["Spool"] = ""
            # Ensure aggregation fields exist
            for field in ("FieldCost", "FabCost", "FabTime", "InstallTime",
                          "Length", "Weight", "Qty"):
                if field not in row or row[field] == "":
                    row[field] = "0" if field != "Qty" else "1"

            result[f"ANC::{job_key}::{idx}"] = row
            summary["ancillaries"] += 1

        summary["total"] = summary["estimate"] + summary["ancillaries"] + summary["estimateTFC"]
        logger.info(
            "Exported %s: %d estimate, %d TFC, %d ancillaries (%d total)",
            job_file_name,
            summary["estimate"],
            summary["estimateTFC"],
            summary["ancillaries"],
            summary["total"],
        )
        return result

    finally:
        conn.close()


def export_to_file(
    db_path: str,
    job_file_name: str,
    output_path: str,
    indent: Optional[int] = None,
) -> dict:
    """Export estimate JSON to a file.

    Args:
        db_path: Path to the SQLite estimates database.
        job_file_name: The JobFileName to export.
        output_path: Output file path (e.g., "model.estimate.json").
        indent: JSON indentation (None for compact, 2 for readable).

    Returns:
        Summary dict with counts and output path.
    """
    data = export_estimate_json(db_path, job_file_name)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False)

    # Count by source
    counts = {"estimate": 0, "ancillaries": 0, "estimateTFC": 0}
    for row in data.values():
        src = row.get("_estimateSource", "estimate")
        if src in counts:
            counts[src] += 1

    size_mb = output_path.stat().st_size / (1024 * 1024)
    return {
        "job_file_name": job_file_name,
        "output_path": str(output_path),
        "size_mb": round(size_mb, 2),
        "estimate_items": counts["estimate"],
        "tfc_items": counts["estimateTFC"],
        "ancillary_items": counts["ancillaries"],
        "total_items": len(data),
    }


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Export estimate.json sidecar from SQLite EST database."
    )
    parser.add_argument(
        "--job", required=True,
        help="JobFileName to export (e.g., 'LCK 064')",
    )
    parser.add_argument(
        "--db", default=str(DEFAULT_DB_PATH),
        help=f"Path to SQLite database (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--output", "-o",
        help="Output file path. If omitted, prints JSON to stdout.",
    )
    parser.add_argument(
        "--indent", type=int, default=None,
        help="JSON indentation level (default: compact)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable verbose logging",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="[est-export] %(message)s",
    )

    try:
        if args.output:
            result = export_to_file(args.db, args.job, args.output, args.indent)
            print(f"[est-export] Wrote {result['output_path']} "
                  f"({result['total_items']} items, {result['size_mb']} MB)")
            print(f"[est-export]   estimate: {result['estimate_items']}, "
                  f"TFC: {result['tfc_items']}, "
                  f"ancillaries: {result['ancillary_items']}")
        else:
            data = export_estimate_json(args.db, args.job)
            json.dump(data, sys.stdout, indent=args.indent, ensure_ascii=False)
            sys.stdout.write("\n")
    except FileNotFoundError as e:
        logger.error(str(e))
        sys.exit(1)
    except ValueError as e:
        logger.error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
