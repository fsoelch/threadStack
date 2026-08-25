'use strict';
// GET /api/search: Suchtreffer für archivierte Meetings/Topics bekommen
// `archived:true` (Themen-Treffer zusätzlich `meetingId`) und werden NICHT
// herausgefiltert (Arbeitspaket B2, "Meetings archivieren statt löschen").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function archiveMeeting(agent, meetingId) {
  const r = await agent.post(`/api/archive/meeting/${meetingId}`).send({ acknowledgeStackConflict: true });
  assert.equal(r.status, 200, `archivieren fehlgeschlagen: ${JSON.stringify(r.body)}`);
}

test('GET /api/search: Meeting-Treffer bekommt archived:true nach dem Archivieren, bleibt auffindbar', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const m = await agent.post('/api/meetings').send({ title: 'Suchbegriff-Budgetplanung-Einzigartig', color: '#4f46e5' });

  const before = await agent.get('/api/search?q=Budgetplanung-Einzigartig');
  assert.equal(before.status, 200);
  const hitBefore = before.body.find((r) => r.type === 'meeting' && r.id === m.body.id);
  assert.ok(hitBefore, 'Meeting muss vor dem Archivieren auffindbar sein');
  assert.equal(hitBefore.archived, false);

  await archiveMeeting(agent, m.body.id);

  const after = await agent.get('/api/search?q=Budgetplanung-Einzigartig');
  assert.equal(after.status, 200);
  const hitAfter = after.body.find((r) => r.type === 'meeting' && r.id === m.body.id);
  assert.ok(hitAfter, 'archiviertes Meeting muss weiterhin auffindbar sein (nicht herausgefiltert)');
  assert.equal(hitAfter.archived, true);
});

test('GET /api/search: Topic-Treffer bekommt meetingId und archived:true, wenn das Eltern-Meeting archiviert ist', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const m = await agent.post('/api/meetings').send({ title: 'Meeting fuer Topic-Suche', color: '#4f46e5' });
  const tp = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Rollout-Strategie-Einzigartig' });

  const before = await agent.get('/api/search?q=Rollout-Strategie-Einzigartig');
  const hitBefore = before.body.find((r) => r.type === 'topic' && r.id === tp.body.id);
  assert.ok(hitBefore);
  assert.equal(hitBefore.meetingId, m.body.id);
  assert.equal(hitBefore.archived, false);

  await archiveMeeting(agent, m.body.id);

  const after = await agent.get('/api/search?q=Rollout-Strategie-Einzigartig');
  const hitAfter = after.body.find((r) => r.type === 'topic' && r.id === tp.body.id);
  assert.ok(hitAfter, 'Topic eines archivierten Meetings muss weiterhin auffindbar sein');
  assert.equal(hitAfter.meetingId, m.body.id);
  assert.equal(hitAfter.archived, true);
});

test('GET /api/search: nicht-archivierbare Treffer (z.B. todo) bekommen archived:false', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  await agent.post('/api/todos').send({ title: 'Einzigartiges-Todo-Suchwort' });
  const r = await agent.get('/api/search?q=Einzigartiges-Todo-Suchwort');
  assert.equal(r.status, 200);
  const hit = r.body.find((x) => x.type === 'todo');
  assert.ok(hit);
  assert.equal(hit.archived, false);
  assert.equal(hit.meetingId, undefined);
});
