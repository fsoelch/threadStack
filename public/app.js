// Extrahiert aus index.html (ehemals inline <script>, Zeilen 3186-10377).
// Bewusst weiterhin ein klassisches, nicht gekapseltes Script (kein IIFE/Modul):
// >300 Inline-Event-Handler in index.html (onclick="...()" etc.) referenzieren
// die hier deklarierten Funktionen per globalem Scope. Eine vollstaendige
// Kapselung wuerde das Umschreiben aller Inline-Handler auf addEventListener
// erfordern (analog zur zurueckgestellten CSP-Haertung, siehe CLAUDE.md-
// Historie) - dieser Schritt beschraenkt sich bewusst auf die reine
// Auslagerung in eine eigenstaendige, lintbare/testbare Datei.

// ── Guard: must run via HTTP ─────────────────────────────────
if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                font-family:-apple-system,sans-serif;padding:2rem;text-align:center;background:#f1f5f9">
      <div style="background:white;border-radius:16px;padding:2.5rem;max-width:480px;
                  box-shadow:0 4px 24px rgba(0,0,0,.1)">
        <div style="font-size:2.5rem;margin-bottom:1rem">⚠️</div>
        <h2 style="color:#dc2626;margin-bottom:.75rem">Server erforderlich</h2>
        <p style="color:#64748b;line-height:1.6;margin-bottom:1.5rem">
          Diese App muss über den Node.js-Server aufgerufen werden —
          nicht direkt als Datei im Browser.
        </p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;
                    padding:1rem;font-family:monospace;font-size:.875rem;text-align:left;margin-bottom:1rem">
          npm install<br>node server.js
        </div>
        <p style="color:#64748b;font-size:.875rem">
          Dann: <strong style="color:#6366f1">http://localhost:3000/notes</strong>
        </p>
      </div>
    </div>`;
  throw new Error('HTTP server required');
}

const _path = window.location.pathname.replace(/\/$/, '');
const API   = _path + '/api';

// ── SVG Icons (Lucide, 1.5px stroke) ────────────────────────
const SVG = {
  users:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  calendar: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  repeat:   `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
  sparkle:  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 2l.75 2.25L22 5l-2.25.75L19 8l-.75-2.25L16 5l2.25-.75z"/></svg>`,
  check:    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><polyline points="20 6 9 17 4 12"/></svg>`,
  moon:     `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  pencil:   `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  notes:    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  layers:   `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1D6FE8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  history:  `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 0 .5-4"/><polyline points="3 3 3 11 11 11"/></svg>`,
  eye:      `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eject:    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><polygon points="5 12 12 4 19 12"/><line x1="5" y1="16" x2="19" y2="16"/></svg>`,
  plus:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><polyline points="6 9 12 15 18 9"/></svg>`,
  chevronUp:   `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><polyline points="18 15 12 9 6 15"/></svg>`,
  chat:     `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.1em"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
};

// ── State ────────────────────────────────────────────────────
let currentUser = null;
let meetings    = [];
let todos       = [];
let selectedId  = null;
let showPrivateTodos = true;
let filterText  = '';
let topicFilter = '';
// Fortschrittsverlauf — Sortierung/Filter, sitzungsweit (Arbeitspaket W1, Story 9)
let todoProgressSortOldest = false;
let todoProgressFilterUndocumented = false;
let topicProgressSortOldest = false;
let topicProgressFilterUndocumented = false;

let editMeetingId   = null;
let editTopicMid    = null;
let editTopicId     = null;
let completeMid     = null;
let completeTid     = null;
let completeTodoId  = null;
let editUserId      = null;
let confirmCallback = null;
// Sicherheitsfix (Security Review, Mittel, Fund 3): Label-/Klassen-Cleanup von
// genericConfirm() darf nicht nur bei Klick auf einen der beiden Dialog-
// Buttons laufen, sondern bei JEDEM Schließen des #confirm-dialog (z. B. auch
// über Escape) — siehe closeConfirm() weiter unten.
let confirmCleanup  = null;
let themes          = [];
let contacts        = [];
let editContactId   = null;
let contactSearch   = '';
let editThemeId     = null;
let themeLinkCtx    = null;
let moveSrcCtx      = null;

// ── Wissensmanagement (v2) state ──────────────────────────────
let selectedThemeId    = null;          // aktuell gewähltes Topic in der Baum-Ansicht
let expandedThemeIds   = new Set();     // ausgeklappte Baum-Knoten
let themeShowDescendants = true;        // Wissen/Todos aus Unter-Topics mit anzeigen
let themeDetailKnowledge = [];          // geladenes Wissen für selectedThemeId
let themeDetailTodos     = [];          // geladene Todos für selectedThemeId
let themeDetailLoading   = false;
let newThemeParentId   = null;          // Parent für "+ Unter-Topic" im Theme-Modal
let themeMoveId        = null;          // Topic, das gerade verschoben wird
let themeDeleteCtx     = null;          // { id, title, subTopicCount, knowledgePageCount }
let knowledgePages     = [];            // globale Wissens-Ansicht Cache
let knowledgeFilterThemeId = '';
let knowledgeSearch     = '';
let editKnowledgeId     = null;
let knowledgeThemeSelection = new Set(); // im Wissens-Modal ausgewählte Topic-IDs
let todoThemeSelection = new Set();      // im Todo-Modal ausgewählte Topic-IDs
let momentumStreak      = null;         // Sichtbarer Fortschritt (Arbeitspaket M4): aktuelle Tages-Serie fuer den Sidebar-Badge, null = keine/deaktiviert

const COLORS = ['#1D6FE8','#3b82f6','#06b6d4','#10b981','#22c55e','#f59e0b','#ef4444','#ec4899','#a855f7','#64748b'];

// ── Toast ────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Erfolgsfeedback für neu angelegtes Wissen (dezent, kein Toast-Ersatz) ──
function knowledgeCreatedThisWeekCount() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Montag = 0
  const monday = new Date(now); monday.setHours(0,0,0,0); monday.setDate(now.getDate() - day);
  return knowledgePages.filter(k => k.createdAt && new Date(k.createdAt) >= monday).length;
}

function celebrateKnowledgeCreated() {
  const count = knowledgeCreatedThisWeekCount();
  const el = document.createElement('div');
  el.className = 'toast toast-success toast-celebrate';
  el.innerHTML = `<span class="toast-celebrate-icon">✨</span> Wissen erstellt` +
    (count > 1 ? `<br><small>Das war deine ${count}. Wissensseite diese Woche</small>` : '');
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ── Loading ──────────────────────────────────────────────────
function setBusy(btnId, busy) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (busy) { btn._orig = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true; }
  else       { btn.innerHTML = btn._orig || btn.innerHTML; btn.disabled = false; }
}

// ── API ──────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin' };
  if (body != null) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res  = await fetch(API + path, opts);
  if (res.status === 401) { handleSessionExpiry(); throw new Error('Sitzung abgelaufen'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Fehler');
    err.status = res.status;
    // Server-Fehler-Envelope ist { error, code, ...extra } (siehe server.js
    // fail()) - err.code wird analog zu linkApiFetch() durchgereicht, damit
    // Aufrufer (z.B. progress.js#mapError/mapSnoozeError) code-spezifische
    // Meldungen (rate_limited, ARCHIVED_READONLY, ref_done, ...) zeigen
    // koennen, statt sich nur auf den HTTP-Status zu verlassen.
    err.code   = data.code;
    err.body   = data;
    throw err;
  }
  return data;
}

// Analog zu api(), aber für binäre Uploads (Arbeitspaket B3, Backup-Restore
// aus Datei) - api() setzt immer 'Content-Type: application/json' und
// JSON.stringify()t den Body, das passt nicht für einen rohen Datei-Body.
// Gleiches 401-/Fehler-Envelope-Verhalten wie api(), damit Aufrufer
// (public/backup.js) denselben err.code/err.status-Vertrag nutzen können.
async function uploadRawViaHost(path, file) {
  const res = await fetch(API + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (res.status === 401) { handleSessionExpiry(); throw new Error('Sitzung abgelaufen'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Fehler');
    err.status = res.status;
    err.code   = data.code;
    err.body   = data;
    throw err;
  }
  return data;
}

// ── TSHost — Schnittstelle für das Graph-Modul (public/graph.js) ──
window.TSHost = {
  // graph.js ruft Pfade inkl. führendem "/api" auf (z.B. "/api/graph"), die
  // interne api()-Funktion baut die URL bereits als `${_path}/api${path}` —
  // ohne dieses Kürzen entsteht ein doppeltes "/api/api/...".
  api: (method, path, body, opts) => api(method, path.replace(/^\/api(?=\/|$)/, ''), body),
  uploadRaw: (path, file) => uploadRawViaHost(path, file),
  toast: (msg, type) => toast(msg, type),
  escHtml: (s) => escHtml(s),
  themeAncestorsPath: (id) => themeAncestorsPath(id),
  openKnowledge: (id) => openKnowledgeModal(id),
  openObject: (type, id, meta) => {
    if (type === 'todo') {
      selectView('__todos__'); openTodoModal(id);
      if (meta?.focus === 'progress') focusTodoProgressSection();
    }
    else if (type === 'topic') {
      // Archivierte Meetings (meta.archived === true, Paket B3) sind nicht
      // mehr in der aktiven `meetings`-Liste enthalten — selectView() +
      // openTopicModal() würden dann einen leeren "Neues Thema"-Dialog statt
      // der Nur-Lese-Ansicht öffnen (Security-Review-Fund). In dem Fall (oder
      // falls das Meeting aus anderem Grund nicht mehr aktiv gefunden wird)
      // stattdessen in die bestehende Archiv-Nur-Lese-Route navigieren.
      // Hinweis (Abweichung/Risiko, siehe Abschlussbericht Paket W2): die
      // Themen-Bearbeiten-Ansicht (#topic-modal) enthält aktuell keinen
      // eigenen Fortschrittsbereich, da das W2-UX-Lastenheft nur die
      // Todo-Übersicht/#todo-modal beschreibt — meta.focus wird hier daher
      // bewusst ignoriert statt eine nicht spezifizierte Fläche zu bauen.
      const meetingId = meta?.meetingId;
      if (meta?.archived === true || (meetingId && !getMeeting(meetingId))) {
        if (meetingId) selectArchiveDetail(meetingId);
      } else {
        if (meetingId) selectView(meetingId);
        openTopicModal(meetingId, id);
      }
    }
    else if (type === 'contact') { selectView('__contacts__'); openContactModal(id); }
  },
  confirm: ({ title, message, confirmLabel, cancelLabel, danger, focus }) =>
    genericConfirm(title, message, confirmLabel, cancelLabel, { danger, focus }),
  // Arbeitspaket B3 (Backup-Restore): der Server invalidiert nach einer
  // erfolgreichen Wiederherstellung ALLE Sitzungen serverseitig - der
  // aktuelle Tab weiss das aber nicht automatisch, bis der nächste Request
  // 401 liefert. forceLogout() löst denselben Sitzungsende-Screen sofort
  // aktiv aus, statt auf den nächsten (zufälligen) 401 zu warten.
  forceLogout: () => handleSessionExpiry(),
  reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  // ── Fortschritt/KI-Zusammenfassungen (Arbeitspaket W2) ──────────────
  // Wird von window.TSProgress (public/progress.js, Paket W1) konsumiert.
  progress: {
    // Bereits vor W2 vorhanden angenommen (Re-Entry-Briefing-Feature,
    // wiederverwendet für TSProgress.mountReentryCard): generischer
    // AI-Feature-Schalter bzw. AI-Reentry-Aufruf für einen Stack-Frame.
    aiEnabled: () => aiFeatureOn('reentry'),
    aiReentry: (frameId) => runProgressAiReentry(frameId),
    // Neu in W2: Feature-Schalter für die KI-Zusammenfassungen von
    // Fortschritt/Beschreibung (prüft zusätzlich den globalen KI-Aus-
    // Schalter via aiFeatureOn -> aiIsActive()).
    aiSummaryEnabled: (kind) => {
      if (kind !== 'progress' && kind !== 'description') return false;
      // Strikte Boolean-Rückgabe: aiFeatureOn()/aiIsActive() können bei
      // aiSettings === null aus einem verketteten "&&" auch `null`
      // zurückgeben — der Vertrag verlangt aber "→ boolean".
      return !!aiFeatureOn(kind === 'progress' ? 'progress_summary' : 'description_summary');
    },
    // Stößt die Neuerzeugung einer KI-Zusammenfassung an. kind/refType
    // werden gegen eine Allowlist geprüft, bevor sie in den Pfad
    // eingesetzt werden (Eingabevalidierung an der Vertrauensgrenze zum
    // W1-Modul); die eigentliche Id wird zusätzlich URL-kodiert.
    // `confirmed` defaultet auf false (Security Review, Mittel, A04): der
    // Hintergrund-Job prüft die Kostenschwelle bei jedem automatischen Lauf
    // mit confirmed:false; ein hier fest verdrahtetes confirm=true hätte
    // diese Prüfung für JEDEN manuellen Klick unbemerkt umgangen. Erst wenn
    // der Status als "confirmation_required" zurückkommt (siehe
    // mountCardSummary in public/progress.js), löst ein expliziter,
    // beschrifteter zweiter Klick den Aufruf erneut MIT confirmed:true aus.
    regenerateSummary: (kind, refType, refId, confirmed) => {
      if (kind !== 'progress' && kind !== 'description') {
        return Promise.reject(new Error('Ungültige Zusammenfassungsart'));
      }
      if (refType !== 'todo' && refType !== 'topic') {
        return Promise.reject(new Error('Ungültiger Referenztyp'));
      }
      if (typeof refId !== 'string' || !refId || refId.length > 200) {
        return Promise.reject(new Error('Ungültige Referenz-Id'));
      }
      const suffix = confirmed ? '?confirm=true' : '';
      return api('POST', `/summaries/${kind}/${refType}/${encodeURIComponent(refId)}/regenerate${suffix}`);
    },
    // Der frühere Dialog zur zielgerichteten Statuserfassung entfällt hier ersatzlos.
    //
    // openEntryDialog ist NICHT Teil der W2 explizit zugewiesenen
    // Host-Hook-Liste (nur aiSummaryEnabled/regenerateSummary/openObject
    // waren gefordert). Da das UX-Lastenheft aber einen "eigenständigen"
    // Zwischenstand-Bearbeiten-Dialog voraussetzt und in diesem Worktree
    // keine TSProgress-Lieferung vorliegt, gegen die ich den tatsächlichen
    // Aufruf verifizieren könnte, biete ich diesen Hook defensiv nach dem
    // Namensschema einer früheren Iteration an. Siehe Abschlussbericht:
    // klärungsbedürftiger Vertrags-Randfall für den Merge mit W1.
    openEntryDialog: ({ refType, refId, entryId, initialHtml, contextHtml, onSaved } = {}) => {
      const item = refType === 'todo' ? todos.find(x => x.id === refId) : findTopicAnywhere(refId)?.topic;
      openProgressEntryDialog(refType, refId, entryId, initialHtml, contextHtml ?? item?.description, onSaved);
    },
    // "Nächster Schritt" bleibt unverändert erhalten (die Redesign-Entscheidung
    // betrifft dieses Feld nicht) — TSProgress.mountTimeline ruft diese Hooks
    // weiterhin auf.
    openNextStepDialog: (ctx) => openProgressNextStepDialog(ctx),
    confirmDelete: ({ title, message }) => genericConfirm(title, message, 'Löschen', 'Abbrechen'),
    // Wird vom Zeitstrahl nach Bearbeiten/Löschen eines BESTEHENDEN Eintrags
    // (data-action="edit-entry"/"delete-entry") ausgelöst - Wiederverwendung
    // der bestehenden Listen-/Cache-Aktualisierung statt einer zweiten.
    onProgressChanged: (refType, refId) => onProgressChangedHost(refType, refId),
  },
};

// ── Fortschritt: Konstanten/Helfer (Arbeitspaket W2) ───────────────────
// DESCRIPTION_MIN_PLAIN_CHARS muss inhaltlich mit lib/summaries/constants.js
// (Paket S1) übereinstimmen. Da index.html ohne Build-Step direkt im
// Browser läuft, kann der Wert nicht importiert werden — siehe
// Abschlussbericht W2 (Merge-Hinweis an S1/S3: bei Änderung dort bitte
// auch diesen Wert anpassen).
const DESCRIPTION_MIN_PLAIN_CHARS = 600;
// Heuristische Schwelle für die NICHT-KI-Zeilenkürzung auf Karten
// (unabhängig von DESCRIPTION_MIN_PLAIN_CHARS): ab dieser Klartextlänge
// wird die Karten-Beschreibung per CSS line-clamp gekürzt, damit die Karte
// im Standardzustand max. 4 Textzeilen behält.
const CARD_DESC_CLAMP_CHARS = 320;
// Sichtbare Topic-Chips im Standardzustand einer Karte, bevor das
// Aufklapp-Element erscheint.
const CARD_VISIBLE_CHIPS = 3;

// DOMParser statt eines detached <div>.innerHTML: ein detached Node führt
// zwar keine <script>-Tags aus, feuert aber weiterhin ressourcenbasierte
// Handler (<img src=x onerror=...>, <svg onload=...>) - ein per DOMParser
// erzeugtes Dokument lädt keine Ressourcen und führt keine Handler aus
// (Security Review, Mittel, A03 Defense-in-Depth).
function plainTextLength(html) {
  if (!html) return 0;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').trim().length;
}

// Liefert einen kurzen, reinen (bereits escapten) Text-Auszug einer
// HTML-Beschreibung für Kontextzeilen — wird NIE als HTML eingesetzt.
function plainTextExcerpt(html, maxLen) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxLen ? text : text.slice(0, Math.max(0, maxLen - 1)).trim() + '…';
}

// Gemeinsame Eingabevalidierung für Fortschritts-Referenzen, bevor sie in
// API-Pfade eingesetzt werden (Vertrauensgrenze zum W1-Modul: refType/refId
// können über TSHost.progress.openEntryDialog von außen hereinkommen).
function isValidProgressRef(refType, refId) {
  return (refType === 'todo' || refType === 'topic') &&
    typeof refId === 'string' && refId.length > 0 && refId.length <= 200;
}

function findTopicAnywhere(tid) {
  for (const m of meetings) {
    const t = (m.topics || []).find(x => x.id === tid);
    if (t) return { meeting: m, topic: t };
  }
  return null;
}

// ── Todo-Modal: Beschreibung — Leseansicht mit Stift-Aktivierung ──────
// (bindende Entscheidung: nach Ersterfassung schreibgeschützt, Bearbeiten
// nur über das Stift-Symbol; nutzt ausschließlich den bestehenden
// #todo-desc Rich-Text-Editor, KEIN zweiter Editor.)
function updateTodoDescReadView(t) {
  const display = document.getElementById('todo-desc-display');
  const html = t?.description || '';
  if (html) {
    display.classList.remove('placeholder');
    display.innerHTML = displayHtml(html);
  } else {
    display.classList.add('placeholder');
    display.textContent = 'Keine Beschreibung — Stift zum Hinzufügen.';
  }
}

function enterTodoDescEditMode() {
  const readview = document.getElementById('todo-desc-readview');
  const wrapper  = document.getElementById('todo-desc-wrapper');
  readview.style.display = 'none';
  wrapper.style.display  = '';
  const ed = document.getElementById('todo-desc');
  ed.focus();
  // Cursor ans Textende setzen (Vorgabe: "Fokus + Cursor ans Textende").
  try {
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* Selection-API in Edge-Fällen (leerer Editor) unkritisch */ }
}

// ── Topic-Modal: Beschreibung — Leseansicht mit Stift-Aktivierung ─────
// Identisches Verhalten zum Todo-Modal (Story 5/10) - Bugfix, siehe
// Testbericht: der Topic-/Task-Bearbeiten-Dialog hatte dieses Muster beim
// Redesign nicht mitbekommen, obwohl "Bearbeiten" für Tasks (Meeting-Themen
// mit Todo-Kennzeichnung) genau hierher führt.
function updateTopicDescReadView(t) {
  const display = document.getElementById('t-desc-display');
  const html = t?.description || '';
  if (html) {
    display.classList.remove('placeholder');
    display.innerHTML = displayHtml(html);
  } else {
    display.classList.add('placeholder');
    display.textContent = 'Keine Beschreibung — Stift zum Hinzufügen.';
  }
}

function enterTopicDescEditMode() {
  const readview = document.getElementById('t-desc-readview');
  const wrapper  = document.getElementById('t-desc-wrapper');
  readview.style.display = 'none';
  wrapper.style.display  = '';
  const ed = document.getElementById('t-desc');
  ed.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* Selection-API in Edge-Fällen (leerer Editor) unkritisch */ }
}

// ── Topic-Modal: "Weitere Details" (natives <details>) ────────────────
function updateTopicMoreDetailsSummary() {
  const parts = [];
  const snooze = document.getElementById('t-snooze').value;
  if (snooze) parts.push(`Schlafend bis ${shortDateLabel(snooze)}`);
  const summaryEl = document.getElementById('t-more-details-summary');
  summaryEl.textContent = parts.length ? `Weitere Details – ${parts.join(', ')}` : 'Weitere Details';
  document.getElementById('t-more-details').open = parts.length > 0;
}

// ── Todo-Modal: "Weitere Details" (natives <details>) ─────────────────
function shortDateLabel(isoDateOnly) {
  if (!isoDateOnly) return '';
  const [y, m, d] = isoDateOnly.slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${d}.${m}.`;
}

function updateTodoMoreDetailsSummary() {
  const parts = [];
  const due = document.getElementById('todo-due').value;
  if (due) parts.push(`Fällig am ${shortDateLabel(due)}`);
  const snooze = document.getElementById('todo-snooze').value;
  if (snooze) parts.push(`Schlafend bis ${shortDateLabel(snooze)}`);
  if (document.getElementById('todo-private').checked) parts.push('Privat');
  const summaryEl = document.getElementById('todo-more-details-summary');
  summaryEl.textContent = parts.length ? `Weitere Details – ${parts.join(', ')}` : 'Weitere Details';
  document.getElementById('todo-more-details').open = parts.length > 0;
}

// ── Todo-Modal: ungespeicherte Änderungen (Verwerfen-Rückfrage) ───────
let todoModalSnapshot = null;

function collectTodoFormData() {
  return {
    title: document.getElementById('todo-title').value.trim(),
    description: getRT('todo-desc'),
    isPrivate: document.getElementById('todo-private').checked,
    dueDate: document.getElementById('todo-due').value || null,
    snoozeDate: document.getElementById('todo-snooze').value || null,
    snoozeHasTime: document.getElementById('todo-snooze-has-time').checked,
    snoozeTime: document.getElementById('todo-snooze-time').value || null,
    done: editTodoId ? document.getElementById('todo-done').checked : false,
    result: editTodoId ? getRT('todo-result') : '',
    resultDate: editTodoId ? document.getElementById('todo-result-date').value : '',
  };
}

function hasUnsavedTodoChanges() {
  if (todoModalSnapshot == null) return false;
  return JSON.stringify(collectTodoFormData()) !== todoModalSnapshot;
}

async function closeTodoModal(skipConfirm) {
  if (!skipConfirm && hasUnsavedTodoChanges()) {
    const ok = await genericConfirm(
      'Änderungen verwerfen?',
      'Es gibt ungespeicherte Änderungen an diesem Todo. Möchtest du sie verwerfen?',
      'Verwerfen', 'Weiter bearbeiten'
    );
    if (!ok) return;
  }
  todoModalSnapshot = null;
  document.getElementById('todo-modal').style.display = 'none';
}

function todoModalOverlayClick(e) {
  if (e.target.id !== 'todo-modal') return;
  closeTodoModal();
}

// ── Todo-Modal: Fortschrittsbereich (Composer + Verlauf) ──────────────
function focusTodoProgressSection() {
  const el = document.getElementById('todo-progress-section');
  if (!el || el.style.display === 'none') return;
  setTimeout(() => {
    el.scrollIntoView({ behavior: (TSHost.reducedMotion() ? 'auto' : 'smooth'), block: 'center' });
  }, 60);
}

// `result` ist optional (Rückgabewert der Schreibroute, z.B. wenn der
// Aufrufer sie kennt) und wird NUR für die aiSummary.pending-Erkennung
// genutzt — das eigentliche Neuladen erfolgt bewusst über einen kompletten
// loadTodos()/loadMeetings()-Refresh statt eines manuellen Merges, damit
// wir keine Annahmen über nicht dokumentierte Detail-Feldformen von
// `result.summary` treffen müssen (siehe Abschlussbericht: die
// Zwischenstands-Schreibrouten liefern laut Vertrag zusätzlich `summary`/
// `aiSummary`, aber die genaue Form von `summary` ist dort nicht spezifiziert).
async function onTodoProgressEntrySaved(refType, refId, result) {
  toast('Zwischenstand gespeichert');
  try {
    if (refType === 'todo') await loadTodos(); else await loadMeetings();
  } catch (e) { toast(e.message || 'Aktualisierung fehlgeschlagen', 'error'); }
  render();
  remountEditModalProgressArea(refType, refId);
  // Server verarbeitet die KI-Zusammenfassung ggf. asynchron
  // (aiSummary.pending === true) — TSProgress.pollSummaries() wartet
  // bis zu 10x/2000ms auf das Ergebnis, danach wird einmal final neu
  // geladen, damit Karten/Bearbeiten-Ansicht die fertige Zusammenfassung
  // zeigen, ohne dass die Nutzerin manuell neu laden muss.
  if (result?.aiSummary?.pending && window.TSProgress && typeof TSProgress.pollSummaries === 'function') {
    try {
      await TSProgress.pollSummaries([`${refType}:${refId}`]);
    } catch { /* Polling-Fehler sind nicht kritisch, Daten bleiben auf letztem Stand */ }
    try {
      if (refType === 'todo') await loadTodos(); else await loadMeetings();
    } catch { /* still non-fatal */ }
    render();
    remountEditModalProgressArea(refType, refId);
  }
}

function remountEditModalProgressArea(refType, refId) {
  if (refType === 'todo' && editTodoId && refId === editTodoId) {
    mountTodoProgressArea(todos.find(x => x.id === editTodoId));
  } else if (refType === 'topic' && editTopicId && refId === editTopicId) {
    mountTopicProgressArea(getTopic(editTopicMid, editTopicId));
  }
}

// Fortschrittsbereich im Todo-/Themen-Bearbeiten-Dialog: ein gemeinsamer,
// selbstspeichernder Composer (TSProgress.mountInlineComposer) plus
// Zeitstrahl (TSProgress.mountTimeline) fuer BEIDE Vorhaben-Typen - Themen
// nutzten frueher ein abweichendes Muster (manueller Speichern-Button,
// Rich-Text-Feld, Wiedereinstiegskarte), das zu Divergenz zwischen den
// beiden gleichwertigen "Vorhaben"-Ansichten fuehrte (siehe CLAUDE.md,
// "Wiederverwendung vor Neuentwicklung") - jetzt identisch fuer beide.
function mountProgressArea(idPrefix, refType, item) {
  const section   = document.getElementById(`${idPrefix}-progress-section`);
  const composerEl = document.getElementById(`${idPrefix}-progress-composer`);
  const timelineEl = document.getElementById(`${idPrefix}-progress-timeline`);
  if (!section) return;
  composerEl.innerHTML = '';
  timelineEl.innerHTML = '';
  if (!item || !item.id) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (!window.TSProgress) {
    timelineEl.innerHTML = '<p class="form-hint">Fortschrittsverlauf derzeit nicht verfügbar.</p>';
    return;
  }
  if (!item.done && typeof TSProgress.mountInlineComposer === 'function') {
    TSProgress.mountInlineComposer(composerEl, {
      refType, refId: item.id,
      snoozedUntil: item.snoozedUntil || null,
      done: !!item.done,
      // Wie bei mountCardComposer: das Öffnen des Bearbeiten-Sheets für ein
      // bestehendes Todo/Thema ist bereits die bewusste Nutzer-Aktion, das
      // Eingabefeld für einen neuen Zwischenstand soll deshalb sofort
      // sichtbar sein statt hinter dem 💬-Zwischentrigger (Nutzerfeedback).
      openOnMount: true,
      onSaved: (result) => onTodoProgressEntrySaved(refType, item.id, result),
      onError: (err) => toast(err?.message || 'Zwischenstand konnte nicht gespeichert werden', 'error'),
      onSnoozeSave: async (val) => {
        await saveComposerSnooze(refType, item.id, val);
        syncSnoozeFormIfModalOpen(refType, item.id);
      },
    });
  }
  if (typeof TSProgress.mountTimeline === 'function') {
    TSProgress.mountTimeline(timelineEl, { refType, refId: item.id, limit: 3 });
  }
}

function mountTodoProgressArea(t) { mountProgressArea('todo', 'todo', t); }
function mountTopicProgressArea(t) { mountProgressArea('t', 'topic', t); }

// ── "Schlafen bis"-Kurzoption im Zwischenstand-Composer (Story 2) ──────
// Persistiert snoozedUntil ueber dieselben Endpunkte wie das "Weitere
// Details"-Feld im jeweiligen Bearbeiten-Dialog (todo-snooze/t-snooze) -
// kein zweiter Mechanismus, nur ein weiterer, unaufaelligerer Einstiegspunkt
// dafuer (CLAUDE.md: Wiederverwendung vor Neuentwicklung). Wird sowohl von
// mountCardComposer (Uebersichtskarte) als auch mountProgressArea
// (Bearbeiten-Dialog) als TSProgress.mountInlineComposer-Option
// "onSnoozeSave" injiziert, damit progress.js selbst keine Kenntnis von
// Meeting-IDs/Endpunkt-Pfaden braucht.
async function saveComposerSnooze(refType, refId, snoozedUntilOrNull) {
  if (refType === 'todo') {
    await api('PUT', `/todos/${refId}`, { snoozedUntil: snoozedUntilOrNull });
    const t = todos.find(x => x.id === refId);
    if (t) t.snoozedUntil = snoozedUntilOrNull;
  } else if (refType === 'topic') {
    const found = findTopicAnywhere(refId);
    if (!found) { const e = new Error('Dieses Thema wurde inzwischen gelöscht.'); e.status = 404; throw e; }
    await api('PUT', `/meetings/${found.meeting.id}/topics/${refId}`, { snoozedUntil: snoozedUntilOrNull });
    found.topic.snoozedUntil = snoozedUntilOrNull;
  } else {
    throw new Error('Für diesen Vorhaben-Typ nicht unterstützt.');
  }
  render();
}

// Haelt die "Weitere Details"-Felder (todo-snooze/t-snooze) synchron, falls
// der jeweilige Bearbeiten-Dialog gerade fuer GENAU dieses Vorhaben offen
// ist - sonst wuerden zwei Bedienelemente fuer denselben Wert (Composer-
// Kurzoption vs. "Weitere Details") auseinanderlaufen (CLAUDE.md: Divergenz
// zwischen gleichwertigen Bedienstellen ist ein Bug).
function syncSnoozeFormIfModalOpen(refType, refId) {
  if (refType === 'todo' && editTodoId === refId) applyTodoSnoozeToForm(todos.find(x => x.id === refId));
  else if (refType === 'topic') {
    const found = findTopicAnywhere(refId);
    if (found && editTopicId === refId && editTopicMid === found.meeting.id) applyTopicSnoozeToForm(found.topic);
  }
}

// ── Karten: Composer "Zwischenstand erfassen" (Story 6, Übersichtsliste) ─
function mountCardComposer(container, refType, refId) {
  if (!window.TSProgress || typeof TSProgress.mountInlineComposer !== 'function') {
    container.innerHTML = '<p class="form-hint">Fortschritts-Erfassung derzeit nicht verfügbar.</p>';
    return;
  }
  const item = refType === 'todo' ? todos.find(x => x.id === refId) : findTopicAnywhere(refId)?.topic;
  TSProgress.mountInlineComposer(container, {
    refType, refId,
    snoozedUntil: item?.snoozedUntil || null,
    done: !!item?.done,
    // Der Klick auf das Notiz-Icon (`toggleTodoCardComposer`) ist bereits
    // die bewusste Aktion "Zwischenstand erfassen" - das Textfeld soll
    // deshalb direkt beim ersten Klick erscheinen statt hinter einem
    // zusaetzlichen Trigger versteckt zu sein (Tester-Feedback).
    openOnMount: true,
    onSaved: (result) => onTodoProgressEntrySaved(refType, refId, result),
    onError: (err) => toast(err?.message || 'Zwischenstand konnte nicht gespeichert werden', 'error'),
    onSnoozeSave: async (val) => {
      await saveComposerSnooze(refType, refId, val);
      syncSnoozeFormIfModalOpen(refType, refId);
    },
  });
}

function toggleTodoCardComposer(refType, refId) {
  const container = document.getElementById(`todo-card-composer-${refType}-${refId}`);
  if (!container) return;
  const willShow = container.style.display === 'none' || !container.style.display;
  container.style.display = willShow ? '' : 'none';
  if (willShow && !container.dataset.mounted) {
    container.dataset.mounted = '1';
    mountCardComposer(container, refType, refId);
  }
}

// ── Karten: EIN Aufklapp-Element für lange Beschreibung + zusätzliche
// Topic-Chips (adaptives Label je nachdem, was tatsächlich überläuft). ──
const _todoCardExpanded = new Set();

function toggleTodoCardOverflow(refType, refId) {
  const key = `${refType}:${refId}`;
  if (_todoCardExpanded.has(key)) _todoCardExpanded.delete(key); else _todoCardExpanded.add(key);
  render();
}

// Liefert { descriptionHtml, chipsHtml, toggleHtml } für eine Todo-/Topic-
// Karte. `isDone`/`isArchived` unterdrücken KI-Zusammenfassung und Composer
// vollständig (Vorgabe: erledigte Todos/archivierte Meetings sind rein
// lesend, ohne Fortschritts-/KI-Flächen).
function renderTodoCardBody(refType, item, themeEntries, isDone, isArchived) {
  const key = `${refType}:${item.id}`;
  const expanded = _todoCardExpanded.has(key);
  const descHtmlRaw = item.description || '';
  const plainLen = plainTextLength(descHtmlRaw);
  const dStatus = item.aiSummary?.description?.status || null;
  // KI-Zusammenfassungsfläche nur für Status, die eine sinnvolle Fläche
  // ergeben — 'not_applicable' bleibt bewusst ausgeblendet (bekannte
  // S3-Mehrdeutigkeit, siehe Abschlussbericht), 'disabled' fällt auf die
  // deterministische Zeilenkürzung zurück.
  const descAiEligible = !isDone && !isArchived && dStatus && dStatus !== 'not_applicable' && dStatus !== 'disabled';
  const descNeedsClamp = !descAiEligible && plainLen > CARD_DESC_CLAMP_CHARS;

  const visibleChips  = expanded ? themeEntries : themeEntries.slice(0, CARD_VISIBLE_CHIPS);
  const chipsOverflow = themeEntries.length > CARD_VISIBLE_CHIPS;
  const showToggle    = !isDone && (descNeedsClamp || chipsOverflow);
  const toggleLabel   = chipsOverflow
    ? (expanded ? 'Weniger anzeigen' : 'Mehr anzeigen')
    : (expanded ? 'Text einklappen'  : 'Ganzen Text anzeigen');

  let descriptionHtml = '';
  if (descAiEligible) {
    descriptionHtml = `<div class="ts-card-summary-slot" id="todo-desc-summary-${refType}-${item.id}"></div>`;
  } else if (descHtmlRaw) {
    const clampClass = (descNeedsClamp && !expanded) ? ' desc-clamp-fallback' : '';
    descriptionHtml = `<div class="topic-description rt-display${clampClass}">${displayHtml(descHtmlRaw)}</div>`;
  }

  const chipsHtml = themeEntries.length > 0 ? `
    <div class="theme-chips">
      ${visibleChips.map(x => `
        <span class="theme-chip" onclick="selectView('__themes__')" title="Topic: ${escHtml(x.theme.title)}">
          🏷️ ${escHtml(x.theme.title)}
        </span>`).join('')}
    </div>` : '';

  const toggleHtml = showToggle
    ? `<button type="button" class="card-more-toggle" onclick="toggleTodoCardOverflow('${refType}','${item.id}')" aria-expanded="${expanded}">${escHtml(toggleLabel)}</button>`
    : '';

  // Zugeordnete Ansprechpartner (Arbeitspaket W2/TSContacts) — `item.contacts`
  // liefert der Server bereits mit GET /todos bzw. GET /meetings.
  const contactsHtml = renderAssignedContactsChipsHtml(item);

  return { descriptionHtml, chipsHtml, toggleHtml, contactsHtml };
}

// Fortschrittszeile + optionale KI-Fortschritts-Zusammenfassung für Karten
// (immer sichtbar außer bei Erledigt/Archiviert — Fortschritt bleibt
// textbasiert, keine feste Zielvorgabe, kein Prozentwert).
function renderTodoCardProgress(refType, item, isDone, isArchived) {
  if (isDone || isArchived) return '';
  const lineHtml = (window.TSProgress && typeof TSProgress.progressLineHtml === 'function' && item.progress)
    ? TSProgress.progressLineHtml(item.progress) : '';
  const lineBlock = lineHtml ? `<div class="ts-progress-line-host">${lineHtml}</div>` : '';
  const pStatus = item.aiSummary?.progress?.status || null;
  const summaryBlock = (pStatus && pStatus !== 'not_applicable' && pStatus !== 'disabled')
    ? `<div class="ts-card-summary-slot" id="todo-progress-summary-${refType}-${item.id}"></div>` : '';
  return lineBlock + summaryBlock;
}

// Nach jedem Rendern der Todo-Übersicht aufzurufen: hängt die von
// TSProgress bereitgestellten Card-Summary-Mounts in die zuvor als leere
// Platzhalter gerenderten Slots ein (Konvention wie bei bestehenden
// Platzhaltern, z.B. reentry-banner-${id}).
function mountTodoCardSummaries(items) {
  if (!window.TSProgress || typeof TSProgress.mountCardSummary !== 'function') return;
  for (const { refType, item } of items) {
    const dStatus = item.aiSummary?.description?.status || null;
    const descSlot = document.getElementById(`todo-desc-summary-${refType}-${item.id}`);
    if (descSlot) {
      TSProgress.mountCardSummary(descSlot, {
        refType, refId: item.id, kind: 'description',
        summary: item.aiSummary.description,
        onRegenerate: () => TSHost.progress.regenerateSummary('description', refType, item.id),
      });
    }
    const pStatus = item.aiSummary?.progress?.status || null;
    const progSlot = document.getElementById(`todo-progress-summary-${refType}-${item.id}`);
    if (progSlot) {
      TSProgress.mountCardSummary(progSlot, {
        refType, refId: item.id, kind: 'progress',
        summary: item.aiSummary.progress,
        onRegenerate: () => TSHost.progress.regenerateSummary('progress', refType, item.id),
      });
    }
  }
}

// ── Zwischenstand bearbeiten (eigenständiger Dialog für vorhandene
// Fortschritts-Einträge; Neueinträge laufen ausschließlich über den
// Inline-Composer, siehe mountCardComposer/mountTodoProgressArea). ────
let progressEntryDialogCtx = null; // { refType, refId, entryId, savedHtml, onSaved }

function openProgressEntryDialog(refType, refId, entryId, initialHtml, contextDescriptionHtml, onSaved) {
  if (!isValidProgressRef(refType, refId)) {
    toast('Zwischenstand konnte nicht geöffnet werden (ungültige Referenz)', 'error');
    return;
  }
  progressEntryDialogCtx = {
    refType, refId, entryId: entryId || null, savedHtml: initialHtml || '',
    onSaved: typeof onSaved === 'function' ? onSaved : null,
  };
  setRT('progress-entry-body', initialHtml || '');
  updateProgressEntryCharHint();
  const ctx = document.getElementById('progress-entry-context');
  const excerpt = plainTextExcerpt(contextDescriptionHtml || '', 160);
  if (excerpt) { ctx.textContent = excerpt; ctx.style.display = ''; }
  else { ctx.textContent = ''; ctx.style.display = 'none'; } // NIE eine leere Kontext-Fläche ohne Inhalt anzeigen
  document.getElementById('progress-entry-error').style.display = 'none';
  document.getElementById('progress-entry-delete-btn').style.display = entryId ? '' : 'none';
  document.getElementById('progress-entry-modal').style.display = 'flex';
}

function closeProgressEntryDialog() {
  document.getElementById('progress-entry-modal').style.display = 'none';
  progressEntryDialogCtx = null;
}

function progressEntryOverlayClick(e) {
  if (e.target.id !== 'progress-entry-modal') return;
  closeProgressEntryDialog();
}

function updateProgressEntryCharHint() {
  const len = getRT('progress-entry-body').replace(/<[^>]*>/g, '').length;
  document.getElementById('progress-entry-char-hint').textContent = `${len} / 5.000 Zeichen (ungefähr)`;
}

async function submitProgressEntryDialog() {
  if (!progressEntryDialogCtx) return;
  const { refType, refId, entryId } = progressEntryDialogCtx;
  if (!isValidProgressRef(refType, refId)) { closeProgressEntryDialog(); return; }
  const body = getRT('progress-entry-body');
  const errEl = document.getElementById('progress-entry-error');
  errEl.style.display = 'none';
  if (!body) { errEl.textContent = 'Bitte einen Zwischenstand eingeben.'; errEl.style.display = ''; return; }
  setBusy('progress-entry-save-btn', true);
  const onSaved = progressEntryDialogCtx.onSaved;
  try {
    const result = entryId
      ? await api('PUT', `/progress/${refType}/${refId}/entries/${entryId}`, { body })
      : await api('POST', `/progress/${refType}/${refId}/entries`, { body });
    closeProgressEntryDialog();
    if (onSaved) onSaved(result); else await onTodoProgressEntrySaved(refType, refId, result);
  } catch (e) {
    errEl.textContent = e.message || 'Speichern fehlgeschlagen';
    errEl.style.display = '';
  } finally { setBusy('progress-entry-save-btn', false); }
}

async function deleteProgressEntryDialog() {
  if (!progressEntryDialogCtx || !progressEntryDialogCtx.entryId) return;
  const { refType, refId, entryId, onSaved } = progressEntryDialogCtx;
  if (!isValidProgressRef(refType, refId)) { closeProgressEntryDialog(); return; }
  const ok = await genericConfirm('Zwischenstand löschen?', 'Dieser Eintrag wird unwiderruflich gelöscht.', 'Löschen', 'Abbrechen');
  if (!ok) return;
  try {
    await api('DELETE', `/progress/${refType}/${refId}/entries/${entryId}`);
    closeProgressEntryDialog();
    if (onSaved) onSaved(); else await onTodoProgressEntrySaved(refType, refId);
  } catch (e) { toast(e.message || 'Löschen fehlgeschlagen', 'error'); }
}

// ── Utils ────────────────────────────────────────────────────
const getMeeting = id => meetings.find(m => m.id === id);
const getTopic   = (mid, tid) => getMeeting(mid)?.topics.find(t => t.id === tid);

function nowLocal() {
  const n = new Date();
  return new Date(n - n.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '';
  return new Date(s).toLocaleString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function fmtDateOnly(s) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric' });
}
function fmtSnoozeLabel(s) {
  if (!s) return '';
  return s.length > 10 ? fmtDateTime(s) : fmtDateOnly(s);
}
// ── Paste-Bereinigung ─────────────────────────────────────────
// Behält: b/strong, i/em, u, a, ul/ol/li, p, br, table/tr/th/td, h1-h6
// Entfernt: style-Attribute, class-Attribute, MS-Office-Tags, Scripts usw.
function cleanPastedHtml(rawHtml) {
  const ALLOWED_TAGS = new Set([
    'b','strong','i','em','u','s','strike',
    'p','br','div','span',
    'ul','ol','li',
    'a',
    'table','thead','tbody','tr','th','td',
    'h1','h2','h3','h4','h5','h6',
    'blockquote','pre','code',
  ]);
  const ALLOWED_ATTRS = { a: ['href','target'], td: ['colspan','rowspan'], th: ['colspan','rowspan'] };

  const tmp = document.createElement('div');
  tmp.innerHTML = rawHtml;

  function walk(node) {
    const children = [...node.childNodes];
    for (const child of children) {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }

      const tag = child.tagName.toLowerCase();

      // Nicht erlaubte Tags: Inhalt behalten, Tag entfernen
      if (!ALLOWED_TAGS.has(tag)) {
        // Block-artige Container: durch br ersetzen damit Zeilenumbruch erhalten bleibt
        const isBlock = /^(div|p|table|tr|td|th|h[1-6]|blockquote|li)$/.test(tag);
        const frag = document.createDocumentFragment();
        walk(child);
        while (child.firstChild) frag.appendChild(child.firstChild);
        child.replaceWith(frag);
        continue;
      }

      // Erlaubte Attribute bereinigen
      const keep = ALLOWED_ATTRS[tag] || [];
      [...child.attributes].forEach(attr => {
        if (!keep.includes(attr.name)) child.removeAttribute(attr.name);
      });
      // Externe Links: target=_blank setzen, javascript-hrefs entfernen
      if (tag === 'a') {
        const href = child.getAttribute('href') || '';
        if (/^javascript:/i.test(href)) child.removeAttribute('href');
        else child.setAttribute('target', '_blank');
      }

      walk(child);
    }
  }

  walk(tmp);

  // Aufräumen: mehrfache leere <br> / <p> zusammenfassen
  let result = tmp.innerHTML
    .replace(/(<br\s*\/?>){3,}/gi, '<br><br>')
    .replace(/(<p>\s*<\/p>){2,}/gi, '<p></p>')
    .trim();

  return result || '';
}

function fmtLastActive(s) {
  if (!s) return '<span style="color:var(--text-light)">—</span>';
  const diff = Date.now() - new Date(s).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  let rel;
  if (mins  <  2) rel = 'gerade eben';
  else if (mins  < 60) rel = `vor ${mins} Min.`;
  else if (hours < 24) rel = `vor ${hours} Std.`;
  else if (days  <  2) rel = 'gestern';
  else if (days  <  7) rel = `vor ${days} Tagen`;
  else if (days  < 31) rel = `vor ${Math.floor(days/7)} Wo.`;
  else                 rel = fmtDate(s);
  const exact = fmtDateTime(s);
  const color = days >= 30 ? 'var(--text-light)' : days >= 7 ? 'var(--text-muted)' : 'var(--text)';
  return `<span style="color:${color}" title="${exact}">${rel}</span>`;
}

function isSnoozed(t) {
  if (!t.snoozedUntil) return false;
  if (t.snoozedUntil.length > 10) return new Date(t.snoozedUntil).getTime() > Date.now();
  return t.snoozedUntil.slice(0, 10) > new Date().toISOString().slice(0, 10);
}
function dueDateClass(s) {
  if (!s) return '';
  const today = new Date().toISOString().slice(0, 10);
  const due = s.slice(0, 10);
  if (due < today) return 'due-overdue';
  if (due === today) return 'due-today';
  return '';
}
function dueDateSuffix(s) {
  if (!s) return '';
  const today = new Date().toISOString().slice(0, 10);
  const due = s.slice(0, 10);
  if (due < today) {
    const [y,m,d] = due.split('-').map(Number);
    const [ty,tm,td] = today.split('-').map(Number);
    const days = Math.round((Date.UTC(ty,tm-1,td) - Date.UTC(y,m-1,d)) / 86400000);
    return ` · ${days} Tag${days===1?'':'e'} überfällig`;
  }
  if (due === today) return ' · heute';
  return '';
}
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function nlBr(s) { return escHtml(s).replace(/\n/g,'<br>'); }

// Für Werte, die als String-Literal in ein Inline-onclick-Attribut eingebettet werden
// (z. B. onclick="foo('${escJsAttr(title)}')"): escHtml() allein reicht hier NICHT,
// weil der HTML-Parser Entities im Attributwert dekodiert, BEVOR der Inhalt als
// JavaScript geparst wird — ein einfaches Anführungszeichen käme unverändert wieder
// heraus und würde aus dem String ausbrechen. \uXXXX-Escapes überleben die
// HTML-Entity-Dekodierung unverändert und sind daher sowohl HTML- als auch JS-sicher.
function escJsAttr(s) {
  return String(s || '').replace(/[\\'"<>&\n\r]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ── Rich-Text helpers ────────────────────────────────────────
function sanitizeHtml(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('script,iframe,object,embed,style,form,base,meta,link').forEach(el => el.remove());
  d.querySelectorAll('*').forEach(el => {
    // Remove all event handlers and style attributes
    [...el.attributes].forEach(a => {
      if (/^on/i.test(a.name) || a.name === 'style') el.removeAttribute(a.name);
    });
    // Sanitize href/src/action: block javascript:, vbscript:, data: protocols.
    // Ausnahme: data:image/(png|jpeg|gif|webp) im src eines <img> ist erlaubt
    // (Quick-Capture/Editor betten Bilder als Data-URI ein, siehe rtInsertImage) -
    // spiegelt die serverseitige Allowlist in lib/sanitize.js.
    for (const attr of ['href', 'src', 'action', 'formaction']) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      const isAllowedImageData = el.tagName === 'IMG' && attr === 'src' &&
        /^data:image\/(png|jpeg|gif|webp)[;,]/i.test(val);
      if (!isAllowedImageData && /^\s*(?:javascript|vbscript|data)\s*:/i.test(val)) el.removeAttribute(attr);
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return d.innerHTML;
}

function displayHtml(s) {
  if (!s) return '';
  return /<[a-zA-Z]/.test(s) ? sanitizeHtml(s) : nlBr(s);
}

function getRT(id) {
  const el = document.getElementById(id);
  const h = el.innerHTML.trim();
  return (h === '' || h === '<br>' || h === '<div><br></div>') ? '' : h;
}

function setRT(id, val) {
  const el = document.getElementById(id);
  if (!val) { el.innerHTML = ''; return; }
  el.innerHTML = /<[a-zA-Z]/.test(val) ? sanitizeHtml(val) : escHtml(val).replace(/\n/g, '<br>');
}

let _rtSel = null, _rtRange = null;
function _saveSelection() {
  const s = window.getSelection();
  _rtSel = s; _rtRange = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
}
function _restoreSelection() {
  if (_rtSel && _rtRange) { _rtSel.removeAllRanges(); _rtSel.addRange(_rtRange); }
}
function rtCmd(cmd) {
  _restoreSelection();
  document.execCommand(cmd, false, null);
}
// ── Link-Dialog (Rich-Text: "nur Link" vs. "Link + KI-Zusammenfassung") ──
// Ersetzt die frühere prompt()-basierte rtLink(). Konsumiert die Backend-
// Endpunkte POST /api/ai/link/fetch und POST /api/ai/link/summarize.
//
// Wichtig: das gespeicherte Selection-Range wird bewusst NICHT im globalen
// _rtRange gehalten (das würde bei parallelem Weiterarbeiten im Editor
// während der Dialog offen ist überschrieben), sondern lokal in
// _rtLinkState geklont — siehe openLinkModal().
let _rtLinkState = null;

function _rtLinkDefaultMode() {
  if (!aiFeatureOn('link_summary')) return 'link';
  const stored = localStorage.getItem('ts.link.mode');
  return stored === 'link_summary' ? 'link_summary' : 'link';
}
function _rtLinkDefaultLength() {
  const stored = localStorage.getItem('ts.link.length');
  return (stored === 'short' || stored === 'medium' || stored === 'long') ? stored : 'medium';
}

function openLinkModal(triggerEl) {
  // _rtSel/_rtRange wurden bereits im onmousedown des Toolbar-Buttons per
  // _saveSelection() gesetzt (Standardmuster dieser Toolbar) — hier lokal
  // klonen, damit spätere Editor-Interaktionen den Dialog-State nicht mehr
  // beeinflussen können.
  _rtLinkState = {
    savedSel: _rtSel,
    savedRange: _rtRange ? _rtRange.cloneRange() : null,
    selectedText: _rtRange ? _rtRange.toString().trim() : '',
    opId: 0,
    controller: null,
    loadingTimer: null,
    pageToken: null,
    finalUrl: '',
    title: '',
    summary: '',
    mode: _rtLinkDefaultMode(),
    length: _rtLinkDefaultLength(),
    phase: 'idle', // idle | loading-pending | loading | preview
    triggerEl: triggerEl || null,
  };

  const urlInput = document.getElementById('rt-link-url');
  urlInput.value = '';
  hideLinkUrlError();

  const featureOn = aiFeatureOn('link_summary');
  const summaryRadio = document.getElementById('rt-link-mode-summary');
  summaryRadio.disabled = !featureOn;
  document.getElementById('rt-link-mode-hint').style.display = featureOn ? 'none' : '';
  document.getElementById('rt-link-mode-link').checked = _rtLinkState.mode === 'link';
  summaryRadio.checked = _rtLinkState.mode === 'link_summary';

  setLinkLengthUi(_rtLinkState.length);
  setLinkAiStatus('');
  document.getElementById('rt-link-progress').style.display = 'none';
  document.getElementById('rt-link-preview').style.display = 'none';
  renderLinkModalPhase();

  document.getElementById('rt-link-modal').style.display = 'flex';
  setTimeout(() => urlInput.focus(), 50);
}

function closeLinkModal() {
  const st = _rtLinkState;
  if (st) {
    st.opId += 1;
    if (st.controller) st.controller.abort();
    if (st.loadingTimer) clearTimeout(st.loadingTimer);
  }
  document.getElementById('rt-link-modal').style.display = 'none';
  _rtLinkState = null;
  if (st && st.triggerEl && document.body.contains(st.triggerEl)) st.triggerEl.focus();
}

function _rtLinkRestoreSelection() {
  const st = _rtLinkState;
  if (st && st.savedSel && st.savedRange) {
    st.savedSel.removeAllRanges();
    st.savedSel.addRange(st.savedRange);
  }
}

function normalizeLinkUrl(raw) {
  const url = (raw || '').trim();
  if (!url) return '';
  return /:\/\//.test(url) ? url : 'https://' + url;
}
function validateLinkUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !!u.hostname;
  } catch (_) {
    return false;
  }
}
function showLinkUrlError(msg) {
  const el = document.getElementById('rt-link-url-error');
  el.textContent = msg;
  el.style.display = '';
}
function hideLinkUrlError() {
  const el = document.getElementById('rt-link-url-error');
  el.textContent = '';
  el.style.display = 'none';
}
function setLinkAiStatus(msg, isError) {
  const el = document.getElementById('rt-link-ai-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--red)' : '';
}
function setLinkLengthUi(length) {
  document.querySelectorAll('#rt-link-length-group .rt-link-length-btn').forEach(b => {
    const active = b.dataset.length === length;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}
function onLinkLengthChange(len) {
  if (!_rtLinkState) return;
  _rtLinkState.length = len;
  setLinkLengthUi(len);
}

function onLinkUrlInput() {
  hideLinkUrlError();
  const st = _rtLinkState;
  if (!st) return;
  // Eine geänderte URL macht einen zuvor abgerufenen page_token ungültig -
  // erzwingt bei erneutem "Zusammenfassung erzeugen" einen frischen fetch.
  if (st.pageToken || st.phase !== 'idle') {
    st.opId += 1;
    if (st.controller) st.controller.abort();
    if (st.loadingTimer) clearTimeout(st.loadingTimer);
    st.pageToken = null; st.finalUrl = ''; st.title = ''; st.summary = '';
    st.phase = 'idle';
    renderLinkModalPhase();
    setLinkAiStatus('');
  }
}

function renderLinkModalPhase() {
  const st = _rtLinkState;
  if (!st) return;
  const modeInput = document.querySelector('input[name="rt-link-mode"]:checked');
  st.mode = modeInput ? modeInput.value : 'link';

  const summaryFields = document.getElementById('rt-link-summary-fields');
  const progress      = document.getElementById('rt-link-progress');
  const preview       = document.getElementById('rt-link-preview');
  const onlyBtn       = document.getElementById('rt-link-only-btn');
  const submitBtn     = document.getElementById('rt-link-submit-btn');

  summaryFields.style.display = st.mode === 'link_summary' ? '' : 'none';
  progress.style.display = (st.mode === 'link_summary' && (st.phase === 'loading')) ? '' : 'none';
  preview.style.display  = (st.mode === 'link_summary' && st.phase === 'preview') ? '' : 'none';

  if (st.mode !== 'link_summary') {
    onlyBtn.style.display = 'none';
    submitBtn.style.display = '';
    submitBtn.textContent = 'Link einfügen';
    submitBtn.disabled = false;
  } else {
    onlyBtn.style.display = '';
    if (st.phase === 'preview') {
      submitBtn.style.display = 'none';
    } else {
      submitBtn.style.display = '';
      const busy = st.phase === 'loading' || st.phase === 'loading-pending';
      submitBtn.textContent = busy ? 'Erzeuge …' : 'Zusammenfassung erzeugen';
      submitBtn.disabled = busy;
    }
  }

  if (st.mode === 'link_summary' && st.phase === 'preview') {
    document.getElementById('rt-link-preview-text').innerHTML = escHtml(st.summary).replace(/\n/g, '<br>');
  }
}

// Dünner fetch()-Wrapper analog api(), aber mit AbortSignal-Unterstützung
// (für den "Abbrechen"-Button im Ladezustand) und mit err.code/err.body,
// damit der 428/402-Confirm-Flow (analog aiCall()) ausgewertet werden kann.
async function linkApiFetch(method, path, body, signal) {
  const opts = { method, credentials: 'same-origin', signal };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(API + path, opts);
  if (res.status === 401) { handleSessionExpiry(); throw new Error('Sitzung abgelaufen'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Fehler');
    err.status = res.status; err.code = data.code; err.body = data;
    throw err;
  }
  return data;
}

const RT_LINK_ERROR_TEXT = {
  invalid_url:              'Die eingegebene URL ist ungültig.',
  blocked_target:           'Diese Adresse kann aus Sicherheitsgründen nicht abgerufen werden.',
  fetch_in_progress:        'Für diese Seite läuft bereits ein Abruf. Bitte kurz warten.',
  budget_exceeded:          'Monatliches AI-Budget erschöpft.',
  too_large:                'Die Seite ist zu groß, um sie zusammenzufassen.',
  unsupported_content_type: 'Dieser Inhaltstyp wird nicht unterstützt.',
  no_text_content:          'Auf der Seite konnte kein Text gefunden werden.',
  fetch_http_error:         'Die Seite konnte nicht abgerufen werden (Fehler beim Laden).',
  too_many_redirects:       'Zu viele Weiterleitungen beim Abrufen der Seite.',
  fetch_failed:             'Die Seite konnte nicht abgerufen werden.',
  fetch_timeout:            'Der Abruf der Seite hat zu lange gedauert (Zeitüberschreitung).',
  invalid_length:           'Ungültige Länge ausgewählt.',
  page_token_expired:       'Der Seiteninhalt ist nicht mehr verfügbar, bitte erneut laden',
  empty_summary:            'Die Zusammenfassung ist leer ausgefallen.',
};
function mapLinkApiError(e) {
  if (e.status === 409) return e.message || 'Feature deaktiviert.';
  if (e.code && RT_LINK_ERROR_TEXT[e.code]) return RT_LINK_ERROR_TEXT[e.code];
  if (e.status === 503) return 'Die KI ist gerade nicht erreichbar. Bitte später erneut versuchen.';
  return e.message || 'Unbekannter Fehler.';
}

function linkFetchApi(url, signal) {
  return linkApiFetch('POST', '/ai/link/fetch', { url }, signal);
}
function linkSummarizeApi(pageToken, length, signal, confirmed) {
  const path = '/ai/link/summarize' + (confirmed ? '?confirm=true' : '');
  return linkApiFetch('POST', path, { page_token: pageToken, length }, signal);
}

function _rtLinkArmLoadingIndicator(myOpId) {
  const st = _rtLinkState;
  st.phase = 'loading-pending';
  renderLinkModalPhase();
  st.loadingTimer = setTimeout(() => {
    if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
    _rtLinkState.phase = 'loading';
    renderLinkModalPhase();
  }, 1000);
}

async function startLinkSummary() {
  const st = _rtLinkState;
  if (!st) return;
  const urlRaw = document.getElementById('rt-link-url').value;
  const url = normalizeLinkUrl(urlRaw);
  if (!validateLinkUrl(url)) {
    showLinkUrlError('Bitte eine gültige URL eingeben (z. B. https://example.com).');
    return;
  }
  hideLinkUrlError();
  setLinkAiStatus('');

  st.opId += 1;
  const myOpId = st.opId;
  st.controller = new AbortController();
  _rtLinkArmLoadingIndicator(myOpId);

  try {
    const fetchRes = await linkFetchApi(url, st.controller.signal);
    if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
    st.pageToken = fetchRes.page_token;
    st.finalUrl = fetchRes.final_url || url;
    st.title = fetchRes.title || '';
    await requestSummary(myOpId);
  } catch (e) {
    if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
    if (e.name === 'AbortError') return;
    clearTimeout(st.loadingTimer);
    st.phase = 'idle';
    renderLinkModalPhase();
    setLinkAiStatus(mapLinkApiError(e), true);
  }
}

async function requestSummary(myOpId) {
  const st = _rtLinkState;
  if (!st) return;
  try {
    const data = await linkSummarizeApi(st.pageToken, st.length, st.controller.signal, false);
    if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
    finishSummarySuccess(data);
  } catch (e) {
    if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
    if (e.name === 'AbortError') return;
    if (e.status === 428) {
      const det = e.body?.detail || {};
      const cents = det.estimated_cost_cents | 0;
      const thr = det.threshold_cents | 0;
      clearTimeout(st.loadingTimer);
      st.phase = 'idle';
      renderLinkModalPhase();
      const ok = confirm(`Geschätzte Kosten: ${(cents/100).toFixed(2)} € (Schwelle: ${(thr/100).toFixed(2)} €).\nFortfahren?`);
      if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
      if (!ok) { setLinkAiStatus('Abgebrochen.'); return; }
      _rtLinkArmLoadingIndicator(myOpId);
      try {
        const data2 = await linkSummarizeApi(st.pageToken, st.length, st.controller.signal, true);
        if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
        finishSummarySuccess(data2);
      } catch (e2) {
        if (!_rtLinkState || _rtLinkState.opId !== myOpId) return;
        if (e2.name === 'AbortError') return;
        clearTimeout(st.loadingTimer);
        st.phase = 'idle';
        renderLinkModalPhase();
        setLinkAiStatus(mapLinkApiError(e2), true);
      }
      return;
    }
    clearTimeout(st.loadingTimer);
    st.phase = 'idle';
    renderLinkModalPhase();
    setLinkAiStatus(mapLinkApiError(e), true);
  }
}

function finishSummarySuccess(data) {
  const st = _rtLinkState;
  if (!st) return;
  clearTimeout(st.loadingTimer);
  st.summary = data.summary || '';
  st.phase = 'preview';
  renderLinkModalPhase();
  setLinkAiStatus(data.truncated ? 'Hinweis: Die Zusammenfassung wurde gekürzt.' : '');
}

async function regenerateSummary() {
  const st = _rtLinkState;
  if (!st || !st.pageToken) return;
  st.opId += 1;
  const myOpId = st.opId;
  st.controller = new AbortController();
  setLinkAiStatus('');
  _rtLinkArmLoadingIndicator(myOpId);
  await requestSummary(myOpId);
}

function cancelLinkLoading() {
  const st = _rtLinkState;
  if (!st) return;
  st.opId += 1;
  if (st.controller) st.controller.abort();
  if (st.loadingTimer) clearTimeout(st.loadingTimer);
  st.phase = 'idle';
  renderLinkModalPhase();
  setLinkAiStatus('Vorgang abgebrochen.');
}

function discardPreview() {
  const st = _rtLinkState;
  if (!st) return;
  st.phase = 'idle';
  st.summary = '';
  renderLinkModalPhase();
  setLinkAiStatus('');
}

function buildLinkOnlyHtml(finalUrl, linkText) {
  return `<p><a href="${escHtml(finalUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(linkText)}</a></p>`;
}

function submitLinkOnly() {
  const st = _rtLinkState;
  if (!st) return;
  const urlRaw = document.getElementById('rt-link-url').value;
  const url = normalizeLinkUrl(urlRaw);
  if (!validateLinkUrl(url)) {
    showLinkUrlError('Bitte eine gültige URL eingeben (z. B. https://example.com).');
    return;
  }
  hideLinkUrlError();
  const finalUrl = st.finalUrl || url;
  const linkText = st.selectedText || st.title || finalUrl;
  const html = buildLinkOnlyHtml(finalUrl, linkText);

  st.opId += 1; // spätere Ergebnisse eines laufenden AI-Aufrufs nicht mehr einfügen
  if (st.controller) st.controller.abort();

  _rtLinkRestoreSelection();
  document.execCommand('insertHTML', false, html);
  closeLinkModal();
}

function submitLinkAction() {
  const st = _rtLinkState;
  if (!st) return;
  if (st.mode === 'link_summary') startLinkSummary();
  else submitLinkOnly();
}

function applyPreview() {
  const st = _rtLinkState;
  if (!st || st.phase !== 'preview') return;
  const url = normalizeLinkUrl(document.getElementById('rt-link-url').value);
  const finalUrl = st.finalUrl || url;
  const linkText = st.title || finalUrl;
  let html = buildLinkOnlyHtml(finalUrl, linkText);
  const paragraphs = (st.summary || '').split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  paragraphs.forEach((p, i) => {
    html += i === 0
      ? `<p><em>✨ KI-Zusammenfassung:</em> ${escHtml(p)}</p>`
      : `<p>${escHtml(p)}</p>`;
  });

  _rtLinkRestoreSelection();
  document.execCommand('insertHTML', false, html);
  localStorage.setItem('ts.link.mode', 'link_summary');
  localStorage.setItem('ts.link.length', st.length);
  closeLinkModal();
}

// Fügt eine Tabelle an der Cursorposition ein.
function rtTable() {
  _restoreSelection();
  const rowsIn = prompt('Zeilen (inkl. Kopfzeile):', '3');
  if (!rowsIn) return;
  const colsIn = prompt('Spalten:', '3');
  if (!colsIn) return;
  const rows = Math.max(1, Math.min(20, parseInt(rowsIn, 10) || 0));
  const cols = Math.max(1, Math.min(10, parseInt(colsIn, 10) || 0));
  const headCells = Array.from({length: cols}, (_, i) => `<th>Spalte ${i+1}</th>`).join('');
  let body = '';
  for (let r = 1; r < rows; r++) {
    body += '<tr>' + Array.from({length: cols}, () => '<td>&nbsp;</td>').join('') + '</tr>';
  }
  const html = `<table><thead><tr>${headCells}</tr></thead><tbody>${body}</tbody></table><p><br></p>`;
  _restoreSelection();
  document.execCommand('insertHTML', false, html);
}

// Bilder werden als Anhang hochgeladen (siehe Attachments) und per <img> referenziert.
// Setzt/entfernt die refType/refId-Zuordnung, an die ein Editor-Feld gerade Bilder hochladen darf.
let _rtImageRefs = {};
function setRtImageRef(editorId, refType, refId) { _rtImageRefs[editorId] = { refType, refId }; }
function clearRtImageRef(editorId) { delete _rtImageRefs[editorId]; }

function rtInsertImage(editorId) {
  const ref = _rtImageRefs[editorId];
  _saveSelection();
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (!ref) {
      // Noch keine gespeicherte Seite -> Bild als komprimiertes Data-URI direkt einbetten.
      try {
        const dataUrl = await downscaleImageToDataUrl(file, 1200, 0.8);
        _restoreSelection();
        document.execCommand('insertHTML', false, `<img src="${dataUrl}" alt="${escHtml(file.name)}" style="max-width:100%">`);
        if (typeof kbUpdateContentCounter === 'function') kbUpdateContentCounter();
        toast('Bild eingefügt (wird beim Speichern mitgesichert)');
      } catch (e) { toast(`Bild konnte nicht eingefügt werden: ${e.message}`, 'error'); }
      return;
    }
    try {
      const base = window.__TS_BASE__ || '';
      const resp = await fetch(`${base}/api/attachments/${ref.refType}/${ref.refId}?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (resp.status === 401) { handleSessionExpiry(); throw new Error('Sitzung abgelaufen'); }
      if (!resp.ok) { const t = await resp.text(); throw new Error(t || resp.statusText); }
      const att = await resp.json();
      _restoreSelection();
      document.execCommand('insertHTML', false,
        `<img src="${base}/api/attachments/download/${att.id}" alt="${escHtml(file.name)}" style="max-width:100%">`);
      const key = `${ref.refType}/${ref.refId}`;
      if (attachCache[key]) {
        attachCache[key].push(att);
        renderAttachSection(ref.refType, ref.refId);
        updateAttachBadge(ref.refType, ref.refId);
      }
      toast('Bild eingefügt');
    } catch(e) { toast(`Bild-Upload fehlgeschlagen: ${e.message}`, 'error'); }
  };
  input.click();
}

// Skaliert ein Bild client-seitig auf maxWidth herunter, liefert ein JPEG-Data-URI
// (haelt den Knowledge-Content unter MAX_KNOWLEDGE_CONTENT, siehe lib/sanitize.js).
function downscaleImageToDataUrl(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.onload = () => {
      img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let _rtColorPickerEl = null;
function _rtShowColorPicker(anchor) {
  if (_rtColorPickerEl) { _rtColorPickerEl.remove(); _rtColorPickerEl = null; return; }
  // Kanonische Quelle dieser Hex-Werte: lib/colors.js PALETTE. index.html
  // laeuft im Browser (kein require von Server-Code), deshalb hier dupliziert -
  // bei Aenderungen an der Palette IMMER beide Stellen synchron halten.
  const SWATCHES = [
    { color: null,      bg:'#fff',     border:'1.5px solid #ccc', text:'✕', label:'Farbe entfernen' },
    { color: '#dc2626', bg:'#dc2626',  label:'Rot' },
    { color: '#c2410c', bg:'#c2410c',  label:'Orange' },
    { color: '#a16207', bg:'#a16207',  label:'Gelb' },
    { color: '#15803d', bg:'#15803d',  label:'Grün' },
    { color: '#2563eb', bg:'#2563eb',  label:'Blau' },
    { color: '#7c3aed', bg:'#7c3aed',  label:'Violett' },
    { color: '#6b7280', bg:'#6b7280',  label:'Grau' },
  ];
  const pop = document.createElement('div');
  pop.className = 'rt-color-popup';
  SWATCHES.forEach(({ color, bg, border, text, label }) => {
    const sw = document.createElement('button');
    sw.type = 'button'; sw.className = 'rt-color-swatch'; sw.title = label;
    sw.style.background = bg;
    if (border) sw.style.border = border;
    if (text) { sw.textContent = text; sw.style.color = '#666'; }
    sw.onmousedown = e => e.preventDefault();
    sw.onclick = () => {
      _restoreSelection();
      // Erzeugt <span style="color:..."> statt <font color="...">, damit die
      // Farbe den Allowlist-Sanitizer (lib/sanitize.js) beim Speichern
      // uebersteht - siehe Arbeitspaket 7.
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('foreColor', false, color || '#1A1918');
      pop.remove(); _rtColorPickerEl = null;
    };
    pop.appendChild(sw);
  });
  const rect = anchor.getBoundingClientRect();
  pop.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:9999`;
  document.body.appendChild(pop);
  _rtColorPickerEl = pop;
  setTimeout(() => {
    document.addEventListener('click', function close() {
      pop.remove(); _rtColorPickerEl = null;
      document.removeEventListener('click', close);
    }, { once: true });
  }, 0);
}

function initRtToolbar(tbId, editorId, opts = {}) {
  const tb = document.getElementById(tbId);
  const ed = document.getElementById(editorId);
  if (!tb || !ed) return;
  const btn = (label, title, cmd) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rt-btn'; b.title = title; b.innerHTML = label;
    b.onmousedown = e => { e.preventDefault(); _saveSelection(); };
    b.onclick = () => rtCmd(cmd);
    return b;
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'rt-sep'; return d; };
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button'; linkBtn.className = 'rt-btn'; linkBtn.title = 'Link einfügen'; linkBtn.innerHTML = '🔗 Link';
  linkBtn.onmousedown = e => { e.preventDefault(); _saveSelection(); };
  linkBtn.onclick = () => openLinkModal(linkBtn);

  const tableBtn = document.createElement('button');
  tableBtn.type = 'button'; tableBtn.className = 'rt-btn'; tableBtn.title = 'Tabelle einfügen'; tableBtn.innerHTML = '📊 Tabelle';
  tableBtn.onmousedown = e => { e.preventDefault(); _saveSelection(); };
  tableBtn.onclick = rtTable;

  const colorBtn = document.createElement('button');
  colorBtn.type = 'button'; colorBtn.className = 'rt-btn'; colorBtn.title = 'Textfarbe';
  colorBtn.innerHTML = '<span style="border-bottom:2.5px solid #dc2626;padding-bottom:1px;font-weight:bold">A</span>';
  colorBtn.onmousedown = e => { e.preventDefault(); _saveSelection(); };
  colorBtn.onclick = e => { e.stopPropagation(); _rtShowColorPicker(colorBtn); };

  const items = [
    btn('<b>B</b>', 'Fett (Strg+B)', 'bold'),
    btn('<i>I</i>', 'Kursiv (Strg+I)', 'italic'),
    btn('<u>U</u>', 'Unterstrichen (Strg+U)', 'underline'),
    sep(),
    btn('• Liste', 'Aufzählung', 'insertUnorderedList'),
    sep(),
    linkBtn,
    tableBtn,
  ];
  if (opts.imageButton) {
    const imgBtn = document.createElement('button');
    imgBtn.type = 'button'; imgBtn.className = 'rt-btn'; imgBtn.title = 'Bild einfügen'; imgBtn.innerHTML = '🖼️ Bild';
    imgBtn.onmousedown = e => { e.preventDefault(); _saveSelection(); };
    imgBtn.onclick = () => rtInsertImage(editorId);
    items.push(imgBtn);
  }
  items.push(sep(), colorBtn);
  tb.append(...items);

  ed.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Default browser behaviour is fine; prevent double-<div> in some browsers
    }
  });

  // ── Paste-Bereinigung: Outlook/Word-Markup entfernen ─────────
  ed.addEventListener('paste', e => {
    e.preventDefault();
    const clipHtml  = e.clipboardData.getData('text/html');
    const clipPlain = e.clipboardData.getData('text/plain');

    let html;
    if (clipHtml) {
      html = cleanPastedHtml(clipHtml);
    } else {
      // Reines Plaintext: Zeilenumbrüche in <br> wandeln
      html = clipPlain
        .split(/\r?\n/)
        .map(l => l ? escHtml(l) : '<br>')
        .join('<br>');
    }
    // An Cursor-Position einfügen
    document.execCommand('insertHTML', false, html);
  });

  // ── Drag-to-resize handles ────────────────────────────────
  const wrapper = ed.closest('.rt-wrapper');
  if (!wrapper) return;

  // Outer wrapper für Eck-Handle (außerhalb overflow:hidden)
  let outer = wrapper.parentElement;
  if (!outer.classList.contains('rt-wrapper-outer')) {
    const div = document.createElement('div');
    div.className = 'rt-wrapper-outer';
    wrapper.parentNode.insertBefore(div, wrapper);
    div.appendChild(wrapper);
    outer = div;
  }

  // Unterer Balken — nur vertikal
  if (!wrapper.querySelector('.rt-resize-handle')) {
    const bar = document.createElement('div');
    bar.className = 'rt-resize-handle';
    bar.title = 'Ziehen um Höhe anzupassen';
    wrapper.appendChild(bar);

    bar.addEventListener('mousedown', e => {
      e.preventDefault();
      const startY = e.clientY, startH = ed.offsetHeight;
      const move = e => {
        ed.style.height = ed.style.minHeight = '0';
        ed.style.height = Math.max(60, startH + e.clientY - startY) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup',   up);
    });
  }

  // Eck-Handle — vertikal + horizontal (Modal wird breiter)
  if (!outer.querySelector('.rt-resize-corner')) {
    const corner = document.createElement('div');
    corner.className = 'rt-resize-corner';
    corner.title = 'Ziehen um Größe anzupassen';
    outer.appendChild(corner);

    corner.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startH = ed.offsetHeight;
      const modal  = wrapper.closest('.modal');
      const startW = modal ? modal.offsetWidth : null;

      const move = e => {
        // Höhe
        ed.style.height = ed.style.minHeight = '0';
        ed.style.height = Math.max(60, startH + e.clientY - startY) + 'px';
        // Breite (Modal)
        if (modal && startW) {
          const newW = Math.max(400, Math.min(window.innerWidth - 32, startW + e.clientX - startX));
          modal.style.width    = newW + 'px';
          modal.style.maxWidth = 'calc(100vw - 2rem)';
        }
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup',   up);
    });
  }
}
function isPast(s) { return s && new Date(s) < new Date(); }
function recLabel(p) { return {weekly:'Wöchentlich',biweekly:'Zweiwöchentlich',monthly:'Monatlich'}[p] || p; }
function initials(name) { return name.trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase(); }
function advanceDate(s, p) {
  const d = new Date(s);
  if (p==='weekly') d.setDate(d.getDate()+7);
  if (p==='biweekly') d.setDate(d.getDate()+14);
  if (p==='monthly') d.setMonth(d.getMonth()+1);
  return new Date(d - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function rgbToHex(rgb) {
  const m = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  return m ? '#'+[m[1],m[2],m[3]].map(x=>(+x).toString(16).padStart(2,'0')).join('') : rgb;
}

// ── Auth ─────────────────────────────────────────────────────
// `expired: true` blendet den Hinweistext "Sitzung abgelaufen" oberhalb des
// Formulars ein (Story 2: sichtbarer, erklärter Wechsel statt kommentarloser
// Rückkehr zum Login) - der normale Logout-Pfad (doLogout) lässt das Flag
// weg, damit der Hinweis dort NICHT erscheint.
function showLogin({ expired = false } = {}) {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pw').value = '';
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('login-session-expired').style.display = expired ? '' : 'none';
  setTimeout(() => document.getElementById('login-user').focus(), 50);
}

// Schließt JEDES offene Bearbeiten-/Detail-Modal ohne die jeweils dort
// hinterlegte "Verwerfen?"-Rückfrage (z.B. requestCloseTopicModal) - bei
// Sitzungsende ist das gewollt (UX-Vorgabe): der Nutzer sieht sofort den
// Login-Screen samt Erklärtext, statt an einem nicht mehr speicherbaren
// Formular hängen zu bleiben. Generischer Selektor statt einer festen
// Modal-ID-Liste, damit neue Modals automatisch erfasst werden.
function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; });
}

// Zentraler Sitzungsende-Handler für ALLE Stellen, die eine Server-Antwort
// mit HTTP 401 sehen (api(), linkApiFetch(), runExport() sowie die beiden
// rohen fetch()-Attachment-Uploads, die bislang keine 401-Behandlung hatten -
// Story 2 verlangt explizit, dass JEDE 401-Antwort erkannt wird). Ersetzt die
// bisher 3x duplizierte `clearClientSessionState(); showLogin();`-Sequenz.
function handleSessionExpiry() {
  clearClientSessionState();
  closeAllModals();
  showLogin({ expired: true });
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const ini = initials(currentUser.username);
  document.getElementById('nav-avatar').textContent   = ini;
  document.getElementById('nav-username').innerHTML   = `<strong>${escHtml(currentUser.username)}</strong>`;
  const adminEntry = document.getElementById('user-menu-admin');
  if (adminEntry) adminEntry.style.display = currentUser.role === 'admin' ? '' : 'none';
  const backupEntry = document.getElementById('user-menu-backup');
  if (backupEntry) backupEntry.style.display = currentUser.role === 'admin' ? '' : 'none';
  // Addin-Download-Link auf korrekten Basis-Pfad setzen
  const addinLink = document.getElementById('addin-download-link');
  if (addinLink) addinLink.href = (window.__TS_BASE__ || '') + '/addin/manifest.xml';
}

// ── Topic/Todo-Card Overflow-Menü ────────────────────────────
function closeAllOverflow() {
  document.querySelectorAll('details.topic-overflow[open]').forEach(d => d.open = false);
}
document.addEventListener('click', e => {
  // Schließe geöffnete overflow-Menüs wenn außerhalb geklickt wird
  if (e.target.closest('details.topic-overflow')) return;
  closeAllOverflow();
});

// ── User-Dropdown-Menu ───────────────────────────────────────
function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const m = document.getElementById('user-menu');
  if (!m) return;
  // Position above the sidebar-user-area
  const anchor = document.getElementById('sidebar-user-area');
  if (anchor && !m.classList.contains('open')) {
    const rect = anchor.getBoundingClientRect();
    m.style.position = 'fixed';
    m.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    m.style.left = rect.left + 'px';
    m.style.top = 'auto';
    m.style.right = 'auto';
  }
  m.classList.toggle('open');
}
function closeUserMenu() {
  const m = document.getElementById('user-menu');
  if (m) m.classList.remove('open');
}
// Close on outside click
document.addEventListener('click', e => {
  const m = document.getElementById('user-menu');
  if (!m || !m.classList.contains('open')) return;
  if (e.target.closest('#sidebar-user-area') || e.target.closest('#user-menu')) return;
  m.classList.remove('open');
});

let snoozeWakeupsTimer = null;
// Idempotent — sicherer Aufruf sowohl vom Session-Restore-Bootstrap als auch
// von doLogin(), ohne einen zweiten parallelen Timer zu riskieren.
function startSnoozeWakeupsPolling() {
  if (snoozeWakeupsTimer) clearInterval(snoozeWakeupsTimer);
  snoozeWakeupsTimer = setInterval(checkSnoozeWakeups, 30000);
}
function stopSnoozeWakeupsPolling() {
  if (snoozeWakeupsTimer) { clearInterval(snoozeWakeupsTimer); snoozeWakeupsTimer = null; }
}

async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pw').value;
  const errEl    = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Bitte alle Felder ausfüllen'; errEl.style.display = ''; return; }
  setBusy('login-btn', true);
  try {
    currentUser = await api('POST', '/login', { username, password });
    await Promise.all([loadMeetings(), loadTodos(), loadThemes(), loadContacts(), loadKnowledgePages(), loadAiSettings(), loadStack()]);
    await loadDrift();
    showApp(); render();
    loadMomentumBadge().then(render);
    startSnoozeWakeupsPolling();
  } catch(e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { setBusy('login-btn', false); }
}

// Räumt allen nutzergebundenen Client-Zustand ab — muss bei JEDEM Verlassen
// der Sitzung laufen (expliziter Logout UND abgelaufene/ungültige Session
// über den 401-Pfad in api()), sonst überleben In-Memory-Daten und der
// Notification-Timer den Nutzerwechsel auf einem geteilten Gerät.
function clearClientSessionState() {
  stopSnoozeWakeupsPolling();
  const uidForCleanup = currentUser?.id;
  if (uidForCleanup) { try { localStorage.removeItem(`notifiedSnoozes:${uidForCleanup}`); } catch {} }
  currentUser = null; meetings = []; todos = []; selectedId = null;
  // Archiv-Zustand (Arbeitspaket W1) muss ebenfalls hier abgeräumt werden,
  // sonst überleben Archiv-Liste, -Detailansicht und der Suchtreffer-Cache
  // den Nutzerwechsel auf einem geteilten Gerät (Security-Review-Fund).
  archiveState = { items: [], total: 0, q: '', offset: 0, loaded: false, loading: false, error: null };
  archiveDetailState = { id: null, data: null, loading: false, error: null };
  for (const k of Object.keys(_archiveSearchDetailCache)) delete _archiveSearchDetailCache[k];
}

async function doLogout() {
  try { await api('POST', '/logout'); } catch {}
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('ts_kb_draft_'))
      .forEach(k => localStorage.removeItem(k));
  } catch {}
  clearClientSessionState();
  showLogin();
}

async function savePassword() {
  const current = document.getElementById('pw-current').value;
  const next    = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  const errEl   = document.getElementById('pw-error');
  errEl.style.display = 'none';
  if (!current || !next) { errEl.textContent = 'Bitte alle Felder ausfüllen'; errEl.style.display = ''; return; }
  if (next !== confirm)  { errEl.textContent = 'Passwörter stimmen nicht überein'; errEl.style.display = ''; return; }
  if (next.length < 6)   { errEl.textContent = 'Passwort mindestens 6 Zeichen'; errEl.style.display = ''; return; }
  setBusy('pw-save-btn', true);
  try {
    await api('PUT', '/password', { current, next });
    document.getElementById('pw-modal').style.display = 'none';
    toast('Passwort erfolgreich geändert');
  } catch(e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { setBusy('pw-save-btn', false); }
}

function openPasswordModal() {
  ['pw-current','pw-new','pw-confirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('pw-error').style.display = 'none';
  document.getElementById('pw-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('pw-current').focus(), 50);
}

// ── Data ─────────────────────────────────────────────────────
async function loadMeetings() { meetings = await api('GET', '/meetings'); }
async function loadTodos()    { try { todos = await api('GET', '/todos'); } catch { todos = []; } }
async function loadThemes()   { try { themes   = await api('GET', '/themes');   } catch { themes   = []; } }
async function loadContacts() { try { contacts = await api('GET', '/contacts'); } catch { contacts = []; } }
// Sichtbarer Fortschritt (Arbeitspaket M4): bewusst getrennt von den
// Kern-Ladefunktionen oben und NICHT Teil des kritischen Login-Pfads
// (siehe Aufrufstellen) - ein langsamer/fehlschlagender Momentum-Abruf darf
// den Login/das Laden von Meetings/Todos nicht verzögern oder blockieren.
async function loadMomentumBadge() {
  try { momentumStreak = window.TSMomentum ? await window.TSMomentum.fetchStreakBadge() : null; }
  catch { momentumStreak = null; }
}

// ── Render ───────────────────────────────────────────────────
function render() { renderSidebarModeSwitch(); renderSidebarTop(); renderTodosNav(); renderSidebar(); renderMain(); }

// ── Sidebar-Modus (Wissen ↔ Todos) ────────────────────────────
// Modus wird aus der aktuellen Ansicht abgeleitet statt separat gehalten,
// damit er nie mit selectedId desynchronisieren kann.
let lastTodosView = '__todos__';
let lastWissenView = '__themes__';
function currentSidebarMode() {
  return (selectedId === '__themes__' || selectedId === '__contacts__' || selectedId === '__graph__') ? 'wissen' : 'todos';
}
function switchSidebarMode(mode) {
  // Kein No-Op, solange wir im Graph sind: __graph__ zaehlt zwar als "wissen"-Modus
  // (fuer die aktiv-Markierung des Umschalters), ein Klick auf "Wissen" soll aber
  // immer tatsaechlich navigieren/neu rendern - sonst bleibt z.B. ein verpasster
  // Graph-Mount-Versuch (window.TSGraph war beim ersten Mount-Aufruf noch nicht
  // bereit) dauerhaft haengen, weil kein erneutes render() ausgeloest wird.
  if (mode === currentSidebarMode() && selectedId !== '__graph__') return;
  selectView(mode === 'wissen' ? lastWissenView : lastTodosView);
}
function renderSidebarModeSwitch() {
  document.getElementById('mode-btn-todos').classList.toggle('active', currentSidebarMode() === 'todos');
  document.getElementById('mode-btn-wissen').classList.toggle('active', currentSidebarMode() === 'wissen');
}
function renderSidebarTop() {
  const el = document.getElementById('sidebar-top');
  if (currentSidebarMode() === 'wissen') {
    el.innerHTML = `
      <button class="sidebar-new-btn" onclick="openThemeModal()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v15m7.5-7.5h-15"/></svg>
        Neues Topic
      </button>`;
  } else {
    el.innerHTML = `
      <button class="sidebar-new-btn" onclick="openMeetingModal()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v15m7.5-7.5h-15"/></svg>
        Neues Meeting
      </button>
      <div class="sidebar-search">
        <span class="sidebar-search-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        </span>
        <input type="text" placeholder="Suchen …" value="${escHtml(filterText)}" oninput="onSearch(this.value)">
      </div>`;
  }
}

function renderTodosNav() {
  const openPersonal = todos.filter(t => !t.done && !isSnoozed(t)).length;
  const openMeeting  = meetings.flatMap(m => m.topics||[]).filter(t => t.isTodo && !t.done && !isSnoozed(t)).length;
  const total = openPersonal + openMeeting;
  const ic = (path, vb='0 0 24 24') => `<svg width="14" height="14" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const el = document.getElementById('todos-nav');

  if (currentSidebarMode() === 'wissen') {
    el.innerHTML = `
      <div class="todo-nav-item ${selectedId === '__contacts__' ? 'active' : ''}" onclick="selectView('__contacts__')">
        <div class="todo-nav-icon contact-icon">${ic('<path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/>')}</div>
        <span class="todo-nav-label">Ansprechpartner</span>
        ${contacts.length > 0 ? `<span class="pill pill-open">${contacts.length}</span>` : ''}
      </div>
      <div class="todo-nav-item ${selectedId === '__graph__' ? 'active' : ''}" onclick="selectView('__graph__')">
        <div class="todo-nav-icon">${ic('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.2 7.3L10 16m5.8-8.7L14 16M8.3 6h7.4"/>')}</div>
        <span class="todo-nav-label">Graph</span>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="todo-nav-item ${selectedId === '__todos__' ? 'active' : ''}" onclick="selectView('__todos__')">
      <div class="todo-nav-icon">${ic('<path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>')}</div>
      <span class="todo-nav-label">Meine Todos</span>
      ${total > 0 ? `<span class="pill pill-open">${total}</span>` : ''}
    </div>
    <div class="todo-nav-item ${selectedId === '__eod__' ? 'active' : ''}" onclick="selectView('__eod__')">
      <div class="todo-nav-icon eod-icon">${ic('<path d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/>')}</div>
      <span class="todo-nav-label">Tagesabschluss</span>
      ${stackState.depth > 0 ? `<span class="pill pill-open">${stackState.depth}</span>` : ''}
    </div>
    <div class="todo-nav-item ${selectedId === '__stack_history__' ? 'active' : ''}" onclick="selectView('__stack_history__')">
      <div class="todo-nav-icon history-icon">${ic('<path d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/>')}</div>
      <span class="todo-nav-label">Stack-Historie</span>
    </div>
    <div class="todo-nav-item ai-action ${selectedId === '__digest__' ? 'active' : ''}" onclick="selectView('__digest__')">
      <div class="todo-nav-icon digest-icon">${ic('<path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/>')}</div>
      <span class="todo-nav-label">Wochen-Digest</span>
    </div>
    <div class="todo-nav-item ${selectedId === '__momentum__' ? 'active' : ''}" onclick="selectView('__momentum__')">
      <div class="todo-nav-icon momentum-icon">${ic('<path d="M2.25 18L9 11.25l4.306 4.306a11.95 11.95 0 015.814-5.518l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/>')}</div>
      <span class="todo-nav-label">Fortschritt</span>
      ${momentumStreak ? `<span class="momentum-nav-badge" aria-label="Serie: ${momentumStreak} Tage aktiv">🔥${momentumStreak}</span>` : ''}
    </div>
    <div class="todo-nav-item archive-nav-item ${selectedId === '__archive__' || selectedId === '__archive_detail__' ? 'active' : ''}"
         role="button" tabindex="0"
         onclick="selectView('__archive__')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectView('__archive__');}">
      <div class="todo-nav-icon archive-icon">${ic('<path d="M3 7.5V6a1.5 1.5 0 011.5-1.5h15A1.5 1.5 0 0121 6v1.5M3 7.5v10.5A1.5 1.5 0 004.5 19.5h15a1.5 1.5 0 001.5-1.5V7.5M3 7.5h18M10 12h4"/>')}</div>
      <span class="todo-nav-label">Archiv</span>
    </div>`;
}

function renderSidebar() {
  document.getElementById('sidebar-section-label').textContent =
    currentSidebarMode() === 'wissen' ? 'Topics' : 'Meetings';
  if (currentSidebarMode() === 'wissen') { renderSidebarTree(); return; }
  renderMeetingsList();
}

function renderSidebarTree() {
  const el = document.getElementById('meeting-list');
  const roots = themeChildren(null);
  el.innerHTML = roots.length === 0
    ? `<div class="sb-tree-empty">Noch keine Topics.</div>`
    : roots.map(t => renderThemeTreeNode(t)).join('');
}

function renderMeetingsList() {
  const el = document.getElementById('meeting-list');
  const lc = filterText.toLowerCase();
  let list;
  if (filterText) {
    list = meetings.filter(m =>
      m.title.toLowerCase().includes(lc) ||
      (m.participants||[]).some(p => p.toLowerCase().includes(lc)) ||
      (m.description||'').toLowerCase().includes(lc)
    ).sort((a,b) => {
      const da = a.nextDate ? new Date(a.nextDate) : null;
      const db2 = b.nextDate ? new Date(b.nextDate) : null;
      if (!da && !db2) return a.title.localeCompare(b.title);
      if (!da) return 1; if (!db2) return -1;
      return da - db2;
    });
  } else {
    list = meetings;
  }
  if (list.length === 0) {
    el.innerHTML = `<div class="empty-sidebar">${filterText ? '😶 Keine Treffer.' : 'Noch keine Meetings.\nErstellen Sie das erste!'}</div>`;
    return;
  }
  const dnd = !filterText;
  el.innerHTML = list.map(m => {
    const open = (m.topics||[]).filter(t => !t.done).length;
    const past = isPast(m.nextDate);
    const drag = dnd ? `draggable="true"
      ondragstart="meetingDragStart(event,'${m.id}')"
      ondragend="meetingDragEnd()"
      ondragover="meetingDragOver(event,'${m.id}')"
      ondragleave="meetingDragLeave(event)"
      ondrop="meetingDrop(event,'${m.id}')"` : '';
    return `
      <div class="meeting-item ${m.id === selectedId ? 'active' : ''}" data-mid="${m.id}" ${drag} onclick="selectMeeting('${m.id}')">
        <div class="meeting-color-dot" style="background:${m.color||'#1D6FE8'}"></div>
        <div class="meeting-item-body">
          <div class="meeting-item-title">${escHtml(m.title)}</div>
          <div class="meeting-item-foot">
            ${m.nextDate ? `<span class="pill ${past ? 'pill-date-past' : 'pill-date-ok'}">${fmtDate(m.nextDate)}</span>` : ''}
            ${m.isRecurring ? `<span class="pill pill-recurring">↻</span>` : ''}
            ${open > 0 ? `<span class="pill pill-open">${open} offen</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderMain() {
  const el = document.getElementById('main-content');
  if (selectedId === '__graph__') {
    document.getElementById('graph-root').hidden = false;
    el.innerHTML = '';
    if (window.TSGraph) {
      window.TSGraph.mount(document.getElementById('graph-root'));
    } else {
      document.getElementById('graph-root').innerHTML = '<div class="empty-state"><p>Graph-Ansicht wird geladen …</p></div>';
    }
    return;
  } else {
    const gr = document.getElementById('graph-root');
    if (gr) { window.TSGraph?.unmount?.(); gr.hidden = true; gr.innerHTML = ''; }
  }
  // Fortschritts-Timelines der Archiv-Detailansicht sauber abhängen, sobald
  // die Ansicht verlassen wird (vermeidet verwaiste Mounts/Requests).
  if (selectedId !== '__archive_detail__') { destroyArchiveDetailTimelines(); archiveDetailMountedForId = null; }
  if (selectedId === '__themes__')   { renderThemesView(el); return; }
  if (selectedId === '__contacts__') { renderContactsView(el); return; }
  if (selectedId === '__todos__')    { renderTodosView(el); return; }
  if (selectedId === '__eod__')      { renderEodView(el); return; }
  if (selectedId === '__stack_history__') { renderStackHistoryView(el); return; }
  if (selectedId === '__digest__')   { renderDigestView(el); return; }
  if (selectedId === '__momentum__') { renderMomentumView(el); return; }
  if (selectedId === '__archive__')  { renderArchiveView(el); return; }
  if (selectedId === '__archive_detail__') { renderArchiveDetailView(el); return; }
  if (!selectedId) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <h2>Willkommen</h2>
        <p>Wählen Sie links ein Meeting aus oder erstellen Sie ein neues.</p>
        <button class="btn btn-primary" onclick="openMeetingModal()">+ Neues Meeting</button>
      </div>`;
    return;
  }
  const m = getMeeting(selectedId);
  if (!m) { selectedId = null; renderMain(); return; }
  el.innerHTML = renderMeetingDetailHtml(m, { readOnly: false });
}

// ── Meeting-Detail-Markup (aktiv + Archiv-Nur-Lese) ─────────────────────
// Arbeitspaket W1 (Archiv-Feature): um einen readOnly-Zweig erweitert statt
// eines zweiten Detail-Renderers (siehe CLAUDE.md "Wiederverwendung vor
// Neuentwicklung" und Schnittstellenvertrag Punkt 3). Im readOnly-Modus
// werden alle schreibenden Kopfzeilen-/Themen-Aktionen entfernt und durch
// ein Archiv-Hinweisbanner (Wiederherstellen/Endgültig löschen) ersetzt.
function renderMeetingDetailHtml(m, opts) {
  const readOnly = !!(opts && opts.readOnly);
  const groupMap = buildGroupMap();
  const themeMap = buildThemeMap();
  const lct = topicFilter.toLowerCase();
  const matchesTopic = t => !topicFilter ||
    t.title.toLowerCase().includes(lct) ||
    (t.description||'').toLowerCase().includes(lct);
  let open      = (m.topics||[]).filter(t => !t.done && !isSnoozed(t) && matchesTopic(t));
  const snoozed = (m.topics||[]).filter(t => !t.done &&  isSnoozed(t) && matchesTopic(t));
  const done    = (m.topics||[]).filter(t =>  t.done && matchesTopic(t))
    .sort((a,b) => new Date(b.resultDate||b.createdAt) - new Date(a.resultDate||a.createdAt));
  const past = isPast(m.nextDate);
  // Fortschritt: Sortierung/Filter analog zur Todo-Übersicht (Story 9) —
  // im readOnly-Modus bewusst deaktiviert (kein Werkzeug-Zustand nötig,
  // Standardreihenfolge genügt für die Ansicht eines archivierten Meetings).
  const openBeforeTopicProgressFilter = open.length;
  if (!readOnly && topicProgressFilterUndocumented && window.TSProgress) {
    open = open.filter(t => TSProgress.isUndocumented(t));
  }
  if (!readOnly && topicProgressSortOldest && window.TSProgress) {
    open = open.slice().sort(TSProgress.compareByProgress);
  }

  return `
    <div class="full-width-view">
      <div class="meeting-header">
        <div class="meeting-header-accent" style="background:${m.color||'#1D6FE8'}"></div>
        <div class="meeting-header-body">
          <div class="meeting-header-info">
            <h1 class="meeting-title">${escHtml(m.title)}</h1>
            ${readOnly ? `
              <div class="archive-readonly-banner" role="status">
                <span class="archive-readonly-banner-text">🗃️ Archiviert am ${escHtml(fmtDateOnly(m.archivedAt))}</span>
                <button class="btn btn-secondary btn-sm" onclick="restoreArchivedMeeting('${m.id}', true)">↺ Wiederherstellen</button>
              </div>` : ''}
            ${m.description ? `<div class="meeting-description rt-display">${displayHtml(m.description)}</div>` : ''}
            <div class="meeting-meta-chips">
              ${(m.participants||[]).length > 0 ? `
                <span class="meta-chip">
                  <span class="meta-chip-icon">${SVG.users}</span>${escHtml(m.participants.join(', '))}
                </span>` : ''}
              ${m.nextDate ? `
                <span class="meta-chip${past?' past':''}">
                  <span class="meta-chip-icon">${SVG.calendar}</span>${fmtDateTime(m.nextDate)}${past?' · vergangen':''}
                </span>` : ''}
              ${m.isRecurring ? `
                <span class="meta-chip">
                  <span class="meta-chip-icon">${SVG.repeat}</span>${recLabel(m.recurrencePattern)}
                </span>` : ''}
            </div>
          </div>
          <div class="meeting-header-actions">
            ${readOnly ? `
              <button class="btn btn-danger btn-sm" onclick="confirmPermanentlyDeleteMeeting('${m.id}','${escJsAttr(m.title)}', true)">🗑️ Endgültig löschen</button>
            ` : `
              ${aiFeatureOn('brief')   ? `<button class="btn btn-secondary btn-sm ai-action" onclick="openAiBrief()">${SVG.sparkle} Briefing</button>` : ''}
              ${aiFeatureOn('capture') ? `<button class="btn btn-secondary btn-sm ai-action" onclick="openAiCapture()">${SVG.notes} Notizen</button>` : ''}
              ${m.isRecurring && m.nextDate ? `<button class="btn btn-secondary btn-sm" onclick="doAdvanceDate('${m.id}')">${SVG.repeat} Nächster Termin</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="openMeetingModal('${m.id}')">${SVG.pencil} Bearbeiten</button>
              <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmArchiveMeeting('${m.id}')" title="Meeting archivieren">🗃️</button>
            `}
          </div>
        </div>
      </div>

      ${readOnly ? '' : renderCmiBanner(m.id)}

      <div class="topics-section">
        <div class="topics-header">
          <div class="topics-header-left">
            <h2>Themen</h2>
            <span class="topic-count-badge">${topicFilter ? `${open.length+snoozed.length+done.length} / ${(m.topics||[]).length}` : (m.topics||[]).length}</span>
          </div>
          <input type="search" class="topic-search" id="topic-search-input"
            placeholder="Suchen …" value="${escHtml(topicFilter)}"
            oninput="onTopicSearch(this.value)" onclick="event.stopPropagation()">
          ${readOnly ? '' : `<button class="btn btn-primary btn-sm" onclick="openTopicModal('${m.id}')">+ Thema</button>`}
        </div>
        ${(m.topics||[]).length === 0 ? `
          <div class="empty-topics">Noch keine Themen${readOnly ? '.' : ' — fügen Sie das erste hinzu.'}</div>` : ''}
        ${!readOnly && openBeforeTopicProgressFilter > 0 ? `
        <div class="todos-toolbar">
          <div class="todos-toolbar-field">
            <label for="topic-progress-sort-select">Sortierung</label>
            <select class="form-control" id="topic-progress-sort-select" onchange="topicProgressSortOldest = (this.value==='oldest'); renderMain()">
              <option value="default"${!topicProgressSortOldest ? ' selected' : ''}>Standard</option>
              <option value="oldest"${topicProgressSortOldest ? ' selected' : ''}>Ältester Stand zuerst</option>
            </select>
          </div>
          <div class="toggle-row">
            <span style="font-size:.8125rem;color:var(--text-muted)">Länger nicht dokumentiert</span>
            <label class="toggle"><input type="checkbox"${topicProgressFilterUndocumented ? ' checked' : ''} onchange="topicProgressFilterUndocumented = this.checked; renderMain()"><span class="toggle-slider"></span></label>
          </div>
        </div>` : ''}
        ${!readOnly && topicProgressFilterUndocumented && open.length === 0 && openBeforeTopicProgressFilter > 0 ? `
          <div class="empty-topics">✅ Alles aktuell dokumentiert — kein offenes Thema ohne Zwischenstand.</div>` : ''}
        ${open.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text open-label">Offen</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${open.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${open.map(t => renderTopicCard(m.id, t, groupMap, themeMap, readOnly)).join('')}` : ''}
        ${snoozed.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text sleep-label">${SVG.moon} Schlafend</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${snoozed.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${snoozed.map(t => renderTopicCard(m.id, t, groupMap, themeMap, readOnly)).join('')}` : ''}
        ${done.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text done-label">Erledigt</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${done.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${done.map(t => renderTopicCard(m.id, t, groupMap, themeMap, readOnly)).join('')}` : ''}
      </div>
    </div><!-- /full-width-view -->`;
}

function renderTodosView(el) {
  // Sortierung: zuerst Todos mit Fälligkeit (frühestes oben), dann Todos ohne dueDate (nach sortOrder/createdAt)
  const byDueDate = (a, b) => {
    const aDue = a.dueDate ? a.dueDate.slice(0,10) : '';
    const bDue = b.dueDate ? b.dueDate.slice(0,10) : '';
    if (aDue && bDue) return aDue.localeCompare(bDue);
    if (aDue) return -1;
    if (bDue) return 1;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
        || new Date(a.createdAt) - new Date(b.createdAt);
  };
  const visibleTodos = showPrivateTodos ? todos : todos.filter(t => !t.isPrivate);
  let open    = visibleTodos.filter(t => !t.done && !isSnoozed(t));
  const snoozedTodos = visibleTodos.filter(t => !t.done &&  isSnoozed(t)).sort(byDueDate);
  const done    = visibleTodos.filter(t =>  t.done)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const hasPrivate = todos.some(t => t.isPrivate);
  // Meeting-Topics als Todo: offen + schlafende separat
  let meetingTodosOpen    = meetings.flatMap(m =>
    (m.topics||[]).filter(t => t.isTodo && !t.done && !isSnoozed(t)).map(t => ({ meeting: m, topic: t }))
  );
  const meetingTodosSnoozed = meetings.flatMap(m =>
    (m.topics||[]).filter(t => t.isTodo && !t.done &&  isSnoozed(t)).map(t => ({ meeting: m, topic: t }))
  );

  // ── Fortschritt: Sortierung "Ältester Stand zuerst" + Filter "Länger
  //    nicht dokumentiert" (Story 9). Zählt nur für die offenen Gruppen —
  //    schlafende/erledigte Todos bleiben von Filter/Sortierung unberührt.
  const openBeforeProgressFilter = open.length + meetingTodosOpen.length;
  if (todoProgressFilterUndocumented && window.TSProgress) {
    open = open.filter(t => TSProgress.isUndocumented(t));
    meetingTodosOpen = meetingTodosOpen.filter(x => TSProgress.isUndocumented(x.topic));
  }
  if (todoProgressSortOldest && window.TSProgress) {
    open = open.slice().sort(TSProgress.compareByProgress);
    meetingTodosOpen = meetingTodosOpen.slice().sort((a, b) => TSProgress.compareByProgress(a.topic, b.topic));
  } else {
    open = open.slice().sort(byDueDate);
    meetingTodosOpen = meetingTodosOpen.slice().sort((a,b) => (a.topic.sortOrder??0) - (b.topic.sortOrder??0));
  }
  const themeMap = buildThemeMap();
  const showProgressToolbar = openBeforeProgressFilter > 0 || snoozedTodos.length > 0 || meetingTodosSnoozed.length > 0;

  el.innerHTML = `
    <div class="full-width-view">
      <div class="meeting-header">
        <div class="meeting-header-accent" style="background:var(--green)"></div>
        <div class="meeting-header-body">
          <div class="meeting-header-info">
            <h1 class="meeting-title">Meine Todos</h1>
            <p class="meeting-description" style="color:var(--text-muted)">
              Persönliche Aufgaben und Themen aus Meetings die auf dich warten.
            </p>
          </div>
          <div class="meeting-header-actions">
            ${hasPrivate ? `<button class="btn btn-ghost btn-sm btn-icon private-toggle${showPrivateTodos ? '' : ' private-hidden'}" onclick="showPrivateTodos=!showPrivateTodos;renderMain()" title="${showPrivateTodos ? 'Private Todos ausblenden' : 'Private Todos anzeigen'}">🔒</button>` : ''}
            <button class="btn btn-primary btn-sm" onclick="openTodoModal()">+ Todo</button>
          </div>
        </div>
      </div>

      <div class="topics-section">
        ${showProgressToolbar ? `
        <div class="todos-toolbar">
          <div class="todos-toolbar-field">
            <label for="todo-progress-sort-select">Sortierung</label>
            <select class="form-control" id="todo-progress-sort-select" onchange="todoProgressSortOldest = (this.value==='oldest'); renderMain()">
              <option value="default"${!todoProgressSortOldest ? ' selected' : ''}>Standard (Fälligkeit)</option>
              <option value="oldest"${todoProgressSortOldest ? ' selected' : ''}>Ältester Stand zuerst</option>
            </select>
          </div>
          <div class="toggle-row">
            <span style="font-size:.8125rem;color:var(--text-muted)">Länger nicht dokumentiert</span>
            <label class="toggle"><input type="checkbox"${todoProgressFilterUndocumented ? ' checked' : ''} onchange="todoProgressFilterUndocumented = this.checked; renderMain()"><span class="toggle-slider"></span></label>
          </div>
        </div>` : ''}

        ${open.length === 0 && meetingTodosOpen.length === 0 && snoozedTodos.length === 0 && meetingTodosSnoozed.length === 0 ? `
          <div class="empty-topics" style="padding:3rem">
            Keine offenen Todos — alles erledigt! 🎉
          </div>` : (todoProgressFilterUndocumented && open.length === 0 && meetingTodosOpen.length === 0 && openBeforeProgressFilter > 0 ? `
          <div class="empty-topics" style="padding:3rem">
            ✅ Alles aktuell dokumentiert — kein offenes Todo ohne Zwischenstand.
          </div>` : '')}

        ${open.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text open-label">Persönlich</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${open.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${open.map(t => renderPersonalTodoCard(t, false, themeMap)).join('')}` : ''}

        ${snoozedTodos.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text sleep-label">${SVG.moon} Schlafend</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${snoozedTodos.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${snoozedTodos.map(t => renderPersonalTodoCard(t, false, themeMap)).join('')}` : ''}

        ${meetingTodosOpen.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text" style="color:#f59e0b">Aus Meetings</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${meetingTodosOpen.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${meetingTodosOpen.map(({ meeting: m, topic: t }) => renderMeetingTopicTodo(m, t, themeMap)).join('')}` : ''}

        ${meetingTodosSnoozed.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text sleep-label">${SVG.moon} Schlafend (Meetings)</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${meetingTodosSnoozed.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${meetingTodosSnoozed.map(({ meeting: m, topic: t }) => renderMeetingTopicTodo(m, t, themeMap)).join('')}` : ''}

        ${done.length > 0 ? `
          <div class="topic-group-header">
            <span class="topic-group-label-text done-label">Erledigt</span>
            <span class="topic-group-label-text" style="color:var(--text-light)">${done.length}</span>
            <div class="topic-group-header-line"></div>
          </div>
          ${done.map(t => renderPersonalTodoCard(t, true, themeMap)).join('')}` : ''}
      </div><!-- /topics-section -->
    </div><!-- /full-width-view -->`;

  // KI-Card-Summary-Slots (Story 7/8) nachträglich einhängen — die Slots
  // wurden oben nur für Karten gerendert, für die eine AI-Zusammenfassung
  // tatsächlich angezeigt werden soll (siehe renderTodoCardBody/-Progress).
  mountTodoCardSummaries([
    ...open.map(item => ({ refType: 'todo', item })),
    ...snoozedTodos.map(item => ({ refType: 'todo', item })),
    ...meetingTodosOpen.map(({ topic }) => ({ refType: 'topic', item: topic })),
    ...meetingTodosSnoozed.map(({ topic }) => ({ refType: 'topic', item: topic })),
  ]);
}

// ── Fortschrittsverlauf: Badge für Todo-/Themen-Karten (Arbeitspaket W1) ──
//    Badge-Markup liefert ausschließlich TSProgress (public/progress.js),
//    hier nur defensiv abgesichert für den Fall, dass das Modul (noch) nicht
//    geladen ist (z. B. sehr frühes render() vor dem "defer"-Laden des
//    Scripts). Der Zeitstrahl selbst ist fest in die Bearbeiten-Ansicht
//    eingebettet (kein Panel-Button mehr, siehe Arbeitspaket W2).
function progressBadgeHtml(progress) {
  return (window.TSProgress && typeof TSProgress.badgeHtml === 'function') ? TSProgress.badgeHtml(progress) : '';
}

function renderPersonalTodoCard(t, isDone, themeMap) {
  const sleeping = !isDone && isSnoozed(t);
  const grp = isDone ? 'done' : 'open';
  const drag = !isDone ? `draggable="true"
    ondragstart="todoDragStart(event,'${t.id}')"
    ondragend="todoDragEnd()"
    ondragover="todoDragOver(event,'${t.id}')"
    ondragleave="todoDragLeave(event)"
    ondrop="todoDrop(event,'${t.id}')"` : '';
  const themeEntries = themeMap ? (themeMap[t.id] || []) : [];
  const cardBody = renderTodoCardBody('todo', t, themeEntries, isDone, false);
  return `
    <div class="topic-card ${grp}${sleeping ? ' snoozed' : ''}" data-todoid="${t.id}" ${drag}>
      <div class="topic-card-header">
        <div class="topic-info">
          ${!isDone ? `<span class="drag-handle" title="Verschieben">⠿</span>` : ''}
          <span class="topic-status-icon ${grp}">${isDone ? '✓' : ''}</span>
          <h4 class="topic-title ${isDone ? 'done-text' : ''}">${escHtml(t.title)}${t.isPrivate ? ' <span class="private-badge" title="Privat">🔒</span>' : ''}</h4>
          ${progressBadgeHtml(t.progress)}
        </div>
        <div class="topic-actions">
          ${!isDone ? `
            <button class="btn btn-secondary btn-sm btn-icon" onclick="openTodoModal('${t.id}')" title="Bearbeiten">${SVG.pencil}</button>
            <button class="btn btn-success btn-sm" onclick="openCompleteTodoModal('${t.id}')">${SVG.check} Erledigt</button>
            <button class="btn btn-secondary btn-sm btn-icon" onclick="toggleTodoCardComposer('todo','${t.id}')" aria-label="Zwischenstand erfassen" title="Zwischenstand erfassen">${SVG.notes}</button>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="openStackPushModal('todo','${t.id}')" title="Auf Stack legen (⌘⇧P)">📚</button>` : `
            <button class="btn btn-secondary btn-sm" onclick="reopenPersonalTodo('${t.id}')">↺ Öffnen</button>`}
          <details class="topic-overflow" onclick="event.stopPropagation()">
            <summary class="btn btn-secondary btn-sm btn-icon" title="Weitere Aktionen">⋯</summary>
            <div class="topic-overflow-menu">
              ${!isDone ? `<button onclick="closeAllOverflow(); moveToTopTodo('${t.id}')">
                <span class="icon">⬆</span><span>Ganz nach oben</span>
              </button><hr>` : ''}
              <button onclick="closeAllOverflow(); openMoveModalForTodo('${t.id}')">
                <span class="icon">→</span><span>In Meeting verschieben</span>
              </button>
              <button onclick="closeAllOverflow(); openThemeLinkModalForTodo('${t.id}')">
                <span class="icon">🏷️</span><span>Topic zuweisen</span>
              </button>
              <button onclick="closeAllOverflow(); openContactAssignmentPickerForTodoCard('${t.id}')">
                <span class="icon">👤</span><span>Ansprechpartner zuordnen</span>
              </button>
              ${!isDone ? `<button onclick="closeAllOverflow(); openStackPushModal('todo','${t.id}')">
                <span class="icon">📚</span><span>Auf Stack legen</span>
              </button>` : ''}
              <hr>
              <button class="danger" onclick="closeAllOverflow(); confirmDeleteTodo('${t.id}','${escHtml(t.title)}')">
                <span class="icon">🗑️</span><span>Löschen</span>
              </button>
            </div>
          </details>
        </div>
      </div>
      ${cardBody.descriptionHtml}
      ${!isDone && t.dueDate ? `
        <div class="due-info">
          <span class="due-badge ${dueDateClass(t.dueDate)}">${SVG.calendar} Fällig: ${fmtDateOnly(t.dueDate)}${dueDateSuffix(t.dueDate)}</span>
        </div>` : ''}
      ${renderTodoCardProgress('todo', t, isDone, false)}
      ${sleeping ? `
        <div class="snooze-info">
          ${SVG.moon} Wacht auf am ${fmtSnoozeLabel(t.snoozedUntil)}
          <button class="snooze-wake-btn" onclick="wakeUpTodo('${t.id}')">🔔 Jetzt wecken</button>
        </div>` : ''}
      ${!isDone ? `<div id="todo-card-composer-todo-${t.id}" class="ts-progress-line-host" style="display:none"></div>` : ''}
      ${cardBody.contactsHtml}
      ${cardBody.chipsHtml}${cardBody.toggleHtml}
      ${isDone ? `
        <div class="topic-result">
          <div class="topic-result-header">
            <span class="result-label">Ergebnis</span>
            ${t.resultDate ? `<span class="result-date">${fmtDateTime(t.resultDate)}</span>` : ''}
          </div>
          ${t.result
            ? `<div class="result-text rt-display">${displayHtml(t.result)}</div>`
            : `<p class="result-empty">Kein Ergebnis eingetragen</p>`}
        </div>` : ''}
      ${(() => { const c = (attachCache['todo/'+t.id]||[]).length; return c > 0 ? `<span class="attach-badge" data-attach-ref="todo/${t.id}">📎 ${c}</span>` : `<span class="attach-badge" data-attach-ref="todo/${t.id}" style="display:none">📎 0</span>`; })()}
      ${!isDone && themeSuggestionsCache[refKey('todo', t.id)] ? `
        <div id="theme-suggest-todo-${t.id}">${renderThemeSuggestionMarkup(themeSuggestionsCache[refKey('todo', t.id)], 'todo', t.id)}</div>
      ` : ''}
    </div>`;
}

function renderMeetingTopicTodo(m, t, themeMap) {
  const sleeping    = isSnoozed(t);
  // ARCHIVED_READONLY (Archiv-Feature): defensiv per Optional-Chaining
  // gelesen, da dieses Worktree (noch) keinen gemergten Archiv-Stand hat —
  // wird erst nach dem Merge wirksam.
  const isArchived = !!m?.archived;
  const themeEntries = themeMap ? (themeMap[t.id] || []) : [];
  const cardBody = renderTodoCardBody('topic', t, themeEntries, false, isArchived);
  return `
    <div class="topic-card open${sleeping ? ' snoozed' : ''}">
      <div class="topic-card-header">
        <div class="topic-info">
          <span class="topic-status-icon open"></span>
          <h4 class="topic-title">${escHtml(t.title)}</h4>
          ${progressBadgeHtml(t.progress)}
        </div>
        <div class="topic-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openTopicModal('${m.id}','${t.id}')" title="Bearbeiten">${SVG.pencil}</button>
          <button class="btn btn-success btn-sm" onclick="openCompleteModal('${m.id}','${t.id}')">${SVG.check} Erledigt</button>
          ${!isArchived ? `<button class="btn btn-secondary btn-sm btn-icon" onclick="toggleTodoCardComposer('topic','${t.id}')" aria-label="Zwischenstand erfassen" title="Zwischenstand erfassen">${SVG.notes}</button>` : ''}
          <details class="topic-overflow" onclick="event.stopPropagation()">
            <summary class="btn btn-secondary btn-sm btn-icon" title="Weitere Aktionen">⋯</summary>
            <div class="topic-overflow-menu">
              <button onclick="closeAllOverflow(); openThemeLinkModalForTopic('${m.id}','${t.id}')">
                <span class="icon">🏷️</span><span>Topic zuweisen</span>
              </button>
              <button onclick="closeAllOverflow(); openContactAssignmentPickerForTopicCard('${m.id}','${t.id}')">
                <span class="icon">👤</span><span>Ansprechpartner zuordnen</span>
              </button>
              <button onclick="closeAllOverflow(); openMoveModalForTopic('${m.id}','${t.id}')">
                <span class="icon">→</span><span>In anderes Meeting verschieben</span>
              </button>
              <button onclick="closeAllOverflow(); toggleTopicTodo('${m.id}','${t.id}')">
                <span class="icon">📌</span><span>Aus Todos entfernen</span>
              </button>
              <button onclick="closeAllOverflow(); openStackPushModal('topic','${t.id}')">
                <span class="icon">📚</span><span>Auf Stack legen</span>
              </button>
              ${sleeping
                ? `<button onclick="closeAllOverflow(); wakeUpTopic('${m.id}','${t.id}')">
                    <span class="icon">🔔</span><span>Jetzt wecken</span>
                  </button>`
                : `<button onclick="closeAllOverflow(); openTopicModal('${m.id}','${t.id}')">
                    <span class="icon">😴</span><span>Schlafen legen</span>
                  </button>`}
              <hr>
              <button class="danger" onclick="closeAllOverflow(); confirmDelete('topic','${m.id}','${t.id}')">
                <span class="icon">🗑️</span><span>Löschen</span>
              </button>
            </div>
          </details>
        </div>
      </div>
      ${cardBody.descriptionHtml}
      ${renderTodoCardProgress('topic', t, false, isArchived)}
      ${sleeping ? `
        <div class="snooze-info">
          ${SVG.moon} Wacht auf am ${fmtSnoozeLabel(t.snoozedUntil)}
          <button class="snooze-wake-btn" onclick="wakeUpTopic('${m.id}','${t.id}')">🔔 Jetzt wecken</button>
        </div>` : ''}
      ${!isArchived ? `<div id="todo-card-composer-topic-${t.id}" class="ts-progress-line-host" style="display:none"></div>` : ''}
      ${cardBody.contactsHtml}
      ${cardBody.chipsHtml}${cardBody.toggleHtml}
      <a class="todo-meeting-chip" onclick="selectMeeting('${m.id}')">
        <span class="meeting-dot" style="background:${escHtml(m.color||'#1D6FE8')};width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:3px"></span>${escHtml(m.title)}
      </a>
    </div>`;
}

function renderTopicCard(mid, t, groupMap, themeMap, readOnly) {
  const sleeping = isSnoozed(t);
  const grp = t.done ? 'done' : 'open';
  const groupMembers = (t.groupId && groupMap) ? (groupMap[t.groupId] || []).filter(x => x.meeting.id !== mid) : [];
  const themeEntries = themeMap ? (themeMap[t.id] || []) : [];
  const drifted     = !t.done && driftTopics.has(t.id);
  const suggestionsHtml = themeSuggestionsCache[refKey('topic', t.id)] || null;
  // readOnly (Arbeitspaket W1, Archiv-Detail): keine Drag-Handles, keine
  // schreibenden Aktionen (Bearbeiten/Erledigen/Verschieben/Teilen/Snooze-
  // Aufwecken/Overflow/Löschen/"+ Thema") — vollständig aus dem Markup
  // entfernt statt nur deaktiviert, damit sie auch aus dem Tab-Fokus
  // verschwinden. Fortschrittsverlauf bleibt sichtbar (siehe
  // renderReadOnlyTopicExtras), Anhänge sind als Downloads eingebettet.
  const dragAttrs = readOnly ? '' : `
         draggable="true"
         ondragstart="topicDragStart(event,'${mid}','${t.id}','${grp}')"
         ondragend="topicDragEnd(event)"
         ondragover="topicDragOver(event,'${mid}','${t.id}','${grp}')"
         ondragleave="topicDragLeave(event)"
         ondrop="topicDrop(event,'${mid}','${t.id}','${grp}')"`;
  return `
    <div class="topic-card ${grp}${sleeping ? ' snoozed' : ''}" data-tid="${t.id}"${dragAttrs}>
      <div class="topic-card-header">
        <div class="topic-info">
          ${readOnly ? '' : `<span class="drag-handle" title="Reihenfolge ändern">⠿</span>`}
          <span class="topic-status-icon ${grp}">${t.done ? '✓' : ''}</span>
          <h4 class="topic-title ${t.done ? 'done-text' : ''}">${escHtml(t.title)}</h4>
          ${progressBadgeHtml(t.progress)}
        </div>
        ${readOnly ? '' : `
        <div class="topic-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openTopicModal('${mid}','${t.id}')" title="Bearbeiten">${SVG.pencil}</button>
          ${!t.done
            ? `<button class="btn btn-success btn-sm" onclick="openCompleteModal('${mid}','${t.id}')">${SVG.check} Erledigt</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="reopenTopic('${mid}','${t.id}')">↺ Öffnen</button>`}
          ${!t.done ? `<button class="btn btn-ghost btn-sm btn-icon"
            onclick="openStackPushModal('topic','${t.id}')"
            title="Auf Stack legen (⌘⇧P)">📚</button>` : ''}
          <details class="topic-overflow" onclick="event.stopPropagation()">
            <summary class="btn btn-secondary btn-sm btn-icon" title="Weitere Aktionen">⋯</summary>
            <div class="topic-overflow-menu">
              ${!t.done ? `<button onclick="closeAllOverflow(); moveToTopTopic('${mid}','${t.id}')">
                <span class="icon">⬆</span><span>Ganz nach oben</span>
              </button><hr>` : ''}
              <button onclick="closeAllOverflow(); openShareModal('${mid}','${t.id}')">
                <span class="icon">🔗</span><span>In weiterem Meeting teilen</span>
              </button>
              <button onclick="closeAllOverflow(); openMoveModalForTopic('${mid}','${t.id}')">
                <span class="icon">→</span><span>Verschieben</span>
              </button>
              <button onclick="closeAllOverflow(); openThemeLinkModalForTopic('${mid}','${t.id}')">
                <span class="icon">🏷️</span><span>Topic zuweisen</span>
              </button>
              <button onclick="closeAllOverflow(); openContactAssignmentPickerForTopicCard('${mid}','${t.id}')">
                <span class="icon">👤</span><span>Ansprechpartner zuordnen</span>
              </button>
              <button onclick="closeAllOverflow(); toggleTopicTodo('${mid}','${t.id}')">
                <span class="icon">📌</span><span>${t.isTodo ? 'Aus Todos entfernen' : 'Als Todo markieren'}</span>
              </button>
              <hr>
              <button class="danger" onclick="closeAllOverflow(); confirmDelete('topic','${mid}','${t.id}')">
                <span class="icon">🗑️</span><span>Löschen</span>
              </button>
            </div>
          </details>
        </div>`}
      </div>
      ${t.description ? `<div class="topic-description rt-display">${displayHtml(t.description)}</div>` : ''}
      ${sleeping ? `
        <div class="snooze-info">
          ${SVG.moon} Wacht auf am ${fmtSnoozeLabel(t.snoozedUntil)}
          ${readOnly ? '' : `<button class="snooze-wake-btn" onclick="wakeUpTopic('${mid}','${t.id}')">🔔 Jetzt wecken</button>`}
        </div>` : ''}
      ${groupMembers.length > 0 ? `
        <div class="topic-group-chips">
          ${groupMembers.map(x => `
            <span class="topic-group-chip${x.topic.done ? ' done-chip' : ''}"
                  onclick="selectMeeting('${x.meeting.id}')"
                  title="In „${escHtml(x.meeting.title)}" öffnen">
              🔗 ${escHtml(x.meeting.title)}${x.topic.done ? ' ✓' : ''}
            </span>`).join('')}
        </div>` : ''}
      ${themeEntries.length > 0 ? `
        <div class="theme-chips">
          ${themeEntries.map(x => `
            <span class="theme-chip" onclick="selectView('__themes__')" title="Topic: ${escHtml(x.theme.title)}">
              🏷️ ${escHtml(x.theme.title)}
            </span>`).join('')}
        </div>` : ''}
      ${renderAssignedContactsChipsHtml(t)}
      ${t.done ? `
        <div class="topic-result">
          <div class="topic-result-header">
            <span class="result-label">Ergebnis</span>
            ${t.resultDate ? `<span class="result-date">${fmtDateTime(t.resultDate)}</span>` : ''}
          </div>
          ${t.result
            ? `<div class="result-text rt-display">${displayHtml(t.result)}</div>`
            : `<p class="result-empty">Kein Ergebnis eingetragen</p>`}
        </div>` : ''}
      ${readOnly ? renderReadOnlyTopicExtras(t) : `
      ${(() => { const c = (attachCache['topic/'+t.id]||[]).length; return c > 0 ? `<span class="attach-badge" data-attach-ref="topic/${t.id}">📎 ${c}</span>` : `<span class="attach-badge" data-attach-ref="topic/${t.id}" style="display:none">📎 0</span>`; })()}
      ${!t.done && suggestionsHtml ? `
        <div id="theme-suggest-topic-${t.id}">${renderThemeSuggestionMarkup(suggestionsHtml, 'topic', t.id)}</div>
      ` : ''}`}
    </div>`;
}

// readOnly-Zusatzbereiche einer Themenkarte (Archiv-Detail): Fortschritts-
// verlauf (nur wenn bereits Zwischenstände existieren — sonst kein Mount,
// um nicht für jede Themenkarte unnötig einen Leerzustand nachzuladen) und
// Anhänge als reine Download-Liste (Wiederverwendung von attachSectionHtml/
// loadAttachments, siehe dortiger readOnly-Parameter).
function renderReadOnlyTopicExtras(t) {
  const hasProgress = !!(t.progress && t.progress.entryCount > 0);
  return `
      ${hasProgress ? `<div class="progress-readonly" id="ro-progress-topic-${t.id}"></div>` : ''}
      ${attachSectionHtml('topic', t.id, true)}`;
}

function renderThemeSuggestionMarkup(suggestions, refType, refId) {
  const key = refKey(refType, refId);
  const dismissed = dismissedThemeSuggestions[key] || new Set();
  const filtered  = suggestions.filter(s => !dismissed.has(s.theme_id));
  if (!filtered.length) return '';
  return `
    <div class="theme-suggest-row ai-action">
      <span class="label"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 2l.75 2.25L22 5l-2.25.75L19 8l-.75-2.25L16 5l2.25-.75z"/></svg> Vorschläge:</span>
      ${filtered.map(s => `
        <span class="theme-suggest-pill" data-theme-id="${s.theme_id}" data-ref-type="${refType}" data-ref-id="${refId}" onclick="acceptThemeSuggestion(event,'${refType}','${refId}','${s.theme_id}')">
          🏷️ ${escHtml(s.theme_title)}
          <span class="confidence">${Math.round(s.confidence * 100)}%</span>
          <button class="dismiss" onclick="dismissThemeSuggestion(event,'${refType}','${refId}','${s.theme_id}')" title="Verwerfen">×</button>
        </span>`).join('')}
    </div>`;
}

async function acceptThemeSuggestion(e, refType, refId, themeId) {
  if (e.target.classList.contains('dismiss')) return;
  e.stopPropagation();
  try {
    await api('POST', `/themes/${themeId}/links`, { refType, refId });
    const key = refKey(refType, refId);
    const set = dismissedThemeSuggestions[key] || new Set();
    set.add(themeId);
    dismissedThemeSuggestions[key] = set;
    await loadThemes(); render();
    toast('Topic verknüpft');
  } catch (e) { toast(e.message || 'Fehler', 'error'); }
}

// ── Wake-up (Snooze aufheben) ────────────────────────────────
async function wakeUpTopic(mid, tid) {
  try {
    await api('PUT', `/meetings/${mid}/topics/${tid}`, { snoozedUntil: null });
    Object.assign(getTopic(mid, tid), { snoozedUntil: null });
    render(); toast('Thema ist wieder aktiv');
  } catch(e) { toast(e.message, 'error'); }
}

async function wakeUpTodo(id) {
  try {
    await api('PUT', `/todos/${id}`, { snoozedUntil: null });
    Object.assign(todos.find(t => t.id === id), { snoozedUntil: null });
    render(); toast('Todo ist wieder aktiv');
  } catch(e) { toast(e.message, 'error'); }
}

// Fragt die Notification-Berechtigung an, falls noch nicht entschieden.
// Robust gegen Umgebungen ohne Notification-API (unsicherer Kontext, ältere
// WebViews) — ein bloßer Zugriff auf den Bezeichner `Notification` würde dort
// einen ReferenceError werfen und (weil vor dem try-Block in saveTodoModal/
// saveTopicModal aufgerufen) das Speichern komplett verhindern.
function requestNotificationPermissionIfNeeded() {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch { /* Berechtigungsanfrage ist best-effort, darf das Speichern nie blockieren */ }
}

// Prüft alle zeitbasiert schlafenden Todos/Themen und feuert eine Browser-
// Notification, sobald die Weckzeit erreicht ist (nur solange der Tab offen
// ist — kein Web Push). notifiedSnoozes verhindert Doppel-Benachrichtigung
// nach einem Reload; der Key enthält snoozedUntil, sodass eine NEUE
// Snooze-Zeit für dieselbe ID erneut benachrichtigt.
function notifiedSnoozesKey() {
  return currentUser ? `notifiedSnoozes:${currentUser.id}` : null;
}

function checkSnoozeWakeups() {
  if (!currentUser) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const storageKey = notifiedSnoozesKey();
  let notified;
  try { notified = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { notified = {}; }
  let changed = false;
  const consider = (item, kind, label) => {
    if (!item.snoozedUntil || item.snoozedUntil.length <= 10) return; // nur bei Uhrzeit
    const dueAt = new Date(item.snoozedUntil).getTime();
    const key = `${kind}:${item.id}:${item.snoozedUntil}`;
    if (dueAt <= Date.now() && !notified[key]) {
      const body = (kind === 'todo' && item.isPrivate) ? 'Ein privates Todo ist aufgewacht' : `${label}: ${item.title}`;
      new Notification('ThreadStack — aufgewacht', { body });
      notified[key] = true; changed = true;
    }
  };
  todos.forEach(t => consider(t, 'todo', 'Todo'));
  meetings.forEach(m => (m.topics || []).forEach(t => consider(t, 'topic', 'Thema')));
  if (changed) {
    const keys = Object.keys(notified);
    if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete notified[k]);
    localStorage.setItem(storageKey, JSON.stringify(notified));
  }
}

// ── Move Modal ───────────────────────────────────────────────
function openMoveModalForTopic(mid, tid) {
  const t = getTopic(mid, tid);
  if (!t) return;
  moveSrcCtx = { type: 'topic', mid, tid, title: t.title };

  document.getElementById('move-modal-title').textContent = 'Thema verschieben';
  document.getElementById('move-modal-info').textContent  =
    `„${t.title}" verschieben — wählen Sie das Ziel. Das Thema wird vollständig dorthin verschoben.`;

  const others = meetings.filter(m => m.id !== mid);
  const sel = document.getElementById('move-target-select');
  sel.innerHTML =
    `<option value="">📋 Persönliche Todos</option>` +
    others.map(m => `<option value="${m.id}">📅 ${escHtml(m.title)}</option>`).join('');

  document.getElementById('move-error').style.display = 'none';
  document.getElementById('move-modal').style.display = 'flex';
}

function openMoveModalForTodo(todoId) {
  const t = todos.find(x => x.id === todoId);
  if (!t) return;
  moveSrcCtx = { type: 'todo', todoId, title: t.title };

  document.getElementById('move-modal-title').textContent = 'Todo verschieben';
  document.getElementById('move-modal-info').textContent  =
    `„${t.title}" in ein Meeting verschieben — z. B. um es dort an jemanden zu übergeben.`;

  const sel = document.getElementById('move-target-select');
  if (meetings.length === 0) {
    sel.innerHTML = '<option value="" disabled>Keine Meetings vorhanden</option>';
  } else {
    sel.innerHTML = meetings.map(m => `<option value="${m.id}">📅 ${escHtml(m.title)}</option>`).join('');
  }

  document.getElementById('move-error').style.display = 'none';
  document.getElementById('move-modal').style.display = 'flex';
}

function closeMoveModal() { document.getElementById('move-modal').style.display = 'none'; }

async function saveMoveModal() {
  if (!moveSrcCtx) return;
  const targetVal = document.getElementById('move-target-select').value;
  const errEl = document.getElementById('move-error');
  errEl.style.display = 'none';

  // Todos dürfen nur in ein Meeting (nicht leer lassen)
  if (moveSrcCtx.type === 'todo' && !targetVal) {
    errEl.textContent = 'Bitte ein Meeting auswählen.';
    errEl.style.display = '';
    return;
  }

  setBusy('move-save-btn', true);
  try {
    if (moveSrcCtx.type === 'topic') {
      const body = targetVal ? { targetMeetingId: targetVal } : {};
      const res = await api('POST', `/meetings/${moveSrcCtx.mid}/topics/${moveSrcCtx.tid}/move`, body);
      // Reload both meetings and todos since the item changed type
      await Promise.all([loadMeetings(), loadTodos(), loadThemes(), loadContacts()]);
      closeMoveModal();
      // Navigate to the destination
      if (res.targetType === 'meeting') {
        selectedId = res.targetId;
        toast(`Thema nach „${getMeeting(res.targetId)?.title}" verschoben`);
      } else {
        selectedId = '__todos__';
        toast('Thema in persönliche Todos verschoben');
      }
    } else {
      const res = await api('POST', `/todos/${moveSrcCtx.todoId}/move`, { targetMeetingId: targetVal });
      await Promise.all([loadMeetings(), loadTodos(), loadThemes(), loadContacts()]);
      closeMoveModal();
      selectedId = res.targetMeetingId;
      toast(`Todo nach „${getMeeting(res.targetMeetingId)?.title}" verschoben`);
    }
    render();
  } catch(e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { setBusy('move-save-btn', false); }
}

// ── Attachments ──────────────────────────────────────────────
const attachCache = {};   // key: "refType/refId" → attachment[]

async function loadAttachments(refType, refId, readOnly) {
  const key = `${refType}/${refId}`;
  try {
    const list = await api('GET', `/attachments/${refType}/${refId}`);
    attachCache[key] = list;
  } catch(e) {
    attachCache[key] = [];
  }
  renderAttachSection(refType, refId, readOnly);
}

async function uploadAttachment(refType, refId, file) {
  const key = `${refType}/${refId}`;
  const containerId = `attach-list-${refType}-${refId}`;
  // Show uploading placeholder
  const placeholder = document.createElement('div');
  placeholder.className = 'attach-uploading';
  placeholder.textContent = `⏫ ${file.name} wird hochgeladen …`;
  const listEl = document.getElementById(containerId);
  if (listEl) listEl.appendChild(placeholder);
  try {
    const base = window.__TS_BASE__ || '';
    const resp = await fetch(`${base}/api/attachments/${refType}/${refId}?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (resp.status === 401) { handleSessionExpiry(); throw new Error('Sitzung abgelaufen'); }
    if (!resp.ok) { const t = await resp.text(); throw new Error(t || resp.statusText); }
    await loadAttachments(refType, refId);
    updateAttachBadge(refType, refId);
    toast(`${file.name} hochgeladen`);
  } catch(e) {
    toast(`Upload fehlgeschlagen: ${e.message}`, 'error');
    placeholder.remove();
  }
}

async function deleteAttachment(id, refType, refId) {
  try {
    await api('DELETE', `/attachments/${id}`);
    const key = `${refType}/${refId}`;
    if (attachCache[key]) attachCache[key] = attachCache[key].filter(a => a.id !== id);
    renderAttachSection(refType, refId);
    updateAttachBadge(refType, refId);
    toast('Anhang gelöscht');
  } catch(e) { toast(e.message, 'error'); }
}

function renderAttachSection(refType, refId, readOnly) {
  const key = `${refType}/${refId}`;
  const list = attachCache[key] || [];
  const listEl = document.getElementById(`attach-list-${refType}-${refId}`);
  if (!listEl) return;
  listEl.innerHTML = list.map(a => {
    const icon = fileIcon(a.mimeType);
    const base = window.__TS_BASE__ || '';
    return `<div class="attach-item">
      <span class="attach-icon">${icon}</span>
      <a class="attach-name" href="${base}/api/attachments/download/${a.id}" target="_blank" download="${escHtml(a.filename)}">${escHtml(a.filename)}</a>
      <span class="attach-size">${fmtFileSize(a.size)}</span>
      ${readOnly ? '' : `<button class="attach-del" title="Löschen" onclick="deleteAttachment('${a.id}','${refType}','${refId}')">✕</button>`}
    </div>`;
  }).join('');
}

function updateAttachBadge(refType, refId) {
  const key = `${refType}/${refId}`;
  const count = (attachCache[key] || []).length;
  // Update all badge elements with data-attach-ref matching this key
  document.querySelectorAll(`[data-attach-ref="${key}"]`).forEach(el => {
    if (count > 0) { el.textContent = `📎 ${count}`; el.style.display = ''; }
    else el.style.display = 'none';
  });
}

function fileIcon(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('excel') || mime.includes('sheet')) return '📊';
  if (mime.includes('powerpoint') || mime.includes('presentation')) return '📑';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('gz')) return '🗜️';
  return '📄';
}

function fmtFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

function attachSectionHtml(refType, refId, readOnly) {
  return `
    <div class="attach-section" id="attach-section-${refType}-${refId}">
      <div class="attach-section-title">📎 Anhänge</div>
      ${readOnly ? '' : `<label class="attach-drop-zone" id="attach-drop-${refType}-${refId}"
        ondragover="event.preventDefault();this.classList.add('drag-over')"
        ondragleave="this.classList.remove('drag-over')"
        ondrop="this.classList.remove('drag-over');event.preventDefault();[...event.dataTransfer.files].forEach(f=>uploadAttachment('${refType}','${refId}',f))">
        <input type="file" multiple
          onchange="[...this.files].forEach(f=>uploadAttachment('${refType}','${refId}',f));this.value=''">
        <span>Dateien hierher ziehen oder <u>auswählen</u></span>
      </label>`}
      <div class="attach-list" id="attach-list-${refType}-${refId}"></div>
    </div>`;
}

// ── Todo Modal ───────────────────────────────────────────────
let editTodoId = null;

function toggleTodoDoneFields(checked) {
  document.getElementById('todo-result-section').style.display = checked ? '' : 'none';
  if (checked && !document.getElementById('todo-result-date').value)
    document.getElementById('todo-result-date').value = nowLocal();
}

function openTodoModal(id, presetThemeId) {
  editTodoId = id || null;
  const t = id ? todos.find(x => x.id === id) : null;
  todoModalPresetThemeId = id ? null : (presetThemeId || null);
  const hint = document.getElementById('todo-modal-context-hint');
  if (todoModalPresetThemeId) {
    const th = themeById(todoModalPresetThemeId);
    hint.textContent = th ? `Wird mit Topic „${th.title}" verknüpft.` : '';
    hint.style.display = th ? 'block' : 'none';
  } else {
    hint.style.display = 'none';
  }
  document.getElementById('todo-modal-title').textContent = t ? 'Todo bearbeiten' : 'Neues Todo';
  document.getElementById('todo-title').value = t?.title || '';
  setRT('todo-desc', t?.description || '');
  // Beschreibung: bei bestehendem Todo schreibgeschützte Leseansicht,
  // bei Neuanlage sofort editierbar (kein Stift-Klick nötig).
  if (t) {
    document.getElementById('todo-desc-wrapper').style.display = 'none';
    document.getElementById('todo-desc-readview').style.display = '';
    updateTodoDescReadView(t);
  } else {
    document.getElementById('todo-desc-readview').style.display = 'none';
    document.getElementById('todo-desc-wrapper').style.display = '';
  }
  applyTodoSnoozeToForm(t);
  document.getElementById('todo-due').value = t?.dueDate?.slice(0, 10) || '';
  document.getElementById('todo-private').checked = !!t?.isPrivate;
  const dr = document.getElementById('todo-done-row');
  if (t) {
    dr.style.display = '';
    document.getElementById('todo-done').checked = !!t.done;
    setRT('todo-result', t.result || '');
    document.getElementById('todo-result-date').value = t.resultDate || '';
    document.getElementById('todo-result-section').style.display = t.done ? '' : 'none';
  } else {
    dr.style.display = 'none';
    document.getElementById('todo-result-section').style.display = 'none';
  }
  // Attachments section (only when editing)
  const attachSlot = document.getElementById('todo-attach-slot');
  if (id) {
    attachSlot.innerHTML = attachSectionHtml('todo', id);
    loadAttachments('todo', id);
  } else {
    attachSlot.innerHTML = '<p style="font-size:.8125rem;color:var(--text-muted);font-style:italic">Anhänge sind verfügbar, sobald das Todo gespeichert wurde.</p>';
  }
  // Ansprechpartner-Zuordnung (Arbeitspaket W2/TSContacts): wie Anhänge nur
  // verfügbar, sobald das Todo existiert (Zuordnungen brauchen eine refId).
  const contactsSection = document.getElementById('todo-contacts-section');
  if (t) {
    contactsSection.style.display = '';
    renderTodoContactsChips(t);
  } else {
    contactsSection.style.display = 'none';
  }
  updateTodoMoreDetailsSummary();
  mountTodoProgressArea(t);
  document.getElementById('todo-theme-filter').value = '';
  todoThemeSelection = new Set(
    t ? (buildThemeMap()[t.id] || []).filter(x => x.link.refType === 'todo').map(x => x.theme.id)
      : (todoModalPresetThemeId ? [todoModalPresetThemeId] : [])
  );
  renderTodoThemeChecklist();
  document.getElementById('todo-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('todo-title').focus(), 50);
  // Snapshot NACH allen obigen Feld-Initialisierungen für den Dirty-Check
  // (Verwerfen-Rückfrage bei Abbrechen/Overlay-Klick/Escape).
  todoModalSnapshot = JSON.stringify(collectTodoFormData());
}

async function saveTodoModal() {
  const title = document.getElementById('todo-title').value.trim();
  if (!title) { document.getElementById('todo-title').focus(); return; }
  const isDone = editTodoId ? document.getElementById('todo-done').checked : false;
  const todoSnoozeHasTimeSave = document.getElementById('todo-snooze-has-time').checked;
  if (todoSnoozeHasTimeSave) requestNotificationPermissionIfNeeded();
  const data = { title, description: getRT('todo-desc'),
    isPrivate: document.getElementById('todo-private').checked,
    snoozedUntil: (() => {
      const d = document.getElementById('todo-snooze').value;
      if (!d) return null;
      if (todoSnoozeHasTimeSave) {
        const time = document.getElementById('todo-snooze-time').value || '00:00';
        return new Date(`${d}T${time}`).toISOString();
      }
      return d;
    })(),
    dueDate: document.getElementById('todo-due').value || null,
    ...(editTodoId ? {
      done: isDone,
      result: isDone ? getRT('todo-result') : '',
      resultDate: isDone ? document.getElementById('todo-result-date').value : '',
    } : {}) };
  setBusy('todo-save-btn', true);
  let savedTodoId = null;
  // Vor dem Speichern merken, ob dies ein Anlegen- oder Bearbeiten-Vorgang
  // ist — für die Erfolgsmeldung, da editTodoId weiter unten ggf. schon vor
  // dem Ende der Funktion auf die neu vergebene Id gesetzt wird (Fund 2).
  const wasNewTodo = !editTodoId;
  try {
    if (editTodoId) {
      await api('PUT', `/todos/${editTodoId}`, data);
      Object.assign(todos.find(t => t.id === editTodoId), { ...data, isPrivate: data.isPrivate });
      savedTodoId = editTodoId;
    } else {
      const t = await api('POST', '/todos', data);
      todos.push(t);
      savedTodoId = t.id;
      // Sicherheitsfix (Security Review, Mittel, Fund 2): editTodoId SOFORT
      // nach erfolgreichem Anlegen auf die neu vergebene Id setzen. Läuft ein
      // erneuter Klick auf "Speichern" (z.B. nach einem zwischenzeitlichen
      // Fehler) dadurch in den Update-Zweig (PUT) statt erneut ein Todo
      // anzulegen — verhindert ein doppelt angelegtes Todo.
      editTodoId = savedTodoId;
    }
    // Topic-Zuordnung wird immer (Anlegen UND Bearbeiten) ueber den
    // Auswahl-Dialog gesteuert - ersetzt das frühere Auto-Link-nur-bei-
    // Neuanlage-aus-Topic-Kontext-Verhalten (siehe Requirements Fix 3).
    try {
      await api('PUT', `/todos/${savedTodoId}/themes`, { themeIds: [...todoThemeSelection] });
      await loadThemes();
    } catch (e) { toast(e.message, 'error'); }
    todoModalPresetThemeId = null;
    // Der Fortschritts-Composer ist seit dem Redesign "Übersichtlichere Todos
    // und Tasks" ein eigenständiger, selbst-speichernder Baustein
    // (TSProgress.mountInlineComposer, siehe mountProgressArea) - er hat
    // seine eigene "Speichern"-Aktion und muss beim Speichern des Todos
    // selbst nicht mehr committet werden. Themen nutzen seit der
    // Vereinheitlichung denselben Composer (siehe saveTopicModal).
    closeTodoModal(true); render();
    await loadThemeDetail(); render();
    if (savedTodoId && !data.done) triggerThemeSuggestions('todo', savedTodoId);
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('todo-save-btn', false); }
}

async function reopenPersonalTodo(id) {
  try {
    await api('PUT', `/todos/${id}`, { done: false });
    Object.assign(todos.find(t => t.id === id), { done: false });
    render(); toast('Todo wieder geöffnet');
  } catch(e) { toast(e.message, 'error'); }
}

function confirmDeleteTodo(id, name) {
  confirmCallback = async () => {
    try {
      await api('DELETE', `/todos/${id}`);
      todos = todos.filter(t => t.id !== id);
      await loadThemeDetail();
      render(); toast(`Todo „${name}" gelöscht`);
    } catch(e) { toast(e.message, 'error'); }
  };
  document.getElementById('confirm-title').textContent   = 'Todo löschen?';
  document.getElementById('confirm-message').textContent = `„${name}" wird unwiderruflich gelöscht.`;
  document.getElementById('confirm-dialog').style.display = 'flex';
}

async function toggleTopicTodo(mid, tid) {
  const t = getTopic(mid, tid);
  if (!t) return;
  try {
    await api('PUT', `/meetings/${mid}/topics/${tid}`, { isTodo: !t.isTodo });
    t.isTodo = !t.isTodo;
    render();
    toast(t.isTodo ? 'Als Todo markiert' : 'Todo-Markierung entfernt');
  } catch(e) { toast(e.message, 'error'); }
}

async function markMeetingTopicDone(mid, tid) {
  try {
    await api('PUT', `/meetings/${mid}/topics/${tid}`, { done: true });
    Object.assign(getTopic(mid, tid), { done: true });
    render(); toast('Als erledigt markiert');
  } catch(e) { toast(e.message, 'error'); }
}

const VIEW_LABELS = { '__themes__':'Wissen', '__contacts__':'Ansprechpartner', '__todos__':'Meine Todos', '__eod__':'Tagesabschluss', '__stack_history__':'Stack-Historie', '__digest__':'Wochen-Digest', '__momentum__':'Fortschritt', '__graph__':'Graph', '__archive__':'Archiv', '__archive_detail__':'Archiv' };
function updateTopbar(title) {
  const el = document.getElementById('topbar-title');
  if (el) el.textContent = title || '—';
}
function selectView(id) {
  selectedId = id; topicFilter = ''; closeMobileSidebar();
  if (id === '__themes__' || id === '__contacts__' || id === '__graph__') lastWissenView = id; else lastTodosView = id;
  updateTopbar(VIEW_LABELS[id] || '—');
  render(); refreshAiUiVisibility();
  if (id === '__themes__') { loadKnowledgePages().then(render); }
}

// ── Drag & Drop (todo reorder) ───────────────────────────────
let todoDragId = null;

function todoDragStart(e, id) {
  todoDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const el = document.querySelector(`.topic-card[data-todoid="${id}"]`);
    if (el) el.classList.add('dragging');
  }, 0);
}
function todoDragEnd() {
  document.querySelectorAll('.topic-card.dragging,.topic-card.drop-above,.topic-card.drop-below')
    .forEach(el => el.classList.remove('dragging','drop-above','drop-below'));
}
function todoDragOver(e, id) {
  if (todoDragId === id) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.topic-card.drop-above,.topic-card.drop-below')
    .forEach(el => el.classList.remove('drop-above','drop-below'));
  const el = document.querySelector(`.topic-card[data-todoid="${id}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  el.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
}
function todoDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget))
    e.currentTarget.classList.remove('drop-above','drop-below');
}
async function todoDrop(e, id) {
  e.preventDefault();
  if (todoDragId === id) return;
  const el = document.querySelector(`.topic-card[data-todoid="${id}"]`);
  const above = el?.classList.contains('drop-above');
  todoDragEnd();

  const openTodos = todos.filter(t => !t.done && !isSnoozed(t));
  const snoozed   = todos.filter(t => !t.done &&  isSnoozed(t));
  const doneTodos = todos.filter(t =>  t.done);

  const from = openTodos.findIndex(t => t.id === todoDragId);
  if (from === -1) return;
  const [dragged] = openTodos.splice(from, 1);
  const to = openTodos.findIndex(t => t.id === id);
  if (to === -1) return;
  openTodos.splice(above ? to : to + 1, 0, dragged);

  // sortOrder lokal aktualisieren, damit render() nicht zurücksortiert
  openTodos.forEach((t, i) => { t.sortOrder = i; });

  todos = [...openTodos, ...snoozed, ...doneTodos];
  render();
  try {
    await api('PUT', '/todos/reorder', { ids: openTodos.map(t => t.id) });
  } catch(err) { toast(err.message, 'error'); }
}

async function moveToTopTodo(id) {
  const openTodos = todos.filter(t => !t.done && !isSnoozed(t));
  const idx = openTodos.findIndex(t => t.id === id);
  if (idx <= 0) return;
  const [item] = openTodos.splice(idx, 1);
  openTodos.unshift(item);
  openTodos.forEach((t, i) => { t.sortOrder = i; });
  todos = [...openTodos, ...todos.filter(t => !t.done && isSnoozed(t)), ...todos.filter(t => t.done)];
  render();
  try { await api('PUT', '/todos/reorder', { ids: openTodos.map(t => t.id) }); }
  catch(err) { toast(err.message, 'error'); }
}

async function moveToTopTopic(mid, tid) {
  const m = getMeeting(mid);
  const open = m.topics.filter(t => !t.done);
  const idx = open.findIndex(t => t.id === tid);
  if (idx <= 0) return;
  const [item] = open.splice(idx, 1);
  open.unshift(item);
  m.topics = [...open, ...m.topics.filter(t => t.done)];
  render();
  try { await api('PUT', `/meetings/${mid}/topics/reorder`, { ids: m.topics.map(t => t.id) }); }
  catch(err) { toast(err.message, 'error'); }
}

// ── Drag & Drop (meeting reorder) ───────────────────────────
let meetingDragId = null;

function meetingDragStart(e, id) {
  meetingDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const el = document.querySelector(`.meeting-item[data-mid="${id}"]`);
    if (el) el.classList.add('dragging');
  }, 0);
}

function meetingDragEnd() {
  document.querySelectorAll('.meeting-item.dragging,.meeting-item.drop-above,.meeting-item.drop-below')
    .forEach(el => el.classList.remove('dragging','drop-above','drop-below'));
}

function meetingDragOver(e, id) {
  if (meetingDragId === id) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.meeting-item.drop-above,.meeting-item.drop-below')
    .forEach(el => el.classList.remove('drop-above','drop-below'));
  const el = document.querySelector(`.meeting-item[data-mid="${id}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  el.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
}

function meetingDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget))
    e.currentTarget.classList.remove('drop-above','drop-below');
}

async function meetingDrop(e, id) {
  e.preventDefault();
  if (meetingDragId === id) return;
  const el = document.querySelector(`.meeting-item[data-mid="${id}"]`);
  const above = el?.classList.contains('drop-above');
  meetingDragEnd();

  const fromIdx = meetings.findIndex(m => m.id === meetingDragId);
  const [dragged] = meetings.splice(fromIdx, 1);
  const toIdx = meetings.findIndex(m => m.id === id);
  meetings.splice(above ? toIdx : toIdx + 1, 0, dragged);

  renderSidebar();
  try {
    await api('PUT', '/meetings/reorder', { ids: meetings.map(m => m.id) });
  } catch(err) { toast(err.message, 'error'); }
}

// ── Drag & Drop (topic reorder) ──────────────────────────────
let dragMid = null, dragTid = null, dragGroup = null;

function topicDragStart(e, mid, tid, group) {
  dragMid = mid; dragTid = tid; dragGroup = group;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const card = document.querySelector(`.topic-card[data-tid="${tid}"]`);
    if (card) card.classList.add('dragging');
  }, 0);
}

function topicDragEnd() {
  document.querySelectorAll('.topic-card.dragging,.topic-card.drop-above,.topic-card.drop-below')
    .forEach(el => el.classList.remove('dragging','drop-above','drop-below'));
}

function topicDragOver(e, mid, tid, group) {
  if (dragMid !== mid || dragGroup !== group) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (dragTid === tid) return;
  document.querySelectorAll('.topic-card.drop-above,.topic-card.drop-below')
    .forEach(el => el.classList.remove('drop-above','drop-below'));
  const card = document.querySelector(`.topic-card[data-tid="${tid}"]`);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
}

function topicDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget))
    e.currentTarget.classList.remove('drop-above','drop-below');
}

async function topicDrop(e, mid, tid, group) {
  e.preventDefault();
  if (dragMid !== mid || dragGroup !== group || dragTid === tid) return;
  const card = document.querySelector(`.topic-card[data-tid="${tid}"]`);
  const above = card?.classList.contains('drop-above');
  topicDragEnd();

  const m = getMeeting(mid);
  const grpTopics = m.topics.filter(t => (t.done ? 'done' : 'open') === group);
  const otherTopics = m.topics.filter(t => (t.done ? 'done' : 'open') !== group);

  const fromIdx = grpTopics.findIndex(t => t.id === dragTid);
  const [dragged] = grpTopics.splice(fromIdx, 1);
  const toIdx = grpTopics.findIndex(t => t.id === tid);
  grpTopics.splice(above ? toIdx : toIdx + 1, 0, dragged);

  m.topics = group === 'open' ? [...grpTopics, ...otherTopics] : [...otherTopics, ...grpTopics];
  render();

  try {
    await api('PUT', `/meetings/${mid}/topics/reorder`, { ids: m.topics.map(t => t.id) });
  } catch(err) { toast(err.message, 'error'); }
}

// ── Meeting Modal ────────────────────────────────────────────
function openMeetingModal(id) {
  editMeetingId = id || null;
  const m = id ? getMeeting(id) : null;
  document.getElementById('mm-title').textContent         = m ? 'Meeting bearbeiten' : 'Neues Meeting';
  document.getElementById('m-title').value                = m?.title || '';
  setRT('m-desc', m?.description || '');
  document.getElementById('m-participants').value         = (m?.participants||[]).join(', ');
  document.getElementById('m-date').value                 = m?.nextDate || '';
  document.getElementById('m-recurring').checked          = !!m?.isRecurring;
  document.getElementById('m-pattern').value              = m?.recurrencePattern || 'weekly';
  document.getElementById('m-recurrence-section').style.display = m?.isRecurring ? '' : 'none';
  const cur = m?.color || COLORS[0];
  document.getElementById('m-color-picker').innerHTML = COLORS.map(c =>
    `<div class="color-swatch ${c===cur?'selected':''}" style="background:${c}" onclick="selectColor('${c}')"></div>`
  ).join('');
  document.getElementById('meeting-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('m-title').focus(), 50);
}

function selectColor(c) {
  document.querySelectorAll('#m-color-picker .color-swatch').forEach(s => {
    const sc = s.style.backgroundColor || s.style.background;
    s.classList.toggle('selected', sc === c || rgbToHex(sc) === c);
  });
}

function closeMeetingModal() { document.getElementById('meeting-modal').style.display = 'none'; }

async function saveMeetingModal() {
  const title = document.getElementById('m-title').value.trim();
  if (!title) { document.getElementById('m-title').focus(); return; }
  const swatch   = document.querySelector('#m-color-picker .color-swatch.selected');
  const rawColor = swatch ? (swatch.style.backgroundColor || swatch.style.background) : COLORS[0];
  const isRecurring = document.getElementById('m-recurring').checked;
  const data = {
    title,
    description: getRT('m-desc'),
    participants: document.getElementById('m-participants').value.split(',').map(s=>s.trim()).filter(Boolean),
    nextDate: document.getElementById('m-date').value,
    isRecurring,
    recurrencePattern: isRecurring ? document.getElementById('m-pattern').value : '',
    color: rawColor.startsWith('rgb') ? rgbToHex(rawColor) : rawColor,
  };
  setBusy('mm-save-btn', true);
  try {
    if (editMeetingId) {
      await api('PUT', `/meetings/${editMeetingId}`, data);
      Object.assign(getMeeting(editMeetingId), data);
    } else {
      const m = await api('POST', '/meetings', data);
      meetings.push(m); selectedId = m.id;
    }
    closeMeetingModal(); render();
    toast(editMeetingId ? 'Meeting aktualisiert' : 'Meeting erstellt');
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('mm-save-btn', false); }
}

// ── Topic Modal ──────────────────────────────────────────────
function openTopicModal(mid, tid) {
  editTopicMid = mid; editTopicId = tid || null;
  const t = tid ? getTopic(mid, tid) : null;
  document.getElementById('tm-title').textContent = t ? 'Thema bearbeiten' : 'Neues Thema';
  document.getElementById('t-title').value = t?.title || '';
  setRT('t-desc', t?.description || '');
  // Beschreibung: bei bestehendem Thema schreibgeschützte Leseansicht, bei
  // Neuanlage sofort editierbar (identisch zum Todo-Modal, Story 5/10).
  if (t) {
    document.getElementById('t-desc-wrapper').style.display = 'none';
    document.getElementById('t-desc-readview').style.display = '';
    updateTopicDescReadView(t);
  } else {
    document.getElementById('t-desc-readview').style.display = 'none';
    document.getElementById('t-desc-wrapper').style.display = '';
  }
  applyTopicSnoozeToForm(t);
  updateTopicMoreDetailsSummary();
  const rs = document.getElementById('t-result-section');
  if (t) {
    rs.style.display = '';
    setRT('t-result', t.result || '');
    document.getElementById('t-result-date').value = t.resultDate || '';
    document.getElementById('t-done').checked      = !!t.done;
  } else { rs.style.display = 'none'; }
  // Attachments section (only when editing)
  const attachSlot = document.getElementById('topic-attach-slot');
  if (tid) {
    attachSlot.innerHTML = attachSectionHtml('topic', tid);
    loadAttachments('topic', tid);
  } else {
    attachSlot.innerHTML = '<p style="font-size:.8125rem;color:var(--text-muted);font-style:italic">Anhänge sind verfügbar, sobald das Thema gespeichert wurde.</p>';
  }
  // Ansprechpartner-Zuordnung (Arbeitspaket W2/TSContacts): wie Anhänge nur
  // verfügbar, sobald das Thema existiert (Zuordnungen brauchen eine refId).
  const topicContactsSection = document.getElementById('topic-contacts-section');
  if (t) {
    topicContactsSection.style.display = '';
    renderTopicContactsChips(t);
  } else {
    topicContactsSection.style.display = 'none';
  }
  document.getElementById('topic-modal').style.display = 'flex';
  // Fortschrittsbereich erscheint nur beim Bearbeiten eines bestehenden
  // Themas, identisch zum Todo-Modal (mountTodoProgressArea/
  // mountTopicProgressArea teilen sich seit der Vereinheitlichung
  // dieselbe Implementierung, siehe mountProgressArea).
  mountTopicProgressArea(t);
  setTimeout(() => { document.getElementById('t-title').focus(); }, 50);
}

function closeTopicModal() {
  document.getElementById('topic-modal').style.display = 'none';
}

// Ersetzt ALLE direkten Schließ-Aufrufe für das Topic-Modal (×, Abbrechen,
// Overlay-Klick, Escape) - analog zum Todo-Modal gibt es fuer den
// Zwischenstand-Composer selbst keine eigene Verwerfen-Rueckfrage mehr (der
// Composer ist selbstspeichernd, siehe mountProgressArea).
function requestCloseTopicModal() {
  closeTopicModal();
}

function topicModalOverlayClick(e) {
  if (e.target.id !== 'topic-modal') return;
  const modal = document.getElementById('topic-modal');
  const progressSection = document.getElementById('t-progress-section');
  const hasText =
    [...modal.querySelectorAll('input[type="text"], input[type="email"], textarea')]
      .filter(el => !(progressSection && progressSection.contains(el)))
      .some(el => el.value.trim() !== '') ||
    [...modal.querySelectorAll('.rt-content')]
      .some(el => (el.textContent || '').trim() !== '');
  if (hasText) return;
  requestCloseTopicModal();
}

async function saveTopicModal() {
  const title = document.getElementById('t-title').value.trim();
  if (!title) { document.getElementById('t-title').focus(); return; }
  const topicSnoozeHasTimeSave = document.getElementById('t-snooze-has-time').checked;
  if (topicSnoozeHasTimeSave) requestNotificationPermissionIfNeeded();
  const data = {
    title,
    description: getRT('t-desc'),
    snoozedUntil: (() => {
      const d = document.getElementById('t-snooze').value;
      if (!d) return null;
      if (topicSnoozeHasTimeSave) {
        const time = document.getElementById('t-snooze-time').value || '00:00';
        return new Date(`${d}T${time}`).toISOString();
      }
      return d;
    })(),
    ...(editTopicId ? {
      result:     getRT('t-result'),
      resultDate: document.getElementById('t-result-date').value,
      done:       document.getElementById('t-done').checked,
    } : {}),
  };
  setBusy('tm-save-btn', true);
  let savedTopicId = null;
  // Vor dem Speichern merken, ob dies ein Anlegen- oder Bearbeiten-Vorgang
  // ist — für die Erfolgsmeldung, da editTopicId weiter unten ggf. schon vor
  // dem Ende der Funktion auf die neu vergebene Id gesetzt wird (Fund 2).
  const wasNewTopic = !editTopicId;
  try {
    if (editTopicId) {
      const t = getTopic(editTopicMid, editTopicId);
      await api('PUT', `/meetings/${editTopicMid}/topics/${editTopicId}`, data);
      if (t?.groupId) {
        await loadMeetings();
      } else {
        Object.assign(t, data);
      }
      savedTopicId = editTopicId;
    } else {
      const t = await api('POST', `/meetings/${editTopicMid}/topics`, data);
      getMeeting(editTopicMid).topics.push(t);
      savedTopicId = t.id;
      // Sicherheitsfix (Security Review, Mittel, Fund 2): editTopicId SOFORT
      // nach erfolgreichem Anlegen auf die neu vergebene Id setzen - analog
      // zu saveTodoModal() (siehe dortiger Kommentar).
      editTopicId = savedTopicId;
    }
    // Der Fortschritts-Composer ist seit der Vereinheitlichung mit dem
    // Todo-Modal ein eigenständiger, selbst-speichernder Baustein (siehe
    // mountProgressArea) und muss beim Speichern des Themas selbst nicht
    // mehr committet werden (kein commitProgressComposer mehr für Themen).
    closeTopicModal();
    toast(wasNewTopic ? 'Thema hinzugefügt' : 'Thema aktualisiert');
    render();
    if (savedTopicId && !data.done) triggerThemeSuggestions('topic', savedTopicId);
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('tm-save-btn', false); }
}

// ── Complete Modal ───────────────────────────────────────────
function openCompleteTodoModal(id) {
  completeMid = null; completeTid = null; completeTodoId = id;
  const t = todos.find(x => x.id === id);
  setRT('c-result', t?.result || '');
  document.getElementById('c-date').value = t?.resultDate || nowLocal();
  aiResultDraftCtx = { refType: 'todo', refId: id };
  document.getElementById('c-result-draft-status').textContent = '';
  refreshAiUiVisibility();
  document.getElementById('complete-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('c-result').focus(), 50);
}

function openCompleteModal(mid, tid) {
  completeMid = mid; completeTid = tid; completeTodoId = null;
  const t = getTopic(mid, tid);
  setRT('c-result', t?.result || '');
  document.getElementById('c-date').value   = t?.resultDate || nowLocal();
  aiResultDraftCtx = { refType: 'topic', refId: tid };
  document.getElementById('c-result-draft-status').textContent = '';
  refreshAiUiVisibility();
  document.getElementById('complete-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('c-result').focus(), 50);
}
function closeCompleteModal() { document.getElementById('complete-modal').style.display = 'none'; }

async function saveCompleteModal() {
  const data = { done: true, result: getRT('c-result'), resultDate: document.getElementById('c-date').value };
  // Sichtbarer Fortschritt (Arbeitspaket M4): Client-Zeitzone mitschicken,
  // damit "aktiver Tag"/Wochenzähler serverseitig korrekt zugeordnet werden
  // (siehe Architektur-Vertrag M1/M2) - additiv, ändert nichts am
  // bestehenden Verhalten für Nutzer ohne das Momentum-Modul.
  if (window.TSMomentum) data.utcOffsetMinutes = window.TSMomentum.utcOffsetMinutes();
  setBusy('cm-save-btn', true);
  try {
    let res;
    if (completeTodoId) {
      res = await api('PUT', `/todos/${completeTodoId}`, data);
      Object.assign(todos.find(t => t.id === completeTodoId), data);
    } else {
      res = await api('PUT', `/meetings/${completeMid}/topics/${completeTid}`, data);
      Object.assign(getTopic(completeMid, completeTid), data);
    }
    closeCompleteModal(); render();
    if (window.TSMomentum && res?.momentum) {
      window.TSMomentum.showCompletionToast(res.momentum);
      loadMomentumBadge().then(render);
    } else {
      toast('Als erledigt markiert');
    }
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('cm-save-btn', false); }
}

async function reopenTopic(mid, tid) {
  try {
    await api('PUT', `/meetings/${mid}/topics/${tid}`, { done: false });
    Object.assign(getTopic(mid, tid), { done: false });
    render(); toast('Thema wieder geöffnet');
  } catch(e) { toast(e.message, 'error'); }
}

// ── Shared topics ────────────────────────────────────────────
function buildGroupMap() {
  const map = {};
  for (const m of meetings) {
    for (const t of (m.topics || [])) {
      if (t.groupId) {
        if (!map[t.groupId]) map[t.groupId] = [];
        map[t.groupId].push({ meeting: m, topic: t });
      }
    }
  }
  return map;
}

// ── Themes (Topics) ──────────────────────────────────────────
function buildThemeMap() {
  const map = {};
  for (const th of themes) {
    for (const link of th.links) {
      if (!map[link.refId]) map[link.refId] = [];
      map[link.refId].push({ theme: th, link });
    }
  }
  return map;
}

// ── Topic-Baum: Hilfsfunktionen ─────────────────────────────
function themeById(id) { return themes.find(t => t.id === id); }
function themeChildren(parentId) {
  return themes.filter(t => (t.parentId || null) === parentId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
function themeAncestorsPath(id) {
  const path = [];
  let cur = themeById(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    path.unshift(cur); seen.add(cur.id);
    cur = cur.parentId ? themeById(cur.parentId) : null;
  }
  return path;
}
function themeDescendantIdsClient(id) {
  const out = []; const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of themeChildren(cur)) { out.push(c.id); stack.push(c.id); }
  }
  return out;
}

// Nach Änderungen an Topics/Wissen: Baum neu laden, Detailansicht aktualisieren
async function afterThemeMutation() {
  await Promise.all([loadThemes(), loadKnowledgePages()]);
  if (selectedThemeId && !themeById(selectedThemeId)) selectedThemeId = null;
  await loadThemeDetail();
}

async function loadThemeDetail() {
  if (!selectedThemeId) { themeDetailKnowledge = []; themeDetailTodos = []; return; }
  themeDetailLoading = true;
  try {
    const [kn, td] = await Promise.all([
      api('GET', `/themes/${selectedThemeId}/knowledge?includeDescendants=${themeShowDescendants}`),
      api('GET', `/themes/${selectedThemeId}/todos?includeDescendants=${themeShowDescendants}`),
    ]);
    themeDetailKnowledge = kn; themeDetailTodos = td;
  } catch(e) { toast(e.message, 'error'); themeDetailKnowledge = []; themeDetailTodos = []; }
  finally { themeDetailLoading = false; }
}

async function selectTheme(id) {
  selectedId = '__themes__';
  lastWissenView = '__themes__';
  selectedThemeId = id;
  let cur = themeById(id);
  while (cur && cur.parentId) { expandedThemeIds.add(cur.parentId); cur = themeById(cur.parentId); }
  themeDetailLoading = true; render();
  await loadThemeDetail();
  render();
}

async function toggleThemeDescendants() {
  themeShowDescendants = !themeShowDescendants;
  themeDetailLoading = true; render();
  await loadThemeDetail();
  render();
}

function toggleThemeExpand(id) {
  if (expandedThemeIds.has(id)) expandedThemeIds.delete(id); else expandedThemeIds.add(id);
  render();
}

// ── Topic-Baum: Rendering ────────────────────────────────────
function renderThemesView(el) {
  el.innerHTML = `<div class="full-width-view">${renderThemeDetailPanel()}</div>`;
}

// Rendert einen Baum-Knoten für die dunkle Sidebar (Wissen-Modus).
function renderThemeTreeNode(theme) {
  const children = themeChildren(theme.id);
  const hasChildren = children.length > 0;
  const expanded = expandedThemeIds.has(theme.id);
  const active = theme.id === selectedThemeId;
  return `
    <div class="sb-tree-node">
      <div class="sb-tree-row ${active ? 'active' : ''}" onclick="selectTheme('${theme.id}')">
        <span class="sb-tree-toggle ${hasChildren ? '' : 'leaf'}"
          onclick="event.stopPropagation();toggleThemeExpand('${theme.id}')"
          style="transform:rotate(${hasChildren && expanded ? '90deg' : '0deg'})">${hasChildren ? '▸' : ''}</span>
        <span class="sb-tree-icon-chip"><span class="sb-tree-icon-dot"></span></span>
        <span class="sb-tree-label" title="${escHtml(theme.title)}">${escHtml(theme.title)}</span>
      </div>
      ${hasChildren && expanded ? `<div class="sb-tree-children">${children.map(c => renderThemeTreeNode(c)).join('')}</div>` : ''}
    </div>`;
}

function renderThemeDetailPanel() {
  if (!selectedThemeId) {
    return `<div class="theme-detail-panel">${renderKnowledgeGrid()}</div>`;
  }
  const theme = themeById(selectedThemeId);
  if (!theme) { selectedThemeId = null; return renderThemeDetailPanel(); }
  const path = themeAncestorsPath(theme.id);
  const children = themeChildren(theme.id);

  const linkedTopics = theme.links.filter(l => l.refType === 'topic').map(link => {
    for (const m of meetings) {
      const t = (m.topics || []).find(x => x.id === link.refId);
      if (t) return { type: 'topic', item: t, link, meeting: m };
    }
    return null;
  }).filter(Boolean);
  const todoThemeMap = buildThemeMap();
  // themeDetailTodos ist ein separat geladener Snapshot (GET /themes/:id/todos);
  // Aktionen wie Erledigen/Wiedereröffnen/Wecken/Verschieben aendern nur das
  // globale todos-Array. Vor dem Rendern die bereits geladenen Eintraege mit
  // dem aktuellen globalen Stand abgleichen, damit z.B. "Erledigt" sofort
  // sichtbar wird, ohne auf den naechsten loadThemeDetail()-Roundtrip zu warten.
  themeDetailTodos = themeDetailTodos.map(t => {
    const g = todos.find(x => x.id === t.id);
    return g ? { ...t, ...g } : t;
  });

  return `
    <div class="theme-detail-panel">
      <div class="theme-breadcrumb">
        ${path.map((p, i) => `
          ${i > 0 ? '<span class="theme-breadcrumb-sep">›</span>' : ''}
          <span class="theme-breadcrumb-item ${i === path.length - 1 ? 'current' : ''}"
            ${i === path.length - 1 ? '' : `onclick="selectTheme('${p.id}')"`}>${escHtml(p.title)}</span>
        `).join('')}
      </div>
      <div class="meeting-header" style="margin-bottom:0">
        <div class="meeting-header-accent" style="background:#7c3aed"></div>
        <div class="meeting-header-body">
          <div class="meeting-header-info">
            <h1 class="meeting-title">🏷️ ${escHtml(theme.title)}</h1>
            ${theme.description ? `<p class="meeting-description" style="color:var(--text-muted)">${escHtml(theme.description)}</p>` : ''}
          </div>
          <div class="meeting-header-actions">
            <button class="btn btn-secondary btn-sm" onclick="openThemeModal(null,'${theme.id}')" title="Unter-Topic anlegen">+ Unter-Topic</button>
            <button class="btn btn-secondary btn-sm btn-icon" onclick="openThemeModal('${theme.id}')" title="Bearbeiten">${SVG.pencil}</button>
            <button class="btn btn-secondary btn-sm btn-icon" onclick="openThemeMoveModal('${theme.id}')" title="Verschieben">↕</button>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmDeleteTheme('${theme.id}','${escJsAttr(theme.title)}')" title="Löschen">🗑️</button>
          </div>
        </div>
      </div>

      ${children.length ? `
        <div class="theme-section" style="margin-top:.75rem">
          <div class="theme-section-head"><span class="theme-section-title">🗂️ Unter-Topics (${children.length})</span></div>
          <div style="display:flex;flex-wrap:wrap;gap:.5rem">
            ${children.map(c => `
              <button class="btn btn-secondary btn-sm" onclick="selectTheme('${c.id}')"
                style="border-color:#e9d5ff;background:#faf5ff;color:#6d28d9">🏷️ ${escHtml(c.title)}</button>`).join('')}
          </div>
        </div>
        <label class="theme-descendant-toggle" style="margin:.75rem 0 0">
          <input type="checkbox" ${themeShowDescendants ? 'checked' : ''} onchange="toggleThemeDescendants()">
          Wissen &amp; Todos aus Unter-Topics einbeziehen
        </label>` : ''}

      ${linkedTopics.length ? `
        <div class="theme-section">
          <div class="theme-section-head"><span class="theme-section-title">📅 Verknüpfte Meeting-Themen (${linkedTopics.length})</span></div>
          ${linkedTopics.map(x => renderThemeItemRow(x)).join('')}
        </div>` : ''}

      <div class="theme-section">
        <div class="theme-section-head">
          <span class="theme-section-title">📚 Wissen${themeDetailKnowledge.length ? ` (${themeDetailKnowledge.length})` : ''}</span>
          <span style="display:inline-flex">
            <button class="btn btn-primary btn-sm" style="background:#7c3aed;border-color:#7c3aed;border-radius:6px 0 0 6px" onclick="openQuickKnowledge('${theme.id}')">+ Wissen</button>
            <details class="topic-overflow" onclick="event.stopPropagation()">
              <summary class="btn btn-primary btn-sm btn-icon" style="background:#7c3aed;border-color:#7c3aed;border-radius:0 6px 6px 0;border-left:1px solid rgba(255,255,255,.3)" title="Weitere Optionen">▾</summary>
              <div class="topic-overflow-menu">
                <button onclick="closeAllOverflow(); openKnowledgeModal(null,'${theme.id}')">
                  <span class="icon">📝</span><span>Voller Editor</span>
                </button>
              </div>
            </details>
          </span>
        </div>
        ${themeDetailLoading ? `<p class="theme-empty-items">Lädt …</p>` :
          themeDetailKnowledge.length === 0 ? `<p class="theme-empty-items">Noch kein Wissen hinterlegt.</p>` :
          themeDetailKnowledge.map(k => renderKnowledgeCard(k)).join('')}
      </div>

      <div class="theme-section">
        <div class="theme-section-head">
          <span class="theme-section-title">✅ Todos${themeDetailTodos.length ? ` (${themeDetailTodos.length})` : ''}</span>
          <button class="btn btn-primary btn-sm" style="background:#7c3aed;border-color:#7c3aed" onclick="openTodoModal(null,'${theme.id}')">+ Todo</button>
        </div>
        ${themeDetailLoading ? `<p class="theme-empty-items">Lädt …</p>` :
          themeDetailTodos.length === 0 ? `<p class="theme-empty-items">Noch keine Todos verknüpft.</p>` :
          themeDetailTodos.map(t => renderPersonalTodoCard(t, t.done, todoThemeMap)).join('')}
      </div>
    </div>`;
}

function renderKnowledgeCard(k) {
  const paths = k.themeIds
    .map(id => themeAncestorsPath(id).map(t => t.title).join(' › '))
    .filter(Boolean);
  return `
    <div class="knowledge-card${k.originThemeTitle ? ' knowledge-card--inherited' : ''}">
      <div class="knowledge-card-head">
        <div style="display:flex;align-items:center;gap:.5rem;min-width:0;flex:1">
          <span style="flex-shrink:0">📄</span>
          <span class="knowledge-card-title" onclick="openKnowledgeModal('${k.id}')">${escHtml(k.title)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:.375rem;flex-shrink:0">
          ${k.originThemeTitle ? `<span class="origin-badge" title="Geerbt von Unter-Topic">${escHtml(k.originThemeTitle)}</span>` : ''}
          <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmDeleteKnowledge('${k.id}','${escJsAttr(k.title)}')" title="Löschen">🗑️</button>
        </div>
      </div>
      ${paths.length ? `<div class="knowledge-card-path">${paths.map(p => `🏷️ ${escHtml(p)}`).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>` : ''}
      ${k.content ? `<div class="knowledge-card-body">${displayHtml(k.content)}</div>` : ''}
    </div>`;
}

function renderThemeItemRow(x) {
  const isDone = x.item.done;
  const typeLabel = x.type === 'todo' ? 'Todo' : 'Thema';
  const navAttr = x.type === 'todo'
    ? `onclick="selectView('__todos__')"`
    : `onclick="selectMeeting('${x.meeting.id}')"`;
  return `
    <div class="theme-item-row">
      <span class="theme-item-type type-${x.type}">${typeLabel}</span>
      <span class="theme-item-name ${isDone ? 'done-text' : ''}" ${navAttr}
            title="${escHtml(x.item.title)}">${escHtml(x.item.title)}${isDone ? ' ✓' : ''}</span>
      ${x.meeting ? `<span class="theme-item-meeting">📅 ${escHtml(x.meeting.title)}</span>` : ''}
      <button class="btn btn-ghost btn-sm btn-icon" style="flex-shrink:0;color:var(--text-muted)"
        onclick="removeThemeLink('${x.link.id}')" title="Verknüpfung entfernen">×</button>
    </div>`;
}

// ── Theme modal ──────────────────────────────────────────────
function openThemeModal(id, parentId) {
  editThemeId = id || null;
  newThemeParentId = editThemeId ? null : (parentId || null);
  const th = id ? themeById(id) : null;
  document.getElementById('theme-modal-title').textContent =
    th ? 'Topic bearbeiten' : (newThemeParentId ? 'Neues Unter-Topic' : 'Neues Topic');
  document.getElementById('theme-name').value = th?.title || '';
  document.getElementById('theme-desc').value = th?.description || '';
  document.getElementById('theme-edit-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('theme-name').focus(), 50);
}
function closeThemeModal() { document.getElementById('theme-edit-modal').style.display = 'none'; }

async function saveThemeModal() {
  const title = document.getElementById('theme-name').value.trim();
  if (!title) { document.getElementById('theme-name').focus(); return; }
  const description = document.getElementById('theme-desc').value;
  setBusy('theme-save-btn', true);
  try {
    if (editThemeId) {
      await api('PUT', `/themes/${editThemeId}`, { title, description });
      const th = themeById(editThemeId);
      if (th) { th.title = title; th.description = description; }
    } else {
      const th = await api('POST', '/themes', { title, description, parentId: newThemeParentId });
      themes.push(th);
      if (newThemeParentId) expandedThemeIds.add(newThemeParentId);
      selectedThemeId = th.id;
      await loadThemeDetail();
    }
    closeThemeModal(); render();
    toast(editThemeId ? 'Topic aktualisiert' : 'Topic erstellt');
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('theme-save-btn', false); }
}

async function confirmDeleteTheme(id, name) {
  let preview;
  try { preview = await api('GET', `/themes/${id}/delete-preview`); }
  catch(e) { toast(e.message, 'error'); return; }

  if (preview.subTopicCount === 0) {
    confirmCallback = async () => {
      try {
        await api('DELETE', `/themes/${id}?cascade=true`);
        await afterThemeMutation();
        render(); toast(`Topic „${name}" gelöscht`);
      } catch(e) { toast(e.message, 'error'); }
    };
    document.getElementById('confirm-title').textContent   = 'Topic löschen?';
    document.getElementById('confirm-message').textContent =
      `„${name}" wird gelöscht.${preview.knowledgePageCount ? ` ${preview.knowledgePageCount} Wissensseite(n) werden mit gelöscht, falls sie sonst nirgends verknüpft sind.` : ''} Verknüpfungen zu Themen und Todos werden aufgehoben.`;
    document.getElementById('confirm-dialog').style.display = 'flex';
    return;
  }

  themeDeleteCtx = { id, title: name, ...preview };
  document.getElementById('theme-delete-info').textContent =
    `„${name}" hat ${preview.subTopicCount} Unter-Topic${preview.subTopicCount === 1 ? '' : 's'}` +
    (preview.knowledgePageCount ? ` mit insgesamt ${preview.knowledgePageCount} Wissensseite(n)` : '') + '.';
  document.getElementById('theme-delete-promote').checked = true;
  document.getElementById('theme-delete-cascade').checked = false;
  document.getElementById('theme-delete-modal').style.display = 'flex';
}

function closeThemeDeleteModal() { document.getElementById('theme-delete-modal').style.display = 'none'; themeDeleteCtx = null; }

async function confirmThemeDeleteChoice() {
  if (!themeDeleteCtx) return;
  const cascade = document.getElementById('theme-delete-cascade').checked;
  setBusy('theme-delete-confirm-btn', true);
  try {
    await api('DELETE', `/themes/${themeDeleteCtx.id}?cascade=${cascade}`);
    const title = themeDeleteCtx.title;
    closeThemeDeleteModal();
    await afterThemeMutation();
    render();
    toast(`Topic „${title}" gelöscht`);
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('theme-delete-confirm-btn', false); }
}

// ── Theme Move modal ─────────────────────────────────────────
function openThemeMoveModal(id) {
  themeMoveId = id;
  const theme = themeById(id);
  const excluded = new Set([id, ...themeDescendantIdsClient(id)]);
  const options = ['<option value="">— Wurzel (kein Übertopic) —</option>'].concat(
    themes.filter(t => !excluded.has(t.id))
      .map(t => ({ t, path: themeAncestorsPath(t.id).map(p => p.title).join(' › ') }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ t, path }) => `<option value="${t.id}" ${t.id === theme.parentId ? 'selected' : ''}>${escHtml(path)}</option>`)
  );
  document.getElementById('theme-move-info').textContent = `„${theme.title}" verschieben unter:`;
  document.getElementById('theme-move-select').innerHTML = options.join('');
  document.getElementById('theme-move-modal').style.display = 'flex';
}
function closeThemeMoveModal() { document.getElementById('theme-move-modal').style.display = 'none'; themeMoveId = null; }

async function saveThemeMoveModal() {
  if (!themeMoveId) return;
  const parentId = document.getElementById('theme-move-select').value || null;
  setBusy('theme-move-save-btn', true);
  try {
    await api('PUT', `/themes/${themeMoveId}/move`, { parentId });
    closeThemeMoveModal();
    await afterThemeMutation();
    render();
    toast('Topic verschoben');
  } catch(e) { toast(e.message, 'error'); }
  finally { setBusy('theme-move-save-btn', false); }
}

// ── Knowledge (Wissensseiten) ────────────────────────────────
function findKnowledgePage(id) {
  return knowledgePages.find(x => x.id === id) || themeDetailKnowledge.find(x => x.id === id) || null;
}

let knowledgeRelatedSelection = new Map(); // id -> {id,title} — im Modal ausgewählte verwandte Wissensseiten
let knowledgeRelatedOriginal  = new Set(); // linkId-lose Menge der beim Öffnen bereits verknüpften IDs
let kbOriginalSnapshot = null;  // {title,content,themeIds,relatedIds} beim Öffnen, für Dirty-Check
let kbDraftTimer = null;
let kbDraftIndicatorTimer = null;
let kbRelatedFocusIdx = -1;

function kbDraftKey() { return `ts_kb_draft_${currentUser?.id || 'anon'}_${editKnowledgeId || 'new'}`; }

function kbToggleMoreDetails(forceOpen) {
  const wrap = document.getElementById('knowledge-more-details');
  const btn = document.querySelector('#knowledge-more-toggle-wrap button');
  const open = forceOpen !== undefined ? forceOpen : wrap.style.display === 'none';
  wrap.style.display = open ? '' : 'none';
  if (btn) btn.setAttribute('aria-expanded', String(open));
  document.getElementById('knowledge-more-toggle-label').textContent =
    open ? '▴ Details ausblenden' : '▾ Mehr Details (Topics, Verwandtes Wissen)';
}

// ── Vorlagen-Chips (nur bei neuer Wissensseite) ─────────────
const KNOWLEDGE_TEMPLATES = {
  decision: '<h3>Entscheidung</h3><p><strong>Kontext:</strong> </p><p><strong>Entscheidung:</strong> </p><p><strong>Begründung:</strong> </p><p><strong>Beteiligte:</strong> </p>',
  howto:    '<h3>Vorgehen</h3><ol><li>Schritt 1: </li><li>Schritt 2: </li><li>Schritt 3: </li></ol><p><strong>Voraussetzungen:</strong> </p>',
  links:    '<h3>Link-Sammlung</h3><ul><li><a href="">Link 1</a> – </li><li><a href="">Link 2</a> – </li></ul>',
  meeting:  '<h3>Meeting-Ergebnis</h3><p><strong>Datum:</strong> </p><p><strong>Teilnehmer:</strong> </p><p><strong>Ergebnisse:</strong> </p><p><strong>Nächste Schritte:</strong> </p>',
};
function kbApplyTemplate(key) {
  const tpl = KNOWLEDGE_TEMPLATES[key];
  if (!tpl) return;
  const ed = document.getElementById('knowledge-content');
  ed.innerHTML = (ed.innerHTML && ed.innerHTML !== '<br>') ? ed.innerHTML + tpl : tpl;
  kbTrackDirty();
  ed.focus();
}

function openKnowledgeModal(id, presetThemeId) {
  editKnowledgeId = id || null;
  const k = id ? findKnowledgePage(id) : null;
  document.getElementById('knowledge-modal-title').textContent = k ? 'Wissen bearbeiten' : 'Neues Wissen';
  document.getElementById('knowledge-title').value = k?.title || '';
  document.getElementById('knowledge-title-error').style.display = 'none';
  document.getElementById('knowledge-error-banner').style.display = 'none';
  document.getElementById('knowledge-theme-filter').value = '';
  setRT('knowledge-content', k?.content || '');
  knowledgeThemeSelection = new Set(k ? k.themeIds : (presetThemeId ? [presetThemeId] : (selectedThemeId ? [selectedThemeId] : [])));
  knowledgeRelatedSelection = new Map();
  knowledgeRelatedOriginal = new Set();
  (k?.relatedPageIds || []).forEach(rid => {
    knowledgeRelatedOriginal.add(rid);
    const p = findKnowledgePage(rid);
    knowledgeRelatedSelection.set(rid, { id: rid, title: p?.title || '(Wissensseite)' });
  });
  renderKnowledgeThemeChecklist();
  renderKnowledgeRelatedChips();
  document.getElementById('knowledge-related-results').style.display = 'none';
  document.getElementById('knowledge-related-search').value = '';
  kbUpdateContentCounter();

  const hasExistingAssoc = !!(k && (k.themeIds.length || (k.relatedPageIds||[]).length));
  document.getElementById('knowledge-more-toggle-wrap').style.display = 'block';
  kbToggleMoreDetails(!k ? false : hasExistingAssoc);
  if (!k && presetThemeId) kbToggleMoreDetails(true); // Topic-Kontext bereits bekannt -> sichtbar lassen

  const templateWrap = document.getElementById('knowledge-template-chips-wrap');
  if (templateWrap) templateWrap.style.display = k ? 'none' : 'block';

  const attachSlot = document.getElementById('knowledge-attach-slot');
  if (id) {
    attachSlot.innerHTML = attachSectionHtml('knowledge_page', id);
    loadAttachments('knowledge_page', id);
    setRtImageRef('knowledge-content', 'knowledge_page', id);
  } else {
    attachSlot.innerHTML = '<p style="font-size:.8125rem;color:var(--text-muted);font-style:italic">Anhänge und Bilder sind verfügbar, sobald die Seite gespeichert wurde.</p>';
    clearRtImageRef('knowledge-content');
  }
  document.getElementById('knowledge-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('knowledge-title').focus(), 50);

  kbOriginalSnapshot = kbCurrentSnapshot();
  document.getElementById('knowledge-draft-indicator').textContent = '';
  clearTimeout(kbDraftTimer);
  kbDraftTimer = setTimeout(kbMaybeSaveDraft, 5000);

  const draftRaw = localStorage.getItem(kbDraftKey());
  document.getElementById('knowledge-draft-banner').style.display = draftRaw ? 'flex' : 'none';
}

function kbCurrentSnapshot() {
  return {
    title: document.getElementById('knowledge-title').value,
    content: getRT('knowledge-content'),
    themeIds: [...knowledgeThemeSelection].sort(),
    relatedIds: [...knowledgeRelatedSelection.keys()].sort(),
  };
}
function kbIsDirty() {
  if (!kbOriginalSnapshot) return false;
  return JSON.stringify(kbCurrentSnapshot()) !== JSON.stringify(kbOriginalSnapshot);
}
function kbTrackDirty() {
  kbUpdateContentCounter();
  clearTimeout(kbDraftTimer);
  kbDraftTimer = setTimeout(kbMaybeSaveDraft, 5000);
}
function kbUpdateContentCounter() {
  const el = document.getElementById('knowledge-content-counter');
  if (!el) return;
  const len = getRT('knowledge-content').length;
  const max = 500000;
  el.textContent = `${len.toLocaleString('de-DE')} / ${max.toLocaleString('de-DE')} Zeichen`;
  el.style.color = len > max ? 'var(--red)' : (len > max * 0.9 ? '#b45309' : 'var(--text-muted)');
}

function kbMaybeSaveDraft() {
  if (!document.getElementById('knowledge-modal') || document.getElementById('knowledge-modal').style.display === 'none') return;
  if (!kbIsDirty()) return;
  try {
    localStorage.setItem(kbDraftKey(), JSON.stringify({ ...kbCurrentSnapshot(), savedAt: Date.now() }));
    const ind = document.getElementById('knowledge-draft-indicator');
    ind.textContent = 'Entwurf lokal gespeichert · gerade eben';
    clearTimeout(kbDraftIndicatorTimer);
    kbDraftIndicatorTimer = setTimeout(() => {
      if (ind) ind.textContent = 'Entwurf lokal gespeichert';
    }, 30000);
  } catch {}
  kbDraftTimer = setTimeout(kbMaybeSaveDraft, 5000);
}
function kbClearDraft() { try { localStorage.removeItem(kbDraftKey()); } catch {} }

function kbRestoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(kbDraftKey()) || 'null');
    if (!draft) return;
    document.getElementById('knowledge-title').value = draft.title || '';
    setRT('knowledge-content', draft.content || '');
    knowledgeThemeSelection = new Set(draft.themeIds || []);
    knowledgeRelatedSelection = new Map((draft.relatedIds || []).map(rid => [rid, knowledgeRelatedSelection.get(rid) || { id: rid, title: findKnowledgePage(rid)?.title || '(Wissensseite)' }]));
    renderKnowledgeThemeChecklist();
    renderKnowledgeRelatedChips();
    kbUpdateContentCounter();
  } catch {}
  document.getElementById('knowledge-draft-banner').style.display = 'none';
  document.getElementById('knowledge-content').focus();
}
function kbDiscardDraft() {
  kbClearDraft();
  document.getElementById('knowledge-draft-banner').style.display = 'none';
}

function kbOverlayClick(e) {
  if (e.target.id === 'knowledge-modal') requestCloseKnowledgeModal();
}

async function requestCloseKnowledgeModal() {
  if (!kbIsDirty()) { closeKnowledgeModal(); return; }
  const ok = await genericConfirm('Ungespeicherte Änderungen verwerfen?', 'Deine Änderungen gehen verloren, wenn du fortfährst.', 'Verwerfen', 'Weiterbearbeiten');
  if (ok) closeKnowledgeModal();
}
function closeKnowledgeModal() {
  clearTimeout(kbDraftTimer);
  document.getElementById('knowledge-modal').style.display = 'none';
  kbOriginalSnapshot = null;
}

// ── Quick-Capture: Wissen ohne Umweg über den vollen Editor ─
let kqContextThemeId = null;
// Beim Anlegen eines Todos aus einem Topic-Kontext: automatische Verknüpfung
// nach dem Speichern (analog kqContextThemeId bei Wissen).
let todoModalPresetThemeId = null;

function openQuickKnowledge(presetThemeId) {
  kqContextThemeId = presetThemeId || (selectedThemeId || null);
  document.getElementById('kq-title').value = '';
  setRT('kq-content', '');
  document.getElementById('kq-error').style.display = 'none';
  const hint = document.getElementById('kq-context-hint');
  if (kqContextThemeId) {
    const t = themeById(kqContextThemeId);
    hint.textContent = t ? `Wird mit Topic „${t.title}" verknüpft.` : '';
    hint.style.display = t ? 'block' : 'none';
  } else {
    hint.style.display = 'none';
  }
  document.getElementById('knowledge-quick-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('kq-title').focus(), 50);
}

function closeQuickKnowledge() {
  document.getElementById('knowledge-quick-modal').style.display = 'none';
}

async function submitQuickKnowledge() {
  const titleEl = document.getElementById('kq-title');
  const title = titleEl.value.trim();
  const errEl = document.getElementById('kq-error');
  errEl.style.display = 'none';
  if (!title) { errEl.textContent = 'Titel ist erforderlich.'; errEl.style.display = ''; titleEl.focus(); return; }
  const content = getRT('kq-content');
  const themeIds = kqContextThemeId ? [kqContextThemeId] : [];
  setBusy('kq-save-btn', true);
  try {
    await api('POST', '/knowledge', { title, content, themeIds });
    closeQuickKnowledge();
    await afterThemeMutation();
    await loadKnowledgePages();
    render();
    celebrateKnowledgeCreated();
    window.TSGraph?.invalidate?.();
  } catch (e) {
    errEl.textContent = e.body?.code === 'TITLE_REQUIRED' ? 'Titel ist erforderlich.'
      : e.body?.code === 'CONTENT_TOO_LONG' ? `Der Inhalt ist zu lang (maximal ${e.body?.limit ?? 500000} Zeichen).`
      : (e.message || 'Fehler beim Speichern.');
    errEl.style.display = '';
  } finally {
    setBusy('kq-save-btn', false);
  }
}

// Übergang: aktuelle Quick-Capture-Eingaben in den vollen Editor übernehmen
function switchQuickToFullEditor() {
  const title = document.getElementById('kq-title').value;
  const content = getRT('kq-content');
  const presetTheme = kqContextThemeId;
  closeQuickKnowledge();
  openKnowledgeModal(null, presetTheme);
  document.getElementById('knowledge-title').value = title;
  setRT('knowledge-content', content);
  kbTrackDirty();
}

// Gemeinsame Checklisten-Logik fuer die Topic-Auswahl (Wissen UND Todo
// nutzen exakt dieselbe Komponente - siehe CLAUDE.md "Wiederverwendung vor
// Neuentwicklung": eine Topic-Auswahl darf sich nicht je Einsatzort anders
// verhalten).
function renderThemeChecklist(selection, opts) {
  const el = document.getElementById(opts.checklistId);
  const chipsEl = document.getElementById(opts.chipsId);
  if (!el) return;
  if (!themes.length) {
    el.innerHTML = '<p class="theme-empty-items">Noch keine Topics vorhanden. Legen Sie zuerst ein Topic an.</p>';
    if (chipsEl) chipsEl.innerHTML = '';
    return;
  }
  const filterRaw = (document.getElementById(opts.filterId)?.value || '').trim().toLowerCase();
  const all = themes
    .map(t => ({ t, path: themeAncestorsPath(t.id).map(p => p.title).join(' › ') }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const filtered = filterRaw ? all.filter(x => x.path.toLowerCase().includes(filterRaw)) : all;

  if (chipsEl) {
    const selected = all.filter(x => selection.has(x.t.id));
    chipsEl.innerHTML = selected.length
      ? `<span style="width:100%;font-size:.75rem;color:var(--text-muted)">Ausgewählt (${selected.length})</span>` +
        selected.map(({ t, path }) => `<span class="theme-chip" style="display:inline-flex;align-items:center;gap:.25rem">
          ${escHtml(path)}
          <button type="button" aria-label="${escHtml(t.title)} entfernen" onclick="${opts.toggle}('${t.id}',false)" style="background:none;border:none;cursor:pointer;color:inherit;font-size:1rem;line-height:1;padding:0">×</button>
        </span>`).join('')
      : '';
  }

  if (!filtered.length) {
    el.innerHTML = '<p class="theme-empty-items">Keine Topics gefunden</p>';
    return;
  }
  el.innerHTML = filtered
    .map(({ t, path }) => {
      const checked = selection.has(t.id);
      const hl = filterRaw ? escHtml(path).replace(new RegExp(`(${filterRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>') : escHtml(path);
      return `<label style="display:flex;align-items:center;gap:.5rem;padding:.25rem 0;font-size:.8125rem">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="${opts.toggle}('${t.id}',this.checked)">
        <span>${hl}</span>
      </label>`;
    }).join('');
}

function renderKnowledgeThemeChecklist() {
  renderThemeChecklist(knowledgeThemeSelection, {
    checklistId: 'knowledge-theme-checklist', chipsId: 'knowledge-theme-selected-chips',
    filterId: 'knowledge-theme-filter', toggle: 'toggleKnowledgeThemeSel',
  });
}
function toggleKnowledgeThemeSel(id, checked) {
  if (checked) knowledgeThemeSelection.add(id); else knowledgeThemeSelection.delete(id);
  renderKnowledgeThemeChecklist();
  kbTrackDirty();
}

function renderTodoThemeChecklist() {
  renderThemeChecklist(todoThemeSelection, {
    checklistId: 'todo-theme-checklist', chipsId: 'todo-theme-selected-chips',
    filterId: 'todo-theme-filter', toggle: 'toggleTodoThemeSel',
  });
}
function toggleTodoThemeSel(id, checked) {
  if (checked) todoThemeSelection.add(id); else todoThemeSelection.delete(id);
  renderTodoThemeChecklist();
}

// ── A8: Verweise zwischen Wissensseiten ("Verwandtes Wissen") ──
let kbRelatedSearchTimer = null;
function kbSearchRelated(q) {
  clearTimeout(kbRelatedSearchTimer);
  const resultsEl = document.getElementById('knowledge-related-results');
  const query = q.trim();
  if (query.length < 2) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
  kbRelatedSearchTimer = setTimeout(async () => {
    try {
      const { results } = await api('GET', `/knowledge/search?q=${encodeURIComponent(query)}`);
      const filtered = results.filter(r => r.id !== editKnowledgeId && !knowledgeRelatedSelection.has(r.id));
      kbRelatedFocusIdx = -1;
      if (!filtered.length) {
        resultsEl.innerHTML = '<div style="padding:.5rem .75rem;font-size:.8125rem;color:var(--text-muted);font-style:italic">Keine Treffer</div>';
      } else {
        resultsEl.innerHTML = filtered.slice(0, 6).map((r, i) => `
          <div class="kb-related-result" tabindex="-1" data-idx="${i}" data-id="${r.id}" data-title="${escHtml(r.title)}"
               style="padding:.5rem .75rem;font-size:.8125rem;cursor:pointer;border-bottom:1px solid var(--border)">
            <strong>${escHtml(r.title)}</strong>
          </div>`).join('');
        resultsEl.querySelectorAll('.kb-related-result').forEach(el => {
          el.addEventListener('click', () => kbSelectRelated(el.dataset.id, el.dataset.title));
        });
      }
      resultsEl.style.display = 'block';
    } catch { resultsEl.style.display = 'none'; }
  }, 200);
}
function kbRelatedSearchKeydown(e) {
  const resultsEl = document.getElementById('knowledge-related-results');
  const items = [...resultsEl.querySelectorAll('.kb-related-result')];
  if (!items.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); kbRelatedFocusIdx = Math.min(kbRelatedFocusIdx + 1, items.length - 1); items[kbRelatedFocusIdx]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); kbRelatedFocusIdx = Math.max(kbRelatedFocusIdx - 1, 0); items[kbRelatedFocusIdx]?.focus(); }
  else if (e.key === 'Enter' && kbRelatedFocusIdx >= 0) { e.preventDefault(); const it = items[kbRelatedFocusIdx]; kbSelectRelated(it.dataset.id, it.dataset.title); }
}
function kbSelectRelated(id, title) {
  knowledgeRelatedSelection.set(id, { id, title });
  document.getElementById('knowledge-related-search').value = '';
  document.getElementById('knowledge-related-results').style.display = 'none';
  renderKnowledgeRelatedChips();
  kbTrackDirty();
}
function kbRemoveRelated(id) {
  knowledgeRelatedSelection.delete(id);
  renderKnowledgeRelatedChips();
  kbTrackDirty();
}
function renderKnowledgeRelatedChips() {
  const el = document.getElementById('knowledge-related-chips');
  if (!el) return;
  const items = [...knowledgeRelatedSelection.values()];
  el.innerHTML = items.length
    ? `<span style="width:100%;font-size:.75rem;color:var(--text-muted)">Verknüpft (${items.length})</span>` +
      items.map(r => `<span class="theme-chip" style="display:inline-flex;align-items:center;gap:.25rem">
        ${escHtml(r.title)}
        <button type="button" aria-label="Verknüpfung zu ${escHtml(r.title)} entfernen" onclick="kbRemoveRelated('${r.id}')" style="background:none;border:none;cursor:pointer;color:inherit;font-size:1rem;line-height:1;padding:0">×</button>
      </span>`).join('')
    : '';
}

async function kbSyncRelatedLinks(pageId) {
  const finalIds = new Set(knowledgeRelatedSelection.keys());
  const toAdd = [...finalIds].filter(id => !knowledgeRelatedOriginal.has(id));
  const toRemove = [...knowledgeRelatedOriginal].filter(id => !finalIds.has(id));
  for (const targetId of toAdd) {
    try { await api('POST', `/knowledge/${pageId}/links`, { targetId }); } catch {}
  }
  if (toRemove.length) {
    try {
      const links = await api('GET', `/knowledge/${pageId}/links`);
      for (const rid of toRemove) {
        const link = links.find(l => l.page.id === rid);
        if (link) { try { await api('DELETE', `/knowledge/${pageId}/links/${link.linkId}`); } catch {} }
      }
    } catch {}
  }
}

async function saveKnowledgeModal() {
  const titleEl = document.getElementById('knowledge-title');
  const titleErrEl = document.getElementById('knowledge-title-error');
  const bannerEl = document.getElementById('knowledge-error-banner');
  titleErrEl.style.display = 'none';
  bannerEl.style.display = 'none';
  const title = titleEl.value.trim();
  if (!title) {
    titleErrEl.textContent = 'Titel erforderlich';
    titleErrEl.style.display = 'block';
    titleEl.setAttribute('aria-invalid', 'true');
    titleEl.focus();
    return;
  }
  titleEl.removeAttribute('aria-invalid');
  const content = getRT('knowledge-content');
  const themeIds = [...knowledgeThemeSelection];
  setBusy('knowledge-save-btn', true);
  try {
    let pageId = editKnowledgeId;
    if (editKnowledgeId) {
      await api('PUT', `/knowledge/${editKnowledgeId}`, { title, content });
      await api('PUT', `/knowledge/${editKnowledgeId}/themes`, { themeIds });
    } else {
      const created = await api('POST', '/knowledge', { title, content, themeIds });
      pageId = created.id;
    }
    await kbSyncRelatedLinks(pageId);
    kbClearDraft();
    closeKnowledgeModal();
    await afterThemeMutation();
    await loadKnowledgePages();
    render();
    if (editKnowledgeId) toast('Wissen gespeichert'); else celebrateKnowledgeCreated();
    window.TSGraph?.invalidate?.();
  } catch(e) {
    const code = e.body?.code;
    if (code === 'TITLE_REQUIRED') {
      titleErrEl.textContent = 'Titel erforderlich'; titleErrEl.style.display = 'block'; titleEl.focus();
    } else if (code === 'TITLE_TOO_LONG') {
      titleErrEl.textContent = `Der Titel ist zu lang (maximal ${e.body?.limit ?? 300} Zeichen).`; titleErrEl.style.display = 'block';
    } else if (code === 'CONTENT_TOO_LONG') {
      bannerEl.textContent = `Der Inhalt ist zu lang (maximal ${e.body?.limit ?? 500000} Zeichen). Bitte kürzen und erneut speichern.`;
      bannerEl.style.display = 'block';
    } else if (code === 'KNOWLEDGE_PAGE_GONE') {
      bannerEl.innerHTML = 'Diese Wissensseite wurde inzwischen gelöscht. ' +
        '<button type="button" class="btn btn-secondary" style="padding:.125rem .5rem;font-size:.75rem;margin-left:.5rem" onclick="saveKnowledgeAsNew()">Als neue Seite speichern</button>';
      bannerEl.style.display = 'block';
    } else {
      bannerEl.textContent = 'Die Wissensseite konnte nicht gespeichert werden. Bitte versuche es erneut.';
      bannerEl.style.display = 'block';
    }
  }
  finally { setBusy('knowledge-save-btn', false); }
}

async function saveKnowledgeAsNew() {
  editKnowledgeId = null;
  await saveKnowledgeModal();
}

function confirmDeleteKnowledge(id, title) {
  confirmCallback = async () => {
    try {
      await api('DELETE', `/knowledge/${id}`);
      await afterThemeMutation();
      render();
      toast(`„${title}" gelöscht`);
    } catch(e) { toast(e.message, 'error'); }
  };
  document.getElementById('confirm-title').textContent   = 'Wissen löschen?';
  document.getElementById('confirm-message').textContent = `„${title}" wird unwiderruflich gelöscht.`;
  document.getElementById('confirm-dialog').style.display = 'flex';
}

// ── Globale Wissens-Ansicht ──────────────────────────────────
async function loadKnowledgePages() {
  try { knowledgePages = await api('GET', '/knowledge'); } catch { knowledgePages = []; }
}

function matchesKnowledge(k, query) {
  if (!query) return true;
  const haystack = [k.title || '', stripHtmlForSearch(k.content || '')].join('\n').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
}

function fmtRelativeShort(s) {
  if (!s) return '';
  const diff = Date.now() - new Date(s).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  2)  return 'gerade eben';
  if (mins  < 60)  return `vor ${mins} Min.`;
  if (hours < 24)  return `vor ${hours} Std.`;
  if (days  <  2)  return 'gestern';
  if (days  <  31) return `vor ${days} Tagen`;
  return fmtDate(s);
}

// Karten-Raster aller Wissensseiten — Startzustand des Wissen-Bereichs, solange kein Topic
// im Baum ausgewählt ist (ersetzt die frühere eigenständige Ansicht).
function renderKnowledgeGrid() {
  const q = knowledgeSearch.trim();
  let list = knowledgePages.filter(k => matchesKnowledge(k, q));
  if (knowledgeFilterThemeId) list = list.filter(k => k.themeIds.includes(knowledgeFilterThemeId));
  list = list.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const themeOptions = themes
    .map(t => ({ t, path: themeAncestorsPath(t.id).map(p => p.title).join(' › ') }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ t, path }) => `<option value="${t.id}" ${t.id === knowledgeFilterThemeId ? 'selected' : ''}>${escHtml(path)}</option>`)
    .join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem">
      <h1 class="meeting-title" style="margin:0">Alle Wissensseiten</h1>
      <span style="display:inline-flex">
        <button class="btn btn-primary btn-sm" style="background:#7c3aed;border-color:#7c3aed;border-radius:6px 0 0 6px" onclick="openQuickKnowledge()">+ Wissensseite</button>
        <details class="topic-overflow" onclick="event.stopPropagation()">
          <summary class="btn btn-primary btn-sm btn-icon" style="background:#7c3aed;border-color:#7c3aed;border-radius:0 6px 6px 0;border-left:1px solid rgba(255,255,255,.3)" title="Weitere Optionen">▾</summary>
          <div class="topic-overflow-menu">
            <button onclick="closeAllOverflow(); openKnowledgeModal()">
              <span class="icon">📝</span><span>Voller Editor</span>
            </button>
          </div>
        </details>
      </span>
    </div>
    <div style="display:flex;gap:.625rem;flex-wrap:wrap;margin-bottom:1.125rem">
      <select class="form-control" style="max-width:260px" onchange="knowledgeFilterThemeId=this.value;renderMain()">
        <option value="">Alle Topics</option>
        ${themeOptions}
      </select>
      <input type="text" class="form-control" style="max-width:260px" placeholder="Wissen durchsuchen …"
        value="${escHtml(knowledgeSearch)}" oninput="knowledgeSearch=this.value;renderMain()">
    </div>
    ${list.length === 0 ? `
      <div class="empty-state" style="padding:3rem 1rem">
        <div class="empty-state-icon" style="background:#faf5ff;border-color:#e9d5ff">📚</div>
        <h2>${knowledgePages.length === 0 ? 'Noch kein Wissen hinterlegt' : 'Keine Treffer'}</h2>
        <p>${knowledgePages.length === 0 ? 'Legen Sie Wissensseiten an und verknüpfen Sie sie mit Topics.' : 'Suchbegriff oder Topic-Filter anpassen.'}</p>
      </div>` :
      `<div class="knowledge-grid">${list.map(k => renderKnowledgeGridCard(k)).join('')}</div>`}`;
}

function renderKnowledgeGridCard(k) {
  const paths = k.themeIds.map(id => themeAncestorsPath(id).map(t => t.title).join(' › ')).filter(Boolean);
  const preview = stripHtmlForSearch(k.content || '');
  return `
    <div class="knowledge-grid-card" onclick="openKnowledgeModal('${k.id}')">
      <div class="knowledge-grid-card-head">
        <div class="knowledge-grid-card-icon">📄</div>
        <span class="knowledge-grid-card-time">${escHtml(fmtRelativeShort(k.updatedAt))}</span>
      </div>
      <div class="knowledge-grid-card-title">${escHtml(k.title)}</div>
      ${preview ? `<div class="knowledge-grid-card-preview">${escHtml(preview)}</div>` : ''}
      ${paths.length ? `<div class="knowledge-grid-card-path">→ ${escHtml(paths.join(' · '))}</div>` : ''}
    </div>`;
}

// ── Contacts (Ansprechpartner) ──────────────────────────────

// Strip HTML for plain-text search (server's description is HTML)
function stripHtmlForSearch(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.innerHTML = s;
  return d.textContent || d.innerText || '';
}

// Multi-Token-Match: alle whitespace-getrennten Tokens müssen irgendwo matchen.
// Suchtreffer-Felder: name, role, email, description (HTML gestrippt).
function matchesContact(c, query) {
  if (!query) return true;
  const haystack = [
    c.name || '',
    c.role || '',
    c.email || '',
    stripHtmlForSearch(c.description || ''),
    // snippet/categories (Arbeitspaket W1/B1): serverseitig gelieferter
    // Klartextauszug bzw. Rubriknamen der neuen strukturierten
    // Zusatzinformationen — ohne diese Felder wäre das lokale Schnellfilter-
    // Suchfeld in dieser Ansicht "blind" für über die neuen Infoblöcke
    // erfasste Inhalte, obwohl die globale (⌘K-)Suche sie bereits findet.
    c.snippet || '',
    Array.isArray(c.categories) ? c.categories.map(cat => cat?.label || '').join(' ') : '',
  ].join('\n').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean)
    .every(token => haystack.includes(token));
}

// Highlight matched tokens within escape-safe HTML.
function highlightSearch(text, query) {
  const safe = escHtml(text || '');
  if (!query) return safe;
  const tokens = query.split(/\s+/).filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))   // regex-escape
    .sort((a, b) => b.length - a.length);                   // longest first
  if (!tokens.length) return safe;
  const re = new RegExp('(' + tokens.join('|') + ')', 'gi');
  return safe.replace(re, '<mark class="search-hit">$1</mark>');
}

function renderContactsView(el) {
  const q = contactSearch.trim();
  const list = contacts.filter(c => matchesContact(c, q));
  const total = contacts.length;
  const matches = list.length;

  el.innerHTML = `
    <div class="content-header" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.5rem; padding:1rem 1.25rem; background:linear-gradient(135deg,#fdf2f8,#fce7f3); border-bottom:1px solid #fbcfe8;">
      <div>
        <h1 style="font-size:1.125rem; font-weight:700; color:#9d174d">👤 Ansprechpartner</h1>
        <p style="font-size:.8125rem; color:#be185d; margin-top:.125rem">Personen, Rollen und Zuständigkeiten</p>
      </div>
      <button class="btn btn-primary btn-sm" style="background:#db2777; border-color:#db2777" onclick="openContactModal()">＋ Neuer Ansprechpartner</button>
    </div>
    <div style="padding:.75rem 1.25rem; display:flex; gap:.5rem; align-items:center; border-bottom:1px solid var(--border)">
      <input type="search" class="form-control" id="contact-search-input"
             placeholder="Suchen in Name, Rolle, E-Mail, Beschreibung …"
             value="${escHtml(contactSearch)}"
             oninput="onContactSearch(this.value)"
             autocomplete="off" autofocus
             style="flex:1; max-width:520px">
      <span style="font-size:.75rem; color:var(--text-muted)" id="contact-search-status">
        ${q ? `${matches} / ${total}` : `${total}`}
      </span>
      ${q ? `<button class="btn btn-ghost btn-sm" onclick="onContactSearch('')">×</button>` : ''}
    </div>
    <div style="padding:1rem 1.25rem" id="contact-list-host"></div>
  `;
  const host = el.querySelector('#contact-list-host');

  if (total === 0) {
    host.innerHTML = `<div class="contact-empty">Noch keine Ansprechpartner. Klicke auf „＋ Neuer Ansprechpartner", um den ersten anzulegen.</div>`;
    return;
  }
  if (matches === 0) {
    host.innerHTML = `<div class="contact-empty">Keine Treffer für „${escHtml(q)}".</div>`;
    return;
  }

  host.innerHTML = list.map(c => {
    // Rubrik-Badges + Klartextauszug der neuen strukturierten Zusatz-
    // informationen (Arbeitspaket W1/B1) statt des früheren reinen
    // `description`-Snippets — TSContacts liefert bereits fertig
    // escaptes HTML, daher hier KEIN zusätzliches highlightSearch() darauf
    // (kein Such-Highlighting innerhalb der Badges/des Snippets, siehe
    // Abschlussbericht W2: TSContacts.contactBadgesHtml kennt den
    // Suchbegriff nicht).
    const badgesHtml = (window.TSContacts && typeof TSContacts.contactBadgesHtml === 'function')
      ? TSContacts.contactBadgesHtml(c, { maxBadges: 4 }) : '';
    return `
      <div class="contact-card">
        <div class="contact-card-header">
          <div class="contact-card-info">
            <div class="contact-card-title">${highlightSearch(c.name, q)}</div>
            ${c.role  ? `<div class="contact-card-role">${highlightSearch(c.role, q)}</div>` : ''}
            ${c.email ? `<a class="contact-card-email" href="mailto:${escHtml(c.email)}">${highlightSearch(c.email, q)}</a>` : ''}
          </div>
          <div class="contact-card-actions">
            <button class="btn btn-secondary btn-sm btn-icon" onclick="openContactModal('${c.id}')" title="Bearbeiten">${SVG.pencil}</button>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmDeleteContact('${c.id}', '${escJsAttr(c.name)}')" title="Löschen">🗑️</button>
          </div>
        </div>
        ${badgesHtml ? `<div class="contact-card-badges">${badgesHtml}</div>` : ''}
      </div>`;
  }).join('');
}

function onContactSearch(val) {
  contactSearch = val;
  renderMain();
  const el = document.getElementById('contact-search-input');
  if (el) { el.focus(); el.setSelectionRange(val.length, val.length); }
}

// ── Erweiterte Kontakt-Detailansicht (Arbeitspaket W1: TSContacts) ────
// Hält das aktuell gemountete mountContactDetail()-Handle, damit es beim
// Schließen/Wechseln des Kontakts sauber destroy()t wird (sonst blieben
// z. B. die von TSProgress innerhalb des Notizen-Abschnitts gemounteten
// Composer-/Timeline-Instanzen an einem bereits ersetzten/entfernten
// DOM-Host hängen).
let contactDetailHandle = null;

function destroyContactDetailSection() {
  if (contactDetailHandle && typeof contactDetailHandle.destroy === 'function') {
    try { contactDetailHandle.destroy(); } catch (e) { console.warn('destroyContactDetailSection: destroy() fehlgeschlagen (Handle evtl. bereits ungültig)', e); }
  }
  contactDetailHandle = null;
}

// Navigations-Ziel aus Abschnitt "Ist zuständig für" (onNavigate liefert
// laut Vertrag NUR {refType, refId}, keine meetingId) — für Themen wird die
// zugehörige Meeting-Id über den bestehenden findTopicAnywhere()-Helfer
// aufgelöst und die vorhandene TSHost.openObject()-Logik (inkl. Archiv-/
// "nicht mehr aktiv"-Behandlung) wiederverwendet, statt sie hier zu
// duplizieren. Wird die Themen-Zuordnung nicht mehr gefunden (z. B. weil sie
// zu einem archivierten Meeting gehört, dessen Id hier nicht bekannt ist),
// bricht die Navigation sichtbar mit einem Toast ab statt eine kaputte
// Bearbeiten-Ansicht zu öffnen.
function navigateFromContactAssignment(ctx) {
  const refType = ctx && ctx.refType, refId = ctx && ctx.refId;
  if (!refType || !refId) return;
  if (refType === 'todo') {
    closeContactModal();
    TSHost.openObject('todo', refId);
  } else if (refType === 'topic') {
    const found = findTopicAnywhere(refId);
    if (!found) {
      toast('Thema nicht gefunden (evtl. archiviert oder gelöscht).', 'error');
      return;
    }
    closeContactModal();
    // Invariante: findTopicAnywhere() durchsucht ausschließlich `meetings`,
    // welches ausnahmslos über GET /meetings befüllt wird — diese Route
    // liefert serverseitig NUR nicht-archivierte Meetings (notArchivedSql).
    // `found.meeting.archived` ist an dieser Stelle daher beweisbar immer
    // false. Archivierte Themen sind über diesen Navigationsweg aktuell
    // NICHT erreichbar, da onNavigate laut Vertrag keine meetingId für den
    // Archiv-Pfad liefert (bekannte Vertragslücke, siehe Kommentar oben).
    TSHost.openObject('topic', refId, { meetingId: found.meeting.id, archived: false });
  }
}

function mountContactDetailSection(id) {
  destroyContactDetailSection();
  const host = document.getElementById('contact-detail-host');
  if (!host) return;
  host.innerHTML = '';
  if (!id) {
    host.innerHTML = '<p style="font-size:.8125rem;color:var(--text-muted);font-style:italic">Zusatzinformationen, Notizen, Topics und Zuständigkeiten sind verfügbar, sobald der Ansprechpartner gespeichert wurde.</p>';
    return;
  }
  if (!window.TSContacts || typeof TSContacts.mountContactDetail !== 'function') {
    host.innerHTML = '<p class="form-error">Erweiterte Kontaktansicht momentan nicht verfügbar.</p>';
    return;
  }
  contactDetailHandle = TSContacts.mountContactDetail(host, {
    contactId: id,
    rt: {
      setRT: (elId, val) => setRT(elId, val),
      getRT: (elId) => getRT(elId),
      // Wird für JEDEN dynamisch erzeugten Infoblock-Editor unmittelbar vor
      // rt.setRT(editorId,...) aufgerufen (siehe Modulkopf-Kommentar in
      // contacts.js) — ohne dieses Wiring bliebe die Rich-Text-Toolbar der
      // Infoblock-Editoren leer.
      initToolbar: (editorId, toolbarId) => initRtToolbar(toolbarId, editorId),
    },
    openThemeLinkModal: openThemeLinkModal,
    confirm: ({ title, message }) => genericConfirm(title, message, 'Löschen', 'Abbrechen'),
    toast: (msg, type) => toast(msg, type),
    onContactChanged: (updated) => {
      if (!updated || !updated.id) return;
      const idx = contacts.findIndex(x => x.id === updated.id);
      if (idx >= 0) contacts[idx] = updated; else contacts.push(updated);
      render();
    },
    onNavigate: (ctx) => navigateFromContactAssignment(ctx),
    onError: (err) => toast((err && err.message) || 'Fehler beim Laden der Kontaktdaten.', 'error'),
  });
}

function openContactModal(id) {
  editContactId = id || null;
  const c = id ? contacts.find(x => x.id === id) : null;
  document.getElementById('contact-modal-title').textContent = c ? 'Ansprechpartner bearbeiten' : 'Neuer Ansprechpartner';
  document.getElementById('contact-name').value  = c?.name  || '';
  document.getElementById('contact-role').value  = c?.role  || '';
  document.getElementById('contact-email').value = c?.email || '';
  document.getElementById('contact-error').style.display = 'none';
  mountContactDetailSection(id);
  document.getElementById('contact-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('contact-name').focus(), 50);
}
function closeContactModal() {
  document.getElementById('contact-modal').style.display = 'none';
  destroyContactDetailSection();
}

async function saveContactModal() {
  const name  = document.getElementById('contact-name').value.trim();
  const role  = document.getElementById('contact-role').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const errEl = document.getElementById('contact-error');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Name ist erforderlich.'; errEl.style.display = ''; return; }
  setBusy('contact-save-btn', true);
  try {
    // Kein `description`-Schlüssel mehr im Body (Arbeitspaket W2): das
    // frühere Freitextfeld "Zuständigkeit & Eigenschaften" ist durch die
    // strukturierten Zusatzinformationen (TSContacts.mountContactDetail,
    // Abschnitt "Zusatzinformationen") ersetzt. Der Legacy-Shim im Backend
    // (`description` NICHT im Body -> keine Blockänderung) bleibt dadurch
    // unangetastet — bereits vorhandene Legacy-Inhalte gehen nicht verloren,
    // sind aber nur noch über den neuen Infoblock-Editor bearbeitbar.
    if (editContactId) {
      const c = await api('PUT', `/contacts/${editContactId}`, { name, role, email });
      const idx = contacts.findIndex(x => x.id === editContactId);
      if (idx >= 0) contacts[idx] = c;
      closeContactModal(); render();
      toast('Ansprechpartner aktualisiert');
    } else {
      const c = await api('POST', '/contacts', { name, role, email });
      contacts.push(c);
      closeContactModal(); render();
      toast('Ansprechpartner erstellt');
    }
  } catch (e) {
    errEl.textContent = e.message || 'Fehler';
    errEl.style.display = '';
  } finally {
    setBusy('contact-save-btn', false);
  }
}

function confirmDeleteContact(id, name) {
  const c = contacts.find(x => x.id === id);
  // Dynamischer Zusatzhinweis (Arbeitspaket W2, UX-Vorgabe): warnt zusätzlich
  // vor dem Verlust strukturierter Zusatzinformationen, falls vorhanden —
  // `infoBlockCount` liefert der Server bereits fertig mit dem Contact-Objekt
  // (kein zusätzlicher Request nötig). Notizen/Zuständigkeits-Zuordnungen
  // werden serverseitig beim Löschen ebenfalls entfernt (siehe B4-Wiring),
  // daher pauschal mit erwähnt statt eine exakte Zahl vorzutäuschen.
  const extraHint = (c && c.infoBlockCount > 0)
    ? ` Zusätzlich gehen ${c.infoBlockCount} Zusatzinformation${c.infoBlockCount === 1 ? '' : 'en'}, alle Notizen und Zuständigkeits-Zuordnungen zu diesem Ansprechpartner verloren.`
    : '';
  confirmCallback = async () => {
    try {
      await api('DELETE', `/contacts/${id}`);
      contacts = contacts.filter(x => x.id !== id);
      render(); toast(`Ansprechpartner „${name}" gelöscht`);
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('confirm-title').textContent   = 'Ansprechpartner löschen?';
  document.getElementById('confirm-message').textContent = `„${name}" wird gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.${extraHint}`;
  document.getElementById('confirm-dialog').style.display = 'flex';
}

// ── Ansprechpartner-Zuordnung an Todo/Thema (Arbeitspaket W2) ─────────
// Gemeinsame Basis für Karten-Overflow-Aktion UND Bearbeiten-Modal — ruft
// TSContacts.openAssignmentPicker() auf (Wiederverwendung des bestehenden,
// von W1 gelieferten Zuordnungsdialogs statt eines zweiten).
function openContactFromChip(id) {
  // Wiederverwendung statt Duplikat: TSHost.openObject('contact', id) macht
  // exakt dasselbe (selectView('__contacts__') + openContactModal(id)), siehe
  // dessen 'contact'-Zweig weiter oben.
  TSHost.openObject('contact', id);
}

// Baut die Chips zugeordneter Ansprechpartner (Todo/Thema, `item.contacts`
// im AssignedContact-Format {contactId,name,role,email,assignedAt} laut
// Server-Vertrag) über die gemeinsame TSContacts.assignedContactsHtml()-
// Funktion — Klick auf einen Chip öffnet den Ansprechpartner direkt.
function renderAssignedContactsChipsHtml(item) {
  if (!window.TSContacts || typeof TSContacts.assignedContactsHtml !== 'function') return '';
  const list = Array.isArray(item?.contacts) ? item.contacts : [];
  if (!list.length) return '';
  return TSContacts.assignedContactsHtml(list, {
    onClickAttr: c => `onclick="event.stopPropagation(); openContactFromChip('${escJsAttr(String(c.contactId))}')"`
  });
}

function toAssignedContactShape(contact) {
  return {
    contactId: contact.id, name: contact.name, role: contact.role,
    email: contact.email, assignedAt: new Date().toISOString(),
  };
}

// Aktualisiert die lokal gehaltene `.contacts`-Liste eines Todos/Themas nach
// einer erfolgreichen Zuordnungsänderung, ohne auf einen vollständigen
// loadTodos()/loadMeetings()-Neuladeroundtrip warten zu müssen (analog zu
// bestehenden optimistischen Aktualisierungen an anderer Stelle in app.js).
function applyAssignedContacts(refType, refId, assignedContactsList) {
  const mapped = (assignedContactsList || []).map(toAssignedContactShape);
  if (refType === 'todo') {
    const t = todos.find(x => x.id === refId);
    if (t) t.contacts = mapped;
  } else if (refType === 'topic') {
    const found = findTopicAnywhere(refId);
    if (found) found.topic.contacts = mapped;
  }
}

function doOpenContactAssignmentPicker(refType, refId, title, afterApply) {
  if (!window.TSContacts || typeof TSContacts.openAssignmentPicker !== 'function') {
    toast('Ansprechpartner-Zuordnung momentan nicht verfügbar.', 'error');
    return;
  }
  TSContacts.openAssignmentPicker({
    refType, refId, title, contacts,
    onChanged: (assigned) => {
      applyAssignedContacts(refType, refId, assigned);
      if (typeof afterApply === 'function') afterApply();
      render();
      toast('Ansprechpartner zugeordnet');
    },
    onError: (err) => toast((err && err.message) || 'Zuordnung konnte nicht geladen werden.', 'error'),
    toast: (msg, type) => toast(msg, type),
  });
}

// Karten-Overflow-Aktion "👤 Ansprechpartner zuordnen"
function openContactAssignmentPickerForTodoCard(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  doOpenContactAssignmentPicker('todo', id, t.title, null);
}

function openContactAssignmentPickerForTopicCard(mid, tid) {
  const t = getTopic(mid, tid);
  if (!t) return;
  doOpenContactAssignmentPicker('topic', tid, t.title, null);
}

// Todo-/Themen-Bearbeiten-Modal: Chip-Anzeige + Zuordnen-Button
function renderTodoContactsChips(t) {
  const host = document.getElementById('todo-contacts-chips');
  if (!host) return;
  host.innerHTML = renderAssignedContactsChipsHtml(t) ||
    '<span class="form-hint">Noch keine Ansprechpartner zugeordnet.</span>';
}

function renderTopicContactsChips(t) {
  const host = document.getElementById('topic-contacts-chips');
  if (!host) return;
  host.innerHTML = renderAssignedContactsChipsHtml(t) ||
    '<span class="form-hint">Noch keine Ansprechpartner zugeordnet.</span>';
}

function openContactAssignmentPickerForTodo() {
  if (!editTodoId) return;
  const t = todos.find(x => x.id === editTodoId);
  if (!t) return;
  doOpenContactAssignmentPicker('todo', editTodoId, t.title, () => renderTodoContactsChips(t));
}

function openContactAssignmentPickerForTopic() {
  if (!editTopicMid || !editTopicId) return;
  const t = getTopic(editTopicMid, editTopicId);
  if (!t) return;
  doOpenContactAssignmentPicker('topic', editTopicId, t.title, () => renderTopicContactsChips(t));
}

// ── Theme link modal ─────────────────────────────────────────
function openThemeLinkModalForTopic(mid, tid) {
  const t = getTopic(mid, tid);
  if (!t) return;
  openThemeLinkModal({ refType: 'topic', refId: tid, title: t.title });
}

function openThemeLinkModalForTodo(tid) {
  const t = todos.find(x => x.id === tid);
  if (!t) return;
  openThemeLinkModal({ refType: 'todo', refId: tid, title: t.title });
}

// `onClosed` (Arbeitspaket W2, Vertrag mit TSContacts.mountContactDetail):
// optionaler zweiter Parameter, wird GENAU EINMAL aufgerufen, sobald dieser
// Dialog schließt (unabhängig davon, ob per ×/„Schließen"/Overlay-Klick/
// Escape) — ersetzt das zuvor von contacts.js genutzte, dauerhaft laufende
// Polling von GET /api/themes. Bestehende Aufrufer (openThemeLinkModalForTopic/
// -ForTodo) übergeben weiterhin KEIN onClosed — vollständig abwärtskompatibel.
let themeLinkOnClosed = null;

function openThemeLinkModal(ctx, onClosed) {
  themeLinkCtx = ctx;
  themeLinkOnClosed = typeof onClosed === 'function' ? onClosed : null;
  document.getElementById('theme-link-item-label').textContent =
    `Wählen Sie die Topics aus, zu denen „${ctx.title}" gehören soll.`;
  renderThemeLinkList();
  document.getElementById('theme-link-modal').style.display = 'flex';
}

function closeThemeLinkModal() {
  document.getElementById('theme-link-modal').style.display = 'none';
  const cb = themeLinkOnClosed;
  themeLinkOnClosed = null;
  if (cb) { try { cb(); } catch (e) { console.warn('closeThemeLinkModal: onClosed-Callback fehlgeschlagen (Schließen wird dadurch nicht verhindert)', e); } }
}

function renderThemeLinkList() {
  const listEl  = document.getElementById('theme-link-list');
  const emptyEl = document.getElementById('theme-link-empty');
  if (themes.length === 0) {
    listEl.innerHTML = ''; emptyEl.style.display = ''; return;
  }
  emptyEl.style.display = 'none';
  listEl.innerHTML = themes.map(th => {
    const link = th.links.find(l => l.refId === themeLinkCtx.refId);
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem .75rem;
                  border-radius:8px;background:${link ? '#faf5ff' : 'var(--bg)'};
                  border:1px solid ${link ? '#e9d5ff' : 'var(--border)'}">
        <div style="flex:1;min-width:0;margin-right:.5rem">
          <div style="font-size:.875rem;font-weight:600;color:${link ? '#4c1d95' : 'var(--text)'}">
            ${escHtml(th.title)}</div>
          ${th.description ? `<div style="font-size:.75rem;color:var(--text-muted);margin-top:.125rem;
              overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(th.description)}</div>` : ''}
        </div>
        ${link
          ? `<button class="btn btn-sm" style="background:#ede9fe;color:#7c3aed;border:1px solid #e9d5ff;flex-shrink:0"
               onclick="doRemoveThemeLink('${link.id}','${th.id}')">✓ Zugewiesen</button>`
          : `<button class="btn btn-sm btn-secondary" style="flex-shrink:0"
               onclick="doAddThemeLink('${th.id}')">+ Zuweisen</button>`}
      </div>`;
  }).join('');
}

async function doAddThemeLink(themeId) {
  if (!themeLinkCtx) return;
  try {
    const link = await api('POST', `/themes/${themeId}/links`, {
      refType: themeLinkCtx.refType, refId: themeLinkCtx.refId
    });
    const th = themes.find(x => x.id === themeId);
    if (th) th.links.push(link);
    renderThemeLinkList();
    await loadThemeDetail(); render();
    toast('Topic zugewiesen');
  } catch(e) { toast(e.message, 'error'); }
}

async function doRemoveThemeLink(linkId, themeId) {
  try {
    await api('DELETE', `/themes/${themeId}/links/${linkId}`);
    const th = themes.find(x => x.id === themeId);
    if (th) th.links = th.links.filter(l => l.id !== linkId);
    renderThemeLinkList();
    await loadThemeDetail(); render();
    toast('Verknüpfung entfernt');
  } catch(e) { toast(e.message, 'error'); }
}

async function removeThemeLink(linkId) {
  const th = themes.find(x => x.links.some(l => l.id === linkId));
  if (!th) return;
  try {
    await api('DELETE', `/themes/${th.id}/links/${linkId}`);
    th.links = th.links.filter(l => l.id !== linkId);
    render(); toast('Verknüpfung entfernt');
  } catch(e) { toast(e.message, 'error'); }
}

let shareMid = null, shareTid = null;

function openShareModal(mid, tid) {
  shareMid = mid; shareTid = tid;
  const t = getTopic(mid, tid);
  const usedMeetingIds = new Set(
    t?.groupId
      ? meetings.flatMap(m => m.topics).filter(x => x.groupId === t.groupId).map(x => x.meetingId)
      : [mid]
  );
  const available = meetings.filter(m => !usedMeetingIds.has(m.id));
  if (available.length === 0) {
    toast('Dieses Thema ist bereits in allen Meetings vorhanden.', 'error');
    return;
  }
  const sel = document.getElementById('share-target-meeting');
  sel.innerHTML = available.map(m => `<option value="${m.id}">${escHtml(m.title)}</option>`).join('');
  document.getElementById('share-error').style.display = 'none';
  document.getElementById('share-modal').style.display = 'flex';
}

function closeShareModal() { document.getElementById('share-modal').style.display = 'none'; }

async function saveShareModal() {
  const targetMeetingId = document.getElementById('share-target-meeting').value;
  const errEl = document.getElementById('share-error');
  errEl.style.display = 'none';
  if (!targetMeetingId) return;
  setBusy('share-save-btn', true);
  try {
    await api('POST', `/meetings/${shareMid}/topics/${shareTid}/share`, { targetMeetingId });
    await loadMeetings();
    closeShareModal(); render();
    toast('Thema erfolgreich geteilt');
  } catch(e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { setBusy('share-save-btn', false); }
}

// ── Advance date ─────────────────────────────────────────────
async function doAdvanceDate(id) {
  const m = getMeeting(id);
  if (!m?.nextDate || !m.recurrencePattern) return;
  const nextDate = advanceDate(m.nextDate, m.recurrencePattern);
  try {
    await api('PUT', `/meetings/${id}`, { nextDate });
    m.nextDate = nextDate; render();
    toast(`Termin vorgerückt auf ${fmtDate(nextDate)}`);
  } catch(e) { toast(e.message, 'error'); }
}

// ── Admin ────────────────────────────────────────────────────
let adminUsers = [];

// Arbeitspaket B3 (Backup/Restore, Admin, Web-only): Handle des aktuell
// gemounteten TSBackup-Panels, analog contactDetailHandle - muss beim
// Schließen des Modals destroy()t werden (sonst blieben z.B. laufende
// Reload-Timer/Event-Listener an einem bereits ersetzten DOM-Host hängen).
let backupPanelHandle = null;

function openBackupPanel() {
  document.getElementById('backup-modal').style.display = 'flex';
  const host = document.getElementById('backup-panel-host');
  if (backupPanelHandle && typeof backupPanelHandle.destroy === 'function') backupPanelHandle.destroy();
  if (!window.TSBackup || typeof TSBackup.mount !== 'function') {
    host.innerHTML = '<p class="form-error">Datensicherung konnte nicht geladen werden.</p>';
    return;
  }
  backupPanelHandle = TSBackup.mount(host);
}

function closeBackupPanel() {
  document.getElementById('backup-modal').style.display = 'none';
  if (backupPanelHandle && typeof backupPanelHandle.destroy === 'function') {
    try { backupPanelHandle.destroy(); } catch (e) { console.warn('closeBackupPanel: destroy() fehlgeschlagen', e); }
  }
  backupPanelHandle = null;
}

async function openAdminPanel() {
  document.getElementById('admin-modal').style.display = 'flex';
  document.getElementById('new-user-form').style.display = 'none';
  await refreshUserList();
}

async function refreshUserList() {
  try {
    adminUsers = await api('GET', '/users');
    renderUserList();
  } catch(e) { toast(e.message, 'error'); }
}

function renderUserList() {
  const el = document.getElementById('admin-user-list');
  if (!adminUsers.length) { el.innerHTML = '<p style="color:var(--text-muted)">Keine Benutzer.</p>'; return; }
  el.innerHTML = `
    <table class="user-table">
      <thead><tr><th>Benutzername</th><th>Rolle</th><th>Erstellt</th><th>Zuletzt aktiv</th><th></th></tr></thead>
      <tbody>${adminUsers.map(u => `
        <tr>
          <td><strong>${escHtml(u.username)}</strong>${u.id===currentUser.id?` <span style="font-size:.75rem;color:var(--text-muted)">(Sie)</span>`:''}</td>
          <td><span class="badge ${u.role==='admin'?'badge-admin':'badge-user'}">${u.role==='admin'?'Admin':'Benutzer'}</span></td>
          <td style="color:var(--text-muted);font-size:.8125rem">${fmtDate(u.created_at)}</td>
          <td style="font-size:.8125rem">${fmtLastActive(u.last_active_at)}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-secondary btn-sm" onclick="openEditUser('${u.id}')">✏️</button>
            ${u.id!==currentUser.id?`<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmDeleteUser('${u.id}','${escJsAttr(u.username)}')">🗑️</button>`:''}
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function toggleNewUserForm() {
  const f = document.getElementById('new-user-form');
  f.style.display = f.style.display === 'none' ? '' : 'none';
  if (f.style.display !== 'none') {
    ['nu-username','nu-password'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('nu-role').value = 'user';
    document.getElementById('nu-error').style.display = 'none';
    setTimeout(() => document.getElementById('nu-username').focus(), 50);
  }
}

async function createUser() {
  const username = document.getElementById('nu-username').value.trim();
  const password = document.getElementById('nu-password').value;
  const role     = document.getElementById('nu-role').value;
  const errEl    = document.getElementById('nu-error');
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Bitte alle Felder ausfüllen'; errEl.style.display = ''; return; }
  setBusy('nu-save-btn', true);
  try {
    await api('POST', '/users', { username, password, role });
    await refreshUserList();
    toggleNewUserForm();
    toast(`Benutzer „${username}" angelegt`);
  } catch(e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { setBusy('nu-save-btn', false); }
}

function openEditUser(id) {
  editUserId = id;
  const u = adminUsers.find(u => u.id === id);
  document.getElementById('eu-modal-title').textContent = `Benutzer: ${u?.username}`;
  document.getElementById('eu-password').value = '';
  document.getElementById('eu-role').value     = u?.role || 'user';
  document.getElementById('eu-error').style.display = 'none';
  document.getElementById('edit-user-modal').style.display = 'flex';
}

async function saveEditUser() {
  const password = document.getElementById('eu-password').value;
  const role     = document.getElementById('eu-role').value;
  const errEl    = document.getElementById('eu-error');
  errEl.style.display = 'none';
  const body = { role }; if (password) body.password = password;
  setBusy('eu-save-btn', true);
  try {
    await api('PUT', `/users/${editUserId}`, body);
    document.getElementById('edit-user-modal').style.display = 'none';
    await refreshUserList();
    toast('Benutzer aktualisiert');
  } catch(e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { setBusy('eu-save-btn', false); }
}

function confirmDeleteUser(id, name) {
  confirmCallback = async () => {
    try { await api('DELETE', `/users/${id}`); await refreshUserList(); toast(`Benutzer „${name}" gelöscht`); }
    catch(e) { toast(e.message, 'error'); }
  };
  document.getElementById('confirm-title').textContent   = 'Benutzer löschen?';
  document.getElementById('confirm-message').textContent = `„${name}" und alle Meetings dieses Benutzers werden unwiderruflich gelöscht.`;
  document.getElementById('confirm-dialog').style.display = 'flex';
}

// ── Confirm ──────────────────────────────────────────────────
// Hinweis (Arbeitspaket W1, Archiv-Feature): confirmDelete() behandelt seit
// der Umstellung auf "Meetings archivieren statt löschen" ausschließlich noch
// den Themen-Zweig ('topic'). Der frühere 'meeting'-Zweig (DELETE
// /api/meetings/:id, echtes/sofortiges Löschen) ist ersatzlos entfernt — der
// Papierkorb-Button in der Meeting-Kopfzeile ruft jetzt confirmArchiveMeeting()
// auf. Der Server-Endpunkt DELETE /api/meetings/:id bleibt laut Vertrag
// unverändert bestehen, wird von der Web-UI aber nicht mehr aufgerufen.
function confirmDelete(type, ...args) {
  if (type !== 'topic') return; // defensiv: unbekannter/entfallener Typ, keine Aktion
  const t = getTopic(args[0], args[1]);
  const isShared = !!t?.groupId;
  confirmCallback = async () => {
    try {
      await api('DELETE', `/meetings/${args[0]}/topics/${args[1]}`);
      if (isShared) {
        await loadMeetings();
      } else {
        const m = getMeeting(args[0]);
        if (m) m.topics = m.topics.filter(x => x.id !== args[1]);
      }
      render(); toast('Thema gelöscht');
    } catch(e) { toast(e.message, 'error'); }
  };
  document.getElementById('confirm-title').textContent   = 'Thema löschen?';
  document.getElementById('confirm-message').textContent = isShared
    ? `„${t?.title}" wird aus diesem Meeting entfernt. In anderen Meetings bleibt das Thema erhalten.`
    : `„${t?.title}" wird unwiderruflich gelöscht.`;
  document.getElementById('confirm-dialog').style.display = 'flex';
}

function closeConfirm() {
  document.getElementById('confirm-dialog').style.display = 'none';
  confirmCallback = null;
  // Sicherheitsfix (Security Review, Mittel, Fund 3): Label-/Klassen-Cleanup
  // von genericConfirm() bei JEDEM Schließen des Dialogs ausführen (Button-
  // Klick, Escape, oder ein sonstiger Programmaufruf) — nicht nur, wenn einer
  // der beiden Dialog-Buttons selbst geklickt wurde. Sonst behält der geteilte
  // #confirm-dialog dauerhaft die zuletzt von genericConfirm() gesetzten
  // Labels/Klasse, und ein späterer, tatsächlich destruktiver Aufruf (z. B.
  // confirmDeleteTodo) zeigt falsch beschriftete/gestylte Buttons.
  if (confirmCleanup) { const fn = confirmCleanup; confirmCleanup = null; fn(); }
}
async function executeConfirm() { const cb = confirmCallback; closeConfirm(); if (cb) await cb(); }

// Generische Promise-basierte Bestätigung mit anpassbaren Button-Labels (nutzt
// den bestehenden confirm-dialog, stellt Standard-Labels/-Klassen danach wieder her).
// `opts` (Arbeitspaket W1, Archiv-Feature, Punkt 6): optionales Objekt
// { danger?: boolean, focus?: 'cancel'|'confirm' } — Default unverändert
// (Bestätigen-Button ist "btn-primary" und erhält den Fokus). Damit bleibt
// EIN gemeinsamer Dialog-Mechanismus statt eines zweiten für den
// "Endgültig löschen"-Sonderfall (Fokus auf Abbrechen, danger-Styling).
function genericConfirm(title, message, confirmLabel, cancelLabel, opts) {
  const danger = !!(opts && opts.danger);
  const focusTarget = (opts && opts.focus === 'cancel') ? 'cancel' : 'confirm';
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const actions = document.querySelector('#confirm-dialog .confirm-actions');
    const cancelBtn = actions.children[0];
    const confirmBtn = actions.children[1];
    const origCancelText = cancelBtn.textContent, origConfirmText = confirmBtn.textContent;
    const origConfirmClass = confirmBtn.className;
    cancelBtn.textContent = cancelLabel || 'Abbrechen';
    confirmBtn.textContent = confirmLabel || 'Bestätigen';
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    // Läuft jetzt zentral in closeConfirm() (Fund 3), damit Labels/Klasse
    // auch bei einem Schließen von außen (z. B. Escape) zuverlässig
    // zurückgesetzt werden statt dauerhaft "hängen zu bleiben".
    confirmCleanup = () => {
      cancelBtn.textContent = origCancelText;
      confirmBtn.textContent = origConfirmText;
      confirmBtn.className = origConfirmClass;
    };
    confirmCallback = async () => { resolve(true); };
    cancelBtn.onclick = () => { closeConfirm(); resolve(false); cancelBtn.onclick = () => closeConfirm(); };
    document.getElementById('confirm-dialog').style.display = 'flex';
    (focusTarget === 'cancel' ? cancelBtn : confirmBtn).focus();
  });
}

// ── Mobile sidebar ───────────────────────────────────────────
function openMobileSidebar() {
  document.querySelector('.sidebar').classList.add('open');
  document.querySelector('.sidebar-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeMobileSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.querySelector('.sidebar-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Navigation ───────────────────────────────────────────────
function selectMeeting(id) {
  selectedId = id; topicFilter = ''; closeMobileSidebar();
  lastTodosView = id;
  const m = meetings.find(x => x.id === id);
  updateTopbar(m ? m.title : '—');
  render(); refreshAiUiVisibility();
  if (id && cmiByMeeting[id] === undefined) loadCmiFor(id).then(() => { if (selectedId === id) render(); });
}
function onSearch(val) { filterText = val; renderSidebar(); }
function onTopicSearch(val) {
  topicFilter = val;
  renderMain();
  const el = document.getElementById('topic-search-input');
  if (el) { el.focus(); el.setSelectionRange(val.length, val.length); }
}
function overlayClick(e, id) {
  if (e.target.id !== id) return;
  const modal = document.getElementById(id);
  // Nicht schließen wenn der User bereits etwas eingegeben hat
  const hasText =
    [...modal.querySelectorAll('input[type="text"], input[type="email"], textarea')]
      .some(el => el.value.trim() !== '') ||
    [...modal.querySelectorAll('.rt-content')]
      .some(el => (el.textContent || '').trim() !== '');
  if (hasText) return;
  // theme-link-modal/contact-modal (Arbeitspaket W2) müssen über ihre
  // eigenen Schließ-Funktionen laufen statt blind ausgeblendet zu werden:
  // theme-link-modal muss `onClosed()` zuverlässig auslösen (siehe
  // openThemeLinkModal), contact-modal muss die gemountete TSContacts-
  // Detailansicht destroy()en (sonst bleiben Notizen-Composer/-Timeline an
  // einem bereits verworfenen Host hängen).
  if (id === 'theme-link-modal') { closeThemeLinkModal(); return; }
  if (id === 'contact-modal') { closeContactModal(); return; }
  if (id === 'backup-modal') { closeBackupPanel(); return; }
  modal.style.display = 'none';
}

// ── AI (Erweiterung v1.1) ────────────────────────────────────
let aiSettings = null;
let aiCaptureLastSuggestions = null;
let aiResultDraftCtx = null;  // { refType, refId }

const AI_FEATURE_LABELS = {
  brief:         'Pre-Meeting-Briefing',
  capture:       'Notizen-Erfassung',
  result_draft:  'Ergebnis-Vorschlag',
  reentry:       'Re-Entry-Briefing',
  theme_tagging: 'Auto-Theme-Tagging',
  digest:        'Wochen-Digest',
  cross_meeting: 'Cross-Meeting-Insight',
  drift:         'Drift-Detection',
  link_summary:  'Link-Zusammenfassung',
  progress_summary:    'Fortschritts-Zusammenfassung',
  description_summary: 'Beschreibungs-Zusammenfassung',
};

const AI_MODEL_DEFAULTS = {
  anthropic: ['claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5'],
  openai:    ['gpt-5','gpt-5-mini','gpt-4o'],
  azure:     [],
};

function aiIsActive() {
  return aiSettings && aiSettings.configured && !aiSettings.globally_disabled;
}

function aiFeatureOn(name) {
  return aiIsActive() && !!(aiSettings.features_enabled || {})[name];
}

function refreshAiUiVisibility() {
  document.body.classList.toggle('ai-disabled', !aiIsActive());
  const rdBtn = document.getElementById('c-result-draft-btn');
  if (rdBtn) rdBtn.style.display = aiFeatureOn('result_draft') ? '' : 'none';
  // Briefing/Notizen werden direkt im Meeting-Detail-Header gerendert; sie
  // sind durch die `ai-action`-Klasse global via body.ai-disabled ein/aus.
}

// ── Export ───────────────────────────────────────────────────
function openExportModal() {
  document.getElementById('export-modal').style.display = 'flex';
  onExportScopeChange();
}

function onExportScopeChange() {
  const scope = document.querySelector('input[name="export-scope"]:checked').value;
  document.getElementById('export-graph-field').style.display = (scope === 'knowledge' || scope === 'both') ? '' : 'none';
  document.getElementById('export-open-only-field').style.display = (scope === 'todos' || scope === 'both') ? '' : 'none';
}

// Bewusste Ausnahme vom sonst üblichen "<a href download>"-Muster: fetch()+Blob
// statt reiner Navigation, weil (a) ein Fehler (abgelaufene Session,
// Serverfehler) sonst als fehlgeschlagener "Download" einer JSON-Fehlerseite
// erscheinen würde statt als Toast, (b) der Busy-State erst nach echtem
// Abschluss zurückgesetzt werden kann.
async function runExport() {
  const scope        = document.querySelector('input[name="export-scope"]:checked').value;
  const format        = document.querySelector('input[name="export-format"]:checked').value;
  const includeGraph  = document.getElementById('export-include-graph').checked;
  const openOnly      = document.getElementById('export-open-only').checked;

  const params = new URLSearchParams({
    scope, format,
    graph: includeGraph ? '1' : '0',
    openOnly: openOnly ? '1' : '0',
  });

  setBusy('export-run-btn', true);
  try {
    const res = await fetch(`${API}/export?${params.toString()}`, { method: 'GET', credentials: 'same-origin' });
    if (res.status === 401) { handleSessionExpiry(); throw new Error('Sitzung abgelaufen'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Export fehlgeschlagen');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : `ThreadStack-Export.${format}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);

    document.getElementById('export-modal').style.display = 'none';
    toast('Export erstellt', 'success');
  } catch (e) {
    toast(e.message || 'Export fehlgeschlagen', 'error');
  } finally {
    setBusy('export-run-btn', false);
  }
}

async function loadAiSettings() {
  try { aiSettings = await api('GET', '/ai/settings'); }
  catch { aiSettings = null; }
  refreshAiUiVisibility();
}

async function openAiSettings() {
  await loadAiSettings();
  const s = aiSettings || {};
  document.getElementById('ai-provider').value          = s.provider || '';
  document.getElementById('ai-model').value             = s.model || '';
  document.getElementById('ai-azure-endpoint').value    = s.azure_endpoint || '';
  document.getElementById('ai-azure-version').value     = s.azure_api_version || '';
  document.getElementById('ai-budget').value            = s.max_monthly_cost_cents   || 0;
  document.getElementById('ai-threshold').value         = s.confirm_threshold_cents || 10;
  document.getElementById('ai-globally-disabled').checked = !!s.globally_disabled;
  document.getElementById('ai-drift-days').value        = s.drift_days != null ? s.drift_days : 21;
  document.getElementById('ai-theme-threshold').value   = s.theme_tag_threshold != null ? s.theme_tag_threshold : 0.7;
  document.getElementById('ai-digest-enabled').checked  = !!s.weekly_digest_enabled;
  document.getElementById('ai-digest-dow').value        = s.weekly_digest_dow != null ? s.weekly_digest_dow : 0;
  document.getElementById('ai-digest-hour').value       = s.weekly_digest_hour != null ? s.weekly_digest_hour : 18;
  document.getElementById('ai-key').value = '';
  document.getElementById('ai-test-result').textContent = '';
  document.getElementById('ai-key-status').textContent =
    s.api_key_last4 ? `Gespeichert: ••••${s.api_key_last4}` : 'Kein Key gesetzt.';
  onAiProviderChange();
  renderAiFeatures(s.features_enabled || {});
  await renderAiUsageAll();
  document.getElementById('ai-settings-modal').style.display = 'flex';
}

function onAiProviderChange() {
  const prov = document.getElementById('ai-provider').value;
  document.getElementById('ai-azure-fields').style.display = (prov === 'azure') ? '' : 'none';
  const defaults = AI_MODEL_DEFAULTS[prov] || [];
  const hint = defaults.length ? `Übliche Modelle: ${defaults.join(', ')}` : '';
  document.getElementById('ai-model-hint').textContent = hint;
}

function renderAiFeatures(enabled) {
  const container = document.getElementById('ai-features');
  container.innerHTML = '';
  for (const key of Object.keys(AI_FEATURE_LABELS)) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex; align-items:center; gap:.5rem; cursor:pointer';
    label.innerHTML = `<input type="checkbox" data-feature="${key}" ${enabled[key] ? 'checked' : ''}> <span>${escHtml(AI_FEATURE_LABELS[key])}</span>`;
    container.appendChild(label);
  }
}

function collectAiFeatures() {
  const out = {};
  document.querySelectorAll('#ai-features input[data-feature]').forEach(cb => {
    out[cb.dataset.feature] = cb.checked;
  });
  return out;
}

async function saveAiSettingsForm() {
  const body = {
    provider:                document.getElementById('ai-provider').value || '',
    model:                   document.getElementById('ai-model').value.trim(),
    azure_endpoint:          document.getElementById('ai-azure-endpoint').value.trim(),
    azure_api_version:       document.getElementById('ai-azure-version').value.trim(),
    max_monthly_cost_cents:  parseInt(document.getElementById('ai-budget').value, 10)    || 0,
    confirm_threshold_cents: parseInt(document.getElementById('ai-threshold').value, 10) || 0,
    globally_disabled:       document.getElementById('ai-globally-disabled').checked,
    features_enabled:        collectAiFeatures(),
    drift_days:              parseInt(document.getElementById('ai-drift-days').value, 10)  || 21,
    theme_tag_threshold:     parseFloat(document.getElementById('ai-theme-threshold').value) || 0.7,
    weekly_digest_enabled:   document.getElementById('ai-digest-enabled').checked,
    weekly_digest_dow:       parseInt(document.getElementById('ai-digest-dow').value, 10),
    weekly_digest_hour:      parseInt(document.getElementById('ai-digest-hour').value, 10),
  };
  const newKey = document.getElementById('ai-key').value;
  if (newKey) body.api_key = newKey;
  try {
    aiSettings = await api('PUT', '/ai/settings', body);
    toast('AI-Einstellungen gespeichert');
    document.getElementById('ai-key').value = '';
    document.getElementById('ai-key-status').textContent =
      aiSettings.api_key_last4 ? `Gespeichert: ••••${aiSettings.api_key_last4}` : 'Kein Key gesetzt.';
    refreshAiUiVisibility();
  } catch (e) {
    toast(e.message || 'Speichern fehlgeschlagen', 'error');
  }
}

async function testAiConnection() {
  const out = document.getElementById('ai-test-result');
  out.innerHTML = '<span class="ai-spinner"></span> teste …';
  try {
    const r = await api('POST', '/ai/test');
    out.textContent = `✓ Verbindung OK (${r.model || ''})`;
  } catch (e) {
    out.textContent = `✗ ${e.message || 'Test fehlgeschlagen'}`;
  }
}

async function removeAiKey() {
  if (!confirm('API-Key wirklich entfernen?')) return;
  try {
    aiSettings = await api('DELETE', '/ai/settings/key');
    document.getElementById('ai-key-status').textContent = 'Kein Key gesetzt.';
    refreshAiUiVisibility();
    toast('API-Key entfernt');
  } catch (e) {
    toast(e.message || 'Fehler', 'error');
  }
}

async function renderAiUsageAll() {
  const periods = ['today','week','month'];
  const labels  = { today: 'Heute', week: 'Diese Woche', month: 'Diesen Monat' };
  const grid = document.getElementById('ai-usage-grid');
  const feat = document.getElementById('ai-usage-features');
  grid.innerHTML = ''; feat.innerHTML = '';
  for (const p of periods) {
    try {
      const u = await api('GET', `/ai/usage?period=${p}`);
      const cents = u.total_cost_cents | 0;
      grid.insertAdjacentHTML('beforeend',
        `<div class="ai-usage-box"><div class="num">${(cents/100).toFixed(2)} €</div><div class="lbl">${labels[p]}</div></div>`);
      if (p === 'month' && u.entries && u.entries.length) {
        const parts = u.entries.map(e =>
          `${escHtml(AI_FEATURE_LABELS[e.feature] || e.feature)}: ${(e.cost_cents/100).toFixed(2)} € (${e.calls})`
        );
        feat.textContent = parts.join(' · ');
      }
    } catch (_) { /* ignore */ }
  }
}

// Generic AI call wrapper that handles 428 (confirm) and 402 (budget).
async function aiCall(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (e) {
    if (e.status === 428) {
      const det = e.body?.detail || {};
      const cents = det.estimated_cost_cents | 0;
      if (confirm(`Geschätzte Kosten: ${(cents/100).toFixed(2)} € (Schwelle: ${(det.threshold_cents/100).toFixed(2)} €).\nFortfahren?`)) {
        const sep = path.includes('?') ? '&' : '?';
        return await api(method, path + sep + 'confirm=true', body);
      }
      const cancel = new Error('Abgebrochen');
      cancel.cancelled = true;
      throw cancel;
    }
    if (e.status === 402) {
      toast('Monatliches AI-Budget erschöpft', 'error');
    }
    throw e;
  }
}

// ── Brief ─────────────────────────────────────────────────────
function openAiBrief() {
  if (!selectedId) { toast('Kein Meeting ausgewählt', 'error'); return; }
  document.getElementById('ai-brief-modal').style.display = 'flex';
  runBrief(false);
}

async function runBrief(redo) {
  const body = document.getElementById('ai-brief-body');
  body.innerHTML = '<div class="ai-status-line"><span class="ai-spinner"></span> Erzeuge Briefing …</div>';
  document.getElementById('ai-brief-redo').style.display = 'none';
  try {
    const r = await aiCall('POST', `/ai/meeting/${selectedId}/brief`);
    const c = r.content || {};
    const tp = (c.talking_points || []).map(s => `<li>${escHtml(s)}</li>`).join('');
    const oi = (c.open_issues || []).map(s => `<li>${escHtml(s)}</li>`).join('');
    body.innerHTML = `
      <div class="ai-section">
        <h3>📌 Talking Points <span class="ai-pill">${(c.talking_points||[]).length}</span></h3>
        <ul style="margin-left:1.2rem">${tp || '<li><em>—</em></li>'}</ul>
      </div>
      <div class="ai-section">
        <h3>❓ Offene Punkte <span class="ai-pill">${(c.open_issues||[]).length}</span></h3>
        <ul style="margin-left:1.2rem">${oi || '<li><em>—</em></li>'}</ul>
      </div>
      <div class="ai-section">
        <h3>📖 Vorgeschichte</h3>
        <p>${escHtml(c.history || '—')}</p>
      </div>
      <div class="ai-status-line">Kosten: ${((r.cost_cents||0)/100).toFixed(2)} €</div>`;
    document.getElementById('ai-brief-redo').style.display = '';
  } catch (e) {
    if (!e.cancelled) body.innerHTML = `<div class="form-error">${escHtml(e.message || 'Fehler')}</div>`;
  }
}

// ── Capture ───────────────────────────────────────────────────
function openAiCapture() {
  if (!selectedId) { toast('Kein Meeting ausgewählt', 'error'); return; }
  document.getElementById('ai-capture-notes').value = '';
  document.getElementById('ai-capture-suggestions').style.display = 'none';
  document.getElementById('ai-capture-suggestions').innerHTML = '';
  document.getElementById('ai-capture-status').textContent = '';
  document.getElementById('ai-capture-apply').style.display = 'none';
  document.getElementById('ai-capture-process').style.display = '';
  aiCaptureLastSuggestions = null;
  document.getElementById('ai-capture-modal').style.display = 'flex';
}

async function runCapture() {
  const notes = document.getElementById('ai-capture-notes').value.trim();
  if (!notes) { toast('Bitte Notizen eingeben', 'error'); return; }
  const status = document.getElementById('ai-capture-status');
  status.innerHTML = '<span class="ai-spinner"></span> Verarbeite Notizen …';
  document.getElementById('ai-capture-process').disabled = true;
  try {
    const r = await aiCall('POST', `/ai/meeting/${selectedId}/capture`, { notes });
    aiCaptureLastSuggestions = r.suggestions;
    renderCaptureSuggestions(r.suggestions);
    status.textContent = `Kosten: ${((r.cost_cents||0)/100).toFixed(2)} €`;
    document.getElementById('ai-capture-apply').style.display = '';
  } catch (e) {
    if (!e.cancelled) status.textContent = `Fehler: ${e.message || ''}`;
  } finally {
    document.getElementById('ai-capture-process').disabled = false;
  }
}

function renderCaptureSuggestions(s) {
  const c = document.getElementById('ai-capture-suggestions');
  const list = (arr, label, render) => arr && arr.length
    ? `<div class="ai-section"><h3>${label} <span class="ai-pill">${arr.length}</span></h3><div class="ai-list">${arr.map(render).join('')}</div></div>`
    : '';
  const checkbox = (group, idx, content) =>
    `<div class="ai-list-item ai-list-check"><input type="checkbox" data-group="${group}" data-idx="${idx}" checked><label>${content}</label></div>`;
  let html = '';
  html += list(s.new_topics,    '🆕 Neue Themen',   (t,i) => checkbox('new_topics', i, `<strong>${escHtml(t.title||'')}</strong>${t.description ? '<br><small>' + escHtml(t.description) + '</small>' : ''}`));
  html += list(s.topic_results, '✓ Ergebnisse',    (r,i) => checkbox('topic_results', i, `<strong>${escHtml(r.topic_id||'')}</strong><br>${escHtml(r.result||'')}`));
  html += list(s.new_todos,     '📋 Neue Todos',   (t,i) => checkbox('new_todos', i, `<strong>${escHtml(t.title||'')}</strong>${t.description ? '<br><small>' + escHtml(t.description) + '</small>' : ''}`));
  html += list(s.theme_links,   '🏷️ Theme-Verknüpfungen', (l,i) => checkbox('theme_links', i, `${escHtml(l.ref_type)} · ${escHtml(l.ref_id)} → ${escHtml(l.theme_id)}`));
  if (!html) html = '<div class="ai-status-line">Keine Vorschläge.</div>';
  c.innerHTML = html;
  c.style.display = '';
}

async function applyCaptureNow() {
  if (!aiCaptureLastSuggestions) return;
  const apply = { new_topics: [], topic_results: [], new_todos: [], theme_links: [] };
  document.querySelectorAll('#ai-capture-suggestions input[type=checkbox]').forEach(cb => {
    if (!cb.checked) return;
    const group = cb.dataset.group;
    const idx   = parseInt(cb.dataset.idx, 10);
    apply[group].push(aiCaptureLastSuggestions[group][idx]);
  });
  try {
    const r = await api('POST', `/ai/meeting/${selectedId}/capture`, { apply_now: apply });
    toast(`Übernommen: ${r.created.topics.length} Themen, ${r.created.todos.length} Todos`);
    await Promise.all([loadMeetings(), loadTodos()]);
    render();
    document.getElementById('ai-capture-modal').style.display = 'none';
  } catch (e) {
    toast(e.message || 'Fehler beim Übernehmen', 'error');
  }
}

// ── Result Draft ──────────────────────────────────────────────
async function runResultDraft() {
  if (!aiResultDraftCtx) return;
  const { refType, refId } = aiResultDraftCtx;
  const status = document.getElementById('c-result-draft-status');
  const btn    = document.getElementById('c-result-draft-btn');
  status.innerHTML = '<span class="ai-spinner"></span> Erzeuge Vorschlag …';
  btn.disabled = true;
  try {
    const r = await aiCall('POST', `/ai/${refType}/${refId}/result-draft`);
    setRT('c-result', escHtml(r.draft || '').replace(/\n/g,'<br>'));
    status.textContent = `Vorschlag eingefügt (Kosten: ${((r.cost_cents||0)/100).toFixed(2)} €) — anpassbar.`;
  } catch (e) {
    if (!e.cancelled) status.textContent = `Fehler: ${e.message || ''}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Stack-Layer (Phase 2) ────────────────────────────────────
let stackState = { frames: [], depth: 0 };
let stackPanelCollapsed = localStorage.getItem('stackPanelCollapsed') !== 'false';
let stackPushCtx     = null;  // { refType, refId, title } | null wenn picker-Modus
let stackPopCtx      = null;
let stackNoteCtx     = null;
let driftPopContext  = null;  // { refType, refId } für drift→backlog
const SHORTCUT_DEFAULTS = { push: 'mod+shift+p', pop: 'mod+shift+o' };
function getShortcuts() {
  try {
    const s = JSON.parse(localStorage.getItem('stackShortcuts') || 'null');
    return s && s.push && s.pop ? s : SHORTCUT_DEFAULTS;
  } catch { return SHORTCUT_DEFAULTS; }
}
function setShortcuts(s) { localStorage.setItem('stackShortcuts', JSON.stringify(s)); }

function refDisplayTitle(refType, refId) {
  if (refType === 'topic') {
    for (const m of meetings) for (const t of (m.topics || [])) if (t.id === refId) return t.title;
  }
  if (refType === 'todo') {
    const t = todos.find(x => x.id === refId);
    if (t) return t.title;
  }
  return '(gelöscht)';
}

function fmtDurationSec(sec) {
  if (sec < 60) return `${sec | 0}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}min` : `${h}h`;
}

async function loadStack() {
  try {
    stackState = await api('GET', '/stack');
    renderStackPanel();
  } catch (_) { /* ignore */ }
}

function renderStackPanel() {
  const panel = document.getElementById('stack-panel');
  if (!currentUser) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  document.getElementById('stack-badge').textContent = stackState.depth;
  document.getElementById('stack-toggle-icon').innerHTML = stackPanelCollapsed
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  panel.classList.toggle('collapsed', stackPanelCollapsed);

  const body = document.getElementById('stack-panel-body');
  if (stackState.frames.length === 0) {
    body.innerHTML = '<div class="stack-empty">Kein offenes Frame.<br><small>⌘⇧P legt eines an.</small></div>';
    return;
  }

  body.innerHTML = stackState.frames.map((f, i) => {
    const isActive = i === 0;
    const typePill = f.ref_type === 'topic' ? `${SVG.chat} Topic` : `${SVG.check} Todo`;
    const note = escHtml(f.next_step_note || '').replace(/\n/g, '<br>');
    const meta = isActive
      ? `läuft seit ${fmtDurationSec(f.age_seconds)}`
      : `geparkt seit ${fmtDurationSec(f.age_seconds)}`;
    const actions = isActive ? `
      <div class="frame-actions" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openStackPopModalFor('${f.id}')">${SVG.eject} Pop</button>
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();openStackNoteModal('${f.id}')">${SVG.notes} Notiz</button>
        <button class="btn btn-ai btn-sm ai-action" onclick="event.stopPropagation();runReentryFor('${f.id}')">${SVG.sparkle} Re-Entry</button>
      </div>
      <div id="reentry-banner-${f.id}" onclick="event.stopPropagation()"></div>
    ` : '';
    return `
      <div class="stack-frame ${isActive ? 'active' : 'parked'}" data-frame-id="${f.id}"
           onclick="openFrameDetail('${f.id}')">
        <div class="frame-title">
          <span class="frame-type-pill">${typePill}</span>
          <span>${escHtml(f.title)}</span>
          ${!isActive ? `<span style="margin-left:auto;font-size:11px;color:var(--text-light)">${SVG.eye} öffnen</span>` : ''}
        </div>
        <div class="frame-note">${note}</div>
        <div class="frame-meta">${meta}</div>
        ${actions}
      </div>`;
  }).join('');
}

function toggleStackPanel() {
  stackPanelCollapsed = !stackPanelCollapsed;
  localStorage.setItem('stackPanelCollapsed', String(stackPanelCollapsed));
  renderStackPanel();
}

// ── Push ─────────────────────────────────────────────────────
function openStackPushModal(refType, refId) {
  stackPushCtx = (refType && refId) ? { refType, refId } : null;
  document.getElementById('sp-note').value = '';
  document.getElementById('sp-count').textContent = '0';
  document.getElementById('sp-depth-warning').style.display = 'none';
  document.getElementById('sp-error').style.display = 'none';
  document.getElementById('sp-save-btn').style.display = '';

  if (stackPushCtx) {
    const title = refDisplayTitle(refType, refId);
    document.getElementById('sp-target').textContent = `${refType === 'topic' ? '💬' : '✓'} ${title}`;
    document.getElementById('sp-target').style.display = '';
    document.getElementById('sp-target-pick-wrap').style.display = 'none';
    // Notizfeld mit dem aktuellen "Nächster Schritt" des Vorhabens vorbelegen
    // (Fortschrittsverlauf, Arbeitspaket S2 liefert diesen bereits eingebettet).
    const nextStep = progressNextStepFor(refType, refId);
    if (nextStep) {
      document.getElementById('sp-note').value = nextStep;
      document.getElementById('sp-count').textContent = String(nextStep.length);
    }
  } else {
    // Quick-Pick: list open topics + todos
    document.getElementById('sp-target').style.display = 'none';
    document.getElementById('sp-target-pick-wrap').style.display = '';
    const sel = document.getElementById('sp-target-pick');
    sel.innerHTML = '<option value="">— bitte wählen —</option>';
    meetings.forEach(m => {
      (m.topics || []).filter(t => !t.done).forEach(t => {
        const o = document.createElement('option');
        o.value = `topic:${t.id}`;
        o.textContent = `💬 ${m.title} — ${t.title}`;
        sel.appendChild(o);
      });
    });
    todos.filter(t => !t.done).forEach(t => {
      const o = document.createElement('option');
      o.value = `todo:${t.id}`;
      o.textContent = `✓ ${t.title}`;
      sel.appendChild(o);
    });
  }

  // Pre-flight depth warning
  if (stackState.depth >= 4) {
    document.getElementById('sp-depth-warning').style.display = '';
    document.getElementById('sp-save-btn').style.display = 'none';
  }

  document.getElementById('stack-push-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('sp-note').focus(), 50);
}

// Liefert den zuletzt hinterlegten "Nächster Schritt" des Fortschrittsverlaufs
// (Arbeitspaket S1/S2 betten dieses Feld bereits in /todos bzw. /meetings ein) —
// leerer String, wenn kein Vorhaben gefunden wird oder noch nichts hinterlegt ist.
function progressNextStepFor(refType, refId) {
  if (refType === 'topic') {
    for (const m of meetings) for (const t of (m.topics || [])) if (t.id === refId) return t.progress?.nextStep || '';
  }
  if (refType === 'todo') {
    const t = todos.find(x => x.id === refId);
    return t?.progress?.nextStep || '';
  }
  return '';
}

// Beim Quick-Pick (Push ohne festes Ziel) wird das Notizfeld erst nach Auswahl
// vorbelegt — nur wenn der Nutzer noch nichts eingetippt hat.
function onStackPushTargetPick() {
  const v = document.getElementById('sp-target-pick').value;
  if (!v) return;
  const [refType, refId] = v.split(':');
  const nextStep = progressNextStepFor(refType, refId);
  const noteEl = document.getElementById('sp-note');
  if (nextStep && !noteEl.value.trim()) {
    noteEl.value = nextStep;
    document.getElementById('sp-count').textContent = String(nextStep.length);
  }
}

function ensurePushCtx() {
  if (stackPushCtx) return stackPushCtx;
  const v = document.getElementById('sp-target-pick').value;
  if (!v) return null;
  const [refType, refId] = v.split(':');
  return { refType, refId };
}

// ── Quick-Push: neues Todo + sofort auf Stack ────────────────
function openQuickPush() {
  document.getElementById('qp-title').value = '';
  document.getElementById('qp-note').value = '';
  document.getElementById('qp-count').textContent = '0';
  document.getElementById('qp-error').style.display = 'none';
  document.getElementById('quick-push-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('qp-title').focus(), 50);
}
async function submitQuickPush() {
  const title = document.getElementById('qp-title').value.trim();
  const note  = document.getElementById('qp-note').value.trim();
  const errEl = document.getElementById('qp-error');
  errEl.style.display = 'none';
  if (!title) { errEl.textContent = 'Titel ist erforderlich.'; errEl.style.display = ''; return; }
  if (!note)  { errEl.textContent = 'Notiz ist erforderlich.'; errEl.style.display = ''; return; }
  const btn = document.getElementById('qp-save-btn');
  btn.disabled = true;
  try {
    const todo = await api('POST', '/todos', { title });
    await loadTodos();
    await api('POST', '/stack/push', { refType: 'todo', refId: todo.id, nextStepNote: note });
    await loadStack();
    document.getElementById('quick-push-modal').style.display = 'none';
    stackPanelCollapsed = false; localStorage.setItem('stackPanelCollapsed', 'false'); renderStackPanel();
    toast('Auf Stack gelegt');
    render();
  } catch (e) {
    errEl.textContent = e.message || 'Fehler';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
}

async function submitStackPush() {
  const note = document.getElementById('sp-note').value.trim();
  const errEl = document.getElementById('sp-error');
  errEl.style.display = 'none';
  if (!note) { errEl.textContent = 'Bitte den nächsten Schritt eintragen.'; errEl.style.display = ''; return; }
  const ctx = ensurePushCtx();
  if (!ctx) { errEl.textContent = 'Bitte ein Topic oder Todo wählen.'; errEl.style.display = ''; return; }
  try {
    const r = await api('POST', '/stack/push', { refType: ctx.refType, refId: ctx.refId, nextStepNote: note });
    toast('Auf Stack gelegt');
    document.getElementById('stack-push-modal').style.display = 'none';
    if (r.depth_warning) toast('Stack-Tiefe ist hoch (≥4) — denk an Tagesabschluss!', 'success');
    await loadStack();
    stackPanelCollapsed = false; localStorage.setItem('stackPanelCollapsed', 'false'); renderStackPanel();
  } catch (e) {
    if (e.status === 409) {
      errEl.textContent = 'Dieses Topic/Todo liegt bereits auf dem Stack.';
      errEl.style.display = '';
    } else {
      errEl.textContent = e.message || 'Fehler';
      errEl.style.display = '';
    }
  }
}

async function doStackPushForce() {
  // Bypass: same as submit, depth warning was just informational
  document.getElementById('sp-depth-warning').style.display = 'none';
  document.getElementById('sp-save-btn').style.display = '';
  await submitStackPush();
}

async function quickCaptureAsTodo() {
  const note = document.getElementById('sp-note').value.trim();
  const ctx = ensurePushCtx();
  if (!ctx) { toast('Bitte ein Topic oder Todo wählen.', 'error'); return; }
  const title = refDisplayTitle(ctx.refType, ctx.refId);
  try {
    await api('POST', '/todos', { title: `Quick: ${title}`, description: note });
    await loadTodos();
    render();
    toast('Als Quick-Todo erfasst (nicht auf Stack)');
    document.getElementById('stack-push-modal').style.display = 'none';
  } catch (e) {
    toast(e.message || 'Fehler', 'error');
  }
}

// ── Pop ──────────────────────────────────────────────────────
function openStackPopModalFor(frameId) {
  const f = stackState.frames.find(x => x.id === frameId);
  if (!f) { toast('Frame nicht gefunden', 'error'); return; }
  stackPopCtx = { frame: f };
  document.getElementById('pop-frame-info').textContent =
    `${f.ref_type === 'topic' ? '💬' : '✓'} ${f.title} — läuft seit ${fmtDurationSec(f.age_seconds)}`;
  // Reset to "done" default
  document.querySelectorAll('input[name=pop-res]').forEach(r => r.checked = r.value === 'done');
  setRT('pop-result', '');
  setRT('pop-progress-note', '');
  document.getElementById('pop-result-date').value = new Date().toISOString().slice(0, 10);
  // Default snooze: tomorrow 09:00 local
  const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
  document.getElementById('pop-snooze-until').value =
    t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0') + '-' + String(t.getDate()).padStart(2,'0') + 'T09:00';
  onPopResolutionChange();
  document.getElementById('pop-error').style.display = 'none';
  document.getElementById('stack-pop-modal').style.display = 'flex';
}

// Traegt snoozedUntil (Datum + optionale Uhrzeit) in die "Weitere Details"-
// Felder des Todo-/Themen-Bearbeiten-Dialogs ein - beim Oeffnen des Dialogs
// UND wenn die Composer-Kurzoption "Schlafen bis" den Wert waehrenddessen
// aendert (siehe syncSnoozeFormIfModalOpen), damit beide Bedienstellen nie
// auseinanderlaufen.
function applyTodoSnoozeToForm(t) {
  document.getElementById('todo-snooze').value = t?.snoozedUntil?.slice(0, 10) || '';
  const hasTime = !!(t?.snoozedUntil && t.snoozedUntil.length > 10);
  document.getElementById('todo-snooze-has-time').checked = hasTime;
  document.getElementById('todo-snooze-time').value = hasTime ? new Date(t.snoozedUntil).toTimeString().slice(0, 5) : '';
  onTodoSnoozeChange();
}
function applyTopicSnoozeToForm(t) {
  document.getElementById('t-snooze').value = t?.snoozedUntil?.slice(0, 10) || '';
  const hasTime = !!(t?.snoozedUntil && t.snoozedUntil.length > 10);
  document.getElementById('t-snooze-has-time').checked = hasTime;
  document.getElementById('t-snooze-time').value = hasTime ? new Date(t.snoozedUntil).toTimeString().slice(0, 5) : '';
  onTopicSnoozeChange();
}

function onTodoSnoozeChange() {
  const hasDate = !!document.getElementById('todo-snooze').value;
  const cb = document.getElementById('todo-snooze-has-time');
  cb.disabled = !hasDate;
  if (!hasDate) cb.checked = false;
  document.getElementById('todo-snooze-time').style.display = (hasDate && cb.checked) ? '' : 'none';
  // Der Schlafen-bis-Hinweis im Zwischenstand-Composer wird vom Composer
  // selbst gerendert (siehe ComposerInstance.snoozedFuture in progress.js),
  // kein externes Hinweis-Element hier mehr nötig.
}
function onTopicSnoozeChange() {
  const hasDate = !!document.getElementById('t-snooze').value;
  const cb = document.getElementById('t-snooze-has-time');
  cb.disabled = !hasDate;
  if (!hasDate) cb.checked = false;
  document.getElementById('t-snooze-time').style.display = (hasDate && cb.checked) ? '' : 'none';
  // Analog zu onTodoSnoozeChange(): der Hinweis kommt jetzt aus dem
  // Composer selbst (siehe mountProgressArea).
}

function onPopResolutionChange() {
  const v = document.querySelector('input[name=pop-res]:checked')?.value || 'done';
  document.getElementById('pop-result-fields').style.display = (v === 'done')    ? '' : 'none';
  document.getElementById('pop-snooze-fields').style.display = (v === 'snoozed') ? '' : 'none';
  document.getElementById('pop-progress-fields').style.display = (v === 'snoozed' || v === 'dropped') ? '' : 'none';
}

async function submitStackPop() {
  if (!stackPopCtx) return;
  const f = stackPopCtx.frame;
  const resolution = document.querySelector('input[name=pop-res]:checked').value;
  const body = { resolution };
  if (resolution === 'done') {
    const result = getRT('pop-result');
    if (result) { body.result = result; body.resultDate = document.getElementById('pop-result-date').value; }
  } else if (resolution === 'snoozed') {
    const local = document.getElementById('pop-snooze-until').value;
    if (local) body.snoozedUntil = new Date(local).toISOString();
  }
  // Vorab erfassen: "Wo stehe ich gerade?" wird NACH erfolgreichem Pop separat
  // als Fortschritts-Zwischenstand gespeichert (Story 6) — vor dem Request
  // sichern, da das Feld nach Schließen des Dialogs zurückgesetzt wird.
  const progressNoteHtml = (resolution === 'snoozed' || resolution === 'dropped') ? getRT('pop-progress-note') : '';
  const progressSource = resolution === 'snoozed' ? 'pop_snoozed' : 'pop_dropped';
  try {
    const r = await api('POST', `/stack/pop/${f.id}`, body);
    document.getElementById('stack-pop-modal').style.display = 'none';
    toast(resolution === 'resumed' ? 'Frame wieder aktiv — weiter bearbeiten' : 'Frame geschlossen');
    if (progressNoteHtml) submitProgressEntryBackground(f.ref_type, f.ref_id, progressNoteHtml, progressSource);
    await Promise.all([loadStack(), loadMeetings(), loadTodos()]);
    render();
    if (resolution === 'resumed') navigateToRef(f.ref_type, f.ref_id);
    if (r.drift_warning) {
      driftPopContext = { refType: f.ref_type, refId: f.ref_id };
      document.getElementById('pop-drift-modal').style.display = 'flex';
    }
  } catch (e) {
    const errEl = document.getElementById('pop-error');
    errEl.textContent = e.message || 'Fehler'; errEl.style.display = '';
  }
}

async function confirmDriftToBacklog() {
  if (!driftPopContext) { document.getElementById('pop-drift-modal').style.display = 'none'; return; }
  const tomorrow9 = (() => { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d.toISOString(); })();
  try {
    if (driftPopContext.refType === 'topic') {
      // find meeting for topic
      let mid = null;
      for (const m of meetings) for (const t of (m.topics || [])) if (t.id === driftPopContext.refId) { mid = m.id; break; }
      if (mid) await api('PUT', `/meetings/${mid}/topics/${driftPopContext.refId}`, { snoozedUntil: tomorrow9 });
    } else {
      await api('PUT', `/todos/${driftPopContext.refId}`, { snoozedUntil: tomorrow9 });
    }
    toast('In Backlog verschoben (snoozed bis morgen 9:00)');
    await Promise.all([loadMeetings(), loadTodos()]); render();
  } catch (e) { toast(e.message || 'Fehler', 'error'); }
  document.getElementById('pop-drift-modal').style.display = 'none';
  driftPopContext = null;
}

// ── Stack Note Edit ──────────────────────────────────────────
function openStackNoteModal(frameId) {
  const f = stackState.frames.find(x => x.id === frameId);
  if (!f) return;
  stackNoteCtx = { frameId };
  document.getElementById('sn-note').value = f.next_step_note || '';
  document.getElementById('sn-count').textContent = (f.next_step_note || '').length;
  document.getElementById('sn-error').style.display = 'none';
  document.getElementById('stack-note-modal').style.display = 'flex';
}
async function submitStackNote() {
  const note = document.getElementById('sn-note').value.trim();
  const errEl = document.getElementById('sn-error');
  if (!note) { errEl.textContent = 'Notiz darf nicht leer sein.'; errEl.style.display = ''; return; }
  try {
    await api('PUT', `/stack/${stackNoteCtx.frameId}/note`, { nextStepNote: note });
    toast('Notiz aktualisiert');
    document.getElementById('stack-note-modal').style.display = 'none';
    await loadStack();
  } catch (e) {
    errEl.textContent = e.message || 'Fehler'; errEl.style.display = '';
  }
}

// ── Frame Detail (peek/activate) ─────────────────────────────
let frameDetailCtx = null;  // { frameId, isActive }

function openFrameDetail(frameId) {
  const f = stackState.frames.find(x => x.id === frameId);
  if (!f) return;
  const idx = stackState.frames.indexOf(f);
  const isActive = idx === 0;
  frameDetailCtx = { frameId: f.id, isActive, frame: f };

  document.getElementById('fd-title').textContent  = isActive ? '📚 Aktives Frame' : '📚 Geparktes Frame';
  document.getElementById('fd-target').textContent = (f.ref_type === 'topic' ? '💬 ' : '✓ ') + f.title;
  document.getElementById('fd-note').textContent   = f.next_step_note || '— keine Notiz —';
  const ageLabel = isActive
    ? `läuft seit ${fmtDurationSec(f.age_seconds)}`
    : `geparkt seit ${fmtDurationSec(f.age_seconds)}`;
  document.getElementById('fd-meta').textContent = ageLabel;
  document.getElementById('fd-status-hint').textContent =
    isActive
      ? 'Du arbeitest gerade hier weiter — schließe einfach diesen Dialog.'
      : 'Klicke „Auf dieses Frame zurück", um hier weiterzumachen (alle anderen Frames bleiben offen geparkt).';
  document.getElementById('fd-activate-btn').style.display = isActive ? 'none' : '';

  document.getElementById('frame-detail-modal').style.display = 'flex';
}

async function activateFrameFromDetail() {
  if (!frameDetailCtx || frameDetailCtx.isActive) return;
  const fid = frameDetailCtx.frameId;
  try {
    // resolution=resumed: Frame bleibt offen, wird zum aktiven oben
    await api('POST', `/stack/pop/${fid}`, { resolution: 'resumed' });
    document.getElementById('frame-detail-modal').style.display = 'none';
    const refType = frameDetailCtx.frame?.ref_type;
    const refId   = frameDetailCtx.frame?.ref_id;
    frameDetailCtx = null;
    await Promise.all([loadStack(), loadMeetings(), loadTodos()]);
    render();
    toast('Frame wieder aktiv — weiter bearbeiten');
    if (refType && refId) navigateToRef(refType, refId);
  } catch (e) {
    toast(e.message || 'Fehler', 'error');
  }
}

// ── Navigate + open edit after resume ───────────────────────
function navigateToRef(refType, refId) {
  if (refType === 'todo') {
    selectView('__todos__');
    // Kurz warten bis render() durch ist, dann Edit-Modal öffnen
    setTimeout(() => openTodoModal(refId), 80);
  } else if (refType === 'topic') {
    // Zugehöriges Meeting suchen
    let mid = null;
    for (const m of meetings) {
      if ((m.topics || []).some(t => t.id === refId)) { mid = m.id; break; }
    }
    if (mid) {
      selectMeeting(mid);
      setTimeout(() => openTopicModal(mid, refId), 80);
    }
  }
}

// ── Re-Entry Briefing ────────────────────────────────────────
async function runReentryFor(frameId) {
  const banner = document.getElementById(`reentry-banner-${frameId}`);
  if (!banner) return;
  banner.innerHTML = '<div class="stack-reentry-banner"><span class="ai-spinner"></span> erzeuge …</div>';
  try {
    const r = await aiCall('POST', `/ai/stack/${frameId}/reentry`);
    banner.innerHTML = `<div class="stack-reentry-banner">${escHtml(r.content.summary || '')}</div>`;
  } catch (e) {
    if (e.cancelled) banner.innerHTML = '';
    else banner.innerHTML = `<div class="stack-reentry-banner" style="border-left-color:var(--red); color:var(--red)">Fehler: ${escHtml(e.message || '')}</div>`;
  }
}

// ── Fortschrittsverlauf — Host-Integration (Arbeitspaket W1/W2) ────────
// Implementiert window.TSHost.progress (siehe Zuweisung weiter oben) sowie
// den umgebenden Modal-/Formular-Rahmen. Anzeige-Bausteine (Zeitstrahl,
// Wiedereinstiegskarte, Badge, Sortier-Comparator) liefert ausschließlich
// window.TSProgress (public/progress.js) — hier wird NICHTS davon dupliziert.
// Der Fortschrittsverlauf ist fest in die Todo-/Themen-Bearbeiten-Ansicht
// eingebettet (kein separates Panel mehr, siehe Arbeitspaket W2).

let progressNextStepDialogCtx = null;  // { refType, refId, resolve }

function isValidProgressRefType(t) { return t === 'todo' || t === 'topic'; }

function makeProgressClientToken() {
  // Muss ^[A-Za-z0-9_-]{1,64}$ erfüllen (siehe lib/progress/routes.js) — dient
  // ausschließlich der serverseitigen Idempotenz bei Netzwerk-Retries.
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// ── Nächster Schritt bearbeiten (dauerhaft am Vorhaben, Story 5) ──
// Eigenständiger Dialog, dauerhaft im Verlaufs-Panel sichtbar/editierbar,
// unabhaengig vom Stack-Zustand
// (Tester-Fund: bislang nur transient im Push-Dialog vorbelegt).
function openProgressNextStepDialog(ctx) {
  return new Promise((resolve) => {
    const refType = ctx && ctx.refType, refId = ctx && ctx.refId;
    if (!isValidProgressRefType(refType) || !refId) { resolve('cancelled'); return; }
    progressNextStepDialogCtx = { refType, refId, resolve };
    const ta = document.getElementById('progress-nextstep-input');
    ta.value = (ctx && ctx.nextStep) || '';
    document.getElementById('progress-nextstep-char-hint').textContent = `${ta.value.length} / 1.000 Zeichen`;
    document.getElementById('progress-nextstep-error').style.display = 'none';
    document.getElementById('progress-nextstep-modal').style.display = 'flex';
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);
  });
}

function closeProgressNextStepDialog(result) {
  document.getElementById('progress-nextstep-modal').style.display = 'none';
  const ctx = progressNextStepDialogCtx;
  progressNextStepDialogCtx = null;
  if (ctx && typeof ctx.resolve === 'function') ctx.resolve(result);
}

function progressNextStepOverlayClick(e) {
  if (e.target.id !== 'progress-nextstep-modal') return;
  if (document.getElementById('progress-nextstep-input').value.trim() !== '') return;
  closeProgressNextStepDialog('cancelled');
}

async function submitProgressNextStepDialog() {
  const ctx = progressNextStepDialogCtx;
  if (!ctx) return;
  const nextStep = document.getElementById('progress-nextstep-input').value;
  const errEl = document.getElementById('progress-nextstep-error');
  errEl.style.display = 'none';
  if (nextStep.length > 1000) {
    errEl.textContent = 'Der nächste Schritt darf maximal 1.000 Zeichen haben.';
    errEl.style.display = '';
    return;
  }
  setBusy('progress-nextstep-save-btn', true);
  try {
    await TSHost.api('PUT', `/api/progress/${encodeURIComponent(ctx.refType)}/${encodeURIComponent(ctx.refId)}/next-step`, { nextStep });
    closeProgressNextStepDialog('saved');
  } catch (e) {
    errEl.textContent = e.message || 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
    errEl.style.display = '';
  } finally {
    setBusy('progress-nextstep-save-btn', false);
  }
}

// ── KI-Re-Entry-Zusammenfassung für die Wiedereinstiegskarte ──
// Eigenständige Variante von runReentryFor() oben: liefert das Ergebnis als
// String zurück statt es in ein Banner zu schreiben (TSProgress rendert die
// Ausgabe selbst) — siehe Vertrag TSHost.progress.aiReentry. Nutzt bewusst
// denselben aiCall()-Helper wie runReentryFor(), keine zweite Implementierung
// des Kosten-/Bestätigungs-Handlings.
async function runProgressAiReentry(frameId) {
  const r = await aiCall('POST', `/ai/stack/${frameId}/reentry`);
  return (r && r.content && typeof r.content.summary === 'string') ? r.content.summary : '';
}

// ── Listen nach Fortschrittsänderung aktualisieren (TSHost.progress.onProgressChanged) ──
async function onProgressChangedHost(refType, refId) {
  if (window.TSProgress && typeof TSProgress.invalidate === 'function') TSProgress.invalidate(refType, refId);
  try {
    if (refType === 'todo') await loadTodos();
    else if (refType === 'topic') await loadMeetings();
  } catch (_) { /* Liste bleibt ggf. veraltet — kein Blocker, kein Datenverlust */ }
  render();
}

// ── Zwischenstand im Hintergrund speichern (Snooze-/Pop-Dialoge, Story 6) ──
// Wird NACH einem bereits erfolgreichen Snooze/Pop aufgerufen. Schlägt dieser
// zweite Request fehl, bleibt der bereits erfolgreiche Snooze/Pop unberührt —
// stattdessen erscheint ein nicht-blockierender Hinweis mit Retry-Aktion; der
// Text bleibt dafür im Funktions-Closure erhalten.
function submitProgressEntryBackground(refType, refId, bodyHtml, source) {
  if (!bodyHtml) return;
  const clientToken = makeProgressClientToken();
  function attempt() {
    TSHost.api('POST', `/api/progress/${encodeURIComponent(refType)}/${encodeURIComponent(refId)}/entries`, {
      body: bodyHtml, source, clientToken,
    }).then(() => {
      onProgressChangedHost(refType, refId);
    }).catch(() => {
      showProgressRetryToast('Zwischenstand konnte nicht gespeichert werden.', attempt);
    });
  }
  attempt();
}

function showProgressRetryToast(msg, retryFn) {
  const el = document.createElement('div');
  el.className = 'toast toast-error';
  const retryId = 'ts-progress-retry-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  el.innerHTML = `<div class="ts-progress-retry-toast"><span>${escHtml(msg)}</span>` +
    `<button type="button" id="${escHtml(retryId)}">Erneut versuchen</button></div>`;
  document.getElementById('toast-container').appendChild(el);
  const btn = document.getElementById(retryId);
  if (btn) btn.addEventListener('click', () => { el.remove(); retryFn(); });
  setTimeout(() => el.remove(), 9000);
}

// ── Fortschrittsbereich eingebettet in Todo-/Themen-Modal ──────────────
// Der Zeitstrahl und der selbstspeichernde Composer (siehe mountProgressArea
// oben) sind fest unterhalb der Beschreibung im jeweiligen Bearbeiten-Modal
// eingebettet und nur beim Bearbeiten eines bestehenden Todos/Themas
// sichtbar. Todo und Thema nutzen seit der Vereinheitlichung denselben Code
// (kein separates Slot-/Token-/Reentry-Handling pro Vorhaben-Typ mehr).

// ── End-of-Day Review & Stack History views ─────────────────
function openEodReview()   { selectView('__eod__'); }
function openStackHistory() { selectView('__stack_history__'); }

async function renderEodView(el) {
  let frames = [];
  try { const r = await api('GET', '/stack'); frames = r.frames; } catch (_) {}
  if (frames.length === 0) {
    el.innerHTML = `<div class="content-empty">
      <div class="content-empty-icon">🌙</div>
      <h2>Tagesabschluss</h2>
      <p>Kein offenes Frame — alles erledigt.</p>
    </div>`;
    return;
  }
  el.innerHTML = `
    <div class="content-header">
      <h1>🌙 Tagesabschluss <span class="badge">${frames.length}</span></h1>
      <p class="muted">Diese Frames sind noch offen. Was möchtest du mit jedem tun?</p>
    </div>
    <div style="max-width:900px; margin:0 auto">
      ${frames.map(f => `
        <div class="stack-history-row">
          <div style="flex:1; min-width:0">
            <div style="font-weight:600; margin-bottom:.25rem">${escHtml(f.title)} <span class="frame-type-pill">${f.ref_type === 'topic' ? '💬 Topic' : '✓ Todo'}</span></div>
            <div style="font-size:.8125rem; color:var(--text-muted); white-space:pre-wrap">${escHtml(f.next_step_note || '')}</div>
            <div style="font-size:.6875rem; color:var(--text-light); margin-top:.25rem">läuft seit ${fmtDurationSec(f.age_seconds)}</div>
          </div>
          <div style="display:flex; gap:.25rem; flex-direction:column">
            <button class="btn btn-primary btn-sm"   onclick="eodAction('${f.id}','tomorrow')">Morgen weitermachen</button>
            <button class="btn btn-secondary btn-sm" onclick="eodAction('${f.id}','snoozed')">Snoozen …</button>
            <button class="btn btn-danger btn-sm"    onclick="eodAction('${f.id}','dropped')">Droppen</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function eodAction(frameId, kind) {
  const f = stackState.frames.find(x => x.id === frameId) || (await api('GET', '/stack')).frames.find(x => x.id === frameId);
  if (!f) return;
  if (kind === 'tomorrow') {
    const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
    // Snooze the referenced topic/todo. Frame stays open.
    if (f.ref_type === 'topic') {
      let mid = null;
      for (const m of meetings) for (const t of (m.topics || [])) if (t.id === f.ref_id) { mid = m.id; break; }
      if (mid) await api('PUT', `/meetings/${mid}/topics/${f.ref_id}`, { snoozedUntil: d.toISOString() });
    } else {
      await api('PUT', `/todos/${f.ref_id}`, { snoozedUntil: d.toISOString() });
    }
    toast('Wird morgen 9:00 wieder aufgenommen');
  } else if (kind === 'snoozed') {
    // Pop with snoozed using a simple prompt for date
    const def = (() => { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d.toISOString().slice(0,16); })();
    const v = prompt('Aufwachen am (YYYY-MM-DDTHH:MM):', def);
    if (!v) return;
    await api('POST', `/stack/pop/${frameId}`, { resolution: 'snoozed', snoozedUntil: new Date(v).toISOString() });
    toast('Frame geschlossen & gesnoozed');
  } else if (kind === 'dropped') {
    await api('POST', `/stack/pop/${frameId}`, { resolution: 'dropped' });
    toast('Frame verworfen');
  }
  await Promise.all([loadStack(), loadMeetings(), loadTodos()]);
  render();
}

async function renderStackHistoryView(el) {
  const fromEl = document.getElementById('sh-from'), toEl = document.getElementById('sh-to'), resEl = document.getElementById('sh-res');
  const from = fromEl?.value || '', to = toEl?.value || '', res = resEl?.value || '';
  let frames = [];
  try {
    const q = [from && `from=${from}`, to && `to=${to}`, res && `resolution=${res}`].filter(Boolean).join('&');
    const r = await api('GET', '/stack/history' + (q ? '?' + q : ''));
    frames = r.frames;
  } catch (_) {}
  el.innerHTML = `
    <div class="content-header">
      <h1>📜 Stack-Historie</h1>
      <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin-top:.5rem">
        <label style="font-size:.8125rem">Von: <input type="date" class="form-control" id="sh-from" value="${from}" style="display:inline-block; width:auto"></label>
        <label style="font-size:.8125rem">Bis: <input type="date" class="form-control" id="sh-to" value="${to}" style="display:inline-block; width:auto"></label>
        <label style="font-size:.8125rem">Resolution:
          <select class="form-control" id="sh-res" style="display:inline-block; width:auto">
            <option value="">alle</option>
            <option value="done"    ${res==='done'?'selected':''}>done</option>
            <option value="snoozed" ${res==='snoozed'?'selected':''}>snoozed</option>
            <option value="dropped" ${res==='dropped'?'selected':''}>dropped</option>
          </select>
        </label>
        <button class="btn btn-secondary btn-sm" onclick="renderStackHistoryView(document.getElementById('main-content'))">Filtern</button>
      </div>
    </div>
    <div style="max-width:900px; margin:0 auto">
      ${frames.length === 0 ? '<div class="content-empty">Keine Frames im Filter.</div>' : frames.map(f => `
        <div class="stack-history-row">
          <span class="resolution-badge resolution-${f.pop_resolution}">${f.pop_resolution || '—'}</span>
          <div style="flex:1; min-width:0">
            <div style="font-weight:600">${escHtml(f.title)} <span class="frame-type-pill">${f.ref_type === 'topic' ? '💬' : '✓'}</span></div>
            <div style="font-size:.8125rem; color:var(--text-muted); white-space:pre-wrap; margin-top:.25rem">${escHtml(f.next_step_note || '')}</div>
            <div style="font-size:.6875rem; color:var(--text-light); margin-top:.25rem">
              gepusht ${fmtDateTime(f.pushed_at)} · gepoppt ${fmtDateTime(f.popped_at)}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Phase 3: Theme-Tag-Vorschläge, Drift, CMI, Digest ────────
let driftTopics = new Set();  // topic_id set, befüllt nach loadDrift()
let cmiByMeeting = {};        // meetingId → {content, artifact_id}
let dismissedThemeSuggestions = {};  // refKey → set of theme_id

function refKey(refType, refId) { return refType + ':' + refId; }

async function loadDrift() {
  driftTopics = new Set();
  if (!aiIsActive() || !aiSettings.features_enabled.drift) return;
  try {
    const r = await api('GET', '/ai/insights/drift');
    driftTopics = new Set(r.drifted.map(d => d.topic_id));
  } catch (_) { /* still */ }
}

async function suggestThemesFor(refType, refId) {
  if (!aiIsActive() || !aiSettings.features_enabled.theme_tagging) return null;
  try {
    return await aiCall('POST', `/ai/${refType}/${refId}/suggest-themes`);
  } catch (e) {
    if (e.cancelled) return null;
    return null;
  }
}

function renderThemeSuggestionsContainer(refType, refId, suggestions, container) {
  if (!suggestions || !suggestions.length) { container.innerHTML = ''; return; }
  const key = refKey(refType, refId);
  const dismissed = dismissedThemeSuggestions[key] || new Set();
  const filtered  = suggestions.filter(s => !dismissed.has(s.theme_id));
  if (!filtered.length) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="theme-suggest-row">
      <span class="label"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 2l.75 2.25L22 5l-2.25.75L19 8l-.75-2.25L16 5l2.25-.75z"/></svg> Vorschläge:</span>
      ${filtered.map(s => `
        <span class="theme-suggest-pill" data-theme-id="${s.theme_id}">
          🏷️ ${escHtml(s.theme_title)}
          <span class="confidence">${Math.round(s.confidence * 100)}%</span>
          <button class="dismiss" onclick="dismissThemeSuggestion(event,'${refType}','${refId}','${s.theme_id}')" title="Verwerfen">×</button>
        </span>`).join('')}
    </div>`;
  container.querySelectorAll('.theme-suggest-pill').forEach(pill => {
    pill.addEventListener('click', async (e) => {
      if (e.target.classList.contains('dismiss')) return;
      const themeId = pill.dataset.themeId;
      try {
        await api('POST', `/themes/${themeId}/links`, { refType, refId });
        toast('Topic verknüpft');
        const dset = dismissedThemeSuggestions[key] || new Set();
        dset.add(themeId);
        dismissedThemeSuggestions[key] = dset;
        await loadThemes(); render();
      } catch (e) { toast(e.message || 'Fehler', 'error'); }
    });
  });
}

function dismissThemeSuggestion(e, refType, refId, themeId) {
  e.stopPropagation();
  const key = refKey(refType, refId);
  const set = dismissedThemeSuggestions[key] || new Set();
  set.add(themeId);
  dismissedThemeSuggestions[key] = set;
  // Re-render only the affected container if visible
  const c = document.getElementById(`theme-suggest-${refType}-${refId}`);
  if (c) {
    const pill = c.querySelector(`[data-theme-id="${themeId}"]`);
    if (pill) pill.remove();
    if (!c.querySelector('.theme-suggest-pill')) c.innerHTML = '';
  }
}

// Wird nach saveTopicModal / saveTodoModal aufgerufen
async function triggerThemeSuggestions(refType, refId) {
  if (!aiIsActive() || !aiSettings.features_enabled.theme_tagging) return;
  const r = await suggestThemesFor(refType, refId);
  if (!r || !r.suggestions || !r.suggestions.length) return;
  // Stash in a small registry so the renderer can read them
  themeSuggestionsCache[refKey(refType, refId)] = r.suggestions;
  render();
}
const themeSuggestionsCache = {};

async function loadCmiFor(meetingId) {
  if (!aiIsActive() || !aiSettings.features_enabled.cross_meeting) { cmiByMeeting[meetingId] = null; return; }
  try {
    const r = await api('GET', `/ai/insights/cross-meeting/${meetingId}`);
    cmiByMeeting[meetingId] = (r && r.content && r.content.matches.length) ? r : null;
  } catch { cmiByMeeting[meetingId] = null; }
}

async function recomputeCmiFor(meetingId) {
  try {
    toast('Berechne Ähnlichkeiten …');
    const r = await aiCall('POST', `/ai/insights/cross-meeting/${meetingId}`);
    cmiByMeeting[meetingId] = (r && r.content && r.content.matches.length) ? r : null;
    toast(r.content.matches.length ? `${r.content.matches.length} Treffer` : 'Keine Treffer');
    render();
  } catch (e) {
    if (!e.cancelled) toast(e.message || 'Fehler', 'error');
  }
}

async function dismissCmi(meetingId) {
  const c = cmiByMeeting[meetingId];
  if (!c || !c.artifact_id) return;
  try {
    await api('DELETE', `/ai/insights/cross-meeting/${meetingId}/${c.artifact_id}`);
    cmiByMeeting[meetingId] = null;
    render();
  } catch (e) { toast(e.message || 'Fehler', 'error'); }
}

function renderCmiBanner(meetingId) {
  const c = cmiByMeeting[meetingId];
  if (!c || !c.content || !c.content.matches.length) return '';
  const matches = c.content.matches;
  const expanded = cmiExpanded[meetingId] || false;
  return `
    <div class="cmi-banner ai-action">
      <span style="font-size:1rem">🔗</span>
      <span class="cmi-banner-title">${matches.length} ähnliche Thema(s) in anderen Meetings</span>
      <div class="cmi-banner-actions">
        <button class="btn btn-secondary" onclick="toggleCmiExpand('${meetingId}')">${expanded ? 'Einklappen' : 'Details'}</button>
        <button class="btn btn-secondary" onclick="recomputeCmiFor('${meetingId}')">Neu berechnen</button>
        <button class="btn btn-ghost" onclick="dismissCmi('${meetingId}')">Verwerfen</button>
      </div>
      ${expanded ? `
        <div class="cmi-details">
          ${matches.map(m => `
            <div class="cmi-detail-row">
              <div class="titles">
                ${escHtml(m.this_topic_title)}<span class="arrow">↔</span>${escHtml(m.other_topic_title)}
                <span class="conf">${Math.round(m.confidence*100)}%</span>
              </div>
              <div class="reason">${escHtml(m.reason || '')} <em style="color:var(--text-light)">— in Meeting: ${escHtml(m.other_meeting)}</em></div>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}
const cmiExpanded = {};
function toggleCmiExpand(meetingId) { cmiExpanded[meetingId] = !cmiExpanded[meetingId]; render(); }

// ── Wochen-Digest View ───────────────────────────────────────
let digestState = { current: null, archive: [], loading: false };

async function loadDigestCurrent() {
  try { digestState.current = await api('GET', '/ai/digest/weekly'); }
  catch { digestState.current = null; }
}
async function loadDigestArchive() {
  try { const r = await api('GET', '/ai/digest/archive'); digestState.archive = r.entries || []; }
  catch { digestState.archive = []; }
}

async function renderDigestView(el) {
  el.innerHTML = `<div class="content-empty"><div class="ai-spinner"></div><p style="margin-top:.5rem">lade …</p></div>`;
  await Promise.all([loadDigestCurrent(), loadDigestArchive()]);
  const d = digestState.current;
  const archive = digestState.archive || [];
  el.innerHTML = `
    <div class="content-header">
      <h1>📊 Wochen-Digest</h1>
      <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin-top:.5rem">
        <button class="btn btn-ai ai-action" onclick="regenerateDigest()"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 2l.75 2.25L22 5l-2.25.75L19 8l-.75-2.25L16 5l2.25-.75z"/></svg> Neu erzeugen</button>
        ${archive.length > 1 ? `
          <select class="form-control" id="digest-pick" style="display:inline-block; width:auto" onchange="pickDigest(this.value)">
            ${archive.map(a => `<option value="${a.artifact_id}" ${d && d.artifact_id === a.artifact_id ? 'selected' : ''}>${a.week} — ${fmtDateOnly(a.created_at)}</option>`).join('')}
          </select>` : ''}
      </div>
    </div>
    <div style="max-width:900px; margin:0 auto">
      ${!d || !d.content ? `
        <div class="content-empty">
          <p>Noch kein Digest für diese Woche.</p>
          <button class="btn btn-ai ai-action" onclick="regenerateDigest()"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.15em"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 2l.75 2.25L22 5l-2.25.75L19 8l-.75-2.25L16 5l2.25-.75z"/></svg> Jetzt erzeugen</button>
        </div>` : `
        <div class="digest-section">
          <h3>Woche ${escHtml(d.week)}</h3>
          <div class="digest-summary">${escHtml(d.content.summary || '')}</div>
        </div>
        ${Array.isArray(d.content.highlights) && d.content.highlights.length ? `
          <div class="digest-section">
            <h3>Highlights</h3>
            <ul class="digest-bullets">${d.content.highlights.map(h => `<li>${escHtml(h)}</li>`).join('')}</ul>
          </div>` : ''}
        ${Array.isArray(d.content.focus_next) && d.content.focus_next.length ? `
          <div class="digest-section">
            <h3>Fokus für die kommende Woche</h3>
            <ul class="digest-bullets">${d.content.focus_next.map(h => `<li>${escHtml(h)}</li>`).join('')}</ul>
          </div>` : ''}
      `}
    </div>
  `;
}

async function regenerateDigest() {
  try {
    toast('Erzeuge Digest …');
    digestState.current = await aiCall('POST', '/ai/digest/weekly');
    await loadDigestArchive();
    if (selectedId === '__digest__') render();
    toast('Digest fertig');
  } catch (e) { if (!e.cancelled) toast(e.message || 'Fehler', 'error'); }
}
function pickDigest(artifactId) {
  const a = (digestState.archive || []).find(x => x.artifact_id === artifactId);
  if (a) { digestState.current = { artifact_id: a.artifact_id, content: a.content, week: a.week, cached: true }; render(); }
}

// ── Sichtbarer Fortschritt (Arbeitspaket M4) ─────────────────
// Fachlogik/Rendering lebt vollständig in public/momentum.js (Arbeitspaket
// M3, window.TSMomentum.mount) - diese Funktion übernimmt ausschließlich das
// Einhängen in den bestehenden view-Container, analog zu window.TSGraph.mount
// oben in renderMain().
let momentumMounted = null;
function renderMomentumView(el) {
  el.innerHTML = `<div class="content-header"><h1>📈 Fortschritt</h1></div><div id="momentum-root"></div>`;
  const root = document.getElementById('momentum-root');
  if (!window.TSMomentum) {
    root.innerHTML = `<div class="content-empty"><p>Fortschritt-Modul konnte nicht geladen werden.</p></div>`;
    return;
  }
  momentumMounted?.destroy?.();
  momentumMounted = window.TSMomentum.mount(root);
}

// ── Archiv: "Meetings archivieren statt löschen" (Arbeitspaket W1) ──────
// Server-Grundlage (bereits gemergt): lib/archive/*, Server-Integration in
// server.js (Pakete B1-B3). Diese Sektion implementiert ausschließlich den
// Web-Client (index.html) gegen den dort festgelegten Schnittstellenvertrag.
//
// ---- ARCHIVE_PURE_HELPERS_START -----------------------------------------
// Reine, DOM-/Netzwerk-freie Formatierungsfunktionen. Werden von
// test/archive_web_helpers.test.js per Regex aus dieser Datei extrahiert und
// in einer Sandbox ausgeführt (index.html ist kein eigenständiges CommonJS-
// Modul wie public/progress.js). Diese Funktionen dürfen daher AUSSCHLIESSLICH
// mit ihren Argumenten arbeiten — keine Referenzen auf window/document/fetch/
// beliebige äußere Variablen dieser Datei.

// Chip-Text einer Archiv-Karte: "{N} Themen · {N} erledigt".
function archiveTopicChipText(topicCount, openTopicCount) {
  const total = Number.isFinite(topicCount) ? Math.max(0, topicCount) : 0;
  const open  = Number.isFinite(openTopicCount) ? Math.max(0, Math.min(openTopicCount, total)) : 0;
  const done  = total - open;
  return `${total} Themen · ${done} erledigt`;
}

// Text des Archiv-Badges (Icon + Text, niemals nur Farbe). `dateLabel` ist
// bereits fertig formatiert (siehe fmtDateOnly) — diese Funktion fügt nur
// Icon/Label zusammen und bleibt damit unabhängig von Locale-/Datumslogik.
function archiveBadgeText(dateLabel) {
  const label = (typeof dateLabel === 'string' && dateLabel.trim()) ? dateLabel.trim() : '—';
  return `🗃 Archiviert am ${label}`;
}

// Zahlen-Text für den "Endgültig löschen"-Dialog aus dem preflight-`impact`.
function archiveImpactText(impact) {
  const i = impact || {};
  const num = (v) => Number.isFinite(v) ? Math.max(0, v) : 0;
  const topics    = num(i.topics);
  const entries   = num(i.progressEntries);
  const files     = num(i.attachments);
  const parts = [
    topics  === 1 ? '1 Thema'                : `${topics} Themen`,
    entries === 1 ? '1 Fortschrittseintrag'  : `${entries} Fortschrittseinträge`,
    files   === 1 ? '1 Anhang'               : `${files} Anhänge`,
  ];
  return parts.join(', ');
}

// Kommagetrennte Themen-Titel aus conflicts.openFrames für die Stack-
// Konflikt-Warnung. Ungültige/fehlende Einträge werden defensiv übersprungen.
function archiveStackConflictText(openFrames) {
  const list = Array.isArray(openFrames) ? openFrames : [];
  return list
    .map(f => (f && typeof f.topicTitle === 'string') ? f.topicTitle.trim() : '')
    .filter(Boolean)
    .join(', ');
}
// ---- ARCHIVE_PURE_HELPERS_END -------------------------------------------

if (typeof window !== 'undefined') {
  window.TSArchive = { archiveTopicChipText, archiveBadgeText, archiveImpactText, archiveStackConflictText };
}

// ---- State ----------------------------------------------------------------
let archiveState = { items: [], total: 0, q: '', offset: 0, loaded: false, loading: false, error: null };
const ARCHIVE_PAGE_SIZE = 50;
let _archiveSearchTimer = null;

let archiveDetailState = { id: null, data: null, loading: false, error: null };
const archiveDetailTimelineHandles = {}; // topicId -> Handle von TSProgress.mountTimeline
let archiveDetailMountedForId = null;    // verhindert Remount bei jedem renderMain() (z. B. Themen-Suche)

function destroyArchiveDetailTimelines() {
  Object.keys(archiveDetailTimelineHandles).forEach(k => {
    try { archiveDetailTimelineHandles[k].destroy(); } catch (_) { /* best effort */ }
    delete archiveDetailTimelineHandles[k];
  });
}

// ---- Archiv-Liste -----------------------------------------------------

async function loadArchiveList(reset) {
  if (reset) { archiveState.offset = 0; archiveState.items = []; }
  archiveState.loading = true;
  archiveState.error = null;
  if (selectedId === '__archive__') render();
  try {
    const qParam = archiveState.q ? `&q=${encodeURIComponent(archiveState.q)}` : '';
    const r = await api('GET', `/archive/meetings?limit=${ARCHIVE_PAGE_SIZE}&offset=${archiveState.offset}${qParam}`);
    archiveState.items = Array.isArray(r.items) ? r.items : [];
    archiveState.total = Number.isFinite(r.total) ? r.total : archiveState.items.length;
    archiveState.loaded = true;
  } catch (e) {
    archiveState.error = 'Archiv konnte nicht geladen werden.';
  } finally {
    archiveState.loading = false;
    if (selectedId === '__archive__') render();
  }
}

function onArchiveSearch(val) {
  archiveState.q = val;
  clearTimeout(_archiveSearchTimer);
  _archiveSearchTimer = setTimeout(() => loadArchiveList(true), 200);
}

function renderArchiveView(el) {
  if (!archiveState.loaded && !archiveState.loading && !archiveState.error) loadArchiveList(true);
  el.innerHTML = `
    <div class="full-width-view">
      <div class="meeting-header">
        <div class="meeting-header-accent" style="background:var(--primary)"></div>
        <div class="meeting-header-body">
          <div class="meeting-header-info">
            <h1 class="meeting-title">Archiv</h1>
            <p class="meeting-description" style="color:var(--text-muted)">Archivierte Meetings</p>
          </div>
        </div>
      </div>
      <div class="topics-section">
        <div class="topics-header">
          <div class="topics-header-left"><h2>Meetings</h2>
            <span class="topic-count-badge">${archiveState.total}</span>
          </div>
          <input type="search" class="topic-search" id="archive-search-input"
            aria-label="Archiv nach Titel durchsuchen" placeholder="Suchen …"
            value="${escHtml(archiveState.q)}" oninput="onArchiveSearch(this.value)">
        </div>
        ${renderArchiveListBody()}
      </div>
    </div>`;
}

function renderArchiveListBody() {
  if (archiveState.loading && !archiveState.loaded) {
    return `<div class="empty-topics"><span class="ai-spinner"></span></div>`;
  }
  if (archiveState.error) {
    return `<div class="empty-topics">
      🗃 ${escHtml(archiveState.error)}
      <div style="margin-top:.75rem"><button class="btn btn-secondary btn-sm" onclick="loadArchiveList(true)">Erneut versuchen</button></div>
    </div>`;
  }
  if (archiveState.items.length === 0) {
    return archiveState.q
      ? `<div class="empty-topics">Keine Treffer im Archiv.</div>`
      : `<div class="empty-topics">
          <div style="font-size:1.75rem;margin-bottom:.5rem">🗃</div>
          Noch keine archivierten Meetings.<br>
          <span style="font-size:.8125rem;color:var(--text-light)">Archivierte Meetings landen hier — du kannst sie jederzeit wiederherstellen oder endgültig löschen.</span>
        </div>`;
  }
  return archiveState.items.map(m => renderArchiveCard(m)).join('');
}

function renderArchiveCard(m) {
  return `
    <div class="topic-card archive-card">
      <button type="button" class="archive-card-body" onclick="selectArchiveDetail('${m.id}')">
        <span class="meeting-color-dot" style="background:${m.color||'#1D6FE8'}"></span>
        <span class="archive-card-main">
          <span class="archive-card-title">${escHtml(m.title)}</span>
          <span class="archive-card-meta">
            <span class="pill pill-open">${escHtml(archiveTopicChipText(m.topicCount, m.openTopicCount))}</span>
            <span class="archive-badge">${escHtml(archiveBadgeText(fmtDateOnly(m.archivedAt)))}</span>
          </span>
        </span>
      </button>
      <div class="archive-card-actions">
        <button class="btn btn-secondary btn-sm" onclick="restoreArchivedMeeting('${m.id}', false)">↺ Wiederherstellen</button>
        <details class="topic-overflow" onclick="event.stopPropagation()">
          <summary class="btn btn-secondary btn-sm btn-icon" title="Weitere Aktionen">⋯</summary>
          <div class="topic-overflow-menu">
            <button class="danger" onclick="closeAllOverflow(); confirmPermanentlyDeleteMeeting('${m.id}','${escJsAttr(m.title)}', false)">
              <span class="icon">🗑️</span><span>Endgültig löschen</span>
            </button>
          </div>
        </details>
      </div>
    </div>`;
}

// ---- Archiv-Detail (Nur-Lesen) ------------------------------------------

async function selectArchiveDetail(id) {
  archiveDetailState = { id, data: null, loading: true, error: null };
  selectedId = '__archive_detail__';
  topicFilter = '';
  closeMobileSidebar();
  updateTopbar('Archiv');
  render();
  try {
    const m = await api('GET', `/archive/meetings/${id}`);
    if (archiveDetailState.id !== id) return; // zwischenzeitlich weiternavigiert
    archiveDetailState.data = m;
  } catch (e) {
    if (archiveDetailState.id !== id) return;
    archiveDetailState.error = 'Archiv konnte nicht geladen werden.';
  } finally {
    if (archiveDetailState.id === id) archiveDetailState.loading = false;
    if (selectedId === '__archive_detail__') render();
  }
}

function renderArchiveDetailView(el) {
  const st = archiveDetailState;
  if (st.loading && !st.data) {
    el.innerHTML = `<div class="full-width-view"><div class="empty-topics"><span class="ai-spinner"></span></div></div>`;
    return;
  }
  if (st.error) {
    el.innerHTML = `<div class="full-width-view"><div class="empty-topics">
      🗃 ${escHtml(st.error)}
      <div style="margin-top:.75rem"><button class="btn btn-secondary btn-sm" onclick="selectArchiveDetail('${st.id}')">Erneut versuchen</button></div>
    </div></div>`;
    return;
  }
  if (!st.data) { el.innerHTML = ''; return; }
  el.innerHTML = renderMeetingDetailHtml(st.data, { readOnly: true });
  mountArchiveDetailExtras(st.data);
}

// Bindet Anhänge (Downloads) und Fortschrittsverlauf (falls vorhanden) in die
// bereits gerenderten Themenkarten ein — Wiederverwendung der bestehenden
// Mechanismen (loadAttachments/attachSectionHtml mit readOnly=true,
// TSProgress.mountTimeline ohne composerSlot/reentrySlot). Läuft nur einmal
// pro geladenem Meeting (siehe archiveDetailMountedForId), damit z. B. die
// Themen-Suche im readOnly-Modus nicht bei jedem Tastendruck neu mountet.
function mountArchiveDetailExtras(m) {
  if (archiveDetailMountedForId === m.id) return;
  destroyArchiveDetailTimelines();
  archiveDetailMountedForId = m.id;
  (m.topics || []).forEach(t => {
    loadAttachments('topic', t.id, true);
    if (t.progress && t.progress.entryCount > 0 && window.TSProgress) {
      const mountEl = document.getElementById(`ro-progress-topic-${t.id}`);
      if (mountEl) archiveDetailTimelineHandles[t.id] = TSProgress.mountTimeline(mountEl, { refType: 'topic', refId: t.id });
    }
  });
}

// ---- Aktionen: Archivieren / Wiederherstellen / Endgültig löschen -------

async function confirmArchiveMeeting(id) {
  const m = getMeeting(id);
  if (!m) return;
  const ok = await genericConfirm(
    'Meeting archivieren?',
    `„${m.title}" wird archiviert und ist danach im Archiv-Bereich zu finden. Alle Themen, Ergebnisse und Anhänge bleiben erhalten.`,
    'Archivieren', 'Abbrechen'
  );
  if (!ok) return;
  await runArchiveMeeting(id);
}

async function confirmArchiveStackConflict(conflicts) {
  const openFrames = (conflicts && Array.isArray(conflicts.openFrames)) ? conflicts.openFrames : [];
  const names = archiveStackConflictText(openFrames);
  return genericConfirm(
    'Offenes Stack-Frame im Meeting',
    `${names ? `Betroffene Themen: „${names}". ` : ''}Das offene Stack-Frame wird beim Archivieren NICHT automatisch geschlossen.`,
    'Trotzdem archivieren', 'Abbrechen'
  );
}

async function runArchiveMeeting(id, acknowledgeStackConflict) {
  let res;
  try {
    res = await api('POST', `/archive/meeting/${id}`, acknowledgeStackConflict ? { acknowledgeStackConflict: true } : {});
  } catch (e) {
    if (e.status === 409 && e.body && e.body.code === 'ARCHIVE_STACK_CONFLICT') {
      const proceed = await confirmArchiveStackConflict(e.body.conflicts);
      if (proceed) await runArchiveMeeting(id, true);
      return;
    }
    toast('Meeting konnte nicht archiviert werden. Bitte versuche es erneut.', 'error');
    return;
  }
  meetings = meetings.filter(x => x.id !== id);
  if (selectedId === id) selectedId = null;
  archiveState.loaded = false; // nächster Archiv-Besuch lädt frische Liste
  render();
  toast('Meeting archiviert — im Archiv wiederzufinden.');
  document.querySelector('.sidebar-new-btn')?.focus?.();
}

async function restoreArchivedMeeting(id, fromDetail) {
  try {
    await api('DELETE', `/archive/meeting/${id}`);
  } catch (e) {
    toast('Meeting konnte nicht wiederhergestellt werden. Bitte versuche es erneut.', 'error');
    return;
  }
  archiveState.items = archiveState.items.filter(x => x.id !== id);
  archiveState.total = Math.max(0, archiveState.total - 1);
  if (_archiveSearchDetailCache[id]) delete _archiveSearchDetailCache[id];
  await loadMeetings();
  // Aus der Nur-Lese-Detailansicht führt Wiederherstellen direkt in die
  // jetzt wieder normal bearbeitbare Meeting-Ansicht (nicht zurück ins
  // Archiv) — aus der Archiv-Liste bleibt man in der Liste.
  if (fromDetail) { selectMeeting(id); }
  else { render(); }
  toast('Meeting wiederhergestellt.');
}

async function confirmPermanentlyDeleteMeeting(id, title, fromDetail) {
  let preflight;
  try {
    preflight = await api('GET', `/archive/meeting/${id}/preflight`);
  } catch (e) {
    toast('Löschumfang konnte nicht ermittelt werden. Bitte versuche es erneut.', 'error');
    return;
  }
  const ok = await genericConfirm(
    'Meeting endgültig löschen?',
    `„${title}" wird unwiderruflich gelöscht: ${archiveImpactText(preflight.impact)}.`,
    'Endgültig löschen', 'Abbrechen',
    { danger: true, focus: 'cancel' }
  );
  if (!ok) return;
  try {
    await api('DELETE', `/archive/meeting/${id}/permanent`);
  } catch (e) {
    toast('Meeting konnte nicht endgültig gelöscht werden. Bitte versuche es erneut.', 'error');
    return;
  }
  archiveState.items = archiveState.items.filter(x => x.id !== id);
  archiveState.total = Math.max(0, archiveState.total - 1);
  if (_archiveSearchDetailCache[id]) delete _archiveSearchDetailCache[id];
  if (fromDetail) { selectView('__archive__'); }
  else { render(); }
  toast(`„${title}" endgültig gelöscht.`);
}

// ── Keyboard shortcut matcher ────────────────────────────────
function eventMatchesShortcut(e, combo) {
  const parts = combo.toLowerCase().split('+').map(s => s.trim());
  const need = { mod: false, ctrl: false, shift: false, alt: false, key: '' };
  for (const p of parts) {
    if (p === 'mod')   need.mod = true;
    else if (p === 'ctrl')  need.ctrl = true;
    else if (p === 'shift') need.shift = true;
    else if (p === 'alt' || p === 'option') need.alt = true;
    else need.key = p;
  }
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  if (need.mod && !modPressed) return false;
  if (need.ctrl && !e.ctrlKey) return false;
  if (need.shift !== e.shiftKey) return false;
  if (need.alt !== e.altKey) return false;
  return e.key.toLowerCase() === need.key;
}

// ── Keyboard ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // ⌘K / Ctrl+K → Suche öffnen
  if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (document.getElementById('search-overlay').classList.contains('open')) closeSearch();
    else openSearch();
    return;
  }
  if (e.key === 'Escape') {
    // Sicherheitsfix (Security Review, Mittel, Fund 3): #confirm-dialog ist
    // ein global geteilter Dialog, den u. a. genericConfirm() nutzt (z. B. der
    // Composer-Datenverlustschutz beim Schließen von Todo-/Topic-Modal, siehe
    // closeTodoModal()/requestCloseTopicModal()). Ist er gerade
    // sichtbar, schließt Escape NUR ihn — über denselben Pfad wie ein Klick
    // auf "Abbrechen" (inkl. Promise-Resolve + Label-/Klassen-Cleanup über
    // closeConfirm(), siehe genericConfirm()) — und bricht danach sofort ab.
    // Andernfalls würde ein im selben Tastendruck weiter unten zusätzlich
    // aufgerufenes closeTodoModal()/requestCloseTopicModal() (das bei
    // ungesichertem Composer-Text seinerseits den Dialog erst öffnet) durch
    // das anschließende blinde closeConfirm() sofort wieder zugeklappt werden,
    // ohne dass Labels/Klasse zurückgesetzt oder die Promise aufgelöst wird.
    const confirmDialogEl = document.getElementById('confirm-dialog');
    if (confirmDialogEl && confirmDialogEl.style.display !== 'none') {
      const actions = confirmDialogEl.querySelector('.confirm-actions');
      const cancelBtn = actions && actions.children[0];
      if (cancelBtn && typeof cancelBtn.onclick === 'function') cancelBtn.onclick();
      else closeConfirm();
      return;
    }
    if (document.getElementById('search-overlay').classList.contains('open')) { closeSearch(); return; }
    closeMobileSidebar();
    closeHelp();
    // todo-modal/topic-modal nehmen an der Verwerfen-Rückfrage teil
    // (ungespeicherte Änderungen) und werden daher NICHT blind ausgeblendet,
    // sondern über die Request-Funktionen geschlossen (Datenverlustschutz
    // für den Fortschritts-Composer). progress-entry-modal wird separat mit
    // 'cancelled' geschlossen (siehe unten).
    // theme-link-modal/contact-modal (Arbeitspaket W2) sind NICHT Teil des
    // blinden Bulk-Hides — sie nehmen wie todo-modal/topic-modal an einem
    // eigenen Schließ-Pfad teil: theme-link-modal muss `onClosed()`
    // zuverlässig auslösen (siehe openThemeLinkModal), contact-modal muss
    // die gemountete TSContacts-Detailansicht destroy()en.
    ['meeting-modal','complete-modal','pw-modal','admin-modal','edit-user-modal','share-modal','theme-edit-modal','theme-delete-modal','theme-move-modal','knowledge-modal','move-modal','ai-settings-modal','ai-brief-modal','ai-capture-modal','stack-push-modal','stack-pop-modal','pop-drift-modal','stack-note-modal','frame-detail-modal','quick-push-modal','knowledge-quick-modal','export-modal']
      .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    if (document.getElementById('todo-modal').style.display !== 'none') closeTodoModal();
    if (document.getElementById('topic-modal').style.display !== 'none') requestCloseTopicModal();
    if (document.getElementById('theme-link-modal').style.display !== 'none') closeThemeLinkModal();
    if (document.getElementById('contact-modal').style.display !== 'none') closeContactModal();
    if (document.getElementById('backup-modal').style.display !== 'none') closeBackupPanel();
    if (document.getElementById('rt-link-modal').style.display !== 'none') closeLinkModal();
    if (document.getElementById('progress-entry-modal').style.display !== 'none') closeProgressEntryDialog('cancelled');
    return;
  }
  // '?' öffnet Hilfe (nur wenn kein Eingabefeld fokussiert)
  if (e.key === '?' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    e.preventDefault();
    openHelp();
    return;
  }
  if (!currentUser) return;
  const sc = getShortcuts();
  if (eventMatchesShortcut(e, sc.push)) {
    e.preventDefault();
    openStackPushModal(null, null);
    return;
  }
  if (eventMatchesShortcut(e, sc.pop)) {
    e.preventDefault();
    const top = stackState.frames[0];
    if (top) openStackPopModalFor(top.id);
    else toast('Stack ist leer', 'error');
    return;
  }
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey &&
      !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) &&
      !document.activeElement?.isContentEditable) {
    e.preventDefault();
    openQuickKnowledge();
    return;
  }
});
document.getElementById('login-pw').addEventListener('keydown',   e => { if (e.key==='Enter') doLogin(); });
document.getElementById('login-user').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('login-pw').focus(); });

// ── Init ─────────────────────────────────────────────────────
// todo-progress-note/t-progress-note entfallen (der Fortschritts-Composer
// in beiden Bearbeiten-Modalen ist TSProgress.mountInlineComposer, ein
// einfaches <textarea> ohne eigenes rt-content-Feld, siehe mountProgressArea).
// pop-progress-note (Pop-Dialog) ist davon unberührt.
['m-desc','t-desc','t-result','c-result','todo-desc','todo-result','pop-result',
  'progress-entry-body','pop-progress-note']
  .forEach(id => initRtToolbar(id+'-tb', id));
initRtToolbar('knowledge-content-tb', 'knowledge-content', { imageButton: true });
initRtToolbar('kq-content-tb', 'kq-content', { imageButton: true });

(async () => {
  try {
    currentUser = await api('GET', '/me');
    await Promise.all([loadMeetings(), loadTodos(), loadThemes(), loadContacts(), loadKnowledgePages(), loadAiSettings(), loadStack()]);
    await loadDrift();
    showApp(); render();
    loadMomentumBadge().then(render);
    startSnoozeWakeupsPolling();
  } catch { showLogin(); }
})();

// ── Globale Volltext-Suche ────────────────────────────────────
let _searchFocusIdx = -1;
let _searchItems    = [];   // flache Liste aller Treffer für Tastatur-Nav
let _searchTimer    = null;

function openSearch() {
  document.getElementById('search-overlay').classList.add('open');
  const f = document.getElementById('search-field');
  f.value = '';
  _renderSearchEmpty();
  requestAnimationFrame(() => f.focus());
}
function closeSearch() {
  document.getElementById('search-overlay').classList.remove('open');
  _searchFocusIdx = -1;
  _searchItems    = [];
}

// ── Query-Parser ─────────────────────────────────────────────
function _parseSearchQuery(raw) {
  const tokens = [];
  // Gänsefüßchen-Phrasen zuerst
  const phraseRe = /"([^"]+)"/g;
  let m;
  let cleaned = raw;
  while ((m = phraseRe.exec(raw)) !== null) {
    const negate = cleaned[cleaned.indexOf(m[0]) - 1] === '-';
    tokens.push({ text: m[1].toLowerCase(), negate, phrase: true });
    cleaned = cleaned.replace((negate ? '-' : '') + m[0], '');
  }
  // Einzelne Wörter
  cleaned.trim().split(/\s+/).filter(Boolean).forEach(w => {
    const negate = w.startsWith('-');
    const text = (negate ? w.slice(1) : w).toLowerCase();
    if (text) tokens.push({ text, negate, phrase: false });
  });
  return tokens;
}

// ── Snippet + Highlight ──────────────────────────────────────
function _snippet(text, tokens) {
  const plain = stripHtmlForSearch(text || '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const term = tokens.find(t => !t.negate)?.text || '';
  if (!term) return plain.slice(0, 100);
  const idx = plain.toLowerCase().indexOf(term);
  if (idx === -1) return plain.slice(0, 100);
  const s = Math.max(0, idx - 35);
  const e = Math.min(plain.length, idx + term.length + 65);
  return (s > 0 ? '…' : '') + plain.slice(s, e) + (e < plain.length ? '…' : '');
}

function _hl(text, tokens) {
  if (!text) return '';
  let out = escHtml(text);
  tokens.filter(t => !t.negate).forEach(t => {
    const re = new RegExp('(' + t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}

// ── Search-Logik ─────────────────────────────────────────────
// Zählt bei jedem Aufruf hoch, damit eine spät eintreffende Antwort einer
// überholten Anfrage das Ergebnis einer neueren nicht mehr überschreiben kann.
let _searchRequestSeq = 0;

// Cache für archivierte Meeting-Details, die für Suchtreffer nachgeladen
// werden müssen (GET /api/meetings enthält seit dem Archiv-Feature keine
// archivierten Meetings mehr — Treffer mit archived:true sind daher NICHT
// im lokalen `meetings`-Array auffindbar, siehe Schnittstellenvertrag).
const _archiveSearchDetailCache = {}; // meetingId -> Ergebnis von GET /api/archive/meetings/:id
async function _fetchArchivedMeetingForSearch(id) {
  if (_archiveSearchDetailCache[id]) return _archiveSearchDetailCache[id];
  try {
    const m = await api('GET', `/archive/meetings/${id}`);
    _archiveSearchDetailCache[id] = m;
    return m;
  } catch { return null; }
}

async function _runSearch(raw) {
  const tokens = _parseSearchQuery(raw);
  if (!tokens.length) { _renderSearchEmpty(); return; }

  const seq = ++_searchRequestSeq;
  let hits;
  try { hits = await api('GET', `/search?q=${encodeURIComponent(raw)}`); }
  catch { hits = []; }
  if (seq !== _searchRequestSeq) return; // veraltete Antwort verwerfen

  const byType = {};
  const pendingArchived = [];
  for (const h of hits) {
    if (h.type === 'meeting') {
      const m = meetings.find(x => x.id === h.id);
      if (m) (byType.meeting ??= []).push(m);
      else if (h.archived) pendingArchived.push(h);
    } else if (h.type === 'topic') {
      let found = false;
      for (const m of meetings) {
        const t = (m.topics || []).find(x => x.id === h.id);
        if (t) { (byType.topic ??= []).push({ topic: t, meeting: m }); found = true; break; }
      }
      if (!found && h.archived && h.meetingId) pendingArchived.push(h);
    } else if (h.type === 'todo') {
      const t = todos.find(x => x.id === h.id);
      if (t) (byType.todo ??= []).push(t);
    } else if (h.type === 'theme') {
      const th = themeById(h.id);
      if (th) (byType.theme ??= []).push(th);
    } else if (h.type === 'knowledge') {
      const k = knowledgePages.find(x => x.id === h.id);
      if (k) (byType.knowledge ??= []).push(k);
    } else if (h.type === 'contact') {
      const c = contacts.find(x => x.id === h.id);
      if (c) (byType.contact ??= []).push(c);
    }
  }

  // Archivierte Treffer werden laut Vertrag NICHT gefiltert — daher hier per
  // GET /api/archive/meetings/:id nachladen (dedupliziert je Meeting-Id).
  if (pendingArchived.length) {
    const meetingIds = [...new Set(pendingArchived.map(h => h.type === 'meeting' ? h.id : h.meetingId).filter(Boolean))];
    const details = await Promise.all(meetingIds.map(id => _fetchArchivedMeetingForSearch(id)));
    if (seq !== _searchRequestSeq) return; // veraltete Antwort verwerfen
    const detailMap = new Map(meetingIds.map((id, i) => [id, details[i]]));
    for (const h of pendingArchived) {
      if (h.type === 'meeting') {
        const m = detailMap.get(h.id);
        if (m) (byType.meeting ??= []).push(m);
      } else {
        const m = detailMap.get(h.meetingId);
        const t = m && (m.topics || []).find(x => x.id === h.id);
        if (t) (byType.topic ??= []).push({ topic: t, meeting: m });
      }
    }
  }

  const GROUP_DEFS = [
    { key: 'meeting',   label: 'Meetings' },
    { key: 'topic',     label: 'Themen' },
    { key: 'todo',      label: 'Todos' },
    { key: 'theme',     label: 'Topics' },
    { key: 'knowledge', label: 'Wissen' },
    { key: 'contact',   label: 'Kontakte' },
  ];
  const groups = GROUP_DEFS
    .filter(g => byType[g.key]?.length)
    .map(g => ({ label: g.label, type: g.key, items: byType[g.key] }));

  _renderSearchResults(groups, tokens);
}

// ── Render ───────────────────────────────────────────────────
const _SEARCH_ICONS = {
  meeting: { bg:'#EFF6FF', stroke:'#1D6FE8',
    svg:'<path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5"/>' },
  topic:   { bg:'#F5F3FF', stroke:'#7C3AED',
    svg:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>' },
  todo:    { bg:'#F0FDF4', stroke:'#16A34A',
    svg:'<path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>' },
  contact: { bg:'#FFF1F2', stroke:'#E11D48',
    svg:'<path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0"/>' },
  theme:   { bg:'#FAF5FF', stroke:'#7C3AED',
    svg:'<path d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z"/><path d="M6 6h.008v.008H6V6z"/>' },
  knowledge: { bg:'#FAF5FF', stroke:'#7C3AED',
    svg:'<path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>' },
};

function _searchIcon(type) {
  const ic = _SEARCH_ICONS[type];
  return `<div class="search-result-icon" style="background:${ic.bg}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${ic.stroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ic.svg}</svg>
  </div>`;
}

function _renderSearchEmpty() {
  _searchFocusIdx = -1; _searchItems = [];
  document.getElementById('search-results-area').innerHTML =
    `<div class="search-empty-state">
       <div class="search-empty-icon">🔍</div>
       <div>Meetings, Themen, Todos und Kontakte durchsuchen</div>
     </div>`;
}

function _renderSearchResults(groups, tokens) {
  _searchItems = [];
  const area = document.getElementById('search-results-area');
  if (!groups.length) {
    area.innerHTML = `<div class="search-empty-state"><div class="search-empty-icon">😶</div><div>Keine Treffer gefunden</div></div>`;
    return;
  }
  let html = '';
  groups.forEach(g => {
    html += `<div class="search-group-label">${escHtml(g.label)}</div>`;
    g.items.forEach((item, i) => {
      const idx = _searchItems.length;
      let title = '', context = '', snippet = '', nav = '';

      let srType = g.type, srId = '', srMid = '', srArchived = false;
      if (g.type === 'meeting') {
        const m = item;
        title   = _hl(m.title, tokens);
        context = (m.participants||[]).length ? escHtml(m.participants.join(', ')) : '';
        snippet = _hl(_snippet(m.description, tokens), tokens);
        srId = m.id;
        srArchived = m.archived === true;
        nav  = srArchived ? `navigateSearchResult('meeting','${m.id}','',true)` : `navigateSearchResult('meeting','${m.id}')`;
      } else if (g.type === 'topic') {
        const { topic: t, meeting: m } = item;
        title   = _hl(t.title, tokens);
        context = escHtml(m.title);
        const snipSrc = [t.description, t.result].find(f => {
          const p = stripHtmlForSearch(f||'');
          return tokens.filter(tk=>!tk.negate).some(tk=>p.toLowerCase().includes(tk.text));
        }) || t.description;
        snippet = _hl(_snippet(snipSrc, tokens), tokens);
        srId = t.id; srMid = m.id;
        srArchived = m.archived === true;
        nav  = `navigateSearchResult('topic','${t.id}','${m.id}',${srArchived})`;
      } else if (g.type === 'todo') {
        const t = item;
        title   = _hl(t.title, tokens);
        context = t.dueDate ? `Fällig: ${fmtDateOnly(t.dueDate)}` : '';
        const snipSrc = [t.description, t.result].find(f => {
          const p = stripHtmlForSearch(f||'');
          return tokens.filter(tk=>!tk.negate).some(tk=>p.toLowerCase().includes(tk.text));
        }) || t.description;
        snippet = _hl(_snippet(snipSrc, tokens), tokens);
        srId = t.id;
        nav  = `navigateSearchResult('todo','${t.id}')`;
      } else if (g.type === 'contact') {
        const c = item;
        title   = _hl(c.name, tokens);
        context = [c.role, c.email].filter(Boolean).map(s=>escHtml(s)).join(' · ');
        snippet = _hl(_snippet(c.description, tokens), tokens);
        srId = c.id;
        nav  = `navigateSearchResult('contact','${c.id}')`;
      } else if (g.type === 'theme') {
        const th = item;
        title   = _hl(th.title, tokens);
        context = themeAncestorsPath(th.id).slice(0, -1).map(p => p.title).join(' › ');
        snippet = _hl(_snippet(th.description, tokens), tokens);
        srId = th.id;
        nav  = `navigateSearchResult('theme','${th.id}')`;
      } else if (g.type === 'knowledge') {
        const k = item;
        title   = _hl(k.title, tokens);
        context = k.themeIds.map(id => themeById(id)?.title).filter(Boolean).join(', ');
        snippet = _hl(_snippet(k.content, tokens), tokens);
        srId = k.id;
        nav  = `navigateSearchResult('knowledge','${k.id}')`;
      }

      _searchItems.push({ type: srType, id: srId, meetingId: srMid, archived: srArchived });
      html += `<div class="search-result-item" data-sr-idx="${idx}" onclick="${nav}; closeSearch()">
        ${_searchIcon(g.type)}
        <div class="search-result-body">
          <div class="search-result-title">${title}${srArchived ? ` <span class="archive-badge archive-badge-inline">🗃 Archiviert</span>` : ''}</div>
          ${context ? `<div class="search-result-context">${context}</div>` : ''}
          ${snippet  ? `<div class="search-result-snippet">${snippet}</div>`  : ''}
        </div>
        <span class="search-result-arrow">›</span>
      </div>`;
    });
  });
  area.innerHTML = html;
  _searchFocusIdx = -1;
}

function _setSearchFocus(idx) {
  const items = document.querySelectorAll('.search-result-item');
  items.forEach((el, i) => el.classList.toggle('sr-focused', i === idx));
  if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block:'nearest' });
  _searchFocusIdx = idx;
}

function navigateSearchResult(type, id, meetingId, archived) {
  if (type === 'meeting' && archived) {
    selectArchiveDetail(id);
  } else if (type === 'meeting') {
    selectMeeting(id);
  } else if (type === 'topic' && archived) {
    // Archivierte Themen führen laut Vertrag NICHT in den normalen
    // Bearbeiten-Modal, sondern in die Archiv-Detail-Nur-Lese-Ansicht des
    // zugehörigen Meetings (über meetingId).
    selectArchiveDetail(meetingId);
  } else if (type === 'topic') {
    selectMeeting(meetingId);
    setTimeout(() => openTopicModal(meetingId, id), 120);
  } else if (type === 'todo') {
    selectView('__todos__');
    setTimeout(() => openTodoModal(id), 120);
  } else if (type === 'contact') {
    selectView('__contacts__');
    setTimeout(() => openContactModal(id), 120);
  } else if (type === 'theme') {
    selectView('__themes__');
    setTimeout(() => selectTheme(id), 120);
  } else if (type === 'knowledge') {
    selectedThemeId = null;
    selectView('__themes__');
    setTimeout(() => openKnowledgeModal(id), 120);
  }
}

function onSearchInput(val) {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => _runSearch(val), 140);
}

function onSearchKey(e) {
  const items = document.querySelectorAll('.search-result-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _setSearchFocus(Math.min(_searchFocusIdx + 1, items.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _setSearchFocus(Math.max(_searchFocusIdx - 1, 0));
  } else if (e.key === 'Enter' && _searchFocusIdx >= 0) {
    e.preventDefault();
    const sr = _searchItems[_searchFocusIdx];
    if (sr) { navigateSearchResult(sr.type, sr.id, sr.meetingId, sr.archived); closeSearch(); }
  }
}

// ── Online-Hilfe ─────────────────────────────────────────────
let _helpCurrentSection = 'overview';

function openHelp(sectionId) {
  document.getElementById('help-modal-overlay').classList.add('open');
  showHelpSection(sectionId || _helpCurrentSection || 'overview');
}
function closeHelp() {
  document.getElementById('help-modal-overlay').classList.remove('open');
}
function showHelpSection(id) {
  _helpCurrentSection = id;
  document.querySelectorAll('.help-section').forEach(s =>
    s.classList.toggle('active', s.id === 'hs-' + id));
  document.querySelectorAll('.help-toc-item').forEach(i =>
    i.classList.toggle('active', i.dataset.section === id));
  document.getElementById('help-content-area').scrollTop = 0;
}
function helpSearch(q) {
  const lq = q.toLowerCase().trim();
  document.querySelectorAll('.help-toc-item').forEach(item => {
    if (!lq) { item.classList.remove('hidden'); return; }
    const sec = document.getElementById('hs-' + item.dataset.section);
    item.classList.toggle('hidden', !sec?.textContent.toLowerCase().includes(lq));
  });
}
