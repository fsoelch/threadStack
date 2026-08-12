'use strict';
// STUB – wird von Paket 5 ersetzt

/**
 * Stub-Verhalten: gibt IMMER einen Platzhalter-Absatz zurueck (kursiv,
 * "[Bild]"). Wird von Paket 5 durch die vollstaendige Bild-Einbettung
 * (Decodierung, Skalierung, Warn-Codes wie IMG_DECODE_FAILED) ersetzt.
 *
 * @param {object} node htmlparser2-Knoten fuer <img>
 * @param {object} ctx RenderContext (siehe export/html/context.js)
 * @returns {Array} Paragraph[] (docx)
 */
function buildImageBlocks(node, ctx) {
  const { Paragraph, TextRun } = require('docx');
  return [
    new Paragraph({
      children: [new TextRun({ text: '[Bild]', italics: true })],
    }),
  ];
}

module.exports = { buildImageBlocks };
