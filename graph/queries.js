'use strict';

const crypto = require('crypto');
const { NODE_TYPES, EDGE_KINDS, compatibilityList } = require('./schema');
// Archiv-Kernmodul (Paket B1): Batch-Lookup für den Archiv-Status von
// Meetings, um Topic-Knoten archivierter Meetings zu kennzeichnen (Paket B3).
// Anders als im KI-Modul werden Topic-Knoten HIER NICHT gefiltert - das ist
// eine bewusste Architekturentscheidung (Wissensmanagement-Zweck des Graphen).
const archive = require('../lib/archive');

// Harte Obergrenze für die Anzahl der im Graphen zurückgegebenen Knoten.
// Darüber wird deterministisch abgeschnitten (Priorität: themes, dann
// knowledge, dann übrige nach created_at) und stats.truncated = true gesetzt.
const GRAPH_MAX_NODES = 5000;

const MAX_DESCRIPTION_CHARS = 500;

function newId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function nodeKey(type, id) {
  return `${type}:${id}`;
}

// Liest alle für den Graphen relevanten Roh-Zeilen des Nutzers (Themes,
// Wissensseiten, verlinkte Todos/Topics/Contacts, Knowledge<->Theme- und
// Knowledge<->Knowledge-Verweise). Eigentümerschaft wird für jede Zeile per
// Join erzwungen (kein Vertrauen in theme_links/knowledge_*_links allein).
function fetchGraphRows(db, userId) {
  // 1) Alle Themes (Topics) des Nutzers.
  const themes = db.prepare(
    'SELECT id, title, description, parent_id, created_at FROM themes WHERE user_id=? ORDER BY created_at'
  ).all(userId);

  // 2) Alle Wissensseiten des Nutzers.
  const knowledgePages = db.prepare(
    'SELECT id, title, updated_at, created_at FROM knowledge_pages WHERE user_id=? ORDER BY created_at'
  ).all(userId);

  // 3) todo/topic/contact NUR, wenn ein theme_links-Eintrag zu einem
  //    EIGENEN Theme existiert. Eigentümerschaft von Objekt UND Theme wird
  //    per Join erzwungen (kein Vertrauen in theme_links allein).
  const todoLinkRows = db.prepare(`
    SELECT td.id, td.title, td.done, td.due_date, td.created_at,
           tl.id AS link_id, tl.theme_id AS link_theme_id
    FROM todos td
    JOIN theme_links tl ON tl.ref_type='todo' AND tl.ref_id=td.id
    JOIN themes th ON th.id=tl.theme_id
    WHERE td.user_id=? AND th.user_id=?
  `).all(userId, userId);

  const topicLinkRows = db.prepare(`
    SELECT tp.id, tp.title, tp.done, tp.created_at, m.id AS meeting_id, m.title AS meeting_title,
           tl.id AS link_id, tl.theme_id AS link_theme_id
    FROM topics tp
    JOIN meetings m ON m.id=tp.meeting_id
    JOIN theme_links tl ON tl.ref_type='topic' AND tl.ref_id=tp.id
    JOIN themes th ON th.id=tl.theme_id
    WHERE m.user_id=? AND th.user_id=?
  `).all(userId, userId);

  // Archiv-Kennzeichnung für Topic-Knoten (Paket B3, "Meetings archivieren
  // statt löschen"): Batch-Lookup über die Menge der beteiligten
  // Meeting-IDs statt N+1-Einzelabfragen pro Topic - `topicLinkRows`
  // kennt bereits jede `meeting_id`, also genügt eine zusätzliche Query
  // unabhängig von der Anzahl der Topics.
  const topicMeetingIds = new Set(topicLinkRows.map(row => row.meeting_id));
  const meetingArchivedFlags = topicMeetingIds.size
    ? archive.archivedFlags(db, [...topicMeetingIds].map(id => ({ refType: 'meeting', refId: id })))
    : new Map();

  const contactLinkRows = db.prepare(`
    SELECT c.id, c.name AS title, c.role, c.created_at,
           tl.id AS link_id, tl.theme_id AS link_theme_id
    FROM contacts c
    JOIN theme_links tl ON tl.ref_type='contact' AND tl.ref_id=c.id
    JOIN themes th ON th.id=tl.theme_id
    WHERE c.user_id=? AND th.user_id=?
  `).all(userId, userId);

  // 4) knowledge<->theme-Zuordnungen (nur eigene Wissensseiten + eigene Themes).
  const knowledgeTopicRows = db.prepare(`
    SELECT kl.id, kl.knowledge_page_id, kl.theme_id
    FROM knowledge_topic_links kl
    JOIN knowledge_pages kp ON kp.id=kl.knowledge_page_id
    JOIN themes th ON th.id=kl.theme_id
    WHERE kp.user_id=? AND th.user_id=?
  `).all(userId, userId);

  // 5) knowledge<->knowledge-Verweise (beide Seiten müssen dem Nutzer gehören).
  //    Annahme zum Tabellenschema (nicht Teil des ctx-Vertrags, siehe Abschlussbericht):
  //    knowledge_links(id, page_a_id, page_b_id, created_at), page_a_id < page_b_id.
  const knowledgeKnowledgeRows = db.prepare(`
    SELECT kl.id, kl.page_a_id, kl.page_b_id
    FROM knowledge_links kl
    JOIN knowledge_pages a ON a.id=kl.page_a_id
    JOIN knowledge_pages b ON b.id=kl.page_b_id
    WHERE a.user_id=? AND b.user_id=?
  `).all(userId, userId);

  return {
    themes, knowledgePages, todoLinkRows, topicLinkRows, contactLinkRows,
    knowledgeTopicRows, knowledgeKnowledgeRows, meetingArchivedFlags,
  };
}

// Baut Knoten- und Kanten-Listen (pure, keine DB-Zugriffe) aus den von
// fetchGraphRows() gelieferten Roh-Zeilen. Gibt zusätzlich `livingKeys`
// zurück (Menge aller "lebenden" Knoten VOR Truncation) - wird vom
// Positions-Sweep benötigt, da Truncation nur eine Anzeige-Begrenzung ist,
// kein Löschen von Objekten.
function buildNodesAndEdges(rows, { htmlToText }) {
  const {
    themes, knowledgePages, todoLinkRows, topicLinkRows, contactLinkRows,
    knowledgeTopicRows, knowledgeKnowledgeRows, meetingArchivedFlags,
  } = rows;

  // ── Knoten bauen ──
  const nodesByKey = new Map();
  const linkCount = new Map(); // themeId -> Anzahl nicht-hierarchischer Kanten

  for (const t of themes) {
    nodesByKey.set(nodeKey('theme', t.id), {
      type: 'theme',
      id: t.id,
      title: t.title,
      done: null,
      _createdAt: t.created_at,
      meta: {
        parentId: t.parent_id || null,
        childCount: 0, // wird unten befüllt
        linkCount: 0,  // wird unten befüllt
        descriptionText: htmlToText(t.description || '').slice(0, MAX_DESCRIPTION_CHARS),
      },
    });
  }
  // childCount berechnen
  for (const t of themes) {
    if (t.parent_id && nodesByKey.has(nodeKey('theme', t.parent_id))) {
      nodesByKey.get(nodeKey('theme', t.parent_id)).meta.childCount += 1;
    }
  }

  for (const k of knowledgePages) {
    nodesByKey.set(nodeKey('knowledge', k.id), {
      type: 'knowledge',
      id: k.id,
      title: k.title,
      done: null,
      _createdAt: k.created_at,
      meta: { updatedAt: k.updated_at },
    });
  }

  for (const row of todoLinkRows) {
    if (!nodesByKey.has(nodeKey('todo', row.id))) {
      nodesByKey.set(nodeKey('todo', row.id), {
        type: 'todo',
        id: row.id,
        title: row.title,
        done: !!row.done,
        _createdAt: row.created_at,
        meta: { dueDate: row.due_date || null },
      });
    }
  }

  for (const row of topicLinkRows) {
    if (!nodesByKey.has(nodeKey('topic', row.id))) {
      nodesByKey.set(nodeKey('topic', row.id), {
        type: 'topic',
        id: row.id,
        title: row.title,
        done: !!row.done,
        _createdAt: row.created_at,
        meta: {
          meetingId: row.meeting_id,
          meetingTitle: row.meeting_title,
          archived: meetingArchivedFlags.get(`meeting:${row.meeting_id}`) === true,
        },
      });
    }
  }

  for (const row of contactLinkRows) {
    if (!nodesByKey.has(nodeKey('contact', row.id))) {
      nodesByKey.set(nodeKey('contact', row.id), {
        type: 'contact',
        id: row.id,
        title: row.title,
        done: null,
        _createdAt: row.created_at,
        meta: { role: row.role || '' },
      });
    }
  }

  // ── Kanten bauen ──
  const edges = [];

  // hierarchy: aus themes.parent_id abgeleitet, keine eigene Zeile.
  for (const t of themes) {
    if (t.parent_id && nodesByKey.has(nodeKey('theme', t.parent_id))) {
      edges.push({
        id: `h:${t.id}`,
        kind: 'hierarchy',
        source: { type: 'theme', id: t.parent_id },
        target: { type: 'theme', id: t.id },
      });
    }
  }

  for (const row of knowledgeTopicRows) {
    edges.push({
      id: `kt:${row.id}`,
      kind: 'knowledge_topic',
      source: { type: 'knowledge', id: row.knowledge_page_id },
      target: { type: 'theme', id: row.theme_id },
    });
    linkCount.set(row.theme_id, (linkCount.get(row.theme_id) || 0) + 1);
  }

  for (const row of knowledgeKnowledgeRows) {
    edges.push({
      id: `kk:${row.id}`,
      kind: 'knowledge_knowledge',
      source: { type: 'knowledge', id: row.page_a_id },
      target: { type: 'knowledge', id: row.page_b_id },
    });
  }

  // Jede Zeile trägt ihren refType (Story: Lesbarkeit/Wartbarkeit) statt ihn
  // per .includes()-Scan über die zusammengeführte Liste zurückzusuchen -
  // vermeidet eine O(n·m)-Suche über die Vereinigung aller theme_links-Zeilen.
  const themeLinkRows = [
    ...todoLinkRows.map(row => ({ row, refType: 'todo' })),
    ...topicLinkRows.map(row => ({ row, refType: 'topic' })),
    ...contactLinkRows.map(row => ({ row, refType: 'contact' })),
  ];
  for (const { row, refType } of themeLinkRows) {
    edges.push({
      id: `tl:${row.link_id}`,
      kind: 'theme_link',
      source: { type: 'theme', id: row.link_theme_id },
      target: { type: refType, id: row.id },
    });
    linkCount.set(row.link_theme_id, (linkCount.get(row.link_theme_id) || 0) + 1);
  }

  for (const [themeId, count] of linkCount.entries()) {
    const node = nodesByKey.get(nodeKey('theme', themeId));
    if (node) node.meta.linkCount = count;
  }

  // Menge aller "lebenden" Knoten des Nutzers (VOR Truncation) für den
  // Positions-Sweep — Truncation ist nur eine Anzeige-Begrenzung, kein
  // Löschen von Objekten.
  const livingKeys = new Set(nodesByKey.keys());

  return { nodesByKey, edges, livingKeys };
}

// Deterministische Anzeige-Begrenzung (Priorität: themes, dann knowledge,
// dann übrige nach created_at) - pure, keine DB-Zugriffe.
function truncateGraph(nodesByKey, edges) {
  const allNodes = Array.from(nodesByKey.values());
  const themeNodes = allNodes.filter(n => n.type === 'theme');
  const knowledgeNodes = allNodes.filter(n => n.type === 'knowledge');
  const otherNodes = allNodes
    .filter(n => n.type !== 'theme' && n.type !== 'knowledge')
    .sort((a, b) => String(a._createdAt).localeCompare(String(b._createdAt)));

  const ordered = [...themeNodes, ...knowledgeNodes, ...otherNodes];
  const truncated = ordered.length > GRAPH_MAX_NODES;
  const kept = truncated ? ordered.slice(0, GRAPH_MAX_NODES) : ordered;
  const keptKeys = new Set(kept.map(n => nodeKey(n.type, n.id)));

  const keptEdges = truncated
    ? edges.filter(e => keptKeys.has(nodeKey(e.source.type, e.source.id)) && keptKeys.has(nodeKey(e.target.type, e.target.id)))
    : edges;

  return { kept, keptEdges, truncated };
}

// Lädt gespeicherte Knoten-Positionen und räumt in derselben Transaktion
// verwaiste Positionsdaten auf (Story B8: Positionsdaten von Knoten, die
// nicht mehr zu `livingKeys` gehören).
function loadAndSyncPositions(db, userId, livingKeys) {
  const positionRows = db.prepare(
    'SELECT node_type, node_id, x, y FROM graph_node_positions WHERE user_id=?'
  ).all(userId);
  const positionByKey = new Map(positionRows.map(p => [nodeKey(p.node_type, p.node_id), p]));

  const orphanRows = positionRows.filter(p => !livingKeys.has(nodeKey(p.node_type, p.node_id)));
  if (orphanRows.length) {
    const del = db.prepare('DELETE FROM graph_node_positions WHERE user_id=? AND node_type=? AND node_id=?');
    for (const o of orphanRows) del.run(userId, o.node_type, o.node_id);
  }

  return positionByKey;
}

// Orchestriert den gesamten Ladevorgang für GET /api/graph in einer
// Transaktion: Rohdaten laden -> Knoten/Kanten bauen -> Truncation ->
// Positionen laden+Sweep -> finale Antwortform.
function loadGraph(db, userId, { htmlToText }) {
  return db.transaction(() => {
    const rows = fetchGraphRows(db, userId);
    const { nodesByKey, edges, livingKeys } = buildNodesAndEdges(rows, { htmlToText });
    const { kept, keptEdges, truncated } = truncateGraph(nodesByKey, edges);
    const positionByKey = loadAndSyncPositions(db, userId, livingKeys);

    const finalNodes = kept.map(n => {
      const pos = positionByKey.get(nodeKey(n.type, n.id));
      const { _createdAt, ...rest } = n;
      return {
        ...rest,
        x: pos ? pos.x : null,
        y: pos ? pos.y : null,
        hasStoredPosition: !!pos,
      };
    });

    return {
      nodes: finalNodes,
      edges: keptEdges,
      schema: {
        nodeTypes: NODE_TYPES,
        edgeKinds: EDGE_KINDS,
        compatibility: compatibilityList(),
      },
      stats: {
        nodeCount: finalNodes.length,
        edgeCount: keptEdges.length,
        truncated,
      },
    };
  })();
}

// ── Kanten anlegen (Story B6) ─────────────────────────────────

function createHierarchyEdge(db, { source, target, userId, themeDescendantIds }) {
  return db.transaction(() => {
    if (source.id === target.id) {
      return { error: ['SELF_PARENT', 'Ein Topic kann nicht sein eigenes Elternteil sein'] };
    }
    const descendants = themeDescendantIds(source.id, userId) || [];
    if (descendants.includes(target.id)) {
      return { error: ['CYCLE', 'Zyklus: Ziel ist ein Unter-Topic dieses Topics'] };
    }
    const current = db.prepare('SELECT parent_id FROM themes WHERE id=? AND user_id=?').get(source.id, userId);
    const created = !current || current.parent_id !== target.id;
    db.prepare('UPDATE themes SET parent_id=? WHERE id=? AND user_id=?').run(target.id, source.id, userId);
    return {
      created,
      edge: {
        id: `h:${source.id}`,
        kind: 'hierarchy',
        source: { type: 'theme', id: target.id },
        target: { type: 'theme', id: source.id },
      },
    };
  })();
}

function findOrCreateKnowledgeTopicEdge(db, { source, target, now }) {
  const knowledgeSide = source.type === 'knowledge' ? source : target;
  const themeSide = source.type === 'theme' ? source : target;
  let row = db.prepare(
    'SELECT id FROM knowledge_topic_links WHERE knowledge_page_id=? AND theme_id=?'
  ).get(knowledgeSide.id, themeSide.id);
  let created = false;
  if (!row) {
    const id = newId();
    db.prepare(
      'INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)'
    ).run(id, knowledgeSide.id, themeSide.id, now);
    row = { id };
    created = true;
  }
  const edge = {
    id: `kt:${row.id}`,
    kind: 'knowledge_topic',
    source: { type: 'knowledge', id: knowledgeSide.id },
    target: { type: 'theme', id: themeSide.id },
  };
  return { created, edge };
}

function findOrCreateKnowledgeKnowledgeEdge(db, { source, target, userId, now }) {
  const [aId, bId] = [source.id, target.id].sort();
  let row = db.prepare('SELECT id FROM knowledge_links WHERE page_a_id=? AND page_b_id=?').get(aId, bId);
  let created = false;
  if (!row) {
    const id = newId();
    db.prepare('INSERT INTO knowledge_links(id,user_id,page_a_id,page_b_id,created_at) VALUES (?,?,?,?,?)').run(id, userId, aId, bId, now);
    row = { id };
    created = true;
  }
  const edge = {
    id: `kk:${row.id}`,
    kind: 'knowledge_knowledge',
    source: { type: 'knowledge', id: aId },
    target: { type: 'knowledge', id: bId },
  };
  return { created, edge };
}

function findOrCreateThemeLinkEdge(db, { source, target, now }) {
  const themeSide = source.type === 'theme' ? source : target;
  const refSide = source.type === 'theme' ? target : source;
  let row = db.prepare(
    'SELECT id FROM theme_links WHERE theme_id=? AND ref_type=? AND ref_id=?'
  ).get(themeSide.id, refSide.type, refSide.id);
  let created = false;
  if (!row) {
    const id = newId();
    db.prepare(
      'INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)'
    ).run(id, themeSide.id, refSide.type, refSide.id, now);
    row = { id };
    created = true;
  }
  const edge = {
    id: `tl:${row.id}`,
    kind: 'theme_link',
    source: { type: 'theme', id: themeSide.id },
    target: { type: refSide.type, id: refSide.id },
  };
  return { created, edge };
}

// ── Kanten entfernen (Story B7) ───────────────────────────────

function deleteHierarchyEdge(db, { themeId, userId }) {
  db.prepare('UPDATE themes SET parent_id=NULL WHERE id=? AND user_id=?').run(themeId, userId);
  return { ok: true, warning: null };
}

function deleteKnowledgeTopicEdge(db, { linkId, userId }) {
  let warning = null;
  db.transaction(() => {
    const row = db.prepare(`
      SELECT kl.id, kl.knowledge_page_id
      FROM knowledge_topic_links kl
      JOIN knowledge_pages kp ON kp.id = kl.knowledge_page_id AND kp.user_id = ?
      JOIN themes th ON th.id = kl.theme_id AND th.user_id = ?
      WHERE kl.id = ?
    `).get(userId, userId, linkId);
    if (!row) return;
    db.prepare('DELETE FROM knowledge_topic_links WHERE id=?').run(row.id);
    const remaining = db.prepare(
      'SELECT COUNT(*) AS c FROM knowledge_topic_links WHERE knowledge_page_id=?'
    ).get(row.knowledge_page_id).c;
    if (remaining === 0) warning = 'KNOWLEDGE_PAGE_NOW_UNASSIGNED';
  })();
  return { ok: true, warning };
}

function deleteKnowledgeKnowledgeEdge(db, { linkId, userId }) {
  db.transaction(() => {
    const row = db.prepare(`
      SELECT kl.id
      FROM knowledge_links kl
      JOIN knowledge_pages a ON a.id = kl.page_a_id AND a.user_id = ?
      JOIN knowledge_pages b ON b.id = kl.page_b_id AND b.user_id = ?
      WHERE kl.id = ?
    `).get(userId, userId, linkId);
    if (!row) return;
    db.prepare('DELETE FROM knowledge_links WHERE id=?').run(row.id);
  })();
  return { ok: true, warning: null };
}

function deleteThemeLinkEdge(db, { linkId, userId }) {
  db.transaction(() => {
    const row = db.prepare(`
      SELECT tl.id
      FROM theme_links tl
      JOIN themes th ON th.id = tl.theme_id AND th.user_id = ?
      WHERE tl.id = ?
    `).get(userId, linkId);
    if (!row) return;
    db.prepare('DELETE FROM theme_links WHERE id=?').run(row.id);
  })();
  return { ok: true, warning: null };
}

// ── Positionen speichern (Story B8) ───────────────────────────

function savePositions(db, { userId, positions, ownsRef, now }) {
  const upsert = db.prepare(`
    INSERT INTO graph_node_positions (user_id, node_type, node_id, x, y, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, node_type, node_id) DO UPDATE SET x=excluded.x, y=excluded.y, updated_at=excluded.updated_at
  `);

  const ignored = [];
  let saved = 0;
  db.transaction(() => {
    for (const p of positions) {
      if (!ownsRef(userId, p.type, p.id)) {
        ignored.push({ type: p.type, id: p.id, reason: 'unknown' });
        continue;
      }
      upsert.run(userId, p.type, p.id, p.x, p.y, now);
      saved++;
    }
  })();

  return { saved, ignored };
}

module.exports = {
  GRAPH_MAX_NODES,
  nodeKey,
  loadGraph,
  createHierarchyEdge,
  findOrCreateKnowledgeTopicEdge,
  findOrCreateKnowledgeKnowledgeEdge,
  findOrCreateThemeLinkEdge,
  deleteHierarchyEdge,
  deleteKnowledgeTopicEdge,
  deleteKnowledgeKnowledgeEdge,
  deleteThemeLinkEdge,
  savePositions,
};
