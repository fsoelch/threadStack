'use strict';
// Tests für die S2-Spiegelung zwischen dem Stack (server.js: /api/stack/*)
// und progress_meta.next_step sowie den best-effort kind='result'-Marker
// beim Pop mit resolution='done'.
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function getProgress(agent, refType, refId) {
  const r = await agent.get(`/api/progress/${refType}/${refId}`);
  assert.equal(r.status, 200);
  return r.body;
}

test('Stack Push spiegelt next_step_note in progress_meta.next_step', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'Angebot einholen' });
  assert.equal(push.status, 201);

  const p = await getProgress(agent, 'topic', topicId);
  assert.equal(p.nextStep, 'Angebot einholen');
  assert.ok(p.nextStepUpdatedAt);
});

test('Stack Push: next_step_note wird vor der Spiegelung nach progress_meta sanitisiert (Security Review F3)', async (t) => {
  // Der /api/stack/push-Endpunkt sanitisiert die Notiz selbst nicht (das war
  // nie sein Vertrag) - setNextStep() in queries.js muss das unabhaengig
  // vom Aufrufer sicherstellen, sonst hat progress_meta.next_step je nach
  // Schreibpfad unterschiedliche Garantien.
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({
    refType: 'topic', refId: topicId,
    nextStepNote: '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;',
  });
  assert.equal(push.status, 201);

  const p = await getProgress(agent, 'topic', topicId);
  assert.ok(!/[<>]/.test(p.nextStep), `nextStep sollte keine spitzen Klammern enthalten, war: ${p.nextStep}`);
});

test('Stack-Notiz-Update (PUT /stack/:frameId/note) spiegelt sich in progress_meta zurück', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'todo', refId: todoId, nextStepNote: 'initial' });
  const frameId = push.body.frame.id;

  const upd = await agent.put(`/api/stack/${frameId}/note`).send({ nextStepNote: 'aktualisiert' });
  assert.equal(upd.status, 200);

  const p = await getProgress(agent, 'todo', todoId);
  assert.equal(p.nextStep, 'aktualisiert');
});

test('Pop mit resolution=done erzeugt genau einen kind=result-Eintrag mit source=pop_done', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'note' });
  const frameId = push.body.frame.id;

  const pop = await agent.post(`/api/stack/pop/${frameId}`).send({ resolution: 'done', result: 'Erledigt: Kunde informiert' });
  assert.equal(pop.status, 200);
  assert.equal(pop.body.applied.topicDone, true);

  const entries = await agent.get(`/api/progress/topic/${topicId}/entries`);
  assert.equal(entries.status, 200);
  assert.equal(entries.body.entries.length, 1);
  const resultEntry = entries.body.entries[0];
  assert.equal(resultEntry.kind, 'result');
  assert.equal(resultEntry.source, 'pop_done');
  assert.equal(resultEntry.linkFrameId, frameId);
  assert.equal(resultEntry.bodyHtml, 'Erledigt: Kunde informiert');
  assert.equal(resultEntry.editable, false);
});

test('Pop mit resolution=snoozed erzeugt KEINEN automatischen Progress-Eintrag', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'todo', refId: todoId, nextStepNote: 'note' });
  const frameId = push.body.frame.id;

  const pop = await agent.post(`/api/stack/pop/${frameId}`).send({ resolution: 'snoozed' });
  assert.equal(pop.status, 200);

  const entries = await agent.get(`/api/progress/todo/${todoId}/entries`);
  assert.equal(entries.body.entries.length, 0);
});

test('Pop mit resolution=dropped erzeugt KEINEN automatischen Progress-Eintrag', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'todo', refId: todoId, nextStepNote: 'note' });
  const frameId = push.body.frame.id;

  const pop = await agent.post(`/api/stack/pop/${frameId}`).send({ resolution: 'dropped' });
  assert.equal(pop.status, 200);

  const entries = await agent.get(`/api/progress/todo/${todoId}/entries`);
  assert.equal(entries.body.entries.length, 0);
});

test('next_step überlebt den Pop unverändert (wird nicht gelöscht/zurückgesetzt)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'bleibt stehen' });
  const frameId = push.body.frame.id;

  await agent.post(`/api/stack/pop/${frameId}`).send({ resolution: 'dropped' });

  const p = await getProgress(agent, 'topic', topicId);
  assert.equal(p.nextStep, 'bleibt stehen');
});

test('Pop mit resolution=done: best-effort schlägt niemals fehl, auch wenn bereits ein Ergebnis-Eintrag für den Frame existiert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  const push = await agent.post('/api/stack/push').send({ refType: 'topic', refId: topicId, nextStepNote: 'note' });
  const frameId = push.body.frame.id;

  // Simuliert eine bereits existierende kind='result'-Zeile für GENAU diesen
  // Frame (z.B. durch einen vorherigen, teilweise fehlgeschlagenen Request) -
  // idx_progress_result_frame (UNIQUE auf link_frame_id WHERE kind='result')
  // würde einen zweiten insertEntry()-Aufruf mit demselben linkFrameId zum
  // Scheitern bringen. Der Pop selbst darf davon NICHT betroffen sein.
  // Ausschließlich parametrisiertes Statement, keine String-Konkatenation.
  const adminId = db.prepare('SELECT id FROM users WHERE username=?').get('admin').id;
  db.prepare(
    `INSERT INTO progress_entries
       (id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('pre-existing', adminId, 'topic', topicId, 'result', 'pop_done', '', '', frameId, null, new Date().toISOString(), null);

  const pop = await agent.post(`/api/stack/pop/${frameId}`).send({ resolution: 'done', result: 'Ergebnis' });
  assert.equal(pop.status, 200, JSON.stringify(pop.body));
  assert.equal(pop.body.applied.topicDone, true);

  // No-Op: weiterhin nur der vorher eingefügte Eintrag, kein zweiter.
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM progress_entries WHERE link_frame_id=? AND kind=?`
  ).get(frameId, 'result').c;
  assert.equal(count, 1);
});
