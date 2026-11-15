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

const { createMomentumRouter } = require('../lib/momentum/routes');
const { runMomentumMigrations } = require('../lib/momentum/schema');

function buildTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momentum-routes-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `);
  runMomentumMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();

  function requireAuth(req, res, next) {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  }
  function uid(req) { return req.session.uid; }

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => { req.session.uid = req.body.uid || 'u1'; res.json({ ok: true }); });
  app.use('/api/momentum', createMomentumRouter({ db, requireAuth, uid, now: () => new Date('2026-09-11T12:00:00.000Z') }));

  return { app, db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function loginAgent(app, uidVal = 'u1') {
  const agent = request.agent(app);
  await agent.post('/test/login').send({ uid: uidVal });
  return agent;
}

test('GET /overview: ohne Anmeldung 401', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const res = await request(app).get('/api/momentum/overview');
  assert.equal(res.status, 401);
});

test('GET /overview: Defaults liefern aktive Bausteine und leere Woche', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const res = await agent.get('/api/momentum/overview');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.settings, { completionToastEnabled: true, streakEnabled: true, weeklyReviewEnabled: true });
  assert.equal(res.body.streak.current, 0);
  assert.equal(res.body.streak.activeToday, false);
  assert.equal(res.body.week.createdCount, 0);
  assert.equal(res.body.week.completedCount, 0);
});

test('GET /overview: ungueltiger utcOffsetMinutes-Wert -> 400', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const res = await agent.get('/api/momentum/overview?utcOffsetMinutes=abc');
  assert.equal(res.status, 400);
});

// Regressionstest fuer den Bug "Fortschrittsdaten konnten nicht geladen
// werden": sobald `week.milestones` nicht leer ist, MUSS jeder Eintrag die
// Felder `type`/`id`/`name` tragen (Vertrag von completion.js und des
// streng typisierten iOS-Clients MomentumMilestone) statt der rohen
// Spaltennamen `kind`/`refId` - andernfalls scheitert das Decoding in der
// App bzw. zeigt die Web-Oberflaeche ein falsches Label an.
test('GET /overview: Meilenstein in week.milestones liefert type/id/name statt kind/refId', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  db.prepare(
    "INSERT INTO momentum_milestones(id,user_id,kind,ref_id,name,occurred_at) VALUES ('ms1','u1','topic','tpX','Serverumzug','2026-09-09T12:00:00.000Z')"
  ).run();

  const res = await agent.get('/api/momentum/overview');
  assert.equal(res.status, 200);
  assert.equal(res.body.week.milestones.length, 1);
  const milestone = res.body.week.milestones[0];
  assert.equal(milestone.type, 'topic');
  assert.equal(milestone.id, 'tpX');
  assert.equal(milestone.name, 'Serverumzug');
  assert.equal('kind' in milestone, false);
  assert.equal('refId' in milestone, false);
});

test('PUT /settings: partielles Update, ungueltiger Typ -> 400', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);

  const bad = await agent.put('/api/momentum/settings').send({ streakEnabled: 'nein' });
  assert.equal(bad.status, 400);

  const ok = await agent.put('/api/momentum/settings').send({ streakEnabled: false });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { completionToastEnabled: true, streakEnabled: false, weeklyReviewEnabled: true });

  const overview = await agent.get('/api/momentum/overview');
  assert.equal(overview.body.streak, null); // deaktivierter Baustein liefert keinen Wert
});

test('PUT /settings: alle drei Bausteine deaktivieren -> overview liefert weder streak noch week', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  await agent.put('/api/momentum/settings').send({ completionToastEnabled: false, streakEnabled: false, weeklyReviewEnabled: false });
  const overview = await agent.get('/api/momentum/overview');
  assert.equal(overview.body.streak, null);
  assert.equal(overview.body.week, null);
});

test('POST /pause-days -> GET /pause-days -> DELETE /pause-days/:date', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);

  const created = await agent.post('/api/momentum/pause-days').send({ date: '2026-11-10' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { date: '2026-11-10' });

  const list = await agent.get('/api/momentum/pause-days');
  assert.deepEqual(list.body.pauseDays, ['2026-11-10']);

  const del = await agent.delete('/api/momentum/pause-days/2026-11-10');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true, removed: true });

  const listAfter = await agent.get('/api/momentum/pause-days');
  assert.deepEqual(listAfter.body.pauseDays, []);
});

test('POST /pause-days: Datum zu weit in der Zukunft -> 400 mit sprechendem Code', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const res = await agent.post('/api/momentum/pause-days').send({ date: '2029-01-01' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TOO_FAR_AHEAD');
});

test('Ownership: Pausentage/Settings sind pro Nutzer getrennt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  db.prepare("INSERT INTO users VALUES ('u2','u2',datetime('now'))").run();
  const agent1 = await loginAgent(app, 'u1');
  const agent2 = await loginAgent(app, 'u2');

  await agent1.post('/api/momentum/pause-days').send({ date: '2026-11-10' });
  const list1 = await agent1.get('/api/momentum/pause-days');
  const list2 = await agent2.get('/api/momentum/pause-days');
  assert.deepEqual(list1.body.pauseDays, ['2026-11-10']);
  assert.deepEqual(list2.body.pauseDays, []);
});

test('Schreibbegrenzung: PUT /settings ist nach 60 Aenderungen pro Nutzer/10-Minuten-Fenster limitiert', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  let last;
  for (let i = 0; i < 60; i++) {
    last = await agent.put('/api/momentum/settings').send({ streakEnabled: i % 2 === 0 });
    assert.equal(last.status, 200);
  }
  const res = await agent.put('/api/momentum/settings').send({ streakEnabled: true });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'rate_limited');
});
