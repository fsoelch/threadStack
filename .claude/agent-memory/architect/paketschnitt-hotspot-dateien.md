---
name: paketschnitt-hotspot-dateien
description: Welche Dateien in ThreadStack Merge-Hotspots sind und wie Arbeitspakete geschnitten werden muessen, damit Entwickler-Agenten wirklich parallel arbeiten koennen (inkl. iOS-Schnitt seit synchronisierten Xcode-Gruppen)
metadata:
  type: project
---

In diesem Repo gibt es grosse Einzeldateien, die JEDES Feature anfassen will und
die deshalb pro Vorhaben an GENAU EIN Arbeitspaket vergeben werden muessen:
`server.js` (~2650 Z.), `public/app.js` (~7000 Z.), `index.html` (~3200 Z., enthaelt
alle Modals), iOS: `AppState.swift` (~1500 Z.), `Models.swift`, `ThreadStackApp.swift`
(RootView + Kompositionswurzel), `ContentView.swift`.

**Why:** Zwei Pakete, die beide server.js oder app.js editieren, erzeugen garantiert
Merge-Konflikte, weil beide Dateien monolithisch und ohne klare Sektionsgrenzen sind.

**project.pbxproj ist KEIN Hotspot mehr fuer neue Dateien** (verifiziert 2026-11-15):
das Xcode-Projekt nutzt `PBXFileSystemSynchronizedRootGroup` (objectVersion 77) fuer
ThreadStack/, ThreadStackTests/, ThreadStackUITests/ - neue Swift-Dateien werden ohne
pbxproj-Aenderung automatisch Teil des Targets. pbxproj nur noch bei Build-Settings/
Versionsnummer anfassen (dort liegen oft uncommittete Versions-Bumps des Menschen).

**How to apply:**
- Backend-Fachlogik immer in ein neues `lib/<feature>/`-Verzeichnis (index/schema/
  queries/routes.js, Router-Factory mit Dependency Injection). Kleine Server-Features
  (Modul + Wiring) duerfen EIN Paket sein, wenn kein zweites Paket server.js braucht.
- Web: neue `public/<feature>.js` + Integrationspaket fuer app.js/index.html.
- iOS kann seit den synchronisierten Gruppen in mehrere Pakete geschnitten werden:
  (1) Basis-Paket mit NEUEN Dateien fuer Modelle/Persistenz/Status-ObservableObject,
  (2) Logik-Paket(e) mit neuen Dateien, die gegen Closure-Buendel statt gegen AppState
  programmieren, (3) UI-Pakete mit disjunkten View-Dateien, (4) EIN Integrationspaket
  fuer AppState/ThreadStackApp/ContentView/AppLock/LoginView. Fallstrick: Views, die ein
  neues `@EnvironmentObject` konsumieren, crashen zur Laufzeit, solange die Injektion
  (Integrationspaket) fehlt - solche UI-Pakete erst NACH dem Integrationspaket mergen.
- Testdateinamen je Paket vorab vergeben (`test/<feature>_*.test.js`,
  `ThreadStackTests/<Feature>*Tests.swift`).
- Vor dem Schnitt `git status` pruefen: uncommittete Fremdaenderungen in Dateien eines
  Pakets explizit melden (Worktrees starten vom letzten Commit).

Siehe auch [[architektur-konventionen-threadstack]], [[paket-offline-ios]].
