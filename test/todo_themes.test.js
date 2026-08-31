'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('PUT /api/todos/:id/themes: manuelle Topic-Zuordnung fuer Todos', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);

  await t.test('setzt Topic-Zuordnung und liefert sie ueber /themes/:id/todos', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Projekt A' });
    const todo = await agent.post('/api/todos').send({ title: 'Aufgabe 1' });
    const r = await agent.put(`/api/todos/${todo.body.id}/themes`).send({ themeIds: [theme.body.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.appliedThemeIds, [theme.body.id]);
    assert.equal(r.body.droppedCount, 0);

    const list = await agent.get(`/api/themes/${theme.body.id}/todos`);
    assert.equal(list.status, 200);
    assert.ok(list.body.some(x => x.id === todo.body.id));
  });

  await t.test('ersetzt bestehende Zuordnung atomar (kein Anhaeufen alter Links)', async () => {
    const theme1 = await agent.post('/api/themes').send({ title: 'Topic X' });
    const theme2 = await agent.post('/api/themes').send({ title: 'Topic Y' });
    const todo = await agent.post('/api/todos').send({ title: 'Aufgabe 2' });
    await agent.put(`/api/todos/${todo.body.id}/themes`).send({ themeIds: [theme1.body.id] });
    const r2 = await agent.put(`/api/todos/${todo.body.id}/themes`).send({ themeIds: [theme2.body.id] });
    assert.deepEqual(r2.body.appliedThemeIds, [theme2.body.id]);

    const list1 = await agent.get(`/api/themes/${theme1.body.id}/todos`);
    assert.ok(!list1.body.some(x => x.id === todo.body.id));
    const list2 = await agent.get(`/api/themes/${theme2.body.id}/todos`);
    assert.ok(list2.body.some(x => x.id === todo.body.id));
  });

  await t.test('verwirft fremde/geloeschte Topic-IDs, liefert droppedCount', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Topic Z' });
    const todo = await agent.post('/api/todos').send({ title: 'Aufgabe 3' });
    const r = await agent.put(`/api/todos/${todo.body.id}/themes`).send({
      themeIds: [theme.body.id, 'ghost-id'],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.appliedThemeIds, [theme.body.id]);
    assert.equal(r.body.droppedCount, 1);
  });

  await t.test('leeres Array ist erlaubt (entfernt alle Zuordnungen)', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Topic W' });
    const todo = await agent.post('/api/todos').send({ title: 'Aufgabe 4' });
    await agent.put(`/api/todos/${todo.body.id}/themes`).send({ themeIds: [theme.body.id] });
    const r = await agent.put(`/api/todos/${todo.body.id}/themes`).send({ themeIds: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.appliedThemeIds, []);
  });

  await t.test('themeIds muss ein Array sein (400)', async () => {
    const todo = await agent.post('/api/todos').send({ title: 'Aufgabe 5' });
    const r = await agent.put(`/api/todos/${todo.body.id}/themes`).send({ themeIds: 'not-an-array' });
    assert.equal(r.status, 400);
  });

  await t.test('fremdes Todo liefert 404', async () => {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const otherId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
      .run(otherId, 'todo-thief-victim', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
    const foreignTodoId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO todos(id,user_id,title,description,due_date,is_private,snoozed_until,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(foreignTodoId, otherId, 'Fremde Aufgabe', '', '', 0, '', 0, new Date().toISOString());

    const r = await agent.put(`/api/todos/${foreignTodoId}/themes`).send({ themeIds: [] });
    assert.equal(r.status, 404);
  });

  await t.test('unauthentifiziert liefert 401', async () => {
    const anon = request.agent(app);
    const r = await anon.put('/api/todos/whatever/themes').send({ themeIds: [] });
    assert.equal(r.status, 401);
  });
});
