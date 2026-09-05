'use strict';
// Eigenständiger Test-Harness für die Kontakt-Zuständigkeiten-API
// (Arbeitspaket B3), analog zum Muster in test/graph_edges.test.js:
// eigenes In-Memory-Schema + eigene ownsRef/requireAuth-Implementierung,
// damit die Tests unabhängig vom (in diesem Worktree teils noch nicht
// vorhandenen) server.js laufen.

const express = require('express');
const Database = require('better-sqlite3');
const { runAssignmentMigrations } = require('../lib/contacts/assignments/schema');
const { createAssignmentsRouter } = require('../lib/contacts/assignments/router');

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE meetings(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT);
    CREATE TABLE topics(
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT,
      done INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT NOT NULL DEFAULT '', created_at TEXT
    );
    CREATE TABLE todos(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT,
      done INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
      created_at TEXT
    );
    CREATE TABLE contacts(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT
    );
  `);
  runAssignmentMigrations(db);
  return db;
}

function ownsRef(db, uid, refType, refId) {
  if (refType === 'topic') {
    return !!db.prepare('SELECT 1 FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.user_id=?').get(refId, uid);
  }
  if (refType === 'todo') {
    return !!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=?').get(refId, uid);
  }
  return false;
}

// Referenz-Implementierung für "ist dieses Vorhaben schreibgeschützt, weil
// sein Meeting archiviert ist" — im Bestand (server.js) existiert dieses
// Konzept zum Zeitpunkt der Umsetzung nicht (siehe Abschlussbericht). Der
// Test-Harness bildet es trotzdem nach, um die injizierte Schnittstelle
// (isRefReadOnly) end-to-end zu verifizieren.
function isRefReadOnly(db, refType, refId) {
  if (refType === 'topic') {
    const row = db.prepare('SELECT m.archived AS archived FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=?').get(refId);
    return !!(row && row.archived);
  }
  return false;
}

let seq = 0;
function id(prefix = 'id') {
  seq += 1;
  return `${prefix}_${seq}`;
}
function nowIso() {
  return new Date().toISOString();
}

function seedUser(db, username) {
  const uid = id('user');
  db.prepare('INSERT INTO users(id,username) VALUES (?,?)').run(uid, username || uid);
  return uid;
}
function seedContact(db, userId, overrides = {}) {
  const cid = id('contact');
  const name = overrides.name || cid;
  db.prepare(
    'INSERT INTO contacts(id,user_id,name,role,email,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(cid, userId, name, overrides.role || '', overrides.email || '', overrides.sortOrder || 0, nowIso());
  return cid;
}
function seedTodo(db, userId, overrides = {}) {
  const tid = id('todo');
  db.prepare(
    'INSERT INTO todos(id,user_id,title,done,snoozed_until,due_date,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(tid, userId, overrides.title || tid, overrides.done ? 1 : 0, overrides.snoozedUntil || '', overrides.dueDate || '', nowIso());
  return tid;
}
function seedMeeting(db, userId, overrides = {}) {
  const mid = id('meeting');
  db.prepare('INSERT INTO meetings(id,user_id,title,archived,created_at) VALUES (?,?,?,?,?)')
    .run(mid, userId, overrides.title || 'Meeting', overrides.archived ? 1 : 0, nowIso());
  return mid;
}
function seedTopic(db, userId, overrides = {}) {
  const meetingId = overrides.meetingId || seedMeeting(db, userId, overrides);
  const tpid = id('topic');
  db.prepare(
    'INSERT INTO topics(id,meeting_id,title,done,snoozed_until,created_at) VALUES (?,?,?,?,?,?)'
  ).run(tpid, meetingId, overrides.title || tpid, overrides.done ? 1 : 0, overrides.snoozedUntil || '', nowIso());
  return tpid;
}

function buildApp(db, { now } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    const u = req.headers['x-user-id'];
    if (!u) return res.status(401).json({ error: 'auth required' });
    req.session = { uid: String(u) };
    next();
  };
  const router = createAssignmentsRouter({
    db,
    requireAuth,
    ownsRef: (uid, refType, refId) => ownsRef(db, uid, refType, refId),
    isRefReadOnly: (refType, refId) => isRefReadOnly(db, refType, refId),
    now: now || nowIso,
  });
  app.use('/api', router);
  // Generischer Fehler-Handler wie in server.js: keine Stacktraces an den Client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Interner Fehler', code: 'INTERNAL_ERROR' });
  });
  return app;
}

module.exports = {
  buildDb,
  buildApp,
  seedUser,
  seedContact,
  seedTodo,
  seedMeeting,
  seedTopic,
  nowIso,
};
