"""Fabrication CADmep MCP Server — backward compatibility shim.

Re-exports all public symbols from the fabrication_mcp package so that
``from server import X`` and ``server.X`` patterns continue to work.
Mutable cache globals proxy through to their canonical modules.

Run via:  python server.py
"""
import logging as _logging
import sys as _sys

_logging.basicConfig(level=_logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")

from fabrication_mcp import mcp  # noqa: F401
import fabrication_mcp.cache as _cache_mod
import fabrication_mcp.bridge as _bridge_mod

# Fire the open-core load seam HERE, from the entry point, now that fabrication_mcp
# has fully imported. It is deliberately NOT called inside fabrication_mcp/__init__.py
# (see the note there): doing so fires `import harris` mid-import of fabrication_mcp,
# and harris.tools.* import back from fabrication_mcp — re-entering a half-built package.
# In public builds (no harris/) this is a no-op: find_spec("harris") is None → False.
from fabrication_mcp import _load_harris_extensions  # noqa: E402
_load_harris_extensions()

_LOOKUP_MODULES = [
    "fabrication_mcp.config", "fabrication_mcp.loaders",
    "fabrication_mcp.cache", "fabrication_mcp.profiles",
    "fabrication_mcp.bridge",
    "fabrication_mcp.tools.csv_tools", "fabrication_mcp.tools.bridge_tools",
    "fabrication_mcp.tools.estimate_tools", "fabrication_mcp.tools.est_tools",
    "fabrication_mcp.tools.profile_tools",
]

_PROXY_ATTRS = {
    "_catalog_cache": _cache_mod, "_catalog_search_index": _cache_mod,
    "_active_profile": _cache_mod, "_profiles": _cache_mod,
    "_last_bridge_check": _bridge_mod, "_last_bridge_db_path": _bridge_mod,
}

_original_dict = _sys.modules[__name__].__dict__


class _ServerModule(_sys.modules[__name__].__class__):
    """Module subclass that proxies attribute access to fabrication_mcp."""

    def __getattr__(self, name):
        mod = _PROXY_ATTRS.get(name)
        if mod is not None:
            return getattr(mod, name)
        for fqn in _LOOKUP_MODULES:
            m = _sys.modules.get(fqn)
            if m is not None and hasattr(m, name):
                return getattr(m, name)
        raise AttributeError(f"module 'server' has no attribute {name!r}")

    def __setattr__(self, name, value):
        mod = _PROXY_ATTRS.get(name)
        if mod is not None:
            setattr(mod, name, value)
            return
        _original_dict[name] = value


_sys.modules[__name__].__class__ = _ServerModule
if __name__ == "__main__":
    import os as _os_main
    _transport = _os_main.environ.get("MCP_TRANSPORT", "stdio")
    if _transport == "sse":
        _port = int(_os_main.environ.get("MCP_PORT", "8005"))
        mcp.run(transport="sse", host="127.0.0.1", port=_port)
    else:
        mcp.run()
