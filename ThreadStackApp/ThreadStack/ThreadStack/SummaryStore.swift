//
//  SummaryStore.swift
//  ThreadStack
//
//  ABWEICHUNG VOM ARBEITSPAKET-ZUSCHNITT (siehe Abschlussbericht Paket A3):
//  Wie `SummaryModels.swift` gehört auch dieser Store laut Vertrag zu Paket
//  A1, existiert aber in keinem erreichbaren Stand — Stand-in-Fassung von
//  Paket A3, MUSS beim Merge mit dem echten Paket A1 abgeglichen werden.
//
//  Netzwerk-Pattern: folgt bewusst 1:1 dem bereits etablierten Muster aus
//  `ProgressAPI.swift`/`ProgressStore.swift` (eigene, dateiweite
//  `URLSession`-Testseam, da `AppState.session`/`AppState.url(_:)` privat
//  sind und diese Datei `AppState.swift` nicht ändern darf; Fehler-Mapping
//  auf `ProgressError` wiederverwendet statt eines neuen Fehlertyps, da die
//  Nutzertexte inhaltlich identisch sind: "keine Verbindung", "zu viele
//  Änderungen" etc.) — kein zweites, abweichendes Netzwerk-/Fehler-Konzept.
//
//  Server-Endpunkte sind ERFUNDEN (kein Paket S3 verfügbar), aber konsistent
//  zum bestehenden `/api/progress/...`-Schema benannt:
//    GET  /api/summary/:refType/:refId                 -> AISummaryPair (JSON)
//    POST /api/summary/:kind/:refType/:refId/regenerate -> AISummaryView (JSON)
//  Schlägt der Request fehl (z.B. weil der Endpunkt serverseitig noch nicht
//  existiert), verhält sich das für Aufrufer wie jeder andere Netzwerkfehler
//  (`ProgressError.offline`/`.server`) — kein Absturz, keine kaschierten
//  Interna in der Fehlermeldung (siehe CLAUDE.md Sicherheits-Baseline).
//

import Foundation
import Combine

// MARK: - Test-only network seam (analog ProgressAPISession)

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

    /// Test-only: siehe `ProgressAPISession.setOverride` — identisches Muster.
    static func setOverride(_ session: URLSession?, for state: AppState) {
        lock.lock(); overrides[ObjectIdentifier(state)] = session; lock.unlock()
    }
}

private struct SummaryErrorBody: Decodable {
    let error: String?
    let code: String?
}

private extension String {
    var asSummaryURLPathSegment: String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

private extension AppState {
    func summaryAPIURL(_ path: String) throws -> URL {
        var base = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.hasSuffix("/") { base = String(base.dropLast()) }
        guard !base.isEmpty, let u = URL(string: base + "/api" + path) else { throw APIError.invalidURL }
        return u
    }

    func summaryRequest<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        var req = URLRequest(url: try summaryAPIURL(path))
        req.httpMethod = method
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await SummaryAPISession.session(for: self).data(for: req)
        } catch {
            throw ProgressError.offline
        }
        guard let http = response as? HTTPURLResponse else { throw ProgressError.offline }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if http.statusCode >= 400 {
            let errorBody = try? JSONDecoder().decode(SummaryErrorBody.self, from: data)
            throw ProgressError.map(code: errorBody?.code, message: errorBody?.error)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func fetchAISummaryPair(refType: String, refId: String) async throws -> AISummaryPair {
        let path = "/summary/\(refType.asSummaryURLPathSegment)/\(refId.asSummaryURLPathSegment)"
        return try await summaryRequest("GET", path)
    }

    func regenerateAISummary(kind: String, refType: String, refId: String) async throws -> AISummaryView {
        let path = "/summary/\(kind.asSummaryURLPathSegment)/\(refType.asSummaryURLPathSegment)/\(refId.asSummaryURLPathSegment)/regenerate"
        return try await summaryRequest("POST", path)
    }
}

/// Zentraler Zustands-Store für KI-Zusammenfassungen (Fortschritt/Beschreibung).
/// Hält pro Ref ("refType:refId") das zuletzt bekannte `AISummaryPair`.
/// Konsumenten (Paket A3: `TodosView`, `MeetingDetailView`, `AISummaryCardView`)
/// beobachten ausschließlich `summaries` und rufen die Methoden unten auf.
@MainActor
final class SummaryStore: ObservableObject {

    /// Stabile Referenz auf ein Vorhaben, für Polling-Aufrufe.
    struct Ref: Hashable {
        let refType: String
        let refId: String
    }

    @Published private(set) var summaries: [String: AISummaryPair] = [:]

    private weak var appState: AppState?
    private var pollTasks: [String: Task<Void, Never>] = [:]

    static let maxPollAttempts = 10
    static let pollIntervalNanoseconds: UInt64 = 3_000_000_000

    init(appState: AppState? = nil) {
        self.appState = appState
    }

    /// Später nachreichbar, falls der Store (z.B. mangels App-weiter
    /// Registrierung in `ThreadStackApp.swift`, siehe Abschlussbericht) erst
    /// nach der Konstruktion Zugriff auf `AppState` bekommt.
    func attach(_ appState: AppState) {
        self.appState = appState
    }

    private func key(_ refType: String, _ refId: String) -> String { "\(refType):\(refId)" }

    func pair(refType: String, refId: String) -> AISummaryPair? {
        summaries[key(refType, refId)]
    }

    // MARK: - Ingest (kein Netzwerk-Request — Daten kommen bereits aus dem Listen-Response)

    /// Übernimmt `TodoItem.aiSummary` für alle übergebenen Todos in den Store.
    /// Todos ohne `aiSummary` (nil) lassen einen ggf. bereits vorhandenen
    /// Eintrag unverändert (z.B. weil zwischenzeitlich per `poll`/`regenerate`
    /// aktuellere Daten geladen wurden).
    func ingest(from todos: [TodoItem]) {
        for t in todos {
            guard let pair = t.aiSummary else { continue }
            summaries[key("todo", t.id)] = pair
        }
    }

    /// Übernimmt `Topic.aiSummary` für alle übergebenen Topics in den Store.
    func ingest(from topics: [Topic]) {
        for t in topics {
            guard let pair = t.aiSummary else { continue }
            summaries[key("topic", t.id)] = pair
        }
    }

    // MARK: - Poll

    /// Startet für jede übergebene Ref, für die noch kein Poll läuft, einen
    /// Hintergrund-Task, der den aktuellen Stand periodisch nachlädt, bis er
    /// nicht mehr `pending` ist, der Task abgebrochen wird
    /// (`cancelPolling(for:)`) oder `maxPollAttempts` erreicht ist (verhindert
    /// unbegrenztes Polling bei dauerhaft hängendem Server-Job).
    func poll(refs: [Ref]) async {
        for ref in refs {
            let k = key(ref.refType, ref.refId)
            guard pollTasks[k] == nil else { continue }
            guard let appState else { continue }
            let task = Task { [weak self] in
                var attempt = 0
                while !Task.isCancelled && attempt < Self.maxPollAttempts {
                    attempt += 1
                    do {
                        let pair = try await appState.fetchAISummaryPair(refType: ref.refType, refId: ref.refId)
                        guard let self, !Task.isCancelled else { return }
                        self.summaries[k] = pair
                        let stillPending = pair.progress?.kind == .pending || pair.description?.kind == .pending
                        if !stillPending { break }
                    } catch {
                        // Netzwerk-/Serverfehler beim Polling werden nicht als
                        // sichtbarer Fehler propagiert (kein Toast pro Zeile) —
                        // der zuletzt bekannte Zustand bleibt sichtbar, ein
                        // erneuter Versuch erfolgt beim nächsten Sichtbarwerden
                        // der Zeile. Fehler werden dennoch nicht verschluckt im
                        // Sinne von "ignoriert und niemals wieder versucht":
                        // Abbruch der aktuellen Poll-Schleife, kein Crash.
                        break
                    }
                    guard !Task.isCancelled else { break }
                    try? await Task.sleep(nanoseconds: Self.pollIntervalNanoseconds)
                }
                guard let self else { return }
                self.pollTasks.removeValue(forKey: k)
            }
            pollTasks[k] = task
        }
    }

    /// Bricht ein laufendes Polling für diese Ref ab (z.B. Zeile verschwindet
    /// aus dem sichtbaren Bereich) — verhindert Task-Leaks.
    func cancelPolling(for ref: Ref) {
        let k = key(ref.refType, ref.refId)
        pollTasks[k]?.cancel()
        pollTasks.removeValue(forKey: k)
    }

    // MARK: - Regenerate

    /// Fordert eine neue KI-Zusammenfassung für `kind` ("progress"|"description")
    /// an und aktualisiert den lokalen Zustand bei Erfolg. Wirft bei Fehler
    /// (Aufrufer zeigt `error.localizedDescription`, z.B. `AISummaryCardView`s
    /// "Erneut versuchen").
    @discardableResult
    func regenerate(kind: String, refType: String, refId: String) async throws -> AISummaryView {
        guard let appState else { throw ProgressError.offline }
        do {
            let view = try await appState.regenerateAISummary(kind: kind, refType: refType, refId: refId)
            let k = key(refType, refId)
            var pair = summaries[k] ?? AISummaryPair()
            if kind == "description" {
                pair.description = view
            } else {
                pair.progress = view
            }
            summaries[k] = pair
            return view
        } catch {
            throw ProgressStore.mapError(error)
        }
    }
}
