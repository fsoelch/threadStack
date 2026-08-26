'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('path');
const request   = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const NA = { status: 'not_applicable', text: null, generatedAt: null, model: null, errorCode: null };

function assertSummaryShape(view) {
  assert.ok(view, 'aiSummary muss vorhanden sein');
  for (const kind of ['progress', 'description']) {
    assert.ok(view[kind], `aiSummary.${kind} fehlt`);
    assert.ok(['ready', 'stale', 'pending', 'error', 'disabled', 'not_applicable'].includes(view[kind].status));
  }
}

test('GET /api/todos: jedes Todo trägt additiv aiSummary (Standardfall: not_applicable ohne Konfiguration)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.post('/api/todos').send({ title: 'T1' });
  await agent.post('/api/todos').send({ title: 'T2', description: 'x'.repeat(650) });

  const res = await agent.get('/api/todos');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  for (const todo of res.body) assertSummaryShape(todo.aiSummary);
});

test('GET /api/meetings: jedes Topic trägt additiv aiSummary', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Top1' });

  const res = await agent.get('/api/meetings');
  assert.equal(res.status, 200);
  const meeting = res.body.find(mm => mm.id === m.body.id);
  assert.equal(meeting.topics.length, 1);
  assertSummaryShape(meeting.topics[0].aiSummary);
});

test('POST /api/meetings/:id/topics: Topic-Erstellung selbst bekommt KEIN aiSummary-Feld (nicht Teil des Vertrags)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const topic = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Top1' });
  assert.equal('aiSummary' in topic.body, false);
});

test('GET /api/themes/:id/todos: verlinkte Todos tragen additiv aiSummary', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const theme = await agent.post('/api/themes').send({ title: 'Thema' });
  const todo = await agent.post('/api/todos').send({ title: 'T1' });
  await agent.post(`/api/themes/${theme.body.id}/links`).send({ refType: 'todo', refId: todo.body.id });

  const res = await agent.get(`/api/themes/${theme.body.id}/todos`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assertSummaryShape(res.body[0].aiSummary);
});

test('GET /api/todos: mit aktivierter KI + vorhandenem Artefakt liefert die Liste "ready"', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-X',
    features_enabled: { description_summary: true, progress_summary: true },
  });

  // Direkt per SQL angelegt (statt POST /api/todos): so löst das Anlegen
  // selbst keinen Hintergrund-Job über onDescriptionChanged aus, der den
  // erwarteten "ready"-Status in diesem Test sonst durch "pending" überdecken
  // würde (siehe service.js-Vorrangregel: pending > ready/stale).
  const longDesc = 'x'.repeat(650);
  const todoId = 'todo-ready-1';
  db.prepare(
    'INSERT INTO todos(id,user_id,title,description,due_date,is_private,snoozed_until,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(todoId, admin.id, 'T', longDesc, '', 0, '', 0, new Date().toISOString());

  const { htmlToText } = require(path.join(REPO_ROOT, 'lib/sanitize'));
  const { descriptionSourceVersion } = require(path.join(REPO_ROOT, 'lib/summaries/queries'));
  const version = descriptionSourceVersion(htmlToText(longDesc));

  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a1', admin.id, 'todo', todoId, 'description_summary',
      JSON.stringify({ summary: 'Kurzfassung', sourceVersion: version }),
      'mock-1', new Date().toISOString());

  const res = await agent.get('/api/todos');
  const t1 = res.body.find(x => x.id === todoId);
  assert.equal(t1.aiSummary.description.status, 'ready');
  assert.equal(t1.aiSummary.description.text, 'Kurzfassung');
});

// ── Anti-Regressionstest (wichtigste Regel von Schnittstelle 9) ──────────
test('Anti-Regression: GET /api/todos mit 200 Todos löst NULL Provider-/KI-Aufrufe aus', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-X',
    features_enabled: { description_summary: true, progress_summary: true },
  });

  const insert = db.prepare(
    'INSERT INTO todos(id,user_id,title,description,due_date,is_private,snoozed_until,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const now = new Date().toISOString();
  for (let i = 0; i < 200; i++) {
    insert.run(`todo-${i}`, admin.id, `Todo ${i}`, 'x'.repeat(650), '', 0, '', i, now);
  }

  const usageBefore = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  const artifactsBefore = db.prepare('SELECT COUNT(*) AS n FROM ai_artifacts').get().n;

  const res = await agent.get('/api/todos');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 200);
  for (const todo of res.body) assertSummaryShape(todo.aiSummary);

  const usageAfter = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  const artifactsAfter = db.prepare('SELECT COUNT(*) AS n FROM ai_artifacts').get().n;
  assert.equal(usageAfter, usageBefore, 'GET /api/todos darf niemals einen KI-Aufruf (ai_usage) auslösen');
  assert.equal(artifactsAfter, artifactsBefore, 'GET /api/todos darf niemals ein neues Artefakt erzeugen');
});

test('Anti-Regression: GET /api/meetings mit vielen Topics löst keine KI-Aufrufe aus', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-X',
    features_enabled: { description_summary: true, progress_summary: true },
  });
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const insert = db.prepare(
    `INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,created_at,sort_order) VALUES (?,?,?,?,0,'','',?,?)`
  );
  const now = new Date().toISOString();
  for (let i = 0; i < 100; i++) insert.run(`topic-${i}`, m.body.id, `Topic ${i}`, 'x'.repeat(650), now, i);

  const usageBefore = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  const res = await agent.get('/api/meetings');
  assert.equal(res.status, 200);
  const usageAfter = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  assert.equal(usageAfter, usageBefore);
});
