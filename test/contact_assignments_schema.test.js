'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runAssignmentMigrations, purgeAssignmentOrphans } = require('../lib/contacts/assignments/schema');

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE meetings(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, created_at TEXT);
    CREATE TABLE topics(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT);
    CREATE TABLE todos(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT);
    CREATE TABLE contacts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT);
  `);
  return db;
}

function seedUser(db, id = 'u1') {
  db.prepare('INSERT INTO users(id,username) VALUES (?,?)').run(id, id);
  return id;
}
function seedContact(db, userId, id) {
  db.prepare('INSERT INTO contacts(id,user_id,name,created_at) VALUES (?,?,?,?)').run(id, userId, id, new Date().toISOString());
  return id;
}
function seedTodo(db, userId, id) {
  db.prepare('INSERT INTO todos(id,user_id,title,created_at) VALUES (?,?,?,?)').run(id, userId, id, new Date().toISOString());
  return id;
}
function seedTopic(db, userId, id, meetingId = 'm1') {
  if (!db.prepare('SELECT 1 FROM meetings WHERE id=?').get(meetingId)) {
    db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)').run(meetingId, userId, 'M', new Date().toISOString());
  }
  db.prepare('INSERT INTO topics(id,meeting_id,title,created_at) VALUES (?,?,?,?)').run(id, meetingId, id, new Date().toISOString());
  return id;
}

test('runAssignmentMigrations legt Tabelle und Indizes an und ist idempotent', () => {
  const db = buildDb();
  runAssignmentMigrations(db);
  runAssignmentMigrations(db); // zweiter Aufruf darf nicht werfen
  const cols = db.prepare('PRAGMA table_info(contact_assignments)').all().map((c) => c.name);
  assert.deepEqual(
    cols.sort(),
    ['contact_id', 'created_at', 'id', 'ref_id', 'ref_type', 'user_id'].sort()
  );
  const indexes = db.prepare('PRAGMA index_list(contact_assignments)').all().map((i) => i.name);
  assert.ok(indexes.includes('idx_ca_ref'));
  assert.ok(indexes.includes('idx_ca_contact'));
  assert.ok(indexes.includes('idx_ca_user'));
});

test('CHECK-Constraint lässt nur ref_type topic/todo zu', () => {
  const db = buildDb();
  runAssignmentMigrations(db);
  const u = seedUser(db);
  const c = seedContact(db, u, 'c1');
  const t = seedTodo(db, u, 't1');
  // gültig
  assert.doesNotThrow(() => {
    db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('a1', u, c, 'todo', t, new Date().toISOString());
  });
  // ungültig
  assert.throws(() => {
    db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('a2', u, c, 'contact', t, new Date().toISOString());
  }, /CHECK constraint failed/);
});

test('UNIQUE(contact_id, ref_type, ref_id) verhindert doppelte Zuordnung', () => {
  const db = buildDb();
  runAssignmentMigrations(db);
  const u = seedUser(db);
  const c = seedContact(db, u, 'c1');
  const t = seedTodo(db, u, 't1');
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('a1', u, c, 'todo', t, new Date().toISOString());
  assert.throws(() => {
    db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('a2', u, c, 'todo', t, new Date().toISOString());
  }, /UNIQUE constraint failed/);
});

test('ON DELETE CASCADE: Löschen des Kontakts entfernt seine Zuordnungen', () => {
  const db = buildDb();
  runAssignmentMigrations(db);
  const u = seedUser(db);
  const c = seedContact(db, u, 'c1');
  const t = seedTodo(db, u, 't1');
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('a1', u, c, 'todo', t, new Date().toISOString());
  db.prepare('DELETE FROM contacts WHERE id=?').run(c);
  const remaining = db.prepare('SELECT * FROM contact_assignments').all();
  assert.equal(remaining.length, 0);
});

test('purgeAssignmentOrphans löscht nur Zeilen ohne existierendes Gegenstück', () => {
  const db = buildDb();
  runAssignmentMigrations(db);
  const u = seedUser(db);
  const c = seedContact(db, u, 'c1');
  const t = seedTodo(db, u, 't1');
  const tp = seedTopic(db, u, 'tp1');

  // gesunde Zuordnungen
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('healthy-todo', u, c, 'todo', t, new Date().toISOString());
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('healthy-topic', u, c, 'topic', tp, new Date().toISOString());

  // verwaiste Zuordnungen: ref_id existiert nicht (mehr)
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('orphan-todo', u, c, 'todo', 'todo-does-not-exist', new Date().toISOString());
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('orphan-topic', u, c, 'topic', 'topic-does-not-exist', new Date().toISOString());

  const result = purgeAssignmentOrphans(db);
  assert.equal(result.deleted, 2);

  const remainingIds = db.prepare('SELECT id FROM contact_assignments ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(remainingIds.sort(), ['healthy-todo', 'healthy-topic'].sort());
});

test('purgeAssignmentOrphans ist idempotent (zweiter Lauf löscht nichts mehr)', () => {
  const db = buildDb();
  runAssignmentMigrations(db);
  const u = seedUser(db);
  const c = seedContact(db, u, 'c1');
  db.prepare('INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('orphan', u, c, 'todo', 'ghost', new Date().toISOString());

  const first = purgeAssignmentOrphans(db);
  assert.equal(first.deleted, 1);
  const second = purgeAssignmentOrphans(db);
  assert.equal(second.deleted, 0);
});
