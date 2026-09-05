'use strict';
// End-to-End-Tests für Kontakt-CRUD, den Legacy-`description`-Shim und die
// `contacts.search_text`/`search_index`-Integration über den echten
// createContactsRouter() (Arbeitspaket B1). Baut - wie test/progress_entries.test.js -
// bewusst KEINE Abhängigkeit zu server.js auf (das Wiring ist Sache von B4).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const Database = require('better-sqlite3');

const { createContactsRouter } = require('../lib/contacts/routes');
const { runContactMigrations, ensureContactNoteTriggers } = require('../lib/contacts/schema');

function buildTestApp({ onContactDeleted, withSearchIndex = true, withThemeLinks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-search-text-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  if (withThemeLinks) {
    db.exec(`
      CREATE TABLE themes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE theme_links (id TEXT PRIMARY KEY, theme_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(theme_id, ref_id));
    `);
  }
  if (withSearchIndex) {
    db.exec(`CREATE VIRTUAL TABLE search_index USING fts5(ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body);`);
  }
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('test-user','test-user',datetime('now'))").run();
  db.prepare("INSERT INTO users VALUES ('other-user','other-user',datetime('now'))").run();

  function requireAuth(req, res, next) {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  }

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => {
    req.session.uid = req.body.uid || 'test-user';
    res.json({ ok: true });
  });
  app.use('/api', createContactsRouter({ db, requireAuth, onContactDeleted }));

  return { app, db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function loginAgent(app, uid = 'test-user') {
  const agent = request.agent(app);
  await agent.post('/test/login').send({ uid });
  return agent;
}

function searchIndexBody(db, contactId) {
  const row = db.prepare("SELECT body FROM search_index WHERE ref_type='contact' AND ref_id=?").get(contactId);
  return row ? row.body : null;
}

// ── Kontakt-CRUD ─────────────────────────────────────────────────

test('GET /contacts: 401 ohne Login', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/contacts');
  assert.equal(r.status, 401);
});

test('POST /contacts: 400 name_required bei leerem Namen', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.post('/api/contacts').send({ name: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'name_required');
});

test('POST /contacts: 400 name_too_long, role_too_long, email_too_long, email_invalid', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r1 = await agent.post('/api/contacts').send({ name: 'x'.repeat(201) });
  assert.equal(r1.body.code, 'name_too_long');
  const r2 = await agent.post('/api/contacts').send({ name: 'Max', role: 'x'.repeat(501) });
  assert.equal(r2.body.code, 'role_too_long');
  const r3 = await agent.post('/api/contacts').send({ name: 'Max', email: 'x'.repeat(496) + '@a.de' });
  assert.equal(r3.body.code, 'email_too_long');
  const r4 = await agent.post('/api/contacts').send({ name: 'Max', email: 'keine-email' });
  assert.equal(r4.body.code, 'email_invalid');
});

test('POST /contacts: 201 legt Kontakt an mit leeren Batch-Feldern (keine Infoblöcke)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.post('/api/contacts').send({ name: 'Max Mustermann', role: 'Einkauf', email: 'max@example.com' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Max Mustermann');
  assert.equal(r.body.description, '');
  assert.deepEqual(r.body.categories, []);
  assert.equal(r.body.infoBlockCount, 0);
  assert.equal(r.body.snippet, '');
});

test('PUT /contacts/:id: 404 bei unbekanntem Kontakt', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.put('/api/contacts/does-not-exist').send({ name: 'Neu' });
  assert.equal(r.status, 404);
});

test('DELETE /contacts/:id: löscht Kontakt, Infoblöcke (Cascade) und theme_links, ruft onContactDeleted-Hook', async (t) => {
  let hookCalls = [];
  const { app, db, dir } = buildTestApp({ onContactDeleted: (uid, cid) => hookCalls.push([uid, cid]) });
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', description: '<p>Notiz</p>' });
  const contactId = created.body.id;

  db.prepare("INSERT INTO themes(id,title) VALUES ('t1','Thema')").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('l1','t1','contact',?,datetime('now'))").run(contactId);

  const del = await agent.delete(`/api/contacts/${contactId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  assert.equal(db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks WHERE contact_id=?').get(contactId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM theme_links WHERE ref_id=?').get(contactId).c, 0);
  assert.deepEqual(hookCalls, [['test-user', contactId]]);

  const del2 = await agent.delete(`/api/contacts/${contactId}`);
  assert.equal(del2.status, 404);
});

test('DELETE /contacts/:id: onContactDeleted-Hook-Fehler kippt die Response nicht', async (t) => {
  const { app, dir } = buildTestApp({ onContactDeleted: () => { throw new Error('boom'); } });
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const del = await agent.delete(`/api/contacts/${created.body.id}`);
  assert.equal(del.status, 200);
});

test('PUT /contacts/reorder: setzt sort_order, ignoriert fremde IDs', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const c1 = await agent.post('/api/contacts').send({ name: 'A' });
  const c2 = await agent.post('/api/contacts').send({ name: 'B' });

  const otherAgent = await loginAgent(app, 'other-user');
  const foreign = await otherAgent.post('/api/contacts').send({ name: 'Fremd' });

  const r = await agent.put('/api/contacts/reorder').send({ ids: [c2.body.id, foreign.body.id, c1.body.id] });
  assert.equal(r.status, 200);

  const list = await agent.get('/api/contacts');
  assert.deepEqual(list.body.map((c) => c.id), [c2.body.id, c1.body.id]);

  const foreignRow = db.prepare('SELECT sort_order FROM contacts WHERE id=?').get(foreign.body.id);
  assert.equal(foreignRow.sort_order, 0, 'fremder Kontakt darf NICHT verändert werden');
});

test('Ownership: fremder Kontakt ist als 404 nicht von "existiert nicht" unterscheidbar', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const otherAgent = await loginAgent(app, 'other-user');
  const foreign = await otherAgent.post('/api/contacts').send({ name: 'Fremd' });

  const agent = await loginAgent(app, 'test-user');
  const getR = await agent.get(`/api/contacts/${foreign.body.id}`);
  const putR = await agent.put(`/api/contacts/${foreign.body.id}`).send({ name: 'x' });
  const delR = await agent.delete(`/api/contacts/${foreign.body.id}`);
  const notExist = await agent.get('/api/contacts/does-not-exist');
  assert.equal(getR.status, 404);
  assert.equal(putR.status, 404);
  assert.equal(delR.status, 404);
  assert.equal(notExist.status, 404);
  assert.equal(getR.body.code, notExist.body.code);
});

// ── GET /contacts/:contactId (Batch: categories/infoBlockCount/snippet/themeLinks) ──

test('GET /contacts/:contactId: liefert infoBlocks, categories und themeLinks korrekt zusammengesetzt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const contactId = created.body.id;
  const cats = await agent.get('/api/contact-categories');
  const catA = cats.body.categories[0];

  await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId: catA.id, body: '<p>Erster Block Text</p>' });

  db.prepare("INSERT INTO themes(id,title) VALUES ('t1','Mein Thema')").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('l1','t1','contact',?,datetime('now'))").run(contactId);

  const r = await agent.get(`/api/contacts/${contactId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.contact.infoBlockCount, 1);
  assert.equal(r.body.contact.snippet, 'Erster Block Text');
  assert.deepEqual(r.body.contact.categories, [{ id: catA.id, label: catA.label }]);
  assert.equal(r.body.infoBlocks.length, 1);
  assert.equal(r.body.categories.length, 4);
  assert.deepEqual(r.body.themeLinks, [{ linkId: 'l1', themeId: 't1', themeTitle: 'Mein Thema' }]);
});

test('GET /contacts (Liste): categories/infoBlockCount/snippet über Batch-Queries für mehrere Kontakte, kein N+1', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const c1 = await agent.post('/api/contacts').send({ name: 'Anna' });
  const c2 = await agent.post('/api/contacts').send({ name: 'Bob' });
  const cats = await agent.get('/api/contact-categories');
  const catA = cats.body.categories[0];

  await agent.post(`/api/contacts/${c1.body.id}/info-blocks`).send({ categoryId: catA.id, body: '<p>Annas Text</p>' });

  const originalPrepare = db.prepare.bind(db);
  let prepareCount = 0;
  db.prepare = (sql) => { prepareCount += 1; return originalPrepare(sql); };
  const r = await agent.get('/api/contacts');
  db.prepare = originalPrepare;

  assert.equal(r.status, 200);
  const annaEntry = r.body.find((c) => c.id === c1.body.id);
  const bobEntry = r.body.find((c) => c.id === c2.body.id);
  assert.equal(annaEntry.infoBlockCount, 1);
  assert.equal(annaEntry.snippet, 'Annas Text');
  assert.equal(bobEntry.infoBlockCount, 0);
  assert.equal(bobEntry.snippet, '');
  // 1x listContactsForUser + genau 2 Batch-Queries für alle Kontakte (kein N+1).
  assert.equal(prepareCount, 3, `erwartet genau 3 vorbereitete Statements (Liste + 2 Batch-Queries), erhalten: ${prepareCount}`);
});

// ── search_text / search_index Integration ────────────────────────

test('Infoblock-Text fließt in contacts.search_text UND search_index ein', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', role: 'Einkauf', email: 'max@example.com' });
  const contactId = created.body.id;
  const cats = await agent.get('/api/contact-categories');
  const catA = cats.body.categories[0];

  await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId: catA.id, body: '<p>Zustaendig fuer APAC</p>' });

  const row = db.prepare('SELECT search_text FROM contacts WHERE id=?').get(contactId);
  assert.match(row.search_text, /Zustaendig fuer APAC/);

  const body = searchIndexBody(db, contactId);
  assert.match(body, /Einkauf/);
  assert.match(body, /max@example\.com/);
  assert.match(body, /Zustaendig fuer APAC/);
});

test('Löschen des letzten Infoblocks leert search_text/search_index wieder', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const contactId = created.body.id;
  const cats = await agent.get('/api/contact-categories');
  const catA = cats.body.categories[0];

  const block = await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId: catA.id, body: '<p>Text</p>' });
  await agent.delete(`/api/contacts/${contactId}/info-blocks/${block.body.block.id}`);

  const row = db.prepare('SELECT search_text FROM contacts WHERE id=?').get(contactId);
  assert.equal(row.search_text, '');
});

test('ensureContactNoteTriggers: Kontakt-Notizen (progress_entries) fließen nachträglich in search_text/search_index ein', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const contactId = created.body.id;

  // progress_entries existiert beim Erststart NICHT (B2 läuft ggf. später) - simulieren.
  assert.deepEqual(ensureContactNoteTriggers(db), { applied: false });

  db.exec(`
    CREATE TABLE progress_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      body_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_text,created_at) VALUES ('n1',?,'contact',?, 'Kontakt-Notiz', datetime('now'))")
    .run('test-user', contactId);

  assert.deepEqual(ensureContactNoteTriggers(db), { applied: true });

  const row = db.prepare('SELECT search_text FROM contacts WHERE id=?').get(contactId);
  assert.match(row.search_text, /Kontakt-Notiz/);
  const body = searchIndexBody(db, contactId);
  assert.match(body, /Kontakt-Notiz/);
});

// ── Legacy-description-Shim über die echten CRUD-Routen ───────────

test('Legacy-Shim: description setzen, aktualisieren und leeren über PUT /contacts/:id', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const contactId = created.body.id;
  assert.equal(created.body.description, '');

  const withDescription = await agent.put(`/api/contacts/${contactId}`).send({ name: 'Max', description: '<p>Neue Beschreibung</p>' });
  assert.equal(withDescription.status, 200);
  assert.equal(withDescription.body.description, '<p>Neue Beschreibung</p>');

  const blocksAfterSet = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  assert.equal(blocksAfterSet.body.blocks.filter((b) => b.isLegacyDescription).length, 1);

  const updated = await agent.put(`/api/contacts/${contactId}`).send({ name: 'Max', description: '<p>Geändert</p>' });
  assert.equal(updated.body.description, '<p>Geändert</p>');
  const blocksAfterUpdate = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  assert.equal(blocksAfterUpdate.body.blocks.filter((b) => b.isLegacyDescription).length, 1, 'kein zweiter Legacy-Block');

  const cleared = await agent.put(`/api/contacts/${contactId}`).send({ name: 'Max', description: '' });
  assert.equal(cleared.body.description, '');
  const blocksAfterClear = await agent.get(`/api/contacts/${contactId}/info-blocks`);
  assert.equal(blocksAfterClear.body.blocks.length, 0, 'Legacy-Block muss gelöscht werden');
});

test('Legacy-Shim: Schlüssel "description" NICHT im Body -> keine Blockänderung', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', description: '<p>Bleibt</p>' });
  const contactId = created.body.id;

  const noDescriptionKey = await agent.put(`/api/contacts/${contactId}`).send({ name: 'Max Neu' });
  assert.equal(noDescriptionKey.status, 200);
  assert.equal(noDescriptionKey.body.description, '<p>Bleibt</p>', 'description bleibt unverändert, wenn Schlüssel fehlt');
});

test('Legacy-Shim: gleiche Sanitizing-/Längenprüfung wie Infoblöcke (body_too_long)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const r = await agent.put(`/api/contacts/${created.body.id}`).send({ name: 'Max', description: `<p>${'a'.repeat(5001)}</p>` });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'body_too_long');
});

// ── Code-Review-Fund "Kritisch #2": Umbenennen von "Zuständigkeit" ────────

test('Legacy-Shim: description setzen funktioniert weiterhin (kein 500), nachdem die Rubrik "Zuständigkeit" umbenannt wurde', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);

  const cats = await agent.get('/api/contact-categories');
  const zustaendigkeit = cats.body.categories.find((c) => c.label === 'Zuständigkeit');
  const renamed = await agent.put(`/api/contact-categories/${zustaendigkeit.id}`).send({ label: 'Verantwortlich' });
  assert.equal(renamed.status, 200, 'Umbenennen von "Zuständigkeit" selbst bleibt erlaubt (nur "Sonstiges" ist geschützt)');

  // POST mit description: darf NICHT mit 500 fehlschlagen, obwohl die
  // Rubrik "Zuständigkeit" unter diesem Label nicht mehr existiert.
  const created = await agent.post('/api/contacts').send({ name: 'Max', description: '<p>Neue Notiz</p>' });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, '<p>Neue Notiz</p>');

  const blocks = await agent.get(`/api/contacts/${created.body.id}/info-blocks`);
  const legacy = blocks.body.blocks.find((b) => b.isLegacyDescription);
  assert.ok(legacy, 'Legacy-Block muss trotzdem angelegt werden');
  assert.equal(legacy.categoryLabel, 'Sonstiges', 'weicht mangels "Zuständigkeit" auf die Auffangrubrik aus');

  // PUT mit description auf einem ANDEREN Kontakt: ebenfalls kein 500.
  const other = await agent.post('/api/contacts').send({ name: 'Bob' });
  const updated = await agent.put(`/api/contacts/${other.body.id}`).send({ name: 'Bob', description: '<p>Auch das</p>' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.description, '<p>Auch das</p>');
});

// ── Code-Review-Fund "Hoch #3": Teil-Update-Konvention bei PUT /contacts/:id ──

test('PUT /contacts/:id: Teil-Update - nicht mitgeschickte Felder bleiben unverändert (kein stilles Leeren)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', role: 'Einkauf', email: 'max@example.com' });
  const contactId = created.body.id;

  const onlyName = await agent.put(`/api/contacts/${contactId}`).send({ name: 'Max Mustermann' });
  assert.equal(onlyName.status, 200);
  assert.equal(onlyName.body.name, 'Max Mustermann');
  assert.equal(onlyName.body.role, 'Einkauf', 'role darf NICHT geleert werden, wenn nicht mitgeschickt');
  assert.equal(onlyName.body.email, 'max@example.com', 'email darf NICHT geleert werden, wenn nicht mitgeschickt');

  const onlyEmail = await agent.put(`/api/contacts/${contactId}`).send({ email: 'x@example.com' });
  assert.equal(onlyEmail.status, 200);
  assert.equal(onlyEmail.body.name, 'Max Mustermann', 'name bleibt vom vorherigen Update erhalten');
  assert.equal(onlyEmail.body.role, 'Einkauf');
  assert.equal(onlyEmail.body.email, 'x@example.com');
});

test('PUT /contacts/:id: explizites Leeren eines Feldes (leerer String) bleibt möglich', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', role: 'Einkauf', email: 'max@example.com' });
  const contactId = created.body.id;

  const cleared = await agent.put(`/api/contacts/${contactId}`).send({ name: 'Max', role: '', email: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.role, '');
  assert.equal(cleared.body.email, '');
});

test('PUT /contacts/:id: Teil-Update ohne name -> 200 mit Bestandsname statt 400 name_required', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max' });
  const contactId = created.body.id;

  const r = await agent.put(`/api/contacts/${contactId}`).send({ email: 'x@example.com' });
  assert.equal(r.status, 200, 'darf NICHT mit 400 name_required fehlschlagen, wenn name nicht mitgeschickt wird');
  assert.equal(r.body.name, 'Max');
  assert.equal(r.body.email, 'x@example.com');
});

// ── Code-Review-Fund "Mittel #4": search_index-Trigger-Override nachholen ──

test('ensureContactNoteTriggers: holt den search_index-Trigger-Override nach, falls search_index beim ersten Lauf fehlte, und reindexiert bestehende Kontakte', async (t) => {
  const { app, db, dir } = buildTestApp({ withSearchIndex: false });
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', role: 'Einkauf', email: 'max@example.com' });
  const contactId = created.body.id;
  const cats = await agent.get('/api/contact-categories');
  const catA = cats.body.categories[0];
  await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId: catA.id, body: '<p>Zustaendig fuer APAC</p>' });

  // search_index existierte beim ersten runContactMigrations()-Lauf NICHT -
  // wird jetzt (analog db/schema.js beim FTS5-Erststart) nachträglich
  // angelegt, MIT der alten, description-basierten Trigger-Formel.
  db.exec(`CREATE VIRTUAL TABLE search_index USING fts5(ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body);`);
  db.exec(`
    CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
        COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
    END;
    CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
      DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
      INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
        COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
    END;
  `);
  // Zu diesem Zeitpunkt (VOR ensureContactNoteTriggers) fehlt der Infoblock-Text
  // im search_index, weil er nie über die alte Formel erfasst wurde.
  assert.equal(searchIndexBody(db, contactId), null);

  ensureContactNoteTriggers(db);

  const body = searchIndexBody(db, contactId);
  assert.match(body, /Zustaendig fuer APAC/, 'Reindex muss bereits vorhandene Kontakte nachträglich erfassen');
  assert.match(body, /Einkauf/);

  // Der Override muss auch fortlaufend greifen (nicht nur beim einmaligen Reindex).
  await agent.post(`/api/contacts/${contactId}/info-blocks`).send({ categoryId: catA.id, body: '<p>Weiterer Text</p>' });
  const bodyAfter = searchIndexBody(db, contactId);
  assert.match(bodyAfter, /Weiterer Text/);
});
