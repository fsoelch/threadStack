'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');

const graphRoutes = require('../graph');

// ── Selbstständiger Test-Harness (siehe graph_read.test.js für Begründung) ──

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

function makeTheme(db, userId, title = 'T') {
  const themeId = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(themeId, userId, title, '', now());
  return themeId;
}

test('PATCH /api/graph/positions: Upsert speichert neue Positionen', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);

  const res = await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({
    positions: [{ type: 'theme', id: themeId, x: 12.5, y: -3.25 }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.saved, 1);
  assert.deepEqual(res.body.ignored, []);

  const row = db.prepare('SELECT * FROM graph_node_positions WHERE user_id=? AND node_type=? AND node_id=?')
    .get(userId, 'theme', themeId);
  assert.equal(row.x, 12.5);
  assert.equal(row.y, -3.25);
});

test('PATCH /api/graph/positions: Upsert ist idempotent (zweiter Aufruf überschreibt)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);

  await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({
    positions: [{ type: 'theme', id: themeId, x: 1, y: 1 }],
  });
  const res2 = await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({
    positions: [{ type: 'theme', id: themeId, x: 99, y: 100 }],
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.saved, 1);

  const rows = db.prepare('SELECT * FROM graph_node_positions WHERE user_id=? AND node_type=? AND node_id=?')
    .all(userId, 'theme', themeId);
  assert.equal(rows.length, 1, 'darf keine Duplikate anlegen (Upsert)');
  assert.equal(rows[0].x, 99);
  assert.equal(rows[0].y, 100);
});

test('PATCH /api/graph/positions: ungültige Koordinate lehnt den GESAMTEN Batch ab (400 INVALID_COORDINATE)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const theme1 = makeTheme(db, userId);
  const theme2 = makeTheme(db, userId);

  const casesInvalid = [NaN, Infinity, -Infinity, 100001, -100001];
  for (const bad of casesInvalid) {
    const res = await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({
      positions: [
        { type: 'theme', id: theme1, x: 1, y: 1 },
        { type: 'theme', id: theme2, x: bad, y: 1 },
      ],
    });
    assert.equal(res.status, 400, `bad=${bad}`);
    assert.equal(res.body.code, 'INVALID_COORDINATE');
  }

  // Sicherstellen, dass auch der gültige erste Eintrag NICHT gespeichert wurde
  const row = db.prepare('SELECT * FROM graph_node_positions WHERE node_id=?').get(theme1);
  assert.equal(row, undefined);
});

test('PATCH /api/graph/positions: fremde/unbekannte Knoten landen in ignored, Rest wird trotzdem gespeichert', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const me = seedUser(db, 'me');
  const other = seedUser(db, 'other');
  const myTheme = makeTheme(db, me);
  const otherTheme = makeTheme(db, other);

  const res = await request(app).patch('/api/graph/positions').set('x-user-id', me).send({
    positions: [
      { type: 'theme', id: myTheme, x: 5, y: 5 },
      { type: 'theme', id: otherTheme, x: 6, y: 6 },
      { type: 'theme', id: 'does-not-exist', x: 7, y: 7 },
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.saved, 1);
  assert.equal(res.body.ignored.length, 2);
  for (const ig of res.body.ignored) {
    assert.equal(ig.reason, 'unknown');
  }

  const myRow = db.prepare('SELECT * FROM graph_node_positions WHERE node_id=?').get(myTheme);
  assert.ok(myRow);
  const otherRow = db.prepare('SELECT * FROM graph_node_positions WHERE node_id=?').get(otherTheme);
  assert.equal(otherRow, undefined, 'fremder Knoten darf nicht gespeichert werden');
});

test('PATCH /api/graph/positions: Batch > 500 -> 413 PAYLOAD_TOO_LARGE', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const positions = Array.from({ length: 501 }, (_, i) => ({ type: 'theme', id: `t${i}`, x: 0, y: 0 }));

  const res = await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({ positions });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
});

test('PATCH /api/graph/positions: leeres Array -> 400 VALIDATION_FAILED', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const res = await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({ positions: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
});

test('PATCH /api/graph/positions: fehlendes positions-Feld -> 400 VALIDATION_FAILED', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const res = await request(app).patch('/api/graph/positions').set('x-user-id', userId).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
});

test('PATCH /api/graph/positions: strikte Pro-Nutzer-Trennung — ein Nutzer sieht nie Positionen eines anderen', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const me = seedUser(db, 'me');
  const other = seedUser(db, 'other');
  const myTheme = makeTheme(db, me);
  const otherThemeSameId = makeTheme(db, other); // andere ID, aber wir simulieren getrennte Speicherung

  await request(app).patch('/api/graph/positions').set('x-user-id', me).send({
    positions: [{ type: 'theme', id: myTheme, x: 1, y: 2 }],
  });
  await request(app).patch('/api/graph/positions').set('x-user-id', other).send({
    positions: [{ type: 'theme', id: otherThemeSameId, x: 9, y: 9 }],
  });

  const mine = db.prepare('SELECT * FROM graph_node_positions WHERE user_id=?').all(me);
  const others = db.prepare('SELECT * FROM graph_node_positions WHERE user_id=?').all(other);
  assert.equal(mine.length, 1);
  assert.equal(others.length, 1);
  assert.equal(mine[0].node_id, myTheme);
  assert.equal(others[0].node_id, otherThemeSameId);
});

test('PATCH /api/graph/positions: erfordert Authentifizierung', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const res = await request(app).patch('/api/graph/positions').send({ positions: [{ type: 'theme', id: 'x', x: 1, y: 1 }] });
  assert.equal(res.status, 401);
});
