'use strict';
// Generisches In-Memory Sliding-Window Rate-Limiting als Express-Middleware.
//
// Bewusst getrennt von den bestehenden Ad-hoc-Limitern in server.js
// (Passwortänderung, Link-Fetch) und export/index.js (Export-Endpunkt) - diese
// bleiben unangetastet, siehe Arbeitspaket S1. Dieses Modul ist die
// wiederverwendbare Basis für alle NEUEN Routen, die ein Sliding-Window
// benötigen (aktuell: lib/progress/routes.js).

/**
 * Erstellt eine Express-Middleware, die pro `key(req)` maximal `max` Treffer
 * innerhalb eines gleitenden Zeitfensters von `windowMs` Millisekunden zulässt.
 *
 * @param {object} opts
 * @param {number} opts.windowMs Fenstergröße in Millisekunden (> 0)
 * @param {number} opts.max Maximal erlaubte Treffer pro Fenster (> 0)
 * @param {(req: import('express').Request) => string|null|undefined} [opts.key]
 *   Liefert den Rate-Limit-Schlüssel für eine Anfrage (z.B. userId aus der
 *   Session). Default: `req.session?.uid`. Liefert die Funktion einen
 *   falsy-Wert, wird die Anfrage NICHT limitiert (z.B. weil noch keine
 *   Auth-Middleware gelaufen ist) - Aufrufer müssen `requireAuth` daher VOR
 *   diesem Limiter registrieren, wenn der Key aus der Session stammt.
 * @param {string} [opts.message] Fehlermeldung im 429-Body (`error`-Feld).
 * @param {string} [opts.code] Fehlercode im 429-Body (`code`-Feld).
 * @param {() => number} [opts.now] Zeitquelle (Default: `Date.now`), injizierbar für Tests.
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(opts) {
  const { windowMs, max } = opts || {};
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimiter: windowMs muss > 0 sein');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createRateLimiter: max muss > 0 sein');
  }
  const keyFn = typeof opts.key === 'function' ? opts.key : (req) => req.session && req.session.uid;
  const message = typeof opts.message === 'string' ? opts.message : 'Zu viele Anfragen. Bitte kurz warten.';
  const code = typeof opts.code === 'string' ? opts.code : 'rate_limited';
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;

  // key -> Array aufsteigend sortierter Zeitstempel (ms) der Treffer im Fenster.
  const hits = new Map();

  return function rateLimitMiddleware(req, res, next) {
    let key;
    try {
      key = keyFn(req);
    } catch (_) {
      key = undefined;
    }
    if (!key) return next();

    const now = nowFn();
    let arr = hits.get(key);
    if (!arr) {
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length && now - arr[0] > windowMs) arr.shift();

    if (arr.length >= max) {
      return res.status(429).json({ error: message, code });
    }
    arr.push(now);
    next();
  };
}

module.exports = { createRateLimiter };
