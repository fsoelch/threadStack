'use strict';
// Arbeitspaket W2 ("Web-Host-Integration" der Ansprechpartner-Erweiterung).
//
// Folgt exakt dem in test/web_todo_overview.test.js etablierten Muster:
// index.html wird per jsdom geladen ("runScripts: dangerously"), externe
// <script src>-Tags werden VOR dem Parsen durch Inline-<script>s mit dem
// jeweiligen Dateiinhalt ersetzt (jsdom laedt externe Ressourcen sonst nur
// per echtem HTTP-Request, was dem hier bewusst deaktivierten Netzwerk
// widerspraeche). Anders als bei TSProgress (dort reicht ein einfacher
// Mock) wird hier das ECHTE public/contacts.js mitgeladen, weil genau die
// Wechselwirkung mit den in app.js implementierten Host-Adaptern geprueft
// werden soll (initToolbar-Wiring, onClosed-Callback, openAssignmentPicker-
// Zusammenspiel) - ein reiner Mock wuerde nur die Form der eigenen Adapter
// pruefen, nicht ob contacts.js sie tatsaechlich wie vertraglich vereinbart
// aufruft.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');
const { setupEnv, loadServer, cleanup, REPO_ROOT } = require('./helpers');

const INDEX_HTML_PATH    = path.resolve(__dirname, '..', 'index.html');
const APP_JS_PATH        = path.resolve(__dirname, '..', 'public', 'app.js');
const CONTACTS_JS_PATH   = path.resolve(__dirname, '..', 'public', 'contacts.js');

const RAW_INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const INDEX_HTML = RAW_INDEX_HTML
  .replace('<script defer src="/assets/app.js"></script>',
    () => `<script>${fs.readFileSync(APP_JS_PATH, 'utf8')}</script>`)
  .replace('<script defer src="/assets/contacts.js"></script>',
    () => `<script>${fs.readFileSync(CONTACTS_JS_PATH, 'utf8')}</script>`);

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
  window.fetch = () => Promise.reject(new Error('network disabled in tests'));
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  return { dom, window, document: window.document, jsdomErrors };
}

function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Siehe test/web_todo_overview.test.js: Top-Level `let`/`const` in einem
// klassischen <script> landen nicht als window-Property - window.eval(...)
// laeuft im selben globalen Scope und kann sie daher gezielt lesen/setzen.
function setAppGlobal(window, name, value) {
  window.__testTmp__ = value;
  window.eval(`${name} = window.__testTmp__;`);
  delete window.__testTmp__;
}
function getAppGlobal(window, name) {
  return window.eval(name);
}

// Baut einen window.api()-Mock, der die von contacts.js (ueber TSHost.api,
// das den fuehrenden "/api"-Praefix bereits entfernt hat) angefragten Pfade
// bedient. `routes` ist eine Liste von {method, test(path), handler(path,body)}.
function makeApiMock(routes, calls) {
  return (method, p, body) => {
    calls.push({ method, path: p, body });
    for (const r of routes) {
      if (r.method === method && r.test(p)) return Promise.resolve(r.handler(p, body));
    }
    return Promise.reject(Object.assign(new Error(`Kein Mock fuer ${method} ${p}`), { status: 404 }));
  };
}

// Server-Envelopes (Quelle der Wahrheit: lib/contacts/routes.js) — NICHT die
// flachen Formen, die contacts.js vor der Nachbesserung (Security-Review
// HOCH 2) fälschlich erwartet hatte:
//   GET /contacts/:id            -> {contact, infoBlocks, categories, themeLinks}
//   GET /contact-categories      -> {categories:[...]}
//   GET .../info-blocks          -> {blocks:[...], categories:[...]}
function baseContactApiRoutes(contact, { categories = [], blocks = [], themes = [], assignments = [] } = {}) {
  return [
    { method: 'GET', test: (p) => p === `/contacts/${contact.id}`, handler: () => ({ contact, infoBlocks: blocks, categories, themeLinks: [] }) },
    { method: 'GET', test: (p) => p === '/contact-categories', handler: () => ({ categories }) },
    { method: 'GET', test: (p) => p === `/contacts/${contact.id}/info-blocks`, handler: () => ({ blocks, categories }) },
    { method: 'GET', test: (p) => p === '/themes', handler: () => themes },
    {
      method: 'GET', test: (p) => p.startsWith(`/contacts/${contact.id}/assignments`),
      handler: () => ({ items: assignments, page: { limit: 50, offset: 0, total: assignments.length, hasMore: false }, counts: { open: 0, done: 0 } }),
    },
  ];
}

test('index.html laedt contacts.js fehlerfrei und exponiert die W2-Integrationsfunktionen', async () => {
  const { window, jsdomErrors } = loadApp();
  await tick();
  assert.deepEqual(jsdomErrors, []);
  assert.equal(typeof window.TSContacts, 'object', 'contacts.js muss window.TSContacts exponieren');
  for (const fn of [
    'mountContactDetailSection', 'destroyContactDetailSection', 'navigateFromContactAssignment',
    'openContactFromChip', 'renderAssignedContactsChipsHtml', 'applyAssignedContacts',
    'toAssignedContactShape', 'doOpenContactAssignmentPicker',
    'openContactAssignmentPickerForTodoCard', 'openContactAssignmentPickerForTopicCard',
    'openContactAssignmentPickerForTodo', 'openContactAssignmentPickerForTopic',
    'renderTodoContactsChips', 'renderTopicContactsChips',
    'openContactModal', 'closeContactModal', 'saveContactModal', 'confirmDeleteContact',
    'openThemeLinkModal', 'closeThemeLinkModal',
  ]) {
    assert.equal(typeof window[fn], 'function', `${fn} sollte definiert sein`);
  }
});

test('Assets: contacts.css/contacts.js werden wie progress.css/progress.js unter /assets/ eingebunden', async () => {
  assert.match(RAW_INDEX_HTML, /<link rel="stylesheet" href="\/assets\/contacts\.css">/);
  assert.match(RAW_INDEX_HTML, /<script defer src="\/assets\/contacts\.js"><\/script>/);
  // Die Dev-Testseite darf NICHT im ausgelieferten HTML referenziert werden.
  assert.doesNotMatch(RAW_INDEX_HTML, /contacts-dev\.html/);
});

test('Server: /assets/contacts.js und /assets/contacts.css sind erreichbar, /assets/contacts-dev.html liefert 404', async () => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  try {
    const js = await request(app).get('/assets/contacts.js');
    assert.equal(js.status, 200);
    const css = await request(app).get('/assets/contacts.css');
    assert.equal(css.status, 200);
    const dev = await request(app).get('/assets/contacts-dev.html');
    assert.equal(dev.status, 404, 'Dev-Testseiten (assetsGuard) duerfen im Auslieferungspfad nicht erreichbar sein');
  } finally {
    cleanup(dir);
  }
});

test('Kontaktkarte: contactBadgesHtml ersetzt das reine description-Snippet (Rubrik-Badges + Klartextauszug)', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'contacts', [
    {
      id: 'c1', name: 'Anna Müller', role: 'PM', email: 'anna@example.com',
      description: '', categories: [{ id: 'cat1', label: 'Zuständigkeit' }],
      infoBlockCount: 1, snippet: 'Verantwortlich für APAC-Rollout',
    },
  ]);
  setAppGlobal(window, 'contactSearch', '');
  const host = document.createElement('div');
  window.renderContactsView(host);
  assert.match(host.innerHTML, /tsc-badge/, 'Rubrik-Badge muss gerendert werden');
  assert.match(host.innerHTML, /Verantwortlich für APAC-Rollout/, 'Klartextauszug (snippet) muss angezeigt werden');
  assert.doesNotMatch(host.innerHTML, /contact-card-desc/, 'altes reines description-Snippet-Markup soll ersetzt sein');
});

// Web-seitiger Regressionsschutz zur Datenschutz-Invariante "Privates"
// (ergänzend zum bereits vorhandenen Backend-Test in
// test/contact_search_text.test.js, der batchContactExtras() direkt prüft):
// Auch bei GEMISCHTEN Rubriken (normale Rubrik + "Privates" am selben
// Kontakt) darf kein Text aus einem "Privates"-Infoblock in der gerenderten
// Kontaktkarte auftauchen. `description` steht hier stellvertretend für ein
// veraltetes/anderes Feld, das theoretisch privaten Klartext enthalten
// könnte — die Karte darf NUR über das serverseitig bereits gefilterte
// `snippet`-Feld rendern, niemals über einen Fallback auf `description`.
test('Kontaktkarte rendert ausschließlich das serverseitig bereinigte snippet, nie einen description-Fallback (auch bei gemischten Rubriken)', async () => {
  const { window, document } = loadApp();
  await tick();
  const PRIVATE_MARKER = '<privater Testtext>';
  setAppGlobal(window, 'contacts', [
    {
      id: 'c1', name: 'Anna Müller', role: 'PM', email: 'anna@example.com',
      // Legacy-/Fallback-Feld: enthält (hypothetisch) den privaten Text —
      // darf von der Karte NICHT gerendert werden.
      description: PRIVATE_MARKER,
      categories: [
        { id: 'cat1', label: 'Zuständigkeit' },
        { id: 'cat2', label: 'Privates' },
      ],
      infoBlockCount: 2,
      // Server liefert laut Vertrag (batchContactExtras, PRIVATE_CATEGORY_LABEL_NORM-
      // Ausschluss) bereits ein von "Privates"-Inhalten bereinigtes Snippet.
      snippet: 'Verantwortlich für APAC-Rollout',
    },
  ]);
  setAppGlobal(window, 'contactSearch', '');
  const host = document.createElement('div');
  window.renderContactsView(host);
  assert.doesNotMatch(host.textContent, /<privater Testtext>/, 'kein Text einer "Privates"-Rubrik darf auf der Kontaktkarte erscheinen');
  assert.match(host.innerHTML, /tsc-badge-private/, '"Privates"-Rubrik darf weiterhin als Badge (ohne Vorschautext) sichtbar sein');
  assert.match(host.innerHTML, /Verantwortlich für APAC-Rollout/, 'der bereinigte Klartextauszug der NICHT-privaten Rubrik bleibt sichtbar');
});

test('Löschbestätigung: dynamischer Hinweis bei vorhandenen Zusatzinformationen (infoBlockCount)', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'contacts', [{ id: 'c1', name: 'Anna', infoBlockCount: 3 }]);
  window.confirmDeleteContact('c1', 'Anna');
  assert.match(document.getElementById('confirm-message').textContent, /3 Zusatzinformation/);

  setAppGlobal(window, 'contacts', [{ id: 'c2', name: 'Bert', infoBlockCount: 0 }]);
  window.confirmDeleteContact('c2', 'Bert');
  assert.doesNotMatch(document.getElementById('confirm-message').textContent, /Zusatzinformation/);
});

test('Todo-Karte/Themen-Karte: Overflow-Menue enthaelt "Ansprechpartner zuordnen" getrennt von "Topic zuweisen"', async () => {
  const { window } = loadApp();
  await tick();
  const todoHtml = window.renderPersonalTodoCard({ id: 't1', title: 'X', description: '', done: false, contacts: [] }, false, {});
  assert.match(todoHtml, /openContactAssignmentPickerForTodoCard\('t1'\)/);
  assert.match(todoHtml, /Ansprechpartner zuordnen/);
  assert.match(todoHtml, /openThemeLinkModalForTodo\('t1'\)/);
  assert.match(todoHtml, />Topic zuweisen</, 'Topic-Zuweisung bleibt als eigene, unterscheidbare Aktion erhalten');

  setAppGlobal(window, 'meetings', [{ id: 'm1', topics: [{ id: 'top1', title: 'Y', done: false, contacts: [] }] }]);
  const topicHtml = window.renderTopicCard('m1', { id: 'top1', title: 'Y', done: false, contacts: [] }, {}, {}, false);
  assert.match(topicHtml, /openContactAssignmentPickerForTopicCard\('m1','top1'\)/);
  assert.match(topicHtml, /Ansprechpartner zuordnen/);
});

test('Chip-Anzeige: zugeordnete Ansprechpartner erscheinen als Chips auf Todo- und Themen-Karte', async () => {
  const { window } = loadApp();
  await tick();
  const assignedContacts = [{ contactId: 'c1', name: 'Anna Müller', role: 'PM', email: '', assignedAt: '2026-01-01T00:00:00.000Z' }];
  const todoHtml = window.renderPersonalTodoCard({ id: 't1', title: 'X', description: '', done: false, contacts: assignedContacts }, false, {});
  assert.match(todoHtml, /tsc-assigned-chip/);
  assert.match(todoHtml, /Anna Müller/);
  assert.match(todoHtml, /openContactFromChip\('c1'\)/);

  const topicHtml = window.renderTopicCard('m1', { id: 'top1', title: 'Y', done: false, contacts: assignedContacts }, {}, {}, false);
  assert.match(topicHtml, /tsc-assigned-chip/);
  assert.match(topicHtml, /Anna Müller/);
});

// Sicherheits-Regressionstest (Code-Review-Auflage "Hoch"): renderAssignedContactsChipsHtml()
// muss escJsAttr() statt der wirkungslosen Kombination escHtml()+.replace(/'/g,"\\'")
// verwenden, um das im onclick-Attribut eingebettete String-Literal abzusichern.
// escHtml() alleine wandelt ' bereits in &#039; um, wodurch der nachgelagerte
// .replace(/'/g,...) nichts mehr findet - der HTML-Parser dekodiert &#039; aber
// wieder zu ' BEVOR der Attributinhalt als JavaScript geparst wird, sodass das
// String-Literal trotzdem aufbricht (siehe Kommentar bei escJsAttr in app.js).
test('Chip-onclick: bösartige contactId kann das String-Literal nicht aufbrechen (escJsAttr-Regressionstest)', async () => {
  const { window, document } = loadApp();
  await tick();
  const maliciousId = "x'); window.__pwned = 1; ('";
  const assignedContacts = [{ contactId: maliciousId, name: 'Anna Müller', role: 'PM', email: '', assignedAt: '2026-01-01T00:00:00.000Z' }];
  const todoHtml = window.renderPersonalTodoCard({ id: 't1', title: 'X', description: '', done: false, contacts: assignedContacts }, false, {});

  // Die im Attribut eingebetteten Anführungszeichen müssen als \uXXXX-Escape
  // vorliegen (escJsAttr), nicht als rohes ' oder als HTML-Entity &#039;, die
  // beide vom HTML-Parser vor dem JS-Parsing wieder aufgelöst würden.
  assert.match(todoHtml, /\\u0027/, 'contactId muss ueber escJsAttr (\\uXXXX-Escapes) eingebettet werden');
  assert.doesNotMatch(todoHtml, /&#039;/, 'kein HTML-Entity-Escaping fuer das JS-String-Literal im onclick-Attribut');

  let receivedId = null;
  window.openContactFromChip = (id) => { receivedId = id; };

  const host = document.createElement('div');
  document.body.appendChild(host);
  host.innerHTML = todoHtml;
  const chip = host.querySelector('.tsc-assigned-chip');
  assert.ok(chip, 'Chip muss gerendert werden');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(window.__pwned, undefined, 'kein injizierter Code darf beim Klick ausgefuehrt worden sein');
  assert.equal(receivedId, maliciousId, 'openContactFromChip muss die unveraenderte, unversehrte contactId erhalten');
  host.remove();
});

test('renderTodoCardBody liefert contactsHtml (gemeinsame Basis fuer Todo- und Meeting-Topic-Todo-Karte)', async () => {
  const { window } = loadApp();
  await tick();
  const assignedContacts = [{ contactId: 'c1', name: 'Bert', role: '', email: '', assignedAt: '2026-01-01T00:00:00.000Z' }];
  const body = window.renderTodoCardBody('todo', { id: 't1', description: '', contacts: assignedContacts }, [], false, false);
  assert.match(body.contactsHtml, /tsc-assigned-chip/);
  assert.match(body.contactsHtml, /Bert/);
});

test('Host-Adapter: doOpenContactAssignmentPicker ruft TSContacts.openAssignmentPicker auf, aktualisiert Todo.contacts nach Speichern', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', [{ id: 't1', title: 'Todo 1', description: '', done: false, contacts: [] }]);
  setAppGlobal(window, 'contacts', [{ id: 'c1', name: 'Anna Müller', role: 'PM', email: 'anna@example.com' }]);

  const calls = [];
  window.api = makeApiMock([
    { method: 'GET', test: (p) => p === '/assignments/todo/t1', handler: () => ({ contacts: [], limit: 20 }) },
    { method: 'PUT', test: (p) => p === '/assignments/todo/t1', handler: () => ({ ok: true }) },
  ], calls);

  window.openContactAssignmentPickerForTodoCard('t1');
  await tick(50); // Vorbelegung (GET) laedt asynchron

  const dialog = document.querySelector('.tsc-assignment-picker');
  assert.ok(dialog, 'Zuordnungsdialog muss geoeffnet sein');
  const checkbox = dialog.querySelector('#tsc-pick-c1');
  assert.ok(checkbox, 'Checkbox fuer den Ansprechpartner muss vorhanden sein');
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));

  const doneBtn = [...dialog.querySelectorAll('.tsc-btn.tsc-btn-primary')].find((b) => b.textContent.trim() === 'Fertig');
  assert.ok(doneBtn, '"Fertig"-Button muss vorhanden sein');
  doneBtn.click();
  await tick(50);

  const putCall = calls.find((c) => c.method === 'PUT' && c.path === '/assignments/todo/t1');
  assert.ok(putCall, 'PUT-Aufruf zum Speichern der Zuordnung muss erfolgt sein');
  // JSON-Normalisierung noetig: putCall.body ist ein Objekt aus dem jsdom-
  // Realm (eigener globaler Object-Prototyp) - assert.deepEqual (strict)
  // scheitert sonst an der Prototyp-Identitaet, obwohl die Struktur identisch ist.
  assert.deepEqual(JSON.parse(JSON.stringify(putCall.body)), { contactIds: ['c1'] });

  const todos = getAppGlobal(window, 'todos');
  assert.equal(todos[0].contacts.length, 1);
  assert.equal(todos[0].contacts[0].contactId, 'c1');
  assert.equal(todos[0].contacts[0].name, 'Anna Müller');

  // Dialog muss nach "Fertig" geschlossen (aus dem DOM entfernt) sein.
  assert.equal(document.querySelector('.tsc-assignment-picker'), null);

  // Chip erscheint jetzt auf der Karte.
  const html = window.renderPersonalTodoCard(todos[0], false, {});
  assert.match(html, /Anna Müller/);
});

test('Host-Adapter: rt.initToolbar wird fuer dynamisch erzeugte Infoblock-Editoren aufgerufen', async () => {
  const { window, document } = loadApp();
  await tick();
  const contact = { id: 'c1', name: 'Anna', role: '', email: '', description: '', categories: [], infoBlockCount: 1, snippet: '' };
  const existingBlock = { id: 'b1', categoryId: null, bodyHtml: '<p>Bestand</p>', updatedAt: '2026-01-01T00:00:00.000Z' };
  setAppGlobal(window, 'contacts', [contact]);
  window.api = makeApiMock(baseContactApiRoutes(contact, { blocks: [existingBlock] }), []);

  const toolbarCalls = [];
  window.initRtToolbar = (tbId, editorId) => { toolbarCalls.push({ tbId, editorId }); };

  window.openContactModal('c1');
  await tick(50); // Promise.all(GET contact/categories/info-blocks) + renderAll + loadTopics/loadAssignments

  const host = document.getElementById('contact-detail-host');
  const addBtn = host.querySelector('[data-action="add-block"]');
  assert.ok(addBtn, '"+ Infoblock hinzufügen"-Button muss nach dem Laden sichtbar sein');
  addBtn.click();
  await tick(30); // rt.initToolbar()/rt.setRT() laufen ueber einen internen setTimeout(...,0)

  assert.equal(toolbarCalls.length, 1, 'initRtToolbar muss fuer den neu erzeugten Infoblock-Editor aufgerufen werden');
  const firstEditor = host.querySelector('[data-role="tsc-block-editor"] .rt-content');
  assert.ok(firstEditor, 'dynamischer Rich-Text-Editor fuer den Infoblock muss im DOM sein');
  assert.equal(toolbarCalls[0].editorId, firstEditor.id);
  assert.equal(toolbarCalls[0].tbId, firstEditor.id + '-tb');

  // Ersten Editor wieder schliessen und einen ZWEITEN, unterschiedlichen
  // Infoblock-Editor oeffnen (Bearbeiten eines bestehenden Blocks statt
  // Neuanlage) — deckt ab, dass initToolbar nicht nur fuer den allerersten,
  // sondern fuer JEDEN dynamisch erzeugten Editor mit jeweils eigener,
  // unterscheidbarer editorId aufgerufen wird.
  const cancelBtn = host.querySelector('[data-action="cancel-block"]');
  assert.ok(cancelBtn, '"Abbrechen"-Button des ersten Editors muss vorhanden sein');
  cancelBtn.click();

  const editBtn = host.querySelector('[data-action="edit-block"][data-block-id="b1"]');
  assert.ok(editBtn, 'Bearbeiten-Button fuer den bestehenden Infoblock muss vorhanden sein');
  editBtn.click();
  await tick(30);

  assert.equal(toolbarCalls.length, 2, 'initRtToolbar muss auch fuer den zweiten, spaeter geoeffneten Infoblock-Editor aufgerufen werden');
  const secondEditor = host.querySelector('[data-role="tsc-block-editor"] .rt-content');
  assert.ok(secondEditor, 'zweiter dynamischer Rich-Text-Editor muss im DOM sein');
  assert.equal(toolbarCalls[1].editorId, secondEditor.id);
  assert.equal(toolbarCalls[1].tbId, secondEditor.id + '-tb');
  assert.notEqual(toolbarCalls[0].editorId, toolbarCalls[1].editorId, 'beide Editoren muessen unterschiedliche editorId-Werte erhalten');
});

test('Host-Adapter: onClosed wird nach Schließen des Theme-Link-Dialogs aufgerufen (Zugeordnete Topics laedt neu)', async () => {
  const { window, document } = loadApp();
  await tick();
  const contact = { id: 'c1', name: 'Anna', role: '', email: '', description: '', categories: [], infoBlockCount: 0, snippet: '' };
  setAppGlobal(window, 'contacts', [contact]);
  setAppGlobal(window, 'themes', []);
  const calls = [];
  window.api = makeApiMock(baseContactApiRoutes(contact), calls);

  window.openContactModal('c1');
  await tick(50);

  const themesCallsBefore = calls.filter((c) => c.method === 'GET' && c.path === '/themes').length;
  assert.equal(themesCallsBefore, 1, 'loadTopics() muss beim initialen Laden genau einmal GET /themes aufrufen');

  const host = document.getElementById('contact-detail-host');
  const assignBtn = host.querySelector('[data-action="assign-topic"]');
  assert.ok(assignBtn, '"Topic zuweisen"-Button in Abschnitt "Zugeordnete Topics" muss vorhanden sein');
  assignBtn.click();

  assert.equal(document.getElementById('theme-link-modal').style.display, 'flex', 'Theme-Link-Dialog muss geoeffnet werden');

  window.closeThemeLinkModal();
  await tick(50);

  const themesCallsAfter = calls.filter((c) => c.method === 'GET' && c.path === '/themes').length;
  assert.equal(themesCallsAfter, themesCallsBefore + 1, 'onClosed() muss loadTopics() (GET /themes) erneut ausloesen');
  assert.equal(document.getElementById('theme-link-modal').style.display, 'none');
});

// Testlücke (Code-Review): der obige Test deckt nur den direkten Aufruf von
// closeThemeLinkModal() ab. onClosed() muss aber unabhängig davon, WIE der
// Nutzer den Dialog schließt, GENAU EINMAL feuern — jeder Schließweg (×,
// "Schließen"-Button, Overlay-Klick, Escape) läuft laut app.js letztlich
// über closeThemeLinkModal(), das wird hier je Weg einzeln nachgewiesen.
for (const [label, closeVia] of [
  ['ueber "×" (.modal-close)', (window, document) => document.querySelector('#theme-link-modal .modal-close').click()],
  ['ueber "Schließen" (.modal-footer .btn-secondary)', (window, document) => document.querySelector('#theme-link-modal .modal-footer .btn-secondary').click()],
  ['ueber Klick auf das Overlay-Element', (window, document) => {
    const overlay = document.getElementById('theme-link-modal');
    // `target` ist keine gueltige MouseEventInit-Option und wird ignoriert;
    // event.target === overlay ergibt sich bereits daraus, dass overlay
    // selbst das Dispatch-Ziel ist.
    overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }],
  ['ueber die Escape-Taste', (window, document) => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }],
]) {
  test(`Host-Adapter: onClosed feuert genau einmal beim Schließen des Theme-Link-Dialogs ${label}`, async () => {
    const { window, document } = loadApp();
    await tick();
    const contact = { id: 'c1', name: 'Anna', role: '', email: '', description: '', categories: [], infoBlockCount: 0, snippet: '' };
    setAppGlobal(window, 'contacts', [contact]);
    setAppGlobal(window, 'themes', []);
    const calls = [];
    window.api = makeApiMock(baseContactApiRoutes(contact), calls);

    window.openContactModal('c1');
    await tick(50);

    const themesCallsBefore = calls.filter((c) => c.method === 'GET' && c.path === '/themes').length;

    const host = document.getElementById('contact-detail-host');
    const assignBtn = host.querySelector('[data-action="assign-topic"]');
    assert.ok(assignBtn, '"Topic zuweisen"-Button in Abschnitt "Zugeordnete Topics" muss vorhanden sein');
    assignBtn.click();
    assert.equal(document.getElementById('theme-link-modal').style.display, 'flex', 'Theme-Link-Dialog muss geoeffnet werden');

    closeVia(window, document);
    await tick(50);

    const themesCallsAfter = calls.filter((c) => c.method === 'GET' && c.path === '/themes').length;
    assert.equal(themesCallsAfter, themesCallsBefore + 1, `onClosed() muss ${label} genau einmal GET /themes ausloesen`);
    assert.equal(document.getElementById('theme-link-modal').style.display, 'none');

    // Erneutes Schließen (z. B. durch nochmaliges Escape) darf onClosed
    // nicht ein zweites Mal fuer denselben Oeffnungsvorgang ausloesen —
    // themeLinkOnClosed wird beim Schließen zurueckgesetzt (siehe app.js).
    closeVia(window, document);
    await tick(50);
    const themesCallsFinal = calls.filter((c) => c.method === 'GET' && c.path === '/themes').length;
    assert.equal(themesCallsFinal, themesCallsAfter, 'onClosed() darf nach dem ersten Schließen nicht erneut feuern');
  });
}

test('closeContactModal() destroy()t die gemountete TSContacts-Detailansicht (kein Fehler beim erneuten Oeffnen eines anderen Kontakts)', async () => {
  const { window, document, jsdomErrors } = loadApp();
  await tick();
  const c1 = { id: 'c1', name: 'Anna', role: '', email: '', description: '', categories: [], infoBlockCount: 0, snippet: '' };
  const c2 = { id: 'c2', name: 'Bert', role: '', email: '', description: '', categories: [], infoBlockCount: 0, snippet: '' };
  setAppGlobal(window, 'contacts', [c1, c2]);
  window.api = makeApiMock([...baseContactApiRoutes(c1), ...baseContactApiRoutes(c2)], []);

  window.openContactModal('c1');
  await tick(50);
  window.closeContactModal();
  window.openContactModal('c2');
  await tick(50);

  assert.deepEqual(jsdomErrors, []);
  assert.equal(document.getElementById('contact-name').value, 'Bert');
});

test('Neuanlage eines Ansprechpartners: contact-detail-host zeigt Hinweis statt TSContacts.mountContactDetail (kein contactId vorhanden)', async () => {
  const { window, document } = loadApp();
  await tick();
  window.openContactModal();
  const host = document.getElementById('contact-detail-host');
  assert.match(host.innerHTML, /sobald der Ansprechpartner gespeichert wurde/);
});
