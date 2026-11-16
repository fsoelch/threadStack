import Foundation
import os

//  OfflineCoordinator.swift
//  Arbeitspaket P3, Schnittstelle S-11: Kompositionsschicht des Offline-Modus.
//  Verbindet ConnectivityMonitor, Outbox, Sync-Motor, Snapshot und OfflineStatusStore
//  und bietet AppState (P7) die Fassade fuer lokale Neuanlagen.
//
//  Datenschutz/Logging: nur Zustandswechsel und Anzahlen, nie Titel, Texte, Tokens, Nutzernamen.

enum RefreshTrigger: Equatable { case coldStart, manual, auto, foreground, reconnect, afterLogin }

struct OfflineHostOperations {
    var currentUser: () -> AppUser?
    var probeSession: (_ timeout: TimeInterval) async -> SessionProbeResult
    var renewSession: () async -> AppUser?
    var fetchServerData: () async throws -> ServerDataSet
    var applyData: (_ data: ServerDataSet, _ changes: [PendingChange], _ fromCache: Bool) -> Void
    var afterDataApplied: () async -> Void
    var http: OfflineHTTPOperations
    var onAcknowledged: (PendingChange, AcknowledgedObject) -> Void
    var onDiscarded: ([PendingChange]) -> Void
    var onPendingChanged: ([PendingChange]) -> Void
}

extension OfflineTexts {
    // Eigene Erweiterung (OfflineUIComponents.swift wird parallel von P5 angepasst).
    /// Outbox-Datei war nicht lesbar: sie wurde gesichert (nie still geloescht), es geht leer weiter.
    static let outboxUnreadable = "Gespeicherte Änderungen konnten nicht gelesen werden. Die Datei wurde gesichert."
}

final class OfflineCoordinator {
    static let probeInterval: TimeInterval = 8
    static let probeTimeout: TimeInterval = 5

    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ThreadStack", category: "offline")

    private let status: OfflineStatusStore
    private let connectivity: ConnectivityMonitor
    private let files: UserScopedFileStore
    private let snapshots: OfflineSnapshotStore
    private let now: () -> Date
    private let sleep: (TimeInterval) async -> Void
    private let probeInterval: TimeInterval

    /// Von der Kompositionswurzel gesetzt.
    var host: OfflineHostOperations!
    /// Wird von `intents.requestReauth` gerufen (P7 oeffnet damit das Re-Auth-Sheet).
    var onRequestReauth: (() -> Void)?

    private(set) var activeScope: OfflineScope?
    private var outbox: OfflineOutbox?
    private var engine: OfflineSyncEngine?
    private var lastServerData: ServerDataSet?
    private var isActive = true
    private var generation = 0

    /// Grund fuer "offline", wenn der Pfad selbst nichts anderes sagt: Pfad fehlt -> noNetwork, sonst Server nicht erreichbar.
    private var currentOfflineReason: OfflineReason { connectivity.isPathSatisfied ? .serverUnreachable : .noNetwork }

    private var refreshTask: Task<Void, Never>?
    private var probeLoopTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?

    /// `sleep`/`probeInterval` sind Test-Seams (Standard: Task.sleep, 8 s).
    init(status: OfflineStatusStore, connectivity: ConnectivityMonitor, files: UserScopedFileStore,
         snapshots: OfflineSnapshotStore, now: @escaping () -> Date = Date.init,
         probeInterval: TimeInterval = OfflineCoordinator.probeInterval,
         sleep: @escaping (TimeInterval) async -> Void = { _ = try? await Task.sleep(for: .seconds($0)) }) {
        self.status = status
        self.connectivity = connectivity
        self.files = files
        self.snapshots = snapshots
        self.now = now
        self.probeInterval = probeInterval
        self.sleep = sleep
    }

    // MARK: Lebenszyklus

    func startMonitoring() {
        connectivity.onPathChange = { [weak self] satisfied in self?.pathChanged(satisfied) }
        connectivity.start()
    }

    /// Nach erfolgreicher Anmeldung/Sitzungsaufbau: Marker schreiben, Outbox laden, Intents setzen.
    func activate(user: AppUser, serverURL: String, biometricProtected: Bool) throws {
        let scope = OfflineScope(serverURL: OfflineScope.normalize(serverURL: serverURL), userId: user.id)
        let marker = OfflineSessionMarker(user: user, serverURL: scope.serverURL,
                                          biometricProtected: biometricProtected, savedAt: now())
        try snapshots.saveMarker(marker)
        if activeScope == scope, outbox != nil {
            engine?.resume()   // gleiche Sitzung (z.B. nach erneuter Anmeldung): Outbox/Motor behalten
            return
        }
        tearDown()
        try attach(scope: scope)
    }

    /// Kaltstart ohne Netz: Snapshot + Overlay anwenden. `false` = kein Snapshot vorhanden.
    func enterOffline(marker: OfflineSessionMarker) throws -> Bool {
        let scope = marker.scope
        if activeScope != scope || outbox == nil {
            tearDown()
            try attach(scope: scope)
        }
        status.connection = .offline(currentOfflineReason)
        startProbeLoopIfNeeded()
        guard let snapshot = snapshots.loadSnapshot(scope: scope) else { return false }
        lastServerData = snapshot.data
        status.dataAsOf = snapshot.savedAt
        status.isShowingCachedData = true
        host.applyData(snapshot.data, outbox?.changes ?? [], true)
        refreshItems()
        return true
    }

    /// Nutzer hat sich (erneut) angemeldet. Verglichen wird nur die Nutzer-ID gegen den Marker/aktiven Scope
    /// (die Signatur enthaelt keine Server-URL): Anderes Konto mit ausstehenden Aenderungen -> ohne Bestaetigung
    /// `scopeMismatch`, mit Bestaetigung wird der alte Bestand komplett verworfen. Gleiche Nutzer-ID auf einem
    /// ANDEREN Server wird hier nicht erkannt; `activate` legt dafuer einen eigenen Scope an (alter Scope bleibt
    /// bis Logout/Purge unberuehrt, es werden nie Daten vermischt).
    func userDidAuthenticate(_ user: AppUser, discardPreviousScopeConfirmed: Bool) throws {
        guard let marker = snapshots.loadMarker() else {
            if let s = activeScope, s.userId != user.id { try discardScope(s, confirmed: discardPreviousScopeConfirmed) }
            return
        }
        let previous = marker.scope
        let sameAccount = previous.userId == user.id
        if sameAccount {
            // Gleicher Nutzer: Marker-Server darf abweichen (URL geaendert) -> dann ist es ein anderer Scope.
            if let s = activeScope, s.userId == user.id { engine?.resume() }
            return
        }
        try discardScope(previous, confirmed: discardPreviousScopeConfirmed)
    }

    private func discardScope(_ scope: OfflineScope, confirmed: Bool) throws {
        let pending = pendingCount(in: scope)
        if pending > 0 && !confirmed { throw OfflineError.scopeMismatch }
        if activeScope == scope { tearDown() }
        snapshots.removeScope(scope)
        snapshots.clearMarker()
        status.items = []
        status.dataAsOf = nil
        status.isShowingCachedData = false
        status.activity = .idle
        lastServerData = nil
        Self.log.info("previous scope discarded, pending=\(pending)")
    }

    private func pendingCount(in scope: OfflineScope) -> Int {
        if activeScope == scope, let ob = outbox { return ob.visibleChanges.count }
        guard let ob = try? OfflineOutbox(scope: scope, store: files, now: now) else { return 0 }
        return ob.visibleChanges.count
    }

    /// Logout: alles lokal Gespeicherte loeschen und alle Aufgaben beenden.
    func deactivateAndPurgeAll() {
        tearDown()
        snapshots.purgeAll()
        lastServerData = nil
        status.connection = .online
        status.activity = .idle
        status.dataAsOf = nil
        status.isShowingCachedData = false
        status.items = []
        status.storageProblemMessage = nil
        status.intents = OfflineIntents()
    }

    private func tearDown() {
        generation += 1
        refreshTask?.cancel(); refreshTask = nil
        probeLoopTask?.cancel(); probeLoopTask = nil
        retryTask?.cancel(); retryTask = nil
        engine?.stop()
        engine = nil
        outbox?.onChange = nil
        outbox = nil
        activeScope = nil
    }

    private func attach(scope: OfflineScope) throws {
        let ob: OfflineOutbox
        do {
            ob = try OfflineOutbox(scope: scope, store: files, now: now)
        } catch OfflineStorageError.corruptQuarantined {
            // Datei wurde gesichert (nie still geloescht); mit leerer Outbox weiterarbeiten, Nutzer informieren.
            status.storageProblemMessage = OfflineTexts.outboxUnreadable
            ob = try OfflineOutbox(scope: scope, store: files, now: now)
        } catch {
            status.storageProblemMessage = OfflineError.localStorageFailed.errorDescription
            throw error
        }
        let host = self.host!
        let api = OfflineSyncAPI(http: host.http)
        let eng = OfflineSyncEngine(outbox: ob, api: api, scopeUserId: scope.userId,
                                    currentUserId: { [weak self] in self?.host.currentUser()?.id },
                                    renewSession: { [weak self] in await self?.host.renewSession() },
                                    now: now)
        eng.onAcknowledged = { [weak self] change, object in self?.host.onAcknowledged(change, object) }
        eng.onActivityChange = { [weak self] activity in
            guard let self else { return }
            self.status.activity = activity
            if activity == .paused(.storageProblem) {
                self.status.storageProblemMessage = OfflineError.localStorageFailed.errorDescription
            }
        }
        ob.onChange = { [weak self] in self?.outboxChanged() }
        outbox = ob
        engine = eng
        activeScope = scope
        installIntents(outbox: ob)
        refreshItems()
    }

    private func installIntents(outbox ob: OfflineOutbox) {
        var intents = OfflineIntents()
        intents.syncNow = { [weak self] in await self?.refresh(.manual) }
        intents.retry = { [weak self] id in
            try ob.retry(id: id)
            self?.kickSync()
        }
        intents.discard = { [weak self] id in
            let removed = try ob.discard(id: id)
            self?.host.onDiscarded(removed)
        }
        intents.dependentsCount = { id in ob.dependents(of: id).count }
        intents.payload = { id in ob.changes.first { $0.id == id }?.payload }
        intents.reassignTopic = { [weak self] id, meetingId in
            try ob.reassignTopic(id: id, toMeetingId: meetingId)
            self?.kickSync()
        }
        intents.convertTopicToTodo = { [weak self] id in
            try ob.convertTopicToTodo(id: id)
            self?.kickSync()
        }
        intents.requestReauth = { [weak self] in self?.onRequestReauth?() }
        status.intents = intents
    }

    /// Nutzeraktion (Erneut senden, Zuordnen, Als Todo uebernehmen): sofort synchronisieren. `.manual` setzt den
    /// Backoff zurueck - der Nutzer hat den Eintrag ausdruecklich angestossen.
    private func kickSync() {
        guard isActive else { return }
        Task { await self.refresh(.manual) }
    }

    private func outboxChanged() {
        refreshItems()
        if let ob = outbox { host.onPendingChanged(ob.changes) }
    }

    private func refreshItems() {
        guard let ob = outbox else { return }
        status.refresh(from: ob, meetings: lastServerData?.meetings ?? [], todos: lastServerData?.todos ?? [])
    }

    // MARK: Ausloeser

    func scenePhaseChanged(isActive active: Bool) {
        guard active != isActive else { return }
        isActive = active
        if active {
            guard activeScope != nil else { return }
            startProbeLoopIfNeeded()
            Task { await self.refresh(.foreground) }
        } else {
            probeLoopTask?.cancel(); probeLoopTask = nil
            retryTask?.cancel(); retryTask = nil
        }
    }

    private func pathChanged(_ satisfied: Bool) {
        guard activeScope != nil else { return }
        if !satisfied {
            setConnection(.offline(.noNetwork))
            return
        }
        guard isActive else { return }
        Task { await self.refresh(.reconnect) }
    }

    /// Von `performRequest` gemeldet.
    func reportTransport(success: Bool) {
        guard activeScope != nil else { return }
        if success {
            if status.isOffline, isActive { Task { await self.refresh(.reconnect) } }
        } else if !status.isOffline {
            setConnection(.offline(currentOfflineReason))
        }
    }

    private func setConnection(_ new: OfflineConnectionState) {
        guard status.connection != new else { return }
        let wasOffline = status.isOffline
        status.connection = new
        if new == .online {
            // Verbindungswechsel: Backoff, Capability-Cache und technische Pause zuruecksetzen.
            engine?.resetBackoff()
            probeLoopTask?.cancel(); probeLoopTask = nil
        } else {
            if !wasOffline { engine?.resetBackoff() }   // Verbindungswechsel online -> offline
            startProbeLoopIfNeeded()
        }
        Self.log.info("connection changed, offline=\(new != .online)")
    }

    private func startProbeLoopIfNeeded() {
        guard probeLoopTask == nil, isActive, status.isOffline, activeScope != nil else { return }
        let gen = generation
        probeLoopTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.sleep(self.probeInterval)
                if Task.isCancelled || self.generation != gen { return }
                guard self.isActive, self.status.isOffline else { continue }
                await self.refresh(.reconnect)
                if !self.status.isOffline { return }
            }
        }
    }

    private func scheduleRetry(at date: Date) {
        retryTask?.cancel()
        let gen = generation
        retryTask = Task { [weak self] in
            guard let self else { return }
            await self.sleep(max(0, date.timeIntervalSince(self.now())))
            if Task.isCancelled || self.generation != gen { return }
            guard self.isActive else { return }
            await self.refresh(.auto)
        }
    }

    // MARK: Refresh

    /// Gleichzeitige Aufrufe teilen sich eine Task. Der Ausloeser eines zweiten Aufrufers wird verworfen:
    /// er erhaelt das Ergebnis des laufenden Refresh (z.B. wirkt ein `.manual` waehrend eines `.auto` nicht
    /// mehr als Backoff-Reset). Nach Logout/Kontowechsel (`tearDown`) startet ein neuer Aufruf einen frischen Lauf.
    func refresh(_ trigger: RefreshTrigger) async {
        if let running = refreshTask { await running.value; return }
        let task = Task { await self.performRefresh(trigger) }
        refreshTask = task
        await task.value
        // Nur das EIGENE Handle freigeben: ein nach tearDown gestarteter neuer Refresh bleibt teilbar.
        if refreshTask == task { refreshTask = nil }
    }

    private enum ProbeResult { case offline, online, mismatch }

    private func probe() async -> ProbeResult {
        guard connectivity.isPathSatisfied else {
            setConnection(.offline(.noNetwork))
            return .offline
        }
        let result = await host.probeSession(Self.probeTimeout)
        switch result {
        case .unreachable:
            setConnection(.offline(.serverUnreachable))
            return .offline
        case .valid(let user):
            setConnection(.online)
            if let scope = activeScope, user.id != scope.userId { return .mismatch }
            return .online
        case .noSession:
            setConnection(.online)
            return .online
        }
    }

    private func performRefresh(_ trigger: RefreshTrigger) async {
        guard let scope = activeScope, let ob = outbox, let engine else { return }
        let gen = generation
        func valid() -> Bool { generation == gen && !Task.isCancelled }

        if trigger == .auto, status.isOffline { return }
        if status.isOffline || trigger == .reconnect {
            switch await probe() {
            case .offline: return
            case .mismatch:
                engine.setPaused(.userMismatch)
                return
            case .online: break
            }
            if !valid() { return }
        }
        // Nie Daten/Aenderungen eines anderen Kontos verarbeiten (Sitzung gehoert nicht zum Scope).
        if let user = host.currentUser(), user.id != scope.userId {
            engine.setPaused(.userMismatch)
            return
        }
        if trigger == .manual { engine.resetBackoff() }   // ausdrueckliche Nutzeraktion: sofort erneut versuchen

        // 1. Warteschlange abarbeiten
        let outcome = await engine.runOnce()
        guard valid() else { return }
        switch outcome {
        case .paused(.userMismatch): return   // niemals Daten eines anderen Kontos anzeigen/speichern
        case .stoppedTransient(let at): scheduleRetry(at: at)
        default: break
        }

        // 2./3. Abruf
        let fetchStartedAt = now()
        var data: ServerDataSet
        do {
            data = try await host.fetchServerData()
        } catch {
            guard valid() else { return }
            guard let retried = await recoverFetch(after: error, scope: scope) else { return }
            data = retried
        }
        guard valid() else { return }
        // Sicherheitsnetz: Daten nur uebernehmen, wenn die Sitzung noch zum Scope gehoert.
        if let user = host.currentUser(), user.id != scope.userId {
            engine.setPaused(.userMismatch)
            return
        }

        // 4. Abgleich
        let todoIds = Set(data.todos.map(\.id))
        let topicIds = Set(data.meetings.flatMap(\.topics).map(\.id))
        do {
            try ob.reconcile(serverTodoIds: todoIds, serverTopicIds: topicIds, fetchStartedAt: fetchStartedAt)
        } catch {
            status.storageProblemMessage = OfflineError.localStorageFailed.errorDescription
        }

        // 5. Anwenden
        lastServerData = data
        setConnection(.online)
        host.applyData(data, ob.changes, false)
        status.dataAsOf = now()
        status.isShowingCachedData = false
        refreshItems()

        // 6. Snapshot (Best Effort, hoechstens einmal pro Refresh)
        let snapshot = OfflineSnapshot(savedAt: now(), data: data)
        try? await snapshots.saveSnapshot(snapshot, scope: scope)
        guard valid() else { return }

        // 7. Nacharbeiten
        await host.afterDataApplied()
    }

    /// Fehler beim Abruf: Transportfehler -> offline (nichts ueberschreiben); 401 -> einmal erneuern und wiederholen.
    private func recoverFetch(after error: Error, scope: OfflineScope) async -> ServerDataSet? {
        if isTransportFailure(error) {
            setConnection(.offline(currentOfflineReason))
            return nil
        }
        if let api = error as? APIError, case .unauthorized = api {
            // Pausen laufen ausschliesslich ueber den Motor (`setPaused`); gleiche Renewal-Entscheidung wie dort.
            let user = await host.renewSession()
            if let reason = OfflineSyncEngine.classifyRenewal(user, scopeUserId: scope.userId) {
                engine?.setPaused(reason)
                return nil
            }
            engine?.resume()
            do { return try await host.fetchServerData() }
            catch {
                if isTransportFailure(error) { setConnection(.offline(currentOfflineReason)) }
                return nil
            }
        }
        Self.log.info("fetch failed (non-transport)")
        return nil
    }

    // MARK: Fassade fuer lokale Neuanlagen

    private func requireOutbox() throws -> OfflineOutbox {
        guard let ob = outbox else { throw OfflineError.localStorageFailed }
        return ob
    }

    private func mapStorage<T>(_ body: () throws -> T) throws -> T {
        do { return try body() }
        catch let e as OfflineStorageError where e == .writeFailed {
            status.storageProblemMessage = OfflineError.localStorageFailed.errorDescription
            throw OfflineError.localStorageFailed
        }
    }

    func enqueueTodo(_ p: PendingTodoPayload, clientToken: String?, capturedAt: Date?) throws -> TodoItem {
        let ob = try requireOutbox()
        let change = try mapStorage { try ob.enqueueTodo(p, clientToken: clientToken, capturedAt: capturedAt) }
        guard let item = change.localTodoItem() else { throw OfflineError.localStorageFailed }
        return item
    }

    func enqueueTopic(_ p: PendingTopicPayload, clientToken: String?, capturedAt: Date?) throws -> Topic {
        let ob = try requireOutbox()
        let change = try mapStorage { try ob.enqueueTopic(p, clientToken: clientToken, capturedAt: capturedAt) }
        guard let topic = change.localTopic() else { throw OfflineError.localStorageFailed }
        return topic
    }

    func enqueueProgress(_ p: PendingProgressPayload, clientToken: String?) throws -> ProgressEntry {
        let ob = try requireOutbox()
        let target: (refType: String, refId: String)
        switch ob.resolve(p.ref) {
        case .server(let t, let id): target = (t, id)
        case .waitingForParent(let pid), .parentFailed(let pid):
            guard let parent = ob.changes.first(where: { $0.id == pid }) else { throw OfflineError.pendingNotSynced }
            target = (parent.kind.refType, parent.localEntityId)
        case .parentGone:
            throw OfflineError.validation(PendingFailureReason.refGone.userMessage)
        }
        let change = try mapStorage { try ob.enqueueProgress(p, clientToken: clientToken, capturedAt: nil) }
        guard let entry = change.localProgressEntry(resolvedRef: target) else { throw OfflineError.localStorageFailed }
        return entry
    }

    func updateLocal(entityId: String, payload: PendingPayload) throws {
        let ob = try requireOutbox()
        guard let change = ob.change(forLocalEntityId: entityId) else { throw OfflineOutboxError.notFound }
        try mapStorage { try ob.updatePayload(id: change.id, payload) }
    }

    func discardLocal(entityId: String) throws -> [PendingChange] {
        let ob = try requireOutbox()
        guard let change = ob.change(forLocalEntityId: entityId) else { throw OfflineOutboxError.notFound }
        let removed = try mapStorage { try ob.discard(id: change.id) }
        host.onDiscarded(removed)
        return removed
    }

    /// local-… -> `.local`, Alias -> `.server(serverId)`, sonst `.server`.
    func resolveRef(refType: String, refId: String) -> PendingRef {
        guard OfflineIds.isLocal(refId) else { return .server(refType: refType, refId: refId) }
        if let c = outbox?.change(forLocalEntityId: refId) { return .local(changeId: c.id) }
        if let alias = outbox?.alias(forLocalId: refId) { return .server(refType: refType, refId: alias) }
        let raw = String(refId.dropFirst(OfflineIds.localPrefix.count))
        if let uuid = UUID(uuidString: raw) { return .local(changeId: uuid) }   // loest sich zu parentGone auf
        return .server(refType: refType, refId: refId)
    }
}
