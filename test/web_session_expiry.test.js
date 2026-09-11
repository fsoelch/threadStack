'use strict';
// Arbeitspaket "Web: Sitzungs-Handling" (Story 2 — sichtbarer, sofortiger
// Wechsel zum Login-Screen bei Sitzungsende).
//
// Folgt exakt dem in test/web_todo_overview.test.js etablierten Muster:
// index.html wird per jsdom geladen ("runScripts: dangerously"), das externe
// <script src="/assets/app.js">-Tag wird vor dem Parsen durch ein Inline-
// <script> mit dem Dateiinhalt ersetzt (jsdom laedt externe Ressourcen sonst
// nur per echtem HTTP-Request, was dem hier bewusst deaktivierten Netzwerk
// widerspraeche). `window.fetch` wird je Test gezielt gemockt, um eine
// 401-Antwort zu simulieren.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX_HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const APP_JS_PATH     = path.resolve(__dirname, '..', 'public', 'app.js');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8')
  .replace('<script defer src="/assets/app.js"></script>',
    () => `<script>${fs.readFileSync(APP_JS_PATH, 'utf8')}</script>`);

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
  // Netzwerk in Tests bewusst deaktiviert per Default — einzelne Tests
  // ueberschreiben window.fetch gezielt, um eine 401-Antwort zu simulieren.
  window.fetch = () => Promise.reject(new Error('network disabled in tests'));
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  return { dom, window, document: window.document, jsdomErrors };
}

function tick(ms = 20) {
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

function jsonResponse(status, body = {}) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

test('showLogin() blendet den Sitzungsende-Hinweis nur mit expired:true ein', async () => {
  const { window, document } = loadApp();
  await tick();

  window.showLogin();
  assert.equal(document.getElementById('login-session-expired').style.display, 'none');

  window.showLogin({ expired: true });
  assert.equal(document.getElementById('login-session-expired').style.display, '');
  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('app').style.display, 'none');

  // Ein normaler, nicht-abgelaufener Aufruf (z.B. via doLogout) blendet den
  // Hinweis wieder aus, statt ihn "stehen zu lassen".
  window.showLogin();
  assert.equal(document.getElementById('login-session-expired').style.display, 'none');
});

test('closeAllModals() schliesst jedes offene .modal-overlay-Element', async () => {
  const { window, document } = loadApp();
  await tick();

  const modalIds = ['todo-modal', 'topic-modal', 'contact-modal'];
  for (const id of modalIds) {
    const el = document.getElementById(id);
    assert.ok(el, `${id} muss im Markup existieren`);
    el.style.display = 'flex';
  }

  window.closeAllModals();

  for (const id of modalIds) {
    assert.equal(document.getElementById(id).style.display, 'none');
  }
});

test('handleSessionExpiry() raeumt Client-State ab, schliesst offene Modals und zeigt den Login-Screen mit Hinweistext', async () => {
  const { window, document } = loadApp();
  await tick();

  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'alice', role: 'user' });
  setAppGlobal(window, 'todos', [{ id: 't1' }]);
  document.getElementById('todo-modal').style.display = 'flex';

  window.handleSessionExpiry();

  assert.equal(getAppGlobal(window, 'currentUser'), null, 'clearClientSessionState() muss gelaufen sein');
  // Cross-Realm-Array (jsdom-window) statt Node-Array — deepStrictEqual
  // scheitert an unterschiedlicher Array-Prototyp-Identitaet, .length ist
  // die stabile, realm-unabhaengige Pruefung fuer "leer".
  assert.equal(getAppGlobal(window, 'todos').length, 0);
  assert.equal(document.getElementById('todo-modal').style.display, 'none', 'offenes Modal muss geschlossen werden');
  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('app').style.display, 'none');
  assert.equal(document.getElementById('login-session-expired').style.display, '');
});

test('api() bei HTTP 401 loest handleSessionExpiry() aus (Login-Screen sichtbar, App verborgen, Hinweistext an)', async () => {
  const { window, document } = loadApp();
  await tick();

  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'alice', role: 'user' });
  document.getElementById('contact-modal').style.display = 'flex';
  window.fetch = () => jsonResponse(401);

  await assert.rejects(() => window.api('GET', '/todos'), /Sitzung abgelaufen/);

  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('app').style.display, 'none');
  assert.equal(document.getElementById('login-session-expired').style.display, '');
  assert.equal(document.getElementById('contact-modal').style.display, 'none');
  assert.equal(getAppGlobal(window, 'currentUser'), null);
});

test('linkApiFetch() bei HTTP 401 loest ebenfalls handleSessionExpiry() aus', async () => {
  const { window, document } = loadApp();
  await tick();

  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'alice', role: 'user' });
  window.fetch = () => jsonResponse(401);

  await assert.rejects(() => window.linkApiFetch('POST', '/ai/link/fetch', { url: 'https://example.com' }), /Sitzung abgelaufen/);

  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('login-session-expired').style.display, '');
});

test('uploadAttachment() bei HTTP 401 loest handleSessionExpiry() aus (vormalige Luecke ohne 401-Behandlung)', async () => {
  const { window, document } = loadApp();
  await tick();

  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'alice', role: 'user' });
  document.getElementById('todo-modal').style.display = 'flex';
  window.fetch = () => jsonResponse(401);

  const fakeFile = { name: 'foto.png', type: 'image/png' };
  await window.uploadAttachment('todo', 't1', fakeFile);
  await tick();

  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('todo-modal').style.display, 'none');
  assert.equal(document.getElementById('login-session-expired').style.display, '');
  assert.equal(getAppGlobal(window, 'currentUser'), null);
});

test('rtInsertImage() bei HTTP 401 loest ebenfalls handleSessionExpiry() aus (zweite vormalige Luecke, Wissenseditor-Bildupload)', async () => {
  const { window, document } = loadApp();
  await tick();

  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'alice', role: 'user' });
  window.setRtImageRef('editor1', 'knowledge', 'k1');

  let capturedInput = null;
  const origCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = (tag) => {
    const el = origCreateElement(tag);
    if (tag === 'input') capturedInput = el;
    return el;
  };
  window.fetch = () => jsonResponse(401);

  window.rtInsertImage('editor1');
  window.document.createElement = origCreateElement;

  assert.ok(capturedInput, 'rtInsertImage() muss ein <input type=file> erzeugen');
  Object.defineProperty(capturedInput, 'files', { value: [{ name: 'a.png', type: 'image/png' }], configurable: true });
  await capturedInput.onchange();
  await tick();

  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('login-session-expired').style.display, '');
  assert.equal(getAppGlobal(window, 'currentUser'), null);
});

test('doLogout() zeigt den Login-Screen OHNE den Sitzungsende-Hinweis (bewusster Unterschied zu handleSessionExpiry)', async () => {
  const { window, document } = loadApp();
  await tick();

  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'alice', role: 'user' });
  window.fetch = () => jsonResponse(200, { ok: true });

  await window.doLogout();

  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(document.getElementById('login-session-expired').style.display, 'none');
});
