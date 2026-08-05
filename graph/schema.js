'use strict';

// ── Graph-Schema: einzige Wahrheitsquelle für Knotentypen, Kantenarten und die
//    Kompatibilitätsmatrix zwischen Knotentypen (Paket 1b: Graph-API). ──
//
// Kanten sind grundsätzlich ungerichtet, mit EINER Ausnahme: 'theme|theme'
// ('hierarchy') ist gerichtet — die Quelle (source) wird beim Anlegen Kind des
// Ziels (target). Das ist ausschließlich in graph/index.js beim Anlegen/Löschen
// relevant; die Kompatibilitätsprüfung selbst ist richtungsunabhängig.

const NODE_TYPES = ['theme', 'knowledge', 'todo', 'topic', 'contact'];
const EDGE_KINDS = ['hierarchy', 'knowledge_topic', 'knowledge_knowledge', 'theme_link'];

const COMPATIBILITY = {
  'theme|theme': 'hierarchy',
  'theme|knowledge': 'knowledge_topic',
  'theme|todo': 'theme_link',
  'theme|topic': 'theme_link',
  'theme|contact': 'theme_link',
  'knowledge|knowledge': 'knowledge_knowledge',
};

/**
 * Bestimmt die Kantenart für ein Paar von Knotentypen, unabhängig von der
 * Reihenfolge (source/target). Gibt null zurück, wenn die Kombination nicht
 * in der Kompatibilitätsmatrix vorhanden ist (= inkompatibel).
 * @param {string} sourceType
 * @param {string} targetType
 * @returns {string|null}
 */
function edgeKindFor(sourceType, targetType) {
  if (!NODE_TYPES.includes(sourceType) || !NODE_TYPES.includes(targetType)) return null;
  const direct = COMPATIBILITY[`${sourceType}|${targetType}`];
  if (direct) return direct;
  const reversed = COMPATIBILITY[`${targetType}|${sourceType}`];
  if (reversed) return reversed;
  return null;
}

/**
 * Löst die Kompatibilitätsmatrix als Array von { source, target, kind } auf,
 * für die Ausgabe im GET /api/graph `schema.compatibility`-Feld.
 * @returns {{source:string,target:string,kind:string}[]}
 */
function compatibilityList() {
  return Object.entries(COMPATIBILITY).map(([key, kind]) => {
    const [source, target] = key.split('|');
    return { source, target, kind };
  });
}

module.exports = {
  NODE_TYPES,
  EDGE_KINDS,
  COMPATIBILITY,
  edgeKindFor,
  compatibilityList,
};
