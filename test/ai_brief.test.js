'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('AI Brief: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).post('/api/ai/meeting/does-not-matter/brief');
  assert.equal(r.status, 401);
});

test('AI Brief: 409 ohne konfigurierten Provider', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#6366f1' });
  const r = await agent.post(`/api/ai/meeting/${m.body.id}/brief`);
  assert.equal(r.status, 409);
});

test('AI Brief: liefert strukturierte Antwort und speichert Artefakt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { brief: true },
    confirm_threshold_cents: 10_000,
  });
  const m = await agent.post('/api/meetings').send({ title: 'Wochenstand', color: '#6366f1' });
  await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Roadmap', description: 'Plan Q3' });

  const brief = await agent.post(`/api/ai/meeting/${m.body.id}/brief`);
  assert.equal(brief.status, 200, JSON.stringify(brief.body));
  assert.ok(Array.isArray(brief.body.content.talking_points));
  assert.ok(typeof brief.body.content.history === 'string');
  assert.ok(brief.body.artifact_id);

  const artifact = db.prepare('SELECT * FROM ai_artifacts WHERE id=?').get(brief.body.artifact_id);
  assert.ok(artifact);
  assert.equal(artifact.feature, 'brief');
  assert.equal(artifact.ref_id, m.body.id);
});
