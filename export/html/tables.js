'use strict';

/**
 * HTML-<table> -> docx-Table Konverter (Arbeitspaket 4 "Tabellen").
 *
 * Verantwortlich fuer: Rahmen (alle Kanten inkl. innerer Linien), volle
 * Satzspiegelbreite, Kopfzeilen-Hervorhebung + Wiederholung bei Seitenumbruch,
 * colspan/rowspan (inkl. Belegungsmatrix), Blockinhalte in Zellen, robuste
 * Behandlung ungleichmaessiger Zeilen und leerer Tabellen.
 *
 * Siehe export/html/context.js fuer den RenderContext-Vertrag und
 * export/docxTheme.js fuer die verwendeten Design-Tokens.
 */

const {
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  TableLayoutType,
  VerticalMergeType,
} = require('docx');

const { COLOR, PAGE } = require('../docxTheme');

const MIN_SPAN = 1;
const MAX_SPAN = 64;
const BORDER_SIZE = 4;
// Security-Nachbesserung (Security Review): MAX_SPAN klemmt nur den
// Einzelwert eines colspan/rowspan-Attributs, nicht die SUMME ueber eine
// Zeile. Ohne Obergrenze fuer die Gesamt-Spaltenzahl (und das daraus
// abgeleitete Zellen-Budget ueber alle Zeilen) kann eine wenige KB grosse,
// bereits sanitisierte Tabelle (z.B. viele <td colspan="64">-Zellen) den
// Node-Prozess mit "JavaScript heap out of memory" abstuerzen lassen, da
// buildRows() jede Zeile bis zur vollen Spaltenzahl auffuellt (quadratischer
// Aufwand). MAX_COLUMNS/MAX_CELL_BUDGET begrenzen das hart.
const MAX_COLUMNS = 64;
const MAX_CELL_BUDGET = 20000;

/**
 * Klemmt einen colspan/rowspan-Rohwert auf sinnvolle Grenzen (1..64).
 * Ungueltige/fehlende Werte fallen auf 1 zurueck. Nutzt Number.parseInt als
 * Schutz gegen absurde/boesartige Eingaben (z.B. colspan="999999999").
 *
 * @param {*} raw Roher Attributwert (String|undefined)
 * @returns {{value:number, wasInvalid:boolean}}
 */
function clampSpan(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: MIN_SPAN, wasInvalid: false };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_SPAN) {
    return { value: MIN_SPAN, wasInvalid: true };
  }
  if (n > MAX_SPAN) {
    return { value: MAX_SPAN, wasInvalid: true };
  }
  return { value: n, wasInvalid: false };
}

/**
 * Sammelt alle <tr>-Knoten einer Tabelle (rekursiv durch thead/tbody/tfoot),
 * markiert dabei, ob die Zeile innerhalb eines <thead> liegt. Steigt NICHT
 * in td/th ab (verschachtelte Tabellen in Zellen werden separat ueber
 * ctx.buildBlocks beim Zellinhalt behandelt, nicht hier).
 *
 * @param {object} tableNode
 * @returns {Array<{node:object, isHeaderRow:boolean}>}
 */
function collectRows(tableNode) {
  const rows = [];
  function walk(node, inHeader) {
    for (const child of node.children || []) {
      if (!child || child.type !== 'tag') continue;
      if (child.name === 'tr') {
        rows.push({ node: child, isHeaderRow: inHeader });
      } else if (child.name === 'thead') {
        walk(child, true);
      } else if (child.name === 'tbody' || child.name === 'tfoot') {
        walk(child, inHeader);
      }
    }
  }
  walk(tableNode, false);
  return rows;
}

/**
 * Extrahiert die td/th-Zellen einer <tr> mit geklemmten colspan/rowspan.
 *
 * @param {object} trNode
 * @param {function} warn ctx.warn
 * @returns {Array<{node:object, isHeaderCell:boolean, colspan:number, rowspan:number}>}
 */
function extractCells(trNode, warn) {
  const cells = [];
  for (const child of trNode.children || []) {
    if (!child || child.type !== 'tag') continue;
    if (child.name !== 'td' && child.name !== 'th') continue;
    const attribs = child.attribs || {};
    const colspanResult = clampSpan(attribs.colspan);
    const rowspanResult = clampSpan(attribs.rowspan);
    if (colspanResult.wasInvalid || rowspanResult.wasInvalid) warn('TABLE_MALFORMED');
    cells.push({
      node: child,
      isHeaderCell: child.name === 'th',
      colspan: colspanResult.value,
      rowspan: rowspanResult.value,
    });
  }
  return cells;
}

/**
 * Ermittelt die Spaltenzahl der Tabelle unter Beruecksichtigung von
 * colspan/rowspan (Belegungssimulation ueber alle Zeilen hinweg).
 *
 * @param {Array<{cells:Array}>} rowsInfo
 * @returns {number}
 */
function computeColumnCount(rowsInfo) {
  let occ = []; // occ[col] = verbleibende Zeilen (inkl. aktueller), fuer die die Spalte belegt ist
  let maxCols = 0;
  for (const row of rowsInfo) {
    let col = 0;
    for (const cell of row.cells) {
      while (occ[col] > 0) col += 1;
      for (let k = 0; k < cell.colspan; k += 1) {
        occ[col + k] = cell.rowspan;
      }
      col += cell.colspan;
    }
    let rowMax = col;
    for (let i = 0; i < occ.length; i += 1) {
      if (occ[i] > 0) rowMax = Math.max(rowMax, i + 1);
    }
    maxCols = Math.max(maxCols, rowMax);
    occ = occ.map((v) => (v > 0 ? v - 1 : 0));
  }
  return maxCols;
}

/**
 * Baut den Inhalt einer einzelnen Zelle als Array von Paragraph/Table.
 * Nutzt fuer Kopfzellen (th) den 'TableHeader'-Absatzstil + fette Runs,
 * fuer normale Zellen (td) ctx.buildBlocks, damit Blockinhalte (Listen,
 * mehrere Absaetze) strukturiert erhalten bleiben. Wirft nie.
 *
 * @param {object} cellInfo
 * @param {object} ctx
 * @returns {Array} Paragraph[] | (Paragraph|Table)[]
 */
function buildCellContent(cellInfo, ctx) {
  const children = (cellInfo.node && cellInfo.node.children) || [];
  try {
    if (cellInfo.isHeaderCell) {
      const runs =
        typeof ctx.inlineRunsOf === 'function' ? ctx.inlineRunsOf(children, { bold: true }) : [];
      return [new Paragraph({ style: 'TableHeader', children: Array.isArray(runs) ? runs : [] })];
    }
    const blocks = typeof ctx.buildBlocks === 'function' ? ctx.buildBlocks(children, ctx.child()) : [];
    if (Array.isArray(blocks) && blocks.length) return blocks;
    return [new Paragraph({})];
  } catch {
    ctx.warn('TABLE_MALFORMED');
    return [new Paragraph({})];
  }
}

/**
 * Baut ein TableCell fuer eine eigene (nicht durch rowspan fortgesetzte) Zelle.
 * @param {object} cellInfo
 * @param {object} ctx
 * @returns {TableCell}
 */
function buildOwnCell(cellInfo, ctx) {
  const content = buildCellContent(cellInfo, ctx);
  const options = { children: content };
  if (cellInfo.colspan > 1) options.columnSpan = cellInfo.colspan;
  if (cellInfo.rowspan > 1) options.verticalMerge = VerticalMergeType.RESTART;
  if (cellInfo.isHeaderCell) options.shading = { fill: COLOR.thBg };
  return new TableCell(options);
}

/**
 * Baut eine CONTINUE-Platzhalterzelle fuer eine per rowspan fortgesetzte Spalte.
 * @param {number} span columnSpan der urspruenglichen Zelle (Konsistenz der Spaltenbreite)
 * @returns {TableCell}
 */
function buildContinuationCell(span) {
  const options = {
    children: [new Paragraph({})],
    verticalMerge: VerticalMergeType.CONTINUE,
  };
  if (span > 1) options.columnSpan = span;
  return new TableCell(options);
}

/**
 * Baut eine leere Auffuellzelle (fuer ungleichmaessige Zeilen).
 * @returns {TableCell}
 */
function buildEmptyCell() {
  return new TableCell({ children: [new Paragraph({})] });
}

/**
 * Baut alle TableRow-Objekte inkl. rowspan/colspan-Handhabung und Auffuellung
 * ungleichmaessiger Zeilen.
 *
 * @param {Array} rowsInfo
 * @param {number} columnCount
 * @param {object} ctx
 * @returns {TableRow[]}
 */
function buildRows(rowsInfo, columnCount, ctx) {
  const tableRows = [];
  // activeMerges: Array<{startCol, span, rowsLeft}> - rowsLeft = wie viele
  // WEITERE Zeilen (nach der aktuellen) noch eine CONTINUE-Zelle brauchen.
  let activeMerges = [];

  for (const row of rowsInfo) {
    const cellsQueue = row.cells.slice();
    const rowCells = [];
    const nextMerges = [];
    // Merges, die in DIESER Zeile eine CONTINUE-Zelle brauchen (rowsLeft war >0 nach vorheriger Zeile)
    const dueMerges = activeMerges.filter((m) => m.rowsLeft > 0);
    dueMerges.sort((a, b) => a.startCol - b.startCol);
    let mergeIdx = 0;

    let col = 0;
    let padded = false;
    while (col < columnCount) {
      const merge = dueMerges[mergeIdx];
      if (merge && merge.startCol === col) {
        rowCells.push(buildContinuationCell(merge.span));
        if (merge.rowsLeft - 1 > 0) {
          nextMerges.push({ startCol: merge.startCol, span: merge.span, rowsLeft: merge.rowsLeft - 1 });
        }
        col += merge.span;
        mergeIdx += 1;
        continue;
      }

      if (cellsQueue.length) {
        const cellInfo = cellsQueue.shift();
        // Spalte kann durch die eigene colspan ueber die verbleibende Breite
        // hinausragen (widerspruechliche Kombination) -> klemmen.
        let effectiveColspan = cellInfo.colspan;
        if (col + effectiveColspan > columnCount) {
          effectiveColspan = Math.max(MIN_SPAN, columnCount - col);
          ctx.warn('TABLE_MALFORMED');
        }
        const clampedCellInfo = { ...cellInfo, colspan: effectiveColspan };
        rowCells.push(buildOwnCell(clampedCellInfo, ctx));
        if (cellInfo.rowspan > 1) {
          nextMerges.push({ startCol: col, span: effectiveColspan, rowsLeft: cellInfo.rowspan - 1 });
        }
        col += effectiveColspan;
        continue;
      }

      // Kein Merge faellig, keine eigene Zelle mehr uebrig -> Auffuellzelle
      // (ungleichmaessige Zeile).
      rowCells.push(buildEmptyCell());
      padded = true;
      col += 1;
    }

    if (cellsQueue.length) {
      // Mehr Zellen deklariert als Platz in der Spaltenzahl -> inkonsistent.
      ctx.warn('TABLE_MALFORMED');
    } else if (padded) {
      // Zeile war kuerzer als die ermittelte Spaltenzahl -> mit leeren Zellen aufgefuellt.
      ctx.warn('TABLE_MALFORMED');
    }

    activeMerges = nextMerges;

    const rowOptions = { children: rowCells };
    if (row.isHeaderRow) rowOptions.tableHeader = true;
    tableRows.push(new TableRow(rowOptions));
  }

  return tableRows;
}

/**
 * Baut die Rahmendefinition (alle Kanten inkl. innerer Linien) fuer die Tabelle.
 * @returns {object}
 */
function buildBorders() {
  const edge = { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: COLOR.rule };
  return {
    top: edge,
    bottom: edge,
    left: edge,
    right: edge,
    insideHorizontal: edge,
    insideVertical: edge,
  };
}

/**
 * Berechnet gleichmaessig verteilte Spaltenbreiten (twip), die in Summe der
 * Satzspiegelbreite entsprechen.
 * @param {number} columnCount
 * @returns {number[]}
 */
function buildColumnWidths(columnCount) {
  const base = Math.floor(PAGE.contentWidthTwip / columnCount);
  const widths = new Array(columnCount).fill(base);
  const remainder = PAGE.contentWidthTwip - base * columnCount;
  if (remainder > 0) widths[widths.length - 1] += remainder;
  return widths;
}

/**
 * Wandelt einen <table>-Knoten in [Table, Paragraph] um (formatierungstreuer
 * Word-Export: volle Breite, Rahmen, wiederholende Kopfzeile, colspan/rowspan).
 *
 * @param {{name:'table', children:object[], attribs:object}} node
 * @param {object} ctx RenderContext (siehe export/html/context.js)
 * @returns {Array} (Table|Paragraph)[] - [] wenn keine <tr> vorhanden ist.
 */
function buildTableBlocks(node, ctx) {
  if (!node || !Array.isArray(node.children) || !ctx || typeof ctx.warn !== 'function') return [];

  try {
    const rawRows = collectRows(node);
    if (!rawRows.length) return [];

    const rowsInfo = rawRows.map((r) => ({
      isHeaderRow: r.isHeaderRow,
      cells: extractCells(r.node, ctx.warn),
    }));

    let columnCount = computeColumnCount(rowsInfo);
    if (columnCount <= 0) return [];
    if (columnCount > MAX_COLUMNS) {
      columnCount = MAX_COLUMNS;
      ctx.warn('TABLE_MALFORMED');
    }
    if (columnCount * rowsInfo.length > MAX_CELL_BUDGET) {
      // Gesamt-Zellenbudget ueberschritten (z.B. sehr viele Zeilen bei
      // gleichzeitig hoher Spaltenzahl) — Tabelle wird nicht gerendert,
      // Export bricht dafuer nicht mit Speicher-Erschoepfung ab.
      ctx.warn('TABLE_MALFORMED');
      return [];
    }

    const tableRows = buildRows(rowsInfo, columnCount, ctx);
    if (!tableRows.length) return [];

    const table = new Table({
      rows: tableRows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      columnWidths: buildColumnWidths(columnCount),
      borders: buildBorders(),
    });

    return [table, new Paragraph({})];
  } catch {
    ctx.warn('TABLE_MALFORMED');
    return [];
  }
}

module.exports = { buildTableBlocks };
