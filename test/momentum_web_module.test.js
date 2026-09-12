'use strict';
// Arbeitspaket M3 (Sichtbarer Fortschritt, public/momentum.js).
//
// Deckt reine Hilfsfunktionen (node-testbar über module.exports) sowie
// DOM-Verhalten via jsdom mit gemocktem window.TSHost.api ab - identisches
// Testmuster zu test/contacts_web_module.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const MOMENTUM_JS_PATH = path.resolve(__dirname, '..', 'public', 'momentum.js');
const MOMENTUM_SRC = fs.readFileSync(MOMENTUM_JS_PATH, 'utf8');

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================================================
// Reine Hilfsfunktionen (kein DOM nötig)
// ==========================================================================

const pure = require(MOMENTUM_JS_PATH);

test('utcOffsetMinutes/todayStr: liefern plausible, node-testbare Werte', () => {
  assert.equal(typeof pure.utcOffsetMinutes(), 'number');
  assert.match(pure.todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});

test('renderStreakCard: leer bei null, enthaelt Zahl+Hinweis sonst', () => {
  global.TSHost = { escHtml: (s) => String(s) };
  assert.equal(pure.renderStreakCard(null), '');
  const html = pure.renderStreakCard({ current: 3, activeToday: true });
  assert.match(html, /3 Tage/);
  assert.match(html, /Heute schon aktiv/);
  const htmlInactive = pure.renderStreakCard({ current: 1, activeToday: false });
  assert.match(htmlInactive, /1 Tag(?!e)/);
  assert.match(htmlInactive, /noch keine Aktivität/);
});

test('renderWeekCard: Leerzustand ohne Meilensteine, Liste mit Meilensteinen', () => {
  global.TSHost = { escHtml: (s) => String(s) };
  assert.equal(pure.renderWeekCard(null), '');
  const empty = pure.renderWeekCard({ createdCount: 2, completedCount: 1, milestones: [] });
  assert.match(empty, /noch keine vollständig/);
  assert.match(empty, />2</);
  assert.match(empty, />1</);
  const withMilestones = pure.renderWeekCard({
    createdCount: 0, completedCount: 3,
    milestones: [{ type: 'topic', name: 'Serverumzug' }, { type: 'contact', name: 'Frau Meyer' }],
  });
  assert.match(withMilestones, /Thema „Serverumzug"/);
  assert.match(withMilestones, /Kontakt „Frau Meyer"/);
});

test('renderPauseDaysList: Leertext ohne Eintraege, Chips mit Entfernen-Button sonst', () => {
  global.TSHost = { escHtml: (s) => String(s) };
  assert.match(pure.renderPauseDaysList([]), /Keine Pausentage geplant/);
  const html = pure.renderPauseDaysList(['2026-12-24']);
  assert.match(html, /2026-12-24/);
  assert.match(html, /data-momentum-remove-pause="2026-12-24"/);
});

test('showCompletionToast: ohne Meilensteine zeigt Wochenzaehler-Text', () => {
  const calls = [];
  global.TSHost = { escHtml: (s) => String(s), toast: (msg, type) => calls.push({ msg, type }) };
  pure.showCompletionToast({ weeklyCompletedCount: 5, milestones: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].msg, /diese Woche: 5/);
});

test('showCompletionToast: mit Meilensteinen zeigt pro Meilenstein einen deutlicheren Toast', () => {
  const calls = [];
  global.TSHost = { escHtml: (s) => String(s), toast: (msg, type) => calls.push({ msg, type }) };
  pure.showCompletionToast({
    weeklyCompletedCount: 2,
    milestones: [{ type: 'topic', name: 'Serverumzug' }, { type: 'contact', name: 'Frau Meyer' }],
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].msg, /Thema „Serverumzug" ist jetzt komplett abgeschlossen/);
  assert.match(calls[1].msg, /Bei „Frau Meyer" ist jetzt alles erledigt/);
  assert.equal(calls[0].type, 'success');
});

test('showCompletionToast: ohne momentum-Objekt tut nichts', () => {
  const calls = [];
  global.TSHost = { escHtml: (s) => String(s), toast: (msg) => calls.push(msg) };
  pure.showCompletionToast(null);
  assert.equal(calls.length, 0);
});

// ==========================================================================
// DOM-Verhalten via jsdom
// ==========================================================================

function makeDom(router) {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const html = `<!DOCTYPE html><html><body>
    <div id="root"></div>
    <script>${MOMENTUM_SRC}</script>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  const calls = [];
  const toasts = [];
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
        err.body = r.body || {};
        throw err;
      });
    },
    toast: (msg, type) => toasts.push({ msg, type }),
    escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  return { dom, window, document: window.document, calls, toasts, jsdomErrors };
}

const DEFAULT_OVERVIEW = {
  settings: { completionToastEnabled: true, streakEnabled: true, weeklyReviewEnabled: true },
  streak: { current: 4, activeToday: true },
  week: { startDate: '2026-09-07', endDate: '2026-09-13', createdCount: 3, completedCount: 2, milestones: [] },
};

function defaultRouter(overview = DEFAULT_OVERVIEW, pauseDays = []) {
  let currentPauseDays = pauseDays.slice();
  return (method, urlPath) => {
    if (method === 'GET' && urlPath.startsWith('/momentum/overview')) return { status: 200, body: overview };
    if (method === 'GET' && urlPath === '/momentum/pause-days') return { status: 200, body: { pauseDays: currentPauseDays } };
    if (method === 'POST' && urlPath.startsWith('/momentum/pause-days')) return { status: 201, body: { date: '2026-12-24' } };
    if (method === 'DELETE' && urlPath.startsWith('/momentum/pause-days/')) return { status: 200, body: { ok: true, removed: true } };
    if (method === 'PUT' && urlPath === '/momentum/settings') return { status: 200, body: overview.settings };
    return { status: 404, body: { error: 'unbekannt' } };
  };
}

test('mount: rendert Serie- und Wochenkarte inkl. Einstellungen', async (t) => {
  const { window, document } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSMomentum.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /4 Tage/);
  assert.match(el.innerHTML, />3</); // createdCount
  assert.match(el.innerHTML, />2</); // completedCount
  assert.ok(el.querySelectorAll('[data-momentum-setting]').length === 3);
});

test('mount: Leerzustand, wenn Serie UND Woche deaktiviert sind (streak/week=null)', async (t) => {
  const overview = { settings: { completionToastEnabled: false, streakEnabled: false, weeklyReviewEnabled: false }, streak: null, week: null };
  const { window, document } = makeDom(defaultRouter(overview));
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSMomentum.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /Der Fortschritt-Bereich ist deaktiviert/);
});

test('mount: Fehlerzustand mit Retry-Button bei fehlgeschlagenem Laden', async (t) => {
  let attempts = 0;
  const router = (method, urlPath) => {
    if (method === 'GET' && urlPath.startsWith('/momentum/overview')) {
      attempts += 1;
      if (attempts === 1) return { status: 500, body: { error: 'kaputt' } };
      return { status: 200, body: DEFAULT_OVERVIEW };
    }
    if (method === 'GET' && urlPath === '/momentum/pause-days') return { status: 200, body: { pauseDays: [] } };
    return { status: 404, body: {} };
  };
  const { window, document } = makeDom(router);
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSMomentum.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /konnten nicht geladen werden/);
  const retryBtn = el.querySelector('[data-momentum-retry]');
  assert.ok(retryBtn);
  retryBtn.click();
  await tick(50);
  assert.match(el.innerHTML, /4 Tage/);
});

test('mount: Einstellungs-Checkbox toggeln ruft PUT /momentum/settings mit dem richtigen Feld', async (t) => {
  const { window, document, calls } = makeDom(defaultRouter());
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSMomentum.mount(el);
  await tick(50);
  const checkbox = el.querySelector('[data-momentum-setting="streakEnabled"]');
  assert.ok(checkbox.checked);
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(50);
  const putCall = calls.find((c) => c.method === 'PUT' && c.url === '/momentum/settings');
  assert.ok(putCall);
  assert.deepEqual(putCall.body, { streakEnabled: false });
});

test('mount: Pausentag hinzufuegen und wieder entfernen aktualisiert die Liste', async (t) => {
  const { window, document, calls } = makeDom(defaultRouter(DEFAULT_OVERVIEW, []));
  t.after(() => window.close());
  const el = document.getElementById('root');
  window.TSMomentum.mount(el);
  await tick(50);
  assert.match(el.innerHTML, /Keine Pausentage geplant/);

  const form = el.querySelector('[data-momentum-pause-form]');
  const input = form.querySelector('input[name="date"]');
  input.value = '2026-12-24';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(50);
  const postCall = calls.find((c) => c.method === 'POST' && c.url.startsWith('/momentum/pause-days'));
  assert.ok(postCall);
  assert.deepEqual(postCall.body, { date: '2026-12-24' });
});
