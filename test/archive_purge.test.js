'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runArchiveMigrations } = require('../lib/archive/schema');
const { archive, isArchived, purgeMeeting } = require('../lib/archive/queries');
const { runProgressMigrations, deleteForRefs, insertEntry } = require('../lib/progress');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-purge-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, group_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE themes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE theme_links (
      id TEXT PRIMARY KEY, theme_id TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
      ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      filename TEXT NOT NULL, stored_as TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE stack_frames (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      next_step_note TEXT NOT NULL, pushed_at TEXT NOT NULL, popped_at TEXT
    );
    CREATE TABLE ai_artifacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      feature TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  runArchiveMigrations(db);
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO users VALUES ('u2','u2',datetime('now'))").run();
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function seedFullMeeting(db, { meetingId = 'm1', userId = 'u1', topicIds = ['t1', 't2'] } = {}) {
  db.prepare('INSERT INTO meetings(id,user_id,title,created_at) VALUES (?,?,?,datetime(\'now\'))')
    .run(meetingId, userId, 'Meeting');
  for (const tid of topicIds) {
    db.prepare("INSERT INTO topics(id,meeting_id,title,created_at) VALUES (?,?,?,datetime('now'))")
      .run(tid, meetingId, `Topic ${tid}`);
  }
  db.prepare("INSERT INTO themes(id,user_id,title,created_at) VALUES ('th1',?,?,datetime('now'))")
    .run(userId, 'Thema');
  for (const tid of topicIds) {
    db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,datetime('now'))")
      .run(`link-${tid}`, 'th1', 'topic', tid);
    db.prepare(
      "INSERT INTO attachments(id,user_id,ref_type,ref_id,filename,stored_as,size,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))"
    ).run(`att-${tid}`, userId, 'topic', tid, 'file.pdf', `stored-${tid}.pdf`, 1234);
    db.prepare(
      "INSERT INTO stack_frames(id,user_id,ref_type,ref_id,next_step_note,pushed_at) VALUES (?,?,?,?,?,datetime('now'))"
    ).run(`frame-${tid}`, userId, 'topic', tid, 'Weiter machen');
    db.prepare(
      "INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,created_at) VALUES (?,?,?,?,?,?,datetime('now'))"
    ).run(`ai-${tid}`, userId, 'topic', tid, 'brief', 'content');
    insertEntry(db, { userId, refType: 'topic', refId: tid, bodyHtml: '<p>x</p>', bodyText: 'x', nowIso: new Date().toISOString() });
  }
  archive(db, userId, 'meeting', meetingId, new Date().toISOString());
  return { meetingId, topicIds };
}

// ── Vollständige Purge-Kaskade ──────────────────────────────

test('purgeMeeting: löscht die vollständige Kaskade und liefert erwartete Zahlen/Dateinamen', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const { meetingId, topicIds } = seedFullMeeting(db);

  const result = purgeMeeting(db, { deleteForRefs }, 'u1', meetingId);

  assert.deepEqual(result.deleted, {
    topics: 2, progressEntries: 2, attachments: 2, themeLinks: 2, stackFrames: 2, aiArtifacts: 2,
  });
  assert.deepEqual(result.storedFiles.sort(), ['stored-t1.pdf', 'stored-t2.pdf']);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM topics').get().c, 0); // FK-Kaskade
  assert.equal(db.prepare('SELECT COUNT(*) c FROM theme_links').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attachments').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stack_frames').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_artifacts').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM progress_entries').get().c, 0);
  for (const tid of topicIds) {
    assert.equal(db.prepare('SELECT COUNT(*) c FROM progress_meta WHERE ref_id=?').get(tid).c, 0);
  }
  assert.equal(isArchived(db, 'meeting', meetingId), false);
});

test('purgeMeeting: Meeting ohne Topics purged sauber (Grenzfall)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  db.prepare("INSERT INTO meetings(id,user_id,title,created_at) VALUES ('m-empty','u1','Leer',datetime('now'))").run();
  archive(db, 'u1', 'meeting', 'm-empty', new Date().toISOString());

  const result = purgeMeeting(db, { deleteForRefs }, 'u1', 'm-empty');
  assert.deepEqual(result.deleted, {
    topics: 0, progressEntries: 0, attachments: 0, themeLinks: 0, stackFrames: 0, aiArtifacts: 0,
  });
  assert.deepEqual(result.storedFiles, []);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings').get().c, 0);
});

// ── Rollback bei simuliertem Fehler ──────────────────────────

test('purgeMeeting: Rollback bei Fehler mitten in der Transaktion - nichts wird halb gelöscht', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const { meetingId } = seedFullMeeting(db);

  const failingProgress = {
    deleteForRefs: () => { throw new Error('simulierter Fehler'); },
  };

  assert.throws(() => purgeMeeting(db, failingProgress, 'u1', meetingId));

  // Kompletter Datenbestand unverändert - nichts halb geloescht.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings WHERE id=?').get(meetingId).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM topics WHERE meeting_id=?').get(meetingId).c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM theme_links').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attachments').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stack_frames').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_artifacts').get().c, 2);
  assert.equal(isArchived(db, 'meeting', meetingId), true);
});

test('purgeMeeting: wirft und rollt zurück, wenn Meeting nicht dem übergebenen userId gehört', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const { meetingId } = seedFullMeeting(db, { userId: 'u1' });

  assert.throws(() => purgeMeeting(db, { deleteForRefs }, 'u2', meetingId));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings WHERE id=?').get(meetingId).c, 1);
});

test('purgeMeeting: wirft, wenn progress.deleteForRefs fehlt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const { meetingId } = seedFullMeeting(db);
  assert.throws(() => purgeMeeting(db, {}, 'u1', meetingId), TypeError);
});

// ── Geteilte Themen (group_id / theme_links) ─────────────────

test('purgeMeeting: geteilte Themen anderer, nicht-archivierter Meetings bleiben unangetastet', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));

  db.prepare("INSERT INTO meetings(id,user_id,title,created_at) VALUES ('m1','u1','M1',datetime('now'))").run();
  db.prepare("INSERT INTO meetings(id,user_id,title,created_at) VALUES ('m2','u1','M2',datetime('now'))").run();

  // Zwei Topic-Kopien mit gemeinsamer group_id (geteiltes Thema), je eine pro Meeting.
  db.prepare("INSERT INTO topics(id,meeting_id,title,group_id,created_at) VALUES ('t1-m1','m1','Geteiltes Thema','shared-group',datetime('now'))").run();
  db.prepare("INSERT INTO topics(id,meeting_id,title,group_id,created_at) VALUES ('t1-m2','m2','Geteiltes Thema','shared-group',datetime('now'))").run();

  db.prepare("INSERT INTO themes(id,user_id,title,created_at) VALUES ('th1','u1','Thema',datetime('now'))").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('link-m1','th1','topic','t1-m1',datetime('now'))").run();
  db.prepare("INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES ('link-m2','th1','topic','t1-m2',datetime('now'))").run();

  archive(db, 'u1', 'meeting', 'm1', new Date().toISOString());

  const result = purgeMeeting(db, { deleteForRefs }, 'u1', 'm1');
  assert.equal(result.deleted.themeLinks, 1);

  // m2 (nicht archiviert) und dessen Topic-Kopie/Theme-Link bleiben unangetastet.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meetings WHERE id='m2'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM topics WHERE id='t1-m2'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM theme_links WHERE ref_id='t1-m2'").get().c, 1);
  // Das Theme selbst bleibt bestehen (nicht Teil der Purge-Kaskade).
  assert.equal(db.prepare("SELECT COUNT(*) c FROM themes WHERE id='th1'").get().c, 1);
});

test('purgeMeeting: 409-Vorbedingung wird NICHT hier geprüft (Router-Verantwortung) - Aufruf auf nicht-archiviertem Meeting purged trotzdem (Dokumentation der Zuständigkeit)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  db.prepare("INSERT INTO meetings(id,user_id,title,created_at) VALUES ('m1','u1','M1',datetime('now'))").run();
  // bewusst NICHT archiviert
  const result = purgeMeeting(db, { deleteForRefs }, 'u1', 'm1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings').get().c, 0);
  assert.ok(result.deleted);
});
