'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const request    = require('supertest');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');
const { getDocumentXml, getPart } = require('./docx-helpers');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// Liest den DOCX-Response-Buffer aus einem Supertest-Response komplett ein
// (Content-Type ist kein text/*, supertest braucht daher einen Buffer-Parser).
async function fetchDocxBuffer(req) {
  const r = await req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return r;
}

async function buildFixture(agent) {
  const themeA = await agent.post('/api/themes').send({ title: 'Thema A' });
  const themeB = await agent.post('/api/themes').send({ title: 'Unterthema B', parentId: themeA.body.id });

  const pageWithImage = await agent.post('/api/knowledge').send({
    title: 'Seite mit Bild',
    content: `<p>Text</p><img src="data:image/png;base64,${PNG_1PX}" alt="Test">`,
    themeIds: [themeA.body.id],
  });
  const pageNoImage = await agent.post('/api/knowledge').send({
    title: 'Seite ohne Bild', content: '<p>Nur Text</p>', themeIds: [themeB.body.id],
  });
  await agent.post(`/api/knowledge/${pageWithImage.body.id}/links`).send({ targetId: pageNoImage.body.id });

  const todoOpen = await agent.post('/api/todos').send({ title: 'Offenes Todo', dueDate: '2026-08-15' });
  const todoDone = await agent.post('/api/todos').send({ title: 'Erledigtes Todo' });
  await agent.put(`/api/todos/${todoDone.body.id}`).send({ done: true, result: 'Fertig' });
  await agent.post(`/api/themes/${themeA.body.id}/links`).send({ refType: 'todo', refId: todoOpen.body.id });

  return { themeA: themeA.body, themeB: themeB.body, pageWithImage: pageWithImage.body, pageNoImage: pageNoImage.body, todoOpen: todoOpen.body, todoDone: todoDone.body };
}

test('Export: XML (both, mit Graph) enthält Themes, Seiten, Todos', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/xml/);
  assert.match(r.headers['content-disposition'], /attachment; filename\*=UTF-8''ThreadStack-Export-/);
  const xml = r.text;
  assert.match(xml, /<threadstackExport/);
  assert.match(xml, /<theme id="[^"]+" parentId="" title="Thema A">/);
  assert.match(xml, /<theme id="[^"]+" parentId="[^"]+" title="Unterthema B"\/>/);
  assert.match(xml, /<page id="[^"]+" title="Seite mit Bild"/);
  assert.match(xml, /<page id="[^"]+" title="Seite ohne Bild"/);
  assert.match(xml, /<relatedRef id="/);
  assert.match(xml, /<todo id="[^"]+" done="false" title="Offenes Todo"/);
  assert.match(xml, /<todo id="[^"]+" done="true" title="Erledigtes Todo"/);
  assert.match(xml, /data:image\/png;base64/);
});

test('Export: XML scope=todos&openOnly=1 enthält nur offene Todos', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=todos&openOnly=1&format=xml');
  assert.equal(r.status, 200);
  assert.match(r.text, /Offenes Todo/);
  assert.doesNotMatch(r.text, /Erledigtes Todo/);
  assert.doesNotMatch(r.text, /<themes>/); // Todos-Scope exportiert nie Themes
});

test('Export: XML scope=knowledge&graph=0 hat keine Themes/themeRefs', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=knowledge&graph=0&format=xml');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /<themes>/);
  assert.doesNotMatch(r.text, /themeRefs/);
  assert.match(r.text, /Seite mit Bild/);
  assert.match(r.text, /Seite ohne Bild/);
});

test('Export: DOCX ist ein gültiger ZIP-Container (PK-Magic-Number), Bild-Seite wirft nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=both&format=docx').buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(Buffer.isBuffer(r.body));
  assert.ok(r.body.length > 100);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');
});

test('Export: Ownership — zweiter User sieht nur eigene Daten', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const otherId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)')
    .run(otherId, 'other-user', bcrypt.hashSync('irrelevant123', 10), 'user', new Date().toISOString(), '');
  const otherAgent = await login(request, app, 'other-user', 'irrelevant123');

  const r = await otherAgent.get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /Thema A/);
  assert.doesNotMatch(r.text, /Seite mit Bild/);
  assert.doesNotMatch(r.text, /Offenes Todo/);
});

test('Export: Validierung — ungültiger scope/format -> 400', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const r1 = await agent.get('/api/export?scope=invalid&format=xml');
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'VALIDATION_FAILED');

  const r2 = await agent.get('/api/export?scope=both&format=invalid');
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'VALIDATION_FAILED');
});

test('Export: ohne Login -> 401', async (t) => {
  const dir = setupEnv();
  const { app } = loadServer(REPO_ROOT);
  t.after(() => cleanup(dir));

  const r = await request(app).get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 401);
});

// ── Arbeitspaket 8: Robustheit, Route, Regression (Integrations-Gate) ──────

test('Export: is_private-Todo — Regression, Flag beeinflusst Sichtbarkeit im eigenen Export nicht', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  await agent.post('/api/todos').send({ title: 'Privates Todo', isPrivate: true });

  const r = await agent.get('/api/export?scope=todos&format=xml');
  assert.equal(r.status, 200);
  assert.match(r.text, /Privates Todo/);
  assert.match(r.text, /isPrivate="true"/);
});

test('Export: EXPORT_FAILED bei internem Fehler — Response enthält NUR Envelope, keine internen Details', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  // Erzwingt einen internen Fehler (simulierter DB-Fehler) im try-Block von
  // export/index.js, OHNE export/index.js selbst zu veraendern. Wird nach
  // dem Test zuverlaessig zurueckgesetzt.
  const origPrepare = db.prepare.bind(db);
  const secretDetail = 'geheimer-query-parameter-xyz-42';
  db.prepare = () => { throw new Error(`simulierter DB-Fehler mit ${secretDetail} und /interner/pfad/geheim.db`); };
  t.after(() => { db.prepare = origPrepare; });

  const r = await agent.get('/api/export?scope=both&format=docx');
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'Export fehlgeschlagen', code: 'EXPORT_FAILED' });
  const raw = JSON.stringify(r.body);
  assert.doesNotMatch(raw, /geheim/i);
  assert.doesNotMatch(raw, /Error/);
  assert.doesNotMatch(raw, /at\s+\S+\s+\(/); // kein Stacktrace-Zeilenmuster
  assert.doesNotMatch(raw, /\.js:\d+/); // kein Dateipfad+Zeilennummer
});

test('Export: Robustheit bei kaputtem/unvollständigem HTML — 200, gültiger ZIP-Container, kein Absturz', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const deeplyNestedList = (depth) => {
    let inner = 'tiefster Punkt';
    for (let i = 0; i < depth; i++) inner = `<ul><li>${inner}</li></ul>`;
    return inner;
  };

  const malformedKnowledgeContent = [
    '<p>Nicht geschlossener Absatz',
    '<b><i>verschachtelt falsch</b></i>',
    '<table><td>Zelle ohne tr</td></table>',
    '<li>Listenpunkt ohne umgebende Liste</li>',
  ].join('');

  const pageMalformed = await agent.post('/api/knowledge').send({
    title: 'Kaputtes HTML', content: malformedKnowledgeContent,
  });
  assert.equal(pageMalformed.status, 201);

  const pageDeepList = await agent.post('/api/knowledge').send({
    title: 'Extrem verschachtelte Liste', content: deeplyNestedList(25),
  });
  assert.equal(pageDeepList.status, 201);

  const todoMalformed = await agent.post('/api/todos').send({
    title: 'Todo mit kaputtem HTML',
    description: '<b><i>x</b></i><table><td>y</td></table><li>z</li>',
  });
  assert.equal(todoMalformed.status, 201);

  const r = await fetchDocxBuffer(agent.get('/api/export?scope=both&format=docx'));
  assert.equal(r.status, 200);
  assert.ok(Buffer.isBuffer(r.body));
  assert.ok(r.body.length > 100);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');
  // Proxy fuer "Dokument ist wohlgeformt": document.xml lässt sich aus dem
  // ZIP extrahieren und ist selbst geparstes XML (keine leere/kaputte Datei).
  const xml = getDocumentXml(r.body);
  assert.match(xml, /<w:document/);
});

test('Export: Sonderzeichen (Umlaute, Emoji, &, <) erscheinen korrekt in word/document.xml, keine doppelt-kodierten Entities', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const specialTitle = 'Übung ä ö ü ß 😀 & <test>';
  const page = await agent.post('/api/knowledge').send({
    title: specialTitle,
    content: '<p>Größe &amp; Prüfung: 5 &lt; 10, Emoji 🎉</p>',
  });
  assert.equal(page.status, 201);

  const todo = await agent.post('/api/todos').send({
    title: 'Todo Ünïcödé & <Test> 🚀',
  });
  assert.equal(todo.status, 201);

  const r = await fetchDocxBuffer(agent.get('/api/export?scope=both&format=docx'));
  assert.equal(r.status, 200);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');

  const xml = getDocumentXml(r.body);
  // Umlaute/Emoji tauchen als lesbares UTF-8 auf, nicht als kaputte Escapes.
  assert.match(xml, /Übung ä ö ü ß/);
  assert.match(xml, /😀/);
  assert.match(xml, /🎉/);
  assert.match(xml, /Größe/);
  // & und < werden korrekt EINFACH XML-escaped (Word-Standard: &amp; / &lt;),
  // NICHT doppelt kodiert (&amp;amp; waere ein sichtbarer Escape-Rest).
  assert.match(xml, /&amp;/);
  assert.doesNotMatch(xml, /&amp;amp;/);
  assert.doesNotMatch(xml, /&amp;lt;/);
});

test('Export: ZIP-/Content-Types-Struktur — enthält die fuer ein gueltiges Word-Dokument noetigen Kernteile', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await fetchDocxBuffer(agent.get('/api/export?scope=both&format=docx'));
  assert.equal(r.status, 200);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');

  const contentTypes = getPart(r.body, '[Content_Types].xml');
  assert.match(contentTypes, /<Types/);
  const rels = getPart(r.body, '_rels/.rels');
  assert.match(rels, /<Relationships/);
  const documentXml = getPart(r.body, 'word/document.xml');
  assert.match(documentXml, /<w:document/);
  assert.match(documentXml, /<w:body/);
});

test('Export: Regression format=xml — Struktur/Verhalten unveraendert (Scope both, alle Kernelemente vorhanden)', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);
  await buildFixture(agent);

  const r = await agent.get('/api/export?scope=both&format=xml');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'].includes('application/xml'), true);
  assert.match(r.headers['content-disposition'], /attachment; filename\*=UTF-8''ThreadStack-Export-\d{4}-\d{2}-\d{2}\.xml/);
  assert.match(r.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(r.text, /<threadstackExport version="1" exportedAt="[^"]+" scope="both" includesGraph="true" openOnly="false">/);
  assert.match(r.text, /<themes>/);
  assert.match(r.text, /<knowledgePages>/);
  assert.match(r.text, /<todos>/);
});

test('Export: Performance — 200 Wissensseiten + 20 kleine Bilder exportieren in vertretbarer Zeit (<=10s serverseitig)', { timeout: 60000 }, async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  const totalPages = 200;
  const imagePages = 20;
  for (let i = 0; i < totalPages; i++) {
    const withImage = i < imagePages;
    const content = withImage
      ? `<p>Kurzer Inhalt ${i}</p><img src="data:image/png;base64,${PNG_1PX}" alt="Bild ${i}">`
      : `<p>Kurzer Inhalt ${i}</p>`;
    const res = await agent.post('/api/knowledge').send({ title: `Perf-Seite ${i}`, content });
    assert.equal(res.status, 201);
  }

  // Nur die eigentliche Export-Verarbeitungszeit wird gemessen, nicht der
  // Aufbau der Testdaten oben.
  const start = Date.now();
  const r = await fetchDocxBuffer(agent.get('/api/export?scope=knowledge&format=docx'));
  const durationMs = Date.now() - start;

  assert.equal(r.status, 200);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');
  // Gemessene tatsaechliche Dauer (lokaler Referenzlauf, In-Process via
  // supertest, kein echter Netzwerk-Roundtrip): ca. 60-100ms fuer 200 Seiten
  // + 20 eingebettete Bilder. Grenze bewusst grosszuegig (10s) bemessen, um
  // Flakiness auf langsamerer/CI-Hardware zu vermeiden.
  assert.ok(durationMs <= 10000, `Export dauerte ${durationMs}ms, erwartet <=10000ms`);
});
