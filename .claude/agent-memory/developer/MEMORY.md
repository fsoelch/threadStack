- [Resumed session verification](workflow_resumed_session.md) — check git status/diff first, prior run may already be complete
- [Progress module ref_type extension pattern](project_progress_module.md) — SQLite CHECK rebuild pattern, ownership split lib/progress vs server.js
- [progress_web_helpers time-bomb test](pitfall_progress_web_helpers_timebomb.md) — hardcoded dates cause future unrelated failures
- [SQLite rebuild migrations: triggers/FK](pitfall_sqlite_rebuild_triggers_fk.md) — DROP+RENAME rebuilds drop own triggers, CASCADE-delete via FK, crash on foreign triggers referencing the table (needs legacy_alter_table=ON); scope foreign_key_check to the table, run it inside the transaction
- [Shared env under heavy load](pitfall_shared_env_high_load.md) — many parallel agent worktrees cause load 150+, slow test runs aren't deadlocks
- [Xcode project format](xcode_project_format.md) — pbxproj uses synchronized groups, no manual file entries needed for new Swift files
- [Flaky-Test Datumsdrift](flaky_test_date_drift.md) — badgeHtml-Test in progress_web_helpers.test.js bricht kalenderzeitabhaengig (Tage/Wochen-Schwelle), unabhaengig von W1/contacts.js.
- [Assignments-API-Mismatch (behoben 2026-09-05/06)](contacts_assignments_api_mismatch.md) — contacts.js an echte Server-Envelopes (assignments UND info-blocks/categories) angepasst; bei Formatkonflikt IMMER Modul+Dev-Harness+Mocks+E2E-Test gegen echten Server in einem Zug fixen.
- [Worktree-Sandbox vs. "arbeite auf main"](pitfall_worktree_sandbox_vs_main_instruction.md) — Task sagt main-Checkout, Sandbox isoliert trotzdem aufs eigene Worktree; git reset --hard auf main-Tip im eigenen Branch statt cd in shared checkout.

## Session-Auto-Renew AppState.swift (2026-09-11)
- `performRequest` ist der EINZIGE Netzwerk-Kern (von request/aiRequest/
  archiveRequest/knowledgeRequest genutzt) - ein 401-Retry-Wrapper dort
  wirkt automatisch fuer alle vier, ohne sie einzeln anzufassen.
- Renewal-Retry braucht einen `allowSessionRenewal`-Parameter (Default true,
  false beim rekursiven Retry) UND eine Exempt-Liste fuer /login, /logout,
  /me - sonst Deadlock/Endlos-Retry bei falschem Passwort bzw. sinnlose
  Versuche beim Kaltstart ohne Session.
- Test-Seam fuer Keychain-abhaengige Methoden (`tryServerReLogin`, geht ueber
  echte Biometrie-API): oeffentlicher optionaler Closure-Override
  (`sessionRenewalOverride`) auf der Instanz, Produktionscode belaesst ihn
  `nil`. Guenstiger als ein Protokoll-Wrapper um Keychain fuer diesen einen
  Anwendungsfall.
- Parallele Requests, die gleichzeitig auf 401 laufen, muessen sich EINEN
  Renewal-Task teilen (`Task<Bool,Never>?`-Property, zweiter Aufrufer awaited
  `.value` des bestehenden Tasks) - sonst mehrfache Biometrie-Prompts/Re-Login-Race.
- xcodebuild-Testlauf auf diesem Rechner: `CODE_SIGNING_ALLOWED=NO
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO` + Simulator-Destination
  (`platform=iOS Simulator,id=<UDID aus xcrun simctl list devices available>`)
  noetig, da kein "Mac Development"-Signing-Zertifikat vorhanden ist und der
  macOS-Test-Runner in dieser Sandbox mit "test runner hung before
  establishing connection" haengenbleibt (Berechtigungsprobleme mit
  DerivedData/Logs). iOS-Simulator-Ziel funktioniert zuverlaessig.
- `xcodebuild test` mit vielen parallelen Testzielen kann einzelne, fuer
  sich genommen stabile Tests (z.B. GraphPositionSyncTests) unter Last
  spuerbar flakey machen (siehe pitfall_shared_env_high_load.md) - bei
  Failures IMMER zuerst isoliert (`-only-testing:ThreadStackTests/<Suite>`)
  gegen den unveraenderten Stand nachpruefen, bevor man sie dem eigenen
  Arbeitspaket zuschreibt.

## Web Session-Expiry-Redirect (2026-09-11)
- Zentraler `handleSessionExpiry()`-Helper (clearClientSessionState +
  closeAllModals + showLogin({expired:true})) ersetzt 5 vormals dupliziert
  inline geschriebene 401-Checks in public/app.js: api(), linkApiFetch(),
  runExport() (hatten den Check schon, aber dupliziert) sowie die beiden
  rohen fetch()-Attachment-Uploads (rtInsertImage-Inline-Handler,
  uploadAttachment) und der Wissenseditor-Bildupload - beide hatten
  VORHER GAR KEINEN 401-Check (echte Sicherheitsluecke: Upload nach
  Sitzungsende schlug nur mit generischem Fehlertoast fehl, ohne zum Login
  zurueckzukehren).
- `closeAllModals()` nutzt bewusst den generischen `.modal-overlay`-Selektor
  statt eine feste ID-Liste - erfasst automatisch neue Modals und umgeht
  gezielt jede "Verwerfen?"-Bestaetigung einzelner Modals (UX-Vorgabe bei
  Sitzungsende).
- `showLogin({expired})`-Signaturaenderung ist abwaertskompatibel (Default
  `{}`), bestehende Aufrufer (`doLogout()`, App-Bootstrap-Catch) bleiben
  unveraendert und zeigen den neuen Hinweistext NICHT.
- Frontend-Test-Pattern fuer index.html+app.js: jsdom mit
  `runScripts:'dangerously'`, externes `<script src>` durch Inline-Skript
  ersetzen, `window.fetch` je Test mocken, `window.eval()` fuer
  Top-Level-`let/const`-State (nicht als window-Property erreichbar), aber
  `function`-Deklarationen sind normal ueber `window.<name>` aufrufbar.
  Cross-Realm-Arrays/Objekte aus dem jsdom-window scheitern an
  `assert.deepStrictEqual` (Prototyp-Identitaet) - `.length`/einzelne Felder
  statt ganzer Objekte vergleichen.
- Bekannte, UNABHAENGIGE Vorbestehende Testfehler (nicht durch dieses oder
  vorige Pakete verursacht, nicht anfassen): `archive_readonly_guard.test.js`
  "Attachment-Lesen/Download bleibt erlaubt..." (500 statt 200, reproduzierbar
  isoliert), `progress_web_helpers.test.js` badgeHtml (siehe
  flaky_test_date_drift.md), eine Contacts-E2E-Rubrik-Zwangsloeschung.

## "Schlafen bis"-Kurzoption + Speichern-Button-Kontrast abgeschlossen (2026-09-11)
- Vorgefundener Stand (aus unterbrochenem frueheren Lauf) war inhaltlich fast
  vollstaendig: Requirements+UX bereits im Lastenheft dokumentiert, Server-
  Defensive-Fix (`req.body || {}`), progress.js/css-Implementierung, sowie
  3 Testdateien (progress_composer_snooze, progress_css_button_tokens,
  Erweiterung von web_todo_overview) waren fertig und gruen.
- EINZIGER echter Fund beim Abschluss-Review: `public/app.js#api()` setzte
  nur `err.status`/`err.body`, nicht `err.code` - dadurch liefen die
  code-basierten Zweige in `progress.js#mapError`/`#mapSnoozeError`
  (rate_limited/ARCHIVED_READONLY/ref_done) seit ihrer Einfuehrung tot,
  betraf auch den LAENGST bestehenden "Speichern"-Button, nicht nur die neue
  Option. Fix + Regressionstest ergaenzt (siehe security-reviewer/MEMORY.md).
- Nicht angefasste, erkennbar fremde/verwaiste Dateien im Arbeitsverzeichnis
  (nicht Teil dieses Features, nicht committen ohne Rueckfrage):
  `test/zz_attach_repro.test.js` (Debug-Scratch-Test, kein Teil der Suite-
  Konvention `test/*.test.js`-Namensmuster, aber wird von `npm test`
  trotzdem mitgesammelt), `CLAUDE_orig.md`, `Claude_Agent_team.zip`,
  `Claude_Agent_team/` (alte Agenten-Framework-Kopie vor Migration auf
  `.axet-code/skills/`), `data.db-shm`/`data.db-wal` (Artefakte eines
  manuellen `npm start`-Laufs).
