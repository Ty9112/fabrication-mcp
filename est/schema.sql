-- EST Pipeline SQLite Schema
-- Replaces the 792 MB Access database (estimate.accdb) with a lightweight,
-- scriptable, version-controlled SQLite database.
--
-- Data source: ESTmep estimate.txt (141 cols), ancillaries.txt (18 cols),
--              estimateTFC.txt (107 cols)
-- Primary key: JobFileName (unique per job)

-- ── jobs ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
    job_file_name       TEXT PRIMARY KEY,
    job_ref             TEXT,
    batched_job_file_name TEXT,
    job_name            TEXT,
    estimate_no         TEXT,
    job_date            TEXT,
    job_type            TEXT,
    schedule_type       TEXT,
    company             TEXT,
    customer            TEXT,
    general_contractor  TEXT,
    project_level_1     TEXT,
    project_level_2     TEXT,
    project_level_3     TEXT,
    project_level_4     TEXT,
    source_file         TEXT,
    imported_at         TEXT DEFAULT (datetime('now'))
);

-- ── estimate_items ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estimate_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_file_name       TEXT NOT NULL REFERENCES jobs(job_file_name),
    source_type         TEXT NOT NULL DEFAULT 'estimate',

    -- Item identity
    item_guid           TEXT,
    item_handle         TEXT,
    item_number         TEXT,

    -- Location / categorization
    drawing             TEXT,
    section             TEXT,
    zone1               TEXT,
    equipment_name      TEXT,
    spool               TEXT,
    service_abbr        TEXT,
    service             TEXT,
    service_type        TEXT,
    alternate           TEXT,

    -- Product identity
    product_name        TEXT,
    product_desc        TEXT,
    product_size        TEXT,
    spec                TEXT,
    product_spec        TEXT,
    material            TEXT,
    gauge               TEXT,
    material_plus_gauge TEXT,
    product_material    TEXT,
    supplier            TEXT,
    cid                 TEXT,
    dbid                TEXT,
    install_type        TEXT,
    fitting_type        TEXT,
    cut_type            TEXT,

    -- Item flags
    cf                  TEXT,
    bought_out          TEXT,
    insulation_location TEXT,
    doublewall          TEXT,

    -- Geometry
    length              REAL,
    qty                 REAL,
    area                REAL,
    weight              REAL,
    base_weight         REAL,
    volume              REAL,
    outer_length        REAL,
    angle               REAL,
    std_piece_length    REAL,

    -- End sizes
    item_end_size_1     TEXT,
    item_end_size_1_duct TEXT,
    end_size_1          TEXT,
    end_size_1_duct_inch TEXT,
    end_size_2          TEXT,
    end_size_3          TEXT,
    end_size_4          TEXT,
    width               REAL,
    depth               REAL,
    width2              REAL,
    depth2              REAL,
    width3              REAL,
    depth3              REAL,
    width4              REAL,
    depth4              REAL,

    -- Duct-specific geometry
    connector_fab_time  REAL,
    connector_weight    REAL,
    splitter_fab_time   REAL,
    stiffner_fab_time   REAL,
    seam_fab_time       REAL,
    seam_weight         REAL,
    sealant_fab_time    REAL,
    sealant_weight      REAL,
    fab_set_1           REAL,
    fab_set_2           REAL,
    fab_set_3           REAL,
    fab_set_4           REAL,
    field_set_1         REAL,
    field_set_2         REAL,

    -- Insulation
    insul_material_w_gauge TEXT,
    insul_material_name TEXT,
    insul_gauge         TEXT,
    insulation_area     REAL,
    insul_material      TEXT,
    insul_fab_time      REAL,
    insul_fab_cost      REAL,
    insul_field_time    REAL,
    insul_field_cost    REAL,

    -- Wrap/facing
    wrap_material_cost  REAL,
    wrap_fab_time       REAL,
    wrap_fab_cost       REAL,
    wrap_field_time     REAL,
    wrap_field_cost     REAL,
    duct_facing_name    TEXT,
    facing_material_cost REAL,
    facing_fab_time     REAL,
    facing_fab_cost     REAL,

    -- Hangers/support
    hanger_weight       REAL,
    hanger_qty          REAL,
    hanger_mtl          REAL,
    hanger_fab_labor    REAL,
    support_fab_cost    REAL,
    hanger_field_labor  REAL,
    support_install_cost REAL,

    -- Airturn
    airturn_name        TEXT,
    airturn_fab_time    REAL,
    airturn_weight      REAL,

    -- M-Rate (material cost)
    price_list_cost     REAL,
    price_list_wo_disc  REAL,
    discount            TEXT,
    price_list_date     TEXT,
    m_rate              REAL,

    -- F-Rate (fabrication / shop labor — seconds)
    fab_time            REAL,
    fab_cost            REAL,
    alt_fab_time        REAL,

    -- E-Rate (installation / field labor — seconds)
    install_time        REAL,
    field_cost          REAL,
    rate                REAL,
    alt_field_time      REAL,

    -- Lifecycle
    life_span           REAL,
    operating_cost      REAL,
    demo_time           REAL,
    demo_cost           REAL,

    -- ERP cost codes
    field_unit_labor_code TEXT,
    material_cost_code  TEXT,
    shop_unit_labor_code TEXT,
    base_material       TEXT,

    -- ProductInfo enrichment (populated from MCP server's PI cache at ETL time)
    harrison_code       TEXT,

    -- Status tracking
    status              TEXT,
    insul_spec          TEXT,
    s1                  TEXT,
    current_status_date TEXT,
    previous_status_1   TEXT,
    previous_status_date_1 TEXT,
    previous_status_2   TEXT,
    previous_status_date_2 TEXT,
    system_date         TEXT
);

-- ── ancillaries ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ancillaries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_file_name       TEXT NOT NULL REFERENCES jobs(job_file_name),
    parent_item_guid    TEXT,
    parent_dbid         TEXT,
    spool               TEXT,
    ancillary_name      TEXT,
    ancillary_type      TEXT,
    data_name           TEXT,
    alternate           TEXT,
    level_1             TEXT,
    level_2             TEXT,
    level_3             TEXT,
    level_4             TEXT,
    qty                 REAL,
    length              REAL,
    weight              REAL,
    material_cost       REAL,
    fab_time            REAL,
    install_time        REAL,
    job_name            TEXT,
    system_date         TEXT
);

-- ── etl_runs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS etl_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at              TEXT DEFAULT (datetime('now')),
    source_file         TEXT NOT NULL,
    job_file_name       TEXT,
    items_loaded        INTEGER DEFAULT 0,
    ancillaries_loaded  INTEGER DEFAULT 0,
    tfc_loaded          INTEGER DEFAULT 0,
    status              TEXT DEFAULT 'ok',
    error_msg           TEXT
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_items_job        ON estimate_items(job_file_name);
CREATE INDEX IF NOT EXISTS idx_items_guid       ON estimate_items(item_guid);
CREATE INDEX IF NOT EXISTS idx_items_service    ON estimate_items(job_file_name, service_abbr);
CREATE INDEX IF NOT EXISTS idx_items_zone1      ON estimate_items(job_file_name, zone1);
CREATE INDEX IF NOT EXISTS idx_items_status     ON estimate_items(job_file_name, status);
CREATE INDEX IF NOT EXISTS idx_items_drawing    ON estimate_items(job_file_name, drawing);
CREATE INDEX IF NOT EXISTS idx_items_spool      ON estimate_items(job_file_name, spool);
CREATE INDEX IF NOT EXISTS idx_items_cid        ON estimate_items(cid);
CREATE INDEX IF NOT EXISTS idx_items_dbid       ON estimate_items(dbid);
CREATE INDEX IF NOT EXISTS idx_items_source     ON estimate_items(source_type);
CREATE INDEX IF NOT EXISTS idx_items_harrison  ON estimate_items(harrison_code);
CREATE INDEX IF NOT EXISTS idx_anc_job          ON ancillaries(job_file_name);
CREATE INDEX IF NOT EXISTS idx_anc_parent_guid ON ancillaries(parent_item_guid);
CREATE INDEX IF NOT EXISTS idx_anc_parent_dbid ON ancillaries(parent_dbid);
CREATE INDEX IF NOT EXISTS idx_anc_spool       ON ancillaries(job_file_name, spool);
CREATE INDEX IF NOT EXISTS idx_etl_job          ON etl_runs(job_file_name);

-- ── Views ───────────────────────────────────────────────────────────────────

-- Summary view: cost totals by job + service
CREATE VIEW IF NOT EXISTS v_job_service_summary AS
SELECT
    e.job_file_name,
    j.job_name,
    e.service,
    e.service_abbr,
    COUNT(*) AS item_count,
    ROUND(SUM(e.price_list_cost), 2) AS total_material,
    ROUND(SUM(e.fab_cost), 2) AS total_fab_cost,
    ROUND(SUM(e.field_cost), 2) AS total_field_cost,
    ROUND(SUM(e.price_list_cost) + SUM(e.fab_cost) + SUM(e.field_cost), 2) AS total_cost,
    ROUND(SUM(e.weight), 2) AS total_weight,
    ROUND(SUM(e.fab_time) / 3600.0, 1) AS fab_hours,
    ROUND(SUM(e.install_time) / 3600.0, 1) AS install_hours
FROM estimate_items e
JOIN jobs j ON e.job_file_name = j.job_file_name
WHERE e.source_type = 'estimate'
GROUP BY e.job_file_name, e.service
ORDER BY e.job_file_name, total_cost DESC;

-- TFC items with equipment names
CREATE VIEW IF NOT EXISTS v_tfc_items AS
SELECT
    e.*,
    j.job_name
FROM estimate_items e
JOIN jobs j ON e.job_file_name = j.job_file_name
WHERE e.zone1 = 'TFC'
ORDER BY e.job_file_name, e.equipment_name, e.service;

-- Price health: items with zero or missing costs
CREATE VIEW IF NOT EXISTS v_price_gaps AS
SELECT
    e.job_file_name,
    j.job_name,
    e.service,
    e.dbid,
    e.product_desc,
    e.product_size,
    e.price_list_cost,
    e.fab_cost,
    e.field_cost
FROM estimate_items e
JOIN jobs j ON e.job_file_name = j.job_file_name
WHERE e.source_type = 'estimate'
  AND (e.price_list_cost IS NULL OR e.price_list_cost = 0
       OR e.fab_cost IS NULL OR e.fab_cost = 0
       OR e.field_cost IS NULL OR e.field_cost = 0)
ORDER BY e.job_file_name, e.service;

-- Status timeline: status progression per item with timestamps
-- Critical for cross-platform status linking with CMiC and Stratus
CREATE VIEW IF NOT EXISTS v_status_timeline AS
SELECT
    e.job_file_name,
    j.job_name,
    e.item_guid,
    e.item_number,
    e.service,
    e.spool,
    e.product_desc,
    e.product_size,
    e.dbid,
    e.status              AS current_status,
    e.current_status_date,
    e.previous_status_1,
    e.previous_status_date_1,
    e.previous_status_2,
    e.previous_status_date_2
FROM estimate_items e
JOIN jobs j ON e.job_file_name = j.job_file_name
WHERE e.source_type = 'estimate'
  AND (e.status IS NOT NULL
       OR e.previous_status_1 IS NOT NULL
       OR e.previous_status_2 IS NOT NULL)
ORDER BY e.job_file_name, e.spool, e.item_number;

-- Spool summary: aggregates cost/labor/status by spool name within a job
-- Bridges directly to Stratus which tracks at spool level
CREATE VIEW IF NOT EXISTS v_spool_summary AS
SELECT
    e.job_file_name,
    j.job_name,
    e.spool,
    COUNT(*) AS item_count,
    ROUND(SUM(e.price_list_cost), 2) AS total_material,
    ROUND(SUM(e.fab_cost), 2) AS total_fab_cost,
    ROUND(SUM(e.field_cost), 2) AS total_field_cost,
    ROUND(SUM(e.weight), 2) AS total_weight,
    ROUND(SUM(e.fab_time) / 3600.0, 1) AS fab_hours,
    ROUND(SUM(e.install_time) / 3600.0, 1) AS install_hours,
    -- Status breakdown: count of items per status value
    SUM(CASE WHEN e.status IS NOT NULL THEN 1 ELSE 0 END) AS items_with_status,
    GROUP_CONCAT(DISTINCT e.status) AS distinct_statuses
FROM estimate_items e
JOIN jobs j ON e.job_file_name = j.job_file_name
WHERE e.source_type = 'estimate'
  AND e.spool IS NOT NULL
GROUP BY e.job_file_name, e.spool
ORDER BY e.job_file_name, e.spool;

-- Material takeoff: BOM-style view grouped by product, material, size
-- For generating material purchase lists
CREATE VIEW IF NOT EXISTS v_material_takeoff AS
SELECT
    e.job_file_name,
    j.job_name,
    e.service,
    e.product_name,
    e.material,
    e.product_size,
    COUNT(*) AS qty,
    ROUND(SUM(e.price_list_cost), 2) AS total_cost,
    ROUND(SUM(e.weight), 2) AS total_weight,
    ROUND(SUM(e.length), 2) AS total_length,
    ROUND(SUM(e.fab_cost), 2) AS total_fab_cost,
    ROUND(SUM(e.field_cost), 2) AS total_field_cost
FROM estimate_items e
JOIN jobs j ON e.job_file_name = j.job_file_name
WHERE e.source_type = 'estimate'
  AND e.product_name IS NOT NULL
GROUP BY e.job_file_name, e.product_name, e.material, e.product_size
ORDER BY e.job_file_name, total_cost DESC;

-- Ancillary summary: ancillary costs grouped by type per job
-- Hangers, Support Rods, etc.
CREATE VIEW IF NOT EXISTS v_ancillary_summary AS
SELECT
    a.job_file_name,
    a.ancillary_type,
    COUNT(*) AS line_count,
    ROUND(SUM(a.qty), 2) AS total_qty,
    ROUND(SUM(a.material_cost), 2) AS total_material_cost,
    ROUND(SUM(a.weight), 2) AS total_weight,
    ROUND(SUM(a.fab_time) / 3600.0, 1) AS fab_hours,
    ROUND(SUM(a.install_time) / 3600.0, 1) AS install_hours
FROM ancillaries a
WHERE a.ancillary_type IS NOT NULL
GROUP BY a.job_file_name, a.ancillary_type
ORDER BY a.job_file_name, total_material_cost DESC;
