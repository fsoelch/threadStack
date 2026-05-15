'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function configureMockAi(agent) {
  return agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-XXXX',
    features_enabled: { brief:true, capture:true, result_draft:true, reentry:true, theme_tagging:true, digest:true, cross_meeting:true },
    confirm_threshold_cents: 10_000,
  });
}

test('Weekly Digest: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/ai/digest/weekly');
  assert.equal(r.status, 401);
});

test('Weekly Digest: POST erzeugt, GET liefert cached', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  const r1 = await agent.post('/api/ai/digest/weekly');
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.ok(typeof r1.body.content.summary === 'string');
  assert.equal(r1.body.cached, false);
  assert.ok(r1.body.week.match(/^\d{4}-W\d{2}$/));

  const r2 = await agent.get('/api/ai/digest/weekly');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cached, true);
  assert.equal(r2.body.artifact_id, r1.body.artifact_id);
});

test('Weekly Digest: Archive listet alle generierten', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  await agent.post('/api/ai/digest/weekly');

  const arc = await agent.get('/api/ai/digest/archive');
  assert.equal(arc.status, 200);
  assert.ok(Array.isArray(arc.body.entries));
  assert.equal(arc.body.entries.length, 1);
  assert.ok(arc.body.entries[0].week);
});
