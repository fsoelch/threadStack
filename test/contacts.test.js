'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('Contacts: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const r = await request(app).get('/api/contacts');
  assert.equal(r.status, 401);
});

test('Contacts: CRUD-Flow', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  // GET leer
  const r0 = await agent.get('/api/contacts');
  assert.equal(r0.status, 200);
  assert.deepEqual(r0.body, []);

  // POST 400 ohne Name
  const r400 = await agent.post('/api/contacts').send({ name: '' });
  assert.equal(r400.status, 400);

  // POST 201
  const r1 = await agent.post('/api/contacts').send({
    name: 'Anna Müller',
    role: 'Projektleitung',
    email: 'anna@example.com',
    description: '<p>Asien-Region</p>',
  });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.name, 'Anna Müller');
  assert.equal(r1.body.role, 'Projektleitung');
  assert.equal(r1.body.email, 'anna@example.com');
  const id = r1.body.id;

  // GET liste mit 1
  const r2 = await agent.get('/api/contacts');
  assert.equal(r2.body.length, 1);
  assert.equal(r2.body[0].id, id);

  // PUT update
  const r3 = await agent.put(`/api/contacts/${id}`).send({
    name: 'Anna M.',
    role: 'Lead PM',
    email: 'anna.m@example.com',
    description: 'Region APAC',
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.name, 'Anna M.');
  assert.equal(r3.body.role, 'Lead PM');

  // PUT 404 fremd
  const r404 = await agent.put('/api/contacts/no-such').send({ name: 'X' });
  assert.equal(r404.status, 404);

  // DELETE
  const rd = await agent.delete(`/api/contacts/${id}`);
  assert.equal(rd.status, 200);

  // GET wieder leer
  const r4 = await agent.get('/api/contacts');
  assert.equal(r4.body.length, 0);
});

test('Contacts: reorder', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const a = await agent.post('/api/contacts').send({ name: 'A' });
  const b = await agent.post('/api/contacts').send({ name: 'B' });
  const c = await agent.post('/api/contacts').send({ name: 'C' });

  await agent.put('/api/contacts/reorder').send({ ids: [c.body.id, a.body.id, b.body.id] });

  const list = await agent.get('/api/contacts');
  assert.deepEqual(list.body.map(x => x.name), ['C', 'A', 'B']);
});
