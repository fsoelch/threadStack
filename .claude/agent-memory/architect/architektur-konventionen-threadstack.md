---
name: architektur-konventionen-threadstack
description: Wiederkehrende technische Entscheidungen und Fallstricke in ThreadStack (Migrationen, DI-Router, FTS-Index, Ownership von topics, Idempotenz/Rate-Limit-Konventionen)
metadata:
  type: project
---

Wiederkehrende Entscheidungen, die in diesem Projekt bereits etabliert sind und in
neuen Entwuerfen uebernommen (nicht neu erfunden) werden sollten:

- **Migrationen gehoeren ins Feature-Modul**, nicht nach `db/schema.js`
  (Vorbild: `lib/progress/schema.js`, `lib/archive/schema.js`). Ausschliesslich
  additiv, idempotent (CREATE ... IF NOT EXISTS / PRAGMA table_info-Check).
  server.js ruft sie beim Boot in fester Reihenfolge auf. Ordnungsabhaengigkeiten
  zwischen Modulmigrationen explizit im Vertrag festhalten.
- **Router-Factories mit Dependency Injection**: `createXRouter({db, requireAuth,
  ownsRef, isRefReadOnly, now, ...hooks})`. Module importieren NIE aus server.js.
  Cross-Modul-Kopplung (z.B. Aufraeumen fremder Tabellen beim Loeschen) laeuft
  ueber injizierte Hooks statt direkter require-Beziehungen - so bleiben Pakete
  unabhaengig entwickelbar.
- **Ownership-Fallstrick**: `topics` (Meeting-Tagesordnungspunkte) haben KEIN
  eigenes `user_id`. Eigentuemerpruefung immer ueber das zugehoerige Meeting bzw.
  ueber die bestehende `ownsRef(uid, refType, refId)`-Funktion in server.js.
- **Volltextsuche**: `search_index` ist eine manuell per SQL-Trigger gepflegte
  FTS5-Tabelle mit einer Zeile je Objekt. Text aus Kindtabellen darf NICHT als
  eigene FTS-Zeile abgelegt werden, sonst zerfaellt die UND-Verknuepfung ueber
  Felder hinweg. Stattdessen: aggregierte `*_text`-Spalte am Elterndatensatz
  pflegen (Vorbild `knowledge_pages.content_text`) und die bestehenden
  Eltern-Trigger den Index neu schreiben lassen.
- **Fehler-Envelope**: `{ error: 'deutscher Klartext', code: '...' }` via
  `lib/http.js` (`sendError`, `makeInternalErrorHandler`). "Existiert nicht" und
  "gehoert anderem Nutzer" sind immer ununterscheidbar 404.
- **Schreibbegrenzung**: `lib/rate-limit.js` `createRateLimiter` mit dem
  etablierten Profil 60 Aenderungen / 10 Minuten pro Session-User und dem Text
  "Zu viele Aenderungen. Bitte kurz warten." (`code: 'rate_limited'`).
- **Idempotenz beim Anlegen** laeuft ueber ein Client-Token
  (`UNIQUE(user_id, client_token)`), nicht ueber Fachschluessel.
- **Sanitizing**: `lib/sanitize.js` (Allowlist) ist die einzige Sicherheitsgrenze;
  `lib/progress/sanitize.js` ist der Rich-Text-Notiz-Geschmack davon
  (ohne Bilder, 50000 roh / 5000 nach Bereinigung). Neue Rich-Text-Felder wrappen
  diese, sie bauen keine zweite Allowlist.

Siehe auch [[paketschnitt-hotspot-dateien]].
