/*
 * ThreadStack — Sichtbarer Fortschritt (Arbeitspaket M3, Web-Fachlogik)
 *
 * Exponiert ausschließlich window.TSMomentum = {
 *   utcOffsetMinutes, mount, fetchStreakBadge, showCompletionToast
 * }.
 * Konsumiert window.TSHost (api, toast, escHtml) - siehe public/progress.js
 * für das identische Integrationsmuster. Kein eigener TSHost.momentum-
 * Namespace nötig: alle Dialoge (Einstellungen, Pausentage) sind
 * selbstständige Markup-Bausteine dieses Moduls, keine Host-Callbacks.
 *
 * `mount(el)` rendert die komplette "Fortschritt"-Ansicht (Serie, Wochen-
 * Rückblick-Karte, Einstellungen inkl. Pausentage-Verwaltung) inkl.
 * Leer-/Fehlerzustand. `fetchStreakBadge()` liefert nur die aktuelle
 * Serien-Zahl (oder null) für die Sidebar-Navigation, die vom
 * Integrationspaket (M4) inline in den Nav-Item-String gerendert wird.
 * `showCompletionToast(momentum)` zeigt den
 * Erledigt-Moment-Toast (Wochenzähler bzw. deutlicherer Meilenstein-Text)
 * an - wird vom Integrationspaket (M4) direkt nach einer erfolgreichen
 * PUT /todos/:id bzw. PUT /meetings/:mid/topics/:tid mit `done`-Änderung
 * aufgerufen, unter Weitergabe von `response.momentum`.
 *
 * Keine Fremdbibliothek, kein Build-Step.
 */
(function (root) {
  'use strict';

  function host() {
    if (!root.TSHost) throw new Error('TSMomentum: TSHost ist nicht verfügbar');
    return root.TSHost;
  }

  // Client-UTC-Offset in Minuten (z.B. Berlin im Sommer: -120). Wird bei
  // JEDER Anfrage frisch berechnet, NIE zwischengespeichert - siehe
  // Architektur-Vertrag (Zeitzonenwechsel/Reisen).
  function utcOffsetMinutes() {
    return -new Date().getTimezoneOffset();
  }

  function esc(s) {
    return host().escHtml(s == null ? '' : String(s));
  }

  // ── Erledigt-Moment-Toast ────────────────────────────────────
  function showCompletionToast(momentum) {
    if (!momentum) return;
    const h = host();
    const milestones = Array.isArray(momentum.milestones) ? momentum.milestones : [];
    if (milestones.length === 0) {
      h.toast(`Erledigt · diese Woche: ${Number(momentum.weeklyCompletedCount) || 0}`);
      return;
    }
    // Deutlicherer Meilenstein-Text (Story 2/3) - eine Bestätigung pro
    // Meilenstein, damit bei mehreren betroffenen Kontakten keine
    // Informationen verloren gehen.
    for (const m of milestones) {
      const label = m.type === 'topic'
        ? `Thema „${esc(m.name)}" ist jetzt komplett abgeschlossen`
        : `Bei „${esc(m.name)}" ist jetzt alles erledigt`;
      h.toast(`🎉 ${label}`, 'success');
    }
  }

  // ── Datenzugriff ─────────────────────────────────────────────
  function fetchOverview() {
    return host().api('GET', `/momentum/overview?utcOffsetMinutes=${utcOffsetMinutes()}`);
  }
  function fetchPauseDays() {
    return host().api('GET', '/momentum/pause-days');
  }
  function saveSettings(patch) {
    return host().api('PUT', '/momentum/settings', patch);
  }
  function addPauseDay(dateStr) {
    return host().api('POST', `/momentum/pause-days?utcOffsetMinutes=${utcOffsetMinutes()}`, { date: dateStr });
  }
  function removePauseDay(dateStr) {
    return host().api('DELETE', `/momentum/pause-days/${encodeURIComponent(dateStr)}`);
  }

  // ── Sidebar-Badge (Serie) ────────────────────────────────────
  // Liefert nur die Rohzahl (oder null, wenn Serie deaktiviert/0/Fehler) -
  // der Aufrufer (M4, app.js) rendert sie selbst inline in den ohnehin bei
  // jedem render() komplett neu aufgebauten Nav-Item-String (analog zum
  // bestehenden "pill pill-open"-Muster), statt eines dauerhaft gemounteten
  // DOM-Knotens, der von diesem Neuaufbau sonst sofort wieder überschrieben
  // würde.
  async function fetchStreakBadge() {
    try {
      const overview = await fetchOverview();
      const current = overview.streak && overview.streak.current;
      return current > 0 ? current : null;
    } catch (_) {
      return null;
    }
  }

  // ── Hauptansicht ─────────────────────────────────────────────
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Rein informativ fuers <input type=date max=...> - die verbindliche
  // Pruefung des 90-Tage-Planungshorizonts (Requirements-Freigabe) liegt
  // serverseitig in lib/momentum/queries.js#addPauseDay.
  function maxPauseDateStr() {
    const d = new Date();
    d.setDate(d.getDate() + 90);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function renderStreakCard(streak) {
    if (!streak) return '';
    const hint = streak.activeToday
      ? 'Heute schon aktiv gewesen.'
      : 'Heute noch keine Aktivität - die Serie bleibt bis Tagesende erhalten.';
    return `
      <div class="momentum-card momentum-streak">
        <h2>Tages-Serie</h2>
        <div class="momentum-streak-value" aria-live="polite">🔥 ${streak.current} ${streak.current === 1 ? 'Tag' : 'Tage'}</div>
        <div class="momentum-streak-hint">${esc(hint)}</div>
      </div>`;
  }

  function renderWeekCard(week) {
    if (!week) return '';
    const milestones = Array.isArray(week.milestones) ? week.milestones : [];
    const milestoneHtml = milestones.length
      ? `<ul class="momentum-milestone-list">${milestones.map((m) => `<li>✓ ${m.type === 'topic' ? 'Thema' : 'Kontakt'} „${esc(m.name)}" abgeschlossen</li>`).join('')}</ul>`
      : `<p class="momentum-week-empty">Diese Woche noch keine vollständig abgeschlossenen Themen/Kontakte.</p>`;
    return `
      <div class="momentum-card momentum-week">
        <h2>Diese Woche</h2>
        <div class="momentum-week-stats">
          <div class="momentum-week-stat"><dt>Neu erfasst</dt><dd>${Number(week.createdCount) || 0}</dd></div>
          <div class="momentum-week-stat"><dt>Erledigt</dt><dd>${Number(week.completedCount) || 0}</dd></div>
        </div>
        ${milestoneHtml}
      </div>`;
  }

  function renderPauseDaysList(pauseDays) {
    if (!pauseDays.length) return `<p class="momentum-week-empty">Keine Pausentage geplant.</p>`;
    return `<ul class="momentum-pause-list">${pauseDays.map((d) => `
      <li class="momentum-pause-chip">
        ${esc(d)}
        <button type="button" data-momentum-remove-pause="${esc(d)}" aria-label="Pausentag ${esc(d)} entfernen">×</button>
      </li>`).join('')}</ul>`;
  }

  function renderSettings(settings, pauseDays) {
    return `
      <div class="momentum-settings">
        <h2>Einstellungen</h2>
        <label class="momentum-toggle-row">
          <input type="checkbox" data-momentum-setting="completionToastEnabled" ${settings.completionToastEnabled ? 'checked' : ''}>
          Erledigt-Moment anzeigen
        </label>
        <label class="momentum-toggle-row">
          <input type="checkbox" data-momentum-setting="streakEnabled" ${settings.streakEnabled ? 'checked' : ''}>
          Tages-Serie anzeigen
        </label>
        <label class="momentum-toggle-row">
          <input type="checkbox" data-momentum-setting="weeklyReviewEnabled" ${settings.weeklyReviewEnabled ? 'checked' : ''}>
          Wochen-Rückblick anzeigen
        </label>
        <div class="momentum-pause-days">
          <h3>Pausentage (unterbrechen die Serie nicht)</h3>
          <form class="momentum-pause-form" data-momentum-pause-form>
            <input type="date" name="date" min="${esc(todayStr())}" max="${esc(maxPauseDateStr())}" required aria-label="Datum für Pausentag">
            <button type="submit" class="btn btn-secondary btn-sm">Als Pause markieren</button>
          </form>
          <div data-momentum-pause-list>${renderPauseDaysList(pauseDays)}</div>
        </div>
      </div>`;
  }

  function renderEmptyState() {
    return `
      <div class="momentum-empty">
        <p>Der Fortschritt-Bereich ist deaktiviert.</p>
        <p>Aktiviere mindestens einen Baustein in den Einstellungen unten, um wieder Zahlen zu sehen.</p>
      </div>`;
  }

  function mount(el) {
    if (!el) throw new Error('TSMomentum.mount: Zielelement erforderlich');
    let destroyed = false;
    let state = { settings: null, streak: null, week: null, pauseDays: [] };

    function renderError(err) {
      el.innerHTML = `
        <div class="momentum-view">
          <div class="momentum-error">
            <p>⚠ Fortschrittsdaten konnten nicht geladen werden.</p>
            <button type="button" class="btn btn-secondary momentum-retry-btn" data-momentum-retry>Erneut laden</button>
          </div>
        </div>`;
      el.querySelector('[data-momentum-retry]')?.addEventListener('click', () => reload());
      if (err) { /* Fehlerdetails bewusst nicht an den Nutzer, nur an die Konsole (kein internes Detail wie Stacktrace/Pfad im UI) */ console.error('[momentum]', err); }
    }

    function renderView() {
      const { settings, streak, week, pauseDays } = state;
      const cardsHtml = (streak || week)
        ? `<div class="momentum-cards">${renderStreakCard(streak)}${renderWeekCard(week)}</div>`
        : renderEmptyState();
      el.innerHTML = `
        <div class="momentum-view">
          ${cardsHtml}
          ${renderSettings(settings, pauseDays)}
        </div>`;
      wireEvents();
    }

    function wireEvents() {
      el.querySelectorAll('[data-momentum-setting]').forEach((input) => {
        input.addEventListener('change', async () => {
          const field = input.getAttribute('data-momentum-setting');
          const prev = !input.checked;
          try {
            state.settings = await saveSettings({ [field]: input.checked });
            await reload();
          } catch (e) {
            input.checked = prev;
            host().toast(e.message || 'Einstellung konnte nicht gespeichert werden', 'error');
          }
        });
      });
      const form = el.querySelector('[data-momentum-pause-form]');
      if (form) {
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const date = new FormData(form).get('date');
          if (!date) return;
          try {
            await addPauseDay(String(date));
            state.pauseDays = await fetchPauseDays().then((r) => r.pauseDays || []);
            const listHost = el.querySelector('[data-momentum-pause-list]');
            if (listHost) listHost.innerHTML = renderPauseDaysList(state.pauseDays);
            form.reset();
            host().toast('Pausentag gespeichert');
          } catch (e) {
            host().toast(e.message || 'Pausentag konnte nicht gespeichert werden', 'error');
          }
        });
      }
      el.querySelectorAll('[data-momentum-remove-pause]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const date = btn.getAttribute('data-momentum-remove-pause');
          try {
            await removePauseDay(date);
            state.pauseDays = state.pauseDays.filter((d) => d !== date);
            const listHost = el.querySelector('[data-momentum-pause-list]');
            if (listHost) listHost.innerHTML = renderPauseDaysList(state.pauseDays);
          } catch (e) {
            host().toast(e.message || 'Pausentag konnte nicht entfernt werden', 'error');
          }
        });
      });
    }

    async function reload() {
      if (destroyed) return;
      el.innerHTML = `<div class="momentum-view"><div class="momentum-empty">Lädt …</div></div>`;
      try {
        const [overview, pauseDaysRes] = await Promise.all([fetchOverview(), fetchPauseDays()]);
        if (destroyed) return;
        state = {
          settings: overview.settings,
          streak: overview.streak,
          week: overview.week,
          pauseDays: pauseDaysRes.pauseDays || [],
        };
        renderView();
      } catch (e) {
        if (!destroyed) renderError(e);
      }
    }

    reload();
    return { reload, destroy: () => { destroyed = true; } };
  }

  root.TSMomentum = { utcOffsetMinutes, mount, fetchStreakBadge, showCompletionToast };

  // Reine, DOM-freie Hilfsfunktionen für node-basierte Unit-Tests (siehe
  // test/momentum_web_module.test.js) - analog zum Muster in
  // public/progress.js. `esc()`/host() benötigen zum Aufrufzeitpunkt ein
  // gesetztes `TSHost.escHtml` (in Node also `global.TSHost`, da `root` dann
  // `globalThis` ist) - Tests setzen das vor dem Aufruf, exakt wie bei einem
  // echten Host.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      utcOffsetMinutes,
      todayStr,
      renderStreakCard,
      renderWeekCard,
      renderPauseDaysList,
      renderSettings,
      renderEmptyState,
      showCompletionToast,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
