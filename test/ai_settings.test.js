'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('AI Settings: GET/PUT/DELETE und Key-Maskierung', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  // 401 ohne Login
  const unauth = await request(app).get('/api/ai/settings');
  assert.equal(unauth.status, 401);

  const agent = await login(request, app, admin.username, admin.password);

  // Default-Settings
  const def = await agent.get('/api/ai/settings');
  assert.equal(def.status, 200);
  assert.equal(def.body.provider, '');
  assert.equal(def.body.configured, false);

  // Settings setzen inkl. API-Key
  const put = await agent.put('/api/ai/settings').send({
    provider: 'mock',
    model:    'mock-1',
    api_key:  'sk-test-supersecret-ABCD',
    max_monthly_cost_cents: 500,
    features_enabled: { brief: true, capture: true, result_draft: true },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.provider, 'mock');
  assert.equal(put.body.api_key_last4, 'ABCD');
  // Klartext darf nirgendwo in der Response stehen
  assert.ok(!JSON.stringify(put.body).includes('supersecret'));

  // In DB darf der Klartext auch nicht stehen
  const row = db.prepare('SELECT * FROM ai_settings WHERE user_id=?').get(admin.id);
  assert.ok(row.api_key_encrypted);
  assert.ok(!row.api_key_encrypted.includes('supersecret'));
  assert.equal(row.api_key_last4, 'ABCD');

  // GET liefert wieder Maskierung
  const get2 = await agent.get('/api/ai/settings');
  assert.equal(get2.body.api_key_last4, 'ABCD');
  assert.equal(get2.body.configured, true);

  // DELETE entfernt nur den Key
  const del = await agent.delete('/api/ai/settings/key');
  assert.equal(del.status, 200);
  assert.equal(del.body.api_key_last4, '');
  assert.equal(del.body.provider, 'mock', 'Provider bleibt erhalten');
});

test('AI test: 409 ohne Konfiguration', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);
  const r = await agent.post('/api/ai/test');
  assert.equal(r.status, 409);
});

test('AI test: ok mit Mock-Provider', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-1234',
  });
  const r = await agent.post('/api/ai/test');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});
