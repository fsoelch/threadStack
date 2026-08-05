'use strict';

const crypto = require('crypto');
const { NODE_TYPES, edgeKindFor, compatibilityList, EDGE_KINDS } = require('./schema');

// Harte Obergrenze für die Anzahl der im Graphen zurückgegebenen Knoten.
// Darüber wird deterministisch abgeschnitten (Priorität: themes, dann
// knowledge, dann übrige nach created_at) und stats.truncated = true gesetzt.
const GRAPH_MAX_NODES = 5000;

const MAX_DESCRIPTION_CHARS = 500;
const MAX_POSITION_BATCH = 500;
const MAX_COORDINATE = 100000;

function newId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function nodeKey(type, id) {
  return `${type}:${id}`;
}

/**
 * Registriert die Graph-API-Endpunkte auf `app`, gegen den vom Backend-Fundament
 * bereitgestellten `ctx`-Vertrag (siehe Paket-1b-Spezifikation).
 * @param {import('express').Express} app
 * @param {object} ctx
 */
module.exports = function graphRoutes(app, ctx) {
  const { db, requireAuth, uid, ownsRef, themeDescendantIds, fail, htmlToText, apiBase = '/api' } = ctx;

  // ── GET /api/graph — der einzige Ladevorgang für den gesamten Graphen ──
  app.get(`${apiBase}/graph`, requireAuth, (req, res) => {
    const userId = uid(req);

    const result = db.transaction(() => {
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
            meta: { meetingId: row.meeting_id, meetingTitle: row.meeting_title },
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

      const themeLinkRows = [...todoLinkRows, ...topicLinkRows, ...contactLinkRows];
      const refTypeOf = (row) => (todoLinkRows.includes(row) ? 'todo' : topicLinkRows.includes(row) ? 'topic' : 'contact');
      for (const row of themeLinkRows) {
        const refType = refTypeOf(row);
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

      // ── Truncation (deterministisch: themes, dann knowledge, dann übrige nach created_at) ──
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

      // ── Positionen laden ──
      const positionRows = db.prepare(
        'SELECT node_type, node_id, x, y FROM graph_node_positions WHERE user_id=?'
      ).all(userId);
      const positionByKey = new Map(positionRows.map(p => [nodeKey(p.node_type, p.node_id), p]));

      // ── Positions-Sweep: verwaiste Positionsdaten (Story B8) in derselben Transaktion löschen ──
      const orphanRows = positionRows.filter(p => !livingKeys.has(nodeKey(p.node_type, p.node_id)));
      if (orphanRows.length) {
        const del = db.prepare('DELETE FROM graph_node_positions WHERE user_id=? AND node_type=? AND node_id=?');
        for (const o of orphanRows) del.run(userId, o.node_type, o.node_id);
      }

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

    res.json(result);
  });

  // ── POST /api/graph/edges — Kante anlegen (Story B6) ──
  app.post(`${apiBase}/graph/edges`, requireAuth, (req, res) => {
    const userId = uid(req);
    const { source, target } = req.body || {};

    if (
      !source || !target ||
      typeof source.id !== 'string' || !source.id ||
      typeof target.id !== 'string' || !target.id ||
      !NODE_TYPES.includes(source.type) || !NODE_TYPES.includes(target.type)
    ) {
      return fail(res, 400, 'INVALID_NODE_TYPE', 'Ungültiger Knotentyp oder ungültige ID');
    }

    const kind = edgeKindFor(source.type, target.type);
    if (!kind) {
      return fail(res, 409, 'INCOMPATIBLE_LINK', 'Diese Verknüpfung ist nicht möglich');
    }

    if (!ownsRef(userId, source.type, source.id) || !ownsRef(userId, target.type, target.id)) {
      return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
    }

    const now = new Date().toISOString();

    if (kind === 'hierarchy') {
      let outcome;
      db.transaction(() => {
        if (source.id === target.id) {
          outcome = { error: ['SELF_PARENT', 'Ein Topic kann nicht sein eigenes Elternteil sein'] };
          return;
        }
        const descendants = themeDescendantIds(source.id, userId) || [];
        if (descendants.includes(target.id)) {
          outcome = { error: ['CYCLE', 'Zyklus: Ziel ist ein Unter-Topic dieses Topics'] };
          return;
        }
        const current = db.prepare('SELECT parent_id FROM themes WHERE id=? AND user_id=?').get(source.id, userId);
        const created = !current || current.parent_id !== target.id;
        db.prepare('UPDATE themes SET parent_id=? WHERE id=? AND user_id=?').run(target.id, source.id, userId);
        outcome = {
          created,
          edge: {
            id: `h:${source.id}`,
            kind: 'hierarchy',
            source: { type: 'theme', id: target.id },
            target: { type: 'theme', id: source.id },
          },
        };
      })();
      if (outcome.error) {
        const [code, msg] = outcome.error;
        return fail(res, 409, code, msg);
      }
      return res.status(outcome.created ? 201 : 200).json({ created: outcome.created, edge: outcome.edge });
    }

    if (kind === 'knowledge_topic') {
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
      return res.status(created ? 201 : 200).json({ created, edge });
    }

    if (kind === 'knowledge_knowledge') {
      const [aId, bId] = [source.id, target.id].sort();
      let row = db.prepare('SELECT id FROM knowledge_links WHERE page_a_id=? AND page_b_id=?').get(aId, bId);
      let created = false;
      if (!row) {
        const id = newId();
        db.prepare('INSERT INTO knowledge_links(id,page_a_id,page_b_id,created_at) VALUES (?,?,?,?)').run(id, aId, bId, now);
        row = { id };
        created = true;
      }
      const edge = {
        id: `kk:${row.id}`,
        kind: 'knowledge_knowledge',
        source: { type: 'knowledge', id: aId },
        target: { type: 'knowledge', id: bId },
      };
      return res.status(created ? 201 : 200).json({ created, edge });
    }

    if (kind === 'theme_link') {
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
      return res.status(created ? 201 : 200).json({ created, edge });
    }

    // Sollte durch edgeKindFor bereits ausgeschlossen sein.
    return fail(res, 409, 'INCOMPATIBLE_LINK', 'Diese Verknüpfung ist nicht möglich');
  });

  // ── DELETE /api/graph/edges/:edgeId — Kante entfernen (Story B7) ──
  app.delete(`${apiBase}/graph/edges/:edgeId`, requireAuth, (req, res) => {
    const userId = uid(req);
    const edgeId = String(req.params.edgeId || '');
    const sep = edgeId.indexOf(':');
    if (sep === -1) return fail(res, 400, 'VALIDATION_FAILED', 'Ungültige Kanten-ID');
    const prefix = edgeId.slice(0, sep + 1);
    const rest = edgeId.slice(sep + 1);
    if (!rest) return fail(res, 400, 'VALIDATION_FAILED', 'Ungültige Kanten-ID');

    if (prefix === 'h:') {
      const themeId = rest;
      db.prepare('UPDATE themes SET parent_id=NULL WHERE id=? AND user_id=?').run(themeId, userId);
      return res.json({ ok: true, warning: null });
    }

    if (prefix === 'kt:') {
      const linkId = rest;
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
      return res.json({ ok: true, warning });
    }

    if (prefix === 'kk:') {
      const linkId = rest;
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
      return res.json({ ok: true, warning: null });
    }

    if (prefix === 'tl:') {
      const linkId = rest;
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
      return res.json({ ok: true, warning: null });
    }

    return fail(res, 400, 'VALIDATION_FAILED', 'Unbekanntes Kantenpräfix');
  });

  // ── PATCH /api/graph/positions — Positionen speichern (Story B8) ──
  app.patch(`${apiBase}/graph/positions`, requireAuth, (req, res) => {
    const userId = uid(req);
    const positions = req.body && req.body.positions;

    if (!Array.isArray(positions) || positions.length === 0) {
      return fail(res, 400, 'VALIDATION_FAILED', 'positions erforderlich (1..500 Einträge)');
    }
    if (positions.length > MAX_POSITION_BATCH) {
      return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Zu viele Positionen in einer Anfrage');
    }

    // Strukturelle Validierung + Koordinaten-Validierung: verletzt EIN Eintrag
    // die Vorgaben, wird die GESAMTE Anfrage abgelehnt.
    for (const p of positions) {
      if (!p || typeof p !== 'object' || !NODE_TYPES.includes(p.type) || typeof p.id !== 'string' || !p.id) {
        return fail(res, 400, 'VALIDATION_FAILED', 'Ungültiger Positions-Eintrag');
      }
      const { x, y } = p;
      if (
        !Number.isFinite(x) || !Number.isFinite(y) ||
        Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE
      ) {
        return fail(res, 400, 'INVALID_COORDINATE', 'Ungültige Koordinate');
      }
    }

    const now = new Date().toISOString();
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

    res.json({ ok: true, saved, ignored });
  });
};

module.exports.GRAPH_MAX_NODES = GRAPH_MAX_NODES;
