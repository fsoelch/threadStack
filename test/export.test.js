'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function buildFixture(agent) {
  const themeA = await agent.post('/api/themes').send({ title: 'Thema A' });
  const themeB = await agent.post('/api/themes').send({ title: 'Unterthema B', parentId: themeA.body.id });

  const pageWithImage = await agent.post('/api/knowledge').send({
    title: 'Seite mit Bild',
    content: `<p>Text</p><img src="data:image/png;base64,${PNG_1PX}" alt="Test">`,
    themeIds: [themeA.body.id],
  });
  const pageNoImage = await agent.post('/api/knowledge').send({
    title: 'Seite ohne Bild', content: '<p>Nur Text</p>', themeIds: [themeB.body.id],
  });
  await agent.post(`/api/knowledge/${pageWithImage.body.id}/links`).send({ targetId: pageNoImage.body.id });

  const todoOpen = await agent.post('/api/todos').send({ title: 'Offenes Todo', dueDate: '2026-08-15' });
  const todoDone = await agent.post('/api/todos').send({ title: 'Erledigtes Todo' });
  await agent.put(`/api/todos/${todoDone.body.id}`).send({ done: true, result: 'Fertig' });
  await agent.post(`/api/themes/${themeA.body.id}/links`).send({ refType: 'todo', refId: todoOpen.body.id });

  return { themeA: themeA.body, themeB: themeB.body, pageWithImage: pageWithImage.body, pageNoImage: pageNoImage.body, todoOpen: todoOpen.body, todoDone: todoDone.body };
}

test('Export: XML (both, mit Graph) enthält Themes, Seiten, Todos', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/xml/);
  assert.match(r.headers['content-disposition'], /attachment; filename\*=UTF-8''ThreadStack-Export-/);
  const xml = r.text;
  assert.match(xml, /<threadstackExport/);
  assert.match(xml, /<theme id="[^"]+" parentId="" title="Thema A">/);
  assert.match(xml, /<theme id="[^"]+" parentId="[^"]+" title="Unterthema B"\/>/);
  assert.match(xml, /<page id="[^"]+" title="Seite mit Bild"/);
  assert.match(xml, /<page id="[^"]+" title="Seite ohne Bild"/);
  assert.match(xml, /<relatedRef id="/);
  assert.match(xml, /<todo id="[^"]+" done="false" title="Offenes Todo"/);
  assert.match(xml, /<todo id="[^"]+" done="true" title="Erledigtes Todo"/);
  assert.match(xml, /data:image\/png;base64/);
});

test('Export: XML scope=todos&openOnly=1 enthält nur offene Todos', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=todos&openOnly=1&format=xml');
  assert.equal(r.status, 200);
  assert.match(r.text, /Offenes Todo/);
  assert.doesNotMatch(r.text, /Erledigtes Todo/);
  assert.doesNotMatch(r.text, /<themes>/); // Todos-Scope exportiert nie Themes
});

test('Export: XML scope=knowledge&graph=0 hat keine Themes/themeRefs', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=knowledge&graph=0&format=xml');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /<themes>/);
  assert.doesNotMatch(r.text, /themeRefs/);
  assert.match(r.text, /Seite mit Bild/);
  assert.match(r.text, /Seite ohne Bild/);
});

test('Export: DOCX ist ein gültiger ZIP-Container (PK-Magic-Number), Bild-Seite wirft nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=both&format=docx').buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(Buffer.isBuffer(r.body));
  assert.ok(r.body.length > 100);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');
});

test('Export: Ownership — zweiter User sieht nur eigene Daten', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const otherId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
    .run(otherId, 'other-user', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
  const otherAgent = await login(request, app, 'other-user', 'irrelevant123');

  const r = await otherAgent.get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /Thema A/);
  assert.doesNotMatch(r.text, /Seite mit Bild/);
  assert.doesNotMatch(r.text, /Offenes Todo/);
});

test('Export: Validierung — ungültiger scope/format -> 400', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const r1 = await agent.get('/api/export?scope=invalid&format=xml');
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'VALIDATION_FAILED');

  const r2 = await agent.get('/api/export?scope=both&format=invalid');
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'VALIDATION_FAILED');
});

test('Export: ohne Login -> 401', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));

  const r = await request(app).get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 401);
});
