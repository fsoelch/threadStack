'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

async function setupAdminWithAi(app, db) {
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-XXXX',
    features_enabled: { brief: true, capture: true, result_draft: true },
    max_monthly_cost_cents: 0,    // unbegrenzt für die meisten Tests
    confirm_threshold_cents: 10_000, // hoch genug, damit keine Confirmation nötig ist
  });
  return { admin, agent };
}

test('AI Usage: Brief schreibt einen ai_usage-Eintrag', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithAi(app, db);

  const m = await agent.post('/api/meetings').send({ title: 'Meeting', color: '#6366f1' });
  await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Topic 1' });

  const brief = await agent.post(`/api/ai/meeting/${m.body.id}/brief`);
  assert.equal(brief.status, 200, JSON.stringify(brief.body));
  assert.ok(Array.isArray(brief.body.content.talking_points));

  const usage = await agent.get('/api/ai/usage?period=month');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.entries.length, 1);
  assert.equal(usage.body.entries[0].feature, 'brief');
});

test('AI Usage: Budget blockiert mit 402', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithAi(app, db);
  // Mini-Budget
  await agent.put('/api/ai/settings').send({ max_monthly_cost_cents: 1 });

  const m = await agent.post('/api/meetings').send({ title: 'Meeting', color: '#6366f1' });

  // Erster Aufruf: Budget winzig → schon Schätzung überschreitet ggf. 1 Cent
  const first = await agent.post(`/api/ai/meeting/${m.body.id}/brief`);
  // Entweder 402 (Schätzung > Budget) oder 200 (Schätzung == 0 → durch); danach garantiert 402
  if (first.status === 200) {
    const second = await agent.post(`/api/ai/meeting/${m.body.id}/brief`);
    assert.equal(second.status, 402);
    assert.equal(second.body.code, 'budget_exceeded');
  } else {
    assert.equal(first.status, 402);
  }
});

test('AI Usage: Confirm-Schwelle erzwingt 428', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithAi(app, db);
  await agent.put('/api/ai/settings').send({ confirm_threshold_cents: 1, max_monthly_cost_cents: 0 });

  const m = await agent.post('/api/meetings').send({ title: 'Meeting', color: '#6366f1' });

  const noConfirm = await agent.post(`/api/ai/meeting/${m.body.id}/brief`);
  assert.equal(noConfirm.status, 428);
  assert.equal(noConfirm.body.code, 'confirmation_required');

  const withConfirm = await agent.post(`/api/ai/meeting/${m.body.id}/brief?confirm=true`);
  assert.equal(withConfirm.status, 200);
});
