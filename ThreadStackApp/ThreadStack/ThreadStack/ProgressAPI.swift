//
//  ProgressAPI.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("App-Datenschicht Progress"): API-Client für das
//  Zielbild-/Fortschrittsverlauf-Feature (Server-Vertrag: Paket S1,
//  `GET/PUT/POST/DELETE /api/progress/...`).
//
//  Redesign-Update (Todo/Task-Übersicht, Arbeitspaket A1): Zielbild entfällt
//  vollständig aus der App-UI (bindende Menschen-Entscheidung) — die frühere
//  `saveProgressGoal(refType:refId:goal:)`-Methode wurde deshalb aus diesem
//  Verantwortungsbereich entfernt (siehe Abschlussbericht: verbleibende
//  Aufrufer in anderen Paketen sind als Abhängigkeit vermerkt, nicht selbst
//  geändert).
//
//  Netzwerk-Pattern: `AppState.request(_:_:body:)` (siehe `AppState.swift`)
//  ist das etablierte, wiederzuverwendende Muster für einfache Endpunkte,
//  kollabiert 4xx/5xx-Antworten aber auf `APIError.server(String)` und wirft
//  damit den vom Server gelieferten `code` weg. Dieses Paket braucht den
//  `code` zwingend (siehe Fehler-Mapping-Tabelle im Vertrag), daher folgt
//  `progressRequest` unten exakt demselben, bereits im Projekt etablierten
//  Muster für "brauche den Fehlercode" wie `AppState.knowledgeRequest`
//  (privat in `AppState.swift`, Arbeitspaket "knowledge-api"): eigene
//  Fehler-Body-Struct `{ error, code }`, 401 weiterhin als
//  `APIError.unauthorized` (damit das bestehende Session-Expiry-Handling an
//  anderer Stelle der App unverändert funktioniert), alles andere über den
//  `code` auf `ProgressError` gemappt.
//
//  Abweichung vom Vertragstext ("nutze GENAU dieses bestehende
//  Request-Muster... erfinde kein neues Netzwerk-Pattern"): `AppState.session`
//  und `AppState.url(_:)` sind `private` in `AppState.swift` und damit aus
//  einer Extension in einer anderen Datei NICHT erreichbar — dieses Paket
//  darf `AppState.swift` laut Auftrag nicht ändern (nur neue Dateien). Statt
//  eines komplett neuen, unabhängigen HTTP-Clients wird daher hier lediglich
//  dieselbe Konstruktionslogik (URL-Aufbau, Session-Konfiguration mit
//  gemeinsamem Cookie-Speicher, Fehler-Decoding) 1:1 nachgebaut, siehe
//  `ProgressAPISession` und `progressPath(_:query:)` unten. Auth funktioniert
//  dabei transparent identisch: `HTTPCookieStorage.shared` ist ein
//  prozessweiter Singleton, kein Session-internes Detail — das
//  Session-Cookie, das `AppState.login` setzt, ist daher auch über eine
//  andere `URLSession`-Instanz automatisch verfügbar, solange deren
//  Konfiguration ebenfalls `httpCookieStorage = .shared` verwendet (wie hier).
//  Für Unit-Tests wird zusätzlich ein eigener, dateiweiter Test-Seam
//  (`ProgressAPISession.setOverride(_:for:)`) bereitgestellt, analog zu
//  `AppState.init(session:)`.
//

import Foundation

// MARK: - Test-only network seam

/// Verwaltet die `URLSession`, die die Progress-API-Aufrufe unten nutzen.
/// Siehe Erklärung oben: kann `AppState.session` nicht direkt wiederverwenden
/// (private, anderes File), verhält sich aber für Produktionszwecke
/// äquivalent (gleiche Cookie-basierte Auth über `HTTPCookieStorage.shared`).
enum ProgressAPISession {
    private static let lock = NSLock()
    // Zugriff ausschließlich über `session(for:)`/`setOverride(_:for:)` unten,
    // beide durch `lock` serialisiert — `nonisolated(unsafe)` ist hier sicher,
    // da die Swift-Concurrency-Prüfung die manuelle Lock-Disziplin nicht
    // erkennen kann (kein Actor-Isolationsmechanismus, aber äquivalent sicher).
    nonisolated(unsafe) private static var overrides: [ObjectIdentifier: URLSession] = [:]

    static let defaultSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        return URLSession(configuration: cfg)
    }()

    static func session(for state: AppState) -> URLSession {
        lock.lock(); defer { lock.unlock() }
        return overrides[ObjectIdentifier(state)] ?? defaultSession
    }

    /// Test-only: leitet Progress-API-Aufrufe für eine bestimmte `AppState`-
    /// Instanz auf eine Stub-`URLSession` um (z.B. gestützt auf ein
    /// `URLProtocol`-Mock, siehe `ProgressAPITests.swift`). Nicht für
    /// Produktions-Aufrufer gedacht.
    static func setOverride(_ session: URLSession?, for state: AppState) {
        lock.lock(); overrides[ObjectIdentifier(state)] = session; lock.unlock()
    }
}

// MARK: - Error-Code-Mapping

/// Server-Fehlerform: `{ "error": "<text>", "code": "<stabiler code>" }`
/// (siehe Vertrag). Beide Felder optional decodiert, damit ein unerwartet
/// leerer/abweichender Body die Fehlerbehandlung selbst nicht zum Absturz
/// bringt.
private struct ProgressErrorBody: Decodable {
    let error: String?
    let code: String?
}

extension ProgressError {
    /// Bildet den stabilen Server-`code` auf den passenden `ProgressError`-
    /// Case ab (siehe Vertragstabelle). Unbekannter/fehlender `code` (aber
    /// eine tatsächliche HTTP-Fehlerantwort wurde empfangen) → `.server` mit
    /// dem vom Server gelieferten Text, oder einem generischen Fallback, falls
    /// keiner vorhanden ist. Reine Transportfehler (kein Server erreicht)
    /// werden NICHT hier, sondern separat in `progressRequest` als `.offline`
    /// abgebildet.
    static func map(code: String?, message: String?) -> ProgressError {
        switch code {
        case "ref_not_found": return .notFound
        case "entry_not_found": return .entryGone
        case "ref_done": return .refDone
        case "entry_not_editable": return .notEditable
        case "goal_too_long": return .tooLong(field: "Zielbild", limit: 500)
        case "next_step_too_long": return .tooLong(field: "Nächster Schritt", limit: 1000)
        case "body_too_long": return .tooLong(field: "Zwischenstand", limit: 5000)
        case "body_empty": return .empty
        case "rate_limited": return .rateLimited
        default:
            if let message, !message.isEmpty { return .server(message) }
            return .server("Ein unerwarteter Fehler ist aufgetreten.")
        }
    }
}

// MARK: - URL-Aufbau

private extension String {
    /// Percent-encodiert diesen Wert für die sichere Verwendung als EIN
    /// URL-Pfadsegment — codiert (anders als `.urlPathAllowed`) auch "/",
    /// damit ein unerwarteter `refId`/`entryId`-Wert (externe Eingabe: kommt
    /// letztlich von Server-IDs, wird hier aber defensiv wie nicht
    /// vertrauenswürdige Eingabe behandelt) keine zusätzlichen Pfadsegmente
    /// einschleusen kann.
    var asProgressURLPathSegment: String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

extension AppState {

    /// Baut `/progress/...`-Pfade inkl. sicher codierter Segmente/Query-
    /// Parameter. `segments` werden einzeln percent-encodiert (siehe oben),
    /// `query`-Werte über `URLComponents` (korrekt codiert `cursor`-Werte,
    /// die z.B. ein "|" enthalten können, siehe Vertrag).
    fileprivate func progressPath(_ segments: [String], query: [(String, String)] = []) -> String {
        let encoded = segments.map { $0.asProgressURLPathSegment }
        var path = "/" + encoded.joined(separator: "/")
        if !query.isEmpty {
            var comps = URLComponents()
            comps.queryItems = query.map { URLQueryItem(name: $0.0, value: $0.1) }
            if let q = comps.percentEncodedQuery { path += "?" + q }
        }
        return path
    }

    /// Analog zu `AppState.url(_:)` (private, daher hier nachgebaut statt
    /// wiederverwendet — siehe Datei-Kopfkommentar).
    private func progressAPIURL(_ path: String) throws -> URL {
        var base = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.hasSuffix("/") { base = String(base.dropLast()) }
        guard !base.isEmpty, let u = URL(string: base + "/api" + path),
              isAllowedServerURLScheme(u) else { throw APIError.invalidURL }
        return u
    }

    /// Wie `AppState.request(_:_:body:)`, bewahrt aber den strukturierten
    /// Server-Fehler (`code`) als `ProgressError` statt jeden 4xx/5xx auf
    /// `APIError.server(String)` zu kollabieren. 401 bleibt weiterhin
    /// `APIError.unauthorized` (bestehendes Session-Expiry-Handling). Echte
    /// Transportfehler (kein Server erreicht, z.B. keine Internetverbindung)
    /// werden explizit auf `ProgressError.offline` gemappt, wie vom Vertrag
    /// gefordert.
    fileprivate func progressRequest<T: Decodable>(_ method: String, _ path: String,
                                                     body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: try progressAPIURL(path))
        req.httpMethod = method
        if let body, !body.isEmpty {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await ProgressAPISession.session(for: self).data(for: req)
        } catch {
            throw ProgressError.offline
        }
        guard let http = response as? HTTPURLResponse else { throw ProgressError.offline }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if http.statusCode >= 400 {
            let errorBody = try? JSONDecoder().decode(ProgressErrorBody.self, from: data)
            throw ProgressError.map(code: errorBody?.code, message: errorBody?.error)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    fileprivate func progressRequestNoContent(_ method: String, _ path: String,
                                               body: [String: Any]? = nil) async throws {
        let _: OKResponse = try await progressRequest(method, path, body: body)
    }

    // MARK: - Public API (Vertrag)

    func loadProgress(refType: String, refId: String, limit: Int = 20) async throws -> ProgressDetail {
        let path = progressPath(["progress", refType, refId], query: [("limit", String(limit))])
        return try await progressRequest("GET", path)
    }

    func loadProgressEntries(refType: String, refId: String, cursor: String?, limit: Int = 20) async throws -> ProgressEntriesPage {
        var query: [(String, String)] = [("limit", String(limit))]
        if let cursor, !cursor.isEmpty { query.append(("cursor", cursor)) }
        let path = progressPath(["progress", refType, refId, "entries"], query: query)
        return try await progressRequest("GET", path)
    }

    func saveProgressNextStep(refType: String, refId: String, nextStep: String) async throws -> ProgressMeta {
        let path = progressPath(["progress", refType, refId, "next-step"])
        return try await progressRequest("PUT", path, body: ["nextStep": nextStep])
    }

    /// `clientToken` wird vom Aufrufer (i.d.R. `ProgressStore`) erzeugt und
    /// hier nur durchgereicht — siehe Vertrag: "der Aufrufer/Store
    /// entscheidet, wann ein NEUER Token nötig ist". Dieser Client baut oder
    /// verwaltet keine eigene Idempotenz-Logik.
    func addProgressEntry(refType: String, refId: String, bodyHTML: String, source: String, clientToken: String) async throws -> ProgressEntry {
        let path = progressPath(["progress", refType, refId, "entries"])
        return try await progressRequest("POST", path, body: [
            "body": bodyHTML, "source": source, "clientToken": clientToken
        ])
    }

    func updateProgressEntry(entryId: String, bodyHTML: String) async throws -> ProgressEntry {
        let path = progressPath(["progress", "entries", entryId])
        return try await progressRequest("PUT", path, body: ["body": bodyHTML])
    }

    func deleteProgressEntry(entryId: String) async throws {
        let path = progressPath(["progress", "entries", entryId])
        try await progressRequestNoContent("DELETE", path)
    }
}
