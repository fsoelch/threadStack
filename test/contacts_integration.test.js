'use strict';
// Integrationstest für Arbeitspaket B4 ("Server-Integration" der
// Ansprechpartner-Erweiterung): verdrahtet drei parallel entwickelte
// Backend-Pakete (B1 Kontakt-Datenmodell, B2 Zwischenstand-Erweiterung um
// ref_type='contact', B3 Kontakt-Zuständigkeiten) in server.js. Dieser Test
// prüft die END-ZU-ENDE-Wirkung der in server.js vorgenommenen Migrations-
// Reihenfolge und Router-Verdrahtung - NICHT die einzelnen Module isoliert
// (dafür existieren bereits test/contact_*.test.js, test/contact_assignments_
// *.test.js, test/progress_contact_*.test.js).
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

function tableInfo(db, name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map(c => `${c.name}:${c.type}`).sort().join(',');
}

test('Kaltstart: Migrationsreihenfolge greift - Kontakte, Rubriken, Kontakt-Notizen (progress ref_type=contact) und Zuständigkeiten sind ab dem ersten Start nutzbar', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  // 1) Kontakt anlegen (neuer, router-basierter Endpunkt aus lib/contacts).
  const contactRes = await agent.post('/api/contacts').send({ name: 'Anna Müller', role: 'PM', email: 'anna@example.com' });
  assert.equal(contactRes.status, 201);
  const contactId = contactRes.body.id;

  // 2) Rubriken (contact_categories) wurden von runContactMigrations/
  // ensureDefaultCategories bereits nutzbar angelegt.
  const categoriesRes = await agent.get('/api/contact-categories');
  assert.equal(categoriesRes.status, 200);
  assert.ok(Array.isArray(categoriesRes.body.categories) && categoriesRes.body.categories.length > 0, 'Default-Rubriken müssen ab dem ersten Start existieren');

  // 3) progress_entries erlaubt ref_type='contact' (B2-Migration
  // migrateProgressRefTypeContact muss VOR contacts.runContactMigrations
  // gelaufen sein, siehe server.js-Kommentar zur Migrationsreihenfolge).
  const noteRes = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Erstkontakt hergestellt</p>' });
  assert.equal(noteRes.status, 201, `Kontakt-Notiz muss anlegbar sein (CHECK-Constraint muss 'contact' bereits enthalten): ${JSON.stringify(noteRes.body)}`);

  // 4) Kontakt-Zuständigkeiten (contact_assignments referenziert contacts(id)
  // - setzt voraus, dass assignments.runAssignmentMigrations NACH
  // contacts.runContactMigrations gelaufen ist).
  const todoRes = await agent.post('/api/todos').send({ title: 'Angebot nachfassen' });
  const todoId = todoRes.body.id;
  assert.deepEqual(todoRes.body.contacts, [], 'Neuanlage: contacts-Feld muss leer, aber vorhanden sein');

  const assignRes = await agent.put(`/api/assignments/todo/${todoId}`).send({ contactIds: [contactId] });
  assert.equal(assignRes.status, 200);
  assert.equal(assignRes.body.contacts.length, 1);
  assert.equal(assignRes.body.contacts[0].contactId, contactId);

  // 5) GET /api/todos reichert das Todo mit den zugewiesenen Kontakten an
  // (contactsForRefs-Anreicherung, EIN Batch-Aufruf für die gesamte Liste).
  const listRes = await agent.get('/api/todos');
  const todoInList = listRes.body.find((x) => x.id === todoId);
  assert.ok(todoInList, 'Todo muss in der Liste auftauchen');
  assert.equal(todoInList.contacts.length, 1);
  assert.equal(todoInList.contacts[0].contactId, contactId);
  assert.equal(todoInList.contacts[0].name, 'Anna Müller');
});

test('Kaltstart: GET /api/meetings reichert Topics ebenfalls mit zugewiesenen Kontakten an (contactsForRefs, kein N+1)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Bert Schmidt' });
  const contactId = contactRes.body.id;

  const meetingRes = await agent.post('/api/meetings').send({ title: 'Sync', color: '#4f46e5' });
  const meetingId = meetingRes.body.id;
  const topicRes = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Budget' });
  const topicId = topicRes.body.id;
  assert.deepEqual(topicRes.body.contacts, [], 'Neuanlage: contacts-Feld muss leer, aber vorhanden sein');

  const assignRes = await agent.put(`/api/assignments/topic/${topicId}`).send({ contactIds: [contactId] });
  assert.equal(assignRes.status, 200);

  const meetingsList = await agent.get('/api/meetings');
  const meeting = meetingsList.body.find((m) => m.id === meetingId);
  const topic = meeting.topics.find((x) => x.id === topicId);
  assert.equal(topic.contacts.length, 1);
  assert.equal(topic.contacts[0].contactId, contactId);
});

test('Topic->ToDo-Konvertierung nimmt Kontakt-Zuständigkeiten mit (moveAssignments-Wiring)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Carla Weber' });
  const contactId = contactRes.body.id;
  const meetingRes = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const topicRes = await agent.post(`/api/meetings/${meetingRes.body.id}/topics`).send({ title: 'Follow-up' });
  const topicId = topicRes.body.id;
  await agent.put(`/api/assignments/topic/${topicId}`).send({ contactIds: [contactId] });

  const moveRes = await agent.post(`/api/meetings/${meetingRes.body.id}/topics/${topicId}/move`).send({});
  assert.equal(moveRes.status, 200);
  assert.equal(moveRes.body.targetType, 'todo');
  const newTodoId = moveRes.body.newId;

  const afterRes = await agent.get(`/api/assignments/todo/${newTodoId}`);
  assert.equal(afterRes.status, 200);
  assert.equal(afterRes.body.contacts.length, 1, 'Zuständigkeit muss bei der Konvertierung auf das neue Todo übertragen werden');
  assert.equal(afterRes.body.contacts[0].contactId, contactId);

  // Am alten (jetzt gelöschten) Topic hängt keine Zuordnung mehr.
  const oldRes = await agent.get(`/api/assignments/topic/${topicId}`);
  assert.equal(oldRes.status, 404, 'Topic existiert nach der Konvertierung nicht mehr');
});

test('ToDo->Topic-Konvertierung (Verschieben in ein Meeting) nimmt Kontakt-Zuständigkeiten mit', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Dirk Novak' });
  const contactId = contactRes.body.id;
  const todoRes = await agent.post('/api/todos').send({ title: 'Persönliches Todo' });
  const todoId = todoRes.body.id;
  await agent.put(`/api/assignments/todo/${todoId}`).send({ contactIds: [contactId] });

  const meetingRes = await agent.post('/api/meetings').send({ title: 'Ziel-Meeting', color: '#4f46e5' });
  const moveRes = await agent.post(`/api/todos/${todoId}/move`).send({ targetMeetingId: meetingRes.body.id });
  assert.equal(moveRes.status, 200);
  const newTopicId = moveRes.body.newId;

  const afterRes = await agent.get(`/api/assignments/topic/${newTopicId}`);
  assert.equal(afterRes.status, 200);
  assert.equal(afterRes.body.contacts.length, 1);
  assert.equal(afterRes.body.contacts[0].contactId, contactId);
});

test('Story 9 (unveraendert): POST /api/themes/:id/links mit refType=contact funktioniert weiterhin und der Graph rendert den Kontakt-Knoten', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Eva Krüger' });
  const contactId = contactRes.body.id;
  const themeRes = await agent.post('/api/themes').send({ title: 'Projekt X' });
  const themeId = themeRes.body.id;

  const linkRes = await agent.post(`/api/themes/${themeId}/links`).send({ refType: 'contact', refId: contactId });
  assert.equal(linkRes.status, 201);
  assert.equal(linkRes.body.refType, 'contact');

  const graphRes = await agent.get('/api/graph');
  assert.equal(graphRes.status, 200);
  const contactNode = graphRes.body.nodes.find((n) => n.type === 'contact' && n.id === contactId);
  assert.ok(contactNode, 'Graph muss einen Kontakt-Knoten für den verlinkten Ansprechpartner enthalten');
});

test('Warmstart: zweiter Serverstart auf derselben DB ist idempotent (Schema unveraendert, kein Datenverlust, keine doppelten Default-Rubriken)', async (t) => {
  const dir = setupEnv();
  t.after(() => cleanup(dir));

  let { app, db } = loadServer(REPO_ROOT);
  let admin = ensureTestAdmin(db);
  let agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Fritz Bauer' });
  const contactId = contactRes.body.id;
  const todoRes = await agent.post('/api/todos').send({ title: 'Todo' });
  await agent.put(`/api/assignments/todo/${todoRes.body.id}`).send({ contactIds: [contactId] });
  await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Notiz vor Neustart</p>' });

  const categoriesBefore = await agent.get('/api/contact-categories');
  const categoryCountBefore = categoriesBefore.body.categories.length;

  const snap1 = {
    contacts: tableInfo(db, 'contacts'),
    contact_categories: tableInfo(db, 'contact_categories'),
    contact_info_blocks: tableInfo(db, 'contact_info_blocks'),
    contact_assignments: tableInfo(db, 'contact_assignments'),
    progress_entries: tableInfo(db, 'progress_entries'),
  };

  // Server "neu starten": Require-Cache leeren, DB schließen, erneut laden -
  // ABER denselben DATA_DIR behalten (siehe test/migrations.test.js-Muster).
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server.js') || k.includes('/ai/')) delete require.cache[k];
  }
  db.close();

  ({ app, db } = loadServer(REPO_ROOT));
  admin = ensureTestAdmin(db);
  agent = await login(request, app, admin.username, admin.password);

  const snap2 = {
    contacts: tableInfo(db, 'contacts'),
    contact_categories: tableInfo(db, 'contact_categories'),
    contact_info_blocks: tableInfo(db, 'contact_info_blocks'),
    contact_assignments: tableInfo(db, 'contact_assignments'),
    progress_entries: tableInfo(db, 'progress_entries'),
  };
  assert.deepEqual(snap2, snap1, 'Schema muss nach dem zweiten Start identisch sein (kein doppelter Rebuild)');

  // Daten sind erhalten geblieben.
  const contactAfter = await agent.get(`/api/contacts/${contactId}`);
  assert.equal(contactAfter.status, 200);
  assert.equal(contactAfter.body.contact.name, 'Fritz Bauer');

  const assignmentsAfter = await agent.get(`/api/contacts/${contactId}/assignments`);
  assert.equal(assignmentsAfter.status, 200);
  assert.equal(assignmentsAfter.body.items.length, 1, 'Zuständigkeit muss den Neustart überleben');

  // Keine doppelten Default-Rubriken durch einen erneuten ensureDefaultCategories-Aufruf.
  const categoriesAfter = await agent.get('/api/contact-categories');
  assert.equal(categoriesAfter.body.categories.length, categoryCountBefore, 'ensureDefaultCategories darf beim zweiten Start keine Duplikate anlegen');
});
