'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Stack History: liefert nur geschlossene Frames', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId, todoId } = await bootstrapStackFixture(request, app, db);

  const f1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'a' });
  const f2 = await agent.post('/api/stack/push').send({ refType: 'todo',  refId: todoId,  nextStepNote: 'b' });

  await agent.post(`/api/stack/pop/${f2.body.frame.id}`).send({ resolution: 'dropped' });

  const r = await agent.get('/api/stack/history');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.frames[0].id, f2.body.frame.id);
  assert.equal(r.body.frames[0].pop_resolution, 'dropped');

  // Frame 1 is still open → not in history
  const open = await agent.get('/api/stack');
  assert.equal(open.body.frames.length, 1);
  assert.equal(open.body.frames[0].id, f1.body.frame.id);
});

test('Stack History: Resolution-Filter', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);

  // 3 topics → 3 frames → pop with different resolutions
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const t = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'T' + i });
    ids.push(t.body.id);
  }
  const frames = [];
  for (const tid of ids) {
    const f = await agent.post('/api/stack/push').send({ refType: 'topic', refId: tid, nextStepNote: 'n' });
    frames.push(f.body.frame.id);
  }
  // Pop them in reverse with different resolutions
  await agent.post(`/api/stack/pop/${frames[2]}`).send({ resolution: 'done' });
  await agent.post(`/api/stack/pop/${frames[1]}`).send({ resolution: 'dropped' });
  await agent.post(`/api/stack/pop/${frames[0]}`).send({ resolution: 'dropped' });

  const rDone = await agent.get('/api/stack/history?resolution=done');
  assert.equal(rDone.body.count, 1);
  assert.equal(rDone.body.frames[0].pop_resolution, 'done');

  const rDropped = await agent.get('/api/stack/history?resolution=dropped');
  assert.equal(rDropped.body.count, 2);
});
