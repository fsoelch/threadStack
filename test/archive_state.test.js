'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runArchiveMigrations } = require('../lib/archive/schema');
const {
  ARCHIVABLE_REF_TYPES,
  notArchivedSql,
  isArchived,
  archivedAt,
  isTopicArchived,
  archivedFlags,
  archive,
  restore,
  deleteState,
  meetingImpact,
  openStackFramesForMeeting,
  listArchivedMeetings,
} = require('../lib/archive/queries');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-state-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      participants TEXT NOT NULL DEFAULT '[]', color TEXT NOT NULL DEFAULT '#4f46e5',
      next_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE stack_frames (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      next_step_note TEXT NOT NULL, pushed_at TEXT NOT NULL, popped_at TEXT
    );
    CREATE TABLE progress_entries (id TEXT PRIMARY KEY, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, stored_as TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE theme_links (id TEXT PRIMARY KEY, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL);
    CREATE TABLE ai_artifacts (id TEXT PRIMARY KEY, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL);
    CREATE VIRTUAL TABLE search_index USING fts5(ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body);
  `);
  runArchiveMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO users VALUES ('u2','u2',datetime('now'))").run();
  return { db, dir };
}

function insertMeeting(db, { id, userId = 'u1', title = 'Meeting', createdAt = new Date().toISOString() } = {}) {
  db.prepare(
    'INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,?)'
  ).run(id, userId, title, createdAt);
  return id;
}

function insertTopic(db, { id, meetingId, title = 'Topic', done = 0 } = {}) {
  db.prepare(
    "INSERT INTO topics(id,meeting_id,title,done,created_at) VALUES (?,?,?,?,datetime('now'))"
  ).run(id, meetingId, title, done);
  return id;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── notArchivedSql ────────────────────────────────────────────

test('notArchivedSql: liefert das vertraglich erwartete SQL-Fragment', () => {
  assert.equal(
    notArchivedSql('m'),
    "NOT EXISTS (SELECT 1 FROM archive_state _a WHERE _a.ref_type='meeting' AND _a.ref_id=m.id)"
  );
});

test('notArchivedSql: wirft bei ungültigem alias (Leerzeichen/Sonderzeichen)', () => {
  assert.throws(() => notArchivedSql('m eeting'), TypeError);
  assert.throws(() => notArchivedSql('m;DROP TABLE x'), TypeError);
  assert.throws(() => notArchivedSql('1abc'), TypeError);
  assert.throws(() => notArchivedSql(''), TypeError);
  assert.throws(() => notArchivedSql(null), TypeError);
});

test('notArchivedSql: wirft bei refType außerhalb ARCHIVABLE_REF_TYPES', () => {
  assert.throws(() => notArchivedSql('m', 'todo'), TypeError);
  assert.throws(() => notArchivedSql('m', 'DROP TABLE archive_state'), TypeError);
});

test('notArchivedSql: erzeugtes Fragment filtert in einer echten Query korrekt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  insertMeeting(db, { id: 'm2' });
  archive(db, 'u1', 'meeting', 'm2', new Date().toISOString());

  const sql = `SELECT id FROM meetings m WHERE ${notArchivedSql('m')} ORDER BY id`;
  const rows = db.prepare(sql).all().map((r) => r.id);
  assert.deepEqual(rows, ['m1']);
});

// ── archive / restore / isArchived / archivedAt / deleteState ──

test('archive: legt Status an, restore entfernt ihn wieder', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });

  assert.equal(isArchived(db, 'meeting', 'm1'), false);
  assert.equal(archivedAt(db, 'meeting', 'm1'), null);

  const r1 = archive(db, 'u1', 'meeting', 'm1', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(r1, { changed: true, archivedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(isArchived(db, 'meeting', 'm1'), true);
  assert.equal(archivedAt(db, 'meeting', 'm1'), '2026-01-01T00:00:00.000Z');

  const r2 = restore(db, 'meeting', 'm1');
  assert.deepEqual(r2, { changed: true });
  assert.equal(isArchived(db, 'meeting', 'm1'), false);
});

test('archive: idempotent - zweiter Aufruf ändert archivedAt nicht, changed=false', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });

  const first = archive(db, 'u1', 'meeting', 'm1', '2026-01-01T00:00:00.000Z');
  assert.equal(first.changed, true);

  const second = archive(db, 'u1', 'meeting', 'm1', '2026-06-01T00:00:00.000Z');
  assert.deepEqual(second, { changed: false, archivedAt: '2026-01-01T00:00:00.000Z' });
});

test('restore: idempotent - zweiter Aufruf liefert changed=false', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());

  const first = restore(db, 'meeting', 'm1');
  assert.equal(first.changed, true);
  const second = restore(db, 'meeting', 'm1');
  assert.equal(second.changed, false);
});

test('deleteState: entfernt den Status ohne Rückgabewert-Semantik, mehrfacher Aufruf wirft nicht', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());

  assert.equal(deleteState(db, 'meeting', 'm1'), undefined);
  assert.equal(isArchived(db, 'meeting', 'm1'), false);
  assert.doesNotThrow(() => deleteState(db, 'meeting', 'm1'));
});

// ── isTopicArchived ──────────────────────────────────────────

test('isTopicArchived: topics -> meetings -> archive_state', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  insertMeeting(db, { id: 'm2' });
  insertTopic(db, { id: 't1', meetingId: 'm1' });
  insertTopic(db, { id: 't2', meetingId: 'm2' });

  assert.equal(isTopicArchived(db, 't1'), false);
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());
  assert.equal(isTopicArchived(db, 't1'), true);
  assert.equal(isTopicArchived(db, 't2'), false);
  assert.equal(isTopicArchived(db, 'does-not-exist'), false);
});

// ── archivedFlags (Batch, kein N+1) ────────────────────────────

test('archivedFlags: liefert korrekte Map für gemischte refType/refId-Listen', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  insertMeeting(db, { id: 'm2' });
  insertMeeting(db, { id: 'm3' });
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());
  archive(db, 'u1', 'meeting', 'm3', new Date().toISOString());

  const flags = archivedFlags(db, [
    { refType: 'meeting', refId: 'm1' },
    { refType: 'meeting', refId: 'm2' },
    { refType: 'meeting', refId: 'm3' },
    { refType: 'meeting', refId: 'unknown' },
    { refType: 'topic', refId: 'm1' }, // andere refType, darf 'meeting:m1' nicht faelschlich matchen
  ]);

  assert.equal(flags.get('meeting:m1'), true);
  assert.equal(flags.get('meeting:m2'), false);
  assert.equal(flags.get('meeting:m3'), true);
  assert.equal(flags.get('meeting:unknown'), false);
  assert.equal(flags.get('topic:m1'), false);
});

test('archivedFlags: leere Eingabe liefert leere Map, kein Fehler', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.deepEqual(archivedFlags(db, []), new Map());
  assert.deepEqual(archivedFlags(db, null), new Map());
});

test('archivedFlags: kein N+1 - genau eine Query pro distinktem refType', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  for (let i = 0; i < 20; i++) insertMeeting(db, { id: `m${i}` });
  archive(db, 'u1', 'meeting', 'm0', new Date().toISOString());

  let queryCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    queryCount++;
    return origPrepare(sql);
  };

  const refs = Array.from({ length: 20 }, (_, i) => ({ refType: 'meeting', refId: `m${i}` }));
  archivedFlags(db, refs);

  db.prepare = origPrepare;
  // Nur EIN refType ('meeting') in der Eingabe -> genau eine IN(...)-Query,
  // unabhängig von der Anzahl der 20 übergebenen refs.
  assert.equal(queryCount, 1);
});

// ── meetingImpact ────────────────────────────────────────────

test('meetingImpact: zählt alle betroffenen Entitäten korrekt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  insertTopic(db, { id: 't1', meetingId: 'm1' });
  insertTopic(db, { id: 't2', meetingId: 'm1' });

  db.prepare("INSERT INTO progress_entries VALUES ('e1','topic','t1',datetime('now'))").run();
  db.prepare("INSERT INTO progress_entries VALUES ('e2','topic','t2',datetime('now'))").run();
  db.prepare("INSERT INTO progress_entries VALUES ('e3','topic','other-topic',datetime('now'))").run(); // fremdes Topic, darf nicht zaehlen

  db.prepare("INSERT INTO attachments VALUES ('a1','topic','t1','stored-a1.pdf',1000)").run();
  db.prepare("INSERT INTO attachments VALUES ('a2','topic','t2','stored-a2.png',2500)").run();

  db.prepare("INSERT INTO theme_links VALUES ('l1','topic','t1')").run();

  db.prepare("INSERT INTO stack_frames VALUES ('f1','u1','topic','t1','next',datetime('now'),NULL)").run();

  db.prepare("INSERT INTO ai_artifacts VALUES ('ai1','topic','t1')").run();
  db.prepare("INSERT INTO ai_artifacts VALUES ('ai2','topic','t2')").run();

  const impact = meetingImpact(db, 'u1', 'm1');
  assert.deepEqual(impact, {
    topics: 2,
    progressEntries: 2,
    attachments: 2,
    attachmentBytes: 3500,
    themeLinks: 1,
    stackFrames: 1,
    aiArtifacts: 2,
  });
});

test('meetingImpact: Meeting ohne Topics liefert lauter Nullen', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  const impact = meetingImpact(db, 'u1', 'm1');
  assert.deepEqual(impact, {
    topics: 0, progressEntries: 0, attachments: 0, attachmentBytes: 0,
    themeLinks: 0, stackFrames: 0, aiArtifacts: 0,
  });
});

// ── openStackFramesForMeeting ────────────────────────────────

test('openStackFramesForMeeting: liefert nur offene Frames der eigenen Topics', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  insertTopic(db, { id: 't1', meetingId: 'm1', title: 'Thema Eins' });
  db.prepare(
    "INSERT INTO stack_frames VALUES ('f1','u1','topic','t1','Naechster Schritt','2026-01-01T00:00:00.000Z',NULL)"
  ).run();
  db.prepare(
    "INSERT INTO stack_frames VALUES ('f2','u1','topic','t1','Bereits erledigt','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')"
  ).run(); // gepoppt, darf nicht auftauchen

  const open = openStackFramesForMeeting(db, 'u1', 'm1');
  assert.deepEqual(open, [{
    frameId: 'f1', topicId: 't1', topicTitle: 'Thema Eins',
    nextStepNote: 'Naechster Schritt', pushedAt: '2026-01-01T00:00:00.000Z',
  }]);
});

test('openStackFramesForMeeting: kein Frame -> leeres Array', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1' });
  insertTopic(db, { id: 't1', meetingId: 'm1' });
  assert.deepEqual(openStackFramesForMeeting(db, 'u1', 'm1'), []);
});

// ── listArchivedMeetings ─────────────────────────────────────

test('listArchivedMeetings: nur archivierte Meetings des Nutzers, sortiert archived_at DESC, title ASC', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1', title: 'Zebra' });
  insertMeeting(db, { id: 'm2', title: 'Apfel' });
  insertMeeting(db, { id: 'm3', title: 'Aktiv (nicht archiviert)' });
  insertMeeting(db, { id: 'm4', userId: 'u2', title: 'Fremdes Meeting' });

  archive(db, 'u1', 'meeting', 'm1', '2026-01-01T00:00:00.000Z');
  archive(db, 'u1', 'meeting', 'm2', '2026-01-01T00:00:00.000Z'); // gleicher Zeitstempel -> Titel entscheidet
  archive(db, 'u2', 'meeting', 'm4', '2026-02-01T00:00:00.000Z');

  const { rows, total } = listArchivedMeetings(db, 'u1', {});
  assert.equal(total, 2);
  assert.deepEqual(rows.map((r) => r.id), ['m2', 'm1']); // Apfel vor Zebra
});

test('listArchivedMeetings: limit/offset werden angewandt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  for (let i = 0; i < 5; i++) {
    insertMeeting(db, { id: `m${i}`, title: `M${i}` });
    archive(db, 'u1', 'meeting', `m${i}`, `2026-01-0${i + 1}T00:00:00.000Z`);
  }
  const page1 = listArchivedMeetings(db, 'u1', { limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.rows.length, 2);
  const page2 = listArchivedMeetings(db, 'u1', { limit: 2, offset: 2 });
  assert.equal(page2.rows.length, 2);
  assert.notDeepEqual(page1.rows.map((r) => r.id), page2.rows.map((r) => r.id));
});

test('listArchivedMeetings: q matcht über Meeting-Titel', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1', title: 'Budgetplanung Q3' });
  insertMeeting(db, { id: 'm2', title: 'Sonstiges' });
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());
  archive(db, 'u1', 'meeting', 'm2', new Date().toISOString());
  db.prepare("INSERT INTO search_index(ref_type,ref_id,user_id,title,body) VALUES ('meeting','m1','u1','Budgetplanung Q3','')").run();
  db.prepare("INSERT INTO search_index(ref_type,ref_id,user_id,title,body) VALUES ('meeting','m2','u1','Sonstiges','')").run();

  const { rows, total } = listArchivedMeetings(db, 'u1', { q: '"Budgetplanung"' });
  assert.equal(total, 1);
  assert.deepEqual(rows.map((r) => r.id), ['m1']);
});

test('listArchivedMeetings: q matcht auch über Topic-Inhalt eines archivierten Meetings', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1', title: 'Team-Sync' });
  insertTopic(db, { id: 't1', meetingId: 'm1', title: 'Rollout-Plan' });
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());
  db.prepare("INSERT INTO search_index(ref_type,ref_id,user_id,title,body) VALUES ('meeting','m1','u1','Team-Sync','')").run();
  db.prepare("INSERT INTO search_index(ref_type,ref_id,user_id,title,body) VALUES ('topic','t1','u1','Rollout-Plan','')").run();

  const { rows, total } = listArchivedMeetings(db, 'u1', { q: '"Rollout-Plan"' });
  assert.equal(total, 1);
  assert.deepEqual(rows.map((r) => r.id), ['m1']);
});

test('listArchivedMeetings: q ohne Treffer liefert leeres Ergebnis, kein Fehler', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertMeeting(db, { id: 'm1', title: 'Etwas' });
  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());
  db.prepare("INSERT INTO search_index(ref_type,ref_id,user_id,title,body) VALUES ('meeting','m1','u1','Etwas','')").run();

  const { rows, total } = listArchivedMeetings(db, 'u1', { q: '"nichtvorhanden"' });
  assert.equal(total, 0);
  assert.deepEqual(rows, []);
});
