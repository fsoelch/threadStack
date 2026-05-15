'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function configureMockAi(agent, extra = {}) {
  return agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-XXXX',
    features_enabled: { brief:true, capture:true, result_draft:true, reentry:true, theme_tagging:true, digest:true, cross_meeting:true },
    confirm_threshold_cents: 10_000,
    ...extra,
  });
}

test('Theme-Tagging: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).post('/api/ai/topic/x/suggest-themes');
  assert.equal(r.status, 401);
});

test('Theme-Tagging: 409 ohne Provider', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);
  const r = await agent.post(`/api/ai/topic/${topicId}/suggest-themes`);
  assert.equal(r.status, 409);
});

test('Theme-Tagging: 404 für fremdes Topic', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);
  const r = await agent.post('/api/ai/topic/does-not-exist/suggest-themes');
  assert.equal(r.status, 404);
});

test('Theme-Tagging: leer wenn keine Themes vorhanden', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);
  const r = await agent.post(`/api/ai/topic/${topicId}/suggest-themes`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.suggestions, []);
});

test('Theme-Tagging: filtert nach Confidence-Schwelle', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  // Create 2 themes
  const t1 = await agent.post('/api/themes').send({ title: 'Strategie' });
  const t2 = await agent.post('/api/themes').send({ title: 'Sonstiges' });

  // Mock returns one match above threshold, one below
  const mock = require('../ai/providers/mock');
  mock.setMockResponse('theme_tagging', {
    matches: [
      { theme_id: t1.body.id, confidence: 0.9 },
      { theme_id: t2.body.id, confidence: 0.4 },  // unter Default 0.7
    ],
  });

  await configureMockAi(agent, { theme_tag_threshold: 0.7 });
  const r = await agent.post(`/api/ai/topic/${topicId}/suggest-themes`);
  assert.equal(r.status, 200);
  assert.equal(r.body.suggestions.length, 1);
  assert.equal(r.body.suggestions[0].theme_id, t1.body.id);
  assert.equal(r.body.suggestions[0].confidence, 0.9);
  assert.equal(r.body.suggestions[0].theme_title, 'Strategie');

  // Cleanup mock fixture for other tests
  mock.setMockResponse('theme_tagging', { matches: [] });
});
