'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('AI Reentry: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).post('/api/ai/stack/no-such/reentry');
  assert.equal(r.status, 401);
});

test('AI Reentry: 409 ohne konfigurierten Provider', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const f = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'note' });
  const r = await agent.post(`/api/ai/stack/${f.body.frame.id}/reentry`);
  assert.equal(r.status, 409);
});

test('AI Reentry: 200 mit Mock-Provider', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { reentry: true },
    confirm_threshold_cents: 10_000,
  });

  const f = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'note' });
  const fid = f.body.frame.id;

  const r = await agent.post(`/api/ai/stack/${fid}/reentry`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(typeof r.body.content.summary === 'string' && r.body.content.summary.length > 0);
  assert.ok(r.body.artifact_id);

  // Artifact gespeichert
  const artifact = db.prepare('SELECT * FROM ai_artifacts WHERE id=?').get(r.body.artifact_id);
  assert.ok(artifact);
  assert.equal(artifact.feature, 'reentry');
  assert.equal(artifact.ref_type, 'frame');
  assert.equal(artifact.ref_id, fid);
});

test('AI Reentry: 404 bei unbekanntem Frame', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { reentry: true }, confirm_threshold_cents: 10_000,
  });
  const r = await agent.post('/api/ai/stack/does-not-exist/reentry');
  assert.equal(r.status, 404);
});
