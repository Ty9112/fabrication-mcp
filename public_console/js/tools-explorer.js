/**
 * MCP Tools Explorer — catalogs every MCP tool the console's server exposes.
 *
 * Data source: live `GET /rpc/tools` from the same-origin proxy (proxy.py);
 * falls back to the committed static capture `data/tools.json` when /rpc is
 * unreachable (e.g. served by a plain static server). Both carry the same
 * shape: { ok, count, tools: [{ name, description, inputSchema }] }.
 *
 * Modes: floating popup (default, mirrors the FloatPanel drag pattern) or
 * docked inline under the "MCP Tools" nav node. Mode persists in
 * localStorage ('toolsExplorer.docked'); the core (toolbar + body) is ONE
 * DOM subtree moved between the two hosts.
 *
 * Esc layering (capture phase, same convention as FloatPanel): the float
 * (z 90) closes first, then this popup (z 85), then the drawer (z 80).
 *
 * DOM safety: all dynamic content uses textContent / createElement — no
 * innerHTML with response data (same contract as app.js).
 */
var ToolsExplorer = (function() {
    var DOCK_KEY = 'toolsExplorer.docked';
    var MODULE_ORDER = ['csv', 'bridge', 'est', 'estimate', 'profile', 'batch', 'diagnostics'];

    var pop = document.getElementById('tools-pop');
    var popHead = document.getElementById('tools-pop-head');
    var navBtn = document.getElementById('tools-nav-btn');
    var dockLi = document.getElementById('tools-dock-li');
    var dockHost = document.getElementById('tools-dock');

    var tools = null;          // normalized [{name, description, module, params}]
    var loadPromise = null;
    var query = '';
    var groupOpen = {};        // module -> bool (in-memory only, not persisted)
    var docked = false;
    try { docked = localStorage.getItem(DOCK_KEY) === 'true'; } catch (e) {}

    /* ── Toast ──────────────────────────────────────────────────── */
    var _toastTimer = null;
    function showToast(msg) {
        var t = document.getElementById('pub-toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function() { t.classList.remove('show'); }, 1800);
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function(resolve, reject) {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
            finally { document.body.removeChild(ta); }
        });
    }

    /* ── Data: fetch + normalize ────────────────────────────────── */
    // Module grouping — prefix heuristics over the tool name (the tools/list
    // payload carries no module tag). Order matters: `get_estimate*` must be
    // tested before the csv fallback; `estimate_cost` is csv, not estimate.
    function deriveModule(name) {
        if (name.indexOf('live_') === 0 || name === 'get_live_status' ||
            name === 'get_service_buttons') return 'bridge';
        if (name.indexOf('est_') === 0) return 'est';
        if (name.indexOf('get_estimate') === 0 || name === 'get_cost_comparison' ||
            name === 'get_price_health') return 'estimate';
        if (name.indexOf('batch_') === 0) return 'batch';
        if (name === 'get_diagnostics') return 'diagnostics';
        if (name.indexOf('profile') !== -1) return 'profile';
        return 'csv';
    }

    function schemaType(prop) {
        if (!prop) return 'any';
        if (prop.type) return Array.isArray(prop.type) ? prop.type.join('|') : prop.type;
        if (prop.anyOf) {
            var types = prop.anyOf.map(function(s) {
                return s.type || (s.enum ? 'enum' : 'any');
            }).filter(function(t) { return t !== 'null'; });
            return types.join('|') || 'any';
        }
        if (prop.enum) return 'enum';
        return 'any';
    }

    function schemaParams(schema) {
        var props = (schema && schema.properties) || {};
        var required = (schema && schema.required) || [];
        return Object.keys(props).map(function(key) {
            var p = props[key] || {};
            var def = p['default'];
            return {
                name: key,
                type: schemaType(p),
                required: required.indexOf(key) !== -1,
                'default': (def === undefined || def === null) ? null
                    : (typeof def === 'object' ? JSON.stringify(def) : String(def)),
                description: p.description || ''
            };
        });
    }

    function normalize(raw) {
        return (raw.tools || []).map(function(t) {
            return {
                name: t.name,
                // Full description — rows display one line (CSS ellipsis) with
                // the full text in the title attr; search covers all of it.
                description: t.description || '',
                module: deriveModule(t.name),
                params: schemaParams(t.inputSchema)
            };
        });
    }

    function loadTools() {
        if (loadPromise) return loadPromise;
        loadPromise = fetch('/rpc/tools', { signal: AbortSignal.timeout(8000) })
            .then(function(r) { if (!r.ok) throw new Error('rpc ' + r.status); return r.json(); })
            .catch(function() {
                // Static fallback — committed capture of the live response
                return fetch('data/tools.json').then(function(r) {
                    if (!r.ok) throw new Error('static ' + r.status);
                    return r.json();
                });
            })
            .then(function(raw) { tools = normalize(raw); return tools; })
            .catch(function() { tools = []; return tools; });
        return loadPromise;
    }

    /* ── Core DOM (toolbar + body) — built once, moved between hosts ── */
    var core = document.createElement('div');
    core.id = 'tools-core';
    core.style.display = 'contents';

    var toolbar = document.createElement('div');
    toolbar.className = 'tools-toolbar';

    var badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.id = 'tools-count-badge';
    badge.textContent = '0';
    toolbar.appendChild(badge);

    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'search-input compact';
    search.placeholder = 'Search tools…';
    search.setAttribute('aria-label', 'Search MCP tools');
    search.autocomplete = 'off';
    toolbar.appendChild(search);

    var dockBtn = document.createElement('button');
    dockBtn.className = 'btn-ghost small';
    dockBtn.id = 'tools-dock-btn';
    toolbar.appendChild(dockBtn);

    var body = document.createElement('div');
    body.className = 'tools-body';

    core.appendChild(toolbar);
    core.appendChild(body);

    /* ── SVG helpers (static paths only) ────────────────────────── */
    function svgIcon(paths) {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        paths.forEach(function(d) {
            var el;
            if (d.rect) {
                el = document.createElementNS(NS, 'rect');
                Object.keys(d.rect).forEach(function(k) { el.setAttribute(k, d.rect[k]); });
            } else {
                el = document.createElementNS(NS, 'path');
                el.setAttribute('d', d);
            }
            svg.appendChild(el);
        });
        return svg;
    }
    // Lucide chevron-right v0.513.0 ISC
    function chevronIcon() { return svgIcon(['m9 18 6-6-6-6']); }
    // Lucide copy v0.513.0 ISC
    function copyIcon() {
        return svgIcon([
            { rect: { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' } },
            'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'
        ]);
    }

    /* ── Rendering ──────────────────────────────────────────────── */
    function buildParamsTable(tool) {
        var wrap = document.createElement('div');
        wrap.className = 'tools-params';
        if (!tool.params.length) {
            var none = document.createElement('span');
            none.className = 'tools-no-params';
            none.textContent = 'No parameters';
            wrap.appendChild(none);
            return wrap;
        }
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        ['Param', 'Type', 'Required', 'Default', 'Description'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        tool.params.forEach(function(p) {
            var tr = document.createElement('tr');
            function td(text, mono) {
                var cell = document.createElement('td');
                if (mono) cell.className = 'mono';
                cell.textContent = text;
                tr.appendChild(cell);
            }
            td(p.name, true);
            td(p.type, true);
            td(p.required ? 'yes' : '—');
            td(p['default'] === null ? '—' : p['default'], true);
            td(p.description || '—');
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    function buildRow(tool) {
        var row = document.createElement('div');
        row.className = 'tools-row';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-expanded', 'false');
        row.title = tool.description;

        var name = document.createElement('span');
        name.className = 'tools-row-name';
        name.textContent = tool.name;
        row.appendChild(name);

        var desc = document.createElement('span');
        desc.className = 'tools-row-desc';
        desc.textContent = tool.description;
        row.appendChild(desc);

        var copyBtn = document.createElement('button');
        copyBtn.className = 'tools-copy';
        copyBtn.setAttribute('aria-label', 'Copy tool name ' + tool.name);
        copyBtn.title = 'Copy tool name';
        copyBtn.appendChild(copyIcon());
        copyBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            copyText(tool.name).then(
                function() { showToast('Copied “' + tool.name + '”'); },
                function() { showToast('Copy failed'); }
            );
        });
        row.appendChild(copyBtn);

        var paramsEl = null;   // built lazily on first expand
        function toggle() {
            var open = row.getAttribute('aria-expanded') === 'true';
            if (open) {
                row.setAttribute('aria-expanded', 'false');
                if (paramsEl) paramsEl.remove();
            } else {
                row.setAttribute('aria-expanded', 'true');
                if (!paramsEl) paramsEl = buildParamsTable(tool);
                row.after(paramsEl);
            }
        }
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        return row;
    }

    function render() {
        clearElement(body);
        if (!tools) {
            body.appendChild(el('div', 'tools-empty', 'Loading…'));
            return;
        }
        if (!tools.length) {
            body.appendChild(el('div', 'tools-empty',
                'Could not load the tool catalog — /rpc unreachable and no static capture.'));
            return;
        }
        var q = query.toLowerCase();
        var shownAny = false;
        MODULE_ORDER.forEach(function(mod) {
            var group = tools.filter(function(t) { return t.module === mod; });
            var matches = q
                ? group.filter(function(t) {
                    return t.name.toLowerCase().indexOf(q) !== -1 ||
                           t.description.toLowerCase().indexOf(q) !== -1;
                })
                : group;
            if (!matches.length) return;   // empty groups hidden (always during search)
            shownAny = true;

            // While searching, groups with matches are forced open; manual
            // collapse state applies only to the unfiltered view.
            var open = q ? true : !!groupOpen[mod];

            var head = document.createElement('button');
            head.className = 'tools-group-head';
            head.setAttribute('aria-expanded', String(open));
            head.appendChild(chevronIcon());
            head.appendChild(document.createTextNode(mod + ' '));
            var count = document.createElement('span');
            count.className = 'tools-group-count';
            count.textContent = '(' + matches.length + ')';
            head.appendChild(count);
            body.appendChild(head);

            var rows = document.createElement('div');
            if (!open) rows.style.display = 'none';
            matches.forEach(function(t) { rows.appendChild(buildRow(t)); });
            body.appendChild(rows);

            head.addEventListener('click', function() {
                var nowOpen = head.getAttribute('aria-expanded') !== 'true';
                head.setAttribute('aria-expanded', String(nowOpen));
                rows.style.display = nowOpen ? '' : 'none';
                if (!q) groupOpen[mod] = nowOpen;
            });
        });
        if (!shownAny) body.appendChild(el('div', 'tools-empty', 'No tools match the search.'));
    }

    function ensureLoaded() {
        if (tools) return;
        render();   // "Loading…"
        loadTools().then(function() {
            badge.textContent = String(tools.length);
            // Default collapse state: all collapsed except the first
            // non-empty module group (spec) — set once, on first load.
            for (var i = 0; i < MODULE_ORDER.length; i++) {
                var mod = MODULE_ORDER[i];
                if (tools.some(function(t) { return t.module === mod; })) {
                    groupOpen[mod] = true;
                    break;
                }
            }
            render();
        });
    }

    /* ── Mode plumbing: popup <-> docked ────────────────────────── */
    function applyMode() {
        dockBtn.textContent = docked ? 'Pop out' : 'Dock to nav';
        if (docked) {
            pop.classList.remove('open');
            dockHost.appendChild(core);
        } else {
            dockLi.classList.add('hidden');
            navBtn.setAttribute('aria-expanded', 'false');
            pop.appendChild(core);
        }
    }

    function openPopup() {
        pop.classList.add('open');
        ensureLoaded();
    }
    function closePopup() { pop.classList.remove('open'); }

    function dockExpanded() { return !dockLi.classList.contains('hidden'); }

    function toggleDock() {
        docked = !docked;
        try { localStorage.setItem(DOCK_KEY, String(docked)); } catch (e) {}
        applyMode();
        if (docked) {
            dockLi.classList.remove('hidden');
            navBtn.setAttribute('aria-expanded', 'true');
            ensureLoaded();
        } else {
            openPopup();
        }
    }

    dockBtn.addEventListener('click', toggleDock);

    navBtn.addEventListener('click', function() {
        if (docked) {
            var show = !dockExpanded();
            dockLi.classList.toggle('hidden', !show);
            navBtn.setAttribute('aria-expanded', String(show));
            if (show) ensureLoaded();
        } else {
            if (pop.classList.contains('open')) closePopup();
            else openPopup();
        }
    });

    document.getElementById('tools-pop-close').addEventListener('click', closePopup);

    /* ── Search ─────────────────────────────────────────────────── */
    search.addEventListener('input', function() {
        query = search.value.trim();
        render();
    });

    /* ── Keyboard ───────────────────────────────────────────────── */
    // Esc — capture phase, same convention as FloatPanel. The float (z 90)
    // sits above this popup (z 85). stopPropagation does NOT suppress other
    // listeners on the same node, so two guards keep one keypress to one
    // layer regardless of registration order: e.cancelBubble detects that a
    // higher layer already claimed this event (FloatPanel runs first and
    // stops propagation), and the open-check defers while the float is up.
    // Our own stopPropagation protects the drawer's bubble handler (z 80).
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape' || !pop.classList.contains('open')) return;
        if (e.cancelBubble) return;
        var float = document.getElementById('pub-float');
        if (float && float.classList.contains('open')) return;
        e.stopPropagation();
        closePopup();
    }, true);

    // `/` focuses the search when the explorer is open (popup or docked) —
    // unless the user is already typing somewhere.
    document.addEventListener('keydown', function(e) {
        if (e.key !== '/') return;
        var active = pop.classList.contains('open') || (docked && dockExpanded());
        if (!active) return;
        var t = e.target;
        var tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
            (t && t.isContentEditable)) return;
        e.preventDefault();
        search.focus();
    });

    /* ── Popup drag — FloatPanel's pointer pattern, head only ───── */
    var drag = null;
    popHead.addEventListener('pointerdown', function(e) {
        if (e.target.closest('button')) return;
        var r = pop.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        popHead.setPointerCapture(e.pointerId);
    });
    popHead.addEventListener('pointermove', function(e) {
        if (!drag) return;
        pop.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
        pop.style.top  = Math.max(0, e.clientY - drag.dy) + 'px';
        pop.style.right = 'auto';
    });
    function endDrag() { drag = null; }
    popHead.addEventListener('pointerup', endDrag);
    popHead.addEventListener('pointercancel', endDrag);
    popHead.addEventListener('lostpointercapture', endDrag);

    /* ── Boot ───────────────────────────────────────────────────── */
    applyMode();   // place the core in the persisted host (dock stays collapsed)

    return { open: openPopup, close: closePopup, toggleDock: toggleDock };
})();
