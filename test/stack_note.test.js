'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Stack Note: PUT updated, 400 bei leerem Note, 404 nach Pop', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const f = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'initial' });
  const fid = f.body.frame.id;

  // Empty note → 400
  const r400 = await agent.put(`/api/stack/${fid}/note`).send({ nextStepNote: '' });
  assert.equal(r400.status, 400);

  // Valid update
  const r = await agent.put(`/api/stack/${fid}/note`).send({ nextStepNote: 'aktualisiert' });
  assert.equal(r.status, 200);

  const peek = await agent.get(`/api/stack/peek/${fid}`);
  assert.equal(peek.body.frame.next_step_note, 'aktualisiert');

  // After pop → 404
  await agent.post(`/api/stack/pop/${fid}`).send({ resolution: 'dropped' });
  const r404 = await agent.put(`/api/stack/${fid}/note`).send({ nextStepNote: 'no' });
  assert.equal(r404.status, 404);
});

test('Stack Note: zu langer Text → 400', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const f = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'ok' });
  const tooLong = 'x'.repeat(1001);
  const r = await agent.put(`/api/stack/${f.body.frame.id}/note`).send({ nextStepNote: tooLong });
  assert.equal(r.status, 400);
});
