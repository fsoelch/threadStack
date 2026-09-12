'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('PUT /api/todos/:id: bettet momentum-Feld nur bei tatsaechlicher done-Aenderung ein', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const todo = await agent.post('/api/todos').send({ title: 'Aufgabe' });

  const noChange = await agent.put(`/api/todos/${todo.body.id}`).send({ title: 'Aufgabe (umbenannt)' });
  assert.equal(noChange.status, 200);
  assert.equal(noChange.body.momentum, undefined);

  const completed = await agent.put(`/api/todos/${todo.body.id}`).send({ done: true, utcOffsetMinutes: 0 });
  assert.equal(completed.status, 200);
  assert.ok(completed.body.momentum);
  assert.equal(completed.body.momentum.weeklyCompletedCount, 1);
  assert.deepEqual(completed.body.momentum.milestones, []);

  const overview = await agent.get('/api/momentum/overview?utcOffsetMinutes=0');
  assert.equal(overview.body.week.completedCount, 1);
  assert.equal(overview.body.streak.activeToday, true);
});

test('PUT /api/todos/:id: Wiedereroeffnen sendet momentum-Feld ohne Meilensteine, Wochenzaehler sinkt wieder', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const todo = await agent.post('/api/todos').send({ title: 'Aufgabe' });
  await agent.put(`/api/todos/${todo.body.id}`).send({ done: true });
  const reopened = await agent.put(`/api/todos/${todo.body.id}`).send({ done: false });
  assert.deepEqual(reopened.body.momentum.milestones, []);
  assert.equal(reopened.body.momentum.weeklyCompletedCount, 0);
});

test('PUT /api/meetings/:mid/topics/:tid: Abschliessen eines Themas liefert immer einen Meilenstein', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const meeting = await agent.post('/api/meetings').send({ title: 'M', color: '#6366f1' });
  const topic = await agent.post(`/api/meetings/${meeting.body.id}/topics`).send({ title: 'Serverumzug' });

  const res = await agent.put(`/api/meetings/${meeting.body.id}/topics/${topic.body.id}`).send({ done: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.momentum.milestones, [{ type: 'topic', id: topic.body.id, name: 'Serverumzug' }]);

  const overview = await agent.get('/api/momentum/overview');
  assert.deepEqual(overview.body.week.milestones.map((m) => m.name), ['Serverumzug']);
});

test('Kontakt-Meilenstein ueber contact_assignments beim Abschliessen des letzten offenen Todos', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contact = await agent.post('/api/contacts').send({ name: 'Frau Meyer' });
  const todo1 = await agent.post('/api/todos').send({ title: 'A' });
  const todo2 = await agent.post('/api/todos').send({ title: 'B' });
  await agent.post(`/api/assignments/todo/${todo1.body.id}`).send({ contactId: contact.body.id });
  await agent.post(`/api/assignments/todo/${todo2.body.id}`).send({ contactId: contact.body.id });

  const r1 = await agent.put(`/api/todos/${todo1.body.id}`).send({ done: true });
  assert.deepEqual(r1.body.momentum.milestones, []);

  const r2 = await agent.put(`/api/todos/${todo2.body.id}`).send({ done: true });
  assert.deepEqual(r2.body.momentum.milestones, [{ type: 'contact', id: contact.body.id, name: 'Frau Meyer' }]);
});

test('PUT /api/todos/:id: ein Todo eines anderen Nutzers bleibt 404, momentum-Hook laeuft nicht mit', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  const todo = await agent.post('/api/todos').send({ title: 'Aufgabe' });

  // Zweiter Nutzer darf das Todo weder sehen noch abschliessen.
  const bcrypt = require('bcryptjs');
  const otherId = 'other-' + Date.now();
  db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run(otherId, 'other', bcrypt.hashSync('test12345', 4), 'user', new Date().toISOString());
  const otherAgent = await login(request, app, 'other', 'test12345');
  const res = await otherAgent.put(`/api/todos/${todo.body.id}`).send({ done: true });
  assert.equal(res.status, 404);
});
