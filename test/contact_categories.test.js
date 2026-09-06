'use strict';
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
const { runContactMigrations } = require('../lib/contacts/schema');
const { MAX_CATEGORIES_PER_USER } = require('../lib/contacts/queries');

// ── Eigenständiger Mini-App-Aufbau gegen eine Temp-DB (Muster analog
//    test/progress_entries.test.js - importiert bewusst nichts aus
//    server.js, siehe Vertrag). ──
function buildTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-categories-test-'));
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
  app.use('/api', createContactsRouter({ db, requireAuth }));

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

function makeContact(db, { id = 'c1', userId = 'test-user' } = {}) {
  db.prepare(
    "INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES (?,?, 'Max', datetime('now'), datetime('now'))"
  ).run(id, userId);
  return id;
}

test('GET /contact-categories: 401 ohne Login', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/contact-categories');
  assert.equal(r.status, 401);
});

test('GET /contact-categories: legt die vier Standardrubriken an, feste Reihenfolge, usageCount=0', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.get('/api/contact-categories');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.categories.map((c) => c.label), ['Zuständigkeit', 'Privates', 'Wichtiges', 'Sonstiges']);
  assert.ok(r.body.categories.every((c) => c.isDefault === true));
  assert.ok(r.body.categories.every((c) => c.usageCount === 0));
});

test('GET /contact-categories: idempotent (zweiter Aufruf legt nicht erneut an)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  await agent.get('/api/contact-categories');
  const r = await agent.get('/api/contact-categories');
  assert.equal(r.body.categories.length, 4);
});

test('Eigene Rubriken werden nach den Default-Rubriken alphabetisch einsortiert', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  await agent.post('/api/contact-categories').send({ label: 'Zeta-Projekt' });
  await agent.post('/api/contact-categories').send({ label: 'Alpha-Projekt' });
  const r = await agent.get('/api/contact-categories');
  assert.deepEqual(r.body.categories.map((c) => c.label), [
    'Zuständigkeit', 'Privates', 'Wichtiges', 'Sonstiges', 'Alpha-Projekt', 'Zeta-Projekt',
  ]);
});

test('POST /contact-categories: 400 label_required bei leerem/fehlendem Label', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r1 = await agent.post('/api/contact-categories').send({ label: '   ' });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'label_required');
  const r2 = await agent.post('/api/contact-categories').send({});
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'label_required');
});

test('POST /contact-categories: 400 label_too_long bei > 100 Zeichen', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.post('/api/contact-categories').send({ label: 'x'.repeat(101) });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'label_too_long');
});

test('POST /contact-categories: 201 bei gültigem Label, danach 409 category_exists (case-/trim-insensitiv)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contact-categories').send({ label: 'Lieferanten' });
  assert.equal(created.status, 201);
  assert.equal(created.body.category.label, 'Lieferanten');
  assert.equal(created.body.category.isDefault, false);

  const dup = await agent.post('/api/contact-categories').send({ label: '  lieferanten  ' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'category_exists');
  assert.equal(dup.body.category.id, created.body.category.id);
});

test('POST /contact-categories: 400 category_limit_reached bei 100 vorhandenen Rubriken', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  await agent.get('/api/contact-categories'); // 4 defaults
  const insert = db.prepare(
    `INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,0,?,datetime('now'),datetime('now'))`
  );
  for (let i = 0; i < 96; i++) {
    insert.run(`cat-${i}`, 'test-user', `Rubrik ${i}`, `rubrik ${i}`, i + 4);
  }
  const r = await agent.post('/api/contact-categories').send({ label: 'Zu viel' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'category_limit_reached');
});

test('PUT /contact-categories/:id: 404 bei unbekannter/fremder Rubrik', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.put('/api/contact-categories/does-not-exist').send({ label: 'Neu' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'category_not_found');
});

test('PUT /contact-categories/:id: benennt um, Selbst-Umbenennung mit gleichem label_norm erlaubt', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contact-categories').send({ label: 'Partner' });
  const id = created.body.category.id;

  const renamed = await agent.put(`/api/contact-categories/${id}`).send({ label: 'Partnerfirmen' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.category.label, 'Partnerfirmen');

  const sameNorm = await agent.put(`/api/contact-categories/${id}`).send({ label: '  Partnerfirmen  ' });
  assert.equal(sameNorm.status, 200);
});

test('PUT /contact-categories/:id: 409 category_exists bei Kollision mit ANDERER Rubrik', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const a = await agent.post('/api/contact-categories').send({ label: 'Rubrik A' });
  const b = await agent.post('/api/contact-categories').send({ label: 'Rubrik B' });
  const r = await agent.put(`/api/contact-categories/${b.body.category.id}`).send({ label: 'rubrik a' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'category_exists');
  assert.equal(r.body.category.id, a.body.category.id);
});

test('DELETE /contact-categories/:id: 404 bei unbekannter Rubrik', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.delete('/api/contact-categories/does-not-exist');
  assert.equal(r.status, 404);
});

test('DELETE /contact-categories/:id: unbenutzte Rubrik wird ohne confirm sofort gelöscht', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contact-categories').send({ label: 'Ungenutzt' });
  const r = await agent.delete(`/api/contact-categories/${created.body.category.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.reassignedCount, 0);
});

test('DELETE /contact-categories/:id: 409 category_in_use ohne confirm bei genutzter Rubrik', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contact-categories').send({ label: 'Genutzt' });
  const categoryId = created.body.category.id;
  makeContact(db, { id: 'c1' });
  await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Info</p>' });

  const r = await agent.delete(`/api/contact-categories/${categoryId}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'category_in_use');
  assert.equal(r.body.usageCount, 1);
  assert.equal(r.body.fallbackLabel, 'Sonstiges');
});

test('DELETE /contact-categories/:id?confirm=true: hängt Infoblöcke an "Sonstiges" um und löscht die Rubrik', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contact-categories').send({ label: 'Genutzt' });
  const categoryId = created.body.category.id;
  makeContact(db, { id: 'c1' });
  const block = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Info</p>' });
  assert.equal(block.status, 201);

  const r = await agent.delete(`/api/contact-categories/${categoryId}?confirm=true`);
  assert.equal(r.status, 200);
  assert.equal(r.body.reassignedCount, 1);
  assert.ok(r.body.fallbackCategoryId);

  const stillGone = await agent.get('/api/contact-categories');
  assert.ok(!stillGone.body.categories.some((c) => c.id === categoryId));

  const blocks = await agent.get('/api/contacts/c1/info-blocks');
  assert.equal(blocks.body.blocks.length, 1);
  assert.equal(blocks.body.blocks[0].categoryId, r.body.fallbackCategoryId);
  assert.equal(blocks.body.blocks[0].categoryLabel, 'Sonstiges');
});

test('DELETE /contact-categories/:id: "Sonstiges" ist auch MIT Nutzung geschützt (confirm=true hebt den Schutz nicht auf)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const sonstiges = cats.body.categories.find((c) => c.label === 'Sonstiges');
  makeContact(db, { id: 'c1' });
  await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: sonstiges.id, body: '<p>Info</p>' });

  const r = await agent.delete(`/api/contact-categories/${sonstiges.id}?confirm=true`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'category_fallback_protected');
});

test('DELETE /contact-categories/:id: "Sonstiges" ist auch OHNE Nutzung geschützt (409, nicht 200)', async (t) => {
  // Code-Review-Fund "Kritisch #1": der Schutz der Auffangrubrik hing zuvor
  // an usage>0 - eine ungenutzte "Sonstiges" ließ sich löschen (200) und
  // brach danach JEDE weitere Rubrik-Löschung mit Infoblöcken (500), weil
  // ensureDefaultCategories() ein No-Op ist, sobald andere Rubriken existieren.
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const sonstiges = cats.body.categories.find((c) => c.label === 'Sonstiges');
  const r = await agent.delete(`/api/contact-categories/${sonstiges.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'category_fallback_protected');

  const stillThere = await agent.get('/api/contact-categories');
  assert.ok(stillThere.body.categories.some((c) => c.id === sonstiges.id), '"Sonstiges" darf weiterhin existieren');
});

test('DELETE /contact-categories/:id: nach fälschlichem Löschversuch von "Sonstiges" funktioniert eine weitere Rubrik-Löschung mit Infoblöcken weiterhin (kein 500)', async (t) => {
  // Regressionstest für die Folgeschäden aus Fund "Kritisch #1": eine
  // WEITERE genutzte Rubrik muss sich weiterhin sauber umhängen und löschen
  // lassen, nachdem zuvor versucht wurde, "Sonstiges" zu löschen.
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const sonstiges = cats.body.categories.find((c) => c.label === 'Sonstiges');
  await agent.delete(`/api/contact-categories/${sonstiges.id}`); // jetzt: 409, kein Effekt

  const created = await agent.post('/api/contact-categories').send({ label: 'Genutzt' });
  const categoryId = created.body.category.id;
  makeContact(db, { id: 'c1' });
  await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Info</p>' });

  const r = await agent.delete(`/api/contact-categories/${categoryId}?confirm=true`);
  assert.equal(r.status, 200, 'darf NICHT mit 500 fehlschlagen');
  assert.equal(r.body.reassignedCount, 1);
  assert.ok(r.body.fallbackCategoryId);
});

test('DELETE /contact-categories/:id?confirm=true: "Privates" ist geschützt (409, sonst wäre der Datenschutz-Filter über den Lösch-Pfad umgehbar)', async (t) => {
  // Security-Review-Fund MITTEL 1: der PUT-Pfad (Umbenennen) schützte
  // "Privates" bereits per label_norm-Prüfung - der DELETE-Pfad hatte
  // denselben Leck-Effekt, da ?confirm=true die Infoblöcke stillschweigend
  // nach "Sonstiges" umgehängt hätte. Danach wären sie NICHT mehr vom
  // Datenschutz-Filter im Kontaktkarten-Snippet (batchContactExtras()/
  // PRIVATE_CATEGORY_LABEL_NORM) erfasst gewesen, da dieser rein
  // label-basiert auf der AKTUELLEN Rubrik des Blocks greift.
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const privates = cats.body.categories.find((c) => c.label === 'Privates');
  makeContact(db, { id: 'c1' });
  const block = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: privates.id, body: '<p>Geheim</p>' });
  assert.equal(block.status, 201);

  const r = await agent.delete(`/api/contact-categories/${privates.id}?confirm=true`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'category_private_protected');

  // Rubrik "Privates" bleibt unverändert bestehen ...
  const stillThere = await agent.get('/api/contact-categories');
  assert.ok(stillThere.body.categories.some((c) => c.id === privates.id), '"Privates" darf weiterhin existieren');

  // ... und ihr Infoblock bleibt weiterhin der Rubrik "Privates" zugeordnet
  // (kein stillschweigendes Umhängen nach "Sonstiges" trotz confirm=true).
  const blocks = await agent.get('/api/contacts/c1/info-blocks');
  assert.equal(blocks.body.blocks.length, 1);
  assert.equal(blocks.body.blocks[0].categoryId, privates.id);
  assert.equal(blocks.body.blocks[0].categoryLabel, 'Privates');

  // Vorher/Nachher-Beleg für den Snippet-Leak: die Kontaktliste darf den
  // Inhalt des "Privates"-Blocks NIE im Snippet zeigen - weder vor noch
  // (insbesondere) nach dem fehlgeschlagenen Löschversuch.
  const list = await agent.get('/api/contacts');
  const entry = list.body.find((c) => c.id === 'c1');
  assert.ok(!entry.snippet.includes('Geheim'), 'Snippet darf "Privates"-Inhalt nach dem Löschversuch weiterhin nicht enthalten');
});

test('PUT /contact-categories/:id: "Sonstiges" kann nicht umbenannt werden (409, sonst würde Fund "Kritisch #1" umgangen)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const sonstiges = cats.body.categories.find((c) => c.label === 'Sonstiges');
  const r = await agent.put(`/api/contact-categories/${sonstiges.id}`).send({ label: 'Umbenannt' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'category_fallback_protected');

  const stillThere = await agent.get('/api/contact-categories');
  assert.ok(stillThere.body.categories.some((c) => c.label === 'Sonstiges'), 'Label darf sich nicht geändert haben');
});

test('Fremder Nutzer sieht/ändert Rubriken des anderen Nutzers nicht (404, keine Existenz-Enumeration)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'test-user');
  const created = await agent.post('/api/contact-categories').send({ label: 'Geheim' });

  const otherAgent = await loginAgent(app, 'other-user');
  const getR = await otherAgent.get('/api/contact-categories');
  assert.ok(!getR.body.categories.some((c) => c.label === 'Geheim'));

  const putR = await otherAgent.put(`/api/contact-categories/${created.body.category.id}`).send({ label: 'Uebernommen' });
  assert.equal(putR.status, 404);

  const delR = await otherAgent.delete(`/api/contact-categories/${created.body.category.id}`);
  assert.equal(delR.status, 404);
});

test('MAX_CATEGORIES_PER_USER-Konstante ist 100 (Vertragskonstante)', () => {
  assert.equal(MAX_CATEGORIES_PER_USER, 100);
});
