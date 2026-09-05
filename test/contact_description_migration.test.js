'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runContactMigrations } = require('../lib/contacts/schema');
const { migrateContactDescriptions } = require('../lib/contacts/migrate-description');
const { getCategoryByLabelNorm, normalizeLabel } = require('../lib/contacts/queries');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-desc-migration-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  runContactMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function makeContact(db, { id, description = '', createdAt = '2024-01-01T00:00:00.000Z' } = {}) {
  db.prepare(
    'INSERT INTO contacts(id,user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)'
  ).run(id, 'u1', 'Kontakt ' + id, description, createdAt, createdAt);
}

test('migriert eine nicht-leere description in einen Legacy-Infoblock der Rubrik "Zuständigkeit"', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '<p>Wichtige Notiz</p>' });

  const result = migrateContactDescriptions(db, { now: () => new Date('2024-06-01T00:00:00.000Z') });
  assert.deepEqual(result, { migrated: 1, skipped: 0 });

  const contact = db.prepare('SELECT description FROM contacts WHERE id=?').get('c1');
  assert.equal(contact.description, '', 'description-Spalte muss geleert werden');

  const block = db.prepare('SELECT * FROM contact_info_blocks WHERE contact_id=?').get('c1');
  assert.ok(block);
  assert.equal(block.is_legacy_description, 1);
  assert.equal(block.body_text, 'Wichtige Notiz');
  assert.equal(block.sort_order, 0);
  assert.equal(block.created_at, '2024-01-01T00:00:00.000Z', 'created_at des Blocks = created_at des Kontakts');

  const category = getCategoryByLabelNorm(db, 'u1', normalizeLabel('Zuständigkeit'));
  assert.equal(block.category_id, category.id);
});

test('Kontakte ohne description bleiben unangetastet', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '' });
  const result = migrateContactDescriptions(db, { now: () => new Date() });
  assert.deepEqual(result, { migrated: 0, skipped: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks').get().c, 0);
});

test('description, die nach Sanitizing nur leeres Markup ergibt: description wird geleert, aber KEIN Block angelegt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '<p><br></p>' });
  const result = migrateContactDescriptions(db, { now: () => new Date() });
  assert.equal(result.migrated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(db.prepare('SELECT description FROM contacts WHERE id=?').get('c1').description, '');
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks').get().c, 0);
});

test('wiederholter Lauf ist idempotent (migrated: 0 beim zweiten Mal)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '<p>Text</p>' });

  const first = migrateContactDescriptions(db, { now: () => new Date() });
  assert.equal(first.migrated, 1);

  const second = migrateContactDescriptions(db, { now: () => new Date() });
  assert.deepEqual(second, { migrated: 0, skipped: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks').get().c, 1, 'kein doppelter Block');
});

test('mehrere Kontakte in EINER Transaktion: bei Erfolg alle migriert', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '<p>Erster</p>' });
  makeContact(db, { id: 'c2', description: '<p>Zweiter</p>' });
  makeContact(db, { id: 'c3', description: '' });

  const result = migrateContactDescriptions(db, { now: () => new Date() });
  assert.deepEqual(result, { migrated: 2, skipped: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks').get().c, 2);
});

test('partieller Unique-Index verhindert strukturell einen zweiten Legacy-Block pro Kontakt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '<p>Text</p>' });
  migrateContactDescriptions(db, { now: () => new Date() });

  // Simuliert einen (fehlerhaften) direkten zweiten Migrationsversuch ohne
  // den regulären NOT-EXISTS-Filter - der partielle Unique-Index greift als
  // strukturelles Sicherheitsnetz.
  const category = getCategoryByLabelNorm(db, 'u1', normalizeLabel('Zuständigkeit'));
  assert.throws(() => {
    db.prepare(
      `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,is_legacy_description,created_at,updated_at)
       VALUES ('dup','u1','c1',?,'<p>x</p>','x',1,1,datetime('now'),datetime('now'))`
    ).run(category.id);
  }, /UNIQUE constraint failed/);
});

test('Logging enthält ausschließlich Zähler, keine Kontaktnamen/Inhalte', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeContact(db, { id: 'c1', description: '<p>Geheime Information ueber Kunde XYZ</p>' });

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    migrateContactDescriptions(db, { now: () => new Date() });
  } finally {
    console.log = originalLog;
  }
  const joined = logged.join('\n');
  assert.ok(joined.includes('migrated'));
  assert.ok(!joined.includes('Geheime Information'), 'Logging darf keine Kontaktinhalte enthalten');
  assert.ok(!joined.includes('Kontakt c1'), 'Logging darf keine Kontaktnamen enthalten');
});
