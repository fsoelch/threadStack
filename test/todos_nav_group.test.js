'use strict';
// Arbeitspaket "Einklappbare Zusatzfunktionen in der ToDos-Navigation" (Web).
//
// Deckt zwei Ebenen ab, analog zum bestehenden Test-Zuschnitt in diesem
// Projekt (siehe test/archive_web_helpers.test.js für den VM-Sandbox-Ansatz
// und test/momentum_web_wiring.test.js für den jsdom-Integrationsansatz):
//
// 1. Reine Entscheidungslogik (NAV_MORE_GROUP_PURE_HELPERS_START/_END) —
//    ohne DOM/localStorage, per VM-Sandbox aus public/app.js extrahiert.
// 2. Tatsächliches Rendering von renderTodosNav() inkl. localStorage-
//    Persistenz und Auto-Aufklappen bei aktivem gruppiertem Punkt — per
//    jsdom (index.html + app.js), da hierfür ein echtes DOM/window.localStorage
//    benötigt wird.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

function loadNavMoreGroupPureHelpers() {
  const jsPath = path.join(__dirname, '..', 'public', 'app.js');
  const src = fs.readFileSync(jsPath, 'utf8');
  const startMarker = '// ---- NAV_MORE_GROUP_PURE_HELPERS_START';
  const endMarker = '// ---- NAV_MORE_GROUP_PURE_HELPERS_END';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('NAV_MORE_GROUP_PURE_HELPERS_START/_END-Marker nicht (mehr) in public/app.js gefunden — Test kann die Funktionen nicht extrahieren.');
  }
  const snippet = src.slice(startIdx, endIdx);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox, { filename: 'public/app.js#nav-more-group-pure-helpers' });
  return sandbox;
}

const { isTodosNavMoreGroupActive, todosNavMoreGroupHasNotice, TODOS_NAV_MORE_GROUP_IDS } = loadNavMoreGroupPureHelpers();

test('isTodosNavMoreGroupActive: erkennt alle 5 gruppierten View-IDs als aktiv', () => {
  for (const id of TODOS_NAV_MORE_GROUP_IDS) {
    assert.equal(isTodosNavMoreGroupActive(id), true, `${id} sollte die Gruppe aktivieren`);
  }
});

test('isTodosNavMoreGroupActive: "Meine Todos" und "null" aktivieren die Gruppe NICHT', () => {
  assert.equal(isTodosNavMoreGroupActive('__todos__'), false);
  assert.equal(isTodosNavMoreGroupActive(null), false);
  assert.equal(isTodosNavMoreGroupActive(undefined), false);
});

test('todosNavMoreGroupHasNotice: true bei Stack-Tiefe > 0 oder Streak-Wert', () => {
  assert.equal(todosNavMoreGroupHasNotice(0, null), false);
  assert.equal(todosNavMoreGroupHasNotice(2, null), true);
  assert.equal(todosNavMoreGroupHasNotice(0, 5), true);
  assert.equal(todosNavMoreGroupHasNotice(0, 0), false);
});

// ── jsdom-Integrationstests ──────────────────────────────────────────────

const INDEX_HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const APP_JS_PATH     = path.resolve(__dirname, '..', 'public', 'app.js');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8')
  .replace('<script defer src="/assets/app.js"></script>',
    () => `<script>${fs.readFileSync(APP_JS_PATH, 'utf8')}</script>`);

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function setAppGlobal(window, name, value) {
  window.__testTmp__ = value;
  window.eval(`${name} = window.__testTmp__;`);
  delete window.__testTmp__;
}
function getAppGlobal(window, name) {
  return window.eval(name);
}
function loadApp() {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('network disabled in tests'));
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  return { dom, window, document: window.document, jsdomErrors };
}

test('renderTodosNav: Gruppe ist standardmaessig eingeklappt, alle 5 Punkte bleiben im Markup', async () => {
  const { window, document, jsdomErrors } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', []);
  setAppGlobal(window, 'meetings', []);
  getAppGlobal(window, 'render')();
  const navHtml = document.getElementById('todos-nav').innerHTML;
  assert.match(navHtml, /todo-nav-group-header/);
  assert.match(navHtml, /aria-expanded="false"/);
  assert.match(navHtml, /collapsed/);
  for (const label of ['Tagesabschluss', 'Stack-Historie', 'Wochen-Digest', 'Fortschritt', 'Archiv']) {
    assert.match(navHtml, new RegExp(label));
  }
  // Bestehende onclick-Handler der einzelnen Punkte bleiben unveraendert
  // (Vertrag: bestehende Wiring-Tests wie momentum_web_wiring.test.js duerfen
  // nicht brechen).
  assert.match(navHtml, /selectView\('__momentum__'\)/);
  assert.deepEqual(jsdomErrors, []);
});

test('renderTodosNav: Klick auf Gruppenkopf klappt auf und persistiert in localStorage', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', []);
  setAppGlobal(window, 'meetings', []);
  getAppGlobal(window, 'render')();
  getAppGlobal(window, 'toggleTodosNavMore')();
  const navHtml = document.getElementById('todos-nav').innerHTML;
  assert.match(navHtml, /aria-expanded="true"/);
  assert.doesNotMatch(navHtml, /todo-nav-group-items collapsed/);
  assert.equal(window.localStorage.getItem('ts.nav.moreExpanded'), '1');
});

test('renderTodosNav: aktiver gruppierter Punkt (z.B. nach Reload) klappt automatisch auf, auch ohne gespeicherten Zustand', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', []);
  setAppGlobal(window, 'meetings', []);
  setAppGlobal(window, 'selectedId', '__archive__');
  getAppGlobal(window, 'renderTodosNav')();
  const navHtml = document.getElementById('todos-nav').innerHTML;
  assert.match(navHtml, /aria-expanded="true"/);
  assert.equal(window.localStorage.getItem('ts.nav.moreExpanded'), null, 'Erzwungenes Aufklappen darf die Nutzerpraeferenz nicht ueberschreiben');
});

test('renderTodosNav: zeigt Hinweis-Punkt am eingeklappten Gruppenkopf, wenn Stack-Tiefe > 0', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', []);
  setAppGlobal(window, 'meetings', []);
  setAppGlobal(window, 'stackState', { frames: [], depth: 3 });
  getAppGlobal(window, 'renderTodosNav')();
  const navHtml = document.getElementById('todos-nav').innerHTML;
  assert.match(navHtml, /todo-nav-group-dot/);
});

test('renderTodosNav: kein Hinweis-Punkt, wenn nichts Neues vorliegt', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', []);
  setAppGlobal(window, 'meetings', []);
  getAppGlobal(window, 'render')();
  const navHtml = document.getElementById('todos-nav').innerHTML;
  assert.doesNotMatch(navHtml, /todo-nav-group-dot/);
});
