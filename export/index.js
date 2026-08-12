'use strict';
const { buildExportXml } = require('./xml');
const { buildExportDocx } = require('./docx');
const { knowledgeThemeIds, knowledgeRelatedIds } = require('../lib/knowledge-queries');

const VALID_SCOPES = new Set(['knowledge', 'todos', 'both']);
const VALID_FORMATS = new Set(['docx', 'xml']);

function groupBy(rows, keyField) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[keyField])) map.set(r[keyField], []);
    map.get(r[keyField]).push(r);
  }
  return map;
}

function collectExportData(db, userId, { scope, includeGraph, openOnly }) {
  const result = {};

  if (scope === 'knowledge' || scope === 'both') {
    result.themes = includeGraph
      ? db.prepare('SELECT id, parent_id, title, description, sort_order FROM themes WHERE user_id=? ORDER BY sort_order, created_at').all(userId)
      : [];
    const pages = db.prepare('SELECT * FROM knowledge_pages WHERE user_id=? ORDER BY title COLLATE NOCASE').all(userId);
    const pageIds = pages.map(p => p.id);
    const themeIdsByPage = includeGraph ? knowledgeThemeIds(db, pageIds) : new Map();
    const relatedByPage  = includeGraph ? knowledgeRelatedIds(db, pageIds) : new Map();
    result.knowledgePages = pages.map(p => ({
      ...p,
      themeIds: themeIdsByPage.get(p.id) || [],
      relatedIds: relatedByPage.get(p.id) || [],
    }));
  }

  if (scope === 'todos' || scope === 'both') {
    const rows = db.prepare(`SELECT * FROM todos WHERE user_id=? ${openOnly ? 'AND done=0' : ''} ORDER BY sort_order, created_at`).all(userId);
    const todoIds = rows.map(t => t.id);
    const themeRefsByTodo = todoIds.length
      ? groupBy(db.prepare(
          `SELECT tl.ref_id as todo_id, tl.theme_id, th.title as theme_title
           FROM theme_links tl JOIN themes th ON th.id = tl.theme_id
           WHERE tl.ref_type='todo' AND tl.ref_id IN (${todoIds.map(() => '?').join(',')})`
        ).all(...todoIds), 'todo_id')
      : new Map();
    result.todos = rows.map(t => ({ ...t, themeRefs: themeRefsByTodo.get(t.id) || [] }));
  }

  return result;
}

// Security-Review-Fund: der Export ist durch die Formatierungstreue (Bild-
// Dekodierung, Tabellen-Matrix, docx-Packer) deutlich rechen-/speicher-
// intensiver geworden. Ohne Begrenzung koennten wenige parallele/serielle
// Aufrufe eines einzelnen angemeldeten Nutzers den Single-Process-Server
// fuer alle Nutzer auslasten. Rein In-Memory, analog zum bestehenden
// Link-Fetch-Rate-Limit in server.js.
const exportInProgress = new Set();
const EXPORT_WINDOW_MS = 60 * 1000;
const EXPORT_MAX_PER_WINDOW = 5;
const exportTimestamps = new Map(); // uid -> number[]
function checkExportRate(uid) {
  const now = Date.now();
  const arr = (exportTimestamps.get(uid) || []).filter(t => now - t < EXPORT_WINDOW_MS);
  if (arr.length >= EXPORT_MAX_PER_WINDOW) { exportTimestamps.set(uid, arr); return false; }
  arr.push(now);
  exportTimestamps.set(uid, arr);
  return true;
}

module.exports = function exportRoutes(app, ctx) {
  const { db, requireAuth, fail, apiBase } = ctx;

  app.get(`${apiBase}/export`, requireAuth, async (req, res) => {
    const userId = req.session.uid;
    const scope  = String(req.query.scope || 'both');
    const format = String(req.query.format || 'docx');
    const includeGraph = req.query.graph !== '0';
    const openOnly     = req.query.openOnly === '1';

    if (!VALID_SCOPES.has(scope))   return fail(res, 400, 'VALIDATION_FAILED', 'Ungültiger Scope');
    if (!VALID_FORMATS.has(format)) return fail(res, 400, 'VALIDATION_FAILED', 'Ungültiges Format');

    if (exportInProgress.has(userId)) {
      return fail(res, 409, 'EXPORT_IN_PROGRESS', 'Ein Export läuft bereits.');
    }
    if (!checkExportRate(userId)) {
      return fail(res, 429, 'RATE_LIMITED', 'Zu viele Exporte. Bitte kurz warten.');
    }
    exportInProgress.add(userId);

    try {
      const data = collectExportData(db, userId, { scope, includeGraph, openOnly });
      const stamp = new Date().toISOString().slice(0, 10);

      if (format === 'xml') {
        const xml = buildExportXml(data, { scope, includeGraph, openOnly });
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`ThreadStack-Export-${stamp}.xml`)}`);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        return res.send(xml);
      }

      const buffer = await buildExportDocx(data, { scope, includeGraph, openOnly });
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`ThreadStack-Export-${stamp}.docx`)}`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      return res.send(buffer);
    } catch (e) {
      // Nur Message + Stacktrace loggen (Code-Pfade), nie das rohe Error-
      // Objekt: bei DB-Fehlern (better-sqlite3) kann dieses Query-Parameter
      // und damit Nutzerinhalte mitfuehren.
      console.error('[export] Fehler:', e && e.message, e && e.stack);
      return fail(res, 500, 'EXPORT_FAILED', 'Export fehlgeschlagen');
    } finally {
      exportInProgress.delete(userId);
    }
  });
};
