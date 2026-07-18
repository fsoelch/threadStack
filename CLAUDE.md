# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ThreadStack — Projekt-Überblick

Meeting- und Todo-Verwaltung. Zwei getrennte Clients (Web-App + native iOS/macOS-App) sprechen gegen denselben Node.js-Server.

---

## Web-App (Node.js)

### Befehle

```bash
npm start               # Server starten (Port 3000, Pfad /notes)
npm test                # Gesamte Test-Suite (node --test)
npm run ai:test         # AI-Provider-Verbindungstest
npm run digest:weekly   # Wochen-Digest manuell auslösen
```

Einzelnen Test ausführen:
```bash
node --test --test-force-exit test/smoke.test.js
```

### Umgebungsvariablen

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `BASE_PATH` | `/notes` | URL-Präfix (alle API-Pfade: `BASE_PATH/api/v1/...`) |
| `DATA_DIR` | `./data` | Verzeichnis für SQLite-DB, Session-Secret, Uploads |
| `TRUST_PROXY` | — | Auf `1` setzen wenn hinter nginx/Reverse-Proxy |
| `AI_PROVIDER_OVERRIDE` | — | `mock` für Tests ohne echten AI-Provider |

### Architektur

**`server.js`** — einzige Datei für HTTP + DB + Auth (kein Aufbrechen erlaubt außer `ai/`):
- Startup: SQLite-Verbindung, idempotente Migrationen via `PRAGMA table_info` + `ALTER TABLE`, Seed-Admin, Session-Setup
- Auth: `requireAuth` / `requireAdmin` Middleware; Cookie-Session; Login-Rate-Limiting via In-Memory-Map; `DUMMY_HASH` für timing-sicheres Bcrypt bei ungültigem Username
- Schlüsselfunktionen: `uid()` (TEXT-IDs), `stripUnsafeHtml()` (Allowlist-basiert), `parseMeeting/parseTopic/parseTodo/parseContact()` (DB-Row → JSON), `displayHtml()` im Frontend

**`index.html`** — einzige Datei für gesamte Web-UI (HTML + CSS + JS inline):
- Render-Zyklus: `render()` → `renderSidebar()` + `renderMain()` + `renderTodosNav()`
- State: globale JS-Variablen (`meetings`, `todos`, `themes`, `contacts`, `selectedId`, `showPrivateTodos`, ...)
- Modal-Pattern: `<div class="modal-overlay">` mit `display:none/flex`; `overlayClick()` schließt bei Hintergrund-Klick
- Rich-Text-Editor: eigener `contenteditable`-Editor (`initRtToolbar`, `rtCmd`, `getRT`, `setRT`); kein externes Framework
- API-Helper: `await api(method, path, body?)`; wirft bei Fehler mit `message`
- Konfirmations-Dialog: `confirmDelete(...)` / `closeConfirm()` / `executeConfirm()`
- Drag & Drop für Meetings, Topics und Todos: je eigener `*DragStart/Drop/End`-Block, persistiert via `PUT .../reorder`

**`ai/`** — AI-Schicht (strikt getrennt von `server.js`):
- `index.js` — Entry-Point; `interpolate(template, data)` für `{{platzhalter}}`-Templates
- `providers/` — Adapter-Dateien mit einheitlicher Signatur: `callModel({system, user, maxTokens, json, apiKey, model})` / `testConnection(...)`
- `prompts/` — Markdown-Templates
- `cost.js` / `usage.js` — Budget-Tracking; Budget-Check **vor** jedem Aufruf; Protokoll in `ai_usage`-Tabelle
- `crypto.js` — AES-256-GCM für API-Keys; Schlüssel in `data/.encryption-key`

### API-Routen (Übersicht)

Alle Routen unter `BASE_PATH/api/v1/`:

| Präfix | Ressource |
|---|---|
| `/meetings`, `/meetings/:id/topics/...` | Meetings + Topics |
| `/todos`, `/todos/reorder` | Persönliche Todos |
| `/themes`, `/themes/:id/links` | Themen + Verknüpfungen |
| `/contacts` | Ansprechpartner |
| `/stack/push`, `/stack/pop/:frameId`, `/stack/history` | Stack-Layer |
| `/ai/meeting/:id/brief`, `/ai/meeting/:id/capture` | AI-Features |
| `/ai/digest/weekly`, `/ai/insights/cross-meeting/:id` | Digest + CMI |
| `/attachments/:refType/:refId` | Dateianhänge |
| `/users` (requireAdmin) | Benutzerverwaltung |

### Datenbank-Konventionen

- Alle IDs: `TEXT` (kein INTEGER), erzeugt via `uid()` (6 Zufalls-Bytes hex)
- Migrationen: nur additiv (`ALTER TABLE ... ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`); bestehende Spalten nie ändern
- `stripUnsafeHtml()` auf alle gespeicherten HTML-Felder anwenden; API-Keys nie loggen

### HTTP-Fehlercodes (AI)

`402` Budget | `409` nicht konfiguriert/deaktiviert | `422` ungültiges JSON (nach 1× Retry) | `428` Kostenbestätigung nötig (→ mit `?confirm=true` wiederholen) | `503` Provider-Fehler

---

## Native App (Swift/SwiftUI)

### Build & Test

```bash
# Im Verzeichnis ThreadStackApp/ThreadStack/
xcodebuild -scheme ThreadStack -destination 'platform=macOS' build
xcodebuild -scheme ThreadStack -destination 'id=<simulator-id>' build

# Verfügbare Destinations anzeigen:
xcodebuild -scheme ThreadStack -showdestinations

# Tests (aus ThreadStackApp/ThreadStack/):
xcodebuild -scheme ThreadStack -destination 'platform=macOS' test
```

### Architektur

**`AppState.swift`** — einziger `@MainActor ObservableObject`; hält allen App-State:
- `@Published`: `meetings`, `todos`, `themes`, `contacts`, `stackFrames`, `aiSettings`, `driftIds`, `cmiByMeeting`, `isLocked`, `isRefreshing`
- `serverURL` wird in `UserDefaults` persistiert; Credentials in `Keychain.swift`
- Auto-Refresh alle 60 Sekunden + manueller Pull-to-Refresh; `loadAll()` lädt alle Ressourcen parallel
- API-Requests: generische `request<T: Decodable>` / `requestOK`-Methoden; wirft `APIError` oder `APIAIError`

**`Models.swift`** — alle Codable-Structs (`Meeting`, `Topic`, `TodoItem`, `Contact`, `StackFrame`, `AISettings`, ...); keine Logik außer berechneten Properties (Datums-Formatierung, `isSnoozed`, `dueStatus`, `openTopicsCount`)

**`Extensions.swift`** — plattformübergreifende Utilities:
- `stripHTML()` — plain text für Suche/TextEditor-Vorausfüllung
- `htmlAttributedString()` — HTML → `AttributedString` für `Text`-Views (preserviert bold/italic/color/links)
- `scaledFont()` — ViewModifier für konsistente Schriftgrößen
- `Color(hex:)` — Hex-String-Initializer

**`ContentView.swift`** — Root-Navigation: `NavigationSplitView` (macOS) / `TabView` (iOS); `AppLock`-Overlay wenn `isLocked`

**Wichtige Konventionen:**
- HTML-Inhalte (description, result) in Read-Only-Views: `Text(htmlAttributedString(field))` 
- HTML-Inhalte in Edit-Formularen: `stripHTML(field)` beim Laden in `TextEditor`/`TextField` — iOS hat keinen Rich-Text-Editor
- Neue Felder in `TodoItem`/`Topic` etc. analog als optionale Properties mit Default hinzufügen; `parseTodo/parseTopic` im Server entsprechend anpassen
- `Theme.swift` (wenn vorhanden) als Farb-Token-Quelle; kein hartes `.indigo` / `"#6366f1"` im Code

---

## Was nicht zu tun ist

- Bestehende DB-Spalten ändern (nur additiv)
- Bestehende API-Endpoints umbenennen oder im Verhalten ändern
- Single-File-Ansatz für `server.js` aufbrechen (außer `ai/`)
- ORM, Frontend-Frameworks oder Build-Tools einführen
- Neue Dependencies ohne Rückfrage hinzufügen
- AI-Logik direkt in `server.js` schreiben (gehört in `ai/`)
