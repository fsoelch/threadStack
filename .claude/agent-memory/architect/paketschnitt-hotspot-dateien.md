---
name: paketschnitt-hotspot-dateien
description: Welche Dateien in ThreadStack Merge-Hotspots sind und wie Arbeitspakete geschnitten werden muessen, damit Entwickler-Agenten wirklich parallel arbeiten koennen
metadata:
  type: project
---

In diesem Repo gibt es vier grosse Einzeldateien, die JEDES Feature anfassen will und
die deshalb pro Vorhaben an GENAU EIN Arbeitspaket vergeben werden muessen:
`server.js` (~2500 Z.), `public/app.js` (~7000 Z.), `index.html` (~3200 Z., enthaelt
alle Modals) und `ThreadStackApp/.../ThreadStack.xcodeproj/project.pbxproj`
(plus `AppState.swift`/`Models.swift` auf iOS-Seite).

**Why:** Zwei Pakete, die beide server.js oder app.js editieren, erzeugen garantiert
Merge-Konflikte, weil beide Dateien monolithisch und ohne klare Sektionsgrenzen sind.
Die iOS-Seite hat zusaetzlich das pbxproj-Problem: jede neue Swift-Datei aendert es.

**How to apply:**
- Backend-Fachlogik immer in ein neues `lib/<feature>/`-Verzeichnis (index/schema/
  queries/routes.js, Router-Factory mit Dependency Injection). Das jeweilige Paket
  besitzt nur sein Verzeichnis.
- Ein einziges "Wiring"-Paket besitzt `server.js` (Mounten der Router, Migrations-
  Aufrufe, Anpassungen an Bestandsrouten/Loeschpfaden) und wird zuletzt gemerged.
- Web-Fachlogik in eine neue `public/<feature>.js` + `.css` mit `window.TS<Feature>`-
  Mount-API (Vorbild: `public/progress.js` mit `TSProgress.mountTimeline` und dem
  `TSHost`-Adapter in app.js). Ein separates Integrationspaket besitzt app.js +
  index.html und macht dort nur die Verdrahtung.
- iOS/macOS bleibt EIN Paket (alle Swift-Dateien + pbxproj), weil AppState.swift,
  Models.swift und pbxproj sonst kollidieren.
- Testdateinamen je Paket vorab vergeben (`test/<feature>_*.test.js`), sonst
  kollidieren zwei Pakete an derselben neuen Testdatei.

Siehe auch [[architektur-konventionen-threadstack]].
