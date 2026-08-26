'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('path');
const express   = require('express');
const request   = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const { createSummaryRouter } = require(path.join(REPO_ROOT, 'lib/summaries/routes'));

// routes.js wird hier als isolierte Einheit getestet: echtes DB-Schema (über
// den vollständigen Server, für realistische todos/topics/ai_artifacts-Tabellen),
// aber vollständig kontrollierbare Dependency-Injection für requireAuth/ownsRef/
// isRefReadOnly/scheduler/aiSettingsLoader — unabhängig vom (noch unvollständigen)
// echten ai/index.js (fehlende summarizeProgress/summarizeDescription, Paket S2)
// und von lib/archive (Paket B-Serie, noch nicht vorhanden).
function buildTestApp({ db, uid = 'user-1', ownsRefImpl, isRefReadOnlyImpl, scheduler, settings, now }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { uid }; next(); });
  const requireAuth = (req, res, next) => {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  };
  const router = createSummaryRouter({
    db,
    requireAuth,
    ownsRef: ownsRefImpl || (() => true),
    isRefReadOnly: isRefReadOnlyImpl || (() => false),
    scheduler: scheduler || { enqueue: () => true, status: () => null },
    aiSettingsLoader: () => settings,
    now: now || (() => new Date()),
  });
  app.use('/api', router);
  return app;
}

const DISABLED_SETTINGS = null; // ai.loadSettings() liefert null, wenn nie konfiguriert
const ENABLED_SETTINGS = {
  globally_disabled: false, provider: 'mock', api_key_encrypted: 'enc',
  features_enabled: { progress_summary: true, description_summary: true },
  max_monthly_cost_cents: 0, confirm_threshold_cents: 10,
};

async function makeFixture(t) {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  return { db, agent, userId: admin.id };
}

test('GET /api/summaries: 401 ohne Session', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const app = buildTestApp({ db, uid: null, settings: ENABLED_SETTINGS });
  const res = await request(app).get('/api/summaries?refs=todo:abc');
  assert.equal(res.status, 401);
});

test('GET /api/summaries: 400 invalid_refs bei fehlendem/ungültigem Format', async (t) => {
  const { db } = await makeFixture(t);
  const app = buildTestApp({ db, settings: ENABLED_SETTINGS });

  const r1 = await request(app).get('/api/summaries');
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'invalid_refs');

  const r2 = await request(app).get('/api/summaries?refs=');
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'invalid_refs');

  const r3 = await request(app).get('/api/summaries?refs=meeting:abc');
  assert.equal(r3.status, 400);
  assert.equal(r3.body.code, 'invalid_refs');

  const r4 = await request(app).get('/api/summaries?refs=todo:abc!!!');
  assert.equal(r4.status, 400);
  assert.equal(r4.body.code, 'invalid_refs');
});

test('GET /api/summaries: 400 too_many_refs bei mehr als 50 Referenzen', async (t) => {
  const { db } = await makeFixture(t);
  const app = buildTestApp({ db, settings: ENABLED_SETTINGS });
  const refs = Array.from({ length: 51 }, (_, i) => `todo:id${i}`).join(',');
  const res = await request(app).get(`/api/summaries?refs=${refs}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'too_many_refs');
});

test('GET /api/summaries: unbekannte/fremde Refs werden kommentarlos weggelassen', async (t) => {
  const { db, userId } = await makeFixture(t);
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS });
  const res = await request(app).get('/api/summaries?refs=todo:nichtvorhanden');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.summaries, {});
});

test('GET /api/summaries: disabled, wenn AI nicht konfiguriert', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T' });
  const app = buildTestApp({ db, uid: userId, settings: DISABLED_SETTINGS });
  const res = await request(app).get(`/api/summaries?refs=todo:${todo.body.id}`);
  assert.equal(res.status, 200);
  const view = res.body.summaries[`todo:${todo.body.id}`];
  assert.equal(view.progress.status, 'disabled');
  assert.equal(view.description.status, 'disabled');
});

test('GET /api/summaries: not_applicable bei zu kurzer Beschreibung / erledigtem Todo', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const short = await agent.post('/api/todos').send({ title: 'T', description: 'kurz' });
  const done = await agent.post('/api/todos').send({ title: 'T2', description: 'x'.repeat(650) });
  await agent.put(`/api/todos/${done.body.id}`).send({ done: true });

  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS });
  const res = await request(app).get(`/api/summaries?refs=todo:${short.body.id},todo:${done.body.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.summaries[`todo:${short.body.id}`].description.status, 'not_applicable');
  assert.equal(res.body.summaries[`todo:${done.body.id}`].description.status, 'not_applicable');
});

test('GET /api/summaries: ready wenn Artefakt vorhanden und sourceVersion passt, stale bei Änderung', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const longDesc = 'x'.repeat(650);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: longDesc });
  const todoId = todo.body.id;

  const { htmlToText } = require(path.join(REPO_ROOT, 'lib/sanitize'));
  const { descriptionSourceVersion } = require(path.join(REPO_ROOT, 'lib/summaries/queries'));
  const currentVersion = descriptionSourceVersion(htmlToText(longDesc));

  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('art1', userId, 'todo', todoId, 'description_summary',
      JSON.stringify({ summary: 'Zusammenfassung X', sourceVersion: currentVersion }), 'mock-1', '2026-01-01T00:00:00.000Z');

  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS });
  const res = await request(app).get(`/api/summaries?refs=todo:${todoId}`);
  const view = res.body.summaries[`todo:${todoId}`].description;
  assert.equal(view.status, 'ready');
  assert.equal(view.text, 'Zusammenfassung X');
  assert.equal(view.model, 'mock-1');

  // Beschreibung ändert sich -> sourceVersion passt nicht mehr -> stale, alter Text bleibt sichtbar
  await agent.put(`/api/todos/${todoId}`).send({ description: 'y'.repeat(650) });
  const res2 = await request(app).get(`/api/summaries?refs=todo:${todoId}`);
  const view2 = res2.body.summaries[`todo:${todoId}`].description;
  assert.equal(view2.status, 'stale');
  assert.equal(view2.text, 'Zusammenfassung X');
});

test('GET /api/summaries: pending, solange der Scheduler einen laufenden Job meldet', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  const scheduler = { enqueue: () => true, status: (uid, kind) => (kind === 'description' ? { state: 'pending', at: new Date().toISOString() } : null) };
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS, scheduler });
  const res = await request(app).get(`/api/summaries?refs=todo:${todo.body.id}`);
  assert.equal(res.body.summaries[`todo:${todo.body.id}`].description.status, 'pending');
});

test('GET /api/summaries: error mit errorCode, wenn Scheduler einen Fehlerzustand meldet', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  const scheduler = { enqueue: () => true, status: () => ({ state: 'error', errorCode: 'ai_unavailable', at: new Date().toISOString() }) };
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS, scheduler });
  const res = await request(app).get(`/api/summaries?refs=todo:${todo.body.id}`);
  const view = res.body.summaries[`todo:${todo.body.id}`].description;
  assert.equal(view.status, 'error');
  assert.equal(view.errorCode, 'ai_unavailable');
});

// ── POST /api/summaries/:kind/:refType/:refId/regenerate ────────────────

test('regenerate: 400 invalid_kind bei unbekannter Art', async (t) => {
  const { db, userId } = await makeFixture(t);
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS });
  const res = await request(app).post('/api/summaries/unknownkind/todo/abc/regenerate');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_kind');
});

test('regenerate: 404 ref_not_found bei fremder/unbekannter Referenz', async (t) => {
  const { db, userId } = await makeFixture(t);
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS, ownsRefImpl: () => false });
  const res = await request(app).post('/api/summaries/description/todo/fremd/regenerate');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ref_not_found');
});

test('regenerate: 409 ARCHIVED_READONLY, wenn isRefReadOnly true liefert', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS, isRefReadOnlyImpl: () => true });
  const res = await request(app).post(`/api/summaries/description/todo/${todo.body.id}/regenerate`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ARCHIVED_READONLY');
});

test('regenerate: 409 ai_disabled, wenn AI nicht konfiguriert', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  const app = buildTestApp({ db, uid: userId, settings: DISABLED_SETTINGS });
  const res = await request(app).post(`/api/summaries/description/todo/${todo.body.id}/regenerate`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ai_disabled');
});

test('regenerate: 402 budget_exceeded, wenn das Monatsbudget bereits ausgeschöpft ist', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  db.prepare('INSERT INTO ai_usage(id,user_id,feature,provider,model,input_tokens,output_tokens,cost_estimate_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('u1', userId, 'description_summary', 'mock', 'mock-1', 0, 0, 10000, new Date().toISOString());
  const settings = { ...ENABLED_SETTINGS, max_monthly_cost_cents: 100 };
  const app = buildTestApp({ db, uid: userId, settings });
  const res = await request(app).post(`/api/summaries/description/todo/${todo.body.id}/regenerate`);
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'budget_exceeded');
});

test('regenerate: 409 not_applicable bei erledigtem Todo bzw. zu kurzer Beschreibung', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const doneTodo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  await agent.put(`/api/todos/${doneTodo.body.id}`).send({ done: true });
  const shortTodo = await agent.post('/api/todos').send({ title: 'T2', description: 'kurz' });

  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS });

  const r1 = await request(app).post(`/api/summaries/description/todo/${doneTodo.body.id}/regenerate`);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'not_applicable');

  const r2 = await request(app).post(`/api/summaries/description/todo/${shortTodo.body.id}/regenerate`);
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'not_applicable');
});

test('regenerate: 202 pending im Erfolgsfall, confirm=true wird an scheduler.enqueue durchgereicht', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  let seen = null;
  const scheduler = { enqueue: (opts) => { seen = opts; return true; }, status: () => null };
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS, scheduler });
  const res = await request(app).post(`/api/summaries/description/todo/${todo.body.id}/regenerate?confirm=true`);
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { status: 'pending' });
  assert.equal(seen.confirmed, true);
  assert.equal(seen.kind, 'description');
});

test('regenerate: 429 rate_limited ab dem 11. Versuch innerhalb von 10 Minuten', async (t) => {
  const { db, agent, userId } = await makeFixture(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'x'.repeat(650) });
  const scheduler = { enqueue: () => true, status: () => null };
  const app = buildTestApp({ db, uid: userId, settings: ENABLED_SETTINGS, scheduler });

  let last;
  for (let i = 0; i < 11; i++) {
    last = await request(app).post(`/api/summaries/description/todo/${todo.body.id}/regenerate`);
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'rate_limited');
});
