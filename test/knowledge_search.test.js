'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('Knowledge-Search: Laengenpruefung, Treffer/Snippet, Sonderzeichen, Nutzer-Isolation', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);

  await t.test('weniger als 2 Zeichen liefert sofort leeres Ergebnis ohne DB-Fehler', async () => {
    const r0 = await agent.get('/api/knowledge/search').query({ q: '' });
    assert.equal(r0.status, 200);
    assert.deepEqual(r0.body, { query: '', results: [] });

    const r1 = await agent.get('/api/knowledge/search').query({ q: 'a' });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body, { query: 'a', results: [] });

    const rSpace = await agent.get('/api/knowledge/search').query({ q: '  a  ' });
    assert.equal(rSpace.status, 200);
    assert.deepEqual(rSpace.body.results, []);
  });

  await t.test('Treffer mit Snippet und themeIds', async () => {
    const theme = await agent.post('/api/themes').send({ title: 'Mein Topic' });
    assert.equal(theme.status, 201);

    const page = await agent.post('/api/knowledge').send({
      title: 'Urlaubsplanung 2026',
      content: '<p>Diese Seite beschreibt die Urlaubsplanung fuer das Team im Jahr 2026 im Detail.</p>',
      themeIds: [theme.body.id],
    });
    assert.equal(page.status, 201);

    const r = await agent.get('/api/knowledge/search').query({ q: 'Urlaubsplanung' });
    assert.equal(r.status, 200);
    assert.equal(r.body.query, 'Urlaubsplanung');
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.results[0].id, page.body.id);
    assert.equal(r.body.results[0].title, 'Urlaubsplanung 2026');
    assert.ok(typeof r.body.results[0].snippet === 'string' && r.body.results[0].snippet.length > 0);

    // Keine SQLite-Match-Marker im Snippet (Hervorhebung uebernimmt das Frontend)
    const hasMarkup = /\[b\]/.test(r.body.results[0].snippet) || /<b>/.test(r.body.results[0].snippet);
    assert.equal(hasMarkup, false);

    assert.deepEqual(r.body.results[0].themeIds, [theme.body.id]);
  });

  await t.test('Sonderzeichen/Operatoren fuehren nie zu 500', async () => {
    const weird = ['"', '"" AND', 'foo OR', '---', 'NOT NOT', '((()))', 'a"b"c', '*', 'foo NEAR bar'];
    for (const q of weird) {
      const r = await agent.get('/api/knowledge/search').query({ q });
      assert.equal(r.status, 200, `q=${JSON.stringify(q)} sollte nie 500 liefern`);
      assert.ok(Array.isArray(r.body.results));
    }
  });

  await t.test('Kein Ergebnis fuer Seiten anderer Nutzer', async () => {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const otherId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
      .run(otherId, 'other-searcher', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
    const otherPageId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO knowledge_pages(id,user_id,title,content,content_text,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(otherPageId, otherId, 'GeheimesStichwortXYZ', '<p>GeheimesStichwortXYZ</p>', 'GeheimesStichwortXYZ', 0, now, now);
    db.prepare("INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', ?, ?, ?, ?)")
      .run(otherPageId, otherId, 'GeheimesStichwortXYZ', 'GeheimesStichwortXYZ');

    const r = await agent.get('/api/knowledge/search').query({ q: 'GeheimesStichwortXYZ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 0);
  });
});
