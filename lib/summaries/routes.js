'use strict';
const express = require('express');
const { KINDS, FEATURE_BY_KIND, PROGRESS_MIN_ENTRIES, DESCRIPTION_MIN_PLAIN_CHARS, MAX_REFS_PER_READ } = require('./constants');
const queries = require('./queries');
const service = require('./service');
const ai = require('../../ai');
const usage = require('../../ai/usage');
const { htmlToText } = require('../sanitize');
const { sendError: fail, makeInternalErrorHandler } = require('../http');

const REF_RE = /^(todo|topic):[A-Za-z0-9_-]{1,200}$/;
const REF_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

// Niemals Stacktraces/SQLite-Fehlertexte/Pfade an den Client, kein Logging
// von Inhalten (Zusammenfassungstext/Beschreibung) - siehe lib/http.js.
const internalError = makeInternalErrorHandler('summaries', {
  code: 'internal', message: 'Interner Fehler',
});

function parseRefsParam(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'invalid_refs' };
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { error: 'invalid_refs' };
  if (parts.length > MAX_REFS_PER_READ) return { error: 'too_many_refs' };
  const items = [];
  for (const p of parts) {
    if (!REF_RE.test(p)) return { error: 'invalid_refs' };
    const idx = p.indexOf(':');
    items.push({ refType: p.slice(0, idx), refId: p.slice(idx + 1) });
  }
  return { items };
}

/**
 * createSummaryRouter({ db, requireAuth, ownsRef, isRefReadOnly, scheduler, aiSettingsLoader, now })
 * → express.Router(), zu mounten unter dem API-Präfix (z. B. app.use(A, router)).
 */
function createSummaryRouter({ db, requireAuth, ownsRef, isRefReadOnly, scheduler, aiSettingsLoader, now = () => new Date() }) {
  const router = express.Router();

  router.get('/summaries', requireAuth, (req, res) => {
    const parsed = parseRefsParam(req.query.refs);
    if (parsed.error === 'invalid_refs') return fail(res, 400, 'invalid_refs', 'Ungültige Referenzliste');
    if (parsed.error === 'too_many_refs') return fail(res, 400, 'too_many_refs', 'Zu viele Referenzen angefragt (max. 50)');
    try {
      const settings = aiSettingsLoader(db, req.session.uid);
      const map = service.forRefs(db, req.session.uid, parsed.items, { settings, scheduler });
      const summaries = {};
      for (const [key, view] of map) summaries[key] = view;
      res.json({ summaries });
    } catch (e) {
      internalError(res, 'GET /summaries', e);
    }
  });

  // Rate-Limiter: max. 10 Regenerate-Anfragen pro Nutzer je 10 Minuten.
  const regenAttempts = new Map(); // userId -> epochMs[]
  function isRegenRateLimited(userId) {
    const cutoff = now().getTime() - 10 * 60 * 1000;
    const arr = (regenAttempts.get(userId) || []).filter(t => t > cutoff);
    regenAttempts.set(userId, arr);
    return arr.length >= 10;
  }
  function recordRegenAttempt(userId) {
    const arr = regenAttempts.get(userId) || [];
    arr.push(now().getTime());
    regenAttempts.set(userId, arr);
  }

  router.post('/summaries/:kind/:refType/:refId/regenerate', requireAuth, (req, res) => {
    try {
      const userId = req.session.uid;
      if (isRegenRateLimited(userId)) return fail(res, 429, 'rate_limited', 'Zu viele Anfragen — bitte kurz warten.');
      recordRegenAttempt(userId);

      const { kind, refType, refId } = req.params;
      if (!KINDS.includes(kind)) return fail(res, 400, 'invalid_kind', 'Ungültige Art der Zusammenfassung');
      if ((refType !== 'todo' && refType !== 'topic') || !REF_ID_RE.test(String(refId || '')))
        return fail(res, 404, 'ref_not_found', 'Referenz nicht gefunden');

      if (!ownsRef(userId, refType, refId)) return fail(res, 404, 'ref_not_found', 'Referenz nicht gefunden');
      if (isRefReadOnly(refType, refId)) return fail(res, 409, 'ARCHIVED_READONLY', 'Diese Referenz ist archiviert und schreibgeschützt');

      const settings = aiSettingsLoader(db, userId);
      try {
        ai.assertActive(settings, FEATURE_BY_KIND[kind]);
      } catch (_) {
        return fail(res, 409, 'ai_disabled', 'KI ist für diese Funktion nicht verfügbar');
      }
      try {
        usage.assertBudgetOk(db, userId, settings, 0);
      } catch (_) {
        return fail(res, 402, 'budget_exceeded', 'Monatliches KI-Budget erschöpft');
      }

      const row = refType === 'todo'
        ? db.prepare('SELECT done, description FROM todos WHERE id=? AND user_id=?').get(refId, userId)
        : db.prepare(
            `SELECT t.done AS done, t.description AS description
               FROM topics t JOIN meetings m ON m.id=t.meeting_id
              WHERE t.id=? AND m.user_id=?`
          ).get(refId, userId);
      if (!row) return fail(res, 404, 'ref_not_found', 'Referenz nicht gefunden');
      if (row.done) return fail(res, 409, 'not_applicable', 'Für erledigte Einträge wird keine Zusammenfassung erzeugt');

      if (kind === 'progress') {
        const versions = queries.progressSourceVersions(db, userId, [{ refType, refId }]);
        const v = versions.get(`${refType}:${refId}`) || { entryCount: 0 };
        if (v.entryCount < PROGRESS_MIN_ENTRIES) return fail(res, 409, 'not_applicable', 'Zu wenige Fortschrittseinträge für eine Zusammenfassung');
      } else {
        const plain = htmlToText(row.description || '');
        if (plain.length < DESCRIPTION_MIN_PLAIN_CHARS) return fail(res, 409, 'not_applicable', 'Beschreibung ist zu kurz für eine Zusammenfassung');
      }

      const confirmed = req.query.confirm === 'true';
      const ok = scheduler.enqueue({ userId, kind, refType, refId, reason: 'manual', confirmed });
      if (!ok) return fail(res, 500, 'internal', 'Anfrage konnte nicht eingeplant werden');
      res.status(202).json({ status: 'pending' });
    } catch (e) {
      internalError(res, 'POST /summaries/:kind/:refType/:refId/regenerate', e);
    }
  });

  return router;
}

module.exports = { createSummaryRouter };
