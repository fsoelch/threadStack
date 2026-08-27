//
//  SummaryAPI.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("App-Datenschicht", Redesign Todo/Task-Übersicht):
//  API-Client für KI-Zusammenfassungen (`GET /api/summaries`,
//  `POST /api/summaries/:kind/:refType/:refId/regenerate`, siehe
//  Schnittstelle 12 im Vertrag).
//
//  Netzwerk-Pattern: identisch zum bereits etablierten Vorbild
//  `ProgressAPI.swift` (Arbeitspaket "App-Datenschicht Progress") — aus
//  denselben Gründen wie dort (`AppState.session`/`AppState.url(_:)` sind
//  `private` und aus einer Extension in einer anderen Datei nicht
//  erreichbar) wird hier eine eigene, gleichwertige `SummaryAPISession`
//  nachgebaut statt `ProgressAPISession` direkt wiederzuverwenden. Letzteres
//  wäre zwar technisch möglich (identische Bauart), würde aber den Namen und
//  die öffentliche Form eines Test-Seams verändern, von dem bereits ein
//  NICHT zu diesem Arbeitspaket gehörendes Testziel
//  (`ProgressComposerTests.swift`, Paket A2) abhängt — ein Umbenennen/
//  Verallgemeinern hätte dessen Vertrag angefasst, obwohl diese Datei nicht
//  in der eigenen Datei-Eigentümerschaft liegt. Diese Duplikation eines
//  kleinen, generischen Infrastruktur-Musters (nicht einer fachlichen
//  Business-Logik) wird daher bewusst in Kauf genommen; siehe
//  Abschlussbericht, Abschnitt "Abweichungen".
//

import Foundation

// MARK: - Test-only network seam

/// Verwaltet die `URLSession`, die die Summary-API-Aufrufe unten nutzen.
/// Siehe Datei-Kopfkommentar: äquivalent zu `ProgressAPISession`, bewusst
/// als eigener Typ gehalten.
enum SummaryAPISession {
    private static let lock = NSLock()
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

    /// Test-only: leitet Summary-API-Aufrufe für eine bestimmte `AppState`-
    /// Instanz auf eine Stub-`URLSession` um. Nicht für Produktions-Aufrufer
    /// gedacht.
    static func setOverride(_ session: URLSession?, for state: AppState) {
        lock.lock(); overrides[ObjectIdentifier(state)] = session; lock.unlock()
    }
}

// MARK: - URL-Aufbau

private extension String {
    /// Percent-encodiert diesen Wert für die sichere Verwendung als EIN
    /// URL-Pfadsegment — codiert (anders als `.urlPathAllowed`) auch "/",
    /// damit ein unerwarteter `refId`-Wert (externe Eingabe, letztlich vom
    /// Server, hier aber defensiv wie nicht vertrauenswürdige Eingabe
    /// behandelt) keine zusätzlichen Pfadsegmente einschleusen kann.
    var asSummaryURLPathSegment: String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

/// Server-Fehlerform: `{ "error": "<text>", "code": "<code>" }` (siehe
/// Vertrag). Beide Felder optional decodiert, damit ein unerwartet leerer/
/// abweichender Body die Fehlerbehandlung selbst nicht zum Absturz bringt.
private struct SummaryErrorBody: Decodable {
    let error: String?
    let code: String?
}

private struct SummariesResponse: Decodable {
    let summaries: [String: AISummaryPair]
}

private struct SummaryRegenerateResponse: Decodable {
    let status: String?
}

extension AppState {

    fileprivate func summaryAPIURL(_ path: String) throws -> URL {
        var base = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.hasSuffix("/") { base = String(base.dropLast()) }
        guard !base.isEmpty, let u = URL(string: base + "/api" + path) else { throw APIError.invalidURL }
        return u
    }

    /// Wie `AppState.request(_:_:body:)`, bewahrt aber den HTTP-Status +
    /// den strukturierten Server-Fehler als `SummaryError` statt jeden
    /// 4xx/5xx auf `APIError.server(String)` zu kollabieren. 401 bleibt
    /// weiterhin `APIError.unauthorized` (bestehendes Session-Expiry-
    /// Handling). Echte Transportfehler (kein Server erreicht) werden
    /// explizit auf `SummaryError.offline` gemappt.
    fileprivate func summaryRequest<T: Decodable>(_ method: String, _ path: String,
                                                   body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: try summaryAPIURL(path))
        req.httpMethod = method
        if let body, !body.isEmpty {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await SummaryAPISession.session(for: self).data(for: req)
        } catch {
            throw SummaryError.offline
        }
        guard let http = response as? HTTPURLResponse else { throw SummaryError.offline }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if http.statusCode >= 400 {
            let errorBody = try? JSONDecoder().decode(SummaryErrorBody.self, from: data)
            throw SummaryError.map(status: http.statusCode, message: errorBody?.error)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Public API (Vertrag: Schnittstelle 12)

    /// `GET /api/summaries?refs=todo:abc,topic:def`. Leeres `refs` liefert
    /// direkt ein leeres Ergebnis, ohne einen (unnötigen) Request zu senden.
    func loadSummaries(refs: [String]) async throws -> [String: AISummaryPair] {
        guard !refs.isEmpty else { return [:] }
        var comps = URLComponents()
        comps.queryItems = [URLQueryItem(name: "refs", value: refs.joined(separator: ","))]
        let query = comps.percentEncodedQuery ?? ""
        let resp: SummariesResponse = try await summaryRequest("GET", "/summaries?" + query)
        return resp.summaries
    }

    /// `POST /api/summaries/:kind/:refType/:refId/regenerate[?confirm=true]`.
    /// Der Server antwortet bei Erfolg mit `202 {"status":"pending"}` — der
    /// Store/Aufrufer entscheidet, ob/wann danach gepollt wird (siehe
    /// `SummaryStore.poll(refs:)`), diese Methode selbst löst kein Polling
    /// aus.
    ///
    /// `confirmed` defaultet auf `false` (Security Review, Mittel, A04): der
    /// Hintergrund-Job prüft die Kostenschwelle bei jedem automatischen Lauf
    /// mit `confirmed:false`. Ein hier fest verdrahtetes `confirm=true` würde
    /// diese Prüfung für JEDEN manuellen Regenerate-Aufruf unbemerkt
    /// umgehen. Erst wenn der Status als `confirmation_required`
    /// zurückkommt (siehe `AISummaryStatus`), löst ein expliziter, vom
    /// Nutzer bestätigter zweiter Aufruf mit `confirmed: true` erneut aus.
    func regenerateSummary(kind: String, refType: String, refId: String, confirmed: Bool = false) async throws {
        var path = "/summaries/\(kind.asSummaryURLPathSegment)/\(refType.asSummaryURLPathSegment)/\(refId.asSummaryURLPathSegment)/regenerate"
        if confirmed { path += "?confirm=true" }
        let _: SummaryRegenerateResponse = try await summaryRequest("POST", path)
    }
}
