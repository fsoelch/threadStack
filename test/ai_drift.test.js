'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Drift: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/ai/insights/drift');
  assert.equal(r.status, 401);
});

test('Drift: leeres Result für frisch angelegtes Topic', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const r = await agent.get('/api/ai/insights/drift');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.drifted, []);
  assert.equal(r.body.drift_days, 21);
});

test('Drift: Topic >21d ohne Edit wird als drifted markiert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  // Manuell created_at und updated_at auf 30 Tage zurück setzen
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE topics SET created_at=?, updated_at=? WHERE id=?').run(past, past, topicId);

  const r = await agent.get('/api/ai/insights/drift');
  assert.equal(r.status, 200);
  assert.equal(r.body.drifted.length, 1);
  assert.equal(r.body.drifted[0].topic_id, topicId);
  assert.equal(r.body.drifted[0].meeting_id, meetingId);
  assert.ok(r.body.drifted[0].days_idle >= 29);
});

test('Drift: erledigtes Topic taucht NICHT auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE topics SET created_at=?, updated_at=?, done=1 WHERE id=?').run(past, past, topicId);

  const r = await agent.get('/api/ai/insights/drift');
  assert.deepEqual(r.body.drifted, []);
});

test('Drift: aktiv gesnoozed schützt vor Drift', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const past   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() +  7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE topics SET created_at=?, updated_at=?, snoozed_until=? WHERE id=?').run(past, past, future, topicId);

  const r = await agent.get('/api/ai/insights/drift');
  assert.deepEqual(r.body.drifted, []);
});

test('Drift: offenes Stack-Frame schützt vor Drift', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  // Topic alt machen
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE topics SET created_at=?, updated_at=? WHERE id=?').run(past, past, topicId);

  // Frame heute pushen → schützt
  await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'note' });

  const r = await agent.get('/api/ai/insights/drift');
  assert.deepEqual(r.body.drifted, []);
});

test('Drift: konfigurierbare drift_days', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE topics SET created_at=?, updated_at=? WHERE id=?').run(past, past, topicId);

  // Default 21 → nicht drifted
  const r1 = await agent.get('/api/ai/insights/drift');
  assert.equal(r1.body.drifted.length, 0);

  // drift_days=7 → drifted
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'k', drift_days: 7,
  });
  const r2 = await agent.get('/api/ai/insights/drift');
  assert.equal(r2.body.drifted.length, 1);
  assert.equal(r2.body.drift_days, 7);
});
