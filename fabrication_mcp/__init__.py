"""fabrication-mcp MCP Server — modular package.

Creates the FastMCP instance and imports all tool modules to register them.
"""

from fastmcp import FastMCP

from fabrication_mcp.config import SERVER_NAME

# ── Create the MCP server instance ───────────────────────────────────────────

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "This server provides read-only access to Autodesk Fabrication CADmep "
        "database exports. "
        "Use get_database_summary first to understand what data is available. "
        "ProductInfo contains ~236k raw rows; ~164k are 'real' products (IsProductListed != N/A). "
        "75k+ items have harrison_code assigned in ProductInfo. "
        "The mapped output (All_Mapped_Deduped, ~7.4k items) is the validated mapped subset. "
        "Cost values come straight from the ProductInfo price lists configured in your "
        "Fabrication database."
    ),
)

# ── Import tool modules to register @mcp.tool() functions ────────────────────
# Order does not matter — each module imports `mcp` from this package.

from fabrication_mcp.tools import csv_tools       # noqa: F401, E402  — 14 CSV tools
from fabrication_mcp.tools import bridge_tools     # noqa: F401, E402  — 15 bridge tools + helpers
from fabrication_mcp.tools import estimate_tools   # noqa: F401, E402  — 2 generic estimate/PBI tools (2 pricing-variance tools in harris/)
from fabrication_mcp.tools import est_tools        # noqa: F401, E402  — 9 EST pipeline tools
from fabrication_mcp.tools import profile_tools    # noqa: F401, E402  — 4 profile tools
from fabrication_mcp.tools import batch_tools       # noqa: F401, E402  — 2 batch tools
from fabrication_mcp.tools import diagnostics_tools  # noqa: F401, E402  — 1 diagnostics tool

# ── Optional Harris private extensions (open-core load seam) ──────────────────
# Public builds ship WITHOUT harris/. Private builds have it and plug Harris-only
# tools + external data loaders in via harris.register(mcp, loaders).
from fabrication_mcp import loaders as _loaders  # noqa: E402


_harris_loaded = False


def _load_harris_extensions():
    """Load the private harris/ package if present — exactly once.

    Two cases MUST be distinguished (GPT-5.5 finding — see sprint plan S0 / S1.5):
      1. harris/ ABSENT          -> public build. Expected. Run in public mode.
      2. harris/ PRESENT but its import/register raises -> the PRIVATE package is
         BROKEN. Must NOT silently fall back to public mode -- fail loudly so a
         misconfigured private server is obvious, never silently degraded.

    Presence is resolved via find_spec against sys.path; the server is always launched
    from the repo root (server.py), where harris/ is importable. register() runs once
    (idempotency guard) so S0b tool registration can never double-fire.
    """
    global _harris_loaded
    if _harris_loaded:
        return True

    import importlib.util

    if importlib.util.find_spec("harris") is None:
        # harris/ is genuinely ABSENT -> public build. Expected; run in public mode.
        return False

    # harris/ IS present. Resolve presence FIRST so that any failure from here is
    # unambiguously a BROKEN private package, not an "absent" signal -- never let it
    # fall through to public mode (GPT-5.5 finding).
    try:
        import harris
        harris.register(mcp, _loaders)
    except Exception as exc:  # noqa: BLE001 -- present-but-broken must hard-fail loud
        raise RuntimeError(
            f"harris/ is present but failed to load -- the PRIVATE server is "
            f"misconfigured and would otherwise run silently in degraded PUBLIC mode. "
            f"Refusing to start. Run the public build deliberately "
            f"(MCP_SERVER_NAME=fabrication-mcp) if public mode is intended. "
            f"Original error: {exc!r}"
        ) from exc

    _harris_loaded = True
    return True


# NOTE: _load_harris_extensions() is invoked by server.py AFTER this package has
# fully imported — NOT here. Calling it during __init__ would fire `import harris`
# mid-import of fabrication_mcp; harris.tools.* import back from fabrication_mcp,
# so the seam could re-enter a half-built package (the failure the harris/tests
# conftest `import server` works around). Firing it from the entry point removes
# the re-entry at its root: the package is complete before the seam reaches in.

# ── Auto-discover profiles from hub manifest ─────────────────────────────────

import sys as _sys  # noqa: E402
if "pytest" not in _sys.modules:
    from fabrication_mcp.profiles import _discover_profiles_from_manifest  # noqa: E402
    _discover_profiles_from_manifest()
