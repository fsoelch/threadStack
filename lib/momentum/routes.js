'use strict';
// HTTP-Schicht für "Sichtbarer Fortschritt" (Arbeitspaket M1).
//
// Dependency Injection, analog lib/archive/routes.js: dieses Modul importiert
// NICHTS aus server.js. `db`, `requireAuth`, `uid`, `now` werden vom
// Wiring-Paket (M2) injiziert.
const express = require('express');
const {
  getSettings, saveSettings,
  listPauseDays, addPauseDay, removePauseDay, PAUSE_DAY_ERRORS,
  localDateStr, weekBoundsForLocalDate,
  computeStreak, weekCounts, weekMilestones,
} = require('./queries');
const { sendError, makeInternalErrorHandler } = require('../http');
const { createRateLimiter } = require('../rate-limit');

function parseUtcOffsetMinutes(raw) {
  if (raw === undefined) return { ok: true, value: 0 };
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return { ok: false };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < -1440 || n > 1440) return { ok: false };
  return { ok: true, value: n };
}

/**
 * @param {object} ctx
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {import('express').RequestHandler} ctx.requireAuth
 * @param {(req: import('express').Request) => string} ctx.uid
 * @param {() => Date} [ctx.now]
 * @returns {import('express').Router}
 */
function createMomentumRouter(ctx) {
  const { db, requireAuth, uid, now = () => new Date() } = ctx || {};
  if (!db) throw new Error('createMomentumRouter: db ist erforderlich');
  if (typeof requireAuth !== 'function') throw new Error('createMomentumRouter: requireAuth ist erforderlich');
  if (typeof uid !== 'function') throw new Error('createMomentumRouter: uid ist erforderlich');

  const router = express.Router();
  const internalError = makeInternalErrorHandler('momentum');

  // Etabliertes Schreibbegrenzungs-Profil (siehe lib/progress/routes.js,
  // lib/contacts/assignments/router.js): 60 Aenderungen / 10 Minuten pro
  // Session-Nutzer. Gilt fuer alle schreibenden Momentum-Routen unten.
  const writeLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 60 });

  router.get('/overview', requireAuth, (req, res) => {
    try {
      const offsetParsed = parseUtcOffsetMinutes(req.query.utcOffsetMinutes);
      if (!offsetParsed.ok) return sendError(res, 400, 'INVALID_OFFSET', 'Ungültiger utcOffsetMinutes-Wert.');
      const utcOffsetMinutes = offsetParsed.value;
      const userId = uid(req);
      const nowDate = now();

      const settings = getSettings(db, userId);
      const streak = settings.streakEnabled ? computeStreak(db, userId, utcOffsetMinutes, nowDate) : null;

      let week = null;
      if (settings.weeklyReviewEnabled) {
        const todayStr = localDateStr(nowDate, utcOffsetMinutes);
        const { startDate, endDate } = weekBoundsForLocalDate(todayStr);
        const counts = weekCounts(db, userId, startDate, endDate);
        const milestones = weekMilestones(db, userId, startDate, endDate);
        week = { startDate, endDate, ...counts, milestones };
      }

      res.json({ settings, streak, week });
    } catch (err) {
      internalError(res, 'GET /overview', err);
    }
  });

  router.put('/settings', requireAuth, writeLimiter, (req, res) => {
    try {
      const userId = uid(req);
      const body = req.body || {};
      const fields = ['completionToastEnabled', 'streakEnabled', 'weeklyReviewEnabled'];
      for (const f of fields) {
        if (body[f] !== undefined && typeof body[f] !== 'boolean') {
          return sendError(res, 400, 'VALIDATION_FAILED', `Feld ${f} muss ein boolescher Wert sein.`);
        }
      }
      const patch = {};
      for (const f of fields) if (body[f] !== undefined) patch[f] = body[f];
      const settings = saveSettings(db, userId, patch, now().toISOString());
      res.json(settings);
    } catch (err) {
      internalError(res, 'PUT /settings', err);
    }
  });

  router.get('/pause-days', requireAuth, (req, res) => {
    try {
      const userId = uid(req);
      res.json({ pauseDays: listPauseDays(db, userId) });
    } catch (err) {
      internalError(res, 'GET /pause-days', err);
    }
  });

  router.post('/pause-days', requireAuth, writeLimiter, (req, res) => {
    try {
      const offsetParsed = parseUtcOffsetMinutes(req.query.utcOffsetMinutes);
      if (!offsetParsed.ok) return sendError(res, 400, 'INVALID_OFFSET', 'Ungültiger utcOffsetMinutes-Wert.');
      const userId = uid(req);
      const { date } = req.body || {};
      if (typeof date !== 'string') return sendError(res, 400, 'VALIDATION_FAILED', 'date erforderlich.');
      const todayStr = localDateStr(now(), offsetParsed.value);
      const result = addPauseDay(db, userId, date, todayStr, now().toISOString());
      if (!result.ok) {
        const messages = {
          [PAUSE_DAY_ERRORS.INVALID_DATE]: 'Ungültiges Datum (Format JJJJ-MM-TT erforderlich).',
          [PAUSE_DAY_ERRORS.TOO_FAR_AHEAD]: 'Datum liegt zu weit in der Zukunft.',
          [PAUSE_DAY_ERRORS.TOO_FAR_BEHIND]: 'Datum liegt zu weit in der Vergangenheit.',
        };
        return sendError(res, 400, result.error, messages[result.error] || 'Ungültiges Datum.');
      }
      res.status(201).json({ date: result.date });
    } catch (err) {
      internalError(res, 'POST /pause-days', err);
    }
  });

  router.delete('/pause-days/:date', requireAuth, writeLimiter, (req, res) => {
    try {
      const userId = uid(req);
      const result = removePauseDay(db, userId, req.params.date);
      if (!result.ok) return sendError(res, 400, result.error, 'Ungültiges Datum (Format JJJJ-MM-TT erforderlich).');
      res.json({ ok: true, removed: result.removed });
    } catch (err) {
      internalError(res, 'DELETE /pause-days/:date', err);
    }
  });

  return router;
}

module.exports = { createMomentumRouter };
