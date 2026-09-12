'use strict';
// HTTP-Schicht fuer DB-Backup/Restore (Arbeitspaket B1).
//
// Alles wird von AUSSEN injiziert (Dependency Injection, Muster aus
// lib/archive/routes.js) - dieses Modul importiert NICHTS aus server.js.
// `db`, `requireAdmin`, `backupsDir`, `sessionStore`, `rebuildSearchIndex`,
// `now` werden von B2 (Wiring) bereitgestellt.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { getSettings, saveSettings, VALIDATION_ERRORS } = require('./queries');
const {
  createBackup, listBackups, deleteBackup,
  withBackupLock, checkBackupRate, ensureValidFilename,
  InvalidFilenameError, BackupNotFoundError,
} = require('./store');
const { restoreFromFile, RestoreValidationError, RestoreFailedError } = require('./restore');
const { sendError, makeInternalErrorHandler } = require('../http');

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB, siehe Requirements-Annahme

const VALIDATION_MESSAGES = {
  [VALIDATION_ERRORS.INVALID_ENABLED]: 'enabled muss ein boolescher Wert sein.',
  [VALIDATION_ERRORS.INVALID_HOUR]: 'Uhrzeit muss zwischen 0 und 23 liegen.',
  [VALIDATION_ERRORS.INVALID_RETENTION]: 'Aufbewahrung muss zwischen 1 und 100 liegen.',
};

function contentLengthGuard(maxBytes) {
  return (req, res, next) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > maxBytes) {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Die Datei ist zu groß (maximal 200 MB).');
    }
    next();
  };
}

// Wrappt express.raw() in eine eigene Middleware, damit Body-Parser-Fehler
// (u.a. eine trotz Content-Length-Vorabcheck zu groß gewordene, z.B.
// chunked-encodete Anfrage) in unser eigenes Fehler-Envelope münden statt
// im generischen 500er-Error-Handler von server.js zu landen.
function rawBodyWithLimit(maxBytes) {
  const parser = express.raw({ type: '*/*', limit: maxBytes });
  return (req, res, next) => {
    parser(req, res, (err) => {
      if (!err) return next();
      if (err.status === 413 || err.type === 'entity.too.large') {
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Die Datei ist zu groß (maximal 200 MB).');
      }
      return sendError(res, 400, 'INVALID_FILE', 'Datei konnte nicht gelesen werden.');
    });
  };
}

function mapRestoreError(res, err) {
  if (err instanceof RestoreValidationError) {
    return sendError(res, 422, 'RESTORE_VALIDATION_FAILED', 'Diese Datei ist keine gültige ThreadStack-Sicherung oder ist beschädigt.');
  }
  if (err instanceof RestoreFailedError) {
    return sendError(res, 500, 'RESTORE_FAILED', err.reverted
      ? 'Wiederherstellung ist fehlgeschlagen. Deine Daten wurden automatisch unverändert gelassen.'
      : 'Wiederherstellung ist fehlgeschlagen. Es wurde keine Änderung vorgenommen.', { reverted: !!err.reverted });
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {import('express').RequestHandler} ctx.requireAdmin
 * @param {string} ctx.backupsDir
 * @param {{clear: (cb: (err?: Error) => void) => void}} ctx.sessionStore
 * @param {(db: import('better-sqlite3').Database) => void} ctx.rebuildSearchIndex
 * @param {() => Date} [ctx.now]
 * @returns {import('express').Router}
 */
function createBackupRouter(ctx) {
  const {
    db, requireAdmin, backupsDir, sessionStore, rebuildSearchIndex, now = () => new Date(),
  } = ctx || {};
  if (!db) throw new Error('createBackupRouter: db ist erforderlich');
  if (typeof requireAdmin !== 'function') throw new Error('createBackupRouter: requireAdmin ist erforderlich');
  if (!backupsDir) throw new Error('createBackupRouter: backupsDir ist erforderlich');
  if (!sessionStore || typeof sessionStore.clear !== 'function') {
    throw new Error('createBackupRouter: sessionStore mit clear() ist erforderlich');
  }
  if (typeof rebuildSearchIndex !== 'function') throw new Error('createBackupRouter: rebuildSearchIndex ist erforderlich');

  const router = express.Router();
  const internalError = makeInternalErrorHandler('backup');

  function checkRate(req, res) {
    const userId = req.session.uid;
    if (!checkBackupRate(userId, now().getTime())) {
      sendError(res, 429, 'RATE_LIMITED', 'Zu viele Backup-Aktionen in kurzer Zeit. Bitte in ein paar Minuten erneut versuchen.');
      return false;
    }
    return true;
  }

  function clearAllSessions() {
    return new Promise((resolve) => {
      sessionStore.clear((err) => {
        if (err) console.error('[backup] Session-Store konnte nach Restore nicht geleert werden:', err.message || err);
        resolve();
      });
    });
  }

  // Gemeinsamer Ablauf fuer beide Restore-Einstiegspunkte (aus Liste /
  // Upload) - Lock, Aufruf von restoreFromFile, Session-Invalidierung und
  // Fehler-Mapping sind identisch, nur die Herkunft von `sourcePath`
  // unterscheidet sich zwischen den beiden Routen.
  async function performRestore(res, routeLabel, sourcePath) {
    try {
      const result = await withBackupLock(() => restoreFromFile(db, {
        sourcePath, backupsDir, rebuildSearchIndex, now,
      }));
      await clearAllSessions();
      res.json({ ok: true, sessionsInvalidated: true, preRestoreBackup: result.preRestoreBackup });
    } catch (err) {
      if (err && err.code === 'BACKUP_IN_PROGRESS') {
        return sendError(res, 409, 'BACKUP_IN_PROGRESS', 'Es läuft bereits eine Backup-Operation. Bitte kurz warten.');
      }
      const mapped = mapRestoreError(res, err);
      if (mapped) return mapped;
      internalError(res, routeLabel, err);
    }
  }

  router.get('/settings', requireAdmin, (req, res) => {
    try {
      res.json(getSettings(db));
    } catch (err) {
      internalError(res, 'GET /settings', err);
    }
  });

  router.put('/settings', requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.hour !== undefined) patch.hour = body.hour;
      if (body.retentionCount !== undefined) patch.retentionCount = body.retentionCount;

      const result = saveSettings(db, patch, { updatedAt: now().toISOString(), updatedBy: req.session.uid });
      if (!result.ok) {
        return sendError(res, 400, 'VALIDATION_FAILED', VALIDATION_MESSAGES[result.error] || 'Ungültige Eingabe.');
      }
      res.json(result.settings);
    } catch (err) {
      internalError(res, 'PUT /settings', err);
    }
  });

  router.get('/', requireAdmin, (req, res) => {
    try {
      res.json({ backups: listBackups(backupsDir) });
    } catch (err) {
      internalError(res, 'GET /', err);
    }
  });

  router.post('/', requireAdmin, async (req, res) => {
    if (!checkRate(req, res)) return;
    try {
      const backup = await withBackupLock(() => createBackup(db, { backupsDir, type: 'manual', now }));
      res.status(201).json({ backup });
    } catch (err) {
      if (err && err.code === 'BACKUP_IN_PROGRESS') {
        return sendError(res, 409, 'BACKUP_IN_PROGRESS', 'Es läuft bereits eine Backup-Operation. Bitte kurz warten.');
      }
      internalError(res, 'POST /', err);
    }
  });

  router.get('/:filename/download', requireAdmin, (req, res) => {
    let filePath;
    try {
      ({ filePath } = ensureValidFilename(backupsDir, req.params.filename));
    } catch (err) {
      if (err instanceof InvalidFilenameError) return sendError(res, 400, 'INVALID_FILENAME', err.message);
      return internalError(res, 'GET /:filename/download', err);
    }
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'NOT_FOUND', 'Backup nicht gefunden.');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    // dotfiles:'allow' ist hier unbedenklich (kein Sicherheitsnachteil): der
    // Dateiname wurde bereits per Allowlist-Regex + Containment-Check
    // (ensureValidFilename) validiert, enthält also nie einen "..“-Segment
    // oder einen führenden Punkt. Ohne diese Option würde `send` (Express'
    // sendFile-Backend) faelschlich 404 liefern, falls IRGENDEIN Segment von
    // `backupsDir` selbst mit einem Punkt beginnt (z.B. ein versteckter
    // DATA_DIR-Unterordner) - unabhängig vom (stets unbedenklichen) Dateinamen.
    res.sendFile(filePath, { dotfiles: 'allow' });
  });

  router.delete('/:filename', requireAdmin, (req, res) => {
    try {
      deleteBackup(backupsDir, req.params.filename);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof InvalidFilenameError) return sendError(res, 400, 'INVALID_FILENAME', err.message);
      if (err instanceof BackupNotFoundError) return sendError(res, 404, 'NOT_FOUND', err.message);
      internalError(res, 'DELETE /:filename', err);
    }
  });

  router.post('/:filename/restore', requireAdmin, async (req, res) => {
    if (!checkRate(req, res)) return;
    let filePath;
    try {
      ({ filePath } = ensureValidFilename(backupsDir, req.params.filename));
    } catch (err) {
      if (err instanceof InvalidFilenameError) return sendError(res, 400, 'INVALID_FILENAME', err.message);
      return internalError(res, 'POST /:filename/restore', err);
    }
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'NOT_FOUND', 'Backup nicht gefunden.');

    await performRestore(res, 'POST /:filename/restore', filePath);
  });

  router.post(
    '/restore-upload',
    requireAdmin,
    contentLengthGuard(MAX_UPLOAD_BYTES),
    rawBodyWithLimit(MAX_UPLOAD_BYTES),
    async (req, res) => {
      if (!checkRate(req, res)) return;
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return sendError(res, 400, 'INVALID_FILE', 'Keine Dateidaten erhalten.');
      }

      const tempPath = path.join(os.tmpdir(), `backup-upload-${crypto.randomBytes(8).toString('hex')}.sqlite`);
      try {
        fs.writeFileSync(tempPath, req.body);
        await performRestore(res, 'POST /restore-upload', tempPath);
      } finally {
        try { fs.unlinkSync(tempPath); } catch (_) { /* bereits weg, ignorieren */ }
      }
    }
  );

  return router;
}

module.exports = { createBackupRouter };
