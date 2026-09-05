'use strict';
// ABWEICHUNG vom Architektur-Vertrag (Arbeitspaket B3, siehe Abschlussbericht):
// Der Vertrag verweist auf ein gemeinsames `lib/rate-limit.js` mit
// `createRateLimiter`. Zum Zeitpunkt der Umsetzung existiert diese Datei im
// Bestand noch nicht; die einzige vorhandene Rate-Limit-Implementierung im
// Projekt ist eine lokale, In-Memory-Sliding-Window-Lösung direkt in
// export/index.js (checkExportRate). Um innerhalb der zugewiesenen
// Modul-Eigentümerschaft zu bleiben, wird hier eine funktionsgleiche lokale
// Express-Middleware nach demselben Muster bereitgestellt. Entsteht später
// ein echtes lib/rate-limit.js, sollte dieses Modul darauf umgestellt werden.

function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> timestamps[]

  return function rateLimit(req, res, next) {
    const key = (req.session && req.session.uid) || req.ip || 'anon';
    const now = Date.now();
    const filtered = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (filtered.length >= max) {
      // Nachbesserung Code-Review Fund 12: das getrimmte (statt des alten,
      // ungetrimmten) Array zurückschreiben, damit pro Schlüssel nicht
      // unbegrenzt viele Timestamps akkumulieren.
      //
      // Kein aktives Cleanup abgelaufener KEYS (die Map wächst über die Zeit
      // um die Anzahl unterschiedlicher Nutzer/IPs) — bei Umstellung auf ein
      // projektweites lib/rate-limit.js sollte das dort einheitlich gelöst
      // werden. Für dieses modul-lokale Limiter-Muster mit sitzungsgebundenen
      // Keys ist das unkritisch (begrenzte Anzahl aktiver Nutzer).
      hits.set(key, filtered);
      return res.status(429).json({
        error: 'Zu viele Anfragen. Bitte kurz warten.',
        code: 'RATE_LIMITED',
      });
    }
    filtered.push(now);
    hits.set(key, filtered);
    next();
  };
}

module.exports = { createRateLimiter };
