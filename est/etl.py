"""
EST Pipeline ETL — loads parsed estimate data into SQLite.

Idempotent: re-loading a job replaces its data (DELETE + INSERT within
a transaction). The etl_runs table logs every execution.

Usage:
    from est.etl import EstDatabase
    db = EstDatabase("path/to/estimates.db")
    db.load_job("path/to/estimate.txt")
    db.load_job("path/to/estimate.txt",
                ancillaries="path/to/ancillaries.txt",
                tfc="path/to/estimateTFC.txt")
"""

import sqlite3
from pathlib import Path
from typing import Optional

from .parser import parse_estimate, parse_ancillaries, parse_hub_ancillaries, parse_tfc


SCHEMA_PATH = Path(__file__).parent / "schema.sql"


class EstDatabase:
    """SQLite-backed estimate database."""

    def __init__(self, db_path: str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    def _init_schema(self) -> None:
        """Create tables if they don't exist, migrate existing ones."""
        schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
        self._conn.executescript(schema_sql)
        self._migrate_schema()

    def _migrate_schema(self) -> None:
        """Add columns that may be missing from pre-existing databases."""
        existing = {row[1] for row in self._conn.execute("PRAGMA table_info(estimate_items)")}
        if "harrison_code" not in existing:
            self._conn.execute("ALTER TABLE estimate_items ADD COLUMN harrison_code TEXT")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_items_harrison ON estimate_items(harrison_code)")
            self._conn.commit()

        anc_cols = {row[1] for row in self._conn.execute("PRAGMA table_info(ancillaries)")}
        new_anc_cols = [
            ("parent_item_guid", "TEXT"),
            ("parent_dbid", "TEXT"),
            ("spool", "TEXT"),
        ]
        added = False
        for col_name, col_type in new_anc_cols:
            if col_name not in anc_cols:
                self._conn.execute(f"ALTER TABLE ancillaries ADD COLUMN {col_name} {col_type}")
                added = True
        if added:
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_anc_parent_guid ON ancillaries(parent_item_guid)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_anc_parent_dbid ON ancillaries(parent_dbid)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_anc_spool ON ancillaries(job_file_name, spool)")
            self._conn.commit()

    def health_check(self) -> bool:
        """Verify the database connection is alive."""
        try:
            self._conn.execute("SELECT 1")
            return True
        except (sqlite3.Error, AttributeError):
            return False

    def checkpoint(self) -> None:
        """Force a WAL checkpoint to truncate the write-ahead log."""
        try:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass

    def close(self) -> None:
        self.checkpoint()
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def load_job(
        self,
        estimate_path: str,
        ancillaries_path: Optional[str] = None,
        hub_ancillaries_path: Optional[str] = None,
        tfc_path: Optional[str] = None,
    ) -> dict:
        """Load a job's estimate data into the database.

        Idempotent: if the job already exists, its data is replaced.

        Args:
            estimate_path: Path to the main estimate.txt file
            ancillaries_path: Optional path to legacy ancillaries.txt
            hub_ancillaries_path: Optional path to hub_ancillaries.txt (preferred — has parent GUID)
            tfc_path: Optional path to estimateTFC.txt

        Returns:
            dict with load statistics
        """
        estimate_path = str(Path(estimate_path).resolve())

        # Parse estimate file
        items, job_info = parse_estimate(estimate_path)
        job_file_name = job_info.get("job_file_name")
        if not job_file_name:
            raise ValueError(f"No JobFileName found in {estimate_path}")

        # Parse ancillaries — prefer hub format (has parent GUID) over legacy
        anc_items = []
        if hub_ancillaries_path and Path(hub_ancillaries_path).exists():
            anc_items = parse_hub_ancillaries(hub_ancillaries_path)
        elif ancillaries_path and Path(ancillaries_path).exists():
            anc_items = parse_ancillaries(ancillaries_path)

        # Parse TFC if provided
        tfc_items = []
        if tfc_path and Path(tfc_path).exists():
            tfc_items, _ = parse_tfc(tfc_path)

        # Load into database (atomic transaction)
        with self._conn:
            # Delete existing data for this job (idempotent reload)
            self._conn.execute("DELETE FROM estimate_items WHERE job_file_name = ?", (job_file_name,))
            self._conn.execute("DELETE FROM ancillaries WHERE job_file_name = ?", (job_file_name,))
            self._conn.execute("DELETE FROM jobs WHERE job_file_name = ?", (job_file_name,))

            # Insert job record
            job_record = {
                "job_file_name": job_file_name,
                "job_ref": job_info.get("job_ref"),
                "batched_job_file_name": job_info.get("batched_job_file_name"),
                "job_name": job_info.get("job_name"),
                "estimate_no": job_info.get("estimate_no"),
                "job_date": job_info.get("job_date"),
                "job_type": job_info.get("job_type"),
                "schedule_type": job_info.get("schedule_type"),
                "company": job_info.get("company"),
                "customer": job_info.get("customer"),
                "general_contractor": job_info.get("general_contractor"),
                "project_level_1": job_info.get("project_level_1"),
                "project_level_2": job_info.get("project_level_2"),
                "project_level_3": job_info.get("project_level_3"),
                "project_level_4": job_info.get("project_level_4"),
                "source_file": estimate_path,
            }
            cols = list(job_record.keys())
            placeholders = ", ".join(["?"] * len(cols))
            self._conn.execute(
                f"INSERT INTO jobs ({', '.join(cols)}) VALUES ({placeholders})",
                [job_record[c] for c in cols],
            )

            # Insert estimate items
            item_count = self._insert_items(items)

            # Insert TFC items
            tfc_count = self._insert_items(tfc_items)

            # Insert ancillaries
            anc_count = self._insert_ancillaries(anc_items, job_file_name)

            # Log ETL run
            self._conn.execute(
                "INSERT INTO etl_runs (source_file, job_file_name, items_loaded, ancillaries_loaded, tfc_loaded) "
                "VALUES (?, ?, ?, ?, ?)",
                (estimate_path, job_file_name, item_count, anc_count, tfc_count),
            )

        result = {
            "job_file_name": job_file_name,
            "job_name": job_info.get("job_name"),
            "items_loaded": item_count,
            "ancillaries_loaded": anc_count,
            "tfc_loaded": tfc_count,
            "db_path": str(self.db_path),
        }
        print(f"[est-etl] Loaded {job_file_name}: {item_count} items, {anc_count} ancillaries, {tfc_count} TFC")
        return result

    def _insert_items(self, items: list[dict]) -> int:
        """Insert estimate items. Returns count inserted."""
        if not items:
            return 0

        # Get column names from first item (all items have same keys)
        cols = list(items[0].keys())
        placeholders = ", ".join(["?"] * len(cols))
        sql = f"INSERT INTO estimate_items ({', '.join(cols)}) VALUES ({placeholders})"

        rows = [[item.get(c) for c in cols] for item in items]
        self._conn.executemany(sql, rows)
        return len(rows)

    def _insert_ancillaries(self, items: list[dict], job_file_name: str) -> int:
        """Insert ancillary items. Returns count inserted."""
        if not items:
            return 0

        # Always override job_file_name to match the parent job
        # (ancillaries often have "BatchedMAJ's" or other generic names)
        for item in items:
            item["job_file_name"] = job_file_name

        cols = list(items[0].keys())
        placeholders = ", ".join(["?"] * len(cols))
        sql = f"INSERT INTO ancillaries ({', '.join(cols)}) VALUES ({placeholders})"

        rows = [[item.get(c) for c in cols] for item in items]
        self._conn.executemany(sql, rows)
        return len(rows)

    def enrich_harrison_codes(self, pi_lookup: dict) -> dict:
        """Enrich estimate_items with harrison_code from ProductInfo cache.

        Called after load_job() with the server's _pi_by_id dict, which maps
        dbid (DatabaseId) -> full ProductInfo record including harrison_code.

        Args:
            pi_lookup: dict mapping dbid -> ProductInfo record dict.
                       Each record has at minimum: {"harrison_code": str|None, ...}

        Returns:
            dict with enrichment stats: {"matched": int, "total": int}
        """
        rows = self._conn.execute(
            "SELECT DISTINCT dbid FROM estimate_items "
            "WHERE dbid IS NOT NULL AND harrison_code IS NULL"
        ).fetchall()
        total = len(rows)

        updates = []
        for (dbid,) in rows:
            pi = pi_lookup.get(dbid)
            if not pi:
                continue
            hc = pi.get("harrison_code")
            # N/A is not a valid value — treat as null
            if hc and hc != "N/A":
                updates.append((hc, dbid))

        if updates:
            with self._conn:
                self._conn.executemany(
                    "UPDATE estimate_items SET harrison_code = ? WHERE dbid = ?",
                    updates,
                )

        return {"matched": len(updates), "total": total}

    def get_jobs(self) -> list[dict]:
        """List all loaded jobs."""
        cur = self._conn.execute(
            "SELECT j.*, "
            "  (SELECT COUNT(*) FROM estimate_items e WHERE e.job_file_name = j.job_file_name AND e.source_type = 'estimate') AS item_count, "
            "  (SELECT COUNT(*) FROM estimate_items e WHERE e.job_file_name = j.job_file_name AND e.source_type = 'tfc') AS tfc_count, "
            "  (SELECT COUNT(*) FROM ancillaries a WHERE a.job_file_name = j.job_file_name) AS anc_count "
            "FROM jobs j ORDER BY j.imported_at DESC"
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        """Run a read-only SQL query and return results as dicts."""
        cur = self._conn.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def get_job_summary(self, job_file_name: str) -> list[dict]:
        """Get cost summary by service for a job."""
        return self.query(
            "SELECT * FROM v_job_service_summary WHERE job_file_name = ?",
            (job_file_name,),
        )

    def get_price_gaps(self, job_file_name: str = None) -> list[dict]:
        """Get items with missing or zero costs."""
        if job_file_name:
            return self.query(
                "SELECT * FROM v_price_gaps WHERE job_file_name = ? LIMIT 100",
                (job_file_name,),
            )
        return self.query("SELECT * FROM v_price_gaps LIMIT 100")

    def get_status_timeline(self, job_file_name: str = None) -> list[dict]:
        """Get status progression for items with status history."""
        if job_file_name:
            return self.query(
                "SELECT * FROM v_status_timeline WHERE job_file_name = ?",
                (job_file_name,),
            )
        return self.query("SELECT * FROM v_status_timeline LIMIT 500")

    def get_spool_summary(self, job_file_name: str = None, spool: str = None) -> list[dict]:
        """Get cost/labor aggregation by spool."""
        if job_file_name and spool:
            return self.query(
                "SELECT * FROM v_spool_summary WHERE job_file_name = ? AND spool = ?",
                (job_file_name, spool),
            )
        if job_file_name:
            return self.query(
                "SELECT * FROM v_spool_summary WHERE job_file_name = ?",
                (job_file_name,),
            )
        return self.query("SELECT * FROM v_spool_summary LIMIT 500")

    def get_material_takeoff(
        self,
        job_file_name: str = None,
        service: str = None,
        material: str = None,
    ) -> list[dict]:
        """Get BOM-style material takeoff grouped by product/material/size."""
        conditions = []
        params = []
        if job_file_name:
            conditions.append("job_file_name = ?")
            params.append(job_file_name)
        if service:
            conditions.append("service = ?")
            params.append(service)
        if material:
            conditions.append("material = ?")
            params.append(material)

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        return self.query(
            f"SELECT * FROM v_material_takeoff{where} LIMIT 500",
            tuple(params),
        )

    def get_ancillary_summary(self, job_file_name: str = None) -> list[dict]:
        """Get ancillary costs grouped by type."""
        if job_file_name:
            return self.query(
                "SELECT * FROM v_ancillary_summary WHERE job_file_name = ?",
                (job_file_name,),
            )
        return self.query("SELECT * FROM v_ancillary_summary LIMIT 500")
