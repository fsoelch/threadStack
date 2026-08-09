'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, cleanup, REPO_ROOT, bootstrapStackFixture } = require('./helpers');

test('Snooze-Validierung: Todo — ungültiges Datum wird abgelehnt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const r = await agent.put(`/api/todos/${todoId}`).send({ snoozedUntil: 'not-a-date' });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
});

test('Snooze-Validierung: Todo — reines Datum wird unverändert gespeichert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const r = await agent.put(`/api/todos/${todoId}`).send({ snoozedUntil: '2030-06-15' });
  assert.equal(r.status, 200);
  const todos = await agent.get('/api/todos');
  assert.equal(todos.body.find(x => x.id === todoId).snoozedUntil, '2030-06-15');
});

test('Snooze-Validierung: Todo — volles ISO-Datetime wird unverändert gespeichert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const until = '2030-06-15T09:30:00.000Z';
  const r = await agent.put(`/api/todos/${todoId}`).send({ snoozedUntil: until });
  assert.equal(r.status, 200);
  const todos = await agent.get('/api/todos');
  assert.equal(todos.body.find(x => x.id === todoId).snoozedUntil, until);
});

test('Snooze-Validierung: Topic — ungültiges Datum wird abgelehnt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const r = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ snoozedUntil: 'kaputt' });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
});

test('Snooze-Validierung: Topic — reines Datum wird unverändert gespeichert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const r = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ snoozedUntil: '2030-07-01' });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT snoozed_until FROM topics WHERE id=?').get(topicId);
  assert.equal(row.snoozed_until, '2030-07-01');
});

test('Snooze-Validierung: Topic — volles ISO-Datetime wird unverändert gespeichert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const until = '2030-07-01T14:00:00.000Z';
  const r = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ snoozedUntil: until });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT snoozed_until FROM topics WHERE id=?').get(topicId);
  assert.equal(row.snoozed_until, until);
});
