'use strict';
// In-Prozess-Zwischenspeicher für abgerufene Linkinhalte, bevor der Nutzer
// eine KI-Zusammenfassung anfordert (POST /api/ai/link/fetch → Token,
// POST /api/ai/link/summarize → Token einlösen). Bewusst NUR im
// Prozessspeicher (Map), keine Persistierung — der Seiteninhalt landet nie
// in der Datenbank oder in Logs.
//
// Sicherheitseigenschaften:
//  - Ein Token ist zwingend an die userId gebunden, die ihn erzeugt hat.
//    `take(userId, token)` liefert bei falschem userId ODER unbekanntem/
//    abgelaufenem Token identisch `null` — die Existenz eines fremden
//    Tokens darf für einen Angreifer nicht unterscheidbar sein.
//  - `take()` liest, ohne zu löschen: der Nutzer kann "Neu erzeugen" mit
//    demselben page_token mehrfach anstoßen (z. B. für andere `length`-Werte),
//    solange der Eintrag nicht abgelaufen ist.
//  - Kein Logging des Seiteninhalts oder der URL an dieser Stelle.
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX_PER_USER = 10;

// token -> { userId, page, createdAt, expiresAt }
const store = new Map();

function put(userId, page) {
  sweep();

  // Ältesten Eintrag dieses Nutzers entfernen, wenn das Limit erreicht ist.
  const usersEntries = [];
  for (const [token, entry] of store) {
    if (entry.userId === userId) usersEntries.push([token, entry]);
  }
  if (usersEntries.length >= MAX_PER_USER) {
    usersEntries.sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = usersEntries.length - MAX_PER_USER + 1;
    for (let i = 0; i < toRemove; i++) store.delete(usersEntries[i][0]);
  }

  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  store.set(token, { userId, page, createdAt: now, expiresAt: now + TTL_MS });
  return token;
}

function take(userId, token) {
  if (!token || typeof token !== 'string') return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  // Bewusst identisches Ergebnis (null) wie "Token unbekannt" — kein
  // Informationsleck über Existenz fremder Tokens.
  if (entry.userId !== userId) return null;
  return entry.page;
}

function sweep() {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (now > entry.expiresAt) store.delete(token);
  }
}

module.exports = { put, take, sweep, TTL_MS, MAX_PER_USER };
