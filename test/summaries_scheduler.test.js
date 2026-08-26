'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');
const request  = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

const { createSummaryScheduler } = require(path.join(REPO_ROOT, 'lib/summaries/scheduler'));

// Der Scheduler wird hier ausschließlich mit einem selbst gebauten Mock für
// `ai` getestet (siehe Task-Vorgabe: eigene Tests mit Mocks für ai/index.js,
// da summarizeProgress/summarizeDescription erst mit Paket S2 real existieren).
// loadSettings/assertActive bilden dabei exakt die im Vertrag beschriebene
// Vorrangregel nach (globally_disabled/kein Provider|Key/Feature-Flag).
function makeMockAi({ settings, summarizeProgress, summarizeDescription } = {}) {
  const s = Object.assign({
    globally_disabled: false,
    provider: 'mock',
    api_key_encrypted: 'enc',
    features_enabled: { progress_summary: true, description_summary: true },
  }, settings);
  return {
    loadSettings: () => s,
    assertActive: (settingsArg, feature) => {
      if (!settingsArg) { const e = new Error('AI nicht konfiguriert'); e.httpStatus = 409; throw e; }
      if (settingsArg.globally_disabled) { const e = new Error('AI ist deaktiviert'); e.httpStatus = 409; throw e; }
      if (!settingsArg.provider || !settingsArg.api_key_encrypted) { const e = new Error('kein Provider/Key'); e.httpStatus = 409; throw e; }
      if (feature && !settingsArg.features_enabled[feature]) { const e = new Error('Feature aus'); e.httpStatus = 409; throw e; }
    },
    summarizeProgress: summarizeProgress || (async () => ({ artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 })),
    summarizeDescription: summarizeDescription || (async () => ({ artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 })),
    _settingsRef: s,
  };
}

function createProgressEntriesTable(db) {
  db.exec(`
    CREATE TABLE progress_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT
    );
  `);
}
let entrySeq = 0;
function addProgressEntries(db, userId, refType, refId, n) {
  const stmt = db.prepare('INSERT INTO progress_entries(id,user_id,ref_type,ref_id,text,created_at) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < n; i++) {
    entrySeq++;
    stmt.run(`e${refId}-${entrySeq}`, userId, refType, refId, `entry ${entrySeq}`, `2026-01-0${(entrySeq % 9) + 1}T00:00:00.000Z`);
  }
}

const LONG_DESC = 'x'.repeat(650);

async function setup(t) {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  createProgressEntriesTable(db);
  return { db, agent, userId: admin.id };
}

test('enqueue: false wenn AI deaktiviert (globally_disabled) — kein Job wird angelegt', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  addProgressEntries(db, userId, 'todo', todo.body.id, 3);

  const ai = makeMockAi({ settings: { globally_disabled: true } });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });

  const ok = scheduler.enqueue({ userId, kind: 'progress', refType: 'todo', refId: todo.body.id, reason: 'created' });
  assert.equal(ok, false);
  assert.equal(scheduler.status(userId, 'progress', 'todo', todo.body.id), null);
  scheduler.stop();
});

test('enqueue: false wenn Ref erledigt ist', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  await agent.put(`/api/todos/${todo.body.id}`).send({ done: true });

  const ai = makeMockAi();
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  assert.equal(ok, false);
  scheduler.stop();
});

test('enqueue: Topic gilt als schreibgeschützt/archiviert -> kein Job (Test-Seam)', async (t) => {
  const { db, agent, userId } = await setup(t);
  const m = await agent.post('/api/meetings').send({ title: 'M', color: '#4f46e5' });
  const topic = await agent.post(`/api/meetings/${m.body.id}/topics`).send({ title: 'Top', description: LONG_DESC });

  const ai = makeMockAi();
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  scheduler._setArchiveForTests({ isTopicArchived: () => true });

  const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'topic', refId: topic.body.id, reason: 'updated' });
  assert.equal(ok, false);
  scheduler.stop();
});

test('enqueue: Schwellwert unterschritten -> kein Job, vorhandenes Artefakt wird gelöscht', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: 'kurz' });
  db.prepare('INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('art1', userId, 'todo', todo.body.id, 'description_summary', JSON.stringify({ summary: 'alt' }), 'm', new Date().toISOString());

  const ai = makeMockAi();
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  assert.equal(ok, false);

  const remaining = db.prepare('SELECT id FROM ai_artifacts WHERE ref_id=?').all(todo.body.id);
  assert.equal(remaining.length, 0, 'Artefakt muss bei Schwellwert-Unterschreitung entfernt werden');
  scheduler.stop();
});

test('enqueue + drain: erfolgreicher Lauf setzt Status zurück auf null, ruft ai genau einmal auf', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  let calls = 0;
  const ai = makeMockAi({ summarizeDescription: async () => { calls++; return { artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 }; } });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });

  const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  assert.equal(ok, true);
  assert.deepEqual(scheduler.status(userId, 'description', 'todo', todo.body.id)?.state, 'pending');

  await scheduler.drain();
  assert.equal(calls, 1);
  assert.equal(scheduler.status(userId, 'description', 'todo', todo.body.id), null);
  scheduler.stop();
});

test('enqueue: mehrfaches Enqueue desselben Schlüssels wird gecoalesced (kein zweiter Job)', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  let calls = 0;
  const ai = makeMockAi({ summarizeDescription: async () => { calls++; return { artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 }; } });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });

  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });

  await scheduler.drain();
  assert.equal(calls, 1, 'Coalescing: nur ein tatsächlicher Aufruf trotz dreifachem enqueue');
  scheduler.stop();
});

test('enqueue: Re-Run wird nachgeholt, wenn während der laufenden Ausführung erneut enqueued wird', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  let calls = 0;
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const ai = makeMockAi({
    summarizeDescription: async () => {
      calls++;
      if (calls === 1) await gate;
      return { artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 };
    },
  });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });

  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  const drainPromise = scheduler.drain();

  // Kurz warten, bis der erste Lauf sicher gestartet ist (running-State),
  // dann erneut enqueuen -> muss als pendingRerun vorgemerkt werden.
  await new Promise(r => setTimeout(r, 20));
  const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  assert.equal(ok, true);

  releaseFirst();
  await drainPromise;

  assert.equal(calls, 2, 'nach der laufenden Ausführung muss genau ein Re-Run erfolgen');
  scheduler.stop();
});

test('enqueue: Warteschlangen-Deckel (MAX_QUEUE_PER_USER) verwirft weitere neue Jobs', async (t) => {
  const { db, agent, userId } = await setup(t);
  const ai = makeMockAi();
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });

  const ids = [];
  for (let i = 0; i < 51; i++) {
    const todo = await agent.post('/api/todos').send({ title: `T${i}`, description: LONG_DESC });
    ids.push(todo.body.id);
  }
  let acceptedCount = 0;
  for (const id of ids) {
    const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: id, reason: 'updated' });
    if (ok) acceptedCount++;
  }
  assert.equal(acceptedCount, 50, 'MAX_QUEUE_PER_USER=50 darf nicht überschritten werden');
  scheduler.stop();
});

test('runJob: Retry ausschließlich bei 503, danach Erfolg -> kein Fehlerstatus, zwei Aufrufe', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  let calls = 0;
  const ai = makeMockAi({
    summarizeDescription: async () => {
      calls++;
      if (calls === 1) { const e = new Error('temporär nicht erreichbar'); e.httpStatus = 503; throw e; }
      return { artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 };
    },
  });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  await scheduler.drain();

  assert.equal(calls, 2);
  assert.equal(scheduler.status(userId, 'description', 'todo', todo.body.id), null);
  scheduler.stop();
});

test('runJob: 503 zweimal in Folge -> genau 2 Aufrufe (MAX_CALLS_PER_JOB), Fehlerstatus ai_unavailable', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  let calls = 0;
  const ai = makeMockAi({
    summarizeDescription: async () => { calls++; const e = new Error('down'); e.httpStatus = 503; throw e; },
  });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  await scheduler.drain();

  assert.equal(calls, 2);
  const st = scheduler.status(userId, 'description', 'todo', todo.body.id);
  assert.equal(st.state, 'error');
  assert.equal(st.errorCode, 'ai_unavailable');
  scheduler.stop();
});

test('runJob: 402/428/422 werden auf die korrekten errorCodes gemappt, kein Retry', async (t) => {
  for (const [status, code] of [[402, 'budget_exceeded'], [428, 'confirmation_required'], [422, 'generation_failed']]) {
    await test(`mapping ${status} -> ${code}`, async (t2) => {
      const { db, agent, userId } = await setup(t2);
      const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
      let calls = 0;
      const ai = makeMockAi({
        summarizeDescription: async () => { calls++; const e = new Error('x'); e.httpStatus = status; throw e; },
      });
      const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
      scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
      await scheduler.drain();
      assert.equal(calls, 1, 'kein Retry außer bei 503');
      const st = scheduler.status(userId, 'description', 'todo', todo.body.id);
      assert.equal(st.state, 'error');
      assert.equal(st.errorCode, code);
      scheduler.stop();
    });
  }
});

test('status: Fehlerzustand verfällt nach TTL (15 Minuten)', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  const ai = makeMockAi({
    summarizeDescription: async () => { const e = new Error('x'); e.httpStatus = 422; throw e; },
  });
  let current = new Date('2026-01-01T00:00:00.000Z');
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => current });
  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  await scheduler.drain();

  assert.equal(scheduler.status(userId, 'description', 'todo', todo.body.id).state, 'error');

  current = new Date(current.getTime() + 16 * 60 * 1000);
  assert.equal(scheduler.status(userId, 'description', 'todo', todo.body.id), null);
  scheduler.stop();
});

test('enqueue: Bestätigungs-Gating wird an ai.summarizeDescription durchgereicht', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  let seenConfirmed = null;
  const ai = makeMockAi({
    summarizeDescription: async ({ confirmed }) => { seenConfirmed = confirmed; return { artifact_id: 'a', content: { summary: 'ok' }, cost_cents: 0 }; },
  });
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'manual', confirmed: true });
  await scheduler.drain();
  assert.equal(seenConfirmed, true);
  scheduler.stop();
});

test('stop(): weitere enqueue()-Aufrufe werden danach verworfen', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: LONG_DESC });
  const ai = makeMockAi();
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });
  scheduler.stop();
  const ok = scheduler.enqueue({ userId, kind: 'description', refType: 'todo', refId: todo.body.id, reason: 'updated' });
  assert.equal(ok, false);
});

test('enqueue: progress-Kind nutzt PROGRESS_MIN_ENTRIES (2), nicht die Beschreibungslänge', async (t) => {
  const { db, agent, userId } = await setup(t);
  const todo = await agent.post('/api/todos').send({ title: 'T', description: '' });
  addProgressEntries(db, userId, 'todo', todo.body.id, 1);
  const ai = makeMockAi();
  const scheduler = createSummaryScheduler({ db, encryptionKey: Buffer.alloc(32), ai, now: () => new Date() });

  assert.equal(scheduler.enqueue({ userId, kind: 'progress', refType: 'todo', refId: todo.body.id, reason: 'created' }), false);

  addProgressEntries(db, userId, 'todo', todo.body.id, 1); // jetzt 2 Einträge
  assert.equal(scheduler.enqueue({ userId, kind: 'progress', refType: 'todo', refId: todo.body.id, reason: 'created' }), true);
  scheduler.stop();
});
