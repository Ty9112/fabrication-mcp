"""
EST Pipeline Parser — reads ESTmep estimate.txt, ancillaries.txt, estimateTFC.txt
and returns structured records ready for SQLite insertion.

The estimate.txt is a comma-delimited file with 141 columns and no quoting.
Values are plain text; empty fields are empty strings.
N/A is Fabrication's default empty placeholder — treated as null.

Usage:
    from est.parser import parse_estimate, parse_ancillaries, parse_tfc
    items, job_info = parse_estimate("path/to/estimate.txt")
"""

import csv
from pathlib import Path
from typing import Optional


def _val(s: str) -> Optional[str]:
    """Normalize a raw CSV value. Empty and N/A become None."""
    if s is None:
        return None
    s = s.strip()
    if not s or s == "N/A" or s == "n/a":
        return None
    return s


def _float(s: str) -> Optional[float]:
    """Parse a numeric value. Returns None for empty/non-numeric."""
    v = _val(s)
    if v is None:
        return None
    try:
        return float(v.replace(",", ""))
    except (ValueError, TypeError):
        return None


def _int(s: str) -> Optional[int]:
    """Parse an integer value. Returns None for empty/non-numeric."""
    v = _val(s)
    if v is None:
        return None
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None


# ── Column mapping: CSV header name → SQLite column name ────────────────────
# This maps the 141 estimate.txt columns to snake_case SQLite columns.
# Order matches the actual CSV header exactly.

ESTIMATE_COLUMNS = [
    ("JobRef", "job_ref"),
    ("JobProjectLevel 1", "project_level_1"),
    ("JobProjectLevel 2", "project_level_2"),
    ("JobProjectLevel 3", "project_level_3"),
    ("JobProjectLevel 4", "project_level_4"),
    ("JobFileName", "job_file_name"),
    ("ItemGloballyUniqueIDBase64", "item_guid"),
    ("ItemHandle", "item_handle"),
    ("ItemNumber", "item_number"),
    ("Drawing", "drawing"),
    ("Section", "section"),
    ("Zone1", "zone1"),
    ("EquipmentName", "equipment_name"),
    ("Spool", "spool"),
    ("ServiceAbbr", "service_abbr"),
    ("Service", "service"),
    ("ServiceType", "service_type"),
    ("ProductName", "product_name"),
    ("Spec", "spec"),
    ("ProductSpecification", "product_spec"),
    ("Material", "material"),
    ("Gauge", "gauge"),
    ("MaterialPlusGauge", "material_plus_gauge"),
    ("ProductMaterial", "product_material"),
    ("Supplier", "supplier"),
    ("Alternate", "alternate"),
    ("CF", "cf"),
    ("BoughtOut", "bought_out"),
    ("InsulationLocation", "insulation_location"),
    ("Doublewall", "doublewall"),
    ("FittingType", "fitting_type"),
    ("CutType", "cut_type"),
    ("CID", "cid"),
    ("InstallType", "install_type"),
    ("ProductDescription", "product_desc"),
    ("dbid", "dbid"),
    ("Status", "status"),
    ("ProductSize", "product_size"),
    ("ItemEndSize1Duct", "item_end_size_1_duct"),
    ("ItemEndSize1", "item_end_size_1"),
    ("ConnectorFabTime", "connector_fab_time"),
    ("EndSize1Duct (inch)", "end_size_1_duct_inch"),
    ("EndSize1", "end_size_1"),
    ("EndSize2", "end_size_2"),
    ("EndSize3", "end_size_3"),
    ("EndSize4", "end_size_4"),
    ("Width", "width"),
    ("Depth ", "depth"),  # note trailing space in actual header
    ("Width2", "width2"),
    ("Depth2", "depth2"),
    ("Width3", "width3"),
    ("Depth3", "depth3"),
    ("Width4", "width4"),
    ("Depth4", "depth4"),
    ("ConnectorWeight", "connector_weight"),
    ("SplitterFabTime", "splitter_fab_time"),
    ("StiffnerFabTime", "stiffner_fab_time"),
    ("SeamFabTime", "seam_fab_time"),
    ("SeamWeight", "seam_weight"),
    ("SealantFabTime", "sealant_fab_time"),
    ("SealantWeight", "sealant_weight"),
    ("STDPieceLength", "std_piece_length"),
    ("Angle", "angle"),
    ("FabSet1", "fab_set_1"),
    ("FabSet2", "fab_set_2"),
    ("FabSet3", "fab_set_3"),
    ("FabSet4", "fab_set_4"),
    ("FieldSet1", "field_set_1"),
    ("FieldSet2", "field_set_2"),
    ("InsulMaterialwGauge", "insul_material_w_gauge"),
    ("InsulMaterialName", "insul_material_name"),
    ("InsulGauge", "insul_gauge"),
    ("InsulationArea", "insulation_area"),
    ("InsulMaterial", "insul_material"),
    ("InsulFabTime", "insul_fab_time"),
    ("InsulFabCost", "insul_fab_cost"),
    ("InsulFieldTime", "insul_field_time"),
    ("InsulFieldCost", "insul_field_cost"),
    ("WrapMaterialCost", "wrap_material_cost"),
    ("WrapFabTime", "wrap_fab_time"),
    ("WrapFabCost", "wrap_fab_cost"),
    ("WrapFieldTime", "wrap_field_time"),
    ("WrapFieldCost", "wrap_field_cost"),
    ("DuctFacingName", "duct_facing_name"),
    ("FacingMaterialCost", "facing_material_cost"),
    ("FacingFabTime", "facing_fab_time"),
    ("FacingFabCost", "facing_fab_cost"),
    ("HangerWeight", "hanger_weight"),
    ("HangerQty", "hanger_qty"),
    ("HangerMtl", "hanger_mtl"),
    ("HangerFabLabor", "hanger_fab_labor"),
    ("SupportFabCost", "support_fab_cost"),
    ("HangerFieldLabor", "hanger_field_labor"),
    ("SupportInstallCost", "support_install_cost"),
    ("AirturnName", "airturn_name"),
    ("AirturnFabTime", "airturn_fab_time"),
    ("AirturnWeight", "airturn_weight"),
    ("BaseWeight", "base_weight"),
    ("Weight", "weight"),
    ("Volume", "volume"),
    ("Length", "length"),
    ("Qty", "qty"),
    ("Area", "area"),
    ("OuterLength", "outer_length"),
    ("BaseMaterial", "base_material"),
    ("ItemPriceListCost", "price_list_cost"),
    ("ItemPriceListWODiscount", "price_list_wo_disc"),
    ("Discount", "discount"),
    ("PriceListDate", "price_list_date"),
    ("M-Rate", "m_rate"),
    ("FabTime", "fab_time"),
    ("FabCost", "fab_cost"),
    ("InstallTime", "install_time"),
    ("FieldCost", "field_cost"),
    ("Rate", "rate"),
    ("AltFabTime", "alt_fab_time"),
    ("AltFieldTime", "alt_field_time"),
    ("Life Span", "life_span"),
    ("OperatingCost", "operating_cost"),
    ("DemoTime", "demo_time"),
    ("DemoCost", "demo_cost"),
    ("Company", "company"),
    ("Customer", "customer"),
    ("GeneralContractor", "general_contractor"),
    ("BatchedJobFileName", "batched_job_file_name"),
    ("JobName", "job_name"),
    ("JobDate", "job_date"),
    ("JobType", "job_type"),
    ("ScheduleType", "schedule_type"),
    ("EstimateNo", "estimate_no"),
    ("FieldUnitLaborCode", "field_unit_labor_code"),
    ("MaterialCostCode", "material_cost_code"),
    ("ShopUnitLaborCode", "shop_unit_labor_code"),
    ("SystemDate", "system_date"),
    ("InsulSpec", "insul_spec"),
    ("S1", "s1"),
    ("CurrentStatusDate", "current_status_date"),
    ("PreviousStatus1", "previous_status_1"),
    ("PreviousStatusDate1", "previous_status_date_1"),
    ("PreviousStatus2", "previous_status_2"),
    ("PreviousStatusDate2", "previous_status_date_2"),
]

# Columns that should be parsed as floats
_FLOAT_COLS = {
    "connector_fab_time", "connector_weight", "splitter_fab_time",
    "stiffner_fab_time", "seam_fab_time", "seam_weight",
    "sealant_fab_time", "sealant_weight", "std_piece_length", "angle",
    "fab_set_1", "fab_set_2", "fab_set_3", "fab_set_4",
    "field_set_1", "field_set_2",
    "insulation_area", "insul_fab_time", "insul_fab_cost",
    "insul_field_time", "insul_field_cost",
    "wrap_material_cost", "wrap_fab_time", "wrap_fab_cost",
    "wrap_field_time", "wrap_field_cost",
    "facing_material_cost", "facing_fab_time", "facing_fab_cost",
    "hanger_weight", "hanger_qty", "hanger_mtl", "hanger_fab_labor",
    "support_fab_cost", "hanger_field_labor", "support_install_cost",
    "airturn_fab_time", "airturn_weight",
    "base_weight", "weight", "volume", "length", "qty", "area",
    "outer_length",
    "price_list_cost", "price_list_wo_disc", "m_rate",
    "fab_time", "fab_cost", "install_time", "field_cost", "rate",
    "alt_fab_time", "alt_field_time",
    "life_span", "operating_cost", "demo_time", "demo_cost",
    "width", "depth", "width2", "depth2", "width3", "depth3",
    "width4", "depth4",
}

# Columns that should be parsed as ints
_INT_COLS: set[str] = set()

# Job-level columns (extracted once per file, not per row)
_JOB_COLS = {
    "job_ref", "project_level_1", "project_level_2", "project_level_3",
    "project_level_4", "job_file_name", "batched_job_file_name",
    "job_name", "job_date", "job_type", "schedule_type", "estimate_no",
    "company", "customer", "general_contractor",
}

# Item-level columns (everything not in _JOB_COLS)
_ITEM_COLS = [col for _, col in ESTIMATE_COLUMNS if col not in _JOB_COLS]


def parse_estimate(filepath: str, source_type: str = "estimate") -> tuple[list[dict], dict]:
    """Parse an estimate.txt or estimateTFC.txt file.

    Returns:
        (items, job_info) where items is a list of item dicts and
        job_info is a dict of job-level fields.
    """
    filepath = Path(filepath)
    if not filepath.exists():
        raise FileNotFoundError(f"Estimate file not found: {filepath}")

    items = []
    job_info = {}

    with open(filepath, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)

        # Build column index: header position → (csv_name, sqlite_name)
        col_map = _build_column_map(header)

        for row_num, row in enumerate(reader, start=2):
            if len(row) < 6:
                continue  # skip malformed rows

            record = {}
            for idx, (csv_name, sqlite_name) in col_map.items():
                if idx >= len(row):
                    continue
                raw = row[idx]
                if sqlite_name in _FLOAT_COLS:
                    record[sqlite_name] = _float(raw)
                elif sqlite_name in _INT_COLS:
                    record[sqlite_name] = _int(raw)
                else:
                    record[sqlite_name] = _val(raw)

            # Extract job info from first data row
            if not job_info:
                for col in _JOB_COLS:
                    if col in record:
                        job_info[col] = record[col]

            # Only keep item-level columns in the item record
            item = {col: record.get(col) for col in _ITEM_COLS}
            item["job_file_name"] = record.get("job_file_name")
            item["source_type"] = source_type
            items.append(item)

    return items, job_info


def _build_column_map(header: list[str]) -> dict[int, tuple[str, str]]:
    """Build a map from header position to (csv_name, sqlite_name).

    Handles the case where the actual header may have slight differences
    (trailing spaces, case differences) from our expected column list.
    """
    # Build lookup: normalized header name → (csv_name, sqlite_name)
    expected = {}
    for csv_name, sqlite_name in ESTIMATE_COLUMNS:
        expected[csv_name.strip().lower()] = (csv_name, sqlite_name)

    col_map = {}
    for idx, h in enumerate(header):
        key = h.strip().lower()
        if key in expected:
            col_map[idx] = expected[key]

    return col_map


# ── Ancillaries parser ──────────────────────────────────────────────────────

ANCILLARY_COLUMNS = [
    ("Ref", None),  # skip — always empty or same as job ref
    ("Level 1", "level_1"),
    ("Level 2", "level_2"),
    ("Level 3", "level_3"),
    ("Level 4", "level_4"),
    ("AncillaryMaterialCost", "material_cost"),
    ("AncillaryFabTime", "fab_time"),
    ("AncillaryInstallTime", "install_time"),
    ("Alternate", "alternate"),
    ("Data Name", "data_name"),
    ("AncillaryLength", "length"),
    ("AncillaryName", "ancillary_name"),
    ("AncillaryQty", "qty"),
    ("AncillaryType", "ancillary_type"),
    ("AncillaryWeight", "weight"),
    ("JobFileName", "job_file_name"),
    ("JobName", "job_name"),
    ("SystemDate", "system_date"),
]

_ANC_FLOAT_COLS = {"material_cost", "fab_time", "install_time", "length", "qty", "weight"}


def parse_ancillaries(filepath: str) -> list[dict]:
    """Parse an ancillaries.txt file.

    Returns a list of ancillary item dicts.
    """
    filepath = Path(filepath)
    if not filepath.exists():
        raise FileNotFoundError(f"Ancillaries file not found: {filepath}")

    items = []
    with open(filepath, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)

        # Build column map
        expected = {}
        for csv_name, sqlite_name in ANCILLARY_COLUMNS:
            if sqlite_name:
                expected[csv_name.strip().lower()] = sqlite_name

        col_map = {}
        for idx, h in enumerate(header):
            key = h.strip().lower()
            if key in expected:
                col_map[idx] = expected[key]

        for row in reader:
            if len(row) < 5:
                continue
            record = {}
            for idx, sqlite_name in col_map.items():
                if idx >= len(row):
                    continue
                raw = row[idx]
                if sqlite_name in _ANC_FLOAT_COLS:
                    record[sqlite_name] = _float(raw)
                else:
                    record[sqlite_name] = _val(raw)
            items.append(record)

    return items


def parse_tfc(filepath: str) -> tuple[list[dict], dict]:
    """Parse an estimateTFC.txt file. Same structure as estimate but with
    source_type='tfc' and slightly different column set (107 cols)."""
    return parse_estimate(filepath, source_type="tfc")


# ── Hub ancillaries parser ─────────────────────────────────────────────────

HUB_ANCILLARY_COLUMNS = [
    ("Item Globally Unique ID (Base64)", "parent_item_guid"),
    ("Code", "parent_dbid"),
    ("Ref", None),
    ("Level 1", "level_1"),
    ("Level 2", "level_2"),
    ("Level 3", "level_3"),
    ("Level 4", "level_4"),
    ("AncillaryMaterialCost", "material_cost"),
    ("AncillaryFabTime", "fab_time"),
    ("AncillaryInstallTime", "install_time"),
    ("Alternate", "alternate"),
    ("Spool", "spool"),
    ("Data Name", "data_name"),
    ("AncillaryLength", "length"),
    ("AncillaryName", "ancillary_name"),
    ("AncillaryQty", "qty"),
    ("AncillaryType", "ancillary_type"),
    ("AncillaryWeight", "weight"),
    ("JobFileName", "job_file_name"),
    ("JobName", "job_name"),
    ("SystemDate", "system_date"),
]

_HUB_ANC_FLOAT_COLS = {"material_cost", "fab_time", "install_time", "length", "qty", "weight"}


def parse_hub_ancillaries(filepath: str) -> list[dict]:
    """Parse a hub_ancillaries.txt file (21-column format with parent item GUID)."""
    filepath = Path(filepath)
    if not filepath.exists():
        raise FileNotFoundError(f"Hub ancillaries file not found: {filepath}")

    items = []
    with open(filepath, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)

        expected = {}
        for csv_name, sqlite_name in HUB_ANCILLARY_COLUMNS:
            if sqlite_name:
                expected[csv_name.strip().lower()] = sqlite_name

        col_map = {}
        for idx, h in enumerate(header):
            key = h.strip().lower()
            if key in expected:
                col_map[idx] = expected[key]

        for row in reader:
            if len(row) < 5:
                continue
            record = {}
            for idx, sqlite_name in col_map.items():
                if idx >= len(row):
                    continue
                raw = row[idx]
                if sqlite_name in _HUB_ANC_FLOAT_COLS:
                    record[sqlite_name] = _float(raw)
                else:
                    record[sqlite_name] = _val(raw)
            items.append(record)

    return items
