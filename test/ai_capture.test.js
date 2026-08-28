'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('AI Capture: liefert Vorschläge (Mock)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { capture: true },
    confirm_threshold_cents: 10_000,
  });
  const m = await agent.post('/api/meetings').send({ title: 'Stand-Up', color: '#6366f1' });

  const cap = await agent.post(`/api/ai/meeting/${m.body.id}/capture`).send({ notes: 'Wir haben über X gesprochen und Y vereinbart.' });
  assert.equal(cap.status, 200, JSON.stringify(cap.body));
  assert.ok(Array.isArray(cap.body.suggestions.new_topics));
  assert.ok(Array.isArray(cap.body.suggestions.new_todos));
});

test('AI Capture: 400 bei fehlenden Notizen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { capture: true }, confirm_threshold_cents: 10_000,
  });
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#6366f1' });
  const cap = await agent.post(`/api/ai/meeting/${m.body.id}/capture`).send({ notes: '' });
  assert.equal(cap.status, 400);
});

test('AI Capture: apply_now legt Topics und Todos an', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { capture: true }, confirm_threshold_cents: 10_000,
  });
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#6366f1' });

  const apply = await agent.post(`/api/ai/meeting/${m.body.id}/capture`).send({
    apply_now: {
      new_topics: [{ title: 'Neues Thema', description: 'beschrieben' }],
      new_todos:  [{ title: 'Neues Todo' }],
      topic_results: [],
      theme_links: [],
    },
  });
  assert.equal(apply.status, 200);
  assert.equal(apply.body.created.topics.length, 1);
  assert.equal(apply.body.created.todos.length, 1);

  const meetingsAfter = await agent.get('/api/meetings');
  assert.equal(meetingsAfter.body[0].topics.length, 1);
  const todosAfter = await agent.get('/api/todos');
  assert.equal(todosAfter.body.length, 1);
});

test('AI Capture: apply_now IDOR — verknüpft KEIN fremdes Todo/Topic über theme_links', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const adminAgent = await login(request, app, admin.username, admin.password);
  await adminAgent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-AAAA',
    features_enabled: { capture: true }, confirm_threshold_cents: 10_000,
  });

  // Opfer: eigenes Todo, das NICHT verknüpft werden soll.
  const victimTodo = await adminAgent.post('/api/todos').send({ title: 'Fremdes Todo' });
  const victimTodoId = victimTodo.body.id;

  // Angreifer: eigener User, eigenes Meeting + eigenes Theme.
  await adminAgent.post('/api/users').send({ username: 'attacker', password: 'attacker12345' });
  const attackerAgent = await login(request, app, 'attacker', 'attacker12345');
  const m = await attackerAgent.post('/api/meetings').send({ title: 'Angreifer-Meeting', color: '#6366f1' });
  const theme = await attackerAgent.post('/api/themes').send({ title: 'Angreifer-Thema' });

  const apply = await attackerAgent.post(`/api/ai/meeting/${m.body.id}/capture`).send({
    apply_now: {
      new_topics: [], new_todos: [], topic_results: [],
      theme_links: [{ theme_id: theme.body.id, ref_type: 'todo', ref_id: victimTodoId }],
    },
  });
  assert.equal(apply.status, 200);
  assert.equal(apply.body.created.theme_links.length, 0, 'darf keinen Link auf fremdes Todo anlegen');

  const themes = await attackerAgent.get('/api/themes');
  const linked = themes.body.find(t => t.id === theme.body.id);
  assert.equal(linked.links.length, 0);
});

