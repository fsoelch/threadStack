'use strict';
// Arbeitspaket W1 (Ansprechpartner/Kontakte-Erweiterung, public/contacts.js).
//
// Deckt window.TSContacts ab: reine Hilfsfunktionen (node-testbar über
// module.exports) sowie DOM-Verhalten via jsdom mit gemocktem globalem
// `fetch` (kein echter Server, siehe Arbeitspaketauftrag). Zusätzlich ein
// Regressionstest für die additive Erweiterung in public/progress.js
// (showNextStep), damit bestehendes Verhalten für todo/topic unverändert
// bleibt und die neue Kontakt-Variante nachweislich funktioniert.
//
// Teststil analog zu test/web_todo_overview.test.js: jsdom mit
// `runScripts:"dangerously"`, Netzwerk ausschließlich über einen
// konfigurierbaren fetch-Mock (keine echten Requests).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROGRESS_JS_PATH = path.resolve(__dirname, '..', 'public', 'progress.js');
const CONTACTS_JS_PATH = path.resolve(__dirname, '..', 'public', 'contacts.js');
const PROGRESS_SRC = fs.readFileSync(PROGRESS_JS_PATH, 'utf8');
const CONTACTS_SRC = fs.readFileSync(CONTACTS_JS_PATH, 'utf8');

const contactsPure = require(CONTACTS_JS_PATH);
const progressPure = require(PROGRESS_JS_PATH);

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body === undefined ? {} : body),
  };
}

/**
 * Baut ein jsdom-Fenster mit progress.js + contacts.js inline geladen und
 * einem konfigurierbaren fetch-Mock. `router(method, urlPath, bodyObj, call)`
 * gibt entweder ein Response-Objekt ({status, body}) oder ein Promise darauf
 * zurück; wirft er, wird das als Netzwerkfehler propagiert.
 */
function makeDom(router) {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const html = `<!DOCTYPE html><html><body>
    <div id="root"></div>
    <script>${PROGRESS_SRC}</script>
    <script>${CONTACTS_SRC}</script>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    let bodyObj;
    if (opts && opts.body != null) {
      try { bodyObj = JSON.parse(opts.body); } catch (e) { bodyObj = opts.body; }
    }
    const call = { url, method, body: bodyObj };
    calls.push(call);
    let result;
    try {
      result = router(method, url, bodyObj, call);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(result).then((r) => fakeResponse(r.status, r.body));
  };
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  return { dom, window, document: window.document, calls, jsdomErrors };
}

function makeRtAdapter(window) {
  return {
    setRT(id, val) {
      const e = window.document.getElementById(id);
      if (e) e.innerHTML = val || '';
    },
    getRT(id) {
      const e = window.document.getElementById(id);
      return e ? e.innerHTML : '';
    },
  };
}

function defaultAdapters(window, overrides) {
  const base = {
    onContactChanged: () => {},
    onNavigate: () => {},
    onError: () => {},
    rt: makeRtAdapter(window),
    openThemeLinkModal: () => {},
    confirm: () => Promise.resolve(true),
    toast: () => {},
  };
  return Object.assign(base, overrides || {});
}

// ==========================================================================
// Reine Hilfsfunktionen (node-testbar, kein DOM nötig)
// ==========================================================================

test('contactBadgesHtml: liefert "" ohne Rubriken/Snippet', () => {
  assert.equal(contactsPure.contactBadgesHtml(null), '');
  assert.equal(contactsPure.contactBadgesHtml({}), '');
  assert.equal(contactsPure.contactBadgesHtml({ categories: [], snippet: '' }), '');
});

test('contactBadgesHtml: Icon+Text-Badges, max. maxBadges + "+n"-Kürzung mit title/aria-label', () => {
  const contact = {
    categories: [
      { id: 'c1', label: 'Vertrieb' },
      { id: 'c2', label: 'Technik' },
      { id: 'c3', label: 'Finanzen' },
      { id: 'c4', label: 'Recht' },
      { id: 'c5', label: 'Extra' },
    ],
    snippet: 'Kurzer Auszug',
  };
  const html = contactsPure.contactBadgesHtml(contact, { maxBadges: 4 });
  assert.match(html, /Vertrieb/);
  assert.match(html, /Technik/);
  assert.match(html, /Finanzen/);
  assert.match(html, /Recht/);
  assert.doesNotMatch(html, />Extra</);
  assert.match(html, /tsc-badge-more/);
  assert.match(html, /\+1</);
  assert.match(html, /title="Extra"/);
  assert.match(html, /aria-label="Weitere Rubriken: Extra"/);
  assert.match(html, /🏷️/);
  assert.match(html, /Kurzer Auszug/);
});

test('contactBadgesHtml: "Privates" erscheint als Badge mit Schloss-Icon, nie als Textauszug', () => {
  const contact = { categories: [{ id: 'p1', label: 'Privates', isPrivate: true }], snippet: 'Geheimer Text' };
  const html = contactsPure.contactBadgesHtml(contact);
  assert.match(html, /🔒/);
  assert.match(html, /Privates/);
  assert.doesNotMatch(html, /Geheimer Text/);
});

test('contactBadgesHtml: escaped gegen XSS (Rubrik-Label und Snippet)', () => {
  const contact = {
    categories: [{ id: 'c1', label: '<img src=x onerror=alert(1)>' }],
    snippet: '<script>alert(2)</script>',
  };
  const html = contactsPure.contactBadgesHtml(contact);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test('assignedContactsHtml: "" ohne Kontakte, sonst Chips mit Name/Rolle, escaped', () => {
  assert.equal(contactsPure.assignedContactsHtml([]), '');
  assert.equal(contactsPure.assignedContactsHtml(null), '');
  const html = contactsPure.assignedContactsHtml([{ id: '1', name: 'Anna <b>M.</b>', role: 'PM' }]);
  assert.match(html, /Anna &lt;b&gt;M\.&lt;\/b&gt;/);
  assert.match(html, /PM/);
  assert.match(html, /👤/);
});

test('assignedContactsHtml: onClickAttr wird pro Kontakt eingefügt', () => {
  const html = contactsPure.assignedContactsHtml([{ id: 'x1', name: 'Bob' }], {
    onClickAttr: (c) => `data-id="${c.id}"`,
  });
  assert.match(html, /data-id="x1"/);
});

// ==========================================================================
// progress.js — Regressionstest + showNextStep-Erweiterung (W1)
// ==========================================================================

test('progress.js: isValidRefType akzeptiert jetzt auch "contact" (Erweiterung, node-testbar)', () => {
  assert.equal(progressPure.isValidRefType('contact'), true);
  assert.equal(progressPure.isValidRefType('todo'), true);
  assert.equal(progressPure.isValidRefType('topic'), true);
  assert.equal(progressPure.isValidRefType('theme'), false);
});

function progressDetail(refType, refId, overrides) {
  return Object.assign({
    ref: { type: refType, id: refId, exists: true },
    nextStep: 'Etwas tun',
    entries: [],
    page: { limit: 20, hasMore: false, nextCursor: null },
  }, overrides || {});
}

function mountHostMock(window, detailByKey) {
  window.TSHost = {
    api: (method, urlPath) => {
      if (method !== 'GET') return Promise.reject(new Error('nicht unterstützt im Mock'));
      const m = urlPath.match(/^\/api\/progress\/([^/]+)\/([^/?]+)/);
      if (!m) return Promise.reject(new Error('unbekannter Pfad'));
      const key = m[1] + ':' + m[2];
      const detail = detailByKey[key];
      if (!detail) return Promise.reject(Object.assign(new Error('nicht gefunden'), { status: 404 }));
      return Promise.resolve(JSON.parse(JSON.stringify(detail)));
    },
    toast: () => {},
    confirm: () => Promise.resolve(true),
    progress: {},
  };
}

test('progress.js Regression: mountTimeline zeigt "Nächster Schritt" für refType=todo unveraendert', async () => {
  const { window, document } = makeDom(() => ({ status: 200, body: {} }));
  mountHostMock(window, { 'todo:t1': progressDetail('todo', 't1', { nextStep: 'Rueckmeldung einholen' }) });
  const root = document.getElementById('root');
  const handle = window.TSProgress.mountTimeline(root, { refType: 'todo', refId: 't1' });
  await tick(50);
  assert.match(root.textContent, /Nächster Schritt/);
  assert.match(root.textContent, /Rueckmeldung einholen/);
  handle.destroy();
});

test('progress.js Erweiterung: mountTimeline unterdrückt "Nächster Schritt" automatisch für refType=contact', async () => {
  const { window, document } = makeDom(() => ({ status: 200, body: {} }));
  mountHostMock(window, { 'contact:k1': progressDetail('contact', 'k1', { nextStep: '' }) });
  const root = document.getElementById('root');
  const handle = window.TSProgress.mountTimeline(root, { refType: 'contact', refId: 'k1' });
  await tick(50);
  assert.doesNotMatch(root.textContent, /Nächster Schritt/);
  handle.destroy();
});

test('progress.js: showNextStep kann explizit überschrieben werden (true für contact, false für todo)', async () => {
  const { window, document } = makeDom(() => ({ status: 200, body: {} }));
  mountHostMock(window, {
    'contact:k2': progressDetail('contact', 'k2', { nextStep: 'x' }),
    'todo:t2': progressDetail('todo', 't2', { nextStep: 'y' }),
  });
  const root1 = document.createElement('div'); document.body.appendChild(root1);
  const h1 = window.TSProgress.mountTimeline(root1, { refType: 'contact', refId: 'k2', showNextStep: true });
  await tick(50);
  assert.match(root1.textContent, /Nächster Schritt/);
  h1.destroy();

  const root2 = document.createElement('div'); document.body.appendChild(root2);
  const h2 = window.TSProgress.mountTimeline(root2, { refType: 'todo', refId: 't2', showNextStep: false });
  await tick(50);
  assert.doesNotMatch(root2.textContent, /Nächster Schritt/);
  h2.destroy();
});

// ==========================================================================
// mountContactDetail — Grundgerüst, Abschnittsreihenfolge, Ladezustände
// ==========================================================================

function baseContact(overrides) {
  return Object.assign({
    id: 'c1', name: 'Anna Müller', role: 'PM', email: 'a@example.com',
    description: '', categories: [], infoBlockCount: 0, snippet: '',
  }, overrides || {});
}

function stubProgressModule(window) {
  // contacts.js delegiert Notizen vollständig an TSProgress — dessen eigenes
  // Netzwerkverhalten (window.TSHost) ist nicht Gegenstand dieses
  // Arbeitspakets. Für die contacts.js-eigenen Tests wird TSProgress daher
  // durch Spies ersetzt, um reine Delegation nachzuweisen, ohne die interne
  // progress.js-Logik erneut mitzutesten (das leistet bereits
  // test/progress_web_helpers.test.js).
  const composerCalls = [];
  const timelineCalls = [];
  window.TSProgress.mountInlineComposer = (container, opts) => {
    composerCalls.push(opts);
    return { destroy: () => {} };
  };
  window.TSProgress.mountTimeline = (container, opts) => {
    timelineCalls.push(opts);
    return { destroy: () => {}, reload: () => {} };
  };
  return { composerCalls, timelineCalls };
}

function standardRouter({ contact, categories, blocks, themes, assignments } = {}) {
  contact = contact || baseContact();
  categories = categories || [];
  blocks = blocks || [];
  themes = themes || [];
  assignments = assignments || [];
  return (method, url) => {
    if (method === 'GET' && /^\/api\/contacts\/[^/]+$/.test(url)) return { status: 200, body: contact };
    if (method === 'GET' && url === '/api/contact-categories') return { status: 200, body: categories };
    if (method === 'GET' && /\/info-blocks$/.test(url)) return { status: 200, body: blocks };
    if (method === 'GET' && url === '/api/themes') return { status: 200, body: themes };
    if (method === 'GET' && /\/assignments/.test(url)) return { status: 200, body: assignments };
    return { status: 404, body: { error: 'Nicht gefunden', code: 'not_found' } };
  };
}

test('mountContactDetail: rendert alle vier Abschnitte in der vorgegebenen Reihenfolge', async () => {
  const { window, document } = makeDom(standardRouter());
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  const titles = Array.from(root.querySelectorAll('.tsc-section-title')).map((e) => e.textContent);
  assert.deepEqual(titles, ['Zusatzinformationen', 'Notizen', 'Zugeordnete Topics', 'Ist zuständig für']);
  handle.destroy();
});

test('mountContactDetail: Notizen werden über TSProgress mit refType=contact und showNextStep:false gemountet', async () => {
  const { window, document } = makeDom(standardRouter());
  const spies = stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.equal(spies.composerCalls.length, 1);
  assert.equal(spies.composerCalls[0].refType, 'contact');
  assert.equal(spies.composerCalls[0].refId, 'c1');
  assert.equal(spies.timelineCalls.length, 1);
  assert.equal(spies.timelineCalls[0].refType, 'contact');
  assert.equal(spies.timelineCalls[0].showNextStep, false);
  handle.destroy();
});

test('mountContactDetail: leere Zusatzinformationen zeigen Leerzustand-Hinweis', async () => {
  const { window, document } = makeDom(standardRouter());
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.match(root.textContent, /Noch keine Zusatzinformationen erfasst\./);
  handle.destroy();
});

test('mountContactDetail: Kontakt-Ladefehler zeigt Fehlerbox mit "Erneut versuchen"', async () => {
  let fail = true;
  const { window, document } = makeDom((method, url) => {
    if (method === 'GET' && /^\/api\/contacts\/[^/]+$/.test(url) && fail) {
      return { status: 500, body: { error: 'Serverfehler', code: 'internal' } };
    }
    return standardRouter()(method, url);
  });
  stubProgressModule(window);
  const onError = () => {};
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window, { onError }) });
  await tick(50);
  assert.match(root.textContent, /Das hat leider nicht geklappt/);
  fail = false;
  const retryBtn = root.querySelector('.tsc-error-box button');
  assert.ok(retryBtn);
  retryBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  assert.doesNotMatch(root.textContent, /Das hat leider nicht geklappt/);
  handle.destroy();
});

test('mountContactDetail: "Privates"-Rubrik ist als <details> standardmäßig eingeklappt', async () => {
  const categories = [{ id: 'p1', label: 'Privates', isPrivate: true }];
  const blocks = [{ id: 'b1', categoryId: 'p1', bodyHtml: '<p>Geheim</p>', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const { window, document } = makeDom(standardRouter({ categories, blocks }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  const details = root.querySelector('details.tsc-category-private');
  assert.ok(details);
  assert.equal(details.hasAttribute('open'), false);
  assert.match(details.querySelector('summary').textContent, /🔒 Privates \(1\)/);
  handle.destroy();
});

// ==========================================================================
// Rubrik-Combobox: Duplikat-Erkennung case-/trim-insensitiv, "neu anlegen"
// ==========================================================================

test('Rubrik-Combobox: Freitext ohne Treffer zeigt "Neue Rubrik anlegen"-Option', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const { window, document } = makeDom(standardRouter({ categories }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="add-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const input = root.querySelector('.tsc-combobox-input');
  assert.ok(input);
  input.value = 'Ganz Neue Rubrik';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  const options = Array.from(root.querySelectorAll('.tsc-combobox-option'));
  assert.ok(options.some((o) => /Neue Rubrik „Ganz Neue Rubrik" anlegen/.test(o.textContent)));
  handle.destroy();
});

test('Rubrik-Combobox: Duplikat case-/trim-insensitiv erkannt (keine "neu anlegen"-Option, keine neue Rubrik-POST beim Speichern)', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const { window, document, calls } = makeDom(standardRouter({ categories }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="add-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const input = root.querySelector('.tsc-combobox-input');
  input.value = '  vertrieb  ';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  const options = Array.from(root.querySelectorAll('.tsc-combobox-option'));
  assert.equal(options.some((o) => /anlegen/.test(o.textContent)), false);
  assert.equal(options.length, 1);
  // Auswahl per Klick auf die (einzige) bestehende Option.
  options[0].dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  await tick(10);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Neuer Inhalt</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  const postCategoryCalls = calls.filter((c) => c.method === 'POST' && c.url === '/api/contact-categories');
  assert.equal(postCategoryCalls.length, 0);
  const postBlockCalls = calls.filter((c) => c.method === 'POST' && /\/info-blocks$/.test(c.url));
  assert.equal(postBlockCalls.length, 1);
  assert.equal(postBlockCalls[0].body.categoryId, 'cat1');
  handle.destroy();
});

// ==========================================================================
// Reorder (↑/↓) + aria-live-Ansage
// ==========================================================================

test('Infoblock-Reorder: Klick auf "↑" verschiebt Block, sendet PUT reorder und kündigt Position per aria-live an', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const blocks = [
    { id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Erster</p>', updatedAt: 't1' },
    { id: 'b2', categoryId: 'cat1', bodyHtml: '<p>Zweiter</p>', updatedAt: 't2' },
  ];
  const router = (method, url) => {
    if (method === 'PUT' && /\/info-blocks\/reorder$/.test(url)) return { status: 200, body: { ok: true } };
    return standardRouter({ categories, blocks })(method, url);
  };
  const { window, document, calls } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  const upButtons = root.querySelectorAll('[data-action="move-up"]');
  assert.equal(upButtons.length, 2);
  upButtons[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  const liveRegion = root.querySelector('[aria-live="polite"]');
  assert.match(liveRegion.textContent, /An Position 1 von 2 verschoben\./);
  const reorderCalls = calls.filter((c) => c.method === 'PUT' && /reorder$/.test(c.url));
  assert.equal(reorderCalls.length, 1);
  assert.deepEqual(reorderCalls[0].body.order, ['b2', 'b1']);
  handle.destroy();
});

test('Infoblock-Reorder: ↑-Button des ersten Blocks ist deaktiviert, aber weiterhin im DOM (Screenreader)', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const blocks = [
    { id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Erster</p>', updatedAt: 't1' },
    { id: 'b2', categoryId: 'cat1', bodyHtml: '<p>Zweiter</p>', updatedAt: 't2' },
  ];
  const { window, document } = makeDom(standardRouter({ categories, blocks }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  const upButtons = root.querySelectorAll('[data-action="move-up"]');
  assert.equal(upButtons[0].disabled, true);
  assert.equal(upButtons[0].getAttribute('aria-label'), 'Infoblock nach oben verschieben');
  handle.destroy();
});

// ==========================================================================
// Konfliktfall beim Speichern (409 block_conflict)
// ==========================================================================

test('Infoblock-Konflikt (409 block_conflict): Banner mit drei Buttons, Editor bleibt mit eigener Eingabe offen', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const blocks = [{ id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Alt</p>', updatedAt: 't1' }];
  const serverBlock = { id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Von anderswo geändert</p>', updatedAt: 't2' };
  let putAttempts = 0;
  const router = (method, url) => {
    if (method === 'PUT' && /\/info-blocks\/b1$/.test(url)) {
      putAttempts++;
      if (putAttempts === 1) {
        return { status: 409, body: { error: 'Konflikt', code: 'block_conflict', block: serverBlock } };
      }
      return { status: 200, body: serverBlock };
    }
    if (method === 'GET' && /\/info-blocks$/.test(url)) return { status: 200, body: [serverBlock] };
    return standardRouter({ categories, blocks })(method, url);
  };
  const { window, document, calls } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="edit-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Meine Änderung</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);

  assert.match(root.textContent, /wurde inzwischen von anderer Stelle geändert/);
  const viewBtn = root.querySelector('[data-action="conflict-view"]');
  const mineBtn = root.querySelector('[data-action="conflict-mine"]');
  const discardBtn = root.querySelector('[data-action="conflict-discard"]');
  assert.ok(viewBtn && mineBtn && discardBtn);

  // Eigene Eingabe bleibt im Editor sichtbar (nicht durch den Serverstand
  // überschrieben) — der Editor-Container existiert weiterhin.
  assert.ok(root.querySelector('[data-role="tsc-block-editor"]'));

  viewBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.match(root.textContent, /Von anderswo geändert/);

  // Nach dem Re-Render (view-server-Toggle) wurde der Editor neu erzeugt —
  // die ursprüngliche mineBtn-Referenz ist jetzt vom Dokument getrennt,
  // daher erneut aus dem aktuellen DOM abfragen.
  root.querySelector('[data-action="conflict-mine"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(putAttempts, 2);
  const putBodies = calls.filter((c) => c.method === 'PUT' && /\/info-blocks\/b1$/.test(c.url)).map((c) => c.body);
  assert.equal(putBodies[1].bodyHtml, '<p>Meine Änderung</p>');
  handle.destroy();
});

test('Infoblock-Konflikt: "Verwerfen und neu laden" lädt Serverstand und schließt Editor', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const blocks = [{ id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Alt</p>', updatedAt: 't1' }];
  const serverBlock = { id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Serverstand</p>', updatedAt: 't2' };
  let putAttempts = 0;
  const router = (method, url) => {
    if (method === 'PUT' && /\/info-blocks\/b1$/.test(url)) {
      putAttempts++;
      return { status: 409, body: { error: 'Konflikt', code: 'block_conflict', block: serverBlock } };
    }
    if (method === 'GET' && /\/info-blocks$/.test(url)) return { status: 200, body: [serverBlock] };
    return standardRouter({ categories, blocks })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="edit-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Meine Änderung</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  root.querySelector('[data-action="conflict-discard"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(putAttempts, 1);
  assert.equal(root.querySelector('[data-role="tsc-block-editor"]'), null);
  assert.match(root.textContent, /Serverstand/);
  handle.destroy();
});

// ==========================================================================
// Zugeordnete Topics / Ist zuständig für — Leer-/Fehlerzustände
// ==========================================================================

test('Zugeordnete Topics: Leerzustand-Text, Chip mit ×-Button bei vorhandener Verknüpfung', async () => {
  const themes = [{ id: 'th1', title: 'Projekt X', links: [{ id: 'l1', refType: 'contact', refId: 'c1' }] }];
  const { window, document } = makeDom(standardRouter({ themes }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.match(root.textContent, /Projekt X/);
  assert.ok(root.querySelector('[data-action="remove-topic"]'));
  handle.destroy();
});

test('Zugeordnete Topics: Leerzustand ohne Verknüpfungen', async () => {
  const { window, document } = makeDom(standardRouter());
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.match(root.textContent, /Noch keinem Topic zugeordnet\./);
  handle.destroy();
});

test('Ist zuständig für: Leerzustand, Fehlerzustand mit Retry, Typ-Badge/Meeting-Label', async () => {
  const { window, document } = makeDom(standardRouter());
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.match(root.textContent, /Diesem Kontakt ist aktuell kein Vorhaben zugeordnet\./);
  handle.destroy();

  let fail = true;
  const assignments = [{ refType: 'topic', refId: 'th1', title: 'Kickoff', done: false, meetingLabel: 'Montagsrunde' }];
  const { window: w2, document: d2 } = makeDom((method, url) => {
    if (method === 'GET' && /\/assignments/.test(url) && fail) return { status: 500, body: { error: 'x', code: 'internal' } };
    return standardRouter({ assignments })(method, url);
  });
  stubProgressModule(w2);
  const root2 = d2.getElementById('root');
  const h2 = w2.TSContacts.mountContactDetail(root2, { contactId: 'c1', ...defaultAdapters(w2) });
  await tick(50);
  assert.match(root2.textContent, /Zuständigkeiten konnten nicht geladen werden\./);
  fail = false;
  root2.querySelector('.tsc-error-box button').dispatchEvent(new w2.Event('click', { bubbles: true }));
  await tick(50);
  assert.match(root2.textContent, /Kickoff/);
  assert.match(root2.textContent, /Thema/);
  assert.match(root2.textContent, /Montagsrunde/);
  h2.destroy();
});

// ==========================================================================
// openAssignmentPicker
// ==========================================================================

function makeContacts(n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push({ id: 'k' + i, name: 'Kontakt ' + i, role: i % 2 === 0 ? 'Einkauf' : 'Vertrieb' });
  return list;
}

test('openAssignmentPicker: Leerzustand ohne Kontakte', () => {
  const { window, document } = makeDom(() => ({ status: 200, body: [] }));
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts: [] });
  const dialog = document.querySelector('.tsc-modal');
  assert.match(dialog.textContent, /Noch keine Ansprechpartner vorhanden/);
});

test('openAssignmentPicker: Titel/Kontextzeile, Suche filtert, Limit von 20 deaktiviert weitere Checkboxen', async () => {
  const contacts = makeContacts(25);
  const { window, document } = makeDom(() => ({ status: 200, body: [] }));
  window.TSContacts.openAssignmentPicker({ refType: 'topic', refId: 'th1', title: 'Migration', contacts });
  await tick(20);
  const dialog = document.querySelector('.tsc-modal');
  assert.match(dialog.textContent, /Für „Migration" \(Thema\)/);

  const search = dialog.querySelector('.tsc-picker-search');
  search.value = 'Kontakt 1';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const rowsAfterSearch = dialog.querySelectorAll('.tsc-picker-row');
  // "Kontakt 1" matcht "Kontakt 1","Kontakt 10".."Kontakt 19" (substring).
  assert.ok(rowsAfterSearch.length > 0 && rowsAfterSearch.length < 25);

  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const checkboxes = Array.from(dialog.querySelectorAll('.tsc-picker-row input[type="checkbox"]'));
  assert.equal(checkboxes.length, 25);
  for (let i = 0; i < 20; i++) {
    checkboxes[i].checked = true;
    checkboxes[i].dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  const countEl = dialog.querySelector('.tsc-picker-count');
  assert.match(countEl.textContent, /20 \/ 20 ausgewählt/);
  const remainingUnchecked = Array.from(dialog.querySelectorAll('.tsc-picker-row input[type="checkbox"]')).filter((cb) => !cb.checked);
  assert.equal(remainingUnchecked.length, 5);
  remainingUnchecked.forEach((cb) => {
    assert.equal(cb.disabled, true);
    assert.equal(cb.getAttribute('aria-disabled'), 'true');
    assert.equal(cb.title, 'Maximal 20 Ansprechpartner pro Vorhaben.');
  });
});

test('openAssignmentPicker: "Fertig" speichert via PUT und ruft onChanged mit ausgewählten Kontakten auf', async () => {
  const contacts = makeContacts(3);
  const calls = [];
  const { window, document } = makeDom((method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { status: 200, body: [] };
    return { status: 200, body: { ok: true } };
  });
  let changedWith = null;
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: 'Angebot', contacts,
    onChanged: (assigned) => { changedWith = assigned; },
  });
  await tick(20);
  const dialog = document.querySelector('.tsc-modal');
  const cb0 = dialog.querySelectorAll('input[type="checkbox"]')[0];
  cb0.checked = true;
  cb0.dispatchEvent(new window.Event('change', { bubbles: true }));
  const buttons = Array.from(dialog.querySelectorAll('button'));
  const doneBtn = buttons.filter((b) => b.textContent === 'Fertig')[0];
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  const putCall = calls.filter((c) => c.method === 'PUT')[0];
  assert.ok(putCall);
  assert.deepEqual(putCall.body.contactIds, ['k0']);
  assert.equal(changedWith.length, 1);
  assert.equal(changedWith[0].id, 'k0');
  assert.equal(document.querySelector('.tsc-modal-overlay'), null);
});

test('openAssignmentPicker: Speicherfehler zeigt Toast, Dialog bleibt offen mit erhaltener Auswahl', async () => {
  const contacts = makeContacts(3);
  const { window, document } = makeDom((method) => {
    if (method === 'GET') return { status: 200, body: [] };
    return { status: 500, body: { error: 'Serverfehler', code: 'internal' } };
  });
  let toastMsg = null;
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: 'Angebot', contacts,
    toast: (msg) => { toastMsg = msg; },
  });
  await tick(20);
  const dialog = document.querySelector('.tsc-modal');
  const cb0 = dialog.querySelectorAll('input[type="checkbox"]')[0];
  cb0.checked = true;
  cb0.dispatchEvent(new window.Event('change', { bubbles: true }));
  const doneBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Fertig')[0];
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(toastMsg, 'Zuordnung konnte nicht gespeichert werden.');
  assert.ok(document.querySelector('.tsc-modal-overlay'));
  const cbStillChecked = document.querySelectorAll('input[type="checkbox"]')[0];
  assert.equal(cbStillChecked.checked, true);
});

test('openAssignmentPicker: Escape schließt den Dialog und stellt Fokus wieder her', async () => {
  const contacts = makeContacts(2);
  const { window, document } = makeDom(() => ({ status: 200, body: [] }));
  const trigger = document.createElement('button');
  trigger.textContent = 'Öffnen';
  document.body.appendChild(trigger);
  trigger.focus();
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(20);
  assert.ok(document.querySelector('.tsc-modal-overlay'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(10);
  assert.equal(document.querySelector('.tsc-modal-overlay'), null);
  assert.equal(document.activeElement, trigger);
});

// ==========================================================================
// Rubrik-Verwaltungsdialog
// ==========================================================================

test('Rubriken verwalten: Liste anzeigen, Umbenennen inline, Löschen mit Bestätigung', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const calls = [];
  const router = (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'PUT' && /contact-categories\/cat1$/.test(url)) return { status: 200, body: { id: 'cat1', label: body.label } };
    return standardRouter({ categories })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="manage-categories"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const dialog = document.querySelector('.tsc-modal');
  assert.match(dialog.textContent, /Vertrieb/);
  const renameBtn = dialog.querySelector('.tsc-category-manage-row .tsc-icon-btn');
  renameBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(10);
  const input = dialog.querySelector('.tsc-category-rename-input');
  input.value = 'Verkauf';
  const saveBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Speichern')[0];
  saveBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const putCall = calls.filter((c) => c.method === 'PUT' && /contact-categories/.test(c.url))[0];
  assert.equal(putCall.body.label, 'Verkauf');
  assert.match(dialog.textContent, /Verkauf/);
  handle.destroy();
});

test('Rubriken verwalten: Löschen bei category_in_use zeigt dynamischen Bestätigungstext mit usageCount/fallbackLabel', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  let firstAttempt = true;
  const confirmMessages = [];
  const router = (method, url) => {
    if (method === 'DELETE' && /contact-categories\/cat1$/.test(url)) {
      if (firstAttempt) {
        firstAttempt = false;
        return { status: 409, body: { error: 'in use', code: 'category_in_use', usageCount: 3, fallbackLabel: 'Sonstiges' } };
      }
      return { status: 200, body: { ok: true } };
    }
    return standardRouter({ categories })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const confirmFn = (opts) => { confirmMessages.push(opts.message); return Promise.resolve(true); };
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window, { confirm: confirmFn }) });
  await tick(50);
  root.querySelector('[data-action="manage-categories"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const dialog = document.querySelector('.tsc-modal');
  const deleteBtn = dialog.querySelectorAll('.tsc-category-manage-row .tsc-icon-btn')[1];
  deleteBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(confirmMessages.length, 2);
  assert.match(confirmMessages[1], /3 Infoblöcken/);
  assert.match(confirmMessages[1], /Sonstiges/);
  handle.destroy();
});
