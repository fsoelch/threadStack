'use strict';
// End-zu-Ende-Verifikation für die Security-Review-Nachbesserung HOCH 2
// ("public/contacts.js spricht ein anderes API-Format als der echte
// Server"): public/contacts.js läuft hier in einer jsdom-Umgebung, aber
// window.TSHost.api spricht NICHT mit einem Mock, sondern per supertest
// GEGEN DEN ECHTEN, VOLLSTÄNDIG VERDRAHTETEN server.js (echtes Express-
// Routing, echte SQLite-DB, echte Session). Damit wird nachgewiesen, dass
// die in test/contacts_web_module.test.js verwendeten Mocks nicht erneut
// einen erfundenen Vertrag "bestätigen", sondern tatsächlich mit
// lib/contacts/routes.js und lib/contacts/assignments/router.js
// übereinstimmen.
//
// Deckt gemäß Security-Review-Auflage mindestens ab: Infoblock anlegen,
// Infoblock bearbeiten (inkl. Konflikt), Infoblock-Reorder, Rubrik anlegen/
// umbenennen/löschen (inkl. Zwangslöschung mit Nutzung).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const CONTACTS_JS_PATH = path.resolve(__dirname, '..', 'public', 'contacts.js');
const CONTACTS_SRC = fs.readFileSync(CONTACTS_JS_PATH, 'utf8');

function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Baut ein minimales jsdom-Fenster mit dem ECHTEN contacts.js, dessen
// TSHost.api-Implementierung jeden Aufruf 1:1 als echten HTTP-Request über
// den übergebenen supertest-Agent gegen den laufenden (In-Process-) Express-
// Server schickt - inklusive Session-Cookie, echter Validierung, echter
// SQLite-Persistenz. Fehlerform entspricht der echten TSHost.api aus
// public/app.js: err.status/err.body, KEIN Top-Level err.code.
function makeRealServerDom(agent) {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
  const html = `<!DOCTYPE html><html><body><div id="root"></div><script>${CONTACTS_SRC}</script></body></html>`;
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  window.TSHost = {
    api: function (method, urlPath, body) {
      const m = String(method).toLowerCase();
      let req = agent[m](urlPath);
      if (body !== null && body !== undefined) req = req.send(body);
      return req.then((res) => {
        if (res.status >= 200 && res.status < 300) return res.body === undefined ? {} : res.body;
        const err = new Error((res.body && res.body.error) || 'Fehler');
        err.status = res.status;
        err.body = res.body || {};
        throw err;
      });
    },
    toast: () => {},
    confirm: () => Promise.resolve(true),
  };
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  return { dom, window, document: window.document, jsdomErrors };
}

function makeRtAdapter(window) {
  return {
    setRT(id, val) { const e = window.document.getElementById(id); if (e) e.innerHTML = val || ''; },
    getRT(id) { const e = window.document.getElementById(id); return e ? e.innerHTML : ''; },
  };
}

function defaultAdapters(window, overrides) {
  const base = {
    onContactChanged: () => {},
    onNavigate: () => {},
    // reportError() in contacts.js kapselt jeden onError()-Aufruf bereits in
    // try/catch (ein werfender Host-Callback darf die App nicht zum Absturz
    // bringen) - ein Fehlerzustand wird in diesen Tests daher stattdessen
    // über sichtbaren Fehlertext im DOM verifiziert, nicht über onError.
    onError: () => {},
    rt: makeRtAdapter(window),
    openThemeLinkModal: () => {},
    confirm: () => Promise.resolve(true),
    toast: () => {},
  };
  return Object.assign(base, overrides || {});
}

async function setupServerAndContact(t) {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  const contactRes = await agent.post('/api/contacts').send({ name: 'Anna Müller', role: 'PM', email: 'anna@example.com' });
  assert.equal(contactRes.status, 201, JSON.stringify(contactRes.body));
  return { db, agent, contactId: contactRes.body.id };
}

test('E2E gegen echten Server: Infoblock über die contacts.js-UI anlegen landet unverändert in der SQLite-DB', async (t) => {
  const { agent, contactId } = await setupServerAndContact(t);
  const { window, document } = makeRealServerDom(agent);
  const root = document.getElementById('root');
  window.TSProgress = { mountInlineComposer: () => ({ destroy: () => {} }), mountTimeline: () => ({ destroy: () => {}, reload: () => {} }) };
  const handle = window.TSContacts.mountContactDetail(root, { contactId, ...defaultAdapters(window) });
  await tick(80);

  root.querySelector('[data-action="add-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  const input = root.querySelector('.tsc-combobox-input');
  assert.ok(input, 'Rubrik-Combobox muss vorhanden sein (Default-Rubriken müssen bereits existieren)');
  input.value = 'Zuständigkeit';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  const option = root.querySelector('.tsc-combobox-option');
  assert.ok(option, 'Default-Rubrik "Zuständigkeit" muss als Option erscheinen');
  option.dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  await tick(20);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Bevorzugt E-Mail-Kontakt.</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(80);

  assert.doesNotMatch(root.textContent, /Das hat leider nicht geklappt/, 'Speichern darf nicht am Formatvertrag scheitern');
  assert.match(root.textContent, /Bevorzugt E-Mail-Kontakt/);

  // Direkt gegen den echten Server verifiziert (nicht nur über die UI).
  const blocksRes = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  assert.equal(blocksRes.status, 200);
  assert.equal(blocksRes.body.blocks.length, 1);
  assert.match(blocksRes.body.blocks[0].bodyHtml, /Bevorzugt E-Mail-Kontakt/);
  handle.destroy();
});

test('E2E gegen echten Server: Infoblock bearbeiten inkl. echtem 409-Konflikt (parallele Änderung durch einen zweiten Request)', async (t) => {
  const { agent, contactId } = await setupServerAndContact(t);
  const catRes = await agent.get('/api/contact-categories');
  const categoryId = catRes.body.categories[0].id;
  const createRes = await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId, body: '<p>Ausgangsstand</p>' });
  assert.equal(createRes.status, 201);
  const blockId = createRes.body.block.id;

  const { window, document } = makeRealServerDom(agent);
  const root = document.getElementById('root');
  window.TSProgress = { mountInlineComposer: () => ({ destroy: () => {} }), mountTimeline: () => ({ destroy: () => {}, reload: () => {} }) };
  const handle = window.TSContacts.mountContactDetail(root, { contactId, ...defaultAdapters(window) });
  await tick(80);

  root.querySelector('[data-action="edit-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);

  // Während die UI den Block noch mit dem Ausgangsstand (expectedUpdatedAt)
  // geöffnet hat, ändert ein ZWEITER, unabhängiger Request denselben Block
  // direkt über die echte API (simuliert eine parallele Änderung).
  const concurrentUpdate = await agent.put(`/api/contacts/${contactId}/info-blocks/${blockId}`).send({ categoryId, body: '<p>Von anderswo geändert</p>' });
  assert.equal(concurrentUpdate.status, 200);

  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Meine Änderung</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(80);

  assert.match(root.textContent, /wurde inzwischen von anderer Stelle geändert/, 'echter 409 block_conflict muss als Banner erscheinen');
  root.querySelector('[data-action="conflict-mine"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(80);

  const finalRes = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  assert.match(finalRes.body.blocks[0].bodyHtml, /Meine Änderung/, 'nach "Meine Version speichern" muss die eigene Eingabe persistiert sein');
  handle.destroy();
});

test('E2E gegen echten Server: Infoblock-Reorder (↑) persistiert die neue Reihenfolge', async (t) => {
  const { agent, contactId } = await setupServerAndContact(t);
  const catRes = await agent.get('/api/contact-categories');
  const categoryId = catRes.body.categories[0].id;
  const b1 = await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId, body: '<p>Erster</p>' });
  const b2 = await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId, body: '<p>Zweiter</p>' });
  assert.equal(b1.status, 201); assert.equal(b2.status, 201);

  const { window, document } = makeRealServerDom(agent);
  const root = document.getElementById('root');
  window.TSProgress = { mountInlineComposer: () => ({ destroy: () => {} }), mountTimeline: () => ({ destroy: () => {}, reload: () => {} }) };
  const handle = window.TSContacts.mountContactDetail(root, { contactId, ...defaultAdapters(window) });
  await tick(80);

  const upButtons = root.querySelectorAll('[data-action="move-up"]');
  assert.equal(upButtons.length, 2);
  upButtons[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(80);

  const finalRes = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  assert.equal(finalRes.body.blocks[0].id, b2.body.block.id, 'der zuvor zweite Block muss nach dem Hochschieben serverseitig zuerst stehen');
  assert.equal(finalRes.body.blocks[1].id, b1.body.block.id);
  handle.destroy();
});

test('E2E gegen echten Server: Rubrik über die Combobox neu anlegen, danach umbenennen und schließlich per Zwangslöschung entfernen (Nutzung wird auf "Sonstiges" umgehängt)', async (t) => {
  const { agent, contactId } = await setupServerAndContact(t);
  const { window, document } = makeRealServerDom(agent);
  const root = document.getElementById('root');
  window.TSProgress = { mountInlineComposer: () => ({ destroy: () => {} }), mountTimeline: () => ({ destroy: () => {}, reload: () => {} }) };
  const handle = window.TSContacts.mountContactDetail(root, { contactId, ...defaultAdapters(window) });
  await tick(80);

  // ── Rubrik anlegen (über den "neu anlegen"-Weg der Combobox) ──
  root.querySelector('[data-action="add-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const input = root.querySelector('.tsc-combobox-input');
  input.value = 'Lieferanten';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  const newOption = Array.from(root.querySelectorAll('.tsc-combobox-option')).find((o) => /anlegen/.test(o.textContent));
  assert.ok(newOption);
  newOption.dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  await tick(20);
  const editorId = root.querySelector('[data-role="tsc-block-editor"]').getAttribute('data-editor-id');
  document.getElementById(editorId).innerHTML = '<p>Lieferant XY, Ansprechpartner Meier</p>';
  root.querySelector('[data-action="tsc-save-block"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(80);

  const catsAfterCreate = await agent.get('/api/contact-categories');
  const created = catsAfterCreate.body.categories.find((c) => c.label === 'Lieferanten');
  assert.ok(created, 'neue Rubrik "Lieferanten" muss serverseitig existieren');
  assert.equal(created.usageCount, 1);

  // ── Rubrik umbenennen (Rubriken verwalten) ──
  root.querySelector('[data-action="manage-categories"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const dialog = document.querySelector('.modal');
  const rows = Array.from(dialog.querySelectorAll('.tsc-category-manage-row'));
  const targetRow = rows.find((r) => /Lieferanten/.test(r.textContent));
  assert.ok(targetRow);
  targetRow.querySelector('.tsc-icon-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  const renameInput = dialog.querySelector('.tsc-category-rename-input');
  renameInput.value = 'Externe Partner';
  Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Speichern').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(50);

  const catsAfterRename = await agent.get('/api/contact-categories');
  const renamed = catsAfterRename.body.categories.find((c) => c.id === created.id);
  assert.equal(renamed.label, 'Externe Partner', 'Umbenennung muss serverseitig persistiert sein');

  // ── Zwangslöschung (Rubrik ist noch in Benutzung) ──
  const rows2 = Array.from(dialog.querySelectorAll('.tsc-category-manage-row'));
  const targetRow2 = rows2.find((r) => /Externe Partner/.test(r.textContent));
  const deleteBtn = targetRow2.querySelectorAll('.tsc-icon-btn')[1];
  deleteBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(80);

  const catsAfterDelete = await agent.get('/api/contact-categories');
  assert.ok(!catsAfterDelete.body.categories.some((c) => c.id === created.id), 'Rubrik muss nach der Zwangslöschung serverseitig entfernt sein');

  const blocksAfterDelete = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  const migratedBlock = blocksAfterDelete.body.blocks.find((b) => /Lieferant XY/.test(b.bodyHtml));
  assert.ok(migratedBlock, 'der Infoblock muss erhalten bleiben');
  const fallbackCat = catsAfterDelete.body.categories.find((c) => c.id === migratedBlock.categoryId);
  assert.equal(fallbackCat.label, 'Sonstiges', 'der Infoblock muss auf die Auffangrubrik "Sonstiges" umgehängt worden sein');
  handle.destroy();
});
