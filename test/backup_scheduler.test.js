'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runBackupMigrations } = require('../lib/backup/schema');
const { saveSettings } = require('../lib/backup/queries');
const { listBackups, _resetForTests } = require('../lib/backup/store');
const { tickOnce } = require('../lib/backup/scheduler');

function tempDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-scheduler-test-'));
  const db = new Database(path.join(dir, 'app.db'));
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL)');
  runBackupMigrations(db);
  const backupsDir = path.join(dir, 'backups');
  return { db, dir, backupsDir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test.beforeEach(() => _resetForTests());

test('tickOnce: deaktiviert -> kein Backup', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  const result = await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 3, 0, 0));
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(listBackups(backupsDir).length, 0);
});

test('tickOnce: aktiviert, aber falsche Stunde -> kein Backup', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  saveSettings(db, { enabled: true, hour: 3 }, { updatedAt: 'x' });
  const result = await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 14, 0, 0));
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'wrong_hour');
});

test('tickOnce: aktiviert + richtige Stunde -> erstellt genau ein "auto"-Backup', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  saveSettings(db, { enabled: true, hour: 3 }, { updatedAt: 'x' });
  const result = await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 3, 0, 0));
  assert.equal(result.ran, true);
  const list = listBackups(backupsDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'auto');
});

test('tickOnce: an demselben Tag bereits gelaufen -> kein zweites Backup (Dedup)', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  saveSettings(db, { enabled: true, hour: 3 }, { updatedAt: 'x' });
  await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 3, 0, 0));
  const result = await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 3, 30, 0));
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'already_ran');
  assert.equal(listBackups(backupsDir).length, 1);
});

test('tickOnce: neuer Tag nach vorherigem Lauf -> erstellt wieder ein Backup', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  saveSettings(db, { enabled: true, hour: 3 }, { updatedAt: 'x' });
  await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 3, 0, 0));
  const result = await tickOnce(db, { backupsDir }, new Date(2026, 8, 13, 3, 0, 0));
  assert.equal(result.ran, true);
  assert.equal(listBackups(backupsDir).length, 2);
});

test('tickOnce: wendet Aufbewahrungsgrenze auf "auto"-Backups an', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  saveSettings(db, { enabled: true, hour: 3, retentionCount: 2 }, { updatedAt: 'x' });
  await tickOnce(db, { backupsDir }, new Date(2026, 8, 10, 3, 0, 0));
  await tickOnce(db, { backupsDir }, new Date(2026, 8, 11, 3, 0, 0));
  await tickOnce(db, { backupsDir }, new Date(2026, 8, 12, 3, 0, 0));
  assert.equal(listBackups(backupsDir).length, 2);
});
