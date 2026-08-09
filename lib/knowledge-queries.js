'use strict';
// Sammelabfragen für Knowledge-Page-Zuordnungen (Theme-Zuordnung, verwandte
// Seiten). Aus server.js extrahiert, damit sowohl die REST-Routen als auch
// das Export-Modul dieselbe Query-Logik nutzen, statt sie zu duplizieren.

// Sammelabfrage: alle knowledge_topic_links, die mindestens eine der
// übergebenen Seiten betreffen — vermeidet N+1-Queries.
function knowledgeThemeIds(db, pageIds) {
  if (!pageIds.length) return new Map();
  const rows = db.prepare(
    `SELECT * FROM knowledge_topic_links WHERE knowledge_page_id IN (${pageIds.map(()=>'?').join(',')})`
  ).all(...pageIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.knowledge_page_id)) map.set(r.knowledge_page_id, []);
    map.get(r.knowledge_page_id).push(r.theme_id);
  }
  return map;
}

// Sammelabfrage: alle knowledge_links, die mindestens eine der übergebenen
// Seiten betreffen — vermeidet N+1-Queries beim Listing (GET /api/knowledge).
function knowledgeRelatedIds(db, pageIds) {
  if (!pageIds.length) return new Map();
  const placeholders = pageIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT page_a_id, page_b_id FROM knowledge_links WHERE page_a_id IN (${placeholders}) OR page_b_id IN (${placeholders})`
  ).all(...pageIds, ...pageIds);
  const idSet = new Set(pageIds);
  const map = new Map();
  for (const r of rows) {
    if (idSet.has(r.page_a_id)) {
      if (!map.has(r.page_a_id)) map.set(r.page_a_id, []);
      map.get(r.page_a_id).push(r.page_b_id);
    }
    if (idSet.has(r.page_b_id)) {
      if (!map.has(r.page_b_id)) map.set(r.page_b_id, []);
      map.get(r.page_b_id).push(r.page_a_id);
    }
  }
  return map;
}

module.exports = { knowledgeThemeIds, knowledgeRelatedIds };
