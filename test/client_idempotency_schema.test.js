'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const idem = require('../lib/client-idempotency');

function mkDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  idem.runClientIdempotencyMigrations(db);
  db.prepare('INSERT INTO users VALUES (?)').run('u1');
  return db;
}

test('Migration ist idempotent und legt Tabelle mit PK an', () => {
  const db = mkDb();
  idem.runClientIdempotencyMigrations(db);
  const cols = db.prepare('PRAGMA table_info(client_create_tokens)').all();
  assert.deepEqual(cols.filter((c) => c.pk).map((c) => c.name).sort(), ['client_token', 'user_id']);
});

test('CHECK verweigert unbekannten ref_type', () => {
  const db = mkDb();
  assert.throws(() => db.prepare("INSERT INTO client_create_tokens VALUES ('u1','t','contact','x','2026-01-01T00:00:00.000Z')").run());
});

test('FK: unbekannter Nutzer verweigert, Loeschen des Nutzers kaskadiert', () => {
  const db = mkDb();
  assert.throws(() => idem.recordClientToken(db, { userId: 'nope', token: 't', refType: 'todo', refId: 'a', nowIso: new Date().toISOString() }));
  idem.recordClientToken(db, { userId: 'u1', token: 't', refType: 'todo', refId: 'a', nowIso: new Date().toISOString() });
  db.prepare('DELETE FROM users WHERE id=?').run('u1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_create_tokens').get().c, 0);
});

test('Purge entfernt nur abgelaufene Mappings', () => {
  const db = mkDb();
  const now = new Date('2026-06-01T00:00:00Z');
  idem.recordClientToken(db, { userId: 'u1', token: 'old', refType: 'todo', refId: 'a', nowIso: '2025-01-01T00:00:00.000Z' });
  idem.recordClientToken(db, { userId: 'u1', token: 'new', refType: 'todo', refId: 'b', nowIso: '2026-05-01T00:00:00.000Z' });
  assert.equal(idem.purgeExpiredClientTokens(db, { now: () => now }), 1);
  assert.equal(idem.lookupClientToken(db, 'u1', 'old'), null);
  assert.ok(idem.lookupClientToken(db, 'u1', 'new'));
  assert.equal(idem.purgeExpiredClientTokens(db, { now: () => now }), 0);
});
