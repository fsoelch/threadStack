'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runBackupMigrations } = require('../lib/backup/schema');
const { getSettings, saveSettings, VALIDATION_ERRORS } = require('../lib/backup/queries');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-queries-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.prepare("INSERT INTO users VALUES ('admin1','admin',datetime('now'))").run();
  runBackupMigrations(db);
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('getSettings: liefert Default-Werte', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.deepEqual(getSettings(db), { enabled: false, hour: 3, retentionCount: 14, updatedAt: null });
});

test('saveSettings: Teil-Patch aktualisiert nur angegebene Felder', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const r = saveSettings(db, { enabled: true }, { updatedAt: '2026-09-12T03:00:00.000Z', updatedBy: 'admin1' });
  assert.ok(r.ok);
  assert.equal(r.settings.enabled, true);
  assert.equal(r.settings.hour, 3);
  assert.equal(r.settings.retentionCount, 14);
  assert.equal(r.settings.updatedAt, '2026-09-12T03:00:00.000Z');
});

test('saveSettings: hour außerhalb 0-23 -> Validierungsfehler, DB unverändert', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const before = getSettings(db);
  const r = saveSettings(db, { hour: 24 }, { updatedAt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, VALIDATION_ERRORS.INVALID_HOUR);
  assert.deepEqual(getSettings(db), before);
});

test('saveSettings: retentionCount außerhalb 1-100 -> Validierungsfehler', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.equal(saveSettings(db, { retentionCount: 0 }, { updatedAt: 'x' }).error, VALIDATION_ERRORS.INVALID_RETENTION);
  assert.equal(saveSettings(db, { retentionCount: 101 }, { updatedAt: 'x' }).error, VALIDATION_ERRORS.INVALID_RETENTION);
});

test('saveSettings: enabled kein boolean -> Validierungsfehler', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.equal(saveSettings(db, { enabled: 'yes' }, { updatedAt: 'x' }).error, VALIDATION_ERRORS.INVALID_ENABLED);
});
