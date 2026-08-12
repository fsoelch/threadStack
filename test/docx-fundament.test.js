'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const { getPart, getDocumentXml } = require('./docx-helpers');
const docxTheme = require('../export/docxTheme');
const { createRenderContext } = require('../export/html/context');
const { buildListBlocks } = require('../export/html/lists');
const { buildTableBlocks } = require('../export/html/tables');
const { buildImageBlocks } = require('../export/html/media');

test('docx-helpers: getDocumentXml liest Text aus selbst erzeugtem Mini-DOCX', async () => {
  const marker = 'FUNDAMENT_TEST_MARKER_12345';
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun(marker)] })] }],
  });
  const buffer = await Packer.toBuffer(doc);
  const xml = getDocumentXml(buffer);
  assert.ok(xml.includes(marker), 'Marker-Text sollte im document.xml vorkommen');
});

test('docx-helpers: getPart liest beliebigen Teil (styles.xml)', async () => {
  const doc = new Document({ sections: [{ children: [new Paragraph('x')] }] });
  const buffer = await Packer.toBuffer(doc);
  const styles = getPart(buffer, 'word/styles.xml');
  assert.match(styles, /<w:styles/);
});

test('docx-helpers: getPart wirft bei unbekanntem Teil', async () => {
  const doc = new Document({ sections: [{ children: [new Paragraph('x')] }] });
  const buffer = await Packer.toBuffer(doc);
  assert.throws(() => getPart(buffer, 'word/does-not-exist.xml'));
});

test('docxTheme: STYLES/SECTION_PROPERTIES sind mit docx v9 kompatibel (Document laesst sich packen)', async () => {
  const doc = new Document({
    styles: docxTheme.STYLES,
    sections: [
      {
        properties: docxTheme.SECTION_PROPERTIES,
        children: [new Paragraph({ text: 'Hallo', heading: 'Heading1' })],
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  const xml = getDocumentXml(buffer);
  assert.match(xml, /Hallo/);
});

test('docxTheme.LIST_INDENT: klemmt level auf 0..8', () => {
  assert.deepEqual(docxTheme.LIST_INDENT(0), { left: 360, hanging: 360 });
  assert.deepEqual(docxTheme.LIST_INDENT(-5), { left: 360, hanging: 360 });
  assert.deepEqual(docxTheme.LIST_INDENT(8), { left: 360 + 360 * 8, hanging: 360 });
  assert.deepEqual(docxTheme.LIST_INDENT(20), { left: 360 + 360 * 8, hanging: 360 });
});

test('docxTheme.createNumberingRegistry: eigene Zaehlung pro allocate-Aufruf', () => {
  const registry = docxTheme.createNumberingRegistry();
  const a = registry.allocate('ordered');
  const b = registry.allocate('ordered');
  const c = registry.allocate('bullet');
  assert.notEqual(a, b);
  assert.match(a, /^ol-\d+$/);
  assert.match(b, /^ol-\d+$/);
  assert.match(c, /^ul-\d+$/);

  const { config } = registry.buildConfig();
  assert.equal(config.length, 3);
  for (const entry of config) {
    assert.equal(entry.levels.length, 9);
  }
});

test('docxTheme.createNumberingRegistry: allocate mit unbekanntem kind wirft TypeError', () => {
  const registry = docxTheme.createNumberingRegistry();
  assert.throws(() => registry.allocate('foo'), TypeError);
});

test('createRenderContext: erzeugt Kontext mit Konstanten und child() erhoeht Tiefe', () => {
  const registry = docxTheme.createNumberingRegistry();
  const ctx = createRenderContext({ numbering: registry });
  assert.equal(ctx.MAX_DEPTH, 20);
  assert.equal(ctx.MAX_BLOCKS, 20000);
  assert.equal(ctx.depth, 0);
  const child = ctx.child();
  assert.equal(child.depth, 1);
  assert.equal(ctx.depth, 0, 'Original-Kontext darf unveraendert bleiben');
});

test('createRenderContext: numbering ist Pflicht', () => {
  assert.throws(() => createRenderContext({}), TypeError);
});

test('createRenderContext: warn gibt nur bekannte Codes weiter, wirft nie', () => {
  const registry = docxTheme.createNumberingRegistry();
  const seen = [];
  const ctx = createRenderContext({ numbering: registry, warn: (code) => seen.push(code) });
  ctx.warn('IMG_DECODE_FAILED');
  ctx.warn('NOT_A_REAL_CODE');
  assert.deepEqual(seen, ['IMG_DECODE_FAILED']);
});

test('Stub buildListBlocks: liefert einen Paragraph pro li', () => {
  const registry = docxTheme.createNumberingRegistry();
  const ctx = createRenderContext({ numbering: registry });
  const node = {
    name: 'ul',
    children: [
      { name: 'li', children: [{ type: 'text', data: 'Eins' }] },
      { name: 'li', children: [{ type: 'text', data: 'Zwei' }] },
    ],
  };
  const blocks = buildListBlocks(node, ctx, 0);
  assert.equal(blocks.length, 2);
});

test('Stub buildTableBlocks: gibt leeres Array zurueck', () => {
  const registry = docxTheme.createNumberingRegistry();
  const ctx = createRenderContext({ numbering: registry });
  const blocks = buildTableBlocks({ name: 'table', children: [] }, ctx);
  assert.deepEqual(blocks, []);
});

test('Stub buildImageBlocks: gibt immer einen Platzhalter-Paragraph zurueck', () => {
  const registry = docxTheme.createNumberingRegistry();
  const ctx = createRenderContext({ numbering: registry });
  const blocks = buildImageBlocks({ name: 'img', attribs: {} }, ctx);
  assert.equal(blocks.length, 1);
});
