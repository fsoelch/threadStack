'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('AI Result-Draft: liefert Vorschlagstext (Mock) und speichert nicht automatisch', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { result_draft: true }, confirm_threshold_cents: 10_000,
  });
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#6366f1' });
  const t1 = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Thema A', description: 'Wichtig.' });

  const r = await agent.post(`/api/ai/topic/${t1.body.id}/result-draft`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(typeof r.body.draft === 'string' && r.body.draft.length > 0);

  // Topic darf NICHT auf done sein
  const meetings = await agent.get('/api/meetings');
  const topic = meetings.body[0].topics[0];
  assert.equal(topic.done, false);
  assert.equal(topic.result, '');
});

test('AI Result-Draft: 404 bei fremdem Topic', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { result_draft: true }, confirm_threshold_cents: 10_000,
  });
  const r = await agent.post('/api/ai/topic/does-not-exist/result-draft');
  assert.equal(r.status, 404);
});
