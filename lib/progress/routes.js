'use strict';
// HTTP-Schicht für den Fortschrittsverlauf (Arbeitspaket S1).
//
// Alles wird von AUSSEN injiziert (Dependency Injection) - dieses Modul
// importiert NICHTS aus server.js. `db`, `requireAuth`, `ownsRef` und
// `getLatestFrameId` werden SPÄTER von S2 beim Wiring bereitgestellt.
const express = require('express');

const {
  refInfo, getMeta, setNextStep,
  insertEntry, updateEntry, deleteEntry, getEntry, listEntries, detailStats, summaryFor,
} = require('./queries');
const {
  sanitizeProgressHtml, progressPlainText, sanitizePlainField, truncateExcerpt,
  MAX_PROGRESS_TEXT, MAX_PROGRESS_HTML, MAX_NEXT_STEP,
} = require('./sanitize');
const { createRateLimiter } = require('../rate-limit');

const REF_TYPES = new Set(['todo', 'topic']);
const SOURCES = new Set(['manual', 'snooze', 'pop_snoozed', 'pop_dropped', 'pop_done']);
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\|[A-Za-z0-9_-]{1,64}$/;

// Defensiver Roh-Payload-Schutz für die Klartext-Felder Zielbild/Nächster
// Schritt, ANALOG zu MAX_PROGRESS_HTML für Zwischenstände: verhindert, dass
// pathologisch große Requests überhaupt erst durch sanitizePlainField
// laufen. Ändert das dokumentierte Verhalten NICHT (finale Grenze bleibt
// MAX_GOAL/MAX_NEXT_STEP nach Sanitizing) - reine Performance-/DoS-Vorsorge.
const MAX_PLAIN_FIELD_RAW = 20000;

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

function internalError(res, route, err) {
  // Niemals Stacktraces/SQLite-Fehlertexte/Pfade an den Client, kein Logging
  // von Inhalten (body_html/goal/nextStep/Klarnamen).
  const sqliteCode = err && err.code ? String(err.code) : undefined;
  try {
    console.error('[progress]', JSON.stringify({ code: 'internal', route, sqliteCode }));
  } catch (_) { /* Logging darf niemals selbst einen Fehler werfen */ }
  return errorResponse(res, 500, 'internal', 'Unerwarteter Fehler. Bitte erneut versuchen.');
}

function serializeRef(refType, refId, ref) {
  return {
    type: refType,
    id: refId,
    exists: true,
    title: ref.title,
    done: ref.done,
    snoozedUntil: ref.snoozedUntil,
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
    result: ref.result,
    resultDate: ref.resultDate,
  };
}

// Serialisierung für vom Client erzeugte/bearbeitete Einträge (POST/PUT
// /entries) - diese sind über diese Routen IMMER kind='note', daher keine
// ref.result-Auflösung nötig.
function serializeNoteEntry(row) {
  return {
    id: row.id,
    refType: row.ref_type,
    refId: row.ref_id,
    kind: row.kind,
    source: row.source,
    bodyHtml: row.body_html,
    excerpt: truncateExcerpt(progressPlainText(row.body_html)),
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    editable: row.kind !== 'result',
    linkFrameId: row.link_frame_id || null,
    clientToken: row.client_token || null,
    // Lücken-/Ruhephasen-Info wird für frisch erstellte/bearbeitete Einzeleinträge
    // nicht neu berechnet (der anschließende Listen-Reload liefert den korrekten
    // Wert) - sichere Defaults, damit clientseitiges Decodieren nicht scheitert.
    gapDaysBefore: 0,
    showDormancyMarker: false,
  };
}

// Serialisierung für Einträge aus listEntries() (GET-Listen): löst
// kind='result' gegen ref.result auf und liefert null (= herausfiltern),
// wenn kein Ergebnistext vorliegt. Enthält zusätzlich die
// Pagination-Anreicherungen gapDaysBefore/showDormancyMarker.
function serializeListEntry(row, ref) {
  const isResult = row.kind === 'result';
  const bodyHtml = isResult ? (ref && ref.result ? ref.result : '') : row.body_html;
  if (isResult && !bodyHtml) return null;
  return {
    id: row.id,
    refType: row.ref_type,
    refId: row.ref_id,
    kind: row.kind,
    source: row.source,
    bodyHtml,
    excerpt: truncateExcerpt(progressPlainText(bodyHtml)),
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    editable: !isResult,
    linkFrameId: row.link_frame_id || null,
    gapDaysBefore: row.gapDaysBefore,
    showDormancyMarker: row.showDormancyMarker,
  };
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {import('express').RequestHandler} deps.requireAuth
 * @param {(uid: string, refType: string, refId: string) => boolean} deps.ownsRef
 * @param {(refType: string, refId: string) => (string|null|Promise<string|null>)} [deps.getLatestFrameId]
 * @param {(refType: string, refId: string) => boolean} [deps.isRefReadOnly] Additive,
 *   optionale Erweiterung (Arbeitspaket B2, "Meetings archivieren statt
 *   löschen"): liefert `true`, wenn Schreibzugriffe auf diese Referenz aktuell
 *   gesperrt sind (z.B. weil das zugehörige Meeting archiviert ist). Wird in
 *   JEDER schreibenden Route NACH dem bestehenden resolveRef()/Ownership-
 *   Check aufgerufen; bei `true` -> 409 ARCHIVED_READONLY. Lesende Routen
 *   bleiben unberührt. Bestehende Aufrufer, die diesen Schlüssel nicht
 *   übergeben, verhalten sich unveraendert (Default `() => false`) -
 *   Abwärtskompatibilitäts-Hardstop, siehe test/progress_readonly_guard.test.js.
 * @param {() => Date} [deps.now]
 * @param {(ctx: {userId:string, refType:'todo'|'topic', refId:string, reason:'created'|'updated'|'deleted'}) => {enqueued:boolean}} [deps.onProgressEntriesChanged]
 *   Additive, optionale Erweiterung (Redesign "Übersichtlichere Todos und
 *   Tasks", Arbeitspaket S3, KI-Zusammenfassungen): wird NACH erfolgreichem
 *   Schreibvorgang und VOR der Response synchron aufgerufen, um eine
 *   Hintergrund-Zusammenfassung anzustoßen. Muss sofort zurückkehren (kein
 *   await, keine KI im Aufrufpfad) - wird defensiv in try/catch aufgerufen
 *   und darf die Response niemals beeinflussen. Default: `() => ({enqueued:false})`.
 * @returns {import('express').Router}
 */
function createProgressRouter({ db, requireAuth, ownsRef, getLatestFrameId, isRefReadOnly, now = () => new Date(), onProgressEntriesChanged }) {
  if (!db) throw new Error('createProgressRouter: db ist erforderlich');
  if (typeof requireAuth !== 'function') throw new Error('createProgressRouter: requireAuth ist erforderlich');
  if (typeof ownsRef !== 'function') throw new Error('createProgressRouter: ownsRef ist erforderlich');

  const readOnlyCheck = typeof isRefReadOnly === 'function' ? isRefReadOnly : () => false;
  const entriesChangedHook = typeof onProgressEntriesChanged === 'function'
    ? onProgressEntriesChanged
    : () => ({ enqueued: false });

  // Ruft den Hook defensiv auf (darf NIE werfen und beeinflusst die
  // Response-Zeit nicht - der Hook selbst muss synchron/nicht-blockierend sein).
  function notifyEntriesChanged(ctx) {
    try {
      const r = entriesChangedHook(ctx);
      return !!(r && r.enqueued);
    } catch (_) {
      return false;
    }
  }

  const router = express.Router();

  const writeLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 60,
    key: (req) => req.session && req.session.uid,
    message: 'Zu viele Änderungen. Bitte kurz warten.',
    code: 'rate_limited',
  });

  function nowIso() {
    return now().toISOString();
  }

  // Löst refType/refId auf, prüft Existenz UND Owner - identische 404-Antwort
  // für "existiert nicht" und "fremder Owner" (keine Existenz-Enumeration).
  // Schreibt bei Fehlschlag direkt die Response und gibt null zurück.
  function resolveRef(req, res) {
    const refType = req.params.refType;
    if (!REF_TYPES.has(refType)) {
      errorResponse(res, 400, 'invalid_ref_type', 'Ungültiger Referenztyp.');
      return null;
    }
    const refId = req.params.refId;
    const uid = req.session.uid;
    const ref = refInfo(db, refType, refId);
    if (!ref.exists || !ownsRef(uid, refType, refId)) {
      errorResponse(res, 404, 'ref_not_found', 'Referenz nicht gefunden.');
      return null;
    }
    return { refType, refId, uid, ref };
  }

  function parseLimit(req) {
    if (req.query.limit === undefined) return { limit: 20 };
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) return { error: true };
    return { limit: n };
  }

  async function resolveAi(refType, refId) {
    if (typeof getLatestFrameId !== 'function') return { available: false, frameId: null };
    try {
      const frameId = await getLatestFrameId(refType, refId);
      return { available: !!frameId, frameId: frameId || null };
    } catch (_) {
      // Optionaler AI-Kontext - Fehler dort dürfen die Antwort nicht kippen.
      return { available: false, frameId: null };
    }
  }

  // ── /entries/:entryId ZUERST registrieren - sonst matcht Express
  //    "entries" fälschlich als :refType der nachfolgenden Routen. ──

  router.put('/entries/:entryId', requireAuth, writeLimiter, async (req, res) => {
    try {
      const uid = req.session.uid;
      const entryId = req.params.entryId;
      const existing = getEntry(db, uid, entryId);
      if (!existing) return errorResponse(res, 404, 'entry_not_found', 'Zwischenstand nicht gefunden.');
      if (readOnlyCheck(existing.ref_type, existing.ref_id)) {
        return errorResponse(res, 409, 'ARCHIVED_READONLY', 'Dieses Meeting ist archiviert. Zum Bearbeiten bitte wiederherstellen.');
      }
      if (existing.kind === 'result') {
        return errorResponse(res, 409, 'entry_not_editable', 'Dieser Eintrag kann nicht bearbeitet werden.');
      }

      const rawBody = req.body && typeof req.body.body === 'string' ? req.body.body : '';
      if (rawBody.length > MAX_PROGRESS_HTML) {
        return errorResponse(res, 400, 'body_too_long', 'Der Zwischenstand ist zu lang.');
      }
      const bodyHtml = sanitizeProgressHtml(rawBody);
      const bodyText = progressPlainText(bodyHtml);
      if (!bodyText) return errorResponse(res, 400, 'body_empty', 'Der Zwischenstand darf nicht leer sein.');
      if (bodyText.length > MAX_PROGRESS_TEXT) {
        return errorResponse(res, 400, 'body_too_long', 'Der Zwischenstand ist zu lang.');
      }

      const updated = updateEntry(db, uid, entryId, { bodyHtml, bodyText, nowIso: nowIso() });
      if (!updated) return errorResponse(res, 404, 'entry_not_found', 'Zwischenstand nicht gefunden.');
      const summary = summaryFor(db, uid, [{ refType: updated.ref_type, refId: updated.ref_id }]).get(`${updated.ref_type}:${updated.ref_id}`);
      const enqueued = notifyEntriesChanged({ userId: uid, refType: updated.ref_type, refId: updated.ref_id, reason: 'updated' });
      res.json({ entry: serializeNoteEntry(updated), summary, aiSummary: { pending: enqueued } });
    } catch (err) {
      internalError(res, 'PUT /entries/:entryId', err);
    }
  });

  router.delete('/entries/:entryId', requireAuth, writeLimiter, async (req, res) => {
    try {
      const uid = req.session.uid;
      const entryId = req.params.entryId;
      const existing = getEntry(db, uid, entryId);
      if (!existing) return errorResponse(res, 404, 'entry_not_found', 'Zwischenstand nicht gefunden.');
      if (readOnlyCheck(existing.ref_type, existing.ref_id)) {
        return errorResponse(res, 409, 'ARCHIVED_READONLY', 'Dieses Meeting ist archiviert. Zum Bearbeiten bitte wiederherstellen.');
      }
      if (existing.kind === 'result') {
        return errorResponse(res, 409, 'entry_not_editable', 'Dieser Eintrag kann nicht gelöscht werden.');
      }

      const ok = deleteEntry(db, uid, entryId);
      if (!ok) return errorResponse(res, 404, 'entry_not_found', 'Zwischenstand nicht gefunden.');

      const ref = refInfo(db, existing.ref_type, existing.ref_id);
      const { stats } = detailStats(db, uid, existing.ref_type, existing.ref_id, ref);
      const summary = summaryFor(db, uid, [{ refType: existing.ref_type, refId: existing.ref_id }]).get(`${existing.ref_type}:${existing.ref_id}`);
      const enqueued = notifyEntriesChanged({ userId: uid, refType: existing.ref_type, refId: existing.ref_id, reason: 'deleted' });
      res.json({ ok: true, stats, summary, aiSummary: { pending: enqueued } });
    } catch (err) {
      internalError(res, 'DELETE /entries/:entryId', err);
    }
  });

  // ── /:refType/:refId... ──

  router.get('/:refType/:refId', requireAuth, async (req, res) => {
    try {
      const resolved = resolveRef(req, res);
      if (!resolved) return;
      const { refType, refId, uid, ref } = resolved;

      const parsedLimit = parseLimit(req);
      if (parsedLimit.error) return errorResponse(res, 400, 'invalid_limit', 'Ungültiges Limit.');
      const limit = parsedLimit.limit;

      const meta = getMeta(db, refType, refId);
      const { stats, reentry } = detailStats(db, uid, refType, refId, ref);
      reentry.ai = await resolveAi(refType, refId);

      const { entries: rawEntries, nextCursor, hasMore } = listEntries(db, uid, refType, refId, { limit });
      const entries = rawEntries.map((row) => serializeListEntry(row, ref)).filter(Boolean);

      res.json({
        ref: serializeRef(refType, refId, ref),
        // DEPRECATED: das Zielbild wurde entfernt (Redesign "Übersichtlichere
        // Todos und Tasks"). Diese Felder bleiben als leere Platzhalter
        // bestehen, damit noch nicht aktualisierte App-Installationen nicht
        // an einem fehlenden Schlüssel scheitern.
        goal: '',
        goalUpdatedAt: null,
        nextStep: meta.nextStep,
        nextStepUpdatedAt: meta.nextStepUpdatedAt,
        stats,
        reentry,
        entries,
        page: { limit, nextCursor, hasMore },
      });
    } catch (err) {
      internalError(res, 'GET /:refType/:refId', err);
    }
  });

  // Redesign "Übersichtlichere Todos und Tasks": das Zielbild entfällt aus
  // der UI - das Ziel ergibt sich aus der Beschreibung. Die Route bleibt
  // REGISTRIERT (sonst würde ein Alt-Client-Aufruf fälschlich als "Referenz
  // nicht gefunden" statt als "Feature entfernt" erscheinen), lehnt aber
  // JEDEN Aufruf ab, ohne irgendeinen Schreibvorgang oder DB-Zugriff.
  router.put('/:refType/:refId/goal', requireAuth, writeLimiter, (req, res) => {
    return errorResponse(res, 410, 'goal_removed', 'Das Zielbild wurde entfernt.');
  });

  router.put('/:refType/:refId/next-step', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveRef(req, res);
      if (!resolved) return;
      const { refType, refId, uid } = resolved;
      if (readOnlyCheck(refType, refId)) {
        return errorResponse(res, 409, 'ARCHIVED_READONLY', 'Dieses Meeting ist archiviert. Zum Bearbeiten bitte wiederherstellen.');
      }

      const rawNextStep = req.body && typeof req.body.nextStep === 'string' ? req.body.nextStep : '';
      if (rawNextStep.length > MAX_PLAIN_FIELD_RAW) {
        return errorResponse(res, 400, 'next_step_too_long', `Der nächste Schritt darf maximal ${MAX_NEXT_STEP} Zeichen haben.`);
      }
      const nextStep = sanitizePlainField(rawNextStep);
      if (nextStep.length > MAX_NEXT_STEP) {
        return errorResponse(res, 400, 'next_step_too_long', `Der nächste Schritt darf maximal ${MAX_NEXT_STEP} Zeichen haben.`);
      }

      const meta = setNextStep(db, uid, refType, refId, nextStep, nowIso());
      res.json({ nextStep: meta.nextStep, nextStepUpdatedAt: meta.nextStepUpdatedAt });
    } catch (err) {
      internalError(res, 'PUT /:refType/:refId/next-step', err);
    }
  });

  router.get('/:refType/:refId/entries', requireAuth, (req, res) => {
    try {
      const resolved = resolveRef(req, res);
      if (!resolved) return;
      const { refType, refId, uid, ref } = resolved;

      const parsedLimit = parseLimit(req);
      if (parsedLimit.error) return errorResponse(res, 400, 'invalid_limit', 'Ungültiges Limit.');
      const limit = parsedLimit.limit;

      let cursor = null;
      if (req.query.cursor !== undefined && req.query.cursor !== '') {
        const raw = String(req.query.cursor);
        if (!CURSOR_RE.test(raw)) return errorResponse(res, 400, 'invalid_cursor', 'Ungültiger Cursor.');
        cursor = raw;
      }

      const { entries: rawEntries, nextCursor, hasMore } = listEntries(db, uid, refType, refId, { limit, cursor });
      const entries = rawEntries.map((row) => serializeListEntry(row, ref)).filter(Boolean);

      res.json({ entries, page: { limit, hasMore, nextCursor } });
    } catch (err) {
      internalError(res, 'GET /:refType/:refId/entries', err);
    }
  });

  router.post('/:refType/:refId/entries', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveRef(req, res);
      if (!resolved) return;
      const { refType, refId, uid, ref } = resolved;
      if (readOnlyCheck(refType, refId)) {
        return errorResponse(res, 409, 'ARCHIVED_READONLY', 'Dieses Meeting ist archiviert. Zum Bearbeiten bitte wiederherstellen.');
      }

      const source = req.body && typeof req.body.source === 'string' && req.body.source
        ? req.body.source
        : 'manual';
      if (!SOURCES.has(source)) return errorResponse(res, 400, 'invalid_source', 'Ungültige Quelle.');

      let clientToken = null;
      if (req.body && req.body.clientToken !== undefined && req.body.clientToken !== null && req.body.clientToken !== '') {
        const rawToken = String(req.body.clientToken);
        if (!CLIENT_TOKEN_RE.test(rawToken)) {
          return errorResponse(res, 400, 'invalid_client_token', 'Ungültiges Client-Token.');
        }
        clientToken = rawToken;
      }

      const rawBody = req.body && typeof req.body.body === 'string' ? req.body.body : '';
      if (rawBody.length > MAX_PROGRESS_HTML) {
        return errorResponse(res, 400, 'body_too_long', 'Der Zwischenstand ist zu lang.');
      }
      const bodyHtml = sanitizeProgressHtml(rawBody);
      const bodyText = progressPlainText(bodyHtml);
      if (!bodyText) return errorResponse(res, 400, 'body_empty', 'Der Zwischenstand darf nicht leer sein.');
      if (bodyText.length > MAX_PROGRESS_TEXT) {
        return errorResponse(res, 400, 'body_too_long', 'Der Zwischenstand ist zu lang.');
      }

      if (ref.done) return errorResponse(res, 409, 'ref_done', 'Dieses Vorhaben ist bereits erledigt.');

      const { entry, idempotent } = insertEntry(db, {
        userId: uid, refType, refId, kind: 'note', source,
        bodyHtml, bodyText, linkFrameId: null, clientToken, nowIso: nowIso(),
      });

      const { stats } = detailStats(db, uid, refType, refId, ref);
      const summary = summaryFor(db, uid, [{ refType, refId }]).get(`${refType}:${refId}`);
      // Bei idempotentem Treffer (Doppel-Speichern) wurde bereits beim ersten
      // Aufruf ein Job eingereiht - kein zweiter Hook-Aufruf nötig.
      const enqueued = idempotent ? false : notifyEntriesChanged({ userId: uid, refType, refId, reason: 'created' });

      if (idempotent) {
        return res.status(200).json({ entry: serializeNoteEntry(entry), idempotent: true, stats, summary, aiSummary: { pending: false } });
      }
      res.status(201).json({ entry: serializeNoteEntry(entry), stats, summary, aiSummary: { pending: enqueued } });
    } catch (err) {
      internalError(res, 'POST /:refType/:refId/entries', err);
    }
  });

  return router;
}

module.exports = { createProgressRouter };
