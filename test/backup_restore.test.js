'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  validateBackupFile, restoreFromFile, RestoreValidationError, RestoreFailedError,
} = require('../lib/backup/restore');

const REQUIRED_SCHEMA = `
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
  CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE themes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-test-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function makeValidBackupFile(filePath, { userTitle = 'orig' } = {}) {
  const db = new Database(filePath);
  db.exec(REQUIRED_SCHEMA);
  db.prepare("INSERT INTO users VALUES ('u1', ?)").run(userTitle);
  db.close();
}

test('validateBackupFile: gültige Datei mit allen Pflichttabellen passt', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const p = path.join(dir, 'backup.sqlite');
  makeValidBackupFile(p);
  assert.doesNotThrow(() => validateBackupFile(p));
});

test('validateBackupFile: fehlende Datei -> RestoreValidationError, keine Ausnahme sonstiger Art', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  assert.throws(() => validateBackupFile(path.join(dir, 'does-not-exist.sqlite')), RestoreValidationError);
});

test('validateBackupFile: keine gültige SQLite-Datei -> RestoreValidationError', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const p = path.join(dir, 'garbage.sqlite');
  fs.writeFileSync(p, 'dies ist keine sqlite datei, nur zufaelliger text');
  assert.throws(() => validateBackupFile(p), RestoreValidationError);
});

test('validateBackupFile: fehlende Pflichttabelle -> RestoreValidationError', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const p = path.join(dir, 'incomplete.sqlite');
  const db = new Database(p);
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)'); // themes/meetings/todos/topics fehlen
  db.close();
  assert.throws(() => validateBackupFile(p), (err) => err instanceof RestoreValidationError && /themes|meetings|todos|topics/.test(err.reason));
});

test('restoreFromFile: Validierungsfehler lässt Live-DB komplett unverändert, kein Vor-Restore-Backup', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const liveDb = new Database(path.join(dir, 'live.db'));
  liveDb.exec(REQUIRED_SCHEMA);
  liveDb.prepare("INSERT INTO users VALUES ('u1','live')").run();

  const backupsDir = path.join(dir, 'backups');
  const badSource = path.join(dir, 'bad.sqlite');
  fs.writeFileSync(badSource, 'garbage');

  let rebuildCalls = 0;
  await assert.rejects(
    restoreFromFile(liveDb, { sourcePath: badSource, backupsDir, rebuildSearchIndex: () => { rebuildCalls++; } }),
    RestoreValidationError
  );

  assert.equal(liveDb.prepare('SELECT username FROM users WHERE id=?').get('u1').username, 'live');
  assert.equal(rebuildCalls, 0);
  assert.ok(!fs.existsSync(backupsDir) || fs.readdirSync(backupsDir).length === 0);
});

test('restoreFromFile: Happy Path ersetzt Live-Daten durch Backup-Inhalt und legt Vor-Restore-Backup an', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const liveDb = new Database(path.join(dir, 'live.db'));
  liveDb.exec(REQUIRED_SCHEMA);
  liveDb.prepare("INSERT INTO users VALUES ('u1','live-vorher')").run();

  const backupsDir = path.join(dir, 'backups');
  const sourcePath = path.join(dir, 'restore-source.sqlite');
  makeValidBackupFile(sourcePath, { userTitle: 'aus-backup' });

  let rebuildCalls = 0;
  const result = await restoreFromFile(liveDb, {
    sourcePath, backupsDir, rebuildSearchIndex: () => { rebuildCalls++; },
  });

  assert.equal(liveDb.prepare('SELECT username FROM users WHERE id=?').get('u1').username, 'aus-backup');
  assert.equal(rebuildCalls, 1);
  assert.equal(result.reverted, false);
  assert.ok(fs.existsSync(path.join(backupsDir, result.preRestoreBackup)));

  // Das Vor-Restore-Backup enthält den ALTEN (Vor-Restore-)Stand.
  const preDb = new Database(path.join(backupsDir, result.preRestoreBackup), { readonly: true });
  assert.equal(preDb.prepare('SELECT username FROM users WHERE id=?').get('u1').username, 'live-vorher');
  preDb.close();
});

test('restoreFromFile: nach Commit erkannte FK-Verletzung wird automatisch zurückgerollt (reverted:true)', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));

  // Live-Schema hat zusätzlich eine "assignments"-Tabelle mit FK auf todos(id),
  // die im Restore-Quellfile NICHT existiert (simuliert eine ältere/kleinere
  // Sicherung) - nach dem Kopieren der todos-Tabelle zeigt assignments auf
  // nicht mehr existierende todo-IDs => foreign_key_check schlägt an.
  const liveDb = new Database(path.join(dir, 'live.db'));
  liveDb.exec(REQUIRED_SCHEMA);
  liveDb.exec(`CREATE TABLE assignments (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL REFERENCES todos(id));`);
  liveDb.prepare("INSERT INTO users VALUES ('u1','live-vorher')").run();
  liveDb.prepare("INSERT INTO todos VALUES ('t-live','Live-Todo')").run();
  liveDb.prepare("INSERT INTO assignments VALUES ('a1','t-live')").run();

  const backupsDir = path.join(dir, 'backups');
  const sourcePath = path.join(dir, 'restore-source.sqlite');
  const srcDb = new Database(sourcePath);
  srcDb.exec(REQUIRED_SCHEMA); // KEIN assignments hier
  srcDb.prepare("INSERT INTO users VALUES ('u1','aus-backup')").run();
  srcDb.prepare("INSERT INTO todos VALUES ('t-other','Anderes Todo')").run();
  srcDb.close();

  let rebuildCalls = 0;
  await assert.rejects(
    restoreFromFile(liveDb, { sourcePath, backupsDir, rebuildSearchIndex: () => { rebuildCalls++; } }),
    (err) => err instanceof RestoreFailedError && err.reverted === true
  );

  // Zurückgerollt: Live-DB zeigt wieder den ORIGINALEN Stand (nicht den defekten Restore-Zwischenstand).
  assert.equal(liveDb.prepare('SELECT username FROM users WHERE id=?').get('u1').username, 'live-vorher');
  assert.equal(liveDb.prepare('SELECT COUNT(*) c FROM todos').get().c, 1);
  assert.equal(liveDb.prepare('SELECT COUNT(*) c FROM assignments').get().c, 1);
  assert.deepEqual(liveDb.pragma('foreign_key_check'), []);
  // rebuildSearchIndex wird sowohl nach dem gescheiterten als auch nach dem
  // revertierenden Restore-Durchlauf aufgerufen.
  assert.equal(rebuildCalls, 1);
});

test('restoreFromFile: kopiert nur Tabellen, die in Live-Schema UND Quelle existieren (keine Fremdtabellen-Injektion)', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const liveDb = new Database(path.join(dir, 'live.db'));
  liveDb.exec(REQUIRED_SCHEMA);
  liveDb.prepare("INSERT INTO users VALUES ('u1','live')").run();

  const backupsDir = path.join(dir, 'backups');
  const sourcePath = path.join(dir, 'restore-source.sqlite');
  const srcDb = new Database(sourcePath);
  srcDb.exec(REQUIRED_SCHEMA);
  srcDb.exec(`CREATE TABLE evil_table (id TEXT PRIMARY KEY, payload TEXT)`);
  srcDb.prepare("INSERT INTO evil_table VALUES ('x','sollte niemals live landen')").run();
  srcDb.prepare("INSERT INTO users VALUES ('u1','aus-backup')").run();
  srcDb.close();

  await restoreFromFile(liveDb, { sourcePath, backupsDir, rebuildSearchIndex: () => {} });

  const evilExists = liveDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evil_table'").get();
  assert.equal(evilExists, undefined);
});
