'use strict';
// Gemeinsamer Fehlerkonstruktor für alle ai/-Module: ein Error mit
// httpStatus-Property, den aiErr() in server.js direkt in eine HTTP-Antwort
// übersetzt (siehe server.js::aiErr). Aus ai/index.js extrahiert (Arbeit
// zur Lesbarkeit/Wartbarkeit), damit settings.js/dispatch.js/index.js sich
// nicht gegenseitig oder im Kreis referenzieren müssen.
function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

module.exports = { httpErr };
