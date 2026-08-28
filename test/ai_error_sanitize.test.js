'use strict';
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const request   = require('supertest');
const { setupEnv, loadServer, cleanup, bootstrapStackFixture, REPO_ROOT } = require('./helpers');

async function configureMockAi(agent, extra = {}) {
  return agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-XXXX',
    features_enabled: { brief: true, capture: true, result_draft: true, reentry: true, theme_tagging: true, digest: true, cross_meeting: true },
    confirm_threshold_cents: 10_000,
    ...extra,
  });
}

test('aiErr: kontrollierter Anwendungsfehler (< 500) liefert weiterhin die konkrete Klartext-Meldung', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);

  // Kein Provider konfiguriert -> httpErr(409, ...) aus ai/index.js, ein
  // bewusst gesetzter, deutscher Klartext ohne interne Details.
  const r = await agent.post(`/api/ai/topic/${topicId}/suggest-themes`);
  assert.equal(r.status, 409);
  assert.ok(r.body.error && r.body.error.length > 0, 'konkrete Fehlermeldung bleibt erhalten');
});

test('aiErr: ungefilterter Provider-Fehler (>= 500) wird NICHT an den Client durchgereicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent, topicId } = await bootstrapStackFixture(request, app, db);
  await configureMockAi(agent);
  await agent.post('/api/themes').send({ title: 'Strategie' }); // sonst kurzschliesst suggestThemes() vor dem Provider-Call

  const mock = require('../ai/providers/mock');
  const originalCallModel = mock.callModel;
  const sensitiveDetail = 'Verbindung zu internal-provider-host.example:8443 fehlgeschlagen (Request-ID abc-123)';
  mock.callModel = async () => {
    throw new Error(sensitiveDetail);
  };
  t.after(() => { mock.callModel = originalCallModel; });

  const r = await agent.post(`/api/ai/topic/${topicId}/suggest-themes`);
  assert.equal(r.status, 503);
  assert.notEqual(r.body.error, sensitiveDetail, 'rohe Fehlermeldung darf nicht im Response-Body landen');
  assert.ok(!JSON.stringify(r.body).includes('internal-provider-host'), 'kein interner Detail-String im Body');
  assert.equal(r.body.error, 'KI-Anfrage fehlgeschlagen');
});
