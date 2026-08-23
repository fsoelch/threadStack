'use strict';
// End-to-End-Tests für das S2-Wiring von lib/progress in server.js.
//
// S1 hat createProgressRouter() bereits ausführlich gegen eine eigene
// Mini-App mit Fake-requireAuth/ownsRef getestet (siehe test/progress_*.test.js).
// Dieses Paket testet stattdessen NUR die Verdrahtung: erreicht man den
// Router über den echten server.js-Mount-Pfad, greift der ECHTE
// requireAuth (Session) / ownsRef (echte todos/topics-Tabellen)?
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Progress-Router: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/progress/todo/does-not-exist');
  assert.equal(r.status, 401);
});

test('Progress-Router: GET /:refType/:refId liefert ref-Daten aus der echten todos-Tabelle', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const r = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ref.refId, todoId);
  assert.equal(r.body.ref.title, 'Todo-1');
  assert.equal(r.body.goal, '');
  assert.equal(r.body.nextStep, '');
  assert.equal(r.body.entries.length, 0);
});

test('Progress-Router: 404 bei nicht existierender Referenz (ownsRef via echte Tabellen)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const r = await agent.get('/api/progress/todo/does-not-exist');
  assert.equal(r.status, 404);
});

test('Progress-Router: 404 bei Referenz eines fremden Nutzers (echtes ownsRef aus server.js)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  // Zweiten Nutzer anlegen (Admin-Endpunkt) und dessen eigenes Todo erzeugen.
  const other = await agent.post('/api/users').send({ username: 'other', password: 'geheim12345', role: 'user' });
  assert.equal(other.status, 201);
  const otherAgent = request.agent(app);
  const login = await otherAgent.post('/api/login').send({ username: 'other', password: 'geheim12345' });
  assert.equal(login.status, 200);
  const otherTodo = await otherAgent.post('/api/todos').send({ title: 'Fremdes Todo' });
  assert.equal(otherTodo.status, 201);

  // admin darf NICHT auf das Todo von "other" zugreifen.
  const r = await agent.get(`/api/progress/todo/${otherTodo.body.id}`);
  assert.equal(r.status, 404);

  // "other" darf nicht auf admins Todo zugreifen.
  const r2 = await otherAgent.get(`/api/progress/todo/${todoId}`);
  assert.equal(r2.status, 404);
});

test('Progress-Router: POST/GET/DELETE Zwischenstand-Entry End-to-End über den echten Server', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const created = await agent.post(`/api/progress/topic/${topicId}/entries`).send({ body: '<p>Kunde kontaktiert</p>' });
  assert.equal(created.status, 201);
  const entryId = created.body.entry.id;
  assert.equal(created.body.entry.refType, 'topic');
  assert.equal(created.body.entry.refId, topicId);
  assert.equal(created.body.stats.entryCount, 1);

  const listed = await agent.get(`/api/progress/topic/${topicId}/entries`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.entries.length, 1);
  assert.equal(listed.body.entries[0].id, entryId);

  const del = await agent.delete(`/api/progress/entries/${entryId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.stats.entryCount, 0);
});

test('Progress-Router: DELETE /entries/:entryId 401 ohne Login (Route-Reihenfolge vor /:refType/:refId)', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).delete('/api/progress/entries/does-not-exist');
  assert.equal(r.status, 401);
});

test('Progress-Router: PUT goal/next-step über den echten Server persistieren', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const goal = await agent.put(`/api/progress/todo/${todoId}/goal`).send({ goal: 'MVP live bringen' });
  assert.equal(goal.status, 200);
  assert.equal(goal.body.goal, 'MVP live bringen');

  const next = await agent.put(`/api/progress/todo/${todoId}/next-step`).send({ nextStep: 'Angebot einholen' });
  assert.equal(next.status, 200);
  assert.equal(next.body.nextStep, 'Angebot einholen');

  const detail = await agent.get(`/api/progress/todo/${todoId}`);
  assert.equal(detail.body.goal, 'MVP live bringen');
  assert.equal(detail.body.nextStep, 'Angebot einholen');
});

test('Progress-Router: reentry.ai wird über den echten getLatestFrameId-Callback befüllt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  // Ohne offenen Stack-Frame -> kein AI-Kontext verfügbar.
  const withoutFrame = await agent.get(`/api/progress/topic/${topicId}`);
  assert.equal(withoutFrame.status, 200);
  assert.deepEqual(withoutFrame.body.reentry.ai, { available: false, frameId: null });

  const pushed = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'weiter' });
  assert.equal(pushed.status, 201);
  const frameId = pushed.body.frame.id;

  const withFrame = await agent.get(`/api/progress/topic/${topicId}`);
  assert.equal(withFrame.status, 200);
  assert.deepEqual(withFrame.body.reentry.ai, { available: true, frameId });
});
