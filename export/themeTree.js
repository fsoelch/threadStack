'use strict';
// Gemeinsamer Baumaufbau für Themen (parent_id -> children), von docx.js UND
// xml.js identisch benötigt (beide serialisieren dieselbe Themenhierarchie,
// nur in unterschiedlichen Ausgabeformaten). Aus beiden Dateien extrahiert,
// um Divergenz zwischen den beiden Export-Formaten zu vermeiden (siehe
// CLAUDE.md: "Wiederverwendung vor Neuentwicklung").
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

module.exports = { buildThemeTree };
