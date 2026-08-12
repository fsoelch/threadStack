'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const request  = require('supertest');
const { sanitizeKnowledgeHtml, htmlToText, MAX_KNOWLEDGE_CONTENT } = require('../lib/sanitize');
const { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT } = require('./helpers');

test('sanitizeKnowledgeHtml: Allowlist-Sanitizing (Unit)', async (t) => {
  await t.test('script-Tags werden inklusive Inhalt entfernt', () => {
    const out = sanitizeKnowledgeHtml('<p>vor</p><script>alert(1)</script><p>nach</p>');
    assert.ok(!out.includes('<script'));
    assert.ok(!out.includes('alert(1)'));
    assert.ok(out.includes('vor'));
    assert.ok(out.includes('nach'));
  });

  await t.test('on*-Attribute werden entfernt, Tag/Text bleiben', () => {
    const out = sanitizeKnowledgeHtml('<p onclick="doEvil()" onmouseover="doEvil()">Text bleibt</p>');
    assert.ok(!/on\w+\s*=/i.test(out));
    assert.ok(out.includes('Text bleibt'));
  });

  await t.test('style-Tags werden inklusive Inhalt entfernt', () => {
    const out = sanitizeKnowledgeHtml('<style>body{background:url(javascript:alert(1))}</style><p>Rest</p>');
    assert.ok(!out.includes('<style'));
    assert.ok(!out.toLowerCase().includes('javascript'));
    assert.ok(out.includes('Rest'));
  });

  // Arbeitspaket 7 (Farb-Persistenz): `style` ist seit Paket 7 NICHT mehr
  // grundsaetzlich verboten, sondern fuer eine eng begrenzte Menge an Tags
  // NUR fuer die Deklaration `color` (Hex/rgb) erlaubt - siehe lib/colors.js
  // sanitizeStyleAttribute()/allowedStyles in diesem Modul. Ein style-Attribut
  // OHNE gueltige `color`-Deklaration (z.B. nur `background:url(...)`) wird
  // weiterhin vollstaendig entfernt, siehe Test unten.
  await t.test('style-Attribut ohne gueltige color-Deklaration wird komplett entfernt', () => {
    const out = sanitizeKnowledgeHtml('<p style="background:url(javascript:alert(1))">x</p>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.toLowerCase().includes('javascript'));
    assert.ok(out.includes('x'));
  });

  await t.test('style="color:#hex" wird fuer erlaubte Tags durchgelassen', () => {
    const out = sanitizeKnowledgeHtml('<p style="color:#dc2626">x</p>');
    assert.ok(out.includes('style="color:#dc2626"'));
  });

  await t.test('style mit color + verbotener Zusatzdeklaration: nur color bleibt', () => {
    const out = sanitizeKnowledgeHtml('<p style="color:#dc2626;background-color:red">x</p>');
    assert.ok(out.includes('color:#dc2626'));
    assert.ok(!out.toLowerCase().includes('background-color'));
  });

  await t.test('benannte CSS-Farben (kein Hex/rgb) werden verworfen', () => {
    const out = sanitizeKnowledgeHtml('<p style="color:red">x</p>');
    assert.ok(!out.includes('color:red'));
    assert.ok(!/style\s*=/.test(out) || !/color/i.test(out));
    assert.ok(out.includes('x'));
  });

  await t.test('style="expression(alert(1))" wird vollstaendig entfernt', () => {
    const out = sanitizeKnowledgeHtml('<p style="expression(alert(1))">x</p>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.toLowerCase().includes('expression'));
  });

  await t.test('style="position:fixed;top:0" wird vollstaendig entfernt', () => {
    const out = sanitizeKnowledgeHtml('<p style="position:fixed;top:0">x</p>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.toLowerCase().includes('position'));
  });

  await t.test('Tags ohne style in STYLE_ALLOWED_TAGS behalten kein style-Attribut', () => {
    const out = sanitizeKnowledgeHtml('<ul style="color:#dc2626"><li>x</li></ul>');
    assert.ok(!out.includes('<ul style'));
  });

  await t.test('iframe/object/embed/form werden inkl. Inhalt entfernt', () => {
    const out = sanitizeKnowledgeHtml(
      '<iframe src="https://evil.example">innen</iframe>' +
      '<object data="x">innen2</object>' +
      '<embed src="x">' +
      '<form action="/x"><input></form>'
    );
    assert.ok(!out.includes('innen'));
    assert.ok(!out.includes('innen2'));
    assert.ok(!/<iframe|<object|<embed|<form/i.test(out));
  });

  await t.test('Struktur bleibt erhalten: Listen, Tabellen, Ueberschriften', () => {
    const html = '<h2>Titel</h2><ul><li>Punkt 1</li><li>Punkt 2</li></ul>' +
      '<table><thead><tr><th>Spalte</th></tr></thead><tbody><tr><td colspan="2">Zelle</td></tr></tbody></table>' +
      '<blockquote>Zitat</blockquote><pre><code>code();</code></pre>';
    const out = sanitizeKnowledgeHtml(html);
    assert.ok(out.includes('<h2>Titel</h2>'));
    assert.ok(out.includes('<ul>') && out.includes('<li>Punkt 1</li>'));
    assert.ok(out.includes('<table>') && out.includes('<th>Spalte</th>'));
    assert.ok(out.includes('colspan="2"'));
    assert.ok(out.includes('<blockquote>Zitat</blockquote>'));
    assert.ok(out.includes('<pre>') && out.includes('<code>code();</code>'));
  });

  await t.test('javascript:-Links werden entfernt (href-Attribut verschwindet)', () => {
    const out = sanitizeKnowledgeHtml('<a href="javascript:alert(1)">Klick</a>');
    assert.ok(!/href\s*=\s*["']?\s*javascript:/i.test(out));
    assert.ok(out.includes('Klick'));
  });

  await t.test('entity-kodierte javascript-Schemata fuehren nie zu einem javascript:-href', () => {
    const out = sanitizeKnowledgeHtml('<a href="j&#97;vascript:alert(1)">Klick</a>');
    assert.ok(!/href\s*=\s*["']javascript:/i.test(out));
  });

  await t.test('vbscript:- und data:-Schemata bei href werden nicht durchgelassen', () => {
    const out1 = sanitizeKnowledgeHtml('<a href="vbscript:msgbox(1)">x</a>');
    assert.ok(!/href\s*=\s*["']?\s*vbscript:/i.test(out1));
    const out2 = sanitizeKnowledgeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    assert.ok(!/href\s*=\s*["']?\s*data:/i.test(out2));
  });

  await t.test('Link ohne Protokoll bekommt https:// davor', () => {
    const out = sanitizeKnowledgeHtml('<a href="example.com/pfad">Link</a>');
    assert.ok(out.includes('href="https://example.com/pfad"'));
  });

  await t.test('Link mit vorhandenem Protokoll bleibt unveraendert (kein doppeltes https://)', () => {
    const out = sanitizeKnowledgeHtml('<a href="https://example.com">Link</a>');
    assert.ok(out.includes('href="https://example.com"'));
    assert.ok(!out.includes('https://https://'));
  });

  await t.test('mailto:-Links bleiben erlaubt', () => {
    const out = sanitizeKnowledgeHtml('<a href="mailto:test@example.com">Mail</a>');
    assert.ok(out.includes('href="mailto:test@example.com"'));
  });

  await t.test('a-Tags erhalten rel=noopener noreferrer nofollow und target=_blank', () => {
    const out = sanitizeKnowledgeHtml('<a href="https://example.com">Link</a>');
    assert.ok(out.includes('rel="noopener noreferrer nofollow"'));
    assert.ok(out.includes('target="_blank"'));
  });

  await t.test('erlaubte img-data-URIs (png/jpeg/gif/webp) bleiben erhalten', () => {
    const out = sanitizeKnowledgeHtml('<img src="data:image/png;base64,AAAA" alt="Bild" width="10" height="10">');
    assert.ok(out.includes('data:image/png;base64,AAAA'));
  });

  await t.test('nicht erlaubte data-URI-Mimetypes bei img werden entfernt', () => {
    const out = sanitizeKnowledgeHtml('<img src="data:text/html;base64,AAAA" alt="x">');
    assert.ok(!out.includes('<img'));
  });

  await t.test('unbekannte Tags werden entfernt, Text bleibt erhalten', () => {
    const out = sanitizeKnowledgeHtml('<marquee>Laufschrift</marquee>');
    assert.ok(!out.includes('<marquee'));
    assert.ok(out.includes('Laufschrift'));
  });

  await t.test('null/undefined werden zu leerem String', () => {
    assert.equal(sanitizeKnowledgeHtml(null), '');
    assert.equal(sanitizeKnowledgeHtml(undefined), '');
  });
});

test('htmlToText: reiner Text fuer FTS/Snippets', async (t) => {
  await t.test('entfernt Tags, dekodiert Entities, normalisiert Whitespace', () => {
    const out = htmlToText('<p>Hallo&nbsp;&amp;<b>  Welt  </b></p>\n\n<p>zwei</p>');
    assert.equal(out, 'Hallo & Welt zwei');
  });

  await t.test('script/style-Inhalte landen nie im Text', () => {
    const out = htmlToText('<script>alert(1)</script><style>a{}</style><p>sichtbar</p>');
    assert.equal(out, 'sichtbar');
  });

  await t.test('MAX_KNOWLEDGE_CONTENT ist 500000', () => {
    assert.equal(MAX_KNOWLEDGE_CONTENT, 500000);
  });
});

test('sanitizeKnowledgeHtml: Integration ueber POST /api/knowledge', async (t) => {
  const dir = setupEnv();
  const { app, db } = loadServer(REPO_ROOT);
  const admin = ensureTestAdmin(db);
  t.after(() => cleanup(dir));
  const agent = await login(request, app, admin.username, admin.password);

  await t.test('gespeicherter content ist bereits sanitized, content_text ist reiner Text', async () => {
    const r = await agent.post('/api/knowledge').send({
      title: 'Sicherheitstest',
      content: '<p onclick="evil()">Hallo</p><script>alert(1)</script>',
      themeIds: [],
    });
    assert.equal(r.status, 201);
    assert.ok(!r.body.content.includes('<script'));
    assert.ok(!/on\w+=/.test(r.body.content));

    const row = db.prepare('SELECT content, content_text FROM knowledge_pages WHERE id=?').get(r.body.id);
    assert.ok(!row.content.includes('<script'));
    assert.equal(row.content_text, 'Hallo');
  });

  await t.test('CONTENT_TOO_LONG wird vor dem Sanitizing anhand der Rohlaenge geprueft', async () => {
    const tooLong = 'a'.repeat(MAX_KNOWLEDGE_CONTENT + 1);
    const r = await agent.post('/api/knowledge').send({ title: 'Zu lang', content: tooLong, themeIds: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'CONTENT_TOO_LONG');
    assert.equal(r.body.limit, MAX_KNOWLEDGE_CONTENT);
  });
});
