'use strict';

/**
 * Baut docx-Absaetze (und ggf. Tabellen) aus einer sanitizten <ul>/<ol> im
 * Knowledge-Content, inklusive verschachtelter Unterlisten, unabhaengiger
 * Nummerierung pro Listen-Wurzel und Erhalt von Inline-Formatierung sowie
 * Blockinhalten (<p>/<blockquote>/<table>) innerhalb eines <li>.
 *
 * Nummerierungs-Strategie (siehe Abschlussbericht fuer die ausfuehrliche
 * Begruendung):
 *  - Jeder Aufruf OHNE (oder mit nicht passendem) `parentRef` ist eine neue,
 *    eigenstaendige Listen-Wurzel und bekommt ueber
 *    `ctx.numbering.allocate(kind)` eine frische Referenz. Der oeffentliche
 *    Vertrag ruft `buildListBlocks(node, ctx, level)` fuer jede oberste Liste
 *    im Dokument OHNE 4. Argument auf -> das erzwingt automatisch, dass zwei
 *    getrennte <ol>-Listen im Dokument unterschiedliche Referenzen (und damit
 *    je eine eigene "1.") bekommen.
 *  - Nur der interne rekursive Aufruf fuer eine Sub-Liste, die direktes Kind
 *    eines <li> derselben Wurzel ist UND denselben Listentyp (ordered/
 *    bullet) hat, reicht die Referenz der Wurzel mit erhoehter Ebene weiter
 *    (klassisches "1., 1.a, 1.b, 2."-Verhalten). Wechselt der Typ beim
 *    Verschachteln (ul in ol oder umgekehrt), wird zwingend eine neue
 *    Referenz mit dem passenden `kind` angelegt, da eine einzelne
 *    NumberingRegistry-Referenz laut docxTheme#buildLevels ausschliesslich
 *    EINEN Formatzyklus (entweder Decimal/Letter/Roman oder Bullet-Zeichen)
 *    ueber alle 9 Ebenen hat und keinen Typwechsel innerhalb einer Referenz
 *    erlaubt.
 */

const { Paragraph } = require('docx');

// Direkte <li>-Kinder, die selbst eine neue (verschachtelte) Liste
// aufspannen.
const NESTED_LIST_TAGS = new Set(['ul', 'ol']);

// Direkte <li>-Kinder, die als eigene Block-Elemente (nicht als Inline-Text
// des Listenpunkts) behandelt werden -- sanitize.js erlaubt diese Tags auch
// innerhalb von <li>.
const BLOCK_CHILD_TAGS = new Set(['p', 'table', 'blockquote', 'pre', 'img', 'hr', 'div', 'h1', 'h2', 'h3', 'h4']);

/**
 * Erkennt Tag-Knoten unabhaengig davon, ob explizit `type: 'tag'` gesetzt
 * ist (echte htmlparser2-Knoten haben das immer) oder nicht (der Vertrag
 * in context.js beschreibt Knoten nur ueber `{name, children, attribs}`
 * ohne `type` als Pflichtfeld). Text-Knoten haben nie ein `name`-Feld,
 * daher reicht die Pruefung auf einen String-Namen UND `type !== 'text'`.
 * @param {object} node
 * @returns {boolean}
 */
function isTagNode(node) {
  return !!node && node.type !== 'text' && typeof node.name === 'string';
}

/**
 * @param {object} ctx RenderContext
 * @param {object[]} nodes
 * @returns {Array} TextRun/ExternalHyperlink[] -- wirft nie
 */
function safeInlineRuns(ctx, nodes) {
  if (!ctx || typeof ctx.inlineRunsOf !== 'function') return [];
  try {
    const runs = ctx.inlineRunsOf(Array.isArray(nodes) ? nodes : [], {});
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

/**
 * Klemmt eine Listenebene defensiv auf 0..8 (siehe docxTheme#LIST_INDENT /
 * #buildLevels, die je Referenz genau 9 Ebenen (0..8) definieren).
 * @param {number} level
 * @returns {number}
 */
function clampLevel(level) {
  let lvl = Number.isFinite(level) ? Math.trunc(level) : 0;
  if (lvl < 0) lvl = 0;
  if (lvl > 8) lvl = 8;
  return lvl;
}

/**
 * Fallback bei Erreichen der maximalen Rekursionstiefe (ctx.MAX_DEPTH):
 * traversiert eine (potenziell beliebig tief verschachtelte) Restliste
 * ITERATIV (kein weiterer Rekursions-/Stackverbrauch) und rendert alle
 * verbleibenden <li>-Texte flach auf der letzten erlaubten Ebene/Referenz,
 * damit kein Inhalt verloren geht.
 * @param {object} listNode
 * @param {object} ctx
 * @param {number} level bereits geklemmte Ebene
 * @param {{reference:string, kind:string}} ref
 * @returns {Paragraph[]}
 */
function flattenRemainingListItems(listNode, ctx, level, ref) {
  const blocks = [];
  const stack = [listNode];
  let guard = 0;
  const HARD_LIMIT = 50000; // Schutz gegen pathologisch grosse Restbaeume

  while (stack.length && guard < HARD_LIMIT) {
    const current = stack.pop();
    guard += 1;
    if (!current || !Array.isArray(current.children)) continue;

    const items = current.children.filter((c) => isTagNode(c) && c.name === 'li');
    for (const li of items) {
      const liChildren = Array.isArray(li.children) ? li.children : [];
      const inlineChildren = liChildren.filter(
        (c) => !(isTagNode(c) && NESTED_LIST_TAGS.has(c.name)),
      );
      const nested = liChildren.filter((c) => isTagNode(c) && NESTED_LIST_TAGS.has(c.name));

      blocks.push(
        new Paragraph({
          children: safeInlineRuns(ctx, inlineChildren),
          numbering: { reference: ref.reference, level },
        }),
      );

      for (const sub of nested) stack.push(sub);
    }
  }

  return blocks;
}

/**
 * Baut die Bloecke fuer genau ein <li> (Haupt-Absatz + ggf. Block-Kinder
 * (<p>/<blockquote>/<table>/...) + ggf. verschachtelte Unterlisten).
 * @param {object} li
 * @param {object} ctx
 * @param {number} level bereits geklemmte Ebene
 * @param {{reference:string, kind:string}} ref
 * @param {string} kind 'ordered'|'bullet' der aktuellen Liste
 * @returns {Array} (Paragraph|Table)[]
 */
function buildListItem(li, ctx, level, ref, kind) {
  const liChildren = Array.isArray(li && li.children) ? li.children : [];

  const nestedLists = [];
  const blockChildren = [];
  const inlineChildren = [];

  for (const child of liChildren) {
    if (!child) continue;
    if (isTagNode(child) && NESTED_LIST_TAGS.has(child.name)) {
      nestedLists.push(child);
    } else if (isTagNode(child) && BLOCK_CHILD_TAGS.has(child.name)) {
      blockChildren.push(child);
    } else {
      inlineChildren.push(child);
    }
  }

  const blocks = [
    new Paragraph({
      children: safeInlineRuns(ctx, inlineChildren),
      numbering: { reference: ref.reference, level },
    }),
  ];

  if (blockChildren.length && typeof ctx.buildBlocks === 'function') {
    try {
      const built = ctx.buildBlocks(blockChildren, ctx.child());
      if (Array.isArray(built)) blocks.push(...built);
    } catch {
      ctx.warn('DEPTH_LIMIT');
    }
  }

  for (const subList of nestedLists) {
    if (!subList || !Array.isArray(subList.children)) continue;

    if (ctx.depth >= ctx.MAX_DEPTH) {
      ctx.warn('DEPTH_LIMIT');
      // Nicht tiefer rekursieren: Rest iterativ (ohne Stackverbrauch) flach
      // auf der letzten erlaubten Ebene/Referenz ausgeben, damit kein Text
      // verloren geht.
      blocks.push(...flattenRemainingListItems(subList, ctx, level, ref));
      continue;
    }

    const subKind = subList.name === 'ol' ? 'ordered' : 'bullet';
    const subParentRef = subKind === kind ? ref : null;
    blocks.push(...buildListBlocks(subList, ctx.child(), level + 1, subParentRef));
  }

  return blocks;
}

/**
 * @param {{name:'ul'|'ol', children:object[], attribs:object}} node
 * @param {object} ctx RenderContext (siehe export/html/context.js)
 * @param {number} [level=0] 0-basierte Listenebene
 * @param {{reference:string, kind:string}|null} [parentRef] NUR fuer interne
 *        rekursive Aufrufe gedacht (siehe Modul-Kommentar oben); von
 *        aussen/Paket 2 nie uebergeben -> jede oberste Liste bekommt so
 *        automatisch eine eigene Nummerierungs-Referenz.
 * @returns {Array} (Paragraph|Table)[] -- nie null, wirft nie
 */
function buildListBlocks(node, ctx, level = 0, parentRef = null) {
  try {
    if (!node || (node.name !== 'ul' && node.name !== 'ol') || !Array.isArray(node.children)) {
      return [];
    }
    if (!ctx || typeof ctx.numbering !== 'object' || typeof ctx.numbering.allocate !== 'function') {
      return [];
    }

    const kind = node.name === 'ol' ? 'ordered' : 'bullet';
    const effectiveLevel = clampLevel(level);

    let ref;
    if (parentRef && parentRef.kind === kind && typeof parentRef.reference === 'string') {
      ref = parentRef;
    } else {
      ref = { reference: ctx.numbering.allocate(kind), kind };
    }

    const items = node.children.filter((c) => isTagNode(c) && c.name === 'li');
    const blocks = [];

    for (const li of items) {
      blocks.push(...buildListItem(li, ctx, effectiveLevel, ref, kind));
    }

    return blocks;
  } catch {
    // Niemals nach aussen werfen -- sicherer Fallback: leere Blockliste.
    try {
      if (ctx && typeof ctx.warn === 'function') ctx.warn('DEPTH_LIMIT');
    } catch {
      // Logging darf den Export nie abbrechen.
    }
    return [];
  }
}

module.exports = { buildListBlocks };
