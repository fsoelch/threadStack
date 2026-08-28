'use strict';
// Deckt die JS-seitige Defense-in-Depth-Bereinigung der nativen Editor-
// Bridge ab (ThreadStackApp/ThreadStack/ThreadStack/EditorAssets/
// knowledge-editor.js, Funktion `stripDangerous`). Diese Datei laeuft NIE im
// Node-Server, sondern ausschliesslich in der WKWebView der iOS/macOS-App -
// wird hier trotzdem per jsdom geladen (analog test/web_todo_overview.test.js),
// weil sie reines, browserfaehiges JS ohne native Bridge-Abhaengigkeit ist
// und die Sicherheitslogik damit isoliert vom Rest der App verifizierbar ist.
//
// Hintergrund (Lesbarkeit/Wartbarkeit-Review): der Filter ist bewusst eine
// DENYLIST, keine Allowlist (Rundreise-Erhalt fuer Tabellen/Ueberschriften/
// Bilder etc.). Dieser Test deckt konkret die Luecke ab, die eine reine
// Uppercase-String-Pruefung von node.tagName gegen FORBIDDEN_TAGS hatte:
// Elemente in einem Fremd-Namensraum (SVG/MathML) behalten ihre originale
// Klein-/Grossschreibung und wurden davon nicht erfasst.
const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const path      = require('node:path');
const { JSDOM } = require('jsdom');

const EDITOR_JS_PATH = path.join(__dirname, '..', 'ThreadStackApp', 'ThreadStack', 'ThreadStack', 'EditorAssets', 'knowledge-editor.js');
const EDITOR_JS = fs.readFileSync(EDITOR_JS_PATH, 'utf8');

function loadEditorBridge() {
  const dom = new JSDOM('<div id="editor" contenteditable="true"></div>', { runScripts: 'dangerously' });
  dom.window.eval(EDITOR_JS);
  return dom.window.TSEditor;
}

test('knowledge-editor Bridge: entfernt <script> in einem SVG-Fremdnamensraum (Case-Sensitivity-Bypass)', () => {
  const editor = loadEditorBridge();
  editor.setContent('<svg><script>alert(1)</script></svg><p>Text</p>');
  const out = editor.getContent();
  assert.ok(!out.toLowerCase().includes('<script'), 'kein <script> im Ergebnis');
  assert.ok(out.includes('Text'), 'sichtbarer Text bleibt erhalten');
});

test('knowledge-editor Bridge: entfernt komplettes <svg>-Element unabhängig vom Inhalt', () => {
  const editor = loadEditorBridge();
  editor.setContent('<svg onload="alert(1)"><image href="javascript:alert(2)"></image></svg><p>Rest</p>');
  const out = editor.getContent();
  assert.ok(!/<svg/i.test(out), 'kein <svg> im Ergebnis');
  assert.ok(out.includes('Rest'));
});

test('knowledge-editor Bridge: entfernt weiterhin klassische <script>/<iframe>/on*-Payloads', () => {
  const editor = loadEditorBridge();
  editor.setContent('<p onclick="alert(1)">Text</p><SCRIPT>alert(2)</SCRIPT><iframe src="https://evil.example"></iframe>');
  const out = editor.getContent();
  assert.ok(!/<script/i.test(out));
  assert.ok(!/<iframe/i.test(out));
  assert.ok(!/on\w+\s*=/i.test(out));
  assert.ok(out.includes('Text'));
});

test('knowledge-editor Bridge: erlaubte Tags (Tabellen, Ueberschriften, Bilder) bleiben fuer den Rundreise-Erhalt erhalten', () => {
  const editor = loadEditorBridge();
  editor.setContent('<h1>Titel</h1><table><tr><td>Zelle</td></tr></table><img src="data:image/png;base64,abc" alt="x">');
  const out = editor.getContent();
  assert.ok(/<h1>/i.test(out));
  assert.ok(/<table>/i.test(out));
  assert.ok(/<img/i.test(out));
});
