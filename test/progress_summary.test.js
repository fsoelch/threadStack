'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runProgressMigrations } = require('../lib/progress/schema');
const {
  refInfo, setNextStep, insertEntry, summaryFor, detailStats,
  DORMANT_DAYS, STALE_DAYS, GAP_DAYS,
} = require('../lib/progress/queries');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-summary-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE todos (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', result_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  runProgressMigrations(db);
  db.prepare("INSERT INTO users VALUES ('u1','u1',datetime('now'))").run();
  return { db, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeTodo(db, { id, done = 0, createdAt, snoozedUntil = '' } = {}) {
  db.prepare(
    'INSERT INTO todos(id,user_id,title,done,created_at,snoozed_until) VALUES (?,?,?,?,?,?)'
  ).run(id, 'u1', 'Todo ' + id, done, createdAt, snoozedUntil);
  return id;
}

test('summaryFor: entryCount=0, junges Todo -> nicht dormant, nicht undocumented', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  makeTodo(db, { id: 't-young', createdAt: daysAgoIso(3) });

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-young', refCreatedAt: daysAgoIso(3), refDone: false, refSnoozedUntil: '' }]);
  const s = map.get('todo:t-young');
  assert.equal(s.entryCount, 0);
  assert.equal(s.dormant, false);
  assert.equal(s.undocumented, false);
  assert.equal(s.badgeLabel, null);
  assert.equal(s.orderKey, null);
});

test('summaryFor: entryCount=0, altes Todo -> dormant UND undocumented', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(20);
  makeTodo(db, { id: 't-old', createdAt });

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-old', refCreatedAt: createdAt, refDone: false, refSnoozedUntil: '' }]);
  const s = map.get('todo:t-old');
  assert.equal(s.entryCount, 0);
  assert.equal(s.dormant, true);
  assert.equal(s.undocumented, true);
});

test('summaryFor: done=true unterdrueckt dormant/undocumented trotz Alter', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(30);
  makeTodo(db, { id: 't-done', createdAt, done: 1 });

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-done', refCreatedAt: createdAt, refDone: true, refSnoozedUntil: '' }]);
  const s = map.get('todo:t-done');
  assert.equal(s.dormant, false);
  assert.equal(s.undocumented, false);
});

test('summaryFor: Snooze in der Zukunft unterdrueckt dormant/undocumented', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(30);
  const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  makeTodo(db, { id: 't-snoozed', createdAt, snoozedUntil: future });

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-snoozed', refCreatedAt: createdAt, refDone: false, refSnoozedUntil: future }]);
  const s = map.get('todo:t-snoozed');
  assert.equal(s.dormant, false);
  assert.equal(s.undocumented, false);
});

test('summaryFor: entryCount>0, stale wenn letzter Eintrag > 14 Tage alt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(40);
  makeTodo(db, { id: 't-stale', createdAt });
  insertEntry(db, { userId: 'u1', refType: 'todo', refId: 't-stale', bodyHtml: '<p>a</p>', bodyText: 'a', nowIso: daysAgoIso(30) });
  insertEntry(db, { userId: 'u1', refType: 'todo', refId: 't-stale', bodyHtml: '<p>b</p>', bodyText: 'b', nowIso: daysAgoIso(20) });

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-stale', refCreatedAt: createdAt, refDone: false, refSnoozedUntil: '' }]);
  const s = map.get('todo:t-stale');
  assert.equal(s.entryCount, 2);
  assert.equal(s.stale, true);
  assert.equal(s.badgeEmphasis, 'stale');
  assert.ok(s.badgeLabel.includes('2 Zwischenstände'), s.badgeLabel);
  assert.ok(s.badgeLabel.includes('vor 20 Tagen'), s.badgeLabel);
  assert.ok(s.orderKey);
});

test('summaryFor: entryCount>0, frischer Eintrag -> nicht stale, badgeLabel "heute"', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(1);
  makeTodo(db, { id: 't-fresh', createdAt });
  insertEntry(db, { userId: 'u1', refType: 'todo', refId: 't-fresh', bodyHtml: '<p>a</p>', bodyText: 'a', nowIso: new Date().toISOString() });

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-fresh', refCreatedAt: createdAt, refDone: false, refSnoozedUntil: '' }]);
  const s = map.get('todo:t-fresh');
  assert.equal(s.stale, false);
  assert.equal(s.badgeEmphasis, 'normal');
  assert.ok(s.badgeLabel.includes('1 Zwischenstand'), s.badgeLabel);
  assert.ok(s.badgeLabel.includes('heute'), s.badgeLabel);
});

test('summaryFor: nextStep aus progress_meta wird mitgeliefert', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(1);
  makeTodo(db, { id: 't-next', createdAt });
  setNextStep(db, 'u1', 'todo', 't-next', 'Angebot einholen', new Date().toISOString());

  const map = summaryFor(db, 'u1', [{ refType: 'todo', refId: 't-next', refCreatedAt: createdAt, refDone: false, refSnoozedUntil: '' }]);
  assert.equal(map.get('todo:t-next').nextStep, 'Angebot einholen');
});

test('summaryFor: GENAU EINE Query pro refType (kein N+1)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const items = [];
  for (let i = 0; i < 5; i++) {
    const id = `t-batch-${i}`;
    makeTodo(db, { id, createdAt: daysAgoIso(1) });
    items.push({ refType: 'todo', refId: id, refCreatedAt: daysAgoIso(1), refDone: false, refSnoozedUntil: '' });
  }

  let groupByCalls = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('GROUP BY ref_id')) groupByCalls++;
    return origPrepare(sql);
  };
  try {
    const map = summaryFor(db, 'u1', items);
    assert.equal(map.size, 5);
  } finally {
    db.prepare = origPrepare;
  }
  assert.equal(groupByCalls, 1, 'summaryFor darf pro refType nur EINE GROUP-BY-Query ausfuehren');
});

test('summaryFor: ignoriert defensiv ungueltige Items statt zu werfen', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  assert.doesNotThrow(() => {
    const map = summaryFor(db, 'u1', [null, {}, { refType: 'invalid', refId: 'x' }, { refType: 'todo' }]);
    assert.equal(map.size, 0);
  });
});

test('detailStats: leeres Todo -> reentry.empty=true, ai default', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(1);
  makeTodo(db, { id: 't-empty', createdAt });
  const ref = refInfo(db, 'todo', 't-empty');

  const { stats, reentry } = detailStats(db, 'u1', 'todo', 't-empty', ref);
  assert.equal(stats.entryCount, 0);
  assert.equal(reentry.empty, true);
  assert.deepEqual(reentry.ai, { available: false, frameId: null });
});

test('detailStats: dormant nach DORMANT_DAYS ohne Aktivitaet, dormantLabel gesetzt', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(21); // ~3 Wochen
  makeTodo(db, { id: 't-dormant', createdAt });
  const ref = refInfo(db, 'todo', 't-dormant');

  const { stats, reentry } = detailStats(db, 'u1', 'todo', 't-dormant', ref);
  assert.equal(stats.dormant, true);
  assert.equal(reentry.show, true);
  assert.ok(reentry.dormantSince);
  assert.equal(typeof reentry.dormantLabel, 'string');
  assert.ok(reentry.dormantLabel.length > 0);
});

test('detailStats: nicht dormant innerhalb DORMANT_DAYS', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(2);
  makeTodo(db, { id: 't-active', createdAt });
  const ref = refInfo(db, 'todo', 't-active');

  const { stats, reentry } = detailStats(db, 'u1', 'todo', 't-active', ref);
  assert.equal(stats.dormant, false);
  assert.equal(reentry.show, false);
  assert.equal(reentry.dormantSince, null);
});

test('detailStats: reentry.empty=false sobald eine Beschreibung vorhanden ist (Redesign: kein Zielbild mehr)', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(1);
  const id = 't-desc';
  db.prepare(
    'INSERT INTO todos(id,user_id,title,description,done,created_at,snoozed_until) VALUES (?,?,?,?,?,?,?)'
  ).run(id, 'u1', 'Todo ' + id, '<p>MVP live bringen</p>', 0, createdAt, '');
  const ref = refInfo(db, 'todo', id);

  const { reentry } = detailStats(db, 'u1', 'todo', id, ref);
  assert.equal(reentry.empty, false);
});

test('detailStats: reentry.empty=true ohne Beschreibung, ohne Naechsten Schritt, ohne Zwischenstaende', (t) => {
  const { db, dir } = tempDb();
  t.after(() => cleanup(dir));
  const createdAt = daysAgoIso(1);
  makeTodo(db, { id: 't-empty', createdAt });
  const ref = refInfo(db, 'todo', 't-empty');

  const { reentry } = detailStats(db, 'u1', 'todo', 't-empty', ref);
  assert.equal(reentry.empty, true);
});

test('Konstanten: DORMANT_DAYS=7, STALE_DAYS=14, GAP_DAYS=7', () => {
  assert.equal(DORMANT_DAYS, 7);
  assert.equal(STALE_DAYS, 14);
  assert.equal(GAP_DAYS, 7);
});
