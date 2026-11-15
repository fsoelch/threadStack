'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, cleanup, ensureTestAdmin, login, REPO_ROOT } = require('./helpers');

test('GET /api/sync/capabilities: 401 ohne Login, 200 mit Vertragsinhalt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const anon = await request(app).get('/api/sync/capabilities');
  assert.equal(anon.status, 401);
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const res = await agent.get('/api/sync/capabilities');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { idempotentCreate: { version: 1, refTypes: ['todo', 'topic'] }, capturedAt: true });
});
