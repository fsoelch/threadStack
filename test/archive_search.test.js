'use strict';
// GET /api/search: Suchtreffer für archivierte Meetings/Topics bekommen
// `archived:true` (Themen-Treffer zusätzlich `meetingId`) und werden NICHT
// herausgefiltert (Arbeitspaket B2, "Meetings archivieren statt löschen").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');
const { listArchivedMeetings } = require('../lib/archive/queries');

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

test('GET /api/archive/meetings?q=...: Suchbegriffe, die der FTS5-Parser ablehnt (Sonderzeichen/reine Negativterme), liefern {items:[],total:0} statt 500', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  // Mindestens ein archiviertes Meeting muss existieren, damit die Route
  // wirklich bis zur MATCH-Abfrage in listArchivedMeetings kommt.
  const m = await agent.post('/api/meetings').send({ title: 'Fund-3-Suchtest', color: '#4f46e5' });
  const arch = await agent.post(`/api/archive/meeting/${m.body.id}`).send({ acknowledgeStackConflict: true });
  assert.equal(arch.status, 200);

  // Analog zum bestehenden Muster in test/knowledge_search.test.js
  // ("Sonderzeichen/Operatoren fuehren nie zu 500") plus explizit reine
  // Negativterme, wie im Security-Review-Fund beschrieben.
  const weird = ['"', '"" AND', 'foo OR', '---', 'NOT NOT', '((()))', 'a"b"c', '*', 'foo NEAR bar', '-nurNegativ'];
  for (const q of weird) {
    const r = await agent.get('/api/archive/meetings').query({ q });
    assert.equal(r.status, 200, `q=${JSON.stringify(q)} sollte nie 500 liefern`);
    assert.deepEqual(r.body.items, [], `q=${JSON.stringify(q)} sollte kein Treffer liefern`);
    assert.equal(r.body.total, 0);
  }
});

test('GET /api/archive/meetings?q=...: gueltiger Suchbegriff trifft weiterhin (LIMIT aendert normales Verhalten nicht)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const m = await agent.post('/api/meetings').send({ title: 'Einzigartiger-Archivsuchtreffer-XYZ', color: '#4f46e5' });
  await agent.post(`/api/archive/meeting/${m.body.id}`).send({ acknowledgeStackConflict: true });

  const r = await agent.get('/api/archive/meetings').query({ q: 'Einzigartiger-Archivsuchtreffer-XYZ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.items[0].id, m.body.id);
});

test('listArchivedMeetings: faengt einen vom FTS5-Parser abgelehnten q-Wert ab (Defense-in-Depth) statt zu werfen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { admin } = await bootstrapStackFixture(request, app, db);

  // listArchivedMeetings() geht laut Vertrag von einer bereits über
  // buildFtsQuery() aufbereiteten Zeichenkette aus (siehe Kommentar in
  // queries.js) - dieser Test übergibt bewusst eine für den Aufrufer
  // "von außen" untypische, syntaktisch ungültige FTS5-Zeichenkette
  // (unbalancierte Anführungszeichen), um die zusätzliche Absicherung in
  // queries.js selbst (statt nur in routes.js) zu verifizieren.
  const result = listArchivedMeetings(db, admin.id, { q: '"unclosed-phrase' });
  assert.deepEqual(result, { rows: [], total: 0 });
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
