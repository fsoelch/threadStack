/*
 * ThreadStack — Ansprechpartner/Kontakte-Erweiterung (Arbeitspaket W1)
 *
 * Exponiert ausschließlich window.TSContacts = {
 *   mountContactDetail, contactBadgesHtml, openAssignmentPicker,
 *   assignedContactsHtml, version
 * } — siehe Vertrag im Arbeitspaket-Auftrag.
 *
 * Konsumiert:
 *  - window.TSProgress (public/progress.js) für die chronologischen Notizen
 *    eines Kontakts (refType:'contact') — KEIN eigener Notiz-Composer, siehe
 *    mountInlineComposer/mountTimeline dort.
 *  - Host-Adapter, die W2 (index.html/app.js-Integration) beim Aufruf von
 *    mountContactDetail() durchreicht: rt (setRT/getRT), openThemeLinkModal,
 *    confirm, toast, onContactChanged, onNavigate, onError. Dieses Modul
 *    ruft KEINE app.js-Funktionen direkt auf.
 *
 * Netzwerk: Der Vertrag sieht für mountContactDetail()/openAssignmentPicker()
 * keinen `api`-Adapter vor (anders als TSHost.api bei progress.js/graph.js).
 * Dieses Modul spricht daher direkt mit `fetch()` unter den in der
 * Architektur spezifizierten absoluten Pfaden (`/api/...`). Läuft die App
 * unter einem Basis-Pfad-Präfix (siehe `_path`/`API` in app.js), greift das
 * NICHT automatisch — siehe Abweichungsdokumentation im Abschlussbericht.
 *
 * Keine Fremdbibliothek, kein Build-Step.
 */
(function (root) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');

  // ==========================================================================
  // Reine Hilfsfunktionen
  // ==========================================================================

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function noop() {}

  function isFn(x) { return typeof x === 'function'; }

  function normLabel(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  function genId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function isPrivateCategory(cat) {
    return !!(cat && (cat.isPrivate === true || normLabel(cat.label) === 'privates'));
  }

  /**
   * Rubrik-Badges + Klartext-Auszug für die Kontaktkarte (siehe Vertrag).
   * Liefert '' wenn der Kontakt keine Zusatzinfos hat. "Privates" erscheint
   * NIE als Textauszug, nur als Badge ohne Vorschautext.
   */
  function contactBadgesHtml(contact, opts) {
    opts = opts || {};
    if (!contact || typeof contact !== 'object') return '';
    var maxBadges = (typeof opts.maxBadges === 'number' && opts.maxBadges > 0) ? opts.maxBadges : 4;
    var categories = Array.isArray(contact.categories) ? contact.categories : [];
    var hasSnippet = typeof contact.snippet === 'string' && contact.snippet.trim() !== '';
    if (!categories.length && !hasSnippet) return '';

    var shown = categories.slice(0, maxBadges);
    var rest = categories.slice(maxBadges);

    var html = '';
    if (shown.length || rest.length) {
      html += '<span class="tsc-badges">';
      for (var i = 0; i < shown.length; i++) {
        var cat = shown[i];
        var priv = isPrivateCategory(cat);
        var icon = priv ? '🔒' : '🏷️';
        var label = cat && cat.label != null ? String(cat.label) : '';
        html += '<span class="tsc-badge' + (priv ? ' tsc-badge-private' : '') + '">' +
          '<span class="tsc-badge-icon" aria-hidden="true">' + icon + '</span>' +
          '<span class="tsc-badge-label">' + escHtml(label) + '</span></span>';
      }
      if (rest.length) {
        var names = [];
        for (var j = 0; j < rest.length; j++) {
          if (rest[j] && rest[j].label != null) names.push(String(rest[j].label));
        }
        var namesText = names.join(', ');
        var moreAria = 'Weitere Rubriken: ' + namesText;
        html += '<span class="tsc-badge tsc-badge-more" title="' + escHtml(namesText) + '" aria-label="' + escHtml(moreAria) + '">+' + rest.length + '</span>';
      }
      html += '</span>';
    }

    // Datenschutz (Vertrag): eine Rubrik "Privates" darf nie als Textauszug
    // erscheinen. Der Server liefert nur EINEN aggregierten Klartextauszug
    // (kein Pro-Rubrik-Text) — die Ausschlusspflicht dafür liegt beim
    // Server. Defensiv wird hier zusätzlich unterdrückt, falls die EINZIGEN
    // gemeldeten Rubriken ausschließlich "Privates" sind (dann kann der vom
    // Server gelieferte Snippet nur aus dieser Rubrik stammen).
    var onlyPrivate = categories.length > 0 && categories.every(isPrivateCategory);
    if (hasSnippet && !onlyPrivate) {
      html += '<span class="tsc-snippet">' + escHtml(contact.snippet) + '</span>';
    }
    return html;
  }

  /**
   * Chips zugeordneter Ansprechpartner an Karte/Detail eines Vorhabens.
   * `onClickAttr` ist optional eine Funktion (contact) -> HTML-Attribut-
   * Fragment, das dem Host obliegt (Host ist verantwortlich für Escaping
   * innerhalb des zurückgegebenen Fragments, analog zu bestehenden
   * onclick="..."-Mustern in app.js).
   */
  function assignedContactsHtml(contacts, opts) {
    opts = opts || {};
    var list = Array.isArray(contacts) ? contacts : [];
    if (!list.length) return '';
    var getAttr = isFn(opts.onClickAttr) ? opts.onClickAttr : function () { return ''; };
    var out = '<span class="tsc-assigned-chips">';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || typeof c !== 'object') continue;
      var name = c.name != null ? String(c.name) : '';
      var roleTxt = c.role != null ? String(c.role) : '';
      var attr = '';
      try { attr = getAttr(c) || ''; } catch (e) { attr = ''; }
      out += '<span class="tsc-assigned-chip"' + (attr ? ' ' + attr : '') + '>' +
        '<span class="tsc-assigned-chip-icon" aria-hidden="true">👤</span>' +
        '<span class="tsc-assigned-chip-name">' + escHtml(name) + '</span>' +
        (roleTxt ? '<span class="tsc-assigned-chip-role">· ' + escHtml(roleTxt) + '</span>' : '') +
        '</span>';
    }
    out += '</span>';
    return out;
  }

  // ==========================================================================
  // Netzwerk (kein TSHost.api-Adapter im Vertrag, siehe Header-Kommentar)
  // ==========================================================================

  function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin' };
    if (body != null) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Fehler');
          err.status = res.status;
          err.code = data && data.code;
          err.body = data || {};
          throw err;
        }
        return data;
      });
    });
  }

  function contactUrl(id) { return '/api/contacts/' + encodeURIComponent(id); }
  function categoriesUrl() { return '/api/contact-categories'; }
  function categoryUrl(id) { return '/api/contact-categories/' + encodeURIComponent(id); }
  function infoBlocksUrl(contactId) { return contactUrl(contactId) + '/info-blocks'; }
  function infoBlockUrl(contactId, blockId) { return infoBlocksUrl(contactId) + '/' + encodeURIComponent(blockId); }
  function infoBlocksReorderUrl(contactId) { return infoBlocksUrl(contactId) + '/reorder'; }
  function themesUrl() { return '/api/themes'; }
  function themeLinkUrl(themeId, linkId) { return '/api/themes/' + encodeURIComponent(themeId) + '/links/' + encodeURIComponent(linkId); }
  function contactAssignmentsUrl(contactId, params) {
    var url = contactUrl(contactId) + '/assignments';
    var qs = [];
    if (params) {
      if (params.limit != null) qs.push('limit=' + encodeURIComponent(params.limit));
      if (params.offset != null) qs.push('offset=' + encodeURIComponent(params.offset));
      if (params.status != null) qs.push('status=' + encodeURIComponent(params.status));
    }
    return qs.length ? url + '?' + qs.join('&') : url;
  }
  function contactAssignmentDeleteUrl(contactId, refType, refId) {
    return contactUrl(contactId) + '/assignments/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId);
  }
  function assignmentsForRefUrl(refType, refId) {
    return '/api/assignments/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId);
  }

  function genericErrorMessage() {
    return 'Das hat leider nicht geklappt. Bitte später erneut versuchen.';
  }

  // ==========================================================================
  // Kleine DOM-Helfer (analog progress.js)
  // ==========================================================================

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') e.className = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (html != null) e.innerHTML = html;
    return e;
  }

  function renderErrorBox(container, message, retryLabel, onRetry) {
    container.innerHTML = '';
    var box = el('div', { class: 'tsc-error-box', role: 'alert' });
    box.appendChild(el('p', { class: 'tsc-error-text' }, escHtml(message)));
    if (onRetry) {
      var btn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary' }, escHtml(retryLabel || 'Erneut versuchen'));
      btn.addEventListener('click', onRetry);
      box.appendChild(btn);
    }
    container.appendChild(box);
    return box;
  }

  // Fokussierbare Elemente innerhalb eines Dialogs (für Fokusfalle/Tab-Zyklus).
  // Bewusst OHNE offsetParent-basierten Sichtbarkeits-Check: jsdom (Test-
  // umgebung dieses Arbeitspakets) berechnet kein Layout, offsetParent wäre
  // dort für alle Elemente null — der reine Selektor (inkl. :not([disabled]))
  // reicht für den Fokusfalle-Zweck aus.
  function focusablesIn(container) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(container.querySelectorAll(sel));
  }

  /**
   * Verdrahtet eine einfache Fokusfalle + Escape-schließt für einen Dialog.
   * Gibt eine close()-Funktion zurück, die den Fokus auf `restoreEl`
   * zurücksetzt (falls vorhanden) und den `onClose`-Callback aufruft.
   */
  function wireDialogA11y(overlayEl, dialogEl, restoreEl, onClose) {
    var closed = false;
    function keydown(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key === 'Tab') {
        var items = focusablesIn(dialogEl);
        if (!items.length) return;
        var first = items[0], last = items[items.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault(); last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault(); first.focus();
        }
      }
    }
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keydown, true);
      if (overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      if (restoreEl && isFn(restoreEl.focus)) {
        try { restoreEl.focus(); } catch (e) { /* Element evtl. nicht mehr im DOM */ }
      }
      if (isFn(onClose)) onClose();
    }
    document.addEventListener('keydown', keydown, true);
    return close;
  }

  // ==========================================================================
  // Rubrik-Combobox (Freitext + Neuanlage), volles ARIA-Combobox-Pattern
  // ==========================================================================

  /**
   * Baut eine Rubrik-Combobox in `hostEl` (leerer Container). `categories`
   * ist die Liste bestehender Rubriken ({id,label,isPrivate}); `initial` ist
   * das aktuell gewählte Category-Objekt (oder null). `onSelect(categoryObj)`
   * wird mit einer bestehenden Rubrik ODER `{id:null, label: '<neuer Text>'}`
   * aufgerufen (Aufrufer erkennt "neu anlegen" an `id === null`).
   */
  function buildCategoryCombobox(hostEl, categories, initial, onSelect) {
    var uid = genId('tsc-combo-');
    var inputId = uid + '-input';
    var listId = uid + '-list';
    hostEl.innerHTML = '';
    var wrap = el('div', { class: 'tsc-combobox' });
    var input = el('input', {
      type: 'text', class: 'tsc-combobox-input', id: inputId,
      role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId,
      'aria-autocomplete': 'list', 'aria-activedescendant': '', autocomplete: 'off',
      placeholder: 'Rubrik wählen oder neu anlegen …'
    });
    input.value = initial && initial.label ? String(initial.label) : '';
    var list = el('ul', { class: 'tsc-combobox-list', id: listId, role: 'listbox', 'aria-label': 'Rubriken' });
    list.hidden = true;
    wrap.appendChild(input);
    wrap.appendChild(list);
    hostEl.appendChild(wrap);

    var state = { open: false, options: [], activeIndex: -1, selected: initial || null };

    function computeOptions() {
      var q = normLabel(input.value);
      var matches = categories.filter(function (c) {
        return normLabel(c.label).indexOf(q) !== -1;
      });
      var exact = categories.some(function (c) { return normLabel(c.label) === q; });
      var opts = matches.map(function (c) { return { kind: 'existing', category: c }; });
      var trimmed = input.value.trim();
      if (trimmed !== '' && !exact) {
        opts.push({ kind: 'new', label: trimmed });
      }
      return opts;
    }

    function optionId(i) { return uid + '-opt-' + i; }

    function renderList() {
      list.innerHTML = '';
      state.options.forEach(function (opt, i) {
        var li = el('li', {
          class: 'tsc-combobox-option' + (i === state.activeIndex ? ' tsc-combobox-option-active' : ''),
          id: optionId(i), role: 'option', 'aria-selected': i === state.activeIndex ? 'true' : 'false'
        });
        if (opt.kind === 'new') {
          li.className += ' tsc-combobox-option-new';
          li.textContent = '➕ Neue Rubrik „' + opt.label + '" anlegen';
        } else {
          var priv = isPrivateCategory(opt.category);
          li.textContent = (priv ? '🔒 ' : '🏷️ ') + (opt.category.label || '');
        }
        li.addEventListener('mousedown', function (ev) {
          ev.preventDefault();
          choose(i);
        });
        list.appendChild(li);
      });
      list.hidden = state.options.length === 0 || !state.open;
      input.setAttribute('aria-expanded', (!list.hidden) ? 'true' : 'false');
      input.setAttribute('aria-activedescendant', state.activeIndex >= 0 ? optionId(state.activeIndex) : '');
    }

    function openList() {
      state.options = computeOptions();
      state.activeIndex = state.options.length ? 0 : -1;
      state.open = true;
      renderList();
    }

    function closeList() {
      state.open = false;
      state.options = [];
      state.activeIndex = -1;
      renderList();
    }

    function choose(i) {
      var opt = state.options[i];
      if (!opt) return;
      if (opt.kind === 'new') {
        input.value = opt.label;
        state.selected = { id: null, label: opt.label };
      } else {
        input.value = opt.category.label;
        state.selected = opt.category;
      }
      closeList();
      input.focus();
      onSelect(state.selected);
    }

    input.addEventListener('input', function () {
      state.selected = null;
      openList();
    });
    input.addEventListener('focus', function () { openList(); });
    input.addEventListener('blur', function () {
      // leichte Verzögerung, damit ein mousedown auf eine Option nicht durch
      // das vorherige blur "verschwindet" (mousedown+preventDefault oben
      // verhindert das Blur bereits, dies ist zusätzliche Absicherung).
      setTimeout(function () { closeList(); }, 0);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (!state.open) { openList(); return; }
        if (state.options.length) {
          state.activeIndex = (state.activeIndex + 1) % state.options.length;
          renderList();
        }
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!state.open) { openList(); return; }
        if (state.options.length) {
          state.activeIndex = (state.activeIndex - 1 + state.options.length) % state.options.length;
          renderList();
        }
      } else if (ev.key === 'Enter') {
        if (state.open && state.activeIndex >= 0) {
          ev.preventDefault();
          choose(state.activeIndex);
        }
      } else if (ev.key === 'Escape') {
        if (state.open) { ev.preventDefault(); closeList(); }
      }
    });

    return {
      getSelected: function () { return state.selected; },
      focus: function () { input.focus(); },
      destroy: function () { hostEl.innerHTML = ''; }
    };
  }

  // ==========================================================================
  // Kontakt-Detailbereich (mountContactDetail)
  // ==========================================================================

  function ContactDetailInstance(container, opts) {
    this.container = container;
    this.contactId = opts.contactId;
    this.onContactChanged = isFn(opts.onContactChanged) ? opts.onContactChanged : noop;
    this.onNavigate = isFn(opts.onNavigate) ? opts.onNavigate : noop;
    this.onError = isFn(opts.onError) ? opts.onError : noop;
    this.rt = (opts.rt && isFn(opts.rt.setRT) && isFn(opts.rt.getRT)) ? opts.rt : { setRT: noop, getRT: function () { return ''; } };
    this.openThemeLinkModalFn = isFn(opts.openThemeLinkModal) ? opts.openThemeLinkModal : null;
    this.confirmFn = isFn(opts.confirm) ? opts.confirm : function () { return Promise.resolve(window.confirm ? window.confirm('Wirklich fortfahren?') : true); };
    this.toastFn = isFn(opts.toast) ? opts.toast : noop;
    this.destroyed = false;
    this.uid = genId('tsc-detail-');

    this.state = {
      loading: true, error: null, contact: null,
      categories: [], categoriesLoaded: false,
      blocks: [], blocksLoading: false, blocksError: null,
      editingBlockId: null,   // block.id oder 'new'
      editorCategory: null,   // aktuell in der Combobox gewählte Rubrik
      conflict: null,         // { blockId, pendingBodyHtml, pendingCategoryId, serverBlock, showServer }
      topics: [], topicsLoading: true, topicsError: null,
      assignments: [], assignmentsLoading: true, assignmentsError: null
    };

    this.rootEl = el('div', { class: 'tsc-detail' });
    this.liveEl = el('div', { class: 'tsc-sr-only', 'aria-live': 'polite' });
    this.rootEl.appendChild(this.liveEl);

    this.headErrorEl = el('div', { class: 'tsc-head-error' });
    this.rootEl.appendChild(this.headErrorEl);

    this.section1El = el('section', { class: 'tsc-section', 'aria-label': 'Zusatzinformationen' });
    this.section2El = el('section', { class: 'tsc-section', 'aria-label': 'Notizen' });
    this.section3El = el('section', { class: 'tsc-section', 'aria-label': 'Zugeordnete Topics' });
    this.section4El = el('section', { class: 'tsc-section', 'aria-label': 'Ist zuständig für' });
    this.rootEl.appendChild(this.section1El);
    this.rootEl.appendChild(this.section2El);
    this.rootEl.appendChild(this.section3El);
    this.rootEl.appendChild(this.section4El);

    container.innerHTML = '';
    container.appendChild(this.rootEl);

    this._notesMounted = false;
    this.load();
  }

  ContactDetailInstance.prototype.announce = function (msg) {
    var self = this;
    this.liveEl.textContent = '';
    setTimeout(function () { if (!self.destroyed) self.liveEl.textContent = msg; }, 30);
  };

  ContactDetailInstance.prototype.reportError = function (err) {
    try { this.onError(err); } catch (e) { /* Host-Callback darf nicht werfen */ }
  };

  ContactDetailInstance.prototype.load = function () {
    var self = this;
    this.state.loading = true;
    this.state.error = null;
    this.renderAll();
    Promise.all([
      request('GET', contactUrl(this.contactId)),
      request('GET', categoriesUrl()).catch(function () { return []; }),
      request('GET', infoBlocksUrl(this.contactId)).catch(function () { return []; })
    ]).then(function (results) {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.contact = results[0];
      self.state.categories = Array.isArray(results[1]) ? results[1] : [];
      self.state.categoriesLoaded = true;
      self.state.blocks = Array.isArray(results[2]) ? results[2] : [];
      self.renderAll();
      self.mountNotesIfNeeded();
      self.loadTopics();
      self.loadAssignments();
    }).catch(function (err) {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.error = genericErrorMessage();
      self.reportError(err);
      self.renderAll();
    });
  };

  ContactDetailInstance.prototype.reload = function () {
    return this.load();
  };

  // ---- Abschnitt 1: Zusatzinformationen ------------------------------------

  ContactDetailInstance.prototype.reloadBlocks = function () {
    var self = this;
    this.state.blocksLoading = true;
    this.renderSection1();
    return request('GET', infoBlocksUrl(this.contactId)).then(function (blocks) {
      if (self.destroyed) return;
      self.state.blocks = Array.isArray(blocks) ? blocks : [];
      self.state.blocksLoading = false;
      self.renderSection1();
    }).catch(function (err) {
      if (self.destroyed) return;
      self.state.blocksLoading = false;
      self.state.blocksError = genericErrorMessage();
      self.reportError(err);
      self.renderSection1();
    });
  };

  ContactDetailInstance.prototype.groupBlocksByCategory = function () {
    var groups = [];
    var byId = {};
    this.state.categories.forEach(function (cat) {
      var g = { category: cat, blocks: [] };
      byId[cat.id] = g;
      groups.push(g);
    });
    var orphan = { category: { id: null, label: 'Ohne Rubrik' }, blocks: [] };
    this.state.blocks.forEach(function (b) {
      var g = byId[b.categoryId];
      if (g) g.blocks.push(b);
      else orphan.blocks.push(b);
    });
    if (orphan.blocks.length) groups.push(orphan);
    return groups.filter(function (g) { return g.blocks.length > 0; });
  };

  ContactDetailInstance.prototype.startAddBlock = function () {
    this.state.editingBlockId = 'new';
    this.state.editorCategory = null;
    this.state.conflict = null;
    this.renderSection1();
    var editor = this.section1El.querySelector('[data-role="tsc-block-editor"]');
    if (editor) {
      var input = editor.querySelector('.tsc-combobox-input');
      if (input) input.focus();
    }
  };

  ContactDetailInstance.prototype.startEditBlock = function (blockId) {
    var block = this.state.blocks.filter(function (b) { return b.id === blockId; })[0];
    if (!block) return;
    this.state.editingBlockId = blockId;
    var cat = this.state.categories.filter(function (c) { return c.id === block.categoryId; })[0] || null;
    this.state.editorCategory = cat;
    this.state.conflict = null;
    this.renderSection1();
  };

  ContactDetailInstance.prototype.cancelEditBlock = function () {
    this.state.editingBlockId = null;
    this.state.editorCategory = null;
    this.state.conflict = null;
    this.renderSection1();
  };

  ContactDetailInstance.prototype.ensureCategory = function (selection) {
    // selection: bestehende Rubrik {id,label,...} ODER {id:null,label:'neu'}.
    if (!selection) return Promise.reject(new Error('Keine Rubrik gewählt'));
    if (selection.id) return Promise.resolve(selection);
    var self = this;
    var label = String(selection.label || '').trim();
    if (!label) return Promise.reject(new Error('Rubrikname darf nicht leer sein'));
    // Client-seitige, case-/trim-insensitive Duplikat-Vorprüfung (schnelles
    // Feedback) — der Server bleibt die verbindliche Instanz (409
    // category_exists), falls es zwischenzeitlich zu einem Konflikt kommt.
    var dup = this.state.categories.filter(function (c) { return normLabel(c.label) === normLabel(label); })[0];
    if (dup) return Promise.resolve(dup);
    return request('POST', categoriesUrl(), { label: label }).then(function (cat) {
      self.state.categories.push(cat);
      return cat;
    }).catch(function (err) {
      if (err && err.code === 'category_exists' && err.body && err.body.category) {
        var existing = err.body.category;
        var already = self.state.categories.some(function (c) { return c.id === existing.id; });
        if (!already) self.state.categories.push(existing);
        return existing;
      }
      throw err;
    });
  };

  ContactDetailInstance.prototype.saveBlockEditor = function (editorEl, expectedUpdatedAt) {
    var self = this;
    var isNew = this.state.editingBlockId === 'new';
    var comboHandle = editorEl._comboHandle;
    var selection = comboHandle ? comboHandle.getSelected() : this.state.editorCategory;
    if (!selection) {
      this.toastFn('Bitte eine Rubrik wählen.');
      return;
    }
    var editorId = editorEl.getAttribute('data-editor-id');
    var bodyHtml = this.rt.getRT(editorId) || '';
    var saveBtn = editorEl.querySelector('[data-action="tsc-save-block"]');
    if (saveBtn) saveBtn.disabled = true;

    this.ensureCategory(selection).then(function (cat) {
      var payload = { categoryId: cat.id, bodyHtml: bodyHtml };
      if (!isNew && expectedUpdatedAt !== undefined) payload.expectedUpdatedAt = expectedUpdatedAt;
      var method = isNew ? 'POST' : 'PUT';
      var url = isNew ? infoBlocksUrl(self.contactId) : infoBlockUrl(self.contactId, self.state.editingBlockId);
      return request(method, url, payload);
    }).then(function () {
      if (self.destroyed) return;
      self.state.editingBlockId = null;
      self.state.editorCategory = null;
      self.state.conflict = null;
      self.toastFn(isNew ? 'Infoblock hinzugefügt' : 'Infoblock gespeichert');
      return self.reloadBlocksAndContact();
    }).catch(function (err) {
      if (self.destroyed) return;
      if (err && err.code === 'block_conflict') {
        self.state.conflict = {
          blockId: self.state.editingBlockId,
          pendingBodyHtml: bodyHtml,
          pendingCategoryId: selection.id,
          serverBlock: err.body && err.body.block,
          showServer: false
        };
        self.renderSection1();
        return;
      }
      self.reportError(err);
      var msg = (err && err.code === 'block_limit_reached') ? 'Maximale Anzahl Infoblöcke erreicht.' : genericErrorMessage();
      self.toastFn(msg);
      if (saveBtn) saveBtn.disabled = false;
    });
  };

  ContactDetailInstance.prototype.resolveConflict = function (action) {
    var self = this;
    var conflict = this.state.conflict;
    if (!conflict) return;
    if (action === 'view-server') {
      conflict.showServer = !conflict.showServer;
      this.renderSection1();
      return;
    }
    if (action === 'discard') {
      this.state.editingBlockId = null;
      this.state.editorCategory = null;
      this.state.conflict = null;
      this.reloadBlocksAndContact();
      return;
    }
    if (action === 'save-mine') {
      var newExpected = conflict.serverBlock ? conflict.serverBlock.updatedAt : undefined;
      request('PUT', infoBlockUrl(this.contactId, conflict.blockId), {
        categoryId: conflict.pendingCategoryId, bodyHtml: conflict.pendingBodyHtml, expectedUpdatedAt: newExpected
      }).then(function () {
        if (self.destroyed) return;
        self.state.editingBlockId = null;
        self.state.editorCategory = null;
        self.state.conflict = null;
        self.toastFn('Infoblock gespeichert');
        return self.reloadBlocksAndContact();
      }).catch(function (err) {
        if (self.destroyed) return;
        if (err && err.code === 'block_conflict') {
          conflict.serverBlock = err.body && err.body.block;
          conflict.showServer = false;
          self.renderSection1();
          return;
        }
        self.reportError(err);
        self.toastFn(genericErrorMessage());
      });
    }
  };

  ContactDetailInstance.prototype.reloadBlocksAndContact = function () {
    var self = this;
    return Promise.all([
      request('GET', infoBlocksUrl(this.contactId)),
      request('GET', contactUrl(this.contactId))
    ]).then(function (results) {
      if (self.destroyed) return;
      self.state.blocks = Array.isArray(results[0]) ? results[0] : [];
      self.state.contact = results[1];
      self.renderSection1();
      self.onContactChanged(self.state.contact);
    }).catch(function (err) {
      if (self.destroyed) return;
      self.reportError(err);
      self.renderSection1();
    });
  };

  ContactDetailInstance.prototype.deleteBlock = function (blockId) {
    var self = this;
    Promise.resolve(this.confirmFn({
      title: 'Infoblock löschen',
      message: 'Dieser Infoblock wird endgültig gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.'
    })).then(function (ok) {
      if (!ok || self.destroyed) return;
      return request('DELETE', infoBlockUrl(self.contactId, blockId)).then(function () {
        if (self.destroyed) return;
        self.toastFn('Infoblock gelöscht');
        return self.reloadBlocksAndContact();
      }).catch(function (err) {
        if (self.destroyed) return;
        self.reportError(err);
        self.toastFn(genericErrorMessage());
      });
    });
  };

  ContactDetailInstance.prototype.moveBlock = function (blockId, dir) {
    var self = this;
    var groups = this.groupBlocksByCategory();
    var group = null;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].blocks.some(function (b) { return b.id === blockId; })) { group = groups[i]; break; }
    }
    if (!group) return;
    var idx = group.blocks.map(function (b) { return b.id; }).indexOf(blockId);
    var newIdx = idx + (dir === 'up' ? -1 : 1);
    if (newIdx < 0 || newIdx >= group.blocks.length) return;
    var order = group.blocks.map(function (b) { return b.id; });
    var tmp = order[idx]; order[idx] = order[newIdx]; order[newIdx] = tmp;

    // Optimistisches Reordering lokal, damit die UI sofort reagiert.
    var prevBlocks = this.state.blocks.slice();
    var reindexed = order.map(function (id, i2) {
      var b = self.state.blocks.filter(function (x) { return x.id === id; })[0];
      return b ? Object.assign({}, b, { sortOrder: i2 }) : null;
    }).filter(Boolean);
    this.state.blocks = this.state.blocks.map(function (b) {
      var replacement = reindexed.filter(function (r) { return r.id === b.id; })[0];
      return replacement || b;
    });
    this.renderSection1();
    this.announce('An Position ' + (newIdx + 1) + ' von ' + order.length + ' verschoben.');

    request('PUT', infoBlocksReorderUrl(this.contactId), { categoryId: group.category.id, order: order }).catch(function (err) {
      if (self.destroyed) return;
      self.state.blocks = prevBlocks;
      self.reportError(err);
      self.toastFn(genericErrorMessage());
      self.renderSection1();
    });
  };

  ContactDetailInstance.prototype.renderBlockReadRow = function (block, posInfo) {
    posInfo = posInfo || {};
    var row = el('li', { class: 'tsc-block', 'data-block-id': block.id });
    var body = el('div', { class: 'tsc-block-body rt-display' });
    // bodyHtml kommt laut Vertrag bereits server-seitig sanitisiert an —
    // konsistent zu progress.js (einzige Stelle mit ungeprüft-strukturiertem
    // HTML statt escHtml/textContent).
    body.innerHTML = block.bodyHtml || '';
    row.appendChild(body);

    var actions = el('div', { class: 'tsc-block-actions' });
    var upBtn = el('button', { type: 'button', class: 'tsc-icon-btn tsc-reorder-btn', 'data-action': 'move-up', 'data-block-id': block.id, 'aria-label': 'Infoblock nach oben verschieben', title: 'Nach oben' }, '↑');
    var downBtn = el('button', { type: 'button', class: 'tsc-icon-btn tsc-reorder-btn', 'data-action': 'move-down', 'data-block-id': block.id, 'aria-label': 'Infoblock nach unten verschieben', title: 'Nach unten' }, '↓');
    // Buttons bleiben immer im DOM/Accessibility-Tree (Screenreader-Zugriff),
    // werden am jeweiligen Gruppenende aber deaktiviert (kein Ziel zum
    // Verschieben) statt entfernt — siehe Vertrag NFR-7.
    if (posInfo.isFirst) { upBtn.disabled = true; upBtn.setAttribute('aria-disabled', 'true'); }
    if (posInfo.isLast) { downBtn.disabled = true; downBtn.setAttribute('aria-disabled', 'true'); }
    var editBtn = el('button', { type: 'button', class: 'tsc-icon-btn', 'data-action': 'edit-block', 'data-block-id': block.id, 'aria-label': 'Infoblock bearbeiten', title: 'Bearbeiten' }, '✎');
    var delBtn = el('button', { type: 'button', class: 'tsc-icon-btn', 'data-action': 'delete-block', 'data-block-id': block.id, 'aria-label': 'Infoblock löschen', title: 'Löschen' }, '🗑');
    actions.appendChild(upBtn); actions.appendChild(downBtn); actions.appendChild(editBtn); actions.appendChild(delBtn);
    row.appendChild(actions);
    return row;
  };

  ContactDetailInstance.prototype.renderBlockEditor = function (block, categoryHint) {
    var self = this;
    var isNew = !block;
    var editorId = this.uid + '-editor-' + (isNew ? 'new' : block.id);
    var wrap = el('div', { class: 'tsc-block-editor', 'data-role': 'tsc-block-editor', 'data-editor-id': editorId });

    var conflict = (!isNew && this.state.conflict && this.state.conflict.blockId === block.id) ? this.state.conflict : null;
    if (conflict) {
      var banner = el('div', { class: 'tsc-conflict-banner', role: 'alert' });
      banner.appendChild(el('p', {}, '⚠️ Dieser Infoblock wurde inzwischen von anderer Stelle geändert.'));
      var actionsRow = el('div', { class: 'tsc-conflict-actions' });
      var viewBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary', 'data-action': 'conflict-view' }, 'Anderen Stand ansehen');
      var mineBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-primary', 'data-action': 'conflict-mine' }, 'Meine Version speichern');
      var discardBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary', 'data-action': 'conflict-discard' }, 'Verwerfen und neu laden');
      actionsRow.appendChild(viewBtn); actionsRow.appendChild(mineBtn); actionsRow.appendChild(discardBtn);
      banner.appendChild(actionsRow);
      if (conflict.showServer && conflict.serverBlock) {
        var serverView = el('div', { class: 'tsc-conflict-server rt-display' });
        serverView.innerHTML = conflict.serverBlock.bodyHtml || '';
        banner.appendChild(serverView);
      }
      wrap.appendChild(banner);
    }

    var comboHost = el('div', { class: 'tsc-combobox-host' });
    wrap.appendChild(comboHost);
    var comboHandle = buildCategoryCombobox(comboHost, this.state.categories, categoryHint || null, function (sel) {
      self.state.editorCategory = sel;
    });
    wrap._comboHandle = comboHandle;
    if (categoryHint) this.state.editorCategory = categoryHint;

    var rtWrap = el('div', { class: 'rt-wrapper' });
    rtWrap.appendChild(el('div', { class: 'rt-toolbar', id: editorId + '-tb' }));
    var rtContent = el('div', { class: 'rt-content', id: editorId, contenteditable: 'true', 'data-placeholder': 'Inhalt des Infoblocks …' });
    rtWrap.appendChild(rtContent);
    wrap.appendChild(rtWrap);

    var footer = el('div', { class: 'tsc-block-editor-footer' });
    var cancelBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary', 'data-action': 'cancel-block' }, 'Abbrechen');
    var saveBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-primary', 'data-action': 'tsc-save-block' }, 'Speichern');
    footer.appendChild(cancelBtn); footer.appendChild(saveBtn);
    wrap.appendChild(footer);

    // Initialbefüllung über den Host-Adapter (rt.setRT), NACH dem Einfügen
    // in den zurückgegebenen wrap, damit der Host ggf. Toolbar-Wiring für
    // die neu erzeugte editorId vornehmen kann (siehe Abschlussbericht:
    // offener Punkt für W2 — initRtToolbar() für dynamisch erzeugte
    // Infoblock-Editoren ist nicht Teil des Vertrags-Adapters `rt`).
    // Bei einem Konflikt (409 block_conflict) wird beim Re-Render NICHT der
    // Server-/Ausgangsstand geladen, sondern die eigene, noch ungespeicherte
    // Eingabe (conflict.pendingBodyHtml) — "Editor bleibt mit eigener
    // Eingabe offen" (Vertrag).
    var initialHtml = isNew ? '' : (block.bodyHtml || '');
    if (conflict) initialHtml = conflict.pendingBodyHtml;
    setTimeout(function () {
      self.rt.setRT(editorId, initialHtml);
    }, 0);

    return wrap;
  };

  ContactDetailInstance.prototype.renderSection1 = function () {
    var self = this;
    var root = this.section1El;
    root.innerHTML = '';

    var head = el('div', { class: 'tsc-section-head' });
    head.appendChild(el('h3', { class: 'tsc-section-title' }, 'Zusatzinformationen'));
    var manageLink = el('button', { type: 'button', class: 'tsc-link-btn', 'data-action': 'manage-categories' }, 'Rubriken verwalten');
    head.appendChild(manageLink);
    root.appendChild(head);

    if (this.state.blocksError) {
      renderErrorBox(root, this.state.blocksError, 'Erneut versuchen', function () { self.reloadBlocks(); });
      return;
    }

    if (this.state.blocksLoading && !this.state.blocks.length) {
      root.appendChild(el('p', { class: 'tsc-loading-hint' }, 'Wird geladen …'));
      return;
    }

    var groups = this.groupBlocksByCategory();
    if (!groups.length && this.state.editingBlockId !== 'new') {
      root.appendChild(el('p', { class: 'tsc-empty-hint' }, 'Noch keine Zusatzinformationen erfasst.'));
    } else {
      groups.forEach(function (group) {
        var priv = isPrivateCategory(group.category);
        var list = el('ul', { class: 'tsc-block-list' });
        group.blocks.forEach(function (block, blockIdx) {
          if (self.state.editingBlockId === block.id) {
            var li = el('li', { class: 'tsc-block tsc-block-editing' });
            li.appendChild(self.renderBlockEditor(block, self.state.editorCategory || group.category));
            list.appendChild(li);
          } else {
            list.appendChild(self.renderBlockReadRow(block, { isFirst: blockIdx === 0, isLast: blockIdx === group.blocks.length - 1 }));
          }
        });
        if (priv) {
          var details = el('details', { class: 'tsc-category-group tsc-category-private' });
          var summary = el('summary', { class: 'tsc-category-summary' }, '🔒 Privates (' + group.blocks.length + ')');
          details.appendChild(summary);
          details.appendChild(list);
          root.appendChild(details);
        } else {
          var section = el('div', { class: 'tsc-category-group' });
          section.appendChild(el('div', { class: 'tsc-category-summary' }, escHtml(group.category.label || '')));
          section.appendChild(list);
          root.appendChild(section);
        }
      });
    }

    if (this.state.editingBlockId === 'new') {
      root.appendChild(this.renderBlockEditor(null, this.state.editorCategory));
    } else {
      var addBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary', 'data-action': 'add-block' }, '+ Infoblock hinzufügen');
      root.appendChild(addBtn);
    }
  };

  // ---- Abschnitt 2: Notizen (TSProgress-Wiederverwendung) -------------------

  ContactDetailInstance.prototype.mountNotesIfNeeded = function () {
    if (this._notesMounted || this.destroyed) return;
    var progress = (typeof window !== 'undefined') ? window.TSProgress : null;
    var root = this.section2El;
    root.innerHTML = '';
    root.appendChild(el('h3', { class: 'tsc-section-title' }, 'Notizen'));
    if (!progress || !isFn(progress.mountTimeline) || !isFn(progress.mountInlineComposer)) {
      root.appendChild(el('p', { class: 'tsc-empty-hint' }, 'Notizen sind momentan nicht verfügbar.'));
      return;
    }
    var composerHost = el('div', { class: 'tsc-notes-composer-host' });
    var timelineHost = el('div', { class: 'tsc-notes-timeline-host' });
    root.appendChild(composerHost);
    root.appendChild(timelineHost);

    this._composerHandle = progress.mountInlineComposer(composerHost, {
      refType: 'contact', refId: this.contactId, openOnMount: false
    });
    // showNextStep:false — Kontakte haben kein "Nächster Schritt"-Feld (kein
    // next-step-Endpunkt, result bleibt ''), siehe Erweiterung in
    // public/progress.js (Arbeitspaket W1).
    this._timelineHandle = progress.mountTimeline(timelineHost, {
      refType: 'contact', refId: this.contactId, showNextStep: false
    });
    this._notesMounted = true;
  };

  // ---- Abschnitt 3: Zugeordnete Topics ---------------------------------------

  ContactDetailInstance.prototype.loadTopics = function () {
    var self = this;
    this.state.topicsLoading = true;
    this.state.topicsError = null;
    this.renderSection3();
    // Wiederverwendung des bestehenden, unveränderten Topic-Verknüpfungs-
    // Mechanismus (GET /api/themes liefert je Thema seine links[], siehe
    // Vertrag "bereits bestehend, unverändert") — kein neuer Endpunkt.
    request('GET', themesUrl()).then(function (themes) {
      if (self.destroyed) return;
      var list = [];
      (Array.isArray(themes) ? themes : []).forEach(function (th) {
        (th.links || []).forEach(function (link) {
          if (link.refType === 'contact' && link.refId === self.contactId) {
            list.push({ themeId: th.id, themeTitle: th.title, linkId: link.id });
          }
        });
      });
      self.state.topics = list;
      self.state.topicsLoading = false;
      self.renderSection3();
    }).catch(function (err) {
      if (self.destroyed) return;
      self.state.topicsLoading = false;
      self.state.topicsError = 'Topics konnten nicht geladen werden.';
      self.reportError(err);
      self.renderSection3();
    });
  };

  ContactDetailInstance.prototype.removeTopicLink = function (themeId, linkId) {
    var self = this;
    request('DELETE', themeLinkUrl(themeId, linkId)).then(function () {
      if (self.destroyed) return;
      self.toastFn('Verknüpfung entfernt');
      self.loadTopics();
    }).catch(function (err) {
      if (self.destroyed) return;
      self.reportError(err);
      self.toastFn(genericErrorMessage());
    });
  };

  ContactDetailInstance.prototype.renderSection3 = function () {
    var self = this;
    var root = this.section3El;
    root.innerHTML = '';
    var head = el('div', { class: 'tsc-section-head' });
    head.appendChild(el('h3', { class: 'tsc-section-title' }, 'Zugeordnete Topics'));
    var addBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary', 'data-action': 'assign-topic' }, '🏷️ Topic zuweisen');
    head.appendChild(addBtn);
    root.appendChild(head);

    if (this.state.topicsError) {
      renderErrorBox(root, this.state.topicsError, 'Erneut versuchen', function () { self.loadTopics(); });
      return;
    }
    if (this.state.topicsLoading) {
      root.appendChild(el('p', { class: 'tsc-loading-hint' }, 'Wird geladen …'));
      return;
    }
    if (!this.state.topics.length) {
      root.appendChild(el('p', { class: 'tsc-empty-hint' }, 'Noch keinem Topic zugeordnet.'));
      return;
    }
    var chips = el('div', { class: 'tsc-topic-chips' });
    this.state.topics.forEach(function (t) {
      var chip = el('span', { class: 'tsc-topic-chip' });
      chip.appendChild(el('span', { class: 'tsc-topic-chip-label' }, escHtml(t.themeTitle || '')));
      var rm = el('button', {
        type: 'button', class: 'tsc-chip-remove', 'data-action': 'remove-topic',
        'data-theme-id': t.themeId, 'data-link-id': t.linkId, 'aria-label': 'Verknüpfung zu „' + (t.themeTitle || '') + '" entfernen'
      }, '×');
      chip.appendChild(rm);
      chips.appendChild(chip);
    });
    root.appendChild(chips);
  };

  // ---- Abschnitt 4: Ist zuständig für -----------------------------------------

  ContactDetailInstance.prototype.loadAssignments = function () {
    var self = this;
    this.state.assignmentsLoading = true;
    this.state.assignmentsError = null;
    this.renderSection4();
    request('GET', contactAssignmentsUrl(this.contactId, { limit: 100, offset: 0 })).then(function (items) {
      if (self.destroyed) return;
      self.state.assignments = Array.isArray(items) ? items : [];
      self.state.assignmentsLoading = false;
      self.renderSection4();
    }).catch(function (err) {
      if (self.destroyed) return;
      self.state.assignmentsLoading = false;
      self.state.assignmentsError = 'Zuständigkeiten konnten nicht geladen werden.';
      self.reportError(err);
      self.renderSection4();
    });
  };

  ContactDetailInstance.prototype.removeAssignment = function (refType, refId) {
    var self = this;
    request('DELETE', contactAssignmentDeleteUrl(this.contactId, refType, refId)).then(function () {
      if (self.destroyed) return;
      self.toastFn('Zuordnung entfernt');
      self.loadAssignments();
    }).catch(function (err) {
      if (self.destroyed) return;
      self.reportError(err);
      self.toastFn(genericErrorMessage());
    });
  };

  ContactDetailInstance.prototype.renderSection4 = function () {
    var self = this;
    var root = this.section4El;
    root.innerHTML = '';
    root.appendChild(el('h3', { class: 'tsc-section-title' }, 'Ist zuständig für'));

    if (this.state.assignmentsError) {
      renderErrorBox(root, this.state.assignmentsError, 'Erneut versuchen', function () { self.loadAssignments(); });
      return;
    }
    if (this.state.assignmentsLoading) {
      root.appendChild(el('p', { class: 'tsc-loading-hint' }, 'Wird geladen …'));
      return;
    }
    if (!this.state.assignments.length) {
      root.appendChild(el('p', { class: 'tsc-empty-hint' }, 'Diesem Kontakt ist aktuell kein Vorhaben zugeordnet.'));
      return;
    }
    var list = el('ul', { class: 'tsc-assignment-list' });
    this.state.assignments.forEach(function (item) {
      var li = el('li', { class: 'tsc-assignment-row' + (item.done ? ' tsc-assignment-done' : '') });
      var typeLabel = item.refType === 'topic' ? 'Thema' : 'ToDo';
      var main = el('button', { type: 'button', class: 'tsc-assignment-main', 'data-action': 'nav-assignment', 'data-ref-type': item.refType, 'data-ref-id': item.refId });
      main.appendChild(el('span', { class: 'tsc-badge-type' }, typeLabel));
      main.appendChild(el('span', { class: 'tsc-assignment-title' }, escHtml(item.title || '')));
      if (item.done) main.appendChild(el('span', { class: 'tsc-assignment-status' }, 'erledigt'));
      if (item.refType === 'topic' && item.meetingLabel) {
        main.appendChild(el('span', { class: 'tsc-assignment-meeting' }, escHtml(item.meetingLabel)));
      }
      li.appendChild(main);
      var rm = el('button', {
        type: 'button', class: 'tsc-chip-remove', 'data-action': 'remove-assignment',
        'data-ref-type': item.refType, 'data-ref-id': item.refId,
        'aria-label': 'Zuordnung zu „' + (item.title || '') + '" entfernen'
      }, '×');
      li.appendChild(rm);
      list.appendChild(li);
    });
    root.appendChild(list);
  };

  // ---- Rubrik-Verwaltungsdialog ------------------------------------------

  ContactDetailInstance.prototype.openCategoryManageDialog = function (triggerEl) {
    var self = this;
    openCategoryManageDialogImpl({
      categories: this.state.categories,
      confirm: this.confirmFn,
      toast: this.toastFn,
      restoreFocusEl: triggerEl,
      onChanged: function (categories) {
        self.state.categories = categories;
        self.reloadBlocks();
      }
    });
  };

  // ---- Event-Delegation / Render / Lifecycle -------------------------------

  ContactDetailInstance.prototype.renderAll = function () {
    if (this.destroyed) return;
    if (this.state.loading) {
      this.headErrorEl.innerHTML = '';
      this.section1El.innerHTML = '<p class="tsc-loading-hint">Wird geladen …</p>';
      this.section2El.innerHTML = '';
      this.section3El.innerHTML = '';
      this.section4El.innerHTML = '';
      return;
    }
    if (this.state.error) {
      var self = this;
      renderErrorBox(this.headErrorEl, this.state.error, 'Erneut versuchen', function () { self.load(); });
      this.section1El.innerHTML = '';
      this.section2El.innerHTML = '';
      this.section3El.innerHTML = '';
      this.section4El.innerHTML = '';
      return;
    }
    this.headErrorEl.innerHTML = '';
    this.renderSection1();
    // Abschnitte 2-4 rendern sich über ihre eigenen load*()-Aufrufe.
  };

  ContactDetailInstance.prototype.handleClick = function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!t) return;
    var action = t.getAttribute('data-action');
    if (action === 'add-block') { this.startAddBlock(); return; }
    if (action === 'edit-block') { this.startEditBlock(t.getAttribute('data-block-id')); return; }
    if (action === 'delete-block') { this.deleteBlock(t.getAttribute('data-block-id')); return; }
    if (action === 'cancel-block') { this.cancelEditBlock(); return; }
    if (action === 'tsc-save-block') {
      var editorEl = t.closest('[data-role="tsc-block-editor"]');
      if (editorEl) this.saveBlockEditor(editorEl);
      return;
    }
    if (action === 'move-up') { this.moveBlock(t.getAttribute('data-block-id'), 'up'); return; }
    if (action === 'move-down') { this.moveBlock(t.getAttribute('data-block-id'), 'down'); return; }
    if (action === 'conflict-view') { this.resolveConflict('view-server'); return; }
    if (action === 'conflict-mine') { this.resolveConflict('save-mine'); return; }
    if (action === 'conflict-discard') { this.resolveConflict('discard'); return; }
    if (action === 'manage-categories') { this.openCategoryManageDialog(t); return; }
    if (action === 'assign-topic') {
      if (this.openThemeLinkModalFn) {
        var contact = this.state.contact;
        this.openThemeLinkModalFn({ refType: 'contact', refId: this.contactId, title: contact ? contact.name : '' });
        // Der bestehende Theme-Link-Dialog aktualisiert seinen eigenen
        // Zustand selbst; wir laden nach einer kurzen Verzögerung neu, damit
        // frisch gesetzte Verknüpfungen in Abschnitt 3 sichtbar werden,
        // sobald der Dialog geschlossen wird (kein Vertrags-Callback dafür
        // vorgesehen — siehe Abschlussbericht).
        var self = this;
        this._topicPoll = setInterval(function () {
          if (self.destroyed) { clearInterval(self._topicPoll); return; }
          self.loadTopics();
        }, 1500);
      }
      return;
    }
    if (action === 'remove-topic') {
      this.removeTopicLink(t.getAttribute('data-theme-id'), t.getAttribute('data-link-id'));
      return;
    }
    if (action === 'nav-assignment') {
      this.onNavigate({ refType: t.getAttribute('data-ref-type'), refId: t.getAttribute('data-ref-id') });
      return;
    }
    if (action === 'remove-assignment') {
      this.removeAssignment(t.getAttribute('data-ref-type'), t.getAttribute('data-ref-id'));
      return;
    }
  };

  ContactDetailInstance.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._topicPoll) clearInterval(this._topicPoll);
    this.rootEl.removeEventListener('click', this._onClick);
    if (this._composerHandle) this._composerHandle.destroy();
    if (this._timelineHandle) this._timelineHandle.destroy();
    if (this.container) this.container.innerHTML = '';
  };

  function mountContactDetail(container, opts) {
    if (!hasDom) throw new Error('mountContactDetail benötigt eine DOM-Umgebung');
    opts = opts || {};
    if (!container || typeof container.appendChild !== 'function') {
      return { destroy: noop, reload: function () { return Promise.resolve(); } };
    }
    if (typeof opts.contactId !== 'string' || !opts.contactId) {
      renderErrorBox(container, 'Ungültiger Aufruf: contactId fehlt.', null, null);
      return { destroy: function () { container.innerHTML = ''; }, reload: function () { return Promise.resolve(); } };
    }
    var inst = new ContactDetailInstance(container, opts);
    inst._onClick = inst.handleClick.bind(inst);
    inst.rootEl.addEventListener('click', inst._onClick);
    return {
      destroy: inst.destroy.bind(inst),
      reload: inst.reload.bind(inst)
    };
  }

  // ==========================================================================
  // Rubrik-Verwaltungsdialog (intern, von "Rubriken verwalten" geöffnet)
  // ==========================================================================

  function openCategoryManageDialogImpl(opts) {
    var confirmFn = opts.confirm;
    var toastFn = opts.toast;
    var categories = opts.categories.slice();
    var previousActive = document.activeElement;

    var overlay = el('div', { class: 'tsc-modal-overlay' });
    var dialog = el('div', { class: 'tsc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Rubriken verwalten' });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var closeFn = wireDialogA11y(overlay, dialog, opts.restoreFocusEl || previousActive, function () {
      opts.onChanged(categories);
    });

    function render() {
      dialog.innerHTML = '';
      var head = el('div', { class: 'tsc-modal-head' });
      head.appendChild(el('h3', {}, 'Rubriken verwalten'));
      var closeBtn = el('button', { type: 'button', class: 'tsc-icon-btn', 'aria-label': 'Schließen' }, '×');
      closeBtn.addEventListener('click', closeFn);
      head.appendChild(closeBtn);
      dialog.appendChild(head);

      var body = el('div', { class: 'tsc-modal-body' });
      var list = el('ul', { class: 'tsc-category-manage-list' });
      categories.forEach(function (cat, idx) {
        var li = el('li', { class: 'tsc-category-manage-row' });
        var priv = isPrivateCategory(cat);
        var labelEl = el('span', { class: 'tsc-category-manage-label' }, (priv ? '🔒 ' : '') + escHtml(cat.label || ''));
        li.appendChild(labelEl);

        var renameBtn = el('button', { type: 'button', class: 'tsc-icon-btn', 'aria-label': 'Rubrik „' + (cat.label || '') + '" umbenennen', title: 'Umbenennen' }, '✎');
        renameBtn.addEventListener('click', function () { startRename(li, cat, idx); });
        li.appendChild(renameBtn);

        var deleteBtn = el('button', { type: 'button', class: 'tsc-icon-btn', 'aria-label': 'Rubrik „' + (cat.label || '') + '" löschen', title: 'Löschen' }, '🗑');
        deleteBtn.addEventListener('click', function () { deleteCategory(cat, idx); });
        li.appendChild(deleteBtn);

        list.appendChild(li);
      });
      body.appendChild(list);
      dialog.appendChild(body);

      var focusFirst = dialog.querySelector('.tsc-icon-btn');
      if (focusFirst) focusFirst.focus();
    }

    function startRename(li, cat, idx) {
      li.innerHTML = '';
      var input = el('input', { type: 'text', class: 'tsc-category-rename-input' });
      input.value = cat.label || '';
      var saveBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-primary' }, 'Speichern');
      var cancelBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary' }, 'Abbrechen');
      li.appendChild(input); li.appendChild(saveBtn); li.appendChild(cancelBtn);
      input.focus();
      cancelBtn.addEventListener('click', render);
      saveBtn.addEventListener('click', function () {
        var newLabel = input.value.trim();
        if (!newLabel) return;
        var dupLocal = categories.some(function (c, i2) { return i2 !== idx && normLabel(c.label) === normLabel(newLabel); });
        if (dupLocal) { toastFn('Diese Rubrik existiert bereits.'); return; }
        request('PUT', categoryUrl(cat.id), { label: newLabel }).then(function (updated) {
          categories[idx] = updated;
          render();
        }).catch(function (err) {
          if (err && err.code === 'category_exists') { toastFn('Diese Rubrik existiert bereits.'); return; }
          toastFn(genericErrorMessage());
        });
      });
    }

    function deleteCategory(cat, idx) {
      Promise.resolve(confirmFn({
        title: 'Rubrik löschen',
        message: 'Die Rubrik „' + (cat.label || '') + '" wird endgültig gelöscht.'
      })).then(function (ok) {
        if (!ok) return;
        request('DELETE', categoryUrl(cat.id)).then(function () {
          categories.splice(idx, 1);
          render();
        }).catch(function (err) {
          if (err && err.code === 'category_in_use') {
            var usageCount = err.body && err.body.usageCount;
            var fallbackLabel = err.body && err.body.fallbackLabel;
            Promise.resolve(confirmFn({
              title: 'Rubrik wird verwendet',
              message: 'Diese Rubrik wird bei ' + usageCount + ' Infoblöcken verwendet. Diese werden stattdessen der Rubrik „' + fallbackLabel + '" zugeordnet. Trotzdem löschen?'
            })).then(function (ok2) {
              if (!ok2) return;
              request('DELETE', categoryUrl(cat.id), { force: true }).then(function () {
                categories.splice(idx, 1);
                render();
              }).catch(function () { toastFn(genericErrorMessage()); });
            });
            return;
          }
          toastFn(genericErrorMessage());
        });
      });
    }

    render();
  }

  // ==========================================================================
  // Ansprechpartner-zuordnen-Dialog (openAssignmentPicker)
  // ==========================================================================

  var ASSIGNMENT_MAX = 20;

  function openAssignmentPicker(opts) {
    opts = opts || {};
    if (!hasDom) return;
    var onChanged = isFn(opts.onChanged) ? opts.onChanged : noop;
    var onError = isFn(opts.onError) ? opts.onError : noop;
    var refType = opts.refType, refId = opts.refId;
    var title = opts.title != null ? String(opts.title) : '';
    var allContacts = Array.isArray(opts.contacts) ? opts.contacts : [];
    if (typeof refType !== 'string' || typeof refId !== 'string' || !refId) {
      try { onError(new Error('Ungültiger Aufruf: refType/refId erforderlich.')); } catch (e) { /* noop */ }
      return;
    }

    var previousActive = document.activeElement;
    var state = { search: '', selected: {}, saving: false, loaded: false };

    var overlay = el('div', { class: 'tsc-modal-overlay' });
    var dialog = el('div', { class: 'tsc-modal tsc-assignment-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ansprechpartner zuordnen' });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var closeFn = wireDialogA11y(overlay, dialog, previousActive, noop);

    function selectedCount() {
      var n = 0;
      for (var k in state.selected) if (state.selected[k]) n++;
      return n;
    }

    function filteredContacts() {
      var q = normLabel(state.search);
      if (!q) return allContacts;
      return allContacts.filter(function (c) {
        return normLabel(c.name).indexOf(q) !== -1 || normLabel(c.role).indexOf(q) !== -1;
      });
    }

    function render() {
      dialog.innerHTML = '';
      var head = el('div', { class: 'tsc-modal-head' });
      head.appendChild(el('h3', {}, 'Ansprechpartner zuordnen'));
      dialog.appendChild(head);

      var typeLabel = refType === 'topic' ? 'Thema' : 'Todo';
      dialog.appendChild(el('p', { class: 'tsc-picker-context' }, 'Für „' + title + '" (' + typeLabel + ')'));

      if (!allContacts.length) {
        dialog.appendChild(el('p', { class: 'tsc-empty-hint' }, 'Noch keine Ansprechpartner vorhanden. Lege zuerst einen Ansprechpartner in der Ansicht „Ansprechpartner" an.'));
        var closeOnlyBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-primary' }, 'Schließen');
        closeOnlyBtn.addEventListener('click', closeFn);
        dialog.appendChild(closeOnlyBtn);
        setTimeout(function () { closeOnlyBtn.focus(); }, 0);
        return;
      }

      var searchInput = el('input', { type: 'search', class: 'tsc-picker-search', placeholder: 'Nach Name oder Rolle suchen …', 'aria-label': 'Ansprechpartner suchen' });
      searchInput.value = state.search;
      searchInput.addEventListener('input', function () { state.search = searchInput.value; renderList(); });
      dialog.appendChild(searchInput);

      var listEl = el('ul', { class: 'tsc-picker-list' });
      dialog.appendChild(listEl);

      var footer = el('div', { class: 'tsc-modal-footer' });
      var countEl = el('span', { class: 'tsc-picker-count' });
      var cancelBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-secondary' }, 'Abbrechen');
      var doneBtn = el('button', { type: 'button', class: 'tsc-btn tsc-btn-primary' }, 'Fertig');
      footer.appendChild(countEl); footer.appendChild(cancelBtn); footer.appendChild(doneBtn);
      dialog.appendChild(footer);

      cancelBtn.addEventListener('click', closeFn);
      doneBtn.addEventListener('click', save);

      function renderList() {
        listEl.innerHTML = '';
        var atMax = selectedCount() >= ASSIGNMENT_MAX;
        filteredContacts().forEach(function (c) {
          var isSel = !!state.selected[c.id];
          var li = el('li', { class: 'tsc-picker-row' + (isSel ? ' tsc-picker-row-selected' : '') });
          var cb = el('input', { type: 'checkbox', id: 'tsc-pick-' + c.id });
          cb.checked = isSel;
          if (!isSel && atMax) {
            cb.disabled = true;
            cb.setAttribute('aria-disabled', 'true');
            cb.title = 'Maximal 20 Ansprechpartner pro Vorhaben.';
          }
          cb.addEventListener('change', function () {
            if (cb.checked) state.selected[c.id] = true; else delete state.selected[c.id];
            renderList();
          });
          var label = el('label', { for: 'tsc-pick-' + c.id, class: 'tsc-picker-label' });
          if (isSel) label.appendChild(el('span', { class: 'tsc-picker-check', 'aria-hidden': 'true' }, '✓'));
          label.appendChild(el('span', { class: 'tsc-picker-name' }, escHtml(c.name || '')));
          if (c.role) label.appendChild(el('span', { class: 'tsc-picker-role' }, ' · ' + escHtml(c.role)));
          li.appendChild(cb); li.appendChild(label);
          listEl.appendChild(li);
        });
        countEl.textContent = selectedCount() + ' / ' + ASSIGNMENT_MAX + ' ausgewählt';
      }
      renderList();
      setTimeout(function () { searchInput.focus(); }, 0);
    }

    function save() {
      if (state.saving) return;
      state.saving = true;
      var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
      request('PUT', assignmentsForRefUrl(refType, refId), { contactIds: ids }).then(function () {
        state.saving = false;
        var assigned = allContacts.filter(function (c) { return state.selected[c.id]; });
        try { onChanged(assigned); } catch (e) { /* noop */ }
        closeFn();
      }).catch(function (err) {
        state.saving = false;
        try { onError(err); } catch (e) { /* noop */ }
        toastFallback('Zuordnung konnte nicht gespeichert werden.', opts.toast);
      });
    }

    function toastFallback(msg, toastFn) {
      if (isFn(toastFn)) { toastFn(msg); return; }
      // Kein toast-Adapter im Vertrag von openAssignmentPicker vorgesehen —
      // Dialog bleibt in jedem Fall offen mit erhaltener Auswahl (siehe
      // UX-Vorgabe), das ist die eigentlich sicherheitsrelevante Garantie.
    }

    // Aktuelle Zuordnung vorbelegen (best effort — Fehler blockieren die
    // Nutzung des Dialogs nicht, Auswahl startet dann einfach leer).
    request('GET', assignmentsForRefUrl(refType, refId)).then(function (ids) {
      (Array.isArray(ids) ? ids : []).forEach(function (id) { state.selected[id] = true; });
      state.loaded = true;
      render();
    }).catch(function () {
      state.loaded = true;
      render();
    });

    render();
  }

  // ==========================================================================
  // Öffentliche Schnittstelle
  // ==========================================================================

  var TSContacts = {
    mountContactDetail: mountContactDetail,
    contactBadgesHtml: contactBadgesHtml,
    openAssignmentPicker: openAssignmentPicker,
    assignedContactsHtml: assignedContactsHtml,
    version: '1.0'
  };

  if (typeof window !== 'undefined') {
    window.TSContacts = TSContacts;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      escHtml: escHtml,
      normLabel: normLabel,
      isPrivateCategory: isPrivateCategory,
      contactBadgesHtml: contactBadgesHtml,
      assignedContactsHtml: assignedContactsHtml
    };
  }
})(typeof window !== 'undefined' ? window : this);
