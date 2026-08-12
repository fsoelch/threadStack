'use strict';
// Dispatcher fuer Blockelemente: baut aus einer flachen Liste von
// DOM-Knoten (export/html/parse.js) eine flache Liste von docx-Bloecken
// (Paragraph/Table).

const {
  Paragraph, TextRun, HeadingLevel, BorderStyle, ShadingType,
} = require('docx');
const docxTheme = require('../docxTheme');
const { textOf } = require('./inline');

// Als Objekte requiret (nicht destrukturiert), damit Tests die exportierten
// Funktionen bei Bedarf monkeypatchen koennen (dieselbe Objektreferenz wird
// hier bei jedem Aufruf erneut per Property-Zugriff gelesen).
const listsModule = require('./lists');
const tablesModule = require('./tables');
const mediaModule = require('./media');

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

// Tags, die als eigener Block behandelt werden (fuer die
// Mixed-Content-Erkennung in p/div: alles andere gilt als Inline-Kind).
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'hr', 'ul', 'ol', 'table', 'img',
]);

function isBlockNode(node) {
  return !!node && node.type === 'tag' && BLOCK_TAGS.has(node.name);
}

function isWhitespaceOnly(nodes) {
  const text = (nodes || []).map(textOf).join('');
  return text.trim() === '';
}

/**
 * Mappt ein hN-Tag auf eine docx-HeadingLevel-Konstante, relativ zu
 * ctx.headingBase, gedeckelt bei Heading 6.
 * @param {string} tag 'h1'..'h6'
 * @param {object} ctx
 * @returns {string}
 */
function mapHeadingLevel(tag, ctx) {
  const num = Number(tag[1]);
  let level = ctx.headingBase + (num - 1);
  if (level > 6) level = 6;
  if (level < 1) level = 1;
  return HEADING_LEVELS[level - 1];
}

function buildHeadingBlock(node, tag, ctx) {
  const runs = ctx.inlineRunsOf(node.children || [], {});
  return new Paragraph({
    heading: mapHeadingLevel(tag, ctx),
    children: runs.length ? runs : [new TextRun('')],
  });
}

function buildHrBlock() {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: docxTheme.COLOR.rule, space: 1 },
    },
    spacing: { before: docxTheme.SPACING.blockAfter, after: docxTheme.SPACING.blockAfter },
    children: [],
  });
}

/**
 * `pre`: jede Zeile wird ein eigener Absatz in FONT_MONO mit CodeBlock-
 * Hintergrund; fuehrende Leerzeichen werden ueber geschuetzte Leerzeichen
 * ( ) erhalten, damit Word sie nicht kollabiert.
 */
function preserveLeadingSpaces(line) {
  const match = /^( +)/.exec(line);
  if (!match) return line;
  return ' '.repeat(match[1].length) + line.slice(match[1].length);
}

function buildPreBlocks(node) {
  const raw = textOf(node);
  const lines = raw.split('\n');
  return lines.map((line) => new Paragraph({
    style: 'CodeBlock',
    shading: { type: ShadingType.CLEAR, fill: docxTheme.COLOR.codeBg, color: 'auto' },
    children: [new TextRun({ text: preserveLeadingSpaces(line), font: docxTheme.FONT_MONO })],
  }));
}

function makeQuoteParagraph(runs) {
  return new Paragraph({
    style: 'Quote',
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: docxTheme.COLOR.quoteBar, space: 8 },
    },
    indent: { left: 360 },
    children: runs,
  });
}

/**
 * `blockquote`: linke Randlinie + Texteinzug (Quote-Stil) fuer den
 * Textinhalt; eine direkt verschachtelte Liste (`blockquote > ul/ol`) behaelt
 * ihre eigene Aufzaehlung, bekommt aber zusaetzlich die Zitat-Einrueckung
 * (Summe der Einzuege) ueber einen erhoehten Start-`level` an buildListBlocks
 * mitgegeben.
 */
function buildBlockquoteBlocks(node, ctx) {
  const out = [];
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    // Immer inlineRunsOf aufrufen (auch bei vermutlich leerem Puffer), damit
    // Warn-Seiteneffekte (z.B. HYPERLINK_INVALID bei einem Link ohne
    // sichtbaren Text) zuverlaessig ausgeloest werden; das Ergebnis wird nur
    // dann als Absatz uebernommen, wenn tatsaechlich sichtbarer Text da ist.
    const runs = ctx.inlineRunsOf(buffer, {});
    if (!isWhitespaceOnly(buffer) && runs.length) out.push(makeQuoteParagraph(runs));
    buffer = [];
  };

  for (const child of node.children || []) {
    if (child && child.type === 'tag' && (child.name === 'ul' || child.name === 'ol')) {
      flush();
      out.push(...listsModule.buildListBlocks(child, ctx.child(), 1));
    } else if (isBlockNode(child)) {
      flush();
      out.push(...dispatchBlockNode(child, ctx));
    } else {
      buffer.push(child);
    }
  }
  flush();
  return out;
}

/**
 * Entscheidet fuer einen einzelnen Block-Knoten, welche docx-Bloecke daraus
 * entstehen. Rekursionsschutz ueber ctx.MAX_DEPTH.
 * @param {object} node
 * @param {object} ctx RenderContext
 * @returns {Array}
 */
function dispatchBlockNode(node, ctx) {
  if (!node || node.type !== 'tag') return [];
  if (ctx.depth >= ctx.MAX_DEPTH) {
    ctx.warn('DEPTH_LIMIT');
    return [];
  }

  const tag = node.name;

  if (tag === 'p' || tag === 'div') {
    return renderBlockChildren(node.children || [], ctx.child());
  }
  if (/^h[1-6]$/.test(tag)) {
    return [buildHeadingBlock(node, tag, ctx)];
  }
  if (tag === 'blockquote') {
    return buildBlockquoteBlocks(node, ctx.child());
  }
  if (tag === 'pre') {
    return buildPreBlocks(node);
  }
  if (tag === 'hr') {
    return [buildHrBlock()];
  }
  if (tag === 'ul' || tag === 'ol') {
    return listsModule.buildListBlocks(node, ctx.child(), 0);
  }
  if (tag === 'table') {
    return tablesModule.buildTableBlocks(node, ctx.child());
  }
  if (tag === 'img') {
    return mediaModule.buildImageBlocks(node, ctx.child());
  }

  // Unbekannte/Container-Tags: transparent in Kinder absteigen.
  return renderBlockChildren(node.children || [], ctx.child());
}

/**
 * Rendert eine Liste von (potenziell gemischten Inline-/Block-)Kindknoten zu
 * einer flachen Liste von docx-Bloecken. KRITISCHER BUGFIX: der
 * Inline-Puffer wird vor JEDEM Blockkind geleert (als eigener Absatz
 * ausgegeben), statt dass Blockinhalt (z.B. eine verschachtelte Tabelle
 * mitten in einem <div>) verloren geht oder falsch als Text eingebettet wird.
 * @param {Array<object>} nodes
 * @param {object} ctx RenderContext
 * @returns {Array}
 */
function renderBlockChildren(nodes, ctx) {
  const blocks = [];
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    // Immer inlineRunsOf aufrufen (auch bei vermutlich leerem Puffer), damit
    // Warn-Seiteneffekte (z.B. HYPERLINK_INVALID bei einem Link ohne
    // sichtbaren Text) zuverlaessig ausgeloest werden. Leere/Whitespace-only
    // Absaetze (z.B. <p><br></p> oder reiner Whitespace-Text) werden trotzdem
    // NICHT als Absatz ausgegeben.
    const runs = ctx.inlineRunsOf(buffer, {});
    if (!isWhitespaceOnly(buffer) && runs.length) blocks.push(new Paragraph({ children: runs }));
    buffer = [];
  };

  for (const node of nodes || []) {
    if (blocks.length + buffer.length >= ctx.MAX_BLOCKS) {
      ctx.warn('BLOCK_LIMIT');
      break;
    }
    if (isBlockNode(node)) {
      flush();
      blocks.push(...dispatchBlockNode(node, ctx));
    } else if (node && (node.type === 'text' || node.type === 'tag')) {
      buffer.push(node);
    }
  }
  flush();
  return blocks;
}

/**
 * Oeffentlicher Einstiegspunkt (wird per Dependency Injection auch als
 * ctx.buildBlocks weitergereicht, siehe export/html/context.js).
 * @param {Array<object>} nodes
 * @param {object} ctx RenderContext
 * @returns {Array} (Paragraph|Table)[]
 */
function buildBlocks(nodes, ctx) {
  if (!ctx || typeof ctx.inlineRunsOf !== 'function') return [];
  if (!Array.isArray(nodes)) return [];
  return renderBlockChildren(nodes, ctx);
}

module.exports = { buildBlocks };
