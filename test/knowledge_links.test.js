'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

async function makePage(agent, title) {
  const r = await agent.post('/api/knowledge').send({ title, content: '<p>x</p>', themeIds: [] });
  assert.equal(r.status, 201);
  return r.body;
}

test('Knowledge-Links: Anlegen, Idempotenz, Selbstverweis, fremde Seite, Löschen, Cascade', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);
  const pageA = await makePage(agent, 'Seite A');
  const pageB = await makePage(agent, 'Seite B');

  await t.test('Anlegen liefert 201 + created:true', async () => {
    const r = await agent.post(`/api/knowledge/${pageA.id}/links`).send({ targetId: pageB.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.created, true);
    assert.equal(r.body.page.id, pageB.id);
    assert.ok(r.body.linkId);
  });

  await t.test('Idempotenz: erneutes Anlegen liefert 200 + created:false, kein Duplikat', async () => {
    const r = await agent.post(`/api/knowledge/${pageA.id}/links`).send({ targetId: pageB.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);

    const list = await agent.get(`/api/knowledge/${pageA.id}/links`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
  });

  await t.test('Idempotenz gilt auch bei umgekehrter Reihenfolge (B->A statt A->B)', async () => {
    const r = await agent.post(`/api/knowledge/${pageB.id}/links`).send({ targetId: pageA.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
  });

  await t.test('Selbstverweis wird abgelehnt: 400 VALIDATION_FAILED', async () => {
    const r = await agent.post(`/api/knowledge/${pageA.id}/links`).send({ targetId: pageA.id });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_FAILED');
  });

  await t.test('Fremde/nicht existierende Seite: 404 NOT_FOUND, kein Auskunfts-Unterschied', async () => {
    const rForeign = await agent.post(`/api/knowledge/${pageA.id}/links`).send({ targetId: 'does-not-exist' });
    assert.equal(rForeign.status, 404);
    assert.equal(rForeign.body.code, 'NOT_FOUND');

    // Anderer Nutzer besitzt eine eigene Seite -> für admin-Agent ist sie "fremd"
    const other = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
    // Simulate a second user directly via DB (keeps this test self-contained, no extra admin route needed)
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const otherId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
      .run(otherId, 'other-user', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
    const foreignPageId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO knowledge_pages(id,user_id,title,content,content_text,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(foreignPageId, otherId, 'Fremde Seite', '', '', 0, new Date().toISOString(), new Date().toISOString());

    const rOwnedById = await agent.post(`/api/knowledge/${pageA.id}/links`).send({ targetId: foreignPageId });
    assert.equal(rOwnedById.status, 404);
    assert.equal(rOwnedById.body.code, 'NOT_FOUND');
    // Gleicher Fehlercode/Text wie bei nicht-existierender ID -> kein Existenz-Orakel
    assert.equal(rOwnedById.body.error, rForeign.body.error);
  });

  await t.test('POST auf fremde Quellseite (:id gehört nicht dem Nutzer) -> 404', async () => {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const foreignOwnerId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
      .run(foreignOwnerId, 'foreign-owner', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
    const foreignSourceId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO knowledge_pages(id,user_id,title,content,content_text,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(foreignSourceId, foreignOwnerId, 'Fremde Quelle', '', '', 0, new Date().toISOString(), new Date().toISOString());

    const r = await agent.post(`/api/knowledge/${foreignSourceId}/links`).send({ targetId: pageB.id });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NOT_FOUND');
  });

  await t.test('Löschen ist idempotent (auch wenn bereits weg)', async () => {
    const list = await agent.get(`/api/knowledge/${pageA.id}/links`);
    const linkId = list.body[0].linkId;

    const del1 = await agent.delete(`/api/knowledge/${pageA.id}/links/${linkId}`);
    assert.equal(del1.status, 200);
    assert.equal(del1.body.ok, true);

    const del2 = await agent.delete(`/api/knowledge/${pageA.id}/links/${linkId}`);
    assert.equal(del2.status, 200);
    assert.equal(del2.body.ok, true);

    const listAfter = await agent.get(`/api/knowledge/${pageA.id}/links`);
    assert.equal(listAfter.body.length, 0);
  });

  await t.test('DELETE eines fremden linkId (existiert, gehört aber nicht zu :id) -> 404', async () => {
    const pageC = await makePage(agent, 'Seite C');
    const pageD = await makePage(agent, 'Seite D');
    const link = await agent.post(`/api/knowledge/${pageC.id}/links`).send({ targetId: pageD.id });
    assert.equal(link.status, 201);

    // Try to delete this link via an unrelated page id
    const r = await agent.delete(`/api/knowledge/${pageA.id}/links/${link.body.linkId}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NOT_FOUND');
  });

  await t.test('Cascade-Delete: Löschen einer verlinkten Seite entfernt den Link', async () => {
    const pageE = await makePage(agent, 'Seite E');
    const pageF = await makePage(agent, 'Seite F');
    const link = await agent.post(`/api/knowledge/${pageE.id}/links`).send({ targetId: pageF.id });
    assert.equal(link.status, 201);

    const del = await agent.delete(`/api/knowledge/${pageE.id}`);
    assert.equal(del.status, 200);

    const remaining = db.prepare('SELECT COUNT(*) as c FROM knowledge_links WHERE id=?').get(link.body.linkId).c;
    assert.equal(remaining, 0);
  });
});
