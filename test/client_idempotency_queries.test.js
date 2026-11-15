'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const idem = require('../lib/client-idempotency');

const NOW = new Date('2026-06-01T12:00:00Z');

test('parseClientToken: fehlend, gueltig, ungueltig', () => {
  for (const v of [undefined, null, '']) assert.deepEqual(idem.parseClientToken(v), { ok: true, token: null });
  assert.deepEqual(idem.parseClientToken('abc-_9'), { ok: true, token: 'abc-_9' });
  assert.equal(idem.parseClientToken('a'.repeat(64)).ok, true);
  for (const v of ['a'.repeat(65), 'a b', "a'b", 5, {}, [], '../x', 'a\n']) assert.equal(idem.parseClientToken(v).ok, false, String(v));
});

test('parseCapturedAt: fehlend, gueltig, normalisiert', () => {
  assert.deepEqual(idem.parseCapturedAt(undefined, { now: NOW }), { ok: true, iso: null });
  assert.deepEqual(idem.parseCapturedAt(null, { now: NOW }), { ok: true, iso: null });
  assert.equal(idem.parseCapturedAt('2026-05-31T10:00:00+02:00', { now: NOW }).iso, '2026-05-31T08:00:00.000Z');
  assert.equal(idem.parseCapturedAt('2026-05-31T10:00Z', { now: NOW }).iso, '2026-05-31T10:00:00.000Z');
  assert.equal(idem.parseCapturedAt('2026-05-31T10:00:00.123Z', { now: NOW }).iso, '2026-05-31T10:00:00.123Z');
});

test('parseCapturedAt: Klemmung Zukunft und zu alt', () => {
  assert.equal(idem.parseCapturedAt('2026-06-01T12:04:00Z', { now: NOW }).iso, '2026-06-01T12:04:00.000Z');
  assert.equal(idem.parseCapturedAt('2026-06-01T12:06:00Z', { now: NOW }).iso, NOW.toISOString());
  assert.equal(idem.parseCapturedAt('2020-01-01T00:00:00Z', { now: NOW }).iso, NOW.toISOString());
});

test('parseCapturedAt: ungueltige Eingaben', () => {
  for (const v of ['2026-05-31', 'gestern', '2026-05-31T10:00:00', '2026-13-45T10:00:00Z', 12345, {}, '2026-05-31T10:00:00Z' + ' '.repeat(40)])
    assert.equal(idem.parseCapturedAt(v, { now: NOW }).ok, false, String(v));
});

test('lookup/record: je Nutzer getrennt, PK-Konflikt wirft', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  idem.runClientIdempotencyMigrations(db);
  db.prepare('INSERT INTO users VALUES (?),(?)').run('u1', 'u2');
  const nowIso = NOW.toISOString();
  assert.equal(idem.lookupClientToken(db, 'u1', 't'), null);
  idem.recordClientToken(db, { userId: 'u1', token: 't', refType: 'topic', refId: 'x', nowIso });
  assert.deepEqual(idem.lookupClientToken(db, 'u1', 't'), { refType: 'topic', refId: 'x' });
  assert.equal(idem.lookupClientToken(db, 'u2', 't'), null);
  assert.throws(() => idem.recordClientToken(db, { userId: 'u1', token: 't', refType: 'topic', refId: 'y', nowIso }));
  idem.recordClientToken(db, { userId: 'u2', token: 't', refType: 'todo', refId: 'z', nowIso });
});

test('CLIENT_TOKEN_RE wird auch von lib/progress verwendet (eine Quelle)', () => {
  assert.equal(idem.CLIENT_TOKEN_RE.source, '^[A-Za-z0-9_-]{1,64}$');
});
