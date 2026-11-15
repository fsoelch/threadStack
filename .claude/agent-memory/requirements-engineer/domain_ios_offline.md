---
name: domain-ios-offline
description: Netzwerk-/Persistenz-Fakten der iOS/macOS-App (ThreadStackApp) und Lastenheft-Grundsaetze, die bei Offline-/Sync-/Cache-Anforderungen relevant sind
metadata:
  type: project
---

Stand 2026-11-15 (Offline-Modus-Analyse) - vor Wiederverwendung am Code verifizieren:

- Die App hat KEINE eigene "Idee"/Inbox-Entitaet. "Ideen festhalten" landet fachlich
  bei Todo (Meine Todos), Thema (`topics`, an ein Meeting gebunden), Zwischenstand
  oder Wissensseite - immer als offene Frage klaeren, Default-Empfehlung: Todo.
- Alle Daten liegen nur im Speicher von `AppState` (@Published-Arrays), gefuellt
  ueber `loadAll()`. Kaltstart ohne Netz: `checkSession()` scheitert -> LoginView
  bzw. LockScreen, dessen `unlockAndAutoLogin()` ebenfalls einen Server-Login
  braucht -> App offline faktisch unbenutzbar.
- Bereits existierende Offline-Bausteine (Wiederverwendung vor Neuentwicklung):
  `GraphCache` (Snapshot in Application Support, beim Logout geloescht),
  `GraphPositionSync` (Warteschlange mit Retry), `KnowledgeDraftStore`
  (pro Nutzer gehasht, completeFileProtection, beim Logout geloescht),
  Zwischenstand-`client_token` (serverseitig UNIQUE pro Nutzer = idempotent).
- Server: POST /todos und POST /meetings/:id/topics haben KEIN Idempotenz-Token
  (Retry nach verlorener Antwort = Duplikat). PUT /todos und PUT topics haben
  KEINE Konflikterkennung (last-write-wins), obwohl `updated_at` existiert;
  Client-`TodoItem` kennt kein `updatedAt`. Einziges Vorbild fuer optimistische
  Konflikterkennung: `expectedUpdatedAt` -> 409 `block_conflict` (Kontakt-Infobloecke).
- Lastenheft Kap. 6 "Abgrenzung" sagt ausdruecklich "Kein Offline-Modus"; Kap. 5.4
  "alle fachlichen Daten verbleiben auf dem Server". Bei Anforderungen, die einen
  dort genannten Ausschluss aufheben, im Lastenheft-Eintrag den Widerspruch
  explizit benennen (Kapitel nicht umschreiben).
- iOS und macOS teilen dieselbe Codebasis (AppState) - "nur iOS" ist meist
  eine offene Frage, nicht selbstverstaendlich.

**Why:** Diese Fakten waren nur durch Code-Lesen zu finden und bestimmen den
Zuschnitt jeder Offline-/Sync-Anforderung.
**How to apply:** Bei Offline-, Cache-, Sync- oder "Duplikat"-Anforderungen zuerst
hier nachsehen, dann am aktuellen Code verifizieren. Verwandt: [[domain-progress-mechanik]].
