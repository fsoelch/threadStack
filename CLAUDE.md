# CLAUDE.md — ThreadStack

Kompakte Hinweise für Code-Änderungen in diesem Repo. Was Claude ohne Hinweis richtig
machen würde, steht nicht hier.

## Projekt-Setup

- Single-File-Server: gesamte HTTP/DB-Logik in `server.js` (NF-05).
- Single-File-Frontend: gesamte Web-UI in `index.html` (HTML + CSS + JS inline).
- Datenbank: SQLite via better-sqlite3 unter `data/app.db`.
- Migrationen: additiv, idempotent, beim Server-Start (`PRAGMA table_info` → `ALTER`/`CREATE TABLE IF NOT EXISTS`).
- IDs: durchgehend TEXT (kein INTEGER), erzeugt via `uid()`.
- Auth: Session-Cookie via `express-session`; Routes nutzen `requireAuth` / `requireAdmin`.

## Erweiterung v1.1 — AI und Stack

### Neue Befehle

- `npm test` — gesamte Test-Suite (`node --test`)
- `npm run ai:test` — Verbindungstest des aktuell konfigurierten Providers (CLI)
- `npm run digest:weekly` — Wochen-Digest manuell auslösen (ab Phase 3)

### AI-Schicht (`ai/`)

- Code in `ai/`. **Strikt: keine AI-Logik in `server.js`.**
- Routes in `server.js` rufen ausschließlich Funktionen aus `require('./ai')` auf.
- Provider-Adapter haben einheitliche Signatur:
  `callModel({ system, user, maxTokens, json, apiKey, model, ...opts })`
  `testConnection({ apiKey, model, ...opts })`
- Prompts sind Markdown-Templates in `ai/prompts/` mit `{{platzhalter}}`,
  interpoliert via `interpolate(template, data)` in `ai/index.js`.
- Jeder Aufruf protokolliert in `ai_usage`; Budget-Check **vor** jedem Aufruf.
- API-Keys nie loggen, nie in Responses (außer maskiert: letzte 4 Zeichen).
- Verschlüsselung: AES-256-GCM, Schlüssel in `data/.encryption-key` (analog Session-Secret).
- Strukturierte Outputs: JSON-Schema-Validierung, 1× Retry bei ungültigem JSON, dann 422.
- Mock-Provider via `AI_PROVIDER_OVERRIDE=mock` (nur für Tests).

### Stack-Layer (ab Phase 2)

- Tabelle `stack_frames` referenziert Topics/Todos via `ref_type` + `ref_id`; löscht sie nicht.
- Push ohne `next_step_note` → HTTP 400.
- Resolution-Werte: `done`, `snoozed`, `dropped`, `resumed`.
- Bei Resolution=`done`: referenziertes Topic/Todo wird zusätzlich erledigt (W-S05).

### HTTP-Fehlercodes (AI)

- 401 Nicht angemeldet
- 402 Monatsbudget erschöpft
- 409 Provider nicht konfiguriert / Feature deaktiviert / `globally_disabled=1`
- 422 Strukturierter Output ungültig (nach 1× Retry)
- 428 Kostenbestätigung nötig → Request mit `?confirm=true` wiederholen
- 503 Provider-Fehler oder Timeout (> 30 s)

## Was nicht zu tun ist

- Bestehende Tabellen-Spalten ändern (nur neue Spalten/Tabellen additiv anlegen).
- Bestehende API-Endpoints umbenennen oder im Verhalten ändern.
- Bestehende UI-Komponenten refactoren, „weil es sauberer ginge".
- Den Single-File-Ansatz für `server.js` aufbrechen (außer `ai/`, explizit erlaubt).
- ORM einführen.
- Neue Frontend-Frameworks oder Build-Tools einführen.
- Neue Dependencies ohne Rückfrage hinzufügen.

## Hilfreiches im Bestand

- Modal-Pattern: `<div class="modal-overlay">` mit `display:none/block`; `overlayClick()` schließt bei Hintergrund-Klick.
- Rich-Text: eigener `contenteditable`-Editor (`initRtToolbar`, `rtCmd`, `getRT`, `setRT`); kein Quill.
- Render-Zyklus: zentrale `render()` ruft `renderSidebar()`, `renderMain()`, `renderTodosNav()`.
- API-Helper im Frontend: `await api(method, path, body?)`.
- Konfirmations-Dialog im Bestand: `confirmDelete(...)` / `closeConfirm()` / `executeConfirm()`.
