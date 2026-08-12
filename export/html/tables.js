'use strict';
// STUB – wird von Paket 4 ersetzt

/**
 * Stub-Verhalten: ignoriert die Tabelle vollstaendig (gibt [] zurueck).
 * Wird von Paket 4 durch die vollstaendige Tabellen-Implementierung ersetzt.
 *
 * @param {object} node htmlparser2-Knoten fuer <table>
 * @param {object} ctx RenderContext (siehe export/html/context.js)
 * @returns {Array} (Table|Paragraph)[] (docx)
 */
function buildTableBlocks(node, ctx) {
  return [];
}

module.exports = { buildTableBlocks };
