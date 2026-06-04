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
    async function getProducts(query, limit, offset) {
        var params = '?limit=' + (limit || 100) + '&offset=' + (offset || 0);
        if (query) params += '&q=' + encodeURIComponent(query);
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

    async function getPriceEntries(listName, query, limit, offset) {
        var params = '?limit=' + (limit || 100) + '&offset=' + (offset || 0);
        if (listName) params += '&list_name=' + encodeURIComponent(listName);
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
    // EST MCP tools are separate from the bridge. MCP's stdio/SSE transports
    // are not browser-reachable, so this is a PATTERN STUB: it probes a plain
    // JSON-RPC-over-HTTP endpoint (e.g. a thin tools/call proxy) on :8005 and
    // shows the connect state when none answers. See README "EST Jobs panel".
    async function mcpCall(tool, args) {
        var url = 'http://localhost:8005/mcp/v1';
        try {
            var resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: tool, arguments: args || {} }, id: 1 }),
                signal: AbortSignal.timeout(12000)
            });
            if (!resp.ok) return null;
            var data = await resp.json();
            if (data.result && data.result.content) {
                var txt = data.result.content.find(function(c) { return c.type === 'text'; });
                if (txt) { try { return JSON.parse(txt.text); } catch(e) { return txt.text; } }
            }
            return null;
        } catch(e) { return null; }
    }

    async function getStatus() {
        return await get('/api/status', SAMPLE.status);
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
        priceLists: {
            count: 3,
            data: [
                { name: 'Standard List', supplier_group: 'Mechanical', entry_count: 3200, last_updated: '2025-01-15' },
                { name: 'Plumbing Material', supplier_group: 'Plumbing', entry_count: 1850, last_updated: '2025-02-01' },
                { name: 'Sheet Metal', supplier_group: 'Sheet Metal', entry_count: 740, last_updated: '2025-01-20' }
            ]
        },
        priceEntries: {
            total: 5,
            data: [
                { product_id: 'S001', description: '90 Elbow 2" No-Hub', size: '2"', list_price: 4.85, multiplier: 0.82, net_price: 3.98 },
                { product_id: 'S002', description: '90 Elbow 3" No-Hub', size: '3"', list_price: 9.20, multiplier: 0.82, net_price: 7.54 },
                { product_id: 'S003', description: '90 Elbow 4" No-Hub', size: '4"', list_price: 16.40, multiplier: 0.80, net_price: 13.12 },
                { product_id: 'S004', description: 'Tee 2" No-Hub', size: '2"', list_price: 7.30, multiplier: 0.82, net_price: 5.99 },
                { product_id: 'S006', description: 'Coupling 2" PVC DWV', size: '2"', list_price: 1.20, multiplier: 0.75, net_price: 0.90 }
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
        mcpCall: mcpCall,
        get: get,
        post: post,
        SAMPLE: SAMPLE
    };
})();

// Auto-check on load
BridgeClient.checkBridge();
