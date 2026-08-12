'use strict';
// Arbeitspaket 7 (Farb-Persistenz: Sanitizer + Editor).
//
// Deckt zwei Wege ab, ueber die Farbe heute persistiert wird:
//   1. sanitizeKnowledgeHtml (lib/sanitize.js) - Allowlist-basiert, fuer
//      Wissensseiten-Content (knowledge_pages.content).
//   2. stripUnsafeHtml (server.js) - Blacklist-basiert, fuer Todos/Themes-
//      Beschreibungen; wird seit Paket 7 um normalizeInlineColorsInHtml()
//      ergaenzt, damit dieselbe Farbmenge gilt wie bei Wissensseiten.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { sanitizeKnowledgeHtml } = require('../lib/sanitize');
const { setupEnv, loadServer, cleanup, REPO_ROOT, bootstrapStackFixture } = require('./helpers');

test('sanitizeKnowledgeHtml: Farb-Allowlist (Unit)', async (t) => {
  await t.test('<span style="color:#hex"> bleibt inkl. Tag und Farbe erhalten', () => {
    const out = sanitizeKnowledgeHtml('<span style="color:#dc2626">x</span>');
    assert.ok(out.includes('<span'));
    assert.ok(out.includes('style="color:#dc2626"'));
    assert.ok(out.includes('x'));
  });

  await t.test('<font color="#hex"> wird zu <span style="color:#hex"> normalisiert und bleibt erhalten', () => {
    const out = sanitizeKnowledgeHtml('<font color="#dc2626">x</font>');
    assert.ok(!/<font/i.test(out));
    assert.ok(out.includes('<span'));
    assert.ok(out.includes('style="color:#dc2626"'));
    assert.ok(out.includes('x'));
  });

  await t.test('style="background-color:red" wird entfernt (kein background-color im Ergebnis)', () => {
    const out = sanitizeKnowledgeHtml('<p style="background-color:red">x</p>');
    assert.ok(!out.toLowerCase().includes('background-color'));
    assert.ok(out.includes('x'));
  });

  await t.test('style="color:red" (benannte CSS-Farbe) wird verworfen, Tag/Text bleiben', () => {
    const out = sanitizeKnowledgeHtml('<p style="color:red">x</p>');
    assert.ok(!out.includes('color:red'));
    assert.ok(out.includes('x'));
    assert.ok(out.includes('<p'));
  });

  await t.test('style="expression(alert(1))" wird vollstaendig entfernt', () => {
    const out = sanitizeKnowledgeHtml('<span style="expression(alert(1))">x</span>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.toLowerCase().includes('expression'));
    assert.ok(out.includes('x'));
  });

  await t.test('style="position:fixed;top:0" wird vollstaendig entfernt', () => {
    const out = sanitizeKnowledgeHtml('<div style="position:fixed;top:0">x</div>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.toLowerCase().includes('position'));
    assert.ok(out.includes('x'));
  });

  await t.test('<font color="javascript:alert(1)"> wird sicher entfernt/neutralisiert', () => {
    const out = sanitizeKnowledgeHtml('<font color="javascript:alert(1)">x</font>');
    assert.ok(!/<font/i.test(out));
    assert.ok(!out.toLowerCase().includes('javascript'));
    assert.ok(!out.includes('style='));
    assert.ok(out.includes('x'));
  });

  await t.test('style="color:red;background-image:url(http://evil.com/track.png)" - nur nicht-farbliche Teile werden verworfen, Tracking-URL verschwindet', () => {
    const out = sanitizeKnowledgeHtml('<p style="color:red;background-image:url(http://evil.com/track.png)">x</p>');
    assert.ok(!out.toLowerCase().includes('evil.com'));
    assert.ok(!out.toLowerCase().includes('background-image'));
    assert.ok(!out.includes('color:red'));
  });

  await t.test('style="background:url(javascript:alert(1))" wird vollstaendig entfernt', () => {
    const out = sanitizeKnowledgeHtml('<p style="background:url(javascript:alert(1))">x</p>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.toLowerCase().includes('javascript'));
  });

  await t.test('gueltige rgb()-Farbe bleibt erhalten', () => {
    const out = sanitizeKnowledgeHtml('<span style="color:rgb(220, 38, 38)">x</span>');
    assert.ok(/style="color:#[0-9a-f]{6}"/i.test(out));
  });

  await t.test('style ist nur fuer die vertraglich definierten Tags erlaubt (z.B. nicht fuer ul)', () => {
    const out = sanitizeKnowledgeHtml('<ul style="color:#dc2626"><li>x</li></ul>');
    assert.ok(!/<ul[^>]*style/i.test(out));
  });
});

test('stripUnsafeHtml (server.js, ueber Todo-API): Farb-Normalisierung + unveraenderte Blacklist', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, todoId } = await bootstrapStackFixture(request, app, db);

  await t.test('<font color="#hex"> wird in eine erhaltene Farbdarstellung umgewandelt', async () => {
    const r = await agent.put(`/api/todos/${todoId}`).send({
      description: '<font color="#2563eb">Text</font>',
    });
    assert.equal(r.status, 200);
    const todos = await agent.get('/api/todos');
    const desc = todos.body.find(x => x.id === todoId).description;
    assert.ok(!/<font/i.test(desc));
    assert.ok(desc.includes('#2563eb'));
    assert.ok(desc.includes('Text'));
  });

  await t.test('bestehende Blacklist-Regel bleibt wirksam: <script> wird weiterhin entfernt', async () => {
    const r = await agent.put(`/api/todos/${todoId}`).send({
      description: '<script>alert(1)</script><p>Rest bleibt</p>',
    });
    assert.equal(r.status, 200);
    const todos = await agent.get('/api/todos');
    const desc = todos.body.find(x => x.id === todoId).description;
    assert.ok(!/<script/i.test(desc));
    assert.ok(!desc.includes('alert(1)'));
    assert.ok(desc.includes('Rest bleibt'));
  });

  await t.test('bestehende Blacklist-Regel bleibt wirksam: on*-Attribute werden weiterhin entschaerft', async () => {
    const r = await agent.put(`/api/todos/${todoId}`).send({
      description: '<p onclick="doEvil()">Text</p>',
    });
    assert.equal(r.status, 200);
    const todos = await agent.get('/api/todos');
    const desc = todos.body.find(x => x.id === todoId).description;
    assert.ok(!/\bonclick\s*=/i.test(desc));
    assert.ok(desc.includes('Text'));
  });

  await t.test('style="background-color:red" wird ueber stripUnsafeHtml ebenfalls verworfen', async () => {
    const r = await agent.put(`/api/todos/${todoId}`).send({
      description: '<p style="background-color:red">Text</p>',
    });
    assert.equal(r.status, 200);
    const todos = await agent.get('/api/todos');
    const desc = todos.body.find(x => x.id === todoId).description;
    assert.ok(!desc.toLowerCase().includes('background-color'));
    assert.ok(desc.includes('Text'));
  });
});
