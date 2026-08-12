'use strict';
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak,
  TableOfContents, Footer, PageNumber, AlignmentType, BorderStyle,
} = require('docx');
const docxTheme = require('./docxTheme');
const { htmlToDocxBlocks } = require('./htmlToDocx');

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

const SCOPE_LABEL = { knowledge: 'Wissen', todos: 'Todos & Tasks', both: 'Wissen + Todos & Tasks' };

// Heading-Level (1-6) -> docx HeadingLevel-Konstante. Klemmt auf 1..6,
// wirft nie (auch nicht bei NaN/undefined).
function headingLevel(n) {
  let lvl = Number.isFinite(n) ? Math.trunc(n) : 1;
  if (lvl < 1) lvl = 1;
  if (lvl > 6) lvl = 6;
  return HEADING_LEVELS[lvl - 1];
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('de-DE');
}

// "TT.MM.JJJJ, HH:MM" — Server-kontrolliertes Datum (new Date()), keine
// Nutzereingabe.
function fmtDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isBlankHtml(html) {
  if (!html) return true;
  const text = String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  return text.length === 0;
}

// Ruft den (Paket 2)-Konverter mit der vereinbarten Fassaden-Signatur auf:
// htmlToDocxBlocks(html, { headingBase, numbering, warn }).
function convertHtml(html, headingBase, registry, warn) {
  return htmlToDocxBlocks(html, { headingBase, numbering: registry, warn });
}

function hintParagraph(text) {
  return new Paragraph({ children: [new TextRun({ text, italics: true, color: docxTheme.COLOR.muted, size: 20 })] });
}

function metaParagraph(text) {
  return new Paragraph({ style: 'Meta', children: [new TextRun(text)] });
}

// Optisch abgesetzte Trennung zwischen zwei Wissensseiten: Abstand + duenne
// Trennlinie (KEIN Seitenumbruch, siehe Architektur-Entscheidung).
function separatorParagraph() {
  return new Paragraph({
    spacing: { before: docxTheme.SPACING.headingBefore, after: docxTheme.SPACING.blockAfter },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: docxTheme.COLOR.rule, space: 4 } },
    children: [],
  });
}

function pageBreakParagraph() {
  return new Paragraph({ children: [new PageBreak()] });
}

function buildThemeTree(themes) {
  const byId = new Map(themes.map(t => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const t of byId.values()) {
    if (t.parent_id && byId.has(t.parent_id)) byId.get(t.parent_id).children.push(t);
    else roots.push(t);
  }
  const sortRec = (list) => {
    list.sort((a, b) => (a.sort_order - b.sort_order) || a.title.localeCompare(b.title, 'de'));
    list.forEach(n => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

// Heading-Level fuer ein Topic nach Tiefe (0-indexiert): Tiefe 0 -> 2,
// Tiefe 1 -> 3, Tiefe >=2 -> 4 (siehe Architektur-Tabelle).
function themeHeadingLevel(depth) {
  if (depth <= 0) return 2;
  if (depth === 1) return 3;
  return 4;
}

// Zusaetzlicher, kumulativer Einzug fuer Topics ab Tiefe 2 (left = 360 *
// (Tiefe-1) twip). Gibt undefined zurueck, wenn kein Zusatz-Einzug noetig
// ist.
function themeExtraIndent(depth) {
  if (depth < 2) return undefined;
  return { left: 360 * (depth - 1) };
}

/**
 * Rendert den "Wissen"-Abschnitt (ohne die einleitende Heading1, die wird
 * vom Aufrufer gesetzt). Gibt eine Liste von Paragraph/Table-Bloecken
 * zurueck.
 */
function knowledgeBlocks(data, includeGraph, registry, warn) {
  const blocks = [];
  const pages = data.knowledgePages || [];

  if (!pages.length) {
    blocks.push(hintParagraph('Keine Wissensseiten vorhanden.'));
    return blocks;
  }

  let isFirstPage = true;
  const emitPage = (p, pageLevel, extraMetaLines) => {
    if (!isFirstPage) blocks.push(separatorParagraph());
    isFirstPage = false;

    blocks.push(new Paragraph({ text: p.title, heading: headingLevel(pageLevel) }));
    if (extraMetaLines && extraMetaLines.length) {
      blocks.push(metaParagraph(extraMetaLines.join(' · ')));
    }
    const headingBase = Math.min(pageLevel + 1, 6);
    blocks.push(...convertHtml(p.content, headingBase, registry, warn));
  };

  if (!includeGraph) {
    const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title, 'de'));
    for (const p of sorted) emitPage(p, 2, []);
    return blocks;
  }

  // Mit Graph: Seiten unter ihrem ersten (sortiert) zugeordneten Topic
  // gruppieren, restliche Topics als "Auch zugeordnet zu"-Metazeile.
  const pagesByFirstTheme = new Map();
  const unassigned = [];
  for (const p of pages) {
    const sortedThemeIds = [...(p.themeIds || [])].sort();
    const firstThemeId = sortedThemeIds[0];
    if (!firstThemeId) { unassigned.push(p); continue; }
    if (!pagesByFirstTheme.has(firstThemeId)) pagesByFirstTheme.set(firstThemeId, []);
    pagesByFirstTheme.get(firstThemeId).push(p);
  }
  const titleById = new Map((data.themes || []).map(t => [t.id, t.title]));
  const pageById = new Map(pages.map(p => [p.id, p]));

  const metaLinesFor = (p, primaryThemeId) => {
    const lines = [];
    const otherThemeIds = (p.themeIds || []).filter(id => id !== primaryThemeId);
    if (otherThemeIds.length) {
      const names = otherThemeIds.map(id => titleById.get(id)).filter(Boolean);
      if (names.length) lines.push(`Auch zugeordnet zu: ${names.join(', ')}`);
    }
    if (p.relatedIds && p.relatedIds.length) {
      const names = p.relatedIds.map(id => pageById.get(id) && pageById.get(id).title).filter(Boolean);
      if (names.length) lines.push(`Verwandtes Wissen: ${names.join(', ')}`);
    }
    return lines;
  };

  const renderTheme = (theme, depth) => {
    const level = themeHeadingLevel(depth);
    const extraIndent = themeExtraIndent(depth);
    const paraOpts = { text: theme.title, heading: headingLevel(level) };
    if (extraIndent) paraOpts.indent = extraIndent;
    blocks.push(new Paragraph(paraOpts));

    const ownPages = (pagesByFirstTheme.get(theme.id) || []).sort((a, b) => a.title.localeCompare(b.title, 'de'));
    const pageLevel = Math.min(level + 1, 5);
    for (const p of ownPages) emitPage(p, pageLevel, metaLinesFor(p, theme.id));

    for (const child of theme.children) renderTheme(child, depth + 1);
  };

  const tree = buildThemeTree(data.themes || []);
  for (const theme of tree) renderTheme(theme, 0);

  if (unassigned.length) {
    const level = 2;
    blocks.push(new Paragraph({ text: 'Ohne Topic-Zuordnung', heading: headingLevel(level) }));
    const pageLevel = Math.min(level + 1, 5);
    for (const p of unassigned.sort((a, b) => a.title.localeCompare(b.title, 'de'))) {
      emitPage(p, pageLevel, metaLinesFor(p, null));
    }
  }

  return blocks;
}

// Heading-Basis fuer Todo-Beschreibung/-Ergebnis-HTML: "Offen"/"Erledigt"
// sind Heading2, Content der Todos beginnt daher eine Ebene tiefer.
const TODO_CONTENT_HEADING_BASE = 3;

function renderTodo(t, done, registry, warn, blocks) {
  blocks.push(new Paragraph({ children: [new TextRun({ text: t.title, bold: true, strike: !!done })] }));

  const meta = [];
  if (t.due_date) meta.push(`Fällig: ${fmtDate(t.due_date)}`);
  if (t.themeRefs && t.themeRefs.length) meta.push(`Topics: ${t.themeRefs.map(r => r.theme_title).join(', ')}`);
  if (meta.length) {
    blocks.push(new Paragraph({ children: [new TextRun({ text: meta.join(' · '), italics: true, color: docxTheme.COLOR.muted, size: 18 })] }));
  }

  if (!isBlankHtml(t.description)) {
    blocks.push(...convertHtml(t.description, TODO_CONTENT_HEADING_BASE, registry, warn));
  }

  if (!isBlankHtml(t.result)) {
    blocks.push(new Paragraph({ children: [new TextRun({ text: 'Ergebnis:', bold: true })] }));
    blocks.push(...convertHtml(t.result, TODO_CONTENT_HEADING_BASE, registry, warn));
  }
}

function todosBlocks(data, openOnly, registry, warn) {
  const blocks = [];
  const todos = data.todos || [];
  const open = todos.filter(t => !t.done);
  const done = todos.filter(t => t.done);

  blocks.push(new Paragraph({ text: 'Offen', heading: headingLevel(2) }));
  if (!open.length) blocks.push(hintParagraph('Keine offenen Todos.'));
  else open.forEach(t => renderTodo(t, false, registry, warn, blocks));

  if (!openOnly) {
    blocks.push(new Paragraph({ text: 'Erledigt', heading: headingLevel(2) }));
    if (!done.length) blocks.push(hintParagraph('Keine erledigten Todos.'));
    else done.forEach(t => renderTodo(t, true, registry, warn, blocks));
  }

  return blocks;
}

function titlePageBlocks(scope, includeGraph, openOnly, now) {
  const scopeLabel = SCOPE_LABEL[scope] || String(scope);
  const blocks = [
    new Paragraph({ style: 'TitlePageTitle', children: [new TextRun('ThreadStack Export')] }),
    new Paragraph({ style: 'TitlePageMeta', children: [new TextRun(scopeLabel)] }),
    new Paragraph({ style: 'TitlePageMeta', children: [new TextRun(`Exportiert am ${fmtDateTime(now)}`)] }),
  ];

  const options = [];
  if ((scope === 'knowledge' || scope === 'both') && includeGraph) options.push('Inkl. Topic-Struktur');
  if ((scope === 'todos' || scope === 'both') && openOnly) options.push('Nur offene Todos');
  if (options.length) {
    blocks.push(new Paragraph({ style: 'TitlePageMeta', children: [new TextRun(options.join(' · '))] }));
  }

  return blocks;
}

function tocBlocks(hasContent) {
  const blocks = [new Paragraph({ text: 'Inhaltsverzeichnis', heading: headingLevel(1) })];
  if (hasContent) {
    blocks.push(new TableOfContents('Inhaltsverzeichnis', { hyperlink: true, headingStyleRange: '1-3' }));
    blocks.push(hintParagraph('Inhaltsverzeichnis in Word mit F9 aktualisieren.'));
  } else {
    blocks.push(hintParagraph('Für den gewählten Export-Umfang sind keine Inhalte vorhanden.'));
  }
  return blocks;
}

function buildFooters(stampText) {
  return {
    first: new Footer({ children: [] }),
    default: new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'Seite ', size: 18, color: docxTheme.COLOR.muted }),
            new TextRun({ children: [PageNumber.CURRENT], size: 18, color: docxTheme.COLOR.muted }),
            new TextRun({ text: ' von ', size: 18, color: docxTheme.COLOR.muted }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: docxTheme.COLOR.muted }),
            new TextRun({ text: ` · ThreadStack Export vom ${stampText}`, size: 18, color: docxTheme.COLOR.muted }),
          ],
        }),
      ],
    }),
  };
}

// Aggregiert warn()-Aufrufe aus dem HTML->DOCX-Konverter in eine
// Map<code,count> und loggt sie am Ende NUR als Codes (nie Inhalte/HTML/
// Titel/URLs/Base64-Daten).
function createWarnCollector() {
  const counts = new Map();
  const warn = (code) => {
    if (typeof code !== 'string' || !code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
  };
  const flush = () => {
    if (counts.size === 0) return;
    console.warn('[export] Hinweise:', Object.fromEntries(counts));
  };
  return { warn, flush };
}

/**
 * @param {object} data Ergebnis von collectExportData (export/index.js).
 * @param {{scope:'knowledge'|'todos'|'both', includeGraph:boolean, openOnly:boolean}} options
 * @returns {Promise<Buffer>} wirft nur bei echten Systemfehlern.
 */
async function buildExportDocx(data, { scope, includeGraph, openOnly }) {
  const now = new Date();
  const stampText = fmtDateTime(now);
  const scopeLabel = SCOPE_LABEL[scope] || String(scope);

  const registry = docxTheme.createNumberingRegistry();
  const { warn, flush } = createWarnCollector();

  const knowledgeSelected = scope === 'knowledge' || scope === 'both';
  const todosSelected = scope === 'todos' || scope === 'both';
  const hasKnowledgeContent = knowledgeSelected && (data.knowledgePages || []).length > 0;
  const hasTodosContent = todosSelected && (data.todos || []).length > 0;
  const hasContent = hasKnowledgeContent || hasTodosContent;

  const children = [
    ...titlePageBlocks(scope, includeGraph, openOnly, now),
    pageBreakParagraph(),
    ...tocBlocks(hasContent),
  ];

  if (knowledgeSelected) {
    children.push(pageBreakParagraph());
    children.push(new Paragraph({ text: 'Wissen', heading: headingLevel(1) }));
    children.push(...knowledgeBlocks(data, includeGraph, registry, warn));
  }

  if (todosSelected) {
    children.push(pageBreakParagraph());
    children.push(new Paragraph({ text: 'Todos & Tasks', heading: headingLevel(1) }));
    children.push(...todosBlocks(data, openOnly, registry, warn));
  }

  const doc = new Document({
    title: 'ThreadStack Export',
    creator: 'ThreadStack',
    lastModifiedBy: 'ThreadStack',
    description: `${scopeLabel}, exportiert am ${stampText}`,
    subject: 'ThreadStack',
    revision: 1,
    styles: docxTheme.STYLES,
    numbering: registry.buildConfig(),
    features: { updateFields: true },
    sections: [
      {
        properties: { ...docxTheme.SECTION_PROPERTIES, titlePage: true },
        footers: buildFooters(stampText),
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  flush();
  return buffer;
}

module.exports = { buildExportDocx };
