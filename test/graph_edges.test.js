'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');

const graphRoutes = require('../graph');
const { COMPATIBILITY, NODE_TYPES } = require('../graph/schema');

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

function makeTheme(db, userId, title = 'T', parentId = null) {
  const themeId = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,parent_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(themeId, userId, title, '', parentId, now());
  return themeId;
}
function makeKnowledge(db, userId, title = 'K') {
  const kid = id('kp');
  db.prepare('INSERT INTO knowledge_pages(id,user_id,title,updated_at,created_at) VALUES (?,?,?,?,?)')
    .run(kid, userId, title, now(), now());
  return kid;
}
function makeTodo(db, userId, title = 'Todo') {
  const tid = id('todo');
  db.prepare('INSERT INTO todos(id,user_id,title,created_at) VALUES (?,?,?,?)').run(tid, userId, title, now());
  return tid;
}
function makeContact(db, userId, name = 'C') {
  const cid = id('contact');
  db.prepare('INSERT INTO contacts(id,user_id,name,role,created_at) VALUES (?,?,?,?,?)').run(cid, userId, name, '', now());
  return cid;
}
function makeTopic(db, userId, title = 'Topic') {
  const meetingId = id('meeting');
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingId, userId, 'M', now());
  const topicId = id('topic');
  db.prepare('INSERT INTO topics(id,meeting_id,title,created_at) VALUES (?,?,?,?)').run(topicId, meetingId, title, now());
  return topicId;
}

// ── Kompatibilitätsmatrix: alle positiven und negativen Kombinationen ──

test('Kompatibilitätsmatrix: alle in COMPATIBILITY definierten Kombinationen sind erlaubt', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const factories = {
    theme: () => makeTheme(db, userId),
    knowledge: () => makeKnowledge(db, userId),
    todo: () => makeTodo(db, userId),
    topic: () => makeTopic(db, userId),
    contact: () => makeContact(db, userId),
  };

  for (const [key, kind] of Object.entries(COMPATIBILITY)) {
    const [sourceType, targetType] = key.split('|');
    const sourceId = factories[sourceType]();
    const targetId = factories[targetType]();
    const res = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
      source: { type: sourceType, id: sourceId },
      target: { type: targetType, id: targetId },
    });
    assert.equal(res.status, 201, `${key} sollte 201 liefern, bekam ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.edge.kind, kind);
  }
});

test('Kompatibilitätsmatrix: alle nicht gelisteten Kombinationen liefern 409 INCOMPATIBLE_LINK', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const factories = {
    theme: () => makeTheme(db, userId),
    knowledge: () => makeKnowledge(db, userId),
    todo: () => makeTodo(db, userId),
    topic: () => makeTopic(db, userId),
    contact: () => makeContact(db, userId),
  };

  const incompatiblePairs = [];
  for (const a of NODE_TYPES) {
    for (const b of NODE_TYPES) {
      if (COMPATIBILITY[`${a}|${b}`] || COMPATIBILITY[`${b}|${a}`]) continue;
      incompatiblePairs.push([a, b]);
    }
  }
  assert.ok(incompatiblePairs.length > 0);

  for (const [sourceType, targetType] of incompatiblePairs) {
    const sourceId = factories[sourceType]();
    const targetId = factories[targetType]();
    const res = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
      source: { type: sourceType, id: sourceId },
      target: { type: targetType, id: targetId },
    });
    assert.equal(res.status, 409, `${sourceType}|${targetType} sollte 409 liefern`);
    assert.equal(res.body.code, 'INCOMPATIBLE_LINK');
  }
});

test('POST /api/graph/edges: unbekannter Knotentyp -> 400 INVALID_NODE_TYPE', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const res = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: themeId },
    target: { type: 'unicorn', id: 'xyz' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_NODE_TYPE');
});

// ── hierarchy: Zyklus / Selbstelternteil ──

test('hierarchy: Selbstelternteil wird abgelehnt (409 SELF_PARENT)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const res = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: themeId },
    target: { type: 'theme', id: themeId },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'SELF_PARENT');
});

test('hierarchy: Zyklus wird abgelehnt (409 CYCLE)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const root = makeTheme(db, userId, 'Root');
  const child = makeTheme(db, userId, 'Child', root);
  // root soll Kind von child werden -> Zyklus, da child bereits Nachfahre... nein,
  // root ist Vorfahre von child. Wir versuchen, child zum Elternteil von root zu machen.
  const res = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: root },
    target: { type: 'theme', id: child },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CYCLE');
});

test('hierarchy: erfolgreiches Anlegen setzt parent_id und ist idempotent', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const parent = makeTheme(db, userId, 'Parent');
  const child = makeTheme(db, userId, 'Child');

  const res1 = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: child },
    target: { type: 'theme', id: parent },
  });
  assert.equal(res1.status, 201);
  assert.equal(res1.body.created, true);
  assert.equal(res1.body.edge.id, `h:${child}`);

  const row = db.prepare('SELECT parent_id FROM themes WHERE id=?').get(child);
  assert.equal(row.parent_id, parent);

  const res2 = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: child },
    target: { type: 'theme', id: parent },
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.created, false);
});

// ── Idempotenz weiterer Kantenarten ──

test('knowledge_topic: erneutes Anlegen ist idempotent (200, created:false)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const kpId = makeKnowledge(db, userId);

  const res1 = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'knowledge', id: kpId },
    target: { type: 'theme', id: themeId },
  });
  assert.equal(res1.status, 201);
  assert.equal(res1.body.created, true);

  const res2 = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: themeId },
    target: { type: 'knowledge', id: kpId },
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.created, false);
  assert.equal(res2.body.edge.id, res1.body.edge.id);

  const count = db.prepare('SELECT COUNT(*) c FROM knowledge_topic_links').get().c;
  assert.equal(count, 1);
});

test('knowledge_knowledge: IDs werden lexikografisch sortiert gespeichert', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const kpA = makeKnowledge(db, userId, 'A');
  const kpB = makeKnowledge(db, userId, 'B');
  const [expectedA, expectedB] = [kpA, kpB].sort();

  const res = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'knowledge', id: kpB },
    target: { type: 'knowledge', id: kpA },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.edge.source.id, expectedA);
  assert.equal(res.body.edge.target.id, expectedB);

  const row = db.prepare('SELECT * FROM knowledge_links').get();
  assert.equal(row.page_a_id, expectedA);
  assert.equal(row.page_b_id, expectedB);
});

test('theme_link: idempotent für todo/topic/contact', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const todoId = makeTodo(db, userId);

  const res1 = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: themeId },
    target: { type: 'todo', id: todoId },
  });
  assert.equal(res1.status, 201);

  const res2 = await request(app).post('/api/graph/edges').set('x-user-id', userId).send({
    source: { type: 'theme', id: themeId },
    target: { type: 'todo', id: todoId },
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.created, false);

  const count = db.prepare('SELECT COUNT(*) c FROM theme_links').get().c;
  assert.equal(count, 1);
});

// ── Fremdnutzer-Ablehnung (kein Existenz-Orakel) ──

test('POST /api/graph/edges: fremde/nicht existierende Referenzen liefern identisch 404 NOT_FOUND', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const me = seedUser(db, 'me');
  const other = seedUser(db, 'other');
  const myTheme = makeTheme(db, me);
  const otherTheme = makeTheme(db, other);

  const resForeign = await request(app).post('/api/graph/edges').set('x-user-id', me).send({
    source: { type: 'theme', id: myTheme },
    target: { type: 'theme', id: otherTheme },
  });
  const resMissing = await request(app).post('/api/graph/edges').set('x-user-id', me).send({
    source: { type: 'theme', id: myTheme },
    target: { type: 'theme', id: 'does-not-exist' },
  });

  assert.equal(resForeign.status, 404);
  assert.equal(resMissing.status, 404);
  assert.equal(resForeign.body.code, 'NOT_FOUND');
  assert.equal(resMissing.body.code, 'NOT_FOUND');
  assert.equal(resForeign.body.error, resMissing.body.error, 'fremd und nicht-existent müssen identisch aussehen (kein Existenz-Orakel)');
});

test('POST /api/graph/edges: erfordert Authentifizierung', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const res = await request(app).post('/api/graph/edges').send({
    source: { type: 'theme', id: 'a' },
    target: { type: 'theme', id: 'b' },
  });
  assert.equal(res.status, 401);
});

// ── DELETE für alle vier Präfix-Typen ──

test('DELETE h: setzt Theme auf Wurzel (parent_id=NULL)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const parent = makeTheme(db, userId);
  const child = makeTheme(db, userId, 'Child', parent);

  const res = await request(app).delete(`/api/graph/edges/h:${child}`).set('x-user-id', userId);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.warning, null);

  const row = db.prepare('SELECT parent_id FROM themes WHERE id=?').get(child);
  assert.equal(row.parent_id, null);
});

test('DELETE kt: löscht Zuordnung und setzt Warnung bei letzter Verknüpfung', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const kpId = makeKnowledge(db, userId);
  const linkId = id('kl');
  db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)')
    .run(linkId, kpId, themeId, now());

  const res = await request(app).delete(`/api/graph/edges/kt:${linkId}`).set('x-user-id', userId);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.warning, 'KNOWLEDGE_PAGE_NOW_UNASSIGNED');

  const remaining = db.prepare('SELECT COUNT(*) c FROM knowledge_topic_links WHERE id=?').get(linkId).c;
  assert.equal(remaining, 0);
});

test('DELETE kt: keine Warnung, wenn weitere Verknüpfungen bestehen bleiben', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const theme1 = makeTheme(db, userId);
  const theme2 = makeTheme(db, userId);
  const kpId = makeKnowledge(db, userId);
  const link1 = id('kl');
  const link2 = id('kl');
  db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)').run(link1, kpId, theme1, now());
  db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)').run(link2, kpId, theme2, now());

  const res = await request(app).delete(`/api/graph/edges/kt:${link1}`).set('x-user-id', userId);
  assert.equal(res.status, 200);
  assert.equal(res.body.warning, null);
});

test('DELETE kk: löscht Wissen-zu-Wissen-Verweis', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const kpA = makeKnowledge(db, userId);
  const kpB = makeKnowledge(db, userId);
  const [a, b] = [kpA, kpB].sort();
  const linkId = id('kk');
  db.prepare('INSERT INTO knowledge_links(id,user_id,page_a_id,page_b_id,created_at) VALUES (?,?,?,?,?)').run(linkId, userId, a, b, now());

  const res = await request(app).delete(`/api/graph/edges/kk:${linkId}`).set('x-user-id', userId);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const remaining = db.prepare('SELECT COUNT(*) c FROM knowledge_links WHERE id=?').get(linkId).c;
  assert.equal(remaining, 0);
});

test('DELETE tl: löscht theme_link-Verknüpfung', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const todoId = makeTodo(db, userId);
  const linkId = id('tl');
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)').run(linkId, themeId, 'todo', todoId, now());

  const res = await request(app).delete(`/api/graph/edges/tl:${linkId}`).set('x-user-id', userId);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const remaining = db.prepare('SELECT COUNT(*) c FROM theme_links WHERE id=?').get(linkId).c;
  assert.equal(remaining, 0);
});

test('DELETE: idempotent — bereits gelöschte Kante liefert weiterhin 200 ok:true', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const themeId = makeTheme(db, userId);
  const todoId = makeTodo(db, userId);
  const linkId = id('tl');
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)').run(linkId, themeId, 'todo', todoId, now());

  const res1 = await request(app).delete(`/api/graph/edges/tl:${linkId}`).set('x-user-id', userId);
  assert.equal(res1.status, 200);
  const res2 = await request(app).delete(`/api/graph/edges/tl:${linkId}`).set('x-user-id', userId);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.ok, true);
});

test('DELETE: fremde Kante liefert identisch 200 ok:true wie eine nicht existierende Kante (kein Existenz-Orakel)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const me = seedUser(db, 'me');
  const other = seedUser(db, 'other');
  const otherTheme = makeTheme(db, other);
  const otherTodo = makeTodo(db, other);
  const linkId = id('tl');
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)').run(linkId, otherTheme, 'todo', otherTodo, now());

  const resForeign = await request(app).delete(`/api/graph/edges/tl:${linkId}`).set('x-user-id', me);
  const resMissing = await request(app).delete('/api/graph/edges/tl:does-not-exist').set('x-user-id', me);

  assert.equal(resForeign.status, 200);
  assert.equal(resMissing.status, 200);
  assert.deepEqual(resForeign.body, resMissing.body);

  // Fremde Kante bleibt unangetastet
  const stillThere = db.prepare('SELECT COUNT(*) c FROM theme_links WHERE id=?').get(linkId).c;
  assert.equal(stillThere, 1);
});

test('DELETE: unbekanntes Präfix -> 400 VALIDATION_FAILED', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const res = await request(app).delete('/api/graph/edges/zz:foo').set('x-user-id', userId);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
});

test('DELETE: fehlender Doppelpunkt -> 400 VALIDATION_FAILED', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);
  const res = await request(app).delete('/api/graph/edges/malformed').set('x-user-id', userId);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
});
