'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Stack Push: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).post('/api/stack/push').send({});
  assert.equal(r.status, 401);
});

test('Stack Push: 400 ohne next_step_note', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const r = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: '' });
  assert.equal(r.status, 400);
});

test('Stack Push: 400 ohne refType / 400 bei ungültigem refType', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const r1 = await agent.post('/api/stack/push').send({ refId: topicId, nextStepNote: 'x' });
  assert.equal(r1.status, 400);

  const r2 = await agent.post('/api/stack/push').send({ refType: 'invalid', refId: topicId, nextStepNote: 'x' });
  assert.equal(r2.status, 400);
});

test('Stack Push: 404 bei fremder Referenz', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const r = await agent.post('/api/stack/push').send({ refType: 'topic', refId: 'does-not-exist', nextStepNote: 'x' });
  assert.equal(r.status, 404);
});

test('Stack Push: 201 normal, parent_frame_id chain stimmt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId, todoId } = await bootstrapStackFixture(request, app, db);

  // 1. push: parent=null
  const r1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'arbeite am Topic' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.frame.parent_frame_id, null);
  assert.equal(r1.body.depth, 1);
  assert.equal(r1.body.depth_warning, false);

  // 2. push: parent=Frame1
  const r2 = await agent.post('/api/stack/push').send({ refType: 'todo', refId: todoId, nextStepNote: 'kurz dazwischen' });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.frame.parent_frame_id, r1.body.frame.id);
  assert.equal(r2.body.depth, 2);

  // GET liefert aktives zuerst (Frame2)
  const g = await agent.get('/api/stack');
  assert.equal(g.body.depth, 2);
  assert.equal(g.body.frames[0].id, r2.body.frame.id);
  assert.equal(g.body.frames[1].id, r1.body.frame.id);
});

test('Stack Push: 409 wenn Referenz schon in offenem Frame', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const r1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'a' });
  assert.equal(r1.status, 201);

  const r2 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'b' });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'conflict_existing');
  assert.equal(r2.body.frame_id, r1.body.frame.id);
});

test('Stack Push: depth_warning ab Tiefe 4', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);

  // 4 topics anlegen und alle pushen
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const t = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'T' + i });
    ids.push(t.body.id);
  }
  for (let i = 0; i < 3; i++) {
    const r = await agent.post('/api/stack/push').send({ refType: 'topic', refId: ids[i], nextStepNote: 'n' + i });
    assert.equal(r.body.depth_warning, false, `push ${i} should not warn`);
  }
  const r4 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: ids[3], nextStepNote: 'n3' });
  assert.equal(r4.body.depth, 4);
  assert.equal(r4.body.depth_warning, true);
});
