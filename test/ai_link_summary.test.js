'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const http       = require('node:http');
const bcrypt     = require('bcryptjs');
const crypto     = require('node:crypto');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

// Ein lokaler Test-Server, ähnlich test/safe_fetch.test.js. Wird nur
// erreichbar, weil ALLOW_LOOPBACK_FETCH_FOR_TEST=true gesetzt ist (siehe
// server.js, Abschnitt "KI-Zusammenfassung beim Einfügen von Links" —
// dokumentierte Abweichung zum Schnittstellenvertrag, s. Abschlussbericht).
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const PARAGRAPH = 'Dies ist ein Absatz mit ausreichend Text, damit die Extraktion nicht fehlschlägt. '.repeat(4);
const HTML_PAGE = `<!doctype html><html lang="de"><head><title>Testseite</title></head>
<body><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p></body></html>`;

function createSecondUser(db, username = 'other-user') {
  const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const password = 'other12345';
  db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run(id, username, bcrypt.hashSync(password, 10), 'user', new Date().toISOString());
  return { id, username, password };
}

async function setupAdminWithLinkSummary(app, db, extraFeatures = {}) {
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-XXXX',
    features_enabled: { link_summary: true, ...extraFeatures },
    max_monthly_cost_cents: 0,
    confirm_threshold_cents: 10_000,
  });
  return { admin, agent };
}

test('AI Link-Summary: 401 ohne Login', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));

  const r1 = await request(app).post('/api/ai/link/fetch').send({ url: 'https://example.com' });
  assert.equal(r1.status, 401);
  const r2 = await request(app).post('/api/ai/link/summarize').send({ page_token: 'x', length: 'short' });
  assert.equal(r2.status, 401);
});

test('AI Link-Summary: Feature-Schalter aus (Default) -> 409, kein Netzwerkabruf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-XXXX',
    // link_summary bewusst NICHT aktiviert -> Default false
    max_monthly_cost_cents: 0, confirm_threshold_cents: 10_000,
  });

  let hit = false;
  const srv = await startServer((req, res) => { hit = true; res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const r = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(r.status, 409);
  assert.equal(hit, false, 'safeFetchPage darf bei deaktiviertem Feature nicht aufgerufen werden');
});

test('AI Link-Summary: Budget erschöpft -> 402 vor dem Abruf', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-XXXX',
    features_enabled: { link_summary: true },
    max_monthly_cost_cents: 1, // winziges Budget: assertBudgetOk(0) selbst reicht meist noch,
    confirm_threshold_cents: 10_000,
  });
  // Verbraucht das Budget künstlich über einen anderen Feature-Call ist nicht
  // nötig: max_monthly_cost_cents=1 mit vorherigem spent=0 lässt "0"-Schätzung
  // noch durch. Daher setzen wir das Limit auf einen negativen/0-artigen Fall,
  // indem wir zuerst tatsächlichen Verbrauch erzeugen.
  await agent.put('/api/ai/settings').send({ features_enabled: { link_summary: true, reentry: true } });

  let hit = false;
  const srv = await startServer((req, res) => { hit = true; res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  // Direktes Erschöpfen: Limit auf 0 setzen würde "unlimited" bedeuten (siehe
  // usage.js: limit<=0 -> unlimited), daher auf einen sehr kleinen, aber
  // bereits überschrittenen Wert setzen, nachdem wir echten Verbrauch erzeugt
  // haben, ist nicht praktikabel in diesem isolierten Test. Stattdessen
  // nutzen wir den vom Projekt vorgesehenen Weg: assertBudgetOk wird mit
  // estimatedCents=0 aufgerufen (siehe server.js) — daher muss `spent` bereits
  // über dem Limit liegen. Wir schreiben dazu einen ai_usage-Eintrag direkt.
  const uidRow = db.prepare('SELECT id FROM users WHERE username=?').get(admin.username);
  db.prepare(
    'INSERT INTO ai_usage(id,user_id,feature,provider,model,input_tokens,output_tokens,cost_estimate_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('preexisting', uidRow.id, 'reentry', 'mock', 'mock-1', 10, 10, 5, new Date().toISOString());
  await agent.put('/api/ai/settings').send({ max_monthly_cost_cents: 1 });

  const r = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.code, 'budget_exceeded');
  assert.equal(hit, false, 'safeFetchPage darf bei erschöpftem Budget nicht aufgerufen werden');
});

test('AI Link-Summary: erfolgreicher Fetch liefert page_token', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const r = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(typeof r.body.page_token, 'string');
  assert.match(r.body.page_token, /^[0-9a-f]{32}$/);
  assert.equal(r.body.title, 'Testseite');
  assert.ok(r.body.text_chars > 0);
  assert.equal(r.body.truncated, false);
});

test('AI Link-Summary: page_token eines anderen Nutzers -> 410 (nicht 403)', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const { agent: agent1 } = await setupAdminWithLinkSummary(app, db);

  const other = createSecondUser(db);
  const agent2 = await login(request, app, other.username, other.password);
  await agent2.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-YYYY',
    features_enabled: { link_summary: true },
    max_monthly_cost_cents: 0, confirm_threshold_cents: 10_000,
  });

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const fetched = await agent2.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
  const foreignToken = fetched.body.page_token;

  const r = await agent1.post('/api/ai/link/summarize').send({ page_token: foreignToken, length: 'short' });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'page_token_expired');
});

test('AI Link-Summary: unbekannter/abgelaufener Token -> 410', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const r = await agent.post('/api/ai/link/summarize').send({ page_token: 'does-not-exist', length: 'short' });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'page_token_expired');
});

test('AI Link-Summary: ungültige Länge -> 400 invalid_length', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const r = await agent.post('/api/ai/link/summarize').send({ page_token: 'whatever', length: 'huge' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_length');
});

test('AI Link-Summary: erfolgreicher End-to-End-Fluss inkl. ai_usage-Eintrag', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const { agent, admin } = await setupAdminWithLinkSummary(app, db);

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const fetched = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));

  const r = await agent.post('/api/ai/link/summarize').send({ page_token: fetched.body.page_token, length: 'medium' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(typeof r.body.summary, 'string');
  assert.ok(r.body.summary.length > 0);
  assert.equal(r.body.length, 'medium');
  assert.equal(typeof r.body.cost_cents, 'number');

  const uidRow = db.prepare('SELECT id FROM users WHERE username=?').get(admin.username);
  const usageRow = db.prepare("SELECT * FROM ai_usage WHERE user_id=? AND feature='link_summary'").get(uidRow.id);
  assert.ok(usageRow, 'ai_usage-Eintrag für link_summary erwartet');
});

test('AI Link-Summary: Neu erzeugen mit gleichem Token für alle drei Längen (kein Löschen bei take)', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const fetched = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  const token = fetched.body.page_token;

  const mock = require('../ai/providers/mock');
  const seenMaxTokens = {};
  for (const length of ['short', 'medium', 'long']) {
    const r = await agent.post('/api/ai/link/summarize').send({ page_token: token, length });
    assert.equal(r.status, 200, `${length}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.length, length);
    const call = mock.getLastCall();
    assert.equal(call.feature, 'link_summary');
    seenMaxTokens[length] = call.maxTokens;
  }
  assert.equal(seenMaxTokens.short, 200);
  assert.equal(seenMaxTokens.medium, 400);
  assert.equal(seenMaxTokens.long, 800);
});

test('AI Link-Summary: leere Modellantwort -> 422 empty_summary', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const mock = require('../ai/providers/mock');
  mock.setMockResponse('link_summary', '       ');
  t.after(() => mock.setMockResponse('link_summary', 'Mock-Zusammenfassung.'));

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const fetched = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));

  const r = await agent.post('/api/ai/link/summarize').send({ page_token: fetched.body.page_token, length: 'short' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'empty_summary');
});

test('AI Link-Summary: Confirm-Schwelle erzwingt 428, funktioniert mit ?confirm=true', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const admin = ensureTestAdmin(db);
  const agent = await login(request, app, admin.username, admin.password);
  await agent.put('/api/ai/settings').send({
    provider: 'mock', model: 'mock-1', api_key: 'mock-key-XXXX',
    features_enabled: { link_summary: true },
    max_monthly_cost_cents: 0,
    confirm_threshold_cents: 1,
  });

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  const fetched = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));

  const noConfirm = await agent.post('/api/ai/link/summarize').send({ page_token: fetched.body.page_token, length: 'short' });
  assert.equal(noConfirm.status, 428);
  assert.equal(noConfirm.body.code, 'confirmation_required');

  const withConfirm = await agent.post('/api/ai/link/summarize?confirm=true').send({ page_token: fetched.body.page_token, length: 'short' });
  assert.equal(withConfirm.status, 200, JSON.stringify(withConfirm.body));
});

test('AI Link-Summary: fehlende/leere URL -> 400 invalid_url', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const r = await agent.post('/api/ai/link/fetch').send({ url: '' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_url');
});

test('AI Link-Summary: blockierte Zieladresse liefert generischen Text ohne Netzwerkdetails', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));
  const { agent } = await setupAdminWithLinkSummary(app, db);

  // Ohne ALLOW_LOOPBACK_FETCH_FOR_TEST bleibt Loopback geblockt (SSRF-Schutz).
  // Kein Port angegeben (Standardport), damit die Portprüfung nicht vor der
  // eigentlichen SSRF-Zieladressprüfung greift.
  const r = await agent.post('/api/ai/link/fetch').send({ url: 'http://127.0.0.1/irrelevant' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'blocked_target');
  assert.equal(r.body.error, 'Diese Adresse kann nicht abgerufen werden.');
  assert.ok(!/127\.0\.0\.1/.test(JSON.stringify(r.body)));
});

// ── Nachbesserung nach Security Review ──────────────────────────────────

test('AI Link-Summary: ALLOW_LOOPBACK_FETCH_FOR_TEST ohne NODE_ENV=test bleibt wirkungslos', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const prevNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV; // setupEnv() setzt es normalerweise auf 'test'
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; process.env.NODE_ENV = prevNodeEnv; });
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const r = await agent.post('/api/ai/link/fetch').send({ url: 'http://127.0.0.1/irrelevant' });
  assert.equal(r.status, 403, 'Loopback muss trotz gesetzter Bypass-Variable geblockt bleiben, da NODE_ENV != "test"');
  assert.equal(r.body.code, 'blocked_target');
});

// Hinweis: ein Test für den Concurrency-Guard von /summarize (analog dem
// bereits vorhandenen, ebenfalls ungetesteten linkFetchInProgress-Guard)
// wurde bewusst NICHT ergänzt - supertest sendet über denselben Agent
// (persistente Verbindung) keine wirklich gleichzeitigen Requests, ein
// Promise.all zweier agent.post()-Aufrufe reproduziert die Race-Bedingung
// daher nicht zuverlässig und würde nur einen flaky Test erzeugen. Die
// Guard-Logik ist strukturell identisch zu linkFetchInProgress (synchrones
// Prüfen-dann-Setzen ohne dazwischenliegendes await) und per Code-Review
// verifiziert.

test('AI Link-Summary: Zeitfenster-Rate-Limit greift nach zu vielen Fetches', async (t) => {
  const dir = setupEnv();
  process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST = 'true';
  const { app, db } = loadServer(REPO_ROOT);
  t.after(() => { cleanup(dir); delete process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST; });
  const { agent } = await setupAdminWithLinkSummary(app, db);

  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); });
  t.after(() => srv.close());

  let last;
  for (let i = 0; i < 11; i++) {
    last = await agent.post('/api/ai/link/fetch').send({ url: srv.url });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'rate_limited');
});
