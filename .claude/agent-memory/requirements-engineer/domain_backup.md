---
name: domain-backup
description: Begriffsabgrenzung DB-Backup/Restore (Admin) vs. bestehendes Nutzer-Export-Feature - Referenz fuer kuenftige Anforderungen zu Datensicherung
metadata:
  type: project
---

- "Backup" (neues Admin-Feature, Web-only) meint ein vollstaendiges
  Snapshot der SQLite-Datenbank (alle Nutzer/Tabellen), NICHT das
  bestehende `export/`-Modul (`GET /api/export`) - das ist ein
  PRO-NUTZER Inhalts-Export (eigene Todos/Wissen als docx/xml), kein
  DB-Level-Backup und nicht admin-beschraenkt. Beide Begriffe bei
  Nutzeranfragen zu "Sicherung"/"Backup" klar auseinanderhalten, am Code
  verifizieren statt zu raten.
- Hochgeladene Anhaenge (`data/uploads`) sind bei "DB-Backup"-Anfragen im
  Zweifel NICHT mitgemeint, sofern der Nutzer nicht explizit "alle
  Dateien"/"Anhaenge" erwaehnt - nur die Datenbank selbst.
- Bestehendes Scheduler-Muster fuer "zu einer bestimmten Zeit automatisch"
  (z.B. Wochen-Digest): `ai/jobs.js` tickt stuendlich per `setInterval`,
  vergleicht `now.getHours()`/`getDay()` gegen eine gespeicherte
  Konfiguration, dedupliziert ueber ein eindeutiges Datums-/Wochenmerkmal,
  plus 30s-Catch-up-Tick nach Prozessstart fuer verpasste Fenster waehrend
  eines Restarts. Neue "taeglich/woechentlich zu Uhrzeit X"-Anforderungen
  sollten dieses Muster referenzieren statt ein neues Scheduling-Konzept
  zu erfinden - Praezision ist stundengenau, nicht minutengenau.
