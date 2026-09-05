'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildDb,
  buildApp,
  seedUser,
  seedContact,
  seedTodo,
  seedTopic,
} = require('./contact_assignments_test_harness');

test('GET /contacts/:contactId/assignments: 404 bei fremdem/nicht existentem Kontakt', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const owner = seedUser(db);
  const other = seedUser(db);
  const c = seedContact(db, owner);

  const foreign = await request(app).get(`/api/contacts/${c}/assignments`).set('x-user-id', other);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'CONTACT_NOT_FOUND');

  const missing = await request(app).get('/api/contacts/ghost/assignments').set('x-user-id', owner);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CONTACT_NOT_FOUND');
});

test('GET liefert todo- und topic-Zuordnungen inkl. meetingId/meetingTitle nur bei topic', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const t = seedTodo(db, u, { title: 'Mein Todo', dueDate: '2026-09-10' });
  const tp = seedTopic(db, u, { title: 'Mein Topic' });

  await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  await request(app).post(`/api/assignments/topic/${tp}`).set('x-user-id', u).send({ contactId: c });

  const res = await request(app).get(`/api/contacts/${c}/assignments`).set('x-user-id', u);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);

  const todoItem = res.body.items.find((i) => i.refType === 'todo');
  assert.equal(todoItem.title, 'Mein Todo');
  assert.equal(todoItem.dueDate, '2026-09-10');
  assert.equal(todoItem.meetingId, null);
  assert.equal(todoItem.meetingTitle, null);

  const topicItem = res.body.items.find((i) => i.refType === 'topic');
  assert.equal(topicItem.title, 'Mein Topic');
  assert.ok(topicItem.meetingId);
  assert.ok(topicItem.meetingTitle);
});

test('Sortierung: offene zuerst (done ASC, assignedAt DESC, refId DESC)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const openTodo = seedTodo(db, u, { title: 'offen', done: false });
  const doneTodo = seedTodo(db, u, { title: 'erledigt', done: true });

  await request(app).post(`/api/assignments/todo/${doneTodo}`).set('x-user-id', u).send({ contactId: c });
  await request(app).post(`/api/assignments/todo/${openTodo}`).set('x-user-id', u).send({ contactId: c });

  const res = await request(app).get(`/api/contacts/${c}/assignments`).set('x-user-id', u);
  assert.equal(res.body.items[0].refId, openTodo);
  assert.equal(res.body.items[0].done, false);
  assert.equal(res.body.items[1].refId, doneTodo);
  assert.equal(res.body.items[1].done, true);
});

test('status=open / status=done filtert; counts bleiben unabhängig vom Filter', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const openTodo = seedTodo(db, u, { done: false });
  const doneTodo = seedTodo(db, u, { done: true });
  await request(app).post(`/api/assignments/todo/${openTodo}`).set('x-user-id', u).send({ contactId: c });
  await request(app).post(`/api/assignments/todo/${doneTodo}`).set('x-user-id', u).send({ contactId: c });

  const open = await request(app).get(`/api/contacts/${c}/assignments?status=open`).set('x-user-id', u);
  assert.equal(open.body.items.length, 1);
  assert.equal(open.body.items[0].refId, openTodo);
  assert.deepEqual(open.body.counts, { open: 1, done: 1 });
  assert.equal(open.body.page.total, 1);

  const done = await request(app).get(`/api/contacts/${c}/assignments?status=done`).set('x-user-id', u);
  assert.equal(done.body.items.length, 1);
  assert.equal(done.body.items[0].refId, doneTodo);
  assert.deepEqual(done.body.counts, { open: 1, done: 1 });

  const all = await request(app).get(`/api/contacts/${c}/assignments?status=all`).set('x-user-id', u);
  assert.equal(all.body.items.length, 2);
});

test('Paging: limit/offset funktionieren, hasMore korrekt gesetzt', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const t = seedTodo(db, u, { title: `t${i}` });
    ids.push(t);
    await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  }

  const page1 = await request(app).get(`/api/contacts/${c}/assignments?limit=2&offset=0`).set('x-user-id', u);
  assert.equal(page1.body.items.length, 2);
  assert.deepEqual(page1.body.page, { limit: 2, offset: 0, total: 5, hasMore: true });

  const page3 = await request(app).get(`/api/contacts/${c}/assignments?limit=2&offset=4`).set('x-user-id', u);
  assert.equal(page3.body.items.length, 1);
  assert.deepEqual(page3.body.page, { limit: 2, offset: 4, total: 5, hasMore: false });
});

test('limit außerhalb 1..50 -> 400 INVALID_LIMIT; offset<0 oder nicht ganzzahlig -> 400 INVALID_OFFSET', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);

  const tooHigh = await request(app).get(`/api/contacts/${c}/assignments?limit=51`).set('x-user-id', u);
  assert.equal(tooHigh.status, 400);
  assert.equal(tooHigh.body.code, 'INVALID_LIMIT');

  const tooLow = await request(app).get(`/api/contacts/${c}/assignments?limit=0`).set('x-user-id', u);
  assert.equal(tooLow.status, 400);
  assert.equal(tooLow.body.code, 'INVALID_LIMIT');

  const nonNumeric = await request(app).get(`/api/contacts/${c}/assignments?limit=abc`).set('x-user-id', u);
  assert.equal(nonNumeric.status, 400);
  assert.equal(nonNumeric.body.code, 'INVALID_LIMIT');

  const negativeOffset = await request(app).get(`/api/contacts/${c}/assignments?offset=-1`).set('x-user-id', u);
  assert.equal(negativeOffset.status, 400);
  assert.equal(negativeOffset.body.code, 'INVALID_OFFSET');

  const fractionalOffset = await request(app).get(`/api/contacts/${c}/assignments?offset=1.5`).set('x-user-id', u);
  assert.equal(fractionalOffset.status, 400);
  assert.equal(fractionalOffset.body.code, 'INVALID_OFFSET');
});

test('ungültiger status-Wert -> 400 INVALID_STATUS', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);

  const res = await request(app).get(`/api/contacts/${c}/assignments?status=archived`).set('x-user-id', u);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_STATUS');
});

// ── Löschen von beiden Seiten liefert identisches Ergebnis ─────────

test('DELETE über Kontakt-Seite und Vorhaben-Seite liefert dasselbe Ergebnis (dieselbe Query-Funktion)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const t1 = seedTodo(db, u);
  const t2 = seedTodo(db, u);
  await request(app).post(`/api/assignments/todo/${t1}`).set('x-user-id', u).send({ contactId: c });
  await request(app).post(`/api/assignments/todo/${t2}`).set('x-user-id', u).send({ contactId: c });

  const viaVorhaben = await request(app).delete(`/api/assignments/todo/${t1}/${c}`).set('x-user-id', u);
  const viaContact = await request(app).delete(`/api/contacts/${c}/assignments/todo/${t2}`).set('x-user-id', u);
  assert.deepEqual(viaVorhaben.body, { ok: true, removed: true });
  assert.deepEqual(viaContact.body, { ok: true, removed: true });

  // beide idempotent identisch beim zweiten Aufruf
  const viaVorhaben2 = await request(app).delete(`/api/assignments/todo/${t1}/${c}`).set('x-user-id', u);
  const viaContact2 = await request(app).delete(`/api/contacts/${c}/assignments/todo/${t2}`).set('x-user-id', u);
  assert.deepEqual(viaVorhaben2.body, { ok: true, removed: false });
  assert.deepEqual(viaContact2.body, { ok: true, removed: false });

  const list = await request(app).get(`/api/contacts/${c}/assignments`).set('x-user-id', u);
  assert.equal(list.body.items.length, 0);
});

test('DELETE über Kontakt-Seite: 400 INVALID_REF_TYPE bei ungültigem refType', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);

  const res = await request(app).delete(`/api/contacts/${c}/assignments/theme/x`).set('x-user-id', u);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REF_TYPE');
});

// Nachbesserung Code-Review Fund 9: DELETE über die Kontakt-Seite prüft jetzt
// ebenfalls die Ref-Eigentümerschaft, bevor gelöscht wird.
test('DELETE über Kontakt-Seite auf fremdes Vorhaben -> 404 REF_NOT_FOUND, nichts wird gelöscht', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const owner = seedUser(db);
  const attacker = seedUser(db);
  const c = seedContact(db, owner);
  const t = seedTodo(db, owner);
  await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', owner).send({ contactId: c });

  const res = await request(app).delete(`/api/contacts/${c}/assignments/todo/${t}`).set('x-user-id', attacker);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'REF_NOT_FOUND');

  const stillThere = await request(app).get(`/api/contacts/${c}/assignments`).set('x-user-id', owner);
  assert.equal(stillThere.body.items.length, 1);
});

// ── N+1-Freiheit ────────────────────────────────────────────────────

test('GET /contacts/:contactId/assignments nutzt eine feste, von der Item-Zahl unabhängige Anzahl Queries', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);

  // Wenige Einträge
  const fewIds = [];
  for (let i = 0; i < 2; i += 1) {
    const t = seedTodo(db, u);
    fewIds.push(t);
    await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  }

  const originalPrepare = db.prepare.bind(db);
  let countFew = 0;
  db.prepare = (sql) => {
    countFew += 1;
    return originalPrepare(sql);
  };
  await request(app).get(`/api/contacts/${c}/assignments?limit=50`).set('x-user-id', u);
  db.prepare = originalPrepare;

  // Viele weitere Einträge dazu
  for (let i = 0; i < 18; i += 1) {
    const t = seedTodo(db, u);
    await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  }

  let countMany = 0;
  db.prepare = (sql) => {
    countMany += 1;
    return originalPrepare(sql);
  };
  await request(app).get(`/api/contacts/${c}/assignments?limit=50`).set('x-user-id', u);
  db.prepare = originalPrepare;

  assert.equal(countFew, countMany, 'Anzahl vorbereiteter Statements darf nicht mit der Item-Zahl wachsen (kein N+1)');
  assert.ok(countMany <= 4, `erwartet höchstens ~3 Queries (resolveContact + items + counts), gemessen: ${countMany}`);
});
