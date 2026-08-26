'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runProgressMigrations, purgeProgressOrphans } = require('../lib/progress/schema');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-schema-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('runProgressMigrations: legt Tabellen/Indizes idempotent an', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  runProgressMigrations(db);
  // Zweiter Aufruf darf nicht werfen (additiv, IF NOT EXISTS).
  assert.doesNotThrow(() => runProgressMigrations(db));

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('progress_entries','progress_meta')"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['progress_entries', 'progress_meta']);

  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_progress%'"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(indexes, [
    'idx_progress_entries_ref',
    'idx_progress_entries_token',
    'idx_progress_entries_user',
    'idx_progress_result_frame',
  ]);
});

test('runProgressMigrations: fasst todos/topics/stack_frames nicht an (keine Spaltenänderung)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const todosBefore = db.prepare('PRAGMA table_info(todos)').all();
  runProgressMigrations(db);
  const todosAfter = db.prepare('PRAGMA table_info(todos)').all();
  assert.deepEqual(todosBefore, todosAfter);
});

test('CHECK-Constraint: ref_type nur todo/topic', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
       VALUES ('e1','u1','invalid','r1','','',datetime('now'))`
    ).run();
  }, /CHECK constraint failed/);
});

test('CHECK-Constraint: kind nur note/result', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,kind,body_html,body_text,created_at)
       VALUES ('e1','u1','todo','r1','invalid','','',datetime('now'))`
    ).run();
  }, /CHECK constraint failed/);
});

test('UNIQUE-Index: client_token pro Nutzer eindeutig (NULL mehrfach erlaubt)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();

  const insert = db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,client_token,created_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'))`
  );
  insert.run('e1', 'u1', 'todo', 'r1', '', '', 'tok-1');
  assert.throws(() => insert.run('e2', 'u1', 'todo', 'r2', '', '', 'tok-1'), /UNIQUE constraint failed/);

  // Mehrere NULL-Tokens sind erlaubt (WHERE client_token IS NOT NULL).
  assert.doesNotThrow(() => insert.run('e3', 'u1', 'todo', 'r3', '', '', null));
  assert.doesNotThrow(() => insert.run('e4', 'u1', 'todo', 'r4', '', '', null));
});

test('UNIQUE-Index: link_frame_id nur für kind=result eindeutig', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();

  const insert = db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,kind,body_html,body_text,link_frame_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
  );
  insert.run('e1', 'u1', 'todo', 'r1', 'result', '', '', 'frame-1');
  assert.throws(() => insert.run('e2', 'u1', 'todo', 'r2', 'result', '', '', 'frame-1'), /UNIQUE constraint failed/);
  // kind='note' ist von der Eindeutigkeit ausgenommen.
  assert.doesNotThrow(() => insert.run('e3', 'u1', 'todo', 'r3', 'note', '', '', 'frame-1'));
  assert.doesNotThrow(() => insert.run('e4', 'u1', 'todo', 'r4', 'note', '', '', 'frame-1'));
});

test('purgeProgressOrphans: entfernt verwaiste Zeilen, laesst gueltige unangetastet', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO todos VALUES ('t-valid','u1','Valides Todo',datetime('now'))").run();

  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES (?,?,?,?,?,?,datetime('now'))`
  ).run('e-valid', 'u1', 'todo', 't-valid', '', '');
  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES (?,?,?,?,?,?,datetime('now'))`
  ).run('e-orphan', 'u1', 'todo', 't-deleted', '', '');
  db.prepare(
    `INSERT INTO progress_meta(ref_type,ref_id,user_id,created_at) VALUES (?,?,?,datetime('now'))`
  ).run('todo', 't-valid', 'u1');
  db.prepare(
    `INSERT INTO progress_meta(ref_type,ref_id,user_id,created_at) VALUES (?,?,?,datetime('now'))`
  ).run('topic', 'topic-deleted', 'u1');

  const result = purgeProgressOrphans(db);
  assert.equal(result.entries, 1);
  assert.equal(result.meta, 1);

  const remainingEntries = db.prepare('SELECT id FROM progress_entries').all().map((r) => r.id);
  assert.deepEqual(remainingEntries, ['e-valid']);
  const remainingMeta = db.prepare('SELECT ref_id FROM progress_meta').all().map((r) => r.ref_id);
  assert.deepEqual(remainingMeta, ['t-valid']);
});
