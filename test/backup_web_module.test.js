'use strict';
// Arbeitspaket B3 (Backup/Restore, public/backup.js).
//
// Deckt reine Hilfsfunktionen (node-testbar über module.exports) sowie
// DOM-Verhalten via jsdom mit gemocktem window.TSHost ab - identisches
// Testmuster zu test/momentum_web_module.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BACKUP_JS_PATH = path.resolve(__dirname, '..', 'public', 'backup.js');
const BACKUP_SRC = fs.readFileSync(BACKUP_JS_PATH, 'utf8');

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================================================
// Reine Hilfsfunktionen (kein DOM nötig)
// ==========================================================================

const pure = require(BACKUP_JS_PATH);

test('formatBytes: skaliert B/KB/MB plausibel', () => {
  assert.equal(pure.formatBytes(0), '0 B');
  assert.equal(pure.formatBytes(500), '500 B');
  assert.equal(pure.formatBytes(2048), '2.0 KB');
  assert.equal(pure.formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('formatTimestamp: formatiert ISO-Datum als deutsches Datum + Uhrzeit', () => {
  assert.equal(pure.formatTimestamp('2026-09-12T03:04:05'), '12.09.2026 03:04 Uhr');
  assert.equal(pure.formatTimestamp(''), '');
  assert.equal(pure.formatTimestamp(null), '');
});

test('typeLabel: übersetzt bekannte Typen, unbekannte bleiben unverändert', () => {
  assert.equal(pure.typeLabel('manual'), 'manuell');
  assert.equal(pure.typeLabel('auto'), 'automatisch');
  assert.equal(pure.typeLabel('prerestore'), 'vor Restore');
  assert.equal(pure.typeLabel('sonstiges'), 'sonstiges');
});

test('describeNextRun: null wenn deaktiviert, sonst heute/morgen + Uhrzeit', () => {
  assert.equal(pure.describeNextRun({ enabled: false, hour: 3 }), null);
  const result = pure.describeNextRun({ enabled: true, hour: 3 });
  assert.match(result, /^(heute|morgen), 03:00 Uhr$/);
});

test('downloadUrl: nutzt window.__TS_BASE__ als Präfix, kodiert Dateinamen', () => {
  global.__TS_BASE__ = '/notes';
  assert.equal(pure.downloadUrl('backup-manual-20260912-030000.sqlite'), '/notes/api/backup/backup-manual-20260912-030000.sqlite/download');
  delete global.__TS_BASE__;
});

test('renderBackupList: Leertext ohne Einträge, Liste mit Badges sonst', () => {
  global.TSHost = { escHtml: (s) => String(s) };
  assert.match(pure.renderBackupList([]), /Noch keine Backups vorhanden/);
  const html = pure.renderBackupList([{ filename: 'backup-manual-20260912-030000.sqlite', type: 'manual', createdAt: '2026-09-12T03:00:00', sizeBytes: 1024 }]);
  assert.match(html, /manuell/);
  assert.match(html, /12\.09\.2026 03:00 Uhr/);
  assert.match(html, /data-backup-restore="backup-manual-20260912-030000\.sqlite"/);
  assert.match(html, /data-backup-delete="backup-manual-20260912-030000\.sqlite"/);
});

// ==========================================================================
// DOM-Verhalten via jsdom
// ==========================================================================

function makeDom(router, hostOverrides) {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const html = `<!DOCTYPE html><html><body>
    <div id="root"></div>
    <script>${BACKUP_SRC}</script>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  window.__TS_BASE__ = '';
  const calls = [];
  const toasts = [];
  const confirmResponses = [];
  let forceLogoutCalls = 0;
  const uploadCalls = [];
  window.TSHost = {
    api: function (method, urlPath, body) {
      const bodyObj = body == null ? undefined : JSON.parse(JSON.stringify(body));
      const call = { url: urlPath, method, body: bodyObj };
      calls.push(call);
      let result;
      try {
        result = router(method, urlPath, bodyObj, call);
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(result).then((r) => {
        if (r.status >= 200 && r.status < 300) return r.body === undefined ? {} : r.body;
        const err = new Error((r.body && r.body.error) || 'Fehler');
        err.status = r.status;
        err.code = r.body && r.body.code;
        err.body = r.body || {};
        throw err;
      });
    },
    uploadRaw: function (urlPath, file) {
      uploadCalls.push({ url: urlPath, file });
      if (hostOverrides && hostOverrides.uploadRaw) return hostOverrides.uploadRaw(urlPath, file);
      return Promise.resolve({ ok: true, sessionsInvalidated: true, preRestoreBackup: 'backup-prerestore-x.sqlite' });
    },
    toast: (msg, type) => toasts.push({ msg, type }),
    escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    confirm: () => Promise.resolve(confirmResponses.length ? confirmResponses.shift() : true),
    forceLogout: () => { forceLogoutCalls += 1; },
  };
  return {
    dom, window, document: window.document, calls, toasts, jsdomErrors, confirmResponses,
    uploadCalls, getForceLogoutCalls: () => forceLogoutCalls,
  };
}

const DEFAULT_SETTINGS = { enabled: false, hour: 3, retentionCount: 14, updatedAt: null };
const SAMPLE_BACKUPS = [
  { filename: 'backup-manual-20260912-030000.sqlite', type: 'manual', createdAt: '2026-09-12T03:00:00', sizeBytes: 1024 },
];

function defaultRouter(settings = DEFAULT_SETTINGS, backups = SAMPLE_BACKUPS) {
  let currentSettings = { ...settings };
  let currentBackups = backups.slice();
  return (method, urlPath, body) => {
    if (method === 'GET' && urlPath === '/backup/settings') return { status: 200, body: currentSettings };
    if (method === 'PUT' && urlPath === '/backup/settings') {
      currentSettings = { ...currentSettings, ...body, updatedAt: 'now' };
      return { status: 200, body: currentSettings };
    }
    if (method === 'GET' && urlPath === '/backup/') return { status: 200, body: { backups: currentBackups } };
    if (method === 'POST' && urlPath === '/backup/') {
      const created = { filename: 'backup-manual-20260101-000000.sqlite', type: 'manual', createdAt: '2026-01-01T00:00:00', sizeBytes: 999 };
      currentBackups = [created, ...currentBackups];
      return { status: 201, body: { backup: created } };
    }
    if (method === 'DELETE' && urlPath.startsWith('/backup/')) {
      const filename = decodeURIComponent(urlPath.replace('/backup/', ''));
      currentBackups = currentBackups.filter((b) => b.filename !== filename);
      return { status: 200, body: { ok: true } };
    }
    if (method === 'POST' && urlPath.endsWith('/restore')) {
      return { status: 200, body: { ok: true, sessionsInvalidated: true, preRestoreBackup: 'backup-prerestore-x.sqlite' } };
    }
    return { status: 404, body: { error: 'unbekannt' } };
  };
}

test('mount: rendert Zeitplan, Liste und Upload-Bereich', async (t) => {
  const { window, document } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /Automatisches Backup/);
  assert.match(el.innerHTML, /manuell/);
  assert.match(el.innerHTML, /Aus Datei wiederherstellen/);
});

test('mount: Leerzustand ohne vorhandene Backups', async (t) => {
  const { window, document } = makeDom(defaultRouter(DEFAULT_SETTINGS, []));
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /Noch keine Backups vorhanden/);
});

test('mount: Fehlerzustand mit Retry-Button bei fehlgeschlagenem Laden', async (t) => {
  let attempts = 0;
  const router = (method, urlPath) => {
    if (method === 'GET' && urlPath === '/backup/settings') {
      attempts += 1;
      if (attempts === 1) return { status: 500, body: { error: 'kaputt' } };
      return { status: 200, body: DEFAULT_SETTINGS };
    }
    if (method === 'GET' && urlPath === '/backup/') return { status: 200, body: { backups: [] } };
    return { status: 404, body: {} };
  };
  const { window, document } = makeDom(router);
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /konnten nicht geladen werden/);
  const retryBtn = el.querySelector('[data-backup-retry]');
  assert.ok(retryBtn);
  retryBtn.click();
  await tick(50);
  assert.match(el.innerHTML, /Noch keine Backups vorhanden/);
});

test('mount: Zeitplan-Checkbox aktivieren schaltet Uhrzeit/Aufbewahrung frei', async (t) => {
  const { window, document } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  const checkbox = el.querySelector('[data-backup-field="enabled"]');
  const hourSelect = el.querySelector('[data-backup-field="hour"]');
  assert.ok(hourSelect.disabled);
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(!hourSelect.disabled);
});

test('mount: Zeitplan speichern ruft PUT /backup/settings mit den Formularwerten', async (t) => {
  const { window, document, calls } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  el.querySelector('[data-backup-field="enabled"]').checked = true;
  el.querySelector('[data-backup-field="hour"]').value = '7';
  el.querySelector('[data-backup-field="retentionCount"]').value = '30';
  const form = el.querySelector('[data-backup-settings-form]');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(50);
  const putCall = calls.find((c) => c.method === 'PUT' && c.url === '/backup/settings');
  assert.ok(putCall);
  assert.deepEqual(putCall.body, { enabled: true, hour: 7, retentionCount: 30 });
});

test('mount: Zeitplan-Validierungsfehler zeigt Serverfehlermeldung im Formular', async (t) => {
  const router = (method, urlPath) => {
    if (method === 'GET' && urlPath === '/backup/settings') return { status: 200, body: DEFAULT_SETTINGS };
    if (method === 'GET' && urlPath === '/backup/') return { status: 200, body: { backups: [] } };
    if (method === 'PUT' && urlPath === '/backup/settings') return { status: 400, body: { error: 'Uhrzeit muss zwischen 0 und 23 liegen.', code: 'VALIDATION_FAILED' } };
    return { status: 404, body: {} };
  };
  const { window, document } = makeDom(router);
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  const form = el.querySelector('[data-backup-settings-form]');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(50);
  const errEl = el.querySelector('[data-backup-settings-error]');
  assert.match(errEl.textContent, /Uhrzeit muss zwischen 0 und 23/);
  assert.notEqual(errEl.style.display, 'none');
});

test('mount: "Backup jetzt erstellen" ruft POST /backup/ und lädt die Liste neu', async (t) => {
  const { window, document, calls, toasts } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  el.querySelector('[data-backup-create]').click();
  await tick(50);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/backup/'));
  assert.ok(toasts.some((t2) => t2.msg === 'Backup erstellt'));
  assert.match(el.innerHTML, /backup-manual-20260101-000000\.sqlite|01\.01\.2026/);
});

test('mount: Löschen fragt per confirm nach und ruft dann DELETE', async (t) => {
  const { window, document, calls } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  el.querySelector('[data-backup-delete]').click();
  await tick(50);
  assert.ok(calls.some((c) => c.method === 'DELETE'));
  assert.match(el.innerHTML, /Noch keine Backups vorhanden/);
});

test('mount: Löschen bricht ab, wenn confirm() false liefert', async (t) => {
  const { window, document, calls, confirmResponses } = makeDom(defaultRouter());
  t.after(() => window.close());
  confirmResponses.push(false);
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  el.querySelector('[data-backup-delete]').click();
  await tick(50);
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
});

test('mount: Wiederherstellen fragt per confirm nach, ruft POST .../restore und meldet ab', async (t) => {
  const { window, document, calls, toasts, getForceLogoutCalls } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  el.querySelector('[data-backup-restore]').click();
  await tick(50);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/restore')));
  assert.ok(toasts.some((t2) => /abgemeldet/.test(t2.msg)));
  await tick(1300);
  assert.equal(getForceLogoutCalls(), 1);
});

test('mount: Wiederherstellen-Fehler zeigt Toast, kein forceLogout', async (t) => {
  const router = (method, urlPath) => {
    if (method === 'GET' && urlPath === '/backup/settings') return { status: 200, body: DEFAULT_SETTINGS };
    if (method === 'GET' && urlPath === '/backup/') return { status: 200, body: { backups: SAMPLE_BACKUPS } };
    if (method === 'POST' && urlPath.endsWith('/restore')) return { status: 422, body: { error: 'Diese Datei ist keine gültige ThreadStack-Sicherung oder ist beschädigt.', code: 'RESTORE_VALIDATION_FAILED' } };
    return { status: 404, body: {} };
  };
  const { window, document, toasts, getForceLogoutCalls } = makeDom(router);
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  el.querySelector('[data-backup-restore]').click();
  await tick(50);
  assert.ok(toasts.some((t2) => t2.type === 'error' && /gültige ThreadStack-Sicherung/.test(t2.msg)));
  assert.equal(getForceLogoutCalls(), 0);
});

test('mount: Upload-Button ist erst nach Dateiauswahl aktiv, Upload löst uploadRaw + Abmeldung aus', async (t) => {
  const { window, document, uploadCalls, getForceLogoutCalls } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  const input = el.querySelector('[data-backup-upload-input]');
  const btn = el.querySelector('[data-backup-upload-restore]');
  assert.ok(btn.disabled);

  const file = new window.File(['sqlite-inhalt'], 'meine-sicherung.sqlite', { type: 'application/octet-stream' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(!btn.disabled);

  btn.click();
  await tick(50);
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].url, '/backup/restore-upload');
  assert.equal(uploadCalls[0].file.name, 'meine-sicherung.sqlite');
  await tick(1300);
  assert.equal(getForceLogoutCalls(), 1);
});

test('mount: Upload-Fehler zeigt Meldung im Upload-Bereich, kein forceLogout', async (t) => {
  const { window, document, getForceLogoutCalls } = makeDom(defaultRouter(), {
    uploadRaw: () => Promise.reject(Object.assign(new Error('Ungültige Backup-Datei.'), { code: 'RESTORE_VALIDATION_FAILED' })),
  });
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSBackup.mount(el);
  await tick(50);
  const input = el.querySelector('[data-backup-upload-input]');
  const btn = el.querySelector('[data-backup-upload-restore]');
  const file = new window.File(['x'], 'kaputt.sqlite', { type: 'application/octet-stream' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  btn.click();
  await tick(50);
  const errEl = el.querySelector('[data-backup-upload-error]');
  assert.match(errEl.textContent, /Ungültige Backup-Datei/);
  assert.equal(getForceLogoutCalls(), 0);
});
