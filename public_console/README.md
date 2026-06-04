# Fabrication CADmep Console

A lightweight browser console for exploring your Autodesk Fabrication CADmep
database via the fabrication-mcp bridge.

## What it demonstrates

| Panel | What it shows |
|-------|---------------|
| **Product Search** | Search your Fabrication product catalog by description, size, material, or spec. Results include cost from your active price list. |
| **Services** | List all services defined in your database. Click a service to inspect its template and catalog entries. |
| **Price Lists** | Browse configured supplier price lists and search their entries. |
| **Cost Estimate** | Pick products, set quantities and multipliers, and calculate a quick material cost estimate. |
| **EST Jobs** | List estimate jobs loaded into the EST pipeline SQLite database (requires MCP server on port 8005). |

## How to open

No build step needed — this is a static HTML/JS/CSS application.

**Option A — double-click:**
Open `public_console/index.html` directly in your browser.
Note: some browsers restrict `fetch()` on `file://` origins. If panels do not
load data, use Option B.

**Option B — local server (recommended):**

```bash
# Python 3
python -m http.server 8110 --directory public_console

# Then open: http://localhost:8110/
```

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

This panel demonstrates the EST-jobs UI pattern. The server's EST tools
(`est_load_job`, `est_list_jobs`, `est_job_summary`, ...) are normally used
from an MCP client over stdio — a transport browsers cannot speak directly.

To wire the panel live, expose a plain JSON-RPC-over-HTTP endpoint for
`tools/call` (for example, a thin localhost proxy in front of the server) at
`localhost:8005/mcp/v1`. The client stub is `js/bridge-client.js → mcpCall()`.
Until such an endpoint exists, the panel shows its connect state and EST data
remains fully available through any MCP client.

## Files

```
public_console/
  index.html          Single-page shell + panel markup
  style.css           Dark engineering theme (no external dependencies)
  js/
    bridge-client.js  Bridge HTTP API client with offline fallback
    app.js            Panel controllers and DOM rendering
  README.md           This file
```

## Theme

Dark neutral engineering aesthetic — no external CSS frameworks or icon fonts.
All icons are inline SVG. All data rendering uses safe DOM methods (no innerHTML
with untrusted content).
