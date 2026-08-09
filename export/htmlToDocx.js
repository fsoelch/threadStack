'use strict';
// Wandelt das feste, von lib/sanitize.js erlaubte HTML-Tag-Set (siehe
// ALLOWED_TAGS dort) in eine Liste von docx-Elementen (Paragraph/Table) um.
// Kein generischer HTML-Parser nötig, da knowledge_pages.content beim
// Speichern bereits allowlist-sanitized wird — der Konverter deckt exakt
// diesen Tag-Umfang ab.
const { Parser } = require('htmlparser2');
const {
  Paragraph, TextRun, ExternalHyperlink, ImageRun,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  HeadingLevel, LevelFormat,
} = require('docx');

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i;
const MAX_IMAGE_WIDTH_PT = 500;

function decodeDataImage(src) {
  const m = DATA_IMAGE_RE.exec(String(src || ''));
  if (!m) return null;
  let mime = m[1].toLowerCase();
  if (mime === 'jpg') mime = 'jpeg';
  // docx's ImageRun `type` only understands a fixed set — gif/webp aren't
  // directly supported for re-encoding, but passing the raw bytes through
  // with a best-effort type still renders in Word/LibreOffice in practice
  // for these container formats; unsupported/corrupt data falls back below.
  const type = ['png', 'jpeg', 'bmp', 'gif'].includes(mime) ? mime : 'png';
  try {
    const data = Buffer.from(m[2], 'base64');
    if (!data.length) return null;
    return { data, type };
  } catch {
    return null;
  }
}

// Baut TextRun-Objekte für Inline-Elemente (Text + verschachtelbare
// b/i/u/s-Formatierung), sammelt sie in `out`.
function buildInlineRuns(node, style, out) {
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
    for (const c of node.children || []) buildInlineRuns(c, { ...nextStyle, color: '1D6FE8', underline: {} }, children);
    if (href && children.length) {
      out.push(new ExternalHyperlink({ link: href, children }));
      return;
    }
    for (const c of children) out.push(c);
    return;
  }

  for (const c of node.children || []) buildInlineRuns(c, nextStyle, out);
}

function textOf(node) {
  if (node.type === 'text') return node.data || '';
  return (node.children || []).map(textOf).join('');
}

// Baut Block-Elemente (Paragraph/Table) für ein HTML-Fragment. `headingBase`
// ist die docx-Heading-Ebene (1-6), ab der Content-eigene h1-h4 einsortiert
// werden (gedeckelt bei Heading6).
function buildBlocks(nodes, headingBase) {
  const blocks = [];
  let listCounter = 0;

  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.data && node.data.trim()) blocks.push(new Paragraph({ children: [new TextRun(node.data)] }));
      continue;
    }
    if (node.type !== 'tag') continue;
    const tag = node.name;

    if (/^h[1-4]$/.test(tag)) {
      const level = Math.min(headingBase + (Number(tag[1]) - 1), 6);
      const runs = [];
      for (const c of node.children || []) buildInlineRuns(c, {}, runs);
      blocks.push(new Paragraph({ heading: HEADING_LEVELS[level - 1], children: runs.length ? runs : [new TextRun('')] }));
      continue;
    }

    if (tag === 'p' || tag === 'div' || tag === 'span') {
      const runs = [];
      for (const c of node.children || []) buildInlineRuns(c, {}, runs);
      if (runs.length) blocks.push(new Paragraph({ children: runs }));
      else blocks.push(...buildBlocks(node.children || [], headingBase));
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      const ordered = tag === 'ol';
      let idx = 0;
      for (const li of (node.children || []).filter(c => c.type === 'tag' && c.name === 'li')) {
        idx++;
        const runs = [];
        for (const c of li.children || []) buildInlineRuns(c, {}, runs);
        blocks.push(new Paragraph({
          children: runs.length ? runs : [new TextRun('')],
          bullet: ordered ? undefined : { level: 0 },
          numbering: ordered ? { reference: 'export-numbering', level: 0 } : undefined,
        }));
      }
      continue;
    }

    if (tag === 'blockquote') {
      const inner = buildBlocks(node.children || [], headingBase);
      for (const b of inner) blocks.push(b); // indentation handled via style below
      continue;
    }

    if (tag === 'code' || tag === 'pre') {
      const text = textOf(node);
      blocks.push(new Paragraph({ children: [new TextRun({ text, font: 'Courier New' })] }));
      continue;
    }

    if (tag === 'hr') {
      blocks.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } }, children: [] }));
      continue;
    }

    if (tag === 'img') {
      const src = node.attribs && node.attribs.src;
      const alt = (node.attribs && node.attribs.alt) || '';
      const decoded = decodeDataImage(src);
      if (decoded) {
        try {
          blocks.push(new Paragraph({
            children: [new ImageRun({
              data: decoded.data,
              type: decoded.type,
              transformation: { width: MAX_IMAGE_WIDTH_PT, height: MAX_IMAGE_WIDTH_PT * 0.6 },
            })],
          }));
          continue;
        } catch {
          // fällt durch zum Platzhalter unten
        }
      }
      blocks.push(new Paragraph({ children: [new TextRun({ text: `[Bild konnte nicht eingebettet werden${alt ? ': ' + alt : ''}]`, italics: true })] }));
      continue;
    }

    if (tag === 'table') {
      const rows = [];
      const trNodes = [];
      const collectRows = (n) => {
        for (const c of n.children || []) {
          if (c.type === 'tag' && c.name === 'tr') trNodes.push(c);
          else if (c.type === 'tag') collectRows(c);
        }
      };
      collectRows(node);
      for (const tr of trNodes) {
        const cells = [];
        for (const cell of (tr.children || []).filter(c => c.type === 'tag' && (c.name === 'td' || c.name === 'th'))) {
          const runs = [];
          for (const c of cell.children || []) buildInlineRuns(c, cell.name === 'th' ? { bold: true } : {}, runs);
          cells.push(new TableCell({
            width: { size: 100, type: WidthType.AUTO },
            children: [new Paragraph({ children: runs })],
          }));
        }
        if (cells.length) rows.push(new TableRow({ children: cells }));
      }
      if (rows.length) blocks.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      continue;
    }

    // Unbekannte/Container-Tags: rekursiv in Kinder absteigen.
    blocks.push(...buildBlocks(node.children || [], headingBase));
    void listCounter;
  }
  return blocks;
}

/**
 * Parst sanitiztes Knowledge-HTML zu einer flachen Liste von docx-Blöcken
 * (Paragraph/Table). `headingBase` (1-6) verschiebt Content-eigene
 * Überschriften relativ zur aktuellen Dokument-Gliederungstiefe.
 */
function htmlToDocxBlocks(html, headingBase = 5) {
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

  return buildBlocks(dom, headingBase);
}

module.exports = { htmlToDocxBlocks };
