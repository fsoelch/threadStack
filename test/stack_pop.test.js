'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function pushTopic(agent, refType, refId, note) {
  const r = await agent.post('/api/stack/push').send({ refType, refId, nextStepNote: note });
  return r.body.frame.id;
}

test('Stack Pop: 401 / 404 / 400', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));

  const r401 = await request(app).post('/api/stack/pop/does-not-exist').send({ resolution: 'done' });
  assert.equal(r401.status, 401);

  const { agent, topicId } = await bootstrapStackFixture(request, app, db);
  const r400 = await agent.post('/api/stack/pop/x').send({ resolution: 'invalid' });
  assert.equal(r400.status, 400);

  const r404 = await agent.post('/api/stack/pop/does-not-exist').send({ resolution: 'done' });
  assert.equal(r404.status, 404);

  // and 404 when frame already closed
  const fid = await pushTopic(agent, 'topic', topicId, 'note');
  await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'dropped' });
  const r404b = await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'dropped' });
  assert.equal(r404b.status, 404);
});

test('Stack Pop: resolution=done setzt Topic auf done', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const fid = await pushTopic(agent, 'topic', topicId, 'note');
  // ensure pop happens after 30s threshold (avoid drift) — wait 35ms is enough? No, threshold is 30s.
  // We can't easily wait 30s; just assert drift_warning=true is OK here and check applied.topicDone.

  const r = await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'done', result: 'Ergebnis-Text' });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied.topicDone, true);
  assert.equal(r.body.applied.resultSaved, true);

  // Verify topic state
  const meetings = await agent.get('/api/meetings');
  const topic = meetings.body.find(m => m.id === meetingId).topics.find(x => x.id === topicId);
  assert.equal(topic.done, true);
  assert.equal(topic.result, 'Ergebnis-Text');
});

test('Stack Pop: resolution=snoozed setzt snoozed_until', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const fid = await pushTopic(agent, 'todo', todoId, 'note');
  const until = '2030-01-01T09:00:00.000Z';
  const r = await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'snoozed', snoozedUntil: until });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied.snoozedUntil, until);

  const todos = await agent.get('/api/todos');
  const td = todos.body.find(x => x.id === todoId);
  assert.equal(td.snoozedUntil, until);
});

test('Stack Pop: resolution=dropped hat keinen Side-Effect', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const fid = await pushTopic(agent, 'topic', topicId, 'note');
  const r = await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'dropped' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applied, {});

  const meetings = await agent.get('/api/meetings');
  const topic = meetings.body.find(m => m.id === meetingId).topics.find(x => x.id === topicId);
  assert.equal(topic.done, false);
});

test('Stack Pop: resolution=resumed hält Frame offen und macht ihn aktiv', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId, todoId } = await bootstrapStackFixture(request, app, db);

  const f1 = await pushTopic(agent, 'topic', topicId, 'note A');
  const f2 = await pushTopic(agent, 'todo',  todoId,  'note B');

  // Pop the active (f2) with resumed → f2 stays open and remains active
  const r = await agent.post(`/api/stack/pop/${f2}`).send({ resolution: 'resumed' });
  assert.equal(r.status, 200);

  const g = await agent.get('/api/stack');
  assert.equal(g.body.depth, 2);
  assert.equal(g.body.frames[0].id, f2);
  assert.equal(g.body.frames[1].id, f1);
});

test('Stack Pop: drift_warning=true bei schnellem Pop (<30s) ohne done', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const fid = await pushTopic(agent, 'todo', todoId, 'note');
  const r = await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'dropped' });
  assert.equal(r.body.drift_warning, true);
});

test('Stack Pop: kein drift_warning bei resolution=done', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const fid = await pushTopic(agent, 'topic', topicId, 'note');
  const r = await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'done' });
  assert.equal(r.body.drift_warning, false);
});

test('Stack Pop: next_active wird korrekt zurückgegeben', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId, todoId } = await bootstrapStackFixture(request, app, db);

  const f1 = await pushTopic(agent, 'topic', topicId, 'note A');
  const f2 = await pushTopic(agent, 'todo',  todoId,  'note B');

  const r = await agent.post(`/api/stack/pop/${f2}`).send({ resolution: 'dropped' });
  assert.equal(r.body.next_active.id, f1);

  const r2 = await agent.post(`/api/stack/pop/${f1}`).send({ resolution: 'dropped' });
  assert.equal(r2.body.next_active, null);
});
