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

const { createArchiveRouter } = require('../lib/archive/routes');
const { runArchiveMigrations } = require('../lib/archive/schema');
const progress = require('../lib/progress');

// ── Kopie des buildFts5Query-Algorithmus aus server.js, NUR für diesen Test
//    (das Router-Paket importiert bewusst nichts aus server.js - `ctx.buildFtsQuery`
//    wird laut Vertrag von außen injiziert; server.js selbst bleibt Eigentum
//    von B2). Identisches Verhalten zum Original in server.js:buildFts5Query. ──
function buildFts5Query(raw) {
  const tokens = [];
  const phraseRe = /"([^"]+)"/g;
  let m; let cleaned = raw;
  while ((m = phraseRe.exec(raw)) !== null) {
    const negate = cleaned[cleaned.indexOf(m[0]) - 1] === '-';
    tokens.push({ text: m[1], negate });
    cleaned = cleaned.replace((negate ? '-' : '') + m[0], '');
  }
  cleaned.trim().split(/\s+/).filter(Boolean).forEach((w) => {
    const negate = w.startsWith('-');
    const text = negate ? w.slice(1) : w;
    if (text) tokens.push({ text, negate });
  });
  if (!tokens.length) return null;
  const esc = (s) => '"' + s.replace(/"/g, '""') + '"';
  const positives = tokens.filter((t) => !t.negate && t.text).map((t) => esc(t.text));
  const negatives = tokens.filter((t) => t.negate && t.text).map((t) => esc(t.text));
  if (!positives.length) return null;
  return positives.join(' ') + negatives.map((n) => ` NOT ${n}`).join('');
}

function parseTopic(t) {
  return {
    id: t.id, meetingId: t.meeting_id, title: t.title, description: t.description,
    done: !!t.done, createdAt: t.created_at, updatedAt: t.updated_at,
  };
}
function parseMeeting(m, topics = []) {
  return {
    id: m.id, title: m.title, description: m.description, color: m.color,
    participants: JSON.parse(m.participants || '[]'),
    nextDate: m.next_date, createdAt: m.created_at,
    topics: topics.filter((t) => t.meeting_id === m.id).map(parseTopic),
  };
}
function fail(res, status, code, msg, extra) {
  res.status(status).json(Object.assign({ error: msg, code }, extra || {}));
}

function buildTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-routes-test-'));
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', participants TEXT NOT NULL DEFAULT '[]',
      color TEXT NOT NULL DEFAULT '#4f46e5', next_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE themes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE theme_links (
      id TEXT PRIMARY KEY, theme_id TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
      ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      filename TEXT NOT NULL, stored_as TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE stack_frames (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      next_step_note TEXT NOT NULL, pushed_at TEXT NOT NULL, popped_at TEXT
    );
    CREATE TABLE ai_artifacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      feature TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE search_index USING fts5(
      ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body
    );
  `);
  runArchiveMigrations(db);
  progress.runProgressMigrations(db);

  db.prepare("INSERT INTO users VALUES ('test-user','test-user',datetime('now'))").run();
  db.prepare("INSERT INTO users VALUES ('other-user','other-user',datetime('now'))").run();

  function requireAuth(req, res, next) {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  }
  function uid(req) {
    return req.session.uid;
  }

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => {
    req.session.uid = req.body.uid || 'test-user';
    res.json({ ok: true });
  });
  app.use('/api/archive', createArchiveRouter({
    db, requireAuth, uid, parseMeeting, parseTopic, progress, fail,
    buildFtsQuery: buildFts5Query, uploadsDir,
  }));

  return { app, db, dir, uploadsDir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function loginAgent(app, uidVal = 'test-user') {
  const agent = request.agent(app);
  await agent.post('/test/login').send({ uid: uidVal });
  return agent;
}

function makeMeeting(db, { id, userId = 'test-user', title = 'Meeting' } = {}) {
  const mid = id || crypto.randomBytes(6).toString('hex');
  db.prepare(
    "INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,datetime('now'))"
  ).run(mid, userId, title);
  return mid;
}

function makeTopic(db, { id, meetingId, title = 'Topic', done = 0 } = {}) {
  const tid = id || crypto.randomBytes(6).toString('hex');
  db.prepare(
    "INSERT INTO topics(id,meeting_id,title,done,created_at,updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))"
  ).run(tid, meetingId, title, done);
  return tid;
}

function indexSearch(db, refType, refId, userId, title, body = '') {
  db.prepare(
    'INSERT INTO search_index(ref_type,ref_id,user_id,title,body) VALUES (?,?,?,?,?)'
  ).run(refType, refId, userId, title, body);
}

function makeAttachmentFile(uploadsDir, storedAs, content = 'x') {
  fs.writeFileSync(path.join(uploadsDir, storedAs), content);
}

// ── POST /:refType/:refId (archivieren) ─────────────────────

test('POST /:refType/:refId: 401 ohne Login', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const r = await request(app).post('/api/archive/meeting/whatever');
  assert.equal(r.status, 401);
});

test('POST /:refType/:refId: 400 UNSUPPORTED_REF_TYPE bei ungültigem Typ', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.post('/api/archive/todo/xyz');
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'UNSUPPORTED_REF_TYPE');
});

test('POST /:refType/:refId: 404 NOT_FOUND bei unbekannter ID', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.post('/api/archive/meeting/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'NOT_FOUND');
});

test('POST /:refType/:refId: 404 NOT_FOUND bei fremder ID - identisch zu unbekannter ID', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const foreignId = makeMeeting(db, { userId: 'other-user' });
  const agent = await loginAgent(app);

  const rForeign = await agent.post(`/api/archive/meeting/${foreignId}`);
  const rMissing = await agent.post('/api/archive/meeting/does-not-exist');
  assert.equal(rForeign.status, 404);
  assert.equal(rMissing.status, 404);
  assert.deepEqual(rForeign.body, rMissing.body);
});

test('POST /:refType/:refId: archiviert erfolgreich, 200 mit alreadyArchived=false', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/archive/meeting/${meetingId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.archived, true);
  assert.equal(r.body.alreadyArchived, false);
  assert.ok(r.body.archivedAt);
});

test('POST /:refType/:refId: idempotent - zweiter Aufruf liefert alreadyArchived=true, archivedAt bleibt gleich', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const agent = await loginAgent(app);

  const r1 = await agent.post(`/api/archive/meeting/${meetingId}`);
  const firstAt = r1.body.archivedAt;

  const r2 = await agent.post(`/api/archive/meeting/${meetingId}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.alreadyArchived, true);
  assert.equal(r2.body.archivedAt, firstAt);
});

test('POST /:refType/:refId: 409 ARCHIVE_STACK_CONFLICT bei offenem Frame, danach Erfolg mit acknowledgeStackConflict', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const topicId = makeTopic(db, { meetingId, title: 'Offenes Thema' });
  db.prepare(
    "INSERT INTO stack_frames(id,user_id,ref_type,ref_id,next_step_note,pushed_at) VALUES ('f1','test-user','topic',?,'Weiter',datetime('now'))"
  ).run(topicId);
  const agent = await loginAgent(app);

  const r1 = await agent.post(`/api/archive/meeting/${meetingId}`);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'ARCHIVE_STACK_CONFLICT');
  assert.equal(r1.body.conflicts.openFrames.length, 1);
  assert.equal(r1.body.conflicts.openFrames[0].frameId, 'f1');
  assert.equal(r1.body.conflicts.openFrames[0].topicTitle, 'Offenes Thema');

  // Nichts wurde geändert.
  const preflight1 = await agent.get(`/api/archive/meeting/${meetingId}/preflight`);
  assert.equal(preflight1.body.archived, false);

  const r2 = await agent.post(`/api/archive/meeting/${meetingId}`).send({ acknowledgeStackConflict: true });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.archived, true);

  // Der Frame bleibt offen - wird nicht automatisch geschlossen.
  const frame = db.prepare('SELECT popped_at FROM stack_frames WHERE id=?').get('f1');
  assert.equal(frame.popped_at, null);
});

test('POST /:refType/:refId: acknowledgeStackConflict mit nicht-strikt-true-Wert zaehlt als false', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const topicId = makeTopic(db, { meetingId });
  db.prepare(
    "INSERT INTO stack_frames(id,user_id,ref_type,ref_id,next_step_note,pushed_at) VALUES ('f1','test-user','topic',?,'Weiter',datetime('now'))"
  ).run(topicId);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/archive/meeting/${meetingId}`).send({ acknowledgeStackConflict: 'true' });
  assert.equal(r.status, 409);
});

// ── DELETE /:refType/:refId (wiederherstellen) ───────────────

test('DELETE /:refType/:refId: stellt wieder her, idempotent', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const agent = await loginAgent(app);
  await agent.post(`/api/archive/meeting/${meetingId}`);

  const r1 = await agent.delete(`/api/archive/meeting/${meetingId}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.archived, false);
  assert.equal(r1.body.alreadyActive, false);

  const r2 = await agent.delete(`/api/archive/meeting/${meetingId}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.alreadyActive, true);
});

test('DELETE /:refType/:refId: 400 UNSUPPORTED_REF_TYPE, 404 bei unbekannt/fremd', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const foreignId = makeMeeting(db, { userId: 'other-user' });

  const rType = await agent.delete('/api/archive/todo/xyz');
  assert.equal(rType.status, 400);
  assert.equal(rType.body.code, 'UNSUPPORTED_REF_TYPE');

  const rMissing = await agent.delete('/api/archive/meeting/does-not-exist');
  assert.equal(rMissing.status, 404);

  const rForeign = await agent.delete(`/api/archive/meeting/${foreignId}`);
  assert.equal(rForeign.status, 404);
});

// ── GET /:refType/:refId/preflight ───────────────────────────

test('GET /:refType/:refId/preflight: liefert impact und conflicts', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const topicId = makeTopic(db, { meetingId });
  db.prepare(
    "INSERT INTO attachments(id,user_id,ref_type,ref_id,filename,stored_as,size,created_at) VALUES ('a1','test-user','topic',?,'f.pdf','stored-a1.pdf',500,datetime('now'))"
  ).run(topicId);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/archive/meeting/${meetingId}/preflight`);
  assert.equal(r.status, 200);
  assert.equal(r.body.archived, false);
  assert.equal(r.body.archivedAt, null);
  assert.equal(r.body.impact.topics, 1);
  assert.equal(r.body.impact.attachments, 1);
  assert.equal(r.body.impact.attachmentBytes, 500);
  assert.deepEqual(r.body.conflicts.openFrames, []);
});

test('GET /:refType/:refId/preflight: 404 bei unbekannt/fremd', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const foreignId = makeMeeting(db, { userId: 'other-user' });
  const agent = await loginAgent(app);
  const r1 = await agent.get('/api/archive/meeting/does-not-exist/preflight');
  const r2 = await agent.get(`/api/archive/meeting/${foreignId}/preflight`);
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
});

// ── DELETE /:refType/:refId/permanent ────────────────────────

test('DELETE /:refType/:refId/permanent: 409 NOT_ARCHIVED bei aktivem Meeting', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const agent = await loginAgent(app);
  const r = await agent.delete(`/api/archive/meeting/${meetingId}/permanent`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_ARCHIVED');
});

test('DELETE /:refType/:refId/permanent: löscht Kaskade + Dateien nach Commit, 404 danach für preflight', async (t) => {
  const { app, db, dir, uploadsDir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const topicId = makeTopic(db, { meetingId });
  db.prepare(
    "INSERT INTO attachments(id,user_id,ref_type,ref_id,filename,stored_as,size,created_at) VALUES ('a1','test-user','topic',?,'f.pdf','stored-a1.pdf',500,datetime('now'))"
  ).run(topicId);
  makeAttachmentFile(uploadsDir, 'stored-a1.pdf');
  const agent = await loginAgent(app);

  await agent.post(`/api/archive/meeting/${meetingId}`);
  const r = await agent.delete(`/api/archive/meeting/${meetingId}/permanent`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.deleted.topics, 1);
  assert.equal(r.body.deleted.attachments, 1);

  assert.equal(fs.existsSync(path.join(uploadsDir, 'stored-a1.pdf')), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings').get().c, 0);

  const rAfter = await agent.get(`/api/archive/meeting/${meetingId}/preflight`);
  assert.equal(rAfter.status, 404);
});

test('DELETE /:refType/:refId/permanent: 404 bei unbekannt/fremd', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const foreignId = makeMeeting(db, { userId: 'other-user' });
  const agent = await loginAgent(app);
  const r1 = await agent.delete('/api/archive/meeting/does-not-exist/permanent');
  const r2 = await agent.delete(`/api/archive/meeting/${foreignId}/permanent`);
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
});

// ── GET /meetings ─────────────────────────────────────────────

test('GET /meetings: listet nur eigene archivierte Meetings, mit total/limit/offset', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const m1 = makeMeeting(db, { title: 'Erstes' });
  const m2 = makeMeeting(db, { title: 'Zweites' });
  makeMeeting(db, { title: 'Aktiv' }); // nicht archiviert
  const foreign = makeMeeting(db, { userId: 'other-user', title: 'Fremd' });
  const agent = await loginAgent(app);
  await agent.post(`/api/archive/meeting/${m1}`);
  await agent.post(`/api/archive/meeting/${m2}`);
  const otherAgent = await loginAgent(app, 'other-user');
  await otherAgent.post(`/api/archive/meeting/${foreign}`);

  const r = await agent.get('/api/archive/meetings');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.limit, 50);
  assert.equal(r.body.offset, 0);
});

test('GET /meetings: 400 VALIDATION_FAILED bei ungültigem limit/offset', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);

  const r1 = await agent.get('/api/archive/meetings?limit=0');
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'VALIDATION_FAILED');

  const r2 = await agent.get('/api/archive/meetings?limit=201');
  assert.equal(r2.status, 400);

  const r3 = await agent.get('/api/archive/meetings?limit=abc');
  assert.equal(r3.status, 400);

  const r4 = await agent.get('/api/archive/meetings?offset=-1');
  assert.equal(r4.status, 400);

  const r5 = await agent.get('/api/archive/meetings?limit=200&offset=0');
  assert.equal(r5.status, 200);
});

test('GET /meetings: q matcht über Meeting-Titel UND über Topic-Inhalt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const m1 = makeMeeting(db, { title: 'Budgetplanung' });
  const m2 = makeMeeting(db, { title: 'Sonstiges' });
  const t1 = makeTopic(db, { meetingId: m2, title: 'Rollout-Strategie' });
  indexSearch(db, 'meeting', m1, 'test-user', 'Budgetplanung');
  indexSearch(db, 'meeting', m2, 'test-user', 'Sonstiges');
  indexSearch(db, 'topic', t1, 'test-user', 'Rollout-Strategie');
  const agent = await loginAgent(app);
  await agent.post(`/api/archive/meeting/${m1}`);
  await agent.post(`/api/archive/meeting/${m2}`);

  const rTitle = await agent.get('/api/archive/meetings?q=Budgetplanung');
  assert.equal(rTitle.body.total, 1);
  assert.equal(rTitle.body.items[0].id, m1);

  const rTopic = await agent.get('/api/archive/meetings?q=Rollout-Strategie');
  assert.equal(rTopic.body.total, 1);
  assert.equal(rTopic.body.items[0].id, m2);
});

test('GET /meetings: q mit reinem Negativterm (buildFtsQuery -> null) liefert leeres Ergebnis, kein 500', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const m1 = makeMeeting(db, { title: 'Etwas' });
  indexSearch(db, 'meeting', m1, 'test-user', 'Etwas');
  const agent = await loginAgent(app);
  await agent.post(`/api/archive/meeting/${m1}`);

  const r = await agent.get('/api/archive/meetings?q=' + encodeURIComponent('-nur-negativ'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { items: [], total: 0, limit: 50, offset: 0 });
});

test('GET /meetings: 401 ohne Login', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/archive/meetings');
  assert.equal(r.status, 401);
});

// ── GET /meetings/:id ─────────────────────────────────────────

test('GET /meetings/:id: liefert Detail mit topics[], archived/archivedAt/readOnly', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db, { title: 'Team-Meeting' });
  makeTopic(db, { meetingId, title: 'Thema A' });
  const agent = await loginAgent(app);
  await agent.post(`/api/archive/meeting/${meetingId}`);

  const r = await agent.get(`/api/archive/meetings/${meetingId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, meetingId);
  assert.equal(r.body.archived, true);
  assert.equal(r.body.readOnly, true);
  assert.ok(r.body.archivedAt);
  assert.equal(r.body.topics.length, 1);
  assert.equal(r.body.topics[0].title, 'Thema A');
  assert.notEqual(r.body.topics[0].progress, undefined); // Progress-Anreicherung vorhanden
});

test('GET /meetings/:id: 404 für aktives (nicht archiviertes) Meeting', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const meetingId = makeMeeting(db);
  const agent = await loginAgent(app);
  const r = await agent.get(`/api/archive/meetings/${meetingId}`);
  assert.equal(r.status, 404);
});

test('GET /meetings/:id: 404 bei unbekannt/fremd', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const foreignId = makeMeeting(db, { userId: 'other-user' });
  const agent = await loginAgent(app);
  const other = await loginAgent(app, 'other-user');
  await other.post(`/api/archive/meeting/${foreignId}`);

  const r1 = await agent.get('/api/archive/meetings/does-not-exist');
  const r2 = await agent.get(`/api/archive/meetings/${foreignId}`);
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
});
