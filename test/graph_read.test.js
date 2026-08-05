'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');
const path = require('path');

const graphRoutes = require('../graph');

// ── Selbstständiger Test-Harness: In-Memory-SQLite + minimaler ctx-Mock ──
// gemäß dem im Arbeitspaket spezifizierten ctx-Vertrag. Diese Fixtures leben
// ausschließlich in den Testdateien von Paket 1b (kein Produktionscode).

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
  // zentraler Error-Handler analog server.js: keine internen Details leaken
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

test('GET /api/graph: Themenhierarchie, Wissen mit mehreren Zuordnungen, Wissen-zu-Wissen, todo/topic/contact nur mit theme_links', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  // Theme-Hierarchie: root -> child
  const rootTheme = id('theme');
  const childTheme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,parent_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(rootTheme, userId, 'Root', '<p>Root <b>Beschreibung</b></p>', null, now());
  db.prepare('INSERT INTO themes(id,user_id,title,description,parent_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(childTheme, userId, 'Child', '', rootTheme, now());

  // Wissen mit zwei Theme-Zuordnungen
  const kp1 = id('kp');
  db.prepare('INSERT INTO knowledge_pages(id,user_id,title,updated_at,created_at) VALUES (?,?,?,?,?)')
    .run(kp1, userId, 'Wissen 1', now(), now());
  db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)')
    .run(id('kl'), kp1, rootTheme, now());
  db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)')
    .run(id('kl'), kp1, childTheme, now());

  // Wissen-zu-Wissen-Verweis
  const kp2 = id('kp');
  db.prepare('INSERT INTO knowledge_pages(id,user_id,title,updated_at,created_at) VALUES (?,?,?,?,?)')
    .run(kp2, userId, 'Wissen 2', now(), now());
  db.prepare('INSERT INTO knowledge_links(id,user_id,page_a_id,page_b_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('kk'), userId, ...[kp1, kp2].sort(), now());

  // Todo MIT theme_link -> erscheint
  const todoLinked = id('todo');
  db.prepare('INSERT INTO todos(id,user_id,title,created_at) VALUES (?,?,?,?)').run(todoLinked, userId, 'Verlinktes Todo', now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('tl'), rootTheme, 'todo', todoLinked, now());

  // Todo OHNE theme_link -> darf NICHT erscheinen
  const todoIsolated = id('todo');
  db.prepare('INSERT INTO todos(id,user_id,title,created_at) VALUES (?,?,?,?)').run(todoIsolated, userId, 'Isoliertes Todo', now());

  // Kontakt mit theme_link
  const contactLinked = id('contact');
  db.prepare('INSERT INTO contacts(id,user_id,name,role,created_at) VALUES (?,?,?,?,?)')
    .run(contactLinked, userId, 'Kontakt A', 'Lead', now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('tl'), childTheme, 'contact', contactLinked, now());

  // Meeting-Thema (topic) mit theme_link
  const meetingId = id('meeting');
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingId, userId, 'Meeting', now());
  const topicLinked = id('topic');
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,?)').run(topicLinked, meetingId, 'Thema', 1, now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('tl'), rootTheme, 'topic', topicLinked, now());

  const res = await request(app).get('/api/graph').set('x-user-id', userId);
  assert.equal(res.status, 200);

  const byKey = new Map(res.body.nodes.map(n => [`${n.type}:${n.id}`, n]));
  assert.ok(byKey.has(`theme:${rootTheme}`));
  assert.ok(byKey.has(`theme:${childTheme}`));
  assert.ok(byKey.has(`knowledge:${kp1}`));
  assert.ok(byKey.has(`knowledge:${kp2}`));
  assert.ok(byKey.has(`todo:${todoLinked}`));
  assert.ok(!byKey.has(`todo:${todoIsolated}`), 'isoliertes Todo ohne theme_link darf nicht im Graphen erscheinen');
  assert.ok(byKey.has(`contact:${contactLinked}`));
  assert.ok(byKey.has(`topic:${topicLinked}`));

  // Meta-Felder
  const rootNode = byKey.get(`theme:${rootTheme}`);
  assert.equal(rootNode.meta.childCount, 1);
  assert.equal(rootNode.meta.parentId, null);
  assert.equal(rootNode.done, null);
  assert.ok(!rootNode.meta.descriptionText.includes('<'), 'descriptionText darf kein HTML enthalten');
  assert.ok(rootNode.meta.descriptionText.includes('Beschreibung'));

  const childNode = byKey.get(`theme:${childTheme}`);
  assert.equal(childNode.meta.parentId, rootTheme);

  const topicNode = byKey.get(`topic:${topicLinked}`);
  assert.equal(topicNode.done, true);
  assert.equal(topicNode.meta.meetingId, meetingId);

  const contactNode = byKey.get(`contact:${contactLinked}`);
  assert.equal(contactNode.meta.role, 'Lead');

  const knowledgeNode = byKey.get(`knowledge:${kp1}`);
  assert.ok(knowledgeNode.meta.updatedAt);

  // Kanten
  const kindsPresent = new Set(res.body.edges.map(e => e.kind));
  assert.ok(kindsPresent.has('hierarchy'));
  assert.ok(kindsPresent.has('knowledge_topic'));
  assert.ok(kindsPresent.has('knowledge_knowledge'));
  assert.ok(kindsPresent.has('theme_link'));

  const hierarchyEdge = res.body.edges.find(e => e.kind === 'hierarchy');
  assert.equal(hierarchyEdge.id, `h:${childTheme}`);
  assert.equal(hierarchyEdge.source.id, rootTheme);
  assert.equal(hierarchyEdge.target.id, childTheme);

  // schema-Feld
  assert.deepEqual(res.body.schema.nodeTypes, ['theme', 'knowledge', 'todo', 'topic', 'contact']);
  assert.ok(res.body.schema.compatibility.some(c => c.source === 'theme' && c.target === 'theme' && c.kind === 'hierarchy'));

  assert.equal(res.body.stats.truncated, false);
  assert.equal(res.body.stats.nodeCount, res.body.nodes.length);
  assert.equal(res.body.stats.edgeCount, res.body.edges.length);
});

test('GET /api/graph: Fremdnutzer-Isolation — Objekte anderer Nutzer erscheinen nie', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const me = seedUser(db, 'me');
  const other = seedUser(db, 'other');

  const myTheme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(myTheme, me, 'Meins', '', now());

  const otherTheme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(otherTheme, other, 'Fremd', '', now());

  const otherKp = id('kp');
  db.prepare('INSERT INTO knowledge_pages(id,user_id,title,updated_at,created_at) VALUES (?,?,?,?,?)')
    .run(otherKp, other, 'Fremdes Wissen', now(), now());

  const otherTodo = id('todo');
  db.prepare('INSERT INTO todos(id,user_id,title,created_at) VALUES (?,?,?,?)').run(otherTodo, other, 'Fremdes Todo', now());
  db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(id('tl'), otherTheme, 'todo', otherTodo, now());

  const res = await request(app).get('/api/graph').set('x-user-id', me);
  assert.equal(res.status, 200);

  const keys = new Set(res.body.nodes.map(n => `${n.type}:${n.id}`));
  assert.ok(keys.has(`theme:${myTheme}`));
  assert.ok(!keys.has(`theme:${otherTheme}`));
  assert.ok(!keys.has(`knowledge:${otherKp}`));
  assert.ok(!keys.has(`todo:${otherTodo}`));
});

test('GET /api/graph: Positions-Sweep entfernt verwaiste Positionsdaten desselben Nutzers', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const liveTheme = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(liveTheme, userId, 'Lebt', '', now());
  db.prepare('INSERT INTO graph_node_positions(user_id,node_type,node_id,x,y,updated_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'theme', liveTheme, 10, 20, now());

  // Verwaiste Position: Knoten existiert nicht (mehr)
  db.prepare('INSERT INTO graph_node_positions(user_id,node_type,node_id,x,y,updated_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'theme', 'theme_geloescht', 1, 1, now());
  db.prepare('INSERT INTO graph_node_positions(user_id,node_type,node_id,x,y,updated_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'todo', 'todo_ohne_link', 5, 5, now());

  const before = db.prepare('SELECT COUNT(*) c FROM graph_node_positions WHERE user_id=?').get(userId).c;
  assert.equal(before, 3);

  const res = await request(app).get('/api/graph').set('x-user-id', userId);
  assert.equal(res.status, 200);

  const after = db.prepare('SELECT * FROM graph_node_positions WHERE user_id=?').all(userId);
  assert.equal(after.length, 1);
  assert.equal(after[0].node_id, liveTheme);

  const themeNode = res.body.nodes.find(n => n.type === 'theme' && n.id === liveTheme);
  assert.equal(themeNode.hasStoredPosition, true);
  assert.equal(themeNode.x, 10);
  assert.equal(themeNode.y, 20);
});

test('GET /api/graph: Positions-Sweep betrifft nur den eigenen Nutzer', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const me = seedUser(db, 'me');
  const other = seedUser(db, 'other');

  // Position eines anderen Nutzers, die für DEN Nutzer verwaist ist -> darf beim
  // Laden von "me" nicht angefasst werden.
  db.prepare('INSERT INTO graph_node_positions(user_id,node_type,node_id,x,y,updated_at) VALUES (?,?,?,?,?,?)')
    .run(other, 'theme', 'orphan_of_other', 1, 1, now());

  await request(app).get('/api/graph').set('x-user-id', me);

  const stillThere = db.prepare('SELECT * FROM graph_node_positions WHERE user_id=?').all(other);
  assert.equal(stillThere.length, 1);
});

test('GET /api/graph: descriptionText ist gekürzt (max 500 Zeichen) und HTML-frei', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const longText = '<p>' + 'A'.repeat(1000) + '</p>';
  const themeId = id('theme');
  db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
    .run(themeId, userId, 'Lang', longText, now());

  const res = await request(app).get('/api/graph').set('x-user-id', userId);
  const node = res.body.nodes.find(n => n.type === 'theme' && n.id === themeId);
  assert.ok(node.meta.descriptionText.length <= 500);
  assert.ok(!node.meta.descriptionText.includes('<'));
});

test('GET /api/graph: erfordert Authentifizierung', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const res = await request(app).get('/api/graph');
  assert.equal(res.status, 401);
});

test('GET /api/graph: konstante Anzahl an SQL-Statements unabhängig von der Knotenzahl', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const userId = seedUser(db);

  const origPrepare = db.prepare.bind(db);
  let prepareCount = 0;
  db.prepare = (sql) => { prepareCount++; return origPrepare(sql); };

  // 10 Themes
  for (let i = 0; i < 10; i++) {
    db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
      .run(id('theme'), userId, `Theme ${i}`, '', now());
  }
  prepareCount = 0;
  await request(app).get('/api/graph').set('x-user-id', userId);
  const countAt10 = prepareCount;

  // Weitere 190 Themes (insgesamt 200)
  for (let i = 0; i < 190; i++) {
    db.prepare('INSERT INTO themes(id,user_id,title,description,created_at) VALUES (?,?,?,?,?)')
      .run(id('theme'), userId, `Theme+ ${i}`, '', now());
  }
  prepareCount = 0;
  await request(app).get('/api/graph').set('x-user-id', userId);
  const countAt200 = prepareCount;

  assert.equal(countAt10, countAt200, 'Query-Anzahl darf nicht mit der Knotenzahl wachsen (kein N+1)');
});
