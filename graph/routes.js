'use strict';

const { NODE_TYPES, edgeKindFor } = require('./schema');
const queries = require('./queries');

const MAX_POSITION_BATCH = 500;
const MAX_COORDINATE = 100000;

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
    res.json(queries.loadGraph(db, userId, { htmlToText }));
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
      const outcome = queries.createHierarchyEdge(db, { source, target, userId, themeDescendantIds });
      if (outcome.error) {
        const [code, msg] = outcome.error;
        return fail(res, 409, code, msg);
      }
      return res.status(outcome.created ? 201 : 200).json({ created: outcome.created, edge: outcome.edge });
    }

    if (kind === 'knowledge_topic') {
      const { created, edge } = queries.findOrCreateKnowledgeTopicEdge(db, { source, target, now });
      return res.status(created ? 201 : 200).json({ created, edge });
    }

    if (kind === 'knowledge_knowledge') {
      const { created, edge } = queries.findOrCreateKnowledgeKnowledgeEdge(db, { source, target, userId, now });
      return res.status(created ? 201 : 200).json({ created, edge });
    }

    if (kind === 'theme_link') {
      const { created, edge } = queries.findOrCreateThemeLinkEdge(db, { source, target, now });
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
      return res.json(queries.deleteHierarchyEdge(db, { themeId: rest, userId }));
    }
    if (prefix === 'kt:') {
      return res.json(queries.deleteKnowledgeTopicEdge(db, { linkId: rest, userId }));
    }
    if (prefix === 'kk:') {
      return res.json(queries.deleteKnowledgeKnowledgeEdge(db, { linkId: rest, userId }));
    }
    if (prefix === 'tl:') {
      return res.json(queries.deleteThemeLinkEdge(db, { linkId: rest, userId }));
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
    const { saved, ignored } = queries.savePositions(db, { userId, positions, ownsRef, now });
    res.json({ ok: true, saved, ignored });
  });
};

module.exports.GRAPH_MAX_NODES = queries.GRAPH_MAX_NODES;
