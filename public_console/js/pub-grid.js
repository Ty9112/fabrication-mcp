/**
 * pub-grid.js — Tabulator 6.3.1 shared infrastructure for the Fabrication MCP Console
 *
 * Provides:
 *   PUB_GRID_DEFAULTS   - base Tabulator config (layout, placeholder, movableColumns, etc.)
 *   makeGrid(el, opts)  - merge defaults + opts, return the Tabulator instance
 *   moneyFormatter      - Tabulator cell formatter: "$1,234.56" or "—"
 *   syncCountBadge(table, badgeId) - wire dataFiltered → count badge
 *   applyQuickFilter(table, value) - cross-field search for existing toolbar inputs
 *   PubProgressLoader   - progressive full-load helper (background-buffered batches)
 *
 * All grid definitions live in app.js. This file is engine/infrastructure only.
 *
 * DOM safety: all formatters use DOM construction or safe string escaping.
 * No innerHTML with data-derived content.
 */

/* ── HTML escape helper (used in formatters that return HTML strings) ───── */
function _pubEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ── Money formatter ─────────────────────────────────────────────────────── */
/**
 * Tabulator cell formatter for currency columns.
 * Returns "$1,234.56" for valid numbers, "—" for null/empty/NaN.
 * Usage in column def: formatter: moneyFormatter
 */
function moneyFormatter(cell) {
    var v = cell.getValue();
    if (v === null || v === undefined || v === '') return '<span class="pub-dash">—</span>';
    var n = parseFloat(v);
    if (!isFinite(n)) return '<span class="pub-dash">—</span>';
    return '<span class="pub-cost-val">' +
        '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        '</span>';
}

/* ── ACI color chip formatter ────────────────────────────────────────────── */
/**
 * Tabulator cell formatter for ACI color number columns.
 * Builds DOM safely (no innerHTML with data). Returns HTML string with
 * a color swatch + the ACI number label.
 *
 * ACI_COLORS mirrors app.js's ACI_COLORS map (kept in sync by construction).
 */
var _ACI_COLORS = {
    '1': '#ff0000', '2': '#ffff00', '3': '#00ff00',
    '4': '#00ffff', '5': '#0000ff', '6': '#ff00ff', '7': '#cccccc'
};
var _ACI_FALLBACK = '#888888';

function aciChipFormatter(cell) {
    var v = cell.getValue();
    var colorStr = (v !== null && v !== undefined) ? String(v) : '';
    if (!colorStr) return '<span class="pub-dash">—</span>';
    var hex = _ACI_COLORS[colorStr] || _ACI_FALLBACK;
    // HTML string — colorStr is an integer from the bridge; _pubEsc is safe redundancy
    return '<span class="aci-chip">' +
        '<span class="aci-swatch" style="background:' + hex + '"></span>' +
        _pubEsc(colorStr) +
        '</span>';
}

/* ── ID cell formatter ───────────────────────────────────────────────────── */
/**
 * Renders product ID values with the .pub-id-cell monospaced style.
 */
function idFormatter(cell) {
    var v = cell.getValue();
    if (v === null || v === undefined || v === '') return '<span class="pub-dash">—</span>';
    return '<span class="pub-id-cell">' + _pubEsc(String(v)) + '</span>';
}

/* ── Dash formatter (null/empty → em-dash) ───────────────────────────────── */
/* "N/A" is the Fabrication database's default EMPTY placeholder, never a real
   value — render it as empty everywhere (company-wide data rule). */
function dashFormatter(cell) {
    var v = cell.getValue();
    if (v === null || v === undefined || v === '' || v === 'N/A') return '<span class="pub-dash">—</span>';
    return _pubEsc(String(v));
}

/* ── Default grid options ────────────────────────────────────────────────── */
/**
 * PUB_GRID_DEFAULTS is the baseline Tabulator config for all 12 grids.
 * makeGrid() deep-merges caller opts on top of these.
 *
 * layout:'fitDataStretch' — columns fit their content, last column stretches.
 * This matches the wam-tools reference and avoids horizontal scroll on
 * data-sparse grids (materials, sections, specifications).
 *
 * headerSortClickElement:'icon' — click the sort icon, not the full header,
 * so the header filter input area remains clickable without triggering sort.
 *
 * movableColumns:true — drag-reorder columns (matches wam-tools recipe).
 *
 * placeholder — shown when the table is empty or filtered to zero rows.
 * columnCalcs:'bottom' — footer row for sum/average calcs (estimate grids).
 */
var PUB_GRID_DEFAULTS = {
    layout: 'fitDataStretch',
    movableColumns: true,
    columnCalcs: 'bottom',
    headerSortClickElement: 'icon',
    placeholder: 'No results',
    renderHorizontal: 'virtual',  /* horizontal virtual rendering for wide grids */
    renderVertical: 'virtual',    /* vertical virtual rendering for large datasets */
    height: '100%',
    /* Persistent selection across page refresh not needed — keep simple */
    selectableRows: false
};

/* ── makeGrid ────────────────────────────────────────────────────────────── */
/**
 * makeGrid(el, opts) — create a Tabulator instance by merging PUB_GRID_DEFAULTS
 * with caller opts. Columns, initialSort, data, height, etc. come from opts.
 *
 * @param {string|HTMLElement} el   - CSS selector string or DOM element
 * @param {object}             opts - Tabulator options (columns required)
 * @returns {Tabulator}
 */
function makeGrid(el, opts) {
    var config = Object.assign({}, PUB_GRID_DEFAULTS, opts);
    return new Tabulator(el, config);
}

/* ── syncCountBadge ──────────────────────────────────────────────────────── */
/**
 * Wire a Tabulator table's dataFiltered event to update a count badge DOM node.
 *
 * @param {Tabulator} table   - Tabulator instance
 * @param {string}    badgeId - DOM id of the count badge <span>
 */
function syncCountBadge(table, badgeId) {
    if (!table || !badgeId) return;
    /* dataFiltered fires after every filter change including initial load */
    table.on('dataFiltered', function(filters, rows) {
        var badge = document.getElementById(badgeId);
        if (badge) badge.textContent = String(rows.length);
    });
    /* Also update on initial data load */
    table.on('dataLoaded', function(data) {
        var badge = document.getElementById(badgeId);
        if (badge) badge.textContent = String(data.length);
    });
}

/* ── applyQuickFilter ────────────────────────────────────────────────────── */
/**
 * Apply a cross-field text filter to a Tabulator table.
 * Used by existing toolbar search inputs (the ones that were wired to
 * the old hand-rolled renderTable(filter) function).
 *
 * The filter matches if ANY visible column's string value contains the query.
 * Replaces any existing "pub-quick" filter each call.
 *
 * @param {Tabulator} table  - Tabulator instance
 * @param {string}    value  - search string ('' clears the filter)
 */
function applyQuickFilter(table, value) {
    if (!table) return;
    if (!value || value === '') {
        /* Clear programmatic filters only — clearFilter(false) keeps header
           filters. (Do NOT call removeFilter with a bare name: mismatched
           args make Tabulator warn "No matching filter type found".) */
        table.clearFilter(false);
        return;
    }
    var lower = value.toLowerCase();
    /* Custom function filter across all data fields */
    table.setFilter(function(data) {
        var vals = Object.values(data);
        for (var i = 0; i < vals.length; i++) {
            var s = vals[i];
            if (s !== null && s !== undefined && String(s).toLowerCase().indexOf(lower) !== -1) {
                return true;
            }
        }
        return false;
    });
}

/* ── PubProgressLoader ───────────────────────────────────────────────────── */
/**
 * Progressive full-load helper for large datasets (products ~165k, pl-entries ~90k).
 *
 * Pattern (matches panel-init.js lines 646-684 from the reference console):
 *  1. Fetch first batch (5,000 rows) → table.setData() for immediate display.
 *  2. Background loop: fetch subsequent 5,000-row batches → table.addData().
 *  3. Update toolbar label: "Loading… X of Y Products" → "N Products".
 *  4. On cancel() — stop the loop (panel switch or list change).
 *
 * Usage:
 *   var loader = new PubProgressLoader(table, labelEl, 'Products');
 *   loader.start(fetchFn);          // fetchFn(limit, offset) → Promise<{data,total}>
 *   // later, to cancel:
 *   loader.cancel();
 *
 * @param {Tabulator}   table    - Tabulator instance to populate
 * @param {HTMLElement} labelEl  - element to update with progress text
 * @param {string}      noun     - display noun, e.g. "Products", "Entries"
 */
function PubProgressLoader(table, labelEl, noun) {
    this._table   = table;
    this._label   = labelEl;
    this._noun    = noun || 'rows';
    this._active  = false;
}

PubProgressLoader.prototype._setLabel = function(text) {
    if (this._label) this._label.textContent = text;
};

PubProgressLoader.prototype.cancel = function() {
    this._active = false;
};

/**
 * Start progressive load.
 *
 * @param {Function} fetchFn  - async function(limit, offset) returning {data:[], total:N}
 */
PubProgressLoader.prototype.start = function(fetchFn, batchSize, onDone) {
    var self = this;
    var BATCH = batchSize || 5000;   // match the reference console's batch size —
                                     // gentler on the serialized bridge; batches
                                     // buffer in the background so size ≠ render cost
    self._active = true;
    self._setLabel('Loading…');

    (async function() {
        var offset = 0;
        var total = 0;
        try {
            // First batch — shown immediately so the grid is useful while the
            // rest streams in the BACKGROUND.
            var first = await fetchFn(BATCH, 0);
            if (!self._active) return;  // cancelled during first fetch

            var firstRows = (first && first.data) ? first.data : [];
            total = (first && first.total !== undefined) ? first.total : firstRows.length;

            await self._table.setData(firstRows);
            if (!self._active) return;  // cancelled during setData — label belongs to the canceller now
            self._setLabel('Loading… ' + firstRows.length.toLocaleString() + ' of ' + total.toLocaleString() + ' ' + self._noun);

            offset = firstRows.length;

            // Background batches accumulate into a PLAIN ARRAY — the grid is
            // not touched per step (rendering/processing the full dataset once
            // is cheap; doing grid work 30+ times during the stream is not).
            // The buffer INCLUDES the first page: the final apply uses
            // replaceData (setData's optimized bulk path, scroll preserved).
            // addData(bigArray) is row-by-row internally — measured dramatically
            // slower at scale vs setData for the same rows.
            // Each fetch is individually guarded: retry once, then stop with
            // an honest label instead of looking "stuck".
            var buffer = firstRows.slice();
            while (self._active && offset < total) {
                var batch = null;
                try { batch = await fetchFn(BATCH, offset); } catch (e) { batch = null; }
                if (!self._active) return;  // cancelled between batches
                if (!batch || !batch.data || batch.data.length === 0) {
                    await new Promise(function(r) { setTimeout(r, 800); });
                    try { batch = await fetchFn(BATCH, offset); } catch (e2) { batch = null; }
                    if (!self._active) return;  // cancelled during the retry round-trip
                    if (!batch || !batch.data || batch.data.length === 0) break;
                }
                for (var i = 0; i < batch.data.length; i++) buffer.push(batch.data[i]);
                offset += batch.data.length;
                self._setLabel('Loading… ' + offset.toLocaleString() + ' of ' + total.toLocaleString() + ' ' + self._noun);
            }

            // ONE grid apply for everything buffered (first page + stream).
            if (self._active && buffer.length > firstRows.length) {
                self._setLabel('Rendering ' + offset.toLocaleString() + ' ' + self._noun + '…');
                await self._table.replaceData(buffer);
            }
        } catch (e) {
            // Surface, don't swallow: the label tells the user where it stopped.
            try { console.error('[pub-grid] progressive load error @', offset, e); } catch (e2) {}
        }
        if (self._active) {
            var doneText = offset.toLocaleString() + ' ' + self._noun;
            if (total && offset < total) {
                doneText += ' of ' + total.toLocaleString() + ' — interrupted; click Load All to retry';
            }
            self._setLabel(doneText);
            // Completion hook — e.g. apply the grid's sort ONCE now (an active
            // sort during incremental adds re-sorts the whole set per batch).
            if (typeof onDone === 'function') {
                try { onDone(offset, total); }
                catch (e) { try { console.error('[pub-grid] onDone error', e); } catch (e2) {} }
            }
        }
        self._active = false;
    })();
};
