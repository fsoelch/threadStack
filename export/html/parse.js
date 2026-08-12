'use strict';
// Wandelt einen (bereits allowlist-sanitizten) HTML-String in einen einfachen
// DOM-Baum {type, name, attribs, children} bzw. {type:'text', data} um.
//
// Nutzt htmlparser2 (bereits Projekt-Abhaengigkeit, siehe package.json) -
// KEINE neue npm-Abhaengigkeit. htmlparser2 ist bereits tolerant gegenueber
// nicht geschlossenen/falsch verschachtelten Tags (SAX-Parser ohne
// Validierung); zusaetzlich wird hier defensiv try/catch verwendet, damit
// diese Funktion unter GAR KEINEN Umstaenden wirft, sondern im Zweifel einen
// (ggf. leeren) Teilbaum liefert.

const { Parser } = require('htmlparser2');

/**
 * Parst einen HTML-String zu einem flachen Array von Top-Level-DOM-Knoten.
 * @param {string} html
 * @returns {Array<object>} niemals null, wirft nie
 */
function parseHtml(html) {
  const dom = [];
  try {
    const source = typeof html === 'string' ? html : (html == null ? '' : String(html));
    const stack = [{ children: dom }];

    const parser = new Parser(
      {
        onopentag(name, attribs) {
          const node = {
            type: 'tag',
            name: typeof name === 'string' ? name.toLowerCase() : '',
            attribs: attribs && typeof attribs === 'object' ? attribs : {},
            children: [],
          };
          const parent = stack[stack.length - 1];
          parent.children.push(node);
          stack.push(node);
        },
        ontext(text) {
          if (typeof text !== 'string' || !text) return;
          // htmlparser2 kann Text um dekodierte Entities/Chunk-Grenzen herum
          // in mehreren ontext()-Aufrufen liefern (z.B. "&Uuml;mlaut" als
          // "Ü" + "mlaut"). Direkt benachbarte Textknoten werden zu einem
          // einzigen Knoten zusammengefuehrt, damit zusammenhaengender Text
          // nicht in mehrere TextRuns zerfaellt.
          const siblings = stack[stack.length - 1].children;
          const last = siblings[siblings.length - 1];
          if (last && last.type === 'text') {
            last.data += text;
          } else {
            siblings.push({ type: 'text', data: text });
          }
        },
        onclosetag() {
          // Robust gegen ueberzaehlige/fehlende Schliesstags: nie unter den
          // Root-Frame poppen.
          if (stack.length > 1) stack.pop();
        },
      },
      {
        decodeEntities: true,
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
      },
    );
    parser.write(source);
    parser.end();
  } catch {
    // Im Fehlerfall wird der bis dahin aufgebaute (ggf. unvollstaendige)
    // Teilbaum zurueckgegeben statt eine Exception nach aussen zu werfen.
  }
  return dom;
}

module.exports = { parseHtml };
