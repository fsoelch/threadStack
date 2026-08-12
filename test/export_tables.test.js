'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Parser } = require('htmlparser2');
const { Paragraph, TextRun, Table } = require('docx');

const { createRenderContext } = require('../export/html/context');
const { buildTableBlocks } = require('../export/html/tables');

// ---------------------------------------------------------------------------
// Test-Infrastruktur: eigener kleiner HTML->DOM Parser (identisch im Aufbau
// zum Parser in export/htmlToDocx.js) sowie ein minimaler Fake fuer
// buildBlocks/inlineRunsOf, da Paket 2 (parse/inline/blocks) diese Dispatcher
// noch nicht bereitstellt. Der Fake bildet nur so viel HTML-Semantik nach,
// wie fuer die Akzeptanzkriterien von Paket 4 (Tabellen) noetig ist:
// - <p> -> ein Paragraph
// - <ul>/<ol> -> ein Paragraph je <li> (Struktur bleibt erhalten, keine Verschmelzung)
// - Text direkt in der Zelle -> ein Paragraph
// ---------------------------------------------------------------------------

function parseHtml(html) {
  const dom = [];
  const stack = [{ children: dom }];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const node = { type: 'tag', name, attribs, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      },
      ontext(text) {
        stack[stack.length - 1].children.push({ type: 'text', data: text });
      },
      onclosetag() {
        if (stack.length > 1) stack.pop();
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return dom;
}

function findTableNode(html) {
  const dom = parseHtml(html);
  return dom.find((n) => n.type === 'tag' && n.name === 'table');
}

function fakeInlineRunsOf(nodes, style) {
  const runs = [];
  for (const node of nodes || []) {
    if (node.type === 'text') {
      if (node.data) runs.push(new TextRun({ text: node.data, ...style }));
    } else if (node.type === 'tag') {
      runs.push(...fakeInlineRunsOf(node.children || [], style));
    }
  }
  return runs;
}

function fakeBuildBlocks(nodes, ctx) {
  const blocks = [];
  for (const node of nodes || []) {
    if (node.type === 'text') {
      if (node.data && node.data.trim()) {
        blocks.push(new Paragraph({ children: [new TextRun(node.data)] }));
      }
      continue;
    }
    if (node.type !== 'tag') continue;
    if (node.name === 'p') {
      blocks.push(new Paragraph({ children: fakeInlineRunsOf(node.children || [], {}) }));
    } else if (node.name === 'ul' || node.name === 'ol') {
      for (const li of (node.children || []).filter((c) => c.type === 'tag' && c.name === 'li')) {
        blocks.push(new Paragraph({ children: fakeInlineRunsOf(li.children || [], {}) }));
      }
    } else {
      blocks.push(...fakeBuildBlocks(node.children || [], ctx));
    }
  }
  return blocks;
}

function makeCtx() {
  const warnings = [];
  const ctx = createRenderContext({
    numbering: { allocate: () => 'ol-1', buildConfig: () => ({ config: [] }) },
    buildBlocks: fakeBuildBlocks,
    inlineRunsOf: fakeInlineRunsOf,
    warn: (code) => warnings.push(code),
  });
  return { ctx, warnings };
}

// ---------------------------------------------------------------------------
// Introspektions-Helfer: docx-Objekte bauen intern eine XmlComponent-Baumstruktur
// { rootKey, root: [...] } auf, die via JSON.stringify vollstaendig serialisiert
// werden kann. Damit koennen wir Struktur/Attribute pruefen ohne einen echten
// .docx zu packen und zu entpacken.
// ---------------------------------------------------------------------------

function toJson(docxObject) {
  return JSON.parse(JSON.stringify(docxObject));
}

/** Rekursive Tiefensuche nach allen Knoten mit gegebenem rootKey. */
function findAllByRootKey(node, rootKey, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.rootKey === rootKey) out.push(node);
  if (Array.isArray(node.root)) {
    for (const child of node.root) findAllByRootKey(child, rootKey, out);
  } else if (Array.isArray(node)) {
    for (const child of node) findAllByRootKey(child, rootKey, out);
  }
  return out;
}

function attrOf(node) {
  const attrNode = (node.root || []).find((n) => n && n.rootKey === '_attr');
  return attrNode ? attrNode.root : {};
}

/**
 * docx serialisiert manche Attribute als einfachen Skalar (z.B. gridSpan.val
 * = 2) und andere als {key, value}-Objekt (z.B. tblW.type). Diese Funktion
 * vereinheitlicht beide Faelle fuer die Testassertions.
 */
function attrVal(raw) {
  if (raw && typeof raw === 'object' && 'value' in raw) return raw.value;
  return raw;
}

// ---------------------------------------------------------------------------

test('buildTableBlocks: leere Tabelle ohne <tr> liefert []', () => {
  const { ctx } = makeCtx();
  const node = findTableNode('<table><thead></thead><tbody></tbody></table>');
  const result = buildTableBlocks(node, ctx);
  assert.deepEqual(result, []);
});

test('buildTableBlocks: nach der Tabelle folgt ein leerer Absatz', () => {
  const { ctx } = makeCtx();
  const node = findTableNode('<table><tr><td>A</td></tr></table>');
  const result = buildTableBlocks(node, ctx);
  assert.equal(result.length, 2);
  assert.ok(result[0] instanceof Table);
  assert.ok(result[1] instanceof Paragraph);
  const json = toJson(result[1]);
  assert.equal(findAllByRootKey(json, 'w:r').length, 0, 'leerer Absatz darf keine Runs enthalten');
});

test('buildTableBlocks: einfache 2-Spalten-Tabelle mit thead + 2 Datenzeilen', () => {
  const { ctx, warnings } = makeCtx();
  const html = `
    <table>
      <thead><tr><th>Name</th><th>Wert</th></tr></thead>
      <tbody>
        <tr><td>Zeile 1</td><td>1</td></tr>
        <tr><td>Zeile 2</td><td>2</td></tr>
      </tbody>
    </table>`;
  const node = findTableNode(html);
  const result = buildTableBlocks(node, ctx);
  assert.equal(warnings.length, 0);

  const table = result[0];
  const json = toJson(table);

  // Volle Breite
  const tblW = findAllByRootKey(json, 'w:tblW')[0];
  assert.equal(attrVal(attrOf(tblW).type), 'pct');
  assert.equal(attrVal(attrOf(tblW).size), '100%');

  // Rahmen auf allen Kanten inkl. innerer Linien, Farbe = COLOR.rule
  for (const key of ['w:top', 'w:bottom', 'w:left', 'w:right', 'w:insideH', 'w:insideV']) {
    const borders = findAllByRootKey(json, 'w:tblBorders')[0];
    const edge = findAllByRootKey(borders, key)[0];
    assert.ok(edge, `Rahmenkante ${key} fehlt`);
    const attrs = attrOf(edge);
    assert.equal(attrVal(attrs.style), 'single');
    assert.equal(attrVal(attrs.size), 4);
    assert.equal(attrVal(attrs.color), 'D8D8D8');
  }

  // Kopfzeile: tblHeader gesetzt (Wiederholung bei Seitenumbruch)
  const rows = findAllByRootKey(json, 'w:tr');
  assert.equal(rows.length, 3);
  const headerRow = rows[0];
  assert.equal(findAllByRootKey(headerRow, 'w:tblHeader').length, 1);
  assert.equal(findAllByRootKey(rows[1], 'w:tblHeader').length, 0);

  // Kopfzellen: shading + fett (TableHeader-Stil + b/bCs Runs)
  const headerCells = findAllByRootKey(headerRow, 'w:tc');
  assert.equal(headerCells.length, 2);
  for (const cell of headerCells) {
    const shd = findAllByRootKey(cell, 'w:shd')[0];
    assert.equal(attrVal(attrOf(shd).fill), 'EAF1FC');
    const pStyle = findAllByRootKey(cell, 'w:pStyle')[0];
    assert.equal(attrVal(attrOf(pStyle).val), 'TableHeader');
    assert.equal(findAllByRootKey(cell, 'w:b').length, 1);
  }
});

test('buildTableBlocks: colspan="2" erstreckt sich ueber zwei Spalten', () => {
  const { ctx, warnings } = makeCtx();
  const html = `
    <table>
      <tr><td colspan="2">Verbunden</td></tr>
      <tr><td>A</td><td>B</td></tr>
    </table>`;
  const node = findTableNode(html);
  const result = buildTableBlocks(node, ctx);
  const rows = findAllByRootKey(toJson(result[0]), 'w:tr');
  assert.equal(rows.length, 2);

  const row1Cells = findAllByRootKey(rows[0], 'w:tc');
  assert.equal(row1Cells.length, 1, 'die verbundene Zeile hat nur EINE tc (der Grid-Span deckt beide Spalten)');
  const gridSpan = findAllByRootKey(row1Cells[0], 'w:gridSpan')[0];
  assert.equal(attrVal(attrOf(gridSpan).val), 2);

  const row2Cells = findAllByRootKey(rows[1], 'w:tc');
  assert.equal(row2Cells.length, 2);
  assert.equal(warnings.length, 0);
});

test('buildTableBlocks: rowspan="2" erstreckt sich ueber zwei Zeilen, Folgezelle korrekt positioniert', () => {
  const { ctx, warnings } = makeCtx();
  const html = `
    <table>
      <tr><td rowspan="2">Verbunden</td><td>Oben</td></tr>
      <tr><td>Unten</td></tr>
    </table>`;
  const node = findTableNode(html);
  const result = buildTableBlocks(node, ctx);
  const rows = findAllByRootKey(toJson(result[0]), 'w:tr');
  assert.equal(rows.length, 2);

  const row1Cells = findAllByRootKey(rows[0], 'w:tc');
  assert.equal(row1Cells.length, 2);
  const vMerge1 = findAllByRootKey(row1Cells[0], 'w:vMerge')[0];
  assert.equal(attrVal(attrOf(vMerge1).val), 'restart');

  // Zeile 2: erste Zelle ist die CONTINUE-Platzhalterzelle (Spalte 0),
  // die tatsaechliche Datenzelle "Unten" landet an Spaltenposition 1.
  const row2Cells = findAllByRootKey(rows[1], 'w:tc');
  assert.equal(row2Cells.length, 2);
  const vMerge2 = findAllByRootKey(row2Cells[0], 'w:vMerge')[0];
  assert.equal(attrVal(attrOf(vMerge2).val), 'continue');
  const secondCellText = findAllByRootKey(row2Cells[1], 'w:t')[0];
  assert.deepEqual(secondCellText.root.filter((r) => typeof r === 'string'), ['Unten']);

  assert.equal(warnings.length, 0);
});

test('buildTableBlocks: colspan UND rowspan gleichzeitig in derselben Tabelle', () => {
  const { ctx } = makeCtx();
  const html = `
    <table>
      <tr><td rowspan="2" colspan="2">Block</td><td>C</td></tr>
      <tr><td>D</td></tr>
      <tr><td>E</td><td>F</td><td>G</td></tr>
    </table>`;
  const node = findTableNode(html);
  const result = buildTableBlocks(node, ctx);
  const rows = findAllByRootKey(toJson(result[0]), 'w:tr');
  assert.equal(rows.length, 3);

  const row1Cells = findAllByRootKey(rows[0], 'w:tc');
  assert.equal(row1Cells.length, 2); // verbundene Zelle (span 2) + "C"
  const gridSpan = findAllByRootKey(row1Cells[0], 'w:gridSpan')[0];
  assert.equal(attrVal(attrOf(gridSpan).val), 2);
  assert.equal(attrVal(attrOf(findAllByRootKey(row1Cells[0], 'w:vMerge')[0]).val), 'restart');

  const row2Cells = findAllByRootKey(rows[1], 'w:tc');
  // Continue-Platzhalter (span 2) + eigene Zelle "D"
  assert.equal(row2Cells.length, 2);
  const continueGridSpan = findAllByRootKey(row2Cells[0], 'w:gridSpan')[0];
  assert.equal(attrVal(attrOf(continueGridSpan).val), 2);
  assert.equal(attrVal(attrOf(findAllByRootKey(row2Cells[0], 'w:vMerge')[0]).val), 'continue');

  const row3Cells = findAllByRootKey(rows[2], 'w:tc');
  assert.equal(row3Cells.length, 3);
});

test('buildTableBlocks: Zelle mit mehreren Absaetzen/einer Liste bleibt strukturiert', () => {
  const { ctx } = makeCtx();
  const html = `
    <table>
      <tr><td><p>Erster Absatz</p><ul><li>Punkt 1</li><li>Punkt 2</li></ul></td></tr>
    </table>`;
  const node = findTableNode(html);
  const result = buildTableBlocks(node, ctx);
  const cell = findAllByRootKey(toJson(result[0]), 'w:tc')[0];
  const paragraphs = findAllByRootKey(cell, 'w:p');
  // 1 Absatz + 2 Listeneintraege = 3 separate Paragraphen, NICHT zu einem verschmolzen.
  assert.equal(paragraphs.length, 3);
});

test('buildTableBlocks: uneven Zeilen werden ohne Absturz mit leeren Zellen aufgefuellt', () => {
  const { ctx, warnings } = makeCtx();
  const html = `
    <table>
      <tr><td>A</td><td>B</td><td>C</td></tr>
      <tr><td>Nur eine Zelle</td></tr>
    </table>`;
  const node = findTableNode(html);
  assert.doesNotThrow(() => buildTableBlocks(node, ctx));
  const result = buildTableBlocks(node, ctx);
  const rows = findAllByRootKey(toJson(result[0]), 'w:tr');
  assert.equal(rows.length, 2);
  const row2Cells = findAllByRootKey(rows[1], 'w:tc');
  assert.equal(row2Cells.length, 3, 'kurze Zeile wird bis zur Spaltenzahl aufgefuellt');
  assert.ok(warnings.includes('TABLE_MALFORMED'));
});

test('buildTableBlocks: absurd hoher colspan/rowspan wird geklemmt statt den Export zu sprengen', () => {
  const { ctx, warnings } = makeCtx();
  const html = '<table><tr><td colspan="999999999" rowspan="999999999">X</td></tr><tr><td>Y</td></tr></table>';
  const node = findTableNode(html);
  assert.doesNotThrow(() => buildTableBlocks(node, ctx));
  const result = buildTableBlocks(node, ctx);
  const rows = findAllByRootKey(toJson(result[0]), 'w:tr');

  const row1Cell = findAllByRootKey(rows[0], 'w:tc')[0];
  const gridSpan = findAllByRootKey(row1Cell, 'w:gridSpan')[0];
  assert.equal(attrVal(attrOf(gridSpan).val), 64, 'colspan wird auf 64 geklemmt');
  assert.equal(attrVal(attrOf(findAllByRootKey(row1Cell, 'w:vMerge')[0]).val), 'restart');

  assert.ok(warnings.includes('TABLE_MALFORMED'));
});

test('buildTableBlocks: Spaltenzahl wird aus der breitesten Zeile (inkl. colspan) ermittelt', () => {
  const { ctx } = makeCtx();
  const html = `
    <table>
      <tr><td>A</td><td>B</td></tr>
      <tr><td colspan="3">Breiteste Zeile</td></tr>
    </table>`;
  const node = findTableNode(html);
  const result = buildTableBlocks(node, ctx);
  const json = toJson(result[0]);
  const gridCols = findAllByRootKey(json, 'w:gridCol');
  assert.equal(gridCols.length, 3);
});

test('buildTableBlocks: wirft nie, auch bei kaputtem Knoten', () => {
  const { ctx } = makeCtx();
  assert.doesNotThrow(() => buildTableBlocks(null, ctx));
  assert.deepEqual(buildTableBlocks(null, ctx), []);
  assert.doesNotThrow(() => buildTableBlocks({ name: 'table' }, ctx));
});
