'use strict';
// Gemeinsame Provider-Boilerplate, aus anthropic.js/openai.js/azure.js
// extrahiert (Arbeit zur Lesbarkeit/Wartbarkeit) - Verhalten unveraendert.
// `httpErr` erzeugt einen Error mit `.httpStatus`, den server.js::aiErr()
// direkt in eine HTTP-Antwort uebersetzt (siehe ai/errors.js, dieselbe
// Fassade). `withTimeout` bricht einen haengenden Provider-Call nach `ms`
// mit einem 503 ab und setzt `.httpStatus=503` auch fuer alle anderen,
// vom SDK durchgereichten Fehler, die noch keinen eigenen Status tragen.
function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      const e = new Error('Provider-Timeout');
      e.httpStatus = 503;
      reject(e);
    }, ms);
    promise.then(v => { clearTimeout(to); resolve(v); },
                 e => { clearTimeout(to); e.httpStatus = e.httpStatus || 503; reject(e); });
  });
}

module.exports = { httpErr, withTimeout };
