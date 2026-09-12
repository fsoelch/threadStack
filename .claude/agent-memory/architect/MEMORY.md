# Architect Memory

- [Paketschnitt: Hotspot-Dateien](paketschnitt-hotspot-dateien.md) — server.js, app.js, index.html, pbxproj gehoeren je genau EINEM Paket; Fachlogik in neue Module.
- [Architektur-Konventionen ThreadStack](architektur-konventionen-threadstack.md) — Modul-Migrationen, DI-Router, FTS-Aggregation, topics-Ownership, Fehler-Envelope, Rate-Limit-Profil.
- [Paketschnitt Momentum-Feature](paket_momentum.md) — additives Antwortfeld statt Extra-Request fuer Sofort-Feedback, Client-Zeitzone statt gespeicherter Zeitzone, Migration neuer Spalten auf Fremdtabellen im Feature-Modul.

## Session-Renewal-Architektur (2026-09-11)
- Bei "401 automatisch abfangen" IMMER pruefen, ob `login`/`logout`/`/me`-Probe-
  Aufrufe von der Auto-Retry-Wrapper-Logik ausgenommen sind - sonst Gefahr von
  Endlos-Rekursion (Login-Endpunkt selbst liefert bei Fehlversuch ebenfalls 401)
  oder doppeltem Biometrie-Prompt beim Lock-Screen-Unlock-Flow.
- Nebenlaeufige 401s duerfen nur EINEN Renewal-Versuch anstossen (gemeinsamer
  `Task`, von allen Aufrufern awaited), sonst parallele Keychain-Prompts/
  Re-Login-Race.
