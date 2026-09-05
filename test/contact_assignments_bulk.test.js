'use strict';
// Nachbesserung Code-Review Hoch-Fund 1: Direkttests gegen die exportierte
// Vertragsfläche zu B4 (contactsForRefs, deleteForRefs, deleteForContact aus
// lib/contacts/assignments/index.js), die bislang in keinem Test referenziert
// war. Ergänzt außerdem moveAssignments (Hoch-Fund 2, Migrations-Hook für die
// Topic↔ToDo-Konvertierung).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { contactsForRefs, deleteForRefs, deleteForContact, moveAssignments } = require('../lib/contacts/assignments');
const {
  buildDb,
  seedUser,
  seedContact,
  seedTodo,
  seedTopic,
  nowIso,
} = require('./contact_assignments_test_harness');

function assign(db, uid, contactId, refType, refId) {
  db.prepare(
    'INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)'
  ).run(`ca_${Math.random().toString(36).slice(2)}`, uid, contactId, refType, refId, nowIso());
}

function countPrepares(db, fn) {
  const original = db.prepare.bind(db);
  let count = 0;
  db.prepare = (sql) => {
    count += 1;
    return original(sql);
  };
  try {
    fn();
  } finally {
    db.prepare = original;
  }
  return count;
}

// ── contactsForRefs ─────────────────────────────────────────────────

test('contactsForRefs: gemischte todo+topic-Refs liefern die jeweils zugeordneten Kontakte', () => {
  const db = buildDb();
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const tp = seedTopic(db, u);
  const c1 = seedContact(db, u, { name: 'Anna' });
  const c2 = seedContact(db, u, { name: 'Bea' });
  assign(db, u, c1, 'todo', t);
  assign(db, u, c2, 'topic', tp);

  const map = contactsForRefs(db, u, [
    { refType: 'todo', refId: t },
    { refType: 'topic', refId: tp },
  ]);

  assert.deepEqual(map.get(`todo:${t}`).map((c) => c.contactId), [c1]);
  assert.deepEqual(map.get(`topic:${tp}`).map((c) => c.contactId), [c2]);
});

test('contactsForRefs: leeres Array liefert eine leere Map ohne Query', () => {
  const db = buildDb();
  const u = seedUser(db);

  const count = countPrepares(db, () => {
    const map = contactsForRefs(db, u, []);
    assert.equal(map.size, 0);
  });
  assert.equal(count, 0, 'bei leerem Input darf gar keine Query ausgeführt werden');
});

test('contactsForRefs: unbekannte Refs liefern eine leere Map (kein Fehler)', () => {
  const db = buildDb();
  const u = seedUser(db);

  const map = contactsForRefs(db, u, [
    { refType: 'todo', refId: 'ghost-todo' },
    { refType: 'topic', refId: 'ghost-topic' },
  ]);
  assert.equal(map.size, 0);
});

test('contactsForRefs: Zuordnungen eines fremden uid werden nicht zurückgeliefert', () => {
  const db = buildDb();
  const owner = seedUser(db);
  const other = seedUser(db);
  const t = seedTodo(db, owner);
  const c = seedContact(db, owner);
  assign(db, owner, c, 'todo', t);

  const map = contactsForRefs(db, other, [{ refType: 'todo', refId: t }]);
  assert.equal(map.size, 0);
});

test('contactsForRefs: genau EINE Query, unabhängig von der Anzahl der Refs/Items', () => {
  const db = buildDb();
  const u = seedUser(db);
  const c = seedContact(db, u);

  const fewRefs = [];
  for (let i = 0; i < 2; i += 1) {
    const t = seedTodo(db, u);
    assign(db, u, c, 'todo', t);
    fewRefs.push({ refType: 'todo', refId: t });
  }
  const countFew = countPrepares(db, () => contactsForRefs(db, u, fewRefs));

  const manyRefs = [...fewRefs];
  for (let i = 0; i < 20; i += 1) {
    const t = seedTodo(db, u);
    assign(db, u, c, 'todo', t);
    manyRefs.push({ refType: 'todo', refId: t });
  }
  const countMany = countPrepares(db, () => contactsForRefs(db, u, manyRefs));

  assert.equal(countFew, 1);
  assert.equal(countMany, 1);
});

test('contactsForRefs: Sortier-Stabilität (sort_order, dann name) innerhalb eines Refs', () => {
  const db = buildDb();
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const cB = seedContact(db, u, { name: 'Bea', sortOrder: 0 });
  const cA1 = seedContact(db, u, { name: 'Anna', sortOrder: 1 });
  const cA0 = seedContact(db, u, { name: 'Aaron', sortOrder: 0 });
  assign(db, u, cB, 'todo', t);
  assign(db, u, cA1, 'todo', t);
  assign(db, u, cA0, 'todo', t);

  const map = contactsForRefs(db, u, [{ refType: 'todo', refId: t }]);
  assert.deepEqual(map.get(`todo:${t}`).map((c) => c.contactId), [cA0, cB, cA1]);
});

// ── deleteForRefs ───────────────────────────────────────────────────

test('deleteForRefs: gemischte Typen werden beide gelöscht', () => {
  const db = buildDb();
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const tp = seedTopic(db, u);
  const c = seedContact(db, u);
  assign(db, u, c, 'todo', t);
  assign(db, u, c, 'topic', tp);

  const result = deleteForRefs(db, [
    { refType: 'todo', refId: t },
    { refType: 'topic', refId: tp },
  ]);
  assert.deepEqual(result, { deleted: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_assignments').get().n, 0);
});

test('deleteForRefs: leere Liste liefert {deleted:0}', () => {
  const db = buildDb();
  assert.deepEqual(deleteForRefs(db, []), { deleted: 0 });
  assert.deepEqual(deleteForRefs(db, null), { deleted: 0 });
});

test('deleteForRefs: Refs ohne Zuordnung liefern {deleted:0}', () => {
  const db = buildDb();
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const result = deleteForRefs(db, [{ refType: 'todo', refId: t }]);
  assert.deepEqual(result, { deleted: 0 });
});

test('deleteForRefs: Idempotenz — zweiter Aufruf löscht nichts mehr', () => {
  const db = buildDb();
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c = seedContact(db, u);
  assign(db, u, c, 'todo', t);

  const refs = [{ refType: 'todo', refId: t }];
  const first = deleteForRefs(db, refs);
  const second = deleteForRefs(db, refs);
  assert.deepEqual(first, { deleted: 1 });
  assert.deepEqual(second, { deleted: 0 });
});

// ── deleteForContact ──────────────────────────────────────────────

test('deleteForContact: unbekannte ID liefert {deleted:0}', () => {
  const db = buildDb();
  assert.deepEqual(deleteForContact(db, 'ghost-contact'), { deleted: 0 });
});

test('deleteForContact: nicht-String-ID liefert {deleted:0} ohne Fehler', () => {
  const db = buildDb();
  assert.deepEqual(deleteForContact(db, 123), { deleted: 0 });
  assert.deepEqual(deleteForContact(db, null), { deleted: 0 });
  assert.deepEqual(deleteForContact(db, undefined), { deleted: 0 });
  assert.deepEqual(deleteForContact(db, ''), { deleted: 0 });
});

test('deleteForContact: löscht alle Zuordnungen des Kontakts, andere bleiben unberührt', () => {
  const db = buildDb();
  const u = seedUser(db);
  const t1 = seedTodo(db, u);
  const t2 = seedTodo(db, u);
  const c1 = seedContact(db, u);
  const c2 = seedContact(db, u);
  assign(db, u, c1, 'todo', t1);
  assign(db, u, c1, 'todo', t2);
  assign(db, u, c2, 'todo', t1);

  const result = deleteForContact(db, c1);
  assert.deepEqual(result, { deleted: 2 });
  const remaining = db.prepare('SELECT contact_id FROM contact_assignments').all().map((r) => r.contact_id);
  assert.deepEqual(remaining, [c2]);
});

// ── moveAssignments (Hoch-Fund 2: Migrations-Hook Topic↔ToDo) ──────

test('moveAssignments: verschiebt Zuordnungen vom alten auf das neue Ref', () => {
  const db = buildDb();
  const u = seedUser(db);
  const oldTopic = seedTopic(db, u);
  const newTodo = seedTodo(db, u);
  const c = seedContact(db, u);
  assign(db, u, c, 'topic', oldTopic);

  const result = moveAssignments(db, { refType: 'topic', refId: oldTopic }, { refType: 'todo', refId: newTodo });
  assert.deepEqual(result, { moved: 1 });

  const rows = db.prepare('SELECT ref_type, ref_id, contact_id FROM contact_assignments').all();
  assert.deepEqual(rows, [{ ref_type: 'todo', ref_id: newTodo, contact_id: c }]);
});

test('moveAssignments: Kollisionsfall — Kontakt ist am Ziel bereits zugeordnet', () => {
  const db = buildDb();
  const u = seedUser(db);
  const oldTopic = seedTopic(db, u);
  const newTodo = seedTodo(db, u);
  const c1 = seedContact(db, u);
  const c2 = seedContact(db, u);
  // c1 ist an BEIDEN Refs bereits zugeordnet (Kollision beim Verschieben),
  // c2 nur am alten Ref.
  assign(db, u, c1, 'topic', oldTopic);
  assign(db, u, c1, 'todo', newTodo);
  assign(db, u, c2, 'topic', oldTopic);

  const result = moveAssignments(db, { refType: 'topic', refId: oldTopic }, { refType: 'todo', refId: newTodo });

  // c2 wurde verschoben; c1s Kollisionszeile am alten Ref wurde bereinigt statt
  // dupliziert oder als Fehler zu werfen.
  assert.equal(result.moved, 1);
  const rows = db
    .prepare('SELECT ref_type, ref_id, contact_id FROM contact_assignments ORDER BY contact_id')
    .all();
  assert.deepEqual(rows.sort((a, b) => a.contact_id.localeCompare(b.contact_id)), [
    { ref_type: 'todo', ref_id: newTodo, contact_id: c1 },
    { ref_type: 'todo', ref_id: newTodo, contact_id: c2 },
  ].sort((a, b) => a.contact_id.localeCompare(b.contact_id)));
  // keine Zeile mehr am alten (nicht mehr existierenden) Ref
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM contact_assignments WHERE ref_type='topic' AND ref_id=?").get(oldTopic).n,
    0
  );
});

test('moveAssignments: ohne bestehende Zuordnungen liefert {moved:0}', () => {
  const db = buildDb();
  const u = seedUser(db);
  const oldTodo = seedTodo(db, u);
  const newTodo = seedTodo(db, u);
  const result = moveAssignments(db, { refType: 'todo', refId: oldTodo }, { refType: 'todo', refId: newTodo });
  assert.deepEqual(result, { moved: 0 });
});

test('moveAssignments: identisches from/to (No-Op) löscht bestehende Zuordnungen NICHT (Verifikations-Review Fund 1)', () => {
  const db = buildDb();
  const u = seedUser(db);
  const topic = seedTopic(db, u);
  const c1 = seedContact(db, u);
  const c2 = seedContact(db, u);
  assign(db, u, c1, 'topic', topic);
  assign(db, u, c2, 'topic', topic);

  const result = moveAssignments(db, { refType: 'topic', refId: topic }, { refType: 'topic', refId: topic });
  assert.deepEqual(result, { moved: 0 });

  const rows = db.prepare('SELECT ref_type, ref_id, contact_id FROM contact_assignments').all();
  assert.equal(rows.length, 2, 'Zuordnungen dürfen bei identischem from/to nicht verloren gehen');
  assert.deepEqual(
    rows.map((r) => r.contact_id).sort(),
    [c1, c2].sort()
  );
});

test('moveAssignments: wirft bei ungültigem refType', () => {
  const db = buildDb();
  assert.throws(() => moveAssignments(db, { refType: 'contact', refId: 'x' }, { refType: 'todo', refId: 'y' }));
  assert.throws(() => moveAssignments(db, { refType: 'todo', refId: 'x' }, { refType: 'meeting', refId: 'y' }));
});

test('moveAssignments: wirft bei ungültiger/leerer refId', () => {
  const db = buildDb();
  assert.throws(() => moveAssignments(db, { refType: 'todo', refId: '' }, { refType: 'topic', refId: 'y' }));
  assert.throws(() => moveAssignments(db, { refType: 'todo', refId: 'x' }, { refType: 'topic', refId: 123 }));
});
