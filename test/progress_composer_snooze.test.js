'use strict';
// "Schlafen bis"-Kurzoption im Zwischenstand-Composer (Story 2, UI-Fix
// Speichern-Button-Kontrast siehe test/progress_css_button_tokens.test.js).
//
// Deckt die progress.js-interne ComposerInstance/mountInlineComposer-Logik
// der neuen Kurzoption via jsdom ab (Teststil analog zu
// test/contacts_web_module.test.js: progress.js wird inline in ein jsdom-
// Fenster geladen, `onSnoozeSave` wird als reiner Spy injiziert - die
// eigentliche Persistenz/Endpunkt-Wahl testet stattdessen
// test/web_todo_overview.test.js, das die app.js-Verdrahtung
// (mountCardComposer/mountProgressArea -> saveComposerSnooze) prüft).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROGRESS_JS_PATH = path.resolve(__dirname, '..', 'public', 'progress.js');
const PROGRESS_SRC = fs.readFileSync(PROGRESS_JS_PATH, 'utf8');

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDom() {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const html = `<!DOCTYPE html><html><body>
    <div id="root"></div>
    <script>${PROGRESS_SRC}</script>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  window.TSHost = { api: () => Promise.reject(new Error('Netzwerk in diesem Test nicht erwartet')) };
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  return { window, document: window.document, jsdomErrors };
}

function mountComposer(window, container, opts) {
  return window.TSProgress.mountInlineComposer(container, opts);
}

test('Composer OHNE onSnoozeSave: rendert keine "Schlafen bis"-Kurzoption', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, { refType: 'todo', refId: 't1', openOnMount: true });
  assert.equal(root.querySelector('.progress-composer-snooze'), null);
});

test('Composer MIT onSnoozeSave, kein Datum gesetzt: zeigt eingeklappten, kleinen Trigger "Schlafen bis"', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, { refType: 'todo', refId: 't2', openOnMount: true, onSnoozeSave: () => Promise.resolve() });
  const toggle = root.querySelector('.progress-composer-snooze-toggle');
  assert.notEqual(toggle, null);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.match(toggle.textContent, /Schlafen bis/);
  assert.equal(root.querySelector('[data-role="composer-snooze-date"]'), null);
});

test('Composer MIT onSnoozeSave, Datum bereits gesetzt: Trigger zeigt das Datum an ("Schläft bis ...")', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, {
    refType: 'todo', refId: 't3', openOnMount: true, snoozedUntil: '2026-09-20',
    onSnoozeSave: () => Promise.resolve(),
  });
  const toggle = root.querySelector('.progress-composer-snooze-toggle');
  assert.match(toggle.textContent, /Schläft bis/);
});

test('Klick auf den Trigger klappt das Datumsfeld auf, erneuter Klick auf "schließen" wieder ein', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, { refType: 'todo', refId: 't4', openOnMount: true, onSnoozeSave: () => Promise.resolve() });

  root.querySelector('[data-action="toggle-snooze"]').click();
  assert.notEqual(root.querySelector('[data-role="composer-snooze-date"]'), null);
  assert.equal(root.querySelector('.progress-composer-snooze-toggle'), null);

  root.querySelector('[data-action="toggle-snooze"]').click();
  assert.equal(root.querySelector('[data-role="composer-snooze-date"]'), null);
  assert.notEqual(root.querySelector('.progress-composer-snooze-toggle'), null);
});

test('Datum im aufgeklappten Feld setzen speichert SOFORT ueber onSnoozeSave, unabhaengig vom Zwischenstand-Text', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  const calls = [];
  mountComposer(window, root, {
    refType: 'todo', refId: 't5', openOnMount: true,
    onSnoozeSave: (val) => { calls.push(val); return Promise.resolve(); },
  });
  root.querySelector('[data-action="toggle-snooze"]').click();

  const dateInput = root.querySelector('[data-role="composer-snooze-date"]');
  dateInput.value = '2026-09-25';
  dateInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  assert.deepEqual(calls, ['2026-09-25']);
  // Der Zwischenstand-Text (composer-text) wurde dabei nicht angefasst.
  assert.equal(root.querySelector('[data-role="composer-text"]').value, '');
});

test('Waehrend des Speicherns ist das Datumsfeld deaktiviert und ein Status "Speichert ..." sichtbar', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  let resolveSave;
  mountComposer(window, root, {
    refType: 'todo', refId: 't6', openOnMount: true,
    onSnoozeSave: () => new Promise((resolve) => { resolveSave = resolve; }),
  });
  root.querySelector('[data-action="toggle-snooze"]').click();
  const dateInput = root.querySelector('[data-role="composer-snooze-date"]');
  dateInput.value = '2026-09-26';
  dateInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  assert.equal(root.querySelector('[data-role="composer-snooze-date"]').disabled, true);
  assert.notEqual(root.querySelector('.progress-composer-snooze-status'), null);

  resolveSave();
  await tick();
  assert.equal(root.querySelector('[data-role="composer-snooze-date"]').disabled, false);
});

test('Fehler beim Speichern von "Schlafen bis" wird angezeigt, das Datumsfeld bleibt bedienbar', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, {
    refType: 'todo', refId: 't7', openOnMount: true,
    onSnoozeSave: () => { const e = new Error('boom'); e.status = 404; e.code = 'ref_not_found'; return Promise.reject(e); },
  });
  root.querySelector('[data-action="toggle-snooze"]').click();
  const dateInput = root.querySelector('[data-role="composer-snooze-date"]');
  dateInput.value = '2026-09-27';
  dateInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  const errEl = root.querySelector('.progress-composer-snooze .progress-error-text');
  assert.notEqual(errEl, null);
  assert.match(errEl.textContent, /gelöscht/);
  assert.equal(root.querySelector('[data-role="composer-snooze-date"]').disabled, false);
});

test('Fehler beim Speichern von "Schlafen bis" fuer ein Thema meldet die themenspezifische Formulierung', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, {
    refType: 'topic', refId: 'top1', openOnMount: true,
    onSnoozeSave: () => { const e = new Error('boom'); e.status = 404; e.code = 'ref_not_found'; return Promise.reject(e); },
  });
  root.querySelector('[data-action="toggle-snooze"]').click();
  const dateInput = root.querySelector('[data-role="composer-snooze-date"]');
  dateInput.value = '2026-09-27';
  dateInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  const errEl = root.querySelector('.progress-composer-snooze .progress-error-text');
  assert.match(errEl.textContent, /Thema wurde inzwischen gelöscht/);
});

test('"Schlafen bis" entfernen (X) ruft onSnoozeSave(null) auf und blendet den Entfernen-Knopf danach aus', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  const calls = [];
  mountComposer(window, root, {
    refType: 'todo', refId: 't8', openOnMount: true, snoozedUntil: '2026-09-20',
    onSnoozeSave: (val) => { calls.push(val); return Promise.resolve(); },
  });
  root.querySelector('[data-action="toggle-snooze"]').click();
  assert.notEqual(root.querySelector('[data-action="clear-snooze"]'), null);

  root.querySelector('[data-action="clear-snooze"]').click();
  await tick();

  assert.deepEqual(calls, [null]);
  assert.equal(root.querySelector('[data-action="clear-snooze"]'), null);
});

test('Erledigtes Todo (done=true) zeigt weder Zwischenstand-Composer noch "Schlafen bis"-Option', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  mountComposer(window, root, {
    refType: 'todo', refId: 't9', done: true, openOnMount: true,
    onSnoozeSave: () => Promise.resolve(),
  });
  assert.equal(root.querySelector('.progress-inline-composer').innerHTML, '');
});

test('destroy() entfernt den change-Listener (kein Speichern nach destroy)', async () => {
  const { window, document } = makeDom();
  const root = document.getElementById('root');
  const calls = [];
  const handle = mountComposer(window, root, {
    refType: 'todo', refId: 't10', openOnMount: true,
    onSnoozeSave: (val) => { calls.push(val); return Promise.resolve(); },
  });
  handle.destroy();
  assert.equal(root.innerHTML, '');
});
