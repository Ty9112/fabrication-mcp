# fabrication-mcp

A FastMCP 3 server exposing an Autodesk Fabrication CADmep database as **44 queryable
MCP tools** across four modes — CSV exports, live bridge, estimate sidecars, and EST
pipeline — plus a static browser console with a searchable MCP Tools Explorer.

## Modes

| Mode | Requires | Description |
|------|----------|-------------|
| CSV | Export files only | Reads ProductInfo CSV exports from the Fabrication database |
| Live bridge | AutoCAD 2024 + bridge plugin | Real-time database access via HTTP bridge at localhost:5050 |
| Estimate | Manifest models | Cost analysis from estimate.json sidecars |
| EST pipeline | SQLite | ETL for ESTmep estimate.txt exports → queryable database |

## Data Sources

Product data is sourced from Fabrication CADmep's `ProductInfo_*.csv` exports (real products
after filtering N/A placeholder rows). Paths are configurable via environment variables:
- `FABRICATION_DATA_ROOT` — root for CSV exports
- `FABRICATION_EXPORTS_DIR` — directory scanned by `est_list_exports` for estimate files

Multiple database profiles are supported via a manifest file, each with its own data paths.

## Tools (44 total)

### CSV-based (6 tools)

| Tool | Description |
|------|-------------|
| `get_database_summary` | Counts, manufacturers, file timestamps — start here |
| `search_products` | Full-text search with token index |
| `get_product_by_id` | O(1) lookup by pi_id |
| `get_product_by_harrison_code` | O(1) lookup by harrison_code column value |
| `estimate_cost` | Material + labor estimate for a product ID list |
| `refresh_cache` | Clear caches and reload updated export files |

### Live bridge (20 tools)

Real-time access to the Fabrication database via an HTTP bridge plugin running inside AutoCAD.

| Tool | Description |
|------|-------------|
| `get_live_status` | Bridge health check |
| `live_search_products` | Real-time product search |
| `live_get_product` / `live_get_product_detail` | Full product detail with prices + install times |
| `live_get_services` | All services in the database |
| `live_get_price_lists` | Price lists with supplier group info |
| `live_get_install_times` | Install time tables |
| `live_get_job_items` / `live_get_job_item` | Items in the current drawing |
| `live_get_service_template_tree` | Full template hierarchy |
| `live_search_price_entries` / `live_search_install_entries` | Individual price/install entries |
| `live_get_service_items` / `get_service_buttons` | Catalog items within service templates |
| `live_get_materials` / `live_get_sections` / `live_get_specifications` | Database entities |
| `live_export_cache` | Trigger a fresh CSV export and reload caches |
| `live_swap_job_item` / `live_undo_swap` | Swap placed items in the drawing |

### Estimate data (2 tools)

| Tool | Description |
|------|-------------|
| `get_estimate_items` | Query estimate records from model sidecars |
| `get_estimate_summary` | Aggregate cost/labor summaries by service, section, material, etc. |

### EST pipeline (9 tools)

SQLite-backed ETL replacing large Access databases for estimate analysis.

| Tool | Description |
|------|-------------|
| `est_load_job` | Load estimate.txt into SQLite |
| `est_list_jobs` / `est_list_exports` | Browse loaded and available estimate files |
| `est_job_summary` | Cost/labor summary by service |
| `est_price_gaps` | Items with missing or zero costs |
| `est_query` | Read-only SQL against the estimate database |
| `est_status_timeline` | Item status history for cross-platform tracking |
| `est_spool_analysis` | Per-spool cost/labor aggregation |
| `est_material_takeoff` | BOM-style takeoff grouped by product/material/size |

### Profile tools (4 tools)

| Tool | Description |
|------|-------------|
| `list_profiles` | Registered database profiles and their load status |
| `switch_profile` | Change the active data context |
| `get_active_profile` | Current profile summary |
| `sync_profile_with_bridge` | Sync MCP profile with the live bridge |

### Batch operations (2 tools)

| Tool | Description |
|------|-------------|
| `batch_product_lookup` | Look up multiple pi_ids in one call (max 100) |
| `batch_harrison_lookup` | Look up multiple harrison_code values in one call (max 100) |

### Diagnostics (1 tool)

| Tool | Description |
|------|-------------|
| `get_diagnostics` | Server health: versions, profile, bridge status, cache state |

## Setup

```bash
pip install fastmcp httpx    # Core deps
python server.py             # Run standalone
```

Or via Claude Code MCP integration (auto-started from `~/.claude/settings.json`).

## Console

A static browser console ships in `public_console/` — a read-only data browser over the
server's tools plus an **MCP Tools Explorer** that lists every tool with its input schema.
One process serves both the UI and a JSON bridge to the tools:

```bash
python public_console/proxy.py        # console + /rpc on http://127.0.0.1:8110
```

No build step and no CORS — the page calls `fetch()` JSON against its own origin.

## Tests

```bash
python -m pytest tests/ -v
```

All tests use mock data — no production CSV dependency.

## Architecture

```
fabrication-mcp/
├── server.py                          # Entry point
├── fabrication_mcp/
│   ├── __init__.py                    # FastMCP instance + tool registration
│   ├── config.py, loaders.py, cache.py, profiles.py, bridge.py
│   └── tools/
│       ├── csv_tools.py               # CSV tools
│       ├── bridge_tools.py            # Live bridge tools
│       ├── estimate_tools.py          # Estimate sidecar tools
│       ├── est_tools.py               # EST pipeline tools
│       ├── profile_tools.py           # Profile tools
│       ├── batch_tools.py             # Batch lookup tools
│       └── diagnostics_tools.py       # Diagnostics
├── est/                               # EST pipeline (schema, parser, ETL)
└── tests/
```
