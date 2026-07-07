/**
 * Bridge Client — connects to localhost:5050, falls back to sample data if offline.
 * All panels use this instead of direct fetch or hardcoded data.
 *
 * The bridge is the FabricationBridgeService HTTP API exposed by the
 * FabricationSample plugin when AutoCAD is running.
 */
var BridgeClient = (function() {
    var BRIDGE_URL = 'http://localhost:5050';
    var _online = null;  // null = unknown, true/false after first check
    var _statusData = null;
    var _checkPromise = null;

    function bridgeUrl(path) { return BRIDGE_URL + path; }

    async function checkBridge() {
        if (_checkPromise) return _checkPromise;
        _checkPromise = (async function() {
            try {
                var resp = await fetch(bridgeUrl('/api/status'), { signal: AbortSignal.timeout(3000) });
                if (resp.ok) {
                    _statusData = await resp.json();
                    _online = true;
                    _notifyStatus(true);
                    return true;
                }
            } catch(e) {}
            _online = false;
            _notifyStatus(false);
            return false;
        })().finally(function() { _checkPromise = null; });
        return _checkPromise;
    }

    var _statusListeners = [];
    function onStatusChange(fn) { _statusListeners.push(fn); }
    function _notifyStatus(online) {
        _statusListeners.forEach(function(fn) { try { fn(online, _statusData); } catch(e) {} });
        _updateStatusBar(online);
    }

    function _updateStatusBar(online) {
        var bar = document.getElementById('bridge-status-bar');
        if (!bar) return;
        // Built with createElement/textContent — never innerHTML with response
        // data. Counts are coerced with Number() so a malformed bridge response
        // cannot inject markup.
        bar.textContent = '';
        var dot = document.createElement('span');
        dot.className = 'status-dot';
        bar.appendChild(dot);
        var text;
        if (online && _statusData) {
            bar.className = 'status-bar online';
            var products = Number(_statusData.product_count) || 0;
            var services = Number(_statusData.service_count) || 0;
            text = ' Bridge Connected — ' + products.toLocaleString() + ' products, ' +
                services + ' services';
        } else {
            bar.className = 'status-bar offline';
            text = ' Bridge Offline — Sample data mode (start AutoCAD + FabricationSample to connect)';
        }
        bar.appendChild(document.createTextNode(text));
    }

    async function get(path, fallback) {
        if (_online === null) await checkBridge();
        if (_online) {
            try {
                var resp = await fetch(bridgeUrl(path), { signal: AbortSignal.timeout(8000) });
                if (resp.ok) return await resp.json();
                console.warn('Bridge GET non-OK:', path, resp.status);
            } catch(e) {
                console.warn('Bridge GET failed:', path, e.message);
            }
            // Mid-session failure: flip to offline and notify, so the status
            // bar and panel banners reflect that the data rendered from here
            // on is SAMPLE data, not live. Sample must never wear a green dot.
            _online = false;
            _notifyStatus(false);
        }
        return (typeof fallback === 'function') ? fallback() : (fallback !== undefined ? fallback : null);
    }

    async function post(path, body) {
        if (_online === null) await checkBridge();
        if (!_online) return { success: false, error: 'Bridge offline' };
        try {
            var resp = await fetch(bridgeUrl(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000)
            });
            if (resp.ok) return await resp.json();
            try { return await resp.json(); } catch(e2) {}
            return { success: false, error: resp.status + ' ' + resp.statusText };
        } catch(e) {
            return { success: false, error: e.message || 'network error' };
        }
    }

    // ── Products ──────────────────────────────────────────────────────────────
    async function getProducts(query, limit, offset, sort) {
        var params = '?limit=' + (limit || 100) + '&offset=' + (offset || 0);
        if (query) params += '&q=' + encodeURIComponent(query);
        if (sort)  params += '&sort=' + encodeURIComponent(sort);
        return await get('/api/products' + params, SAMPLE.products);
    }

    // ── Services ──────────────────────────────────────────────────────────────
    async function getServices() {
        return await get('/api/services', SAMPLE.services);
    }

    async function getServiceEntries(name) {
        return await get('/api/services/' + encodeURIComponent(name) + '/entries', { entries: [], count: 0 });
    }

    // ── Price lists ───────────────────────────────────────────────────────────
    async function getPriceLists() {
        return await get('/api/price-lists', SAMPLE.priceLists);
    }

    async function getPriceEntries(listName, supplierGroup, query, limit, offset) {
        var params = '?limit=' + (limit || 100) + '&offset=' + (offset || 0);
        if (listName) params += '&list_name=' + encodeURIComponent(listName);
        // supplier_group + list_name TOGETHER identify a list — names alone
        // collide (two "Harrison List Prices" under different groups)
        if (supplierGroup) params += '&supplier_group=' + encodeURIComponent(supplierGroup);
        if (query) params += '&q=' + encodeURIComponent(query);
        return await get('/api/price-lists/entries' + params, SAMPLE.priceEntries);
    }

    // ── Cost estimate ─────────────────────────────────────────────────────────
    async function estimateCost(productIds) {
        // The bridge doesn't have a direct estimate endpoint — we pull individual
        // products and apply price-list multipliers client-side.
        return await post('/api/products/estimate', { product_ids: productIds });
    }

    // ── EST jobs ──────────────────────────────────────────────────────────────
    // EST MCP tools are separate from the bridge. The console's proxy sidecar
    // (public_console/proxy.py) serves this page AND bridges to the MCP server
    // at the same origin: POST /rpc {tool, arguments} → {ok, result}. Start it
    // with `python public_console/proxy.py` — when this page is served any
    // other way (e.g. file://), the call fails fast and the connect state shows.
    async function mcpCall(tool, args) {
        try {
            var resp = await fetch('/rpc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: tool, arguments: args || {} }),
                signal: AbortSignal.timeout(12000)
            });
            if (!resp.ok) return null;
            var data = await resp.json();
            return (data && data.ok) ? data.result : null;
        } catch(e) { return null; }
    }

    async function getStatus() {
        return await get('/api/status', SAMPLE.status);
    }

    // ── Database lists ────────────────────────────────────────────────────────
    async function getMaterials() {
        return await get('/api/materials', SAMPLE.materials);
    }

    async function getSections() {
        return await get('/api/sections', SAMPLE.sections);
    }

    async function getSpecifications() {
        return await get('/api/specifications', SAMPLE.specifications);
    }

    async function getItemStatuses() {
        return await get('/api/item-statuses', SAMPLE.itemStatuses);
    }

    async function getJobStatuses() {
        return await get('/api/job-statuses', SAMPLE.jobStatuses);
    }

    async function getServiceTypes() {
        return await get('/api/service-types', SAMPLE.serviceTypes);
    }

    async function getAncillaries() {
        return await get('/api/ancillaries', SAMPLE.ancillaries);
    }

    // Single product with prices + install times + linked services + image_path.
    // KNOWN BRIDGE LIMIT: ids containing spaces (a substantial share of the DB)
    // 404 until the bridge unescapes the path segment — callers must fall back
    // to row data.
    async function getProductDetail(id) {
        return await get('/api/products/' + encodeURIComponent(id), SAMPLE.productDetail);
    }

    // Build a same-bridge <img src> URL for a disk image path.
    // Returns null offline (sample mode shows no images).
    function imageUrl(path) {
        if (!path || !_online) return null;
        return bridgeUrl('/api/image?path=' + encodeURIComponent(path));
    }

    // Full template hierarchy for a SERVICE (route takes the service name,
    // not the template name): tabs → buttons → items → conditions.
    async function getServiceTree(serviceName) {
        return await get('/api/service-templates/' + encodeURIComponent(serviceName) + '/tree',
                         SAMPLE.serviceTree);
    }

    // ── Labor / pricing (Batch 3) ─────────────────────────────────────────────
    // Install-time tables: identity is (name, group) TOGETHER — some names
    // collide across material groups. type: 'breakpoint' (matrix) | 'simple'
    // (entries). Bare-list response.
    async function getInstallTables() {
        return await get('/api/install-times', SAMPLE.installTables);
    }

    // Entries for SIMPLE tables. Bridge field filters are substring — callers
    // exact-match (table_name, group) client-side and reconcile against the
    // table's own entry_count.
    async function getInstallEntries(tableName, group, limit, offset) {
        return await get('/api/install-times/entries?table_name=' + encodeURIComponent(tableName) +
                         '&group=' + encodeURIComponent(group || '') +
                         '&limit=' + (limit || 100) + '&offset=' + (offset || 0),
                         SAMPLE.installEntries);
    }

    // 2D matrix for BREAKPOINT tables (type=install; type=price exists for
    // price lists — not wired here yet).
    async function getBreakpointTable(name) {
        return await get('/api/breakpoint-table?type=install&name=' + encodeURIComponent(name),
                         SAMPLE.breakpointTable);
    }

    async function getDiscountCodes() {
        return await get('/api/discount-codes', SAMPLE.discountCodes);
    }

    // Placed items in the CURRENT drawing (requires an open job + a cache
    // built while it was open). Server filters: q/service/status/section.
    async function getJobItems(q, limit, offset) {
        return await get('/api/job/items?q=' + encodeURIComponent(q || '') +
                         '&limit=' + (limit || 100) + '&offset=' + (offset || 0),
                         SAMPLE.jobItems);
    }

    function isOnline() { return _online; }
    function statusData() { return _statusData; }

    // ── Sample data (fallback when bridge offline) ────────────────────────────
    var SAMPLE = {
        status: {
            status: 'demo',
            product_count: 0,
            service_count: 0,
            price_entries_count: 0,
            install_entries_count: 0
        },
        products: {
            total: 8, offset: 0, limit: 100,
            data: [
                { id: 'S001', description: '90 Elbow 2" No-Hub', manufacturer: 'ACME Supply', size: '2"', material: 'Cast Iron', specification: 'NH', cost: 4.85 },
                { id: 'S002', description: '90 Elbow 3" No-Hub', manufacturer: 'ACME Supply', size: '3"', material: 'Cast Iron', specification: 'NH', cost: 9.20 },
                { id: 'S003', description: '90 Elbow 4" No-Hub', manufacturer: 'ACME Supply', size: '4"', material: 'Cast Iron', specification: 'NH', cost: 16.40 },
                { id: 'S004', description: 'Tee 2" No-Hub', manufacturer: 'ACME Supply', size: '2"', material: 'Cast Iron', specification: 'NH', cost: 7.30 },
                { id: 'S005', description: 'Tee 3" No-Hub', manufacturer: 'ACME Supply', size: '3"', material: 'Cast Iron', specification: 'NH', cost: 13.65 },
                { id: 'S006', description: 'Coupling 2" PVC DWV', manufacturer: 'GenPipe Co', size: '2"', material: 'PVC', specification: 'DWV', cost: 1.20 },
                { id: 'S007', description: 'Coupling 4" PVC DWV', manufacturer: 'GenPipe Co', size: '4"', material: 'PVC', specification: 'DWV', cost: 3.85 },
                { id: 'S008', description: '45 Elbow 2" Copper', manufacturer: 'MechParts Inc', size: '2"', material: 'Copper', specification: 'Wrot', cost: 6.10 }
            ]
        },
        services: [
            { name: 'Sanitary Waste', template: 'Cast Iron NH / PVC DWV', item_count: 412 },
            { name: 'Domestic Cold Water', template: 'Copper ProPress', item_count: 287 },
            { name: 'Domestic Hot Water', template: 'Copper ProPress', item_count: 243 },
            { name: 'Storm Drain', template: 'Cast Iron NH', item_count: 198 },
            { name: 'Vent', template: 'Cast Iron NH / PVC DWV', item_count: 156 },
            { name: 'Condensate', template: 'PVC Sch40', item_count: 88 }
        ],
        // Field names mirror the live bridge payloads exactly
        // (price lists: list_name; entries: cost / discount_code / units)
        priceLists: {
            count: 3,
            data: [
                { list_name: 'Standard List', supplier_group: 'Mechanical', entry_count: 3200, last_updated: '2025-01-15' },
                { list_name: 'Plumbing Material', supplier_group: 'Plumbing', entry_count: 1850, last_updated: '2025-02-01' },
                { list_name: 'Sheet Metal', supplier_group: 'Sheet Metal', entry_count: 740, last_updated: '2025-01-20' }
            ]
        },
        // Mirrors the live entry shape incl. supplier_group + list_name (a
        // list is identified by BOTH) and harrison_code/manufacturer/material
        priceEntries: {
            total: 5,
            data: [
                { product_id: 'S001', description: '90 Elbow 2" No-Hub', size: '2"', harrison_code: 'SAMPLE-HC-003', manufacturer: '(Generic)', material: 'Cast Iron', cost: 4.85, discount_code: 'Cast Iron:ci', units: '(each)', status: 'Active', supplier_group: 'Mechanical', list_name: 'Standard List' },
                { product_id: 'S002', description: '90 Elbow 3" No-Hub', size: '3"', harrison_code: 'SAMPLE-HC-004', manufacturer: '(Generic)', material: 'Cast Iron', cost: 9.20, discount_code: 'Cast Iron:ci', units: '(each)', status: 'Active', supplier_group: 'Mechanical', list_name: 'Standard List' },
                { product_id: 'S003', description: '90 Elbow 4" No-Hub', size: '4"', harrison_code: 'SAMPLE-HC-005', manufacturer: '(Generic)', material: 'Cast Iron', cost: 16.40, discount_code: 'Cast Iron:ci', units: '(each)', status: 'Active', supplier_group: 'Mechanical', list_name: 'Standard List' },
                { product_id: 'S004', description: 'Tee 2" No-Hub', size: '2"', harrison_code: 'N/A', manufacturer: '(Generic)', material: 'Cast Iron', cost: 7.30, discount_code: 'Cast Iron:ci', units: '(each)', status: 'Active', supplier_group: 'Mechanical', list_name: 'Standard List' },
                { product_id: 'S006', description: 'Coupling 2" PVC DWV', size: '2"', harrison_code: 'N/A', manufacturer: '(Generic)', material: 'PVC', cost: 1.20, discount_code: 'PVC:pvc', units: '(each)', status: 'Active', supplier_group: 'Plumbing', list_name: 'Plumbing Material' }
            ]
        },

        // ── Database list fixtures — field shapes mirror live endpoints exactly ──
        // (grid rule #1: fixtures lie in the same shape as truth)

        materials: {
            count: 5,
            data: [
                { name: 'Copper',        group: 'Pipework',       gauge_count: 8  },
                { name: 'Cast Iron',     group: 'Drainage',       gauge_count: 4  },
                { name: 'PVC',           group: 'Drainage',       gauge_count: 6  },
                { name: 'Carbon Steel',  group: 'Mechanical',     gauge_count: 12 },
                { name: 'Stainless',     group: 'Pipework',       gauge_count: 5  }
            ]
        },

        sections: {
            count: 3,
            data: [
                { name: "20'",   index: 1 },
                { name: "10'",   index: 2 },
                { name: "5'",    index: 3 }
            ]
        },

        specifications: {
            count: 3,
            data: [
                { name: 'Schedule 40' },
                { name: 'Schedule 80' },
                { name: 'DWV'         }
            ]
        },

        itemStatuses: {
            count: 4,
            data: [
                { index: 0, name: 'Pending',   color: '2', layer_tag: 'FAB-PENDING',   output: true  },
                { index: 1, name: 'Approved',  color: '3', layer_tag: 'FAB-APPROVED',  output: true  },
                { index: 2, name: 'On Hold',   color: '1', layer_tag: 'FAB-HOLD',      output: false },
                { index: 3, name: 'Complete',  color: '5', layer_tag: 'FAB-DONE',      output: false }
            ]
        },

        // Live shape DIFFERS from item-statuses: {index, description, active,
        // do_save, do_copy} — the panel normalizes description→name, active→output.
        // Rows here exercise that path in offline mode.
        jobStatuses: {
            count: 2,
            data: [
                { index: 0, description: 'Estimating', active: true,  do_save: false, do_copy: false },
                { index: 1, description: 'Released',   active: false, do_save: true,  do_copy: false }
            ]
        },

        serviceTypes: {
            count: 4,
            data: [
                { id: 0,  description: '  0: Equipment'        },
                { id: 1,  description: '  1: Pipe'             },
                { id: 2,  description: '  2: Duct'             },
                { id: 3,  description: '  3: Hanger'           }
            ]
        },

        productDetail: {
            id: 'SAMPLE_PIPE_CU-K-0001',
            description: 'Pipe - Copper Type K - 20ft',
            product_name: 'Pipework',
            size: '3/4',
            manufacturer: '(Generic)',
            material: 'Copper',
            specification: 'Type K',
            install_type: 'Copper Male x Copper Male',
            source: 'Pipe - Copper Type K - 20ft',
            range: 'Standard',
            finish: 'N/A',
            group: 'Mechanical',
            is_product_listed: 'Yes',
            image_path: '',
            supplier_ids: {
                'Harrison': 'SAMPLE-HC-001', 'Ferguson': 'N/A',
                'Manufacturer Code': 'N/A', 'UPC Code': 'N/A', 'OEM Code': 'N/A'
            },
            prices: [
                { supplier_group: 'Sample Supplier', list_name: 'Sample List Prices',
                  cost: 12.34, discount_code: 'Copper Pipe:sample', units: '(each)',
                  date: '2026-01-01', status: 'Active' }
            ],
            install_times: [
                { table_name: 'Sample Labor Table', group: 'Sample - Labor',
                  labor_rate: 0.25, units: '(each)', status: 'Active' }
            ],
            linked_services: ['Sample Service A']
        },

        serviceTree: {
            service_name: 'Sample Service A',
            template_name: 'Sample Template',
            tab_count: 2, button_count: 3, item_count: 4,
            cache_ready: true,
            tabs: [
                { name: 'Copper (Soldered)', button_count: 2, buttons: [
                    { name: 'Type M - 20ft', image: '', item_count: 2,
                      product_ids: '1/2,3/4',
                      items: [
                        { entry_name: '1/2', database_id: 'SAMPLE_PIPE_CU-M-0001',
                          condition_desc: '', condition_id: 'N/A',
                          greater_than: 'Unrestricted', less_than_eq: '0.75',
                          image_path: '', item_folder: 'Pipework', item_path: '' },
                        { entry_name: '3/4', database_id: 'SAMPLE_PIPE_CU-M-0002',
                          condition_desc: '', condition_id: 'N/A',
                          greater_than: '0.75', less_than_eq: 'Unrestricted',
                          image_path: '', item_folder: 'Pipework', item_path: '' }
                      ] },
                    { name: 'Coupling', image: '', item_count: 1,
                      product_ids: '1/2',
                      items: [
                        { entry_name: '1/2', database_id: 'SAMPLE_CPLG_CU-0001',
                          condition_desc: '', condition_id: 'N/A',
                          greater_than: 'Unrestricted', less_than_eq: 'Unrestricted',
                          image_path: '', item_folder: 'Fittings', item_path: '' }
                      ] }
                ]},
                { name: 'Press Fit', button_count: 1, buttons: [
                    { name: 'Press Coupling', image: '', item_count: 1,
                      product_ids: '1/2',
                      items: [
                        { entry_name: '1/2', database_id: 'SAMPLE_CPLG_PF-0001',
                          condition_desc: '', condition_id: 'N/A',
                          greater_than: 'Unrestricted', less_than_eq: 'Unrestricted',
                          image_path: '', item_folder: 'Fittings', item_path: '' }
                      ] }
                ]}
            ]
        },

        jobItems: {
            total: 3, offset: 0, limit: 100, cache_ready: true,
            data: [
                { unique_id: 'SAMPLE-UID-0001', name: 'Pipe - Copper Type L', cid: 2041,
                  service: 'Sample Service A', status: 'Design', section: "20'",
                  spool_name: 'SP-001', zone: 'Level 1', order: '', notes: '' },
                { unique_id: 'SAMPLE-UID-0002', name: '90 Elbow', cid: 2523,
                  service: 'Sample Service A', status: 'Design', section: "20'",
                  spool_name: 'SP-001', zone: 'Level 1', order: '', notes: '' },
                { unique_id: 'SAMPLE-UID-0003', name: 'Coupling', cid: 522,
                  service: 'Sample Service B', status: 'Fabrication', section: "10'",
                  spool_name: 'SP-002', zone: 'Level 2', order: '', notes: 'rush' }
            ]
        },

        installTables: [
            { name: 'Sample Labor Table',            group: 'Sample - Labor',          type: 'simple',     entry_count: 3 },
            { name: 'Press - 90 Elbow (P x P)',      group: 'Fittings - Carbon Steel', type: 'breakpoint', entry_count: 0 },
            { name: 'Press - 90 Elbow (P x P)',      group: 'Fittings - Stainless',    type: 'breakpoint', entry_count: 0 },
            { name: 'Solder - Coupling (C x C)',     group: 'Fittings - Copper',       type: 'breakpoint', entry_count: 0 }
        ],

        installEntries: {
            total: 3, offset: 0, limit: 100, cache_ready: true,
            data: [
                { table_name: 'Sample Labor Table', group: 'Sample - Labor', labor_rate: 0.25,
                  units: '(each)', status: 'Active', product_id: 'SAMPLE_FIT_90E-0001',
                  description: '90 Elbow', manufacturer: '(Generic)', material: 'Copper',
                  size: '1/2', harrison_code: 'N/A' },
                { table_name: 'Sample Labor Table', group: 'Sample - Labor', labor_rate: 0.31,
                  units: '(each)', status: 'Active', product_id: 'SAMPLE_FIT_90E-0002',
                  description: '90 Elbow', manufacturer: '(Generic)', material: 'Copper',
                  size: '3/4', harrison_code: 'SAMPLE-HC-002' },
                { table_name: 'Sample Labor Table', group: 'Sample - Labor', labor_rate: 0.42,
                  units: '(each)', status: 'Active', product_id: 'SAMPLE_FIT_TEE-0001',
                  description: 'Tee', manufacturer: '(Generic)', material: 'Copper',
                  size: '1/2', harrison_code: 'N/A' }
            ]
        },

        breakpointTable: {
            name: 'Press - 90 Elbow (P x P)', table_type: 'install',
            costed_by: 'ByQuantity',
            horizontal_units: 'None', vertical_units: 'Inches',
            horizontal_type: 'None', vertical_type: 'DuctEnd1WidthOrDiameter',
            column_count: 3, row_count: 4,
            horizontal_breakpoints: [{ value: 1 }, { value: 2 }, { value: 3 }],
            vertical_breakpoints: [{ value: 0.5 }, { value: 0.75 }, { value: 1 }, { value: 1.5 }],
            values: [
                { row_label: 0.5,  'c_1.00': 0.10, 'c_2.00': 0.12, 'c_3.00': 0.15 },
                { row_label: 0.75, 'c_1.00': 0.12, 'c_2.00': 0.15, 'c_3.00': 0.18 },
                { row_label: 1,    'c_1.00': 0.15, 'c_2.00': 0.18, 'c_3.00': 0.22 },
                { row_label: 1.5,  'c_1.00': 0.20, 'c_2.00': 0.24, 'c_3.00': 0.30 }
            ]
        },

        discountCodes: {
            count: 4,
            data: [
                { supplier_group: 'Sample Supplier', code: 'Copper Fittings:cufit',  value: 0.42, description: '' },
                { supplier_group: 'Sample Supplier', code: 'Steel Pipe:stlpip',      value: 0.55, description: '' },
                { supplier_group: 'Sample Supplier', code: 'Ball Valves:bv',         value: 0.38, description: '' },
                { supplier_group: 'Sample Supplier', code: 'ABS Fittings:abs',       value: 1,    description: '' }
            ]
        },

        ancillaries: {
            count: 5,
            data: [
                { ancillary_type: 'SupportRod',        cost_type: 'PriceList', can_change: true,  fab_time_type: 'Value',      install_time_type: 'TimesTable' },
                { ancillary_type: 'Fixing',            cost_type: 'PriceList', can_change: true,  fab_time_type: 'Value',      install_time_type: 'TimesTable' },
                { ancillary_type: 'Clip',              cost_type: 'Value',     can_change: false, fab_time_type: 'Value',      install_time_type: 'Value'      },
                { ancillary_type: 'AncillaryMaterial', cost_type: 'PriceList', can_change: true,  fab_time_type: 'TimesTable', install_time_type: 'TimesTable' },
                { ancillary_type: 'Gasket',            cost_type: 'Value',     can_change: true,  fab_time_type: 'Value',      install_time_type: 'Value'      }
            ]
        }
    };

    return {
        checkBridge: checkBridge,
        onStatusChange: onStatusChange,
        isOnline: isOnline,
        statusData: statusData,
        getStatus: getStatus,
        getProducts: getProducts,
        getServices: getServices,
        getServiceEntries: getServiceEntries,
        getPriceLists: getPriceLists,
        getPriceEntries: getPriceEntries,
        estimateCost: estimateCost,
        getMaterials: getMaterials,
        getSections: getSections,
        getSpecifications: getSpecifications,
        getItemStatuses: getItemStatuses,
        getJobStatuses: getJobStatuses,
        getServiceTypes: getServiceTypes,
        getAncillaries: getAncillaries,
        getProductDetail: getProductDetail,
        getServiceTree: getServiceTree,
        getJobItems: getJobItems,
        getInstallTables: getInstallTables,
        getInstallEntries: getInstallEntries,
        getBreakpointTable: getBreakpointTable,
        getDiscountCodes: getDiscountCodes,
        imageUrl: imageUrl,
        mcpCall: mcpCall,
        get: get,
        post: post,
        SAMPLE: SAMPLE
    };
})();

// Auto-check on load
BridgeClient.checkBridge();
