'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runBackupMigrations, SETTINGS_ID } = require('../lib/backup/schema');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-schema-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);`);
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('runBackupMigrations: legt backup_settings mit Default-Zeile an', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  runBackupMigrations(db);

  const row = db.prepare('SELECT * FROM backup_settings WHERE id=?').get(SETTINGS_ID);
  assert.ok(row);
  assert.equal(row.enabled, 0);
  assert.equal(row.hour, 3);
  assert.equal(row.retention_count, 14);
});

test('runBackupMigrations: idempotent, zweiter Aufruf überschreibt bestehende Zeile nicht', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  runBackupMigrations(db);
  db.prepare('UPDATE backup_settings SET enabled=1, hour=7, retention_count=30 WHERE id=?').run(SETTINGS_ID);
  runBackupMigrations(db);

  const row = db.prepare('SELECT * FROM backup_settings WHERE id=?').get(SETTINGS_ID);
  assert.equal(row.enabled, 1);
  assert.equal(row.hour, 7);
  assert.equal(row.retention_count, 30);
});
