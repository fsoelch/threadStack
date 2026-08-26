'use strict';
// Route-für-Route-Abdeckung des Schreibschutz-Guards ARCHIVED_READONLY
// (Arbeitspaket B2, "Meetings archivieren statt löschen"): jede Route aus
// der Guard-Tabelle des Architektur-Auftrags bekommt einen negativen Test
// (409 bei archiviert) UND einen positiven Test (normale Antwort bei nicht
// archiviert). Anhang-Lesezugriffe bleiben ausdrücklich ohne Guard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function makeMeetingWithTopic(agent, title = 'Meeting') {
  const m = await agent.post('/api/meetings').send({ title, color: '#4f46e5' });
  const t = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Topic' });
  return { meetingId: m.body.id, topicId: t.body.id };
}

async function archiveMeeting(agent, meetingId) {
  // acknowledgeStackConflict: true, da einige Guard-Tests bewusst offene
  // Stack-Frames auf dem zu archivierenden Meeting anlegen (Pop-Guard-Tests) -
  // das Archivieren selbst ist nicht Gegenstand dieser Tests (das ist Paket
  // B1, siehe test/archive_routes.test.js), daher hier immer bestätigt.
  const r = await agent.post(`/api/archive/meeting/${meetingId}`).send({ acknowledgeStackConflict: true });
  assert.equal(r.status, 200, `archivieren fehlgeschlagen: ${JSON.stringify(r.body)}`);
}

function assertArchivedReadOnly(r) {
  assert.equal(r.status, 409, `erwartet 409, bekam ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'ARCHIVED_READONLY');
}

// ── PUT /api/meetings/:id ─────────────────────────────────────

test('Guard PUT /api/meetings/:id: 409 wenn archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const { meetingId } = await makeMeetingWithTopic(agent);

  const okBefore = await agent.put(`/api/meetings/${meetingId}`).send({ title: 'Neu' });
  assert.equal(okBefore.status, 200);

  await archiveMeeting(agent, meetingId);
  const blocked = await agent.put(`/api/meetings/${meetingId}`).send({ title: 'Blockiert' });
  assertArchivedReadOnly(blocked);
});

// ── POST /api/meetings/:id/topics ─────────────────────────────

test('Guard POST /api/meetings/:id/topics: 409 wenn archiviert, 201 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const { meetingId } = await makeMeetingWithTopic(agent);

  const okBefore = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Weiteres Thema' });
  assert.equal(okBefore.status, 201);

  await archiveMeeting(agent, meetingId);
  const blocked = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Blockiert' });
  assertArchivedReadOnly(blocked);
});

// ── PUT /api/meetings/:id/topics/reorder ──────────────────────

test('Guard PUT /api/meetings/:id/topics/reorder: 409 wenn archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const { meetingId, topicId } = await makeMeetingWithTopic(agent);

  const okBefore = await agent.put(`/api/meetings/${meetingId}/topics/reorder`).send({ ids: [topicId] });
  assert.equal(okBefore.status, 200);

  await archiveMeeting(agent, meetingId);
  const blocked = await agent.put(`/api/meetings/${meetingId}/topics/reorder`).send({ ids: [topicId] });
  assertArchivedReadOnly(blocked);
});

// ── PUT /api/meetings/:id/topics/:tid ─────────────────────────

test('Guard PUT /api/meetings/:id/topics/:tid: 409 wenn archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const { meetingId, topicId } = await makeMeetingWithTopic(agent);

  const okBefore = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ title: 'Vor Archiv' });
  assert.equal(okBefore.status, 200);

  await archiveMeeting(agent, meetingId);
  const blocked = await agent.put(`/api/meetings/${meetingId}/topics/${topicId}`).send({ title: 'Blockiert' });
  assertArchivedReadOnly(blocked);
});

// ── DELETE /api/meetings/:id/topics/:tid ──────────────────────

test('Guard DELETE /api/meetings/:id/topics/:tid: 409 wenn archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  // Positiv: eigenes, nicht archiviertes Meeting.
  const okFixture = await makeMeetingWithTopic(agent, 'Loeschbar');
  const okDelete = await agent.delete(`/api/meetings/${okFixture.meetingId}/topics/${okFixture.topicId}`);
  assert.equal(okDelete.status, 200);

  // Negativ: archiviertes Meeting.
  const { meetingId, topicId } = await makeMeetingWithTopic(agent, 'Archiviert');
  await archiveMeeting(agent, meetingId);
  const blocked = await agent.delete(`/api/meetings/${meetingId}/topics/${topicId}`);
  assertArchivedReadOnly(blocked);
});

// ── POST /api/meetings/:id/topics/:tid/share ──────────────────

test('Guard Share: 409 wenn Quelle archiviert, 404 wenn Ziel archiviert, 201 wenn beides aktiv', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  // Positiv.
  const src1 = await makeMeetingWithTopic(agent, 'Quelle-OK');
  const tgt1 = await makeMeetingWithTopic(agent, 'Ziel-OK');
  const okShare = await agent
    .post(`/api/meetings/${src1.meetingId}/topics/${src1.topicId}/share`)
    .send({ targetMeetingId: tgt1.meetingId });
  assert.equal(okShare.status, 201);

  // Negativ: Quelle archiviert -> 409.
  const src2 = await makeMeetingWithTopic(agent, 'Quelle-Archiviert');
  const tgt2 = await makeMeetingWithTopic(agent, 'Ziel-OK-2');
  await archiveMeeting(agent, src2.meetingId);
  const blockedSource = await agent
    .post(`/api/meetings/${src2.meetingId}/topics/${src2.topicId}/share`)
    .send({ targetMeetingId: tgt2.meetingId });
  assertArchivedReadOnly(blockedSource);

  // Negativ: Ziel archiviert -> 404 (kein 409, Ziel ist nicht der aktuelle Kontext).
  const src3 = await makeMeetingWithTopic(agent, 'Quelle-OK-3');
  const tgt3 = await makeMeetingWithTopic(agent, 'Ziel-Archiviert');
  await archiveMeeting(agent, tgt3.meetingId);
  const blockedTarget = await agent
    .post(`/api/meetings/${src3.meetingId}/topics/${src3.topicId}/share`)
    .send({ targetMeetingId: tgt3.meetingId });
  assert.equal(blockedTarget.status, 404);
  assert.equal(blockedTarget.body.error, 'Ziel-Meeting nicht gefunden');
});

// ── POST /api/meetings/:id/topics/:tid/move ───────────────────

test('Guard Move (zu anderem Meeting): 409 wenn Quelle archiviert, 404 wenn Ziel archiviert, 200 wenn beides aktiv', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const src1 = await makeMeetingWithTopic(agent, 'Quelle-OK');
  const tgt1 = await makeMeetingWithTopic(agent, 'Ziel-OK');
  const okMove = await agent
    .post(`/api/meetings/${src1.meetingId}/topics/${src1.topicId}/move`)
    .send({ targetMeetingId: tgt1.meetingId });
  assert.equal(okMove.status, 200);

  const src2 = await makeMeetingWithTopic(agent, 'Quelle-Archiviert');
  const tgt2 = await makeMeetingWithTopic(agent, 'Ziel-OK-2');
  await archiveMeeting(agent, src2.meetingId);
  const blockedSource = await agent
    .post(`/api/meetings/${src2.meetingId}/topics/${src2.topicId}/move`)
    .send({ targetMeetingId: tgt2.meetingId });
  assertArchivedReadOnly(blockedSource);

  const src3 = await makeMeetingWithTopic(agent, 'Quelle-OK-3');
  const tgt3 = await makeMeetingWithTopic(agent, 'Ziel-Archiviert');
  await archiveMeeting(agent, tgt3.meetingId);
  const blockedTarget = await agent
    .post(`/api/meetings/${src3.meetingId}/topics/${src3.topicId}/move`)
    .send({ targetMeetingId: tgt3.meetingId });
  assert.equal(blockedTarget.status, 404);
  assert.equal(blockedTarget.body.error, 'Ziel-Meeting nicht gefunden');
});

test('Guard Move (in persönliches Todo umwandeln): 409 wenn Quelle archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const src1 = await makeMeetingWithTopic(agent, 'Quelle-OK');
  const okConvert = await agent.post(`/api/meetings/${src1.meetingId}/topics/${src1.topicId}/move`).send({});
  assert.equal(okConvert.status, 200);
  assert.equal(okConvert.body.targetType, 'todo');

  const src2 = await makeMeetingWithTopic(agent, 'Quelle-Archiviert');
  await archiveMeeting(agent, src2.meetingId);
  const blocked = await agent.post(`/api/meetings/${src2.meetingId}/topics/${src2.topicId}/move`).send({});
  assertArchivedReadOnly(blocked);
});

// ── POST /api/todos/:id/move (Ziel-Meeting-Guard) ─────────────

test('Guard Todo->Meeting move: 404 wenn Ziel-Meeting archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const tgt1 = await agent.post('/api/meetings').send({ title: 'Ziel-OK', color: '#4f46e5' });
  const todo1 = await agent.post('/api/todos').send({ title: 'Todo-OK' });
  const okMove = await agent.post(`/api/todos/${todo1.body.id}/move`).send({ targetMeetingId: tgt1.body.id });
  assert.equal(okMove.status, 200);

  const tgt2 = await agent.post('/api/meetings').send({ title: 'Ziel-Archiviert', color: '#4f46e5' });
  await archiveMeeting(agent, tgt2.body.id);
  const todo2 = await agent.post('/api/todos').send({ title: 'Todo-Blockiert' });
  const blocked = await agent.post(`/api/todos/${todo2.body.id}/move`).send({ targetMeetingId: tgt2.body.id });
  assert.equal(blocked.status, 404);
  assert.equal(blocked.body.error, 'Meeting nicht gefunden');
});

// ── Theme-Links (ref_type='topic') ────────────────────────────

test('Guard Theme-Links hinzufuegen: 409 wenn Topic archiviert, 201 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const theme = await agent.post('/api/themes').send({ title: 'Thema' });

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const okLink = await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'topic', refId: t1.topicId });
  assert.equal(okLink.status, 201);

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'topic', refId: t2.topicId });
  assertArchivedReadOnly(blocked);
});

test('Guard Theme-Links entfernen: 409 wenn Topic archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const theme = await agent.post('/api/themes').send({ title: 'Thema' });

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const link1 = await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'topic', refId: t1.topicId });
  const okDelete = await agent.delete(`/api/themes/${theme.body.id}/links/${link1.body.id}`);
  assert.equal(okDelete.status, 200);

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  const link2 = await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'topic', refId: t2.topicId });
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent.delete(`/api/themes/${theme.body.id}/links/${link2.body.id}`);
  assertArchivedReadOnly(blocked);

  // Unbekannte link-ID bleibt idempotent (kein Guard, kein 409) - Verhalten
  // vor dieser Änderung bleibt für diesen Fall unverändert.
  const okNoop = await agent.delete(`/api/themes/${theme.body.id}/links/does-not-exist`);
  assert.equal(okNoop.status, 200);
});

// ── Attachments ────────────────────────────────────────────────

test('Guard Attachment-Upload: 409 wenn Topic archiviert, 201 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const okUpload = await agent
    .post(`/api/attachments/topic/${t1.topicId}?filename=a.txt`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('hallo'));
  assert.equal(okUpload.status, 201);

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent
    .post(`/api/attachments/topic/${t2.topicId}?filename=b.txt`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('hallo'));
  assertArchivedReadOnly(blocked);
});

test('Guard Attachment-Loeschen: 409 wenn Topic archiviert, 200 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const up1 = await agent
    .post(`/api/attachments/topic/${t1.topicId}?filename=a.txt`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('hallo'));
  const okDelete = await agent.delete(`/api/attachments/${up1.body.id}`);
  assert.equal(okDelete.status, 200);

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  const up2 = await agent
    .post(`/api/attachments/topic/${t2.topicId}?filename=b.txt`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('hallo'));
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent.delete(`/api/attachments/${up2.body.id}`);
  assertArchivedReadOnly(blocked);
});

test('Attachment-Lesen/Download: bleibt erlaubt, auch wenn das Topic archiviert ist', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const { meetingId, topicId } = await makeMeetingWithTopic(agent, 'Archiviert');
  const up = await agent
    .post(`/api/attachments/topic/${topicId}?filename=c.txt`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('hallo'));
  assert.equal(up.status, 201);
  await archiveMeeting(agent, meetingId);

  const list = await agent.get(`/api/attachments/topic/${topicId}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);

  const download = await agent.get(`/api/attachments/download/${up.body.id}`);
  assert.equal(download.status, 200);
});

// ── Stack Push ─────────────────────────────────────────────────

test('Guard Stack Push: 409 wenn Topic archiviert, 201 wenn nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const okPush = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t1.topicId, nextStepNote: 'x' });
  assert.equal(okPush.status, 201);

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t2.topicId, nextStepNote: 'x' });
  assertArchivedReadOnly(blocked);
});

// ── PUT /api/stack/:frameId/note (Security-Review-Fund 1) ─────

test('Guard Stack-Notiz (PUT /api/stack/:frameId/note): 409 wenn Topic archiviert, progress_meta.next_step bleibt unveraendert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  // Positiv: nicht archiviertes Topic -> 200, Notiz wird uebernommen und
  // spiegelt sich nach progress_meta.next_step.
  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const push1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t1.topicId, nextStepNote: 'initial' });
  const okNote = await agent.put(`/api/stack/${push1.body.frame.id}/note`).send({ nextStepNote: 'aktualisiert' });
  assert.equal(okNote.status, 200);
  const progressAfterOk = await agent.get(`/api/progress/topic/${t1.topicId}`);
  assert.equal(progressAfterOk.body.nextStep, 'aktualisiert');

  // Negativ: Topic pushen, zugehoeriges Meeting archivieren (Frame bleibt
  // dabei offen), dann versuchen, die Notiz zu aendern -> 409
  // ARCHIVED_READONLY statt stillem Schreiben.
  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  const push2 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t2.topicId, nextStepNote: 'vor-archiv' });
  await archiveMeeting(agent, t2.meetingId);

  const blocked = await agent.put(`/api/stack/${push2.body.frame.id}/note`).send({ nextStepNote: 'sollte-nicht-ankommen' });
  assertArchivedReadOnly(blocked);

  // stack_frames.next_step_note bleibt unveraendert.
  const peek = await agent.get(`/api/stack/peek/${push2.body.frame.id}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.body.frame.next_step_note, 'vor-archiv');

  // progress_meta.next_step bleibt ebenfalls unveraendert (kein Bypass ueber
  // diese Route).
  const progressAfterBlocked = await agent.get(`/api/progress/topic/${t2.topicId}`);
  assert.equal(progressAfterBlocked.status, 200);
  assert.equal(progressAfterBlocked.body.nextStep, 'vor-archiv');
});

test('Guard Stack-Notiz: 404 bei unbekanntem/fremdem Frame bleibt unveraendert (kein 409 vor Ownership-Pruefung)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const r = await agent.put('/api/stack/does-not-exist/note').send({ nextStepNote: 'x' });
  assert.equal(r.status, 404);
});

// ── Stack Pop: 'done'/'snoozed' blockiert, 'dropped'/'resumed' erlaubt ──

test("Guard Stack Pop: resolution='done' auf archiviertem Topic -> 409, auf aktivem -> 200", async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const push1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t1.topicId, nextStepNote: 'x' });
  const okPop = await agent.post(`/api/stack/pop/${push1.body.frame.id}`).send({ resolution: 'done' });
  assert.equal(okPop.status, 200);
  assert.equal(okPop.body.applied.topicDone, true);

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  const push2 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t2.topicId, nextStepNote: 'x' });
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent.post(`/api/stack/pop/${push2.body.frame.id}`).send({ resolution: 'done' });
  assertArchivedReadOnly(blocked);
});

test("Guard Stack Pop: resolution='snoozed' auf archiviertem Topic -> 409, auf aktivem -> 200", async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const push1 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t1.topicId, nextStepNote: 'x' });
  const okPop = await agent
    .post(`/api/stack/pop/${push1.body.frame.id}`)
    .send({ resolution: 'snoozed', snoozedUntil: '2030-01-01T09:00:00.000Z' });
  assert.equal(okPop.status, 200);
  assert.equal(okPop.body.applied.snoozedUntil, '2030-01-01T09:00:00.000Z');

  const t2 = await makeMeetingWithTopic(agent, 'Archiviert');
  const push2 = await agent.post('/api/stack/push').send({ refType: 'topic', refId: t2.topicId, nextStepNote: 'x' });
  await archiveMeeting(agent, t2.meetingId);
  const blocked = await agent
    .post(`/api/stack/pop/${push2.body.frame.id}`)
    .send({ resolution: 'snoozed', snoozedUntil: '2030-01-01T09:00:00.000Z' });
  assertArchivedReadOnly(blocked);

  // Frame bleibt offen, da der Pop-Versuch blockiert wurde.
  const peek = await agent.get(`/api/stack/peek/${push2.body.frame.id}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.body.frame.popped_at, null);
});

test("Guard Stack Pop: resolution='dropped' bleibt erlaubt, auch wenn das Topic archiviert ist", async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const { meetingId, topicId } = await makeMeetingWithTopic(agent, 'Archiviert');
  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'x' });
  await archiveMeeting(agent, meetingId);

  const r = await agent.post(`/api/stack/pop/${push.body.frame.id}`).send({ resolution: 'dropped' });
  assert.equal(r.status, 200);
});

test("Guard Stack Pop: resolution='resumed' bleibt erlaubt, auch wenn das Topic archiviert ist", async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const { meetingId, topicId } = await makeMeetingWithTopic(agent, 'Archiviert');
  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'x' });
  await archiveMeeting(agent, meetingId);

  const r = await agent.post(`/api/stack/pop/${push.body.frame.id}`).send({ resolution: 'resumed' });
  assert.equal(r.status, 200);
  // Frame bleibt offen (resumed schließt den Frame nicht).
  const peek = await agent.get(`/api/stack/peek/${push.body.frame.id}`);
  assert.equal(peek.body.frame.popped_at, null);
});

// ── GET /api/stack: archived-Flag pro Frame ───────────────────

test('GET /api/stack: archived=true für Frames auf archivierten Topics, sonst false', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const t1 = await makeMeetingWithTopic(agent, 'OK');
  const t2 = await makeMeetingWithTopic(agent, 'Wird archiviert');
  await agent.post('/api/stack/push').send({ refType: 'topic', refId: t1.topicId, nextStepNote: 'a' });
  await agent.post('/api/stack/push').send({ refType: 'topic', refId: t2.topicId, nextStepNote: 'b' });
  await archiveMeeting(agent, t2.meetingId);

  const r = await agent.get('/api/stack');
  assert.equal(r.status, 200);
  const f1 = r.body.frames.find((f) => f.ref_id === t1.topicId);
  const f2 = r.body.frames.find((f) => f.ref_id === t2.topicId);
  assert.equal(f1.archived, false);
  assert.equal(f2.archived, true);
});

// ── GET /api/meetings/reorder: archivierte IDs werden still ignoriert ──

test('PUT /api/meetings/reorder: archivierte Meetings in der Liste werden still ignoriert (kein Fehler)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId: activeId } = await bootstrapStackFixture(request, app, db);
  const archived = await agent.post('/api/meetings').send({ title: 'Archiviert', color: '#4f46e5' });
  await archiveMeeting(agent, archived.body.id);

  const r = await agent.put('/api/meetings/reorder').send({ ids: [activeId, archived.body.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

// ── GET /api/themes: Links auf archivierte Topics bleiben enthalten ──

test('GET /api/themes: Link auf archiviertes Topic bleibt enthalten, mit archived:true', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);
  const theme = await agent.post('/api/themes').send({ title: 'Thema' });
  const { meetingId, topicId } = await makeMeetingWithTopic(agent, 'Archiviert');
  await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'topic', refId: topicId });
  await archiveMeeting(agent, meetingId);

  const r = await agent.get('/api/themes');
  assert.equal(r.status, 200);
  const t1 = r.body.find((x) => x.id === theme.body.id);
  const link = t1.links.find((l) => l.refId === topicId);
  assert.ok(link, 'Link auf archiviertes Topic muss enthalten bleiben');
  assert.equal(link.archived, true);
});
