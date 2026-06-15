# Fabrication MCP Console

A lightweight browser console for exploring your Autodesk Fabrication CADmep
database via the MCP bridge.

## What it demonstrates

| Panel | What it shows |
|-------|---------------|
| **Product Search** | Search your Fabrication product catalog by description, size, material, or spec. Results include cost from your active price list. |
| **Services** | List all services defined in your database. Click a service to inspect its template and catalog entries. |
| **Price Lists** | Browse configured supplier price lists and search their entries. |
| **Cost Estimate** | Pick products, set quantities and multipliers, and calculate a quick material cost estimate. |
| **EST Jobs** | List estimate jobs loaded into the EST pipeline SQLite database (live when served via `proxy.py`, see below). |
| **Application** | Config hero card (database name, path, profile, loaded state), KPI stat cards (product/service/price/install/image/cache counts), and item status chips with a link to the full Statuses panel. |

## How to open

No build step needed — this is a static HTML/JS/CSS application.

**Option A — double-click:**
Open `public_console/index.html` directly in your browser.
Note: some browsers restrict `fetch()` on `file://` origins. If panels do not
load data, use Option B.

**Option B — console proxy (recommended):**

```bash
# From the repo root — serves the console AND bridges it to the MCP server
python public_console/proxy.py

# Then open: http://localhost:8110/
```

The proxy makes the EST Jobs panel live (`POST /rpc`) and exposes the tool
catalog at `GET /rpc/tools`. Any plain static server
(`python -m http.server 8110 --directory public_console`) also works, but
serves Panels 1–4 only.

## Bridge requirement (Panels 1–4)

Panels 1–4 connect to the FabricationBridgeService HTTP API on `localhost:5050`.

**To connect:**
1. Open AutoCAD 2024 with your Fabrication database loaded.
2. `NETLOAD` the `FabricationSample.dll` plugin (see the FabricationSample repo).
3. The bridge starts automatically at `localhost:5050`.
4. Reload or open this console — the status bar turns green.

**Offline / demo mode:**
If the bridge is not running, all panels fall back to small sample datasets so
you can explore the UI. The status bar shows "Bridge Offline — Sample data mode".

## EST Jobs panel (Panel 5)

The server's EST tools (`est_load_job`, `est_list_jobs`, `est_job_summary`, ...)
are normally used from an MCP client over stdio — a transport browsers cannot
speak directly. `proxy.py` closes that gap: it runs the same MCP server
in-process and exposes it at the page's own origin as
`POST /rpc {"tool": ..., "arguments": {...}}`. The client side is
`js/bridge-client.js → mcpCall()`. Every call passes through the server's
mutation-policy engine, so guarded tools require `confirm` flags exactly as
they do for AI clients. Without the proxy, the panel shows its connect state
and EST data remains fully available through any MCP client.

## Files

```
public_console/
  index.html          Single-page shell + panel markup
  theme-tokens.css    Design tokens (--pub-* custom properties, light + dark)
  style.css           Component styles consuming the tokens
  proxy.py            Static file server + same-origin MCP tool proxy
  assets/
    fabrication-logo.png  Default brand mark (official Autodesk Fabrication badge)
  js/
    bridge-client.js  Bridge HTTP API client with offline fallback
    app.js            Panel controllers and DOM rendering
  vendor/
    shadows.min.css   Open Props v1.7.6 shadow scale (MIT)
    easings.min.css   Open Props v1.7.6 easing curves (MIT)
    animations.min.css  Open Props v1.7.6 animation keyframes (MIT)
    README.md         Vendor attribution + version pins
  README.md           This file
```

## Theme

Data-dense engineering aesthetic — Autodesk vocabulary, distinct identity.
Tokens live in `theme-tokens.css` (`--pub-*` namespace).

**Light / dark modes:**
- Toggle button in the topbar (sun/moon icons). Persisted to `localStorage`
  under key `fab-mcp-theme`. Falls back to `prefers-color-scheme` on first
  visit. A pre-paint `<script>` in `<head>` sets `data-theme` before first
  render to prevent flash.
- Dark palette: engineering near-black (`#111214` bg) — distinct from common
  dark-IDE palettes. Blue accent shifts to `#1aabf0` for
  legibility on dark surfaces. All text/border tokens satisfy WCAG AA contrast.
- Print always renders light mode via `@media print` overrides.

**Token architecture:**
- `--pub-shadow-*` — aliased from Open Props `--shadow-1` … `--shadow-4`
- `--pub-ease-*` — aliased from Open Props `--ease-2`, `--ease-out-3`, `--ease-spring-2`
- `--pub-accent-2` — Fabrication magenta `#cb1e78` sampled from the official
  product tile. Used for the 1px topbar accent edge only.
  NOT applied to surfaces or large areas.

**Brand customization:**
Click the logo in the topbar to upload your own PNG or JPEG mark (kept
client-side as a data-URL in `localStorage`, key `fab-mcp-logo` — nothing is
sent anywhere). "Reset to default" restores the Fabrication badge.

**Vendored libraries (no CDN runtime deps):**
- Open Props v1.7.6 — shadow scale, easing curves, animation keyframes (MIT)
- Lucide v0.513.0 — icons inlined as `<svg>` elements in `index.html` (ISC)
- **Tabulator 6.3.1** — all 10 data grids (MIT, `vendor/tabulator.min.{js,css}`)

No external CSS frameworks or icon fonts. All icons are inline SVG with
`stroke="currentColor"` for theme-aware coloring. All data rendering uses
safe DOM methods (no innerHTML with untrusted content).

## Grids (Tabulator 6.3.1)

All 10 data grids are built with Tabulator via `js/pub-grid.js`:

| Grid mount | Panel | Progressive load |
|---|---|---|
| `#product-grid` | Product Search | Yes — `PubProgressLoader` over `getProducts(sort='id')` |
| `#pl-entry-grid` | Price Lists | Yes — `PubProgressLoader` over `getPriceEntries()` per list |
| `#est-basket-grid` | Cost Estimate | No — driven by in-memory basket array via `setData()` |
| `#est-result-grid` | Cost Estimate | No — driven by basket on `runEstimate()` via `setData()` |
| `#mat-grid` | Materials | No — single `setData()` on load |
| `#sec-grid` | Sections | No — single `setData()` on load |
| `#spec-grid` | Specifications | No — single `setData()` on load |
| `#status-item-grid` | Statuses | No — single `setData()` on load |
| `#status-job-grid` | Statuses | No — single `setData()` on load |
| `#svctype-grid` | Service Types | No — single `setData()` on load |

Dynamic grids (created on demand per selection):
- Service entries — Tabulator instance per service, destroyed on next selection
- EST job summary — Tabulator instance per job, destroyed on next selection

**Universal grid contract:**
- Column header filters on all filterable columns (`type:'input'` or `'list'`)
- Default alphabetical sort (`name asc` or `description asc`) on all grids
- **Exceptions to default sort:**
  1. Estimate basket — no `initialSort`. Basket preserves user insertion order (deliberate: user curates sequence)
  2. Products grid — `initialSort: [{column:'id', dir:'asc'}]` (numeric ID order is the natural catalog sort)
- Toolbar filter inputs wire to `applyQuickFilter()` (cross-field client-side filter, keeps header filters)
- `syncCountBadge(table, badgeId)` wires row-count display to each panel's badge span
