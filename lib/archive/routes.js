'use strict';
// HTTP-Schicht für das Archiv-Kernmodul (Arbeitspaket B1).
//
// Alles wird von AUSSEN injiziert (Dependency Injection) - dieses Modul
// importiert NICHTS aus server.js. `db`, `requireAuth`, `uid`, `parseMeeting`,
// `parseTopic`, `progress`, `fail`, `buildFtsQuery`, `uploadsDir`, `now`
// werden SPÄTER von B2 beim Wiring bereitgestellt (siehe Vertrag).
const express = require('express');
const path = require('path');
const fs = require('fs');

const {
  ARCHIVABLE_REF_TYPES,
  isArchived,
  archivedAt,
  archive,
  restore,
  meetingImpact,
  openStackFramesForMeeting,
  purgeMeeting,
  listArchivedMeetings,
} = require('./queries');

// Tabelle je Referenztyp, gegen die die Ownership-Prüfung ("Ursprungstabelle")
// läuft. Einzige Erweiterungsstelle für spätere Referenztypen - Schlüssel
// sind stets Code-Konstanten (nie Nutzereingabe), Tabellennamen werden daher
// bewusst NICHT parametrisiert (SQLite erlaubt Tabellennamen ohnehin nicht
// als `?`-Platzhalter), sondern kommen ausschließlich aus dieser Allowlist.
const OWNER_TABLE = { meeting: 'meetings' };

function parsePositiveInt(raw, { min, max } = {}) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { ok: false };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return { ok: false };
  if (min !== undefined && n < min) return { ok: false };
  if (max !== undefined && n > max) return { ok: false };
  return { ok: true, value: n };
}

/**
 * @param {object} ctx
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {import('express').RequestHandler} ctx.requireAuth
 * @param {(req: import('express').Request) => string} ctx.uid
 * @param {(m: object, topics?: object[]) => object} ctx.parseMeeting
 * @param {(t: object) => object} ctx.parseTopic
 * @param {{deleteForRefs: Function, summaryFor: Function}} ctx.progress
 * @param {(res: import('express').Response, status: number, code: string, msg: string, extra?: object) => void} ctx.fail
 * @param {(raw: string) => (string|null)} ctx.buildFtsQuery
 * @param {string} ctx.uploadsDir
 * @param {() => Date} [ctx.now]
 * @returns {import('express').Router}
 */
function createArchiveRouter(ctx) {
  const {
    db, requireAuth, uid, parseMeeting, parseTopic, progress, fail, buildFtsQuery,
    uploadsDir, now = () => new Date(),
  } = ctx || {};

  if (!db) throw new Error('createArchiveRouter: db ist erforderlich');
  if (typeof requireAuth !== 'function') throw new Error('createArchiveRouter: requireAuth ist erforderlich');
  if (typeof uid !== 'function') throw new Error('createArchiveRouter: uid ist erforderlich');
  if (typeof parseMeeting !== 'function') throw new Error('createArchiveRouter: parseMeeting ist erforderlich');
  if (typeof parseTopic !== 'function') throw new Error('createArchiveRouter: parseTopic ist erforderlich');
  if (!progress || typeof progress.deleteForRefs !== 'function' || typeof progress.summaryFor !== 'function') {
    throw new Error('createArchiveRouter: progress (deleteForRefs, summaryFor) ist erforderlich');
  }
  if (typeof fail !== 'function') throw new Error('createArchiveRouter: fail ist erforderlich');
  if (typeof buildFtsQuery !== 'function') throw new Error('createArchiveRouter: buildFtsQuery ist erforderlich');
  if (typeof uploadsDir !== 'string' || !uploadsDir) throw new Error('createArchiveRouter: uploadsDir ist erforderlich');

  const router = express.Router();

  function nowIso() {
    return now().toISOString();
  }

  function internalError(res, route, err) {
    // Niemals Stacktraces/SQLite-Fehlertexte/Pfade an den Client, kein
    // Logging von Inhalten (Meeting-Titel/Teilnehmer/Notizen).
    const sqliteCode = err && err.code ? String(err.code) : undefined;
    try {
      console.error('[archive]', JSON.stringify({ code: 'internal', route, sqliteCode }));
    } catch (_) { /* Logging darf niemals selbst einen Fehler werfen */ }
    fail(res, 500, 'INTERNAL', 'Unerwarteter Fehler. Bitte erneut versuchen.');
  }

  function ownsSourceEntity(refType, refId, userId) {
    const table = OWNER_TABLE[refType];
    if (!table) return false;
    return !!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=?`).get(refId, userId);
  }

  // ── /meetings, /meetings/:id ZUERST registrieren - sonst matcht Express
  //    "meetings" fälschlich als :refType der nachfolgenden generischen
  //    Routen. ──

  router.get('/meetings', requireAuth, (req, res) => {
    try {
      const userId = uid(req);

      const limitParsed = parsePositiveInt(req.query.limit, { min: 1, max: 200 });
      if (!limitParsed.ok) return fail(res, 400, 'VALIDATION_FAILED', 'Ungültiges limit.');
      const limit = limitParsed.value !== undefined ? limitParsed.value : 50;

      const offsetParsed = parsePositiveInt(req.query.offset, { min: 0 });
      if (!offsetParsed.ok) return fail(res, 400, 'VALIDATION_FAILED', 'Ungültiges offset.');
      const offset = offsetParsed.value !== undefined ? offsetParsed.value : 0;

      const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      let ftsQuery = null;
      if (rawQ) {
        ftsQuery = buildFtsQuery(rawQ);
        if (ftsQuery === null) {
          // Reine Negativterme o.ä. -> definiertes leeres Ergebnis, kein 500.
          return res.json({ items: [], total: 0, limit, offset });
        }
      }

      const { rows, total } = listArchivedMeetings(db, userId, { q: ftsQuery, limit, offset });
      res.json({ items: rows, total, limit, offset });
    } catch (err) {
      internalError(res, 'GET /meetings', err);
    }
  });

  router.get('/meetings/:id', requireAuth, (req, res) => {
    try {
      const userId = uid(req);
      const meetingId = req.params.id;

      const m = db.prepare('SELECT * FROM meetings WHERE id=? AND user_id=?').get(meetingId, userId);
      if (!m) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');

      const at = archivedAt(db, 'meeting', meetingId);
      if (at === null) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden'); // aktives Meeting: nicht über diesen Pfad erreichbar

      const topics = db.prepare('SELECT * FROM topics WHERE meeting_id=? ORDER BY sort_order, created_at').all(meetingId);
      // Additive Progress-Anreicherung, identisch zum bestehenden Muster in
      // server.js (GET /api/meetings) - eine Batch-Query, kein N+1.
      const topicItems = topics.map((t) => ({
        refType: 'topic', refId: t.id,
        refCreatedAt: t.created_at, refUpdatedAt: t.updated_at,
        refDone: !!t.done, refSnoozedUntil: t.snoozed_until || null,
      }));
      const progressMap = progress.summaryFor(db, userId, topicItems);
      const meeting = parseMeeting(m, topics);
      for (const topic of meeting.topics) {
        topic.progress = progressMap.get(`topic:${topic.id}`) ?? null;
      }

      res.json({ ...meeting, archived: true, archivedAt: at, readOnly: true });
    } catch (err) {
      internalError(res, 'GET /meetings/:id', err);
    }
  });

  // ── generische /:refType/:refId... Routen ──

  router.post('/:refType/:refId', requireAuth, (req, res) => {
    try {
      const { refType, refId } = req.params;
      if (!ARCHIVABLE_REF_TYPES.has(refType)) {
        return fail(res, 400, 'UNSUPPORTED_REF_TYPE', 'Dieser Typ kann nicht archiviert werden.');
      }
      const userId = uid(req);
      if (!ownsSourceEntity(refType, refId, userId)) {
        return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
      }

      const acknowledgeStackConflict = !!(req.body && req.body.acknowledgeStackConflict === true);

      const existingAt = archivedAt(db, refType, refId);
      if (existingAt !== null) {
        return res.json({ ok: true, refType, refId, archived: true, archivedAt: existingAt, alreadyArchived: true });
      }

      if (refType === 'meeting' && !acknowledgeStackConflict) {
        const openFrames = openStackFramesForMeeting(db, userId, refId);
        if (openFrames.length) {
          return fail(res, 409, 'ARCHIVE_STACK_CONFLICT', 'Für dieses Meeting sind noch Einträge im Stack offen.', {
            conflicts: { openFrames },
          });
        }
      }

      let result = null;
      const run = db.transaction(() => {
        // Ownership-Recheck innerhalb der Transaktion (Defense-in-Depth).
        if (!ownsSourceEntity(refType, refId, userId)) return;
        result = archive(db, userId, refType, refId, nowIso());
      });
      run();

      if (!result) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');

      res.status(200).json({ ok: true, refType, refId, archived: true, archivedAt: result.archivedAt, alreadyArchived: false });
    } catch (err) {
      internalError(res, 'POST /:refType/:refId', err);
    }
  });

  router.delete('/:refType/:refId', requireAuth, (req, res) => {
    try {
      const { refType, refId } = req.params;
      if (!ARCHIVABLE_REF_TYPES.has(refType)) {
        return fail(res, 400, 'UNSUPPORTED_REF_TYPE', 'Dieser Typ kann nicht archiviert werden.');
      }
      const userId = uid(req);
      if (!ownsSourceEntity(refType, refId, userId)) {
        return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
      }

      let result = null;
      const run = db.transaction(() => {
        if (!ownsSourceEntity(refType, refId, userId)) return;
        result = restore(db, refType, refId);
      });
      run();

      if (!result) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');

      res.status(200).json({ ok: true, refType, refId, archived: false, alreadyActive: !result.changed });
    } catch (err) {
      internalError(res, 'DELETE /:refType/:refId', err);
    }
  });

  router.get('/:refType/:refId/preflight', requireAuth, (req, res) => {
    try {
      const { refType, refId } = req.params;
      if (!ARCHIVABLE_REF_TYPES.has(refType)) {
        return fail(res, 400, 'UNSUPPORTED_REF_TYPE', 'Dieser Typ kann nicht archiviert werden.');
      }
      const userId = uid(req);
      if (!ownsSourceEntity(refType, refId, userId)) {
        return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
      }

      const archivedFlag = isArchived(db, refType, refId);
      const at = archivedAt(db, refType, refId);
      // Impact/Konflikte sind aktuell nur für 'meeting' definiert (einziger
      // ARCHIVABLE_REF_TYPES-Eintrag) - Erweiterungsstelle für spätere Typen.
      const impact = refType === 'meeting'
        ? meetingImpact(db, userId, refId)
        : { topics: 0, progressEntries: 0, attachments: 0, attachmentBytes: 0, themeLinks: 0, stackFrames: 0, aiArtifacts: 0 };
      const openFrames = refType === 'meeting' ? openStackFramesForMeeting(db, userId, refId) : [];

      res.json({ refType, refId, archived: archivedFlag, archivedAt: at, impact, conflicts: { openFrames } });
    } catch (err) {
      internalError(res, 'GET /:refType/:refId/preflight', err);
    }
  });

  router.delete('/:refType/:refId/permanent', requireAuth, (req, res) => {
    try {
      const { refType, refId } = req.params;
      if (!ARCHIVABLE_REF_TYPES.has(refType)) {
        return fail(res, 400, 'UNSUPPORTED_REF_TYPE', 'Dieser Typ kann nicht archiviert werden.');
      }
      const userId = uid(req);
      if (!ownsSourceEntity(refType, refId, userId)) {
        return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
      }
      if (!isArchived(db, refType, refId)) {
        return fail(res, 409, 'NOT_ARCHIVED', 'Nur archivierte Meetings können endgültig gelöscht werden.');
      }

      let purgeResult;
      try {
        purgeResult = purgeMeeting(db, progress, userId, refId);
      } catch (e) {
        // Transaktion ist bereits automatisch zurückgerollt (better-sqlite3).
        // Details ausschließlich nach stderr, niemals im Response.
        console.error('[archive] purge failed:', e && e.message);
        return fail(res, 500, 'PURGE_FAILED', 'Löschen fehlgeschlagen');
      }

      // Dateisystem-Aufräumung NACH erfolgreichem DB-Commit, mit
      // Pfad-Absicherung (identisches Muster zu server.js DELETE /attachments/:id).
      const resolvedUploadsDir = path.resolve(uploadsDir);
      for (const storedName of purgeResult.storedFiles) {
        const filePath = path.resolve(resolvedUploadsDir, storedName);
        if (!filePath.startsWith(resolvedUploadsDir + path.sep)) continue;
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error('[archive] unlink failed:', e.message);
        }
      }

      res.json({ ok: true, deleted: purgeResult.deleted });
    } catch (err) {
      internalError(res, 'DELETE /:refType/:refId/permanent', err);
    }
  });

  return router;
}

module.exports = { createArchiveRouter };
