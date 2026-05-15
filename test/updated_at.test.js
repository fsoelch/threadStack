'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('updated_at: migration läuft idempotent, Spalten vorhanden', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));

  const cols = db.prepare('PRAGMA table_info(topics)').all().map(c => c.name);
  assert.ok(cols.includes('updated_at'));

  const cols2 = db.prepare('PRAGMA table_info(todos)').all().map(c => c.name);
  assert.ok(cols2.includes('updated_at'));
});

test('updated_at: PUT topic setzt updated_at, created_at unverändert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const before = db.prepare('SELECT created_at, updated_at FROM topics WHERE id=?').get(topicId);
  await new Promise(r => setTimeout(r, 30));
  const r = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ title: 'Topic-1 edited' });
  assert.equal(r.status, 200);

  const after = db.prepare('SELECT created_at, updated_at FROM topics WHERE id=?').get(topicId);
  assert.equal(after.created_at, before.created_at, 'created_at darf nicht geändert werden');
  assert.notEqual(after.updated_at, before.updated_at, 'updated_at muss aktualisiert sein');
  assert.ok(after.updated_at > before.updated_at, 'updated_at muss neuer sein');
});

test('updated_at: PUT todo setzt updated_at', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const before = db.prepare('SELECT created_at, updated_at FROM todos WHERE id=?').get(todoId);
  await new Promise(r => setTimeout(r, 30));
  await agent.put(`/api/todos/${todoId}`).send({ title: 'Todo-1 edited' });
  const after = db.prepare('SELECT created_at, updated_at FROM todos WHERE id=?').get(todoId);
  assert.ok(after.updated_at > before.updated_at);
});
