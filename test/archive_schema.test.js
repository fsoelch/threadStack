'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runArchiveMigrations, purgeArchiveOrphans } = require('../lib/archive/schema');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-schema-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('runArchiveMigrations: legt Tabelle/Indizes additiv und idempotent an', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  runArchiveMigrations(db);
  assert.doesNotThrow(() => runArchiveMigrations(db)); // zweiter Aufruf ist ein No-Op

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='archive_state'"
  ).all().map((r) => r.name);
  assert.deepEqual(tables, ['archive_state']);

  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_archive_state%'"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(indexes, ['idx_archive_state_ref', 'idx_archive_state_user']);

  const cols = db.prepare('PRAGMA table_info(archive_state)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['archived_at', 'ref_id', 'ref_type', 'user_id']);
});

test('runArchiveMigrations: fasst meetings nicht an (keine Spaltenänderung)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const before = db.prepare('PRAGMA table_info(meetings)').all();
  runArchiveMigrations(db);
  const after = db.prepare('PRAGMA table_info(meetings)').all();
  assert.deepEqual(before, after);
});

test('Migration ist additiv: bestehende Daten bleiben nach zweitem Aufruf unangetastet', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runArchiveMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO meetings VALUES ('m1','u1','M',datetime('now'))").run();
  db.prepare(
    "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m1','u1',datetime('now'))"
  ).run();

  runArchiveMigrations(db); // zweiter Aufruf

  const row = db.prepare("SELECT * FROM archive_state WHERE ref_type='meeting' AND ref_id='m1'").get();
  assert.ok(row);
  assert.equal(row.user_id, 'u1');
});

test('PRIMARY KEY (ref_type, ref_id): doppelter Insert derselben Referenz wirft', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runArchiveMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare(
    "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m1','u1',datetime('now'))"
  ).run();
  assert.throws(() => {
    db.prepare(
      "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m1','u1',datetime('now'))"
    ).run();
  }, /UNIQUE constraint failed|PRIMARY KEY/);
});

test('user_id REFERENCES users(id) ON DELETE CASCADE: Nutzerlöschung räumt archive_state mit auf', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runArchiveMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare(
    "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m1','u1',datetime('now'))"
  ).run();
  db.prepare('DELETE FROM users WHERE id=?').run('u1');
  const row = db.prepare("SELECT * FROM archive_state WHERE ref_id='m1'").get();
  assert.equal(row, undefined);
});

test('purgeArchiveOrphans: entfernt verwaiste Zeilen (kein FK auf meetings), laesst gueltige unangetastet', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runArchiveMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO meetings VALUES ('m-valid','u1','Valides Meeting',datetime('now'))").run();

  db.prepare(
    "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m-valid','u1',datetime('now'))"
  ).run();
  db.prepare(
    "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m-deleted','u1',datetime('now'))"
  ).run();

  const result = purgeArchiveOrphans(db);
  assert.equal(result.removed, 1);

  const remaining = db.prepare('SELECT ref_id FROM archive_state').all().map((r) => r.ref_id);
  assert.deepEqual(remaining, ['m-valid']);
});

test('purgeArchiveOrphans: zweiter Aufruf ist ein No-Op (idempotent)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runArchiveMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO meetings VALUES ('m-valid','u1','M',datetime('now'))").run();
  db.prepare(
    "INSERT INTO archive_state(ref_type,ref_id,user_id,archived_at) VALUES ('meeting','m-valid','u1',datetime('now'))"
  ).run();

  purgeArchiveOrphans(db);
  const second = purgeArchiveOrphans(db);
  assert.equal(second.removed, 0);
});
