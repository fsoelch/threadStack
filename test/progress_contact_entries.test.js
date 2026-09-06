'use strict';
// Arbeitspaket B2 (Ansprechpartner-Notizen): CRUD/Paging/Idempotenz/
// Owner-Check/next-step-Ablehnung für ref_type='contact' über den
// bestehenden, generischen Zwischenstand-Mechanismus (kein zweiter
// Mechanismus, siehe CLAUDE.md "Wiederverwendung vor Neuentwicklung").
//
// Aufbau bewusst analog zu test/progress_entries.test.js (gleiches Muster,
// gleiche Helfer-Konventionen), ergänzt um eine minimale `contacts`-Tabelle
// und den Aufruf von migrateProgressRefTypeContact() NACH runProgressMigrations()
// - exakt die Reihenfolge, die B4 beim Server-Wiring einhalten muss.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const Database = require('better-sqlite3');

const { createProgressRouter } = require('../lib/progress/routes');
const { runProgressMigrations, migrateProgressRefTypeContact } = require('../lib/progress/schema');
const { insertEntry, deleteForRefs, summaryFor, setNextStep } = require('../lib/progress/queries');

function buildTestApp({ getLatestFrameId, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-contact-entries-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  // Reihenfolge wie in server.js vorgesehen: erst die additive Basis-Migration,
  // dann die CHECK-Erweiterung um 'contact' (siehe Abschlussbericht B2).
  runProgressMigrations(db);
  migrateProgressRefTypeContact(db);
  db.prepare("INSERT INTO users VALUES ('test-user','test-user',datetime('now'))").run();
  db.prepare("INSERT INTO users VALUES ('other-user','other-user',datetime('now'))").run();

  const foreignIds = new Set();
  function ownsRef(uid, refType, refId) {
    if (uid !== 'test-user') return false;
    if (foreignIds.has(`${refType}:${refId}`)) return false;
    const row = refType === 'todo'
      ? db.prepare('SELECT 1 FROM todos WHERE id=?').get(refId)
      : refType === 'topic'
        ? db.prepare('SELECT 1 FROM topics WHERE id=?').get(refId)
        : refType === 'contact'
          ? db.prepare('SELECT 1 FROM contacts WHERE id=? AND user_id=?').get(refId, uid)
          : null;
    return !!row;
  }

  function requireAuth(req, res, next) {
    if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  }

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => {
    req.session.uid = req.body.uid || 'test-user';
    res.json({ ok: true });
  });
  app.use('/api/progress', createProgressRouter({ db, requireAuth, ownsRef, getLatestFrameId, now }));

  return { app, db, dir, foreignIds };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function loginAgent(app, uid = 'test-user') {
  const agent = request.agent(app);
  await agent.post('/test/login').send({ uid });
  return agent;
}

function makeContact(db, { id, userId = 'test-user', name = 'Ada Lovelace', description = '', createdAt } = {}) {
  const cid = id || crypto.randomBytes(6).toString('hex');
  const ts = createdAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts(id,user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)`
  ).run(cid, userId, name, description, ts, ts);
  return cid;
}

// ── CRUD ──────────────────────────────────────────────────────

test('GET /contact/:id: 200 mit leerem Detail-Payload fuer frischen Kontakt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/contact/${contactId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ref.title, 'Ada Lovelace');
  assert.equal(r.body.ref.done, false);
  assert.equal(r.body.ref.result, '');
  assert.equal(r.body.ref.resultDate, '');
  assert.equal(r.body.stats.entryCount, 0);
  assert.deepEqual(r.body.entries, []);
});

test('POST /contact/:id/entries: legt Zwischenstand an (201), GET liefert ihn zurueck', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const created = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Kennengelernt auf der Konferenz</p>' });
  assert.equal(created.status, 201);
  assert.equal(created.body.entry.refType, 'contact');
  assert.equal(created.body.entry.refId, contactId);
  assert.ok(/Kennengelernt/.test(created.body.entry.bodyHtml));
  assert.equal(created.body.stats.entryCount, 1);
  // summaryFor() muss fuer 'contact' generisch mitlaufen, damit "summary"
  // nicht undefined ist (Konsistenz zu todo/topic-Antworten).
  assert.ok(created.body.summary, 'summary sollte fuer contact vorhanden sein');
  assert.equal(created.body.summary.entryCount, 1);

  const list = await agent.get(`/api/progress/contact/${contactId}/entries`);
  assert.equal(list.status, 200);
  assert.equal(list.body.entries.length, 1);
  assert.equal(list.body.entries[0].id, created.body.entry.id);
});

test('PUT /entries/:id: bearbeitet Kontakt-Zwischenstand, editedAt wird gesetzt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const created = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>original</p>' });
  const entryId = created.body.entry.id;

  const updated = await agent.put(`/api/progress/entries/${entryId}`).send({ body: '<p>bearbeitet</p>' });
  assert.equal(updated.status, 200);
  assert.ok(/bearbeitet/.test(updated.body.entry.bodyHtml));
  assert.ok(updated.body.entry.editedAt, 'editedAt sollte gesetzt sein');
});

test('DELETE /entries/:id: loescht Kontakt-Zwischenstand', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const created = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>zu loeschen</p>' });
  const r = await agent.delete(`/api/progress/entries/${created.body.entry.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.stats.entryCount, 0);
});

test('POST /contact/:id/entries: nie 409 ref_done (Kontakte kennen keinen Erledigt-Zustand)', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>x</p>' });
  assert.equal(r.status, 201);
});

// ── Idempotenz (clientToken) ─────────────────────────────────

test('POST /contact/:id/entries: Idempotenz ueber clientToken', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const r1 = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Erster</p>', clientToken: 'tok-contact-1' });
  assert.equal(r1.status, 201);
  const r2 = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>Zweiter</p>', clientToken: 'tok-contact-1' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.idempotent, true);
  assert.equal(r2.body.entry.id, r1.body.entry.id);

  const count = db.prepare('SELECT COUNT(*) AS c FROM progress_entries WHERE ref_id=?').get(contactId).c;
  assert.equal(count, 1);
});

// ── Paging ────────────────────────────────────────────────────

test('GET /contact/:id/entries: Cursor-Pagination funktioniert wie bei todo/topic', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const timestamps = ['2026-01-01T09:00:00.000Z', '2026-01-02T09:00:00.000Z', '2026-01-03T09:00:00.000Z'];
  for (const ts of timestamps) {
    insertEntry(db, {
      userId: 'test-user', refType: 'contact', refId: contactId, kind: 'note', source: 'manual',
      bodyHtml: `<p>${ts}</p>`, bodyText: ts, linkFrameId: null, clientToken: null, nowIso: ts,
    });
  }

  const page1 = await agent.get(`/api/progress/contact/${contactId}/entries?limit=2`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.entries.length, 2);
  assert.equal(page1.body.page.hasMore, true);
  assert.ok(page1.body.page.nextCursor);

  const page2 = await agent.get(`/api/progress/contact/${contactId}/entries?limit=2&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`);
  assert.equal(page2.status, 200);
  assert.equal(page2.body.entries.length, 1);
  assert.equal(page2.body.page.hasMore, false);
});

// ── Owner-Check ───────────────────────────────────────────────

test('GET /contact/:id: 404 bei nicht existierendem Kontakt', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);
  const r = await agent.get('/api/progress/contact/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'ref_not_found');
});

test('GET /contact/:id: 404 bei fremdem Kontakt, identisch zu nicht-existent (keine Existenz-Enumeration)', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db, { userId: 'other-user' });
  foreignIds.add(`contact:${contactId}`);
  const agent = await loginAgent(app);

  const rForeign = await agent.get(`/api/progress/contact/${contactId}`);
  const rMissing = await agent.get('/api/progress/contact/does-not-exist');
  assert.equal(rForeign.status, 404);
  assert.equal(rMissing.status, 404);
  assert.deepEqual(rForeign.body, rMissing.body);
});

test('POST /contact/:id/entries: 404 bei fremdem Kontakt', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db, { userId: 'other-user' });
  foreignIds.add(`contact:${contactId}`);
  const agent = await loginAgent(app);

  const r = await agent.post(`/api/progress/contact/${contactId}/entries`).send({ body: '<p>x</p>' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'ref_not_found');
});

// ── next-step: Ablehnung fuer Kontakte ───────────────────────

test('PUT /contact/:id/next-step: 400 unsupported_for_ref_type, OHNE DB-Zugriff (auch bei nicht existierendem Kontakt)', async (t) => {
  const { app, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const agent = await loginAgent(app);

  // Bewusst eine ID, die es gar nicht gibt: schlaegt die Route DB-basiert vor
  // der Typpruefung nach, waere das Ergebnis 404 ref_not_found statt 400 -
  // dieser Test beweist also, dass der Guard VOR resolveRef() greift.
  const r = await agent.put('/api/progress/contact/does-not-exist/next-step').send({ nextStep: 'Anrufen' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unsupported_for_ref_type');
});

test('PUT /contact/:id/next-step: 400 unsupported_for_ref_type auch fuer existierenden, fremden Kontakt', async (t) => {
  const { app, db, dir, foreignIds } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db, { userId: 'other-user' });
  foreignIds.add(`contact:${contactId}`);
  const agent = await loginAgent(app);

  const r = await agent.put(`/api/progress/contact/${contactId}/next-step`).send({ nextStep: 'Anrufen' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unsupported_for_ref_type');
});

// ── reentry/dormant: Kontakte kennen kein Wiedereinstiegs-/Ruhephasen-Konzept ──

test('GET /contact/:id: reentry.show=false und ai={available:false,frameId:null}, auch wenn getLatestFrameId einen Frame liefern wuerde', async (t) => {
  const { app, db, dir } = buildTestApp({ getLatestFrameId: async () => 'frame-should-be-ignored' });
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/contact/${contactId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.reentry.show, false);
  assert.equal(r.body.reentry.ai.available, false);
  assert.equal(r.body.reentry.ai.frameId, null);
  assert.equal(r.body.stats.dormant, false);
});

test('GET /contact/:id: dormant=false, obwohl letzte Aktivitaet weit in der Vergangenheit liegt', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db, { createdAt: '2020-01-01T00:00:00.000Z' });
  insertEntry(db, {
    userId: 'test-user', refType: 'contact', refId: contactId, kind: 'note', source: 'manual',
    bodyHtml: '<p>alt</p>', bodyText: 'alt', linkFrameId: null, clientToken: null, nowIso: '2020-01-02T00:00:00.000Z',
  });
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/contact/${contactId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.stats.dormant, false);
  assert.equal(r.body.reentry.show, false);
  // stale wird weiterhin "wie gehabt" berechnet (nicht Teil des Vertrags-Ausschlusses).
  assert.equal(r.body.stats.stale, true);
});

test('GET /contact/:id: description ist immer "" (nicht contacts.description), done/result/resultDate sind leer, reentry.empty daher trotz befuellter contacts.description true', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db, { description: 'Interner Beschreibungstext' });
  const agent = await loginAgent(app);

  const r = await agent.get(`/api/progress/contact/${contactId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ref.done, false);
  assert.equal(r.body.ref.result, '');
  assert.equal(r.body.ref.resultDate, '');
  // reentry.empty haengt (ueber descriptionEmpty) direkt an ref.description -
  // waere ref.description faelschlich contacts.description, waere empty hier
  // false, obwohl kein Zwischenstand/next-step existiert (Code-Review-Fund,
  // Mittel #7: Testtitel/Assertion muss das tatsaechlich pruefen).
  assert.equal(r.body.reentry.empty, true);
});

// ── Sonstige generische Endpunkte bleiben unveraendert nutzbar ──

test('PUT /contact/:id/goal: bleibt fuer contact wie fuer alle Typen mit 410 goal_removed beantwortet', async (t) => {
  const { app, db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const agent = await loginAgent(app);

  const r = await agent.put(`/api/progress/contact/${contactId}/goal`).send({ goal: 'x' });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'goal_removed');
});

// ── deleteForRefs()/summaryFor() direkt getestet (Code-Review-Fund, Mittel #4) ──
// Bisher nur indirekt ueber HTTP abgedeckt - hier direkte Tests analog zum
// Muster in test/progress_summary.test.js.

test('deleteForRefs: loescht nur die Kontakt-Eintraege, laesst todo/topic-Eintraege und progress_meta unangetastet', (t) => {
  const { db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const nowIso = new Date().toISOString();

  insertEntry(db, { userId: 'test-user', refType: 'contact', refId: contactId, bodyHtml: '<p>c</p>', bodyText: 'c', nowIso });
  insertEntry(db, { userId: 'test-user', refType: 'todo', refId: 'todo-x', bodyHtml: '<p>t</p>', bodyText: 't', nowIso });
  insertEntry(db, { userId: 'test-user', refType: 'topic', refId: 'topic-x', bodyHtml: '<p>k</p>', bodyText: 'k', nowIso });
  setNextStep(db, 'test-user', 'todo', 'todo-x', 'Anrufen', nowIso);
  setNextStep(db, 'test-user', 'topic', 'topic-x', 'Klaeren', nowIso);

  const result = deleteForRefs(db, [{ refType: 'contact', refId: contactId }]);
  assert.equal(result.entries, 1);
  assert.equal(result.meta, 0, 'progress_meta traegt niemals contact-Zeilen (No-Op fuer diesen refType)');

  const remainingEntries = db.prepare('SELECT ref_type, ref_id FROM progress_entries ORDER BY ref_type').all();
  assert.deepEqual(remainingEntries, [
    { ref_type: 'todo', ref_id: 'todo-x' },
    { ref_type: 'topic', ref_id: 'topic-x' },
  ]);

  const remainingMeta = db.prepare('SELECT ref_type, ref_id FROM progress_meta ORDER BY ref_type').all();
  assert.deepEqual(remainingMeta, [
    { ref_type: 'todo', ref_id: 'todo-x' },
    { ref_type: 'topic', ref_id: 'topic-x' },
  ]);
});

test('summaryFor: gemischte Items (todo+topic+contact) liefern alle drei Schluessel, GENAU EINE Query pro belegtem refType', (t) => {
  const { db, dir } = buildTestApp();
  t.after(() => cleanup(dir));
  const contactId = makeContact(db);
  const nowIso = new Date().toISOString();

  insertEntry(db, { userId: 'test-user', refType: 'contact', refId: contactId, bodyHtml: '<p>c</p>', bodyText: 'c', nowIso });
  insertEntry(db, { userId: 'test-user', refType: 'todo', refId: 'todo-x', bodyHtml: '<p>t</p>', bodyText: 't', nowIso });
  insertEntry(db, { userId: 'test-user', refType: 'topic', refId: 'topic-x', bodyHtml: '<p>k</p>', bodyText: 'k', nowIso });

  const items = [
    { refType: 'todo', refId: 'todo-x', refCreatedAt: nowIso, refDone: false, refSnoozedUntil: '' },
    { refType: 'topic', refId: 'topic-x', refCreatedAt: nowIso, refDone: false, refSnoozedUntil: '' },
    { refType: 'contact', refId: contactId, refCreatedAt: nowIso, refDone: false, refSnoozedUntil: '' },
  ];

  let groupByCalls = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('GROUP BY ref_id')) groupByCalls++;
    return origPrepare(sql);
  };
  let map;
  try {
    map = summaryFor(db, 'test-user', items);
  } finally {
    db.prepare = origPrepare;
  }

  assert.equal(map.size, 3);
  assert.equal(map.get('todo:todo-x').entryCount, 1);
  assert.equal(map.get('topic:topic-x').entryCount, 1);
  assert.equal(map.get(`contact:${contactId}`).entryCount, 1);
  assert.equal(groupByCalls, 3, 'genau eine GROUP-BY-Query je belegtem refType (todo/topic/contact), kein N+1');
});
