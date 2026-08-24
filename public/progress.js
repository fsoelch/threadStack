/*
 * ThreadStack — Fortschrittsverlauf (Arbeitspaket W1: Platzierung/Konsolidierung
 * des Fortschrittsverlaufs in die Todo-/Themen-Bearbeiten-Ansicht)
 *
 * Exponiert ausschließlich window.TSProgress = {
 *   mountTimeline, mountReentryCard, badgeHtml, compareByProgress,
 *   isUndocumented, formatAbsolute, formatRelative, invalidate,
 *   deriveEntrySource, isEffectivelyEmptyHtml
 * }.
 * Konsumiert window.TSHost (api, toast, escHtml, confirm, reducedMotion) sowie
 * window.TSHost.progress (openGoalDialog, openNextStepDialog, openEntryDialog,
 * confirmDelete, aiReentry, aiEnabled, onProgressChanged) — siehe
 * progress-dev.html für ein lauffähiges Mock dieser Schnittstelle.
 *
 * mountTimeline bettet den Verlauf fest ein (Composer-Slot -> Zielbild ->
 * Nächster Schritt -> Reentry-Slot -> Verlauf), statt ihn in einem separaten
 * Panel zu öffnen. Der Composer selbst (Rich-Text-Eingabe für einen neuen
 * Zwischenstand) lebt als Host-DOM im Konsumenten (W2/index.html) und wird
 * hier nur ortsfest eingehängt — dieses Modul kennt seinen Inhalt nicht.
 *
 * Nur Anzeige-/Lese-Bausteine: Zeitstrahl, Ruhephasen-Marker, Wiedereinstiegs-
 * karte, Badge-Markup, Sortier-Comparator, Datumsformatierung. Erfassen/
 * Bearbeiten/Löschen laufen ausschließlich über TSHost.progress.*.
 *
 * Keine Fremdbibliothek, kein Build-Step.
 */
(function (root) {
  'use strict';

  // ==========================================================================
  // Reine Hilfsfunktionen (auch ohne DOM/Browser nutzbar, node-testbar)
  // ==========================================================================

  var MONTHS_ABBR = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
  var VALID_REF_TYPES = { todo: true, topic: true };

  function isValidRefType(t) { return t === 'todo' || t === 'topic'; }

  function isValidRefId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 200;
  }

  function parseIso(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  /** Deutsches Absolut-Datum, z.B. "14. Aug. 2026". Leerer String bei ungültiger Eingabe. */
  function formatAbsolute(iso) {
    var d = parseIso(iso);
    if (!d) return '';
    return d.getDate() + '. ' + MONTHS_ABBR[d.getMonth()] + ' ' + d.getFullYear();
  }

  /**
   * Textbaustein für eine Dauer in Tagen, z.B. "12 Tage" / "3 Wochen".
   * `dative`=true liefert den Dativ für Anschlüsse wie "vor …" (Tage -> Tagen,
   * Monat(e) -> Monaten, Jahr(e) -> Jahren; "Woche(n)" ist im Dativ Plural
   * identisch zum Nominativ).
   */
  function durationLabel(days, dative) {
    var n = Math.max(0, Math.round(days));
    if (n === 0) return dative ? '0 Tagen' : '0 Tage';
    if (n === 1) return dative ? '1 Tag' : '1 Tag';
    if (n < 14) return n + (dative ? ' Tagen' : ' Tage');
    if (n < 30) {
      var weeks = Math.round(n / 7);
      return weeks <= 1 ? '1 Woche' : weeks + ' Wochen';
    }
    if (n < 365) {
      var months = Math.round(n / 30);
      if (months <= 1) return dative ? '1 Monat' : '1 Monat';
      return months + (dative ? ' Monaten' : ' Monate');
    }
    var years = Math.round(n / 365);
    if (years <= 1) return dative ? '1 Jahr' : '1 Jahr';
    return years + (dative ? ' Jahren' : ' Jahre');
  }

  /**
   * Deutsches Relativ-Datum, z.B. "vor 9 Tagen" / "vor 3 Wochen".
   * `now` ist optional (Default: aktueller Zeitpunkt) und dient ausschließlich
   * der deterministischen Testbarkeit — eine Erweiterung ggü. dem minimalen
   * Vertrag `formatRelative(iso) -> string`, die abwärtskompatibel ist, da
   * Aufrufer, die nur ein Argument übergeben, unverändert funktionieren.
   */
  function formatRelative(iso, now) {
    var d = parseIso(iso);
    if (!d) return '';
    var ref = now instanceof Date ? now : (now ? new Date(now) : new Date());
    if (isNaN(ref.getTime())) ref = new Date();
    var diffMs = ref.getTime() - d.getTime();
    var diffDays = Math.floor(diffMs / 86400000);
    if (diffDays <= 0) return 'heute';
    if (diffDays === 1) return 'gestern';
    return 'vor ' + durationLabel(diffDays, true);
  }

  /**
   * Comparator für Vorhaben-Listen (Todos/Topics) nach Fortschritts-Zeitstand.
   * Identisch zur später in der App implementierten Sortierung — siehe Vertrag.
   */
  function compareByProgress(a, b) {
    var aKey = (a && a.progress && a.progress.orderKey != null) ? a.progress.orderKey : null;
    var bKey = (b && b.progress && b.progress.orderKey != null) ? b.progress.orderKey : null;
    if ((aKey === null) !== (bKey === null)) return aKey === null ? 1 : -1; // ohne Stand ans Ende
    if (aKey === null && bKey === null) return 0; // Aufrufer behält bestehende Standard-Sortierung bei
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0; // älterer Stand (kleineres ISO-Datum) zuerst
  }

  /** true, wenn das Item als "undokumentiert" markiert ist (server-seitiges Flag). */
  function isUndocumented(item) {
    return !!(item && item.progress && item.progress.undocumented === true);
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  /**
   * Markup einer Fortschritts-Badge-Pille. Liefert '' wenn kein Zwischenstand
   * existiert (entryCount===0, fehlendes badgeLabel oder progress===null) —
   * dann darf der Aufrufer gar kein Badge rendern.
   */
  function badgeHtml(progress) {
    if (!progress || typeof progress !== 'object') return '';
    if (!progress.entryCount || progress.entryCount <= 0) return '';
    if (!progress.badgeLabel) return '';
    var stale = progress.badgeEmphasis === 'stale';
    var icon = stale ? '⏳' : '📈';
    var count = progress.entryCount;
    var unit = count === 1 ? 'Zwischenstand' : 'Zwischenstände';
    var rel = progress.lastEntryAt ? formatRelative(progress.lastEntryAt) : '';
    var aria = 'Fortschritt: ' + count + ' ' + unit + (rel ? ', letzter ' + rel : '');
    if (stale) aria += ' — länger nicht aktualisiert';
    var cls = 'progress-badge ' + (stale ? 'progress-badge-stale' : 'progress-badge-normal');
    return '<span class="' + cls + '" aria-label="' + escHtml(aria) + '">' +
      '<span class="progress-badge-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="progress-badge-label">' + escHtml(progress.badgeLabel) + '</span></span>';
  }

  /**
   * Herkunft eines (neuen) Zwischenstands ableiten. 'snooze' GENAU DANN, wenn
   * `snoozedUntil` ein String ist, dessen getrimmter Wert nicht leer ist —
   * alles andere (null/undefined/leer/Nicht-String) ergibt 'manual'.
   */
  function deriveEntrySource(opts) {
    var snoozedUntil = opts && opts.snoozedUntil;
    if (typeof snoozedUntil === 'string' && snoozedUntil.trim() !== '') return 'snooze';
    return 'manual';
  }

  /**
   * true, wenn `html` inhaltlich leer ist (kein sichtbarer Text nach Entfernen
   * aller Tags, Entities zu Leerzeichen aufgelöst und getrimmt) — z.B. '',
   * '<br>', '<div><br></div>', '<p>   </p>', '<p>&nbsp;</p>' oder reine
   * Whitespace-Strings. Rein string-basiert (kein DOM nötig), damit sowohl im
   * Browser als auch in Node-Tests nutzbar.
   */
  function isEffectivelyEmptyHtml(html) {
    if (html == null) return true;
    var s = String(html);
    if (s.trim() === '') return true;
    var text = s
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#160;/gi, ' ')
      .replace(/&#xa0;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length === 0;
  }

  // ---- Wiedereinstiegskarte: Dismiss-Logik (localStorage) ------------------

  function dismissStorageKey(refType, refId) {
    return 'ts.progress.dismiss.' + refType + ':' + refId;
  }

  function getLocalStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    } catch (e) { /* z.B. Private-Mode / Zugriff verweigert — Karte einfach nicht unterdrücken */ }
    return null;
  }

  /**
   * true, wenn die Wiedereinstiegskarte für diese Ruhephase bereits weggeklickt
   * wurde. `storage` ist optional (Default: window.localStorage) und dient
   * ausschließlich der Testbarkeit ohne echten Browser-Storage.
   */
  function isReentryDismissed(refType, refId, dormantSince, storage) {
    if (!dormantSince) return false;
    var s = storage || getLocalStorage();
    if (!s) return false;
    try {
      var val = s.getItem(dismissStorageKey(refType, refId));
      return val != null && val === dormantSince;
    } catch (e) { return false; }
  }

  function setReentryDismissed(refType, refId, dormantSince, storage) {
    if (!dormantSince) return;
    var s = storage || getLocalStorage();
    if (!s) return;
    try { s.setItem(dismissStorageKey(refType, refId), dormantSince); } catch (e) { /* Quota o.ä. — nicht kritisch */ }
  }

  function clearReentryDismissed(refType, refId, storage) {
    var s = storage || getLocalStorage();
    if (!s) return;
    try { s.removeItem(dismissStorageKey(refType, refId)); } catch (e) { /* ignore */ }
  }

  // ==========================================================================
  // Ab hier: DOM-abhängiger Teil (mountTimeline / mountReentryCard / Cache)
  // Wird beim Laden über Node/`require` (Tests) übersprungen, da `window`
  // dort nicht existiert bzw. die Registrierung am Ende geschützt ist.
  // ==========================================================================

  var hasDom = (typeof document !== 'undefined');

  // ---- Shared per-Vorhaben Cache für ProgressDetail-Fetches ----------------
  var detailCache = {}; // "refType:refId" -> Promise<ProgressDetail>

  function cacheKey(refType, refId) { return refType + ':' + refId; }

  function getHost() {
    return (typeof window !== 'undefined') ? window.TSHost : null;
  }

  function detailUrl(refType, refId, cursor) {
    var url = '/api/progress/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId);
    if (cursor) url += '?cursor=' + encodeURIComponent(cursor);
    return url;
  }

  // Der Detail-Endpunkt (detailUrl) wertet nur `limit` aus, keinen `cursor` -
  // Nachladen weiterer Seiten muss den eigenständigen /entries-Endpunkt
  // treffen, sonst liefert der Server wiederholt Seite 1 zurueck (Security
  // Review, Mittel: F5).
  function entriesUrl(refType, refId, cursor) {
    var url = '/api/progress/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId) + '/entries';
    if (cursor) url += '?cursor=' + encodeURIComponent(cursor);
    return url;
  }

  function fetchDetail(refType, refId, force) {
    var k = cacheKey(refType, refId);
    if (!force && detailCache[k]) return detailCache[k];
    var host = getHost();
    if (!host || typeof host.api !== 'function') {
      return Promise.reject(new Error('TSHost.api ist nicht verfügbar'));
    }
    var p = host.api('GET', detailUrl(refType, refId), null).then(function (detail) {
      if (!detail || typeof detail !== 'object') throw new Error('Ungültige Antwort vom Server');
      return detail;
    });
    detailCache[k] = p;
    p.catch(function () { if (detailCache[k] === p) delete detailCache[k]; });
    return p;
  }

  function invalidate(refType, refId) {
    if (!isValidRefType(refType) || !isValidRefId(refId)) return;
    delete detailCache[cacheKey(refType, refId)];
  }

  // ---- Kleine DOM-Helfer -----------------------------------------------------

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

  /** true, wenn `x` ein tatsächliches DOM-Element ist (Validierung von Host-Input). */
  function isElement(x) {
    return !!x && typeof x === 'object' && x.nodeType === 1 && typeof x.parentNode !== 'undefined';
  }

  // `retryAction` ist der data-action-Wert, den der delegierte Klick-Handler
  // der jeweiligen Instanz (TimelineInstance/ReentryInstance) auswertet.
  function renderError(container, message, retryAction) {
    container.innerHTML = '';
    var box = el('div', { class: 'progress-error-box', role: 'alert' });
    box.appendChild(el('p', { class: 'progress-error-text' }, escHtml(message)));
    if (retryAction) {
      box.appendChild(el('button', { type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': retryAction }, 'Erneut versuchen'));
    }
    container.appendChild(box);
  }

  function genericErrorMessage() {
    return 'Das hat leider nicht geklappt. Bitte später erneut versuchen.';
  }

  // ==========================================================================
  // Zeitstrahl (mountTimeline)
  // ==========================================================================

  function TimelineInstance(container, opts) {
    this.container = container;
    this.refType = opts.refType;
    this.refId = opts.refId;
    this.composerSlot = isElement(opts.composerSlot) ? opts.composerSlot : null;
    this.reentrySlot = isElement(opts.reentrySlot) ? opts.reentrySlot : null;
    this.destroyed = false;
    this.state = {
      loading: true,
      error: null,
      entries: [],
      page: { limit: 20, hasMore: false, nextCursor: null },
      goal: '',
      nextStep: '',
      loadingMore: false,
      loadMoreError: null,
      expanded: {}, // entryId -> true
      refExists: true
    };

    // Invariante (Datenverlustschutz): Heimatposition JEDES übergebenen Slots
    // wird erfasst, BEVOR irgendetwas in `container` geschrieben oder der Slot
    // selbst bewegt wird. destroy() hängt beide Slots strikt in dieser
    // Reihenfolge zuerst zurück, bevor der Container geleert wird.
    if (this.composerSlot) {
      this._composerHome = this.composerSlot.parentNode;
      this._composerNext = this.composerSlot.nextSibling;
    }
    if (this.reentrySlot) {
      this._reentryHome = this.reentrySlot.parentNode;
      this._reentryNext = this.reentrySlot.nextSibling;
    }

    this.rootEl = el('div', { class: 'progress-timeline', 'data-progress-timeline': '1' });
    this.announceEl = el('div', { class: 'progress-sr-only', 'aria-live': 'polite' });
    this.rootEl.appendChild(this.announceEl);

    if (this.composerSlot) {
      this.composerHostEl = el('div', { class: 'progress-composer-slot-host' });
      this.composerHostEl.appendChild(this.composerSlot);
      this.rootEl.appendChild(this.composerHostEl);
    }

    // Wird ausschließlich von renderHead() beschrieben.
    this.headEl = el('div', { class: 'progress-section-head' });
    this.rootEl.appendChild(this.headEl);

    if (this.reentrySlot) {
      this.reentryHostEl = el('div', { class: 'progress-reentry-slot-host' });
      this.reentryHostEl.appendChild(this.reentrySlot);
      this.rootEl.appendChild(this.reentryHostEl);
    }

    // Sichtbarkeit wird separat (nicht als Teil von renderHead()/renderBody())
    // per Style-Toggle gesteuert — der Divider selbst ist kein Nachfahre der
    // beiden von render() beschriebenen Container.
    this.dividerEl = el('div', { class: 'progress-section-divider', 'aria-hidden': 'true' });
    this.dividerEl.style.display = 'none';
    this.rootEl.appendChild(this.dividerEl);

    // Wird ausschließlich von renderBody() beschrieben.
    this.listWrapEl = el('div', { class: 'progress-timeline-body' });
    this.rootEl.appendChild(this.listWrapEl);

    container.innerHTML = '';
    container.appendChild(this.rootEl);
    this._onClick = this.handleClick.bind(this);
    this.rootEl.addEventListener('click', this._onClick);
    this.load(false);
  }

  TimelineInstance.prototype.announce = function (msg) {
    this.announceEl.textContent = '';
    var self = this;
    // Re-Trigger, damit Screenreader wiederholte identische Meldungen erneut ansagen.
    setTimeout(function () { if (!self.destroyed) self.announceEl.textContent = msg; }, 30);
  };

  TimelineInstance.prototype.load = function (force) {
    var self = this;
    this.state.loading = true;
    this.state.error = null;
    this.render();
    fetchDetail(this.refType, this.refId, force).then(function (detail) {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.entries = Array.isArray(detail.entries) ? detail.entries : [];
      self.state.page = detail.page || { limit: 20, hasMore: false, nextCursor: null };
      self.state.goal = typeof detail.goal === 'string' ? detail.goal : '';
      self.state.nextStep = typeof detail.nextStep === 'string' ? detail.nextStep : '';
      self.state.refExists = !detail.ref || detail.ref.exists !== false;
      self.state.expanded = {};
      self.render();
    }).catch(function () {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.error = genericErrorMessage();
      self.render();
    });
  };

  TimelineInstance.prototype.loadMore = function () {
    if (this.state.loadingMore || !this.state.page.hasMore) return;
    var self = this;
    var host = getHost();
    if (!host || typeof host.api !== 'function') return;
    this.state.loadingMore = true;
    this.state.loadMoreError = null;
    this.render();
    var priorCursor = this.state.page.nextCursor;
    host.api('GET', entriesUrl(this.refType, this.refId, priorCursor), null).then(function (result) {
      if (self.destroyed) return;
      var newEntries = (result && Array.isArray(result.entries)) ? result.entries : [];
      var nextPage = (result && result.page) || { limit: 20, hasMore: false, nextCursor: null };
      // Defensive: keine Vervielfachung/Endlosschleife, falls der Server
      // trotzdem keinen Fortschritt macht (z.B. bei einem zukünftigen
      // Vertragsbruch wie F5).
      if (newEntries.length === 0 || nextPage.nextCursor === priorCursor) {
        nextPage = { limit: nextPage.limit, hasMore: false, nextCursor: null };
      }
      self.state.entries = self.state.entries.concat(newEntries);
      self.state.page = nextPage;
      self.state.loadingMore = false;
      self.render();
      self.announce(newEntries.length + ' weitere ' + (newEntries.length === 1 ? 'Eintrag' : 'Einträge') + ' geladen');
    }).catch(function () {
      if (self.destroyed) return;
      self.state.loadingMore = false;
      self.state.loadMoreError = genericErrorMessage();
      self.render();
    });
  };

  TimelineInstance.prototype.openEntryDialogFor = function (entryId) {
    var host = getHost();
    if (!host || !host.progress || typeof host.progress.openEntryDialog !== 'function') return;
    // entryId ist jetzt Pflicht (nur noch Bearbeiten, siehe Vertrag) — der
    // frühere "Erfassen ohne entryId"-Fall entfällt.
    if (!entryId) return;
    var entry = this.state.entries.filter(function (e) { return e.id === entryId; })[0] || null;
    if (!entry) return; // z.B. veraltete Id nach zwischenzeitlicher Löschung
    var lastEntry = this.state.entries[0] || null;
    var self = this;
    host.progress.openEntryDialog({
      refType: this.refType,
      refId: this.refId,
      entryId: entry.id,
      source: entry.source,
      prefillHtml: entry.bodyHtml || '',
      goal: this.state.goal || '',
      lastEntryHtml: lastEntry ? (lastEntry.bodyHtml || '') : ''
    }).then(function (result) {
      if (self.destroyed) return;
      if (result === 'saved') {
        self.load(true);
        if (host.progress.onProgressChanged) host.progress.onProgressChanged(self.refType, self.refId);
      }
    }).catch(function () { /* Dialog-Fehler werden vom Host selbst kommuniziert */ });
  };

  TimelineInstance.prototype.openGoalDialogFor = function () {
    var host = getHost();
    if (!host || !host.progress || typeof host.progress.openGoalDialog !== 'function') return;
    var self = this;
    host.progress.openGoalDialog({
      refType: this.refType,
      refId: this.refId,
      goal: this.state.goal || ''
    }).then(function (result) {
      if (self.destroyed) return;
      if (result === 'saved') {
        self.load(true);
        if (host.progress.onProgressChanged) host.progress.onProgressChanged(self.refType, self.refId);
      }
    }).catch(function () { /* Dialog-Fehler werden vom Host selbst kommuniziert */ });
  };

  TimelineInstance.prototype.openNextStepDialogFor = function () {
    var host = getHost();
    if (!host || !host.progress || typeof host.progress.openNextStepDialog !== 'function') return;
    var self = this;
    host.progress.openNextStepDialog({
      refType: this.refType,
      refId: this.refId,
      nextStep: this.state.nextStep || ''
    }).then(function (result) {
      if (self.destroyed) return;
      if (result === 'saved') {
        self.load(true);
        if (host.progress.onProgressChanged) host.progress.onProgressChanged(self.refType, self.refId);
      }
    }).catch(function () { /* Dialog-Fehler werden vom Host selbst kommuniziert */ });
  };

  TimelineInstance.prototype.deleteEntry = function (entryId) {
    var host = getHost();
    if (!host || !host.progress) return;
    var self = this;
    var entry = this.state.entries.filter(function (e) { return e.id === entryId; })[0];
    if (!entry) return;
    var confirmFn = typeof host.progress.confirmDelete === 'function' ? host.progress.confirmDelete : host.confirm;
    Promise.resolve(confirmFn({
      title: 'Zwischenstand löschen',
      message: 'Dieser Zwischenstand wird endgültig gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.'
    })).then(function (ok) {
      if (!ok || self.destroyed) return;
      // Anmerkung (Abweichung/Annahme, siehe Abschlussbericht): Der Vertrag
      // liefert keinen dedizierten Lösch-Endpunkt. Wir verwenden in Analogie
      // zu bestehenden REST-Mustern (z.B. DELETE /api/graph/edges/:id)
      // DELETE /api/progress/entries/:id.
      if (!host.api) return;
      return host.api('DELETE', '/api/progress/entries/' + encodeURIComponent(entryId), null).then(function () {
        if (self.destroyed) return;
        self.load(true);
        if (host.progress.onProgressChanged) host.progress.onProgressChanged(self.refType, self.refId);
        if (host.toast) host.toast('Zwischenstand gelöscht', 'success');
      });
    }).catch(function () {
      if (!self.destroyed && host.toast) host.toast(genericErrorMessage(), 'error');
    });
  };

  TimelineInstance.prototype.handleClick = function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!t) return;
    var action = t.getAttribute('data-action');
    var entryId = t.getAttribute('data-entry-id');
    if (action === 'toggle-more') {
      this.state.expanded[entryId] = !this.state.expanded[entryId];
      this.render();
      // Fokus nach Re-Render auf dem selben Toggle-Button halten (vorhersehbare
      // Tastatur-/Screenreader-Position statt Fokusverlust nach DOM-Ersatz).
      var self = this;
      setTimeout(function () {
        var again = self.rootEl.querySelector('[data-action="toggle-more"][data-entry-id="' + cssEscape(entryId) + '"]');
        if (again) again.focus();
      }, 0);
    } else if (action === 'edit-goal') {
      this.openGoalDialogFor();
    } else if (action === 'edit-nextstep') {
      this.openNextStepDialogFor();
    } else if (action === 'edit-entry') {
      this.openEntryDialogFor(entryId);
    } else if (action === 'delete-entry') {
      this.deleteEntry(entryId);
    } else if (action === 'load-more') {
      this.loadMore();
    } else if (action === 'retry-load-more') {
      this.loadMore();
    } else if (action === 'retry-load') {
      this.load(true);
    }
  };

  function cssEscape(s) {
    return String(s == null ? '' : s).replace(/["\\]/g, '\\$&');
  }

  TimelineInstance.prototype.renderEntryBody = function (entry, expanded) {
    var cls = 'progress-entry-body' + (expanded ? '' : ' progress-entry-body-clamped');
    var wrap = el('div', { class: cls, 'data-progress-clampable': expanded ? '' : '1' });
    // bodyHtml kommt laut Vertrag bereits server-seitig sanitisiert an — dies
    // ist die einzige Stelle im Modul, an der ungeprüft-strukturiertes HTML
    // (statt reinem Text via textContent/escHtml) eingefügt wird.
    wrap.innerHTML = entry.bodyHtml || '';
    return wrap;
  };

  TimelineInstance.prototype.renderEntryEl = function (entry) {
    var self = this;
    var expanded = !!this.state.expanded[entry.id];
    var isResult = entry.kind === 'result';
    var canEdit = entry.editable === true && !isResult;

    var li = el('li', { class: 'progress-entry' + (isResult ? ' progress-entry-result' : ''), 'data-entry-id': entry.id });
    li.appendChild(el('div', { class: 'progress-entry-dot', 'aria-hidden': 'true' }));

    var card = el('div', { class: 'progress-entry-card' });

    var head = el('div', { class: 'progress-entry-head' });
    var dates = el('div', { class: 'progress-entry-dates' });
    dates.appendChild(el('span', { class: 'progress-entry-date-abs' }, escHtml(formatAbsolute(entry.createdAt))));
    dates.appendChild(el('span', { class: 'progress-entry-date-rel' }, escHtml(formatRelative(entry.createdAt))));
    if (entry.editedAt) {
      dates.appendChild(el('span', { class: 'progress-entry-edited' }, 'bearbeitet am ' + escHtml(formatAbsolute(entry.editedAt))));
    }
    head.appendChild(dates);

    if (isResult) {
      head.appendChild(el('span', { class: 'progress-badge-result' }, 'Abschluss aus Stack'));
    } else if (canEdit) {
      var actions = el('div', { class: 'progress-entry-actions' });
      var editBtn = el('button', {
        type: 'button', class: 'progress-icon-btn', 'data-action': 'edit-entry',
        'data-entry-id': entry.id, 'aria-label': 'Zwischenstand bearbeiten', title: 'Bearbeiten'
      }, '<span aria-hidden="true">✎</span>');
      var delBtn = el('button', {
        type: 'button', class: 'progress-icon-btn', 'data-action': 'delete-entry',
        'data-entry-id': entry.id, 'aria-label': 'Zwischenstand löschen', title: 'Löschen'
      }, '<span aria-hidden="true">🗑</span>');
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      head.appendChild(actions);
    }
    card.appendChild(head);

    card.appendChild(this.renderEntryBody(entry, expanded));

    var toggle = el('button', {
      type: 'button', class: 'progress-toggle-btn', 'data-action': 'toggle-more',
      'data-entry-id': entry.id, 'aria-expanded': expanded ? 'true' : 'false'
    }, expanded ? 'Weniger anzeigen' : 'Mehr anzeigen');
    toggle.style.display = 'none'; // wird nach dem Rendern bei tatsächlichem Overflow eingeblendet
    card.appendChild(toggle);

    li.appendChild(card);
    return li;
  };

  TimelineInstance.prototype.renderDormancyMarker = function (entry) {
    var label = durationLabel(entry.gapDaysBefore);
    var li = el('li', { class: 'progress-dormancy-marker' });
    var pill = el('span', {
      class: 'progress-dormancy-pill', role: 'note',
      'aria-label': 'Ruhephase: ' + label + ' ohne Zwischenstand'
    });
    pill.innerHTML = '<span aria-hidden="true">🌙</span> ' + escHtml(label) + ' Pause';
    li.appendChild(pill);
    return li;
  };

  TimelineInstance.prototype.checkOverflow = function () {
    var self = this;
    var bodies = this.rootEl.querySelectorAll('[data-progress-clampable="1"]');
    bodies.forEach ? bodies.forEach(measure) : Array.prototype.forEach.call(bodies, measure);
    function measure(bodyEl) {
      var overflowing = bodyEl.scrollHeight > bodyEl.clientHeight + 1;
      var card = bodyEl.parentElement;
      if (!card) return;
      var toggle = card.querySelector('[data-action="toggle-more"]');
      if (toggle) toggle.style.display = overflowing ? '' : 'none';
    }
  };

  /**
   * Kopfbereich (Zielbild / Nächster Schritt). Beschreibt ausschließlich
   * `.progress-section-head` — rührt Composer-/Reentry-Slot-Hosts nicht an.
   * Texte werden IMMER über textContent gesetzt (nie innerHTML): Zielbild und
   * Nächster Schritt sind Klartextfelder und dürfen nie als HTML interpretiert
   * werden.
   */
  TimelineInstance.prototype.renderHead = function () {
    var head = this.headEl;
    head.innerHTML = '';

    var goalRow = el('div', { class: 'progress-goal-row' });
    goalRow.appendChild(el('span', { class: 'progress-row-label' }, '🎯 Zielbild'));
    var goalText = el('span', { class: 'progress-row-text' });
    var goalBtn = el('button', {
      type: 'button', class: 'progress-icon-btn', 'data-action': 'edit-goal',
      'aria-label': 'Zielbild bearbeiten', title: 'Bearbeiten'
    }, '<span aria-hidden="true">✎</span>');

    var nextRow = el('div', { class: 'progress-nextstep-row' });
    nextRow.appendChild(el('span', { class: 'progress-row-label' }, '➡️ Nächster Schritt'));
    var nextText = el('span', { class: 'progress-row-text' });
    var nextBtn = el('button', {
      type: 'button', class: 'progress-icon-btn', 'data-action': 'edit-nextstep',
      'aria-label': 'Nächsten Schritt bearbeiten', title: 'Bearbeiten'
    }, '<span aria-hidden="true">✎</span>');

    if (this.state.loading) {
      goalText.textContent = 'Zielbild wird geladen …';
      goalText.className = 'progress-row-text progress-row-text-muted';
      goalBtn.disabled = true;
      nextText.textContent = 'Nächster Schritt wird geladen …';
      nextText.className = 'progress-row-text progress-row-text-muted';
      nextBtn.disabled = true;
    } else if (this.state.error) {
      goalText.textContent = 'Zielbild konnte nicht geladen werden.';
      goalText.className = 'progress-row-text progress-row-text-muted';
      goalBtn.disabled = true;
      nextText.textContent = 'Nächster Schritt konnte nicht geladen werden.';
      nextText.className = 'progress-row-text progress-row-text-muted';
      nextBtn.disabled = true;
    } else {
      var goalVal = this.state.goal || '';
      if (goalVal) {
        goalText.textContent = goalVal;
        goalText.className = 'progress-row-text';
      } else {
        goalText.textContent = 'Noch kein Zielbild hinterlegt.';
        goalText.className = 'progress-row-text progress-row-text-empty';
      }
      goalBtn.disabled = false;

      var nextVal = this.state.nextStep || '';
      if (nextVal) {
        nextText.textContent = nextVal;
        nextText.className = 'progress-row-text';
      } else {
        nextText.textContent = 'Noch kein nächster Schritt notiert.';
        nextText.className = 'progress-row-text progress-row-text-empty';
      }
      nextBtn.disabled = false;
    }

    goalRow.appendChild(goalText);
    goalRow.appendChild(goalBtn);
    nextRow.appendChild(nextText);
    nextRow.appendChild(nextBtn);
    head.appendChild(goalRow);
    head.appendChild(nextRow);
  };

  /** Zeitstrahl-Körper. Beschreibt ausschließlich `.progress-timeline-body`. */
  TimelineInstance.prototype.renderBody = function () {
    var wrap = this.listWrapEl;
    wrap.innerHTML = '';

    if (!this.state.refExists) {
      wrap.appendChild(el('p', { class: 'progress-empty-hint' }, 'Dieses Vorhaben ist nicht mehr verfügbar.'));
      return;
    }

    if (this.state.loading && !this.state.entries.length) {
      wrap.appendChild(el('p', { class: 'progress-loading-hint' }, 'Wird geladen…'));
      return;
    }

    if (this.state.error) {
      renderError(wrap, this.state.error, 'retry-load');
      return;
    }

    if (!this.state.entries.length) {
      // Kein CTA-Button mehr (siehe Vertrag): der Composer steht permanent
      // sichtbar direkt oberhalb dieses Bereichs — ein zweiter Erfassungsweg
      // wäre redundant.
      wrap.appendChild(el('p', { class: 'progress-empty-hint' }, 'Noch kein Zwischenstand erfasst — trag oben deinen ersten ein.'));
      return;
    }

    var list = el('ul', { class: 'progress-timeline-list' });
    for (var i = 0; i < this.state.entries.length; i++) {
      var entry = this.state.entries[i];
      if (entry && entry.showDormancyMarker && entry.gapDaysBefore != null && entry.gapDaysBefore > 0) {
        list.appendChild(this.renderDormancyMarker(entry));
      }
      list.appendChild(this.renderEntryEl(entry));
    }
    wrap.appendChild(list);

    var footer = el('div', { class: 'progress-timeline-footer' });
    if (this.state.page && this.state.page.hasMore) {
      var moreBtn = el('button', {
        type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': 'load-more', 'aria-busy': this.state.loadingMore ? 'true' : 'false'
      }, this.state.loadingMore ? 'Wird geladen…' : 'Weitere laden');
      moreBtn.disabled = !!this.state.loadingMore;
      footer.appendChild(moreBtn);
      if (this.state.loadMoreError) {
        footer.appendChild(el('p', { class: 'progress-error-text' }, escHtml(this.state.loadMoreError)));
        var retry = el('button', { type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': 'retry-load-more' }, 'Erneut versuchen');
        footer.appendChild(retry);
      }
    }
    wrap.appendChild(footer);
  };

  // Divider ist kein Nachfahre von head/body und wird daher außerhalb von
  // renderHead()/renderBody() separat sichtbar/unsichtbar geschaltet.
  TimelineInstance.prototype.updateDividerVisibility = function () {
    var wrap = this.listWrapEl;
    var hasContent = !!(wrap && wrap.textContent && wrap.textContent.trim().length > 0);
    this.dividerEl.style.display = hasContent ? '' : 'none';
  };

  TimelineInstance.prototype.render = function () {
    if (this.destroyed) return;
    // Invariante: render() beschreibt ausschließlich .progress-section-head
    // und .progress-timeline-body — die Slot-Hosts (Composer/Reentry) und ihr
    // Inhalt werden hier in KEINEM Zustand angefasst.
    this.renderHead();
    this.renderBody();
    this.updateDividerVisibility();

    var self = this;
    var raf = (typeof window !== 'undefined' && window.requestAnimationFrame) ? window.requestAnimationFrame : function (fn) { setTimeout(fn, 0); };
    raf(function () { if (!self.destroyed) self.checkOverflow(); });
  };

  TimelineInstance.prototype.getGoal = function () { return this.state.goal || ''; };
  TimelineInstance.prototype.getNextStep = function () { return this.state.nextStep || ''; };

  TimelineInstance.prototype.reload = function () { this.load(true); };
  TimelineInstance.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rootEl.removeEventListener('click', this._onClick);
    // Invariante: beide Slots werden ZUERST an ihre Heimatposition
    // zurückgehängt, DANACH erst wird der Container geleert — sonst würden
    // sie beim innerHTML-Reset mit zerstört.
    if (this.composerSlot && this._composerHome) {
      this._composerHome.insertBefore(this.composerSlot, this._composerNext || null);
    }
    if (this.reentrySlot && this._reentryHome) {
      this._reentryHome.insertBefore(this.reentrySlot, this._reentryNext || null);
    }
    if (this.container) this.container.innerHTML = '';
  };

  function mountTimeline(container, opts) {
    if (!hasDom) throw new Error('mountTimeline benötigt eine DOM-Umgebung');
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('mountTimeline: container (Element) erforderlich');
    }
    opts = opts || {};
    if (!isValidRefType(opts.refType) || !isValidRefId(opts.refId)) {
      renderError(container, 'Ungültiger Aufruf: refType/refId fehlen oder sind ungültig.', null);
      return {
        reload: function () {},
        destroy: function () { container.innerHTML = ''; },
        getGoal: function () { return ''; },
        getNextStep: function () { return ''; }
      };
    }
    var inst = new TimelineInstance(container, opts);
    return {
      reload: inst.reload.bind(inst),
      destroy: inst.destroy.bind(inst),
      getGoal: inst.getGoal.bind(inst),
      getNextStep: inst.getNextStep.bind(inst)
    };
  }

  // ==========================================================================
  // Wiedereinstiegskarte (mountReentryCard)
  // ==========================================================================

  function ReentryInstance(container, opts) {
    this.container = container;
    this.refType = opts.refType;
    this.refId = opts.refId;
    this.onRequestCompose = (typeof opts.onRequestCompose === 'function') ? opts.onRequestCompose : null;
    this.destroyed = false;
    this.state = { loading: true, error: null, detail: null, aiLoading: false, aiError: null, aiText: null };
    this.rootEl = el('div', { class: 'progress-reentry-wrap' });
    container.innerHTML = '';
    container.appendChild(this.rootEl);
    this._onClick = this.handleClick.bind(this);
    this.rootEl.addEventListener('click', this._onClick);
    this._announced = false;
    this.load(false);
  }

  ReentryInstance.prototype.load = function (force) {
    var self = this;
    this.state.loading = true;
    this.state.error = null;
    fetchDetail(this.refType, this.refId, force).then(function (detail) {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.detail = detail;
      self.render();
    }).catch(function () {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.error = genericErrorMessage();
      self.render();
    });
  };

  ReentryInstance.prototype.handleClick = function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!t) return;
    var action = t.getAttribute('data-action');
    if (action === 'dismiss-reentry') {
      var reentry = this.state.detail && this.state.detail.reentry;
      if (reentry && reentry.dormantSince) {
        setReentryDismissed(this.refType, this.refId, reentry.dormantSince);
      }
      this.render(true);
    } else if (action === 'reentry-primary-cta') {
      // Kein Dialog mehr: ausschließlich der vom Host übergebene Callback
      // (siehe Vertrag) — die frühere interne openEntryDialog-Aufrufstelle
      // dieser Instanz ist ersatzlos entfallen.
      if (this.onRequestCompose) this.onRequestCompose();
    } else if (action === 'reentry-ai') {
      this.loadAi();
    } else if (action === 'retry-load') {
      this.load(true);
    }
  };

  ReentryInstance.prototype.loadAi = function () {
    var host = getHost();
    var reentry = this.state.detail && this.state.detail.reentry;
    if (!host || !host.progress || typeof host.progress.aiReentry !== 'function') return;
    if (!reentry || !reentry.ai || !reentry.ai.frameId) return;
    var self = this;
    this.state.aiLoading = true;
    this.state.aiError = null;
    this.render();
    host.progress.aiReentry(reentry.ai.frameId).then(function (text) {
      if (self.destroyed) return;
      self.state.aiLoading = false;
      self.state.aiText = typeof text === 'string' ? text : '';
      self.render();
    }).catch(function () {
      if (self.destroyed) return;
      self.state.aiLoading = false;
      self.state.aiError = genericErrorMessage();
      self.render();
    });
  };

  ReentryInstance.prototype.render = function (skipDismissCheck) {
    if (this.destroyed) return;
    var wrap = this.rootEl;
    wrap.innerHTML = '';

    if (this.state.loading) return; // stiller Ladezustand, kein Layout-Sprung für eine reine Zusatzkarte
    if (this.state.error) {
      renderError(wrap, this.state.error, 'retry-load');
      return;
    }

    var detail = this.state.detail || {};
    var reentry = detail.reentry;
    if (!reentry || !reentry.show) return;

    if (!skipDismissCheck && isReentryDismissed(this.refType, this.refId, reentry.dormantSince)) return;

    var host2 = getHost();
    var aiEnabled = !!(host2 && host2.progress && typeof host2.progress.aiEnabled === 'function' && host2.progress.aiEnabled());
    var aiAvailable = aiEnabled && reentry.ai && reentry.ai.available === true;

    var card = el('div', { class: 'progress-reentry-card', role: 'region', 'aria-label': 'Wiedereinstieg' });
    var accent = el('div', { class: 'progress-reentry-accent', 'aria-hidden': 'true' });
    card.appendChild(accent);
    var body = el('div', { class: 'progress-reentry-body' });

    var head = el('div', { class: 'progress-reentry-head' });
    head.appendChild(el('span', { class: 'progress-reentry-title' }, '<span aria-hidden="true">🌙</span> ruht seit ' + escHtml(reentry.dormantLabel || '')));
    var dismissBtn = el('button', { type: 'button', class: 'progress-reentry-dismiss', 'data-action': 'dismiss-reentry', 'aria-label': 'Wiedereinstiegskarte ausblenden' }, '×');
    head.appendChild(dismissBtn);
    body.appendChild(head);

    if (reentry.empty === true) {
      body.appendChild(el('p', { class: 'progress-reentry-hint' }, 'Für dieses Vorhaben liegen noch kein Zielbild und keine Zwischenstände vor.'));
      if (this.onRequestCompose) {
        var cta0 = el('button', { type: 'button', class: 'progress-btn progress-btn-primary', 'data-action': 'reentry-primary-cta' }, '+ Zwischenstand erfassen');
        body.appendChild(cta0);
      }
    } else {
      if (detail.goal) {
        var goalEl = el('blockquote', { class: 'progress-reentry-goal' });
        goalEl.textContent = detail.goal;
        body.appendChild(goalEl);
      }
      var lastEntry = detail.entries && detail.entries[0];
      if (lastEntry) {
        var lastWrap = el('div', { class: 'progress-reentry-last' });
        var lastMeta = el('div', { class: 'progress-reentry-last-meta' }, escHtml(formatAbsolute(lastEntry.createdAt)) + ' · ' + escHtml(formatRelative(lastEntry.createdAt)));
        lastWrap.appendChild(lastMeta);
        var lastBody = el('div', { class: 'progress-reentry-last-body' });
        lastBody.innerHTML = lastEntry.bodyHtml || ''; // server-seitig sanitisiert, siehe Vertrag
        lastWrap.appendChild(lastBody);
        body.appendChild(lastWrap);
      }
      var nextStepText = detail.nextStep;
      var nextWrap = el('div', { class: 'progress-reentry-next' });
      nextWrap.appendChild(el('span', { class: 'progress-reentry-next-label' }, 'Nächster Schritt'));
      var nextVal = el('span', { class: 'progress-reentry-next-value' });
      nextVal.textContent = nextStepText || 'Noch kein nächster Schritt hinterlegt.';
      nextWrap.appendChild(nextVal);
      body.appendChild(nextWrap);

      if (aiAvailable) {
        if (this.state.aiText != null) {
          var aiBox = el('div', { class: 'progress-reentry-ai-result' });
          aiBox.textContent = this.state.aiText;
          body.appendChild(aiBox);
        } else {
          var aiBtn = el('button', {
            type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': 'reentry-ai', 'aria-busy': this.state.aiLoading ? 'true' : 'false'
          }, this.state.aiLoading ? 'KI denkt nach…' : '🤖 KI-Zusammenfassung');
          aiBtn.disabled = !!this.state.aiLoading;
          body.appendChild(aiBtn);
          if (this.state.aiError) body.appendChild(el('p', { class: 'progress-error-text' }, escHtml(this.state.aiError)));
        }
      }

      if (this.onRequestCompose) {
        var ctaWrap = el('div', { class: 'progress-reentry-cta-row' });
        ctaWrap.appendChild(el('button', { type: 'button', class: 'progress-btn progress-btn-primary', 'data-action': 'reentry-primary-cta' }, '+ Zwischenstand erfassen'));
        body.appendChild(ctaWrap);
      }
    }

    card.appendChild(body);
    var liveEl = el('div', { class: 'progress-sr-only', 'aria-live': 'polite' });
    wrap.appendChild(liveEl);
    wrap.appendChild(card);

    if (!this._announced) {
      this._announced = true;
      var summary = 'Wiedereinstieg: ruht seit ' + (reentry.dormantLabel || '') + '.';
      setTimeout(function () { liveEl.textContent = summary; }, 30);
    }
  };

  ReentryInstance.prototype.reload = function () { this._announced = false; this.load(true); };
  ReentryInstance.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rootEl.removeEventListener('click', this._onClick);
    // Leert nur den Inhalt des übergebenen Containers, nicht den Container-
    // Knoten selbst — der Container gehört dem Host (bei Nutzung als
    // reentrySlot von mountTimeline wird er von dessen destroy() an seine
    // Heimatposition zurückgehängt, siehe dort).
    if (this.container) this.container.innerHTML = '';
  };

  function mountReentryCard(container, opts) {
    if (!hasDom) throw new Error('mountReentryCard benötigt eine DOM-Umgebung');
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('mountReentryCard: container (Element) erforderlich');
    }
    opts = opts || {};
    if (!isValidRefType(opts.refType) || !isValidRefId(opts.refId)) {
      container.innerHTML = '';
      return { reload: function () {}, destroy: function () { container.innerHTML = ''; } };
    }
    var inst = new ReentryInstance(container, opts);
    return { reload: inst.reload.bind(inst), destroy: inst.destroy.bind(inst) };
  }

  // ==========================================================================
  // Öffentliche Schnittstelle
  // ==========================================================================

  var TSProgress = {
    mountTimeline: mountTimeline,
    mountReentryCard: mountReentryCard,
    badgeHtml: badgeHtml,
    compareByProgress: compareByProgress,
    isUndocumented: isUndocumented,
    formatAbsolute: formatAbsolute,
    formatRelative: formatRelative,
    invalidate: invalidate,
    deriveEntrySource: deriveEntrySource,
    isEffectivelyEmptyHtml: isEffectivelyEmptyHtml
  };

  if (typeof window !== 'undefined') {
    window.TSProgress = TSProgress;
  }

  // Reine Hilfsfunktionen für node-basierte Unit-Tests (siehe
  // test/progress_web_helpers.test.js) — ohne DOM/Browser nutzbar.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      compareByProgress: compareByProgress,
      isUndocumented: isUndocumented,
      badgeHtml: badgeHtml,
      formatAbsolute: formatAbsolute,
      formatRelative: formatRelative,
      durationLabel: durationLabel,
      isReentryDismissed: isReentryDismissed,
      setReentryDismissed: setReentryDismissed,
      clearReentryDismissed: clearReentryDismissed,
      dismissStorageKey: dismissStorageKey,
      isValidRefType: isValidRefType,
      isValidRefId: isValidRefId,
      escHtml: escHtml,
      deriveEntrySource: deriveEntrySource,
      isEffectivelyEmptyHtml: isEffectivelyEmptyHtml
    };
  }
})(typeof window !== 'undefined' ? window : this);
