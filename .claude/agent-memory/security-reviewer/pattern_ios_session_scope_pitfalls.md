---
name: pattern-ios-session-scope-pitfalls
description: iOS/macOS-Client - wiederkehrende Luecken bei Logout (Cookie bleibt), Session-Renewal (anderes Konto) und nutzergetrennten Caches (Offline-Bestand/GraphCache)
metadata:
  type: project
---

Beim Review des Offline-Modus (2026-11-16) gefundene, strukturell wiederkehrende Risiken im
SwiftUI-Client (AppState.swift + Offline*.swift):

1. **Logout raeumt das Session-Cookie nicht lokal ab.** `AppState.logout()` ruft `POST /logout`
   nur best effort (und offline gar nicht) auf; `HTTPCookieStorage.shared` wird nie fuer die
   Server-URL geleert. Folge: nach Offline-Logout reaktiviert der naechste Start mit Netz per
   `GET /me`-Probe automatisch die alte Sitzung (kein Passwort, keine Biometrie) und laedt alle
   Daten neu - der "lokal alles geloescht"-Purge wird ausgehebelt.
   **How to apply:** bei jeder Aenderung an Logout/Kontowechsel pruefen, ob Cookies fuer die
   Server-URL lokal geloescht werden, UNABHAENGIG vom Erfolg des Server-Calls.

2. **Session-Renewal mit Keychain-Zugangsdaten prueft nicht, ob es dasselbe Konto ist.**
   `Keychain` haelt die zuletzt mit "merken" gespeicherten Daten - Login ohne "merken" loescht sie
   nicht. Renewal (`renewSessionUser`) kann daher als ANDERES Konto anmelden und setzt
   `currentUser` um, waehrend Daten/Scope des alten Kontos aktiv bleiben. Outbox/Sync sind per
   `userMismatch` geschuetzt, andere Cache-Schreiber (z.B. `GraphStore` -> `GraphCache.save(scope:
   activeScope)`) aber nicht.
   **How to apply:** jeder neue Cache-Schreiber, der `offline.activeScope` nutzt, muss
   `currentUser.id == activeScope.userId` pruefen; Renewal sollte fail-closed sein.

3. Positiv/etabliert: `UserScopedFileStore` (sha256-Scope, Allowlist-Dateinamen,
   `.completeFileProtection` beim Schreiben, Backup-Ausschluss) ist die EINE wiederzuverwendende
   Loesung fuer lokale Nutzerdaten (Offline-Bestand, KnowledgeDrafts, GraphCache). Neue lokale
   Persistenz sollte darauf aufsetzen, nicht eigene FileManager-Logik bauen.

Stand 2026-11-16 behoben: zentrale Helfer `AppState.clearLocalSessionCookies()` (Logout, Reject,
fail-closed Renewal) und `AppState.writableOfflineScope` (Graph/Progress-Cache). Neue Logout-/
Kontowechsel-Pfade und neue Cache-Schreiber MUESSEN diese Helfer nutzen statt `activeScope` direkt.
`lib/rate-limit.js` setzt seither `Retry-After` bei 429 fuer alle Nutzer des Moduls.

Server-Seite (lib/client-idempotency): Idempotenz-Mapping ist korrekt pro `user_id` gescoped,
Replay-Loader pruefen Ownership erneut - Referenzmuster fuer kuenftige idempotente Endpunkte.
