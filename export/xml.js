'use strict';
const { create } = require('xmlbuilder2');

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

function writeThemeNode(parentEl, theme) {
  const el = parentEl.ele('theme', {
    id: theme.id,
    parentId: theme.parent_id || '',
    title: theme.title,
  });
  if (theme.description) el.ele('description').dat(theme.description).up();
  for (const child of theme.children) writeThemeNode(el, child);
}

function buildExportXml(data, { scope, includeGraph, openOnly }) {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('threadstackExport', {
      version: '1',
      exportedAt: new Date().toISOString(),
      scope,
      includesGraph: String(!!includeGraph),
      openOnly: String(!!openOnly),
    });

  if ((scope === 'knowledge' || scope === 'both') && includeGraph && (data.themes || []).length) {
    const themesEl = root.ele('themes');
    const tree = buildThemeTree(data.themes);
    for (const theme of tree) writeThemeNode(themesEl, theme);
  }

  if (scope === 'knowledge' || scope === 'both') {
    const titleById = new Map((data.themes || []).map(t => [t.id, t.title]));
    const pagesEl = root.ele('knowledgePages');
    for (const p of data.knowledgePages || []) {
      const pageEl = pagesEl.ele('page', {
        id: p.id, title: p.title, createdAt: p.created_at, updatedAt: p.updated_at,
      });
      if (includeGraph && (p.themeIds || []).length) {
        const refsEl = pageEl.ele('themeRefs');
        for (const themeId of p.themeIds) refsEl.ele('themeRef', { id: themeId, title: titleById.get(themeId) || '' });
      }
      if (includeGraph && (p.relatedIds || []).length) {
        const relEl = pageEl.ele('relatedRefs');
        for (const relId of p.relatedIds) relEl.ele('relatedRef', { id: relId });
      }
      pageEl.ele('content').dat(p.content || '').up();
    }
  }

  if (scope === 'todos' || scope === 'both') {
    const todosEl = root.ele('todos');
    for (const t of data.todos || []) {
      const todoEl = todosEl.ele('todo', {
        id: t.id,
        done: String(!!t.done),
        title: t.title,
        dueDate: t.due_date || '',
        snoozedUntil: t.snoozed_until || '',
        createdAt: t.created_at,
        updatedAt: t.updated_at || '',
        isPrivate: String(!!t.is_private),
      });
      todoEl.ele('description').dat(t.description || '').up();
      if (t.result) todoEl.ele('result', { date: t.result_date || '' }).dat(t.result).up();
      if ((t.themeRefs || []).length) {
        const refsEl = todoEl.ele('themeRefs');
        for (const r of t.themeRefs) refsEl.ele('themeRef', { id: r.theme_id, title: r.theme_title || '' });
      }
    }
  }

  return root.end({ prettyPrint: true });
}

module.exports = { buildExportXml };
