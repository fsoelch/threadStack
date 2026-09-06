'use strict';
// Arbeitspaket W1 (Ansprechpartner/Kontakte-Erweiterung, public/contacts.js).
//
// Deckt window.TSContacts ab: reine Hilfsfunktionen (node-testbar über
// module.exports) sowie DOM-Verhalten via jsdom mit gemocktem
// `window.TSHost.api` (kein echter Server, siehe Arbeitspaketauftrag).
// Netzwerk läuft NICHT mehr über einen direkten `fetch()`-Mock (Code-Review-
// Fund: contacts.js ruft ausschließlich TSHost.api auf, analog
// public/progress.js — absolute `/api`-Pfade würden im Produktivbetrieb mit
// gesetztem Basis-Pfad-Präfix nicht funktionieren). Zusätzlich ein
// Regressionstest für die additive Erweiterung in public/progress.js
// (showNextStep), damit bestehendes Verhalten für todo/topic unverändert
// bleibt und die neue Kontakt-Variante nachweislich funktioniert.
//
// Teststil analog zu test/web_todo_overview.test.js: jsdom mit
// `runScripts:"dangerously"`, Netzwerk ausschließlich über einen
// konfigurierbaren TSHost.api-Mock (keine echten Requests).
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

/**
 * Baut ein jsdom-Fenster mit progress.js + contacts.js inline geladen und
 * einem konfigurierbaren window.TSHost.api-Mock (Spy). `router(method,
 * urlPath, bodyObj, call)` gibt entweder ein Response-Objekt ({status, body})
 * oder ein Promise darauf zurück; wirft er, wird das als Netzwerkfehler
 * propagiert. Bildet dieselbe Fehlerform wie die echte TSHost.api-Implemen-
 * tierung (public/app.js) nach: `err.status`/`err.body`, KEIN Top-Level
 * `err.code` (das normalisiert contacts.js selbst, siehe request()).
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
  window.TSHost = {
    api: function (method, urlPath, body) {
      // JSON-Rundreise mit dem JSON-Objekt DIESES (Node-)Realms: `body` kommt
      // als Objekt aus dem jsdom-Realm des Fensters (contacts.js läuft dort),
      // Arrays/Objekte daraus sind sonst nicht `assert.deepEqual`-vergleichbar
      // mit in diesem Testfile erzeugten Literalen (unterschiedliche
      // Prototypen trotz gleicher Struktur). Entspricht inhaltlich exakt dem
      // Verhalten der echten TSHost.api (JSON.stringify beim Senden).
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
    toast: () => {},
    confirm: (opts) => Promise.resolve(true),
    progress: {},
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

// B3-Backend (lib/contacts/assignments/router.js) liefert für
// GET /api/contacts/:id/assignments ein verschachteltes Objekt
// { items, page:{limit,offset,total,hasMore}, counts:{open,done} } — KEIN
// flaches Array (siehe Review-Fund/Formatkonflikt W1<->B3).
function assignmentsResponse(items) {
  items = items || [];
  var open = items.filter((i) => !i.done).length;
  var done = items.length - open;
  return {
    items,
    page: { limit: 50, offset: 0, total: items.length, hasMore: false },
    counts: { open, done },
  };
}

// Server-Envelopes (Quelle der Wahrheit: lib/contacts/routes.js) — NICHT die
// flachen Formen, die contacts.js vor der Nachbesserung (Security-Review
// HOCH 2) fälschlich erwartet hatte:
//   GET /contacts/:id            -> {contact, infoBlocks, categories, themeLinks}
//   GET /contact-categories      -> {categories:[...]}
//   GET .../info-blocks          -> {blocks:[...], categories:[...]}
function standardRouter({ contact, categories, blocks, themes, assignments } = {}) {
  contact = contact || baseContact();
  categories = categories || [];
  blocks = blocks || [];
  themes = themes || [];
  assignments = assignments || [];
  return (method, url) => {
    if (method === 'GET' && /^\/api\/contacts\/[^/]+$/.test(url)) {
      return { status: 200, body: { contact, infoBlocks: blocks, categories, themeLinks: [] } };
    }
    if (method === 'GET' && url === '/api/contact-categories') return { status: 200, body: { categories } };
    if (method === 'GET' && /\/info-blocks$/.test(url)) return { status: 200, body: { blocks, categories } };
    if (method === 'GET' && url === '/api/themes') return { status: 200, body: themes };
    if (method === 'GET' && /\/assignments/.test(url)) return { status: 200, body: assignmentsResponse(assignments) };
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

test('mountContactDetail: reload() baut den Notizen-Bereich erneut auf statt ihn dauerhaft leer zu lassen (Code-Review-Fund)', async () => {
  const { window, document } = makeDom(standardRouter());
  const spies = stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.equal(spies.composerCalls.length, 1);
  assert.equal(spies.timelineCalls.length, 1);
  const notesSection = root.querySelector('[aria-label="Notizen"]');
  assert.notEqual(notesSection.innerHTML, '');

  await handle.reload();
  await tick(50);

  // mountInlineComposer/mountTimeline müssen nach reload() erneut aufgerufen
  // worden sein — ohne den Fix bleibt _notesMounted fälschlich `true` und
  // der (durch renderAll() geleerte) Container wird nie wieder befüllt.
  assert.equal(spies.composerCalls.length, 2);
  assert.equal(spies.timelineCalls.length, 2);
  assert.notEqual(notesSection.innerHTML, '');
  handle.destroy();
});

test('mountContactDetail: destroy() räumt Notizen-Handles auf (kein doppeltes destroy() durch reload() vorher nötig)', async () => {
  const { window, document } = makeDom(standardRouter());
  const destroyCalls = { composer: 0, timeline: 0 };
  window.TSProgress.mountInlineComposer = () => ({ destroy: () => { destroyCalls.composer++; } });
  window.TSProgress.mountTimeline = () => ({ destroy: () => { destroyCalls.timeline++; }, reload: () => {} });
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  handle.destroy();
  assert.equal(destroyCalls.composer, 1);
  assert.equal(destroyCalls.timeline, 1);
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

// ==========================================================================
// Verschluckte Ladefehler (Code-Review-Fund): Infoblöcke/Rubriken dürfen bei
// einem 500er NICHT wie ein echter Leerzustand aussehen, und ein
// Rubriken-Ladefehler darf "Privates"-Inhalte nicht ungewollt aufgeklappt
// im Klartext zeigen.
// ==========================================================================

test('Zusatzinformationen: Infoblock-Ladefehler zeigt Fehlerbox statt Leerzustand-Text, Retry lädt erfolgreich nach', async () => {
  let fail = true;
  const blocks = [{ id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Inhalt</p>', updatedAt: 't1' }];
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const router = (method, url) => {
    if (method === 'GET' && /\/info-blocks$/.test(url) && fail) {
      return { status: 500, body: { error: 'Serverfehler', code: 'internal' } };
    }
    return standardRouter({ categories, blocks })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.doesNotMatch(root.textContent, /Noch keine Zusatzinformationen erfasst\./);
  assert.match(root.textContent, /Das hat leider nicht geklappt/);
  fail = false;
  const retryBtn = root.querySelector('.tsc-error-box button');
  assert.ok(retryBtn);
  retryBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  assert.doesNotMatch(root.textContent, /Das hat leider nicht geklappt/);
  assert.match(root.textContent, /Inhalt/);
  handle.destroy();
});

test('Zusatzinformationen: Rubriken-Ladefehler zeigt Fehlerbox UND rendert "Privates"-Blöcke NICHT ungewollt aufgeklappt', async () => {
  let fail = true;
  const blocks = [{ id: 'b1', categoryId: 'cat-privates', bodyHtml: '<p>Geheimer Inhalt</p>', updatedAt: 't1' }];
  const router = (method, url) => {
    if (method === 'GET' && url === '/api/contact-categories' && fail) {
      return { status: 500, body: { error: 'Serverfehler', code: 'internal' } };
    }
    return standardRouter({ blocks })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  // Fehlerbox statt eines echten (aufgeklappten) Rubrik-Blocks — der
  // "Privates"-Inhalt darf in diesem Zustand nicht sichtbar sein.
  assert.match(root.textContent, /Das hat leider nicht geklappt/);
  assert.doesNotMatch(root.innerHTML, /Geheimer Inhalt/);

  fail = false;
  const retryBtn = root.querySelector('.tsc-error-box button');
  assert.ok(retryBtn);
  retryBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  assert.doesNotMatch(root.textContent, /Das hat leider nicht geklappt/);
  // Rubriken sind jetzt geladen, aber die Kategorie 'cat-privates' existiert
  // dort serverseitig nicht (Vertrag: nicht auflösbare categoryId landet in
  // "Ohne Rubrik") — WICHTIG: diese Gruppe muss weiterhin eingeklappt sein,
  // solange sie nicht nachweislich NUR echte "Ohne Rubrik"-Blöcke enthält.
  // Da hier `categoriesLoaded` nach dem Retry wieder true ist, prüfen wir
  // stattdessen den eigentlichen Kernschutz: der geheime Inhalt ist nicht
  // durch den Rubriken-Fehler zuvor ungewollt sichtbar geworden (oben) — und
  // ist nach erfolgreichem Nachladen als normale "Ohne Rubrik"-Gruppe
  // vorhanden (kein Datenverlust).
  assert.match(root.textContent, /Geheimer Inhalt/);
  handle.destroy();
});

test('Zusatzinformationen (Security-Review-Fund HOCH 2): ein unerwartetes Antwortformat (flaches Array statt {categories}) wird als Fehler behandelt, NICHT still als Leerzustand', async () => {
  // Simuliert einen künftigen Format-Drift: der Server liefert (fälschlich)
  // ein flaches Array statt des vertraglich vorgesehenen {categories}-
  // Envelopes. Vor der Nachbesserung wäre das per `Array.isArray(x)?x:[]`
  // still als "keine Rubriken" durchgerutscht.
  const onErrorCalls = [];
  const router = (method, url) => {
    if (method === 'GET' && url === '/api/contact-categories') {
      return { status: 200, body: [{ id: 'cat1', label: 'Vertrieb' }] };
    }
    return standardRouter()(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, {
    contactId: 'c1', ...defaultAdapters(window, { onError: (e) => onErrorCalls.push(e) }),
  });
  await tick(50);
  assert.match(root.textContent, /Das hat leider nicht geklappt/, 'Format-Drift muss als Fehler sichtbar sein, nicht als Leerzustand');
  assert.ok(onErrorCalls.length > 0, 'onError muss bei einem unerwarteten Antwortformat aufgerufen werden');
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

test('Rubrik-Combobox: neue Rubrik anlegen entpackt Server-Envelope {category} (Security-Review-Fund HOCH 2) und speichert Block mit deren id', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const router = (method, url, body) => {
    if (method === 'POST' && url === '/api/contact-categories') {
      // Server-Envelope ist {category:{...}}, KEIN flaches Kategorie-Objekt
      // (lib/contacts/routes.js POST /contact-categories).
      return { status: 201, body: { category: { id: 'cat-new', label: body.label, isDefault: false, sortOrder: 0, usageCount: 0 } } };
    }
    return standardRouter({ categories })(method, url);
  };
  const { window, document, calls } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="add-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const input = root.querySelector('.tsc-combobox-input');
  input.value = 'Ganz Neue Rubrik';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  const newOption = Array.from(root.querySelectorAll('.tsc-combobox-option')).filter((o) => /anlegen/.test(o.textContent))[0];
  assert.ok(newOption, '"neu anlegen"-Option erwartet');
  newOption.dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  await tick(10);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Inhalt</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  const postCategoryCalls = calls.filter((c) => c.method === 'POST' && c.url === '/api/contact-categories');
  assert.equal(postCategoryCalls.length, 1);
  assert.equal(postCategoryCalls[0].body.label, 'Ganz Neue Rubrik');
  const postBlockCalls = calls.filter((c) => c.method === 'POST' && /\/info-blocks$/.test(c.url));
  assert.equal(postBlockCalls.length, 1);
  assert.equal(postBlockCalls[0].body.categoryId, 'cat-new', 'die vom Server per {category} zurückgegebene id muss verwendet werden');
  assert.equal(postBlockCalls[0].body.body, '<p>Inhalt</p>', 'Server-Feldname ist `body`, nicht `bodyHtml`');
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
  // Server-Feldname ist `orderedIds`, nicht `order` (lib/contacts/routes.js).
  assert.deepEqual(reorderCalls[0].body.orderedIds, ['b2', 'b1']);
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
// expectedUpdatedAt im normalen Speicherpfad (Code-Review-Fund)
// ==========================================================================

test('Infoblock bearbeiten (normaler Speicherpfad): PUT sendet expectedUpdatedAt des geladenen Blocks', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const blocks = [{ id: 'b1', categoryId: 'cat1', bodyHtml: '<p>Alt</p>', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const { window, document, calls } = makeDom(standardRouter({ categories, blocks }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="edit-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Neu</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  const putCall = calls.filter((c) => c.method === 'PUT' && /\/info-blocks\/b1$/.test(c.url))[0];
  assert.ok(putCall, 'PUT-Aufruf erwartet');
  assert.equal(putCall.body.expectedUpdatedAt, '2026-01-01T00:00:00.000Z');
  handle.destroy();
});

test('Neuen Infoblock anlegen: POST sendet KEIN expectedUpdatedAt (kein Vorgänger-Stand vorhanden)', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const { window, document, calls } = makeDom(standardRouter({ categories }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="add-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const input = root.querySelector('.tsc-combobox-input');
  input.value = 'Vertrieb';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  root.querySelector('.tsc-combobox-option').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  await tick(10);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Neu</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);
  const postCall = calls.filter((c) => c.method === 'POST' && /\/info-blocks$/.test(c.url))[0];
  assert.ok(postCall, 'POST-Aufruf erwartet');
  assert.equal('expectedUpdatedAt' in postCall.body, false);
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
      return { status: 200, body: { block: serverBlock } };
    }
    if (method === 'GET' && /\/info-blocks$/.test(url)) return { status: 200, body: { blocks: [serverBlock], categories } };
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
  // Server-Feldname ist `body`, nicht `bodyHtml` (lib/contacts/routes.js
  // planBody(body.body)).
  assert.equal(putBodies[1].body, '<p>Meine Änderung</p>');
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
    if (method === 'GET' && /\/info-blocks$/.test(url)) return { status: 200, body: { blocks: [serverBlock], categories } };
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

test('Topic zuweisen: ruft openThemeLinkModal(ctx, onClosed) auf, Topics werden erst nach onClosed() neu geladen (Code-Review-Fund: kein Polling mehr)', async () => {
  const themesCallsBefore = [];
  let capturedOnClosed = null;
  const router = (method, url) => {
    if (method === 'GET' && url === '/api/themes') themesCallsBefore.push(1);
    return standardRouter()(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const openThemeLinkModal = (ctx, onClosed) => { capturedOnClosed = onClosed; };
  const handle = window.TSContacts.mountContactDetail(root, {
    contactId: 'c1', ...defaultAdapters(window, { openThemeLinkModal }),
  });
  await tick(50);
  const themesCallCountAfterMount = themesCallsBefore.length;

  root.querySelector('[data-action="assign-topic"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.equal(typeof capturedOnClosed, 'function');

  // Ohne Aufruf von onClosed() darf KEIN zusätzlicher GET /api/themes
  // erfolgen (kein Hintergrund-Polling mehr, siehe Code-Review-Fund) — auch
  // nach einer Wartezeit, die für das frühere 1,5s-Intervall ausgereicht
  // hätte.
  await tick(60);
  assert.equal(themesCallsBefore.length, themesCallCountAfterMount);

  capturedOnClosed();
  await tick(20);
  assert.equal(themesCallsBefore.length, themesCallCountAfterMount + 1);
  handle.destroy();
});

test('Ist zuständig für: Leerzustand, Fehlerzustand mit Retry, Typ-Badge/Meeting-Titel', async () => {
  const { window, document } = makeDom(standardRouter());
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.match(root.textContent, /Diesem Kontakt ist aktuell kein Vorhaben zugeordnet\./);
  handle.destroy();

  let fail = true;
  const assignments = [{ refType: 'topic', refId: 'th1', title: 'Kickoff', done: false, meetingId: 'm1', meetingTitle: 'Montagsrunde' }];
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

test('Ist zuständig für: GET sendet limit<=50 (B3 validiert 1..50, vorher fälschlich limit=100 -> 400 INVALID_LIMIT)', async () => {
  const assignments = [{ refType: 'todo', refId: 't1', title: 'Angebot', done: false }];
  const { window, document, calls } = makeDom(standardRouter({ assignments }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  const assignmentCall = calls.filter((c) => c.method === 'GET' && /\/assignments/.test(c.url))[0];
  assert.ok(assignmentCall, 'GET .../assignments erwartet');
  const limitMatch = assignmentCall.url.match(/limit=(\d+)/);
  assert.ok(limitMatch, 'limit-Query-Parameter erwartet');
  assert.ok(Number(limitMatch[1]) <= 50, 'limit muss <= 50 sein (B3-Validierung)');
  assert.match(root.textContent, /Angebot/);
  handle.destroy();
});

test('Ist zuständig für: entpackt B3-Antwortformat {items,page,counts} statt eines flachen Arrays', async () => {
  const assignments = [
    { refType: 'todo', refId: 't1', title: 'Angebot erstellen', done: false },
    { refType: 'topic', refId: 'th2', title: 'Review', done: true, meetingId: 'm2', meetingTitle: 'Freitagsrunde' },
  ];
  const { window, document } = makeDom(standardRouter({ assignments }));
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  assert.match(root.textContent, /Angebot erstellen/);
  assert.match(root.textContent, /Review/);
  assert.match(root.textContent, /Freitagsrunde/);
  assert.match(root.textContent, /erledigt/);
  handle.destroy();
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
  const { window, document } = makeDom(() => ({ status: 200, body: { contacts: [] } }));
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts: [] });
  const dialog = document.querySelector('.modal');
  assert.match(dialog.textContent, /Noch keine Ansprechpartner vorhanden/);
});

test('openAssignmentPicker: Titel/Kontextzeile, Suche filtert, Limit von 20 deaktiviert weitere Checkboxen', async () => {
  const contacts = makeContacts(25);
  const { window, document } = makeDom(() => ({ status: 200, body: { contacts: [] } }));
  window.TSContacts.openAssignmentPicker({ refType: 'topic', refId: 'th1', title: 'Migration', contacts });
  await tick(20);
  const dialog = document.querySelector('.modal');
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

test('openAssignmentPicker: Eintreffen der Vorbelegung reißt NICHT die Sucheingabe (Fokus/Eingabe) ein (Code-Review-Fund: kein volles render() mehr)', async () => {
  const contacts = makeContacts(3);
  let resolvePrefill;
  const router = (method) => {
    if (method === 'GET') {
      // B3-Backend liefert { contacts:[{contactId,...}], limit } — KEIN
      // flaches ID-Array (Formatkonflikt-Fix).
      return new Promise((resolve) => {
        resolvePrefill = () => resolve({
          status: 200,
          body: { contacts: [{ contactId: 'k1', name: 'Kontakt 1', role: 'Vertrieb', email: '', assignedAt: '2026-01-01' }], limit: 20 },
        });
      });
    }
    return { status: 200, body: { ok: true } };
  };
  const { window, document } = makeDom(router);
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(10);
  const dialog = document.querySelector('.modal');
  const search = dialog.querySelector('.tsc-picker-search');
  assert.ok(search, 'Sucheingabe muss bereits synchron vorhanden sein');
  search.value = 'Kontakt 1';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(dialog.querySelector('.tsc-loading-hint').hidden, false); // sichtbar, solange nicht geladen

  // Vorbelegung trifft jetzt (verzögert) ein.
  resolvePrefill();
  await tick(20);

  // Dieselbe Sucheingabe-DOM-Node (kein Neuaufbau der Chrome) UND der vom
  // Nutzer eingegebene Text bleiben erhalten.
  assert.equal(dialog.querySelector('.tsc-picker-search'), search);
  assert.equal(search.value, 'Kontakt 1');
  assert.equal(dialog.querySelector('.tsc-loading-hint').hidden, true);

  // Die Vorbelegung (k1) ist trotz aktivem Suchfilter im state.selected
  // verankert — Suchfeld leeren, um das zu prüfen.
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const preselected = dialog.querySelector('#tsc-pick-k1');
  assert.ok(preselected);
  assert.equal(preselected.checked, true);
});

test('openAssignmentPicker (Security-Review-Fund MITTEL 4): "Fertig" ist gesperrt, solange die Vorbelegung noch lädt, und ein Klick löst KEIN PUT aus', async () => {
  const contacts = makeContacts(2);
  let resolvePrefill;
  const putCalls = [];
  const router = (method, url, body) => {
    if (method === 'GET') {
      return new Promise((resolve) => {
        resolvePrefill = () => resolve({
          status: 200,
          body: { contacts: [{ contactId: 'k0', name: 'Kontakt 0', role: 'Einkauf', email: '', assignedAt: '2026-01-01' }], limit: 20 },
        });
      });
    }
    if (method === 'PUT') putCalls.push(body);
    return { status: 200, body: { ok: true } };
  };
  const { window, document } = makeDom(router);
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(10);
  const dialog = document.querySelector('.modal');
  const doneBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Fertig')[0];

  // Vorbelegung (GET) hängt noch (resolvePrefill wurde absichtlich noch
  // nicht aufgerufen) — "Fertig" MUSS bereits jetzt gesperrt sein, sonst
  // würde ein Klick die noch unbekannte bestehende Zuordnung per
  // Voll-Ersetzen-PUT {contactIds:[]} löschen.
  assert.equal(doneBtn.disabled, true, '"Fertig" muss gesperrt sein, solange die Vorbelegung noch lädt');
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.equal(putCalls.length, 0, 'ein Klick auf "Fertig" vor Abschluss des Prefills darf KEINEN PUT auslösen');
  assert.ok(document.querySelector('.modal-overlay'), 'Dialog muss offen bleiben');

  // Vorbelegung trifft jetzt ein — "Fertig" wird freigegeben.
  resolvePrefill();
  await tick(20);
  assert.equal(doneBtn.disabled, false);
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.equal(putCalls.length, 1);
  assert.deepEqual(putCalls[0].contactIds, ['k0']);
});

test('openAssignmentPicker: Titel in der Kontextzeile ist gegen XSS escaped (Code-Review-Fund)', async () => {
  const contacts = makeContacts(1);
  const { window, document } = makeDom(() => ({ status: 200, body: { contacts: [] } }));
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: '<img src=x onerror=alert(1)>', contacts,
  });
  await tick(20);
  const dialog = document.querySelector('.modal');
  const context = dialog.querySelector('.tsc-picker-context');
  assert.doesNotMatch(context.innerHTML, /<img/);
  assert.match(context.innerHTML, /&lt;img/);
  assert.equal(dialog.querySelector('.tsc-picker-context img'), null);
});

test('openAssignmentPicker: "Fertig" speichert via PUT und ruft onChanged mit ausgewählten Kontakten auf', async () => {
  const contacts = makeContacts(3);
  const calls = [];
  const { window, document } = makeDom((method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { status: 200, body: { contacts: [] } };
    return { status: 200, body: { ok: true } };
  });
  let changedWith = null;
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: 'Angebot', contacts,
    onChanged: (assigned) => { changedWith = assigned; },
  });
  await tick(20);
  const dialog = document.querySelector('.modal');
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
  assert.equal(document.querySelector('.modal-overlay'), null);
});

test('openAssignmentPicker: Speicherfehler zeigt Toast, Dialog bleibt offen mit erhaltener Auswahl', async () => {
  const contacts = makeContacts(3);
  const { window, document } = makeDom((method) => {
    if (method === 'GET') return { status: 200, body: { contacts: [] } };
    return { status: 500, body: { error: 'Serverfehler', code: 'internal' } };
  });
  let toastMsg = null;
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: 'Angebot', contacts,
    toast: (msg) => { toastMsg = msg; },
  });
  await tick(20);
  const dialog = document.querySelector('.modal');
  const cb0 = dialog.querySelectorAll('input[type="checkbox"]')[0];
  cb0.checked = true;
  cb0.dispatchEvent(new window.Event('change', { bubbles: true }));
  const doneBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Fertig')[0];
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(toastMsg, 'Zuordnung konnte nicht gespeichert werden.');
  assert.ok(document.querySelector('.modal-overlay'));
  const cbStillChecked = document.querySelectorAll('input[type="checkbox"]')[0];
  assert.equal(cbStillChecked.checked, true);
});

test('openAssignmentPicker: Escape schließt den Dialog und stellt Fokus wieder her', async () => {
  const contacts = makeContacts(2);
  const { window, document } = makeDom(() => ({ status: 200, body: { contacts: [] } }));
  const trigger = document.createElement('button');
  trigger.textContent = 'Öffnen';
  document.body.appendChild(trigger);
  trigger.focus();
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(20);
  assert.ok(document.querySelector('.modal-overlay'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(10);
  assert.equal(document.querySelector('.modal-overlay'), null);
  assert.equal(document.activeElement, trigger);
});

test('openAssignmentPicker: Prefill entpackt B3-Format {contacts:[{contactId,...}]} korrekt (Formatkonflikt-Fix)', async () => {
  const contacts = makeContacts(3);
  const { window, document } = makeDom((method) => {
    if (method === 'GET') {
      return {
        status: 200,
        body: { contacts: [{ contactId: 'k0', name: 'Kontakt 0', role: 'Einkauf', email: '', assignedAt: '2026-01-01' }], limit: 20 },
      };
    }
    return { status: 200, body: { ok: true } };
  });
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(20);
  const preselected = document.querySelector('#tsc-pick-k0');
  assert.ok(preselected, 'Checkbox für k0 erwartet');
  assert.equal(preselected.checked, true);
});

test('openAssignmentPicker (Security-Review-Fund HOCH 2): unerwartetes Prefill-Format (flaches Array statt {contacts}) wird wie ein Ladefehler behandelt, NICHT als leere Vorbelegung', async () => {
  const contacts = makeContacts(2);
  const putCalls = [];
  const { window, document } = makeDom((method, url, body) => {
    if (method === 'GET') return { status: 200, body: [{ contactId: 'k0' }] };
    if (method === 'PUT') putCalls.push(body);
    return { status: 200, body: { ok: true } };
  });
  let reportedErr = null;
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: 'Angebot', contacts,
    onError: (err) => { reportedErr = err; },
  });
  await tick(20);
  const dialog = document.querySelector('.modal');
  assert.ok(reportedErr, 'ein unerwartetes Format muss wie ein Ladefehler onError auslösen');
  const doneBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Fertig')[0];
  assert.equal(doneBtn.disabled, true, '"Fertig" darf bei unerwartetem Prefill-Format NICHT freigegeben werden');
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.equal(putCalls.length, 0, 'ein Klick darf in diesem Zustand keinen destruktiven PUT auslösen');
});

// ==========================================================================
// Fund A (Review): stiller Prefill-Fehler trotz destruktivem Speichern
// ==========================================================================

test('openAssignmentPicker: fehlgeschlagene Vorbelegung meldet onError, zeigt sichtbaren Hinweis und deaktiviert "Fertig"', async () => {
  const contacts = makeContacts(3);
  const { window, document, calls } = makeDom((method) => {
    if (method === 'GET') return { status: 500, body: { error: 'Serverfehler', code: 'internal' } };
    return { status: 200, body: { ok: true } };
  });
  let reportedErr = null;
  window.TSContacts.openAssignmentPicker({
    refType: 'todo', refId: 't1', title: 'Angebot', contacts,
    onError: (err) => { reportedErr = err; },
  });
  await tick(20);
  const dialog = document.querySelector('.modal');
  assert.ok(reportedErr, 'onError muss bei einem Prefill-Fehler aufgerufen werden');
  const warning = dialog.querySelector('.tsc-picker-warning');
  assert.ok(warning, 'sichtbarer Warnhinweis erwartet');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /Aktuelle Zuordnung konnte nicht geladen werden/);
  const doneBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Fertig')[0];
  assert.equal(doneBtn.disabled, true);
  assert.equal(doneBtn.getAttribute('aria-disabled'), 'true');

  // Defense-in-Depth: selbst ein (programmatischer) Klick auf den
  // deaktivierten Button darf keinen PUT auslösen, der die komplette
  // Zuordnung durch eine leere/unvollständige Auswahl ersetzen würde.
  doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.ok(document.querySelector('.modal-overlay'), 'Dialog muss offen bleiben');
  assert.equal(
    calls.filter((c) => c.method === 'PUT').length,
    0,
    'ein Klick auf den deaktivierten "Fertig"-Button darf keinen PUT auslösen (würde sonst die bestehende Zuordnung durch eine leere Auswahl ersetzen)'
  );
});

test('openAssignmentPicker: erfolgreiche Vorbelegung zeigt KEINEN Warnhinweis, "Fertig" bleibt aktiv', async () => {
  const contacts = makeContacts(2);
  const { window, document } = makeDom(() => ({ status: 200, body: { contacts: [] } }));
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(20);
  const dialog = document.querySelector('.modal');
  assert.equal(dialog.querySelector('.tsc-picker-warning').hidden, true);
  const doneBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Fertig')[0];
  assert.equal(doneBtn.disabled, false);
});

// ==========================================================================
// Fund B (Review): Modal-Chrome (modal-body-Wrapper, <h2> statt <h3>)
// ==========================================================================

test('openAssignmentPicker: Inhalt liegt in .modal-body, Überschrift ist <h2> (Modal-Chrome-Konsistenz)', async () => {
  const contacts = makeContacts(1);
  const { window, document } = makeDom(() => ({ status: 200, body: { contacts: [] } }));
  window.TSContacts.openAssignmentPicker({ refType: 'todo', refId: 't1', title: 'Angebot', contacts });
  await tick(20);
  const dialog = document.querySelector('.modal');
  const body = dialog.querySelector('.modal-body');
  assert.ok(body, '.modal-body-Wrapper erwartet');
  assert.ok(body.querySelector('.tsc-picker-context'));
  assert.ok(body.querySelector('.tsc-picker-search'));
  assert.ok(body.querySelector('.tsc-picker-list'));
  const heading = dialog.querySelector('.modal-header h2');
  assert.ok(heading, '<h2> in .modal-header erwartet (statt <h3>)');
  assert.equal(dialog.querySelector('.modal-header h3'), null);
});

// ==========================================================================
// Rubrik-Verwaltungsdialog
// ==========================================================================

test('Rubriken verwalten: Modal-Header nutzt <h2> (Modal-Chrome-Konsistenz, Fund B)', async () => {
  const { window, document } = makeDom(standardRouter());
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="manage-categories"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const dialog = document.querySelector('.modal');
  assert.ok(dialog.querySelector('.modal-header h2'));
  assert.equal(dialog.querySelector('.modal-header h3'), null);
  handle.destroy();
});

test('Rubriken verwalten: Liste anzeigen, Umbenennen inline, Löschen mit Bestätigung', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  const calls = [];
  const router = (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'PUT' && /contact-categories\/cat1$/.test(url)) {
      // Server-Envelope ist {category:{...}}, kein flaches Kategorie-Objekt
      // (lib/contacts/routes.js serializeCategoryWithUsage()).
      return { status: 200, body: { category: { id: 'cat1', label: body.label, isDefault: false, sortOrder: 0, usageCount: 0 } } };
    }
    return standardRouter({ categories })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window) });
  await tick(50);
  root.querySelector('[data-action="manage-categories"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const dialog = document.querySelector('.modal');
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

test('Rubriken verwalten (Security-Review-Fund MITTEL 3): Umbenennen von "Privates" liefert 409 category_private_protected, Toast statt Änderung', async () => {
  const categories = [{ id: 'p1', label: 'Privates' }];
  const router = (method, url) => {
    if (method === 'PUT' && /contact-categories\/p1$/.test(url)) {
      return {
        status: 409,
        body: { error: 'Die Rubrik „Privates“ ist eine Systemrubrik (Datenschutz-Filter) und kann nicht umbenannt werden.', code: 'category_private_protected' },
      };
    }
    return standardRouter({ categories })(method, url);
  };
  const { window, document } = makeDom(router);
  stubProgressModule(window);
  const root = document.getElementById('root');
  let toastMsg = null;
  const handle = window.TSContacts.mountContactDetail(root, { contactId: 'c1', ...defaultAdapters(window, { toast: (m) => { toastMsg = m; } }) });
  await tick(50);
  root.querySelector('[data-action="manage-categories"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const dialog = document.querySelector('.modal');
  const renameBtn = dialog.querySelector('.tsc-category-manage-row .tsc-icon-btn');
  renameBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(10);
  const input = dialog.querySelector('.tsc-category-rename-input');
  input.value = 'Persönliches';
  const saveBtn = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Speichern')[0];
  saveBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.match(toastMsg || '', /Systemrubrik \(Datenschutz-Filter\)/);
  handle.destroy();
});

test('Rubriken verwalten: Löschen bei category_in_use zeigt dynamischen Bestätigungstext mit usageCount/fallbackLabel', async () => {
  const categories = [{ id: 'cat1', label: 'Vertrieb' }];
  let firstAttempt = true;
  const confirmMessages = [];
  const deleteCalls = [];
  const router = (method, url) => {
    // `$` allein würde den zweiten Versuch verfehlen: contacts.js hängt bei
    // der Bestätigung `?confirm=true` als QUERY-PARAMETER an (lib/contacts/
    // routes.js liest `req.query.confirm`, KEIN Body-Feld `force`).
    if (method === 'DELETE' && /contact-categories\/cat1(\?.*)?$/.test(url)) {
      deleteCalls.push(url);
      if (firstAttempt) {
        firstAttempt = false;
        return { status: 409, body: { error: 'in use', code: 'category_in_use', usageCount: 3, fallbackLabel: 'Sonstiges' } };
      }
      return { status: 200, body: { ok: true, reassignedCount: 3, fallbackCategoryId: 'cat-sonstiges' } };
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
  const dialog = document.querySelector('.modal');
  const deleteBtn = dialog.querySelectorAll('.tsc-category-manage-row .tsc-icon-btn')[1];
  deleteBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(confirmMessages.length, 2);
  assert.match(confirmMessages[1], /3 Infoblöcken/);
  assert.match(confirmMessages[1], /Sonstiges/);
  // Der zweite (bestätigte) Löschversuch muss die Bestätigung als
  // Query-Parameter senden, nicht als Body-Feld (Security-Review-Fund HOCH 2).
  assert.equal(deleteCalls.length, 2);
  assert.match(deleteCalls[1], /\?confirm=true$/);
  handle.destroy();
});
