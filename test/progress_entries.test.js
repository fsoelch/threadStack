'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const Database = require('better-sqlite3');

const { createProgressRouter } = require('../lib/progress/routes');
const { runProgressMigrations } = require('../lib/progress/schema');
const { insertEntry } = require('../lib/progress/queries');

// ── Eigenstaendiger Mini-App-Aufbau gegen eine Temp-DB (Muster analog
//    test/helpers.js, aber ohne server.js zu laden - dieses Paket importiert
//    bewusst nichts aus server.js, siehe Vertrag). ──
function buildTestApp({ getLatestFrameId, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-entries-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('test-user','test-user',datetime('now'))").run();
  db.prepare("INSERT INTO users VALUES ('other-user','other-user',datetime('now'))").run();

  const foreignIds = new Set();
  function ownsRef(uid, refType, refId) {
    if (uid !== 'test-user') return false;
    if (foreignIds.has(`${refType}:${refId}`)) return false;
    const row = refType === 'todo'
      ? db.prepare('SELECT 1 FROM todos WHERE id=?').get(refId)
      : refType === 'topic'
        ? db.prepare('SELECT 1 FROM topics WHERE id=?').get(refId)
        : null;
    return !!row;
  }

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
  app.use('/api/progress', createProgressRouter({ db, requireAuth, ownsRef, getLatestFrameId, now }));

  return { app, db, dir, foreignIds };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function loginAgent(app, uid = 'test-user') {
  const agent = request.agent(app);
  await agent.post('/test/login').send({ uid });
  return agent;
}

function makeTodo(db, { id, userId = 'test-user', title = 'Todo', done = 0, createdAt } = {}) {
  const tid = id || crypto.randomBytes(6).toString('hex');
  db.prepare(
    `INSERT INTO todos(id,user_id,title,done,created_at) VALUES (?,?,?,?,?)`
  ).run(tid, userId, title, done, createdAt || new Date().toISOString());
  return tid;
}

test('GET /:refType/:refId: 401 ohne Login', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/progress/todo/whatever');
  assert.equal(r.status, 401);
});

test('GET /:refType/:refId: 400 invalid_ref_type', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.get('/api/progress/invalid/xyz');
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_ref_type');
});

test('GET /:refType/:refId: 404 ref_not_found bei nicht existierender Referenz', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.get('/api/progress/todo/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'ref_not_found');
});

test('GET /:refType/:refId: 404 ref_not_found bei fremdem Owner (identisch zu nicht-existent)', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db, { userId: 'other-user' });
  foreignIds.add(`todo:${todoId}`);
  const agent = await loginAgent(app);

  const rForeign = await agent.get(`/api/progress/todo/${todoId}`);
  const rMissing = await agent.get('/api/progress/todo/does-not-exist');
  assert.equal(rForeign.status, 404);
  assert.equal(rMissing.status, 404);
  assert.equal(rForeign.body.code, rMissing.body.code);
  assert.deepEqual(rForeign.body, rMissing.body);
});

test('GET /:refType/:refId: leerer Detail-Payload fuer frisches Todo', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.goal, '');
  assert.equal(r.body.goalUpdatedAt, null);
  assert.equal(r.body.nextStep, '');
  assert.deepEqual(r.body.entries, []);
  assert.equal(r.body.stats.entryCount, 0);
  assert.equal(r.body.reentry.ai.available, false);
  assert.equal(r.body.reentry.ai.frameId, null);
  assert.equal(r.body.page.hasMore, false);
});

test('POST entries: sanitized <img>/<script>, liefert 201', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/todo/${todoId}/entries`).send({
    body: '<p>Kickoff erledigt</p><img src="x.png" onerror="alert(1)"><script>alert(2)</script>',
  });
  assert.equal(r.status, 201);
  assert.ok(!/<img/i.test(r.body.entry.bodyHtml));
  assert.ok(!/<script/i.test(r.body.entry.bodyHtml));
  assert.ok(/Kickoff erledigt/.test(r.body.entry.bodyHtml));
  assert.equal(r.body.entry.editable, true);
  assert.equal(r.body.stats.entryCount, 1);
});

test('POST entries: 400 body_empty bei leerem/nur-Whitespace-Inhalt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r1 = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '' });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'body_empty');

  const r2 = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>   \n\t  </p>' });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'body_empty');
});

test('POST entries: 400 body_too_long bei Plaintext > 5000 Zeichen, exakte Grenze bei 5000 ok', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const exact = 'a'.repeat(5000);
  const rOk = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: `<p>${exact}</p>` });
  assert.equal(rOk.status, 201, `sollte bei genau 5000 Zeichen noch erlaubt sein: ${JSON.stringify(rOk.body)}`);

  const tooLong = 'a'.repeat(5001);
  const rTooLong = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: `<p>${tooLong}</p>` });
  assert.equal(rTooLong.status, 400);
  assert.equal(rTooLong.body.code, 'body_too_long');
});

test('POST entries: 400 body_too_long bei rohem HTML > 50000 Zeichen (vor Sanitizing)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const hugeRaw = `<p>${'a'.repeat(50001)}</p>`;
  const r = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: hugeRaw });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'body_too_long');
});

test('POST entries: 400 invalid_source bei nicht erlaubter Quelle', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>x</p>', source: 'not-allowed' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_source');
});

test('POST entries: 400 invalid_client_token bei ungueltigem Format', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>x</p>', clientToken: 'invalid token!' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_client_token');
});

test('POST entries: Idempotenz bei doppeltem clientToken (kein zweiter Insert)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r1 = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>Erster</p>', clientToken: 'tok-abc123' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.idempotent, undefined);

  const r2 = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>Zweiter (sollte ignoriert werden)</p>', clientToken: 'tok-abc123' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.idempotent, true);
  assert.equal(r2.body.entry.id, r1.body.entry.id);
  assert.ok(/Erster/.test(r2.body.entry.bodyHtml), 'zweiter Insert darf den ersten Inhalt nicht ueberschreiben');

  const count = db.prepare('SELECT COUNT(*) AS c FROM progress_entries WHERE ref_id=?').get(todoId).c;
  assert.equal(count, 1);
});

test('POST entries: 409 ref_done wenn Todo erledigt ist', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db, { done: 1 });
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>x</p>' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ref_done');
});

test('POST entries: 404 bei fremdem Owner', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db, { userId: 'other-user' });
  foreignIds.add(`todo:${todoId}`);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>x</p>' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'ref_not_found');
});

test('PUT /entries/:id: bearbeitet Inhalt, createdAt bleibt, editedAt wird gesetzt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const created = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>original</p>' });
  const entryId = created.body.entry.id;
  const createdAt = created.body.entry.createdAt;

  const updated = await agent.put(`/api/progress/entries/${entryId}`).send({ body: '<p>bearbeitet</p>' });
  assert.equal(updated.status, 200);
  assert.ok(/bearbeitet/.test(updated.body.entry.bodyHtml));
  assert.equal(updated.body.entry.createdAt, createdAt);
  assert.ok(updated.body.entry.editedAt, 'editedAt sollte gesetzt sein');
});

test('PUT /entries/:id: 404 entry_not_found bei unbekannter/fremder ID', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.put('/api/progress/entries/does-not-exist').send({ body: '<p>x</p>' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'entry_not_found');
});

test('PUT/DELETE /entries/:id: 409 entry_not_editable bei kind=result', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const { entry } = insertEntry(db, {
    userId: 'test-user', refType: 'todo', refId: todoId, kind: 'result', source: 'manual',
    bodyHtml: '', bodyText: '', linkFrameId: 'frame-x', clientToken: null, nowIso: new Date().toISOString(),
  });
  const agent = await loginAgent(app);

  const rPut = await agent.put(`/api/progress/entries/${entry.id}`).send({ body: '<p>x</p>' });
  assert.equal(rPut.status, 409);
  assert.equal(rPut.body.code, 'entry_not_editable');

  const rDel = await agent.delete(`/api/progress/entries/${entry.id}`);
  assert.equal(rDel.status, 409);
  assert.equal(rDel.body.code, 'entry_not_editable');
});

test('DELETE /entries/:id: 404 bei unbekannter ID, sonst ok:true + stats', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const rMissing = await agent.delete('/api/progress/entries/does-not-exist');
  assert.equal(rMissing.status, 404);
  assert.equal(rMissing.body.code, 'entry_not_found');

  const created = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>zu loeschen</p>' });
  const r = await agent.delete(`/api/progress/entries/${created.body.entry.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.stats.entryCount, 0);
});

test('GET .../entries: kind=result wird gefiltert wenn ref.result leer, sonst ueber ref.result aufgeloest', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  insertEntry(db, {
    userId: 'test-user', refType: 'todo', refId: todoId, kind: 'result', source: 'manual',
    bodyHtml: '', bodyText: '', linkFrameId: 'frame-y', clientToken: null, nowIso: new Date().toISOString(),
  });
  const agent = await loginAgent(app);

  const rEmpty = await agent.get(`/api/progress/todo/${todoId}/entries`);
  assert.equal(rEmpty.status, 200);
  assert.deepEqual(rEmpty.body.entries, [], 'kind=result mit leerem ref.result muss gefiltert werden');

  db.prepare('UPDATE todos SET result=? WHERE id=?').run('<p>Ergebnis: erfolgreich</p>', todoId);
  const rFilled = await agent.get(`/api/progress/todo/${todoId}/entries`);
  assert.equal(rFilled.body.entries.length, 1);
  assert.equal(rFilled.body.entries[0].kind, 'result');
  assert.equal(rFilled.body.entries[0].editable, false);
  assert.ok(/Ergebnis: erfolgreich/.test(rFilled.body.entries[0].bodyHtml));
});

test('GET .../entries: 400 invalid_limit ausserhalb 1..50', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r1 = await agent.get(`/api/progress/todo/${todoId}/entries?limit=0`);
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'invalid_limit');

  const r2 = await agent.get(`/api/progress/todo/${todoId}/entries?limit=51`);
  assert.equal(r2.status, 400);

  const r3 = await agent.get(`/api/progress/todo/${todoId}/entries?limit=abc`);
  assert.equal(r3.status, 400);
});

test('GET .../entries: 400 invalid_cursor bei Formatverstoss', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/todo/${todoId}/entries?cursor=garbage`);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_cursor');
});

test('GET .../entries: Cursor-Pagination + gapDaysBefore ueber Seitengrenzen hinweg', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  // 5 Eintraege mit fallenden, kontrollierten created_at-Zeitstempeln
  // anlegen: E1 (aeltester) .. E5 (neuester), mit definierten Luecken.
  // E5: 2026-01-20, E4: 2026-01-15 (Luecke 5T), E3: 2026-01-14 (1T),
  // E2: 2026-01-01 (13T), E1 (aeltester): 2025-12-01 (31T Luecke zu E2).
  const timestamps = [
    ['e1', '2025-12-01T09:00:00.000Z'],
    ['e2', '2026-01-01T09:00:00.000Z'],
    ['e3', '2026-01-14T09:00:00.000Z'],
    ['e4', '2026-01-15T09:00:00.000Z'],
    ['e5', '2026-01-20T09:00:00.000Z'],
  ];
  for (const [label, ts] of timestamps) {
    insertEntry(db, {
      userId: 'test-user', refType: 'todo', refId: todoId, kind: 'note', source: 'manual',
      bodyHtml: `<p>${label}</p>`, bodyText: label, linkFrameId: null, clientToken: null, nowIso: ts,
    });
  }

  // Seite 1: limit=2 -> neueste zwei (e5, e4)
  const page1 = await agent.get(`/api/progress/todo/${todoId}/entries?limit=2`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.entries.length, 2);
  assert.ok(/e5/.test(page1.body.entries[0].bodyHtml));
  assert.ok(/e4/.test(page1.body.entries[1].bodyHtml));
  assert.equal(page1.body.entries[0].gapDaysBefore, 5); // e5 -> e4: 20.-15. = 5 Tage
  assert.equal(page1.body.entries[1].gapDaysBefore, 1); // e4 -> e3 (ueber Seitengrenze!): 15.-14. = 1 Tag
  assert.equal(page1.body.hasMore, true);
  assert.ok(page1.body.nextCursor);

  // Seite 2 ueber Cursor: e3, e2
  const page2 = await agent.get(`/api/progress/todo/${todoId}/entries?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
  assert.equal(page2.status, 200);
  assert.equal(page2.body.entries.length, 2);
  assert.ok(/e3/.test(page2.body.entries[0].bodyHtml));
  assert.ok(/e2/.test(page2.body.entries[1].bodyHtml));
  assert.equal(page2.body.entries[0].gapDaysBefore, 13); // e3 -> e2: 14.01 - 01.01 = 13 Tage
  assert.equal(page2.body.entries[1].gapDaysBefore, 31); // e2 -> e1 (ueber Seitengrenze): 01.01 - 01.12 = 31 Tage
  assert.equal(page2.body.entries[1].showDormancyMarker, true); // > GAP_DAYS (7)
  assert.equal(page2.body.hasMore, true);

  // Seite 3: e1 (aeltester Eintrag ueberhaupt) -> gapDaysBefore = 0
  const page3 = await agent.get(`/api/progress/todo/${todoId}/entries?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`);
  assert.equal(page3.body.entries.length, 1);
  assert.ok(/e1/.test(page3.body.entries[0].bodyHtml));
  assert.equal(page3.body.entries[0].gapDaysBefore, 0);
  assert.equal(page3.body.hasMore, false);
  assert.equal(page3.body.nextCursor, null);
});

test('reentry.ai: nutzt injizierten getLatestFrameId-Callback (auch async)', async (t) => {
  const { app, db, dir } = buildTestApp({ getLatestFrameId: async (refType, refId) => 'frame-123' });
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(r.body.reentry.ai.available, true);
  assert.equal(r.body.reentry.ai.frameId, 'frame-123');
});

test('reentry.ai: Default {available:false, frameId:null} wenn kein Callback gesetzt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(r.body.reentry.ai.available, false);
  assert.equal(r.body.reentry.ai.frameId, null);
});

test('Rate-Limit: greift nach 60 Schreibzugriffen (routenuebergreifend, gleicher Nutzer)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  for (let i = 0; i < 60; i++) {
    const r = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: `Schritt ${i}` });
    assert.equal(r.status, 200, `Schreibzugriff ${i + 1}/60 sollte durchgehen`);
  }
  const r61 = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: 'Schritt 61' });
  assert.equal(r61.status, 429);
  assert.equal(r61.body.code, 'rate_limited');
  assert.equal(r61.body.error, 'Zu viele Änderungen. Bitte kurz warten.');
});
