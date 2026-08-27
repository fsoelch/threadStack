'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');
const request  = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const queries = require(path.join(REPO_ROOT, 'lib/summaries/queries'));

// lib/progress (Paket S1) legt progress_entries bereits per Migration an
// (lib/progress/schema.js): Spalten (id, user_id, ref_type, ref_id, kind,
// source, body_html, body_text, link_frame_id, client_token, created_at,
// edited_at). Klartext liegt in `body_text`, der Änderungszeitstempel heißt
// `edited_at` (NULL bis zur ersten Bearbeitung).
function insertEntry(db, { id, userId, refType, refId, text = 'note', kind = 'note', createdAt, editedAt = null }) {
  db.prepare(
    `INSERT INTO progress_entries(id,user_id,ref_type,ref_id,kind,source,body_html,body_text,created_at,edited_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, userId, refType, refId, kind, 'manual', text, text, createdAt, editedAt);
}

test('progressSourceVersions: liefert entryCount=0 für unbekannte Refs (kein Absturz)', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));

  const map = queries.progressSourceVersions(db, 'u1', [{ refType: 'todo', refId: 't1' }]);
  const v = map.get('todo:t1');
  assert.equal(v.entryCount, 0);
  assert.equal(v.lastChangeAt, null);
  assert.match(v.sourceVersion, /^sha256:[0-9a-f]{16}$/);
});

test('progressSourceVersions: degradiert defensiv, wenn die Tabelle fehlt (z.B. abweichendes Schema)', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  db.exec('DROP TABLE progress_entries');

  const map = queries.progressSourceVersions(db, 'u1', [{ refType: 'todo', refId: 't1' }]);
  assert.equal(map.get('todo:t1').entryCount, 0);
});

test('progressSourceVersions: zählt Einträge je Ref korrekt (eine Query je refType, kein N+1)', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const u1 = ensureTestAdmin(db).id;
  const u2 = db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES ('u2','u2','x',?)").run(new Date().toISOString()) && 'u2';

  insertEntry(db, { id: 'e1', userId: u1, refType: 'todo', refId: 't1', createdAt: '2026-01-01T00:00:00.000Z' });
  insertEntry(db, { id: 'e2', userId: u1, refType: 'todo', refId: 't1', createdAt: '2026-01-02T00:00:00.000Z' });
  insertEntry(db, { id: 'e3', userId: u1, refType: 'topic', refId: 'top1', createdAt: '2026-01-03T00:00:00.000Z' });
  // andere User dürfen nicht mitgezählt werden
  insertEntry(db, { id: 'e4', userId: u2, refType: 'todo', refId: 't1', createdAt: '2026-01-04T00:00:00.000Z' });

  const map = queries.progressSourceVersions(db, u1, [
    { refType: 'todo', refId: 't1' },
    { refType: 'todo', refId: 't-empty' },
    { refType: 'topic', refId: 'top1' },
  ]);

  assert.equal(map.get('todo:t1').entryCount, 2);
  assert.equal(map.get('todo:t-empty').entryCount, 0);
  assert.equal(map.get('topic:top1').entryCount, 1);
});

test('progressSourceVersions: sourceVersion ändert sich, wenn sich Anzahl oder letzte Änderung ändert', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const u1 = ensureTestAdmin(db).id;

  insertEntry(db, { id: 'e1', userId: u1, refType: 'todo', refId: 't1', createdAt: '2026-01-01T00:00:00.000Z' });
  const v1 = queries.progressSourceVersions(db, u1, [{ refType: 'todo', refId: 't1' }]).get('todo:t1');

  insertEntry(db, { id: 'e2', userId: u1, refType: 'todo', refId: 't1', createdAt: '2026-01-02T00:00:00.000Z' });
  const v2 = queries.progressSourceVersions(db, u1, [{ refType: 'todo', refId: 't1' }]).get('todo:t1');

  assert.notEqual(v1.sourceVersion, v2.sourceVersion);

  // Unverändert erneut abgefragt: gleicher Wert (deterministisch)
  const v2b = queries.progressSourceVersions(db, u1, [{ refType: 'todo', refId: 't1' }]).get('todo:t1');
  assert.equal(v2.sourceVersion, v2b.sourceVersion);
});

test('loadProgressEntryTexts: liest Einträge chronologisch, degradiert defensiv ohne Tabelle', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  db.exec('DROP TABLE progress_entries');

  assert.deepEqual(queries.loadProgressEntryTexts(db, 'u1', 'todo', 't1'), []);
});

test('loadProgressEntryTexts: liest Einträge chronologisch, ignoriert Ergebnis-Einträge', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const u1 = ensureTestAdmin(db).id;

  insertEntry(db, { id: 'e1', userId: u1, refType: 'todo', refId: 't1', text: 'zuerst', createdAt: '2026-01-01T00:00:00.000Z' });
  insertEntry(db, { id: 'e2', userId: u1, refType: 'todo', refId: 't1', text: 'danach', createdAt: '2026-01-02T00:00:00.000Z' });
  insertEntry(db, { id: 'e3', userId: u1, refType: 'todo', refId: 't1', text: 'Ergebnis', kind: 'result', createdAt: '2026-01-03T00:00:00.000Z' });

  const entries = queries.loadProgressEntryTexts(db, u1, 'todo', 't1');
  assert.deepEqual(entries.map(e => e.text), ['zuerst', 'danach']);
});

test('descriptionSourceVersion: deterministisches Format sha256:<16 hex>, ändert sich bei Textänderung', async () => {
  const a = queries.descriptionSourceVersion('Hallo Welt');
  const b = queries.descriptionSourceVersion('Hallo Welt');
  const c = queries.descriptionSourceVersion('Anderer Text');
  assert.match(a, /^sha256:[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('loadArtifacts: liest Artefakte je Kind/refType, ignoriert fremde Features und kaputtes JSON', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const todo = await agent.post('/api/todos').send({ title: 'T' });
  const todoId = todo.body.id;

  const now = new Date().toISOString();
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a1', admin.id, 'todo', todoId, 'progress_summary', JSON.stringify({ summary: 'Fortschritt X', sourceVersion: 'sv1' }), 'mock-1', now);
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a2', admin.id, 'todo', todoId, 'description_summary', 'not-json{{{', 'mock-1', now);
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a3', admin.id, 'todo', todoId, 'brief', JSON.stringify({ summary: 'sollte ignoriert werden' }), 'mock-1', now);

  const map = queries.loadArtifacts(db, admin.id, [{ refType: 'todo', refId: todoId }]);
  assert.equal(map.get(`progress:todo:${todoId}`).summary, 'Fortschritt X');
  assert.equal(map.get(`progress:todo:${todoId}`).sourceVersion, 'sv1');
  assert.equal(map.has(`description:todo:${todoId}`), false, 'kaputtes JSON darf nicht auftauchen');
});

test('loadArtifacts: neuester Treffer je (kind,refType,refId) gewinnt', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const todo = await agent.post('/api/todos').send({ title: 'T' });
  const todoId = todo.body.id;

  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a1', admin.id, 'todo', todoId, 'progress_summary', JSON.stringify({ summary: 'alt' }), 'm1', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('a2', admin.id, 'todo', todoId, 'progress_summary', JSON.stringify({ summary: 'neu' }), 'm2', '2026-01-02T00:00:00.000Z');

  const map = queries.loadArtifacts(db, admin.id, [{ refType: 'todo', refId: todoId }]);
  assert.equal(map.get(`progress:todo:${todoId}`).summary, 'neu');
});

test('deleteForRefs: löscht beide Kinds ohne explizites kind, oder gezielt nur eine Kind', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const todo = await agent.post('/api/todos').send({ title: 'T' });
  const todoId = todo.body.id;
  const now = new Date().toISOString();
  const ins = (id, feature) => db.prepare(
    'INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, admin.id, 'todo', todoId, feature, JSON.stringify({ summary: 'x' }), 'm', now);
  ins('a1', 'progress_summary');
  ins('a2', 'description_summary');

  const r1 = queries.deleteForRefs(db, admin.id, [{ refType: 'todo', refId: todoId, kind: 'progress' }]);
  assert.equal(r1.deleted, 1);
  let remaining = db.prepare('SELECT feature FROM ai_artifacts WHERE ref_id=?').all(todoId);
  assert.deepEqual(remaining.map(r => r.feature), ['description_summary']);

  const r2 = queries.deleteForRefs(db, admin.id, [{ refType: 'todo', refId: todoId }]);
  assert.equal(r2.deleted, 1);
  remaining = db.prepare('SELECT feature FROM ai_artifacts WHERE ref_id=?').all(todoId);
  assert.equal(remaining.length, 0);
});

test('deleteForRefs: leeres Array liefert {deleted:0} und wirft nicht', async (t) => {
  const dir = setupEnv();
  const { db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  assert.deepEqual(queries.deleteForRefs(db, 'u1', []), { deleted: 0 });
  assert.deepEqual(queries.deleteForRefs(db, 'u1', null), { deleted: 0 });
});

test('purgeSummaryOrphans: entfernt Artefakte zu nicht mehr existierenden Todos/Topics, lässt gültige stehen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const todo = await agent.post('/api/todos').send({ title: 'T' });
  const todoId = todo.body.id;
  const now = new Date().toISOString();

  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('valid', admin.id, 'todo', todoId, 'progress_summary', JSON.stringify({ summary: 'x' }), 'm', now);
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('orphan', admin.id, 'todo', 'geloescht-123', 'progress_summary', JSON.stringify({ summary: 'x' }), 'm', now);

  const r = queries.purgeSummaryOrphans(db);
  assert.equal(r.deleted, 1);
  const remaining = db.prepare('SELECT id FROM ai_artifacts WHERE feature=?').all('progress_summary');
  assert.deepEqual(remaining.map(x => x.id), ['valid']);
});
