'use strict';
// End-to-End-Integrationstest für Arbeitspaket B2 ("Server-Integration &
// Schreibschutz" für "Meetings archivieren statt löschen"): archivieren über
// die neue /api/archive/*-API -> verschwindet aus GET /api/meetings ->
// Schreibversuch auf ein Topic des archivierten Meetings liefert 409
// ARCHIVED_READONLY -> wiederherstellen -> wieder normal bearbeitbar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

test('Archiv-Integration: archivieren blendet aus GET /api/meetings aus, sperrt Schreibzugriffe, restore stellt wieder her', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  // Vor dem Archivieren: Meeting ist normal sichtbar und bearbeitbar.
  const before = await agent.get('/api/meetings');
  assert.ok(before.body.some((m) => m.id === meetingId));
  const editBefore = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ title: 'Vor Archiv' });
  assert.equal(editBefore.status, 200);

  // Archivieren über die neue Archiv-API (Paket B1).
  const archiveRes = await agent.post(`/api/archive/meeting/${meetingId}`);
  assert.equal(archiveRes.status, 200);
  assert.equal(archiveRes.body.archived, true);

  // Verschwindet aus der normalen Meetings-Liste.
  const after = await agent.get('/api/meetings');
  assert.ok(!after.body.some((m) => m.id === meetingId), 'archiviertes Meeting darf nicht mehr in GET /api/meetings auftauchen');

  // Bleibt aber über die Archiv-Detailroute erreichbar.
  const detail = await agent.get(`/api/archive/meetings/${meetingId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.archived, true);

  // Schreibversuch auf ein Topic dieses Meetings -> 409 ARCHIVED_READONLY.
  const editAfter = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ title: 'Nach Archiv' });
  assert.equal(editAfter.status, 409);
  assert.equal(editAfter.body.code, 'ARCHIVED_READONLY');

  // Titel wurde NICHT verändert.
  const stillOld = await agent.get(`/api/archive/meetings/${meetingId}`);
  assert.equal(stillOld.body.topics[0].title, 'Vor Archiv');

  // Wiederherstellen.
  const restoreRes = await agent.delete(`/api/archive/meeting/${meetingId}`);
  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.body.archived, false);

  // Wieder in GET /api/meetings sichtbar.
  const afterRestore = await agent.get('/api/meetings');
  assert.ok(afterRestore.body.some((m) => m.id === meetingId));

  // Wieder normal bearbeitbar.
  const editRestored = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ title: 'Nach Restore' });
  assert.equal(editRestored.status, 200);
  const finalState = await agent.get('/api/meetings');
  const topic = finalState.body.find((m) => m.id === meetingId).topics.find((x) => x.id === topicId);
  assert.equal(topic.title, 'Nach Restore');
});

test('Archiv-Integration: DELETE /api/meetings/:id bleibt unveraendert - loescht weiterhin sofort und endgueltig', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);

  const del = await agent.delete(`/api/meetings/${meetingId}`);
  assert.equal(del.status, 200);

  const after = await agent.get('/api/meetings');
  assert.ok(!after.body.some((m) => m.id === meetingId));

  // Kein Archiv-Eintrag - Meeting ist tatsächlich weg, nicht nur archiviert.
  const detail = await agent.get(`/api/archive/meetings/${meetingId}`);
  assert.equal(detail.status, 404);
});
