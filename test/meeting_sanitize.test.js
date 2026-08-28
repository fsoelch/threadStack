'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('Meeting-Description wird wie Topics/Todos/Themes/Contacts serverseitig saniert', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);

  t.after(() => cleanup(dir));

  const agent = await login(request, app, admin.username, admin.password);

  const payload = '<p>Text</p><script>alert(1)</script><img src=x onerror="alert(2)">';

  // POST /api/meetings: description darf kein <script>/onerror ueberleben.
  const created = await agent.post('/api/meetings').send({
    title: 'Sanitize-Test', color: '#6366f1', description: payload,
  });
  assert.equal(created.status, 201);
  assert.ok(!created.body.description.includes('<script'), 'kein <script> in POST-Response');
  assert.ok(!/on\w+\s*=/i.test(created.body.description), 'kein Event-Handler-Attribut in POST-Response');
  assert.ok(created.body.description.includes('Text'), 'sichtbarer Text bleibt erhalten');

  const meetingId = created.body.id;

  // Auch direkt aus der DB gelesen darf kein <script> gespeichert sein
  // (nicht nur clientseitig weggefiltert).
  const stored = db.prepare('SELECT description FROM meetings WHERE id=?').get(meetingId);
  assert.ok(!stored.description.includes('<script'), 'kein <script> in der DB');
  assert.ok(!/on\w+\s*=/i.test(stored.description), 'kein Event-Handler-Attribut in der DB');

  // PUT /api/meetings/:id: gleiche Garantie beim Update.
  const updated = await agent.put(`/api/meetings/${meetingId}`).send({ description: payload });
  assert.equal(updated.status, 200);

  const storedAfterPut = db.prepare('SELECT description FROM meetings WHERE id=?').get(meetingId);
  assert.ok(!storedAfterPut.description.includes('<script'), 'kein <script> in der DB nach PUT');
  assert.ok(!/on\w+\s*=/i.test(storedAfterPut.description), 'kein Event-Handler-Attribut in der DB nach PUT');
});
