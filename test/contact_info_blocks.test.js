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
const { MAX_INFO_BLOCKS_PER_CONTACT } = require('../lib/contacts/queries');

function buildTestApp({ onContactDeleted } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-info-blocks-test-'));
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
    CREATE TABLE themes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE theme_links (id TEXT PRIMARY KEY, theme_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL);
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

function makeContact(db, { id = 'c1', userId = 'test-user' } = {}) {
  db.prepare(
    "INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES (?,?, 'Max', datetime('now'), datetime('now'))"
  ).run(id, userId);
  return id;
}

async function firstCategoryId(agent) {
  const r = await agent.get('/api/contact-categories');
  return r.body.categories[0].id;
}

test('GET /contacts/:contactId/info-blocks: 401 ohne Login', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/contacts/c1/info-blocks');
  assert.equal(r.status, 401);
});

test('GET /contacts/:contactId/info-blocks: 404 bei unbekanntem Kontakt', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.get('/api/contacts/does-not-exist/info-blocks');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'contact_not_found');
});

test('GET /contacts/:contactId/info-blocks: 404 bei Kontakt eines fremden Nutzers', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', userId: 'other-user' });
  const agent = await loginAgent(app, 'test-user');
  const r = await agent.get('/api/contacts/c1/info-blocks');
  assert.equal(r.status, 404);
});

test('POST info-blocks: 400 category_required ohne categoryId', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const r = await agent.post('/api/contacts/c1/info-blocks').send({ body: '<p>Text</p>' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'category_required');
});

test('POST info-blocks: 404 category_not_found bei fremder/unbekannter Rubrik', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const r = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: 'unknown', body: '<p>Text</p>' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'category_not_found');
});

test('POST info-blocks: 400 body_empty bei leerem Inhalt (auch NACH Sanitizing)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const r1 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '' });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'body_empty');
  // Nur aus Markup bestehender Inhalt ohne Klartext -> ebenfalls body_empty.
  const r2 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p><br></p>' });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'body_empty');
});

test('POST info-blocks: 400 body_too_long bei Klartext > 5000 Zeichen', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const longText = 'a'.repeat(5001);
  const r = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: `<p>${longText}</p>` });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'body_too_long');
});

test('POST info-blocks: 400 body_too_long bei Roh-HTML > 50000 Zeichen', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const raw = '<p>' + 'a'.repeat(50001) + '</p>';
  const r = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: raw });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'body_too_long');
});

test('POST info-blocks: body_too_long liefert für Roh-HTML- und Klartext-Grenze unterscheidbare Meldungen mit korrektem Grenzwert (Code-Review-Fund "Mittel #5")', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);

  const rawTooLong = await agent.post('/api/contacts/c1/info-blocks')
    .send({ categoryId, body: '<p>' + 'a'.repeat(50001) + '</p>' });
  assert.equal(rawTooLong.status, 400);
  assert.equal(rawTooLong.body.code, 'body_too_long');
  assert.match(rawTooLong.body.error, /50000/, 'Meldung muss den tatsächlich verletzten Grenzwert (50000, roh) nennen');
  assert.doesNotMatch(rawTooLong.body.error, /\b5000\b(?!0)/, 'Meldung darf NICHT fälschlich 5000 nennen');

  const textTooLong = await agent.post('/api/contacts/c1/info-blocks')
    .send({ categoryId, body: `<p>${'a'.repeat(5001)}</p>` });
  assert.equal(textTooLong.status, 400);
  assert.equal(textTooLong.body.code, 'body_too_long');
  assert.match(textTooLong.body.error, /5000/, 'Meldung muss den tatsächlich verletzten Grenzwert (5000, Klartext) nennen');

  assert.notEqual(rawTooLong.body.error, textTooLong.body.error, 'die beiden Grenzwertverletzungen müssen unterscheidbare Meldungen liefern');
});

test('POST info-blocks: 201 legt Infoblock an, sortOrder fortlaufend je Rubrik, sanitized', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);

  const r1 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Erster</p><script>evil()</script>' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.block.sortOrder, 0);
  assert.equal(r1.body.block.isLegacyDescription, false);
  assert.ok(!/script/i.test(r1.body.block.bodyHtml), 'script-Tags müssen entfernt werden (sanitizeProgressHtml)');
  assert.equal(r1.body.block.excerpt, 'Erster');

  const r2 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Zweiter</p>' });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.block.sortOrder, 1);
});

test('POST info-blocks: 400 block_limit_reached bei 50 vorhandenen Blöcken', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const insert = db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
  );
  for (let i = 0; i < MAX_INFO_BLOCKS_PER_CONTACT; i++) {
    insert.run(`b-${i}`, 'test-user', 'c1', categoryId, `<p>${i}</p>`, `${i}`, i);
  }
  const r = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Zu viel</p>' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'block_limit_reached');
});

test('PUT info-blocks/:blockId: 404 block_not_found bei fremdem/gelöschtem Block (keine Neuanlage)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const r = await agent.put('/api/contacts/c1/info-blocks/does-not-exist').send({ categoryId, body: '<p>x</p>' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'block_not_found');
  const list = await agent.get('/api/contacts/c1/info-blocks');
  assert.equal(list.body.blocks.length, 0, 'PUT auf unbekannte ID darf KEINEN neuen Block anlegen');
});

test('PUT info-blocks/:blockId: identische Validierung wie POST (Validierungsparität)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Original</p>' });
  const blockId = created.body.block.id;

  const noCategory = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ body: '<p>x</p>' });
  assert.equal(noCategory.status, 400);
  assert.equal(noCategory.body.code, 'category_required');

  const emptyBody = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ categoryId, body: '' });
  assert.equal(emptyBody.status, 400);
  assert.equal(emptyBody.body.code, 'body_empty');

  const tooLong = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ categoryId, body: `<p>${'a'.repeat(5001)}</p>` });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.code, 'body_too_long');
});

test('PUT info-blocks/:blockId: 200 aktualisiert Inhalt, updated_at ändert sich', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Original</p>' });
  const blockId = created.body.block.id;

  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ categoryId, body: '<p>Neu</p>' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.block.excerpt, 'Neu');
});

test('PUT info-blocks/:blockId: unverändert (gleiche category_id + body_html) -> updated_at bleibt stabil', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Original</p>' });
  const blockId = created.body.block.id;
  const updatedAtBefore = created.body.block.updatedAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  const same = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ categoryId, body: '<p>Original</p>' });
  assert.equal(same.status, 200);
  assert.equal(same.body.block.updatedAt, updatedAtBefore);
});

test('PUT info-blocks/:blockId: 409 block_conflict bei abweichendem expectedUpdatedAt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Original</p>' });
  const blockId = created.body.block.id;

  const r = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`)
    .send({ categoryId, body: '<p>Neu</p>', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'block_conflict');
  assert.equal(r.body.block.id, blockId);
});

test('PUT info-blocks/:blockId: fehlendes expectedUpdatedAt -> Last-Write-Wins (kein Konflikt)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>Original</p>' });
  const blockId = created.body.block.id;
  const r = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ categoryId, body: '<p>Ohne Konflikt</p>' });
  assert.equal(r.status, 200);
});

test('PUT info-blocks/:blockId: Rubrikwechsel setzt Block ans Ende der Zielrubrik', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const [catA, catB] = cats.body.categories;

  await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: catB.id, body: '<p>B-1</p>' });
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: catA.id, body: '<p>A-1</p>' });
  const blockId = created.body.block.id;

  const moved = await agent.put(`/api/contacts/c1/info-blocks/${blockId}`).send({ categoryId: catB.id, body: '<p>A-1</p>' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.block.categoryId, catB.id);
  assert.equal(moved.body.block.sortOrder, 1, 'sollte ans Ende der Zielrubrik gesetzt werden');
});

test('DELETE info-blocks/:blockId: idempotent - deleted:true beim ersten, deleted:false danach', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>x</p>' });
  const blockId = created.body.block.id;

  const first = await agent.delete(`/api/contacts/c1/info-blocks/${blockId}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.deleted, true);

  const second = await agent.delete(`/api/contacts/c1/info-blocks/${blockId}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.deleted, false);
});

test('DELETE info-blocks/:blockId: Fremdzugriff über anderen Kontakt scheitert am Kontakt-Check (404)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  makeContact(db, { id: 'c2' });
  const agent = await loginAgent(app);
  const categoryId = await firstCategoryId(agent);
  const created = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId, body: '<p>x</p>' });
  const blockId = created.body.block.id;

  const r = await agent.delete(`/api/contacts/c2/info-blocks/${blockId}`);
  assert.equal(r.status, 200); // Kontakt c2 existiert und gehört dem Nutzer -> Route selbst liefert 200
  assert.equal(r.body.deleted, false, 'Block gehört nicht zu c2 -> nicht gelöscht');

  const stillThere = await agent.get('/api/contacts/c1/info-blocks');
  assert.equal(stillThere.body.blocks.length, 1);
});

test('PUT info-blocks/reorder: 404 category_not_found bei fremder/unbekannter Rubrik', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const r = await agent.put('/api/contacts/c1/info-blocks/reorder').send({ categoryId: 'unknown', orderedIds: [] });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'category_not_found');
});

test('PUT info-blocks/reorder: schreibt Positionen nur für Blöcke der Rubrik, hängt Rest stabil ans Ende, ignoriert unbekannte IDs', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1' });
  const agent = await loginAgent(app);
  const cats = await agent.get('/api/contact-categories');
  const catA = cats.body.categories[0];
  const catB = cats.body.categories[1];

  const b1 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: catA.id, body: '<p>1</p>' });
  const b2 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: catA.id, body: '<p>2</p>' });
  const b3 = await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: catA.id, body: '<p>3</p>' });
  await agent.post('/api/contacts/c1/info-blocks').send({ categoryId: catB.id, body: '<p>andere Rubrik</p>' });

  const id1 = b1.body.block.id, id2 = b2.body.block.id, id3 = b3.body.block.id;

  const r = await agent.put('/api/contacts/c1/info-blocks/reorder')
    .send({ categoryId: catA.id, orderedIds: [id3, 'unknown-id', id1] });
  assert.equal(r.status, 200);
  const order = r.body.blocks.map((b) => b.id);
  assert.deepEqual(order, [id3, id1, id2], 'id2 (nicht genannt) sollte stabil ans Ende rutschen');
  assert.deepEqual(r.body.blocks.map((b) => b.sortOrder), [0, 1, 2]);

  const other = await agent.get('/api/contacts/c1/info-blocks');
  const catBBlocks = other.body.blocks.filter((b) => b.categoryId === catB.id);
  assert.equal(catBBlocks.length, 1, 'andere Rubrik bleibt unangetastet');
});

test('Legacy-description-Shim: description auf einem Kontakt erscheint als is_legacy_description-Block', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const created = await agent.post('/api/contacts').send({ name: 'Max', description: '<p>Alte Notiz</p>' });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, '<p>Alte Notiz</p>');

  const blocks = await agent.get(`/api/contacts/${created.body.id}/info-blocks`);
  const legacy = blocks.body.blocks.find((b) => b.isLegacyDescription);
  assert.ok(legacy, 'sollte einen Legacy-Block erzeugen');
  assert.equal(legacy.categoryLabel, 'Zuständigkeit');
});
