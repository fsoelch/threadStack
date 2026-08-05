'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('Knowledge: themeIds optional (A3), fremde/geloeschte Topics werden verworfen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);

  await t.test('POST /api/knowledge ohne themeIds funktioniert (leeres Array default)', async () => {
    const r = await agent.post('/api/knowledge').send({ title: 'Ohne Topic', content: '<p>x</p>' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.themeIds, []);
    assert.deepEqual(r.body.relatedPageIds, []);
  });

  await t.test('POST /api/knowledge mit themeIds:[] funktioniert explizit', async () => {
    const r = await agent.post('/api/knowledge').send({ title: 'Explizit leer', content: '', themeIds: [] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.themeIds, []);
  });

  await t.test('Fremdes/nicht existierendes Topic in themeIds wird stillschweigend verworfen (kein 400)', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Echtes Topic' });
    assert.equal(theme.status, 201);

    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const otherId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
      .run(otherId, 'topic-thief-victim', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
    const foreignThemeId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO themes(id,user_id,title,description,sort_order,created_at) VALUES (?,?,?,?,?,?)')
      .run(foreignThemeId, otherId, 'Fremdes Topic', '', 0, new Date().toISOString());

    const r = await agent.post('/api/knowledge').send({
      title: 'Gemischt',
      content: '',
      themeIds: [theme.body.id, foreignThemeId, 'does-not-exist-at-all'],
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.themeIds, [theme.body.id]);
  });

  await t.test('PUT /api/knowledge/:id/themes verwirft fremde/geloeschte IDs, liefert droppedCount', async () => {
    const theme1 = await agent.post('/api/themes').send({ title: 'Topic 1' });
    const theme2 = await agent.post('/api/themes').send({ title: 'Topic 2' });
    const page = await agent.post('/api/knowledge').send({ title: 'Seite', content: '', themeIds: [theme1.body.id] });
    assert.equal(page.status, 201);

    // delete theme2 so it no longer exists -> should be silently dropped
    const del = await agent.delete(`/api/themes/${theme2.body.id}`);
    assert.equal(del.status, 200);

    const r = await agent.put(`/api/knowledge/${page.body.id}/themes`).send({
      themeIds: [theme1.body.id, theme2.body.id, 'ghost-id'],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.appliedThemeIds, [theme1.body.id]);
    assert.equal(r.body.droppedCount, 2);
  });

  await t.test('PUT /api/knowledge/:id/themes mit leerem Array ist erlaubt', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Topic 3' });
    const page = await agent.post('/api/knowledge').send({ title: 'Seite 2', content: '', themeIds: [theme.body.id] });
    const r = await agent.put(`/api/knowledge/${page.body.id}/themes`).send({ themeIds: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.appliedThemeIds, []);
    assert.equal(r.body.droppedCount, 0);
  });

  await t.test('GET /api/knowledge?themeId= filtert weiterhin korrekt', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Filter-Topic' });
    const page = await agent.post('/api/knowledge').send({ title: 'Gefiltert', content: '', themeIds: [theme.body.id] });
    assert.equal(page.status, 201);

    const list = await agent.get('/api/knowledge').query({ themeId: theme.body.id });
    assert.equal(list.status, 200);
    assert.ok(list.body.some(p => p.id === page.body.id));
  });
});
