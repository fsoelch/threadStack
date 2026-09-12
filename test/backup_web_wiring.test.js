'use strict';
// Arbeitspaket B3 (Backup/Restore, Web-Integration index.html/app.js).
//
// Deckt: Asset-Einbindung (Reachability, BASE_PATH-Templating), den neuen
// Admin-Menüpunkt "Datensicherung" (Sichtbarkeit nach Rolle), das
// Öffnen/Schließen des Backup-Panels (mount/destroy von window.TSBackup)
// sowie die neuen TSHost-Erweiterungen (confirm mit danger/focus, uploadRaw,
// forceLogout) - Testmuster identisch zu test/momentum_web_wiring.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');
const { setupEnv, loadServer, cleanup, REPO_ROOT } = require('./helpers');

const INDEX_HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const APP_JS_PATH     = path.resolve(__dirname, '..', 'public', 'app.js');
const RAW_INDEX_HTML  = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const INDEX_HTML = RAW_INDEX_HTML
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

test('index.html referenziert backup.css/js', () => {
  assert.match(RAW_INDEX_HTML, /<link rel="stylesheet" href="\/assets\/backup\.css">/);
  assert.match(RAW_INDEX_HTML, /<script defer src="\/assets\/backup\.js"><\/script>/);
});

test('Server: /assets/backup.js und /assets/backup.css sind erreichbar', async () => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  try {
    const js = await request(app).get('/assets/backup.js');
    assert.equal(js.status, 200);
    const css = await request(app).get('/assets/backup.css');
    assert.equal(css.status, 200);
  } finally {
    cleanup(dir);
  }
});

test('Server: mit BASE_PATH gesetzt trägt das ausgelieferte HTML das Präfix auch für backup.css/js', async () => {
  const dir = setupEnv();
  process.env.BASE_PATH = '/notes';
  const { app } = loadServer(REPO_ROOT);
  try {
    const res = await request(app).get('/notes');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/notes\/assets\/backup\.css"/);
    assert.match(res.text, /src="\/notes\/assets\/backup\.js"/);
  } finally {
    cleanup(dir);
  }
});

test('showApp(): Admin sieht den Menüpunkt "Datensicherung", normaler Nutzer nicht', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'admin', role: 'admin' });
  getAppGlobal(window, 'showApp')();
  assert.equal(document.getElementById('user-menu-backup').style.display, '');

  setAppGlobal(window, 'currentUser', { id: 'u2', username: 'bob', role: 'user' });
  getAppGlobal(window, 'showApp')();
  assert.equal(document.getElementById('user-menu-backup').style.display, 'none');
});

test('openBackupPanel(): zeigt das Modal und mountet window.TSBackup', async () => {
  const { window, document } = loadApp();
  await tick();
  const mountCalls = [];
  window.TSBackup = { mount: (el) => { mountCalls.push(el); el.textContent = 'MOUNTED'; return { destroy() {} }; } };
  getAppGlobal(window, 'openBackupPanel')();
  assert.equal(document.getElementById('backup-modal').style.display, 'flex');
  assert.equal(mountCalls.length, 1);
  assert.match(document.getElementById('backup-panel-host').innerHTML, /MOUNTED/);
});

test('openBackupPanel(): ohne geladenes TSBackup zeigt Fallback-Hinweis statt Crash', async () => {
  const { window, document, jsdomErrors } = loadApp();
  await tick();
  getAppGlobal(window, 'openBackupPanel')();
  assert.match(document.getElementById('backup-panel-host').innerHTML, /konnte nicht geladen werden/);
  assert.deepEqual(jsdomErrors, []);
});

test('closeBackupPanel(): versteckt das Modal und destroy()t das TSBackup-Handle', async () => {
  const { window, document } = loadApp();
  await tick();
  let destroyed = false;
  window.TSBackup = { mount: () => ({ destroy: () => { destroyed = true; } }) };
  getAppGlobal(window, 'openBackupPanel')();
  getAppGlobal(window, 'closeBackupPanel')();
  assert.equal(document.getElementById('backup-modal').style.display, 'none');
  assert.equal(destroyed, true);
});

test('openBackupPanel(): erneutes Öffnen destroy()t das vorherige Handle, bevor neu gemountet wird', async () => {
  const { window, document } = loadApp();
  await tick();
  let destroyCount = 0;
  window.TSBackup = { mount: () => ({ destroy: () => { destroyCount += 1; } }) };
  getAppGlobal(window, 'openBackupPanel')();
  getAppGlobal(window, 'openBackupPanel')();
  assert.equal(destroyCount, 1);
});

test('overlayClick auf backup-modal-Hintergrund läuft über closeBackupPanel() (destroy statt blindes Ausblenden)', async () => {
  const { window, document } = loadApp();
  await tick();
  let destroyed = false;
  window.TSBackup = { mount: () => ({ destroy: () => { destroyed = true; } }) };
  getAppGlobal(window, 'openBackupPanel')();
  const overlay = document.getElementById('backup-modal');
  getAppGlobal(window, 'overlayClick')({ target: overlay }, 'backup-modal');
  assert.equal(overlay.style.display, 'none');
  assert.equal(destroyed, true);
});

test('TSHost.confirm: reicht danger/focus an genericConfirm weiter', async () => {
  const { window, document } = loadApp();
  await tick();
  const confirmPromise = window.TSHost.confirm({
    title: 'Datenbank wiederherstellen?', message: 'Achtung.',
    confirmLabel: 'Wiederherstellen', cancelLabel: 'Abbrechen', danger: true, focus: 'cancel',
  });
  const confirmBtn = document.querySelector('#confirm-dialog .confirm-actions').children[1];
  assert.match(confirmBtn.className, /btn-danger/);
  confirmBtn.click();
  assert.equal(await confirmPromise, true);
});

test('TSHost.forceLogout: löst denselben Sitzungsende-Screen wie handleSessionExpiry() aus', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'admin', role: 'admin' });
  window.TSHost.forceLogout();
  assert.equal(document.getElementById('app').style.display, 'none');
  assert.equal(document.getElementById('login-screen').style.display, 'flex');
  assert.equal(getAppGlobal(window, 'currentUser'), null);
});

test('TSHost.uploadRaw: POSTed rohen Datei-Body an den angegebenen Pfad, 401 löst handleSessionExpiry() aus', async () => {
  const { window, document } = loadApp();
  await tick();
  setAppGlobal(window, 'currentUser', { id: 'u1', username: 'admin', role: 'admin' });
  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ status: 401, ok: false, json: async () => ({}) });
  };
  const file = new window.File(['x'], 'a.sqlite', { type: 'application/octet-stream' });
  await assert.rejects(window.TSHost.uploadRaw('/backup/restore-upload', file));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/backup\/restore-upload$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(document.getElementById('login-screen').style.display, 'flex');
});
