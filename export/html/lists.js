'use strict';
// STUB – wird von Paket 3 ersetzt

/**
 * Stub-Verhalten: gibt flache Absaetze zurueck (ein Paragraph pro <li>,
 * ohne Nummerierung/Einrueckung). Wird von Paket 3 durch die vollstaendige
 * Listen-Implementierung (Nummerierung, Einrueckung, verschachtelte Listen)
 * ersetzt.
 *
 * @param {{name:'ul'|'ol', children:object[], attribs:object}} node
 * @param {object} ctx RenderContext (siehe export/html/context.js)
 * @param {number} [level=0] 0-basierte Listenebene
 * @returns {Array} Paragraph[] (docx)
 */
function buildListBlocks(node, ctx, level = 0) {
  const { Paragraph, TextRun } = require('docx');

  if (!node || !Array.isArray(node.children)) return [];

  const items = node.children.filter((child) => child && child.name === 'li');
  const blocks = [];

  for (const li of items) {
    const text = extractPlainText(li);
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text })],
      }),
    );
  }

  return blocks;
}

/**
 * Extrahiert rekursiv den reinen Textinhalt eines htmlparser2-Knotens.
 * Rein fuer den Stub gedacht (Paket 3 ersetzt dies durch buildInlineRuns).
 * @param {object} node
 * @returns {string}
 */
function extractPlainText(node) {
  if (!node) return '';
  if (node.type === 'text') return typeof node.data === 'string' ? node.data : '';
  if (!Array.isArray(node.children)) return '';
  return node.children.map(extractPlainText).join('');
}

module.exports = { buildListBlocks };
