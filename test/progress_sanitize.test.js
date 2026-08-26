'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  sanitizeProgressHtml, progressPlainText, sanitizePlainField, truncateExcerpt,
  MAX_PROGRESS_TEXT, MAX_PROGRESS_HTML, MAX_GOAL, MAX_NEXT_STEP,
} = require('../lib/progress/sanitize');

test('sanitizeProgressHtml: entfernt <img>', () => {
  const out = sanitizeProgressHtml('<p>Text</p><img src="https://evil.example/track.png" onerror="alert(1)">');
  assert.ok(!/<img/i.test(out), `img sollte entfernt sein, war: ${out}`);
  assert.ok(/Text/.test(out));
});

test('sanitizeProgressHtml: entfernt <video>/<audio>/<source> inkl. Inhalt', () => {
  const out = sanitizeProgressHtml(
    '<p>vorher</p><video controls><source src="a.mp4" type="video/mp4">Fallback</video><audio src="a.mp3"></audio><p>nachher</p>'
  );
  assert.ok(!/<video/i.test(out));
  assert.ok(!/<audio/i.test(out));
  assert.ok(!/<source/i.test(out));
  assert.ok(/vorher/.test(out));
  assert.ok(/nachher/.test(out));
});

test('sanitizeProgressHtml: entfernt <script> (ueber die geteilte Allowlist)', () => {
  const out = sanitizeProgressHtml('<p>x</p><script>alert(1)</script>');
  assert.ok(!/<script/i.test(out));
  assert.ok(!/alert\(1\)/.test(out));
});

test('sanitizeProgressHtml: behaelt erlaubte Rich-Text-Tags (delegiert an sanitizeKnowledgeHtml)', () => {
  const out = sanitizeProgressHtml('<p><strong>fett</strong> und <em>kursiv</em></p><ul><li>Punkt</li></ul>');
  assert.ok(/<strong>fett<\/strong>/.test(out));
  assert.ok(/<em>kursiv<\/em>/.test(out));
  assert.ok(/<li>Punkt<\/li>/.test(out));
});

test('sanitizeProgressHtml: null/undefined -> leerer String, wirft nie', () => {
  assert.equal(sanitizeProgressHtml(null), '');
  assert.equal(sanitizeProgressHtml(undefined), '');
  assert.equal(sanitizeProgressHtml(''), '');
});

test('sanitizeProgressHtml: img mit quoted ">" im Attributwert wird trotzdem entfernt', () => {
  const out = sanitizeProgressHtml('<p>a</p><img alt="foo &gt; bar" src="x.png">');
  assert.ok(!/<img/i.test(out));
});

test('sanitizeProgressHtml: verschachteltes/zusammengesetztes <img> ueberlebt nicht (Security Review F1)', () => {
  // Der Regex-Vorstrip (stripDisallowedMediaTags) kann durch ineinander
  // verschachtelte Tag-Fragmente umgangen werden, die sich erst NACH dem
  // Vorstrip zu einem gueltigen <img> zusammensetzen. Die eigentliche
  // Sicherheitsgrenze ist deshalb allowImages:false in der Allowlist selbst.
  const out1 = sanitizeProgressHtml('<<img>img src="https://evil.example/p.png">');
  assert.ok(!/<img/i.test(out1), `img sollte entfernt sein, war: ${out1}`);
  const out2 = sanitizeProgressHtml('<im<img>g src="https://evil.example/p.png">');
  assert.ok(!/<img/i.test(out2), `img sollte entfernt sein, war: ${out2}`);
});

test('sanitizePlainField: doppelt kodierte Entities erzeugen kein Markup mehr (Security Review F2)', () => {
  const out1 = sanitizePlainField('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
  assert.ok(!/[<>]/.test(out1), `sollte keine spitzen Klammern enthalten, war: ${out1}`);
  const out2 = sanitizePlainField('<b>hi</b> &amp;lt;img src=x onerror=1&amp;gt;');
  assert.ok(!/[<>]/.test(out2), `sollte keine spitzen Klammern enthalten, war: ${out2}`);
  assert.ok(/hi/.test(out2));
});

test('progressPlainText: entfernt Markup, normalisiert Whitespace', () => {
  const out = progressPlainText('<p>Hallo   <strong>Welt</strong>\n\n  !</p>');
  assert.equal(out, 'Hallo Welt !');
});

test('sanitizePlainField: entfernt Markup + trimmt + kollabiert Whitespace', () => {
  assert.equal(sanitizePlainField('  <b>Ziel</b>   erreichen  '), 'Ziel erreichen');
  assert.equal(sanitizePlainField(''), '');
  assert.equal(sanitizePlainField(null), '');
});

test('truncateExcerpt: kuerzt wortweise mit Ellipse', () => {
  const text = 'Dies ist ein laengerer Beispieltext für den Kürzungstest der Funktion truncateExcerpt.';
  const out = truncateExcerpt(text, 20);
  assert.ok(out.length <= 21, `zu lang: "${out}" (${out.length})`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.slice(0, -1).endsWith(' '));
});

test('truncateExcerpt: kein Kuerzen wenn Text kurz genug', () => {
  assert.equal(truncateExcerpt('kurz', 280), 'kurz');
});

test('truncateExcerpt: Default-Laenge 280', () => {
  const text = 'x'.repeat(300);
  const out = truncateExcerpt(text);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 281);
});

test('truncateExcerpt: leerer/nullish Text', () => {
  assert.equal(truncateExcerpt(''), '');
  assert.equal(truncateExcerpt(null), '');
  assert.equal(truncateExcerpt(undefined), '');
});

test('Konstanten: exakte Laengengrenzen', () => {
  assert.equal(MAX_GOAL, 500);
  assert.equal(MAX_NEXT_STEP, 1000);
  assert.equal(MAX_PROGRESS_TEXT, 5000);
  assert.equal(MAX_PROGRESS_HTML, 50000);
});

// MAX_NEXT_STEP MUSS identisch zur bestehenden Stack-Notiz-Grenze in
// server.js bleiben (`const MAX_NOTE = 1000;`). Diese Prüfung liest
// server.js NUR als Text (kein require, kein Serverstart) und verifiziert
// den exakten Wortlaut, damit S2 spaeter aktiv gewarnt wird, falls server.js
// MAX_NOTE jemals aendert, ohne diesen Vertrag nachzuziehen.
test('MAX_NEXT_STEP bleibt exakt zu server.js MAX_NOTE synchron (1000)', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(
    /const\s+MAX_NOTE\s*=\s*1000\s*;/.test(serverSrc),
    'server.js MAX_NOTE hat sich geaendert - MAX_NEXT_STEP in lib/progress/sanitize.js gegenpruefen!'
  );
  assert.equal(MAX_NEXT_STEP, 1000);
});
