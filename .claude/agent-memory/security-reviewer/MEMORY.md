# Security-Reviewer Memory — personly / ThreadStack

## Index (Details in den verlinkten Dateien)

- [escJsAttr vs. escHtml](pattern_escjsattr_vs_eschtml.md) — wirkungsloses onclick-Escaping in app.js, CSP erlaubt unsafe-inline
- [Privates-Rubrik-Invariante](pattern_private_rubrik_label_invariante.md) — Datenschutzfilter haengt am veraenderbaren Label statt an einem Flag
- [Momentum-Schreibrouten brauchen Rate-Limit von Anfang an](pattern_momentum_writes_need_rate_limit.md) — neue lib/<feature>/routes.js-Module sofort mit dem etablierten 60/10min-Profil ausstatten, nicht erst im Review nachziehen
- [Client/Backend-Envelope-Drift](pattern_client_backend_envelope_drift.md) — Clients + Test-Mocks nehmen flache Arrays an, Backend liefert Envelopes
- [Backup-Restore Double-Fault-Falle](pattern_backup_restore_double_fault.md) — fehlschlagender Revert-Versuch wurde faelschlich als reverted:true gemeldet; os.tmpdir() fuer sensible Zwischendateien vermeiden

## Wiederkehrende, bereits etablierte sichere Muster (als Referenz fuer neue Endpunkte)

- **Topic-Zuordnungs-Endpunkte** (`PUT /api/knowledge/:id/themes`,
  `PUT /api/todos/:id/themes`): einheitliches Muster - Ownership-Check auf
  der Ressource selbst (`WHERE id=? AND user_id=?`), dann Filtern der
  angefragten `themeIds` gegen `themes WHERE user_id=?` (fremde/geloeschte
  IDs werden stillschweigend verworfen, `droppedCount` statt Fehlermeldung
  mit Existenz-Auskunft). Neue "Owner setzt Many-to-Many-Zuordnung"-
  Endpunkte sollten dieses Muster wiederverwenden statt neu zu erfinden.
- **Kontakte/Zustaendigkeiten** (`lib/contacts/routes.js#resolveContact`,
  `lib/contacts/assignments/queries.js#assertOwnsRef`/`resolveContact`):
  einheitlich 404 fuer "existiert nicht" UND "fremder Owner", jede
  verschachtelte Ressource (Infoblock, Rubrik, Zuordnung) zusaetzlich
  `WHERE ... AND user_id=?`. Cross-Tenant-Probes (Lesen/Aendern/Loeschen
  fremder Kontakte, Infobloecke ueber eigene contactId, fremde categoryId,
  fremdes Todo als Zuordnungsziel) am 2026-09-06 empirisch alle sauber.
  Als Referenz fuer neue verschachtelte Endpunkte wiederverwenden.
- Alle SQL-Statements im Projekt nutzen durchgehend parametrisierte
  Queries (`?`-Platzhalter, IN-Klauseln ueber
  `ids.map(()=>'?').join(',')` + Spread der Werte) - kein String-
  Interpolieren von Nutzereingaben in SQL beobachtet.
- iOS `APIError.server(String)` transportiert nur die vom Server selbst
  gesetzten, bereits nutzerverstaendlichen deutschen Fehlermeldungen
  (z.B. "Nicht gefunden") - keine Stacktraces/interne Pfade. Beim
  Hinzufuegen neuer `.errorAlert($error)`-Anzeigen ist das unkritisch,
  SOLANGE der Server weiterhin nur solche Meldungen liefert.

## Ein bereits bekanntes Muster, das bei neuen AppState-Netzwerkmethoden zu pruefen ist

- Frueher swallowten `themeKnowledge`/`themeTodos` in AppState.swift JEDEN
  Fehler (inkl. 401) per `try? ... ?? []` und liessen ihn wie einen leeren
  Datensatz aussehen (kein Sicherheitsfund im engeren Sinne, aber ein
  Fehlerbehandlungs-Antipattern, das reale Bugs verschleiert hat). Bei
  neuen `async -> [T]`-Helpers mit `try?`-Fallback in AppState.swift
  gezielt nachfragen, ob ein Fehler wirklich unterschlagen werden darf.

## Session-Auto-Renew (2026-09-11) — positives Muster fuer kuenftige Reviews
- `tryServerReLogin()`/Keychain.load() nutzen `kSecAttrAccessControl` mit
  `.userPresence` - JEDER automatische Re-Login-Versuch verlangt weiterhin
  einen Face-ID/Touch-ID-Prompt (neuer `LAContext()` pro Aufruf, kein
  Caching/Skip). Automatische Sitzungserneuerung untergraebt damit NICHT
  den Session-Timeout als Zugriffskontrolle - es ersetzt nur den manuellen
  Login-Tap durch einen Prompt. Bei kuenftigen "automatisch erneuern"-
  Feature-Wuenschen gezielt pruefen, ob dieselbe Garantie erhalten bleibt
  (kein `kSecUseAuthenticationUISkip` im Renewal-Pfad).
- Serverseitiger Login-Rate-Limiter (`isLoginBlocked`/`recordFailedLogin`,
  10 Fehlversuche/15 Min) deckt automatisch auch automatisierte
  Renewal-Versuche ab, da `tryServerReLogin()` denselben `/api/login`-
  Endpunkt aufruft - kein zusaetzlicher Schutz im Client noetig.
- Bei parallelen 401-Retry-Mechanismen: pruefen, ob mehrere gleichzeitige
  Requests sich EINEN Renewal-Versuch teilen (gemeinsamer Task) statt pro
  Request einen eigenen Login-Call/Biometrie-Prompt auszuloesen - sonst
  unnoetige Amplifikation gegen den Login-Endpunkt.

## Schlafen-bis-Kurzoption + api()-Fehlercode-Luecke (2026-09-11)
- Feature nutzt bewusst KEINEN neuen Endpunkt (Wiederverwendung PUT
  /todos/:id bzw. PUT /meetings/:mid/topics/:tid) - Ownership-Check,
  Rate-Limiting, isValidDate()-Validierung und ARCHIVED_READONLY-Guard sind
  dadurch automatisch mitgeerbt, kein neuer Pruefpfad noetig.
- Gefunden (Code-Review, kein Sicherheitsfund im engeren Sinne, aber
  Fehlerbehandlungs-Bug): `public/app.js#api()` setzte bislang NUR
  `err.status`/`err.body` auf geworfenen Fehlern, nicht `err.code` (anders
  als das bereits existierende `linkApiFetch()`). Dadurch liefen die
  code-basierten Zweige in `progress.js#mapError`/`#mapSnoozeError`
  (`code==='rate_limited'`, `code==='ARCHIVED_READONLY'`, `code==='ref_done'`)
  seit ihrer Einfuehrung tot - betraf NICHT nur die neue Schlafen-bis-Option,
  sondern auch den bestehenden Zwischenstand-"Speichern"-Button. Fix:
  `err.code = data.code;` in `api()` ergaenzt (Server-Envelope ist
  `{error, code, ...extra}`, siehe `server.js#fail()`). Bei kuenftigen
  Reviews von Fehlerbehandlung in progress.js/app.js: IMMER pruefen, ob
  ein `err.code`-Zweig ueberhaupt erreichbar ist (welche Funktion wirft den
  Fehler, setzt sie `.code`?), nicht nur ob die Zuordnungslogik selbst
  plausibel aussieht.

## Einklappbare "Mehr"-Gruppe ToDos-Nav (2026-09-17)
- Reine UI-/Layout-Aenderung (Web: index.html/app.js Gruppierung+Persistenz
  via localStorage-Bool; iOS/macOS: SidebarView.swift DisclosureGroup+
  @AppStorage-Bool). Keine neuen Endpunkte, keine neuen Daten, keine
  Nutzereingaben, die in innerHTML/SQL/Dateipfade fliessen - OWASP-Review
  ergab keine Funde. Gespeicherter Wert ist ausschliesslich ein Bool-Flag
  (kein PII/Secret), defensiv geparst (`=== '1'`).
