'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Stack GET: leer initial', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const r = await agent.get('/api/stack');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { frames: [], depth: 0 });
});

test('Stack GET: aktiv zuerst', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId, todoId } = await bootstrapStackFixture(request, app, db);

  const f1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'a' });
  const f2 = await agent.post('/api/stack/push').send({ refType: 'todo',  refId: todoId,  nextStepNote: 'b' });

  const r = await agent.get('/api/stack');
  assert.equal(r.body.depth, 2);
  assert.equal(r.body.frames[0].id, f2.body.frame.id);
  assert.equal(r.body.frames[1].id, f1.body.frame.id);
  assert.ok(typeof r.body.frames[0].age_seconds === 'number');
});

test('Stack GET: peek liefert einzelnes Frame, 404 bei fremd', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const f = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'x' });

  const r = await agent.get(`/api/stack/peek/${f.body.frame.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.frame.id, f.body.frame.id);

  const r404 = await agent.get('/api/stack/peek/does-not-exist');
  assert.equal(r404.status, 404);
});

test('Stack GET: gelöschter Topic erscheint als (gelöscht)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'x' });
  await agent.delete(`/api/meetings/${meetingId}/topics/${topicId}`);

  const r = await agent.get('/api/stack');
  assert.equal(r.body.frames.length, 1);
  assert.equal(r.body.frames[0].title, '(gelöscht)');
  assert.equal(r.body.frames[0].ref_exists, false);
});
