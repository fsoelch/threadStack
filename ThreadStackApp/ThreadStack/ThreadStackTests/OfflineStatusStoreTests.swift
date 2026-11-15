import Testing
import Foundation
@testable import ThreadStack

//  Paket P2, S-6/S-10: Statusmodell, Texte, UI-Logik, Performance.

@Suite(.serialized)
struct OfflineStatusStoreTests {
    typealias T = OfflineTestSupport

    private func outbox() throws -> (OfflineOutbox, UserScopedFileStore) {
        let store = T.makeStore()
        return (try OfflineOutbox(scope: T.scope, store: store), store)
    }

    // MARK: Statusmodell

    @Test func defaultsAreOnlineIdleAndIntentsAreInert() async {
        let s = OfflineStatusStore()
        #expect(s.connection == .online && !s.isOffline)
        #expect(s.activity == .idle)
        #expect(s.items.isEmpty && s.unsyncedCount == 0 && s.failedCount == 0)
        #expect(s.dataAsOf == nil && !s.isShowingCachedData && s.storageProblemMessage == nil)
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.retry(UUID()) }
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.discard(UUID()) }
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.reassignTopic(UUID(), "m") }
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.convertTopicToTodo(UUID()) }
        #expect(s.intents.dependentsCount(UUID()) == 0)
        #expect(s.intents.payload(UUID()) == nil)
        await s.intents.syncNow()
        s.intents.requestReauth()
    }

    @Test func isOfflineFollowsConnection() {
        let s = OfflineStatusStore()
        s.connection = .offline(.noNetwork)
        #expect(s.isOffline)
        s.connection = .offline(.serverUnreachable)
        #expect(s.isOffline)
        s.connection = .online
        #expect(!s.isOffline)
    }

    @Test func refreshBuildsSortedSummariesAndCounts() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo("Erstes"))
        let b = try ob.enqueueTopic(T.topic("Thema", meeting: "m1"))
        let c = try ob.enqueueTodo(T.todo("Drittes"))
        _ = try ob.markInFlight(id: b.id)
        _ = try ob.markInFlight(id: c.id)
        try ob.markFailed(id: c.id, reason: .refGone)
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [T.meeting("m1", title: "Montag")], todos: [])
        #expect(s.items.map(\.id) == [a.id, b.id, c.id])
        #expect(s.items[0].status == .pending)
        #expect(s.items[1].status == .syncing && s.items[1].contextText == "Montag")
        #expect(s.items[2].status == .failed(message: PendingFailureReason.refGone.userMessage))
        #expect(s.unsyncedCount == 3 && s.failedCount == 1)
        #expect(s.summary(forEntityId: a.localEntityId)?.title == "Erstes")
        #expect(s.summary(forEntityId: "local-unbekannt") == nil)
    }

    @Test func acknowledgedAndTombstonedItemsAreNotListed() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: a.id)
        try ob.markAcknowledged(id: a.id, serverId: "s1", object: .todo(T.serverTodo("s1")))
        let b = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: b.id)
        try ob.discard(id: b.id)
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [])
        #expect(s.items.isEmpty)
    }

    @Test func progressItemsAreMatchedByRefAndWaitingOnParentIsBlocked() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let p = try ob.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "s1"), body: "<p>Direkt</p>"))
        let parent = try ob.enqueueTodo(T.todo("Neues Vorhaben"))
        let dep = try ob.enqueueProgress(T.progress(ref: .local(changeId: parent.id), body: "<p>Danach</p>"))
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [T.serverTodo("s1", title: "Altes Todo")])
        #expect(s.pendingProgress(refType: "todo", refId: "s1").map(\.id) == [p.id])
        #expect(s.pendingProgress(refType: "todo", refId: "s1").first?.contextText == "Altes Todo")
        let depItem = try #require(s.items.first { $0.id == dep.id })
        #expect(depItem.status == .blocked(message: "Wird nach dem Vorhaben übertragen."))
        #expect(s.pendingProgress(refType: "todo", refId: parent.localEntityId).map(\.id) == [dep.id])
        // Elternteil scheitert -> Hinweis nennt den Titel.
        _ = try ob.markInFlight(id: parent.id)
        try ob.markFailed(id: parent.id, reason: .rejected(message: nil))
        s.refresh(from: ob, meetings: [], todos: [])
        let after = try #require(s.items.first { $0.id == dep.id })
        #expect(after.status == .blocked(message: "Wartet auf 'Neues Vorhaben', der fehlgeschlagen ist."))
    }

    @Test func fullTextContainsTitleAndPlainDescription() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        _ = try ob.enqueueTodo(PendingTodoPayload(title: "T", descriptionHTML: "<p>Zeile <b>eins</b></p>",
                                                  snoozedUntil: nil, dueDate: nil, isPrivate: false))
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [])
        #expect(s.items[0].fullText == "T\n\nZeile eins")
    }

    // MARK: Texte (UX-Wortlaut)

    @Test func failureReasonTextsFollowUXWording() {
        #expect(PendingFailureReason.meetingArchived.userMessage ==
                "Das Meeting wurde inzwischen archiviert. Ordne das Thema einem anderen Meeting zu oder übernimm es als Todo.")
        #expect(PendingFailureReason.meetingGone.userMessage ==
                "Das Meeting existiert nicht mehr. Ordne das Thema einem anderen Meeting zu oder übernimm es als Todo.")
        #expect(PendingFailureReason.refGone.userMessage ==
                "Das zugehörige Vorhaben existiert nicht mehr. Kopiere den Text, falls du ihn behalten willst.")
        #expect(PendingFailureReason.refDone.userMessage ==
                "Das Vorhaben wurde inzwischen erledigt. Kopiere den Text, falls du ihn behalten willst.")
        #expect(PendingFailureReason.validation(message: "Titel zu lang.").userMessage ==
                "Der Server hat den Eintrag abgelehnt: Titel zu lang. Bitte bearbeite den Eintrag und sende ihn erneut.")
        #expect(PendingFailureReason.tokenConflict.userMessage ==
                "Der Eintrag konnte nicht eindeutig zugeordnet werden. Bitte erneut senden.")
        #expect(PendingFailureReason.rejected(message: "Nein").userMessage == "Nein")
        #expect(PendingFailureReason.rejected(message: nil).userMessage == "Der Server hat den Eintrag abgelehnt.")
        #expect(PendingFailureReason.rejected(message: "  ").userMessage == "Der Server hat den Eintrag abgelehnt.")
    }

    @Test func offlineErrorTexts() {
        #expect(OfflineError.pendingNotSynced.errorDescription ==
                "Dieser Eintrag ist noch nicht synchronisiert. Diese Aktion ist erst danach möglich.")
        #expect(OfflineError.notAvailableOffline.errorDescription ==
                "Keine Verbindung – dein Inhalt bleibt im Dialog erhalten. Bitte versuche es erneut, sobald du wieder online bist.")
        #expect(OfflineError.localStorageFailed.errorDescription ==
                "Der Eintrag konnte auf diesem Gerät nicht gespeichert werden. Bitte kopiere den Text und versuche es später erneut.")
        #expect(OfflineError.offlineLoginUnavailable.errorDescription == "Keine Verbindung – Anmeldung erst mit Netz möglich.")
        #expect(OfflineError.scopeMismatch.errorDescription ==
                "Die Änderungen gehören zu einem anderen Konto und werden nicht übertragen.")
        #expect(OfflineError.validation("x").errorDescription == "x")
    }

    // MARK: Modelle

    @Test func scopeNormalizationAndKey() {
        #expect(OfflineScope.normalize(serverURL: "  https://a.test/// ") == "https://a.test")
        #expect(OfflineScope(serverURL: "https://a", userId: "u").key == "https://a\nu")
    }

    @Test func idHelpers() {
        #expect(OfflineIds.isLocal("local-abc") && !OfflineIds.isLocal("abc"))
        #expect(OfflineIds.isSafeServerId("abc_DEF-1"))
        for bad in ["", "local-x", "a b", "a/b", "..", String(repeating: "a", count: 65)] {
            #expect(!OfflineIds.isSafeServerId(bad), "\(bad)")
        }
    }

    @Test func pendingChangeCodableRoundTrip() throws {
        let c = PendingChange(id: UUID(), seq: 7, clientToken: UUID().uuidString, capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123),
                              payload: .progress(T.progress(ref: .local(changeId: UUID()))),
                              state: .failed(.validation(message: "x")), revision: 3, followUp: .update,
                              isTombstone: false, attemptCount: 2, lastAttemptAt: Date(),
                              acknowledgedObject: .topic(meetingId: "m1", T.serverTopic("t1", meeting: "m1")))
        let data = try JSONEncoder().encode(c)
        #expect(try JSONDecoder().decode(PendingChange.self, from: data) == c)
    }

    // MARK: Badge / Stand-Anzeige / Platzhalter

    @Test func badgeVariantsTextsAndIcons() {
        #expect(PendingSyncBadgeLogic.text(for: .pending) == "Nicht synchronisiert")
        #expect(PendingSyncBadgeLogic.text(for: .syncing) == "Wird synchronisiert")
        #expect(PendingSyncBadgeLogic.text(for: .failed) == "Fehlgeschlagen")
        #expect(PendingSyncBadgeLogic.text(for: .blocked) == "Wartet")
        #expect(PendingSyncBadgeLogic.iconName(for: .pending) == "icloud.slash")
        #expect(PendingSyncBadgeLogic.iconName(for: .syncing) == "arrow.triangle.2.circlepath")
        #expect(PendingSyncBadgeLogic.iconName(for: .failed) == "exclamationmark.triangle")
        #expect(PendingSyncBadgeLogic.iconName(for: .blocked) == "clock")
        #expect(PendingSyncBadgeLogic.kind(for: .failed(message: "x")) == .failed)
        #expect(PendingSyncBadgeLogic.kind(for: .blocked(message: "x")) == .blocked)
        #expect(PendingSyncBadgeLogic.accessibilityLabel(for: .pending, itemDescription: "Todo 'Titel'")
                == "Todo 'Titel', nicht synchronisiert")
        #expect(PendingSyncBadgeLogic.accessibilityLabel(for: .pending, itemDescription: nil) == "Nicht synchronisiert")
    }

    @Test func dataAsOfFormatting() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Date {
            cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
        }
        let now = date(2026, 11, 15, 18, 0)
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 11, 15, 14, 32), now: now, calendar: cal) == "heute, 14:32")
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 11, 14, 9, 5), now: now, calendar: cal) == "gestern, 09:05")
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 11, 13, 14, 32), now: now, calendar: cal) == "13.11., 14:32")
        #expect(OfflineDataAsOfFormatter.string(for: date(2025, 11, 15, 14, 32), now: now, calendar: cal) == "15.11.2025, 14:32")
        // Monats-/Jahresgrenze fuer "gestern".
        let newYear = date(2027, 1, 1, 8, 0)
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 12, 31, 23, 59), now: newYear, calendar: cal) == "gestern, 23:59")
        #expect(OfflineDataAsOfFormatter.label(for: date(2026, 11, 13, 14, 32), now: now, calendar: cal) == "Stand vom 13.11., 14:32")
        #expect(OfflineDataAsOfFormatter.label(for: date(2026, 11, 15, 14, 32), now: now, calendar: cal) == "Stand: heute, 14:32")
        #expect(OfflineDataAsOfFormatter.label(for: nil, now: now, calendar: cal) == "Noch kein Stand geladen")
    }

    @Test func unavailableViewTexts() {
        #expect(OfflineTexts.unavailableTitle == "Offline nicht verfügbar")
        #expect(OfflineUnavailableReason.notLoadedYet.explanation ==
                "Dieser Inhalt wurde noch nicht geladen. Er ist verfügbar, sobald du wieder online bist.")
        #expect(OfflineUnavailableReason.custom("x").explanation == "x")
        #expect(OfflineTexts.retry == "Erneut versuchen")
    }

    // MARK: Performance (NFR)

    @Test func performanceSnapshotWith5000TodosAndTopics() async throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let todos = (0..<5000).map { T.serverTodo("td\($0)", title: "Todo Nummer \($0)") }
        let topics = (0..<5000).map { T.serverTopic("tp\($0)", meeting: "m1") }
        let data = ServerDataSet(meetings: [T.meeting("m1", topics: topics)], todos: todos, themes: [],
                                 contacts: nil, knowledgePages: nil, contactCategories: nil, stackFrames: nil, stackDepth: nil)
        let snapshots = OfflineSnapshotStore(store: store)
        let clock = ContinuousClock()
        let saveTime = try await clock.measure {
            try await snapshots.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: data), scope: T.scope)
        }
        var loaded: OfflineSnapshot?
        let loadTime = clock.measure { loaded = snapshots.loadSnapshot(scope: T.scope) }
        #expect(loaded?.data.todos.count == 5000)
        #expect(loaded?.data.meetings.first?.topics.count == 5000)
        print("PERF snapshot 5000+5000: save=\(saveTime) load=\(loadTime)")
        #expect(loadTime < .seconds(1))   // Kaltstart-Lesen deutlich unter 1 s
        #expect(saveTime < .seconds(1))   // Encoding auf dem Aufrufer-Actor ueberschreitet 100 ms nicht dramatisch
        // Overlay ueber den grossen Bestand bleibt schnell.
        let overlayTime = clock.measure {
            _ = OfflineOverlay.merge(serverTodos: todos, serverMeetings: data.meetings, changes: [])
        }
        #expect(overlayTime < .milliseconds(500))
    }

    @Test func performanceOutboxWithFiveHundredEntries() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let ob = try OfflineOutbox(scope: T.scope, store: store)
        for i in 0..<499 { _ = try ob.enqueueTodo(T.todo("Eintrag \(i)")) }
        let clock = ContinuousClock()
        var change: PendingChange?
        let writeTime = try clock.measure { change = try ob.enqueueTodo(T.todo("Eintrag 500")) }
        print("PERF outbox 500 entries write=\(writeTime)")
        #expect(ob.changes.count == 500)
        #expect(writeTime < .milliseconds(300))
        var reloaded: OfflineOutbox?
        let loadTime = try clock.measure { reloaded = try OfflineOutbox(scope: T.scope, store: store) }
        #expect(reloaded?.changes.count == 500 && reloaded?.changes.last == change)
        #expect(loadTime < .milliseconds(300))
    }
}
