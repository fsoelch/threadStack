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
const progressLib    = require('../lib/progress');
const archiveLib     = require('../lib/archive');
const contactsLib    = require('../lib/contacts');
const assignmentsLib = require('../lib/contacts/assignments');

// Vergleicht die tatsächliche CREATE-TABLE-Anweisung aus sqlite_master statt
// nur Spaltennamen/-typen (PRAGMA table_info) - andernfalls sind CHECK-
// Constraints (z.B. der ref_type-CHECK auf progress_entries) für den
// Warmstart-Vergleich unsichtbar (Code-Review-Fund "Mittel #3").
function schemaSql(db, name) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row ? row.sql : null;
}

// Namensmenge aller Trigger - macht einen Verlust/eine Veränderung von
// Triggern (z.B. trg_cnote_*, trg_cib_*) zwischen zwei Serverstarts sichtbar,
// was ein reiner Spalten-Vergleich nicht könnte (Code-Review-Fund "Mittel #3").
function triggerNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
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

test('Kaltstart: GET /api/meetings reichert Topics ebenfalls mit zugewiesenen Kontakten an (contactsForRefs, gemessen: genau EIN contact_assignments-Statement für die gesamte Liste)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const contactRes = await agent.post('/api/contacts').send({ name: 'Bert Schmidt' });
  const contactId = contactRes.body.id;

  // Zwei Meetings mit je einem Topic - mehrere Refs, damit ein N+1-Zugriff
  // (eine Query PRO Topic statt einer gebatchten Query) überhaupt sichtbar
  // werden könnte.
  const meetingRes = await agent.post('/api/meetings').send({ title: 'Sync', color: '#4f46e5' });
  const meetingId = meetingRes.body.id;
  const topicRes = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Budget' });
  const topicId = topicRes.body.id;
  assert.deepEqual(topicRes.body.contacts, [], 'Neuanlage: contacts-Feld muss leer, aber vorhanden sein');
  await agent.put(`/api/assignments/topic/${topicId}`).send({ contactIds: [contactId] });

  const meeting2Res = await agent.post('/api/meetings').send({ title: 'Sync 2', color: '#4f46e5' });
  const meeting2Id = meeting2Res.body.id;
  const topic2Res = await agent.post(`/api/meetings/${meeting2Id}/topics`).send({ title: 'Roadmap' });
  const topic2Id = topic2Res.body.id;
  await agent.put(`/api/assignments/topic/${topic2Id}`).send({ contactIds: [contactId] });

  // db.prepare() für die Dauer des GET-Requests umhüllen und die Anzahl der
  // Statements zählen, deren SQL-Text `contact_assignments` referenziert
  // (contactsForRefs() ist die einzige Stelle, die dort liest).
  const originalPrepare = db.prepare.bind(db);
  let contactAssignmentsStatementCount = 0;
  db.prepare = (sql, ...rest) => {
    if (typeof sql === 'string' && sql.includes('contact_assignments')) {
      contactAssignmentsStatementCount += 1;
    }
    return originalPrepare(sql, ...rest);
  };
  let meetingsList;
  try {
    meetingsList = await agent.get('/api/meetings');
  } finally {
    db.prepare = originalPrepare;
  }

  assert.equal(
    contactAssignmentsStatementCount, 1,
    'GET /api/meetings darf für die Kontakt-Anreicherung nur EIN gebatchtes contact_assignments-Statement vorbereiten (kein N+1 pro Topic)'
  );

  const meeting = meetingsList.body.find((m) => m.id === meetingId);
  const topic = meeting.topics.find((x) => x.id === topicId);
  assert.equal(topic.contacts.length, 1);
  assert.equal(topic.contacts[0].contactId, contactId);

  const meeting2 = meetingsList.body.find((m) => m.id === meeting2Id);
  const topic2 = meeting2.topics.find((x) => x.id === topic2Id);
  assert.equal(topic2.contacts.length, 1);
  assert.equal(topic2.contacts[0].contactId, contactId);
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
    contacts: schemaSql(db, 'contacts'),
    contact_categories: schemaSql(db, 'contact_categories'),
    contact_info_blocks: schemaSql(db, 'contact_info_blocks'),
    contact_assignments: schemaSql(db, 'contact_assignments'),
    progress_entries: schemaSql(db, 'progress_entries'),
  };
  const triggers1 = triggerNames(db);

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
    contacts: schemaSql(db, 'contacts'),
    contact_categories: schemaSql(db, 'contact_categories'),
    contact_info_blocks: schemaSql(db, 'contact_info_blocks'),
    contact_assignments: schemaSql(db, 'contact_assignments'),
    progress_entries: schemaSql(db, 'progress_entries'),
  };
  assert.deepEqual(snap2, snap1, 'Schema (inkl. CHECK-Constraints) muss nach dem zweiten Start identisch sein (kein doppelter Rebuild)');
  assert.deepEqual(
    triggerNames(db), triggers1,
    'Trigger-Menge (inkl. trg_cnote_*/trg_cib_*) muss nach dem zweiten Start identisch sein'
  );

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

test('Bestandsupgrade: Alt-Installation (progress_entries ohne "contact" im CHECK, gefüllte contacts.description, fehlende trg_cnote_*-Trigger) wird durch die volle Migrationskette korrekt nachgezogen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  // Kontakt über den regulären, bereits voll migrierten Endpunkt anlegen.
  const contactRes = await agent.post('/api/contacts').send({ name: 'Gerda Holt' });
  assert.equal(contactRes.status, 201);
  const contactId = contactRes.body.id;

  // ── Künstlich auf Alt-Schema zurückbauen ────────────────────────
  // WICHTIG: legacy_alter_table=ON VOR dem Rebuild setzen - sonst scheitert
  // das abschließende `ALTER TABLE ... RENAME`, weil trg_cib_ai (auf
  // contact_info_blocks) in seinem SQL-Text bereits auf `progress_entries`
  // verweist (die includeNotes-Formel) und SQLite mit legacy_alter_table=OFF
  // versucht, Referenzen in ANDEREN Schema-Objekten beim Rename automatisch
  // nachzuziehen - was in der kurzen Zwischenphase (Tabelle bereits
  // gedroppt, neue noch nicht umbenannt) mit "no such table:
  // main.progress_entries" fehlschlägt.
  const priorForeignKeys = db.pragma('foreign_keys', { simple: true });
  const priorLegacyAlterTable = db.pragma('legacy_alter_table', { simple: true });
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    const downgrade = db.transaction(() => {
      // trg_cnote_*-Trigger droppen (Alt-Installation kannte ref_type='contact'
      // noch nicht, also auch keine Kontakt-Notiz-Trigger).
      db.exec(`
        DROP TRIGGER IF EXISTS trg_cnote_ai;
        DROP TRIGGER IF EXISTS trg_cnote_au;
        DROP TRIGGER IF EXISTS trg_cnote_ad;
      `);
      // progress_entries ohne 'contact' im ref_type-CHECK neu aufbauen
      // (Umkehrung von migrateProgressRefTypeContact, siehe lib/progress/schema.js).
      db.exec(`
        CREATE TABLE progress_entries_old (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ref_type      TEXT NOT NULL CHECK (ref_type IN ('todo','topic')),
          ref_id        TEXT NOT NULL,
          kind          TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','result')),
          source        TEXT NOT NULL DEFAULT 'manual',
          body_html     TEXT NOT NULL DEFAULT '',
          body_text     TEXT NOT NULL DEFAULT '',
          link_frame_id TEXT,
          client_token  TEXT,
          created_at    TEXT NOT NULL,
          edited_at     TEXT
        );
        INSERT INTO progress_entries_old
          (id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at)
          SELECT id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at
          FROM progress_entries;
        DROP TABLE progress_entries;
        ALTER TABLE progress_entries_old RENAME TO progress_entries;
        CREATE INDEX idx_progress_entries_ref  ON progress_entries(ref_type, ref_id, created_at DESC);
        CREATE INDEX idx_progress_entries_user ON progress_entries(user_id, created_at DESC);
        CREATE UNIQUE INDEX idx_progress_entries_token
          ON progress_entries(user_id, client_token) WHERE client_token IS NOT NULL;
        CREATE UNIQUE INDEX idx_progress_result_frame
          ON progress_entries(link_frame_id) WHERE kind='result';
      `);
      // Gefüllte Alt-`description` (direkter SQL-Zugriff, bewusst AM
      // Contact-CRUD-Endpunkt vorbei - der würde `description` sofort selbst
      // in einen Infoblock konvertieren, siehe lib/contacts/routes.js. Genau
      // dieser noch-nicht-migrierte Zustand soll hier simuliert werden).
      db.prepare('UPDATE contacts SET description=? WHERE id=?').run('<p>Alte Zustaendigkeits-Notiz</p>', contactId);
    });
    downgrade();
  } finally {
    db.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`);
    db.pragma(`legacy_alter_table = ${priorLegacyAlterTable ? 'ON' : 'OFF'}`);
  }

  // Alt-Zustand verifizieren, bevor die Migrationskette erneut läuft.
  assert.ok(!schemaSql(db, 'progress_entries').includes("'contact'"), 'Testaufbau: CHECK darf vor dem Upgrade kein "contact" enthalten');
  assert.ok(!triggerNames(db).includes('trg_cnote_ai'), 'Testaufbau: trg_cnote_-Trigger dürfen vor dem Upgrade nicht existieren');

  // ── Komplette Migrationskette erneut in der server.js-Reihenfolge aufrufen ──
  progressLib.runProgressMigrations(db);
  progressLib.migrateProgressRefTypeContact(db);
  progressLib.purgeProgressOrphans(db);
  progressLib.dropProgressGoal(db);
  archiveLib.runArchiveMigrations(db);
  archiveLib.purgeArchiveOrphans(db);
  contactsLib.runContactMigrations(db);
  assignmentsLib.runAssignmentMigrations(db);
  contactsLib.migrateContactDescriptions(db, { now: () => new Date() });
  contactsLib.ensureContactNoteTriggers(db);
  contactsLib.purgeContactOrphans(db);
  assignmentsLib.purgeAssignmentOrphans(db);

  // 1) CHECK enthält wieder 'contact'.
  assert.ok(schemaSql(db, 'progress_entries').includes("'contact'"), 'ref_type-CHECK muss nach dem Upgrade wieder "contact" enthalten');

  // 2) Alle drei trg_cnote_*-Trigger existieren wieder.
  const triggersAfter = triggerNames(db);
  for (const name of ['trg_cnote_ai', 'trg_cnote_au', 'trg_cnote_ad']) {
    assert.ok(triggersAfter.includes(name), `${name} muss nach dem Upgrade existieren`);
  }

  // 3) Der Legacy-Infoblock wurde aus der alten description angelegt.
  const legacyBlock = db.prepare(
    'SELECT body_text, is_legacy_description FROM contact_info_blocks WHERE contact_id=? AND is_legacy_description=1'
  ).get(contactId);
  assert.ok(legacyBlock, 'Legacy-Infoblock muss aus contacts.description angelegt worden sein');
  assert.match(legacyBlock.body_text, /Alte Zustaendigkeits-Notiz/);
  const contactRow = db.prepare('SELECT description FROM contacts WHERE id=?').get(contactId);
  assert.equal(contactRow.description, '', 'contacts.description muss nach der Migration geleert sein');

  // 4) Eine neue Kontakt-Notiz landet korrekt in search_text.
  const noteRes = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Frisch nach dem Upgrade</p>' });
  assert.equal(noteRes.status, 201, `Kontakt-Notiz muss nach dem Upgrade anlegbar sein: ${JSON.stringify(noteRes.body)}`);
  const contactSearchRow = db.prepare('SELECT search_text FROM contacts WHERE id=?').get(contactId);
  assert.match(contactSearchRow.search_text, /Frisch nach dem Upgrade/);
});
