'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMomentumMigrations } = require('../lib/momentum/schema');
const q = require('../lib/momentum/queries');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momentum-queries-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `);
  runMomentumMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  db.prepare("INSERT INTO meetings VALUES ('m1','u1','M',datetime('now'))").run();
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

let seq = 0;
function insertTodo(db, { createdAt, completedAt = '', userId = 'u1' }) {
  const id = `t${seq++}`;
  db.prepare('INSERT INTO todos(id,user_id,title,done,created_at,completed_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, 'Todo', completedAt ? 1 : 0, createdAt, completedAt);
  return id;
}
function insertTopic(db, { createdAt, completedAt = '', meetingId = 'm1' }) {
  const id = `tp${seq++}`;
  db.prepare('INSERT INTO topics(id,meeting_id,title,done,created_at,completed_at) VALUES (?,?,?,?,?,?)')
    .run(id, meetingId, 'Topic', completedAt ? 1 : 0, createdAt, completedAt);
  return id;
}

test('localDateStr: rechnet UTC-Zeitstempel unter Client-Offset auf lokales Kalenderdatum um', () => {
  // 2026-01-01T23:30:00Z ist in UTC+2 (Offset +120min) bereits der 2. Januar.
  assert.equal(q.localDateStr('2026-01-01T23:30:00.000Z', 120), '2026-01-02');
  // In UTC-5 (Offset -300min) noch der 1. Januar.
  assert.equal(q.localDateStr('2026-01-01T23:30:00.000Z', -300), '2026-01-01');
});

test('weekBoundsForLocalDate: liefert Montag-Sonntag-Fenster (ISO-Woche)', () => {
  // 2026-09-11 ist ein Freitag.
  const { startDate, endDate } = q.weekBoundsForLocalDate('2026-09-11');
  assert.equal(startDate, '2026-09-07'); // Montag
  assert.equal(endDate, '2026-09-13');   // Sonntag
});

test('getSettings: liefert Defaults (alle aktiv), wenn nichts gespeichert ist', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.deepEqual(q.getSettings(db, 'u1'), {
    completionToastEnabled: true, streakEnabled: true, weeklyReviewEnabled: true,
  });
});

test('saveSettings: partielles Patch aendert nur die angegebenen Felder', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  q.saveSettings(db, 'u1', { streakEnabled: false }, '2026-01-01T00:00:00.000Z');
  const s1 = q.getSettings(db, 'u1');
  assert.deepEqual(s1, { completionToastEnabled: true, streakEnabled: false, weeklyReviewEnabled: true });

  q.saveSettings(db, 'u1', { completionToastEnabled: false }, '2026-01-02T00:00:00.000Z');
  const s2 = q.getSettings(db, 'u1');
  assert.deepEqual(s2, { completionToastEnabled: false, streakEnabled: false, weeklyReviewEnabled: true });
});

test('addPauseDay: lehnt ungueltiges Datum ab', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const res = q.addPauseDay(db, 'u1', '2026-13-40', '2026-09-11', '2026-09-11T00:00:00.000Z');
  assert.equal(res.ok, false);
  assert.equal(res.error, q.PAUSE_DAY_ERRORS.INVALID_DATE);
});

test('addPauseDay: lehnt Datum weiter als 90 Tage in der Zukunft ab', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const res = q.addPauseDay(db, 'u1', '2028-01-01', '2026-09-11', '2026-09-11T00:00:00.000Z');
  assert.equal(res.ok, false);
  assert.equal(res.error, q.PAUSE_DAY_ERRORS.TOO_FAR_AHEAD);
});

test('addPauseDay: akzeptiert genau 90 Tage in der Zukunft, lehnt 91 Tage ab (Requirements-Grenze)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const exactly90 = q.addDaysToDateStr('2026-09-11', 90);
  const beyond90 = q.addDaysToDateStr('2026-09-11', 91);
  const ok = q.addPauseDay(db, 'u1', exactly90, '2026-09-11', '2026-09-11T00:00:00.000Z');
  assert.equal(ok.ok, true);
  const tooFar = q.addPauseDay(db, 'u1', beyond90, '2026-09-11', '2026-09-11T00:00:00.000Z');
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.error, q.PAUSE_DAY_ERRORS.TOO_FAR_AHEAD);
});

test('addPauseDay: ist idempotent (doppeltes Anlegen ist kein Fehler)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const r1 = q.addPauseDay(db, 'u1', '2026-11-10', '2026-09-11', '2026-09-11T00:00:00.000Z');
  const r2 = q.addPauseDay(db, 'u1', '2026-11-10', '2026-09-11', '2026-09-11T00:00:00.000Z');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(q.listPauseDays(db, 'u1'), ['2026-11-10']);
});

test('removePauseDay: entfernt vorhandenen Pausentag, meldet removed=false wenn keiner existierte', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  q.addPauseDay(db, 'u1', '2026-11-10', '2026-09-11', '2026-09-11T00:00:00.000Z');
  const r1 = q.removePauseDay(db, 'u1', '2026-11-10');
  assert.deepEqual(r1, { ok: true, removed: true });
  const r2 = q.removePauseDay(db, 'u1', '2026-11-10');
  assert.deepEqual(r2, { ok: true, removed: false });
});

test('computeStreak: mehrere aufeinanderfolgende aktive Tage werden gezaehlt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, { createdAt: '2026-09-09T10:00:00.000Z' });
  insertTodo(db, { createdAt: '2026-09-08T10:00:00.000Z', completedAt: '2026-09-10T10:00:00.000Z' });
  insertTodo(db, { createdAt: '2026-09-11T10:00:00.000Z' });
  const now = new Date('2026-09-11T12:00:00.000Z');
  const result = q.computeStreak(db, 'u1', 0, now);
  assert.equal(result.activeToday, true);
  assert.equal(result.current, 4); // 08. (createdAt), 09. (createdAt), 10. (completedAt), 11. (createdAt)
});

test('computeStreak: ungeplante Luecke in der Vergangenheit bricht die Serie ab', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, { createdAt: '2026-09-05T10:00:00.000Z' }); // Luecke danach
  insertTodo(db, { createdAt: '2026-09-10T10:00:00.000Z' });
  insertTodo(db, { createdAt: '2026-09-11T10:00:00.000Z' });
  const now = new Date('2026-09-11T12:00:00.000Z');
  const result = q.computeStreak(db, 'u1', 0, now);
  assert.equal(result.current, 2); // nur 10. und 11., der 05. ist isoliert
});

test('computeStreak: heutiger Tag ohne Aktivitaet zaehlt nicht mit, bricht die Serie aber nicht ab', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, { createdAt: '2026-09-09T10:00:00.000Z' });
  insertTodo(db, { createdAt: '2026-09-10T10:00:00.000Z' });
  const now = new Date('2026-09-11T12:00:00.000Z'); // 11. selbst ohne Aktivitaet
  const result = q.computeStreak(db, 'u1', 0, now);
  assert.equal(result.activeToday, false);
  assert.equal(result.current, 2);
});

test('computeStreak: als Pause markierter Tag ohne Aktivitaet unterbricht die Serie nicht', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, { createdAt: '2026-09-09T10:00:00.000Z' });
  // 2026-09-10 bewusst ohne Aktivitaet, aber als Pause markiert.
  q.addPauseDay(db, 'u1', '2026-09-10', '2026-09-09', '2026-09-09T00:00:00.000Z');
  insertTodo(db, { createdAt: '2026-09-11T10:00:00.000Z' });
  const now = new Date('2026-09-11T12:00:00.000Z');
  const result = q.computeStreak(db, 'u1', 0, now);
  assert.equal(result.current, 3);
});

test('weekCounts/weekMilestones: zaehlt Todos/Themen und filtert Meilensteine auf das Wochenfenster', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  insertTodo(db, { createdAt: '2026-09-08T10:00:00.000Z', completedAt: '2026-09-09T10:00:00.000Z' });
  insertTodo(db, { createdAt: '2026-09-20T10:00:00.000Z' }); // ausserhalb des Fensters
  insertTopic(db, { createdAt: '2026-09-10T10:00:00.000Z' });
  db.prepare("INSERT INTO momentum_milestones(id,user_id,kind,ref_id,name,occurred_at) VALUES ('ms1','u1','topic','tpX','Serverumzug','2026-09-09T12:00:00.000Z')").run();
  db.prepare("INSERT INTO momentum_milestones(id,user_id,kind,ref_id,name,occurred_at) VALUES ('ms2','u1','contact','cX','Frau Meyer','2026-09-30T12:00:00.000Z')").run();

  const counts = q.weekCounts(db, 'u1', '2026-09-07', '2026-09-13');
  assert.equal(counts.createdCount, 2); // ein Todo + ein Thema in der Woche
  assert.equal(counts.completedCount, 1);

  const milestones = q.weekMilestones(db, 'u1', '2026-09-07', '2026-09-13');
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].name, 'Serverumzug');
});
