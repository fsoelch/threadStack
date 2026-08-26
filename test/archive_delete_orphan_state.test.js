'use strict';
// Security-Review-Fund 2 (Niedrig): DELETE /api/meetings/:id räumt eine
// zuvor angelegte archive_state-Zeile auf, statt sie als Waise
// zurückzulassen (die sich sonst erst beim nächsten Serverstart per
// purgeArchiveOrphans() aufräumt). DELETE /api/meetings/:id selbst bleibt
// bewusst der Sofort-Löschen-Pfad (kein Archivieren-Alias).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

function archiveStateRow(db, refId) {
  return db.prepare("SELECT * FROM archive_state WHERE ref_type='meeting' AND ref_id=?").get(refId);
}

test('DELETE /api/meetings/:id: archive_state-Zeile eines zuvor archivierten Meetings wird mitgeloescht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const m = await agent.post('/api/meetings').send({ title: 'Wird archiviert und dann geloescht', color: '#4f46e5' });
  const meetingId = m.body.id;

  const archived = await agent.post(`/api/archive/meeting/${meetingId}`).send({ acknowledgeStackConflict: true });
  assert.equal(archived.status, 200, `archivieren fehlgeschlagen: ${JSON.stringify(archived.body)}`);
  assert.ok(archiveStateRow(db, meetingId), 'archive_state-Zeile muss nach dem Archivieren existieren');

  const del = await agent.delete(`/api/meetings/${meetingId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  assert.equal(
    archiveStateRow(db, meetingId),
    undefined,
    'archive_state-Zeile muss nach DELETE /api/meetings/:id nicht mehr existieren (keine Waise)'
  );
});

test('DELETE /api/meetings/:id: nicht archiviertes Meeting bleibt unveraendert loeschbar (kein Fehler durch neue deleteState-Aufraeumung)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const m = await agent.post('/api/meetings').send({ title: 'Nie archiviert', color: '#4f46e5' });
  const meetingId = m.body.id;
  assert.equal(archiveStateRow(db, meetingId), undefined);

  const del = await agent.delete(`/api/meetings/${meetingId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  assert.equal(archiveStateRow(db, meetingId), undefined);
});

test('DELETE /api/meetings/:id: unbekannte ID bleibt 404, keine unbeabsichtigte Seiteneffekte', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await bootstrapStackFixture(request, app, db);

  const del = await agent.delete('/api/meetings/does-not-exist');
  assert.equal(del.status, 404);
});
