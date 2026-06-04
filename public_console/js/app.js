/**
 * Fabrication CADmep Console — application logic
 *
 * DOM safety: all dynamic content uses textContent / createElement / setAttribute.
 * No innerHTML with untrusted data anywhere in this file.
 */

/* ──────────────────────────────────────────────────────────────
   Navigation
   ────────────────────────────────────────────────────────────── */
(function initNav() {
    var btns = document.querySelectorAll('.nav-btn');
    btns.forEach(function(btn) {
        btn.addEventListener('click', function() {
            var target = btn.getAttribute('data-panel');
            btns.forEach(function(b) {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
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

function fmtNum(val) {
    if (val === null || val === undefined || val === '') return '—';
    return String(val);
}

function fmtMult(val) {
    if (val === null || val === undefined) return '—';
    var n = parseFloat(val);
    if (isNaN(n)) return '—';
    return (n * 100).toFixed(0) + '%';
}

function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

function td(text, cls) {
    var d = document.createElement('td');
    if (cls) d.className = cls;
    d.textContent = (text !== null && text !== undefined) ? String(text) : '—';
    return d;
}

function clearElement(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function setMeta(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
}

/* ──────────────────────────────────────────────────────────────
   Panel controllers — each panel registers an onActivate()
   ────────────────────────────────────────────────────────────── */
var PanelControllers = {};

/* ══════════════════════════════════════════════════════════════
   Panel 1 — Product Search
   ══════════════════════════════════════════════════════════════ */
PanelControllers.products = (function() {
    var loaded = false;

    function init() {
        document.getElementById('product-search-btn').addEventListener('click', function() {
            runSearch();
        });
        document.getElementById('product-search-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') runSearch();
        });
        document.getElementById('product-load-all-btn').addEventListener('click', function() {
            document.getElementById('product-search-input').value = '';
            runSearch('', 500);
        });
    }

    async function runSearch(query, limit) {
        if (query === undefined) query = document.getElementById('product-search-input').value.trim();
        if (limit === undefined) limit = 100;

        var meta = document.getElementById('product-results-meta');
        meta.textContent = 'Searching…';

        var tbody = document.getElementById('product-tbody');
        clearElement(tbody);

        var row = document.createElement('tr');
        row.className = 'loading-row';
        var cell = document.createElement('td');
        cell.colSpan = 8;
        cell.textContent = 'Loading…';
        row.appendChild(cell);
        tbody.appendChild(row);

        var data = await BridgeClient.getProducts(query, limit, 0);
        renderProducts(data, query);
    }

    function renderProducts(data, query) {
        var tbody = document.getElementById('product-tbody');
        var emptyDiv = document.getElementById('product-empty');
        var meta = document.getElementById('product-results-meta');

        clearElement(tbody);

        var rows = (data && data.data) ? data.data : [];
        var total = (data && data.total !== undefined) ? data.total : rows.length;

        if (rows.length === 0) {
            emptyDiv.classList.remove('hidden');
            meta.textContent = 'No results.';
            return;
        }

        emptyDiv.classList.add('hidden');

        var shown = rows.length;
        var label = query ? ('Showing ' + shown + ' of ' + total + ' results for “' + query + '”') :
                           ('Showing ' + shown + ' of ' + total + ' products');
        meta.textContent = label;

        var frag = document.createDocumentFragment();
        rows.forEach(function(p) {
            var tr = document.createElement('tr');

            var idTd = document.createElement('td');
            var idSpan = document.createElement('span');
            idSpan.className = 'cell-id';
            idSpan.textContent = p.id || '—';
            idTd.appendChild(idSpan);
            tr.appendChild(idTd);

            tr.appendChild(td(p.description));
            tr.appendChild(td(p.size || '—'));
            tr.appendChild(td(p.material || '—'));
            tr.appendChild(td(p.specification || p.spec || '—'));
            tr.appendChild(td(p.manufacturer || '—'));

            var costTd = document.createElement('td');
            costTd.className = 'col-num';
            var costSpan = document.createElement('span');
            costSpan.className = 'cell-cost';
            costSpan.textContent = (p.cost !== null && p.cost !== undefined && p.cost !== '') ? fmt(p.cost) : '—';
            costTd.appendChild(costSpan);
            tr.appendChild(costTd);

            // Add-to-estimate button
            var actTd = document.createElement('td');
            actTd.className = 'col-action';
            var addBtn = document.createElement('button');
            addBtn.className = 'pick-item-add';
            addBtn.title = 'Add to estimate';
            addBtn.setAttribute('aria-label', 'Add to estimate: ' + (p.description || p.id));
            addBtn.textContent = '+';
            addBtn.addEventListener('click', function() {
                EstimatePanel.addProduct(p);
            });
            actTd.appendChild(addBtn);
            tr.appendChild(actTd);

            frag.appendChild(tr);
        });

        tbody.appendChild(frag);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); runSearch('', 100); }
        }
    };
})();

/* ══════════════════════════════════════════════════════════════
   Panel 2 — Services
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

        if (svc.item_count !== undefined) {
            var cTag = document.createElement('span');
            cTag.className = 'meta-tag';
            cTag.textContent = svc.item_count + ' items';
            metaRow.appendChild(cTag);
        }

        wrap.appendChild(metaRow);

        // Try to load entries from bridge
        if (BridgeClient.isOnline()) {
            var loading = document.createElement('p');
            loading.style.color = 'var(--text-muted)';
            loading.style.fontSize = '12px';
            loading.textContent = 'Loading entries…';
            wrap.appendChild(loading);
            pane.appendChild(wrap);

            var result = await BridgeClient.getServiceEntries(svc.name);
            var entries = (result && result.entries) ? result.entries : [];

            wrap.removeChild(loading);

            var entTitle = document.createElement('div');
            entTitle.className = 'svc-entries-title';
            entTitle.textContent = 'Entries (' + entries.length + ')';
            wrap.appendChild(entTitle);

            if (entries.length > 0) {
                var table = document.createElement('table');
                table.className = 'data-table';
                var thead = document.createElement('thead');
                var hrow = document.createElement('tr');
                ['ID', 'Description', 'Material', 'Size', 'Cost', 'Install'].forEach(function(h) {
                    var th = document.createElement('th');
                    th.scope = 'col';
                    th.textContent = h;
                    hrow.appendChild(th);
                });
                thead.appendChild(hrow);
                table.appendChild(thead);

                var tbody = document.createElement('tbody');
                entries.slice(0, 200).forEach(function(e) {
                    var tr = document.createElement('tr');
                    tr.appendChild(td(e.id || e.product_id || '—'));
                    tr.appendChild(td(e.description || e.product_name || '—'));
                    tr.appendChild(td(e.material || '—'));
                    tr.appendChild(td(e.size || '—'));
                    tr.appendChild(td((e.cost !== undefined && e.cost !== null) ? fmt(e.cost) : '—'));
                    tr.appendChild(td((e.install_time !== undefined) ? e.install_time : '—'));
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);

                var gridWrap = document.createElement('div');
                gridWrap.className = 'grid-wrap short';
                gridWrap.appendChild(table);
                wrap.appendChild(gridWrap);
            } else {
                var noEnt = document.createElement('p');
                noEnt.style.cssText = 'font-size:12px;color:var(--text-muted);padding:12px 0;';
                noEnt.textContent = 'No entries returned. Template-level detail may require bridge version 1.2+.';
                wrap.appendChild(noEnt);
            }
        } else {
            var offNote = document.createElement('p');
            offNote.style.cssText = 'font-size:12px;color:var(--text-muted);padding:12px 0;';
            offNote.textContent = 'Connect the bridge to load service entries.';
            wrap.appendChild(offNote);
            pane.appendChild(wrap);
        }

        if (pane.lastChild !== wrap) pane.appendChild(wrap);
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

    async function load() {
        var data = await BridgeClient.getPriceLists();
        allLists = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
        setMeta('pl-count-badge', String(allLists.length));
        renderList();
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
            prim.style.color = 'var(--text-dim)';
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

        // Show entries area
        entriesArea.classList.remove('hidden');

        var loadBtn = document.getElementById('pl-entry-load-btn');
        var searchInput = document.getElementById('pl-entry-search');

        // Replace event listeners by cloning
        var newLoadBtn = loadBtn.cloneNode(true);
        loadBtn.parentNode.replaceChild(newLoadBtn, loadBtn);

        newLoadBtn.addEventListener('click', function() {
            loadEntries(pl.name, searchInput.value.trim());
        });

        var newSearch = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearch, searchInput);
        newSearch.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') loadEntries(pl.name, newSearch.value.trim());
        });

        if (BridgeClient.isOnline()) loadEntries(pl.name, '');
    }

    async function loadEntries(listName, query) {
        var tbody = document.getElementById('pl-entry-tbody');
        clearElement(tbody);

        var loadingRow = document.createElement('tr');
        loadingRow.className = 'loading-row';
        var loadingCell = document.createElement('td');
        loadingCell.colSpan = 6;
        loadingCell.textContent = 'Loading entries…';
        loadingRow.appendChild(loadingCell);
        tbody.appendChild(loadingRow);

        var data = await BridgeClient.getPriceEntries(listName, query, 200, 0);
        var rows = (data && data.data) ? data.data : [];

        clearElement(tbody);
        setMeta('pl-entry-count', String(rows.length));

        if (rows.length === 0) {
            var emptyRow = document.createElement('tr');
            emptyRow.className = 'loading-row';
            var emptyCell = document.createElement('td');
            emptyCell.colSpan = 6;
            emptyCell.textContent = 'No entries found.';
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
            return;
        }

        var frag = document.createDocumentFragment();
        rows.forEach(function(e) {
            var tr = document.createElement('tr');

            var idTd = document.createElement('td');
            var idSpan = document.createElement('span');
            idSpan.className = 'cell-id';
            idSpan.textContent = e.product_id || e.id || '—';
            idTd.appendChild(idSpan);
            tr.appendChild(idTd);

            tr.appendChild(td(e.description || '—'));
            tr.appendChild(td(e.size || '—'));

            tr.appendChild(td(fmt(e.list_price), 'col-num'));

            var multTd = document.createElement('td');
            multTd.className = 'col-num';
            multTd.textContent = (e.multiplier !== undefined && e.multiplier !== null) ? fmtMult(e.multiplier) : '—';
            tr.appendChild(multTd);

            var netTd = document.createElement('td');
            netTd.className = 'col-num';
            var netSpan = document.createElement('span');
            netSpan.className = 'cell-cost';
            netSpan.textContent = (e.net_price !== undefined && e.net_price !== null) ? fmt(e.net_price) :
                (e.list_price && e.multiplier) ? fmt(parseFloat(e.list_price) * parseFloat(e.multiplier)) : '—';
            netTd.appendChild(netSpan);
            tr.appendChild(netTd);

            frag.appendChild(tr);
        });
        tbody.appendChild(frag);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; load(); }
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

    function init() {
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
        loadingP.style.cssText = 'padding:12px;color:var(--text-muted);font-size:12px;';
        loadingP.textContent = 'Searching…';
        container.appendChild(loadingP);

        var data = await BridgeClient.getProducts(q, 50, 0);
        var rows = (data && data.data) ? data.data : [];

        clearElement(container);

        if (rows.length === 0) {
            var noRes = document.createElement('p');
            noRes.style.cssText = 'padding:12px;color:var(--text-dim);font-size:12px;';
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
        // Check if already in basket
        var existing = basket.find(function(b) { return b.product.id === p.id; });
        if (existing) {
            existing.qty++;
        } else {
            basket.push({ product: p, qty: 1, multiplier: DEFAULT_MULTIPLIER });
        }
        renderBasket();
        document.getElementById('est-result-card').classList.add('hidden');
    }

    function clearBasket() {
        basket = [];
        renderBasket();
        document.getElementById('est-result-card').classList.add('hidden');
    }

    function removeItem(idx) {
        basket.splice(idx, 1);
        renderBasket();
        document.getElementById('est-result-card').classList.add('hidden');
    }

    function renderBasket() {
        var tbody = document.getElementById('est-basket-tbody');
        var emptyDiv = document.getElementById('est-basket-empty');
        var totalsBar = document.getElementById('est-totals');
        var runRow = document.getElementById('est-run-row');

        clearElement(tbody);

        if (basket.length === 0) {
            emptyDiv.classList.remove('hidden');
            totalsBar.classList.add('hidden');
            runRow.classList.add('hidden');
            return;
        }

        emptyDiv.classList.add('hidden');
        totalsBar.classList.remove('hidden');
        runRow.classList.remove('hidden');

        var grandTotal = 0;
        var frag = document.createDocumentFragment();

        basket.forEach(function(item, idx) {
            var p = item.product;
            var unitCost = (p.cost !== null && p.cost !== undefined && p.cost !== '') ? parseFloat(p.cost) : 0;
            var lineTotal = unitCost * item.qty * item.multiplier;
            grandTotal += lineTotal;

            var tr = document.createElement('tr');
            tr.appendChild(td(p.description || p.id || '—'));

            // Qty cell with input
            var qtyTd = document.createElement('td');
            qtyTd.className = 'col-num';
            var qtyInput = document.createElement('input');
            qtyInput.type = 'number';
            qtyInput.min = '1';
            qtyInput.value = String(item.qty);
            qtyInput.style.cssText = 'width:52px;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--mono);font-size:11px;padding:2px 4px;text-align:right;';
            var capturedIdx = idx;
            qtyInput.addEventListener('change', function() {
                var v = parseInt(this.value, 10);
                if (!isNaN(v) && v >= 1) { basket[capturedIdx].qty = v; renderBasket(); }
            });
            qtyTd.appendChild(qtyInput);
            tr.appendChild(qtyTd);

            tr.appendChild(td(unitCost > 0 ? fmt(unitCost) : '—', 'col-num'));

            // Multiplier cell with input
            var multTd = document.createElement('td');
            multTd.className = 'col-num';
            var multInput = document.createElement('input');
            multInput.type = 'number';
            multInput.min = '0';
            multInput.max = '1';
            multInput.step = '0.01';
            multInput.value = item.multiplier.toFixed(2);
            multInput.style.cssText = 'width:58px;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--mono);font-size:11px;padding:2px 4px;text-align:right;';
            multInput.addEventListener('change', function() {
                var v = parseFloat(this.value);
                if (!isNaN(v) && v >= 0 && v <= 1) { basket[capturedIdx].multiplier = v; renderBasket(); }
            });
            multTd.appendChild(multInput);
            tr.appendChild(multTd);

            var lineTd = document.createElement('td');
            lineTd.className = 'col-num';
            var lineSpan = document.createElement('span');
            lineSpan.className = 'cell-cost';
            lineSpan.textContent = unitCost > 0 ? fmt(lineTotal) : '—';
            lineTd.appendChild(lineSpan);
            tr.appendChild(lineTd);

            var actTd = document.createElement('td');
            actTd.className = 'col-action';
            var rmBtn = document.createElement('button');
            rmBtn.className = 'btn-remove';
            rmBtn.title = 'Remove';
            rmBtn.setAttribute('aria-label', 'Remove from estimate');
            rmBtn.textContent = '×';
            rmBtn.addEventListener('click', function() { removeItem(capturedIdx); });
            actTd.appendChild(rmBtn);
            tr.appendChild(actTd);

            frag.appendChild(tr);
        });

        tbody.appendChild(frag);
        document.getElementById('est-total-value').textContent = fmt(grandTotal);
    }

    function runEstimate() {
        if (basket.length === 0) return;

        var resultCard = document.getElementById('est-result-card');
        var resultBody = document.getElementById('est-result-body');
        clearElement(resultBody);
        resultCard.classList.remove('hidden');

        var table = document.createElement('table');
        table.className = 'est-result-table';

        var thead = document.createElement('thead');
        var hrow = document.createElement('tr');
        ['Product', 'Qty', 'Unit Cost', 'Multiplier', 'Net Unit', 'Line Total'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            hrow.appendChild(th);
        });
        thead.appendChild(hrow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        var grand = 0;

        basket.forEach(function(item) {
            var p = item.product;
            var unitCost = (p.cost !== null && p.cost !== undefined && p.cost !== '') ? parseFloat(p.cost) : 0;
            var netUnit = unitCost * item.multiplier;
            var lineTotal = netUnit * item.qty;
            grand += lineTotal;

            var tr = document.createElement('tr');
            tr.appendChild(td(p.description || p.id || '—'));
            tr.appendChild(td(String(item.qty)));
            tr.appendChild(td(unitCost > 0 ? fmt(unitCost) : '—'));
            tr.appendChild(td((item.multiplier * 100).toFixed(0) + '%'));
            tr.appendChild(td(unitCost > 0 ? fmt(netUnit) : '—'));
            var lt = document.createElement('td');
            var ltSpan = document.createElement('span');
            ltSpan.className = 'cell-cost';
            ltSpan.textContent = unitCost > 0 ? fmt(lineTotal) : '—';
            lt.appendChild(ltSpan);
            tr.appendChild(lt);
            tbody.appendChild(tr);
        });

        // Total row
        var totalRow = document.createElement('tr');
        totalRow.className = 'est-result-total';
        var labels = ['TOTAL MATERIAL', '', '', '', '', fmt(grand)];
        labels.forEach(function(txt, i) {
            var td_el = document.createElement('td');
            if (i === 5) {
                var sp = document.createElement('span');
                sp.className = 'cell-cost';
                sp.textContent = fmt(grand);
                td_el.appendChild(sp);
            } else {
                td_el.textContent = txt;
            }
            totalRow.appendChild(td_el);
        });
        tbody.appendChild(totalRow);

        table.appendChild(tbody);

        var gridWrap = document.createElement('div');
        gridWrap.className = 'grid-wrap';
        gridWrap.appendChild(table);
        resultBody.appendChild(gridWrap);

        // Summary note
        var note = document.createElement('p');
        note.style.cssText = 'padding:10px 14px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border);';
        note.textContent = 'Material cost only. Multiplier approximates net price from list price. Adjust multipliers per your negotiated discount schedules.';
        resultBody.appendChild(note);
    }

    return {
        onActivate: function() {
            if (!loaded) { loaded = true; init(); }
        },
        addProduct: addProduct
    };
})();

PanelControllers.estimate = EstimatePanel;

/* ══════════════════════════════════════════════════════════════
   Panel 5 — EST Jobs
   ══════════════════════════════════════════════════════════════ */
PanelControllers.est = (function() {
    var state = 'unknown';  // unknown | offline | connected
    var allJobs = [];
    var activeJob = null;

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
            prim.style.color = 'var(--text-dim)';
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
        clearElement(detailPane);

        var wrap = document.createElement('div');
        wrap.className = 'job-detail-wrap';

        var title = document.createElement('div');
        title.className = 'job-detail-title';
        title.textContent = job.job_name || job.job_file_name || '(unnamed)';
        wrap.appendChild(title);

        // Meta grid
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

        // Load summary
        var summaryTitle = document.createElement('div');
        summaryTitle.className = 'job-section-title';
        summaryTitle.textContent = 'Service Summary';
        wrap.appendChild(summaryTitle);

        var loadingP = document.createElement('p');
        loadingP.style.cssText = 'font-size:12px;color:var(--text-muted);';
        loadingP.textContent = 'Loading summary…';
        wrap.appendChild(loadingP);
        detailPane.appendChild(wrap);

        var summary = await BridgeClient.mcpCall('est_job_summary', { job_file_name: job.job_file_name });

        wrap.removeChild(loadingP);

        var rows = [];
        if (summary && !summary.error) {
            rows = Array.isArray(summary) ? summary : (summary.rows || summary.data || []);
        }

        if (rows.length > 0) {
            var table = document.createElement('table');
            table.className = 'data-table';
            var thead = document.createElement('thead');
            var hrow = document.createElement('tr');
            ['Service', 'Items', 'Material', 'Fab Cost', 'Field Cost', 'Total', 'Fab Hrs', 'Install Hrs'].forEach(function(h) {
                var th = document.createElement('th');
                th.scope = 'col';
                th.textContent = h;
                hrow.appendChild(th);
            });
            thead.appendChild(hrow);
            table.appendChild(thead);

            var tbody = document.createElement('tbody');
            rows.forEach(function(r) {
                var tr = document.createElement('tr');
                tr.appendChild(td(r.service || r.service_abbr || '—'));
                tr.appendChild(td(r.item_count !== undefined ? String(r.item_count) : '—'));
                tr.appendChild(td(r.total_material !== undefined ? fmt(r.total_material) : '—', 'col-num'));
                tr.appendChild(td(r.total_fab_cost !== undefined ? fmt(r.total_fab_cost) : '—', 'col-num'));
                tr.appendChild(td(r.total_field_cost !== undefined ? fmt(r.total_field_cost) : '—', 'col-num'));
                var totTd = document.createElement('td');
                totTd.className = 'col-num';
                var totSpan = document.createElement('span');
                totSpan.className = 'cell-cost';
                totSpan.textContent = r.total_cost !== undefined ? fmt(r.total_cost) : '—';
                totTd.appendChild(totSpan);
                tr.appendChild(totTd);
                tr.appendChild(td(r.fab_hours !== undefined ? String(r.fab_hours) : '—', 'col-num'));
                tr.appendChild(td(r.install_hours !== undefined ? String(r.install_hours) : '—', 'col-num'));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);

            var gridWrap = document.createElement('div');
            gridWrap.className = 'grid-wrap';
            gridWrap.appendChild(table);
            wrap.appendChild(gridWrap);
        } else {
            var noSum = document.createElement('p');
            noSum.style.cssText = 'font-size:12px;color:var(--text-muted);padding:12px 0;';
            noSum.textContent = 'No summary data available for this job.';
            wrap.appendChild(noSum);
        }
    }

    var initDone = false;
    return {
        onActivate: function() {
            if (!initDone) { initDone = true; init(); }
        }
    };
})();

/* ──────────────────────────────────────────────────────────────
   Boot — activate the first panel
   ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
    PanelControllers.products.onActivate();
});
