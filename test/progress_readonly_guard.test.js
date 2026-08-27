'use strict';
// Additive Vertragserweiterung von lib/progress/routes.js::createProgressRouter
// um den optionalen `isRefReadOnly(refType, refId) => boolean`-Schlüssel
// (Arbeitspaket B2, "Meetings archivieren statt löschen"):
//
//   - Wird `isRefReadOnly` NICHT übergeben, verhält sich der Router exakt
//     wie vorher (Default `() => false`) - Abwärtskompatibilitäts-Hardstop
//     für alle bestehenden Aufrufer.
//   - Wird `isRefReadOnly` übergeben und liefert `true`, antwortet JEDE
//     schreibende Route (POST/PUT/DELETE) mit 409 ARCHIVED_READONLY, NACH
//     dem bestehenden resolveRef()/Ownership-Check. Lesende Routen bleiben
//     unberührt.
//
// Eigenständiger Mini-App-Aufbau gegen eine Temp-DB (Muster analog
// test/progress_entries.test.js), da dieses Paket bewusst nichts aus
// server.js importiert.
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

function buildTestApp({ isRefReadOnly } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-readonly-guard-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('test-user','test-user',datetime('now'))").run();

  function ownsRef(uid, refType, refId) {
    if (uid !== 'test-user' || refType !== 'topic') return false;
    return !!db.prepare('SELECT 1 FROM topics WHERE id=?').get(refId);
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
  // isRefReadOnly wird NUR übergeben, wenn der Test es explizit tut - so
  // lässt sich der Default-Fall (Schlüssel komplett fehlt) sauber prüfen.
  const ctx = { db, requireAuth, ownsRef };
  if (isRefReadOnly !== undefined) ctx.isRefReadOnly = isRefReadOnly;
  app.use('/api/progress', createProgressRouter(ctx));

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

function makeTopic(db, { id, title = 'Topic' } = {}) {
  const tid = id || crypto.randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO topics(id,title,created_at) VALUES (?,?,datetime('now'))`).run(tid, title);
  return tid;
}

// ── Abwärtskompatibilität: isRefReadOnly NICHT übergeben ──────

test('Abwärtskompatibilität: ohne isRefReadOnly verhalten sich alle Schreib-Routen unverändert (kein Guard)', async (t) => {
  const { app, db, dir } = buildTestApp(); // kein isRefReadOnly im ctx
  t.after(() => cleanup(dir));
  const topicId = makeTopic(db);
  const agent = await loginAgent(app);

  const nextStep = await agent.put(`/api/progress/topic/${topicId}/next-step`).send({ nextStep: 'Schritt' });
  assert.equal(nextStep.status, 200);

  const created = await agent.post(`/api/progress/topic/${topicId}/entries`).send({ body: 'Zwischenstand' });
  assert.equal(created.status, 201);
  const entryId = created.body.entry.id;

  const updated = await agent.put(`/api/progress/entries/${entryId}`).send({ body: 'Geändert' });
  assert.equal(updated.status, 200);

  const deleted = await agent.delete(`/api/progress/entries/${entryId}`);
  assert.equal(deleted.status, 200);
});

// ── isRefReadOnly übergeben und liefert true -> 409 auf allen Schreib-Routen ──

test('isRefReadOnly=true: JEDE Schreib-Route liefert 409 ARCHIVED_READONLY, NACH dem Ownership-Check', async (t) => {
  const { app, db, dir } = buildTestApp({ isRefReadOnly: () => true });
  t.after(() => cleanup(dir));
  const topicId = makeTopic(db);
  const agent = await loginAgent(app);

  // Ownership-Check greift weiterhin zuerst: fremde/unbekannte Referenz -> 404, nicht 409.
  const foreign = await agent.put('/api/progress/topic/does-not-exist/next-step').send({ nextStep: 'x' });
  assert.equal(foreign.status, 404);

  const nextStep = await agent.put(`/api/progress/topic/${topicId}/next-step`).send({ nextStep: 'Schritt' });
  assert.equal(nextStep.status, 409);
  assert.equal(nextStep.body.code, 'ARCHIVED_READONLY');

  const created = await agent.post(`/api/progress/topic/${topicId}/entries`).send({ body: 'Zwischenstand' });
  assert.equal(created.status, 409);
  assert.equal(created.body.code, 'ARCHIVED_READONLY');
});

test('isRefReadOnly=true: PUT/DELETE /entries/:entryId liefern 409, obwohl der Eintrag zuvor bei nicht gesperrtem Ref angelegt wurde', async (t) => {
  // Zwei Router-Instanzen auf DERSELBEN DB: erst ohne Sperre einen Eintrag
  // anlegen, danach mit `isRefReadOnly=true` bearbeiten/löschen versuchen -
  // simuliert "Meeting wurde nachträglich archiviert".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-readonly-guard-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('test-user','test-user',datetime('now'))").run();
  const topicId = makeTopic(db);

  function ownsRef(uid, refType, refId) {
    return uid === 'test-user' && refType === 'topic' && !!db.prepare('SELECT 1 FROM topics WHERE id=?').get(refId);
  }
  function requireAuth(req, res, next) {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  }
  function buildApp(isRefReadOnly) {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
    app.post('/test/login', (req, res) => { req.session.uid = 'test-user'; res.json({ ok: true }); });
    app.use('/api/progress', createProgressRouter({ db, requireAuth, ownsRef, isRefReadOnly }));
    return app;
  }
  t.after(() => cleanup(dir));

  const openApp = buildApp(() => false);
  const openAgent = await loginAgent(openApp);
  const created = await openAgent.post(`/api/progress/topic/${topicId}/entries`).send({ body: 'Zwischenstand' });
  assert.equal(created.status, 201);
  const entryId = created.body.entry.id;

  const lockedApp = buildApp(() => true);
  const lockedAgent = await loginAgent(lockedApp);
  const updateBlocked = await lockedAgent.put(`/api/progress/entries/${entryId}`).send({ body: 'Geändert' });
  assert.equal(updateBlocked.status, 409);
  assert.equal(updateBlocked.body.code, 'ARCHIVED_READONLY');

  const deleteBlocked = await lockedAgent.delete(`/api/progress/entries/${entryId}`);
  assert.equal(deleteBlocked.status, 409);
  assert.equal(deleteBlocked.body.code, 'ARCHIVED_READONLY');
});

// ── Lesende Routen bleiben unberührt ──────────────────────────

test('isRefReadOnly=true: lesende Routen (GET) bleiben unberührt, kein 409', async (t) => {
  const { app, db, dir } = buildTestApp({ isRefReadOnly: () => true });
  t.after(() => cleanup(dir));
  const topicId = makeTopic(db);
  const agent = await loginAgent(app);

  const detail = await agent.get(`/api/progress/topic/${topicId}`);
  assert.equal(detail.status, 200);

  const entries = await agent.get(`/api/progress/topic/${topicId}/entries`);
  assert.equal(entries.status, 200);
});
