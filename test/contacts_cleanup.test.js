'use strict';
// Arbeitspaket B4 ("Server-Integration"): verifiziert, dass die
// bestehenden Löschpfade (DELETE /todos/:id, DELETE /meetings/:id/topics/:tid,
// DELETE /meetings/:id, DELETE /contacts/:id) nach der Verdrahtung von
// assignments.deleteForRefs()/deleteForContact() keine verwaisten Zeilen in
// contact_assignments, progress_entries, theme_links oder search_index
// zurücklassen.
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

function countAssignments(db, refType, refId) {
  return db.prepare('SELECT COUNT(*) AS c FROM contact_assignments WHERE ref_type=? AND ref_id=?').get(refType, refId).c;
}
function countProgress(db, refType, refId) {
  return db.prepare('SELECT COUNT(*) AS c FROM progress_entries WHERE ref_type=? AND ref_id=?').get(refType, refId).c;
}
function countThemeLinks(db, refType, refId) {
  return db.prepare('SELECT COUNT(*) AS c FROM theme_links WHERE ref_type=? AND ref_id=?').get(refType, refId).c;
}
function countSearchIndex(db, refType, refId) {
  return db.prepare('SELECT COUNT(*) AS c FROM search_index WHERE ref_type=? AND ref_id=?').get(refType, refId).c;
}

test('DELETE /api/todos/:id raeumt contact_assignments, progress_entries, theme_links und search_index auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Grit Lehmann' });
  const contactId = contactRes.body.id;
  const todoRes = await agent.post('/api/todos').send({ title: 'Aufraeum-Todo', description: 'x' });
  const todoId = todoRes.body.id;

  await agent.put(`/api/assignments/todo/${todoId}`).send({ contactIds: [contactId] });
  await agent.post(`/api/progress/todo/${todoId}/entries`).send({ body: '<p>Zwischenstand</p>' });
  const themeRes = await agent.post('/api/themes').send({ title: 'Theme-für-Todo' });
  await agent.post(`/api/themes/${themeRes.body.id}/links`).send({ refType: 'todo', refId: todoId });

  assert.ok(countAssignments(db, 'todo', todoId) > 0);
  assert.ok(countProgress(db, 'todo', todoId) > 0);
  assert.ok(countThemeLinks(db, 'todo', todoId) > 0);
  assert.ok(countSearchIndex(db, 'todo', todoId) > 0);

  const delRes = await agent.delete(`/api/todos/${todoId}`);
  assert.equal(delRes.status, 200);

  assert.equal(countAssignments(db, 'todo', todoId), 0, 'contact_assignments darf keine verwaiste Zeile behalten');
  assert.equal(countProgress(db, 'todo', todoId), 0, 'progress_entries darf keine verwaiste Zeile behalten');
  assert.equal(countThemeLinks(db, 'todo', todoId), 0, 'theme_links darf keine verwaiste Zeile behalten');
  assert.equal(countSearchIndex(db, 'todo', todoId), 0, 'search_index darf keine verwaiste Zeile behalten');

  // Der Kontakt selbst bleibt unberührt (nur die Zuordnung wurde entfernt).
  const contactStill = await agent.get(`/api/contacts/${contactId}`);
  assert.equal(contactStill.status, 200);
});

test('DELETE /api/meetings/:id/topics/:tid raeumt contact_assignments, progress_entries, theme_links und search_index auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Hans Weiss' });
  const contactId = contactRes.body.id;
  const meetingRes = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const meetingId = meetingRes.body.id;
  const topicRes = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Topic' });
  const topicId = topicRes.body.id;

  await agent.put(`/api/assignments/topic/${topicId}`).send({ contactIds: [contactId] });
  await agent.post(`/api/progress/topic/${topicId}/entries`).send({ body: '<p>Notiz</p>' });
  const themeRes = await agent.post('/api/themes').send({ title: 'Theme-für-Topic' });
  await agent.post(`/api/themes/${themeRes.body.id}/links`).send({ refType: 'topic', refId: topicId });

  assert.ok(countAssignments(db, 'topic', topicId) > 0);
  assert.ok(countProgress(db, 'topic', topicId) > 0);
  assert.ok(countThemeLinks(db, 'topic', topicId) > 0);
  assert.ok(countSearchIndex(db, 'topic', topicId) > 0);

  const delRes = await agent.delete(`/api/meetings/${meetingId}/topics/${topicId}`);
  assert.equal(delRes.status, 200);

  assert.equal(countAssignments(db, 'topic', topicId), 0);
  assert.equal(countProgress(db, 'topic', topicId), 0);
  assert.equal(countThemeLinks(db, 'topic', topicId), 0);
  assert.equal(countSearchIndex(db, 'topic', topicId), 0);
});

test('DELETE /api/meetings/:id (Cascade auf Topics) raeumt contact_assignments und progress_entries fuer ALLE Topics des Meetings auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Ines Fuchs' });
  const contactId = contactRes.body.id;
  const meetingRes = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const meetingId = meetingRes.body.id;
  const topic1 = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'T1' });
  const topic2 = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'T2' });

  await agent.put(`/api/assignments/topic/${topic1.body.id}`).send({ contactIds: [contactId] });
  await agent.put(`/api/assignments/topic/${topic2.body.id}`).send({ contactIds: [contactId] });
  await agent.post(`/api/progress/topic/${topic1.body.id}/entries`).send({ body: '<p>N1</p>' });
  await agent.post(`/api/progress/topic/${topic2.body.id}/entries`).send({ body: '<p>N2</p>' });

  assert.ok(countAssignments(db, 'topic', topic1.body.id) > 0);
  assert.ok(countAssignments(db, 'topic', topic2.body.id) > 0);

  const delRes = await agent.delete(`/api/meetings/${meetingId}`);
  assert.equal(delRes.status, 200);

  assert.equal(countAssignments(db, 'topic', topic1.body.id), 0);
  assert.equal(countAssignments(db, 'topic', topic2.body.id), 0);
  assert.equal(countProgress(db, 'topic', topic1.body.id), 0);
  assert.equal(countProgress(db, 'topic', topic2.body.id), 0);
});

test('DELETE /api/contacts/:id raeumt zugehoerige Zuordnungen (contact_assignments) und Kontakt-Notizen (progress_entries ref_type=contact) ueber onContactDeleted auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Jonas Richter' });
  const contactId = contactRes.body.id;
  const todoRes = await agent.post('/api/todos').send({ title: 'Todo' });
  const todoId = todoRes.body.id;

  await agent.put(`/api/assignments/todo/${todoId}`).send({ contactIds: [contactId] });
  await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Kontakt-Notiz</p>' });

  assert.ok(countAssignments(db, 'todo', todoId) > 0);
  assert.ok(countProgress(db, 'contact', contactId) > 0);
  assert.ok(countSearchIndex(db, 'contact', contactId) > 0);

  const delRes = await agent.delete(`/api/contacts/${contactId}`);
  assert.equal(delRes.status, 200);

  assert.equal(countAssignments(db, 'todo', todoId), 0, 'Zuordnung des gelöschten Kontakts darf nicht verwaist zurückbleiben');
  assert.equal(countProgress(db, 'contact', contactId), 0, 'Kontakt-Notizen (progress_entries) müssen über onContactDeleted aufgeräumt werden');
  assert.equal(countSearchIndex(db, 'contact', contactId), 0, 'search_index-Eintrag des Kontakts muss verschwunden sein');

  // Das Todo selbst existiert weiterhin, nur die Zuordnung ist weg.
  const todoStill = await agent.get('/api/todos');
  assert.ok(todoStill.body.some((x) => x.id === todoId));
  assert.deepEqual(todoStill.body.find((x) => x.id === todoId).contacts, []);
});

test('purgeContactOrphans/purgeAssignmentOrphans beim Serverstart raeumen bereits vorhandene Karteileichen defensiv auf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Karl Otto' });
  const contactId = contactRes.body.id;
  const todoRes = await agent.post('/api/todos').send({ title: 'Wird hart geloescht' });
  const todoId = todoRes.body.id;
  await agent.put(`/api/assignments/todo/${todoId}`).send({ contactIds: [contactId] });

  // Direktes Löschen am Todo vorbei (simuliert einen Datenreparatur-Fall /
  // eine Inkonsistenz, die NICHT über den normalen DELETE-Pfad entstanden ist).
  db.prepare('DELETE FROM todos WHERE id=?').run(todoId);
  assert.ok(countAssignments(db, 'todo', todoId) > 0, 'Vorbedingung: verwaiste Zuordnung existiert vor dem Neustart');

  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server.js') || k.includes('/ai/')) delete require.cache[k];
  }
  db.close();
  const restarted = loadServer(REPO_ROOT);
  assert.equal(countAssignments(restarted.db, 'todo', todoId), 0, 'purgeAssignmentOrphans muss die verwaiste Zuordnung beim Neustart entfernen');
});
