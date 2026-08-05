/*
 * ThreadStack — Wissensnetz-Graph (Paket 4: Web-App Graph-Modul)
 *
 * Exponiert ausschließlich window.TSGraph = { mount, unmount, invalidate, isMounted }.
 * Konsumiert window.TSHost (siehe Vertrag in der Architektur / graph-dev.html Mock).
 *
 * Keine Fremdbibliothek, kein Build-Step, reines SVG.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var NODE_R = 26; // nomineller "Radius" für Hit-Test / Layout-Spacing
  var ZOOM_MIN = 0.2;
  var ZOOM_MAX = 4.0;
  var STORAGE_FILTER_KEY = 'tsg.activeTypes.v1';
  var TYPES = ['theme', 'knowledge', 'todo', 'topic', 'contact'];
  var TYPE_LABELS = {
    theme: 'Topic', knowledge: 'Wissensseite', todo: 'Todo', topic: 'Meeting-Thema', contact: 'Ansprechpartner'
  };
  var MAX_COMFORTABLE_NODES = 500;

  function key(type, id) { return type + ':' + id; }

  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function debounce(fn, ms) {
    var t = null;
    var wrapped = function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
    wrapped.cancel = function () { clearTimeout(t); };
    return wrapped;
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
      }
    }
    return el;
  }

  function htmlEl(tag, attrs, text) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') el.className = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
    }
    if (text != null) el.textContent = text;
    return el;
  }

  // ---- Icon path fragments (viewBox-local, centered at 0,0, ~14px) --------
  var ICONS = {
    theme: 'M -7 -3 L -3 -3 L -1.5 -5 L 7 -5 L 7 5 L -7 5 Z',
    knowledge: 'M -6 -7 L 3 -7 L 6 -4 L 6 7 L -6 7 Z M 3 -7 L 3 -4 L 6 -4',
    todo: 'M -5 0 L -1.5 3.5 L 5 -4',
    topic: 'M -7 -5 L 7 -5 L 7 3 L -1 3 L -4 6 L -4 3 L -7 3 Z',
    contact: 'M 0 -2 A 3 3 0 1 0 0.01 -2 M -5 6 C -5 1 5 1 5 6'
  };

  function buildNodeShape(type) {
    var g = svgEl('g', {});
    switch (type) {
      case 'theme':
        g.appendChild(svgEl('circle', { class: 'tsg-shape', r: NODE_R, cx: 0, cy: 0 }));
        break;
      case 'knowledge':
        g.appendChild(svgEl('rect', { class: 'tsg-shape', x: -NODE_R, y: -NODE_R * 0.78, width: NODE_R * 2, height: NODE_R * 1.56, rx: 6 }));
        break;
      case 'todo': {
        var d = NODE_R * 1.05;
        g.appendChild(svgEl('polygon', { class: 'tsg-shape', points: [0, -d, d, 0, 0, d, -d, 0].join(',') }));
        break;
      }
      case 'topic': {
        var pts = [];
        for (var i = 0; i < 6; i++) {
          var ang = Math.PI / 6 + i * Math.PI / 3;
          pts.push((NODE_R * Math.cos(ang)).toFixed(1) + ',' + (NODE_R * Math.sin(ang)).toFixed(1));
        }
        g.appendChild(svgEl('polygon', { class: 'tsg-shape', points: pts.join(' ') }));
        break;
      }
      case 'contact':
        g.appendChild(svgEl('circle', { class: 'tsg-shape', r: NODE_R, cx: 0, cy: 0 }));
        g.appendChild(svgEl('circle', { r: NODE_R - 5, cx: 0, cy: 0, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, opacity: .5 }));
        break;
    }
    var icon = svgEl('path', { class: 'tsg-icon', d: ICONS[type] || '' });
    g.appendChild(icon);
    return g;
  }

  // ==========================================================================
  // Layout: deterministischer Tidy-Tree (Themes per hierarchy) + Satelliten
  // ==========================================================================
  function computeLayout(nodes, edges) {
    var byKey = {};
    nodes.forEach(function (n) { byKey[key(n.type, n.id)] = n; });

    var childOf = {}; // themeKey -> parentThemeKey (hierarchy: source=child, target=parent)
    var childrenOf = {}; // parentThemeKey -> [childThemeKey]
    edges.forEach(function (e) {
      if (e.kind === 'hierarchy') {
        var ck = key(e.source.type, e.source.id);
        var pk = key(e.target.type, e.target.id);
        childOf[ck] = pk;
        (childrenOf[pk] = childrenOf[pk] || []).push(ck);
      }
    });

    var themeRoots = nodes.filter(function (n) { return n.type === 'theme' && !childOf[key(n.type, n.id)]; })
      .map(function (n) { return key(n.type, n.id); });

    var positions = {};
    var LEVEL_DY = 130;
    var LEAF_DX = 90;
    var cursorX = 0;

    function layoutSubtree(themeKey, depth) {
      var kids = (childrenOf[themeKey] || []).slice();
      if (kids.length === 0) {
        positions[themeKey] = { x: cursorX, y: depth * LEVEL_DY };
        cursorX += LEAF_DX;
        return positions[themeKey].x;
      }
      var xs = kids.map(function (ck) { return layoutSubtree(ck, depth + 1); });
      var mid = (xs[0] + xs[xs.length - 1]) / 2;
      positions[themeKey] = { x: mid, y: depth * LEVEL_DY };
      return mid;
    }

    themeRoots.forEach(function (rk) { layoutSubtree(rk, 0); cursorX += LEAF_DX; });

    // Fallback: any theme not reachable (shouldn't happen, but be defensive)
    nodes.forEach(function (n) {
      if (n.type === 'theme') {
        var k = key(n.type, n.id);
        if (!positions[k]) { positions[k] = { x: cursorX, y: 0 }; cursorX += LEAF_DX; }
      }
    });

    // Satellites: non-theme nodes linked to a theme via theme_link / knowledge_topic
    var satellitesByTheme = {};
    var satelliteAssigned = {};
    edges.forEach(function (e) {
      var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
      var srcN = byKey[sk], tgtN = byKey[tk];
      if (!srcN || !tgtN) return;
      if ((e.kind === 'theme_link' || e.kind === 'knowledge_topic')) {
        var themeSide = srcN.type === 'theme' ? sk : (tgtN.type === 'theme' ? tk : null);
        var otherSide = themeSide === sk ? tk : sk;
        if (themeSide && byKey[otherSide] && byKey[otherSide].type !== 'theme' && !satelliteAssigned[otherSide]) {
          (satellitesByTheme[themeSide] = satellitesByTheme[themeSide] || []).push(otherSide);
          satelliteAssigned[otherSide] = true;
        }
      }
    });

    Object.keys(satellitesByTheme).forEach(function (themeKey) {
      var center = positions[themeKey];
      if (!center) return;
      var sats = satellitesByTheme[themeKey];
      var radius = 65 + Math.ceil(sats.length / 8) * 30;
      sats.forEach(function (sk, i) {
        var ang = (i / sats.length) * Math.PI * 2;
        positions[sk] = { x: center.x + radius * Math.cos(ang), y: center.y + radius * Math.sin(ang) };
      });
    });

    // Any remaining unpositioned nodes (isolated / knowledge_knowledge-only clusters) -> grid
    var gridX = 0, gridY = -250, col = 0;
    nodes.forEach(function (n) {
      var k = key(n.type, n.id);
      if (!positions[k]) {
        positions[k] = { x: gridX, y: gridY };
        gridX += 80;
        col++;
        if (col > 10) { col = 0; gridX = 0; gridY -= 80; }
      }
    });

    return positions;
  }

  // Non-overlapping default placement near neighbors for a single new node
  function placeNear(existingPositions, neighborsKeys, occupied) {
    var base = { x: 0, y: 0 };
    if (neighborsKeys && neighborsKeys.length) {
      var sx = 0, sy = 0, c = 0;
      neighborsKeys.forEach(function (nk) {
        if (existingPositions[nk]) { sx += existingPositions[nk].x; sy += existingPositions[nk].y; c++; }
      });
      if (c) base = { x: sx / c, y: sy / c };
    }
    var r = 70;
    for (var attempt = 0; attempt < 24; attempt++) {
      var ang = attempt * 2.4;
      var cand = { x: base.x + r * Math.cos(ang), y: base.y + r * Math.sin(ang) };
      var ok = true;
      for (var i = 0; i < occupied.length; i++) {
        var dx = occupied[i].x - cand.x, dy = occupied[i].y - cand.y;
        if (Math.sqrt(dx * dx + dy * dy) < NODE_R * 2.1) { ok = false; break; }
      }
      if (ok) return cand;
      if (attempt % 8 === 7) r += 60;
    }
    return { x: base.x + Math.random() * 200 - 100, y: base.y + Math.random() * 200 - 100 };
  }

  // ==========================================================================
  // GraphInstance
  // ==========================================================================
  function GraphInstance(root) {
    this.root = root;
    this.mounted = false;
    this.host = window.TSHost;
    this.abortController = null;
    this.destroyed = false;

    // data
    this.nodes = [];
    this.edges = [];
    this.schema = { nodeTypes: TYPES, edgeKinds: [], compatibility: [] };
    this.nodeMap = {};
    this.edgeMap = {};
    this.edgesByNode = {};
    this.pos = {}; // key -> {x,y}

    // view state
    this.viewport = { x: 0, y: 0, k: 1 };
    this.selectedKey = null;
    this.selectedEdgeId = null;
    this.focusKbKey = null;
    this.focusModeKey = null;
    this.focusModeDepth = 2;
    this.searchTerm = '';
    this.searchMatches = [];
    this.searchIndex = -1;
    this.activeTypes = this.loadActiveTypes();
    this.legendCollapsed = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    this.a11yListOpen = false;

    // drag state
    this.drag = null;
    this.edgeDrag = null;

    // save queue (B8)
    this.pendingBatch = {}; // key -> {type,id,x,y}
    this.saveInFlight = false;
    this.saveDebounced = debounce(this._flushPositions.bind(this), 500);

    // undo for topic move
    this.undoTimer = null;
    this.lastMove = null;

    this._listeners = [];
    this._domNodes = {}; // key -> <g>
    this._domEdges = {}; // edgeId -> {path, hit}
  }

  GraphInstance.prototype.loadActiveTypes = function () {
    try {
      var raw = localStorage.getItem(STORAGE_FILTER_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          var set = {};
          TYPES.forEach(function (t) { set[t] = parsed.indexOf(t) !== -1; });
          return set;
        }
      }
    } catch (e) { /* ignore malformed storage */ }
    var all = {};
    TYPES.forEach(function (t) { all[t] = true; });
    return all;
  };

  GraphInstance.prototype.saveActiveTypes = function () {
    try {
      var active = TYPES.filter(function (t) { return this.activeTypes[t]; }, this);
      localStorage.setItem(STORAGE_FILTER_KEY, JSON.stringify(active));
    } catch (e) { /* storage unavailable, ignore silently */ }
  };

  GraphInstance.prototype.on = function (el, ev, fn, opts) {
    el.addEventListener(ev, fn, opts);
    this._listeners.push([el, ev, fn, opts]);
  };

  GraphInstance.prototype.destroyListeners = function () {
    this._listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    this._listeners = [];
  };

  // ---- Mount / lifecycle ---------------------------------------------------
  GraphInstance.prototype.mount = function () {
    if (this.mounted) return;
    this.mounted = true;
    this.buildShell();
    this.loadData();
  };

  GraphInstance.prototype.unmount = function () {
    if (!this.mounted) return;
    this.destroyListeners();
    if (this.abortController) { try { this.abortController.abort(); } catch (e) {} }
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.saveDebounced.cancel();
    this.root.innerHTML = '';
    this.mounted = false;
  };

  GraphInstance.prototype.invalidate = function () {
    if (!this.mounted) return;
    this.loadData();
  };

  // ---- Shell / DOM skeleton -------------------------------------------------
  GraphInstance.prototype.buildShell = function () {
    this.root.innerHTML = '';
    this.root.classList.add('tsg-root');
    if (this.host && this.host.reducedMotion && this.host.reducedMotion()) {
      this.root.classList.add('tsg-reduced-motion');
    }

    var wrap = htmlEl('div', { class: 'tsg-svg-wrap' });
    var svg = svgEl('svg', {
      class: 'tsg-svg', viewBox: '-400 -300 800 600',
      role: 'application', 'aria-label': 'Wissensnetz-Graph', tabindex: '0'
    });
    var g = svgEl('g', { class: 'tsg-viewport' });
    svg.appendChild(g);
    wrap.appendChild(svg);
    this.root.appendChild(wrap);
    this.svg = svg;
    this.gRoot = g;

    this.gEdges = svgEl('g', { class: 'tsg-layer-edges' });
    this.gToplevel = svgEl('g', { class: 'tsg-layer-toplevel' });
    this.gNodes = svgEl('g', { class: 'tsg-layer-nodes' });
    this.gPreview = svgEl('g', { class: 'tsg-layer-preview' });
    g.appendChild(this.gEdges);
    g.appendChild(this.gToplevel);
    g.appendChild(this.gNodes);
    g.appendChild(this.gPreview);

    // toolbar
    var toolbar = htmlEl('div', { class: 'tsg-toolbar' });
    toolbar.appendChild(this.buildSearchBox());
    toolbar.appendChild(this.buildFilterChips());
    toolbar.appendChild(this.buildZoomControls());
    this.root.appendChild(toolbar);

    // legend
    this.root.appendChild(this.buildLegend());

    // sync indicator
    var sync = htmlEl('div', { class: 'tsg-sync', 'aria-live': 'polite' });
    var dot = htmlEl('span', { class: 'tsg-sync-dot' });
    var label = htmlEl('span', {}, 'Gespeichert');
    sync.appendChild(dot);
    sync.appendChild(label);
    this.root.appendChild(sync);
    this.syncDot = dot;
    this.syncLabel = label;

    // panel
    this.panel = htmlEl('div', { class: 'tsg-panel', hidden: 'hidden' });
    this.root.appendChild(this.panel);

    // a11y toggle + list
    var a11yBtn = htmlEl('button', { class: 'tsg-menu-btn tsg-a11y-list-toggle', title: 'Knotenliste (barrierefrei)' }, '☰');
    a11yBtn.setAttribute('aria-label', 'Knotenliste anzeigen (Alternative zur räumlichen Ansicht)');
    this.on(a11yBtn, 'click', this.toggleA11yList.bind(this));
    this.root.appendChild(a11yBtn);

    this.a11yList = htmlEl('div', { class: 'tsg-a11y-list', hidden: 'hidden', role: 'region', 'aria-label': 'Knotenliste' });
    this.root.appendChild(this.a11yList);

    // live regions
    this.liveAssertive = htmlEl('div', { class: 'tsg-sr-only', 'aria-live': 'assertive', role: 'status' });
    this.livePolite = htmlEl('div', { class: 'tsg-sr-only', 'aria-live': 'polite', role: 'status' });
    this.root.appendChild(this.liveAssertive);
    this.root.appendChild(this.livePolite);

    // toast fallback host (only used if TSHost.toast missing — defensive, spec says host provides it)
    this.toastHost = htmlEl('div', { class: 'tsg-toast-host' });
    this.root.appendChild(this.toastHost);

    this.attachSvgInteractions();
  };

  GraphInstance.prototype.announce = function (msg, assertive) {
    var el = assertive ? this.liveAssertive : this.livePolite;
    el.textContent = '';
    // Force re-announcement even for repeated identical text.
    window.requestAnimationFrame(function () { el.textContent = msg; });
  };

  GraphInstance.prototype.toast = function (msg, type) {
    if (this.host && typeof this.host.toast === 'function') {
      this.host.toast(msg, type);
      return;
    }
    var t = htmlEl('div', { class: 'tsg-toast' + (type === 'error' ? ' tsg-toast-error' : type === 'success' ? ' tsg-toast-success' : '') }, msg);
    this.toastHost.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  };

  // ---- Toolbar builders -------------------------------------------------
  GraphInstance.prototype.buildSearchBox = function () {
    var wrap = htmlEl('div', { class: 'tsg-search' });
    var input = htmlEl('input', { type: 'search', placeholder: 'Knoten suchen…', 'aria-label': 'Knoten suchen' });
    var status = htmlEl('span', { class: 'tsg-search-status' }, '');
    var next = htmlEl('button', { type: 'button', title: 'Nächster Treffer' }, '↓');
    next.setAttribute('aria-label', 'Nächster Treffer');
    this.on(input, 'input', this.onSearchInput.bind(this));
    this.on(next, 'click', this.searchNext.bind(this));
    wrap.appendChild(input);
    wrap.appendChild(next);
    wrap.appendChild(status);
    this.searchInput = input;
    this.searchStatusEl = status;
    return wrap;
  };

  GraphInstance.prototype.buildFilterChips = function () {
    var wrap = htmlEl('div', { class: 'tsg-filters', role: 'group', 'aria-label': 'Nach Knotentyp filtern' });
    var self = this;
    this.chipEls = {};
    TYPES.forEach(function (t) {
      var chip = htmlEl('button', {
        type: 'button', class: 'tsg-chip', 'aria-pressed': self.activeTypes[t] ? 'true' : 'false'
      }, TYPE_LABELS[t]);
      self.on(chip, 'click', function () {
        self.activeTypes[t] = !self.activeTypes[t];
        chip.setAttribute('aria-pressed', self.activeTypes[t] ? 'true' : 'false');
        self.saveActiveTypes();
        self.renderVisibility();
      });
      wrap.appendChild(chip);
      self.chipEls[t] = chip;
    });
    return wrap;
  };

  GraphInstance.prototype.buildZoomControls = function () {
    var wrap = htmlEl('div', { class: 'tsg-zoom-controls' });
    var self = this;
    var minus = htmlEl('button', { type: 'button', 'aria-label': 'Verkleinern' }, '–');
    var fit = htmlEl('button', { type: 'button', 'aria-label': 'Passend einpassen' }, '⤢');
    var plus = htmlEl('button', { type: 'button', 'aria-label': 'Vergrößern' }, '+');
    var reset = htmlEl('button', { type: 'button', 'aria-label': 'Overflow-Menü' }, '⋯');
    this.on(minus, 'click', function () { self.zoomBy(0.8); });
    this.on(plus, 'click', function () { self.zoomBy(1.25); });
    this.on(fit, 'click', function () { self.fitToView(true); });
    this.on(reset, 'click', function () { self.openOverflowMenu(reset); });
    wrap.appendChild(minus); wrap.appendChild(fit); wrap.appendChild(plus); wrap.appendChild(reset);
    return wrap;
  };

  GraphInstance.prototype.openOverflowMenu = function (anchor) {
    var self = this;
    this.closePopover();
    var pop = htmlEl('div', { class: 'tsg-popover', role: 'menu' });
    var r = anchor.getBoundingClientRect();
    var rootR = this.root.getBoundingClientRect();
    pop.style.top = (r.bottom - rootR.top + 6) + 'px';
    pop.style.right = '12px';
    var relayout = htmlEl('button', { class: 'tsg-btn' }, 'Layout neu berechnen');
    var resetPositions = htmlEl('button', { class: 'tsg-btn' }, 'Layout zurücksetzen');
    this.on(relayout, 'click', function () { self.closePopover(); self.confirmAndRecomputeLayout(); });
    this.on(resetPositions, 'click', function () { self.closePopover(); self.confirmAndRecomputeLayout(); });
    pop.appendChild(relayout);
    this.root.appendChild(pop);
    this._popover = pop;
    setTimeout(function () {
      self._popoverOutside = function (ev) { if (!pop.contains(ev.target) && ev.target !== anchor) self.closePopover(); };
      document.addEventListener('mousedown', self._popoverOutside);
    }, 0);
  };

  GraphInstance.prototype.closePopover = function () {
    if (this._popover) { this._popover.remove(); this._popover = null; }
    if (this._popoverOutside) { document.removeEventListener('mousedown', this._popoverOutside); this._popoverOutside = null; }
  };

  GraphInstance.prototype.confirmAndRecomputeLayout = function () {
    var self = this;
    var doIt = function (ok) {
      if (!ok) return;
      var positions = computeLayout(self.nodes, self.edges);
      self.pos = positions;
      self.nodes.forEach(function (n) { n.hasStoredPosition = true; });
      self.renderAll();
      self.fitToView(true);
      var batch = self.nodes.map(function (n) {
        var p = self.pos[key(n.type, n.id)] || { x: 0, y: 0 };
        return { type: n.type, id: n.id, x: p.x, y: p.y };
      });
      self.savePositionsBatch(batch);
      self.announce('Layout wurde neu berechnet und gespeichert.', true);
    };
    if (this.host && typeof this.host.confirm === 'function') {
      this.host.confirm({
        title: 'Layout neu berechnen',
        message: 'Alle manuell gesetzten Positionen werden überschrieben. Fortfahren?',
        confirmLabel: 'Layout neu berechnen'
      }).then(doIt);
    } else if (window.confirm('Alle manuell gesetzten Positionen werden überschrieben. Fortfahren?')) {
      doIt(true);
    }
  };

  GraphInstance.prototype.buildLegend = function () {
    var self = this;
    var wrap = htmlEl('div', { class: 'tsg-legend' + (this.legendCollapsed ? ' tsg-collapsed' : '') });
    var toggle = htmlEl('button', { class: 'tsg-legend-toggle', 'aria-expanded': (!this.legendCollapsed).toString() });
    toggle.appendChild(htmlEl('span', {}, 'Legende'));
    toggle.appendChild(htmlEl('span', { class: 'tsg-legend-chevron' }, '▾'));
    this.on(toggle, 'click', function () {
      self.legendCollapsed = !self.legendCollapsed;
      wrap.classList.toggle('tsg-collapsed', self.legendCollapsed);
      toggle.setAttribute('aria-expanded', (!self.legendCollapsed).toString());
    });
    wrap.appendChild(toggle);
    var body = htmlEl('div', { class: 'tsg-legend-body' });
    TYPES.forEach(function (t) {
      var row = htmlEl('div', { class: 'tsg-legend-item' });
      var svg = svgEl('svg', { width: 22, height: 22, viewBox: '-14 -14 28 28' });
      svg.appendChild(buildNodeShape(t));
      row.appendChild(svg);
      row.appendChild(htmlEl('span', {}, TYPE_LABELS[t]));
      body.appendChild(row);
    });
    var solid = htmlEl('div', { class: 'tsg-legend-item' });
    var solidSvg = svgEl('svg', { width: 30, height: 10 });
    solidSvg.appendChild(svgEl('line', { x1: 0, y1: 5, x2: 30, y2: 5, stroke: '#64748b', 'stroke-width': 2 }));
    solid.appendChild(solidSvg);
    solid.appendChild(htmlEl('span', {}, 'Direkte Verknüpfung (durchgezogen)'));
    var dashed = htmlEl('div', { class: 'tsg-legend-item' });
    var dashedSvg = svgEl('svg', { width: 30, height: 10 });
    dashedSvg.appendChild(svgEl('line', { x1: 0, y1: 5, x2: 30, y2: 5, stroke: '#64748b', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
    dashed.appendChild(dashedSvg);
    dashed.appendChild(htmlEl('span', {}, 'Wissen-zu-Wissen (gestrichelt)'));
    body.appendChild(solid);
    body.appendChild(dashed);
    wrap.appendChild(body);
    this.legendWrap = wrap;
    return wrap;
  };

  // ---- Data loading -------------------------------------------------------
  GraphInstance.prototype.loadData = function () {
    var self = this;
    this.showState('loading');
    if (this.abortController) { try { this.abortController.abort(); } catch (e) {} }
    this.abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var opts = this.abortController ? { signal: this.abortController.signal } : undefined;
    this.host.api('GET', '/api/graph', undefined, opts).then(function (data) {
      if (self.destroyed || !self.mounted) return;
      self.applyData(data);
    }).catch(function (err) {
      if (self.destroyed || !self.mounted) return;
      if (err && err.name === 'AbortError') return;
      self.showState('error');
    });
  };

  GraphInstance.prototype.applyData = function (data) {
    data = data || {};
    var nodes = Array.isArray(data.nodes) ? data.nodes : [];
    var edges = Array.isArray(data.edges) ? data.edges : [];
    var schema = data.schema || {};
    this.schema = {
      nodeTypes: Array.isArray(schema.nodeTypes) ? schema.nodeTypes : TYPES,
      edgeKinds: Array.isArray(schema.edgeKinds) ? schema.edgeKinds : [],
      compatibility: Array.isArray(schema.compatibility) ? schema.compatibility : []
    };
    this.stats = data.stats || { nodeCount: nodes.length, edgeCount: edges.length, truncated: false };

    if (nodes.length === 0) {
      this.nodes = []; this.edges = [];
      this.showState('empty');
      return;
    }

    this.nodes = nodes;
    this.edges = edges;
    this.nodeMap = {};
    this.edgesByNode = {};
    this.edgeMap = {};
    var self = this;
    nodes.forEach(function (n) { self.nodeMap[key(n.type, n.id)] = n; });
    edges.forEach(function (e) {
      self.edgeMap[e.id] = e;
      var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
      (self.edgesByNode[sk] = self.edgesByNode[sk] || []).push(e);
      (self.edgesByNode[tk] = self.edgesByNode[tk] || []).push(e);
    });

    var hasStored = nodes.some(function (n) { return n.hasStoredPosition; });
    this.pos = {};
    var newlyPlaced = [];
    if (!hasStored) {
      this.pos = computeLayout(nodes, edges);
      nodes.forEach(function (n) { newlyPlaced.push(n); });
    } else {
      nodes.forEach(function (n) {
        var k = key(n.type, n.id);
        if (n.hasStoredPosition && typeof n.x === 'number' && typeof n.y === 'number') {
          self.pos[k] = { x: n.x, y: n.y };
        }
      });
      var occupied = Object.keys(this.pos).map(function (k) { return self.pos[k]; });
      nodes.forEach(function (n) {
        var k = key(n.type, n.id);
        if (!self.pos[k]) {
          var neighborKeys = (self.edgesByNode[k] || []).map(function (e) {
            var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
            return sk === k ? tk : sk;
          });
          var p = placeNear(self.pos, neighborKeys, occupied);
          self.pos[k] = p;
          occupied.push(p);
          newlyPlaced.push(n);
        }
      });
    }

    this.showState(null);
    this.renderAll();
    this.fitToView(false);

    if (newlyPlaced.length) {
      var batch = newlyPlaced.map(function (n) {
        var p = self.pos[key(n.type, n.id)];
        return { type: n.type, id: n.id, x: p.x, y: p.y };
      });
      this.savePositionsBatch(batch);
    }

    if (nodes.length > MAX_COMFORTABLE_NODES) {
      this.showPerfBanner();
    } else if (this.perfBanner) {
      this.perfBanner.remove(); this.perfBanner = null;
    }
  };

  GraphInstance.prototype.showPerfBanner = function () {
    if (this.perfBanner) return;
    this.perfBanner = htmlEl('div', { class: 'tsg-perf-banner' },
      'Viele Knoten (' + this.nodes.length + '). Nutze Filter, um die Ansicht übersichtlicher zu machen.');
    this.root.appendChild(this.perfBanner);
  };

  // ---- State views (loading/error/empty) ----------------------------------
  GraphInstance.prototype.showState = function (state) {
    if (this.stateEl) { this.stateEl.remove(); this.stateEl = null; }
    var self = this;
    this.currentState = state || null;
    if (!state) { this.svg.style.display = ''; return; }
    this.svg.style.display = 'none';
    var el = htmlEl('div', { class: 'tsg-state' });
    if (state === 'loading') {
      el.appendChild(htmlEl('div', { class: 'tsg-spinner', 'aria-hidden': 'true' }));
      el.appendChild(htmlEl('p', {}, 'Graph wird geladen …'));
      el.setAttribute('role', 'status');
    } else if (state === 'error') {
      el.appendChild(htmlEl('div', { class: 'tsg-state-icon', 'aria-hidden': 'true' }, '⚠️'));
      el.appendChild(htmlEl('p', {}, 'Der Graph konnte nicht geladen werden. Bitte versuche es erneut.'));
      var retry = htmlEl('button', { class: 'tsg-btn tsg-btn-primary' }, 'Erneut versuchen');
      this.on(retry, 'click', function () { self.loadData(); });
      el.appendChild(retry);
    } else if (state === 'empty') {
      el.appendChild(htmlEl('div', { class: 'tsg-state-icon', 'aria-hidden': 'true' }, '🗂️'));
      el.appendChild(htmlEl('p', {}, 'Noch keine Topics vorhanden. Lege dein erstes Topic an, um dein Wissensnetz aufzubauen.'));
      var createBtn = htmlEl('button', { class: 'tsg-btn tsg-btn-primary' }, 'Erstes Topic anlegen');
      this.on(createBtn, 'click', function () {
        if (typeof self.onCreateFirstTopic === 'function') self.onCreateFirstTopic();
      });
      el.appendChild(createBtn);
    } else if (state === 'filtered-empty') {
      el.appendChild(htmlEl('p', {}, 'Keine Knoten für diese Filterauswahl.'));
      var resetBtn = htmlEl('button', { class: 'tsg-btn' }, 'Filter zurücksetzen');
      this.on(resetBtn, 'click', function () {
        TYPES.forEach(function (t) { self.activeTypes[t] = true; self.chipEls[t].setAttribute('aria-pressed', 'true'); });
        self.saveActiveTypes();
        self.renderVisibility();
      });
      el.appendChild(resetBtn);
      el.style.background = 'transparent';
      el.style.pointerEvents = 'none';
      resetBtn.style.pointerEvents = 'auto';
    }
    this.root.appendChild(el);
    this.stateEl = el;
  };

  // ==========================================================================
  // Rendering
  // ==========================================================================
  GraphInstance.prototype.renderAll = function () {
    this.gNodes.innerHTML = '';
    this.gEdges.innerHTML = '';
    this._domNodes = {};
    this._domEdges = {};
    this.renderToplevelZone();
    var self = this;
    this.edges.forEach(function (e) { self.renderEdge(e); });
    this.nodes.forEach(function (n) { self.renderNode(n); });
    this.renderVisibility();
    this.renderA11yList();
  };

  GraphInstance.prototype.renderToplevelZone = function () {
    this.gToplevel.innerHTML = '';
    var zone = svgEl('rect', {
      class: 'tsg-toplevel-zone', x: -390, y: -290, width: 780, height: 40, rx: 8
    });
    this.gToplevel.appendChild(zone);
    this.toplevelZoneEl = zone;
  };

  GraphInstance.prototype.nodeAriaLabel = function (n) {
    var k = key(n.type, n.id);
    var parts = [TYPE_LABELS[n.type] + ': ' + n.title];
    if (n.done === true) parts.push('erledigt');
    var edgeCount = (this.edgesByNode[k] || []).length;
    parts.push(edgeCount + ' Verknüpfung' + (edgeCount === 1 ? '' : 'en'));
    return parts.join(', ');
  };

  GraphInstance.prototype.renderNode = function (n) {
    var self = this;
    var k = key(n.type, n.id);
    var p = this.pos[k] || { x: 0, y: 0 };
    var g = svgEl('g', {
      class: 'tsg-node', 'data-type': n.type, 'data-key': k,
      transform: 'translate(' + p.x + ',' + p.y + ')', tabindex: '-1',
      role: 'button', 'aria-label': this.nodeAriaLabel(n)
    });
    g.appendChild(buildNodeShape(n.type));

    if (n.done === true) {
      g.classList.add('tsg-done');
      var badge = svgEl('g', { class: 'tsg-done-badge', transform: 'translate(' + (NODE_R * 0.6) + ',' + (-NODE_R * 0.6) + ')' });
      badge.appendChild(svgEl('circle', { r: 8 }));
      badge.appendChild(svgEl('path', { d: 'M -3.5 0 L -1 2.5 L 3.5 -3' }));
      g.appendChild(badge);
    }

    var label = svgEl('text', { class: 'tsg-label', y: NODE_R + 14 });
    label.textContent = truncateTitle(n.title || '');
    g.appendChild(label);

    // connection handle (top of shape) for edge-drag creation
    var handle = svgEl('circle', { class: 'tsg-handle', r: 6, cx: 0, cy: -NODE_R - 4 });
    g.appendChild(handle);

    this.on(g, 'click', function (ev) { ev.stopPropagation(); self.selectNode(k); });
    this.on(g, 'dblclick', function (ev) { ev.stopPropagation(); self.openNode(n); });
    this.on(g, 'keydown', function (ev) { self.onNodeKeydown(ev, n); });
    this.on(g, 'pointerdown', function (ev) { self.onNodePointerDown(ev, n, g); });
    this.on(handle, 'pointerdown', function (ev) { ev.stopPropagation(); self.onHandlePointerDown(ev, n); });

    this.gNodes.appendChild(g);
    this._domNodes[k] = g;
  };

  function truncateTitle(t) {
    if (t.length <= 22) return t;
    return t.slice(0, 21) + '…';
  }

  GraphInstance.prototype.edgePath = function (e) {
    var sp = this.pos[key(e.source.type, e.source.id)] || { x: 0, y: 0 };
    var tp = this.pos[key(e.target.type, e.target.id)] || { x: 0, y: 0 };
    return 'M ' + sp.x + ' ' + sp.y + ' L ' + tp.x + ' ' + tp.y;
  };

  GraphInstance.prototype.edgeAriaLabel = function (e) {
    var sn = this.nodeMap[key(e.source.type, e.source.id)];
    var tn = this.nodeMap[key(e.target.type, e.target.id)];
    var a = sn ? sn.title : e.source.id, b = tn ? tn.title : e.target.id;
    return 'Verknüpfung zwischen ' + a + ' und ' + b + ', ' + e.kind;
  };

  GraphInstance.prototype.renderEdge = function (e) {
    var self = this;
    var dashed = e.kind === 'knowledge_knowledge';
    var path = svgEl('path', {
      class: 'tsg-edge' + (dashed ? ' tsg-edge-dashed' : ''), d: this.edgePath(e)
    });
    var hit = svgEl('path', {
      class: 'tsg-edge-hit', d: this.edgePath(e), tabindex: '-1', role: 'button', 'aria-label': this.edgeAriaLabel(e)
    });
    this.on(hit, 'click', function (ev) { ev.stopPropagation(); self.selectEdge(e.id); });
    this.on(hit, 'keydown', function (ev) { self.onEdgeKeydown(ev, e); });
    this.gEdges.appendChild(path);
    this.gEdges.appendChild(hit);
    this._domEdges[e.id] = { path: path, hit: hit };
  };

  GraphInstance.prototype.updateIncidentEdges = function (k) {
    var self = this;
    (this.edgesByNode[k] || []).forEach(function (e) {
      var dom = self._domEdges[e.id];
      if (!dom) return;
      var d = self.edgePath(e);
      dom.path.setAttribute('d', d);
      dom.hit.setAttribute('d', d);
    });
  };

  // ---- Visibility (filters + focus mode + search) -------------------------
  GraphInstance.prototype.visibleKeys = function () {
    var self = this;
    var typeVisible = {};
    this.nodes.forEach(function (n) {
      typeVisible[key(n.type, n.id)] = !!self.activeTypes[n.type];
    });
    if (!this.focusModeKey) return typeVisible;

    var within = {};
    var startKey = this.focusModeKey;
    within[startKey] = true;
    if (this.focusModeDepth !== 'all') {
      var frontier = [startKey];
      for (var d = 0; d < this.focusModeDepth; d++) {
        var next = [];
        frontier.forEach(function (fk) {
          (self.edgesByNode[fk] || []).forEach(function (e) {
            var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
            var other = sk === fk ? tk : sk;
            if (!within[other]) { within[other] = true; next.push(other); }
          });
        });
        frontier = next;
      }
    } else {
      // BFS full reachable set
      var queue = [startKey], seen = { };
      seen[startKey] = true;
      while (queue.length) {
        var cur = queue.shift();
        (self.edgesByNode[cur] || []).forEach(function (e) {
          var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
          var other = sk === cur ? tk : sk;
          if (!seen[other]) { seen[other] = true; queue.push(other); within[other] = true; }
        });
      }
    }
    var combined = {};
    Object.keys(typeVisible).forEach(function (k) { combined[k] = typeVisible[k] && !!within[k]; });
    return combined;
  };

  GraphInstance.prototype.renderVisibility = function () {
    var self = this;
    var visible = this.visibleKeys();
    var anyVisible = false;
    Object.keys(this._domNodes).forEach(function (k) {
      var v = !!visible[k];
      if (v) anyVisible = true;
      self._domNodes[k].classList.toggle('tsg-dimmed', !v);
      self._domNodes[k].style.pointerEvents = v ? '' : 'none';
    });
    this.edges.forEach(function (e) {
      var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
      var v = visible[sk] && visible[tk];
      var dom = self._domEdges[e.id];
      if (!dom) return;
      dom.path.classList.toggle('tsg-edge-dimmed', !v);
      dom.hit.style.pointerEvents = v ? '' : 'none';
    });
    if (!anyVisible && this.nodes.length > 0) {
      this.showState('filtered-empty');
    } else if (this.currentState === 'filtered-empty') {
      this.showState(null);
    }
    this.renderA11yList();
  };

  // ---- Search ---------------------------------------------------------------
  GraphInstance.prototype.onSearchInput = function (ev) {
    this.searchTerm = ev.target.value || '';
    this.runSearch();
  };

  GraphInstance.prototype.runSearch = function () {
    var self = this;
    Object.keys(this._domNodes).forEach(function (k) {
      self._domNodes[k].classList.remove('tsg-search-hit', 'tsg-search-current');
    });
    var term = this.searchTerm.trim().toLowerCase();
    if (!term) { this.searchMatches = []; this.searchIndex = -1; this.searchStatusEl.textContent = ''; return; }
    this.searchMatches = this.nodes
      .filter(function (n) { return (n.title || '').toLowerCase().indexOf(term) !== -1; })
      .map(function (n) { return key(n.type, n.id); });
    if (this.searchMatches.length === 0) {
      this.searchIndex = -1;
      this.searchStatusEl.textContent = 'Kein Knoten gefunden';
      return;
    }
    this.searchMatches.forEach(function (k) { if (self._domNodes[k]) self._domNodes[k].classList.add('tsg-search-hit'); });
    this.searchIndex = 0;
    this.searchStatusEl.textContent = (this.searchIndex + 1) + ' / ' + this.searchMatches.length;
    this.goToSearchMatch();
  };

  GraphInstance.prototype.searchNext = function () {
    if (!this.searchMatches.length) return;
    this.searchIndex = (this.searchIndex + 1) % this.searchMatches.length;
    this.searchStatusEl.textContent = (this.searchIndex + 1) + ' / ' + this.searchMatches.length;
    this.goToSearchMatch();
  };

  GraphInstance.prototype.goToSearchMatch = function () {
    var self = this;
    Object.keys(this._domNodes).forEach(function (k) { self._domNodes[k].classList.remove('tsg-search-current'); });
    var k = this.searchMatches[this.searchIndex];
    if (!k || !this._domNodes[k]) return;
    this._domNodes[k].classList.add('tsg-search-current');
    this.centerOn(this.pos[k]);
    this.selectNode(k, { skipPanFocus: true });
  };

  // ---- Pan / Zoom -------------------------------------------------------
  GraphInstance.prototype.applyViewport = function () {
    var v = this.viewport;
    this.gRoot.setAttribute('transform', 'translate(' + v.x + ',' + v.y + ') scale(' + v.k + ')');
  };

  GraphInstance.prototype.zoomBy = function (factor, center) {
    var v = this.viewport;
    var newK = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor));
    if (center) {
      // keep the graph point under `center` (svg-local px coords) stationary
      var gx = (center.x - v.x) / v.k, gy = (center.y - v.y) / v.k;
      v.x = center.x - gx * newK;
      v.y = center.y - gy * newK;
    }
    v.k = newK;
    this.applyViewport();
  };

  GraphInstance.prototype.centerOn = function (p) {
    if (!p) return;
    var rect = this.svg.getBoundingClientRect();
    var vb = this.svg.viewBox.baseVal;
    var scaleToViewport = vb.width / (rect.width || vb.width);
    this.viewport.x = (vb.width / 2) * scaleToViewport - p.x * this.viewport.k - (vb.x * scaleToViewport);
    this.viewport.y = (vb.height / 2) * scaleToViewport - p.y * this.viewport.k - (vb.y * scaleToViewport);
    this.applyViewport();
  };

  GraphInstance.prototype.fitToView = function (animate) {
    var self = this;
    var keys = Object.keys(this.pos);
    if (!keys.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    keys.forEach(function (k) {
      var p = self.pos[k];
      minX = Math.min(minX, p.x - NODE_R); maxX = Math.max(maxX, p.x + NODE_R);
      minY = Math.min(minY, p.y - NODE_R); maxY = Math.max(maxY, p.y + NODE_R);
    });
    var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    var vb = this.svg.viewBox.baseVal;
    var pad = 60;
    var k = Math.min((vb.width - pad) / w, (vb.height - pad) / h);
    k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k || 1));
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.viewport.k = k;
    this.viewport.x = vb.width / 2 + vb.x - cx * k;
    this.viewport.y = vb.height / 2 + vb.y - cy * k;
    this.applyViewport();
  };

  GraphInstance.prototype.attachSvgInteractions = function () {
    var self = this;
    // wheel zoom
    this.on(this.svg, 'wheel', function (ev) {
      ev.preventDefault();
      var rect = self.svg.getBoundingClientRect();
      var vb = self.svg.viewBox.baseVal;
      var localX = ((ev.clientX - rect.left) / rect.width) * vb.width + vb.x;
      var localY = ((ev.clientY - rect.top) / rect.height) * vb.height + vb.y;
      var factor = ev.deltaY < 0 ? 1.1 : 0.9;
      self.zoomBy(factor, { x: localX, y: localY });
    }, { passive: false });

    // pan on empty area drag
    this.on(this.svg, 'pointerdown', function (ev) {
      if (ev.target !== self.svg && ev.target !== self.gRoot) return;
      self.selectNode(null);
      self.svg.classList.add('tsg-panning');
      var startX = ev.clientX, startY = ev.clientY;
      var startVp = { x: self.viewport.x, y: self.viewport.y };
      var rect = self.svg.getBoundingClientRect();
      var vb = self.svg.viewBox.baseVal;
      var scale = vb.width / rect.width;
      var move = function (mev) {
        self.viewport.x = startVp.x + (mev.clientX - startX) * scale;
        self.viewport.y = startVp.y + (mev.clientY - startY) * scale;
        self.applyViewport();
      };
      var up = function () {
        self.svg.classList.remove('tsg-panning');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    this.on(this.svg, 'keydown', function (ev) {
      var step = 40;
      if (ev.target !== self.svg) return;
      if (ev.key === 'ArrowLeft') { self.viewport.x += step; self.applyViewport(); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { self.viewport.x -= step; self.applyViewport(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { self.viewport.y += step; self.applyViewport(); ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { self.viewport.y -= step; self.applyViewport(); ev.preventDefault(); }
      else if (ev.key === 'Escape') { self.selectNode(null); }
    });

    this.on(document, 'keydown', function (ev) {
      if (!self.root.contains(document.activeElement) && document.activeElement !== document.body) return;
      var mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      if (ev.key === '+' || ev.key === '=') { self.zoomBy(1.25); ev.preventDefault(); }
      else if (ev.key === '-') { self.zoomBy(0.8); ev.preventDefault(); }
      else if (ev.key === '0') { self.fitToView(true); ev.preventDefault(); }
    });
  };

  // ==========================================================================
  // Selection / Panel
  // ==========================================================================
  GraphInstance.prototype.selectNode = function (k, opts) {
    opts = opts || {};
    if (this.selectedKey && this._domNodes[this.selectedKey]) this._domNodes[this.selectedKey].classList.remove('tsg-selected');
    this.selectedEdgeId = null;
    this.selectedKey = k;
    if (k && this._domNodes[k]) {
      this._domNodes[k].classList.add('tsg-selected');
      this.renderPanelForNode(this.nodeMap[k]);
    } else {
      this.closePanel();
    }
  };

  GraphInstance.prototype.selectEdge = function (edgeId) {
    var self = this;
    Object.keys(this._domEdges).forEach(function (id) { self._domEdges[id].path.classList.remove('tsg-edge-selected'); });
    this.selectedKey = null;
    this.selectedEdgeId = edgeId;
    var e = this.edgeMap[edgeId];
    if (!e) return;
    this._domEdges[edgeId].path.classList.add('tsg-edge-selected');
    this.renderPanelForEdge(e);
  };

  GraphInstance.prototype.closePanel = function () {
    this.panel.setAttribute('hidden', 'hidden');
    this.panel.innerHTML = '';
  };

  GraphInstance.prototype.renderPanelForNode = function (n) {
    var self = this;
    var k = key(n.type, n.id);
    this.panel.innerHTML = '';
    this.panel.removeAttribute('hidden');
    var close = htmlEl('button', { class: 'tsg-panel-close', 'aria-label': 'Schließen' }, '✕');
    this.on(close, 'click', function () { self.selectNode(null); });
    this.panel.appendChild(close);

    var iconSvg = svgEl('svg', { width: 26, height: 26, viewBox: '-14 -14 28 28' });
    iconSvg.appendChild(buildNodeShape(n.type));
    var typeRow = htmlEl('div', { class: 'tsg-panel-type' });
    var iconWrap = document.createElement('span');
    iconWrap.appendChild(iconSvg);
    typeRow.appendChild(iconWrap);
    typeRow.appendChild(htmlEl('span', {}, TYPE_LABELS[n.type] + (n.done === true ? ' · erledigt' : '')));

    var title = htmlEl('div', { class: 'tsg-panel-title' });
    title.textContent = n.title || '';

    this.panel.appendChild(title);
    this.panel.appendChild(typeRow);

    var meta = n.meta || {};
    if (n.type === 'theme') {
      if (meta.childCount != null) this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, 'Unter-Topics: ' + meta.childCount));
      if (meta.linkCount != null) this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, 'Verknüpfungen: ' + meta.linkCount));
    } else if (n.type === 'knowledge') {
      if (meta.updatedAt) this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, 'Aktualisiert: ' + formatDate(meta.updatedAt)));
    } else if (n.type === 'todo') {
      this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, meta.dueDate ? 'Fällig: ' + formatDate(meta.dueDate) : 'Kein Fälligkeitsdatum'));
    } else if (n.type === 'topic') {
      if (meta.meetingTitle) this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, 'Meeting: ' + meta.meetingTitle));
    } else if (n.type === 'contact') {
      if (meta.role) this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, 'Rolle: ' + meta.role));
    }

    var actions = htmlEl('div', { class: 'tsg-panel-actions' });
    var openBtn = htmlEl('button', { class: 'tsg-btn tsg-btn-primary' }, 'Öffnen');
    this.on(openBtn, 'click', function () { self.openNode(n); });
    actions.appendChild(openBtn);

    if (n.type === 'theme') {
      var moveBtn = htmlEl('button', { class: 'tsg-btn' }, 'Verschieben nach …');
      this.on(moveBtn, 'click', function () { self.openMoveCombobox(n); });
      actions.appendChild(moveBtn);
    }

    var linkBtn = htmlEl('button', { class: 'tsg-btn' }, 'Verknüpfen mit …');
    this.on(linkBtn, 'click', function () { self.openLinkCombobox(n); });
    actions.appendChild(linkBtn);

    this.panel.appendChild(actions);

    // Verknüpfungen list
    var edges = this.edgesByNode[k] || [];
    if (edges.length) {
      this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta', style: 'margin-top:14px;font-weight:700;' }, 'Verknüpfungen'));
      var ul = htmlEl('ul', { class: 'tsg-panel-edges' });
      edges.forEach(function (e) {
        var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
        var otherK = sk === k ? tk : sk;
        var otherN = self.nodeMap[otherK];
        var li = document.createElement('li');
        li.appendChild(htmlEl('span', {}, (otherN ? otherN.title : '?') + ' (' + e.kind + ')'));
        var rm = htmlEl('button', { 'aria-label': 'Verknüpfung entfernen' }, '×');
        self.on(rm, 'click', function () { self.confirmDeleteEdge(e); });
        li.appendChild(rm);
        ul.appendChild(li);
      });
      this.panel.appendChild(ul);
    }

    this.panelComboContainer = null;
  };

  GraphInstance.prototype.renderPanelForEdge = function (e) {
    var self = this;
    this.panel.innerHTML = '';
    this.panel.removeAttribute('hidden');
    var close = htmlEl('button', { class: 'tsg-panel-close', 'aria-label': 'Schließen' }, '✕');
    this.on(close, 'click', function () { self.selectEdge(null); self.selectedEdgeId = null; self.closePanel(); });
    this.panel.appendChild(close);
    var sn = this.nodeMap[key(e.source.type, e.source.id)];
    var tn = this.nodeMap[key(e.target.type, e.target.id)];
    this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-title' }, 'Verknüpfung'));
    this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, (sn ? sn.title : '?') + ' → ' + (tn ? tn.title : '?')));
    this.panel.appendChild(htmlEl('div', { class: 'tsg-panel-meta' }, 'Art: ' + e.kind));
    var actions = htmlEl('div', { class: 'tsg-panel-actions' });
    var del = htmlEl('button', { class: 'tsg-btn tsg-btn-danger' }, 'Verknüpfung entfernen');
    this.on(del, 'click', function () { self.confirmDeleteEdge(e); });
    actions.appendChild(del);
    this.panel.appendChild(actions);
  };

  function formatDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleDateString('de-DE');
    } catch (e) { return String(iso); }
  }

  // ---- Open node ------------------------------------------------------------
  GraphInstance.prototype.openNode = function (n) {
    var self = this;
    var handleErr = function (err) {
      if (err && err.status === 404) {
        self.toast('Objekt existiert nicht mehr', 'error');
        self.invalidate();
      } else {
        self.toast('Objekt konnte nicht geöffnet werden.', 'error');
      }
    };
    try {
      if (n.type === 'knowledge') {
        var r = this.host.openKnowledge(n.id);
        if (r && typeof r.catch === 'function') r.catch(handleErr);
      } else {
        var r2 = this.host.openObject(n.type, n.id, n.meta);
        if (r2 && typeof r2.catch === 'function') r2.catch(handleErr);
      }
    } catch (err) { handleErr(err); }
  };

  // ==========================================================================
  // Keyboard node/edge navigation
  // ==========================================================================
  GraphInstance.prototype.onNodeKeydown = function (ev, n) {
    var k = key(n.type, n.id);
    if (ev.key === 'Enter') { ev.preventDefault(); this.openNode(n); return; }
    if (ev.key === 'Escape') { this.selectNode(null); return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(ev.key) !== -1) {
      ev.preventDefault();
      this.moveKeyboardFocusAlongEdge(k, ev.key);
      return;
    }
    var step = ev.shiftKey ? 40 : 10;
    if (ev.key === 'PageUp' || (ev.altKey && ev.key === 'ArrowUp')) { /* reserved */ }
  };

  GraphInstance.prototype.moveKeyboardFocusAlongEdge = function (k, arrowKey) {
    var neighbors = (this.edgesByNode[k] || []).map(function (e) {
      var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
      return sk === k ? tk : sk;
    }).filter(function (nk) { return this._domNodes[nk]; }, this);
    if (!neighbors.length) return;
    var idx = 0;
    if (['ArrowDown', 'ArrowRight'].indexOf(arrowKey) !== -1) idx = 0; else idx = neighbors.length - 1;
    var targetKey = neighbors[idx];
    var g = this._domNodes[targetKey];
    if (g) {
      if (this._domNodes[k]) this._domNodes[k].setAttribute('tabindex', '-1');
      g.setAttribute('tabindex', '0');
      g.focus();
      this.selectNode(targetKey);
    }
  };

  GraphInstance.prototype.onEdgeKeydown = function (ev, e) {
    if (ev.key === 'Enter') { ev.preventDefault(); this.confirmDeleteEdge(e); }
  };

  // ==========================================================================
  // Node dragging (position OR theme-reparent) — O(degree) redraw
  // ==========================================================================
  GraphInstance.prototype.onNodePointerDown = function (ev, n, g) {
    if (ev.button !== undefined && ev.button !== 0) return;
    var self = this;
    ev.stopPropagation();
    var k = key(n.type, n.id);
    var startClient = { x: ev.clientX, y: ev.clientY };
    var startPos = { x: this.pos[k].x, y: this.pos[k].y };
    var rect = this.svg.getBoundingClientRect();
    var vb = this.svg.viewBox.baseVal;
    var scale = vb.width / rect.width;
    var moved = false;
    var dropTargetKey = null;
    var dropIsTopLevel = false;

    var toGraphCoords = function (clientX, clientY) {
      var localX = ((clientX - rect.left) / rect.width) * vb.width + vb.x;
      var localY = ((clientY - rect.top) / rect.height) * vb.height + vb.y;
      return { x: (localX - self.viewport.x) / self.viewport.k, y: (localY - self.viewport.y) / self.viewport.k };
    };

    var isDescendantTheme = function (candidateKey, ofKey) {
      // walk up hierarchy from candidateKey; if we hit ofKey, candidate is descendant
      var cur = candidateKey;
      var guard = 0;
      while (guard++ < 500) {
        var parentEdge = (self.edgesByNode[cur] || []).find(function (e) {
          return e.kind === 'hierarchy' && key(e.source.type, e.source.id) === cur;
        });
        if (!parentEdge) return false;
        var pk = key(parentEdge.target.type, parentEdge.target.id);
        if (pk === ofKey) return true;
        cur = pk;
      }
      return false;
    };

    var move = function (mev) {
      var dxClient = mev.clientX - startClient.x, dyClient = mev.clientY - startClient.y;
      if (Math.abs(dxClient) > 3 || Math.abs(dyClient) > 3) moved = true;
      if (!moved) return;
      var gp = toGraphCoords(mev.clientX, mev.clientY);
      self.pos[k] = { x: gp.x, y: gp.y };
      g.setAttribute('transform', 'translate(' + gp.x + ',' + gp.y + ')');
      self.updateIncidentEdges(k);

      // clear previous hover markers
      Object.keys(self._domNodes).forEach(function (ok) {
        if (ok !== k) self._domNodes[ok].classList.remove('tsg-drop-valid', 'tsg-drop-invalid');
      });
      self.toplevelZoneEl.classList.remove('tsg-drop-valid');

      dropTargetKey = null; dropIsTopLevel = false;
      if (n.type === 'theme') {
        // top-level zone hit test (fixed screen-space rect near top)
        var localPt = { x: ((mev.clientX - rect.left) / rect.width) * vb.width + vb.x, y: ((mev.clientY - rect.top) / rect.height) * vb.height + vb.y };
        if (localPt.y < vb.y + 40) {
          dropIsTopLevel = true;
          self.toplevelZoneEl.classList.add('tsg-active', 'tsg-drop-valid');
        } else {
          self.toplevelZoneEl.classList.remove('tsg-active');
          // find nearest theme node under pointer
          var best = null, bestDist = Infinity;
          self.nodes.forEach(function (other) {
            if (other.type !== 'theme') return;
            var ok = key(other.type, other.id);
            if (ok === k) return;
            var op = self.pos[ok];
            var d = Math.hypot(op.x - gp.x, op.y - gp.y);
            if (d < NODE_R * 1.3 && d < bestDist) { bestDist = d; best = ok; }
          });
          if (best) {
            dropTargetKey = best;
            var invalid = (best === k) || isDescendantTheme(best, k);
            self._domNodes[best].classList.add(invalid ? 'tsg-drop-invalid' : 'tsg-drop-valid');
          }
        }
      }
    };

    var up = function (uev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      self.toplevelZoneEl.classList.remove('tsg-active', 'tsg-drop-valid');
      Object.keys(self._domNodes).forEach(function (ok) { self._domNodes[ok].classList.remove('tsg-drop-valid', 'tsg-drop-invalid'); });

      if (!moved) {
        // treat as click (already stopped propagation) — selection handled via click event
        return;
      }

      if (n.type === 'theme' && dropIsTopLevel) {
        self.confirmReparent(n, null, startPos, k);
        return;
      }
      if (n.type === 'theme' && dropTargetKey) {
        var invalid = (dropTargetKey === k) || isDescendantTheme(dropTargetKey, k);
        if (dropTargetKey === k) {
          self.showTooltipNear(g, 'Ein Topic kann nicht sein eigenes Elternteil sein');
          self.shakeNode(k);
          self.revertPosition(n, startPos, k);
          return;
        }
        if (invalid) {
          self.showTooltipNear(g, 'Zyklus: Ziel ist ein Unter-Topic dieses Topics');
          self.shakeNode(k);
          self.revertPosition(n, startPos, k);
          return;
        }
        var targetNode = self.nodeMap[dropTargetKey];
        self.confirmReparent(n, targetNode, startPos, k);
        return;
      }

      // plain position move -> save (no dialog)
      self.scheduleSavePosition(n, k);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  GraphInstance.prototype.revertPosition = function (n, startPos, k) {
    this.pos[k] = startPos;
    if (this._domNodes[k]) this._domNodes[k].setAttribute('transform', 'translate(' + startPos.x + ',' + startPos.y + ')');
    this.updateIncidentEdges(k);
  };

  GraphInstance.prototype.shakeNode = function (k) {
    var g = this._domNodes[k];
    if (!g) return;
    g.classList.remove('tsg-shake');
    void g.offsetWidth;
    g.classList.add('tsg-shake');
  };

  GraphInstance.prototype.showTooltipNear = function (g, text) {
    var self = this;
    var tip = htmlEl('div', { class: 'tsg-tooltip' }, text);
    var rect = g.getBoundingClientRect();
    var rootRect = this.root.getBoundingClientRect();
    tip.style.left = Math.max(4, rect.left - rootRect.left) + 'px';
    tip.style.top = Math.max(4, rect.top - rootRect.top - 28) + 'px';
    this.root.appendChild(tip);
    setTimeout(function () { tip.remove(); }, 2200);
  };

  GraphInstance.prototype.confirmReparent = function (childNode, parentNode, startPos, k) {
    var self = this;
    var childKey = key(childNode.type, childNode.id);
    var msg = parentNode
      ? '„' + childNode.title + '“ unter „' + parentNode.title + '“ verschieben?'
      : '„' + childNode.title + '“ auf die oberste Ebene verschieben?';
    var run = function (ok) {
      if (!ok) { self.revertPosition(childNode, startPos, k); return; }
      self.doReparent(childNode, parentNode, startPos);
    };
    if (this.host && typeof this.host.confirm === 'function') {
      this.host.confirm({ title: 'Topic verschieben', message: msg, confirmLabel: 'Verschieben' }).then(run);
    } else if (window.confirm(msg)) { run(true); } else { run(false); }
  };

  GraphInstance.prototype.doReparent = function (childNode, parentNode, startPos) {
    var self = this;
    var childKey = key(childNode.type, childNode.id);
    var oldParentEdge = (this.edgesByNode[childKey] || []).find(function (e) {
      return e.kind === 'hierarchy' && key(e.source.type, e.source.id) === childKey;
    });
    var newParentId = parentNode ? parentNode.id : null;

    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; }, 10000);

    this.host.api('PUT', '/api/themes/' + encodeURIComponent(childNode.id) + '/move', { parentId: newParentId })
      .then(function () {
        clearTimeout(timer);
        // optimistic edge update
        if (oldParentEdge) delete self.edgeMap[oldParentEdge.id];
        if (oldParentEdge) self.edges = self.edges.filter(function (e) { return e.id !== oldParentEdge.id; });
        if (parentNode) {
          var newEdge = {
            id: 'tmp-' + Date.now(), kind: 'hierarchy',
            source: { type: 'theme', id: childNode.id }, target: { type: 'theme', id: parentNode.id }
          };
          self.edges.push(newEdge);
          self.edgeMap[newEdge.id] = newEdge;
        }
        self.rebuildEdgeIndex();
        self.renderAll();
        self.scheduleSavePosition(childNode, childKey);
        self.toast('Topic verschoben', 'success');
        self.announce('Topic „' + childNode.title + '“ wurde verschoben.', true);
        self.offerUndo(childNode, oldParentEdge, parentNode);
      })
      .catch(function (err) {
        clearTimeout(timer);
        self.revertPosition(childNode, startPos, childKey);
        var msg = timedOut ? 'Zeitüberschreitung beim Verschieben.' : 'Topic konnte nicht verschoben werden.';
        self.toastWithRetry(msg, function () { self.doReparent(childNode, parentNode, startPos); });
      });
  };

  GraphInstance.prototype.offerUndo = function (childNode, oldParentEdge, newParentNode) {
    var self = this;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    var oldParentId = oldParentEdge ? oldParentEdge.target.id : null;
    var undoFn = function () {
      self.doReparent(childNode, oldParentId ? self.nodeMap[key('theme', oldParentId)] : null, self.pos[key(childNode.type, childNode.id)]);
    };
    if (this.host && typeof this.host.toast === 'function') {
      // host toast has no built-in action API in the contract; surface via console-safe local UI as fallback
      this._undoAvailable = undoFn;
    }
    this.undoTimer = setTimeout(function () { self._undoAvailable = null; }, 8000);
  };

  GraphInstance.prototype.toastWithRetry = function (msg, retryFn) {
    this.toast(msg + ' Erneut versuchen möglich.', 'error');
    this._lastRetry = retryFn;
  };

  GraphInstance.prototype.rebuildEdgeIndex = function () {
    var self = this;
    this.edgesByNode = {};
    this.edges.forEach(function (e) {
      var sk = key(e.source.type, e.source.id), tk = key(e.target.type, e.target.id);
      (self.edgesByNode[sk] = self.edgesByNode[sk] || []).push(e);
      (self.edgesByNode[tk] = self.edgesByNode[tk] || []).push(e);
    });
  };

  // ==========================================================================
  // Position save queue (B8) — strict serialization
  // ==========================================================================
  GraphInstance.prototype.scheduleSavePosition = function (n, k) {
    var p = this.pos[k];
    this.pendingBatch[k] = { type: n.type, id: n.id, x: p.x, y: p.y };
    this.setSyncState('saving');
    this.saveDebounced();
  };

  GraphInstance.prototype.savePositionsBatch = function (arr) {
    var self = this;
    arr.forEach(function (item) { self.pendingBatch[key(item.type, item.id)] = item; });
    this.setSyncState('saving');
    this.saveDebounced();
  };

  GraphInstance.prototype._flushPositions = function () {
    if (this.saveInFlight) return; // will be re-scheduled when in-flight request finishes
    var keys = Object.keys(this.pendingBatch);
    if (!keys.length) { this.setSyncState('saved'); return; }
    var self = this;
    var batch = keys.map(function (k) { return self.pendingBatch[k]; }).slice(0, 500);
    keys.forEach(function (k) { delete self.pendingBatch[k]; });
    this.saveInFlight = true;

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 10000);
    var opts = controller ? { signal: controller.signal } : undefined;

    this.host.api('PATCH', '/api/graph/positions', { positions: batch }, opts)
      .then(function () {
        clearTimeout(timer);
        self.saveInFlight = false;
        self.setSyncState('saved');
        self.announce('Positionen gespeichert.', false);
        if (Object.keys(self.pendingBatch).length) self.saveDebounced();
      })
      .catch(function () {
        clearTimeout(timer);
        self.saveInFlight = false;
        // requeue failed items unless newer values already pending
        batch.forEach(function (item) {
          var k = key(item.type, item.id);
          if (!self.pendingBatch[k]) self.pendingBatch[k] = item;
        });
        self.setSyncState('error');
        self.toast('Position konnte nicht gespeichert werden – Änderung bleibt nur lokal sichtbar.', 'error');
        if (Object.keys(self.pendingBatch).length) self.saveDebounced();
      });
  };

  GraphInstance.prototype.setSyncState = function (state) {
    if (!this.syncDot) return;
    this.syncDot.classList.remove('tsg-saving', 'tsg-error');
    if (state === 'saving') { this.syncDot.classList.add('tsg-saving'); this.syncLabel.textContent = 'Speichert …'; }
    else if (state === 'error') { this.syncDot.classList.add('tsg-error'); this.syncLabel.textContent = 'Nicht gespeichert'; }
    else { this.syncLabel.textContent = 'Gespeichert'; }
  };

  // ==========================================================================
  // Edge creation via drag from handle (B6)
  // ==========================================================================
  GraphInstance.prototype.compatibleTargets = function (fromType) {
    return this.schema.compatibility.filter(function (c) { return c.source === fromType; }).map(function (c) { return c.target; });
  };

  GraphInstance.prototype.isCompatible = function (fromType, toType) {
    return this.schema.compatibility.some(function (c) { return c.source === fromType && c.target === toType; });
  };

  GraphInstance.prototype.onHandlePointerDown = function (ev, n) {
    var self = this;
    var fromKey = key(n.type, n.id);
    var rect = this.svg.getBoundingClientRect();
    var vb = this.svg.viewBox.baseVal;

    var toGraphCoords = function (clientX, clientY) {
      var localX = ((clientX - rect.left) / rect.width) * vb.width + vb.x;
      var localY = ((clientY - rect.top) / rect.height) * vb.height + vb.y;
      return { x: (localX - self.viewport.x) / self.viewport.k, y: (localY - self.viewport.y) / self.viewport.k };
    };

    var previewLine = svgEl('path', { class: 'tsg-edge-preview' });
    var previewLabel = svgEl('text', { class: 'tsg-label', 'font-weight': '700' });
    this.gPreview.appendChild(previewLine);
    this.gPreview.appendChild(previewLabel);

    var targetKey = null;
    var startP = this.pos[fromKey];

    var move = function (mev) {
      var gp = toGraphCoords(mev.clientX, mev.clientY);
      previewLine.setAttribute('d', 'M ' + startP.x + ' ' + startP.y + ' L ' + gp.x + ' ' + gp.y);

      Object.keys(self._domNodes).forEach(function (ok) { if (ok !== fromKey) self._domNodes[ok].classList.remove('tsg-drop-valid', 'tsg-drop-invalid'); });
      targetKey = null;
      var best = null, bestDist = Infinity;
      self.nodes.forEach(function (other) {
        var ok = key(other.type, other.id);
        if (ok === fromKey) return;
        var op = self.pos[ok];
        var d = Math.hypot(op.x - gp.x, op.y - gp.y);
        if (d < NODE_R * 1.3 && d < bestDist) { bestDist = d; best = ok; }
      });
      previewLine.classList.remove('tsg-invalid');
      previewLabel.textContent = '';
      if (best) {
        targetKey = best;
        var otherNode = self.nodeMap[best];
        var ok = self.isCompatible(n.type, otherNode.type);
        self._domNodes[best].classList.add(ok ? 'tsg-drop-valid' : 'tsg-drop-invalid');
        if (!ok) previewLine.classList.add('tsg-invalid');
        if (ok && n.type === 'theme' && otherNode.type === 'theme') {
          previewLabel.textContent = 'wird Unter-Topic von „' + otherNode.title + '“';
          previewLabel.setAttribute('x', gp.x + 10);
          previewLabel.setAttribute('y', gp.y - 10);
        }
      }
    };

    var up = function () {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      previewLine.remove(); previewLabel.remove();
      Object.keys(self._domNodes).forEach(function (ok) { self._domNodes[ok].classList.remove('tsg-drop-valid', 'tsg-drop-invalid'); });

      if (!targetKey) return;
      var otherNode = self.nodeMap[targetKey];
      if (!self.isCompatible(n.type, otherNode.type)) {
        self.toast('Diese Verknüpfung ist nicht möglich.', 'error');
        return;
      }
      self.confirmCreateEdge(n, otherNode);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  GraphInstance.prototype.confirmCreateEdge = function (a, b) {
    var self = this;
    var directed = a.type === 'theme' && b.type === 'theme';
    var msg = directed
      ? '„' + a.title + '“ wird Unter-Topic von „' + b.title + '“?'
      : '„' + a.title + '“ und „' + b.title + '“ verknüpfen?';
    var run = function (ok) { if (ok) self.createEdge(a, b); };
    if (this.host && typeof this.host.confirm === 'function') {
      this.host.confirm({ title: 'Verknüpfen', message: msg, confirmLabel: 'Verknüpfen' }).then(run);
    } else if (window.confirm(msg)) { run(true); }
  };

  GraphInstance.prototype.createEdge = function (a, b) {
    var self = this;
    var tempId = 'tmp-' + Date.now();
    var tempEdge = {
      id: tempId,
      kind: a.type === 'theme' && b.type === 'theme' ? 'hierarchy'
        : (a.type === 'knowledge' && b.type === 'theme') || (a.type === 'theme' && b.type === 'knowledge') ? 'knowledge_topic'
        : (a.type === 'knowledge' && b.type === 'knowledge') ? 'knowledge_knowledge' : 'theme_link',
      source: { type: a.type, id: a.id }, target: { type: b.type, id: b.id }
    };
    this.edges.push(tempEdge);
    this.edgeMap[tempId] = tempEdge;
    this.rebuildEdgeIndex();
    this.renderAll();

    this.host.api('POST', '/api/graph/edges', { source: tempEdge.source, target: tempEdge.target })
      .then(function (res) {
        self.edges = self.edges.filter(function (e) { return e.id !== tempId; });
        delete self.edgeMap[tempId];
        var real = (res && res.edge) ? res.edge : tempEdge;
        self.edges.push(real);
        self.edgeMap[real.id] = real;
        self.rebuildEdgeIndex();
        self.renderAll();
        var created = !res || res.created !== false;
        self.toast(created ? 'Verknüpfung erstellt' : 'Verknüpfung existiert bereits', 'success');
        if (self._domEdges[real.id]) {
          self._domEdges[real.id].path.classList.add('tsg-edge-highlight');
          setTimeout(function () { if (self._domEdges[real.id]) self._domEdges[real.id].path.classList.remove('tsg-edge-highlight'); }, 1200);
        }
        self.announce('Verknüpfung zwischen ' + a.title + ' und ' + b.title + ' erstellt.', true);
      })
      .catch(function (err) {
        self.edges = self.edges.filter(function (e) { return e.id !== tempId; });
        delete self.edgeMap[tempId];
        self.rebuildEdgeIndex();
        self.renderAll();
        var msg = err && err.code === 'CYCLE' ? 'Diese Verknüpfung würde einen Zyklus erzeugen.'
          : err && err.code === 'INCOMPATIBLE_LINK' ? 'Diese Verknüpfung ist nicht möglich.'
          : 'Verknüpfung konnte nicht erstellt werden.';
        self.toastWithRetry(msg, function () { self.createEdge(a, b); });
      });
  };

  // ---- Edge deletion (B7) ------------------------------------------------
  GraphInstance.prototype.confirmDeleteEdge = function (e) {
    var self = this;
    var sn = this.nodeMap[key(e.source.type, e.source.id)];
    var tn = this.nodeMap[key(e.target.type, e.target.id)];
    var msg = e.kind === 'hierarchy'
      ? 'Das Topic „' + (sn ? sn.title : '?') + '“ wird dadurch zum Top-Level-Topic. Fortfahren?'
      : 'Verknüpfung zwischen „' + (sn ? sn.title : '?') + '“ und „' + (tn ? tn.title : '?') + '“ entfernen?';
    var run = function (ok) { if (ok) self.deleteEdge(e); };
    if (this.host && typeof this.host.confirm === 'function') {
      this.host.confirm({ title: 'Verknüpfung entfernen', message: msg, confirmLabel: 'Entfernen' }).then(run);
    } else if (window.confirm(msg)) { run(true); }
  };

  GraphInstance.prototype.deleteEdge = function (e) {
    var self = this;
    var backup = e;
    this.edges = this.edges.filter(function (ed) { return ed.id !== e.id; });
    delete this.edgeMap[e.id];
    this.rebuildEdgeIndex();
    this.renderAll();
    this.closePanel();

    this.host.api('DELETE', '/api/graph/edges/' + encodeURIComponent(e.id))
      .then(function (res) {
        self.toast('Verknüpfung entfernt', 'success');
        self.announce('Verknüpfung entfernt.', true);
        if (res && res.warning === 'KNOWLEDGE_PAGE_NOW_UNASSIGNED') {
          self.toast('Diese Seite ist jetzt nur noch unter „Ohne Topic“ auffindbar.', 'success');
        }
      })
      .catch(function () {
        self.edges.push(backup);
        self.edgeMap[backup.id] = backup;
        self.rebuildEdgeIndex();
        self.renderAll();
        self.toastWithRetry('Verknüpfung konnte nicht entfernt werden.', function () { self.deleteEdge(backup); });
      });
  };

  // ==========================================================================
  // Combobox helpers (keyboard alternative for reparent / link) — B5/B6
  // ==========================================================================
  GraphInstance.prototype.openMoveCombobox = function (n) {
    var self = this;
    var options = this.nodes.filter(function (o) { return o.type === 'theme' && o.id !== n.id; });
    this.renderCombobox('Verschieben nach …', options, function (target) {
      self.confirmReparent(n, target, self.pos[key(n.type, n.id)], key(n.type, n.id));
    }, { includeTopLevel: true, onTopLevel: function () { self.confirmReparent(n, null, self.pos[key(n.type, n.id)], key(n.type, n.id)); } });
  };

  GraphInstance.prototype.openLinkCombobox = function (n) {
    var self = this;
    var compatibleTypes = this.compatibleTargets(n.type);
    var options = this.nodes.filter(function (o) {
      return o.id !== n.id && compatibleTypes.indexOf(o.type) !== -1;
    });
    this.renderCombobox('Verknüpfen mit …', options, function (target) {
      self.confirmCreateEdge(n, target);
    });
  };

  GraphInstance.prototype.renderCombobox = function (label, options, onPick, extra) {
    var self = this;
    if (this.panelComboContainer) this.panelComboContainer.remove();
    var wrap = htmlEl('div', { class: 'tsg-combo' });
    wrap.appendChild(htmlEl('label', { class: 'tsg-panel-meta' }, label));
    var input = htmlEl('input', { type: 'text', placeholder: 'Tippen zum Filtern…', 'aria-label': label });
    var list = htmlEl('ul', { class: 'tsg-combo-list' });
    wrap.appendChild(input);
    wrap.appendChild(list);

    if (extra && extra.includeTopLevel) {
      var liTop = document.createElement('li');
      var btnTop = htmlEl('button', {}, '(Oberste Ebene)');
      this.on(btnTop, 'click', extra.onTopLevel);
      liTop.appendChild(btnTop);
      list.appendChild(liTop);
    }

    var renderList = function (term) {
      var filtered = options.filter(function (o) { return (o.title || '').toLowerCase().indexOf(term) !== -1; });
      Array.from(list.children).forEach(function (c) { if (!c.dataset || c.dataset.fixed !== 'true') c.remove(); });
      filtered.forEach(function (o) {
        var li = document.createElement('li');
        var btn = htmlEl('button', {}, o.title);
        self.on(btn, 'click', function () { onPick(o); });
        li.appendChild(btn);
        list.appendChild(li);
      });
    };
    renderList('');
    this.on(input, 'input', function () { renderList(input.value.toLowerCase()); });

    this.panel.appendChild(wrap);
    this.panelComboContainer = wrap;
    input.focus();
  };

  // ==========================================================================
  // Focus mode (B3)
  // ==========================================================================
  GraphInstance.prototype.enterFocusMode = function (n, depth) {
    this.focusModeKey = key(n.type, n.id);
    this.focusModeDepth = depth;
    this.renderFocusBreadcrumb(n);
    this.renderVisibility();
  };

  GraphInstance.prototype.exitFocusMode = function () {
    this.focusModeKey = null;
    if (this.breadcrumbEl) { this.breadcrumbEl.remove(); this.breadcrumbEl = null; }
    this.renderVisibility();
  };

  GraphInstance.prototype.renderFocusBreadcrumb = function (n) {
    var self = this;
    if (this.breadcrumbEl) this.breadcrumbEl.remove();
    var el = htmlEl('div', { class: 'tsg-breadcrumb' });
    el.appendChild(htmlEl('span', {}, 'Fokus: ' + n.title));
    var btn = htmlEl('button', {}, 'Zurücksetzen ×');
    this.on(btn, 'click', function () { self.exitFocusMode(); });
    el.appendChild(btn);
    this.root.appendChild(el);
    this.breadcrumbEl = el;
  };

  // ==========================================================================
  // Accessible node list (screen-reader alternative)
  // ==========================================================================
  GraphInstance.prototype.toggleA11yList = function () {
    this.a11yListOpen = !this.a11yListOpen;
    if (this.a11yListOpen) this.a11yList.removeAttribute('hidden'); else this.a11yList.setAttribute('hidden', 'hidden');
  };

  GraphInstance.prototype.renderA11yList = function () {
    if (!this.a11yList) return;
    var self = this;
    this.a11yList.innerHTML = '';
    var closeBtn = htmlEl('button', { class: 'tsg-btn' }, 'Schließen');
    this.on(closeBtn, 'click', function () { self.toggleA11yList(); });
    this.a11yList.appendChild(closeBtn);
    var visible = this.visibleKeys();
    TYPES.forEach(function (t) {
      var group = self.nodes.filter(function (n) { return n.type === t && visible[key(n.type, n.id)]; });
      if (!group.length) return;
      self.a11yList.appendChild(htmlEl('h3', {}, TYPE_LABELS[t] + ' (' + group.length + ')'));
      var ul = document.createElement('ul');
      group.forEach(function (n) {
        var li = document.createElement('li');
        var btn = htmlEl('button', { 'aria-label': self.nodeAriaLabel(n) });
        btn.textContent = n.title + (n.done === true ? ' (erledigt)' : '');
        self.on(btn, 'click', function () { self.selectNode(key(n.type, n.id)); self.toggleA11yList(); });
        li.appendChild(btn);
        ul.appendChild(li);
      });
      self.a11yList.appendChild(ul);
    });
  };

  // ==========================================================================
  // Public API
  // ==========================================================================
  var instance = null;

  window.TSGraph = {
    mount: function (rootEl) {
      if (!rootEl) throw new Error('TSGraph.mount: rootEl erforderlich');
      if (instance && instance.mounted) {
        if (instance.root === rootEl) return; // idempotent no-op
        instance.unmount();
      }
      instance = new GraphInstance(rootEl);
      instance.mount();
    },
    unmount: function () {
      if (instance) { instance.unmount(); }
    },
    invalidate: function () {
      if (instance) instance.invalidate();
    },
    isMounted: function () {
      return !!(instance && instance.mounted);
    },
    // Test-/Benchmark-Hilfsfunktionen, ausschließlich für graph-dev.html gedacht.
    _debug: {
      getInstance: function () { return instance; },
      computeLayout: computeLayout
    }
  };
})();
