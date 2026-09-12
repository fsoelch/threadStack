'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMomentumMigrations } = require('../lib/momentum/schema');
const { applyTodoDoneChange, applyTopicDoneChange } = require('../lib/momentum/completion');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momentum-completion-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE contact_assignments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  runMomentumMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO meetings VALUES ('m1','u1','M',datetime('now'))").run();
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function insertTodo(db, id, done = 0) {
  db.prepare('INSERT INTO todos(id,user_id,title,done,created_at) VALUES (?,?,?,?,datetime(\'now\'))').run(id, 'u1', 'Todo', done);
}
function insertTopic(db, id, done = 0) {
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,datetime(\'now\'))').run(id, 'm1', 'Topic', done);
}
function insertContact(db, id, name) {
  db.prepare('INSERT INTO contacts(id,user_id,name,created_at) VALUES (?,?,?,datetime(\'now\'))').run(id, 'u1', name);
}
function assign(db, contactId, refType, refId) {
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,datetime(\'now\'))')
    .run(`ca-${contactId}-${refType}-${refId}`, 'u1', contactId, refType, refId);
}

// Simuliert die reale Aufrufreihenfolge aus server.js: die BESTEHENDE Route
// setzt `done` bereits selbst im UPDATE-Statement, BEVOR der Momentum-Hook
// aufgerufen wird (siehe Vertrag) - der Hook selbst pflegt nur `completed_at`
// und die Meilenstein-Erkennung, nicht das `done`-Flag.
function completeTodo(db, todoId, done, userId, now) {
  db.prepare('UPDATE todos SET done=? WHERE id=?').run(done ? 1 : 0, todoId);
  return applyTodoDoneChange(db, { todoId, userId, done, now });
}
function completeTopic(db, topicId, done, topicTitle, userId, now) {
  db.prepare('UPDATE topics SET done=? WHERE id=?').run(done ? 1 : 0, topicId);
  return applyTopicDoneChange(db, { topicId, userId, done, topicTitle, now });
}

test('applyTodoDoneChange: setzt completed_at beim Abschliessen und leert es beim Wiedereroeffnen', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, 'todo1');

  const r1 = completeTodo(db, 'todo1', true, 'u1', new Date('2026-09-11T10:00:00.000Z'));
  assert.deepEqual(r1.milestones, []);
  assert.equal(db.prepare('SELECT completed_at FROM todos WHERE id=?').get('todo1').completed_at, '2026-09-11T10:00:00.000Z');

  const r2 = completeTodo(db, 'todo1', false, 'u1', new Date('2026-09-11T11:00:00.000Z'));
  assert.deepEqual(r2.milestones, []);
  assert.equal(db.prepare('SELECT completed_at FROM todos WHERE id=?').get('todo1').completed_at, '');
});

test('applyTodoDoneChange: fremder Nutzer kann das Todo eines anderen Nutzers nicht abschliessen', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, 'todo1');
  completeTodo(db, 'todo1', true, 'other-user', new Date());
  assert.equal(db.prepare('SELECT completed_at FROM todos WHERE id=?').get('todo1').completed_at, '');
});

test('applyTopicDoneChange: Abschliessen eines Themas ist IMMER ein Meilenstein', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTopic(db, 'topic1');
  const r = completeTopic(db, 'topic1', true, 'Serverumzug', 'u1', new Date('2026-09-11T10:00:00.000Z'));
  assert.deepEqual(r.milestones, [{ type: 'topic', id: 'topic1', name: 'Serverumzug' }]);
  const milestoneRow = db.prepare("SELECT * FROM momentum_milestones WHERE kind='topic' AND ref_id='topic1'").get();
  assert.equal(milestoneRow.name, 'Serverumzug');
});

test('applyTopicDoneChange: Wiedereroeffnen loest keinen Meilenstein aus', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTopic(db, 'topic1', 1);
  const r = completeTopic(db, 'topic1', false, 'Serverumzug', 'u1', new Date());
  assert.deepEqual(r.milestones, []);
});

test('applyTodoDoneChange: Kontakt-Meilenstein erst beim LETZTEN offenen zugewiesenen Vorhaben', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, 'todo1');
  insertTodo(db, 'todo2');
  insertContact(db, 'c1', 'Frau Meyer');
  assign(db, 'c1', 'todo', 'todo1');
  assign(db, 'c1', 'todo', 'todo2');

  const r1 = completeTodo(db, 'todo1', true, 'u1', new Date('2026-09-11T10:00:00.000Z'));
  assert.deepEqual(r1.milestones, []); // todo2 ist noch offen

  const r2 = completeTodo(db, 'todo2', true, 'u1', new Date('2026-09-11T11:00:00.000Z'));
  assert.deepEqual(r2.milestones, [{ type: 'contact', id: 'c1', name: 'Frau Meyer' }]);
});

test('applyTodoDoneChange: Kontakt ohne Zuweisungen bleibt ohne Meilenstein', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, 'todo1');
  insertContact(db, 'c1', 'Frau Meyer'); // keine Zuweisung
  const r = completeTodo(db, 'todo1', true, 'u1', new Date());
  assert.deepEqual(r.milestones, []);
});

test('applyTopicDoneChange: Thema- und Kontakt-Meilenstein koennen gemeinsam ausgeloest werden', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTopic(db, 'topic1');
  insertContact(db, 'c1', 'Frau Meyer');
  assign(db, 'c1', 'topic', 'topic1');

  const r = completeTopic(db, 'topic1', true, 'Serverumzug', 'u1', new Date());
  assert.deepEqual(r.milestones, [
    { type: 'topic', id: 'topic1', name: 'Serverumzug' },
    { type: 'contact', id: 'c1', name: 'Frau Meyer' },
  ]);
});

test('applyTodoDoneChange: Kontakt mit gemischten Todo/Thema-Zuweisungen wird erst bei beiden erledigt vollstaendig', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, 'todo1');
  insertTopic(db, 'topic1');
  insertContact(db, 'c1', 'Frau Meyer');
  assign(db, 'c1', 'todo', 'todo1');
  assign(db, 'c1', 'topic', 'topic1');

  const r1 = completeTodo(db, 'todo1', true, 'u1', new Date());
  assert.deepEqual(r1.milestones, []); // topic1 ist noch offen

  const r2 = completeTopic(db, 'topic1', true, 'Thema', 'u1', new Date());
  assert.deepEqual(r2.milestones, [
    { type: 'topic', id: 'topic1', name: 'Thema' },
    { type: 'contact', id: 'c1', name: 'Frau Meyer' },
  ]);
});

