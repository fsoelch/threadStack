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

// ── GET (Vorhaben-Seite) ──────────────────────────────────────────

test('GET /assignments/:refType/:refId liefert leere Liste + limit', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);

  const res = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', u);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { contacts: [], limit: 20 });
});

test('GET liefert 400 INVALID_REF_TYPE bei unbekanntem refType', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);

  const res = await request(app).get('/api/assignments/theme/abc').set('x-user-id', u);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REF_TYPE');
});

test('GET liefert 404 REF_NOT_FOUND bei fremdem todo (ununterscheidbar von "existiert nicht")', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const owner = seedUser(db);
  const other = seedUser(db);
  const t = seedTodo(db, owner);

  const resForeign = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', other);
  assert.equal(resForeign.status, 404);
  assert.equal(resForeign.body.code, 'REF_NOT_FOUND');

  const resMissing = await request(app).get('/api/assignments/todo/does-not-exist').set('x-user-id', owner);
  assert.equal(resMissing.status, 404);
  assert.equal(resMissing.body.code, 'REF_NOT_FOUND');
  assert.equal(resMissing.body.error, resForeign.body.error);
});

test('GET sortiert nach contacts.sort_order, name', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const cB = seedContact(db, u, { name: 'Bea', sortOrder: 1 });
  const cA = seedContact(db, u, { name: 'Anna', sortOrder: 0 });

  await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: [cB, cA] });
  const res = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', u);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.contacts.map((c) => c.contactId), [cA, cB]);
});

// ── PUT (Mengensemantik) ──────────────────────────────────────────

test('PUT setzt den kompletten Satz: dedupliziert, ergänzt neue, entfernt alte', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c1 = seedContact(db, u, { name: 'C1' });
  const c2 = seedContact(db, u, { name: 'C2' });
  const c3 = seedContact(db, u, { name: 'C3' });

  const first = await request(app)
    .put(`/api/assignments/todo/${t}`)
    .set('x-user-id', u)
    .send({ contactIds: [c1, c2, c1] }); // Duplikat in der Eingabe
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.contacts.map((c) => c.contactId).sort(), [c1, c2].sort());

  const second = await request(app)
    .put(`/api/assignments/todo/${t}`)
    .set('x-user-id', u)
    .send({ contactIds: [c2, c3] }); // c1 raus, c3 neu, c2 bleibt
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.contacts.map((c) => c.contactId).sort(), [c2, c3].sort());
});

test('PUT behält assignedAt für bereits zugeordnete Kontakte (nicht neu gesetzt)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c1 = seedContact(db, u);
  const c2 = seedContact(db, u);

  const first = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: [c1] });
  const firstAssignedAt = first.body.contacts.find((c) => c.contactId === c1).assignedAt;

  await new Promise((r) => setTimeout(r, 5));
  const second = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: [c1, c2] });
  const stillC1 = second.body.contacts.find((c) => c.contactId === c1);
  assert.equal(stillC1.assignedAt, firstAssignedAt);
});

test('PUT: 400 INVALID_PAYLOAD bei Nicht-Array oder Nicht-String-Einträgen', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);

  const notArray = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: 'x' });
  assert.equal(notArray.status, 400);
  assert.equal(notArray.body.code, 'INVALID_PAYLOAD');

  const withNumber = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: [123] });
  assert.equal(withNumber.status, 400);
  assert.equal(withNumber.body.code, 'INVALID_PAYLOAD');
});

test('PUT: 400 ASSIGNMENT_LIMIT_REACHED nach Dedupe über 20 eindeutige IDs', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const ids = Array.from({ length: 21 }, () => seedContact(db, u));

  const res = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: ids });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ASSIGNMENT_LIMIT_REACHED');

  // Nichts darf geschrieben worden sein (Alles-oder-nichts)
  const check = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', u);
  assert.equal(check.body.contacts.length, 0);
});

test('PUT: 20 eindeutige IDs (Grenzwert) sind erlaubt', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const ids = Array.from({ length: 20 }, () => seedContact(db, u));

  const res = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: ids });
  assert.equal(res.status, 200);
  assert.equal(res.body.contacts.length, 20);
});

test('PUT: 404 CONTACT_NOT_FOUND sobald EINE ID nicht dem Nutzer gehört — nichts wird geschrieben', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const other = seedUser(db);
  const t = seedTodo(db, u);
  const mine = seedContact(db, u);
  const foreign = seedContact(db, other);

  const res = await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: [mine, foreign] });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'CONTACT_NOT_FOUND');

  const check = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', u);
  assert.equal(check.body.contacts.length, 0, 'Alles-oder-nichts: auch die gültige ID darf nicht geschrieben worden sein');
});

test('PUT: 404 REF_NOT_FOUND bei fremdem/nicht existentem Vorhaben', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);

  const res = await request(app).put('/api/assignments/todo/ghost').set('x-user-id', u).send({ contactIds: [c] });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'REF_NOT_FOUND');
});

test('PUT: 409 ARCHIVED_READONLY, wenn das zugehörige Meeting archiviert ist (topic) (Referenzverhalten — Archiv-Konzept im Bestand noch nicht vorhanden)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const tp = seedTopic(db, u, { archived: true });

  const res = await request(app).put(`/api/assignments/topic/${tp}`).set('x-user-id', u).send({ contactIds: [c] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ARCHIVED_READONLY');
});

// ── POST (Dedupe) ──────────────────────────────────────────────────

test('POST legt neue Zuordnung an (201, created:true)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c = seedContact(db, u, { name: 'Neu' });

  const res = await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  assert.equal(res.status, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.assignment.contactId, c);
  assert.equal(res.body.assignment.name, 'Neu');
});

test('POST ist dedupliziert: bestehende Zuordnung liefert 200 created:false ohne Fehler', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c = seedContact(db, u);

  const first = await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  assert.equal(first.status, 201);

  const second = await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.assignment.assignedAt, first.body.assignment.assignedAt);

  const list = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', u);
  assert.equal(list.body.contacts.length, 1, 'keine doppelte Zeile');
});

test('POST: 400 ASSIGNMENT_LIMIT_REACHED, wenn bereits 20 Kontakte zugeordnet sind', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const ids = Array.from({ length: 20 }, () => seedContact(db, u));
  await request(app).put(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactIds: ids });

  const extra = seedContact(db, u);
  const res = await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: extra });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ASSIGNMENT_LIMIT_REACHED');
});

test('POST: 404 CONTACT_NOT_FOUND bei fremdem Kontakt', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const other = seedUser(db);
  const t = seedTodo(db, u);
  const foreign = seedContact(db, other);

  const res = await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: foreign });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'CONTACT_NOT_FOUND');
});

test('POST: 400 INVALID_PAYLOAD bei fehlender/ungültiger contactId', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);

  const res = await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PAYLOAD');
});

test('POST: 409 ARCHIVED_READONLY bei archiviertem Meeting (topic) (Referenzverhalten — Archiv-Konzept im Bestand noch nicht vorhanden)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const c = seedContact(db, u);
  const tp = seedTopic(db, u, { archived: true });

  const res = await request(app).post(`/api/assignments/topic/${tp}`).set('x-user-id', u).send({ contactId: c });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ARCHIVED_READONLY');
});

// ── DELETE (Vorhaben-Seite, idempotent) ─────────────────────────────

test('DELETE entfernt eine bestehende Zuordnung (removed:true)', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c = seedContact(db, u);
  await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });

  const res = await request(app).delete(`/api/assignments/todo/${t}/${c}`).set('x-user-id', u);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, removed: true });
});

test('DELETE ist idempotent: zweiter Aufruf liefert removed:false, kein Fehler', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);
  const t = seedTodo(db, u);
  const c = seedContact(db, u);
  await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', u).send({ contactId: c });

  await request(app).delete(`/api/assignments/todo/${t}/${c}`).set('x-user-id', u);
  const second = await request(app).delete(`/api/assignments/todo/${t}/${c}`).set('x-user-id', u);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true, removed: false });
});

test('DELETE: 400 INVALID_REF_TYPE bei ungültigem refType', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const u = seedUser(db);

  const res = await request(app).delete('/api/assignments/theme/x/y').set('x-user-id', u);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REF_TYPE');
});

// Nachbesserung Code-Review Fund 9: DELETE auf ein fremdes Vorhaben prüft nun
// dieselbe Ref-Eigentümerschaft wie GET/PUT/POST und liefert konsistent 404
// REF_NOT_FOUND statt eines stillen "Erfolgs" (removed:false). Da die 404
// -Antwort identisch zu "existiert nicht" ist, findet weiterhin keine
// Existenz-Enumeration statt.
test('DELETE auf ein fremdes Vorhaben -> 404 REF_NOT_FOUND, nichts wird gelöscht', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const owner = seedUser(db);
  const attacker = seedUser(db);
  const t = seedTodo(db, owner);
  const c = seedContact(db, owner);
  await request(app).post(`/api/assignments/todo/${t}`).set('x-user-id', owner).send({ contactId: c });

  const res = await request(app).delete(`/api/assignments/todo/${t}/${c}`).set('x-user-id', attacker);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'REF_NOT_FOUND');

  const stillThere = await request(app).get(`/api/assignments/todo/${t}`).set('x-user-id', owner);
  assert.equal(stillThere.body.contacts.length, 1);
});

// ── Auth ─────────────────────────────────────────────────────────

test('Alle Routen verlangen Authentifizierung', async () => {
  const db = buildDb();
  const app = buildApp(db);
  const res = await request(app).get('/api/assignments/todo/whatever');
  assert.equal(res.status, 401);
});
