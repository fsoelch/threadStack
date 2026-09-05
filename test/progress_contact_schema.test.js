'use strict';
// Arbeitspaket B2 (Ansprechpartner-Notizen): Schema-Migration, die den
// ref_type-CHECK von progress_entries um 'contact' erweitert, plus die
// erweiterte purgeProgressOrphans()-Aufräumlogik. Ergänzt (nicht ersetzt)
// test/progress_schema.test.js, das unverändert grün bleiben muss.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  runProgressMigrations, purgeProgressOrphans, migrateProgressRefTypeContact,
} = require('../lib/progress/schema');

function tempDb({ withContacts = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-contact-schema-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  if (withContacts) {
    db.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      );
    `);
  }
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function checkSql(db, tableName) {
  return db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName).sql;
}

test('migrateProgressRefTypeContact: No-Op, wenn progress_entries noch nicht existiert', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const result = migrateProgressRefTypeContact(db);
  assert.deepEqual(result, { migrated: false });
});

test('migrateProgressRefTypeContact: erweitert CHECK, Insert mit ref_type=contact vorher unmoeglich/danach moeglich', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();

  assert.throws(() => {
    db.prepare(
      `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
       VALUES ('e1','u1','contact','c1','','',datetime('now'))`
    ).run();
  }, /CHECK constraint failed/, 'vor der Migration muss contact abgelehnt werden');

  const result = migrateProgressRefTypeContact(db);
  assert.deepEqual(result, { migrated: true });

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
       VALUES ('e1','u1','contact','c1','','',datetime('now'))`
    ).run();
  }, 'nach der Migration muss contact erlaubt sein');

  // 'invalid' bleibt weiterhin abgelehnt - CHECK ist erweitert, nicht entfernt.
  assert.throws(() => {
    db.prepare(
      `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
       VALUES ('e2','u1','invalid','c1','','',datetime('now'))`
    ).run();
  }, /CHECK constraint failed/);
});

test('migrateProgressRefTypeContact: idempotent (zweiter Aufruf ist No-Op)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);

  const first = migrateProgressRefTypeContact(db);
  assert.deepEqual(first, { migrated: true });
  const sqlAfterFirst = checkSql(db, 'progress_entries');

  const second = migrateProgressRefTypeContact(db);
  assert.deepEqual(second, { migrated: false });
  const sqlAfterSecond = checkSql(db, 'progress_entries');
  assert.equal(sqlAfterFirst, sqlAfterSecond, 'Tabellendefinition darf sich beim No-Op nicht mehr aendern');
});

test('migrateProgressRefTypeContact: bestehende Daten bleiben nach Rebuild erhalten', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare(
    `INSERT INTO progress_entries
       (id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at)
     VALUES ('e-todo','u1','todo','t1','note','manual','<p>Hallo</p>','Hallo',NULL,'tok-1',datetime('now'),NULL)`
  ).run();

  migrateProgressRefTypeContact(db);

  const row = db.prepare('SELECT * FROM progress_entries WHERE id=?').get('e-todo');
  assert.ok(row, 'Zeile muss nach dem Rebuild noch existieren');
  assert.equal(row.ref_type, 'todo');
  assert.equal(row.ref_id, 't1');
  assert.equal(row.body_html, '<p>Hallo</p>');
  assert.equal(row.body_text, 'Hallo');
  assert.equal(row.client_token, 'tok-1');
});

test('migrateProgressRefTypeContact: Indizes werden nach dem Rebuild identisch neu angelegt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  const before = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_progress%'"
  ).all().map((r) => r.name).sort();

  migrateProgressRefTypeContact(db);

  const after = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_progress%'"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(after, before);

  // Funktionale Probe: UNIQUE-Index auf client_token muss nach dem Rebuild
  // weiterhin greifen.
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  const insert = db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,client_token,created_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'))`
  );
  insert.run('e1', 'u1', 'todo', 'r1', '', '', 'tok-x');
  assert.throws(() => insert.run('e2', 'u1', 'todo', 'r2', '', '', 'tok-x'), /UNIQUE constraint failed/);
});

test('migrateProgressRefTypeContact: progress_meta bleibt unveraendert (Schema und CHECK)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  const metaSqlBefore = checkSql(db, 'progress_meta');
  const metaColsBefore = db.prepare('PRAGMA table_info(progress_meta)').all();

  migrateProgressRefTypeContact(db);

  const metaSqlAfter = checkSql(db, 'progress_meta');
  const metaColsAfter = db.prepare('PRAGMA table_info(progress_meta)').all();
  assert.equal(metaSqlAfter, metaSqlBefore);
  assert.deepEqual(metaColsAfter, metaColsBefore);

  // progress_meta lehnt ref_type='contact' weiterhin ab (CHECK unveraendert).
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO progress_meta(ref_type,ref_id,user_id,created_at) VALUES ('contact','c1','u1',datetime('now'))`
    ).run();
  }, /CHECK constraint failed/);
});

test('purgeProgressOrphans: bestehendes Verhalten ohne contacts-Tabelle bleibt unveraendert (kein Fehler)', (t) => {
  const { db, dir } = tempDb({ withContacts: false });
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  migrateProgressRefTypeContact(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO todos VALUES ('t-valid','u1','Valides Todo',datetime('now'))").run();
  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES ('e-valid','u1','todo','t-valid','','',datetime('now'))`
  ).run();

  assert.doesNotThrow(() => purgeProgressOrphans(db));
  const remaining = db.prepare('SELECT id FROM progress_entries').all().map((r) => r.id);
  assert.deepEqual(remaining, ['e-valid']);
});

test('migrateProgressRefTypeContact: Trigger AUF progress_entries ueberlebt den Rebuild und feuert weiterhin (Code-Review-Fund, Hoch #1)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.exec(`
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL);
    CREATE TRIGGER trg_progress_entries_audit
    AFTER INSERT ON progress_entries
    BEGIN
      INSERT INTO audit_log(msg) VALUES ('inserted:' || NEW.id);
    END;
  `);

  const result = migrateProgressRefTypeContact(db);
  assert.deepEqual(result, { migrated: true });

  const trigger = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_progress_entries_audit'"
  ).get();
  assert.ok(trigger, 'Trigger muss nach dem Rebuild noch in sqlite_master vorhanden sein');

  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES ('e-after-rebuild','u1','contact','c1','','',datetime('now'))`
  ).run();
  const audited = db.prepare("SELECT msg FROM audit_log WHERE msg=?").get('inserted:e-after-rebuild');
  assert.ok(audited, 'Trigger muss nach dem Rebuild weiterhin feuern (nicht nur als Schema-Eintrag ueberleben)');
});

test('migrateProgressRefTypeContact: laeuft mit foreign_keys=OFF, damit eine kuenftige ON DELETE CASCADE-Kindtabelle beim Rebuild nicht leergeraeumt wird (Code-Review-Fund, Hoch #2)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.exec(`
    CREATE TABLE progress_entry_children (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES progress_entries(id) ON DELETE CASCADE
    );
  `);
  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES ('e1','u1','todo','t1','','',datetime('now'))`
  ).run();
  db.prepare("INSERT INTO progress_entry_children(id, entry_id) VALUES ('child-1','e1')").run();

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'Testaufbau erwartet foreign_keys=ON vor der Migration');

  const result = migrateProgressRefTypeContact(db);
  assert.deepEqual(result, { migrated: true });

  const entryRow = db.prepare('SELECT id FROM progress_entries WHERE id=?').get('e1');
  assert.ok(entryRow, 'Zeile mit id="e1" muss nach dem Rebuild mit unveraenderter id erhalten bleiben');

  const childRow = db.prepare('SELECT id FROM progress_entry_children WHERE id=?').get('child-1');
  assert.ok(childRow, 'Kind-Zeile darf durch den Rebuild NICHT per CASCADE geloescht worden sein');

  assert.equal(
    db.pragma('foreign_keys', { simple: true }), 1,
    'foreign_keys muss nach der Migration auf den urspruenglichen Wert (ON) zurueckgesetzt sein'
  );

  // Nach Wiederherstellung von foreign_keys=ON muss eine tatsaechlich
  // ungueltige Fremdschluessel-Referenz weiterhin abgelehnt werden.
  assert.throws(() => {
    db.prepare("INSERT INTO progress_entry_children(id, entry_id) VALUES ('child-2','does-not-exist')").run();
  }, /FOREIGN KEY constraint failed/);

  const violations = db.pragma('foreign_key_check');
  assert.deepEqual(violations, [], 'foreign_key_check darf nach dem Rebuild keine Inkonsistenzen melden');
});

test('purgeProgressOrphans: entfernt verwaiste contact-Zeilen, wenn contacts-Tabelle existiert', (t) => {
  const { db, dir } = tempDb({ withContacts: true });
  t.after(() => cleanup(dir));
  runProgressMigrations(db);
  migrateProgressRefTypeContact(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare(
    "INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c-valid','u1','Valider Kontakt',datetime('now'),datetime('now'))"
  ).run();

  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES ('e-valid','u1','contact','c-valid','','',datetime('now'))`
  ).run();
  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_html,body_text,created_at)
     VALUES ('e-orphan','u1','contact','c-deleted','','',datetime('now'))`
  ).run();

  const result = purgeProgressOrphans(db);
  assert.equal(result.entries, 1);
  assert.equal(result.meta, 0, 'progress_meta traegt niemals contact-Zeilen');

  const remaining = db.prepare('SELECT id FROM progress_entries').all().map((r) => r.id);
  assert.deepEqual(remaining, ['e-valid']);
});
