'use strict';
const { create } = require('xmlbuilder2');
const { buildThemeTree } = require('./themeTree');

// Bugfix (Export-Absturz bei "]]>" im Nutzertext): xmlbuilder2 delegiert
// .dat() direkt an DOM Document.createCDATASection(), das PER SPEC (WHATWG
// DOM) IMMER InvalidCharacterError wirft, wenn der Inhalt die Sequenz "]]>"
// enthaelt - unabhaengig von der wellFormed-Option. Enthaelt eine
// Beschreibung/ein Inhalt/ein Ergebnis diese Sequenz (z.B. copy-pasteter
// Code-Schnipsel), wuerde der komplette XML-Export bisher mit einer
// ungefangenen Exception abbrechen (500 EXPORT_FAILED).
// Fix: den Text bei "]]>" in Teile splitten, jeden Teil als eigene
// CDATA-Section anhaengen - UND das Trennzeichen "]]>" selbst als
// escapten Text-Node ("]]&gt;") zwischen den Teilen wieder einfuegen,
// da es sonst beim Splitten verloren ginge (die "]]>"-Zeichen sind kein
// Teil der Daten irgendeiner der beiden Teil-Sections, sondern nur ihr
// Trenner). CDATA- und Text-Nodes sind im XML-Infoset gleichwertige
// Zeichendaten - beim Parsen ergibt sich wieder exakt der Originaltext.
function writeCData(el, text) {
  const s = String(text == null ? '' : text);
  const parts = s.split(']]>');
  parts.forEach((part, i) => {
    el.dat(part);
    if (i < parts.length - 1) el.txt(']]>');
  });
  return el;
}

function writeThemeNode(parentEl, theme) {
  const el = parentEl.ele('theme', {
    id: theme.id,
    parentId: theme.parent_id || '',
    title: theme.title,
  });
  if (theme.description) writeCData(el.ele('description'), theme.description).up();
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
      writeCData(pageEl.ele('content'), p.content).up();
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
      writeCData(todoEl.ele('description'), t.description).up();
      if (t.result) writeCData(todoEl.ele('result', { date: t.result_date || '' }), t.result).up();
      if ((t.themeRefs || []).length) {
        const refsEl = todoEl.ele('themeRefs');
        for (const r of t.themeRefs) refsEl.ele('themeRef', { id: r.theme_id, title: r.theme_title || '' });
      }
    }
  }

  // xmlbuilder2's prettyPrint fügt zwischen den durch writeCData()-Splitting
  // entstehenden Geschwister-Nodes (CDATA, Trenner-Text "]]&gt;", CDATA)
  // Zeilenumbruch+Einrückung ein - das würde den ursprünglichen Text an
  // genau der gesplitteten Stelle um zusätzlichen Whitespace verändern.
  // Der Trenner-Text "]]&gt;" wird ausschließlich von writeCData() erzeugt
  // (kommt in keinem anderen Kontext in diesem Dokument vor, auch nicht als
  // Teilstring - das ">"-Zeichen ist dort immer als "&gt;" escaped). Es wird
  // gezielt nur auf "\n"+Einrückung geprüft (nie auf einzelne Leerzeichen),
  // damit ein vom Nutzer tatsächlich eingegebenes Leerzeichen direkt vor/
  // nach "]]>" NICHT verschluckt wird - nur die von prettyPrint eingefügte
  // Formatierung wird entfernt, um den Originaltext exakt zu erhalten.
  return root.end({ prettyPrint: true })
    .replace(/\]\]>\r?\n[ \t]*(?=\]\]&gt;)/g, ']]>')
    .replace(/\]\]&gt;\r?\n[ \t]*(?=\]\]&gt;|<!\[CDATA\[)/g, ']]&gt;');
}

module.exports = { buildExportXml };
