'use strict';
// Tests für die additive Progress-Einbettung (item.progress) in die
// bestehenden Listen-Endpunkte GET /api/todos, GET /api/meetings und
// GET /api/themes/:id/todos - inklusive N+1-Freiheit (EINE summaryFor()
// Batch-Query pro Liste, unabhängig von der Item-Anzahl).
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, ensureTestAdmin, login, REPO_ROOT } = require('./helpers');

test('GET /api/todos: item.progress ist vor Zwischenständen ein Summary mit entryCount=0, danach entryCount=1', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const before = await agent.get('/api/todos');
  assert.equal(before.status, 200);
  const todoBefore = before.body.find(x => x.id === todoId);
  // summaryFor() liefert für jedes gültige Ref-Item IMMER ein Summary-Objekt
  // (auch ohne Zwischenstände, entryCount=0) - `?? null` in der Wiring-Logik
  // greift nur, falls ein Item aus irgendeinem Grund gar nicht im
  // summaryMap landet (z.B. leere Liste).
  assert.ok(todoBefore.progress);
  assert.equal(todoBefore.progress.entryCount, 0);
  assert.equal(todoBefore.progress.badgeLabel, null);

  const entry = await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>Zwischenstand</p>' });
  assert.equal(entry.status, 201);

  const after = await agent.get('/api/todos');
  const todoAfter = after.body.find(x => x.id === todoId);
  assert.ok(todoAfter.progress);
  assert.equal(todoAfter.progress.entryCount, 1);
});

test('GET /api/todos: item.progress ist null, wenn die Liste keine Items enthält (leeres summaryFor-Ergebnis)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  const r = await agent.get('/api/todos');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('GET /api/meetings: topics[].progress wird analog befüllt (entryCount 0 -> 1)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const before = await agent.get('/api/meetings');
  assert.equal(before.status, 200);
  const meetingBefore = before.body.find(m => m.id === meetingId);
  const topicBefore = meetingBefore.topics.find(x => x.id === topicId);
  assert.ok(topicBefore.progress);
  assert.equal(topicBefore.progress.entryCount, 0);

  await agent.post(`/api/progress/topic/${topicId}/entries`).send({ body: '<p>Notiz</p>' });

  const after = await agent.get('/api/meetings');
  const meetingAfter = after.body.find(m => m.id === meetingId);
  const topicAfter = meetingAfter.topics.find(x => x.id === topicId);
  assert.ok(topicAfter.progress);
  assert.equal(topicAfter.progress.entryCount, 1);
});

test('GET /api/themes/:id/todos: item.progress wird für verlinkte Todos befüllt (entryCount 0 -> 1)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const theme = await agent.post('/api/themes').send({ title: 'Thema-1' });
  assert.equal(theme.status, 201);
  const link = await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'todo', refId: todoId });
  assert.equal(link.status, 201);

  const before = await agent.get(`/api/themes/${theme.body.id}/todos`);
  assert.equal(before.status, 200);
  const todoBefore = before.body.find(x => x.id === todoId);
  assert.ok(todoBefore.progress);
  assert.equal(todoBefore.progress.entryCount, 0);

  await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>Notiz</p>' });

  const after = await agent.get(`/api/themes/${theme.body.id}/todos`);
  const todoAfter = after.body.find(x => x.id === todoId);
  assert.ok(todoAfter.progress);
  assert.equal(todoAfter.progress.entryCount, 1);
});

test('GET /api/todos: kein N+1 - GENAU EINE GROUP-BY-Query unabhängig von der Todo-Anzahl', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  for (let i = 0; i < 12; i++) {
    const r = await agent.post('/api/todos').send({ title: `Todo-batch-${i}` });
    assert.equal(r.status, 201);
  }

  // Spy auf db.prepare() (Muster analog test/progress_summary.test.js von S1),
  // direkt um den echten HTTP-Request herum, da supertest asynchron ist.
  let groupByCalls = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('GROUP BY ref_id')) groupByCalls++;
    return origPrepare(sql);
  };
  let response;
  try {
    response = await agent.get('/api/todos');
  } finally {
    db.prepare = origPrepare;
  }
  assert.equal(response.status, 200);
  assert.ok(response.body.length >= 13, 'mind. 13 Todos erwartet (1 aus Fixture + 12 Batch)');
  // summaryFor() macht max. 1 GROUP-BY-Query pro refType; bei einer reinen
  // Todo-Liste ist das GENAU EINE Query, unabhängig von der Item-Anzahl.
  assert.equal(groupByCalls, 1, 'GET /api/todos darf pro Response nur EINE GROUP-BY-Query ausführen (kein N+1)');
});

test('GET /api/meetings: kein N+1 bei vielen Topics', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);

  for (let i = 0; i < 10; i++) {
    const r = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: `Topic-batch-${i}` });
    assert.equal(r.status, 201);
  }

  let groupByCalls = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('GROUP BY ref_id')) groupByCalls++;
    return origPrepare(sql);
  };
  let response;
  try {
    response = await agent.get('/api/meetings');
  } finally {
    db.prepare = origPrepare;
  }
  assert.equal(response.status, 200);
  assert.equal(groupByCalls, 1, 'GET /api/meetings darf pro Response nur EINE GROUP-BY-Query für Topics ausführen (kein N+1)');
});
