'use strict';
// Paket B3 ("Meetings archivieren statt löschen" - Nebenverbraucher KI & Graph):
// Verifiziert, dass archivierte Meetings/Topics in KEINER KI-Funktion mehr als
// Datenquelle auftauchen (weder als Prompt-Kontext, noch in aggregierten
// Statistiken/Vorschlägen), während nicht-archivierte Daten unverändert
// erscheinen.
//
// Da die Server-Integration des Archiv-Kernmoduls (Paket B2, insb.
// `archive.runArchiveMigrations(db)` in server.js und der Archiv-Router)
// zum Zeitpunkt dieser Änderung parallel läuft und noch nicht in diesem
// Worktree vorliegt, wird der Archiv-Status hier direkt über die
// Query-Schicht des bereits gemergten Archiv-Kernmoduls (`lib/archive`)
// gesetzt statt über eine HTTP-Route - siehe Abschlussbericht.
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');
const archiveLib = require('../lib/archive');

async function configureMockAi(agent, extraFeatures = {}) {
  return agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-XXXX',
    features_enabled: {
      brief: true, capture: true, result_draft: true, reentry: true,
      theme_tagging: true, digest: true, cross_meeting: true,
      ...extraFeatures,
    },
    confirm_threshold_cents: 10_000,
  });
}

function archiveMeeting(db, userId, meetingId) {
  return archiveLib.archive(db, userId, 'meeting', meetingId, new Date().toISOString());
}

// ── Einzelner Meeting-Lookup (briefMeeting) ──────────────────────────────
test('Brief: archiviertes Meeting liefert 404 "Meeting nicht gefunden" (bestehender Fehlerpfad greift automatisch)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, admin, meetingId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  archiveMeeting(db, admin.id, meetingId);

  const r = await agent.post(`/api/ai/meeting/${meetingId}/brief`);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Meeting nicht gefunden');
  assert.equal(r.body.code, undefined, 'kein neuer Fehlercode - bestehender Pfad wird wiederverwendet');
});

test('Brief: nicht-archiviertes Meeting funktioniert unverändert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, meetingId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  const r = await agent.post(`/api/ai/meeting/${meetingId}/brief`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.content.talking_points));
});

// ── Aggregat-Query: Drift-Erkennung (reine DB-Query, kein AI-Call) ───────
test('Drift-Erkennung: Topic eines archivierten Meetings wird nicht mehr als drifted gemeldet, Topic eines aktiven Meetings weiterhin', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, admin, meetingId, topicId } = await bootstrapStackFixture(request, app, db);

  const m2 = await agent.post('/api/meetings').send({ title: 'Wird archiviert', color: '#111111' });
  const t2 = await agent.post(`/api/meetings/${m2.body.id}/topics`).send({ title: 'Altes Thema (archiviert)' });

  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE topics SET created_at=?, updated_at=? WHERE id IN (?,?)').run(past, past, topicId, t2.body.id);

  archiveMeeting(db, admin.id, m2.body.id);

  const r = await agent.get('/api/ai/insights/drift');
  assert.equal(r.status, 200);
  assert.equal(r.body.drifted.length, 1, JSON.stringify(r.body.drifted));
  assert.equal(r.body.drifted[0].topic_id, topicId);
  assert.ok(!r.body.drifted.some(d => d.topic_id === t2.body.id), 'archiviertes Topic darf nicht im Drift-Ergebnis erscheinen');
});

// ── Aggregat-Query: Wochen-Digest-Statistik (gatherWeeklyStats) ──────────
test('Wochen-Digest: archiviertes Meeting/Topic erscheint nicht im KI-Prompt-Kontext, aktives weiterhin', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, admin, topicId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  const today = new Date().toISOString().slice(0, 10);
  db.prepare("UPDATE topics SET done=1, result='Ergebnis aktiv', result_date=? WHERE id=?").run(today, topicId);

  const m2 = await agent.post('/api/meetings').send({ title: 'Archiviertes Meeting', color: '#222222' });
  const t2 = await agent.post(`/api/meetings/${m2.body.id}/topics`).send({ title: 'Archiviertes Thema XYZ' });
  db.prepare("UPDATE topics SET done=1, result='Ergebnis archiviert', result_date=? WHERE id=?").run(today, t2.body.id);

  archiveMeeting(db, admin.id, m2.body.id);

  const r = await agent.post('/api/ai/digest/weekly');
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const mock = require('../ai/providers/mock');
  const lastCall = mock.getLastCall();
  assert.ok(lastCall.user.includes('Topic-1'), 'aktives Thema muss weiterhin im Digest-Kontext erscheinen');
  assert.ok(!lastCall.user.includes('Archiviertes Thema XYZ'), 'archiviertes Thema darf nicht im KI-Kontext erscheinen');
  assert.ok(!lastCall.user.includes('Archiviertes Meeting'), 'archiviertes Meeting darf nicht im KI-Kontext erscheinen');
});

// ── Aggregat-Query: Cross-Meeting-Insight ────────────────────────────────
test('Cross-Meeting-Insight: archiviertes Meeting weder als Kontext noch als Match, aktives Meeting weiterhin', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, admin, meetingId, topicId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  const m2 = await agent.post('/api/meetings').send({ title: 'Meeting B', color: '#ef4444' });
  const t2 = await agent.post(`/api/meetings/${m2.body.id}/topics`).send({ title: 'Topic-B-1' });

  const m3 = await agent.post('/api/meetings').send({ title: 'Archiviertes Meeting C', color: '#333333' });
  const t3 = await agent.post(`/api/meetings/${m3.body.id}/topics`).send({ title: 'Archiviertes Thema C' });
  archiveMeeting(db, admin.id, m3.body.id);

  const mock = require('../ai/providers/mock');
  mock.setMockResponse('cross_meeting', {
    matches: [
      { this_topic_id: topicId, other_topic_id: t2.body.id, confidence: 0.9, reason: 'match B' },
      { this_topic_id: topicId, other_topic_id: t3.body.id, confidence: 0.9, reason: 'match archiviert' },
    ],
  });

  const post = await agent.post(`/api/ai/insights/cross-meeting/${meetingId}`);
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.equal(post.body.content.matches.length, 1, JSON.stringify(post.body.content.matches));
  assert.equal(post.body.content.matches[0].other_topic_id, t2.body.id);

  const lastCall = mock.getLastCall();
  assert.ok(!lastCall.user.includes('Archiviertes Thema C'), 'archiviertes Thema darf nicht im Cross-Meeting-Kontext erscheinen');
  assert.ok(lastCall.user.includes('Topic-B-1'), 'nicht-archiviertes Thema muss weiterhin im Kontext erscheinen');

  mock.setMockResponse('cross_meeting', { matches: [] });
});

// ── Re-Entry: archiviertes Topic wird wie ein gelöschtes Topic behandelt ──
test('Re-Entry-Briefing: Topic eines archivierten Meetings liefert Fallback statt Topic-Inhalt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, admin } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);

  const m = await agent.post('/api/meetings').send({ title: 'Reentry-Meeting', color: '#444444' });
  const top = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Reentry-Thema', description: 'Details zum Thema' });
  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: top.body.id, nextStepNote: 'weiter machen' });
  assert.equal(push.status, 201, JSON.stringify(push.body));

  archiveMeeting(db, admin.id, m.body.id);

  const r = await agent.post(`/api/ai/stack/${push.body.frame.id}/reentry`);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const mock = require('../ai/providers/mock');
  const lastCall = mock.getLastCall();
  assert.ok(!lastCall.user.includes('Details zum Thema'), 'Beschreibung des archivierten Topics darf nicht im Prompt-Kontext erscheinen');
  assert.ok(lastCall.user.includes('(gelöscht)'), 'archiviertes Topic wird wie ein gelöschtes Topic behandelt (bestehender Fallback)');
});
