'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('path');
const request   = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const service = require(path.join(REPO_ROOT, 'lib/summaries/service'));

const LONG_DESC_A = 'a'.repeat(650);
const LONG_DESC_B = 'b'.repeat(650);

test('service.onProgressEntriesChanged: liefert {enqueued:false} und wirft nie, wenn kein Scheduler konfiguriert ist', () => {
  service._resetSchedulerForTests();
  const r = service.onProgressEntriesChanged({ userId: 'u1', refType: 'todo', refId: 't1', reason: 'created' });
  assert.deepEqual(r, { enqueued: false });
});

test('service.onDescriptionChanged: liefert {enqueued:false} und wirft nie bei ctx=null', () => {
  service._resetSchedulerForTests();
  assert.deepEqual(service.onDescriptionChanged(null), { enqueued: false });
  assert.deepEqual(service.onProgressEntriesChanged(undefined), { enqueued: false });
});

test('service.configure: leitet enqueue an den injizierten Scheduler weiter, gibt {enqueued} zurück', () => {
  let seen = null;
  service.configure({ scheduler: { enqueue: (opts) => { seen = opts; return true; } } });
  const r = service.onProgressEntriesChanged({ userId: 'u1', refType: 'topic', refId: 'top1', reason: 'deleted' });
  assert.deepEqual(r, { enqueued: true });
  assert.equal(seen.kind, 'progress');
  assert.equal(seen.confirmed, false);
  assert.equal(seen.reason, 'deleted');

  const r2 = service.onDescriptionChanged({ userId: 'u1', refType: 'todo', refId: 't1' });
  assert.deepEqual(r2, { enqueued: true });
  assert.equal(seen.kind, 'description');
  assert.equal(seen.reason, 'updated'); // Default-Reason, wenn keiner übergeben wird
  service._resetSchedulerForTests();
});

test('service Hooks: werfen nie, selbst wenn der injizierte Scheduler wirft', () => {
  service.configure({ scheduler: { enqueue: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => {
    const r = service.onProgressEntriesChanged({ userId: 'u1', refType: 'todo', refId: 't1', reason: 'updated' });
    assert.deepEqual(r, { enqueued: false });
  });
  service._resetSchedulerForTests();
});

// ── Server-Integration: Beschreibungsänderung löst additiv aiSummary.pending aus ──

test('PUT /api/todos/:id: aiSummary.pending nur, wenn sich die Beschreibung tatsächlich ändert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC_A });
  assert.ok('aiSummary' in todo.body, 'POST /api/todos muss additiv aiSummary liefern');
  assert.equal(typeof todo.body.aiSummary.pending, 'boolean');

  // Titel ändern, Beschreibung unverändert lassen -> kein aiSummary-Feld
  const r1 = await agent.put(`/api/todos/${todo.body.id}`).send({ title: 'Neuer Titel' });
  assert.equal(r1.status, 200);
  assert.equal('aiSummary' in r1.body, false, 'ohne Beschreibungsänderung darf aiSummary nicht auftauchen');

  // Beschreibung ändern -> aiSummary.pending muss auftauchen
  const r2 = await agent.put(`/api/todos/${todo.body.id}`).send({ description: LONG_DESC_B });
  assert.equal(r2.status, 200);
  assert.ok('aiSummary' in r2.body);
  assert.equal(typeof r2.body.aiSummary.pending, 'boolean');
});

test('PUT /api/meetings/:id/topics/:tid: Beschreibungsänderung wird an alle Gruppenmitglieder weitergereicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  const m1 = await agent.post('/api/meetings').send({ title: 'M1', color: '#4f46e5' });
  const m2 = await agent.post('/api/meetings').send({ title: 'M2', color: '#4f46e5' });
  const topic = await agent.post(`/api/meetings/${m1.body.id}/topics`).send({ title: 'Top', description: LONG_DESC_A });
  const shared = await agent.post(`/api/meetings/${m1.body.id}/topics/${topic.body.id}/share`).send({ targetMeetingId: m2.body.id });
  assert.equal(shared.status, 201);

  const r = await agent.put(`/api/meetings/${m1.body.id}/topics/${topic.body.id}`).send({ description: LONG_DESC_B });
  assert.equal(r.status, 200);
  assert.ok('aiSummary' in r.body);

  // Beide Gruppenmitglieder müssen die neue Beschreibung tragen (bestehendes Verhalten, unverändert)
  const list = await agent.get('/api/meetings');
  const t1 = list.body.find(mm => mm.id === m1.body.id).topics.find(tt => tt.id === topic.body.id);
  const t2 = list.body.find(mm => mm.id === m2.body.id).topics.find(tt => tt.id === shared.body.id);
  assert.equal(t1.description, LONG_DESC_B);
  assert.equal(t2.description, LONG_DESC_B);
});

test('DELETE /api/todos/:id: ruft summaries.deleteForRefs auf (Artefakt verschwindet)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC_A });
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a1', admin.id, 'todo', todo.body.id, 'description_summary', JSON.stringify({ summary: 'x' }), 'm', new Date().toISOString());

  const del = await agent.delete(`/api/todos/${todo.body.id}`);
  assert.equal(del.status, 200);
  const remaining = db.prepare('SELECT id FROM ai_artifacts WHERE ref_id=?').all(todo.body.id);
  assert.equal(remaining.length, 0);
});

test('DELETE /api/meetings/:id/topics/:tid: ruft summaries.deleteForRefs auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const topic = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Top', description: LONG_DESC_A });
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a1', admin.id, 'topic', topic.body.id, 'description_summary', JSON.stringify({ summary: 'x' }), 'm', new Date().toISOString());

  const del = await agent.delete(`/api/meetings/${m.body.id}/topics/${topic.body.id}`);
  assert.equal(del.status, 200);
  const remaining = db.prepare('SELECT id FROM ai_artifacts WHERE ref_id=?').all(topic.body.id);
  assert.equal(remaining.length, 0);
});

test('DELETE /api/meetings/:id: räumt Zusammenfassungen aller enthaltenen Topics vor dem Cascade-Delete auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const topic = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Top', description: LONG_DESC_A });
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a1', admin.id, 'topic', topic.body.id, 'description_summary', JSON.stringify({ summary: 'x' }), 'm', new Date().toISOString());

  const del = await agent.delete(`/api/meetings/${m.body.id}`);
  assert.equal(del.status, 200);
  const remaining = db.prepare('SELECT id FROM ai_artifacts WHERE ref_id=?').all(topic.body.id);
  assert.equal(remaining.length, 0);
});

test('DELETE /api/meetings/:id: 404 bei fremdem/unbekanntem Meeting, keine Seiteneffekte', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const res = await agent.delete('/api/meetings/does-not-exist');
  assert.equal(res.status, 404);
});
