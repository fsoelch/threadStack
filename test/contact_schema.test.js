'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runContactMigrations, ensureContactNoteTriggers, purgeContactOrphans } = require('../lib/contacts/schema');

function tempDb({ withSearchIndex = false, withProgressEntries = false, withThemeLinks = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-schema-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  if (withThemeLinks) {
    db.exec(`
      CREATE TABLE themes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE theme_links (id TEXT PRIMARY KEY, theme_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }
  if (withSearchIndex) {
    db.exec(`CREATE VIRTUAL TABLE search_index USING fts5(ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body);`);
  }
  if (withProgressEntries) {
    db.exec(`
      CREATE TABLE progress_entries (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
        body_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
    `);
  }
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('runContactMigrations: legt Tabellen/Indizes/Spalte idempotent an', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  runContactMigrations(db);
  assert.doesNotThrow(() => runContactMigrations(db));

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contact_categories','contact_info_blocks')"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['contact_categories', 'contact_info_blocks']);

  const cols = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
  assert.ok(cols.includes('search_text'), 'contacts.search_text sollte additiv angelegt worden sein');

  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'idx_cib%' OR name LIKE 'idx_contact_categories%')"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(indexes, [
    'idx_cib_category',
    'idx_cib_contact',
    'idx_cib_legacy',
    'idx_contact_categories_user',
  ]);
});

test('runContactMigrations: fasst bestehende contacts-Spalten nicht an (rein additiv)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const before = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
  runContactMigrations(db);
  const after = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name).filter((n) => n !== 'search_text');
  assert.deepEqual(before, after);
});

test('UNIQUE-Index: label_norm pro Nutzer eindeutig', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  const insert = db.prepare(
    `INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,0,0,datetime('now'),datetime('now'))`
  );
  insert.run('cat1', 'u1', 'Wichtiges', 'wichtiges');
  assert.throws(() => insert.run('cat2', 'u1', 'wichtiges', 'wichtiges'), /UNIQUE constraint failed/);
});

test('UNIQUE-Index: nur EIN Legacy-Block pro Kontakt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  db.prepare("INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at) VALUES ('cat1','u1','Zuständigkeit','zuständigkeit',1,0,datetime('now'),datetime('now'))").run();

  const insertBlock = db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,is_legacy_description,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))`
  );
  insertBlock.run('b1', 'u1', 'c1', 'cat1', '<p>a</p>', 'a', 0);
  assert.throws(() => insertBlock.run('b2', 'u1', 'c1', 'cat1', '<p>b</p>', 'b', 1), /UNIQUE constraint failed/);
});

test('FK ON DELETE RESTRICT: Rubrik mit zugeordneten Infoblöcken kann nicht direkt gelöscht werden', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  db.prepare("INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at) VALUES ('cat1','u1','Privates','privates',0,0,datetime('now'),datetime('now'))").run();
  db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,created_at,updated_at)
     VALUES ('b1','u1','c1','cat1','<p>x</p>','x',0,datetime('now'),datetime('now'))`
  ).run();
  assert.throws(() => db.prepare('DELETE FROM contact_categories WHERE id=?').run('cat1'), /FOREIGN KEY constraint failed/);
});

test('FK ON DELETE CASCADE: Kontakt-Löschung entfernt zugehörige Infoblöcke', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  db.prepare("INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at) VALUES ('cat1','u1','Privates','privates',0,0,datetime('now'),datetime('now'))").run();
  db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,created_at,updated_at)
     VALUES ('b1','u1','c1','cat1','<p>x</p>','x',0,datetime('now'),datetime('now'))`
  ).run();
  db.prepare('DELETE FROM contacts WHERE id=?').run('c1');
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks').get().c, 0);
});

test('search_text-Trigger: Infoblock-Änderungen aktualisieren contacts.search_text (ohne progress_entries)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  db.prepare("INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at) VALUES ('cat1','u1','Privates','privates',0,0,datetime('now'),datetime('now'))").run();

  db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,created_at,updated_at)
     VALUES ('b1','u1','c1','cat1','<p>Hallo Welt</p>','Hallo Welt',0,datetime('now'),datetime('now'))`
  ).run();
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, 'Hallo Welt');

  db.prepare("UPDATE contact_info_blocks SET body_text='Geändert' WHERE id='b1'").run();
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, 'Geändert');

  db.prepare("DELETE FROM contact_info_blocks WHERE id='b1'").run();
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, '');
});

test('runContactMigrations crasht NICHT, wenn progress_entries noch fehlt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.doesNotThrow(() => runContactMigrations(db));
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
  assert.ok(!triggers.includes('trg_cnote_ai'), 'trg_cnote_* sollte ohne progress_entries nicht angelegt werden');
});

test('ensureContactNoteTriggers: No-Op, solange progress_entries fehlt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  const result = ensureContactNoteTriggers(db);
  assert.deepEqual(result, { applied: false });
});

test('ensureContactNoteTriggers: holt Trigger-Setup nach, sobald progress_entries existiert, und aktualisiert search_text rückwirkend', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db); // progress_entries existiert hier noch nicht
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  db.prepare("INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at) VALUES ('cat1','u1','Privates','privates',0,0,datetime('now'),datetime('now'))").run();
  db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,created_at,updated_at)
     VALUES ('b1','u1','c1','cat1','<p>Block</p>','Block',0,datetime('now'),datetime('now'))`
  ).run();
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, 'Block');

  // progress_entries kommt jetzt hinzu (simuliert B2s spätere Migration).
  db.exec(`
    CREATE TABLE progress_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      body_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_text,created_at) VALUES ('n1','u1','contact','c1','Notiz',datetime('now'))").run();

  const result = ensureContactNoteTriggers(db);
  assert.deepEqual(result, { applied: true });
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, 'Block Notiz');

  // Live-Trigger greifen jetzt ebenfalls.
  db.prepare("INSERT INTO progress_entries(id,user_id,ref_type,ref_id,body_text,created_at) VALUES ('n2','u1','contact','c1','Zweite',datetime('now'))").run();
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, 'Block Notiz Zweite');

  db.prepare("DELETE FROM progress_entries WHERE id='n1'").run();
  assert.equal(db.prepare('SELECT search_text FROM contacts WHERE id=?').get('c1').search_text, 'Block Zweite');
});

test('search_index-Reindex: alte description-basierte Einträge werden durch search_text ersetzt', (t) => {
  const { db, dir } = tempDb({ withSearchIndex: true });
  t.after(() => cleanup(dir));
  db.exec(`
    CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
        COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
    END;
    CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
      DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
      INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
        COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
    END;
    CREATE TRIGGER trg_search_contacts_ad AFTER DELETE ON contacts BEGIN
      DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
    END;
  `);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare(
    "INSERT INTO contacts(id,user_id,name,role,email,description,created_at,updated_at) VALUES ('c1','u1','Max','Rolle','max@x.de','Alte Beschreibung',datetime('now'),datetime('now'))"
  ).run();
  assert.match(db.prepare("SELECT body FROM search_index WHERE ref_id='c1'").get().body, /Alte Beschreibung/);

  runContactMigrations(db);
  const bodyAfter = db.prepare("SELECT body FROM search_index WHERE ref_id='c1'").get().body;
  assert.doesNotMatch(bodyAfter, /Alte Beschreibung/, 'description darf nicht mehr im Suchtext auftauchen');
  assert.match(bodyAfter, /Rolle/);
  assert.match(bodyAfter, /max@x\.de/);

  // Neue Trigger-Formel greift live weiter (role/email/search_text, KEIN description).
  db.prepare("UPDATE contacts SET description='Sollte ignoriert werden' WHERE id='c1'").run();
  const bodyAfterUpdate = db.prepare("SELECT body FROM search_index WHERE ref_id='c1'").get().body;
  assert.doesNotMatch(bodyAfterUpdate, /Sollte ignoriert werden/);
});

test('runContactMigrations crasht NICHT, wenn search_index noch fehlt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  });
  assert.doesNotThrow(() => runContactMigrations(db));
});

test('purgeContactOrphans: entfernt verwaiste theme_links (ref_type=contact) ohne existierenden Kontakt', (t) => {
  const { db, dir } = tempDb({ withThemeLinks: true });
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO contacts(id,user_id,name,created_at,updated_at) VALUES ('c1','u1','Max',datetime('now'),datetime('now'))").run();
  db.prepare("INSERT INTO themes(id,title) VALUES ('t1','Thema')").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('l1','t1','contact','c1',datetime('now'))").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('l2','t1','contact','deleted-contact',datetime('now'))").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('l3','t1','todo','some-todo',datetime('now'))").run();

  const result = purgeContactOrphans(db);
  assert.equal(result.themeLinks, 1);
  const remaining = db.prepare('SELECT id FROM theme_links ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(remaining, ['l1', 'l3']);
});

test('purgeContactOrphans: sicheres No-Op, wenn theme_links nicht existiert', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  runContactMigrations(db);
  assert.deepEqual(purgeContactOrphans(db), { themeLinks: 0 });
});
