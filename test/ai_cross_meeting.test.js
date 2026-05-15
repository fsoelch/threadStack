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

test('Cross-Meeting-Insight: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/ai/insights/cross-meeting/x');
  assert.equal(r.status, 401);
});

test('Cross-Meeting-Insight: GET leer initial', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);
  const r = await agent.get(`/api/ai/insights/cross-meeting/${meetingId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.content.matches, []);
});

test('Cross-Meeting-Insight: POST liefert leer wenn kein anderes Meeting', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);
  const r = await agent.post(`/api/ai/insights/cross-meeting/${meetingId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.content.matches, []);
});

test('Cross-Meeting-Insight: POST + GET + DELETE Zyklus', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  // Zweites Meeting + Topic, damit Cross-Meeting-Daten existieren
  const m2 = await agent.post('/api/meetings').send({ title: 'Meeting B', color: '#ef4444' });
  const t2 = await agent.post(`/api/meetings/${m2.body.id}/topics`).send({ title: 'Topic-B-1' });

  await configureMockAi(agent);

  const mock = require('../ai/providers/mock');
  mock.setMockResponse('cross_meeting', {
    matches: [
      { this_topic_id: topicId, other_topic_id: t2.body.id, confidence: 0.82, reason: 'beide befassen sich mit X' },
    ],
  });

  const post = await agent.post(`/api/ai/insights/cross-meeting/${meetingId}`);
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.equal(post.body.content.matches.length, 1);
  assert.equal(post.body.content.matches[0].other_meeting, 'Meeting B');
  assert.equal(post.body.content.matches[0].other_topic_title, 'Topic-B-1');

  const get = await agent.get(`/api/ai/insights/cross-meeting/${meetingId}`);
  assert.equal(get.body.content.matches.length, 1);
  assert.equal(get.body.artifact_id, post.body.artifact_id);

  const del = await agent.delete(`/api/ai/insights/cross-meeting/${meetingId}/${post.body.artifact_id}`);
  assert.equal(del.status, 200);

  const get2 = await agent.get(`/api/ai/insights/cross-meeting/${meetingId}`);
  assert.deepEqual(get2.body.content.matches, []);

  mock.setMockResponse('cross_meeting', { matches: [] });
});
