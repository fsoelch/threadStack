//
//  ProgressStoreTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A1 ("App-Datenschicht Progress"): Tests für `ProgressStore`,
//  insbesondere das im Vertrag explizit vorgegebene Dismiss-Verhalten der
//  Wiedereinstiegskarte (Key-Schema, "bleibt unterdrückt solange gespeicherter
//  Wert == aktuellem dormantSince, erscheint bei neuer Ruhephase automatisch
//  wieder"). Nicht Teil der im Auftrag explizit benannten Testdateien
//  (`ProgressAPITests.swift`, `ProgressModelsTests.swift`), aber sinnvolle
//  Ergänzung, da `ProgressStore` selbst konkretes, vertraglich beschriebenes
//  Verhalten enthält (Dismiss-Key-Schema) — siehe Abschlussbericht.
//
//  Netzwerk-Mocking: wiederverwendet `KnowledgeMockURLProtocol` (siehe
//  `KnowledgeAPITests.swift`) wie schon `ProgressAPITests.swift`.
//

import Testing
import Foundation
@testable import ThreadStack

@MainActor
private func makeProgressStoreTestState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "progress-store-mock-\(UUID().uuidString).invalid"
    KnowledgeMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
    let mockSession = URLSession(configuration: cfg)
    let state = AppState(session: URLSession(configuration: .ephemeral))
    state.serverURL = "https://\(host)"
    ProgressAPISession.setOverride(mockSession, for: state)
    return state
}

private func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

private func detailJSON(dormantSince: Any, show: Bool) -> [String: Any] {
    [
        "ref": ["type": "todo", "id": "a1", "title": "T", "done": false, "exists": true],
        "goal": "Ziel", "goalUpdatedAt": NSNull(),
        "nextStep": "Schritt", "nextStepUpdatedAt": NSNull(),
        "stats": ["entryCount": 1, "firstEntryAt": NSNull(), "lastEntryAt": NSNull(), "lastActivityAt": NSNull(),
                   "dormant": true, "dormantDays": 21, "stale": true, "staleDays": 21],
        "reentry": ["show": show, "dormantSince": dormantSince, "dormantLabel": "3 Wochen",
                     "empty": false, "ai": ["available": false, "frameId": NSNull()]],
        "entries": [],
        "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]
    ]
}

@MainActor
struct ProgressStoreLoadTests {

    @Test func loadPopulatesLoadedStateWithDetail() async throws {
        let state = makeProgressStoreTestState { _ in
            (200, jsonData(detailJSON(dormantSince: "2026-08-01T00:00:00.000Z", show: true)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        #expect(store.state(refType: "todo", refId: "a1").detail?.ref.id == "a1")
        #expect(store.state(refType: "todo", refId: "a1").isLoading == false)
    }

    @Test func loadOnErrorSetsFailedStateWithMappedProgressError() async throws {
        let state = makeProgressStoreTestState { _ in
            (404, jsonData(["error": "Das Vorhaben existiert nicht mehr.", "code": "ref_not_found"]))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "gone")
        #expect(store.state(refType: "todo", refId: "gone").error == .notFound)
    }

    @Test func retryReloadsAndCanRecoverFromFailedState() async throws {
        var callCount = 0
        let state = makeProgressStoreTestState { _ in
            callCount += 1
            if callCount == 1 {
                return (500, jsonData(["error": "Serverfehler"]))
            }
            return (200, jsonData(detailJSON(dormantSince: NSNull(), show: false)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        #expect(store.state(refType: "todo", refId: "a1").error != nil)
        await store.retry(refType: "todo", refId: "a1")
        #expect(store.state(refType: "todo", refId: "a1").detail != nil)
    }
}

@MainActor
struct ProgressStoreReentryDismissTests {

    @Test func showsReentryCardWhenServerSaysShowAndNotDismissed() async throws {
        let state = makeProgressStoreTestState { _ in
            (200, jsonData(detailJSON(dormantSince: "2026-08-01T00:00:00.000Z", show: true)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        #expect(store.shouldShowReentry(refType: "todo", refId: "a1") == true)
    }

    /// Vertrag: Key-Schema "ts.progress.dismiss.<refType>:<refId>", Wert = das
    /// zum Dismiss-Zeitpunkt aktuelle `reentry.dormantSince`.
    @Test func dismissPersistsUnderDocumentedKeySchemaWithDormantSinceValue() async throws {
        let state = makeProgressStoreTestState { _ in
            (200, jsonData(detailJSON(dormantSince: "2026-08-01T00:00:00.000Z", show: true)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        store.dismissReentry(refType: "todo", refId: "a1")
        #expect(defaults.string(forKey: "ts.progress.dismiss.todo:a1") == "2026-08-01T00:00:00.000Z")
    }

    @Test func dismissedCardStaysHiddenOnReloadWithSameDormancyPhase() async throws {
        let state = makeProgressStoreTestState { _ in
            (200, jsonData(detailJSON(dormantSince: "2026-08-01T00:00:00.000Z", show: true)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        store.dismissReentry(refType: "todo", refId: "a1")
        #expect(store.shouldShowReentry(refType: "todo", refId: "a1") == false)

        // Erneutes Laden derselben Ruhephase (unveränderter dormantSince) —
        // Karte bleibt unterdrückt.
        await store.load(refType: "todo", refId: "a1")
        #expect(store.shouldShowReentry(refType: "todo", refId: "a1") == false)
    }

    /// Vertrag: "erscheint bei neuer Ruhephase automatisch wieder".
    @Test func cardReappearsWhenDormantSinceChangesToNewPhase() async throws {
        var dormantSince = "2026-08-01T00:00:00.000Z"
        let state = makeProgressStoreTestState { _ in
            (200, jsonData(detailJSON(dormantSince: dormantSince, show: true)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        store.dismissReentry(refType: "todo", refId: "a1")
        #expect(store.shouldShowReentry(refType: "todo", refId: "a1") == false)

        // Neue Ruhephase: anderes dormantSince nach erneuter Aktivität + erneuter Inaktivität.
        dormantSince = "2026-09-01T00:00:00.000Z"
        await store.load(refType: "todo", refId: "a1")
        #expect(store.shouldShowReentry(refType: "todo", refId: "a1") == true)
    }

    @Test func doesNotShowReentryWhenServerSaysShowFalse() async throws {
        let state = makeProgressStoreTestState { _ in
            (200, jsonData(detailJSON(dormantSince: NSNull(), show: false)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        await store.load(refType: "todo", refId: "a1")
        #expect(store.shouldShowReentry(refType: "todo", refId: "a1") == false)
    }
}

@MainActor
struct ProgressStoreClientTokenTests {

    @Test func clientTokenForPendingEntryIsStableUntilDiscarded() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        let store = ProgressStore(appState: state, defaults: UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!)
        let t1 = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        let t2 = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        #expect(t1 == t2)
        store.discardPendingEntryToken(refType: "todo", refId: "a1")
        let t3 = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        #expect(t3 != t1)
    }

    @Test func clientTokenIsClearedAfterSuccessfulAddEntry() async throws {
        let entryResponse: [String: Any] = [
            "id": "e1", "refType": "todo", "refId": "a1", "kind": "note",
            "source": "manual", "bodyHtml": "<p>x</p>", "excerpt": "x",
            "createdAt": "2026-08-01T00:00:00.000Z", "editedAt": NSNull(),
            "gapDaysBefore": 0, "showDormancyMarker": false, "editable": true
        ]
        var callCount = 0
        let state = makeProgressStoreTestState { _ in
            callCount += 1
            if callCount == 1 { return (200, jsonData(entryResponse)) }
            return (200, jsonData(detailJSON(dormantSince: NSNull(), show: false)))
        }
        let defaults = UserDefaults(suiteName: "progress-store-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)
        let before = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        _ = try await store.addEntry(refType: "todo", refId: "a1", bodyHTML: "<p>x</p>", source: "manual")
        let after = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        #expect(before != after)
    }
}
