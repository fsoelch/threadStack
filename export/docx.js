'use strict';
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat,
} = require('docx');
const { htmlToDocxBlocks } = require('./htmlToDocx');

const NUMBERING = {
  config: [{
    reference: 'export-numbering',
    levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: 'start' }],
  }],
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('de-DE');
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

function knowledgeSection(data, includeGraph) {
  const blocks = [new Paragraph({ text: 'Wissen', heading: HeadingLevel.HEADING_1 })];
  const pages = data.knowledgePages || [];

  if (!includeGraph) {
    const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title, 'de'));
    for (const p of sorted) {
      blocks.push(new Paragraph({ text: p.title, heading: HeadingLevel.HEADING_2 }));
      blocks.push(...htmlToDocxBlocks(p.content, 3));
    }
    return blocks;
  }

  // Mit Graph: Seiten unter ihrem ersten zugeordneten Theme gruppieren.
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

  const renderTheme = (theme, depth) => {
    const level = Math.min(depth + 1, 6); // Heading2 für Top-Level-Themes
    blocks.push(new Paragraph({ text: theme.title, heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][level] }));
    const ownPages = (pagesByFirstTheme.get(theme.id) || []).sort((a, b) => a.title.localeCompare(b.title, 'de'));
    for (const p of ownPages) {
      const pageHeadingLevel = Math.min(level + 1, 6);
      blocks.push(new Paragraph({ text: p.title, heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][pageHeadingLevel] }));
      blocks.push(...htmlToDocxBlocks(p.content, pageHeadingLevel + 2));
      const otherThemeIds = (p.themeIds || []).filter(id => id !== theme.id);
      if (otherThemeIds.length) {
        const names = otherThemeIds.map(id => titleById.get(id)).filter(Boolean);
        if (names.length) blocks.push(new Paragraph({ children: [new TextRun({ text: `Auch zugeordnet zu: ${names.join(', ')}`, italics: true, size: 18 })] }));
      }
    }
    for (const child of theme.children) renderTheme(child, depth + 1);
  };

  const tree = buildThemeTree(data.themes || []);
  for (const theme of tree) renderTheme(theme, 0);

  if (unassigned.length) {
    blocks.push(new Paragraph({ text: 'Ohne Topic-Zuordnung', heading: HeadingLevel.HEADING_2 }));
    for (const p of unassigned.sort((a, b) => a.title.localeCompare(b.title, 'de'))) {
      blocks.push(new Paragraph({ text: p.title, heading: HeadingLevel.HEADING_3 }));
      blocks.push(...htmlToDocxBlocks(p.content, 4));
    }
  }

  return blocks;
}

function todosSection(data, openOnly) {
  const blocks = [new Paragraph({ text: 'Todos', heading: HeadingLevel.HEADING_1 })];
  const todos = data.todos || [];
  const open = todos.filter(t => !t.done);
  const done = todos.filter(t => t.done);

  const renderTodo = (t) => {
    blocks.push(new Paragraph({ children: [new TextRun({ text: t.title, bold: true })] }));
    const meta = [];
    if (t.due_date) meta.push(`Fällig: ${fmtDate(t.due_date)}`);
    if (t.themeRefs && t.themeRefs.length) meta.push(`Topics: ${t.themeRefs.map(r => r.theme_title).join(', ')}`);
    if (meta.length) blocks.push(new Paragraph({ children: [new TextRun({ text: meta.join(' · '), italics: true, size: 18 })] }));
    if (t.description) blocks.push(new Paragraph({ children: [new TextRun(t.description)] }));
    if (t.result) {
      const label = t.result_date ? `Ergebnis (${fmtDate(t.result_date)}):` : 'Ergebnis:';
      blocks.push(new Paragraph({ children: [new TextRun({ text: label, bold: true }), new TextRun(` ${t.result}`)] }));
    }
  };

  blocks.push(new Paragraph({ text: 'Offen', heading: HeadingLevel.HEADING_2 }));
  if (!open.length) blocks.push(new Paragraph({ children: [new TextRun({ text: 'Keine offenen Todos.', italics: true })] }));
  open.forEach(renderTodo);

  if (!openOnly) {
    blocks.push(new Paragraph({ text: 'Erledigt', heading: HeadingLevel.HEADING_2 }));
    if (!done.length) blocks.push(new Paragraph({ children: [new TextRun({ text: 'Keine erledigten Todos.', italics: true })] }));
    done.forEach(renderTodo);
  }

  return blocks;
}

async function buildExportDocx(data, { scope, includeGraph, openOnly }) {
  const stamp = new Date().toLocaleString('de-DE');
  const scopeLabel = { knowledge: 'Wissen', todos: 'Todos & Tasks', both: 'Wissen + Todos & Tasks' }[scope] || scope;

  const children = [
    new Paragraph({ text: 'ThreadStack Export', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: `Exportiert am ${stamp} — ${scopeLabel}`, italics: true, color: '666666' })] }),
  ];

  if (scope === 'knowledge' || scope === 'both') children.push(...knowledgeSection(data, includeGraph));
  if (scope === 'todos' || scope === 'both') children.push(...todosSection(data, openOnly));

  const doc = new Document({
    numbering: NUMBERING,
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildExportDocx };
