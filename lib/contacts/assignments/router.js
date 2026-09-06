'use strict';
// Router-Factory für die Kontakt-Zuständigkeiten-API (Arbeitspaket B3).
// Bewusst als Factory, die einen express.Router() zurückgibt (statt den
// `app`-Objekt-Mutations-Stil von graph/index.js bzw. export/index.js), da
// der Schnittstellenvertrag `createAssignmentsRouter({...})` explizit
// vorgibt. B4 mountet den Router unter der jeweiligen API-Basis, z.B.
// `app.use(apiBase, createAssignmentsRouter({...}))`.

const express = require('express');
const {
  MAX_ASSIGNMENTS_PER_REF,
  ApiError,
  assertOwnsRef,
  assertWritable,
  resolveContact,
  listAssignedContacts,
  setAssignments,
  addAssignment,
  removeAssignment,
  listContactAssignments,
} = require('./queries');
const { createRateLimiter } = require('./rate-limit');

// Nachbesserung Code-Review Fund 3: statt einen eigenen sendError()-Helfer zu
// duplizieren, wird der geteilte Fehler-Envelope wie im übrigen Projekt
// üblich injiziert (Vorbild: export/index.js `const { db, requireAuth, fail,
// apiBase } = ctx;`). Für den eigenständigen Testbetrieb (Test-Harness ohne
// server.js) existiert ein funktionsgleicher Default.
function defaultFail(res, status, code, message, extra) {
  res.status(status).json(Object.assign({ error: message, code }, extra || {}));
}

function createAssignmentsRouter({ db, requireAuth, ownsRef, isRefReadOnly, now, fail }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createAssignmentsRouter: db (better-sqlite3-Instanz) erforderlich');
  }
  if (typeof requireAuth !== 'function') {
    throw new Error('createAssignmentsRouter: requireAuth erforderlich');
  }
  if (typeof ownsRef !== 'function') {
    throw new Error('createAssignmentsRouter: ownsRef erforderlich');
  }
  // isRefReadOnly ist optional (siehe Abschlussbericht: im Bestand existiert
  // aktuell kein Archiv-/Readonly-Konzept). Wird kein Callback übergeben,
  // findet schlicht keine Archiv-Sperre statt.
  const nowFn = typeof now === 'function' ? now : () => new Date().toISOString();
  const sendError = typeof fail === 'function' ? fail : defaultFail;

  const router = express.Router();
  // 60 Schreibzugriffe / 10 Minuten, wie im Rest des Projekts (siehe
  // export/index.js#checkExportRate für das Referenzmuster).
  const writeLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 60 });

  // Kapselt den ApiError-Steuerfluss aus queries.js in den Fehler-Envelope.
  // Unerwartete (nicht-ApiError) Fehler werden weitergereicht, damit der
  // globale Error-Handler der mountenden App (server.js) sie protokolliert,
  // statt sie hier zu verschlucken.
  function handle(fn) {
    return (req, res, next) => {
      try {
        fn(req, res);
      } catch (e) {
        if (e instanceof ApiError) return sendError(res, e.status, e.code, e.message);
        return next(e);
      }
    };
  }

  // ── Vorhaben-Seite ──────────────────────────────────────────────

  router.get(
    '/assignments/:refType/:refId',
    requireAuth,
    handle((req, res) => {
      const uid = req.session.uid;
      const { refType, refId } = req.params;
      assertOwnsRef(ownsRef, uid, refType, refId);
      const contacts = listAssignedContacts(db, uid, refType, refId);
      res.json({ contacts, limit: MAX_ASSIGNMENTS_PER_REF });
    })
  );

  router.put(
    '/assignments/:refType/:refId',
    requireAuth,
    writeLimiter,
    handle((req, res) => {
      const uid = req.session.uid;
      const { refType, refId } = req.params;
      assertOwnsRef(ownsRef, uid, refType, refId);
      assertWritable(isRefReadOnly, refType, refId);
      const contacts = setAssignments(db, {
        uid,
        refType,
        refId,
        contactIds: (req.body || {}).contactIds,
        now: nowFn,
      });
      res.json({ contacts });
    })
  );

  router.post(
    '/assignments/:refType/:refId',
    requireAuth,
    writeLimiter,
    handle((req, res) => {
      const uid = req.session.uid;
      const { refType, refId } = req.params;
      assertOwnsRef(ownsRef, uid, refType, refId);
      assertWritable(isRefReadOnly, refType, refId);
      const { assignment, created } = addAssignment(db, {
        uid,
        refType,
        refId,
        contactId: (req.body || {}).contactId,
        now: nowFn,
      });
      res.status(created ? 201 : 200).json({ assignment, created });
    })
  );

  router.delete(
    '/assignments/:refType/:refId/:contactId',
    requireAuth,
    writeLimiter,
    handle((req, res) => {
      const uid = req.session.uid;
      const { refType, refId, contactId } = req.params;
      // Nachbesserung Code-Review Fund 8/9: statt refType hart zu prüfen und
      // die Ref-Eigentümerschaft komplett zu überspringen, dieselbe Prüfung
      // wie bei GET/PUT/POST verwenden — ein DELETE auf ein fremdes Vorhaben
      // liefert damit konsistent 404 statt eines stillen "Erfolgs". Die
      // Idempotenz der eigentlichen Zuordnungs-Löschung bleibt unverändert.
      assertOwnsRef(ownsRef, uid, refType, refId);
      const removed = removeAssignment(db, uid, contactId, refType, refId);
      res.json({ ok: true, removed });
    })
  );

  // ── Kontakt-Seite ───────────────────────────────────────────────

  router.get(
    '/contacts/:contactId/assignments',
    requireAuth,
    handle((req, res) => {
      const uid = req.session.uid;
      const { contactId } = req.params;
      resolveContact(db, uid, contactId);

      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        return sendError(res, 400, 'INVALID_LIMIT', 'Ungültiges Limit.');
      }

      const rawOffset = req.query.offset;
      const offset = rawOffset === undefined ? 0 : Number(rawOffset);
      if (!Number.isInteger(offset) || offset < 0) {
        return sendError(res, 400, 'INVALID_OFFSET', 'Ungültiger Offset.');
      }

      const status = req.query.status === undefined ? 'all' : String(req.query.status);
      if (!['open', 'done', 'all'].includes(status)) {
        return sendError(res, 400, 'INVALID_STATUS', 'Ungültiger Status.');
      }

      const result = listContactAssignments(db, { uid, contactId, limit, offset, status });
      res.json(result);
    })
  );

  router.delete(
    '/contacts/:contactId/assignments/:refType/:refId',
    requireAuth,
    writeLimiter,
    handle((req, res) => {
      const uid = req.session.uid;
      const { contactId, refType, refId } = req.params;
      // Siehe Kommentar bei der Vorhaben-seitigen DELETE-Route.
      assertOwnsRef(ownsRef, uid, refType, refId);
      // Delegiert an dieselbe Query-Funktion wie die Vorhaben-Seite, damit
      // beide Lösch-Richtungen garantiert dasselbe Ergebnis liefern.
      const removed = removeAssignment(db, uid, contactId, refType, refId);
      res.json({ ok: true, removed });
    })
  );

  return router;
}

module.exports = { createAssignmentsRouter };
