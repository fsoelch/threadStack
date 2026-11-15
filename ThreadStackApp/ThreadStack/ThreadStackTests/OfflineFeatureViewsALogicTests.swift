import Testing
import Foundation
@testable import ThreadStack

//  Paket P5: Offline-Entscheidungslogik der Feature-Views A
//  (Todos, Themen, Formulare, Zwischenstaende). Reine Logik, kein View-Rendering.

@MainActor @Suite(.serialized)
struct OfflineFeatureALogicTests {
    typealias L = OfflineFeatureALogic
    let local = "local-3f2a9c1e-0000-4000-8000-000000000001"
    let server = "abc123"

    private func summary(id: UUID = UUID(), kind: PendingChangeKind = .createProgressEntry,
                         entityId: String? = "local-x", at: TimeInterval = 0,
                         status: PendingItemStatus = .pending) -> PendingItemSummary {
        PendingItemSummary(id: id, kind: kind, title: "t", contextText: nil,
                           capturedAt: Date(timeIntervalSince1970: at), status: status,
                           entityId: entityId, refType: "todo", refId: "r1", fullText: "t")
    }

    // MARK: Server-Aktionen (Erledigen, Snooze, Verschieben, Teilen, Reorder, Topics ...)

    @Test func serverActionOnSyncedEntryOnlineIsAllowed() {
        #expect(L.serverActionDisabledReason(id: server, isOffline: false) == nil)
    }

    @Test func serverActionOnSyncedEntryOfflineIsDisabledWithUnavailableText() {
        #expect(L.serverActionDisabledReason(id: server, isOffline: true) == "Offline nicht verfügbar")
    }

    @Test func serverActionOnLocalEntryIsAlwaysDisabledWithPendingText() {
        let expected = "Dieser Eintrag ist noch nicht synchronisiert. Diese Aktion ist erst danach möglich."
        #expect(L.serverActionDisabledReason(id: local, isOffline: false) == expected)
        #expect(L.serverActionDisabledReason(id: local, isOffline: true) == expected)
    }

    // MARK: Bearbeiten

    @Test func editRules() {
        #expect(L.editDisabledReason(id: server, isOffline: false) == nil)
        #expect(L.editDisabledReason(id: server, isOffline: true) == "Offline nicht verfügbar")
        // Lokale Eintraege sind offline UND online bearbeitbar.
        #expect(L.editDisabledReason(id: local, isOffline: true) == nil)
        #expect(L.editDisabledReason(id: local, isOffline: false) == nil)
    }

    // MARK: Loeschen / Verwerfen

    @Test func deleteModeRules() {
        #expect(L.deleteMode(id: server, isOffline: false) == .server)
        #expect(L.deleteMode(id: server, isOffline: true) == .disabled(reason: "Offline nicht verfügbar"))
        #expect(L.deleteMode(id: local, isOffline: true) == .discardLocal)
        #expect(L.deleteMode(id: local, isOffline: false) == .discardLocal)
    }

    @Test func discardMessageMentionsDependentProgressEntries() {
        #expect(L.discardMessage(title: "Plan", dependents: 0)
                == "'Plan' wird nicht übertragen und gelöscht. Zugehörige ausstehende Zwischenstände werden ebenfalls verworfen.")
        #expect(L.discardMessage(title: "Plan", dependents: 1).contains("Der zugehörige ausstehende Zwischenstand"))
        #expect(L.discardMessage(title: "Plan", dependents: 3).contains("Die 3 zugehörigen ausstehenden Zwischenstände"))
    }

    @Test func discardMessageForProgressEntryOmitsDependentsHint() {
        #expect(L.discardMessage(title: "Text", dependents: 0, showsDependentsHint: false)
                == "'Text' wird nicht übertragen und gelöscht.")
    }

    @Test func discardRequestUsesDependentsFromIntents() {
        let store = OfflineStatusStore()
        let id = UUID()
        store.items = [summary(id: id, kind: .createTodo, entityId: local)]
        store.intents.dependentsCount = { $0 == id ? 2 : 0 }
        let r = store.discardRequest(forEntityId: local, title: "Plan")
        #expect(r.id == local)
        #expect(r.dependents == 2)
        #expect(r.showsDependentsHint)
        // Unbekannte ID -> 0 abhaengige, kein Absturz.
        #expect(store.discardRequest(forEntityId: "local-unknown", title: "X").dependents == 0)
    }

    // MARK: Formularfelder (Konsistenzentscheidung 8)

    @Test func relationFieldsDisabledOfflineOrForLocalEntry() {
        #expect(L.relationFieldsDisabled(isOffline: false, entryId: nil) == false)       // online neu anlegen
        #expect(L.relationFieldsDisabled(isOffline: false, entryId: server) == false)    // online bearbeiten
        #expect(L.relationFieldsDisabled(isOffline: true, entryId: nil) == true)         // offline neu anlegen
        #expect(L.relationFieldsDisabled(isOffline: true, entryId: server) == true)
        #expect(L.relationFieldsDisabled(isOffline: false, entryId: local) == true)      // lokal, online
    }

    @Test func relationFieldsHintDependsOnConnection() {
        #expect(L.relationFieldsHint(isOffline: true) == "Offline nicht verfügbar")
        #expect(L.relationFieldsHint(isOffline: false).contains("noch nicht synchronisiert"))
    }

    @Test func relationsAreOnlyCommittedForServerIds() {
        #expect(L.shouldCommitRelations(savedId: server))
        #expect(!L.shouldCommitRelations(savedId: local))
    }

    // MARK: Zwischenstaende

    @Test func localRefHistoryIsNeverLoadedFromServer() {
        #expect(L.shouldLoadHistory(refId: server))
        #expect(!L.shouldLoadHistory(refId: local))
    }

    @Test func offlineErrorShowsUnavailableViewOtherErrorsDoNot() {
        #expect(L.showsOfflineUnavailable(for: .offline))
        #expect(!L.showsOfflineUnavailable(for: .rateLimited))
        #expect(!L.showsOfflineUnavailable(for: .server("x")))
        #expect(!L.showsOfflineUnavailable(for: .notFound))
    }

    @Test func pendingEntriesSortedNewestFirstAndDeduplicated() {
        let a = summary(entityId: "local-a", at: 100)
        let b = summary(entityId: "local-b", at: 300)
        let c = summary(entityId: "local-c", at: 200)
        let sorted = L.pendingEntriesNewestFirst([a, b, c])
        #expect(sorted.map(\.entityId) == ["local-b", "local-c", "local-a"])
        let dedup = L.pendingEntriesNewestFirst([a, b, c], excludingIds: ["local-c"])
        #expect(dedup.map(\.entityId) == ["local-b", "local-a"])
    }

    @Test func pendingProgressEntryIsBuiltFromPayloadAndEditable() throws {
        let s = summary(entityId: "local-abc", at: 1_700_000_000)
        let payload = PendingPayload.progress(
            PendingProgressPayload(ref: .server(refType: "todo", refId: "r1"), bodyHTML: "<p>Stand heute</p>", source: "manual"))
        let e = try #require(L.pendingProgressEntry(summary: s, payload: payload, refType: "todo", refId: "r1"))
        #expect(e.id == "local-abc")
        #expect(e.refType == "todo" && e.refId == "r1")
        #expect(e.bodyHtml == "<p>Stand heute</p>")
        #expect(e.excerpt == "Stand heute")
        #expect(e.editable)
        #expect(!e.showDormancyMarker)
    }

    @Test func pendingProgressEntryNilWithoutPayloadOrEntityIdOrWrongKind() {
        let ok = PendingPayload.progress(
            PendingProgressPayload(ref: .server(refType: "todo", refId: "r1"), bodyHTML: "<p>x</p>", source: "manual"))
        #expect(L.pendingProgressEntry(summary: summary(), payload: nil, refType: "todo", refId: "r1") == nil)
        #expect(L.pendingProgressEntry(summary: summary(entityId: nil), payload: ok, refType: "todo", refId: "r1") == nil)
        let todo = PendingPayload.todo(PendingTodoPayload(title: "t", descriptionHTML: "", snoozedUntil: nil, dueDate: nil, isPrivate: false))
        #expect(L.pendingProgressEntry(summary: summary(), payload: todo, refType: "todo", refId: "r1") == nil)
    }

    // MARK: Status-Texte / Hinweise

    @Test func statusMessageOnlyForFailedAndBlocked() {
        #expect(L.statusMessage(for: .pending) == nil)
        #expect(L.statusMessage(for: .syncing) == nil)
        #expect(L.statusMessage(for: .failed(message: "Fehler")) == "Fehler")
        #expect(L.statusMessage(for: .blocked(message: "Wartet auf 'X', der fehlgeschlagen ist.")) != nil)
    }

    @Test func uxTexts() {
        #expect(L.pendingNote == "Dieser Eintrag ist noch nicht übertragen.")
        #expect(L.discardTitle == "Eintrag verwerfen?")
        #expect(L.composerOfflineHint.contains("eingereiht"))
    }

    // MARK: Status-Store-Anbindung (Badge-Quelle)

    @Test func rowBadgeSourceFindsLocalEntryOnly() {
        let store = OfflineStatusStore()
        store.items = [summary(kind: .createTodo, entityId: local, status: .failed(message: "x"))]
        #expect(store.summary(forEntityId: local)?.status == .failed(message: "x"))
        #expect(store.summary(forEntityId: server) == nil)
    }

    @Test func pendingProgressIsScopedByRef() {
        let store = OfflineStatusStore()
        store.items = [summary(entityId: "local-1"),
                       PendingItemSummary(id: UUID(), kind: .createProgressEntry, title: "o", contextText: nil,
                                          capturedAt: Date(), status: .pending, entityId: "local-2",
                                          refType: "topic", refId: "r1", fullText: "o")]
        #expect(store.pendingProgress(refType: "todo", refId: "r1").map(\.entityId) == ["local-1"])
    }
}
