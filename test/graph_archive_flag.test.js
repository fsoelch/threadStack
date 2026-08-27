'use strict';
// Paket B3 ("Meetings archivieren statt löschen" - Nebenverbraucher KI & Graph):
// Anders als im KI-Modul werden Topic-Knoten archivierter Meetings NICHT aus
// dem Graphen gefiltert (wissensorientierte Sicht des Archivs), sondern über
// `meta.archived` gekennzeichnet.
//
// Eigenständiger Test-Harness analog test/graph_read.test.js (Paket 1b) -
// keine Abhängigkeit von server.js, da die Server-Integration des Archiv-
// Kernmoduls (Paket B2) parallel läuft und noch nicht in diesem Worktree
// vorliegt (siehe Abschlussbericht).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');

const graphRoutes = require('../graph');
const archiveLib = require('../lib/archive');

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE meetings(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, created_at TEXT);
    CREATE TABLE topics(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT);
    CREATE TABLE todos(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, done INTEGER NOT NULL DEFAULT 0, due_date TEXT NOT NULL DEFAULT '', created_at TEXT);
    CREATE TABLE themes(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, description TEXT NOT NULL DEFAULT '', parent_id TEXT, created_at TEXT);
    CREATE TABLE theme_links(id TEXT PRIMARY KEY, theme_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT, UNIQUE(theme_id, ref_id));
    CREATE TABLE knowledge_pages(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, updated_at TEXT, created_at TEXT);
    CREATE TABLE knowledge_topic_links(id TEXT PRIMARY KEY, knowledge_page_id TEXT NOT NULL, theme_id TEXT NOT NULL, created_at TEXT, UNIQUE(knowledge_page_id, theme_id));
    CREATE TABLE knowledge_links(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_a_id TEXT NOT NULL, page_b_id TEXT NOT NULL, created_at TEXT, UNIQUE(page_a_id, page_b_id), CHECK(page_a_id < page_b_id));
    CREATE TABLE contacts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT '', created_at TEXT);
    CREATE TABLE graph_node_positions(user_id TEXT NOT NULL, node_type TEXT NOT NULL, node_id TEXT NOT NULL, x REAL, y REAL, updated_at TEXT, PRIMARY KEY(user_id, node_type, node_id));
  `);
  archiveLib.runArchiveMigrations(db);
  return db;
}

function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function ownsRef(db, userId, refType, refId) {
  switch (refType) {
    case 'theme': return !!db.prepare('SELECT 1 FROM themes WHERE id=? AND user_id=?').get(refId, userId);
    case 'knowledge': return !!db.prepare('SELECT 1 FROM knowledge_pages WHERE id=? AND user_id=?').get(refId, userId);
    case 'todo': return !!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=?').get(refId, userId);
    case 'topic': return !!db.prepare(
      'SELECT 1 FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.user_id=?'
    ).get(refId, userId);
    case 'contact': return !!db.prepare('SELECT 1 FROM contacts WHERE id=? AND user_id=?').get(refId, userId);
    default: return false;
  }
}

function themeDescendantIds(db, themeId) {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM themes WHERE id = ?
      UNION ALL
      SELECT t.id FROM themes t JOIN sub ON t.parent_id = sub.id
    )
    SELECT id FROM sub
  `).all(themeId);
  return rows.map(r => r.id);
}

function fail(res, status, code, msg, extra) {
  res.status(status).json({ error: msg, code, ...(extra || {}) });
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    const u = req.headers['x-user-id'];
    if (!u) return res.status(401).json({ error: 'auth required' });
    req.session = { uid: String(u) };
    next();
  };
  const ctx = {
    db,
    requireAuth,
    uid: (req) => req.session.uid,
    ownsRef: (userId, refType, refId) => ownsRef(db, userId, refType, refId),
    themeDescendantIds: (themeId) => themeDescendantIds(db, themeId),
    fail,
    htmlToText,
    NODE_TYPES: ['theme', 'knowledge', 'todo', 'topic', 'contact'],
  };
  graphRoutes(app, ctx);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Interner Fehler', code: 'INTERNAL_ERROR' });
  });
  return app;
}

let seq = 0;
function id(prefix = 'id') { seq += 1; return `${prefix}_${seq}`; }
function now() { return new Date().toISOString(); }

function seedUser(db, username = 'u') {
  const uid = id('user');
  db.prepare('INSERT INTO users(id,username) VALUES (?,?)').run(uid, username);
  return uid;
}

test('GET /api/graph: Topic-Knoten eines archivierten Meetings hat meta.archived === true', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const theme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(theme, userId, 'Thema', '', now());

  const meetingId = id('meeting');
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingId, userId, 'Archiviertes Meeting', now());
  const topicId = id('topic');
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,?)').run(topicId, meetingId, 'Archiviertes Thema', 0, now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('tl'), theme, 'topic', topicId, now());

  archiveLib.archive(db, userId, 'meeting', meetingId, now());

  const res = await request(app).get('/api/graph').set('x-user-id', userId);
  assert.equal(res.status, 200);

  const topicNode = res.body.nodes.find(n => n.type === 'topic' && n.id === topicId);
  assert.ok(topicNode, 'Topic-Knoten eines archivierten Meetings muss weiterhin im Graphen erscheinen (kein Filtern)');
  assert.equal(topicNode.meta.archived, true);
});

test('GET /api/graph: Topic-Knoten eines nicht-archivierten Meetings hat meta.archived falsy', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const theme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(theme, userId, 'Thema', '', now());

  const meetingId = id('meeting');
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingId, userId, 'Aktives Meeting', now());
  const topicId = id('topic');
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,?)').run(topicId, meetingId, 'Aktives Thema', 0, now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('tl'), theme, 'topic', topicId, now());

  const res = await request(app).get('/api/graph').set('x-user-id', userId);
  assert.equal(res.status, 200);

  const topicNode = res.body.nodes.find(n => n.type === 'topic' && n.id === topicId);
  assert.ok(topicNode);
  assert.ok(!topicNode.meta.archived, 'meta.archived muss falsy sein für ein nicht-archiviertes Meeting');
  // Konvention wie beim bestehenden `done`-Feld: explizit gesetzt statt weggelassen.
  assert.equal(topicNode.meta.archived, false);
});

test('GET /api/graph: mehrere Topics verschiedener Meetings - Batch-Lookup markiert nur das archivierte korrekt (kein N+1)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const theme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(theme, userId, 'Thema', '', now());

  const meetingA = id('meeting');
  const meetingB = id('meeting');
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingA, userId, 'Meeting A', now());
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingB, userId, 'Meeting B', now());

  const topicA = id('topic');
  const topicB = id('topic');
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,?)').run(topicA, meetingA, 'Thema A', 0, now());
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,?)').run(topicB, meetingB, 'Thema B', 0, now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)').run(id('tl'), theme, 'topic', topicA, now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)').run(id('tl'), theme, 'topic', topicB, now());

  archiveLib.archive(db, userId, 'meeting', meetingA, now());

  const origPrepare = db.prepare.bind(db);
  let prepareCount = 0;
  db.prepare = (sql) => { prepareCount++; return origPrepare(sql); };

  const res = await request(app).get('/api/graph').set('x-user-id', userId);
  assert.equal(res.status, 200);

  const nodeA = res.body.nodes.find(n => n.id === topicA);
  const nodeB = res.body.nodes.find(n => n.id === topicB);
  assert.equal(nodeA.meta.archived, true);
  assert.equal(nodeB.meta.archived, false);

  // Der Archiv-Batch-Lookup darf nicht pro Topic, sondern höchstens einmal
  // zusätzlich abgefragt werden (kein N+1) - grobe Obergrenze reicht hier,
  // die exakte Konstanz gegen die Knotenzahl prüft bereits das bestehende
  // Paket-1b-Testcase in graph_read.test.js.
  assert.ok(prepareCount < 20, `zu viele SQL-Statements (${prepareCount}) - Hinweis auf N+1`);
});
