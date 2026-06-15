"""Data loaders — read CSV/SQLite files from disk into in-memory lists/dicts.

Imports: config only.
"""

import csv
from pathlib import Path
from typing import Optional

from fabrication_mcp.config import (
    PI_COLS, ITEM_DATA_COLS, _NA, _val,
    FAB_CONTENT_DIR, MAPPING_TOOLS_DIR,
    log,
)


def _latest_csv(directory: Path, pattern: str, exclude: str = "") -> Optional[Path]:
    """Return the most recently modified CSV matching the glob pattern."""
    matches = [
        p for p in directory.glob(pattern)
        if not exclude or exclude not in p.name
    ]
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)


def _load_product_info(
    directory: Path = None,
    pattern: str = "ProductInfo_*.csv",
    exclude: str = "DEMO",
) -> list[dict]:
    directory = directory or FAB_CONTENT_DIR
    path = _latest_csv(directory, pattern, exclude=exclude)
    if not path:
        log.warning(f"No ProductInfo CSV found in {directory}")
        return []
    log.info(f"Loading ProductInfo: {path.name}")
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader)  # skip header row
        for row in reader:
            if not row:
                continue
            record = {}
            for idx, key in PI_COLS.items():
                record[key] = _val(row[idx]) if idx < len(row) else None
            rows.append(record)
    log.info(f"Loaded {len(rows):,} ProductInfo rows")
    return rows


def _load_mapped_output(directory: Path = None) -> list[dict]:
    directory = directory or MAPPING_TOOLS_DIR
    path = _latest_csv(directory, "mapped_products_*.csv")
    if not path:
        log.warning(f"No mapped_products CSV found")
        return []
    log.info(f"Loading mapped output: {path.name}")
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({k: _val(v) for k, v in row.items()})
    log.info(f"Loaded {len(rows):,} mapped rows")
    return rows


def _load_item_data(
    directory: Optional[Path] = None,
    pattern: str = "*_ItemData_*.csv",
) -> list[dict]:
    """Load ItemData CSV export (service -> button -> item mapping)."""
    if directory is None:
        return []
    if not directory.exists():
        return []
    files = sorted(directory.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return []
    path = files[0]
    log.info(f"Loading ItemData from: {path.name}")
    rows: list[dict] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        for line in reader:
            r: dict[str, str] = {}
            for i, val in enumerate(line):
                col = ITEM_DATA_COLS.get(i)
                if col:
                    v = val.strip()
                    r[col] = v if v and v not in _NA else ""
            if r.get("service_name"):
                rows.append(r)
    log.info(f"Loaded {len(rows):,} item data rows from {path.name}")
    return rows
