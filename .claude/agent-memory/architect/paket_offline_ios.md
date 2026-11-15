---
name: paket-offline-ios
description: Architekturentscheidungen Offline-Modus iOS/macOS (Outbox, Idempotenz-Mapping-Tabelle, Snapshot, Boot-Flow, Sync-401-Sicherheit) - Referenz fuer jede kuenftige Offline-/Queue-/Sync-Anforderung
metadata:
  type: project
---

Entscheidungen aus dem Entwurf Offline-Modus Stufe 1 (2026-11-15), wiederverwendbar:

- **Server-Idempotenz fuer Kern-Tabellen ueber eigene Mapping-Tabelle**
  (`client_create_tokens(user_id, client_token, ref_type, ref_id)`, PK user+token)
  statt `client_token`-Spalte an todos/topics: topics haben kein `user_id`, ein
  Mapping erkennt zusaetzlich "angelegt, inzwischen geloescht/verschoben" (410
  statt Duplikat) und Typ-Kollision (409). Replay vor Validierung/Archiv-Guard
  pruefen (Erstanlage war gueltig). better-sqlite3 ist synchron -> Lookup+Insert
  im selben Handler ist race-frei, trotzdem in `db.transaction()`.
- **Erfassungszeitpunkt**: optional, ISO mit Zeitzone, Format-Fehler 400,
  unplausibel (Zukunft >5 min / aelter 365 d) wird auf Server-now geklemmt statt
  abgelehnt (Uhr-Drift darf keine Eintraege "fehlschlagen" lassen).
- **Lokale IDs mit Praefix `local-`** + AppState als Fassade, die Mutationen auf
  lokale IDs in die Outbox umleitet: bestehende Formulare (TodoFormView,
  TopicFormView, ProgressEntryComposer/EditorSheet) bleiben unveraendert
  wiederverwendbar. Zentraler Guard: kein HTTP-Pfad mit `local-`-Segment.
- **Sync-Requests NIE mit transparentem 401-Auto-Renewal**: performRequest
  wuerde nach Re-Login mit (evtl. fremden) Keychain-Daten die Anfrage sofort
  wiederholen -> Queue unter fremdem Konto. Sync ruft Renewal explizit auf und
  prueft danach `user.id == scope.userId`.
- **Offline-Boot**: Probe mit kurzem Timeout (2.5 s, sofort bei NWPath
  unsatisfied) statt checkSession mit 60-s-URLSession-Default. Marker-Datei
  merkt `biometricProtected`; "Anmeldedaten vergessen" darf den Biometrie-Schutz
  des Offline-Bestands nicht aushebeln.
- **Overlay statt Mischen in @Published-Arrays**: Server-Arrays werden nach jedem
  Laden mit Outbox-Overlay neu zusammengesetzt; quittierte Eintraege bleiben als
  `acknowledged` bis ein NACH der Quittung gestarteter Reload sie enthaelt (kein
  kurzes Fehlen/Doppeln).
- **Captive-Portal**: jede Nicht-JSON-Antwort (auch 200/404 HTML) = transient/offline.
- Rate-Limit `lib/progress` (60/10 min) begrenzt Zwischenstand-Sync: clientseitiges
  Budget + 429 als transient mit >=60 s Backoff.
- GraphPositionSync bewusst NICHT in die Outbox verschmolzen (Koaleszierung
  last-write-wins vs. geordnete idempotente Anlage) - begruendete Abweichung.
- Default-Actor-Isolation MainActor (iOS 26, Swift 5 Approachable Concurrency):
  Codable-Encoding von Model-Typen off-main kann an isolierten Konformitaeten
  scheitern -> Encoding auf Main, nur Datei-IO off-main.

Siehe [[paketschnitt-hotspot-dateien]], [[architektur-konventionen-threadstack]].
