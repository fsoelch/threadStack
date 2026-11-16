//
//  ProgressStore.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("App-Datenschicht Progress"): zentraler Zustands-Store
//  für das Zielbild-/Fortschrittsverlauf-Feature. Hält pro Ref
//  ("refType:refId", z.B. "todo:a1…") den zuletzt geladenen `ProgressDetail`,
//  Ladezustand/Fehler, nachgeladene ältere Einträge sowie das Dismiss-
//  Handling der Wiedereinstiegskarte. `AppState` wird direkt gehalten (wie
//  `AppState` selbst als `ObservableObject`) — kein Protokoll-Umweg, da hier
//  (anders als beim closure-basierten `KnowledgeSaveCoordinatorOperations`,
//  siehe dortiger Kommentar zu Witness-Mismatches über die Testtarget-Grenze)
//  keine Protokoll-Konformitätserklärung für den `@MainActor`-isolierten Typ
//  nötig ist — Unit-Tests injizieren stattdessen dieselbe
//  `AppState(session:)`-Testseam-Instanz wie `KnowledgeAPITests`.
//
//  A2/A3 beobachten ausschließlich die `@Published`-Properties und rufen die
//  Methoden unten auf; sie fassen niemals `AppState`/`ProgressAPI` direkt an.
//
//  Redesign-Update (Todo/Task-Übersicht, Arbeitspaket A1): Zielbild entfällt
//  vollständig aus der App-UI (bindende Menschen-Entscheidung) — die frühere
//  `saveGoal(refType:refId:goal:)`-Methode wurde deshalb entfernt. Siehe
//  Abschlussbericht: `ProgressGoalEditorSheet.swift` (Aufrufer von
//  `store.saveGoal`) sowie `ProgressTimelineView.swift`,
//  `ProgressReentryCardView.swift` und `ProgressEntryEditorSheet.swift`
//  (lesen `ProgressDetail.goal`, jetzt optional statt `String`) liegen in
//  anderen Paketen und wurden NICHT angefasst — das sind offene
//  Abhängigkeiten für A2/A3 (durch lokalen `xcodebuild build` bestätigt,
//  siehe Abschlussbericht).
//

import Foundation
import Combine

@MainActor
final class ProgressStore: ObservableObject {

    // MARK: - Typen

    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(ProgressDetail)
        case failed(ProgressError)

        var detail: ProgressDetail? {
            if case .loaded(let d) = self { return d }
            return nil
        }
        var error: ProgressError? {
            if case .failed(let e) = self { return e }
            return nil
        }
        var isLoading: Bool { self == .loading }
    }

    // MARK: - Published state

    /// Lade-/Detailzustand je Ref (Schlüssel "refType:refId").
    @Published private(set) var states: [String: LoadState] = [:]

    /// Über `loadMoreEntries` nachgeladene (ältere) Einträge, getrennt vom
    /// initialen `ProgressDetail.entries` gehalten, damit ein erneutes
    /// `load(...)` den Verlauf sauber zurücksetzt statt zu duplizieren.
    @Published private(set) var appendedEntries: [String: [ProgressEntry]] = [:]

    /// `true`, solange für diese Ref gerade `loadMoreEntries` läuft (verhindert
    /// parallele Doppel-Anfragen, z.B. bei mehrfachem Scroll-Trigger).
    @Published private(set) var isLoadingMore: Set<String> = []

    /// Fehler eines fehlgeschlagenen `loadMoreEntries`-Versuchs. Wird bewusst
    /// getrennt von `states` gehalten: ein Nachladefehler darf den bereits
    /// sichtbaren Verlauf nicht verstecken (kein Rückfall in `.failed`).
    @Published private(set) var loadMoreError: [String: ProgressError] = [:]

    /// Ob die Wiedereinstiegskarte für diese Ref aktuell angezeigt werden
    /// soll (siehe `dismissReentry`/Dismiss-Persistenz unten). Wird nach
    /// jedem `load(...)` und jedem `dismissReentry(...)` neu berechnet.
    @Published private(set) var reentryVisible: [String: Bool] = [:]

    /// Refs, deren angezeigter Verlauf aus dem lokalen Cache stammt (offline, Server nicht erreichbar).
    @Published private(set) var staleRefs: Set<String> = []

    // MARK: - Internals

    /// `clientToken` je Ref für den aktuell laufenden "Zwischenstand
    /// hinzufügen"-Versuch (siehe `clientTokenForPendingEntry`). Bewusst kein
    /// `@Published` — reines internes Idempotenz-Bookkeeping, keine UI-Relevanz.
    private var pendingEntryTokens: [String: String] = [:]

    private let appState: AppState
    private let defaults: UserDefaults

    /// Sentinel für `dismissReentry`, falls `reentry.dormantSince` (seltener
    /// Randfall) `nil` ist, obwohl `reentry.show == true` — kollidiert nie mit
    /// einem echten ISO-8601-Zeitstempel.
    private static let dismissedWithoutTimestampSentinel = "__dismissed_no_timestamp__"

    init(appState: AppState, defaults: UserDefaults = .standard) {
        self.appState = appState
        self.defaults = defaults
    }

    private func key(_ refType: String, _ refId: String) -> String { "\(refType):\(refId)" }
    private func dismissDefaultsKey(_ refType: String, _ refId: String) -> String {
        "ts.progress.dismiss.\(refType):\(refId)"
    }

    // MARK: - Accessors

    func state(refType: String, refId: String) -> LoadState { states[key(refType, refId)] ?? .idle }
    func detail(refType: String, refId: String) -> ProgressDetail? { state(refType: refType, refId: refId).detail }

    /// Initial geladene Einträge + über `loadMoreEntries` nachgeladene,
    /// unverändert in Server-Reihenfolge (neueste zuerst).
    func entries(refType: String, refId: String) -> [ProgressEntry] {
        let k = key(refType, refId)
        return (detail(refType: refType, refId: refId)?.entries ?? []) + (appendedEntries[k] ?? [])
    }

    func hasMoreEntries(refType: String, refId: String) -> Bool {
        latestPage(refType: refType, refId: refId)?.hasMore ?? false
    }

    private var pageOverride: [String: ProgressPage] = [:]

    private func latestPage(refType: String, refId: String) -> ProgressPage? {
        let k = key(refType, refId)
        return pageOverride[k] ?? detail(refType: refType, refId: refId)?.page
    }

    /// `true`, wenn der angezeigte Verlauf aus dem lokalen Cache stammt (Stand kann veraltet sein).
    func isStale(refType: String, refId: String) -> Bool { staleRefs.contains(key(refType, refId)) }

    func shouldShowReentry(refType: String, refId: String) -> Bool {
        reentryVisible[key(refType, refId)] ?? false
    }

    // MARK: - Load

    func load(refType: String, refId: String, limit: Int = 20) async {
        // Ein noch nicht synchronisiertes Vorhaben hat keinen Serververlauf (S-12).
        guard !OfflineIds.isLocal(refId) else { return }
        let k = key(refType, refId)
        states[k] = .loading
        do {
            let detail = try await appState.loadProgress(refType: refType, refId: refId, limit: limit)
            states[k] = .loaded(detail)
            staleRefs.remove(k)
            appendedEntries[k] = []
            pageOverride[k] = nil
            loadMoreError[k] = nil
            cacheDetail(detail, refType: refType, refId: refId)
            recomputeReentryVisibility(refType: refType, refId: refId)
        } catch {
            let mapped = Self.mapError(error)
            // Offline: zuletzt geladenen Verlauf aus dem lokalen Bestand zeigen (als veraltet markiert);
            // ohne Cache bleibt es bei `.failed(.offline)`.
            if mapped == .offline, let cached = cachedDetail(refType: refType, refId: refId) {
                states[k] = .loaded(cached)
                staleRefs.insert(k)
                appendedEntries[k] = []
                pageOverride[k] = nil
                recomputeReentryVisibility(refType: refType, refId: refId)
            } else {
                states[k] = .failed(mapped)
            }
        }
    }

    private func cacheDetail(_ detail: ProgressDetail, refType: String, refId: String) {
        guard let snapshots = appState.offlineSnapshots, let scope = appState.writableOfflineScope else { return }
        snapshots.saveProgressDetail(detail, refType: refType, refId: refId, scope: scope)
    }

    private func cachedDetail(refType: String, refId: String) -> ProgressDetail? {
        guard let snapshots = appState.offlineSnapshots, let scope = appState.writableOfflineScope else { return nil }
        return snapshots.loadProgressDetail(refType: refType, refId: refId, scope: scope)
    }

    /// Erneuter Ladeversuch nach einem Fehler (UI: "Erneut versuchen") —
    /// funktional identisch zu `load`, eigener Name für klare Aufrufer-Absicht.
    func retry(refType: String, refId: String, limit: Int = 20) async {
        await load(refType: refType, refId: refId, limit: limit)
    }

    func loadMoreEntries(refType: String, refId: String, limit: Int = 20) async {
        let k = key(refType, refId)
        guard !isLoadingMore.contains(k) else { return }
        guard let cursor = latestPage(refType: refType, refId: refId)?.nextCursor else { return }
        isLoadingMore.insert(k)
        defer { isLoadingMore.remove(k) }
        do {
            let page = try await appState.loadProgressEntries(refType: refType, refId: refId, cursor: cursor, limit: limit)
            appendedEntries[k, default: []].append(contentsOf: page.entries)
            pageOverride[k] = page.page
            loadMoreError[k] = nil
        } catch {
            // Bereits geladener Verlauf bleibt unverändert sichtbar; der
            // Fehler wird für eine optionale Retry-Anzeige veröffentlicht,
            // nicht verschluckt (siehe CLAUDE.md: Fehler werden behandelt,
            // nicht verschluckt).
            loadMoreError[k] = Self.mapError(error)
        }
    }

    // MARK: - Nächster Schritt
    // Zielbild entfällt vollständig aus der App-UI (bindende Menschen-
    // Entscheidung) — die frühere `saveGoal(refType:refId:goal:)`-Methode
    // wurde deshalb entfernt.

    @discardableResult
    func saveNextStep(refType: String, refId: String, nextStep: String) async throws -> ProgressMeta {
        do {
            let meta = try await appState.saveProgressNextStep(refType: refType, refId: refId, nextStep: nextStep)
            replaceDetail(refType: refType, refId: refId) { old in
                ProgressDetail(ref: old.ref, goal: old.goal, goalUpdatedAt: old.goalUpdatedAt,
                                nextStep: meta.nextStep ?? old.nextStep,
                                nextStepUpdatedAt: meta.nextStepUpdatedAt ?? old.nextStepUpdatedAt,
                                stats: old.stats, reentry: old.reentry, entries: old.entries, page: old.page)
            }
            return meta
        } catch {
            throw Self.mapError(error)
        }
    }

    private func replaceDetail(refType: String, refId: String, transform: (ProgressDetail) -> ProgressDetail) {
        let k = key(refType, refId)
        guard case .loaded(let old) = states[k] else { return }
        states[k] = .loaded(transform(old))
    }

    // MARK: - Einträge: hinzufügen / bearbeiten / löschen

    /// Liefert einen stabilen `clientToken` für den aktuell laufenden
    /// "Zwischenstand hinzufügen"-Versuch dieser Ref: bei erneutem Aufruf
    /// (z.B. Retry nach `.offline`) wird der VORHERIGE Token zurückgegeben,
    /// nicht ein neuer erzeugt — Grundlage der Server-Idempotenz (siehe
    /// Vertrag). Ein neuer Token entsteht erst wieder, nachdem `addEntry`
    /// erfolgreich war, oder nach explizitem `discardPendingEntryToken`.
    func clientTokenForPendingEntry(refType: String, refId: String) -> String {
        let k = key(refType, refId)
        if let existing = pendingEntryTokens[k] { return existing }
        let token = UUID().uuidString
        pendingEntryTokens[k] = token
        return token
    }

    /// Verwirft den aktuell vorbereiteten `clientToken` (z.B. Nutzer bricht
    /// die Eingabe ab, ohne zu speichern) — der nächste Versuch bekommt einen
    /// frischen Token.
    func discardPendingEntryToken(refType: String, refId: String) {
        pendingEntryTokens.removeValue(forKey: key(refType, refId))
    }

    /// Fügt einen Zwischenstand hinzu und lädt den Ref danach neu (statt die
    /// serverseitig neu berechneten, nicht-trivialen Felder wie
    /// `stats.dormant`/`gapDaysBefore`/`badgeLabel` lokal nachzubilden — das
    /// würde Server-Business-Logik duplizieren und wäre eine potenzielle
    /// Divergenzquelle). Bewusste Design-Entscheidung: Korrektheit vor
    /// optimistischem UI-Update; A2 kann bei Bedarf zusätzlich einen
    /// optimistischen Zwischenzustand in der View selbst halten.
    ///
    /// Offline-Modus (S-12): Fuer Todos/Themen wird der Zwischenstand bei lokalem Vorhaben, bekannter
    /// Offline-Lage oder `ProgressError.offline` in die Outbox eingereiht (mit dem bestehenden Token) und als
    /// lokaler `ProgressEntry` (`local-…`) zurueckgegeben - der Composer leert dann das Feld. Fuer andere
    /// Bezuege (Kontakt) bleibt der Fehler und die Eingabe im Dialog erhalten.
    @discardableResult
    func addEntry(refType: String, refId: String, bodyHTML: String, source: String) async throws -> ProgressEntry {
        let k = key(refType, refId)
        let token = clientTokenForPendingEntry(refType: refType, refId: refId)
        let canQueue = Self.isQueueable(refType)
        if canQueue, appState.offline != nil,
           OfflineIds.isLocal(refId) || appState.offlineStatus?.isOffline == true {
            return try enqueueOffline(refType: refType, refId: refId, bodyHTML: bodyHTML, source: source, token: token)
        }
        do {
            let entry = try await appState.addProgressEntry(refType: refType, refId: refId, bodyHTML: bodyHTML,
                                                              source: source, clientToken: token)
            pendingEntryTokens.removeValue(forKey: k)
            await load(refType: refType, refId: refId)
            return entry
        } catch {
            let mapped = Self.mapError(error)
            if mapped == .offline, canQueue, appState.offline != nil {
                return try enqueueOffline(refType: refType, refId: refId, bodyHTML: bodyHTML, source: source, token: token)
            }
            throw mapped
        }
    }

    /// Nur Todos und Themen werden offline eingereiht (Entscheidung: Kontakt-Zwischenstaende nicht).
    private static func isQueueable(_ refType: String) -> Bool { refType == "todo" || refType == "topic" }

    private func enqueueOffline(refType: String, refId: String, bodyHTML: String, source: String,
                                token: String) throws -> ProgressEntry {
        guard let off = appState.offline else { throw ProgressError.offline }
        do {
            try OfflineLocalValidation.validateProgress(bodyHTML: bodyHTML)
            let payload = PendingProgressPayload(ref: off.resolveRef(refType: refType, refId: refId),
                                                 bodyHTML: bodyHTML, source: source)
            let entry = try off.enqueueProgress(payload, clientToken: token)
            pendingEntryTokens.removeValue(forKey: key(refType, refId))
            appState.showToast(AppState.offlineSavedToast)
            return entry
        } catch {
            throw Self.mapError(error)
        }
    }

    @discardableResult
    func updateEntry(refType: String, refId: String, entryId: String, bodyHTML: String) async throws -> ProgressEntry {
        // Lokaler (noch nicht uebertragener) Eintrag: Outbox bearbeiten statt Server (S-12).
        if OfflineIds.isLocal(entryId) {
            return try updateLocalEntry(refType: refType, refId: refId, entryId: entryId, bodyHTML: bodyHTML)
        }
        do {
            let entry = try await appState.updateProgressEntry(entryId: entryId, bodyHTML: bodyHTML)
            await load(refType: refType, refId: refId)
            return entry
        } catch {
            throw Self.mapError(error)
        }
    }

    func deleteEntry(refType: String, refId: String, entryId: String) async throws {
        if OfflineIds.isLocal(entryId) {
            guard let off = appState.offline else { throw ProgressError.entryGone }
            do { _ = try off.discardLocal(entityId: entryId) }
            catch OfflineOutboxError.notFound { throw ProgressError.entryGone }
            catch { throw Self.mapError(error) }
            return
        }
        do {
            try await appState.deleteProgressEntry(entryId: entryId)
            await load(refType: refType, refId: refId)
        } catch {
            throw Self.mapError(error)
        }
    }

    private func updateLocalEntry(refType: String, refId: String, entryId: String, bodyHTML: String) throws -> ProgressEntry {
        guard let off = appState.offline, let status = appState.offlineStatus,
              let summaryId = status.summary(forEntityId: entryId)?.id,
              case .progress(let existing)? = status.intents.payload(summaryId) else { throw ProgressError.entryGone }
        do {
            try OfflineLocalValidation.validateProgress(bodyHTML: bodyHTML)
            let updated = PendingProgressPayload(ref: existing.ref, bodyHTML: bodyHTML, source: existing.source)
            try off.updateLocal(entityId: entryId, payload: .progress(updated))
        } catch OfflineOutboxError.notFound {
            throw ProgressError.entryGone
        } catch {
            throw Self.mapError(error)
        }
        guard let entry = pendingEntries(refType: refType, refId: refId).first(where: { $0.id == entryId }) else {
            throw ProgressError.entryGone
        }
        return entry
    }

    // MARK: - Offline: ausstehende Zwischenstaende

    /// Ausstehende (noch nicht uebertragene) Zwischenstaende dieses Vorhabens als lokale `ProgressEntry`
    /// (`id` = `local-…`), neueste zuerst. Quelle: Spiegel der Outbox in `AppState`.
    func pendingEntries(refType: String, refId: String) -> [ProgressEntry] {
        guard let status = appState.offlineStatus else { return [] }
        let changes = Dictionary(appState.offlineChanges.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // Zuordnung (Alias, wartendes/fehlgeschlagenes Eltern-Vorhaben) liefert der Status (`makeSummaries`);
        // hier wird sie nicht nachgebaut.
        return status.pendingProgress(refType: refType, refId: refId).reversed().compactMap { summary in
            guard let change = changes[summary.id] else { return nil }
            return change.localProgressEntry(resolvedRef: (refType, refId))
        }
    }

    /// Logout: In-Memory-Zustand des vorherigen Nutzers verwerfen.
    func clearOnLogout() {
        states = [:]
        appendedEntries = [:]
        isLoadingMore = []
        loadMoreError = [:]
        reentryVisible = [:]
        staleRefs = []
        pendingEntryTokens = [:]
        pageOverride = [:]
    }

    // MARK: - Wiedereinstiegskarte: Dismiss-Handling

    /// Persistiert das Dismiss für die AKTUELLE Ruhephase (`reentry.dormantSince`
    /// zum Dismiss-Zeitpunkt). Key-Schema: "ts.progress.dismiss.<refType>:<refId>"
    /// (siehe Vertrag). Bei einer neuen Ruhephase (anderes `dormantSince`)
    /// erscheint die Karte automatisch wieder, da der gespeicherte Wert dann
    /// nicht mehr mit dem aktuellen übereinstimmt.
    func dismissReentry(refType: String, refId: String) {
        guard let detail = detail(refType: refType, refId: refId) else { return }
        let value = detail.reentry.dormantSince ?? Self.dismissedWithoutTimestampSentinel
        defaults.set(value, forKey: dismissDefaultsKey(refType, refId))
        recomputeReentryVisibility(refType: refType, refId: refId)
    }

    private func recomputeReentryVisibility(refType: String, refId: String) {
        let k = key(refType, refId)
        guard let detail = detail(refType: refType, refId: refId), detail.reentry.show else {
            reentryVisible[k] = false
            return
        }
        let dismissedValue = defaults.string(forKey: dismissDefaultsKey(refType, refId))
        let currentValue = detail.reentry.dormantSince ?? Self.dismissedWithoutTimestampSentinel
        reentryVisible[k] = dismissedValue != currentValue
    }

    // MARK: - Fehler-Normalisierung

    /// Normalisiert jeden von den `AppState`-Progress-Methoden geworfenen
    /// Fehler auf `ProgressError`, damit A2/A3 nur EINEN Fehlertyp behandeln
    /// müssen. `APIError.unauthorized` (401) wird dabei bewusst NICHT als
    /// generischer `.server`-Text kaschiert, sondern mit einer eigenen,
    /// verständlichen Meldung abgebildet — die zentrale Re-Login-Behandlung
    /// an anderer Stelle der App reagiert weiterhin auf das ursprüngliche
    /// `APIError.unauthorized`, da dieses Mapping erst NACH dem `throw` in
    /// `AppState`, hier im Store, stattfindet und den Originalfehler nicht
    /// verändert, nur für die Store-Konsumenten in eine einheitliche Form bringt.
    static func mapError(_ error: Error) -> ProgressError {
        if let e = error as? ProgressError { return e }
        if let e = error as? OfflineError {
            // Verstaendlicher deutscher Text (Validierung, lokaler Speicherfehler, Eintrag noch nicht synchronisiert).
            return .server(e.errorDescription ?? "Die Aktion konnte nicht ausgeführt werden.")
        }
        if error is OfflineOutboxError { return .entryGone }
        if let e = error as? APIError {
            switch e {
            case .unauthorized: return .server("Sitzung abgelaufen — bitte neu anmelden.")
            case .invalidURL, .network: return .offline
            case .server(let m): return .server(m)
            }
        }
        return .offline
    }
}
