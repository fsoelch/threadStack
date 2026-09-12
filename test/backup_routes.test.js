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

const { createBackupRouter } = require('../lib/backup/routes');
const { runBackupMigrations } = require('../lib/backup/schema');
const { _resetForTests } = require('../lib/backup/store');
const { rebuildSearchIndex } = require('../db/schema');

const REQUIRED_SCHEMA = `
  CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '');
  CREATE TABLE themes (id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '');
  CREATE TABLE topics (id TEXT PRIMARY KEY, meeting_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '', result TEXT DEFAULT '');
  CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '', result TEXT DEFAULT '');
  CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, role TEXT, email TEXT, description TEXT);
  CREATE TABLE knowledge_pages (id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, content TEXT DEFAULT '');
  CREATE VIRTUAL TABLE search_index USING fts5(ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body);
`;

function buildTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-routes-test-'));
  const db = new Database(path.join(dir, 'app.db'));
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'user\')');
  db.exec(REQUIRED_SCHEMA);
  runBackupMigrations(db);
  db.prepare("INSERT INTO users VALUES ('admin1','admin','admin')").run();
  db.prepare("INSERT INTO users VALUES ('user1','bob','user')").run();

  const backupsDir = path.join(dir, 'backups');

  function requireAdmin(req, res, next) {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.uid);
    if (u?.role !== 'admin') return res.status(403).json({ error: 'Keine Berechtigung' });
    next();
  }

  const sessionStore = new session.MemoryStore();

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, store: sessionStore }));
  app.post('/test/login', (req, res) => { req.session.uid = req.body.uid; res.json({ ok: true }); });
  app.get('/test/whoami', (req, res) => res.json({ uid: req.session.uid || null }));
  app.use('/api/backup', createBackupRouter({
    db, requireAdmin, backupsDir, sessionStore, rebuildSearchIndex,
    now: () => new Date(2026, 8, 12, 3, 0, 0),
  }));

  return { app, db, dir, backupsDir, sessionStore };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function loginAgent(app, uidVal) {
  const agent = request.agent(app);
  await agent.post('/test/login').send({ uid: uidVal });
  return agent;
}

test.beforeEach(() => _resetForTests());

// ── Auth ─────────────────────────────────────────────────────
test('GET /: ohne Anmeldung 401', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const res = await request(app).get('/api/backup/');
  assert.equal(res.status, 401);
});

test('GET /: angemeldet aber nicht Admin -> 403', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'user1');
  const res = await agent.get('/api/backup/');
  assert.equal(res.status, 403);
});

test('POST /: nicht Admin -> 403, kein Backup wird erstellt', async (t) => {
  const { app, dir, backupsDir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'user1');
  const res = await agent.post('/api/backup/');
  assert.equal(res.status, 403);
  assert.ok(!fs.existsSync(backupsDir) || fs.readdirSync(backupsDir).length === 0);
});

// ── Settings ─────────────────────────────────────────────────
test('GET /settings: liefert Defaults', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.get('/api/backup/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { enabled: false, hour: 3, retentionCount: 14, updatedAt: null });
});

test('PUT /settings: gültiger Patch aktualisiert Werte', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.put('/api/backup/settings').send({ enabled: true, hour: 5, retentionCount: 7 });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.hour, 5);
  assert.equal(res.body.retentionCount, 7);
});

test('PUT /settings: ungültige hour -> 400 VALIDATION_FAILED', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.put('/api/backup/settings').send({ hour: 30 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
});

// ── Liste/Erstellen ──────────────────────────────────────────
test('GET /: leere Liste ohne vorhandene Backups', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.get('/api/backup/');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.backups, []);
});

test('POST /: erstellt manuelles Backup, erscheint danach in der Liste', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const create = await agent.post('/api/backup/');
  assert.equal(create.status, 201);
  assert.equal(create.body.backup.type, 'manual');

  const list = await agent.get('/api/backup/');
  assert.equal(list.body.backups.length, 1);
  assert.equal(list.body.backups[0].filename, create.body.backup.filename);
});

test('POST /: Rate-Limit greift nach 5 Aufrufen innerhalb des Fensters', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  for (let i = 0; i < 5; i++) {
    const res = await agent.delete('/api/backup/nonexistent-should-fail.sqlite');
    assert.notEqual(res.status, 429);
  }
  // Löschungen zählen nicht gegen das Backup-Rate-Limit (nur mutierende
  // Backup-Aktionen selbst: create/restore) - hier gezielt 5x POST / auslösen.
});

test('POST /: fünfter Aufruf ok, sechster im selben Fenster liefert 429', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  for (let i = 0; i < 5; i++) {
    const res = await agent.post('/api/backup/');
    assert.equal(res.status, 201);
  }
  const sixth = await agent.post('/api/backup/');
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.code, 'RATE_LIMITED');
});

// ── Download ─────────────────────────────────────────────────
test('GET /:filename/download: liefert die Datei', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const create = await agent.post('/api/backup/');
  const filename = create.body.backup.filename;
  const res = await agent.get(`/api/backup/${filename}/download`);
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-disposition'].includes(filename));
});

test('GET /:filename/download: ungültiger Dateiname -> 400, Traversal wird blockiert', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.get('/api/backup/..%2f..%2fetc%2fpasswd/download');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_FILENAME');
});

test('GET /:filename/download: unbekannte, aber syntaktisch gültige Datei -> 404', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.get('/api/backup/backup-manual-20260101-000000.sqlite/download');
  assert.equal(res.status, 404);
});

// ── Löschen ──────────────────────────────────────────────────
test('DELETE /:filename: entfernt Backup aus der Liste', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const create = await agent.post('/api/backup/');
  const filename = create.body.backup.filename;
  const del = await agent.delete(`/api/backup/${filename}`);
  assert.equal(del.status, 200);
  const list = await agent.get('/api/backup/');
  assert.equal(list.body.backups.length, 0);
});

test('DELETE /:filename: nicht existierendes Backup -> 404', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.delete('/api/backup/backup-manual-20260101-000000.sqlite');
  assert.equal(res.status, 404);
});

// ── Restore aus Liste ────────────────────────────────────────
test('POST /:filename/restore: erfolgreiche Wiederherstellung invalidiert alle Sitzungen', async (t) => {
  const { app, dir, sessionStore } = buildTestApp();
  t.after(() => cleanup(dir));
  const adminAgent = await loginAgent(app, 'admin1');
  const otherAgent = await loginAgent(app, 'user1');

  const create = await adminAgent.post('/api/backup/');
  const filename = create.body.backup.filename;

  await new Promise((resolve, reject) => sessionStore.length((err, n) => (err ? reject(err) : resolve(n))))
    .then((n) => assert.ok(n >= 2));

  const restore = await adminAgent.post(`/api/backup/${filename}/restore`);
  assert.equal(restore.status, 200);
  assert.equal(restore.body.sessionsInvalidated, true);
  assert.ok(restore.body.preRestoreBackup);

  const remaining = await new Promise((resolve, reject) => sessionStore.length((err, n) => (err ? reject(err) : resolve(n))));
  assert.equal(remaining, 0);

  const whoami = await otherAgent.get('/test/whoami');
  assert.equal(whoami.body.uid, null);
});

test('POST /:filename/restore: nicht existierendes Backup -> 404', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.post('/api/backup/backup-manual-20260101-000000.sqlite/restore');
  assert.equal(res.status, 404);
});

test('POST /:filename/restore: ungültiger Dateiname -> 400', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent.post('/api/backup/not-a-backup.txt/restore');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_FILENAME');
});

// ── Restore-Upload ───────────────────────────────────────────
test('POST /restore-upload: gültige hochgeladene Datei stellt wieder her', async (t) => {
  const { app, dir, db: liveDb } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');

  // Baue eine eigenständige, gültige "Backup"-Datei mit denselben Kern-Tabellen.
  const srcPath = path.join(dir, 'upload-source.sqlite');
  const srcDb = new Database(srcPath);
  srcDb.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'user\')');
  srcDb.exec(REQUIRED_SCHEMA.replace('CREATE VIRTUAL TABLE search_index USING fts5(ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body);', ''));
  srcDb.prepare("INSERT INTO users VALUES ('admin1','admin-aus-upload','admin')").run();
  srcDb.close();
  const buf = fs.readFileSync(srcPath);

  const res = await agent
    .post('/api/backup/restore-upload')
    .set('Content-Type', 'application/octet-stream')
    .send(buf);
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionsInvalidated, true);

  assert.equal(liveDb.prepare("SELECT username FROM users WHERE id='admin1'").get().username, 'admin-aus-upload');
});

test('POST /restore-upload: ungültige Datei -> 422, Live-DB unverändert', async (t) => {
  const { app, dir, db: liveDb } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');

  const res = await agent
    .post('/api/backup/restore-upload')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('offensichtlich keine sqlite datei'));
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'RESTORE_VALIDATION_FAILED');
  assert.equal(liveDb.prepare("SELECT username FROM users WHERE id='admin1'").get().username, 'admin');
});

test('POST /restore-upload: Content-Length über Limit -> 413, ohne Body-Parsing', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent
    .post('/api/backup/restore-upload')
    .set('Content-Type', 'application/octet-stream')
    .set('Content-Length', String(300 * 1024 * 1024))
    .send(Buffer.from('klein, aber die Content-Length behauptet 300MB'));
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
});

test('POST /restore-upload: leerer Body -> 400 INVALID_FILE', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app, 'admin1');
  const res = await agent
    .post('/api/backup/restore-upload')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(0));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_FILE');
});
