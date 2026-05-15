'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');
const path = require('path');

test('Job-Runner: tickOnce erzeugt Digest wenn enabled + Stunde+DOW passen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  // AI konfigurieren + Digest aktivieren + DOW/Stunde so setzen, dass tickOnce
  // sie als fällig erkennt
  const now = new Date();
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-X',
    features_enabled: { digest: true },
    weekly_digest_enabled: true,
    weekly_digest_dow:  now.getDay(),
    weekly_digest_hour: now.getHours(),
    confirm_threshold_cents: 10_000,
  });

  // Vor Tick: kein Digest
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ai_artifacts WHERE feature='digest'`).get();
  assert.equal(before.n, 0);

  // Tick ausführen
  const jobs = require(path.join(REPO_ROOT, 'ai/jobs'));
  // encryptionKey ist beim Server-Start in das Modul geladen, aber Tests laufen
  // mit Mock-Provider, der keinen Key verwendet — wir reichen einen Dummy durch.
  const fakeKey = require('crypto').randomBytes(32);
  const out = await jobs.tickOnce(db, fakeKey, now);
  assert.equal(out.ran, 1, JSON.stringify(out));

  const after = db.prepare(`SELECT COUNT(*) AS n FROM ai_artifacts WHERE feature='digest'`).get();
  assert.equal(after.n, 1);
});

test('Job-Runner: tickOnce dedupliziert wenn diese Woche bereits gelaufen', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  const now = new Date();
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-X',
    features_enabled: { digest: true },
    weekly_digest_enabled: true,
    weekly_digest_dow:  now.getDay(),
    weekly_digest_hour: now.getHours(),
    confirm_threshold_cents: 10_000,
  });

  const jobs = require(path.join(REPO_ROOT, 'ai/jobs'));
  const key  = require('crypto').randomBytes(32);

  await jobs.tickOnce(db, key, now);
  const r2 = await jobs.tickOnce(db, key, now);
  assert.equal(r2.ran, 0, 'zweiter Tick darf nicht nochmal generieren');

  const n = db.prepare(`SELECT COUNT(*) AS n FROM ai_artifacts WHERE feature='digest'`).get();
  assert.equal(n.n, 1);
});

test('Job-Runner: tickOnce ignoriert Nutzer mit deaktiviertem Digest', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);

  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-X',
    features_enabled: { digest: true },
    weekly_digest_enabled: false,  // ← aus
  });

  const jobs = require(path.join(REPO_ROOT, 'ai/jobs'));
  const out = await jobs.tickOnce(db, require('crypto').randomBytes(32), new Date());
  assert.equal(out.ran, 0);
});
