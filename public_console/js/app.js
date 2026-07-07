/**
 * Fabrication CADmep Console — application logic
 *
 * DOM safety: all dynamic content uses textContent / createElement / setAttribute.
 * No innerHTML with untrusted data anywhere in this file.
 *
 * Grids: all 10 data grids use Tabulator 6.3.1 via makeGrid() from pub-grid.js.
 * Universal contract:
 *   - Column header filters on every filterable column (type:'input' or 'list')
 *   - Default alphabetical sort (name asc) on all grids except basket (insertion
 *     order — deliberate exception: user-curated sequence) and item/job statuses
 *     (name asc honored; index col remains sortable)
 *   - Progressive full-load (PubProgressLoader) on products + pl-entries
 *   - syncCountBadge wired to every grid's badge span
 *   - Toolbar filter inputs wired to applyQuickFilter (cross-field client filter)
 */

/* ──────────────────────────────────────────────────────────────
   Navigation
   ────────────────────────────────────────────────────────────── */
// Activate a panel by name — the single navigation entry point, used by the
// nav buttons and by programmatic navigation (e.g. Application stat cards).
function activatePanel(target) {
    document.querySelectorAll('.nav-btn').forEach(function(b) {
        var is = b.getAttribute('data-panel') === target;
        b.classList.toggle('active', is);
        b.setAttribute('aria-selected', is ? 'true' : 'false');
    });
    document.querySelectorAll('.panel').forEach(function(p) {
        p.classList.add('hidden');
        p.classList.remove('active');
    });
    var panel = document.getElementById('panel-' + target);
    if (panel) {
        panel.classList.remove('hidden');
        panel.classList.add('active');
        PanelControllers[target] && PanelControllers[target].onActivate();
    }
}

(function initNav() {
    document.querySelectorAll('.nav-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            activatePanel(btn.getAttribute('data-panel'));
        });
    });
})();

/* ──────────────────────────────────────────────────────────────
   Bridge status wiring
   ────────────────────────────────────────────────────────────── */
BridgeClient.onStatusChange(function(online) {
    showOfflineBanners(!online);
});

function showOfflineBanners(show) {
    var banners = document.querySelectorAll('.offline-banner');
    banners.forEach(function(b) {
        if (show) { b.classList.remove('hidden'); }
        else { b.classList.add('hidden'); }
    });
}

/* ──────────────────────────────────────────────────────────────
   Utilities
   ────────────────────────────────────────────────────────────── */
function fmt(val, decimals) {
    if (val === null || val === undefined || val === '') return '—';
    var n = parseFloat(val);
    if (isNaN(n)) return String(val);
    return '$' + n.toFixed(decimals !== undefined ? decimals : 2);
}

function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

function clearElement(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function setMeta(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
}

// ── Stat card builder — shared by Application + Overview ─────────
// value: display string, label: caption, mod: optional modifier class
// (e.g. 'ok' → green accent, 'warn' → orange accent, '' → default blue)
function makeStatCard(value, label, mod) {
    var card = document.createElement('div');
    card.className = 'app-stat' + (mod ? ' app-stat--' + mod : '');

    var vEl = document.createElement('div');
    vEl.className = 'app-stat-value';
    vEl.textContent = String(value);

    var lEl = document.createElement('div');
    lEl.className = 'app-stat-label';
    lEl.textContent = label;

    card.appendChild(vEl);
    card.appendChild(lEl);
    return card;
}

/* ──────────────────────────────────────────────────────────────
   Detail drawer — shared right slide-over. A controller calls
   open(title) and renders into the returned body element with
   section()/row(). One drawer instance, last-opener wins.
   ────────────────────────────────────────────────────────────── */
var DetailDrawer = (function() {
    var drawer = document.getElementById('pub-drawer');
    var titleEl = document.getElementById('pub-drawer-title');
    var bodyEl = document.getElementById('pub-drawer-body');

    document.getElementById('pub-drawer-close').addEventListener('click', close);
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && drawer.classList.contains('open')) close();
    });

    function open(title) {
        titleEl.textContent = title || '';
        clearElement(bodyEl);
        drawer.classList.add('open');
        return bodyEl;
    }

    function close() { drawer.classList.remove('open'); }

    function section(parent, title) {
        var sec = el('div', 'pub-detail-section');
        sec.appendChild(el('h3', null, title));
        parent.appendChild(sec);
        return sec;
    }

    // N/A is the Fabrication empty placeholder, never a value — render as dash.
    function row(parent, label, value, mono) {
        var r = el('div', 'pub-detail-row');
        r.appendChild(el('span', 'label', label));
        var v = (value === null || value === undefined || value === '' || value === 'N/A')
            ? '—' : String(value);
        r.appendChild(el('span', mono ? 'value mono' : 'value', v));
        parent.appendChild(r);
        return r;
    }

    return { open: open, close: close, section: section, row: row };
})();

/* ──────────────────────────────────────────────────────────────
   Floating datagrid panel — draggable popup, one instance.
   open(title, cleanup) returns the body element; cleanup runs on
   close or when a new opener takes over (destroy grids there).
   ────────────────────────────────────────────────────────────── */
var FloatPanel = (function() {
    var panel = document.getElementById('pub-float');
    var head = document.getElementById('pub-float-head');
    var titleEl = document.getElementById('pub-float-title');
    var bodyEl = document.getElementById('pub-float-body');
    var cleanupFn = null;

    document.getElementById('pub-float-close').addEventListener('click', close);

    // Escape closes the float FIRST when both it and the drawer are open
    // (float sits above the drawer) — capture phase + stopPropagation beat
    // the drawer's bubble-phase Escape handler.
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && panel.classList.contains('open')) {
            e.stopPropagation();
            close();
        }
    }, true);

    // Drag by header. Pointer events keep it simple — no drop zones, just move.
    var drag = null;
    head.addEventListener('pointerdown', function(e) {
        if (e.target.closest('.pub-drawer-close')) return;
        var r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function(e) {
        if (!drag) return;
        panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
        panel.style.top  = Math.max(0, e.clientY - drag.dy) + 'px';
        panel.style.right = 'auto';
    });
    // All three end events — pointercancel/lostpointercapture fire on touch
    // cancel or gesture takeover, where pointerup never arrives; without them
    // the panel keeps dragging on the next hover (Wave 2.5/2.6 float lesson).
    function endDrag() { drag = null; }
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    head.addEventListener('lostpointercapture', endDrag);

    function open(title, cleanup) {
        if (cleanupFn) { try { cleanupFn(); } catch(e) {} }
        cleanupFn = cleanup || null;
        titleEl.textContent = title || '';
        clearElement(bodyEl);
        panel.classList.add('open');
        return bodyEl;
    }

    function close() {
        if (cleanupFn) { try { cleanupFn(); } catch(e) {} cleanupFn = null; }
        clearElement(bodyEl);
        panel.classList.remove('open');
    }

    return { open: open, close: close };
})();

/* ──────────────────────────────────────────────────────────────
   Size-range condition formatting (service template entries).
   greater_than / less_than_eq arrive as decimal-inch strings
   ("0.75") or "Unrestricted"; condition_desc may carry a label.
   ────────────────────────────────────────────────────────────── */
function formatSizeCondition(gt, lte, desc) {
    // ESTmep parity: conditions display as explicit decimals
    // ("> 2.0", "<= 1.25"), confirmed against the live API. Neither source is
    // complete alone — numerics carry the value on some rows (SS304L: gt="2",
    // bare desc), the desc tail carries it on others ("Cast Iron : > 1.5",
    // numerics Unrestricted) — so merge: numerics win, desc tail is fallback.
    function estDec(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return null;                       // defensive: never render NaN
        return Number.isInteger(n) ? n + '.0' : String(n);
    }
    function num(v) {
        return (v && v !== 'Unrestricted' && v !== 'N/A') ? estDec(v) : null;
    }

    var g = num(gt), l = num(lte);
    if (g || l) return (g ? '> ' + g : '') + (g && l ? '  ' : '') + (l ? '<= ' + l : '');

    // Fallback: the authored condition description — "{name} : {op} {value}"
    if (desc && desc !== 'Unrestricted' && desc !== 'N/A') {
        var m = desc.match(/:\s*(>|<=)\s*([0-9.]+)\s*$/);
        if (m) {
            var d = estDec(m[2]);
            if (d) return m[1] + ' ' + d;
        }
        return desc;   // authored text without a parseable value — show verbatim
    }
    return 'Unrestricted';
}

/* ──────────────────────────────────────────────────────────────
   Button tree — the service template hierarchy experience:
   summary line → tab bar → button PNG grid → click a button →
   floating panel with its catalog entries grid. Shared by the
   Services and Templates panels.
   ────────────────────────────────────────────────────────────── */
var ButtonTree = (function() {
    var entriesTable = null;   // Tabulator in the float panel

    function destroyEntries() {
        if (entriesTable) { try { entriesTable.destroy(); } catch(e) {} entriesTable = null; }
    }

    function openButtonPanel(btn, tabName, serviceName) {
        var body = FloatPanel.open(
            serviceName + ' › ' + tabName + ' › ' + (btn.name || 'Button'), destroyEntries);

        var mount = el('div', 'pub-grid');
        body.appendChild(mount);

        var rows = (btn.items || []).map(function(it) {
            return {
                entry_name:  it.entry_name || '',
                database_id: it.database_id || '',
                cond:        formatSizeCondition(it.greater_than, it.less_than_eq, it.condition_desc || ''),
                item_folder: it.item_folder || ''
            };
        });

        entriesTable = makeGrid(mount, {
            data: rows,
            columns: [
                { title: 'Entry',       field: 'entry_name',  formatter: dashFormatter,
                  headerFilter: 'input', width: 110 },
                { title: 'Database ID', field: 'database_id', formatter: idFormatter,
                  headerFilter: 'input' },
                { title: 'Size Range',  field: 'cond',        formatter: dashFormatter, width: 140 },
                { title: 'Folder',      field: 'item_folder', formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } }
            ],
            initialSort: [{ column: 'entry_name', dir: 'asc' }]
        });

        // Entry → product detail drawer (cross-grid navigation)
        entriesTable.on('rowClick', function(e, row) {
            var d = row.getData();
            if (d.database_id) {
                openProductDetailById(d.database_id, d.entry_name);
            }
        });
    }

    // Minimal row-shaped seed for the drawer when navigating from an entry
    function openProductDetailById(databaseId, entryName) {
        if (PanelControllers.products && PanelControllers.products.openDetail) {
            PanelControllers.products.openDetail({ id: databaseId, description: entryName || databaseId });
        }
    }

    function renderButtons(grid, tab, serviceName) {
        clearElement(grid);
        (tab.buttons || []).forEach(function(btn) {
            var card = el('button', 'pub-btn-card');
            card.type = 'button';
            card.title = (btn.name || 'Button') + ' (' + (btn.item_count || 0) + ' items)';

            var src = BridgeClient.imageUrl(btn.image);
            if (src) {
                var img = document.createElement('img');
                img.loading = 'lazy';
                img.alt = btn.name || '';
                img.onerror = function() {
                    var ph = el('div', 'pub-btn-ph', '✦');
                    this.replaceWith(ph);
                };
                img.src = src;
                card.appendChild(img);
            } else {
                card.appendChild(el('div', 'pub-btn-ph', '✦'));
            }

            card.appendChild(el('div', 'pub-btn-name', btn.name || ''));
            if (btn.item_count) card.appendChild(el('div', 'pub-btn-count', btn.item_count + ' items'));

            card.addEventListener('click', function() {
                grid.querySelectorAll('.pub-btn-card').forEach(function(c) { c.classList.remove('selected'); });
                card.classList.add('selected');
                openButtonPanel(btn, tab.name || '', serviceName);
            });
            grid.appendChild(card);
        });
    }

    // Render the tree for a service into a container element.
    async function renderInto(container, serviceName) {
        // Per-call token on the container: a faster competing renderInto on the
        // SAME container claims it, and this call's slow response aborts. (A
        // contains(note) check misses the case where the old note is still in
        // the DOM when the stale response lands.)
        var token = {};
        container._btToken = token;

        var note = el('p', null, 'Loading template tree…');
        note.style.cssText = 'color:var(--pub-text-muted);font-size:12px;';
        container.appendChild(note);

        var tree = await BridgeClient.getServiceTree(serviceName);
        if (container._btToken !== token) return;   // a newer render owns this container
        if (container.contains(note)) container.removeChild(note);

        if (!tree || tree.error || !(tree.tabs || []).length) {
            var msg = (tree && tree.no_template) ? 'No service template assigned.'
                    : (tree && tree.loading)     ? 'Service items still loading in the bridge — try again shortly.'
                    : 'No template data returned.';
            var p = el('p', null, msg);
            p.style.cssText = 'color:var(--pub-text-muted);font-size:12px;padding:8px 0;';
            container.appendChild(p);
            return;
        }

        container.appendChild(el('div', 'pub-tree-summary',
            (tree.tab_count || 0) + ' tabs · ' + (tree.button_count || 0) + ' buttons · ' +
            (tree.item_count || 0) + ' items — ' + (tree.template_name || '')));

        var tabBar = el('div', 'pub-tree-tabs');
        var grid = el('div', 'pub-btn-grid');
        container.appendChild(tabBar);
        container.appendChild(grid);

        (tree.tabs || []).forEach(function(tab, i) {
            var tb = el('button', 'pub-tree-tab', tab.name || ('Tab ' + (i + 1)));
            tb.type = 'button';
            if (i === 0) tb.classList.add('active');
            tb.addEventListener('click', function() {
                tabBar.querySelectorAll('.pub-tree-tab').forEach(function(t) { t.classList.remove('active'); });
                tb.classList.add('active');
                renderButtons(grid, tab, serviceName);
            });
            tabBar.appendChild(tb);
        });

        if (tree.tabs.length) renderButtons(grid, tree.tabs[0], serviceName);
    }

    return { renderInto: renderInto };
})();

/* ──────────────────────────────────────────────────────────────
   Panel controllers — each panel registers an onActivate()
   ────────────────────────────────────────────────────────────── */
var PanelControllers = {};

/* ══════════════════════════════════════════════════════════════
   Panel 0 — Overview (landing dashboard)
   KPI cards with live counts; every card click-navigates to its
   panel. Refreshes on each activation — the calls are light
   (/api/status + /api/cache + est_list_jobs via /rpc).
   ══════════════════════════════════════════════════════════════ */
PanelControllers.overview = (function() {
    var loading = false;

    function statTo(panel, value, label, mod) {
        var card = makeStatCard(value, label, mod);
        if (panel) {
            card.style.cursor = 'pointer';
            card.setAttribute('role', 'link');
            card.setAttribute('tabindex', '0');
            card.addEventListener('click', function() { activatePanel(panel); });
            card.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activatePanel(panel); }
            });
        }
        return card;
    }

    function num(v) { return (v === null || v === undefined) ? '—' : Number(v).toLocaleString(); }

    async function load() {
        if (loading) return;   // inflight guard — rapid re-activation
        loading = true;
        try {
            var idRow = document.getElementById('ov-identity');
            var dbRow = document.getElementById('ov-db-stats');
            var workRow = document.getElementById('ov-work-stats');

            var results = await Promise.all([
                BridgeClient.getStatus(),
                BridgeClient.get('/api/cache', null),
                BridgeClient.mcpCall('est_list_jobs', {})
            ]);
            var status = results[0] || {};
            var cache = results[1] || {};
            var est = results[2];

            clearElement(idRow);
            var online = BridgeClient.isOnline();
            idRow.appendChild(statTo(null, online ? 'Online' : 'Offline',
                'Bridge', online ? 'ok' : 'warn'));
            idRow.appendChild(statTo('application', status.database_name || '—', 'Database'));
            idRow.appendChild(statTo('application', status.profile_name || '—', 'Profile'));

            clearElement(dbRow);
            dbRow.appendChild(statTo('products',     num(cache.product_count),         'Products'));
            dbRow.appendChild(statTo('services',     num(cache.service_items_count),   'Service Items'));
            dbRow.appendChild(statTo('pricelists',   num(cache.price_entries_count),   'Price Entries'));
            dbRow.appendChild(statTo('installtimes', num(cache.install_entries_count), 'Install Entries'));
            dbRow.appendChild(statTo('products',     num(cache.image_count),           'Product Images'));

            clearElement(workRow);
            var jobMod = (cache.job_items_count > 0) ? 'ok' : '';
            workRow.appendChild(statTo('jobitems', num(cache.job_items_count), 'Job Items (drawing)', jobMod));
            workRow.appendChild(statTo('est', (est && est.job_count !== undefined) ? num(est.job_count) : '—', 'EST Jobs'));
        } finally {
            loading = false;
        }
    }

    return { onActivate: function() { load(); } };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 1 — Product Search
   ══════════════════════════════════════════════════════════════ */
PanelControllers.products = (function() {
    var loaded = false;
    var table = null;
    var loader = null;
    var detailGen = 0;   // generation counter — stale async detail renders are dropped

    function drawerOpen() {
        return document.getElementById('pub-drawer').classList.contains('open');
    }

    // Label element for progress display — reuse the results meta span
    function labelEl() { return document.getElementById('product-results-meta'); }

    // Row click → detail drawer. Detail route 404s on ids containing spaces
    // (a substantial share of the DB — bridge unescape gap), so the row itself
    // is the fallback: render what we have, flag that prices/labor need the fix.
    async function openProductDetail(rowData) {
        var gen = ++detailGen;
        var body = DetailDrawer.open(rowData.description || rowData.id);
        body.appendChild(el('div', 'pub-detail-section', 'Loading…'));

        var detail = await BridgeClient.getProductDetail(rowData.id);
        // Abort if a newer click took over OR the drawer was closed mid-flight
        // (a stale render into a closed drawer pops back on next open).
        if (gen !== detailGen || !drawerOpen()) return;
        var partial = false;
        if (!detail || detail.error) { detail = rowData; partial = true; }

        clearElement(body);

        // Image: detail image_path, else service-items lookup by database_id
        // (query params decode correctly even for space-ids; path segments don't)
        var imagePath = detail.image_path || null;
        if (!imagePath && BridgeClient.isOnline()) {
            var si = await BridgeClient.get(
                '/api/services/items?database_id=' + encodeURIComponent(rowData.id) + '&limit=1', null);
            if (gen !== detailGen || !drawerOpen()) return;
            if (si && si.data && si.data.length)
                imagePath = si.data[0].image_path || si.data[0].button_image || null;
        }
        var imgSrc = BridgeClient.imageUrl(imagePath);
        if (imgSrc) {
            var wrap = el('div', 'pub-drawer-img');
            var img = document.createElement('img');
            img.alt = detail.description || '';
            img.onerror = function() { wrap.style.display = 'none'; };
            img.src = imgSrc;
            wrap.appendChild(img);
            body.appendChild(wrap);
        }

        var ident = DetailDrawer.section(body, 'Identity');
        DetailDrawer.row(ident, 'Database ID',   detail.id, true);
        DetailDrawer.row(ident, 'Description',   detail.description);
        DetailDrawer.row(ident, 'Manufacturer',  detail.manufacturer);
        DetailDrawer.row(ident, 'Material',      detail.material);
        DetailDrawer.row(ident, 'Specification', detail.specification);
        DetailDrawer.row(ident, 'Size',          detail.size);
        DetailDrawer.row(ident, 'Install Type',  detail.install_type);
        DetailDrawer.row(ident, 'Group',         detail.group);
        DetailDrawer.row(ident, 'Listed',        detail.is_product_listed);

        var sids = detail.supplier_ids || {};
        var sup = DetailDrawer.section(body, 'Supplier IDs');
        DetailDrawer.row(sup, 'Harrison Code', sids['Harrison'], true);
        DetailDrawer.row(sup, 'Ferguson Code', sids['Ferguson'], true);
        DetailDrawer.row(sup, 'Mfr Code',      sids['Manufacturer Code'], true);
        DetailDrawer.row(sup, 'UPC Code',      sids['UPC Code'], true);
        DetailDrawer.row(sup, 'OEM Code',      sids['OEM Code'], true);

        if (partial) {
            var note = DetailDrawer.section(body, 'Pricing & Labor');
            DetailDrawer.row(note, 'Status',
                'Unavailable for this id — bridge update pending (ids with spaces)');
            return;
        }

        var prices = detail.prices || [];
        var pr = DetailDrawer.section(body, 'Pricing (' + prices.length + ')');
        if (prices.length) {
            prices.forEach(function(p) {
                DetailDrawer.row(pr, p.list_name || p.supplier_group || 'Price', fmt(p.cost));
                if (p.discount_code && p.discount_code !== 'N/A')
                    DetailDrawer.row(pr, 'Discount Code', p.discount_code, true);
            });
        } else {
            DetailDrawer.row(pr, 'Status', 'No pricing data');
        }

        var installs = detail.install_times || [];
        var ins = DetailDrawer.section(body, 'Labor (' + installs.length + ')');
        if (installs.length) {
            installs.forEach(function(t) {
                DetailDrawer.row(ins, t.table_name || t.group || 'Table',
                    (t.labor_rate !== undefined && t.labor_rate !== null)
                        ? t.labor_rate + ' ' + (t.units || '') : '—');
            });
        } else {
            DetailDrawer.row(ins, 'Status', 'No labor data');
        }

        var linked = detail.linked_services || [];
        var ls = DetailDrawer.section(body, 'Linked Services (' + linked.length + ')');
        if (linked.length) {
            linked.forEach(function(s) { DetailDrawer.row(ls, '', s); });
        } else {
            DetailDrawer.row(ls, 'Status', 'Not used by any service');
        }
    }

    function init() {
        // Build Tabulator grid
        table = makeGrid('#product-grid', {
            columns: [
                { title: 'ID',           field: 'id',           formatter: idFormatter,
                  headerFilter: 'input', width: 100 },
                { title: 'Description',  field: 'description',  formatter: dashFormatter,
                  headerFilter: 'input' },
                { title: 'Size',         field: 'size',         formatter: dashFormatter,
                  headerFilter: 'input', width: 90 },
                { title: 'Material',     field: 'material',     formatter: dashFormatter,
                  headerFilter: 'list',  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Spec',         field: 'specification', formatter: dashFormatter,
                  headerFilter: 'list',  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Manufacturer', field: 'manufacturer', formatter: dashFormatter,
                  headerFilter: 'list',  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Cost',         field: 'cost',         formatter: moneyFormatter,
                  headerFilter: 'input', sorter: 'number', hozAlign: 'right',
                  headerFilterFunc: '>=', width: 100 },
                { title: '',             field: '_add',         width: 44, hozAlign: 'center',
                  headerSort: false,
                  formatter: function() {
                      return '<button class="pick-item-add" title="Add to estimate" aria-label="Add to estimate">+</button>';
                  },
                  cellClick: function(e, cell) {
                      EstimatePanel.addProduct(cell.getRow().getData());
                  }
                }
            ],
            // NO initialSort here — with an active sort, Tabulator RE-SORTS the
            // entire accumulated dataset on every addData batch (O(n²) over a
            // progressive load — stall times climb sharply as more rows land).
            // The bridge already returns batches server-sorted by id; the loader
            // applies the client sort ONCE on completion (see startProgressiveLoad).
            // Perf at large row counts: fitColumns avoids fitDataStretch's per-addData
            // content re-measuring; no calc columns here so skip the calc walk.
            layout: 'fitColumns',
            columnCalcs: false
        });

        // Row click → detail drawer (skip clicks on the add-to-estimate button,
        // which has its own cellClick)
        table.on('rowClick', function(e, row) {
            if (e.target && e.target.closest && e.target.closest('.pick-item-add')) return;
            openProductDetail(row.getData());
        });

        syncCountBadge(table, null);  // badge wired via dataLoaded below
        // Update results-meta on load/filter. Tabulator fires dataLoaded once
        // at table init with NO array — guard before reading .length.
        table.on('dataLoaded', function(data) {
            var lbl = labelEl();
            if (!lbl) return;
            var n = (data && typeof data.length === 'number') ? data.length : table.getDataCount();
            lbl.textContent = n.toLocaleString() + ' Products';
        });

        // Server-side search: cancel progressive load and re-fetch
        document.getElementById('product-search-btn').addEventListener('click', function() {
            runServerSearch();
        });
        document.getElementById('product-search-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') runServerSearch();
        });

        // Quick filter: apply on each keystroke (client-side over loaded data);
        // also cancel any in-progress progressive load so the user isn't fighting it
        document.getElementById('product-search-input').addEventListener('input', function() {
            var q = this.value.trim();
            if (loader) { loader.cancel(); loader = null; }
            applyQuickFilter(table, q);
        });

        document.getElementById('product-load-all-btn').addEventListener('click', function() {
            document.getElementById('product-search-input').value = '';
            applyQuickFilter(table, '');
            startProgressiveLoad('');
        });

        // Initial view: ONE fast page (loads almost instantly), not the full
        // dataset pull — auto-firing many batch requests on every page open
        // starves the serialized bridge for other consumers (e.g. the reference
        // console's service-tree calls). "Load All" runs the full progressive load.
        loadFirstPage();
    }

    // Generation counter for the grid's data-mutating flows. Each flow claims
    // the grid by bumping the counter; any earlier flow still awaiting a fetch
    // sees a stale generation afterwards and aborts BEFORE touching the grid.
    // (Without this, a slow first-page/search response can land mid-stream and
    // clobber the progressive loader's data.)
    var dataGen = 0;

    async function loadFirstPage() {
        var gen = ++dataGen;
        var first = await BridgeClient.getProducts('', 10000, 0, 'id');
        if (gen !== dataGen) return;   // a newer flow owns the grid now
        var rows = (first && first.data) ? first.data : [];
        var total = (first && first.total !== undefined) ? first.total : rows.length;
        await table.setData(rows);  // await so dataLoaded's label write lands FIRST
        var lbl = labelEl();
        if (lbl) lbl.textContent = rows.length.toLocaleString() + ' of ' +
            total.toLocaleString() + ' Products — Load All for the rest';
    }

    function startProgressiveLoad(serverQuery) {
        ++dataGen;                     // claim the grid (loader has its own cancel gating)
        if (loader) loader.cancel();
        var lbl = labelEl();
        loader = new PubProgressLoader(table, lbl, 'Products');
        loader.start(function(limit, offset) {
            return BridgeClient.getProducts(serverQuery, limit, offset, 'id');
        }, undefined, function() {
            // Batches arrived server-sorted by id; activate the client sort
            // (and its header indicator) exactly once, over the full set.
            table.setSort('id', 'asc');
        });
    }

    async function runServerSearch() {
        var q = document.getElementById('product-search-input').value.trim();
        // Clear quick filter so server results are shown unfiltered
        applyQuickFilter(table, '');
        if (loader) { loader.cancel(); loader = null; }

        if (!q) {
            startProgressiveLoad('');
            return;
        }

        // Single-shot fetch for server search (results are already filtered)
        var gen = ++dataGen;
        var lbl = labelEl();
        if (lbl) lbl.textContent = 'Searching…';
        var data = await BridgeClient.getProducts(q, 500, 0);
        if (gen !== dataGen) return;   // superseded while awaiting
        var rows = (data && data.data) ? data.data : [];
        table.setData(rows);
        if (lbl) lbl.textContent = rows.length.toLocaleString() + ' results for "' + q + '"';
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); }
            // Virtual rendering: redraw after panel becomes visible
            else if (table) { table.redraw(true); }
        },
        // Cross-grid navigation: other panels (button tree entries, price
        // entries) open the product drawer with a minimal {id, description}.
        openDetail: openProductDetail
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 2 — Services
   (List + detail pane; detail uses a dynamic Tabulator per service)
   ══════════════════════════════════════════════════════════════ */
PanelControllers.services = (function() {
    var loaded = false;
    var allServices = [];
    var activeService = null;

    function init() {
        document.getElementById('svc-filter').addEventListener('input', function() {
            renderList(this.value.trim().toLowerCase());
        });
    }

    async function load() {
        var data = await BridgeClient.getServices();
        allServices = Array.isArray(data) ? data : (data && data.data ? data.data : []);
        renderList('');
    }

    function renderList(filter) {
        var ul = document.getElementById('svc-list');
        var emptyDiv = document.getElementById('svc-list-empty');
        clearElement(ul);

        var items = filter ? allServices.filter(function(s) {
            return (s.name || '').toLowerCase().indexOf(filter) !== -1 ||
                   (s.template || '').toLowerCase().indexOf(filter) !== -1;
        }) : allServices;

        setMeta('svc-count-badge', String(items.length));

        if (items.length === 0) {
            emptyDiv.classList.remove('hidden');
            return;
        }
        emptyDiv.classList.add('hidden');

        var frag = document.createDocumentFragment();
        items.forEach(function(svc) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.className = 'item-btn';
            if (activeService && activeService.name === svc.name) btn.classList.add('active');

            var prim = document.createElement('span');
            prim.className = 'item-btn-primary';
            prim.textContent = svc.name || '(unnamed)';
            btn.appendChild(prim);

            if (svc.template) {
                var sec = document.createElement('span');
                sec.className = 'item-btn-secondary';
                sec.textContent = svc.template;
                btn.appendChild(sec);
            }

            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-selected', (activeService && activeService.name === svc.name) ? 'true' : 'false');

            btn.addEventListener('click', function() {
                activeService = svc;
                document.querySelectorAll('#svc-list .item-btn').forEach(function(b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                renderDetail(svc);
            });

            li.appendChild(btn);
            frag.appendChild(li);
        });
        ul.appendChild(frag);
    }

    // Service detail = the button-tree experience (template tabs → buttons →
    // entries in a floating grid), not a flat price grid.
    async function renderDetail(svc) {
        var pane = document.getElementById('svc-detail');
        clearElement(pane);

        var wrap = document.createElement('div');
        wrap.className = 'svc-detail-wrap';

        var title = document.createElement('div');
        title.className = 'svc-detail-title';
        title.textContent = svc.name;
        wrap.appendChild(title);

        var metaRow = document.createElement('div');
        metaRow.className = 'svc-meta-row';

        if (svc.template) {
            var tag = document.createElement('span');
            tag.className = 'meta-tag';
            tag.textContent = svc.template;
            metaRow.appendChild(tag);
        }

        if (svc.group) {
            var gTag = document.createElement('span');
            gTag.className = 'meta-tag';
            gTag.textContent = svc.group;
            metaRow.appendChild(gTag);
        }

        wrap.appendChild(metaRow);
        pane.appendChild(wrap);

        await ButtonTree.renderInto(wrap, svc.name);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 3 — Price Lists
   ══════════════════════════════════════════════════════════════ */
PanelControllers.pricelists = (function() {
    var loaded = false;
    var activeList = null;
    var allLists = [];
    var entryTable = null;
    var entryLoader = null;

    async function load() {
        var data = await BridgeClient.getPriceLists();
        allLists = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        allLists.forEach(function(pl) { if (!pl.name && pl.list_name) pl.name = pl.list_name; });
        setMeta('pl-count-badge', String(allLists.length));
        renderList();

        // Build the entries grid once (hidden until a list is selected)
        if (!entryTable) {
            entryTable = makeGrid('#pl-entry-grid', {
                columns: [
                    { title: 'ID',            field: 'product_id',   formatter: idFormatter,
                      headerFilter: 'input',  width: 100 },
                    { title: 'Description',   field: 'description',  formatter: dashFormatter,
                      headerFilter: 'input' },
                    { title: 'Size',          field: 'size',         formatter: dashFormatter,
                      width: 90 },
                    { title: 'Harrison Code', field: 'harrison_code', formatter: dashFormatter,
                      headerFilter: 'input', width: 120 },
                    { title: 'Manufacturer',  field: 'manufacturer', formatter: dashFormatter,
                      headerFilter: 'list',
                      headerFilterParams: { valuesLookup: 'active', clearable: true } },
                    { title: 'Material',      field: 'material',     formatter: dashFormatter,
                      headerFilter: 'list',
                      headerFilterParams: { valuesLookup: 'active', clearable: true } },
                    { title: 'Cost',          field: 'cost',         formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', headerFilter: 'input',
                      headerFilterFunc: '>=', width: 100 },
                    { title: 'Discount Code', field: 'discount_code', formatter: dashFormatter,
                      headerFilter: 'list',
                      headerFilterParams: { valuesLookup: 'active', clearable: true } },
                    { title: 'Units',         field: 'units',        formatter: dashFormatter,
                      headerFilter: 'list',
                      headerFilterParams: { valuesLookup: 'active', clearable: true }, width: 90 }
                ],
                // No initialSort — applied once by the loader's onDone (an
                // active sort re-sorts everything per addData batch: O(n²))
                // Perf: same big-data settings as products (lists can also get very large)
                layout: 'fitColumns',
                columnCalcs: false
            });
            syncCountBadge(entryTable, 'pl-entry-count');
        }
    }

    function renderList() {
        var ul = document.getElementById('pl-list');
        clearElement(ul);

        if (allLists.length === 0) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.className = 'item-btn';
            var prim = document.createElement('span');
            prim.className = 'item-btn-primary';
            prim.style.color = 'var(--pub-text-dim)';
            prim.textContent = 'No price lists loaded';
            btn.appendChild(prim);
            li.appendChild(btn);
            ul.appendChild(li);
            return;
        }

        var frag = document.createDocumentFragment();
        allLists.forEach(function(pl) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.className = 'item-btn';
            btn.setAttribute('role', 'option');
            if (activeList && activeList.name === pl.name) {
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
            } else {
                btn.setAttribute('aria-selected', 'false');
            }

            var prim = document.createElement('span');
            prim.className = 'item-btn-primary';
            prim.textContent = pl.name || '(unnamed)';
            btn.appendChild(prim);

            var sec = document.createElement('span');
            sec.className = 'item-btn-secondary';
            var secParts = [];
            if (pl.supplier_group) secParts.push(pl.supplier_group);
            if (pl.entry_count !== undefined) secParts.push(pl.entry_count.toLocaleString() + ' entries');
            sec.textContent = secParts.join(' • ');
            btn.appendChild(sec);

            btn.addEventListener('click', function() {
                activeList = pl;
                document.querySelectorAll('#pl-list .item-btn').forEach(function(b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                renderDetail(pl);
            });

            li.appendChild(btn);
            frag.appendChild(li);
        });
        ul.appendChild(frag);
    }

    function renderDetail(pl) {
        var detail = document.getElementById('pl-detail');
        var entriesArea = document.getElementById('pl-entries-area');

        clearElement(detail);

        var wrap = document.createElement('div');
        wrap.className = 'pl-detail-wrap';

        var title = document.createElement('div');
        title.className = 'pl-detail-title';
        title.textContent = pl.name;
        wrap.appendChild(title);

        var statsRow = document.createElement('div');
        statsRow.className = 'pl-stats-row';

        function addStat(val, label) {
            var s = document.createElement('div');
            s.className = 'pl-stat';
            var sv = document.createElement('div');
            sv.className = 'pl-stat-value';
            sv.textContent = val;
            var sl = document.createElement('div');
            sl.className = 'pl-stat-label';
            sl.textContent = label;
            s.appendChild(sv);
            s.appendChild(sl);
            statsRow.appendChild(s);
        }

        if (pl.supplier_group) addStat(pl.supplier_group, 'Supplier Group');
        if (pl.entry_count !== undefined) addStat(pl.entry_count.toLocaleString(), 'Entries');
        if (pl.last_updated) addStat(pl.last_updated, 'Last Updated');

        wrap.appendChild(statsRow);
        detail.appendChild(wrap);

        entriesArea.classList.remove('hidden');

        // Wire search input → applyQuickFilter on already-loaded data
        // (server-side re-fetch on Load button for fresh data)
        var searchInput = document.getElementById('pl-entry-search');
        var loadBtn = document.getElementById('pl-entry-load-btn');

        // Clone to drop any previous list's listeners
        var newSearch = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearch, searchInput);
        var newLoadBtn = loadBtn.cloneNode(true);
        loadBtn.parentNode.replaceChild(newLoadBtn, loadBtn);

        // Quick filter: client-side over already-loaded entries
        newSearch.addEventListener('input', function() {
            applyQuickFilter(entryTable, this.value.trim());
        });

        // Load button: cancel existing load + start fresh progressive load for this list
        newLoadBtn.addEventListener('click', function() {
            applyQuickFilter(entryTable, '');
            newSearch.value = '';
            startEntryLoad(pl);
        });

        // Auto-load entries when online
        if (BridgeClient.isOnline()) startEntryLoad(pl);

        // Ensure grid renders after entriesArea becomes visible
        if (entryTable) entryTable.redraw(true);
    }

    function startEntryLoad(pl) {
        if (entryLoader) { entryLoader.cancel(); entryLoader = null; }
        var lbl = document.getElementById('pl-entry-count');
        entryLoader = new PubProgressLoader(entryTable, lbl, 'Entries');

        // A price list is identified by supplier_group + list_name TOGETHER —
        // two different lists can share a name (e.g. a supplier price list
        // exists under two supplier groups; name-only filtering merged them
        // into one combined grid). The bridge filter is SUBSTRING match, so
        // even supplier_group can over-match when one group's name is a
        // prefix of another's — fetch server-narrowed pages, keep EXACT
        // matches only, and trust the list's own entry_count as the
        // authoritative total. Raw page offsets are tracked separately
        // from the filtered count the loader accumulates.
        var rawOffset = 0;
        function fetchExact(limit) {
            return (async function() {
                var out = [];
                while (out.length === 0) {
                    var page = await BridgeClient.getPriceEntries(pl.name, pl.supplier_group, '', limit, rawOffset);
                    var rows = (page && page.data) ? page.data : [];
                    if (rows.length === 0) return { data: [], total: pl.entry_count };
                    rawOffset += rows.length;
                    for (var i = 0; i < rows.length; i++) {
                        if (rows[i].supplier_group === pl.supplier_group && rows[i].list_name === pl.name) {
                            out.push(rows[i]);
                        }
                    }
                }
                return { data: out, total: pl.entry_count };
            })();
        }
        entryLoader.start(fetchExact, undefined, function() {
            // Sort ONCE on completion — sorting during load is O(n²) per batch
            entryTable.setSort('product_id', 'asc');
        });
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; load(); }
            else if (entryTable) { entryTable.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 4 — Cost Estimate
   ══════════════════════════════════════════════════════════════ */
var EstimatePanel = (function() {
    var loaded = false;
    var basket = [];  // { product: {...}, qty: N, multiplier: 0.82 }
    var DEFAULT_MULTIPLIER = 0.82;
    var basketTable = null;
    var resultTable = null;

    function init() {
        // Basket grid — no initialSort (insertion order is deliberate user curation).
        // R2 note: qty/multiplier render as read-only values this round; the
        // panel-level number inputs below the grid handle adjustments.
        // Deliberate contract exception: basket preserves insertion order.
        basketTable = makeGrid('#est-basket-grid', {
            columns: [
                { title: 'Description', field: 'description', formatter: dashFormatter },
                { title: 'Qty',         field: 'qty',         sorter: 'number',
                  hozAlign: 'right', width: 70 },
                { title: 'Unit Cost',   field: 'unit_cost',   formatter: moneyFormatter,
                  sorter: 'number', hozAlign: 'right', width: 110 },
                { title: 'Multiplier',  field: 'multiplier',  sorter: 'number',
                  hozAlign: 'right', width: 100,
                  formatter: function(cell) {
                      var v = parseFloat(cell.getValue());
                      return isNaN(v) ? '—' : (v * 100).toFixed(0) + '%';
                  }
                },
                { title: 'Line Total',  field: 'line_total',  formatter: moneyFormatter,
                  sorter: 'number', hozAlign: 'right', width: 120,
                  bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter
                },
                { title: '',            field: '_remove',     width: 44, hozAlign: 'center',
                  headerSort: false,
                  formatter: function() {
                      return '<button class="btn-remove" title="Remove" aria-label="Remove from estimate">&times;</button>';
                  },
                  cellClick: function(e, cell) {
                      var rowData = cell.getRow().getData();
                      removeItem(rowData._idx);
                  }
                }
            ]
            // No initialSort — basket keeps insertion order (deliberate exception)
        });

        // Result grid
        resultTable = makeGrid('#est-result-grid', {
            columns: [
                { title: 'Product',    field: 'description', formatter: dashFormatter },
                { title: 'Qty',        field: 'qty',         sorter: 'number',
                  hozAlign: 'right', width: 70 },
                { title: 'Unit Cost',  field: 'unit_cost',   formatter: moneyFormatter,
                  sorter: 'number', hozAlign: 'right', width: 110 },
                { title: 'Multiplier', field: 'multiplier',  sorter: 'number',
                  hozAlign: 'right', width: 100,
                  formatter: function(cell) {
                      var v = parseFloat(cell.getValue());
                      return isNaN(v) ? '—' : (v * 100).toFixed(0) + '%';
                  }
                },
                { title: 'Net Unit',   field: 'net_unit',    formatter: moneyFormatter,
                  sorter: 'number', hozAlign: 'right', width: 110 },
                { title: 'Line Total', field: 'line_total',  formatter: moneyFormatter,
                  sorter: 'number', hozAlign: 'right', width: 120,
                  bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter
                }
            ],
            initialSort: [{ column: 'description', dir: 'asc' }]
        });

        document.getElementById('est-search-btn').addEventListener('click', runSearch);
        document.getElementById('est-search-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') runSearch();
        });
        document.getElementById('est-clear-btn').addEventListener('click', clearBasket);
        document.getElementById('est-run-btn').addEventListener('click', runEstimate);
    }

    async function runSearch() {
        var q = document.getElementById('est-search-input').value.trim();
        var container = document.getElementById('est-pick-results');
        clearElement(container);

        var loadingP = document.createElement('p');
        loadingP.style.cssText = 'padding:12px;color:var(--pub-text-muted);font-size:12px;';
        loadingP.textContent = 'Searching…';
        container.appendChild(loadingP);

        var data = await BridgeClient.getProducts(q, 50, 0);
        var rows = (data && data.data) ? data.data : [];

        clearElement(container);

        if (rows.length === 0) {
            var noRes = document.createElement('p');
            noRes.style.cssText = 'padding:12px;color:var(--pub-text-dim);font-size:12px;';
            noRes.textContent = 'No results.';
            container.appendChild(noRes);
            return;
        }

        var frag = document.createDocumentFragment();
        rows.forEach(function(p) {
            var item = document.createElement('div');
            item.className = 'pick-item';
            item.setAttribute('role', 'option');
            item.setAttribute('tabindex', '0');

            var textWrap = document.createElement('div');
            textWrap.className = 'pick-item-text';

            var desc = document.createElement('span');
            desc.className = 'pick-item-desc';
            desc.textContent = p.description || p.id || '(unknown)';
            textWrap.appendChild(desc);

            var meta = document.createElement('span');
            meta.className = 'pick-item-meta';
            var metaParts = [];
            if (p.size) metaParts.push(p.size);
            if (p.material) metaParts.push(p.material);
            if (p.cost !== undefined && p.cost !== null && p.cost !== '') metaParts.push(fmt(p.cost));
            meta.textContent = metaParts.join(' · ');
            textWrap.appendChild(meta);

            item.appendChild(textWrap);

            var addBtn = document.createElement('button');
            addBtn.className = 'pick-item-add';
            addBtn.title = 'Add to estimate';
            addBtn.setAttribute('aria-label', 'Add to estimate: ' + (p.description || p.id));
            addBtn.textContent = '+';

            addBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                addProduct(p);
            });

            item.addEventListener('click', function() { addProduct(p); });
            item.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addProduct(p); }
            });

            item.appendChild(addBtn);
            frag.appendChild(item);
        });
        container.appendChild(frag);
    }

    function addProduct(p) {
        var existing = basket.find(function(b) { return b.product.id === p.id; });
        if (existing) {
            existing.qty++;
        } else {
            basket.push({ product: p, qty: 1, multiplier: DEFAULT_MULTIPLIER });
        }
        renderBasket();
        document.getElementById('est-result-card').classList.add('hidden');
        var note = document.getElementById('est-result-note');
        if (note) note.style.display = 'none';
    }

    function clearBasket() {
        basket = [];
        renderBasket();
        document.getElementById('est-result-card').classList.add('hidden');
        var note = document.getElementById('est-result-note');
        if (note) note.style.display = 'none';
    }

    function removeItem(idx) {
        basket.splice(idx, 1);
        renderBasket();
        document.getElementById('est-result-card').classList.add('hidden');
        var note = document.getElementById('est-result-note');
        if (note) note.style.display = 'none';
    }

    function renderBasket() {
        var emptyDiv = document.getElementById('est-basket-empty');
        var totalsBar = document.getElementById('est-totals');
        var runRow = document.getElementById('est-run-row');

        if (basket.length === 0) {
            emptyDiv.classList.remove('hidden');
            totalsBar.classList.add('hidden');
            runRow.classList.add('hidden');
            basketTable.setData([]);
            return;
        }

        emptyDiv.classList.add('hidden');
        totalsBar.classList.remove('hidden');
        runRow.classList.remove('hidden');

        var grandTotal = 0;
        var rows = basket.map(function(item, idx) {
            var p = item.product;
            var unitCost = (p.cost !== null && p.cost !== undefined && p.cost !== '') ? parseFloat(p.cost) : 0;
            var lineTotal = unitCost * item.qty * item.multiplier;
            grandTotal += lineTotal;
            return {
                _idx:        idx,
                description: p.description || p.id || '—',
                qty:         item.qty,
                unit_cost:   unitCost || null,
                multiplier:  item.multiplier,
                line_total:  unitCost > 0 ? lineTotal : null
            };
        });

        basketTable.setData(rows);
        document.getElementById('est-total-value').textContent = fmt(grandTotal);
    }

    function runEstimate() {
        if (basket.length === 0) return;

        var resultCard = document.getElementById('est-result-card');
        resultCard.classList.remove('hidden');

        var rows = basket.map(function(item) {
            var p = item.product;
            var unitCost = (p.cost !== null && p.cost !== undefined && p.cost !== '') ? parseFloat(p.cost) : 0;
            var netUnit = unitCost * item.multiplier;
            var lineTotal = netUnit * item.qty;
            return {
                description: p.description || p.id || '—',
                qty:         item.qty,
                unit_cost:   unitCost || null,
                multiplier:  item.multiplier,
                net_unit:    unitCost > 0 ? netUnit : null,
                line_total:  unitCost > 0 ? lineTotal : null
            };
        });

        resultTable.setData(rows);
        resultTable.redraw(true);

        var note = document.getElementById('est-result-note');
        if (note) note.style.display = '';
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); }
            else {
                if (basketTable) basketTable.redraw(true);
                if (resultTable) resultTable.redraw(true);
            }
        },
        addProduct: addProduct
    };
})();

PanelControllers.estimate = EstimatePanel;

/* ══════════════════════════════════════════════════════════════
   Panel 5 — EST Jobs
   ══════════════════════════════════════════════════════════════ */
PanelControllers.est = (function() {
    var state = 'unknown';
    var allJobs = [];
    var activeJob = null;
    var summaryTable = null;  // Tabulator instance for EST job summary (dynamic)
    var spoolsTable = null;   // Tabulator instance for the spools rollup (dynamic)

    async function probe() {
        var result = await BridgeClient.mcpCall('est_list_jobs', {});
        return (result !== null && !result.error);
    }

    async function init() {
        document.getElementById('est-retry-btn').addEventListener('click', function() {
            load();
        });
        document.getElementById('est-refresh-btn').addEventListener('click', function() {
            loadJobs();
        });
        await load();
    }

    async function load() {
        var connected = await probe();
        var offlineDiv = document.getElementById('est-mcp-offline');
        var jobsArea = document.getElementById('est-jobs-area');

        if (!connected) {
            offlineDiv.classList.remove('hidden');
            jobsArea.classList.add('hidden');
            state = 'offline';
            return;
        }

        state = 'connected';
        offlineDiv.classList.add('hidden');
        jobsArea.classList.remove('hidden');
        await loadJobs();
    }

    async function loadJobs() {
        var result = await BridgeClient.mcpCall('est_list_jobs', {});
        if (!result || result.error) {
            allJobs = [];
        } else {
            allJobs = Array.isArray(result) ? result : (result.jobs || []);
        }

        setMeta('est-job-count', String(allJobs.length));
        renderJobList();
    }

    function renderJobList() {
        var ul = document.getElementById('est-job-list');
        clearElement(ul);

        if (allJobs.length === 0) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.className = 'item-btn';
            var prim = document.createElement('span');
            prim.className = 'item-btn-primary';
            prim.style.color = 'var(--pub-text-dim)';
            prim.textContent = 'No jobs loaded';
            btn.appendChild(prim);
            var sec = document.createElement('span');
            sec.className = 'item-btn-secondary';
            sec.textContent = 'Use est_load_job to load an estimate.txt';
            btn.appendChild(sec);
            li.appendChild(btn);
            ul.appendChild(li);
            return;
        }

        var frag = document.createDocumentFragment();
        allJobs.forEach(function(job) {
            var jobName = job.job_name || job.job_file_name || '(unnamed)';
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.className = 'item-btn';
            btn.setAttribute('role', 'option');
            if (activeJob && activeJob.job_file_name === job.job_file_name) {
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
            } else {
                btn.setAttribute('aria-selected', 'false');
            }

            var prim = document.createElement('span');
            prim.className = 'item-btn-primary';
            prim.textContent = jobName;
            btn.appendChild(prim);

            var sec = document.createElement('span');
            sec.className = 'item-btn-secondary';
            var secParts = [];
            if (job.item_count !== undefined) secParts.push(job.item_count + ' items');
            if (job.job_date) secParts.push(job.job_date);
            sec.textContent = secParts.join(' • ');
            btn.appendChild(sec);

            btn.addEventListener('click', function() {
                activeJob = job;
                document.querySelectorAll('#est-job-list .item-btn').forEach(function(b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                renderJobDetail(job);
            });

            li.appendChild(btn);
            frag.appendChild(li);
        });
        ul.appendChild(frag);
    }

    async function renderJobDetail(job) {
        var detailPane = document.getElementById('est-job-detail');
        // Destroy prior dynamic tables
        if (summaryTable) { try { summaryTable.destroy(); } catch(e) {} summaryTable = null; }
        if (spoolsTable)  { try { spoolsTable.destroy(); }  catch(e) {} spoolsTable = null; }
        clearElement(detailPane);

        var wrap = document.createElement('div');
        wrap.className = 'job-detail-wrap';

        var title = document.createElement('div');
        title.className = 'job-detail-title';
        title.textContent = job.job_name || job.job_file_name || '(unnamed)';
        wrap.appendChild(title);

        var metaGrid = document.createElement('div');
        metaGrid.className = 'job-meta-grid';

        function addMeta(label, value) {
            if (value === undefined || value === null || value === '') return;
            var item = document.createElement('div');
            item.className = 'job-meta-item';
            var lbl = document.createElement('div');
            lbl.className = 'job-meta-label';
            lbl.textContent = label;
            var val = document.createElement('div');
            val.className = 'job-meta-value';
            val.textContent = String(value);
            item.appendChild(lbl);
            item.appendChild(val);
            metaGrid.appendChild(item);
        }

        addMeta('Job File', job.job_file_name);
        addMeta('Job Date', job.job_date);
        addMeta('Items', job.item_count);
        addMeta('Ancillaries', job.ancillary_count);
        addMeta('TFC Items', job.tfc_count);
        addMeta('Customer', job.customer);
        wrap.appendChild(metaGrid);

        var summaryTitle = document.createElement('div');
        summaryTitle.className = 'job-section-title';
        summaryTitle.textContent = 'Service Summary';
        wrap.appendChild(summaryTitle);

        var loadingP = document.createElement('p');
        loadingP.style.cssText = 'font-size:12px;color:var(--pub-text-muted);';
        loadingP.textContent = 'Loading summary…';
        wrap.appendChild(loadingP);
        detailPane.appendChild(wrap);

        var summary = await BridgeClient.mcpCall('est_job_summary', { job_file_name: job.job_file_name });
        if (activeJob !== job) return;   // a newer selection took over mid-flight

        wrap.removeChild(loadingP);

        var rows = [];
        if (summary && !summary.error) {
            // Live shape (verified Jun 5): { job_file_name, service_count, services: [...] }
            rows = Array.isArray(summary) ? summary : (summary.services || summary.rows || summary.data || []);
        }

        if (rows.length > 0) {
            var mountEl = document.createElement('div');
            mountEl.className = 'pub-grid';
            mountEl.style.cssText = 'height:280px;';

            var gridWrap = document.createElement('div');
            gridWrap.className = 'grid-wrap';
            gridWrap.appendChild(mountEl);
            wrap.appendChild(gridWrap);

            var tableRows = rows.map(function(r) {
                return {
                    service:      r.service || r.service_abbr || '',
                    item_count:   r.item_count !== undefined ? r.item_count : null,
                    material:     r.total_material !== undefined ? r.total_material : null,
                    fab_cost:     r.total_fab_cost !== undefined ? r.total_fab_cost : null,
                    field_cost:   r.total_field_cost !== undefined ? r.total_field_cost : null,
                    total:        r.total_cost !== undefined ? r.total_cost : null,
                    fab_hrs:      r.fab_hours !== undefined ? r.fab_hours : null,
                    install_hrs:  r.install_hours !== undefined ? r.install_hours : null
                };
            });

            summaryTable = makeGrid(mountEl, {
                data: tableRows,
                columns: [
                    { title: 'Service',      field: 'service',     formatter: dashFormatter,
                      headerFilter: 'input' },
                    { title: 'Items',        field: 'item_count',  sorter: 'number',
                      hozAlign: 'right', width: 70,
                      bottomCalc: 'sum' },
                    { title: 'Material',     field: 'material',    formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', width: 110,
                      bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter },
                    { title: 'Fab Cost',     field: 'fab_cost',    formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', width: 110,
                      bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter },
                    { title: 'Field Cost',   field: 'field_cost',  formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', width: 110,
                      bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter },
                    { title: 'Total',        field: 'total',       formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', width: 120,
                      bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter },
                    { title: 'Fab Hrs',      field: 'fab_hrs',     sorter: 'number',
                      hozAlign: 'right', width: 90,
                      bottomCalc: 'sum' },
                    { title: 'Install Hrs',  field: 'install_hrs', sorter: 'number',
                      hozAlign: 'right', width: 100,
                      bottomCalc: 'sum' }
                ],
                initialSort: [{ column: 'service', dir: 'asc' }]
            });
        } else {
            var noSum = document.createElement('p');
            noSum.style.cssText = 'font-size:12px;color:var(--pub-text-muted);padding:12px 0;';
            noSum.textContent = 'No summary data available for this job.';
            wrap.appendChild(noSum);
        }

        // ── Spools (est_spool_analysis) — per-spool cost/labor rollup ─────
        // Public sourcing note: spools ride /rpc EST data here.
        var spoolTitle = document.createElement('div');
        spoolTitle.className = 'job-section-title';
        spoolTitle.textContent = 'Spools';
        wrap.appendChild(spoolTitle);

        var spoolLoading = document.createElement('p');
        spoolLoading.style.cssText = 'font-size:12px;color:var(--pub-text-muted);';
        spoolLoading.textContent = 'Loading spools…';
        wrap.appendChild(spoolLoading);

        var spoolRes = await BridgeClient.mcpCall('est_spool_analysis', { job_file_name: job.job_file_name });
        if (activeJob !== job) return;   // a newer selection took over mid-flight
        wrap.removeChild(spoolLoading);

        var spools = (spoolRes && !spoolRes.error) ? (spoolRes.spools || []) : [];
        if (spools.length > 0) {
            // Resolved height on the WRAPPER (recipe rule #1)
            var spoolWrap = document.createElement('div');
            spoolWrap.className = 'grid-wrap';
            spoolWrap.style.cssText = 'height:320px;';
            var spoolMount = document.createElement('div');
            spoolMount.className = 'pub-grid';
            spoolWrap.appendChild(spoolMount);
            wrap.appendChild(spoolWrap);

            spoolsTable = makeGrid(spoolMount, {
                data: spools,
                columns: [
                    { title: 'Spool',       field: 'spool',            formatter: dashFormatter,
                      headerFilter: 'input' },
                    { title: 'Items',       field: 'item_count',       sorter: 'number',
                      hozAlign: 'right', width: 70, bottomCalc: 'sum' },
                    { title: 'Material',    field: 'total_material',   formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', width: 110,
                      bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter },
                    { title: 'Field Cost',  field: 'total_field_cost', formatter: moneyFormatter,
                      sorter: 'number', hozAlign: 'right', width: 110,
                      bottomCalc: 'sum', bottomCalcFormatter: moneyFormatter },
                    { title: 'Weight',      field: 'total_weight',     sorter: 'number',
                      hozAlign: 'right', width: 90, bottomCalc: 'sum' },
                    { title: 'Install Hrs', field: 'install_hours',    sorter: 'number',
                      hozAlign: 'right', width: 100, bottomCalc: 'sum' },
                    { title: 'Statused',    field: 'items_with_status', sorter: 'number',
                      hozAlign: 'right', width: 90 }
                ],
                initialSort: [{ column: 'spool', dir: 'asc' }]
            });
        } else {
            var noSp = document.createElement('p');
            noSp.style.cssText = 'font-size:12px;color:var(--pub-text-muted);padding:12px 0;';
            noSp.textContent = 'No spool data for this job.';
            wrap.appendChild(noSp);
        }
    }

    var initDone = false;
    return {
        onActivate: function() {
            if (!initDone) { initDone = true; init(); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 6 — Materials
   ══════════════════════════════════════════════════════════════ */
PanelControllers.materials = (function() {
    var loaded = false;
    var table = null;

    function init() {
        table = makeGrid('#mat-grid', {
            columns: [
                { title: 'Group',   field: 'group',       formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Name',    field: 'name',        formatter: dashFormatter,
                  headerFilter: 'input' },
                { title: 'Gauges',  field: 'gauge_count', sorter: 'number',
                  hozAlign: 'right', width: 90 }
            ],
            initialSort: [{ column: 'group', dir: 'asc' }, { column: 'name', dir: 'asc' }]
        });
        syncCountBadge(table, 'mat-count-badge');

        document.getElementById('mat-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    async function load() {
        var data = await BridgeClient.getMaterials();
        var rows = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        table.setData(rows);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 7 — Sections
   ══════════════════════════════════════════════════════════════ */
PanelControllers.sections = (function() {
    var loaded = false;
    var table = null;

    function init() {
        table = makeGrid('#sec-grid', {
            columns: [
                { title: 'Index', field: 'index', sorter: 'number',
                  hozAlign: 'right', width: 90 },
                { title: 'Name',  field: 'name',  formatter: dashFormatter,
                  headerFilter: 'input' }
            ],
            initialSort: [{ column: 'name', dir: 'asc' }]
        });
        syncCountBadge(table, 'sec-count-badge');

        document.getElementById('sec-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    async function load() {
        var data = await BridgeClient.getSections();
        var rows = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        table.setData(rows);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 8 — Specifications
   ══════════════════════════════════════════════════════════════ */
PanelControllers.specifications = (function() {
    var loaded = false;
    var table = null;

    function init() {
        table = makeGrid('#spec-grid', {
            columns: [
                { title: 'Name', field: 'name', formatter: dashFormatter,
                  headerFilter: 'input' }
            ],
            initialSort: [{ column: 'name', dir: 'asc' }]
        });
        syncCountBadge(table, 'spec-count-badge');

        document.getElementById('spec-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    async function load() {
        var data = await BridgeClient.getSpecifications();
        var rows = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        table.setData(rows);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 9 — Statuses
   Two grids: Item Statuses + Job Statuses.
   Filter input applies applyQuickFilter to both.
   ══════════════════════════════════════════════════════════════ */
PanelControllers.statuses = (function() {
    var loaded = false;
    var itemTable = null;
    var jobTable = null;
    var allItemStatuses = [];
    var allJobStatuses  = [];

    // Status columns shared by both sub-grids
    function statusCols() {
        return [
            { title: 'Index',     field: 'index',     sorter: 'number',
              hozAlign: 'right', width: 80 },
            { title: 'Name',      field: 'name',      formatter: dashFormatter,
              headerFilter: 'input' },
            { title: 'Color',     field: 'color',     formatter: aciChipFormatter,
              headerFilter: 'list',
              headerFilterParams: { valuesLookup: 'active', clearable: true }, width: 90 },
            { title: 'Layer Tag', field: 'layer_tag', formatter: dashFormatter,
              headerFilter: 'input' },
            { title: 'Output',    field: 'output',    width: 80, hozAlign: 'center',
              formatter: function(cell) {
                  var v = cell.getValue();
                  return v ? '<span style="color:var(--pub-ok)">&#10003;</span>' : '<span class="pub-dash">—</span>';
              }
            }
        ];
    }

    function init() {
        itemTable = makeGrid('#status-item-grid', {
            columns: statusCols(),
            initialSort: [{ column: 'name', dir: 'asc' }],
            placeholder: 'No item statuses defined in this database.'
        });

        jobTable = makeGrid('#status-job-grid', {
            columns: statusCols(),
            initialSort: [{ column: 'name', dir: 'asc' }],
            placeholder: 'No job statuses defined in this database.'
        });

        // Combined badge wired manually (two tables → one badge)
        itemTable.on('dataFiltered', updateCombinedBadge);
        itemTable.on('dataLoaded',   updateCombinedBadge);
        jobTable.on('dataFiltered',  updateCombinedBadge);
        jobTable.on('dataLoaded',    updateCombinedBadge);

        document.getElementById('status-filter').addEventListener('input', function() {
            var q = this.value.trim();
            applyQuickFilter(itemTable, q);
            applyQuickFilter(jobTable, q);
        });
    }

    function updateCombinedBadge() {
        var itemCount = itemTable ? itemTable.getDataCount('active') : 0;
        var jobCount  = jobTable  ? jobTable.getDataCount('active')  : 0;
        setMeta('status-count-badge', String(itemCount + jobCount));
    }

    async function load() {
        var itemData = await BridgeClient.getItemStatuses();
        var jobData  = await BridgeClient.getJobStatuses();

        allItemStatuses = (itemData && itemData.data) ? itemData.data : [];
        allJobStatuses  = (jobData  && jobData.data)  ? jobData.data  : [];

        // Normalize job status shape: {index, description, active} → {index, name, color, layer_tag, output}
        allJobStatuses = allJobStatuses.map(function(r) {
            return { index: r.index, name: r.description || '', color: '',
                     layer_tag: '', output: !!r.active };
        });

        itemTable.setData(allItemStatuses);
        jobTable.setData(allJobStatuses);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else {
                if (itemTable) itemTable.redraw(true);
                if (jobTable)  jobTable.redraw(true);
            }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 10 — Service Types
   ══════════════════════════════════════════════════════════════ */
PanelControllers.servicetypes = (function() {
    var loaded = false;
    var table = null;

    // Strip the "  N: " prefix baked into CADmep's description strings.
    function trimDesc(raw) {
        if (!raw) return '';
        return raw.replace(/^\s*\d+:\s*/, '').trim() || raw.trim();
    }

    function init() {
        table = makeGrid('#svctype-grid', {
            columns: [
                { title: 'ID',          field: 'id',          sorter: 'number',
                  hozAlign: 'right', width: 80 },
                { title: 'Description', field: 'description',
                  headerFilter: 'input',
                  // Strip the "  N: " prefix for display. Formatter output goes
                  // to innerHTML — bridge strings MUST pass _pubEsc (codebro P1).
                  formatter: function(cell) {
                      var trimmed = trimDesc(cell.getValue());
                      return trimmed ? _pubEsc(trimmed) : '<span class="pub-dash">—</span>';
                  }
                }
            ],
            initialSort: [{ column: 'description', dir: 'asc' }]
        });
        syncCountBadge(table, 'svctype-count-badge');

        document.getElementById('svctype-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    async function load() {
        var data = await BridgeClient.getServiceTypes();
        var rows = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        table.setData(rows);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 10b — Ancillaries
   Thin shape from /api/ancillaries: type + cost/time sources.
   Columns ordered coarse→fine (type leads at 5 distinct values).
   price_list field omitted — bridge serializes the .NET type name,
   not the list name (bridge backlog: expose PriceList.Name).
   ══════════════════════════════════════════════════════════════ */
PanelControllers.ancillaries = (function() {
    var loaded = false;
    var table = null;

    function init() {
        var listFilter = { headerFilter: 'list',
                           headerFilterParams: { valuesLookup: 'active', clearable: true } };
        table = makeGrid('#anc-grid', {
            columns: [
                { title: 'Type',         field: 'ancillary_type',    formatter: dashFormatter,
                  headerFilter: listFilter.headerFilter, headerFilterParams: listFilter.headerFilterParams },
                { title: 'Cost Source',  field: 'cost_type',         formatter: dashFormatter,
                  headerFilter: listFilter.headerFilter, headerFilterParams: listFilter.headerFilterParams },
                { title: 'Fab Time',     field: 'fab_time_type',     formatter: dashFormatter,
                  headerFilter: listFilter.headerFilter, headerFilterParams: listFilter.headerFilterParams },
                { title: 'Install Time', field: 'install_time_type', formatter: dashFormatter,
                  headerFilter: listFilter.headerFilter, headerFilterParams: listFilter.headerFilterParams },
                { title: 'Editable',     field: 'can_change',        width: 90, hozAlign: 'center',
                  formatter: function(cell) {
                      var v = cell.getValue();
                      return v ? '<span style="color:var(--pub-ok)">&#10003;</span>' : '<span class="pub-dash">—</span>';
                  }
                }
            ],
            initialSort: [{ column: 'ancillary_type', dir: 'asc' }]
        });
        syncCountBadge(table, 'anc-count-badge');

        document.getElementById('anc-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    async function load() {
        var data = await BridgeClient.getAncillaries();
        var rows = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        table.setData(rows);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 10c — Service Templates
   Thin wrapper over the shared ButtonTree: distinct templates
   from the services list (the tree route is service-keyed, so
   each template entry rides on its first service).
   ══════════════════════════════════════════════════════════════ */
PanelControllers.templates = (function() {
    var loaded = false;
    var groups = [];          // [{template, services: [svc, ...]}]
    var activeTemplate = null;

    function init() {
        document.getElementById('tmpl-filter').addEventListener('input', function() {
            renderList(this.value.trim().toLowerCase());
        });
    }

    async function load() {
        var data = await BridgeClient.getServices();
        var services = Array.isArray(data) ? data : (data && data.data ? data.data : []);
        var byTemplate = {};
        services.forEach(function(s) {
            if (!s.template) return;
            if (!byTemplate[s.template]) byTemplate[s.template] = [];
            byTemplate[s.template].push(s);
        });
        groups = Object.keys(byTemplate).sort().map(function(t) {
            return { template: t, services: byTemplate[t] };
        });
        renderList('');
    }

    function renderList(filter) {
        var ul = document.getElementById('tmpl-list');
        var emptyDiv = document.getElementById('tmpl-list-empty');
        clearElement(ul);

        var items = filter ? groups.filter(function(g) {
            return g.template.toLowerCase().indexOf(filter) !== -1;
        }) : groups;

        setMeta('tmpl-count-badge', String(items.length));

        if (items.length === 0) { emptyDiv.classList.remove('hidden'); return; }
        emptyDiv.classList.add('hidden');

        var frag = document.createDocumentFragment();
        items.forEach(function(g) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.className = 'item-btn';
            if (activeTemplate === g.template) btn.classList.add('active');

            var prim = document.createElement('span');
            prim.className = 'item-btn-primary';
            prim.textContent = g.template;
            btn.appendChild(prim);

            var sec = document.createElement('span');
            sec.className = 'item-btn-secondary';
            sec.textContent = g.services.length + ' service' + (g.services.length === 1 ? '' : 's') +
                ' — ' + g.services.map(function(s) { return s.name; }).slice(0, 3).join(', ') +
                (g.services.length > 3 ? '…' : '');
            btn.appendChild(sec);

            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-selected', activeTemplate === g.template ? 'true' : 'false');

            btn.addEventListener('click', function() {
                activeTemplate = g.template;
                document.querySelectorAll('#tmpl-list .item-btn').forEach(function(b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                renderDetail(g);
            });

            li.appendChild(btn);
            frag.appendChild(li);
        });
        ul.appendChild(frag);
    }

    async function renderDetail(g) {
        var pane = document.getElementById('tmpl-detail');
        clearElement(pane);

        var wrap = document.createElement('div');
        wrap.className = 'svc-detail-wrap';

        var title = document.createElement('div');
        title.className = 'svc-detail-title';
        title.textContent = g.template;
        wrap.appendChild(title);

        var metaRow = document.createElement('div');
        metaRow.className = 'svc-meta-row';
        g.services.slice(0, 6).forEach(function(s) {
            var tag = document.createElement('span');
            tag.className = 'meta-tag';
            tag.textContent = s.name;
            metaRow.appendChild(tag);
        });
        wrap.appendChild(metaRow);
        pane.appendChild(wrap);

        // Tree route is service-keyed — any service sharing the template shows it
        if (!g.services.length || !g.services[0].name) {
            var none = el('p', null, 'No services available for this template.');
            none.style.cssText = 'color:var(--pub-text-muted);font-size:12px;';
            wrap.appendChild(none);
            return;
        }
        await ButtonTree.renderInto(wrap, g.services[0].name);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 12 — Install Times
   Table list (a mix of breakpoint and simple types) → type-aware
   detail: breakpoint tables render a heat-mapped size×size matrix;
   simple tables render their labor entries grid. Identity is
   (name, group) — some names collide across material groups.
   ══════════════════════════════════════════════════════════════ */
PanelControllers.installtimes = (function() {
    var loaded = false;
    var listTable = null;
    var detailTable = null;   // entries Tabulator (simple tables)
    var entryLoader = null;   // progressive loader for big entry sets

    function destroyDetail() {
        if (entryLoader) { entryLoader.cancel(); entryLoader = null; }
        if (detailTable) { try { detailTable.destroy(); } catch(e) {} detailTable = null; }
    }

    function init() {
        // Collapsible tree by TYPE — Tabulator groupBy with
        // header toggles; group column stays filterable inside each fold.
        listTable = makeGrid('#it-list-grid', {
            groupBy: 'type',
            groupToggleElement: 'header',
            groupHeader: function(value, count) {
                return _pubEsc(String(value)) +
                    ' <span style="color:var(--pub-text-muted)">(' + count.toLocaleString() + ' tables)</span>';
            },
            columns: [
                { title: 'Group',   field: 'group', width: 170, formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Name',    field: 'name',  formatter: dashFormatter,
                  headerFilter: 'input' },
                { title: 'Entries', field: 'entry_count', sorter: 'number',
                  hozAlign: 'right', width: 80 }
            ],
            initialSort: [
                { column: 'name', dir: 'asc' },
                { column: 'group', dir: 'asc' }
            ]
        });
        syncCountBadge(listTable, 'it-count-badge');

        listTable.on('rowClick', function(e, row) {
            renderDetail(row.getData());
        });

        document.getElementById('it-filter').addEventListener('input', function() {
            applyQuickFilter(listTable, this.value.trim());
        });

        initSplitResize();
    }

    // ── Resizable ribbon: drag the divider to widen the table list so long
    //    names fit. Width is session-local.
    function initSplitResize() {
        var handle = document.getElementById('it-split-resizer');
        var left = document.getElementById('it-split-left');
        if (!handle || !left) return;
        var drag = null;
        handle.addEventListener('pointerdown', function(e) {
            drag = { x: e.clientX, w: left.getBoundingClientRect().width };
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', function(e) {
            if (!drag) return;
            var w = Math.min(Math.max(drag.w + (e.clientX - drag.x), 220), window.innerWidth * 0.7);
            left.style.flex = '0 0 ' + w + 'px';
            if (listTable) listTable.redraw();
        });
        function endDrag() { drag = null; }
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
        handle.addEventListener('lostpointercapture', endDrag);
    }

    async function load() {
        var data = await BridgeClient.getInstallTables();
        var rows = Array.isArray(data) ? data : (data && data.data ? data.data : []);
        listTable.setData(rows);
    }

    // ── Heat wash: interpolate the live theme's accent pair ──────────────
    function accentRgb(varName) {
        var v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        var m = v.match(/^#?([0-9a-f]{6})$/i);
        if (m) {
            var n = parseInt(m[1], 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
        var r = v.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        return r ? [+r[1], +r[2], +r[3]] : null;
    }

    function heatPainter() {
        var a = accentRgb('--pub-accent')   || [41, 173, 228];
        var b = accentRgb('--pub-accent-2') || [242, 97, 46];
        return function(t) {
            if (t !== t || t == null) return '';
            if (t < 0) t = 0; if (t > 1) t = 1;
            var r = Math.round(a[0] + (b[0] - a[0]) * t);
            var g = Math.round(a[1] + (b[1] - a[1]) * t);
            var bl = Math.round(a[2] + (b[2] - a[2]) * t);
            return 'rgba(' + r + ',' + g + ',' + bl + ',' + (0.10 + t * 0.18).toFixed(3) + ')';
        };
    }

    function fmtAxis(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return String(v);
        return String(n.toFixed(2)).replace(/\.?0+$/, '');
    }

    function fmtCell(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return '';
        return String(n.toFixed(4)).replace(/\.?0+$/, '') || '0';
    }

    function renderMatrix(wrap, bp) {
        var meta = el('div', 'pub-bp-meta');
        meta.appendChild(el('span', null, bp.row_count + ' × ' + bp.column_count));
        if (bp.costed_by && bp.costed_by !== 'None') meta.appendChild(el('span', null, bp.costed_by));
        if (bp.vertical_type && bp.vertical_type !== 'None') meta.appendChild(el('span', null, '↓ ' + bp.vertical_type));
        if (bp.horizontal_type && bp.horizontal_type !== 'None') meta.appendChild(el('span', null, '→ ' + bp.horizontal_type));
        wrap.appendChild(meta);

        var hbps = (bp.horizontal_breakpoints || []).map(function(h) { return h.value; });
        var rows = bp.values || [];

        // Heat range over NONZERO cells — sparse matrices are mostly 0 and a
        // zero-anchored range would wash out the real values.
        var min = Infinity, max = -Infinity;
        rows.forEach(function(r) {
            hbps.forEach(function(h) {
                var v = r['c_' + h.toFixed(2)];
                if (typeof v === 'number' && v > 0) { if (v < min) min = v; if (v > max) max = v; }
            });
        });
        var paint = heatPainter();
        var span = (max > min) ? (max - min) : 1;

        var scroll = el('div', 'pub-bp-wrap');
        var table = el('table', 'pub-bp-table');
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        hr.appendChild(el('th', null, ''));   // corner
        hbps.forEach(function(h) { hr.appendChild(el('th', null, fmtAxis(h))); });
        thead.appendChild(hr);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        rows.forEach(function(r) {
            var tr = document.createElement('tr');
            tr.appendChild(el('td', null, fmtAxis(r.row_label)));
            hbps.forEach(function(h) {
                var v = r['c_' + h.toFixed(2)];
                var td = el('td', null, (typeof v === 'number' && v > 0) ? fmtCell(v) : '·');
                if (typeof v === 'number' && v > 0 && isFinite(min)) {
                    td.style.background = paint((v - min) / span);
                } else {
                    td.style.color = 'var(--pub-text-dim)';
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        wrap.appendChild(scroll);
    }

    function renderEntries(wrap, t) {
        // Recipe rule #1: the resolved height goes on the WRAPPER — Tabulator's
        // default height:'100%' rewrites the mount's own inline height, and 100%
        // of an auto-height parent is indeterminate → virtualization silently
        // OFF (measured here: thousands of real DOM rows → multi-second
        // setData/sort).
        var gridWrap = el('div', null);
        gridWrap.style.cssText = 'height:calc(100vh - var(--pub-topbar-h) - 290px);min-height:260px;';
        var mount = el('div', 'pub-grid');
        gridWrap.appendChild(mount);
        wrap.appendChild(gridWrap);

        var lbl = el('div', 'pub-tree-summary', 'Loading entries…');
        wrap.insertBefore(lbl, gridWrap);

        detailTable = makeGrid(mount, {
            columns: [
                { title: 'Product ID',   field: 'product_id',   formatter: idFormatter,
                  headerFilter: 'input', width: 150 },
                { title: 'Description',  field: 'description',  formatter: dashFormatter,
                  headerFilter: 'input' },
                { title: 'Manufacturer', field: 'manufacturer', formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Material',     field: 'material',     formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Size',         field: 'size',         formatter: dashFormatter, width: 80 },
                { title: 'Rate',         field: 'labor_rate',   sorter: 'number',
                  hozAlign: 'right', width: 80 },
                { title: 'Units',        field: 'units',        formatter: dashFormatter, width: 90 },
                { title: 'Harrison Code', field: 'harrison_code', formatter: dashFormatter,
                  headerFilter: 'input', width: 130 }
            ],
            layout: 'fitColumns',
            columnCalcs: false
            // No initialSort during a progressive load (O(n²) re-sort) —
            // applied once in the loader's onDone below.
        });

        // Entry → product drawer (same cross-grid nav as button-tree entries)
        detailTable.on('rowClick', function(e, row) {
            var d = row.getData();
            if (d.product_id && PanelControllers.products.openDetail) {
                PanelControllers.products.openDetail({ id: d.product_id, description: d.description || d.product_id });
            }
        });

        // Exact-match wrapper: bridge filters are SUBSTRING — over-fetch the
        // raw stream and keep only rows whose (table_name, group) equal this
        // table's identity. The table's own entry_count is the honest total.
        var rawOffset = 0;
        function fetchExact(limit) {
            return (async function() {
                var out = [];
                while (out.length === 0) {
                    var page = await BridgeClient.getInstallEntries(t.name, t.group, limit, rawOffset);
                    var rows = (page && page.data) ? page.data : [];
                    if (rows.length === 0) return { data: [], total: t.entry_count };
                    rawOffset += rows.length;
                    for (var i = 0; i < rows.length; i++)
                        if (rows[i].table_name === t.name && rows[i].group === t.group) out.push(rows[i]);
                }
                return { data: out, total: t.entry_count };
            })();
        }

        // the console serves the first capped page instantly (~0.2s) then loads
        // the rest OPT-IN via Load All — same UX as the products panel.
        (async function() {
            var myTable = detailTable;   // staleness guard — a table-switch destroys this instance
            var first = await fetchExact(5000);
            if (detailTable !== myTable) return;
            var rows = (first && first.data) ? first.data : [];
            await myTable.setData(rows);
            // Re-guard after EVERY await: setData yields the event loop too,
            // and destroyDetail() nulls the closure var synchronously.
            if (detailTable !== myTable) return;
            myTable.setSort('product_id', 'asc');
            if (t.entry_count > rows.length) {
                lbl.textContent = rows.length.toLocaleString() + ' of ' +
                    t.entry_count.toLocaleString() + ' Entries shown';
                var btn = el('button', 'btn-secondary small', 'Load All');
                btn.style.marginLeft = '10px';
                btn.addEventListener('click', function() {
                    btn.remove();
                    // Restart the raw stream from 0 — the loader's own first
                    // batch becomes the grid's base (continuing mid-stream
                    // would drop the first page from its final replaceData).
                    rawOffset = 0;
                    var loadTable = detailTable;   // captured — onDone must not read the mutable closure
                    entryLoader = new PubProgressLoader(loadTable, lbl, 'Entries');
                    entryLoader.start(function(limit) { return fetchExact(limit); }, 5000, function() {
                        if (detailTable !== loadTable) return;
                        loadTable.setSort('product_id', 'asc');
                    });
                });
                lbl.appendChild(btn);
            } else {
                lbl.textContent = rows.length.toLocaleString() + ' Entries';
            }
        })();
    }

    async function renderDetail(t) {
        var pane = document.getElementById('it-detail');
        destroyDetail();
        clearElement(pane);

        // Per-render token: a faster competing selection aborts this one
        var token = {};
        pane._itToken = token;

        var wrap = el('div', 'svc-detail-wrap');
        wrap.appendChild(el('div', 'svc-detail-title', t.name));

        var metaRow = el('div', 'svc-meta-row');
        var g = el('span', 'meta-tag', t.group || '');
        metaRow.appendChild(g);
        metaRow.appendChild(el('span', 'meta-tag', t.type));
        wrap.appendChild(metaRow);
        pane.appendChild(wrap);

        if (t.type === 'breakpoint') {
            var note = el('p', null, 'Loading matrix…');
            note.style.cssText = 'color:var(--pub-text-muted);font-size:12px;';
            wrap.appendChild(note);
            var bp = await BridgeClient.getBreakpointTable(t.name);
            if (pane._itToken !== token) return;
            wrap.removeChild(note);
            if (!bp || bp.error || !(bp.values || []).length) {
                var p = el('p', null, (bp && bp.error) ? bp.error : 'No matrix data returned.');
                p.style.cssText = 'color:var(--pub-text-muted);font-size:12px;';
                wrap.appendChild(p);
                return;
            }
            renderMatrix(wrap, bp);
        } else {
            renderEntries(wrap, t);
        }
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (listTable) { listTable.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 14 — Job Items
   Placed items in the current drawing (cache-built while a job is
   open). Capped first page + Load All; honest empty state when the
   cache has no drawing items.
   ══════════════════════════════════════════════════════════════ */
PanelControllers.jobitems = (function() {
    var loaded = false;
    var table = null;
    var loader = null;

    function metaEl() { return document.getElementById('ji-results-meta'); }

    function init() {
        // Drill coarse→fine: service → status → section → spool → item
        table = makeGrid('#ji-grid', {
            columns: [
                { title: 'Service',  field: 'service',    formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Status',   field: 'status',     formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true }, width: 110 },
                { title: 'Section',  field: 'section',    formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true }, width: 100 },
                { title: 'Spool',    field: 'spool_name', formatter: dashFormatter,
                  headerFilter: 'input', width: 110 },
                { title: 'Name',     field: 'name',       formatter: dashFormatter,
                  headerFilter: 'input' },
                { title: 'CID',      field: 'cid',        sorter: 'number',
                  hozAlign: 'right', width: 70 },
                { title: 'Zone',     field: 'zone',       formatter: dashFormatter,
                  headerFilter: 'input', width: 100 },
                { title: 'Notes',    field: 'notes',      formatter: dashFormatter,
                  headerFilter: 'input' }
            ],
            layout: 'fitColumns',
            columnCalcs: false
            // No initialSort — applied on load completion (progressive rule)
        });
        syncCountBadge(table, 'ji-count-badge');

        document.getElementById('ji-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    var loadingNow = false;
    async function load() {
        if (loadingNow) return;            // inflight guard — rapid re-activation
        loadingNow = true;
        try { await doLoad(); } finally { loadingNow = false; }
    }

    async function doLoad() {
        if (loader) { loader.cancel(); loader = null; }   // re-pull supersedes a stream
        var first = await BridgeClient.getJobItems('', 5000, 0);
        var rows = (first && first.data) ? first.data : [];
        var total = (first && first.total !== undefined) ? first.total : rows.length;
        var empty = document.getElementById('ji-empty');
        var meta = metaEl();

        await table.setData(rows);
        table.setSort('service', 'asc');

        if (rows.length === 0) {
            empty.classList.remove('hidden');
            if (meta) meta.textContent = '';
            return;
        }
        empty.classList.add('hidden');

        if (total > rows.length) {
            if (meta) {
                meta.textContent = rows.length.toLocaleString() + ' of ' + total.toLocaleString() + ' shown';
                var btn = el('button', 'btn-secondary small', 'Load All');
                btn.style.marginLeft = '8px';
                btn.addEventListener('click', function() {
                    btn.remove();
                    loader = new PubProgressLoader(table, meta, 'Items');
                    loader.start(function(limit, offset) {
                        return BridgeClient.getJobItems('', limit, offset);
                    }, 5000, function() { table.setSort('service', 'asc'); });
                });
                meta.appendChild(btn);
            }
        } else if (meta) {
            meta.textContent = rows.length.toLocaleString() + ' items';
        }
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); load(); }   // re-pull — drawing state changes
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 13 — Discounts
   Supplier discount codes → multipliers. value === 1 means the
   code is assigned with no discount (real data, not empty).
   ══════════════════════════════════════════════════════════════ */
PanelControllers.discounts = (function() {
    var loaded = false;
    var table = null;

    function init() {
        table = makeGrid('#dc-grid', {
            columns: [
                { title: 'Supplier Group', field: 'supplier_group', formatter: dashFormatter,
                  headerFilter: 'list',
                  headerFilterParams: { valuesLookup: 'active', clearable: true } },
                { title: 'Code',           field: 'code',           formatter: dashFormatter,
                  headerFilter: 'input' },
                { title: 'Multiplier',     field: 'value',          sorter: 'number',
                  hozAlign: 'right', width: 110,
                  formatter: function(cell) {
                      var v = cell.getValue();
                      if (v === null || v === undefined || v === '') return '<span class="pub-dash">—</span>';
                      return _pubEsc(String(v));
                  } },
                { title: 'Description',    field: 'description',    formatter: dashFormatter,
                  headerFilter: 'input' }
            ],
            initialSort: [
                { column: 'code', dir: 'asc' },
                { column: 'supplier_group', dir: 'asc' }
            ]
        });
        syncCountBadge(table, 'dc-count-badge');

        document.getElementById('dc-filter').addEventListener('input', function() {
            applyQuickFilter(table, this.value.trim());
        });
    }

    async function load() {
        var data = await BridgeClient.getDiscountCodes();
        var rows = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        table.setData(rows);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); load(); }
            else if (table) { table.redraw(true); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 11 — Application
   "config loaded" view: config hero card + KPI stat
   cards + item status chips. Stat-card class (.app-stat) is
   designed for Batch-4 reuse across overview dashboards.
   ══════════════════════════════════════════════════════════════ */
PanelControllers.application = (function() {
    var loaded = false;

    // ── ACI color map (mirrors _ACI_COLORS in pub-grid.js) ──────────────
    var ACI_HEX = {
        '1': '#ff0000', '2': '#ffff00', '3': '#00ff00',
        '4': '#00ffff', '5': '#0000ff', '6': '#ff00ff', '7': '#cccccc'
    };
    var ACI_FALLBACK = '#888888';

    // (makeStatCard hoisted to the shared utilities — Overview uses it too)

    // ── Render the config hero card ──────────────────────────────────────
    function renderConfig(s) {
        // Logo: user-uploaded custom mark if set, else default Fabrication badge
        var logoImg = document.getElementById('app-config-logo');
        if (logoImg) {
            try {
                var custom = localStorage.getItem('fab-mcp-logo');
                logoImg.src = custom || 'assets/fabrication-logo.png';
            } catch(e) {
                logoImg.src = 'assets/fabrication-logo.png';
            }
        }

        var dbName = s.database_name || 'Fabrication Database';
        var dbPath = s.database_path || '';
        var profileName = s.profile_name || '';
        var dbLoaded = !!s.db_loaded;

        setMeta('app-db-name', dbName || '—');
        setMeta('app-db-path', dbPath || '');

        // Profile badge (hidden when empty)
        var profileBadge = document.getElementById('app-profile-badge');
        if (profileBadge) {
            if (profileName) {
                profileBadge.textContent = profileName;
                profileBadge.classList.remove('hidden');
            } else {
                profileBadge.classList.add('hidden');
            }
        }

        // Loaded / demo badge
        var loadedBadge = document.getElementById('app-loaded-badge');
        if (loadedBadge) {
            clearElement(loadedBadge);
            var dot = document.createElement('span');
            dot.className = 'app-status-dot';
            loadedBadge.appendChild(dot);
            if (dbLoaded) {
                loadedBadge.className = 'app-config-status-badge app-config-status-badge--ok';
                loadedBadge.appendChild(document.createTextNode('DB Loaded'));
            } else if (!BridgeClient.isOnline()) {
                loadedBadge.className = 'app-config-status-badge app-config-status-badge--warn';
                loadedBadge.appendChild(document.createTextNode('Demo Mode'));
            } else {
                loadedBadge.className = 'app-config-status-badge app-config-status-badge--warn';
                loadedBadge.appendChild(document.createTextNode('Not Loaded'));
            }
        }
    }

    // ── Render KPI stat cards ────────────────────────────────────────────
    function renderStats(s) {
        var row = document.getElementById('app-stats-row');
        if (!row) return;
        clearElement(row);

        var stats = [
            { v: Number(s.product_count  || 0).toLocaleString(), l: 'Products' },
            { v: Number(s.service_count  || 0).toLocaleString(), l: 'Services' },
            { v: Number(s.price_entries_count   || 0).toLocaleString(), l: 'Price Entries' },
            { v: Number(s.install_entries_count || 0).toLocaleString(), l: 'Install Entries' },
            { v: Number(s.image_count    || 0).toLocaleString(), l: 'Images' }
        ];

        stats.forEach(function(item) {
            row.appendChild(makeStatCard(item.v, item.l, ''));
        });

        // Cache stat — separate because it has a distinct state modifier
        var cacheReady = !!s.cache_ready;
        var cacheBuilding = !!s.cache_building;
        var cacheCount = s.cache_product_count;

        var cacheMod = cacheReady ? 'ok' : (cacheBuilding ? 'warn' : '');
        var cacheLabel = cacheReady ? 'Cache Ready' : (cacheBuilding ? 'Cache Building' : 'Cache');
        var cacheVal = (cacheCount !== undefined && cacheCount !== null)
            ? Number(cacheCount).toLocaleString()
            : (cacheReady ? 'Ready' : '—');
        row.appendChild(makeStatCard(cacheVal, cacheLabel, cacheMod));
    }

    // ── Render item status chips ─────────────────────────────────────────
    // Each chip is: [color swatch] [name]. Safe DOM construction — no innerHTML with data.
    function renderStatusChips(statuses) {
        var container = document.getElementById('app-status-chips');
        var linkRow = document.getElementById('app-status-link-row');
        if (!container) return;
        clearElement(container);

        if (!statuses || statuses.length === 0) {
            var none = document.createElement('span');
            none.className = 'app-status-empty';
            none.textContent = 'No item statuses defined.';
            container.appendChild(none);
            if (linkRow) linkRow.classList.add('hidden');
            return;
        }

        var frag = document.createDocumentFragment();
        statuses.forEach(function(st) {
            var chip = document.createElement('span');
            chip.className = 'app-status-chip';

            var swatch = document.createElement('span');
            swatch.className = 'aci-swatch';
            var colorStr = (st.color !== null && st.color !== undefined) ? String(st.color) : '';
            var hex = ACI_HEX[colorStr] || ACI_FALLBACK;
            swatch.style.background = hex;
            chip.appendChild(swatch);

            var nameSpan = document.createElement('span');
            nameSpan.textContent = st.name || '(unnamed)';
            chip.appendChild(nameSpan);

            frag.appendChild(chip);
        });
        container.appendChild(frag);

        if (linkRow) linkRow.classList.remove('hidden');
    }

    // ── Wire the "View all statuses →" link ─────────────────────────────
    function wireStatusLink() {
        var btn = document.getElementById('app-view-statuses-btn');
        if (!btn) return;
        btn.addEventListener('click', function() { activatePanel('statuses'); });
    }

    // ── Main load function ───────────────────────────────────────────────
    var _loading = false;  // inflight guard — rapid re-activation must not
                           // race two load chains (stale slow response could
                           // overwrite the fresh one; codebro P2)
    async function load() {
        if (_loading) return;
        _loading = true;
        try {
        var statusData = await BridgeClient.getStatus();
        var s = statusData || BridgeClient.SAMPLE.status;

        renderConfig(s);
        renderStats(s);

        // Item statuses
        var itemData = await BridgeClient.getItemStatuses();
        var items = (itemData && itemData.data) ? itemData.data : [];
        renderStatusChips(items);

        // Offline banner
        var banner = document.getElementById('app-offline-banner');
        if (banner) {
            if (!BridgeClient.isOnline()) {
                banner.classList.remove('hidden');
            } else {
                banner.classList.add('hidden');
            }
        }
        } finally { _loading = false; }
    }

    function init() {
        wireStatusLink();
        var refreshBtn = document.getElementById('app-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function() { load(); });
        }
        load();
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); }
            else { load(); }
        }
    };
})();

/* ──────────────────────────────────────────────────────────────
   Brand mark customization
   ────────────────────────────────────────────────────────────── */
var BrandMark = (function() {
    var KEY = 'fab-mcp-logo';
    var DEFAULT_SRC = 'assets/fabrication-logo.png';
    var MAX_DATAURL_CHARS = 512 * 1024;

    function init() {
        var img = document.getElementById('brand-logo-img');
        var btn = document.getElementById('brand-logo-btn');
        var menu = document.getElementById('brand-menu');
        var fileInput = document.getElementById('brand-file-input');
        if (!img || !btn || !menu || !fileInput) return;

        try {
            var saved = localStorage.getItem(KEY);
            if (saved) img.src = saved;
        } catch (e) {}

        function closeMenu() {
            menu.classList.add('hidden');
            btn.setAttribute('aria-expanded', 'false');
        }

        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var opening = menu.classList.contains('hidden');
            menu.classList.toggle('hidden', !opening);
            btn.setAttribute('aria-expanded', String(opening));
        });
        document.addEventListener('click', closeMenu);
        menu.addEventListener('click', function(e) { e.stopPropagation(); });

        document.getElementById('brand-upload-btn').addEventListener('click', function() {
            fileInput.click();
        });

        document.getElementById('brand-reset-btn').addEventListener('click', function() {
            try { localStorage.removeItem(KEY); } catch (e) {}
            img.src = DEFAULT_SRC;
            closeMenu();
        });

        fileInput.addEventListener('change', function() {
            var f = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            closeMenu();
            if (!f) return;
            if (f.type !== 'image/png' && f.type !== 'image/jpeg') {
                alert('Logo must be a PNG or JPEG image.');
                return;
            }
            var reader = new FileReader();
            reader.onload = function() {
                var dataUrl = reader.result;
                if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATAURL_CHARS) {
                    alert('Logo file is too large — please keep it under ~380 KB.');
                    return;
                }
                try { localStorage.setItem(KEY, dataUrl); }
                catch (e) { alert('Could not save the logo (browser storage is full).'); return; }
                img.src = dataUrl;
            };
            reader.readAsDataURL(f);
        });
    }

    return { init: init };
})();

/* ──────────────────────────────────────────────────────────────
   Boot
   ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
    BrandMark.init();
    // Land on the Overview dashboard — light KPI calls instead of the
    // products panel's 10k first-page pull (which serialized behind every
    // other boot request on the bridge). Products loads on first visit.
    PanelControllers.overview.onActivate();
});
