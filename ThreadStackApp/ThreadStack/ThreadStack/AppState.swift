import Foundation
import SwiftUI
import Combine

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidURL, network, unauthorized, server(String)
    var errorDescription: String? {
        switch self {
        case .invalidURL:    return "Ungültige Server-URL. Bitte in Einstellungen prüfen."
        case .network:       return "Keine Verbindung – dein Inhalt bleibt im Dialog erhalten. Bitte versuche es erneut, sobald du wieder online bist."
        case .unauthorized:  return "Sitzung abgelaufen — bitte neu anmelden."
        case .server(let m): return m
        }
    }
}

// v1.1: structured AI error preserving HTTP status + code (402/409/422/428/503)
struct APIAIError: LocalizedError {
    let status:  Int
    let message: String
    let code:    String?
    let detail:  AIErrorDetail?
    var errorDescription: String? { message }
    var needsConfirmation: Bool { status == 428 || code == "confirmation_required" }
    var budgetExceeded:    Bool { status == 402 || code == "budget_exceeded" }
}

// v2.2: dedicated conflict error for POST /api/archive/meeting/:id — thrown on
// 409 ARCHIVE_STACK_CONFLICT while `acknowledgeStackConflict == false`. Kept as a
// narrow, purpose-built type (same style as APIAIError/KnowledgeAPIError above)
// rather than widening the generic `request` helper, which only surfaces a flat
// `APIError.server(String)` and would otherwise lose the structured conflict list.
struct ArchiveConflictError: LocalizedError {
    let openFrames: [ArchiveStackConflict]
    var errorDescription: String? { "Offenes Stack-Frame im Meeting" }
}

// MARK: - Contact-Infoblöcke/Rubriken: strukturierte Fehler (Arbeitspaket A1
// "Erweiterung Ansprechpartner-Konzept")

/// Geworfen von `updateContactInfoBlock`, wenn der Server einen
/// `409 block_conflict` meldet (jemand anders hat den Infoblock zwischenzeitlich
/// geändert). Trägt den aktuellen Serverstand (`{block: ...}` im Body laut
/// Vertrag) mit, damit `ContactInfoBlockSheet` die drei geforderten Optionen
/// ("Anderen Stand ansehen"/"Meine Version speichern"/"Verwerfen und neu
/// laden") anbieten kann — ein generischer `APIError.server(String)` würde
/// diesen strukturierten Konfliktstand verwerfen.
struct ContactInfoBlockConflictError: Error, LocalizedError {
    let currentBlock: ContactInfoBlock
    var errorDescription: String? {
        "Dieser Infoblock wurde zwischenzeitlich an anderer Stelle geändert."
    }
}

/// Geworfen von `deleteContactCategory`, wenn der Server einen
/// `409 category_in_use` meldet — trägt die Nutzungsanzahl mit, damit
/// `ContactCategorySheet` einen konkreten Bestätigungstext zeigen kann
/// (Vertrag: "Text abhängig von `usageCount` aus der `category_in_use`-Antwort").
struct ContactCategoryInUseError: Error, LocalizedError {
    let usageCount: Int
    var errorDescription: String? {
        usageCount == 1
            ? "Diese Rubrik wird noch von einem Infoblock verwendet und kann nicht gelöscht werden."
            : "Diese Rubrik wird noch von \(usageCount) Infoblöcken verwendet und kann nicht gelöscht werden."
    }
}

/// Geworfen von `deleteContactCategory`, wenn der Server einen 409
/// `category_fallback_protected` (Rubrik "Sonstiges", Auffangrubrik) oder
/// `category_private_protected` (Rubrik "Privates", Datenschutz-Filter)
/// meldet — siehe `lib/contacts/routes.js`. Anders als bei den Start-
/// Rubriken "Zuständigkeit"/"Wichtiges" (die wie jede eigene Rubrik frei
/// löschbar sind, inkl. Zwangslöschung mit Umhängen nach "Sonstiges" bei
/// Nutzung) ist eine Löschung dieser beiden Rubriken serverseitig
/// grundsätzlich verboten. Trägt die vom Server bereits gelieferte,
/// nutzerverständliche deutsche Fehlermeldung mit, statt sie clientseitig
/// erneut zu hardcoden (vermeidet Textdrift zwischen Server und Client).
struct ContactCategoryProtectedError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Geworfen von den Zuständigkeits-Methoden (`setAssignments`), wenn der
/// Server einen `409 assignment_limit_reached` meldet — trägt keine
/// zusätzlichen Daten, das Limit (20) ist bereits clientseitig in
/// `ContactAssignmentPickerSheet` durchgesetzt; dieser Fehler ist ein
/// Fail-Safe für den Fall eines Wettlaufs mit einem anderen Gerät.
struct ContactAssignmentLimitError: Error, LocalizedError {
    var errorDescription: String? { "Maximal 20 Ansprechpartner pro Vorhaben." }
}

// MARK: - AppState

@MainActor
final class AppState: ObservableObject {

    @Published var currentUser: AppUser?
    @Published var meetings:    [Meeting]  = []
    @Published var todos:       [TodoItem] = []
    @Published var themes:      [Theme]    = []
    @Published var knowledgePages: [KnowledgePage] = []
    @Published var contacts:    [Contact]  = []
    // Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): frei
    // erweiterbare Rubriken für Kontakt-Infoblöcke, global (nicht pro
    // Kontakt) verwaltet — analog zu `contacts`/`themes` oben.
    @Published var contactCategories: [ContactCategory] = []
    @Published var isLoading = false

    // v1.1 Phase 2: Stack
    @Published var stackFrames: [StackFrame] = []
    @Published var stackDepth:  Int          = 0

    // v1.1 Phase 1+3: AI
    @Published var aiSettings:   AISettings?
    @Published var driftIds:     Set<String> = []
    @Published var cmiByMeeting: [String: CMIContent] = [:]

    // v2.2: Archiv (Paket A1)
    @Published var archivedMeetings: [ArchivedMeetingListItem] = []
    @Published var archiveTotal: Int = 0

    // App-Lock (Face ID / Touch ID)
    @Published var isLocked: Bool = false
    @Published var hasStoredCredentials: Bool = Keychain.hasStoredCredentials

    // Refresh state
    @Published var isRefreshing: Bool = false
    @Published var lastRefreshAt: Date? = nil
    private var refreshTimer: Timer?

    // Sichtbarer Fortschritt (Arbeitspaket M5, Momentum): sequentielle
    // Toast-Warteschlange, damit mehrere Meilensteine (z.B. Thema UND
    // Kontakt in derselben Aktion) nacheinander statt überlappend gezeigt
    // werden. Nur der VORDERSTE Eintrag ist sichtbar (siehe ToastOverlay.swift).
    @Published private(set) var toastQueue: [ToastMessage] = []
    var currentToast: ToastMessage? { toastQueue.first }
    func showToast(_ text: String, emphasized: Bool = false) {
        toastQueue.append(ToastMessage(text: text, emphasized: emphasized))
    }
    func dismissCurrentToast(id: UUID) {
        // Nur entfernen, wenn es wirklich noch der vorderste (angezeigte)
        // Eintrag ist - verhindert, dass ein verspäteter Auto-Dismiss-Timer
        // einen inzwischen bereits nachgerückten, ANDEREN Toast wegwischt.
        if toastQueue.first?.id == id { toastQueue.removeFirst() }
    }
    // Aktuelle Tages-Serie für den Sidebar-Badge - nil bedeutet "keine
    // Serie/deaktiviert/Fehler", nicht "0" (kein Badge statt "🔥0").
    @Published var momentumStreakCount: Int? = nil
    private let autoRefreshInterval: TimeInterval = 60   // Sekunden

    // Session-Auto-Renew (Anforderung: laufende Bearbeitung soll eine
    // abgelaufene Sitzung nicht mehr unterbrechen). Mehrere Requests, die
    // gleichzeitig auf 401 laufen, teilen sich EINEN Renewal-Versuch statt
    // je einen eigenen Re-Login/Biometrie-Vorgang auszulösen.
    private var pendingSessionRenewal: Task<Bool, Never>?

    /// Test-only seam: `tryServerReLogin()` geht über die echte, Biometrie-
    /// geschützte Keychain, die in einem automatisierten Testlauf entweder
    /// leer ist oder einen System-Prompt auslösen würde. Ist dieser Override
    /// gesetzt, verwendet `attemptSessionRenewal()` ihn statt
    /// `tryServerReLogin()` — Produktionscode lässt ihn `nil` (Default) und
    /// ist davon unberührt.
    var sessionRenewalOverride: (() async -> Bool)?

    // Graph-Zustand lebt seit der Lesbarkeits-/Wartbarkeits-Aufteilung in
    // `GraphStore` (analog zu `ProgressStore`/`SummaryStore`). `AppState`
    // haelt nur noch diese schwache Rueckreferenz, damit `logout()` weiterhin
    // garantieren kann, dass der Graph-Cache jeden Logout NICHT ueberlebt
    // (Security-Anforderung, siehe `GraphStore.clearOnLogout()`) - gesetzt
    // von der Kompositionswurzel (`ThreadStackApp.swift`).
    weak var graphStore: GraphStore?
    /// Wie `graphStore`: schwache Rueckreferenz fuer Logout-Reset und das
    /// Nachladen nach quittierten Zwischenstaenden (Offline-Modus, P7).
    weak var progressStore: ProgressStore?

    // MARK: Offline-Modus (Paket P7, Kompositionswurzel setzt diese Referenzen)

    /// Kompositionswurzel-Referenzen (`attachOffline`). `nil` in Tests/Vorschauen ohne Offline-Modus:
    /// dann verhaelt sich AppState wie vor dem Offline-Modus.
    var offline: OfflineCoordinator?
    var offlineStatus: OfflineStatusStore?
    var offlineSnapshots: OfflineSnapshotStore?
    /// Liefert den NWPath-Zustand des `ConnectivityMonitor` (Standard: Pfad vorhanden).
    var pathSatisfied: () -> Bool = { true }
    /// Nur im Speicher (nie persistiert): Zugangsdaten nach lokalem Biometrie-Nachweis, solange offline
    /// gestartet wurde. Geloescht bei Anmeldung, Logout und Wechsel in den Hintergrund.
    var offlineUnlockCredentials: StoredCredentials?
    /// Test-only seam: Laden der Zugangsdaten (Standard: Biometrie-geschuetzter Keychain-Zugriff).
    var credentialLoader: (_ prompt: String) throws -> StoredCredentials = { try Keychain.load(prompt: $0) }
    /// Spiegel der Outbox (ohne Inhalte zu loggen): Quelle fuer Overlay-Neuanwendung und `ProgressStore`.
    private(set) var offlineChanges: [PendingChange] = []
    /// Impuls der Kompositionswurzel: LoginView im Modus "erneute Anmeldung" als Sheet zeigen.
    @Published var reauthRequested = false
    /// Hinweis fuer LoginView/LockScreen nach einem Start ohne Netz (Story 2).
    @Published var loginNotice: String?
    /// Hinweis auf dem Lock-Screen nach einem Start ohne Netz (UX S2).
    @Published var lockNotice: String?
    /// Der Start fand den Server nicht erreichbar vor (steuert u.a. "Anmeldedaten vergessen" im Lock-Screen).
    @Published var bootedOffline = false
    /// `true`, sobald nach Anmeldung/Start die erste Datenladung erfolgt ist (ContentView laedt dann nicht erneut).
    private(set) var hasCompletedInitialLoad = false
    /// Szene aktiv (Auto-Refresh laeuft nur dann, F7).
    var isSceneActive = true
    /// Nach einem Start ohne Netz fehlen KI-Einstellungen/Serie noch: beim ersten Online-Refresh nachladen.
    private var deferredOnlineLoadsPending = false

    var aiIsActive: Bool { aiSettings?.isActive ?? false }
    func aiFeatureEnabled(_ keyPath: KeyPath<AIFeatures, Bool>) -> Bool {
        guard aiIsActive, let f = aiSettings?.features_enabled else { return false }
        return f[keyPath: keyPath]
    }

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    static let defaultServerURL = "https://soelch.com/threadStack"

    private let session: URLSession
    private let decoder = JSONDecoder()

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? Self.defaultServerURL
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: cfg)
    }

    /// Test-only seam: allows injecting a `URLSession` (e.g. backed by a
    /// custom `URLProtocol` stub) so unit tests can exercise the real
    /// request/error-mapping code paths without hitting the network. Not
    /// used by production call sites, which continue to use `init()`.
    init(session: URLSession) {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        self.session = session
    }

    // MARK: - Core request
    // Body values: use NSNull() to send JSON null; nil entries are excluded.

    private func url(_ path: String) throws -> URL {
        var base = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.hasSuffix("/") { base = String(base.dropLast()) }
        guard !base.isEmpty, let u = URL(string: base + "/api" + path),
              isAllowedServerURLScheme(u) else { throw APIError.invalidURL }
        return u
    }

    /// Pfade, die NIE einen automatischen Renewal-Versuch auslösen dürfen:
    /// `/login` und `/logout` würden sonst bei einem 401 (z.B. falsches
    /// Passwort) `tryServerReLogin()` → `login()` → erneut `performRequest`
    /// auf demselben Pfad aufrufen, während der ursprüngliche Renewal-Task
    /// noch läuft — ein Task, der auf sich selbst wartet, würde deadlocken.
    /// `/me` ist zusätzlich ausgenommen, da ein 401 dort auch den normalen
    /// "noch keine Sitzung vorhanden"-Kaltstart-Fall abbildet, für den ein
    /// Renewal-Versuch ohne vorherigen Login sinnlos wäre.
    private static let sessionRenewalExemptPaths: Set<String> = ["/login", "/logout", "/me"]

    /// Gemeinsamer Kern von `request`/`aiRequest`/`archiveRequest`/
    /// `knowledgeRequest` (Arbeit zur Lesbarkeit/Wartbarkeit - aus 4 fast
    /// identischen Kopien extrahiert): baut die `URLRequest`, sendet sie und
    /// prüft Netzwerk-/401-Fehler EINHEITLICH. Die vier öffentlichen
    /// Methoden unterscheiden sich nur noch in ihrer jeweiligen ≥400-
    /// Fehler-Zuordnung (structured error body je Feature-Bereich) - dafür
    /// bekommen sie hier Rohdaten + HTTP-Status zurück, statt die
    /// Entscheidung selbst zu treffen.
    ///
    /// Bei einem 401 wird (außer für `sessionRenewalExemptPaths` oder wenn
    /// bereits ein Retry läuft) EINMAL versucht, die Sitzung über
    /// `tryServerReLogin()` automatisch zu erneuern und die ursprüngliche
    /// Anfrage danach transparent zu wiederholen — damit läuft eine während
    /// der Bearbeitung ablaufende Sitzung nicht mehr in eine sichtbare
    /// Fehlermeldung, solange gespeicherte Zugangsdaten vorhanden sind.
    /// Schlägt die Erneuerung fehl (oder sind keine Zugangsdaten
    /// gespeichert), bleibt das bisherige Verhalten (`APIError.unauthorized`)
    /// unverändert erhalten.
    private func performRequest(_ method: String, _ path: String,
                                 body: [String: Any]? = nil,
                                 allowSessionRenewal: Bool = true,
                                 timeout: TimeInterval? = nil) async throws -> (data: Data, http: HTTPURLResponse) {
        let req = try buildRequest(method, path, body: body, timeout: timeout)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let urlError as URLError where urlError.code != .cancelled {
            // Offline-Modus (S-12): Transportfehler einheitlich als `APIError.network` mit verstaendlichem
            // Text melden und den Verbindungszustand an den Coordinator weitergeben.
            offline?.reportTransport(success: false)
            throw APIError.network
        }
        guard let http = response as? HTTPURLResponse else {
            offline?.reportTransport(success: false)
            throw APIError.network
        }
        if http.statusCode < 500 { offline?.reportTransport(success: true) }
        if http.statusCode == 401 {
            let canRenew = allowSessionRenewal && !Self.sessionRenewalExemptPaths.contains(path)
            if canRenew, await attemptSessionRenewal() {
                return try await performRequest(method, path, body: body, allowSessionRenewal: false, timeout: timeout)
            }
            throw APIError.unauthorized
        }
        return (data, http)
    }

    /// Baut die `URLRequest`. Zentraler Guard (S-12): Ein Pfad mit einem `local-`-Segment oder ein ID-Feld
    /// im Body mit lokaler ID darf NIE zum Server gehen (Eintrag ist noch nicht synchronisiert).
    private func buildRequest(_ method: String, _ path: String, body: [String: Any]?,
                              timeout: TimeInterval?) throws -> URLRequest {
        if Self.containsLocalId(path: path) || Self.bodyContainsLocalId(body) {
            throw OfflineError.pendingNotSynced
        }
        var req = URLRequest(url: try url(path))
        req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        if let body, !body.isEmpty {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    static func containsLocalId(path: String) -> Bool {
        let beforeQuery = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path
        return beforeQuery.split(separator: "/").contains { OfflineIds.isLocal(String($0)) }
    }

    /// Nur ID-Felder (Schluessel auf `Id`/`Ids`) werden geprueft - Freitexte (Titel etc.) koennen
    /// legitim mit "local-" beginnen. Das generische Feld `ids` (Reorder) filtern die Aufrufer selbst.
    private static func bodyContainsLocalId(_ body: [String: Any]?) -> Bool {
        guard let body else { return false }
        for (key, value) in body where key.hasSuffix("Id") || key.hasSuffix("Ids") {
            if let s = value as? String, OfflineIds.isLocal(s) { return true }
            if let a = value as? [String], a.contains(where: OfflineIds.isLocal) { return true }
        }
        return false
    }

    /// Transport fuer den Sync-Motor (P3): OHNE transparentes 401-Auto-Renewal, HTTP-Fehlerstatus kommt als
    /// normale Antwort zurueck. Pfade relativ zu `/api`. Transportfehler werden geworfen.
    func performSyncRequest(method: String, path: String, body: [String: Any]?,
                            timeout: TimeInterval) async throws -> (Data, HTTPURLResponse) {
        let req = try buildRequest(method, path, body: body, timeout: timeout)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.network }
        return (data, http)
    }

    /// Bündelt gleichzeitige Renewal-Anfragen mehrerer parallel laufender
    /// Requests auf EINEN `tryServerReLogin()`-Aufruf, statt pro betroffenem
    /// Request einen eigenen (ggf. mit eigenem Biometrie-Prompt) zu starten.
    private func attemptSessionRenewal() async -> Bool {
        if let existing = pendingSessionRenewal {
            return await existing.value
        }
        let task = Task { [weak self] () -> Bool in
            guard let self else { return false }
            if let override = self.sessionRenewalOverride { return await override() }
            return await self.tryServerReLogin()
        }
        pendingSessionRenewal = task
        let result = await task.value
        pendingSessionRenewal = nil
        return result
    }

    /// Fallback-Fehlerzuordnung für ≥400-Antworten, die kein feature-
    /// spezifisches structured Error-Body liefern (oder deren Decodierung
    /// scheitert): versucht `{"error": "..."}`, sonst generischer HTTP-Text.
    private func mapGenericError(data: Data, status: Int) -> APIError {
        let msg = (try? decoder.decode([String: String].self, from: data))?["error"]
                  ?? "HTTP \(status)"
        return .server(msg)
    }

    // Strukturierte Fehler-Bodies für die Contact-Endpunkte (Arbeitspaket A1
    // "Erweiterung Ansprechpartner-Konzept") — alle Felder optional decodiert,
    // damit ein unerwartet abweichender Body die Fehlerbehandlung selbst
    // nicht zum Absturz bringt (fällt dann auf `mapGenericError` zurück).
    private struct ContactCategoryInUseBody: Decodable { let error: String?; let code: String?; let usageCount: Int? }
    private struct ContactInfoBlockConflictBody: Decodable { let error: String?; let code: String?; let block: ContactInfoBlock? }
    private struct ContactAssignmentLimitBody: Decodable { let error: String?; let code: String? }

    func request<T: Decodable>(_ method: String, _ path: String,
                               body: [String: Any]? = nil) async throws -> T {
        let (data, http) = try await performRequest(method, path, body: body)
        if http.statusCode >= 400 { throw mapGenericError(data: data, status: http.statusCode) }
        return try decoder.decode(T.self, from: data)
    }

    private func requestOK(_ method: String, _ path: String,
                           body: [String: Any]? = nil) async throws {
        let _: OKResponse = try await request(method, path, body: body)
    }

    // v1.1: AI-aware request that surfaces 402/409/422/428/503 via APIAIError.
    func aiRequest<T: Decodable>(_ method: String, _ path: String,
                                 body: [String: Any]? = nil) async throws -> T {
        let (data, http) = try await performRequest(method, path, body: body)
        if http.statusCode >= 400 {
            if let errBody = try? decoder.decode(AIErrorBody.self, from: data) {
                throw APIAIError(status: http.statusCode, message: errBody.error,
                                 code: errBody.code, detail: errBody.detail)
            }
            throw mapGenericError(data: data, status: http.statusCode)
        }
        return try decoder.decode(T.self, from: data)
    }

    // Convenience: builds a body dict and encodes String? as NSNull for JSON null.
    private static func nullable(_ s: String?) -> Any { s ?? NSNull() }

    // MARK: - Auth

    func checkSession() async throws {
        let user: AppUser = try await request("GET", "/me")
        currentUser = user
        activateOfflineSession(for: user)
    }

    /// `discardPreviousOfflineScope`: Nutzer hat die Warnung beim Kontowechsel bestaetigt (Story 10/12).
    /// Ohne Bestaetigung wirft die Anmeldung eines ANDEREN Kontos bei ausstehenden Aenderungen
    /// `OfflineError.scopeMismatch` - es wird dann weder `currentUser` gesetzt noch der alte Bestand angefasst.
    func login(username: String, password: String, rememberWithBiometry: Bool = false,
               discardPreviousOfflineScope: Bool = false) async throws {
        let user: AppUser = try await request("POST", "/login",
                                              body: ["username": username, "password": password])
        if let offline {
            do {
                try offline.userDidAuthenticate(user, discardPreviousScopeConfirmed: discardPreviousOfflineScope)
            } catch OfflineError.scopeMismatch {
                // Die frisch angelegte Serversitzung gehoert zum fremden Konto: best-effort beenden.
                _ = try? await requestOK("POST", "/logout")
                throw OfflineError.scopeMismatch
            }
        }
        currentUser = user
        offlineUnlockCredentials = nil
        loginNotice = nil
        if rememberWithBiometry {
            do {
                try Keychain.save(username: username, password: password)
                hasStoredCredentials = true
            } catch {
                // Speichern fehlgeschlagen ist nicht fatal — Login selbst war erfolgreich
            }
        }
        activateOfflineSession(for: user)
    }

    func logout() async throws {
        stopAutoRefresh()
        offlineUnlockCredentials = nil
        // Server-Logout ist best-effort: der lokale Zustand (inkl. Notifications,
        // siehe unten) muss auch bei Netzwerkausfall vollständig abgeräumt werden, sonst
        // wirkt die App abgemeldet, während Vorgänger-Daten/-Notifications noch aktiv sind.
        // Kurzes Timeout, damit Abmelden ohne Netz nicht minutenlang haengt.
        if !(offlineStatus?.isOffline ?? false) {
            _ = try? await performRequest("POST", "/logout", timeout: 5)
        }
        currentUser = nil; meetings = []; todos = []; themes = []; knowledgePages = []; contacts = []
        contactCategories = []
        stackFrames = []; stackDepth = 0
        driftIds = []; cmiByMeeting = [:]
        archivedMeetings = []; archiveTotal = 0
        graphStore?.clearOnLogout()
        progressStore?.clearOnLogout()
        // Offline-Bestand (Snapshot, Outbox, Marker, Caches, Quarantaene aller Scopes) vollstaendig loeschen (Story 12).
        offline?.deactivateAndPurgeAll()
        offlineChanges = []
        reauthRequested = false
        loginNotice = nil
        lockNotice = nil
        bootedOffline = false
        hasCompletedInitialLoad = false
        // Security requirement (analog zu GraphStore.clearOnLogout): lokale
        // Wissens-Entwürfe (unsynced, ggf. sensible Notizinhalte) gehören dem
        // vorherigen Nutzer und dürfen den Logout nicht überleben.
        KnowledgeDraftStore.clearAll()
        // Geplante/zugestellte Notifications gehören dem vorherigen Nutzer und dürfen
        // den Logout nicht überleben (gleiche Anforderung wie GraphStore.clearOnLogout()).
        // resyncSnoozeNotifications() plant beim nächsten Login idempotent alles neu.
        NotificationScheduler.shared.cancelAll()
        // Beim manuellen Logout: stored credentials behalten wir bewusst — der nächste
        // App-Start fragt dann via Face ID nach.
    }

    enum UnlockOutcome: Equatable { case online, offline }

    /// Entsperrt die App via Biometrie und meldet sich automatisch am Server an.
    /// Wird vom Lock-Screen aufgerufen. Ohne Netz: lokaler Nachweis (Biometrie) genuegt, der lokale
    /// Bestand wird geoeffnet (`.offline`); ohne Bestand `OfflineError.offlineLoginUnavailable`.
    @discardableResult
    func unlockAndAutoLogin() async throws -> UnlockOutcome {
        let creds = try credentialLoader("ThreadStack mit \(Keychain.biometryTypeDescription) entsperren")
        let probe = pathSatisfied() ? await probeSession(timeout: Self.bootProbeTimeout) : .unreachable
        switch probe {
        case .valid(let user):
            // Cookie noch gueltig - kein Re-Login noetig.
            try? offline?.userDidAuthenticate(user, discardPreviousScopeConfirmed: false)
            currentUser = user
            activateOfflineSession(for: user)
            offlineUnlockCredentials = nil
            lockNotice = nil
            isLocked = false
            return .online
        case .noSession:
            do {
                try await login(username: creds.username, password: creds.password)
                lockNotice = nil
                isLocked = false
                return .online
            } catch {
                guard isTransportFailure(error) else { throw error }
                return try enterOfflineAfterUnlock(creds)   // Verbindung brach waehrenddessen ab
            }
        case .unreachable:
            return try enterOfflineAfterUnlock(creds)
        }
    }

    static let bootProbeTimeout: TimeInterval = 2.5

    /// Lokaler Nachweis erbracht, Server nicht erreichbar: Zugangsdaten nur im Speicher halten und den
    /// lokalen Bestand oeffnen. Ohne passenden Bestand scheitert das Entsperren mit `offlineLoginUnavailable`.
    private func enterOfflineAfterUnlock(_ creds: StoredCredentials) throws -> UnlockOutcome {
        guard let marker = validOfflineMarker(), enterOffline(marker: marker) else {
            throw OfflineError.offlineLoginUnavailable
        }
        offlineUnlockCredentials = creds
        lockNotice = nil
        deferredOnlineLoadsPending = true
        hasCompletedInitialLoad = true
        isLocked = false
        return .offline
    }

    /// Marker mit gleicher Server-URL und vorhandenem Snapshot - sonst `nil`.
    private func validOfflineMarker() -> OfflineSessionMarker? {
        guard offline != nil, let snapshots = offlineSnapshots, let marker = snapshots.loadMarker(),
              marker.serverURL == OfflineScope.normalize(serverURL: serverURL),
              snapshots.loadSnapshot(scope: marker.scope) != nil else { return nil }
        return marker
    }

    /// Snapshot + Overlay anwenden und den Nutzer aus dem Marker uebernehmen. `false` = kein Snapshot.
    private func enterOffline(marker: OfflineSessionMarker) -> Bool {
        guard let offline, (try? offline.enterOffline(marker: marker)) == true else { return false }
        currentUser = marker.user
        return true
    }

    /// Direkter Server-Re-Login mit gespeicherten Credentials (ohne Biometrie-Prompt).
    /// Nur erfolgreich wenn Keychain seit dem letzten Unlock authentifiziert wurde — sonst wirft Keychain.
    /// Wird automatisch von `performRequest`/`attemptSessionRenewal` bei einem
    /// 401 während laufender Requests aufgerufen (transparenter 401-Fallback
    /// während die App läuft, siehe dort). Im Offline-Start zuerst `offlineUnlockCredentials`
    /// (kein zweiter Biometrie-Prompt direkt nach der Wiederverbindung).
    func tryServerReLogin() async -> Bool {
        guard hasStoredCredentials || offlineUnlockCredentials != nil else { return false }
        do {
            let creds = try offlineUnlockCredentials
                ?? credentialLoader("Sitzung am Server erneuern")
            // Reine Sitzungserneuerung: Offline-Scope bleibt unberuehrt (Nutzer-ID-Pruefung macht der Sync-Motor).
            currentUser = try await request("POST", "/login",
                                            body: ["username": creds.username, "password": creds.password])
            offlineUnlockCredentials = nil
            return true
        } catch {
            return false
        }
    }

    /// Explizites Renewal fuer den Sync-Motor (Story 10): liefert den Nutzer der neuen Sitzung oder `nil`.
    func renewSessionForSync() async -> AppUser? {
        guard await tryServerReLogin() else { return nil }
        return currentUser
    }

    func forgetStoredCredentials() {
        Keychain.clear()
        hasStoredCredentials = false
    }

    func changePassword(old: String, new newPW: String) async throws {
        try await requestOK("PUT", "/password", body: ["current": old, "next": newPW])
    }

    // MARK: - Load all

    /// Laedt alle Serverdaten und uebernimmt sie (mit Overlay der ausstehenden lokalen Eintraege).
    /// Aufteilung (Offline-Modus, S-11): `fetchServerDataSet` ruft ab, `applyServerData` weist zu.
    func loadAll() async throws {
        let data = try await fetchServerDataSet(includeStack: false)
        applyServerData(data, changes: offlineChanges)
    }

    /// Alle GETs von `loadAll` OHNE Zuweisung. Pflicht: Meetings, Todos, Themes (Fehler werden geworfen).
    /// Neuere Endpunkte (Kontakte, Wissen, Rubriken, Stack) tolerieren alte Server: Fehler -> `nil` (Bestand bleibt).
    func fetchServerDataSet(includeStack: Bool) async throws -> ServerDataSet {
        async let m:  [Meeting]  = request("GET", "/meetings")
        async let t:  [TodoItem] = request("GET", "/todos")
        async let th: [Theme]    = request("GET", "/themes")
        async let co: [Contact]  = request("GET", "/contacts")
        async let kp: [KnowledgePage] = request("GET", "/knowledge")
        async let cc: ContactCategoriesResponse = request("GET", "/contact-categories")
        let meetings = try await m, todos = try await t, themes = try await th
        let contacts = try? await co
        let pages = try? await kp
        let categories = (try? await cc)?.categories
        var stack: StackResponse?
        if includeStack { stack = try? await request("GET", "/stack") }
        return ServerDataSet(meetings: meetings, todos: todos, themes: themes, contacts: contacts,
                             knowledgePages: pages, contactCategories: categories,
                             stackFrames: stack?.frames, stackDepth: stack?.depth)
    }

    /// Weist Serverdaten zu. `meetings`/`todos` enthalten zusaetzlich die lokal ausstehenden Neuanlagen
    /// (`OfflineOverlay`); optionale Teile (`nil`) lassen den bisherigen Bestand unveraendert.
    func applyServerData(_ data: ServerDataSet, changes: [PendingChange]) {
        offlineChanges = changes
        let merged = OfflineOverlay.merge(serverTodos: data.todos, serverMeetings: data.meetings, changes: changes)
        meetings = merged.meetings
        todos = merged.todos
        themes = data.themes
        if let c = data.contacts { contacts = c }
        if let k = data.knowledgePages { knowledgePages = k }
        if let cc = data.contactCategories { contactCategories = cc }
        if let f = data.stackFrames { stackFrames = f; stackDepth = data.stackDepth ?? f.count }
    }

    // MARK: - Meetings

    func createMeeting(title: String, description: String, participants: [String],
                       color: String, nextDate: String,
                       isRecurring: Bool, recurrencePattern: String) async throws {
        let m: Meeting = try await request("POST", "/meetings", body: [
            "title": title, "description": description, "participants": participants,
            "color": color, "nextDate": nextDate,
            "isRecurring": isRecurring, "recurrencePattern": recurrencePattern
        ])
        meetings.append(m)
    }

    func updateMeeting(id: String, title: String, description: String, participants: [String],
                       color: String, nextDate: String,
                       isRecurring: Bool, recurrencePattern: String) async throws {
        try await requestOK("PUT", "/meetings/\(id)", body: [
            "title": title, "description": description, "participants": participants,
            "color": color, "nextDate": nextDate,
            "isRecurring": isRecurring, "recurrencePattern": recurrencePattern
        ])
        if let i = meetings.firstIndex(where: { $0.id == id }) {
            meetings[i].title = title; meetings[i].description = description
            meetings[i].participants = participants; meetings[i].color = color
            meetings[i].nextDate = nextDate; meetings[i].isRecurring = isRecurring
            meetings[i].recurrencePattern = recurrencePattern
        }
    }

    func deleteMeeting(_ id: String) async throws {
        try await requestOK("DELETE", "/meetings/\(id)")
        meetings.removeAll { $0.id == id }
    }

    func advanceDate(_ id: String) async throws {
        guard let m = meetings.first(where: { $0.id == id }),
              let d = m.nextDateParsed else { return }
        var next = d
        switch m.recurrencePattern {
        case "weekly":   next = Calendar.current.date(byAdding: .day,   value: 7,  to: d)!
        case "biweekly": next = Calendar.current.date(byAdding: .day,   value: 14, to: d)!
        case "monthly":  next = Calendar.current.date(byAdding: .month, value: 1,  to: d)!
        default: break
        }
        let s = toAPIDate(next)
        try await requestOK("PUT", "/meetings/\(id)", body: ["nextDate": s])
        if let i = meetings.firstIndex(where: { $0.id == id }) { meetings[i].nextDate = s }
    }

    // MARK: - v2.2: Archiv (Meetings archivieren statt löschen)
    // Server-Vertrag (bereits gemergt, Paket B1-B3): /api/archive/meeting/:id[...].
    // `DELETE /api/meetings/:id` bleibt unverändert bestehen (echtes, sofortiges
    // Löschen) und wird von dieser App absichtlich nicht mehr aus der UI heraus
    // aufgerufen (siehe SidebarView) — `deleteMeeting(_:)` oben bleibt aber als
    // Methode bestehen, da der Server-Endpunkt selbst nicht umgewidmet wird.

    private struct ArchiveErrorBody: Decodable {
        let error: String?
        let code: String?
        let conflicts: ArchiveConflicts?
    }

    /// Like `aiRequest`/`knowledgeRequest`, but preserves the structured 409
    /// `ARCHIVE_STACK_CONFLICT` body (`{ conflicts: { openFrames: [...] } }`) as
    /// `ArchiveConflictError` instead of collapsing it into `APIError.server(String)`.
    /// 401 still surfaces as `APIError.unauthorized`, matching the shared contract.
    private func archiveRequest<T: Decodable>(_ method: String, _ path: String,
                                               body: [String: Any]? = nil) async throws -> T {
        let (data, http) = try await performRequest(method, path, body: body)
        if http.statusCode >= 400 {
            if http.statusCode == 409,
               let errBody = try? decoder.decode(ArchiveErrorBody.self, from: data),
               let conflicts = errBody.conflicts {
                throw ArchiveConflictError(openFrames: conflicts.openFrames)
            }
            throw mapGenericError(data: data, status: http.statusCode)
        }
        return try decoder.decode(T.self, from: data)
    }

    private struct ArchiveActionResponse: Decodable {
        let ok: Bool?; let refType: String?; let refId: String?
        let archived: Bool?; let archivedAt: String?
        let alreadyArchived: Bool?; let alreadyActive: Bool?
    }

    /// Archiviert ein Meeting. Wirft `ArchiveConflictError`, wenn der Server 409
    /// ARCHIVE_STACK_CONFLICT meldet und `acknowledgeStackConflict == false` war.
    /// Entfernt das Meeting bei Erfolg optimistisch aus `meetings` (der Server
    /// liefert es über `GET /meetings` ohnehin nicht mehr) und storniert alle
    /// lokalen Erinnerungen seiner Themen — analog zu `deleteTopic`/`deleteMeeting`
    /// oben, die dasselbe `NotificationScheduler`-Muster für ihre jeweiligen IDs nutzen.
    func archiveMeeting(_ id: String, acknowledgeStackConflict: Bool = false) async throws {
        var body: [String: Any] = [:]
        if acknowledgeStackConflict { body["acknowledgeStackConflict"] = true }
        let _: ArchiveActionResponse = try await archiveRequest("POST", "/archive/meeting/\(id)", body: body)
        if let m = meetings.first(where: { $0.id == id }) {
            for t in m.topics {
                NotificationScheduler.shared.cancel(id: "topic-\(id)-\(t.id)")
            }
        }
        meetings.removeAll { $0.id == id }
    }

    /// Stellt ein archiviertes Meeting wieder her. Löst danach `refreshAll()`
    /// aus — das lädt u.a. die Meetings neu und plant über das darin enthaltene
    /// `resyncSnoozeNotifications()`-Äquivalent Snooze-Erinnerungen für das nun
    /// wieder aktive Meeting neu ein (idempotent, gleiches Muster wie beim Login).
    func restoreMeeting(_ id: String) async throws {
        let _: ArchiveActionResponse = try await archiveRequest("DELETE", "/archive/meeting/\(id)")
        archivedMeetings.removeAll { $0.id == id }
        await refreshAll(showSpinner: false)
    }

    func archivePreflight(_ id: String) async throws -> ArchivePreflight {
        try await archiveRequest("GET", "/archive/meeting/\(id)/preflight")
    }

    private struct ArchivePermanentDeleteResponse: Decodable {
        struct Deleted: Decodable {
            let topics, progressEntries, attachments, themeLinks, stackFrames, aiArtifacts: Int
        }
        let ok: Bool?
        let deleted: Deleted
    }

    func permanentlyDeleteMeeting(_ id: String) async throws {
        let _: ArchivePermanentDeleteResponse = try await archiveRequest("DELETE", "/archive/meeting/\(id)/permanent")
        archivedMeetings.removeAll { $0.id == id }
    }

    /// Serverseitige Suche (kein lokales Filtern) — analog zum Muster in
    /// `searchKnowledge`: Query-Encoding über `URLComponents`, "+" wird zusätzlich
    /// explizit als "%2B" escaped, da `percentEncodedQuery` es sonst unkodiert
    /// ließe und es serverseitig als Leerzeichen interpretiert werden könnte.
    func loadArchivedMeetings(q: String = "", offset: Int = 0) async throws {
        var comps = URLComponents()
        var items: [URLQueryItem] = []
        if !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
        items.append(URLQueryItem(name: "offset", value: String(offset)))
        comps.queryItems = items
        let encodedQuery = (comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        let r: ArchiveListResponse = try await archiveRequest("GET", "/archive/meetings?\(encodedQuery)")
        archivedMeetings = r.items
        archiveTotal = r.total
    }

    /// Lädt die Nur-Lesen-Detailansicht eines archivierten Meetings. Die Server-
    /// Response enthält zusätzlich `readOnly:true`, das `Meeting` (Vertrag oben)
    /// kennt dieses Feld nicht — unbekannte JSON-Schlüssel werden von `Decodable`
    /// standardmäßig ignoriert, ein Decode-Fehler entsteht dadurch nicht.
    func loadArchivedMeetingDetail(_ id: String) async throws -> Meeting {
        try await archiveRequest("GET", "/archive/meetings/\(id)")
    }

    // MARK: - Topics

    func createTopic(meetingId: String, title: String, description: String,
                     isTodo: Bool = false, snoozedUntil: String? = nil) async throws {
        _ = try await createTopicReturning(meetingId: meetingId, title: title, description: description,
                                            isTodo: isTodo, snoozedUntil: snoozedUntil)
    }

    @discardableResult
    func createTopicReturning(meetingId: String, title: String, description: String,
                     isTodo: Bool = false, snoozedUntil: String? = nil) async throws -> Topic {
        let payload = PendingTopicPayload(meetingId: meetingId, title: title, descriptionHTML: description,
                                          isTodo: isTodo, snoozedUntil: snoozedUntil)
        if let offline {
            try OfflineLocalValidation.validate(payload)
            if offlineStatus?.isOffline == true {
                return try enqueueTopicLocally(offline, payload, clientToken: nil, capturedAt: nil)
            }
        }
        let token = UUID().uuidString
        let firstAttempt = Date()
        var body: [String: Any] = ["title": title, "description": description, "isTodo": isTodo]
        if let s = snoozedUntil { body["snoozedUntil"] = s }
        if offline != nil { body["clientToken"] = token }
        let path = "/meetings/\(meetingId)/topics"
        do {
            let (data, http) = try await performRequest("POST", path, body: body)
            if http.statusCode >= 500 { throw APIError.network }
            if http.statusCode >= 400 { throw mapGenericError(data: data, status: http.statusCode) }
            let t = try decoder.decode(Topic.self, from: data)
            if let i = meetings.firstIndex(where: { $0.id == meetingId }) { meetings[i].topics.append(t) }
            return t
        } catch let error where shouldEnqueueAfter(error) {
            guard let offline else { throw error }
            return try enqueueTopicLocally(offline, payload, clientToken: token, capturedAt: firstAttempt)
        }
    }

    func updateTopic(meetingId: String, id: String,
                     title: String, description: String,
                     done: Bool, result: String, resultDate: String,
                     isTodo: Bool, snoozedUntil: String?) async throws {
        var id = id
        if OfflineIds.isLocal(id) {
            guard let offline else { throw OfflineError.pendingNotSynced }
            switch offline.resolveRef(refType: "topic", refId: id) {
            case .server(_, let serverId): id = serverId
            case .local:
                let p = PendingTopicPayload(meetingId: meetingId, title: title, descriptionHTML: description,
                                            isTodo: isTodo, snoozedUntil: snoozedUntil)
                try OfflineLocalValidation.validate(p)
                try updateLocalEntity(offline, entityId: id, payload: .topic(p))
                rescheduleLocalNotification(id: "topic-\(meetingId)-\(id)", title: title, snoozedUntil: snoozedUntil)
                return
            }
        }
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: [
            "title": title, "description": description, "done": done,
            "result": result, "resultDate": resultDate,
            "isTodo": isTodo, "snoozedUntil": Self.nullable(snoozedUntil)
        ])
        updateTopicInState(meetingId: meetingId, id: id) { t in
            t.title = title; t.description = description; t.done = done
            t.result = result; t.resultDate = resultDate
            t.isTodo = isTodo; t.snoozedUntil = snoozedUntil
        }
    }

    func deleteTopic(meetingId: String, id: String) async throws {
        var id = id
        if OfflineIds.isLocal(id) {
            guard let offline else { throw OfflineError.pendingNotSynced }
            switch offline.resolveRef(refType: "topic", refId: id) {
            case .server(_, let serverId): id = serverId
            case .local:
                try discardLocalEntity(offline, entityId: id)
                NotificationScheduler.shared.cancel(id: "topic-\(meetingId)-\(id)")
                return
            }
        }
        try await requestOK("DELETE", "/meetings/\(meetingId)/topics/\(id)")
        let fresh: [Meeting] = try await request("GET", "/meetings")
        meetings = overlaid(meetings: fresh)
        NotificationScheduler.shared.cancel(id: "topic-\(meetingId)-\(id)")
    }

    func completeTopic(meetingId: String, id: String, result: String, resultDate: String) async throws {
        // Sichtbarer Fortschritt (Arbeitspaket M5): utcOffsetMinutes additiv im
        // Body, `momentum`-Feld additiv in der Antwort (siehe Architektur-Vertrag
        // M1/M2 - server.js bettet es nur ein, wenn `done` sich tatsächlich
        // ändert). `CompleteMutationResponse` deckt beide möglichen Formen ab.
        let response: CompleteMutationResponse = try await request("PUT", "/meetings/\(meetingId)/topics/\(id)", body: [
            "done": true, "result": result, "resultDate": resultDate,
            "utcOffsetMinutes": utcOffsetMinutes,
        ])
        updateTopicInState(meetingId: meetingId, id: id) { t in
            t.done = true; t.result = result; t.resultDate = resultDate
        }
        presentMomentumToasts(response.momentum)
    }

    func reopenTopic(meetingId: String, id: String) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: ["done": false])
        updateTopicInState(meetingId: meetingId, id: id) { $0.done = false }
    }

    func shareTopic(meetingId: String, id: String, targetMeetingId: String) async throws {
        try await requestOK("POST", "/meetings/\(meetingId)/topics/\(id)/share",
                            body: ["targetMeetingId": targetMeetingId])
        let fresh: [Meeting] = try await request("GET", "/meetings")
        meetings = overlaid(meetings: fresh)
    }

    func moveTopic(meetingId: String, id: String, targetMeetingId: String?) async throws {
        var body: [String: Any] = [:]
        if let t = targetMeetingId { body["targetMeetingId"] = t }
        try await requestOK("POST", "/meetings/\(meetingId)/topics/\(id)/move", body: body)
        async let m: [Meeting]  = request("GET", "/meetings")
        async let t: [TodoItem] = request("GET", "/todos")
        let merged = OfflineOverlay.merge(serverTodos: try await t, serverMeetings: try await m, changes: offlineChanges)
        meetings = merged.meetings; todos = merged.todos
    }

    func toggleTopicTodo(meetingId: String, id: String) async throws {
        guard let t = getTopic(meetingId: meetingId, id: id) else { return }
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: ["isTodo": !t.isTodo])
        updateTopicInState(meetingId: meetingId, id: id) { $0.isTodo = !$0.isTodo }
    }

    func snoozeTopic(meetingId: String, id: String, until: String?) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)",
                            body: ["snoozedUntil": Self.nullable(until)])
        updateTopicInState(meetingId: meetingId, id: id) { $0.snoozedUntil = until }
        if until == nil { NotificationScheduler.shared.cancel(id: "topic-\(meetingId)-\(id)") }
    }

    func reorderTopics(meetingId: String, ids: [String]) async throws {
        // Noch nicht synchronisierte Eintraege kennt der Server nicht - sie bleiben aussen vor.
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/reorder", body: ["ids": ids.filter { !OfflineIds.isLocal($0) }])
    }

    // MARK: - Todos

    func createTodo(title: String, description: String, snoozedUntil: String? = nil, dueDate: String? = nil, isPrivate: Bool = false) async throws {
        _ = try await createTodoReturning(title: title, description: description, snoozedUntil: snoozedUntil, dueDate: dueDate, isPrivate: isPrivate)
    }

    @discardableResult
    func createTodoReturning(title: String, description: String, snoozedUntil: String? = nil, dueDate: String? = nil, isPrivate: Bool = false) async throws -> TodoItem {
        let payload = PendingTodoPayload(title: title, descriptionHTML: description, snoozedUntil: snoozedUntil,
                                         dueDate: dueDate, isPrivate: isPrivate)
        if let offline {
            try OfflineLocalValidation.validate(payload)
            if offlineStatus?.isOffline == true {
                return try enqueueTodoLocally(offline, payload, clientToken: nil, capturedAt: nil)
            }
        }
        let token = UUID().uuidString
        let firstAttempt = Date()
        var body: [String: Any] = ["title": title, "description": description, "isPrivate": isPrivate]
        if let s = snoozedUntil { body["snoozedUntil"] = s }
        if let d = dueDate     { body["dueDate"]     = d }
        if offline != nil { body["clientToken"] = token }
        do {
            let (data, http) = try await performRequest("POST", "/todos", body: body)
            if http.statusCode >= 500 { throw APIError.network }
            if http.statusCode >= 400 { throw mapGenericError(data: data, status: http.statusCode) }
            let t = try decoder.decode(TodoItem.self, from: data)
            todos.append(t)
            return t
        } catch let error where shouldEnqueueAfter(error) {
            guard let offline else { throw error }
            return try enqueueTodoLocally(offline, payload, clientToken: token, capturedAt: firstAttempt)
        }
    }

    func updateTodo(id: String, title: String, description: String,
                    done: Bool, result: String, resultDate: String,
                    snoozedUntil: String?, dueDate: String?, isPrivate: Bool = false) async throws {
        var id = id
        if OfflineIds.isLocal(id) {
            guard let offline else { throw OfflineError.pendingNotSynced }
            switch offline.resolveRef(refType: "todo", refId: id) {
            case .server(_, let serverId): id = serverId
            case .local:
                let p = PendingTodoPayload(title: title, descriptionHTML: description, snoozedUntil: snoozedUntil,
                                           dueDate: dueDate, isPrivate: isPrivate)
                try OfflineLocalValidation.validate(p)
                try updateLocalEntity(offline, entityId: id, payload: .todo(p))
                rescheduleLocalNotification(id: "todo-\(id)", title: title, snoozedUntil: snoozedUntil, isPrivate: isPrivate)
                return
            }
        }
        try await requestOK("PUT", "/todos/\(id)", body: [
            "title": title, "description": description, "done": done,
            "result": result, "resultDate": resultDate,
            "snoozedUntil": Self.nullable(snoozedUntil),
            "dueDate": Self.nullable(dueDate),
            "isPrivate": isPrivate
        ])
        if let i = todos.firstIndex(where: { $0.id == id }) {
            todos[i].title = title; todos[i].description = description
            todos[i].done = done; todos[i].result = result
            todos[i].resultDate = resultDate; todos[i].snoozedUntil = snoozedUntil
            todos[i].dueDate = dueDate; todos[i].isPrivate = isPrivate
        }
    }

    /// Setzt die Topic-Zuordnungen eines Todos atomar - Pendant zu
    /// `setKnowledgeThemes` (siehe dort), damit Topics einem Todo auch
    /// manuell zugeordnet werden können statt nur ueber `presetThemeId`
    /// beim Anlegen aus einem Topic-Kontext.
    struct TodoThemesResult: Decodable, Equatable {
        let appliedThemeIds: [String]
        let droppedCount: Int
    }

    func setTodoThemes(id: String, themeIds: [String]) async throws -> TodoThemesResult {
        try await request("PUT", "/todos/\(id)/themes", body: ["themeIds": themeIds])
    }

    func completeTodo(id: String, result: String, resultDate: String) async throws {
        // Sichtbarer Fortschritt (Arbeitspaket M5): siehe Kommentar bei
        // completeTopic (identisches Muster).
        let response: CompleteMutationResponse = try await request("PUT", "/todos/\(id)", body: [
            "done": true, "result": result, "resultDate": resultDate,
            "utcOffsetMinutes": utcOffsetMinutes,
        ])
        if let i = todos.firstIndex(where: { $0.id == id }) {
            todos[i].done = true; todos[i].result = result; todos[i].resultDate = resultDate
        }
        presentMomentumToasts(response.momentum)
    }

    func reopenTodo(id: String) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: ["done": false])
        if let i = todos.firstIndex(where: { $0.id == id }) { todos[i].done = false }
    }

    func deleteTodo(id: String) async throws {
        var id = id
        if OfflineIds.isLocal(id) {
            guard let offline else { throw OfflineError.pendingNotSynced }
            switch offline.resolveRef(refType: "todo", refId: id) {
            case .server(_, let serverId): id = serverId
            case .local:
                try discardLocalEntity(offline, entityId: id)
                NotificationScheduler.shared.cancel(id: "todo-\(id)")
                return
            }
        }
        try await requestOK("DELETE", "/todos/\(id)")
        todos.removeAll { $0.id == id }
        NotificationScheduler.shared.cancel(id: "todo-\(id)")
    }

    func moveTodo(id: String, targetMeetingId: String) async throws {
        try await requestOK("POST", "/todos/\(id)/move", body: ["targetMeetingId": targetMeetingId])
        async let m: [Meeting]  = request("GET", "/meetings")
        async let t: [TodoItem] = request("GET", "/todos")
        let merged = OfflineOverlay.merge(serverTodos: try await t, serverMeetings: try await m, changes: offlineChanges)
        meetings = merged.meetings; todos = merged.todos
    }

    func snoozeTodo(id: String, until: String?) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: ["snoozedUntil": Self.nullable(until)])
        if let i = todos.firstIndex(where: { $0.id == id }) { todos[i].snoozedUntil = until }
        if until == nil { NotificationScheduler.shared.cancel(id: "todo-\(id)") }
    }

    func reorderTodos(ids: [String]) async throws {
        try await requestOK("PUT", "/todos/reorder", body: ["ids": ids.filter { !OfflineIds.isLocal($0) }])
    }

    // MARK: - Themes

    @discardableResult
    func createTheme(title: String, description: String, parentId: String? = nil) async throws -> Theme {
        var body: [String: Any] = ["title": title, "description": description]
        if let parentId { body["parentId"] = parentId }
        let th: Theme = try await request("POST", "/themes", body: body)
        themes.append(th)
        return th
    }

    func updateTheme(id: String, title: String, description: String) async throws {
        try await requestOK("PUT", "/themes/\(id)",
                            body: ["title": title, "description": description])
        if let i = themes.firstIndex(where: { $0.id == id }) {
            themes[i].title = title; themes[i].description = description
        }
    }

    /// Verschiebt ein Topic unter ein neues Parent (nil = Wurzel).
    func moveTheme(id: String, parentId: String?) async throws {
        try await requestOK("PUT", "/themes/\(id)/move", body: ["parentId": Self.nullable(parentId)])
        if let i = themes.firstIndex(where: { $0.id == id }) { themes[i].parentId = parentId }
    }

    func themeDeletePreview(id: String) async -> ThemeDeletePreview {
        (try? await request("GET", "/themes/\(id)/delete-preview"))
            ?? ThemeDeletePreview(subTopicCount: 0, knowledgePageCount: 0)
    }

    /// cascade=true löscht Unter-Topics und deren Wissen mit; cascade=false stuft Unter-Topics
    /// eine Ebene hoch. Lädt Themes und Wissen danach neu, da sich die Baumstruktur ändert.
    func deleteTheme(id: String, cascade: Bool) async throws {
        try await requestOK("DELETE", "/themes/\(id)?cascade=\(cascade)")
        themes = (try? await request("GET", "/themes")) ?? themes.filter { $0.id != id }
        await loadKnowledgePages()
    }

    func themeChildren(of parentId: String?) -> [Theme] {
        themes.filter { $0.parentId == parentId }
            .sorted { ($0.sortOrder ?? 0) < ($1.sortOrder ?? 0) }
    }

    /// Pfad von der Wurzel bis zum Topic (inklusive), für Breadcrumbs.
    func themeAncestorsPath(_ id: String) -> [Theme] {
        var path: [Theme] = []
        var seen = Set<String>()
        var current = themes.first(where: { $0.id == id })
        while let cur = current, !seen.contains(cur.id) {
            path.insert(cur, at: 0)
            seen.insert(cur.id)
            current = cur.parentId.flatMap { pid in themes.first(where: { $0.id == pid }) }
        }
        return path
    }

    func themeDescendantIds(_ id: String) -> [String] {
        var out: [String] = []
        var stack = [id]
        while let cur = stack.popLast() {
            for c in themeChildren(of: cur) { out.append(c.id); stack.append(c.id) }
        }
        return out
    }

    // MARK: - Knowledge (Wissensseiten)

    func loadKnowledgePages() async {
        knowledgePages = (try? await request("GET", "/knowledge")) ?? knowledgePages
    }

    /// Wissen zu einem Topic, optional inkl. Unter-Topics (mit originThemeId/-Title für Herkunfts-Badges).
    /// Wirft (statt still `[]` zu liefern), damit ein 401/Netzwerkfehler nicht
    /// als "Topic hat kein Wissen" missverstanden wird (siehe ThemeDetailScreen.load()).
    func themeKnowledge(id: String, includeDescendants: Bool) async throws -> [KnowledgePage] {
        try await request("GET", "/themes/\(id)/knowledge?includeDescendants=\(includeDescendants)")
    }

    /// Todos zu einem Topic, optional inkl. Unter-Topics (mit originThemeId/-Title für Herkunfts-Badges).
    /// Wirft ebenfalls (siehe themeKnowledge).
    func themeTodos(id: String, includeDescendants: Bool) async throws -> [TodoItem] {
        try await request("GET", "/themes/\(id)/todos?includeDescendants=\(includeDescendants)")
    }

    // MARK: - Knowledge (native Rich-Text-Editor, Wissensmanagement v2.1)

    /// Server error body shape produced by `fail(res, status, code, msg, extra)`
    /// in server.js: `{ error, code, ...extra }` where `extra` may add `limit`.
    private struct KnowledgeErrorBody: Decodable {
        let error: String
        let code: String?
        let limit: Int?
    }

    /// Like `request(_:_:body:)`, but preserves the server's structured error
    /// (`code`, `limit`) as `KnowledgeAPIError` instead of collapsing every
    /// 4xx/5xx into `APIError.server(String)`. 401 still surfaces as
    /// `APIError.unauthorized`, matching the existing `request` contract, so
    /// shared session-expiry handling elsewhere in the app keeps working.
    private func knowledgeRequest<T: Decodable>(_ method: String, _ path: String,
                                                 body: [String: Any]? = nil) async throws -> T {
        let (data, http) = try await performRequest(method, path, body: body)
        if http.statusCode >= 400 {
            if let errBody = try? decoder.decode(KnowledgeErrorBody.self, from: data) {
                throw KnowledgeAPIError(status: http.statusCode, code: errBody.code ?? "",
                                        message: errBody.error, limit: errBody.limit)
            }
            throw KnowledgeAPIError(status: http.statusCode, code: "",
                                    message: "HTTP \(http.statusCode)", limit: nil)
        }
        return try decoder.decode(T.self, from: data)
    }

    func createKnowledgePage(title: String, content: String, themeIds: [String]) async throws -> KnowledgePage {
        try await knowledgeRequest("POST", "/knowledge", body: [
            "title": title, "content": content, "themeIds": themeIds
        ])
    }

    private struct KnowledgeUpdateResponse: Decodable { let ok: Bool; let updatedAt: String }

    /// Aufrufer lädt die Seite danach selbst neu (z.B. via `reloadKnowledgePage`),
    /// da PUT /api/knowledge/:id keine vollständige Seite zurückliefert.
    @discardableResult
    func updateKnowledgePage(id: String, title: String, content: String) async throws -> String {
        let r: KnowledgeUpdateResponse = try await knowledgeRequest("PUT", "/knowledge/\(id)", body: [
            "title": title, "content": content
        ])
        return r.updatedAt
    }

    struct KnowledgeThemesResult: Decodable, Equatable {
        let appliedThemeIds: [String]
        let droppedCount: Int
    }

    func setKnowledgeThemes(id: String, themeIds: [String]) async throws -> KnowledgeThemesResult {
        try await knowledgeRequest("PUT", "/knowledge/\(id)/themes", body: ["themeIds": themeIds])
    }

    /// DELETE /api/knowledge/:id. A 404 (page already gone) is treated as a
    /// successful outcome from the caller's point of view — the desired end
    /// state (page no longer exists) is reached either way — and is not
    /// thrown, matching the documented contract.
    func deleteKnowledgePage(id: String) async throws {
        do {
            let _: OKResponse = try await knowledgeRequest("DELETE", "/knowledge/\(id)")
        } catch let e as KnowledgeAPIError where e.isGone {
            // already gone — treated as success
        }
        knowledgePages.removeAll { $0.id == id }
    }

    struct KnowledgeLink: Identifiable, Decodable, Equatable {
        struct Page: Decodable, Equatable { let id: String; let title: String; let updatedAt: String? }
        let linkId: String
        let page: Page
        var id: String { linkId }
    }

    func knowledgeLinks(pageId: String) async throws -> [KnowledgeLink] {
        try await knowledgeRequest("GET", "/knowledge/\(pageId)/links")
    }

    /// POST /api/knowledge/:id/links — server responds 200 with `created:false`
    /// on a duplicate link (idempotent re-add) instead of an error; that case
    /// is surfaced to the caller as a normal (non-throwing) result here too.
    private struct KnowledgeLinkCreateResponse: Decodable {
        let linkId: String
        let created: Bool
        let page: KnowledgeLink.Page
    }

    @discardableResult
    func addKnowledgeLink(pageId: String, targetId: String) async throws -> KnowledgeLink {
        let r: KnowledgeLinkCreateResponse = try await knowledgeRequest(
            "POST", "/knowledge/\(pageId)/links", body: ["targetId": targetId])
        return KnowledgeLink(linkId: r.linkId, page: r.page)
    }

    /// DELETE /api/knowledge/:id/links/:linkId — idempotent: the server
    /// returns `{ ok: true }` even if the link was already removed, so no
    /// special-casing of 404 is needed here (the endpoint never returns one
    /// for an already-gone link per the documented contract; a defensive
    /// catch is kept in case of an unowned/foreign id which does 404).
    func removeKnowledgeLink(pageId: String, linkId: String) async throws {
        do {
            let _: OKResponse = try await knowledgeRequest("DELETE", "/knowledge/\(pageId)/links/\(linkId)")
        } catch let e as KnowledgeAPIError where e.isGone {
            // already gone — idempotent success
        }
    }

    private struct KnowledgeSearchResponse: Decodable {
        let query: String
        let results: [KnowledgeSearchHit]
    }

    func searchKnowledge(query: String) async throws -> [KnowledgeSearchHit] {
        // URLQueryItem-based encoding (statt CharacterSet.urlQueryAllowed) haelt
        // "&", "=", "+" korrekt escaped, sodass Nutzereingaben keine weiteren
        // Query-Parameter an den Aufruf anhaengen koennen.
        var comps = URLComponents()
        comps.queryItems = [URLQueryItem(name: "q", value: query)]
        // percentEncodedQuery laesst "+" unkodiert, das serverseitig aber
        // ueblicherweise als Leerzeichen interpretiert wird — explizit escapen,
        // damit z. B. "C++" nicht verfaelscht wird.
        let encodedQuery = (comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        let r: KnowledgeSearchResponse = try await knowledgeRequest("GET", "/knowledge/search?\(encodedQuery)")
        return r.results
    }

    /// There is no `GET /api/knowledge/:id` — reloading a single page after
    /// an edit goes through the list endpoint. Updates `knowledgePages` in
    /// place and returns the (possibly updated) page, or `nil` if it no
    /// longer exists (e.g. deleted concurrently on another device).
    @discardableResult
    func reloadKnowledgePage(id: String) async -> KnowledgePage? {
        guard let fresh: [KnowledgePage] = try? await request("GET", "/knowledge") else { return nil }
        knowledgePages = fresh
        return fresh.first { $0.id == id }
    }

    // MARK: - Contacts (Ansprechpartner)

    func loadContacts() async {
        do { contacts = try await request("GET", "/contacts") }
        catch { /* still — alte Server liefern 404, ok */ }
    }

    func createContact(name: String, role: String, email: String, description: String) async throws {
        let c: Contact = try await request("POST", "/contacts",
                                           body: ["name": name, "role": role, "email": email, "description": description])
        contacts.append(c)
    }

    func updateContact(id: String, name: String, role: String, email: String, description: String) async throws {
        let c: Contact = try await request("PUT", "/contacts/\(id)",
                                           body: ["name": name, "role": role, "email": email, "description": description])
        if let i = contacts.firstIndex(where: { $0.id == id }) { contacts[i] = c }
    }

    func deleteContact(id: String) async throws {
        try await requestOK("DELETE", "/contacts/\(id)")
        contacts.removeAll { $0.id == id }
    }

    /// Lädt einen einzelnen Kontakt neu und aktualisiert `contacts` in place —
    /// analog zu `reloadKnowledgePage(id:)`. `ContactDetailView` ruft dies
    /// nach Änderungen an Infoblöcken auf, da sich dadurch die serverseitig
    /// berechneten `Contact.categories`/`infoBlockCount`/`snippet`-Metadaten
    /// ändern können. `nil`, falls der Kontakt nicht mehr existiert (z.B.
    /// anderswo gelöscht).
    ///
    /// Nachbesserung Security-Review (2026-09-06): `GET /contacts/:contactId`
    /// liefert laut Server (`lib/contacts/routes.js`) das Envelope
    /// `{contact, infoBlocks, categories, themeLinks}`, keinen flachen
    /// `Contact`. `infoBlocks`/`categories`/`themeLinks` werden hier bewusst
    /// verworfen (kein aktueller Aufrufer benötigt sie über diesen Pfad —
    /// `ContactDetailView` lädt Infoblöcke separat via
    /// `loadContactInfoBlocks`), Rückgabetyp bleibt unverändert `Contact?`.
    @discardableResult
    func reloadContact(id: String) async -> Contact? {
        guard let resp: ContactDetailResponse = try? await request("GET", "/contacts/\(id)") else { return nil }
        let fresh = resp.contact
        if let i = contacts.firstIndex(where: { $0.id == id }) { contacts[i] = fresh } else { contacts.append(fresh) }
        return fresh
    }

    func addThemeLink(themeId: String, refType: String, refId: String) async throws {
        let link: ThemeLink = try await request("POST", "/themes/\(themeId)/links",
                                                body: ["refType": refType, "refId": refId])
        if let i = themes.firstIndex(where: { $0.id == themeId }) { themes[i].links.append(link) }
    }

    func removeThemeLink(id linkId: String) async throws {
        guard let idx = themes.firstIndex(where: { $0.links.contains(where: { $0.id == linkId }) })
        else { return }
        let themeId = themes[idx].id
        try await requestOK("DELETE", "/themes/\(themeId)/links/\(linkId)")
        themes[idx].links.removeAll { $0.id == linkId }
    }

    func themeLinks(for refId: String) -> [(theme: Theme, link: ThemeLink)] {
        themes.flatMap { th in th.links.filter { $0.refId == refId }.map { (th, $0) } }
    }

    func themeLinksForTheme(themeId: String) -> [(type: String, title: String, meetingId: String?)] {
        guard let theme = themes.first(where: { $0.id == themeId }) else { return [] }
        return theme.links.compactMap { link in
            if link.refType == "topic" {
                for m in meetings {
                    if let t = m.topics.first(where: { $0.id == link.refId }) {
                        return (type: "topic", title: t.title, meetingId: m.id)
                    }
                }
            } else if link.refType == "todo" {
                if let t = todos.first(where: { $0.id == link.refId }) {
                    return (type: "todo", title: t.title, meetingId: nil)
                }
            }
            return nil
        }
    }

    // MARK: - Contact-Rubriken (Arbeitspaket A1 "Erweiterung Ansprechpartner-Konzept")

    // Nachbesserung Security-Review (2026-09-06): der Server (`lib/contacts/routes.js`)
    // liefert bei allen drei Rubrik-Endpunkten unten ein Envelope
    // (`{categories:[...]}` bzw. `{category:{...}}`), keine flachen
    // Objekte/Arrays — siehe `ContactCategoriesResponse`/`ContactCategoryResponse`
    // in `Models.swift`.
    func loadContactCategories() async {
        do {
            let resp: ContactCategoriesResponse = try await request("GET", "/contact-categories")
            contactCategories = resp.categories
        } catch { /* still — alte Server liefern 404, ok */ }
    }

    @discardableResult
    func createContactCategory(label: String) async throws -> ContactCategory {
        let resp: ContactCategoryResponse = try await request("POST", "/contact-categories", body: ["label": label])
        contactCategories.append(resp.category)
        return resp.category
    }

    @discardableResult
    func updateContactCategory(id: String, label: String) async throws -> ContactCategory {
        let resp: ContactCategoryResponse = try await request("PUT", "/contact-categories/\(id)", body: ["label": label])
        if let i = contactCategories.firstIndex(where: { $0.id == id }) { contactCategories[i] = resp.category }
        return resp.category
    }

    /// Löscht eine Rubrik. Feature-Parität mit dem Web-Client
    /// (`public/contacts.js`, `deleteCategory()`): NICHT clientseitig anhand
    /// von `isDefault` einschränken, sondern den Server per Fehlercode
    /// entscheiden lassen — nur die Auffangrubrik "Sonstiges" und die
    /// Datenschutz-Rubrik "Privates" sind serverseitig unlöschbar
    /// (`409 category_fallback_protected`/`category_private_protected`,
    /// siehe `ContactCategoryProtectedError`). Alle anderen Rubriken
    /// (inkl. der Start-Rubriken "Zuständigkeit"/"Wichtiges") sind frei
    /// löschbar, auch wenn sie noch von Infoblöcken verwendet werden.
    ///
    /// Wird eine noch verwendete Rubrik ohne `confirm: true` gelöscht,
    /// antwortet der Server mit `409 category_in_use`
    /// (`ContactCategoryInUseError`, trägt `usageCount` mit). Der Aufrufer
    /// (`ContactCategorySheet`) zeigt daraufhin einen zweiten Bestätigungs-
    /// dialog ("Trotzdem löschen? Blöcke werden nach „Sonstiges" umgehängt")
    /// und ruft bei Bestätigung erneut mit `confirm: true` auf — analog zum
    /// zweistufigen Web-Flow (`?confirm=true`-Query-Parameter, siehe
    /// `lib/contacts/routes.js`).
    func deleteContactCategory(id: String, confirm: Bool = false) async throws {
        let path = "/contact-categories/\(id)" + (confirm ? "?confirm=true" : "")
        let (data, http) = try await performRequest("DELETE", path)
        if http.statusCode >= 400 {
            if http.statusCode == 409,
               let body = try? decoder.decode(ContactCategoryInUseBody.self, from: data) {
                switch body.code {
                case "category_in_use":
                    throw ContactCategoryInUseError(usageCount: body.usageCount ?? 0)
                case "category_fallback_protected", "category_private_protected":
                    throw ContactCategoryProtectedError(
                        message: body.error ?? "Diese Rubrik ist eine Systemrubrik und kann nicht gelöscht werden."
                    )
                default:
                    break
                }
            }
            throw mapGenericError(data: data, status: http.statusCode)
        }
        contactCategories.removeAll { $0.id == id }
    }

    // MARK: - Contact-Infoblöcke (Arbeitspaket A1)

    // Nachbesserung Security-Review (2026-09-06): der Server
    // (`lib/contacts/routes.js`, `planBody()`) erwartet als Request-Feld
    // `body` (nicht `bodyHtml`) und liest kein `categoryLabel`-Feld — die
    // Rubrik-Bezeichnung wird serverseitig ausschließlich über `categoryId`
    // aus der Datenbank aufgelöst (siehe `serializeInfoBlockRow`). Das
    // `categoryLabel`-Funktionsparameter bleibt aus Kompatibilitätsgründen
    // zum bestehenden Aufrufer (`ContactInfoBlockSheet.swift`, außerhalb
    // dieses Arbeitspakets) erhalten, wird aber nicht mehr mitgeschickt.
    // GET/POST/PUT liefern zudem ein `{blocks:[...], categories:[...]}`
    // bzw. `{block:{...}}`-Envelope, kein flaches Objekt/Array — siehe
    // `ContactInfoBlocksResponse`/`ContactInfoBlockResponse` in `Models.swift`.
    func loadContactInfoBlocks(contactId: String) async throws -> [ContactInfoBlock] {
        let resp: ContactInfoBlocksResponse = try await request("GET", "/contacts/\(contactId)/info-blocks")
        return resp.blocks
    }

    func createContactInfoBlock(contactId: String, categoryId: String, categoryLabel: String, bodyHtml: String) async throws -> ContactInfoBlock {
        let resp: ContactInfoBlockResponse = try await request("POST", "/contacts/\(contactId)/info-blocks", body: [
            "categoryId": categoryId, "body": bodyHtml
        ])
        return resp.block
    }

    /// Wirft `ContactInfoBlockConflictError`, wenn der Server einen
    /// `409 block_conflict` meldet (siehe Vertrag: `expectedUpdatedAt` zur
    /// Konflikterkennung) — der mitgelieferte aktuelle Serverstand steckt in
    /// `ContactInfoBlockConflictError.currentBlock`.
    func updateContactInfoBlock(contactId: String, blockId: String, categoryId: String, categoryLabel: String,
                                 bodyHtml: String, expectedUpdatedAt: String) async throws -> ContactInfoBlock {
        let (data, http) = try await performRequest("PUT", "/contacts/\(contactId)/info-blocks/\(blockId)", body: [
            "categoryId": categoryId, "body": bodyHtml, "expectedUpdatedAt": expectedUpdatedAt
        ])
        if http.statusCode == 409,
           let body = try? decoder.decode(ContactInfoBlockConflictBody.self, from: data),
           body.code == "block_conflict", let block = body.block {
            throw ContactInfoBlockConflictError(currentBlock: block)
        }
        if http.statusCode >= 400 { throw mapGenericError(data: data, status: http.statusCode) }
        return try decoder.decode(ContactInfoBlockResponse.self, from: data).block
    }

    func deleteContactInfoBlock(contactId: String, blockId: String) async throws {
        try await requestOK("DELETE", "/contacts/\(contactId)/info-blocks/\(blockId)")
    }

    func reorderContactInfoBlocks(contactId: String, categoryId: String, orderedIds: [String]) async throws {
        try await requestOK("PUT", "/contacts/\(contactId)/info-blocks/reorder", body: [
            "categoryId": categoryId, "orderedIds": orderedIds
        ])
    }

    // MARK: - Zuständigkeit (Kontakt <-> Todo/Topic, Arbeitspaket A1)

    // Nachbesserung Security-Review (2026-09-06): der Server
    // (`lib/contacts/assignments/router.js`) liefert bei GET/PUT
    // `/assignments/:refType/:refId` ein `{contacts:[...], limit?}`-Envelope,
    // kein flaches Array — siehe `AssignmentsResponse` in `Models.swift`.
    func loadAssignments(refType: String, refId: String) async throws -> [AssignedContact] {
        let resp: AssignmentsResponse = try await request("GET", "/assignments/\(refType)/\(refId)")
        return resp.contacts
    }

    /// Ersetzt die vollständige Zuständigkeits-Zuordnung eines Vorhabens
    /// (analog zu `setTodoThemes` für Topic-Zuordnungen) — wird von
    /// `TodoFormView`/`TopicFormView` EINMALIG nach dem eigentlichen
    /// Speichern des Todos/Themas aufgerufen, mit der finalen Auswahl aus
    /// `ContactAssignmentPickerSheet`. Wirft `ContactAssignmentLimitError`
    /// bei `409 assignment_limit_reached` (Fail-Safe, siehe dortiger Kommentar).
    @discardableResult
    func setAssignments(refType: String, refId: String, contactIds: [String]) async throws -> [AssignedContact] {
        let (data, http) = try await performRequest("PUT", "/assignments/\(refType)/\(refId)", body: ["contactIds": contactIds])
        if http.statusCode == 409,
           let body = try? decoder.decode(ContactAssignmentLimitBody.self, from: data),
           body.code == "assignment_limit_reached" {
            throw ContactAssignmentLimitError()
        }
        if http.statusCode >= 400 { throw mapGenericError(data: data, status: http.statusCode) }
        return try decoder.decode(AssignmentsResponse.self, from: data).contacts
    }

    /// `status` ist optional (z.B. "open"/"done") — `nil` liefert laut
    /// Vertrag alle Zuordnungen, offene vor erledigten (Server-Sortierung,
    /// `ContactDetailView` sortiert nicht selbst nach).
    ///
    /// Nachbesserung Security-Review (2026-09-06): der Server
    /// (`lib/contacts/assignments/router.js`) liefert
    /// `{items:[...], page:{...}, counts:{...}}`, kein flaches Array — siehe
    /// `ContactAssignmentsResponse` in `Models.swift`. `page`/`counts` werden
    /// hier verworfen, da kein aktueller Aufrufer sie benötigt (Rückgabetyp
    /// bleibt unverändert `[AssignmentTarget]`).
    func loadContactAssignments(contactId: String, limit: Int = 20, offset: Int = 0, status: String? = nil) async throws -> [AssignmentTarget] {
        var path = "/contacts/\(contactId)/assignments?limit=\(limit)&offset=\(offset)"
        if let status, !status.isEmpty { path += "&status=\(status)" }
        let resp: ContactAssignmentsResponse = try await request("GET", path)
        return resp.items
    }

    func removeContactAssignment(contactId: String, refType: String, refId: String) async throws {
        try await requestOK("DELETE", "/contacts/\(contactId)/assignments/\(refType)/\(refId)")
    }

    // MARK: - Admin

    func fetchUsers() async throws -> [AdminUser] {
        try await request("GET", "/users")
    }

    func createUser(username: String, password: String, isAdmin: Bool) async throws {
        try await requestOK("POST", "/users", body: [
            "username": username, "password": password,
            "role": isAdmin ? "admin" : "user"
        ])
    }

    func deleteUser(id: String) async throws {
        try await requestOK("DELETE", "/users/\(id)")
    }

    // MARK: - Helpers

    func getTopic(meetingId: String, id: String) -> Topic? {
        meetings.first(where: { $0.id == meetingId })?.topics.first(where: { $0.id == id })
    }

    private func updateTopicInState(meetingId: String, id: String, update: (inout Topic) -> Void) {
        guard let mi = meetings.firstIndex(where: { $0.id == meetingId }),
              let ti = meetings[mi].topics.firstIndex(where: { $0.id == id }) else { return }
        update(&meetings[mi].topics[ti])
    }

    var openTodoCount: Int {
        let personal     = todos.filter { !$0.done && !$0.isSnoozed }.count
        let fromMeetings = meetings.flatMap(\.topics)
                                   .filter { $0.isTodo && !$0.done && !$0.isSnoozed }.count
        return personal + fromMeetings
    }

    // MARK: - v1.1 Phase 2: Stack

    func loadStack() async {
        do {
            let r: StackResponse = try await request("GET", "/stack")
            stackFrames = r.frames; stackDepth = r.depth
        } catch {
            // Offline (Transportfehler): letzten Stand behalten statt den Stack zu leeren.
            if isTransportFailure(error) { return }
            stackFrames = []; stackDepth = 0
        }
    }

    @discardableResult
    func stackPush(refType: String, refId: String, nextStepNote: String) async throws -> StackPushResponse {
        let r: StackPushResponse = try await request("POST", "/stack/push",
            body: ["refType": refType, "refId": refId, "nextStepNote": nextStepNote])
        await loadStack()
        return r
    }

    @discardableResult
    func stackPop(frameId: String, resolution: String,
                  result: String? = nil, resultDate: String? = nil,
                  snoozedUntil: String? = nil) async throws -> StackPopResponse {
        var body: [String: Any] = ["resolution": resolution]
        if let r = result, !r.isEmpty { body["result"] = r }
        if let d = resultDate, !d.isEmpty { body["resultDate"] = d }
        if let s = snoozedUntil, !s.isEmpty { body["snoozedUntil"] = s }
        let r: StackPopResponse = try await request("POST", "/stack/pop/\(frameId)", body: body)
        await loadStack()
        try? await loadAll()
        return r
    }

    func stackUpdateNote(frameId: String, note: String) async throws {
        try await requestOK("PUT", "/stack/\(frameId)/note", body: ["nextStepNote": note])
        await loadStack()
    }

    /// Hebt ein geparktes Frame zurück an die Spitze (= macht es zum aktiven).
    /// Frame bleibt offen — keine andere Side-Effects am referenzierten Topic/Todo.
    func stackResume(frameId: String) async throws {
        let _: StackPopResponse = try await request("POST", "/stack/pop/\(frameId)",
                                                    body: ["resolution": "resumed"])
        await loadStack()
    }

    func stackHistory(from: String? = nil, to: String? = nil, resolution: String? = nil) async throws -> [StackFrame] {
        var parts: [String] = []
        if let f = from { parts.append("from=\(f)") }
        if let t = to   { parts.append("to=\(t)") }
        if let r = resolution { parts.append("resolution=\(r)") }
        let q = parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
        let r: StackHistoryResponse = try await request("GET", "/stack/history\(q)")
        return r.frames
    }

    // MARK: - v1.1: AI Settings

    func loadAiSettings() async {
        do { aiSettings = try await request("GET", "/ai/settings") }
        catch { aiSettings = nil }
    }

    @discardableResult
    func saveAiSettings(_ body: [String: Any]) async throws -> AISettings {
        let s: AISettings = try await aiRequest("PUT", "/ai/settings", body: body)
        aiSettings = s
        return s
    }

    func removeAiKey() async throws {
        let s: AISettings = try await aiRequest("DELETE", "/ai/settings/key")
        aiSettings = s
    }

    func testAiConnection() async throws -> Bool {
        struct R: Codable { let ok: Bool }
        let r: R = try await aiRequest("POST", "/ai/test")
        return r.ok
    }

    func aiUsage(period: String = "month") async throws -> AIUsageResponse {
        try await aiRequest("GET", "/ai/usage?period=\(period)")
    }

    // MARK: - v1.1: AI features

    func aiBrief(meetingId: String, confirm: Bool = false) async throws -> BriefResponse {
        try await aiRequest("POST", "/ai/meeting/\(meetingId)/brief\(confirm ? "?confirm=true" : "")")
    }

    func aiCapture(meetingId: String, notes: String, confirm: Bool = false) async throws -> CaptureResponse {
        try await aiRequest("POST", "/ai/meeting/\(meetingId)/capture\(confirm ? "?confirm=true" : "")",
                            body: ["notes": notes])
    }

    struct CaptureApplyResponse: Codable {
        struct Created: Codable {
            let topics: [String]?; let todos: [String]?; let theme_links: [String]?; let results: Int?
        }
        let created: Created
    }
    func aiCaptureApply(meetingId: String, suggestions: CaptureSuggestions) async throws {
        let body: [String: Any] = [
            "apply_now": [
                "new_topics":    suggestions.new_topics.map    { ["title": $0.title, "description": $0.description ?? ""] },
                "topic_results": suggestions.topic_results.map { ["topic_id": $0.topic_id, "result": $0.result] },
                "new_todos":     suggestions.new_todos.map     { ["title": $0.title, "description": $0.description ?? ""] },
                "theme_links":   suggestions.theme_links.map   { ["ref_type": $0.ref_type, "ref_id": $0.ref_id, "theme_id": $0.theme_id] }
            ]
        ]
        let _: CaptureApplyResponse = try await aiRequest("POST", "/ai/meeting/\(meetingId)/capture", body: body)
        try? await loadAll()
    }

    func aiResultDraft(refType: String, refId: String, confirm: Bool = false) async throws -> ResultDraftResponse {
        try await aiRequest("POST", "/ai/\(refType)/\(refId)/result-draft\(confirm ? "?confirm=true" : "")")
    }

    func aiReentry(frameId: String, confirm: Bool = false) async throws -> ReentryResponse {
        try await aiRequest("POST", "/ai/stack/\(frameId)/reentry\(confirm ? "?confirm=true" : "")")
    }

    func aiSuggestThemes(refType: String, refId: String, confirm: Bool = false) async throws -> ThemeSuggestionsResponse {
        try await aiRequest("POST", "/ai/\(refType)/\(refId)/suggest-themes\(confirm ? "?confirm=true" : "")")
    }

    func aiDigestCurrent() async throws -> DigestResponse {
        try await aiRequest("GET", "/ai/digest/weekly")
    }
    func aiDigestRegenerate(confirm: Bool = false) async throws -> DigestResponse {
        try await aiRequest("POST", "/ai/digest/weekly\(confirm ? "?confirm=true" : "")")
    }
    func aiDigestArchive() async throws -> [DigestArchiveEntry] {
        let r: DigestArchiveResponse = try await aiRequest("GET", "/ai/digest/archive")
        return r.entries
    }

    func aiCmiLoad(meetingId: String) async {
        guard aiFeatureEnabled(\.cross_meeting) else { cmiByMeeting[meetingId] = nil; return }
        do {
            let r: CMIResponse = try await aiRequest("GET", "/ai/insights/cross-meeting/\(meetingId)")
            cmiByMeeting[meetingId] = r.content
        } catch { cmiByMeeting[meetingId] = nil }
    }
    @discardableResult
    func aiCmiRecompute(meetingId: String, confirm: Bool = false) async throws -> CMIResponse {
        let r: CMIResponse = try await aiRequest("POST", "/ai/insights/cross-meeting/\(meetingId)\(confirm ? "?confirm=true" : "")")
        cmiByMeeting[meetingId] = r.content
        return r
    }
    func aiCmiDismiss(meetingId: String, artifactId: String) async throws {
        try await requestOK("DELETE", "/ai/insights/cross-meeting/\(meetingId)/\(artifactId)")
        cmiByMeeting[meetingId] = nil
    }

    func aiLoadDrift() async {
        guard aiFeatureEnabled(\.drift) else { driftIds = []; return }
        do {
            let r: DriftResponse = try await aiRequest("GET", "/ai/insights/drift")
            driftIds = Set(r.drifted.map(\.topic_id))
        } catch { driftIds = [] }
    }

    // MARK: - v1.1: AI link summary

    func aiLinkFetch(url: String) async throws -> LinkFetchResponse {
        try await aiRequest("POST", "/ai/link/fetch", body: ["url": url])
    }

    func aiLinkSummarize(pageToken: String, length: String, confirm: Bool = false) async throws -> LinkSummaryResponse {
        try await aiRequest("POST", "/ai/link/summarize\(confirm ? "?confirm=true" : "")",
                            body: ["page_token": pageToken, "length": length])
    }

    // MARK: - Offline-Modus (Paket P7: Kompositionswurzel, Host-Operationen, Fassade, Boot-Ablauf)

    static let offlineLockHint = "Offline – du kannst auf deinen letzten Stand zugreifen."
    static let offlineSavedToast = "Offline gespeichert – wird übertragen, sobald du wieder online bist."

    /// Kompositionswurzel: verbindet Coordinator, Status, Snapshot-Speicher und Pfadzustand mit AppState.
    /// `host` MUSS vor `activate` gesetzt sein - das passiert hier.
    func attachOffline(coordinator: OfflineCoordinator, status: OfflineStatusStore,
                       snapshots: OfflineSnapshotStore, pathSatisfied: @escaping () -> Bool = { true }) {
        offline = coordinator
        offlineStatus = status
        offlineSnapshots = snapshots
        self.pathSatisfied = pathSatisfied
        coordinator.host = makeOfflineHost()
        coordinator.onRequestReauth = { [weak self] in self?.reauthRequested = true }
    }

    private func makeOfflineHost() -> OfflineHostOperations {
        let http = OfflineHTTPOperations(
            send: { [weak self] method, path, body, timeout in
                guard let self else { throw APIError.network }
                return try await self.performSyncRequest(method: method, path: path, body: body, timeout: timeout)
            },
            progressEntriesPath: { [weak self] refType, refId in
                self?.progressEntriesPath(refType: refType, refId: refId) ?? ""
            })
        return OfflineHostOperations(
            currentUser: { [weak self] in self?.currentUser },
            probeSession: { [weak self] timeout in
                guard let self else { return .unreachable }
                return await self.probeSession(timeout: timeout)
            },
            renewSession: { [weak self] in await self?.renewSessionForSync() },
            fetchServerData: { [weak self] in
                guard let self else { throw APIError.network }
                return try await self.fetchServerDataSet(includeStack: true)
            },
            applyData: { [weak self] data, changes, _ in self?.applyServerData(data, changes: changes) },
            afterDataApplied: { [weak self] in await self?.afterOfflineDataApplied() },
            http: http,
            onAcknowledged: { [weak self] change, object in self?.offlineChangeAcknowledged(change, object) },
            onDiscarded: { [weak self] changes in self?.offlineChangesDiscarded(changes) },
            onPendingChanged: { [weak self] changes in self?.reapplyOverlay(changes) })
    }

    /// `GET /me` ohne Renewal (Story 3): 200 + gueltiger Nutzer = `.valid`, 401 + JSON = `.noSession`,
    /// alles andere (Transportfehler, Timeout, Nicht-JSON/Captive Portal, 5xx) = `.unreachable`.
    func probeSession(timeout: TimeInterval) async -> SessionProbeResult {
        guard let req = try? buildRequest("GET", "/me", body: nil, timeout: timeout) else { return .unreachable }
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse,
                  (try? JSONSerialization.jsonObject(with: data)) != nil else { return .unreachable }
            switch http.statusCode {
            case 200:
                guard let user = try? decoder.decode(AppUser.self, from: data) else { return .unreachable }
                return .valid(user)
            case 401: return .noSession
            default: return .unreachable
            }
        } catch {
            return .unreachable
        }
    }

    /// Nach erfolgreicher Anmeldung/Sitzungsaufbau: Marker schreiben, Outbox laden. Ein Speicherfehler ist nicht
    /// fatal (der Coordinator meldet ihn ueber `storageProblemMessage`).
    private func activateOfflineSession(for user: AppUser) {
        guard let offline else { return }
        try? offline.activate(user: user, serverURL: serverURL, biometricProtected: hasStoredCredentials)
    }

    private func afterOfflineDataApplied() async {
        await aiLoadDrift()
        resyncSnoozeNotifications()
        if deferredOnlineLoadsPending {
            deferredOnlineLoadsPending = false
            await loadAiSettings()
            await refreshMomentumStreakBadge()
        }
    }

    // MARK: Boot-Ablauf (verbindlich, siehe Architektur Paket 7)

    enum BootRoute: Equatable { case online, offline, lock, login }

    /// Entscheidet beim App-Start, was angezeigt wird. Setzt `currentUser`/`isLocked`/Hinweise entsprechend.
    @discardableResult
    func bootstrap() async -> BootRoute {
        guard !serverURL.isEmpty else { return routeWithoutSession() }
        let probe = pathSatisfied() ? await probeSession(timeout: Self.bootProbeTimeout) : .unreachable
        switch probe {
        case .valid(let user):
            try? offline?.userDidAuthenticate(user, discardPreviousScopeConfirmed: false)
            currentUser = user
            activateOfflineSession(for: user)
            await completeAuthentication(trigger: .coldStart)
            return .online
        case .noSession:
            return routeWithoutSession()
        case .unreachable:
            if let marker = validOfflineMarker() {
                bootedOffline = true
                if marker.biometricProtected {
                    if hasStoredCredentials {
                        lockNotice = Self.offlineLockHint
                        isLocked = true
                        return .lock
                    }
                    // Bestand war biometrisch geschuetzt, Zugangsdaten wurden vergessen: nicht offline oeffnen.
                    loginNotice = OfflineError.offlineLoginUnavailable.errorDescription
                    return .login
                }
                if enterOffline(marker: marker) {
                    deferredOnlineLoadsPending = true
                    hasCompletedInitialLoad = true
                    return .offline
                }
            }
            bootedOffline = true
            if hasStoredCredentials {
                lockNotice = OfflineError.offlineLoginUnavailable.errorDescription
                isLocked = true   // Entsperren endet mit offlineLoginUnavailable
                return .lock
            }
            loginNotice = OfflineError.offlineLoginUnavailable.errorDescription
            return .login
        }
    }

    private func routeWithoutSession() -> BootRoute {
        if hasStoredCredentials { isLocked = true; return .lock }
        return .login
    }

    /// Erste Datenladung nach Anmeldung/Start: Warteschlange senden + Serverstand laden, danach die
    /// einmaligen Online-Nachladungen (KI-Einstellungen, Serie) und den Auto-Refresh-Timer.
    func completeAuthentication(trigger: RefreshTrigger = .afterLogin) async {
        if let offline {
            await offline.refresh(trigger)
        } else {
            try? await loadAll()
            await loadStack()
            await aiLoadDrift()
            resyncSnoozeNotifications()
        }
        NotificationScheduler.shared.requestPermissionIfNeeded()
        if offlineStatus?.isOffline == true {
            deferredOnlineLoadsPending = true
        } else {
            await loadAiSettings()
            await refreshMomentumStreakBadge()
        }
        hasCompletedInitialLoad = true
        lastRefreshAt = Date()
        startAutoRefresh()
    }

    /// Nach erfolgreicher erneuter Anmeldung (Re-Auth-Sheet): Sync anstossen, Bestand neu laden.
    func refreshAfterReauth() async {
        reauthRequested = false
        await offline?.refresh(.afterLogin)
    }

    // MARK: Fassade fuer lokale Neuanlagen (S-12)

    /// Transportfehler, 5xx (in `createTopic/TodoReturning` zu `.network` gemacht) oder nicht decodierbare Antwort:
    /// Ergebnis unklar -> mit demselben Token einreihen. 4xx und `.invalidURL`/`.unauthorized` werden geworfen.
    private func shouldEnqueueAfter(_ error: Error) -> Bool {
        if case APIError.network = error { return true }
        return error is DecodingError
    }

    private func enqueueTodoLocally(_ off: OfflineCoordinator, _ p: PendingTodoPayload,
                                    clientToken: String?, capturedAt: Date?) throws -> TodoItem {
        let item = try off.enqueueTodo(p, clientToken: clientToken, capturedAt: capturedAt)
        if !todos.contains(where: { $0.id == item.id }) { todos.append(item) }
        rescheduleLocalNotification(id: "todo-\(item.id)", title: item.title, snoozedUntil: p.snoozedUntil,
                                    isPrivate: p.isPrivate)
        showToast(Self.offlineSavedToast)
        return item
    }

    private func enqueueTopicLocally(_ off: OfflineCoordinator, _ p: PendingTopicPayload,
                                     clientToken: String?, capturedAt: Date?) throws -> Topic {
        let topic = try off.enqueueTopic(p, clientToken: clientToken, capturedAt: capturedAt)
        if let i = meetings.firstIndex(where: { $0.id == p.meetingId }),
           !meetings[i].topics.contains(where: { $0.id == topic.id }) {
            meetings[i].topics.append(topic)
        }
        rescheduleLocalNotification(id: "topic-\(p.meetingId)-\(topic.id)", title: topic.title,
                                    snoozedUntil: p.snoozedUntil)
        showToast(Self.offlineSavedToast)
        return topic
    }

    private func updateLocalEntity(_ off: OfflineCoordinator, entityId: String, payload: PendingPayload) throws {
        do { try off.updateLocal(entityId: entityId, payload: payload) }
        catch OfflineOutboxError.notFound { throw OfflineError.pendingNotSynced }
    }

    private func discardLocalEntity(_ off: OfflineCoordinator, entityId: String) throws {
        do { _ = try off.discardLocal(entityId: entityId) }
        catch OfflineOutboxError.notFound { throw OfflineError.pendingNotSynced }
    }

    /// Lokale Erinnerung (`todo-<localId>` bzw. `topic-<meetingId>-<localId>`): nur in der Zukunft, sonst storniert.
    private func rescheduleLocalNotification(id: String, title: String, snoozedUntil: String?, isPrivate: Bool = false) {
        var fireAt: Date?
        if let s = snoozedUntil, s.count > 10, let d = parseFlexDate(s), d > Date() { fireAt = d }
        NotificationScheduler.shared.reschedule(id: id, title: title, fireAt: fireAt, isPrivate: isPrivate)
    }

    // MARK: Overlay

    private func overlaid(meetings fresh: [Meeting]) -> [Meeting] {
        OfflineOverlay.merge(serverTodos: [], serverMeetings: fresh, changes: offlineChanges).meetings
    }

    /// Outbox hat sich geaendert: lokale Eintraege neu ueber den aktuellen Serverstand legen.
    private func reapplyOverlay(_ changes: [PendingChange]) {
        offlineChanges = changes
        let baseTodos = todos.filter { !OfflineIds.isLocal($0.id) }
        var baseMeetings = meetings
        for i in baseMeetings.indices { baseMeetings[i].topics.removeAll { OfflineIds.isLocal($0.id) } }
        let merged = OfflineOverlay.merge(serverTodos: baseTodos, serverMeetings: baseMeetings, changes: changes)
        if merged.todos != todos { todos = merged.todos }
        if merged.meetings != meetings { meetings = merged.meetings }
    }

    /// Eintrag wurde uebertragen: lokale Erinnerung ab-, Server-Erinnerung einplanen; Zwischenstand-Verlauf neu laden.
    /// (Der Austausch lokal -> Server im Bestand erfolgt ueber `reapplyOverlay`.)
    private func offlineChangeAcknowledged(_ change: PendingChange, _ object: AcknowledgedObject) {
        let localId = change.localEntityId
        switch object {
        case .todo(let t):
            NotificationScheduler.shared.cancel(id: "todo-\(localId)")
            rescheduleLocalNotification(id: "todo-\(t.id)", title: t.title, snoozedUntil: t.snoozedUntil,
                                        isPrivate: t.isPrivate)
        case .topic(let meetingId, let t):
            NotificationScheduler.shared.cancel(id: "topic-\(meetingId)-\(localId)")
            rescheduleLocalNotification(id: "topic-\(meetingId)-\(t.id)", title: t.title, snoozedUntil: t.snoozedUntil)
        case .progressEntry(let e):
            if let store = progressStore, store.state(refType: e.refType, refId: e.refId) != .idle {
                Task { await store.load(refType: e.refType, refId: e.refId) }
            }
        }
    }

    /// Verworfene Eintraege (inkl. abhaengiger): lokale Erinnerungen stornieren.
    private func offlineChangesDiscarded(_ changes: [PendingChange]) {
        for c in changes {
            switch c.payload {
            case .todo: NotificationScheduler.shared.cancel(id: "todo-\(c.localEntityId)")
            case .topic(let p): NotificationScheduler.shared.cancel(id: "topic-\(p.meetingId)-\(c.localEntityId)")
            case .progress: break
            }
        }
    }

    // MARK: - Refresh (auto + manual)

    /// Lädt Meetings/Todos/Themes + Stack + Drift neu. Setzt `isRefreshing` für UI-Feedback.
    /// Verschluckt Server-Fehler still (User wird nicht durch jeden Polling-Glitch genervt).
    /// Mit Offline-Modus: laeuft ueber `OfflineCoordinator.refresh` (erst Warteschlange senden, dann laden;
    /// `showSpinner` = manuelle Aktion -> `.manual`, sonst `.auto`, das offline uebersprungen wird).
    func refreshAll(showSpinner: Bool = true) async {
        guard currentUser != nil, !isLocked else { return }
        if showSpinner { isRefreshing = true }
        if let offline {
            await offline.refresh(showSpinner ? .manual : .auto)
            if showSpinner, let status = offlineStatus, status.isOffline {
                showToast("Keine Verbindung – \(OfflineDataAsOfFormatter.label(for: status.dataAsOf)).")
            }
        } else {
            do { try await loadAll() } catch { /* still */ }
            await loadStack()
            await aiLoadDrift()
            resyncSnoozeNotifications()
        }
        lastRefreshAt = Date()
        if showSpinner { isRefreshing = false }
    }

    /// Plant lokale Notifications für alle zeitbasiert schlafenden Todos/Themen
    /// erneut ein — idempotent dank fester Identifier, sichert Re-Sync nach
    /// Neuinstallation, anderem Gerät oder verpassten Terminen bei App-Start.
    private func resyncSnoozeNotifications() {
        for t in todos {
            guard let s = t.snoozedUntil, s.count > 10, let d = parseFlexDate(s), d > Date() else { continue }
            NotificationScheduler.shared.reschedule(id: "todo-\(t.id)", title: t.title, fireAt: d, isPrivate: t.isPrivate)
        }
        for m in meetings {
            for t in m.topics {
                guard let s = t.snoozedUntil, s.count > 10, let d = parseFlexDate(s), d > Date() else { continue }
                NotificationScheduler.shared.reschedule(id: "topic-\(m.id)-\(t.id)", title: t.title, fireAt: d)
            }
        }
    }

    /// Startet einen wiederkehrenden Auto-Refresh. Idempotent — vorhandener Timer wird ersetzt.
    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: autoRefreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                // Sync/Auto-Refresh laufen nur bei aktiver App (F7).
                guard let self, self.isSceneActive else { return }
                await self.refreshAll(showSpinner: false)
            }
        }
    }

    func stopAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }
}

struct KnowledgeSearchHit: Identifiable, Decodable, Equatable {
    let id: String
    let title: String
    let snippet: String?
}
