/*
 * ThreadStack — Fortschrittsverlauf (Arbeitspaket W1, erweitert im Redesign
 * "Übersichtlichere Todos und Tasks" um Story 3/6/7/8)
 *
 * Exponiert ausschließlich window.TSProgress = {
 *   mountTimeline, mountReentryCard, badgeHtml, compareByProgress,
 *   isUndocumented, formatAbsolute, formatRelative, invalidate,
 *   deriveEntrySource, isEffectivelyEmptyHtml, progressLineHtml,
 *   mountInlineComposer, mountCardSummary, pollSummaries
 * }.
 * Konsumiert window.TSHost (api, toast, escHtml, confirm, reducedMotion,
 * openObject) sowie window.TSHost.progress (openNextStepDialog,
 * openEntryDialog, confirmDelete, aiReentry, aiEnabled, onProgressChanged,
 * aiSummaryEnabled, regenerateSummary) — siehe progress-dev.html für ein
 * lauffähiges Mock dieser Schnittstelle. `openGoalDialog` entfällt (Redesign:
 * das Zielbild wurde entfernt, das Ziel ergibt sich aus der Beschreibung).
 *
 * mountTimeline bettet den Verlauf fest ein (Composer-Slot -> Nächster
 * Schritt -> Reentry-Slot -> Verlauf), statt ihn in einem separaten Panel zu
 * öffnen. Der Composer selbst (Rich-Text-Eingabe für einen neuen
 * Zwischenstand) lebt als Host-DOM im Konsumenten (W2/index.html) und wird
 * hier nur ortsfest eingehängt — dieses Modul kennt seinen Inhalt nicht.
 * `progressLineHtml`/`mountInlineComposer`/`mountCardSummary` sind eigenständige
 * Bausteine für die Übersichtskarte (kompakte Fortschrittszeile, Inline-
 * Zwischenstand-Erfassung, KI-Zusammenfassung) und unabhängig von mountTimeline.
 *
 * Anzeige-/Lese-Bausteine: Zeitstrahl, Ruhephasen-Marker, Wiedereinstiegskarte,
 * Badge-Markup, Sortier-Comparator, Datumsformatierung, KI-Zusammenfassungs-
 * Anzeige. Bearbeiten/Löschen bestehender Einträge laufen weiterhin
 * ausschließlich über TSHost.progress.*; das Erfassen NEUER Zwischenstände
 * kann zusätzlich direkt über mountInlineComposer erfolgen (kein zweiter
 * Zustands-/Idempotenzmechanismus - eigener clientToken pro Instanz).
 *
 * Keine Fremdbibliothek, kein Build-Step.
 */
(function (root) {
  'use strict';

  // ==========================================================================
  // Reine Hilfsfunktionen (auch ohne DOM/Browser nutzbar, node-testbar)
  // ==========================================================================

  var MONTHS_ABBR = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
  // 'contact' (Arbeitspaket W1, Ansprechpartner-Erweiterung): Kontakte nutzen
  // denselben Zwischenstand-Mechanismus für ihre chronologischen Notizen wie
  // Todos/Topics, haben aber keinen "Nächster Schritt" (siehe showNextStep in
  // TimelineInstance) und keinen next-step-Endpunkt server-seitig.
  var VALID_REF_TYPES = { todo: true, topic: true, contact: true };

  function isValidRefType(t) {
    return typeof t === 'string' && Object.prototype.hasOwnProperty.call(VALID_REF_TYPES, t);
  }

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
    // "Stale" wird über Icon UND Text erkennbar - Farbe ist nie alleiniger
    // Bedeutungsträger (Redesign "Übersichtlichere Todos und Tasks").
    var suffixHtml = progress.badgeSuffix
      ? ' <span class="progress-badge-suffix">· ' + escHtml(progress.badgeSuffix) + '</span>'
      : '';
    return '<span class="' + cls + '" aria-label="' + escHtml(aria) + '">' +
      '<span class="progress-badge-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="progress-badge-label">' + escHtml(progress.badgeLabel) + '</span>' + suffixHtml + '</span>';
  }

  /**
   * Einzeilige, kompakte Fortschrittsanzeige für Übersichtskarten (Story 3).
   * Anders als badgeHtml() liefert diese Funktion IMMER Markup, auch ohne
   * Zwischenstand (neutraler Leerzustand statt gar keiner Anzeige). "Veraltet"
   * wird über Icon UND Text erkennbar, nie nur über Farbe.
   */
  function progressLineHtml(progress) {
    var hasEntries = progress && typeof progress === 'object' && progress.entryCount > 0 && progress.badgeLabel;
    if (!hasEntries) {
      return '<span class="progress-line progress-line-empty">' +
        '<span class="progress-line-icon" aria-hidden="true">◌</span>' +
        '<span class="progress-line-label">Noch kein Zwischenstand</span></span>';
    }
    var stale = progress.badgeEmphasis === 'stale';
    var icon = stale ? '⏳' : '📈';
    var suffix = progress.badgeSuffix ? ' · ' + progress.badgeSuffix : '';
    var aria = progress.badgeLabel + suffix;
    var cls = 'progress-line ' + (stale ? 'progress-line-stale' : 'progress-line-normal');
    return '<span class="' + cls + '" aria-label="' + escHtml(aria) + '">' +
      '<span class="progress-line-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="progress-line-label">' + escHtml(progress.badgeLabel) + escHtml(suffix) + '</span></span>';
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

  function detailUrl(refType, refId, cursor, limit) {
    var url = '/api/progress/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId);
    var params = [];
    if (limit && limit > 0) params.push('limit=' + encodeURIComponent(limit));
    if (cursor) params.push('cursor=' + encodeURIComponent(cursor));
    if (params.length) url += '?' + params.join('&');
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

  function fetchDetail(refType, refId, force, limit) {
    var k = cacheKey(refType, refId) + (limit ? ':' + limit : '');
    if (!force && detailCache[k]) return detailCache[k];
    var host = getHost();
    if (!host || typeof host.api !== 'function') {
      return Promise.reject(new Error('TSHost.api ist nicht verfügbar'));
    }
    var p = host.api('GET', detailUrl(refType, refId, null, limit), null).then(function (detail) {
      if (!detail || typeof detail !== 'object') throw new Error('Ungültige Antwort vom Server');
      return detail;
    });
    detailCache[k] = p;
    p.catch(function () { if (detailCache[k] === p) delete detailCache[k]; });
    return p;
  }

  function invalidate(refType, refId) {
    if (!isValidRefType(refType) || !isValidRefId(refId)) return;
    var prefix = cacheKey(refType, refId);
    for (var k in detailCache) {
      if (Object.prototype.hasOwnProperty.call(detailCache, k) && (k === prefix || k.indexOf(prefix + ':') === 0)) {
        delete detailCache[k];
      }
    }
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
    // Redesign "Übersichtlichere Todos und Tasks": ersetzt das entfallene
    // Zielbild als Kontextzeile im Zwischenstand-Dialog (siehe openEntryDialogFor).
    this.descriptionHtml = typeof opts.descriptionHtml === 'string' ? opts.descriptionHtml : '';
    // Arbeitspaket W1 (Ansprechpartner-Erweiterung): Kontakte haben keinen
    // "Nächster Schritt" (kein next-step-Endpunkt, result bleibt ''). Ohne
    // explizite Angabe leitet sich showNextStep aus refType ab (nur
    // 'contact' unterdrückt die Kopfzeile) — bestehende Aufrufer für
    // todo/topic, die diese Option nicht kennen, sind unverändert.
    this.showNextStep = (typeof opts.showNextStep === 'boolean') ? opts.showNextStep : (this.refType !== 'contact');
    this.destroyed = false;
    this.state = {
      loading: true,
      error: null,
      entries: [],
      page: { limit: opts.limit && opts.limit > 0 ? opts.limit : 20, hasMore: false, nextCursor: null },
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
    fetchDetail(this.refType, this.refId, force, this.state.page.limit).then(function (detail) {
      if (self.destroyed) return;
      self.state.loading = false;
      self.state.entries = Array.isArray(detail.entries) ? detail.entries : [];
      self.state.page = detail.page || { limit: self.state.page.limit, hasMore: false, nextCursor: null };
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
      descriptionHtml: this.descriptionHtml || '',
      lastEntryHtml: lastEntry ? (lastEntry.bodyHtml || '') : ''
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
   * Kopfbereich (Nächster Schritt). Beschreibt ausschließlich
   * `.progress-section-head` — rührt Composer-/Reentry-Slot-Hosts nicht an.
   * Texte werden IMMER über textContent gesetzt (nie innerHTML): "Nächster
   * Schritt" ist ein Klartextfeld und darf nie als HTML interpretiert werden.
   * Redesign "Übersichtlichere Todos und Tasks": das Zielbild entfällt hier
   * ersatzlos (ergibt sich aus der Beschreibung, die außerhalb dieses Moduls
   * angezeigt wird).
   */
  TimelineInstance.prototype.renderHead = function () {
    var head = this.headEl;
    head.innerHTML = '';

    // Arbeitspaket W1 (Ansprechpartner-Erweiterung): Kontakte (und jeder
    // andere Aufrufer mit showNextStep:false) haben keine "Nächster
    // Schritt"-Kopfzeile — der Kopfbereich bleibt dann schlicht leer,
    // renderBody()/der Verlauf darunter ist davon unberührt.
    if (!this.showNextStep) return;

    var nextRow = el('div', { class: 'progress-nextstep-row' });
    nextRow.appendChild(el('span', { class: 'progress-row-label' }, '➡️ Nächster Schritt'));
    var nextText = el('span', { class: 'progress-row-text' });
    var nextBtn = el('button', {
      type: 'button', class: 'progress-icon-btn', 'data-action': 'edit-nextstep',
      'aria-label': 'Nächsten Schritt bearbeiten', title: 'Bearbeiten'
    }, '<span aria-hidden="true">✎</span>');

    if (this.state.loading) {
      nextText.textContent = 'Nächster Schritt wird geladen …';
      nextText.className = 'progress-row-text progress-row-text-muted';
      nextBtn.disabled = true;
    } else if (this.state.error) {
      nextText.textContent = 'Nächster Schritt konnte nicht geladen werden.';
      nextText.className = 'progress-row-text progress-row-text-muted';
      nextBtn.disabled = true;
    } else {
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

    nextRow.appendChild(nextText);
    nextRow.appendChild(nextBtn);
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
        getNextStep: function () { return ''; }
      };
    }
    var inst = new TimelineInstance(container, opts);
    return {
      reload: inst.reload.bind(inst),
      destroy: inst.destroy.bind(inst),
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
      body.appendChild(el('p', { class: 'progress-reentry-hint' }, 'Für dieses Vorhaben liegen noch keine Zwischenstände vor.'));
      if (this.onRequestCompose) {
        var cta0 = el('button', { type: 'button', class: 'progress-btn progress-btn-primary', 'data-action': 'reentry-primary-cta' }, '+ Zwischenstand erfassen');
        body.appendChild(cta0);
      }
    } else {
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
  // Inline-Zwischenstand-Composer für die Übersichtskarte (Story 6)
  // ==========================================================================

  var MAX_ENTRY_TEXT = 5000;

  function genClientToken() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function entriesPostUrl(refType, refId) {
    return '/api/progress/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId) + '/entries';
  }

  function ComposerInstance(container, opts) {
    this.container = container;
    this.refType = opts.refType;
    this.refId = opts.refId;
    this.snoozedUntil = opts.snoozedUntil || null;
    this.done = !!opts.done;
    this.onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : function () {};
    this.onError = typeof opts.onError === 'function' ? opts.onError : function () {};
    this.destroyed = false;
    // `openOnMount`: ueberspringt den sonst noetigen ersten Klick auf den
    // 💬-Trigger und zeigt das Textfeld direkt beim Einhaengen (siehe
    // `mountCardComposer`/`mountTodoProgressArea` in public/app.js — das
    // Einhaengen selbst ist dort bereits die bewusste Nutzer-Aktion
    // "Zwischenstand erfassen", ein zusaetzlicher Klick auf einen
    // Zwischen-Trigger waere redundant). Default `false` erhaelt das
    // bisherige Verhalten fuer verbleibende Einhaenge-Stellen (z.B.
    // Themen-/Topic-Bearbeiten-Ansicht) unveraendert.
    this.open = !!opts.openOnMount;
    this.text = '';
    this.saving = false;
    this.errorMsg = null;
    this.clientToken = genClientToken();
    this.rootEl = el('div', { class: 'progress-inline-composer' });
    container.innerHTML = '';
    container.appendChild(this.rootEl);
    this._onClick = this.handleClick.bind(this);
    this.rootEl.addEventListener('click', this._onClick);
    this._onInput = this.handleInput.bind(this);
    this.render();
    if (this.open) {
      var ta = this.rootEl.querySelector('[data-role="composer-text"]');
      if (ta) ta.focus();
    }
  }

  ComposerInstance.prototype.handleInput = function (ev) {
    if (ev.target && ev.target.matches && ev.target.matches('[data-role="composer-text"]')) {
      this.text = ev.target.value;
      this.errorMsg = null;
      this.updateCounter();
    }
  };

  ComposerInstance.prototype.updateCounter = function () {
    var counter = this.rootEl.querySelector('[data-role="composer-counter"]');
    if (!counter) return;
    var len = this.text.length;
    counter.textContent = len + ' / ' + MAX_ENTRY_TEXT + ' Zeichen';
    counter.className = 'progress-composer-counter' + (len > MAX_ENTRY_TEXT ? ' progress-composer-counter-over' : '');
  };

  ComposerInstance.prototype.handleClick = function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!t) return;
    var action = t.getAttribute('data-action');
    if (action === 'open-composer') {
      this.open = true;
      this.render();
      var ta = this.rootEl.querySelector('[data-role="composer-text"]');
      if (ta) ta.focus();
    } else if (action === 'cancel-composer') {
      this.open = false;
      this.errorMsg = null;
      this.render();
    } else if (action === 'save-composer') {
      this.save();
    }
  };

  ComposerInstance.prototype.save = function () {
    if (this.saving) return;
    var host = getHost();
    var plain = this.text.replace(/\s+/g, ' ').trim();
    if (!plain) {
      this.errorMsg = 'Bitte gib einen Text ein.';
      this.render();
      return;
    }
    if (this.text.length > MAX_ENTRY_TEXT) {
      this.errorMsg = 'Dein Zwischenstand ist zu lang (mehr als ' + MAX_ENTRY_TEXT + ' Zeichen). Bitte kürze ihn.';
      this.render();
      return;
    }
    if (!host || typeof host.api !== 'function') {
      this.errorMsg = 'Keine Verbindung zum Server. Deine Eingabe bleibt erhalten.';
      this.render();
      return;
    }
    this.saving = true;
    this.errorMsg = null;
    this.render();
    var self = this;
    var source = deriveEntrySource({ snoozedUntil: this.snoozedUntil });
    var bodyHtml = '<p>' + escHtml(this.text).replace(/\n/g, '<br>') + '</p>';
    host.api('POST', entriesPostUrl(this.refType, this.refId), {
      body: bodyHtml, source: source, clientToken: this.clientToken
    }).then(function (result) {
      if (self.destroyed) return;
      self.saving = false;
      self.open = false;
      self.text = '';
      self.clientToken = genClientToken();
      invalidate(self.refType, self.refId);
      self.render();
      self.onSaved(result);
    }).catch(function (err) {
      if (self.destroyed) return;
      self.saving = false;
      self.errorMsg = self.mapError(err);
      self.render();
      self.onError(err);
    });
  };

  ComposerInstance.prototype.mapError = function (err) {
    var status = err && err.status;
    var code = err && err.code;
    if (status === 429 || code === 'rate_limited') return 'Zu viele Änderungen. Bitte kurz warten.';
    if (status === 404 || code === 'ref_not_found') {
      if (this.refType === 'topic') return 'Dieses Thema wurde inzwischen gelöscht.';
      if (this.refType === 'contact') return 'Dieser Ansprechpartner wurde inzwischen gelöscht.';
      return 'Dieses Todo wurde inzwischen gelöscht.';
    }
    if (status === 409 && code === 'ARCHIVED_READONLY') return 'Dieses Meeting ist archiviert. Zum Bearbeiten bitte wiederherstellen.';
    if (status === 409 && code === 'ref_done') return 'Dieses Vorhaben ist bereits erledigt.';
    if (status == null) return 'Keine Verbindung zum Server. Deine Eingabe bleibt erhalten.';
    return genericErrorMessage();
  };

  ComposerInstance.prototype.render = function () {
    if (this.destroyed) return;
    var root = this.rootEl;
    root.removeEventListener('input', this._onInput);
    root.innerHTML = '';

    if (this.done) return; // Erledigte Todos bieten keine Zwischenstand-Erfassung an.

    if (!this.open) {
      var trigger = el('button', {
        type: 'button', class: 'progress-icon-btn', 'data-action': 'open-composer',
        'aria-label': 'Zwischenstand erfassen', title: 'Zwischenstand erfassen'
      }, '<span aria-hidden="true">💬</span>');
      root.appendChild(trigger);
      return;
    }

    var box = el('div', { class: 'progress-composer-box' });

    var snoozedFuture = typeof this.snoozedUntil === 'string' && this.snoozedUntil && new Date(this.snoozedUntil).getTime() > Date.now();
    if (snoozedFuture) {
      box.appendChild(el('p', { class: 'progress-composer-snooze-hint' }, 'Wird beim Speichern als Zwischenstand zu deiner Ruhephase geführt, weil du „Schlafen bis" gesetzt hast.'));
    }

    var ta = document.createElement('textarea');
    ta.className = 'progress-composer-textarea';
    ta.setAttribute('data-role', 'composer-text');
    ta.setAttribute('placeholder', 'Was hat sich getan?');
    ta.setAttribute('rows', '3');
    ta.value = this.text;
    ta.disabled = this.saving;
    box.appendChild(ta);

    var footer = el('div', { class: 'progress-composer-footer' });
    footer.appendChild(el('span', { class: 'progress-composer-counter', 'data-role': 'composer-counter' }, this.text.length + ' / ' + MAX_ENTRY_TEXT + ' Zeichen'));
    var actions = el('div', { class: 'progress-composer-actions' });
    actions.appendChild(el('button', { type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': 'cancel-composer' }, 'Abbrechen'));
    var saveBtn = el('button', {
      type: 'button', class: 'progress-btn progress-btn-primary', 'data-action': 'save-composer', 'aria-busy': this.saving ? 'true' : 'false'
    }, this.saving ? 'Speichert …' : 'Speichern');
    saveBtn.disabled = this.saving;
    actions.appendChild(saveBtn);
    footer.appendChild(actions);
    box.appendChild(footer);

    if (this.errorMsg) {
      box.appendChild(el('p', { class: 'progress-error-text', role: 'alert' }, escHtml(this.errorMsg)));
    }

    root.appendChild(box);
    root.addEventListener('input', this._onInput);
    this.updateCounter();
  };

  ComposerInstance.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rootEl.removeEventListener('click', this._onClick);
    this.rootEl.removeEventListener('input', this._onInput);
    if (this.container) this.container.innerHTML = '';
  };

  function mountInlineComposer(container, opts) {
    if (!hasDom) throw new Error('mountInlineComposer benötigt eine DOM-Umgebung');
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('mountInlineComposer: container (Element) erforderlich');
    }
    opts = opts || {};
    if (!isValidRefType(opts.refType) || !isValidRefId(opts.refId)) {
      container.innerHTML = '';
      return { destroy: function () { container.innerHTML = ''; } };
    }
    var inst = new ComposerInstance(container, opts);
    return { destroy: inst.destroy.bind(inst) };
  }

  // ==========================================================================
  // KI-Zusammenfassung auf der Übersichtskarte (Story 7/8)
  // ==========================================================================

  var SUMMARY_KIND_LABEL = { progress: 'KI-Zusammenfassung', description: 'KI-Kurzfassung' };

  function summaryRegenerateUrl(kind, refType, refId, confirmed) {
    var url = '/api/summaries/' + encodeURIComponent(kind) + '/' + encodeURIComponent(refType) + '/' + encodeURIComponent(refId) + '/regenerate';
    return confirmed ? url + '?confirm=true' : url;
  }

  function SummaryCardInstance(container, opts) {
    this.container = container;
    this.refType = opts.refType;
    this.refId = opts.refId;
    this.kind = opts.kind;
    this.onRegenerate = typeof opts.onRegenerate === 'function' ? opts.onRegenerate : null;
    this.destroyed = false;
    this.regenerating = false;
    this.setSummary(opts.summary);
  }

  SummaryCardInstance.prototype.setSummary = function (summary) {
    this.summary = summary && typeof summary === 'object' ? summary : { status: 'not_applicable' };
    this.render();
  };

  // `confirmed` defaultet auf false: der Hintergrund-Job prüft die
  // Kostenschwelle bei jedem automatischen Lauf mit confirmed:false. Ein
  // hier fest verdrahtetes confirm=true würde diese Prüfung für JEDEN
  // manuellen "Erneut versuchen"-Klick unbemerkt umgehen (Security Review,
  // Mittel, A04). Erst der dedizierte "Trotzdem erstellen"-Button (siehe
  // render(), Status confirmation_required) ruft mit confirmed:true auf.
  SummaryCardInstance.prototype.regenerate = function (confirmed) {
    if (this.regenerating) return;
    var host = getHost();
    var self = this;
    this.regenerating = true;
    this.render();
    var p;
    if (host && host.progress && typeof host.progress.regenerateSummary === 'function') {
      p = host.progress.regenerateSummary(this.kind, this.refType, this.refId, !!confirmed);
    } else if (host && typeof host.api === 'function') {
      p = host.api('POST', summaryRegenerateUrl(this.kind, this.refType, this.refId, !!confirmed), null);
    } else {
      p = Promise.reject(new Error('kein Host verfügbar'));
    }
    Promise.resolve(p).then(function () {
      if (self.destroyed) return;
      self.regenerating = false;
      self.summary = { status: 'pending', text: self.summary.text || null, generatedAt: null, model: null, errorCode: null };
      self.render();
      if (self.onRegenerate) self.onRegenerate(self.kind, self.refType, self.refId);
    }).catch(function () {
      if (self.destroyed) return;
      self.regenerating = false;
      self.render();
    });
  };

  SummaryCardInstance.prototype.render = function () {
    if (this.destroyed) return;
    var root = this.container;
    root.innerHTML = '';
    var status = this.summary && this.summary.status;

    // disabled/not_applicable/unbekannter Status: nichts rendern (keine leere Fläche).
    if (status === 'disabled' || status === 'not_applicable' || !status) return;

    var box = el('div', { class: 'progress-summary-box progress-summary-' + status });
    var head = el('div', { class: 'progress-summary-head' });
    head.appendChild(el('span', { class: 'progress-summary-icon', 'aria-hidden': 'true' }, '✨'));
    head.appendChild(el('span', { class: 'progress-summary-label' }, SUMMARY_KIND_LABEL[this.kind] || 'KI-Zusammenfassung'));
    box.appendChild(head);

    if (status === 'pending' && !this.summary.text) {
      box.appendChild(el('p', { class: 'progress-summary-loading' }, 'Wird erstellt …'));
    } else if (status === 'error' && this.summary.errorCode === 'confirmation_required') {
      // Eigener Zustand statt eines generischen Fehlers: ein einfacher
      // "Erneut versuchen"-Klick darf die Kostenbestätigung nicht unbemerkt
      // mit confirm=true umgehen (Security Review, Mittel, A04).
      box.appendChild(el('p', { class: 'progress-summary-loading' }, 'Diese Zusammenfassung überschreitet dein Kosten-Limit für automatische Erstellung.'));
      var confirmBtn = el('button', {
        type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': 'confirm-summary',
        'aria-busy': this.regenerating ? 'true' : 'false'
      }, 'Trotzdem jetzt erstellen');
      confirmBtn.disabled = this.regenerating;
      box.appendChild(confirmBtn);
    } else if (status === 'error') {
      box.appendChild(el('p', { class: 'progress-error-text' }, 'Zusammenfassung momentan nicht verfügbar.'));
      var retryBtn = el('button', {
        type: 'button', class: 'progress-btn progress-btn-secondary', 'data-action': 'retry-summary',
        'aria-busy': this.regenerating ? 'true' : 'false'
      }, 'Erneut versuchen');
      retryBtn.disabled = this.regenerating;
      box.appendChild(retryBtn);
    } else if (this.summary.text) {
      var textEl = el('p', { class: 'progress-summary-text' });
      textEl.textContent = this.summary.text;
      box.appendChild(textEl);
      if (status === 'stale') {
        box.appendChild(el('p', { class: 'progress-summary-stale-hint', 'aria-live': 'polite' }, 'Wird aktualisiert …'));
      }
      if (this.kind === 'progress') {
        var link = el('button', { type: 'button', class: 'progress-link-btn', 'data-action': 'open-timeline' }, 'Alle Zwischenstände ansehen');
        box.appendChild(link);
      }
    }

    root.appendChild(box);

    var self = this;
    root.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!t) return;
      var action = t.getAttribute('data-action');
      if (action === 'retry-summary') self.regenerate(false);
      else if (action === 'confirm-summary') self.regenerate(true);
      else if (action === 'open-timeline') {
        var host = getHost();
        if (host && typeof host.openObject === 'function') host.openObject(self.refType, self.refId, { focus: 'progress' });
      }
    }, { once: true });
  };

  SummaryCardInstance.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.container) this.container.innerHTML = '';
  };

  function mountCardSummary(container, opts) {
    if (!hasDom) throw new Error('mountCardSummary benötigt eine DOM-Umgebung');
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('mountCardSummary: container (Element) erforderlich');
    }
    opts = opts || {};
    if (!isValidRefType(opts.refType) || !isValidRefId(opts.refId) || (opts.kind !== 'progress' && opts.kind !== 'description')) {
      container.innerHTML = '';
      return { destroy: function () { container.innerHTML = ''; }, update: function () {} };
    }
    var inst = new SummaryCardInstance(container, opts);
    return {
      destroy: inst.destroy.bind(inst),
      update: inst.setSummary.bind(inst)
    };
  }

  // ==========================================================================
  // Polling auf fertige KI-Zusammenfassungen (Story 7/8)
  // ==========================================================================

  var SUMMARY_POLL_INTERVAL_MS = 2000;
  var SUMMARY_POLL_MAX_ATTEMPTS = 10;

  function summariesUrl(refs) {
    return '/api/summaries?refs=' + encodeURIComponent(refs.join(','));
  }

  function anyPending(map) {
    var pending = false;
    map.forEach(function (pair) {
      if (pair && ((pair.progress && pair.progress.status === 'pending') || (pair.description && pair.description.status === 'pending'))) {
        pending = true;
      }
    });
    return pending;
  }

  /**
   * Fragt GET /api/summaries für die übergebenen refs ab und wiederholt dies
   * alle 2000ms bis zu 10 Mal, solange mindestens ein Ergebnis noch "pending"
   * ist. Löst IMMER auf (nie ab), auch nach Erschöpfen der Versuche - der
   * letzte bekannte Stand wird zurückgegeben.
   * @param {string[]} refs z.B. ["todo:abc","topic:def"]
   * @returns {Promise<Map<string,{progress,description}>>}
   */
  function pollSummaries(refs) {
    var list = Array.isArray(refs) ? refs.filter(function (r) { return typeof r === 'string' && r; }) : [];
    if (!list.length) return Promise.resolve(new Map());
    var host = getHost();
    if (!host || typeof host.api !== 'function') return Promise.resolve(new Map());

    function attempt(n) {
      return host.api('GET', summariesUrl(list), null).then(function (res) {
        var map = new Map();
        var summaries = (res && res.summaries) || {};
        for (var key in summaries) {
          if (Object.prototype.hasOwnProperty.call(summaries, key)) map.set(key, summaries[key]);
        }
        if (n >= SUMMARY_POLL_MAX_ATTEMPTS || !anyPending(map)) return map;
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(attempt(n + 1)); }, SUMMARY_POLL_INTERVAL_MS);
        });
      }).catch(function () { return new Map(); });
    }
    return attempt(1);
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
    isEffectivelyEmptyHtml: isEffectivelyEmptyHtml,
    progressLineHtml: progressLineHtml,
    mountInlineComposer: mountInlineComposer,
    mountCardSummary: mountCardSummary,
    pollSummaries: pollSummaries
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
      isEffectivelyEmptyHtml: isEffectivelyEmptyHtml,
      progressLineHtml: progressLineHtml
    };
  }
})(typeof window !== 'undefined' ? window : this);
