'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('Smoke: bestehende Routes funktionieren weiter', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);

  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);

  // GET /api/me
  const me = await agent.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'admin');

  // GET /api/meetings (empty)
  const meetings1 = await agent.get('/api/meetings');
  assert.equal(meetings1.status, 200);
  assert.deepEqual(meetings1.body, []);

  // POST /api/meetings
  const created = await agent.post('/api/meetings').send({ title: 'Test-Meeting', color: '#6366f1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, 'Test-Meeting');
  const meetingId = created.body.id;

  // POST topic
  const topic = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Erstes Thema' });
  assert.equal(topic.status, 201);

  // GET meetings has 1 topic
  const meetings2 = await agent.get('/api/meetings');
  assert.equal(meetings2.body.length, 1);
  assert.equal(meetings2.body[0].topics.length, 1);

  // Logout
  const out = await agent.post('/api/logout');
  assert.equal(out.status, 200);
});
