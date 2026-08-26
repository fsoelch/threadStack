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

function buildTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-meta-test-'));
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
  app.use('/api/progress', createProgressRouter({ db, requireAuth, ownsRef }));

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

function makeTodo(db, { userId = 'test-user' } = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO todos(id,user_id,title,created_at) VALUES (?,?,?,?)`)
    .run(id, userId, 'Todo', new Date().toISOString());
  return id;
}

test('PUT goal: setzt und liest Zielbild, leerer String erlaubt und loescht', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r1 = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: 'MVP live bringen' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.goal, 'MVP live bringen');
  assert.ok(r1.body.goalUpdatedAt);

  const detail = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(detail.body.goal, 'MVP live bringen');

  const r2 = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: '' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.goal, '');
});

test('PUT goal: entfernt Markup (Klartext-Feld)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: '<b>Ziel</b> <script>alert(1)</script>erreichen' });
  assert.equal(r.status, 200);
  assert.equal(r.body.goal, 'Ziel erreichen');
});

test('PUT goal: 400 goal_too_long bei genau 501 Zeichen, 500 Zeichen sind ok', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const exact = 'a'.repeat(500);
  const rOk = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: exact });
  assert.equal(rOk.status, 200);

  const tooLong = 'a'.repeat(501);
  const rTooLong = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: tooLong });
  assert.equal(rTooLong.status, 400);
  assert.equal(rTooLong.body.code, 'goal_too_long');
});

test('PUT goal: 404 bei fremdem Owner (identisch zu nicht-existent)', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db, { userId: 'other-user' });
  foreignIds.add(`todo:${todoId}`);
  const agent = await loginAgent(app);

  const rForeign = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: 'x' });
  const rMissing = await agent.put('/api/progress/todo/does-not-exist/goal').send({ goal: 'x' });
  assert.equal(rForeign.status, 404);
  assert.equal(rMissing.status, 404);
  assert.deepEqual(rForeign.body, rMissing.body);
});

test('PUT next-step: setzt und liest naechsten Schritt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const r1 = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: 'Angebot einholen' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.nextStep, 'Angebot einholen');
  assert.ok(r1.body.nextStepUpdatedAt);

  const detail = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(detail.body.nextStep, 'Angebot einholen');
});

test('PUT next-step: 400 next_step_too_long bei genau 1001 Zeichen, 1000 Zeichen sind ok', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  const exact = 'a'.repeat(1000);
  const rOk = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: exact });
  assert.equal(rOk.status, 200);

  const tooLong = 'a'.repeat(1001);
  const rTooLong = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: tooLong });
  assert.equal(rTooLong.status, 400);
  assert.equal(rTooLong.body.code, 'next_step_too_long');
});

test('PUT next-step: 404 bei fremdem Owner', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db, { userId: 'other-user' });
  foreignIds.add(`todo:${todoId}`);
  const agent = await loginAgent(app);

  const r = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: 'x' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'ref_not_found');
});

test('setGoal/setNextStep aktualisieren dieselbe progress_meta-Zeile (keine Doppel-Inserts)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const todoId = makeTodo(db);
  const agent = await loginAgent(app);

  await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: 'Ziel A' });
  await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: 'Schritt A' });
  await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: 'Ziel B' });

  const rows = db.prepare('SELECT * FROM progress_meta WHERE ref_type=? AND ref_id=?').all('todo', todoId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, 'Ziel B');
  assert.equal(rows[0].next_step, 'Schritt A');
});
