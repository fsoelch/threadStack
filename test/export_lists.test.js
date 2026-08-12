'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Parser } = require('htmlparser2');
const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink,
  Table, TableRow, TableCell, WidthType,
} = require('docx');
const { getDocumentXml, getPart } = require('./docx-helpers');
const docxTheme = require('../export/docxTheme');
const { createRenderContext } = require('../export/html/context');
const { buildListBlocks } = require('../export/html/lists');

// --------------------------------------------------------------------------
// Test-Doubles, die simulieren, was Paket 2 (parse.js/inline.js/blocks.js)
// dem RenderContext via ctx.buildBlocks / ctx.inlineRunsOf bereitstellt.
// Bewusst schlank gehalten: deckt nur das ab, was lists.js selbst konsumiert
// (p/table/blockquote als Block-Kinder, b/i/u/s/a/br als Inline-Kinder).
// --------------------------------------------------------------------------

function parseFragment(html) {
  const dom = [];
  const stack = [{ children: dom }];
  const parser = new Parser({
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
  }, { decodeEntities: true });
  parser.write(String(html || ''));
  parser.end();
  return dom;
}

function firstOfType(nodes, name) {
  return nodes.find((n) => n && n.type === 'tag' && n.name === name);
}

function buildInlineRunsLocal(node, style, out) {
  if (node.type === 'text') {
    if (node.data) out.push(new TextRun({ text: node.data, ...style }));
    return;
  }
  if (node.type !== 'tag') return;
  const tag = node.name;
  const nextStyle = { ...style };
  if (tag === 'strong' || tag === 'b') nextStyle.bold = true;
  else if (tag === 'em' || tag === 'i') nextStyle.italics = true;
  else if (tag === 'u') nextStyle.underline = {};
  else if (tag === 's') nextStyle.strike = true;
  else if (tag === 'br') { out.push(new TextRun({ text: '', break: 1 })); return; }

  if (tag === 'a') {
    const href = node.attribs && node.attribs.href;
    const children = [];
    for (const c of node.children || []) buildInlineRunsLocal(c, { ...nextStyle, color: '1D6FE8', underline: {} }, children);
    if (href && children.length) {
      out.push(new ExternalHyperlink({ link: href, children }));
      return;
    }
    for (const c of children) out.push(c);
    return;
  }

  for (const c of node.children || []) buildInlineRunsLocal(c, nextStyle, out);
}

function buildBlocksLocal(nodes, ctx) {
  const blocks = [];
  for (const node of nodes || []) {
    if (!node || node.type !== 'tag') continue;
    if (node.name === 'p') {
      const runs = [];
      for (const c of node.children || []) buildInlineRunsLocal(c, {}, runs);
      blocks.push(new Paragraph({ children: runs.length ? runs : [new TextRun('')] }));
      continue;
    }
    if (node.name === 'table') {
      const rows = [];
      for (const tr of (node.children || []).filter((c) => c.type === 'tag' && c.name === 'tr')) {
        const cells = [];
        for (const cell of (tr.children || []).filter((c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'))) {
          const runs = [];
          for (const c of cell.children || []) buildInlineRunsLocal(c, {}, runs);
          cells.push(new TableCell({ children: [new Paragraph({ children: runs })] }));
        }
        if (cells.length) rows.push(new TableRow({ children: cells }));
      }
      if (rows.length) blocks.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      continue;
    }
    if (node.name === 'blockquote') {
      blocks.push(...buildBlocksLocal(node.children || [], ctx));
      continue;
    }
    // Unbekannte Container: rekursiv absteigen (analog zum echten Dispatcher).
    blocks.push(...buildBlocksLocal(node.children || [], ctx));
  }
  return blocks;
}

function makeCtx(overrides = {}) {
  const registry = docxTheme.createNumberingRegistry();
  const warnLog = [];
  const ctx = createRenderContext({
    numbering: registry,
    buildBlocks: (nodes, innerCtx) => buildBlocksLocal(nodes, innerCtx),
    inlineRunsOf: (nodes, style) => {
      const out = [];
      for (const n of nodes || []) buildInlineRunsLocal(n, style, out);
      return out;
    },
    warn: (code) => warnLog.push(code),
    ...overrides,
  });
  return { ctx, registry, warnLog };
}

async function packBlocks(blocks, registry) {
  const doc = new Document({
    numbering: registry.buildConfig(),
    sections: [{ children: blocks }],
  });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, xml: getDocumentXml(buffer) };
}

function extractParagraphs(xml) {
  const out = [];
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const ilvlMatch = /<w:ilvl w:val="(\d+)"/.exec(body);
    const numIdMatch = /<w:numId w:val="(\d+)"/.exec(body);
    const texts = [...body.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]);
    out.push({
      ilvl: ilvlMatch ? Number(ilvlMatch[1]) : null,
      numId: numIdMatch ? numIdMatch[1] : null,
      text: texts.join(''),
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// 1) Verschachtelte ul: Sub-Items sind eigene Absaetze, nicht Text im
//    Elternpunkt.
// --------------------------------------------------------------------------
test('buildListBlocks: verschachtelte ul erzeugt eigene Absaetze auf Ebene 1 statt Text im Elternpunkt', async () => {
  const html = '<ul><li>Eins</li><li>Zwei<ul><li>Zwei-a</li><li>Zwei-b</li></ul></li></ul>';
  const node = firstOfType(parseFragment(html), 'ul');
  const { ctx, registry } = makeCtx();

  const blocks = buildListBlocks(node, ctx, 0);
  assert.equal(blocks.length, 4, 'Eins, Zwei, Zwei-a, Zwei-b als 4 eigenstaendige Absaetze');

  const { xml } = await packBlocks(blocks, registry);
  const paras = extractParagraphs(xml);
  assert.equal(paras.length, 4);
  assert.equal(paras[0].text, 'Eins');
  assert.equal(paras[0].ilvl, 0);
  assert.equal(paras[1].text, 'Zwei');
  assert.equal(paras[1].ilvl, 0, 'Elternpunkt "Zwei" enthaelt NICHT den Text der Unterpunkte');
  assert.ok(!paras[1].text.includes('Zwei-a'), 'Unterpunkt-Text darf nicht im Elternabsatz landen');
  assert.equal(paras[2].text, 'Zwei-a');
  assert.equal(paras[2].ilvl, 1, 'Unterpunkt liegt auf Einrueckungsebene 1');
  assert.equal(paras[3].text, 'Zwei-b');
  assert.equal(paras[3].ilvl, 1);
});

// --------------------------------------------------------------------------
// 2) Verschachtelung bis mindestens Ebene 3 bleibt unterscheidbar.
// --------------------------------------------------------------------------
test('buildListBlocks: Verschachtelung bis Ebene 3 bleibt unterscheidbar eingerueckt', async () => {
  const html = '<ul><li>L0<ul><li>L1<ul><li>L2<ul><li>L3</li></ul></li></ul></li></ul></li></ul>';
  const node = firstOfType(parseFragment(html), 'ul');
  const { ctx, registry } = makeCtx();

  const blocks = buildListBlocks(node, ctx, 0);
  const { xml } = await packBlocks(blocks, registry);
  const paras = extractParagraphs(xml);

  assert.equal(paras.length, 4);
  assert.deepEqual(paras.map((p) => p.ilvl), [0, 1, 2, 3]);
  assert.deepEqual(paras.map((p) => p.text), ['L0', 'L1', 'L2', 'L3']);
});

// --------------------------------------------------------------------------
// 3) Zwei getrennte ol-Listen beginnen jeweils bei "1." (eigene Referenzen).
// --------------------------------------------------------------------------
test('buildListBlocks: zwei getrennte ol-Listen bekommen unabhaengige Nummerierungsreferenzen', async () => {
  const nodeA = firstOfType(parseFragment('<ol><li>A1</li><li>A2</li></ol>'), 'ol');
  const nodeB = firstOfType(parseFragment('<ol><li>B1</li><li>B2</li></ol>'), 'ol');
  const { ctx, registry } = makeCtx();

  const blocksA = buildListBlocks(nodeA, ctx, 0);
  const blocksB = buildListBlocks(nodeB, ctx, 0);

  const { config } = registry.buildConfig();
  assert.equal(config.length, 2, 'zwei unabhaengige ol-Referenzen wurden angelegt');

  const { xml } = await packBlocks([...blocksA, ...blocksB], registry);
  const paras = extractParagraphs(xml);
  assert.equal(paras.length, 4);
  // Alle vier Absaetze liegen auf ilvl 0 ...
  assert.deepEqual(paras.map((p) => p.ilvl), [0, 0, 0, 0]);
  // ... aber A und B nutzen unterschiedliche numId (= unabhaengige Zaehlung,
  // beide starten intern wieder bei "1.").
  assert.notEqual(paras[0].numId, paras[2].numId);
  assert.equal(paras[0].numId, paras[1].numId);
  assert.equal(paras[2].numId, paras[3].numId);
});

// --------------------------------------------------------------------------
// 4) Gemischte Verschachtelung (ol in ul) behaelt je Ebene ihren Typ.
// --------------------------------------------------------------------------
test('buildListBlocks: ol verschachtelt in ul behaelt eigenen Typ (neue Referenz je Ebene)', async () => {
  const html = '<ul><li>Bullet<ol><li>Nr1</li><li>Nr2</li></ol></li></ul>';
  const node = firstOfType(parseFragment(html), 'ul');
  const { ctx, registry } = makeCtx();

  const blocks = buildListBlocks(node, ctx, 0);
  const { config } = registry.buildConfig();
  assert.equal(config.length, 2, 'bullet-Wurzel und ordered-Sub-Liste bekommen je eine eigene Referenz');
  assert.equal(config.filter((c) => c.reference.startsWith('ul-')).length, 1);
  assert.equal(config.filter((c) => c.reference.startsWith('ol-')).length, 1);

  const { xml } = await packBlocks(blocks, registry);
  const paras = extractParagraphs(xml);
  assert.equal(paras.length, 3);
  assert.equal(paras[0].text, 'Bullet');
  assert.equal(paras[1].text, 'Nr1');
  assert.equal(paras[2].text, 'Nr2');
  assert.notEqual(paras[0].numId, paras[1].numId, 'Sub-Liste mit anderem Typ nutzt eine andere numId als der Elternpunkt');
  assert.equal(paras[1].numId, paras[2].numId);
});

test('buildListBlocks: ol verschachtelt in ol (gleicher Typ) fuehrt Referenz der Wurzel mit erhoehter Ebene fort', async () => {
  const html = '<ol><li>Erst<ol><li>Erst-a</li></ol></li></ol>';
  const node = firstOfType(parseFragment(html), 'ol');
  const { ctx, registry } = makeCtx();

  buildListBlocks(node, ctx, 0);
  const { config } = registry.buildConfig();
  assert.equal(config.length, 1, 'gleicher Typ auf verschachtelter Ebene teilt sich die Referenz der Wurzel');
});

// --------------------------------------------------------------------------
// 5) Inline-Formatierung (fett/kursiv/Link) in li bleibt erhalten.
// --------------------------------------------------------------------------
test('buildListBlocks: Inline-Formatierung (bold/italic/link) in li bleibt erhalten', async () => {
  const html = '<ul><li><b>fett</b> <i>kursiv</i> <a href="https://example.com/ziel">Link</a></li></ul>';
  const node = firstOfType(parseFragment(html), 'ul');
  const { ctx, registry } = makeCtx();

  const blocks = buildListBlocks(node, ctx, 0);
  assert.equal(blocks.length, 1);

  const { buffer, xml } = await packBlocks(blocks, registry);
  assert.match(xml, /<w:b\/>/, 'fett bleibt erhalten');
  assert.match(xml, /<w:i\/>/, 'kursiv bleibt erhalten');
  assert.match(xml, /Link/);
  const rels = getPart(buffer, 'word/_rels/document.xml.rels');
  assert.match(rels, /https:\/\/example\.com\/ziel/, 'Hyperlink-Ziel bleibt als Relationship erhalten');
});

// --------------------------------------------------------------------------
// 6) Leeres li erzeugt einen leeren Listenpunkt, kein Absturz.
// --------------------------------------------------------------------------
test('buildListBlocks: leeres li erzeugt einen leeren Listenpunkt-Absatz statt eines Absturzes', async () => {
  const node = firstOfType(parseFragment('<ul><li></li><li>Danach</li></ul>'), 'ul');
  const { ctx, registry } = makeCtx();

  const blocks = buildListBlocks(node, ctx, 0);
  assert.equal(blocks.length, 2);

  const { xml } = await packBlocks(blocks, registry);
  const paras = extractParagraphs(xml);
  assert.equal(paras.length, 2);
  assert.equal(paras[0].text, '');
  assert.equal(paras[0].ilvl, 0, 'auch das leere li hat einen korrekten Numbering-Bezug');
  assert.equal(paras[1].text, 'Danach');
});

test('buildListBlocks: fehlerhafter/kaputter Knoten wirft nie, liefert sicheren Fallback', () => {
  const { ctx } = makeCtx();
  assert.doesNotThrow(() => {
    const r1 = buildListBlocks(null, ctx, 0);
    assert.deepEqual(r1, []);
    const r2 = buildListBlocks({ name: 'ul', children: 'kaputt' }, ctx, 0);
    assert.deepEqual(r2, []);
    const r3 = buildListBlocks({ name: 'ul', children: [] }, undefined, 0);
    assert.deepEqual(r3, []);
  });
});

// --------------------------------------------------------------------------
// 7) Blockelement (Tabelle/Absatz) innerhalb eines li bleibt strukturiert
//    erhalten.
// --------------------------------------------------------------------------
test('buildListBlocks: Blockelemente (p/table) in li werden strukturiert (nicht als Text) uebernommen', async () => {
  const html = '<ul><li>Punkt mit Anhang'
    + '<p>Zusatzabsatz</p>'
    + '<table><tr><td>Zelle1</td><td>Zelle2</td></tr></table>'
    + '</li></ul>';
  const node = firstOfType(parseFragment(html), 'ul');
  const { ctx, registry } = makeCtx();

  const blocks = buildListBlocks(node, ctx, 0);
  // Haupt-li-Absatz + Zusatzabsatz-Paragraph + Table
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0] instanceof Paragraph);
  assert.ok(blocks[1] instanceof Paragraph);
  assert.ok(blocks[2] instanceof Table, 'die verschachtelte Tabelle bleibt ein eigenstaendiges Table-Objekt');

  const { xml } = await packBlocks(blocks, registry);
  assert.match(xml, /Punkt mit Anhang/);
  assert.match(xml, /Zusatzabsatz/);
  assert.match(xml, /Zelle1/);
  assert.match(xml, /Zelle2/);
});

// --------------------------------------------------------------------------
// 8) Extrem tiefe Verschachtelung (>20 Ebenen) bricht nicht mit Stack
//    Overflow ab, sondern greift der MAX_DEPTH-Schutz -- kein Textverlust.
// --------------------------------------------------------------------------
function buildDeepUl(i, total) {
  const isLeaf = i === total;
  const liChildren = [{ type: 'text', data: isLeaf ? 'DeepText' : `Level${i}` }];
  if (!isLeaf) liChildren.push(buildDeepUl(i + 1, total));
  return {
    type: 'tag',
    name: 'ul',
    attribs: {},
    children: [{ type: 'tag', name: 'li', attribs: {}, children: liChildren }],
  };
}

test('buildListBlocks: sehr tiefe Verschachtelung (>20 Ebenen) bricht nicht ab, MAX_DEPTH-Schutz greift, kein Textverlust', async () => {
  const deepNode = buildDeepUl(1, 30);
  const { ctx, registry, warnLog } = makeCtx();

  let blocks;
  assert.doesNotThrow(() => {
    blocks = buildListBlocks(deepNode, ctx, 0);
  });
  assert.ok(Array.isArray(blocks));
  assert.ok(blocks.length >= 20, 'alle Ebenen (inkl. Blatt) sind als Absaetze vorhanden, kein Datenverlust');
  assert.ok(warnLog.includes('DEPTH_LIMIT'), 'DEPTH_LIMIT wird bei Erreichen der maximalen Tiefe gemeldet');

  const { xml } = await packBlocks(blocks, registry);
  assert.match(xml, /DeepText/, 'der Text des tiefsten Blatt-Listenpunkts geht nicht verloren');
  assert.match(xml, /Level1/, 'Text oberer Ebenen bleibt ebenfalls erhalten');
});

test('buildListBlocks: extrem viele Geschwister-Ebenen (Breite) bleiben ebenfalls stabil', () => {
  // Kein "li in li"-Rekursionspfad, sondern viele direkte Kinder -- Schutz
  // gegen pathologisch breite Listen (kein Performance-/Stack-Problem).
  const many = Array.from({ length: 500 }, (_, i) => ({
    type: 'tag', name: 'li', attribs: {}, children: [{ type: 'text', data: `Item ${i}` }],
  }));
  const node = { name: 'ul', children: many };
  const { ctx } = makeCtx();
  let blocks;
  assert.doesNotThrow(() => { blocks = buildListBlocks(node, ctx, 0); });
  assert.equal(blocks.length, 500);
});
