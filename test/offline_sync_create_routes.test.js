'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupEnv, loadServer, cleanup, ensureTestAdmin, login, REPO_ROOT } = require('./helpers');

async function boot(t) {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#6366f1' });
  return { app, db, admin, agent, meetingId: m.body.id };
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

test('Todo: Replay liefert dieselbe ID, keine Duplikate', async (t) => {
  const { agent, db } = await boot(t);
  const a = await agent.post('/api/todos').send({ title: 'T', clientToken: 'tok-1' });
  assert.equal(a.status, 201);
  assert.equal(a.body.idempotent, undefined);
  const before = count(db, 'todos');
  const b = await agent.post('/api/todos').send({ title: 'T anders', clientToken: 'tok-1' });
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.title, 'T');
  assert.equal(b.body.idempotent, true);
  assert.deepEqual(b.body.aiSummary, { pending: false });
  assert.deepEqual(b.body.contacts, []);
  assert.equal(count(db, 'todos'), before);
  assert.equal(count(db, 'client_create_tokens'), 1);
});

test('Todo: Replay ueberspringt Validierung (Token-Pruefung vor Body-Validierung)', async (t) => {
  const { agent } = await boot(t);
  const a = await agent.post('/api/todos').send({ title: 'T', clientToken: 'tok-v' });
  const b = await agent.post('/api/todos').send({ clientToken: 'tok-v' });
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
});

test('Todo: ungueltiges Token 400, leer/null gilt als fehlend', async (t) => {
  const { agent, db } = await boot(t);
  for (const bad of ['a b', 'x'.repeat(65), 123, {}, "a'; DROP"]) {
    const r = await agent.post('/api/todos').send({ title: 'T', clientToken: bad });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_CLIENT_TOKEN');
    assert.equal(r.body.error, 'Ungültiges Client-Token.');
  }
  assert.equal(count(db, 'todos'), 0);
  for (const ok of ['', null]) {
    const r = await agent.post('/api/todos').send({ title: 'T', clientToken: ok });
    assert.equal(r.status, 201);
  }
  assert.equal(count(db, 'client_create_tokens'), 0);
});

test('Typ-Kollision: Todo-Token fuer Topic und umgekehrt -> 409', async (t) => {
  const { agent, meetingId, db } = await boot(t);
  await agent.post('/api/todos').send({ title: 'T', clientToken: 'shared' });
  const r1 = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'shared' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'CLIENT_TOKEN_CONFLICT');
  await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'shared2' });
  const r2 = await agent.post('/api/todos').send({ title: 'T', clientToken: 'shared2' });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'CLIENT_TOKEN_CONFLICT');
  assert.equal(count(db, 'todos'), 1);
  assert.equal(count(db, 'topics'), 1);
});

test('Geloeschtes Ziel -> 410 mit refType/refId (Todo und Topic)', async (t) => {
  const { agent, meetingId, db } = await boot(t);
  const td = await agent.post('/api/todos').send({ title: 'T', clientToken: 'g1' });
  assert.equal((await agent.delete(`/api/todos/${td.body.id}`)).status, 200);
  const r = await agent.post('/api/todos').send({ title: 'T', clientToken: 'g1' });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'CLIENT_TOKEN_TARGET_GONE');
  assert.equal(r.body.refType, 'todo');
  assert.equal(r.body.refId, td.body.id);
  assert.equal(count(db, 'todos'), 0);

  const tp = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'g2' });
  await agent.delete(`/api/meetings/${meetingId}/topics/${tp.body.id}`);
  const r2 = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'g2' });
  assert.equal(r2.status, 410);
  assert.equal(r2.body.refType, 'topic');
  assert.equal(r2.body.refId, tp.body.id);
});

test('Topic: Replay liefert dieselbe ID, auch mit abweichender Meeting-ID im Pfad', async (t) => {
  const { agent, meetingId, db } = await boot(t);
  const a = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'tp1' });
  assert.equal(a.status, 201);
  const other = await agent.post('/api/meetings').send({ title: 'M2', color: '#6366f1' });
  const b = await agent.post(`/api/meetings/${other.body.id}/topics`).send({ title: 'X', clientToken: 'tp1' });
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.idempotent, true);
  assert.deepEqual(b.body.contacts, []);
  assert.equal(count(db, 'topics'), 1);
});

test('capturedAt Todo: fehlend, gueltig, Zukunft/zu alt geklemmt, ungueltig 400', async (t) => {
  const { agent, db } = await boot(t);
  const t0 = Date.now();
  const none = await agent.post('/api/todos').send({ title: 'a' });
  assert.ok(Date.parse(none.body.createdAt) >= t0 - 1000);

  const good = iso(-3 * 86400000);
  const ok = await agent.post('/api/todos').send({ title: 'b', capturedAt: good });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.createdAt, good);

  const fut = await agent.post('/api/todos').send({ title: 'c', capturedAt: iso(3600000) });
  assert.ok(Math.abs(Date.parse(fut.body.createdAt) - Date.now()) < 5000);
  const old = await agent.post('/api/todos').send({ title: 'd', capturedAt: iso(-400 * 86400000) });
  assert.ok(Math.abs(Date.parse(old.body.createdAt) - Date.now()) < 5000);

  const before = count(db, 'todos');
  for (const bad of ['gestern', '2026-01-01', 42]) {
    const r = await agent.post('/api/todos').send({ title: 'e', capturedAt: bad, clientToken: 'ca-bad' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_CAPTURED_AT');
  }
  assert.equal(count(db, 'todos'), before);
  assert.equal(count(db, 'client_create_tokens'), 0);
});

test('capturedAt Topic: gueltig uebernommen, ungueltig 400', async (t) => {
  const { agent, meetingId } = await boot(t);
  const good = iso(-86400000);
  const ok = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'x', capturedAt: good });
  assert.equal(ok.body.createdAt, good);
  const bad = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'x', capturedAt: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_CAPTURED_AT');
});

test('Gleiches Token bei anderem Nutzer bleibt unabhaengig', async (t) => {
  const { app, db, agent, meetingId } = await boot(t);
  db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('u-two', 'zwei', bcrypt.hashSync('pw-zwei-123', 4), 'user', new Date().toISOString());
  const a2 = await login(request, app, 'zwei', 'pw-zwei-123');
  const r1 = await agent.post('/api/todos').send({ title: 'A', clientToken: 'same' });
  const r2 = await a2.post('/api/todos').send({ title: 'B', clientToken: 'same' });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.notEqual(r1.body.id, r2.body.id);
  // Fremdes Meeting: kein Leak ueber das Token, Nutzer 2 bekommt 404
  const tp = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'tpx' });
  const leak = await a2.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'tpx' });
  assert.equal(leak.status, 404);
  assert.notEqual(leak.body.id, tp.body.id);
});

test('Archiviertes Meeting: mit vorhandenem Token 200, sonst 409', async (t) => {
  const { agent, meetingId, db } = await boot(t);
  const a = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'ar1' });
  assert.equal((await agent.post(`/api/archive/meeting/${meetingId}`)).status, 200);
  const replay = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X', clientToken: 'ar1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, a.body.id);
  const fresh = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'Y', clientToken: 'ar2' });
  assert.equal(fresh.status, 409);
  assert.equal(fresh.body.code, 'ARCHIVED_READONLY');
  assert.equal(count(db, 'topics'), 1);
  assert.equal(count(db, 'client_create_tokens'), 1);
});

test('Ohne Token unveraendert 201 ohne Mapping-Zeile', async (t) => {
  const { agent, meetingId, db } = await boot(t);
  const a = await agent.post('/api/todos').send({ title: 'T' });
  const b = await agent.post(`/api/meetings/${meetingId}/topics`).send({ title: 'X' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(count(db, 'client_create_tokens'), 0);
  const c = await agent.post('/api/todos').send({ title: '   ' });
  assert.equal(c.status, 400);
  assert.equal(c.body.error, 'Titel erforderlich');
});

test('Nutzer loeschen kaskadiert Mappings', async (t) => {
  const { db, agent, admin } = await boot(t);
  await agent.post('/api/todos').send({ title: 'T', clientToken: 'casc' });
  assert.equal(count(db, 'client_create_tokens'), 1);
  db.prepare('DELETE FROM users WHERE id=?').run(admin.id);
  assert.equal(count(db, 'client_create_tokens'), 0);
});

test('Fehlgeschlagene Validierung hinterlaesst kein Mapping', async (t) => {
  const { agent, db } = await boot(t);
  const r = await agent.post('/api/todos').send({ title: '', clientToken: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(count(db, 'client_create_tokens'), 0);
});
