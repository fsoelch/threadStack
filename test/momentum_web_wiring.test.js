'use strict';
// Arbeitspaket M4 (Sichtbarer Fortschritt, Web-Integration index.html/app.js).
//
// Deckt: Asset-Einbindung (Reachability, BASE_PATH-Templating), den neuen
// Sidebar-Nav-Punkt "Fortschritt", den View-Dispatch (inkl. Fallback ohne
// geladenes TSMomentum) sowie die Erledigt-Moment-Anbindung in
// saveCompleteModal() - abwärtskompatibel (altes Verhalten bleibt exakt
// erhalten, wenn window.TSMomentum nicht verfügbar ist).
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

test('index.html referenziert momentum.css/js, keine Dev-Seite geleakt', () => {
  assert.match(RAW_INDEX_HTML, /<link rel="stylesheet" href="\/assets\/momentum\.css">/);
  assert.match(RAW_INDEX_HTML, /<script defer src="\/assets\/momentum\.js"><\/script>/);
  assert.doesNotMatch(RAW_INDEX_HTML, /momentum-dev\.html/);
});

test('Server: /assets/momentum.js und /assets/momentum.css sind erreichbar', async () => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  try {
    const js = await request(app).get('/assets/momentum.js');
    assert.equal(js.status, 200);
    const css = await request(app).get('/assets/momentum.css');
    assert.equal(css.status, 200);
  } finally {
    cleanup(dir);
  }
});

test('Server: mit BASE_PATH gesetzt trägt das ausgelieferte HTML das Präfix auch für momentum.css/js', async () => {
  const dir = setupEnv();
  process.env.BASE_PATH = '/notes';
  const { app } = loadServer(REPO_ROOT);
  try {
    const res = await request(app).get('/notes');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/notes\/assets\/momentum\.css"/);
    assert.match(res.text, /src="\/notes\/assets\/momentum\.js"/);
  } finally {
    cleanup(dir);
  }
});

test('Nav: "Fortschritt"-Eintrag ist vorhanden und selektierbar', async () => {
  const { window, document, jsdomErrors } = loadApp();
  await tick();
  setAppGlobal(window, 'todos', []);
  setAppGlobal(window, 'meetings', []);
  getAppGlobal(window, 'render')();
  const navHtml = document.getElementById('todos-nav').innerHTML;
  assert.match(navHtml, /Fortschritt/);
  assert.match(navHtml, /selectView\('__momentum__'\)/);
  assert.deepEqual(jsdomErrors, []);
});

test('renderMomentumView: zeigt Fallback-Hinweis, wenn TSMomentum nicht geladen ist (kein Crash)', async () => {
  const { window, document, jsdomErrors } = loadApp();
  await tick();
  setAppGlobal(window, 'selectedId', '__momentum__');
  getAppGlobal(window, 'renderMain')();
  const html = document.getElementById('main-content').innerHTML;
  assert.match(html, /Fortschritt-Modul konnte nicht geladen werden/);
  assert.deepEqual(jsdomErrors, []);
});

test('renderMomentumView: mountet ueber window.TSMomentum, wenn verfuegbar', async () => {
  const { window, document } = loadApp();
  await tick();
  const mountCalls = [];
  window.TSMomentum = { mount: (el) => { mountCalls.push(el); el.textContent = 'MOUNTED'; return { destroy() {} }; } };
  setAppGlobal(window, 'selectedId', '__momentum__');
  getAppGlobal(window, 'renderMain')();
  assert.equal(mountCalls.length, 1);
  assert.match(document.getElementById('momentum-root').innerHTML, /MOUNTED/);
});

test('saveCompleteModal: ohne TSMomentum bleibt das bisherige Verhalten (Toast "Als erledigt markiert") erhalten', async () => {
  const { window, document } = loadApp();
  await tick();
  const putCalls = [];
  window.fetch = (url, opts) => {
    putCalls.push({ url: String(url), opts });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }) });
  };
  setAppGlobal(window, 'todos', [{ id: 't1', title: 'A', done: false }]);
  setAppGlobal(window, 'completeTodoId', 't1');
  setAppGlobal(window, 'completeMid', null);
  setAppGlobal(window, 'completeTid', null);
  document.getElementById('c-result').innerHTML = '';
  document.getElementById('c-date').value = '2026-09-11';
  await getAppGlobal(window, 'saveCompleteModal')();
  assert.equal(putCalls.length, 1);
  const sentBody = JSON.parse(putCalls[0].opts.body);
  assert.equal(sentBody.utcOffsetMinutes, undefined);
  const toasts = document.querySelectorAll('#toast-container .toast');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].textContent, /Als erledigt markiert/);
});

test('saveCompleteModal: mit TSMomentum sendet utcOffsetMinutes und zeigt den Momentum-Toast statt des generischen', async () => {
  const { window, document } = loadApp();
  await tick();
  const shownMomentum = [];
  window.TSMomentum = {
    utcOffsetMinutes: () => 120,
    showCompletionToast: (m) => shownMomentum.push(m),
    fetchStreakBadge: async () => null,
  };
  window.fetch = (url, opts) => Promise.resolve({
    status: 200, ok: true,
    json: async () => ({ ok: true, momentum: { weeklyCompletedCount: 3, milestones: [] } }),
  });
  setAppGlobal(window, 'todos', [{ id: 't1', title: 'A', done: false }]);
  setAppGlobal(window, 'completeTodoId', 't1');
  setAppGlobal(window, 'completeMid', null);
  setAppGlobal(window, 'completeTid', null);
  document.getElementById('c-result').innerHTML = '';
  document.getElementById('c-date').value = '2026-09-11';
  await getAppGlobal(window, 'saveCompleteModal')();
  assert.deepEqual(shownMomentum, [{ weeklyCompletedCount: 3, milestones: [] }]);
  // Kein generischer Zusatz-Toast neben dem Momentum-Toast (siehe UX-Vorgabe:
  // hoechstens EIN Hinweis pro Aktion).
  const toasts = document.querySelectorAll('#toast-container .toast');
  assert.equal(toasts.length, 0);
});
