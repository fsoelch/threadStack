---
name: pattern-momentum-writes-need-rate-limit
description: Neue schreibende Endpunkte in ThreadStack muessen von Anfang an das etablierte Rate-Limit-Profil (60/10min) bekommen, nicht erst nachtraeglich im Review nachgezogen werden
metadata:
  type: pattern
---

Beim Sichtbarer-Fortschritt-Feature (`lib/momentum/routes.js`) fehlte in der
ersten Entwicklerfassung die Rate-Begrenzung auf `PUT /settings`,
`POST /pause-days`, `DELETE /pause-days/:date` - obwohl `lib/progress/
routes.js` und `lib/contacts/assignments/router.js` das etablierte Profil
(`createRateLimiter({windowMs: 10*60*1000, max: 60})`, siehe
`lib/rate-limit.js`) fuer JEDE schreibende Route bereits vormachen.

**Why:** Ohne Limiter kann ein authentifizierter Nutzer (oder ein
kompromittiertes Session-Cookie) beliebig viele Schreibvorgaenge pro
Sekunde ausloesen - bei Pausentagen zusaetzlich unnoetiges DB-Wachstum.

**How to apply:** Bei JEDEM neuen `lib/<feature>/routes.js`-Modul mit
schreibenden Routen (`PUT`/`POST`/`DELETE`) sofort beim ersten Entwurf
`writeLimiter = createRateLimiter({...})` importieren und an ALLE
schreibenden Handler haengen - nicht erst als Nachbesserung im
Code-/Security-Review. Der Reviewer sollte bei jedem neuen Router aktiv
per Grep nach `router.(put|post|delete)` suchen und fuer jeden Treffer
pruefen, ob ein Rate-Limiter registriert ist.

Bereits VOR diesem Feature bekannte, unabhaengige Luecke (nicht durch
Momentum verursacht, nicht in diesem Fund behoben): die BESTEHENDEN Routen
`PUT /api/todos/:id` und `PUT /api/meetings/:id/topics/:tid` in `server.js`
haben ebenfalls KEINEN Rate-Limiter (nur Login/Passwortaenderung/Link-Fetch
sind serverseitig begrenzt) - relevant fuer kuenftige Anforderungen an
diesen beiden Routen, aber ausserhalb des Scopes des aktuellen Features.
