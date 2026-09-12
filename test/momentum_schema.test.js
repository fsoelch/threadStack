'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMomentumMigrations, purgeMomentumOrphans } = require('../lib/momentum/schema');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momentum-schema-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `);
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('runMomentumMigrations: legt completed_at additiv auf todos/topics an, idempotent', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  runMomentumMigrations(db);
  assert.doesNotThrow(() => runMomentumMigrations(db)); // zweiter Aufruf: No-Op

  const todoCols = db.prepare('PRAGMA table_info(todos)').all().map((c) => c.name);
  assert.ok(todoCols.includes('completed_at'));
  const topicCols = db.prepare('PRAGMA table_info(topics)').all().map((c) => c.name);
  assert.ok(topicCols.includes('completed_at'));
});

test('runMomentumMigrations: bestehende Todo/Topic-Daten bleiben nach zweitem Aufruf unangetastet', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO todos(id,user_id,title,created_at) VALUES ('t1','u1','Todo',datetime('now'))").run();

  runMomentumMigrations(db);
  db.prepare("UPDATE todos SET completed_at=datetime('now') WHERE id='t1'").run();
  runMomentumMigrations(db);

  const row = db.prepare('SELECT completed_at FROM todos WHERE id=?').get('t1');
  assert.ok(row.completed_at);
});

test('runMomentumMigrations: legt momentum_settings/momentum_pause_days/momentum_milestones an', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runMomentumMigrations(db);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'momentum_%'"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['momentum_milestones', 'momentum_pause_days', 'momentum_settings']);
});

test('purgeMomentumOrphans: entfernt Zeilen ohne existierenden Nutzer', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runMomentumMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  // FK-Erzwingung erlaubt regulär keine Einträge mit fremdem user_id - der
  // "Geist"-Datensatz simuliert den einzigen Fall, in dem so etwas trotzdem
  // entstehen könnte (FK war zum Zeitpunkt der Nutzerlöschung deaktiviert).
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO momentum_pause_days(user_id,pause_date,created_at) VALUES ('ghost','2026-01-01',datetime('now'))").run();
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO momentum_pause_days(user_id,pause_date,created_at) VALUES ('u1','2026-01-02',datetime('now'))").run();

  const result = purgeMomentumOrphans(db);
  assert.equal(result.removed, 1);
  const remaining = db.prepare('SELECT user_id FROM momentum_pause_days').all().map((r) => r.user_id);
  assert.deepEqual(remaining, ['u1']);
});
