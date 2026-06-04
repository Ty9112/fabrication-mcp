"""EST pipeline tools -- 9 tools for SQLite-backed estimate database.

Security fixes applied during extraction:
1. est_query: read-only SQLite connection, generic error messages
2. est_load_job: path confinement check, relative path in errors
3. est_query: placeholder count validation
4. bridge.py bare exception: already fixed in bridge.py extraction
"""

import atexit
import os
import sqlite3
from pathlib import Path
from typing import Optional

from fabrication_mcp import mcp
from fabrication_mcp.config import DATA_ROOT, log
from fabrication_mcp.cache import _products_by_id
from fabrication_mcp.mutation_policy import guard

_est_db_path: Optional[str] = None
_est_db_instance = None


def _est_db() -> "EstDatabase":
    """Get or create the EST database instance (singleton).

    Validates the cached instance is still healthy before returning it.
    If the connection is dead or the DB file was deleted, recreates it.
    """
    global _est_db_path, _est_db_instance

    if _est_db_instance is not None:
        # Health check: verify connection is alive and DB file still exists
        db_path = Path(_est_db_path) if _est_db_path else None
        if db_path and not db_path.exists():
            log.warning("EST database file deleted -- recreating singleton")
            try:
                _est_db_instance.close()
            except Exception:
                pass
            _est_db_instance = None
        elif not _est_db_instance.health_check():
            log.warning("EST database connection unhealthy -- recreating singleton")
            try:
                _est_db_instance.close()
            except Exception:
                pass
            _est_db_instance = None

    if _est_db_instance is not None:
        return _est_db_instance

    if _est_db_path is None:
        _est_db_path = str(Path(__file__).resolve().parent.parent.parent / "est" / "estimates.db")

    from est.etl import EstDatabase
    _est_db_instance = EstDatabase(_est_db_path)
    return _est_db_instance


def _est_db_cleanup() -> None:
    """Close the EST database singleton on server shutdown."""
    global _est_db_instance
    if _est_db_instance is not None:
        try:
            _est_db_instance.close()
            log.info("EST database connection closed on shutdown")
        except Exception:
            pass
        _est_db_instance = None


atexit.register(_est_db_cleanup)


# -- Path constants ------------------------------------------------------------

_EXPORTS_DIR = Path(os.environ.get("FABRICATION_EXPORTS_DIR", str(DATA_ROOT / "exports")))


def _est_resolve_companions(file_stem: str) -> dict:
    """Resolve ancillaries and TFC companion files for a given file stem.

    Checks both the exact stem and a WET2_0_ prefixed variant.
    Prefers hub_ancillaries (has parent GUID) over legacy ancillaries.
    """
    stems = [file_stem]
    if not file_stem.startswith("WET2_0_"):
        stems.append(f"WET2_0_{file_stem}")

    hub_anc = None
    legacy_anc = None
    tfc = None

    for stem in stems:
        candidate = _EXPORTS_DIR / f"hub_ancillaries_{stem}.txt"
        if not hub_anc and candidate.exists():
            hub_anc = str(candidate)
        candidate = _EXPORTS_DIR / f"ancillaries_{stem}.txt"
        if not legacy_anc and candidate.exists():
            legacy_anc = str(candidate)
        candidate = _EXPORTS_DIR / f"estimateTFC_{stem}.txt"
        if not tfc and candidate.exists():
            tfc = str(candidate)

    return {
        "hub_ancillaries": hub_anc,
        "ancillaries": legacy_anc,
        "tfc": tfc,
    }


def _est_resolve_exports(job_file_name: str) -> dict:
    """Resolve the estimate + companion files for a job in PROJECTS/Exports."""
    estimate_path = _EXPORTS_DIR / f"{job_file_name}.txt"
    if not estimate_path.exists():
        estimate_path = _EXPORTS_DIR / f"WET2_0_{job_file_name}.txt"

    companions = _est_resolve_companions(job_file_name)
    return {
        "estimate": str(estimate_path) if estimate_path.exists() else None,
        **companions,
    }


@mcp.tool()
def est_load_job(
    job_file_name: str = "",
    estimate_path: str = "",
    dry_run: bool = False,
) -> dict:
    """
    Load estimate data from ESTmep export files into the SQLite database.

    Provide EITHER job_file_name (auto-resolves files from PROJECTS/Exports/) OR
    estimate_path (explicit path to estimate.txt). Loading is idempotent -- reloading
    a job replaces its previous data. Pass dry_run=true to preview without loading.

    Args:
        job_file_name: e.g. "SAMPLE-JOB-MP_PL_R24_batched.20260220" -- auto-resolves
                       estimate, ancillaries, and TFC files from PROJECTS/Exports/
        estimate_path: Explicit path to an estimate.txt file (overrides job_file_name)
        dry_run: preview which files would be loaded without writing the database

    Returns load statistics: items_loaded, ancillaries_loaded, tfc_loaded, db_path.
    """
    if not job_file_name and not estimate_path:
        return {"error": "Provide either job_file_name or estimate_path."}

    verdict = guard("est_load_job", dry_run=dry_run,
                    detail={"job_file_name": job_file_name, "estimate_path": estimate_path})
    if verdict is not None:
        return verdict

    try:
        db = _est_db()
        try:
            pi_lookup = _products_by_id()
        except Exception:
            pi_lookup = {}

        if estimate_path:
            ep = Path(estimate_path)
            # Audit log, NOT a confinement gate: estimate_path is a caller-provided
            # explicit path by design (the documented "load from anywhere" mode), so the
            # load below proceeds regardless. We only note when it's outside the standard
            # exports dir. relative_to gives an accurate boundary test — str.startswith
            # would wrongly treat ".../exports-evil" as inside ".../exports".
            try:
                ep.resolve().relative_to(_EXPORTS_DIR.resolve())
            except ValueError:
                log.info(f"Loading EST job from non-standard path: {ep.name}")
            except OSError:
                pass
            if not ep.exists():
                return {"error": f"File not found: {ep.name}"}
            companions = _est_resolve_companions(ep.stem)
            result = db.load_job(
                str(ep),
                ancillaries_path=companions["ancillaries"],
                hub_ancillaries_path=companions["hub_ancillaries"],
                tfc_path=companions["tfc"],
            )
            try:
                enrichment = db.enrich_harrison_codes(pi_lookup)
                result["harrison_enrichment"] = enrichment
            except Exception as e:
                log.warning(f"Harrison enrichment failed: {e}")
            return result

        paths = _est_resolve_exports(job_file_name)
        if not paths["estimate"]:
            return {
                "error": f"Estimate file not found for '{job_file_name}'",
                "searched": f"PROJECTS/Exports/{job_file_name}.txt",
            }

        result = db.load_job(
            paths["estimate"],
            ancillaries_path=paths["ancillaries"],
            hub_ancillaries_path=paths["hub_ancillaries"],
            tfc_path=paths["tfc"],
        )
        try:
            enrichment = db.enrich_harrison_codes(pi_lookup)
            result["harrison_enrichment"] = enrichment
        except Exception as e:
            log.warning(f"Harrison enrichment failed: {e}")
        return result
    except ValueError as e:
        log.warning(f"EST load_job validation error: {e}")
        return {"error": f"Validation error: {e}"}
    except sqlite3.Error as e:
        log.warning(f"EST load_job database error: {e}")
        return {"error": "Database error -- EST database may be corrupted or locked."}


@mcp.tool()
def est_list_jobs() -> dict:
    """
    List all jobs loaded in the EST SQLite database.

    Returns each job's file name, display name, item count, ancillary count,
    TFC count, and import timestamp.
    """
    try:
        db = _est_db()
        jobs = db.get_jobs()
        return {
            "job_count": len(jobs),
            "jobs": jobs,
            "db_path": str(db.db_path),
        }
    except (sqlite3.Error, ValueError) as e:
        log.warning(f"EST list_jobs error: {e}")
        return {"error": "Failed to list jobs -- database may be unavailable."}


@mcp.tool()
def est_job_summary(job_file_name: str) -> dict:
    """
    Get cost and labor summary for a job, grouped by service.

    Shows per-service: item_count, total_material, total_fab_cost, total_field_cost,
    total_cost, total_weight, fab_hours, install_hours.

    Sorted by total_cost descending.
    """
    try:
        db = _est_db()
        summary = db.get_job_summary(job_file_name)
        if not summary:
            return {"error": f"No data found for job '{job_file_name}'. Run est_load_job first."}
        return {
            "job_file_name": job_file_name,
            "service_count": len(summary),
            "services": summary,
        }
    except (sqlite3.Error, ValueError) as e:
        log.warning(f"EST job_summary error: {e}")
        return {"error": "Failed to get job summary -- database may be unavailable."}


@mcp.tool()
def est_price_gaps(job_file_name: str = "") -> dict:
    """
    Find estimate items with missing or zero costs (material, fab, or field cost).

    These represent pricing gaps that need attention -- items where ESTmep couldn't
    resolve the cost from the price list, or where no price list entry exists.

    Args:
        job_file_name: Optional -- filter to a specific job. If empty, checks all jobs.

    Returns up to 100 items with gap details.
    """
    try:
        db = _est_db()
        gaps = db.get_price_gaps(job_file_name or None)
        return {
            "gap_count": len(gaps),
            "items": gaps,
            "note": "Items with NULL or 0 in price_list_cost, fab_cost, or field_cost.",
        }
    except (sqlite3.Error, ValueError) as e:
        log.warning(f"EST price_gaps error: {e}")
        return {"error": "Failed to get price gaps -- database may be unavailable."}


@mcp.tool()
def est_query(sql: str, job_file_name: str = "") -> dict:
    """
    Run a read-only SQL query against the EST SQLite database.

    Available tables: jobs, estimate_items, ancillaries, etl_runs.
    Available views: v_job_service_summary, v_tfc_items, v_price_gaps,
    v_status_timeline, v_spool_summary, v_material_takeoff, v_ancillary_summary.

    Common patterns:
    - SELECT service, COUNT(*) AS n, SUM(price_list_cost) AS material FROM estimate_items WHERE job_file_name = ? GROUP BY service
    - SELECT * FROM v_tfc_items WHERE job_file_name = ? AND equipment_name LIKE '%AHU%'
    - SELECT * FROM ancillaries WHERE job_file_name = ? AND ancillary_type = 'Support Rods'

    Args:
        sql: SQL query (SELECT only). Use ? placeholder for job_file_name parameter.
        job_file_name: Value for ? placeholder (if used in query).
    """
    if not sql.strip().upper().startswith("SELECT"):
        return {"error": "Only SELECT queries are allowed."}

    # Security: validate placeholder count -- only job_file_name is bindable
    placeholder_count = sql.count("?")
    if placeholder_count > 1:
        return {"error": f"Query has {placeholder_count} placeholders but only 1 parameter (job_file_name) is supported. Use exactly one ? placeholder."}
    if job_file_name:
        params = (job_file_name,) if placeholder_count == 1 else ()
    else:
        if placeholder_count > 0:
            return {"error": f"Query has {placeholder_count} placeholder(s) but no job_file_name provided."}
        params = ()

    db = _est_db()
    try:
        results = db.query(sql, params)
        return {
            "row_count": len(results),
            "rows": results[:500],
            "truncated": len(results) > 500,
        }
    except (sqlite3.Error, ValueError) as e:
        # Security: log full error, return generic message
        log.warning(f"EST query error: {e}")
        return {"error": "Query failed -- check SQL syntax and available tables/columns."}


@mcp.tool()
def est_status_timeline(job_file_name: str = "") -> dict:
    """
    Query item status history for cross-platform tracking (CMiC/Stratus integration).

    Shows each item's current status, previous statuses, and their dates -- the full
    status progression chain. Only items with at least one status value are returned.

    Args:
        job_file_name: Optional -- filter to a specific job. If empty, returns all (limit 500).

    Returns items with: current_status, current_status_date, previous_status_1/2 and dates.
    """
    try:
        db = _est_db()
        items = db.get_status_timeline(job_file_name or None)
        return {
            "item_count": len(items),
            "items": items,
        }
    except (sqlite3.Error, ValueError) as e:
        log.warning(f"EST status_timeline error: {e}")
        return {"error": "Failed to get status timeline -- database may be unavailable."}


@mcp.tool()
def est_spool_analysis(
    job_file_name: str = "",
    spool: str = "",
) -> dict:
    """
    Analyze cost and labor data aggregated by spool -- bridges to Stratus spool tracking.

    Shows per-spool: item_count, total_material, total_fab_cost, total_field_cost,
    total_weight, fab_hours, install_hours, and status breakdown.

    Args:
        job_file_name: Optional -- filter to a specific job.
        spool: Optional -- filter to a specific spool name.

    Only items with a spool name assigned are included.
    """
    try:
        db = _est_db()
        spools = db.get_spool_summary(
            job_file_name=job_file_name or None,
            spool=spool or None,
        )
        return {
            "spool_count": len(spools),
            "spools": spools,
        }
    except (sqlite3.Error, ValueError) as e:
        log.warning(f"EST spool_analysis error: {e}")
        return {"error": "Failed to get spool analysis -- database may be unavailable."}


@mcp.tool()
def est_material_takeoff(
    job_file_name: str = "",
    service: str = "",
    material: str = "",
) -> dict:
    """
    Generate a BOM-style material takeoff grouped by product name, material, and size.

    Shows quantities, total cost, total weight per product line -- useful for
    generating material purchase lists and vendor quotes.

    Args:
        job_file_name: Optional -- filter to a specific job.
        service: Optional -- filter to a specific service (e.g. "CHW Supply").
        material: Optional -- filter to a specific material (e.g. "Carbon Steel").

    Returns up to 500 product line items sorted by total cost descending.
    """
    try:
        db = _est_db()
        items = db.get_material_takeoff(
            job_file_name=job_file_name or None,
            service=service or None,
            material=material or None,
        )
        return {
            "line_count": len(items),
            "items": items,
        }
    except (sqlite3.Error, ValueError) as e:
        log.warning(f"EST material_takeoff error: {e}")
        return {"error": "Failed to get material takeoff -- database may be unavailable."}


@mcp.tool()
def est_list_exports() -> dict:
    """
    List available ESTmep export files in PROJECTS/Exports/ that can be loaded.

    Scans for estimate.txt files and shows which have matching ancillaries and TFC files.
    """
    try:
        if not _EXPORTS_DIR.exists():
            return {"error": f"Exports directory not found: {_EXPORTS_DIR}"}

        files = list(_EXPORTS_DIR.glob("*.txt"))
        # Find estimate files (not ancillaries_ or estimateTFC_ or hub_ancillaries_)
        estimates = []
        for f in sorted(files):
            name = f.name
            if name.startswith(("ancillaries_", "estimateTFC_", "hub_ancillaries_")):
                continue
            if not name.endswith(".txt") or name.endswith(".TXT"):
                continue
            stem = f.stem
            companions = _est_resolve_companions(stem)
            size_mb = round(f.stat().st_size / 1024 / 1024, 1)
            estimates.append({
                "job_file_name": stem,
                "file": name,
                "size_mb": size_mb,
                "has_hub_ancillaries": companions["hub_ancillaries"] is not None,
                "has_ancillaries": companions["ancillaries"] is not None,
                "has_tfc": companions["tfc"] is not None,
            })

        return {
            "exports_dir": str(_EXPORTS_DIR),
            "estimate_count": len(estimates),
            "estimates": estimates,
        }
    except (OSError, ValueError) as e:
        log.warning(f"EST list_exports error: {e}")
        return {"error": "Failed to list exports -- check exports directory."}
