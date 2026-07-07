"""Cache infrastructure — SearchIndex, ProfileConfig/ProfileCache dataclasses,
and all cache accessor functions.

Imports: config, loaders.
"""

import bisect
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from fabrication_mcp.config import (
    FAB_CONTENT_DIR, MAPPING_TOOLS_DIR, HUB_MANIFEST_PATH,
    _safe_float, log,
)
from fabrication_mcp.loaders import (
    _load_product_info,
    _load_mapped_output, _load_item_data,
)

# ── Open-core hooks (installed by the optional extension at boot) ───────
# Public builds leave these None and run in pure-CSV mode. A private build installs an
# external ProductInfo loader, the discount loader, and the catalog loader here.
_external_product_loader = None   # (config_id=...) -> list[dict] | None
_discount_loader = None           # (directory=...) -> dict[str, float]
_external_catalog_loader = None   # () -> (list[dict], SearchIndex); set by fab_ext.catalog.register()


# ── SearchIndex ──────────────────────────────────────────────────────────────

class SearchIndex:
    """Pre-built token index for sub-linear product search.

    Tokenizes the searchable fields (description, product_name, size,
    specification, harrison_code) into lowercase words. Queries find
    candidate pi_ids via set intersection of token matches, then the
    caller does final filtering on the small candidate set.

    Memory: scales linearly, roughly 100 bytes per product row.
    Build time: <1 second (runs once at cache load).
    """

    __slots__ = ("_token_to_ids", "_listed_ids", "_sorted_tokens")

    def __init__(self) -> None:
        self._token_to_ids: dict[str, set[str]] = {}
        self._listed_ids: set[str] = set()  # pi_ids where is_product_listed != None
        self._sorted_tokens: list[str] = []  # sorted keys for bisect prefix search

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        """Split text into lowercase alphanumeric tokens (min 2 chars)."""
        if not text:
            return []
        return [t for t in text.lower().split() if len(t) >= 2]

    def build(self, records: list[dict]) -> None:
        """Build the index from ProductInfo records."""
        token_map = self._token_to_ids
        listed = self._listed_ids
        for r in records:
            pi_id = r.get("pi_id")
            if not pi_id:
                continue
            # Track listed products
            if r.get("is_product_listed") is not None:
                listed.add(pi_id)
            # Index searchable fields
            search_text = r.get("_search_text", "")
            for token in self._tokenize(search_text):
                bucket = token_map.get(token)
                if bucket is None:
                    bucket = set()
                    token_map[token] = bucket
                bucket.add(pi_id)
        # Pre-sort tokens for bisect-based prefix search
        self._sorted_tokens = sorted(token_map.keys())

    def query(self, q: str) -> Optional[set[str]]:
        """Find candidate pi_ids matching all tokens in the query.

        Returns None if no tokens (caller should fall back to full scan).
        Returns empty set if tokens exist but no matches found.
        """
        tokens = self._tokenize(q)
        if not tokens:
            return None  # empty query -- no index filtering

        # For single-token queries, also check substring matches against
        # multi-word tokens. For efficiency, only do exact token lookup.
        result = self._token_to_ids.get(tokens[0])
        if result is None:
            # Try substring match across all tokens (handles partial matches)
            return self._substring_query(q.lower())

        result = set(result)  # copy to avoid mutating index
        for token in tokens[1:]:
            match = self._token_to_ids.get(token)
            if match is None:
                return self._substring_query(q.lower())
            result &= match

        return result

    def _prefix_candidates(self, prefix: str) -> list[str]:
        """Use bisect on _sorted_tokens to efficiently find all tokens
        starting with the given prefix. O(log n + k) where k is the
        number of matching tokens, vs O(n) for a full scan.
        """
        if not prefix:
            return []
        tokens = self._sorted_tokens
        lo = bisect.bisect_left(tokens, prefix)
        # The upper bound is the prefix with its last character incremented.
        # All tokens >= prefix and < hi_key are prefix matches.
        hi_key = prefix[:-1] + chr(ord(prefix[-1]) + 1)
        hi = bisect.bisect_left(tokens, hi_key)
        return tokens[lo:hi]

    def _substring_query(self, q: str) -> set[str]:
        """Fallback: find IDs where every query token appears as a substring
        of at least one index token. Uses AND semantics across query tokens,
        matching the exact-match path behavior.

        Uses a fast bisect-based prefix check first (O(log n + k)), then
        falls back to full scan only for infix matches that prefix missed.
        """
        q_tokens = self._tokenize(q)
        if not q_tokens:
            return set()

        result: set[str] | None = None
        for qt in q_tokens:
            # Fast path: prefix matches via bisect (covers "elb" -> "elbow",
            # "thread" -> "threadolet", etc.)
            ids_for_token: set[str] = set()
            for idx_token in self._prefix_candidates(qt):
                ids_for_token |= self._token_to_ids[idx_token]

            # Slow path: full scan for infix matches (covers "valve" in
            # "ballvalve", "4x2" in "red4x2", etc.) — only needed when
            # the query token appears mid-word, not at the start.
            if not ids_for_token:
                for idx_token, ids in self._token_to_ids.items():
                    if qt in idx_token:
                        ids_for_token |= ids

            if not ids_for_token:
                return set()  # one token matched nothing -> AND fails
            if result is None:
                result = ids_for_token
            else:
                result &= ids_for_token
                if not result:
                    return set()  # early exit: intersection already empty
        return result or set()


# ── Profile dataclasses ──────────────────────────────────────────────────────

@dataclass
class ProfileConfig:
    """Configuration for one Fabrication database profile."""
    name: str
    display_name: str
    product_info_dir: Path
    product_info_pattern: str = "ProductInfo_*.csv"
    product_info_exclude: str = "DEMO"
    pricing_dir: Optional[Path] = None
    mapping_dir: Optional[Path] = None
    item_data_dir: Optional[Path] = None
    item_data_pattern: str = "*_ItemData_*.csv"
    database_path: Optional[str] = None  # Fabrication database root for bridge matching


@dataclass
class ProfileCache:
    """Lazily-loaded data cache for one profile."""
    config: ProfileConfig
    pi_cache: Optional[list] = field(default=None)
    pi_by_id: Optional[dict] = field(default=None)
    pi_by_harrison: Optional[dict] = field(default=None)
    search_index: Optional[SearchIndex] = field(default=None)
    mapped_cache: Optional[list] = field(default=None)
    mapped_by_id: Optional[dict] = field(default=None)
    discount_cache: Optional[dict] = field(default=None)
    item_data_cache: Optional[list] = field(default=None)
    loaded_at: Optional[datetime] = field(default=None)


# ── Profile-aware cache state ────────────────────────────────────────────────

_profiles: dict[str, ProfileCache] = {}
_active_profile: Optional[str] = None

# The catalog is shared across all profiles (not per-profile). Populated lazily via the
# external catalog loader hook in private builds; stays empty/None in public builds.
_catalog_cache: Optional[list[dict]] = None
_catalog_search_index: Optional[SearchIndex] = None

# Estimate Data (per-model, loaded from estimate.json sidecars)
# Cache: model_id -> list of estimate records (flattened from GlobalId-keyed dict)
_estimate_caches: dict[str, list[dict]] = {}
# Index: model_id -> { dbid -> [records] } for cross-referencing with ProductInfo
_estimate_by_dbid: dict[str, dict[str, list[dict]]] = {}


# ── Profile load ─────────────────────────────────────────────────────────────

def _load_profile_data(cache: ProfileCache) -> None:
    """Load all data for a profile into its cache.

    ProductInfo source depends on the open-core hook:
    - public build (no external loader): load from CSV in the profile's product_info_dir
    - private build (extension installs an external loader): load from that source, falling
      back to CSV if the external read returns None
    """
    cfg = cache.config
    source = "external" if _external_product_loader is not None else "csv"
    log.info(f"Loading profile data: {cfg.name} (source={source})")

    # Load ProductInfo — a private build installs an external loader (with CSV fallback);
    # the public build has no external hook and loads CSV directly.
    products = None
    if _external_product_loader is not None:
        # The hook contract is "return None to fall back to CSV". Defend the seam against a
        # loader that RAISES instead (e.g. an OS/permission error on the source) so a broken
        # external source degrades to CSV rather than 500-ing the whole profile load.
        try:
            products = _external_product_loader(config_id=cfg.name)
        except Exception:  # noqa: BLE001 -- any loader failure must fall back, not propagate
            log.exception(f"External ProductInfo loader raised for {cfg.name}, falling back to CSV")
            products = None
        if products is None:
            log.warning(f"External load returned no data for {cfg.name}, falling back to CSV")
    if products is not None:
        cache.pi_cache = products
    else:
        cache.pi_cache = _load_product_info(cfg.product_info_dir, cfg.product_info_pattern, cfg.product_info_exclude)
    # Pre-build lowercased search text for each product (avoids per-query string ops)
    for r in cache.pi_cache:
        r["_search_text"] = " ".join(filter(None, [
            r.get("description"), r.get("product_name"), r.get("size"),
            r.get("specification"), r.get("harrison_code"),
        ])).lower()
    cache.pi_by_id = {r["pi_id"]: r for r in cache.pi_cache if r.get("pi_id")}
    cache.pi_by_harrison = {
        (r["harrison_code"] or "").lower(): r
        for r in cache.pi_cache if r.get("harrison_code")
    }
    if cfg.mapping_dir:
        cache.mapped_cache = _load_mapped_output(cfg.mapping_dir)
        cache.mapped_by_id = {r.get("pi_id"): r for r in cache.mapped_cache if r.get("pi_id")}
    else:
        cache.mapped_cache = []
        cache.mapped_by_id = {}
    if _discount_loader is not None and cfg.pricing_dir:
        cache.discount_cache = _discount_loader(cfg.pricing_dir)
    else:
        cache.discount_cache = {}
    cache.search_index = SearchIndex()
    cache.search_index.build(cache.pi_cache)
    cache.loaded_at = datetime.now()
    log.info(f"Profile {cfg.name} loaded: {len(cache.pi_cache):,} products, {len(cache.search_index._token_to_ids):,} tokens indexed")


def _get_active_cache() -> ProfileCache:
    """Get the active profile's cache, loading data lazily if needed.

    Always returns a ProfileCache — a default profile is registered on startup
    if no hub manifest exists, so _active_profile is always set.
    """
    if not _active_profile or _active_profile not in _profiles:
        raise RuntimeError(
            "No active profile. Call _discover_profiles_from_manifest() or "
            "register_profile() + set_active_profile() before accessing data."
        )
    cache = _profiles[_active_profile]
    if cache.pi_cache is None:
        _load_profile_data(cache)
    return cache


# ── Cache accessors ──────────────────────────────────────────────────────────

def _products() -> list[dict]:
    """Return ProductInfo records from the active profile."""
    return _get_active_cache().pi_cache


def _products_by_id() -> dict:
    """O(1) product lookup by pi_id."""
    return _get_active_cache().pi_by_id


def _products_by_harrison() -> dict:
    """O(1) product lookup by harrison_code (lowercased)."""
    return _get_active_cache().pi_by_harrison


def _get_search_index() -> SearchIndex:
    """Get the search index for the active profile."""
    return _get_active_cache().search_index


def _mapped() -> list[dict]:
    """Return mapped records from the active profile."""
    return _get_active_cache().mapped_cache


def _mapped_by_id_index() -> dict:
    """O(1) mapped lookup by pi_id."""
    return _get_active_cache().mapped_by_id


def _catalog() -> list[dict]:
    """Return shared catalog records (shared across all profiles).

    Public builds have no external catalog loader installed, so this returns [] (CSV-only
    mode has no proprietary catalog snapshot). Private builds install a records+index
    provider via the _external_catalog_loader hook; on first access this lazily loads
    both halves and caches them.
    """
    global _catalog_cache, _catalog_search_index
    if _catalog_cache is None:
        if _external_catalog_loader is None:
            return []  # public mode — no catalog
        _catalog_cache, _catalog_search_index = _external_catalog_loader()
    return _catalog_cache


def _catalog_search_index_accessor() -> Optional[SearchIndex]:
    """Get the catalog search index (building it if needed). None in public builds."""
    _catalog()  # ensures cache and index are built (no-op in public mode)
    return _catalog_search_index


def _discounts() -> dict[str, float]:
    """Return discount code -> multiplier map from the active profile."""
    return _get_active_cache().discount_cache


def _get_item_data() -> list[dict]:
    """Return ItemData rows from the active profile."""
    cache = _get_active_cache()
    cfg = cache.config
    if cfg.item_data_dir:
        if cache.item_data_cache is None:
            cache.item_data_cache = _load_item_data(cfg.item_data_dir, cfg.item_data_pattern)
        return cache.item_data_cache
    return []


# ── Estimate data cache ─────────────────────────────────────────────────────

def _resolve_estimate_path(model_id: str) -> Optional[Path]:
    """Find the estimate.json path for a model from the hub manifest."""
    if not HUB_MANIFEST_PATH.exists():
        return None
    try:
        with open(HUB_MANIFEST_PATH, encoding="utf-8") as f:
            manifest = json.load(f)
        viewer_root = Path(manifest.get("defaults", {}).get("viewer_data_root", ""))
        for _pname, profile in manifest.get("profiles", {}).items():
            for model in profile.get("models", []):
                if model.get("id") == model_id:
                    est_file = (model.get("sidecars") or {}).get("estimate")
                    if est_file and viewer_root.exists():
                        return viewer_root / est_file
        return None
    except (json.JSONDecodeError, KeyError):
        return None


def _load_estimate(model_id: str) -> list[dict]:
    """Load estimate.json for a model, converting GlobalId-keyed dict to a flat list."""
    path = _resolve_estimate_path(model_id)
    if not path or not path.exists():
        return []
    log.info(f"Loading estimate data for model {model_id}: {path.name} ({path.stat().st_size / 1_000_000:.1f} MB)")
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    # raw is {GlobalId: {field: value, ...}, ...}
    records = []
    for global_id, fields in raw.items():
        rec = {"GlobalId": global_id}
        rec.update(fields)
        records.append(rec)
    log.info(f"Loaded {len(records):,} estimate items for {model_id}")
    return records


def _estimate_items(model_id: str) -> list[dict]:
    """Get cached estimate records for a model. Loads lazily."""
    if model_id not in _estimate_caches:
        records = _load_estimate(model_id)
        _estimate_caches[model_id] = records
        # Build dbid index (one dbid can appear multiple times -- different sizes/fittings)
        by_dbid: dict[str, list[dict]] = {}
        for r in records:
            dbid = r.get("dbid")
            if dbid:
                by_dbid.setdefault(dbid, []).append(r)
        _estimate_by_dbid[model_id] = by_dbid
    return _estimate_caches[model_id]


def _estimate_dbid_index(model_id: str) -> dict[str, list[dict]]:
    """Get dbid -> estimate records index for a model."""
    _estimate_items(model_id)  # ensure loaded
    return _estimate_by_dbid.get(model_id, {})


def _default_model_id() -> Optional[str]:
    """Get the first model_id from the active profile, or None."""
    if not _active_profile or _active_profile not in _profiles:
        return None
    if not HUB_MANIFEST_PATH.exists():
        return None
    try:
        with open(HUB_MANIFEST_PATH, encoding="utf-8") as f:
            manifest = json.load(f)
        profile = manifest.get("profiles", {}).get(_active_profile, {})
        models = profile.get("models", [])
        return models[0]["id"] if models else None
    except (json.JSONDecodeError, KeyError, IndexError):
        return None
