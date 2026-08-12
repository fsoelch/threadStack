'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Document, Packer } = require('docx');
const { getDocumentXml } = require('./docx-helpers');
const { htmlToDocxBlocks } = require('../export/htmlToDocx');
const docxTheme = require('../export/docxTheme');
const listsModule = require('../export/html/lists');
const { normalizeColor, toDocxColor } = require('../lib/colors');

/**
 * Packt eine Liste von docx-Bloecken in ein Mini-Dokument und liefert das
 * rohe word/document.xml als String (fuer strukturelle Assertions).
 */
async function xmlOf(blocks) {
  const doc = new Document({
    styles: docxTheme.STYLES,
    sections: [{ children: blocks }],
  });
  const buffer = await Packer.toBuffer(doc);
  return getDocumentXml(buffer);
}

// ---------------------------------------------------------------------------
// Story 1: Mixed-Content-Bugfix
// ---------------------------------------------------------------------------

test('Mixed content: Blockkind (verschachtelte Liste) in <div> geht nicht verloren', async () => {
  const blocks = htmlToDocxBlocks('<div>Text before<ul><li>Eins</li><li>Zwei</li></ul>Text after</div>', 5);
  // "Text before"-Absatz, 2 Listen-Absaetze, "Text after"-Absatz
  assert.equal(blocks.length, 4);
  const xml = await xmlOf(blocks);
  const iBefore = xml.indexOf('Text before');
  const iEins = xml.indexOf('Eins');
  const iZwei = xml.indexOf('Zwei');
  const iAfter = xml.indexOf('Text after');
  assert.ok(iBefore >= 0 && iEins > iBefore && iZwei > iEins && iAfter > iZwei, 'Reihenfolge muss erhalten bleiben');
});

test('Leere/Whitespace-only Absaetze erzeugen keinen Output', () => {
  assert.deepEqual(htmlToDocxBlocks('<p><br></p>', 5), []);
  assert.deepEqual(htmlToDocxBlocks('<p>   </p>', 5), []);
  assert.deepEqual(htmlToDocxBlocks('<div>   <span></span>  </div>', 5), []);
});

// ---------------------------------------------------------------------------
// blockquote: Randlinie + Einzug, verschachtelte Liste
// ---------------------------------------------------------------------------

test('blockquote: Randlinie und Einzug (Quote-Stil) fuer Textinhalt', async () => {
  const blocks = htmlToDocxBlocks('<blockquote>Ein Zitat</blockquote>', 5);
  assert.equal(blocks.length, 1);
  const xml = await xmlOf(blocks);
  assert.match(xml, /Ein Zitat/);
  assert.match(xml, /w:pStyle w:val="Quote"/);
  assert.match(xml, /<w:pBdr>/);
  assert.match(xml, /<w:left[^>]*w:color="1D6FE8"/);
  assert.match(xml, /<w:ind[^>]*w:left="360"/);
});

test('blockquote mit verschachtelter Liste: Liste behaelt Aufzaehlung + zusaetzliche Zitat-Einrueckung', () => {
  let capturedLevel = null;
  const original = listsModule.buildListBlocks;
  listsModule.buildListBlocks = (node, ctx, level) => {
    capturedLevel = level;
    return original(node, ctx, level);
  };
  try {
    const blocks = htmlToDocxBlocks('<blockquote>Zitat<ul><li>Punkt</li></ul></blockquote>', 5);
    assert.equal(capturedLevel, 1, 'Liste muss mit erhoehtem Start-Level (Summe der Einzuege) aufgerufen werden');
    assert.ok(blocks.length >= 2, 'Zitat-Absatz + mind. ein Listen-Absatz');
  } finally {
    listsModule.buildListBlocks = original;
  }
});

// ---------------------------------------------------------------------------
// pre: mehrere Zeilen, fuehrende Leerzeichen erhalten; Unterscheidung zu
// Inline-code
// ---------------------------------------------------------------------------

test('pre: jede Zeile ein eigener Absatz, fuehrende Leerzeichen erhalten (nbsp)', async () => {
  const blocks = htmlToDocxBlocks('<pre>  line1\n    line2\nline3</pre>', 5);
  assert.equal(blocks.length, 3);
  const xml = await xmlOf(blocks);
  assert.ok(xml.includes('  line1'), 'fuehrende Leerzeichen von line1 muessen als nbsp erhalten bleiben');
  assert.ok(xml.includes('    line2'), 'fuehrende Leerzeichen von line2 muessen als nbsp erhalten bleiben');
  assert.ok(xml.includes('line3'));
  assert.match(xml, /w:pStyle w:val="CodeBlock"/);
  assert.match(xml, /w:ascii="Consolas"/);
});

test('Inline-code vs. Block-pre: inline <code> bekommt Monospace ohne CodeBlock-Hintergrundstil', async () => {
  const inlineBlocks = htmlToDocxBlocks('<p>inline <code>foo()</code> end</p>', 5);
  assert.equal(inlineBlocks.length, 1);
  const inlineXml = await xmlOf(inlineBlocks);
  assert.match(inlineXml, /w:ascii="Consolas"/);
  assert.doesNotMatch(inlineXml, /w:pStyle w:val="CodeBlock"/);

  const preBlocks = htmlToDocxBlocks('<pre>bar</pre>', 5);
  const preXml = await xmlOf(preBlocks);
  assert.match(preXml, /w:pStyle w:val="CodeBlock"/);
});

// ---------------------------------------------------------------------------
// hr
// ---------------------------------------------------------------------------

test('hr: Absatz mit unterer Rahmenlinie ueber volle Breite', async () => {
  const blocks = htmlToDocxBlocks('<hr>', 5);
  assert.equal(blocks.length, 1);
  const xml = await xmlOf(blocks);
  assert.match(xml, /<w:pBdr>/);
  assert.match(xml, /<w:bottom[^>]*w:color="D8D8D8"/);
});

// ---------------------------------------------------------------------------
// Heading-Deckelung
// ---------------------------------------------------------------------------

test('Heading-Mapping: h4 bei headingBase=6 wird auf Heading6 gedeckelt', async () => {
  const blocks = htmlToDocxBlocks('<h4>Deep</h4>', 6);
  assert.equal(blocks.length, 1);
  const xml = await xmlOf(blocks);
  assert.match(xml, /w:pStyle w:val="Heading6"/);
  assert.match(xml, /Deep/);
});

test('Heading-Mapping: h1..h4 relativ zu headingBase=1', async () => {
  const blocks = htmlToDocxBlocks('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4>', 1);
  assert.equal(blocks.length, 4);
  const xml = await xmlOf(blocks);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /w:pStyle w:val="Heading3"/);
  assert.match(xml, /w:pStyle w:val="Heading4"/);
});

// ---------------------------------------------------------------------------
// Farbe (Hex + <font color>) kombiniert mit fett/kursiv
// ---------------------------------------------------------------------------

test('Farbe ueber style="color:..." kombiniert mit fett + kursiv', async () => {
  const blocks = htmlToDocxBlocks('<p><strong><em><span style="color:#dc2626">Text</span></em></strong></p>', 5);
  const xml = await xmlOf(blocks);
  const expectedColor = toDocxColor(normalizeColor('#dc2626'));
  assert.match(xml, new RegExp(`w:color w:val="${expectedColor}"`));
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:i\/>/);
});

test('Legacy <font color="..."> wird ueber normalizeColor/toDocxColor aufgeloest', async () => {
  const blocks = htmlToDocxBlocks('<p><font color="#2563eb">Blau</font></p>', 5);
  const xml = await xmlOf(blocks);
  const expectedColor = toDocxColor(normalizeColor('#2563eb'));
  assert.match(xml, new RegExp(`w:color w:val="${expectedColor}"`));
  assert.match(xml, /Blau/);
});

test('Ungueltige Farbe: COLOR_REJECTED wird gemeldet, Text bleibt ungefaerbt statt Abbruch', async () => {
  const warned = [];
  const blocks = htmlToDocxBlocks('<p><span style="color:not-a-color">Text</span></p>', { headingBase: 5, warn: (c) => warned.push(c) });
  assert.deepEqual(warned, ['COLOR_REJECTED']);
  assert.equal(blocks.length, 1);
  const xml = await xmlOf(blocks);
  assert.match(xml, /Text/);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test('Ungueltiger Link (javascript:-Schema) wird zu Fliesstext statt Hyperlink', async () => {
  const warned = [];
  const blocks = htmlToDocxBlocks('<p><a href="javascript:alert(1)">Klick</a></p>', { headingBase: 5, warn: (c) => warned.push(c) });
  assert.ok(warned.includes('HYPERLINK_INVALID'));
  const xml = await xmlOf(blocks);
  assert.doesNotMatch(xml, /w:hyperlink/);
  assert.match(xml, /Klick/);
});

test('Ungueltiger Link (leerer sichtbarer Text) wird zu Fliesstext statt Hyperlink', () => {
  const warned = [];
  const blocks = htmlToDocxBlocks('<p><a href="https://example.com"></a></p>', { headingBase: 5, warn: (c) => warned.push(c) });
  assert.ok(warned.includes('HYPERLINK_INVALID'));
  // Kein sichtbarer Inhalt -> gesamter Absatz gilt als leer -> kein Output.
  assert.deepEqual(blocks, []);
});

test('Gueltiger https-Link wird zu ExternalHyperlink mit Akzentfarbe + Unterstreichung', async () => {
  const blocks = htmlToDocxBlocks('<p><a href="https://example.com">Klick hier</a></p>', 5);
  const xml = await xmlOf(blocks);
  assert.match(xml, /<w:hyperlink/);
  assert.match(xml, new RegExp(`w:color w:val="${docxTheme.COLOR.accent}"`));
  assert.match(xml, /<w:u w:val="single"\/>/);
  assert.match(xml, /Klick hier/);
});

test('Gueltiger mailto-Link wird zu ExternalHyperlink', async () => {
  const blocks = htmlToDocxBlocks('<p><a href="mailto:test@example.com">Mail</a></p>', 5);
  const xml = await xmlOf(blocks);
  assert.match(xml, /<w:hyperlink/);
  assert.match(xml, /Mail/);
});

// ---------------------------------------------------------------------------
// Sonderzeichen
// ---------------------------------------------------------------------------

test('Sonderzeichen (Umlaute, Emoji, &, <) bleiben korrekt ohne Entity-Reste', async () => {
  const blocks = htmlToDocxBlocks('<p>&Uuml;mlaut &amp; Emoji 😀 &lt;tag&gt;</p>', 5);
  const xml = await xmlOf(blocks);
  assert.match(xml, /Ümlaut/);
  assert.ok(xml.includes('😀'), 'Emoji muss erhalten bleiben');
  assert.match(xml, /&amp;/);
  assert.match(xml, /&lt;tag&gt;/);
  assert.doesNotMatch(xml, /&amp;amp;/, 'kein doppelt escapetes Ampersand');
  assert.doesNotMatch(xml, /&amp;lt;/, 'kein doppelt escapetes <');
});

// ---------------------------------------------------------------------------
// Robustheit: kaputtes HTML wirft nie
// ---------------------------------------------------------------------------

test('htmlToDocxBlocks wirft nie, auch bei kaputtem HTML', () => {
  assert.doesNotThrow(() => htmlToDocxBlocks('<p>unclosed<div><span>nested</p>', 5));
  assert.doesNotThrow(() => htmlToDocxBlocks(null, 5));
  assert.doesNotThrow(() => htmlToDocxBlocks(undefined, 5));
  assert.doesNotThrow(() => htmlToDocxBlocks(12345, 5));
  const blocks = htmlToDocxBlocks('<p>unclosed<div><span>nested</p>', 5);
  assert.ok(Array.isArray(blocks));
});

// ---------------------------------------------------------------------------
// Rueckwaertskompatibilitaet: Zahl als zweites Argument = headingBase
// ---------------------------------------------------------------------------

test('Rueckwaertskompatibilitaet: Zahl als Options-Argument wird als headingBase interpretiert', async () => {
  const blocks = htmlToDocxBlocks('<h1>Titel</h1>', 3);
  const xml = await xmlOf(blocks);
  assert.match(xml, /w:pStyle w:val="Heading3"/);
});

test('Fehlende numbering-Option: interne Wegwerf-Registry wird genutzt, keine Exception', () => {
  assert.doesNotThrow(() => htmlToDocxBlocks('<ul><li>Eins</li></ul>', {}));
});
