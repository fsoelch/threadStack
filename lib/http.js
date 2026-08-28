'use strict';
// Gemeinsame HTTP-/SQL-Hilfsfunktionen für die lib/-Module (progress,
// archive, summaries), aus deren jeweils eigenen, fast identischen Kopien
// extrahiert (Arbeit zur Lesbarkeit/Wartbarkeit) - Verhalten unveraendert.

// `ids.map(() => '?').join(',')` — der mit Abstand am häufigsten wiederholte
// Idiom im gesamten lib/-Baum (SQL-`IN (...)`-Platzhalter für eine
// dynamische Anzahl parametrisierter Werte). `n` ist die Anzahl der Werte,
// NIE roher Nutzerinput.
function placeholders(n) {
  return Array(n).fill('?').join(',');
}

// Sendet eine strukturierte Fehlerantwort im projektweiten Envelope-Format
// `{ error, code, ...extra }`. Ersetzt die drei bisher separat definierten,
// aber gleichwertigen `fail()`/`errorResponse()`-Funktionen in
// lib/progress/routes.js, lib/archive/routes.js (dort injiziert) und
// lib/summaries/routes.js.
function sendError(res, status, code, message, extra) {
  return res.status(status).json(Object.assign({ error: message, code }, extra || {}));
}

// Baut eine `internalError(res, route, err)`-Funktion für ein Modul: loggt
// NIEMALS Stacktraces/SQLite-Fehlertexte/Pfade/Inhalte an den Client, nur
// `{code:'internal', route, sqliteCode}` nach console.error, und antwortet
// mit einer generischen 500. `moduleTag` erscheint im Log-Präfix (z. B.
// "[progress]"), `code` ist der code-String im Response-Body (Module
// verwenden hier leicht unterschiedliche Konventionen: 'internal' vs.
// 'INTERNAL' - bewusst konfigurierbar, um bestehende API-Verträge/Tests
// nicht zu brechen). `sendErrorFn` ist optional injizierbar für Module wie
// lib/archive, die ihre eigene, von AUSSEN injizierte `fail()`-Funktion
// verwenden statt der hier bereitgestellten `sendError()`.
function makeInternalErrorHandler(moduleTag, {
  code = 'internal',
  message = 'Unerwarteter Fehler. Bitte erneut versuchen.',
  sendErrorFn = sendError,
} = {}) {
  return function internalError(res, route, err) {
    const sqliteCode = err && err.code ? String(err.code) : undefined;
    try {
      console.error(`[${moduleTag}]`, JSON.stringify({ code: 'internal', route, sqliteCode }));
    } catch (_) { /* Logging darf niemals selbst einen Fehler werfen */ }
    return sendErrorFn(res, 500, code, message);
  };
}

module.exports = { placeholders, sendError, makeInternalErrorHandler };
