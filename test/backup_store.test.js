'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const store = require('../lib/backup/store');
const {
  buildFilename, parseFilename, resolveBackupPath, ensureValidFilename,
  createBackup, listBackups, deleteBackup, applyRetention,
  withBackupLock, checkBackupRate, InvalidFilenameError, BackupNotFoundError,
} = store;

function tempDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-store-test-'));
  const dbPath = path.join(dir, 'app.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t(id TEXT PRIMARY KEY, v TEXT)');
  db.prepare("INSERT INTO t VALUES ('1','hello')").run();
  const backupsDir = path.join(dir, 'backups');
  return { db, dir, backupsDir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test.beforeEach(() => store._resetForTests());

test('buildFilename/parseFilename: Roundtrip liefert Typ + ISO-Zeitstempel', () => {
  const date = new Date(2026, 8, 12, 3, 4, 5); // Monat 0-basiert = September
  const filename = buildFilename('manual', date);
  assert.equal(filename, 'backup-manual-20260912-030405.sqlite');
  const meta = parseFilename(filename);
  assert.equal(meta.type, 'manual');
  assert.equal(meta.createdAt, '2026-09-12T03:04:05');
});

test('buildFilename: unbekannter Typ wirft', () => {
  assert.throws(() => buildFilename('evil', new Date()));
});

test('parseFilename: lehnt beliebige/Traversal-Dateinamen ab', () => {
  assert.equal(parseFilename('../../etc/passwd'), null);
  assert.equal(parseFilename('backup-manual-2026-09-12.sqlite'), null);
  assert.equal(parseFilename('backup-evil-20260912-030405.sqlite'), null);
  assert.equal(parseFilename(''), null);
  assert.equal(parseFilename(null), null);
});

test('resolveBackupPath: verweigert Pfade außerhalb backupsDir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-resolve-test-'));
  try {
    const backupsDir = path.join(dir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    assert.equal(resolveBackupPath(backupsDir, '../outside.sqlite'), null);
    assert.ok(resolveBackupPath(backupsDir, 'backup-manual-20260912-030405.sqlite'));
  } finally { cleanup(dir); }
});

test('ensureValidFilename: wirft InvalidFilenameError bei ungültigem Namen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-ensure-test-'));
  try {
    assert.throws(() => ensureValidFilename(path.join(dir, 'backups'), 'not-a-backup.txt'), InvalidFilenameError);
  } finally { cleanup(dir); }
});

test('createBackup: erzeugt Datei, listBackups findet sie mit korrekten Metadaten', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));

  const meta = await createBackup(db, { backupsDir, type: 'manual', now: () => new Date(2026, 8, 12, 3, 0, 0) });
  assert.equal(meta.type, 'manual');
  assert.ok(meta.sizeBytes > 0);
  assert.ok(fs.existsSync(path.join(backupsDir, meta.filename)));

  const list = listBackups(backupsDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].filename, meta.filename);
});

test('createBackup: erzeugte Datei ist eine gültige, lesbare SQLite-Kopie', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));

  const meta = await createBackup(db, { backupsDir, type: 'manual' });
  const copy = new Database(path.join(backupsDir, meta.filename), { readonly: true });
  const row = copy.prepare('SELECT v FROM t WHERE id=?').get('1');
  copy.close();
  assert.equal(row.v, 'hello');
});

test('listBackups: sortiert absteigend nach createdAt, ignoriert fremde Dateien', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));

  await createBackup(db, { backupsDir, type: 'manual', now: () => new Date(2026, 8, 10, 0, 0, 0) });
  await createBackup(db, { backupsDir, type: 'auto', now: () => new Date(2026, 8, 12, 0, 0, 0) });
  fs.writeFileSync(path.join(backupsDir, 'random-other-file.txt'), 'noise');

  const list = listBackups(backupsDir);
  assert.equal(list.length, 2);
  assert.ok(list[0].createdAt > list[1].createdAt);
});

test('deleteBackup: entfernt Datei, wirft NOT_FOUND wenn schon weg', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));

  const meta = await createBackup(db, { backupsDir, type: 'manual' });
  deleteBackup(backupsDir, meta.filename);
  assert.ok(!fs.existsSync(path.join(backupsDir, meta.filename)));
  assert.throws(() => deleteBackup(backupsDir, meta.filename), BackupNotFoundError);
});

test('deleteBackup: ungültiger Dateiname -> InvalidFilenameError, keine Traversal möglich', (t) => {
  const { dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));
  fs.mkdirSync(backupsDir, { recursive: true });
  assert.throws(() => deleteBackup(backupsDir, '../../etc/passwd'), InvalidFilenameError);
});

test('applyRetention: löscht nur überzählige "auto"-Backups, älteste zuerst, "manual" bleibt', async (t) => {
  const { db, dir, backupsDir } = tempDirs();
  t.after(() => cleanup(dir));

  await createBackup(db, { backupsDir, type: 'manual', now: () => new Date(2026, 8, 1, 0, 0, 0) });
  await createBackup(db, { backupsDir, type: 'auto', now: () => new Date(2026, 8, 2, 0, 0, 0) });
  await createBackup(db, { backupsDir, type: 'auto', now: () => new Date(2026, 8, 3, 0, 0, 0) });
  await createBackup(db, { backupsDir, type: 'auto', now: () => new Date(2026, 8, 4, 0, 0, 0) });

  const result = applyRetention(backupsDir, 2);
  assert.equal(result.removed, 1);

  const remaining = listBackups(backupsDir);
  assert.equal(remaining.length, 3);
  assert.equal(remaining.filter((b) => b.type === 'manual').length, 1);
  assert.equal(remaining.filter((b) => b.type === 'auto').length, 2);
  assert.ok(remaining.filter((b) => b.type === 'auto').every((b) => b.createdAt >= '2026-09-03'));
});

test('withBackupLock: zweiter gleichzeitiger Aufruf wirft BACKUP_IN_PROGRESS', async () => {
  let release;
  const first = withBackupLock(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(withBackupLock(() => Promise.resolve()), (err) => err.code === 'BACKUP_IN_PROGRESS');
  release();
  await first;
  // Nach Freigabe funktioniert ein neuer Aufruf wieder normal.
  await assert.doesNotReject(withBackupLock(() => Promise.resolve('ok')));
});

test('withBackupLock: Lock wird auch bei einem Fehler in fn() wieder freigegeben', async () => {
  await assert.rejects(withBackupLock(() => { throw new Error('boom'); }), /boom/);
  await assert.doesNotReject(withBackupLock(() => Promise.resolve('ok')));
});

test('checkBackupRate: erlaubt bis max, blockiert danach im Fenster, erlaubt nach Fensterende wieder', () => {
  const userId = 'u1';
  let now = 1000;
  for (let i = 0; i < 5; i++) assert.equal(checkBackupRate(userId, now), true);
  assert.equal(checkBackupRate(userId, now), false);
  now += 10 * 60 * 1000 + 1;
  assert.equal(checkBackupRate(userId, now), true);
});

test('checkBackupRate: Nutzer sind unabhängig voneinander', () => {
  const now = 5000;
  for (let i = 0; i < 5; i++) assert.equal(checkBackupRate('userA', now), true);
  assert.equal(checkBackupRate('userA', now), false);
  assert.equal(checkBackupRate('userB', now), true);
});
