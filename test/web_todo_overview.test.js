'use strict';
// Arbeitspaket W2 (Uebersicht/Bearbeiten-Ansicht, index.html).
//
// index.html ist eine monolithische, buildlose HTML/JS-Datei ohne Module.
// Um die darin enthaltene Rendering-/Interaktionslogik trotzdem isoliert zu
// testen, wird die komplette Datei per jsdom geladen ("runScripts:
// dangerously"): jsdom stellt DOM/Selection/execCommand bereit, `fetch`
// wird bewusst deaktiviert (kein Netzwerk in Tests) — der App-Bootstrap
// (`await api('GET','/me')`) laeuft dadurch kontrolliert in `showLogin()`,
// was fuer diese Tests unschaedlich ist, da wir Render-/Helferfunktionen
// direkt mit eigenen Fixture-Daten aufrufen statt echte Server-Antworten
// zu erwarten.
//
// Dieses Vorgehen ist neu fuer dieses Projekt (bisher gibt es keine
// Frontend-Tests fuer index.html) und wird daher hier ausfuehrlich
// dokumentiert statt an anderer Stelle wiederverwendet zu werden, siehe
// Abschlussbericht.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX_HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

function loadApp() {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    virtualConsole,
  });
  const { window } = dom;
  // Netzwerk in Tests bewusst deaktiviert (siehe Kommentar oben).
  window.fetch = () => Promise.reject(new Error('network disabled in tests'));
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  return { dom, window, document: window.document, jsdomErrors };
}

// Wartet einen Tick, damit der App-Bootstrap (async IIFE) durchlaufen kann.
function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// index.html deklariert seinen App-State (todos, meetings, aiSettings, ...)
// als Top-Level `let`/`const` in einem klassischen <script> — solche
// Bindungen landen NICHT als Eigenschaft auf window (anders als `var`/
// Funktionsdeklarationen), sind also von außen weder lesbar noch
// beschreibbar über `window.todos = …`. `window.eval(...)` läuft dagegen im
// selben globalen Scope wie das <script> und kann diese Bindungen daher
// gezielt lesen/setzen — das ist der einzige Weg, um App-State für diese
// Tests zu fixturen, ohne index.html selbst zu verändern.
function setAppGlobal(window, name, value) {
  window.__testTmp__ = value;
  window.eval(`${name} = window.__testTmp__;`);
  delete window.__testTmp__;
}
function getAppGlobal(window, name) {
  return window.eval(name);
}

test('index.html laedt fehlerfrei und exponiert die W2-Funktionen', async () => {
  const { window, jsdomErrors } = loadApp();
  await tick();
  assert.deepEqual(jsdomErrors, []);
  for (const fn of [
    'renderPersonalTodoCard', 'renderMeetingTopicTodo', 'renderTodosView',
    'openTodoModal', 'closeTodoModal', 'saveTodoModal',
    'enterTodoDescEditMode', 'updateTodoDescReadView',
    'updateTodoMoreDetailsSummary', 'collectTodoFormData', 'hasUnsavedTodoChanges',
    'mountTodoProgressArea', 'mountCardComposer', 'toggleTodoCardComposer',
    'renderTodoCardBody', 'renderTodoCardProgress', 'mountTodoCardSummaries',
    'openProgressEntryDialog', 'submitProgressEntryDialog', 'deleteProgressEntryDialog',
    'plainTextLength', 'plainTextExcerpt',
  ]) {
    assert.equal(typeof window[fn], 'function', `${fn} sollte definiert sein`);
  }
  assert.equal(typeof window.TSHost, 'object');
  assert.equal(typeof window.TSHost.progress, 'object');
});

test('Zielbild/Goal-Funktion ist vollstaendig entfernt (DoD-Anforderung)', async () => {
  // Muss auf dem Rohtext prüfen (nicht nur auf geladene Funktionen), damit
  // auch tote Markup-Reste/Kommentare erfasst werden.
  assert.equal(/openGoalDialog/i.test(INDEX_HTML), false);
  assert.equal(/progress-goal-modal/i.test(INDEX_HTML), false);
  assert.equal(/Zielbild/i.test(INDEX_HTML), false);
});

test('TSHost.progress: aiSummaryEnabled prueft Feature-Schalter UND globalen KI-Schalter', async () => {
  const { window } = loadApp();
  await tick();
  setAppGlobal(window, 'aiSettings', { configured: true, globally_disabled: false, features_enabled: { progress_summary: true } });
  assert.equal(window.TSHost.progress.aiSummaryEnabled('progress'), true);
  assert.equal(window.TSHost.progress.aiSummaryEnabled('description'), false);

  setAppGlobal(window, 'aiSettings', { configured: true, globally_disabled: true, features_enabled: { progress_summary: true } });
  assert.equal(window.TSHost.progress.aiSummaryEnabled('progress'), false, 'globaler KI-Aus-Schalter muss greifen');

  setAppGlobal(window, 'aiSettings', null);
  assert.equal(window.TSHost.progress.aiSummaryEnabled('progress'), false);

  // Eingabevalidierung: unbekannte "kind"-Werte werden abgelehnt statt
  // stillschweigend als falsy durchzufallen (Regressionsschutz).
  setAppGlobal(window, 'aiSettings', { configured: true, globally_disabled: false, features_enabled: { progress_summary: true, description_summary: true } });
  assert.equal(window.TSHost.progress.aiSummaryEnabled('unknown-kind'), false);
});

test('TSHost.progress.regenerateSummary: validiert kind/refType/refId vor dem API-Aufruf', async () => {
  const { window } = loadApp();
  await tick();
  const calls = [];
  window.api = (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve({ status: 'pending' }); };

  await assert.rejects(() => window.TSHost.progress.regenerateSummary('invalid', 'todo', 'abc'));
  await assert.rejects(() => window.TSHost.progress.regenerateSummary('progress', 'invalid', 'abc'));
  await assert.rejects(() => window.TSHost.progress.regenerateSummary('progress', 'todo', ''));
  await assert.rejects(() => window.TSHost.progress.regenerateSummary('progress', 'todo', 'x'.repeat(201)));
  assert.equal(calls.length, 0, 'bei ungueltigen Eingaben darf kein Request ausgeloest werden');

  // `confirmed` defaultet auf false (Security Review, Mittel, A04): ein
  // Aufruf ohne explizite Bestätigung darf die Kostenschwelle NICHT über ein
  // fest verdrahtetes confirm=true umgehen.
  const res = await window.TSHost.progress.regenerateSummary('progress', 'todo', 'abc-123');
  assert.equal(res.status, 'pending');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/summaries/progress/todo/abc-123/regenerate');

  // refId wird URL-kodiert (Pfad-Injektion/Sonderzeichen abgefangen).
  await window.TSHost.progress.regenerateSummary('description', 'topic', 'a/b?c');
  assert.equal(calls[1].path, '/summaries/description/topic/a%2Fb%3Fc/regenerate');

  // Erst ein expliziter vierter Parameter confirmed=true haengt ?confirm=true an.
  await window.TSHost.progress.regenerateSummary('progress', 'todo', 'abc-123', true);
  assert.equal(calls[2].path, '/summaries/progress/todo/abc-123/regenerate?confirm=true');
});

test('TSHost.openObject: focus=progress scrollt zum Fortschrittsbereich, wenn vorhanden', async () => {
  const { window, document } = loadApp();
  await tick();
  // Minimal-Fixture, damit openTodoModal ohne echten Server-Roundtrip läuft.
  setAppGlobal(window, 'todos', [{ id: 't1', title: 'Test', description: '', done: false }]);
  let scrolled = false;
  const section = document.getElementById('todo-progress-section');
  section.scrollIntoView = () => { scrolled = true; };
  window.TSHost.openObject('todo', 't1', { focus: 'progress' });
  await tick(100);
  assert.equal(scrolled, true);
});

test('Beschreibung: Leseansicht mit Stift-Aktivierung (kein zweiter Editor)', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', [{ id: 't1', title: 'Test', description: '<p>Hallo <b>Welt</b></p>', done: false }]);
  window.openTodoModal('t1');

  assert.equal(document.getElementById('todo-desc-readview').style.display, '');
  assert.equal(document.getElementById('todo-desc-wrapper').style.display, 'none');
  assert.match(document.getElementById('todo-desc-display').innerHTML, /Hallo/);

  window.enterTodoDescEditMode();
  assert.equal(document.getElementById('todo-desc-readview').style.display, 'none');
  assert.equal(document.getElementById('todo-desc-wrapper').style.display, '');
  // Es gibt weiterhin nur EINEN rt-content-Editor fuer die Beschreibung.
  assert.equal(document.querySelectorAll('#todo-modal .rt-content[id^="todo-desc"]').length, 1);
});

test('Beschreibung: ohne Wert Platzhaltertext + aktives Stift-Symbol; Neuanlage sofort editierbar', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', [{ id: 't2', title: 'Leer', description: '', done: false }]);
  window.openTodoModal('t2');
  const display = document.getElementById('todo-desc-display');
  assert.match(display.textContent, /Keine Beschreibung/);
  assert.equal(document.getElementById('todo-desc-edit-btn').hasAttribute('disabled'), false);

  window.openTodoModal(); // Neuanlage
  assert.equal(document.getElementById('todo-desc-wrapper').style.display, '');
  assert.equal(document.getElementById('todo-desc-readview').style.display, 'none');
});

test('"Weitere Details": startet geschlossen bei Neuanlage, offen mit Kurzuebersicht bei befuellten Werten', async () => {
  const { window, document } = loadApp();
  await tick();
  window.openTodoModal();
  assert.equal(document.getElementById('todo-more-details').open, false);
  assert.equal(document.getElementById('todo-more-details-summary').textContent, 'Weitere Details');

  setAppGlobal(window, 'todos', [{ id: 't3', title: 'X', description: '', dueDate: '2026-09-12', isPrivate: true, done: false }]);
  window.openTodoModal('t3');
  assert.equal(document.getElementById('todo-more-details').open, true);
  const summaryText = document.getElementById('todo-more-details-summary').textContent;
  assert.match(summaryText, /Weitere Details –/);
  assert.match(summaryText, /12\.09\./);
  assert.match(summaryText, /Privat/);
});

test('Verwerfen-Rueckfrage: hasUnsavedTodoChanges erkennt Aenderungen, closeTodoModal fragt nach', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', [{ id: 't4', title: 'Original', description: '', done: false }]);
  window.openTodoModal('t4');
  assert.equal(window.hasUnsavedTodoChanges(), false);

  document.getElementById('todo-title').value = 'Geaendert';
  assert.equal(window.hasUnsavedTodoChanges(), true);

  let confirmCalled = false;
  window.genericConfirm = (title) => { confirmCalled = true; return Promise.resolve(false); };
  await window.closeTodoModal();
  assert.equal(confirmCalled, true, 'genericConfirm muss bei ungespeicherten Aenderungen aufgerufen werden');
  assert.equal(document.getElementById('todo-modal').style.display, 'flex', 'Modal bleibt offen, wenn Nutzer "Weiter bearbeiten" waehlt');

  window.genericConfirm = () => Promise.resolve(true);
  await window.closeTodoModal();
  assert.equal(document.getElementById('todo-modal').style.display, 'none');
});

test('closeTodoModal(true) (nach erfolgreichem Speichern) schliesst ohne Rueckfrage', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', [{ id: 't5', title: 'Original', description: '', done: false }]);
  window.openTodoModal('t5');
  document.getElementById('todo-title').value = 'Geaendert';
  let confirmCalled = false;
  window.genericConfirm = () => { confirmCalled = true; return Promise.resolve(true); };
  await window.closeTodoModal(true);
  assert.equal(confirmCalled, false);
  assert.equal(document.getElementById('todo-modal').style.display, 'none');
});

test('Karten: lange Beschreibung ohne aktives KI-Feature bekommt Zeilenkuerzung + Ausklapp-Element mit passendem Label', async () => {
  const { window } = loadApp();
  await tick();
  const longText = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(20) + '</p>'; // > CARD_DESC_CLAMP_CHARS, kein aiSummary
  const todo = { id: 'c1', title: 'Lang', description: longText, done: false, aiSummary: {} };
  const body = window.renderTodoCardBody('todo', todo, [], false, false);
  assert.match(body.descriptionHtml, /desc-clamp-fallback/);
  assert.match(body.toggleHtml, /Ganzen Text anzeigen/);
  assert.doesNotMatch(body.descriptionHtml, /ts-card-summary-slot/);
});

test('Karten: lange Beschreibung mit aktivem/aktionsfaehigem KI-Status bekommt Summary-Slot statt Volltext', async () => {
  const { window } = loadApp();
  await tick();
  const longText = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(20) + '</p>';
  const todo = { id: 'c2', title: 'Lang', description: longText, done: false, aiSummary: { description: { status: 'ready', text: 'Kurzfassung' } } };
  const body = window.renderTodoCardBody('todo', todo, [], false, false);
  assert.match(body.descriptionHtml, /ts-card-summary-slot/);
  assert.match(body.descriptionHtml, /todo-desc-summary-todo-c2/);
});

test('Karten: description-Status "not_applicable" zeigt defensiv KEINE KI-Flaeche (bekannte S3-Mehrdeutigkeit)', async () => {
  const { window } = loadApp();
  await tick();
  const longText = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(20) + '</p>';
  const todo = { id: 'c3', title: 'Lang', description: longText, done: false, aiSummary: { description: { status: 'not_applicable' } } };
  const body = window.renderTodoCardBody('todo', todo, [], false, false);
  assert.doesNotMatch(body.descriptionHtml, /ts-card-summary-slot/);
  // Fällt stattdessen auf die deterministische Kürzung zurück.
  assert.match(body.descriptionHtml, /desc-clamp-fallback/);
});

test('Karten: Fortschritts-KI-Zusammenfassung nur wenn status != not_applicable und Todo nicht erledigt/archiviert', async () => {
  const { window } = loadApp();
  await tick();
  const readyTodo = { id: 'p1', progress: { orderKey: 'x' }, aiSummary: { progress: { status: 'ready' } } };
  assert.match(window.renderTodoCardProgress('todo', readyTodo, false, false), /todo-progress-summary-todo-p1/);

  const naTodo = { id: 'p2', progress: { orderKey: 'x' }, aiSummary: { progress: { status: 'not_applicable' } } };
  assert.doesNotMatch(window.renderTodoCardProgress('todo', naTodo, false, false), /ts-card-summary-slot/);

  // Erledigt / archiviert: komplett keine Fortschrittszeile, kein Composer-Icon, keine KI-Zusammenfassung.
  assert.equal(window.renderTodoCardProgress('todo', readyTodo, true, false), '');
  assert.equal(window.renderTodoCardProgress('todo', readyTodo, false, true), '');
});

test('Karten: EIN Aufklapp-Element mit "Mehr/Weniger anzeigen", wenn zusaetzliche Topic-Chips vorhanden sind', async () => {
  const { window } = loadApp();
  await tick();
  const themeEntries = [1, 2, 3, 4, 5].map(n => ({ theme: { id: 'th' + n, title: 'Topic ' + n } }));
  const todo = { id: 'c4', title: 'Chips', description: '', done: false };
  const body = window.renderTodoCardBody('todo', todo, themeEntries, false, false);
  assert.match(body.toggleHtml, /Mehr anzeigen/);
  const chipCountVisible = (body.chipsHtml.match(/class="theme-chip"/g) || []).length;
  assert.equal(chipCountVisible, 3, 'im Standardzustand nur 3 Chips sichtbar');
});

test('renderPersonalTodoCard: Erledigt-Karten haben keine Fortschrittszeile und kein Composer-Icon', async () => {
  const { window } = loadApp();
  await tick();
  const doneTodo = { id: 'd1', title: 'Fertig', description: '', done: true, result: 'Ok', progress: { orderKey: 'x' }, aiSummary: { progress: { status: 'ready' }, description: { status: 'ready' } } };
  const html = window.renderPersonalTodoCard(doneTodo, true, {});
  assert.doesNotMatch(html, /todo-card-composer-todo-d1/);
  assert.doesNotMatch(html, /ts-card-summary-slot/);
  assert.doesNotMatch(html, /ts-progress-line-host/);
  assert.doesNotMatch(html, /toggleTodoCardComposer/);
});

test('renderPersonalTodoCard: offene Karten zeigen "Zwischenstand erfassen" als Primäraktion, "Auf Stack legen" wandert ins Ueberlaufmenue', async () => {
  const { window } = loadApp();
  await tick();
  const openTodo = { id: 'o1', title: 'Offen', description: '', done: false };
  const html = window.renderPersonalTodoCard(openTodo, false, {});
  assert.match(html, /toggleTodoCardComposer\('todo','o1'\)/);
  assert.match(html, /aria-label="Zwischenstand erfassen"/);
  // "Auf Stack legen" ist jetzt Teil des Ueberlaufmenues (topic-overflow-menu), nicht mehr eigenstaendiger Button.
  const overflowIdx = html.indexOf('topic-overflow-menu');
  const stackIdx = html.indexOf('Auf Stack legen');
  assert.ok(overflowIdx > -1 && stackIdx > overflowIdx);
});

test('AI-Einstellungen: neue Feature-Labels sind registriert und werden ueber das bestehende, datengetriebene Rendering dargestellt', async () => {
  const { window, document } = loadApp();
  await tick();
  const labels = getAppGlobal(window, 'AI_FEATURE_LABELS');
  assert.equal(labels.progress_summary, 'Fortschritts-Zusammenfassung');
  assert.equal(labels.description_summary, 'Beschreibungs-Zusammenfassung');

  window.renderAiFeatures({ progress_summary: true, description_summary: false });
  const checkboxes = [...document.querySelectorAll('#ai-features input[data-feature]')];
  const byName = Object.fromEntries(checkboxes.map(cb => [cb.dataset.feature, cb.checked]));
  assert.equal(byName.progress_summary, true);
  assert.equal(byName.description_summary, false);

  const collected = window.collectAiFeatures();
  assert.equal(collected.progress_summary, true);
  assert.equal(collected.description_summary, false);
});

test('progress-entry-modal: Kontextzeile zeigt gekuerzte Beschreibung statt Zielbild, entfaellt ohne Beschreibung', async () => {
  const { window, document } = loadApp();
  await tick();
  window.openProgressEntryDialog('todo', 't1', null, '', '<p>' + 'x'.repeat(300) + '</p>');
  const ctx = document.getElementById('progress-entry-context');
  assert.equal(ctx.style.display, '');
  assert.ok(ctx.textContent.length <= 160);
  assert.doesNotMatch(ctx.textContent, /Zielbild/i);

  window.closeProgressEntryDialog();
  window.openProgressEntryDialog('todo', 't1', null, '', '');
  assert.equal(document.getElementById('progress-entry-context').style.display, 'none', 'ohne Beschreibung NIE eine leere Flaeche anzeigen');
});

test('progress-entry-modal: Loeschen-Button nur bei vorhandenem Eintrag sichtbar', async () => {
  const { window, document } = loadApp();
  await tick();
  window.openProgressEntryDialog('todo', 't1', null, '<p>neu</p>', '');
  assert.equal(document.getElementById('progress-entry-delete-btn').style.display, 'none');
  window.closeProgressEntryDialog();
  window.openProgressEntryDialog('todo', 't1', 'entry-1', '<p>bestehend</p>', '');
  assert.equal(document.getElementById('progress-entry-delete-btn').style.display, '');
});

test('plainTextExcerpt: liefert reinen Text (kein HTML) und kuerzt korrekt', async () => {
  const { window } = loadApp();
  await tick();
  const html = '<p>Hallo <b>Welt</b> &amp; <script>alert(1)</script></p>';
  const excerpt = window.plainTextExcerpt(html, 10);
  assert.doesNotMatch(excerpt, /<[a-z]/i);
  assert.ok(excerpt.length <= 10);
});

test('Assets: progress.css/progress.js werden wie graph.css/graph.js unter /assets/ eingebunden', async () => {
  assert.match(INDEX_HTML, /<link rel="stylesheet" href="\/assets\/progress\.css">/);
  assert.match(INDEX_HTML, /<script defer src="\/assets\/progress\.js"><\/script>/);
});
