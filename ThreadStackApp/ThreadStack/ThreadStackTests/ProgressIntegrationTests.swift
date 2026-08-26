//
//  ProgressIntegrationTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A3 ("App-Integration Progress"): Tests für das, was
//  ausschliesslich in diesem Paket entsteht — NICHT erneut die bereits von
//  A1/A2 abgedeckte Modell-/Store-/View-Logik (siehe `ProgressModelsTests.swift`,
//  `ProgressStoreTests.swift`, `ProgressViewLogicTests.swift`):
//
//  1. Rückwärtskompatible Decodierung von `TodoItem`/`Topic` MIT und OHNE das
//     additive `progress`-Feld (Server liefert es nur in bestimmten Endpoints).
//  2. Vorbelegungs-Logik für das Push-Dialog-Notizfeld aus `progress.nextStep`
//     (`StackPushPrefillLogic`, extrahiert aus `StackPushSheet`).
//  3. Zuordnung Pop-Resolution -> Progress-Source für den optionalen
//     "Wo stehe ich gerade?"-Zwischenstand (`StackPopCheckpointLogic`,
//     extrahiert aus `StackPopSheet`).
//  4. End-to-End-Beleg (unter Wiederverwendung von A1s Store-Test-Harness),
//     dass ein als "dormant" markiertes Listen-Item (`item.progress?.dormant`)
//     nach dem Öffnen des Verlaufs-Sheets (`ProgressHistorySheet`-Wiring:
//     refType/refId an denselben `ProgressStore` durchgereicht) tatsächlich zu
//     `store.shouldShowReentry(...) == true` führt — die Sichtbarkeitsbedingung
//     der Wiedereinstiegskarte wird dabei NICHT neu implementiert, sondern nur
//     durch das A3-Wiring hindurch beobachtet (siehe Abschlussbericht,
//     Abschnitt "Abweichungen": `ProgressReentryCardView` wird bewusst immer
//     gemountet und entscheidet ihre Sichtbarkeit selbst).
//
//  Netzwerk-Mocking: wiederverwendet `KnowledgeMockURLProtocol`
//  (siehe `ProgressStoreTests.swift`/`ProgressAPITests.swift`) — kein neuer
//  Mock-Mechanismus.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - 1. TodoItem/Topic: rückwärtskompatible Decodierung von `progress`

struct TodoItemProgressDecodingTests {

    @Test func decodesTodoItemWithoutProgressField() throws {
        // Altes Server-JSON (vor S2) — kein "progress"-Schlüssel überhaupt.
        let json = """
        { "id":"t1", "title":"Titel", "description":"", "done":false, "isPrivate":false,
          "result":"", "resultDate":"", "createdAt":"2026-08-01T00:00:00.000Z" }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(TodoItem.self, from: json)
        #expect(t.id == "t1")
        #expect(t.progress == nil)
    }

    @Test func decodesTodoItemWithNullProgressField() throws {
        let json = """
        { "id":"t1", "title":"Titel", "description":"", "done":false, "isPrivate":false,
          "result":"", "resultDate":"", "createdAt":"2026-08-01T00:00:00.000Z", "progress": null }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(TodoItem.self, from: json)
        #expect(t.progress == nil)
    }

    @Test func decodesTodoItemWithFullProgressSummary() throws {
        let json = """
        { "id":"t1", "title":"Titel", "description":"", "done":false, "isPrivate":false,
          "result":"", "resultDate":"", "createdAt":"2026-08-01T00:00:00.000Z",
          "progress": { "entryCount":2, "lastEntryAt":"2026-08-20T10:00:00.000Z",
            "stale":false, "staleDays":null, "dormant":true, "dormantSince":"2026-08-01T00:00:00.000Z",
            "orderKey":null, "undocumented":false, "nextStep":"Rückmeldung einholen",
            "badgeLabel":"2 Zwischenstände", "badgeEmphasis":"normal" } }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(TodoItem.self, from: json)
        #expect(t.progress?.entryCount == 2)
        #expect(t.progress?.dormant == true)
        #expect(t.progress?.nextStep == "Rückmeldung einholen")
    }
}

struct TopicProgressDecodingTests {

    @Test func decodesTopicWithoutProgressField() throws {
        let json = """
        { "id":"to1", "title":"Thema", "description":"", "done":false,
          "result":"", "resultDate":"", "isTodo":false, "createdAt":"2026-08-01T00:00:00.000Z" }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(Topic.self, from: json)
        #expect(t.id == "to1")
        #expect(t.progress == nil)
    }

    @Test func decodesTopicWithFullProgressSummary() throws {
        let json = """
        { "id":"to1", "title":"Thema", "description":"", "done":false,
          "result":"", "resultDate":"", "isTodo":false, "createdAt":"2026-08-01T00:00:00.000Z",
          "progress": { "entryCount":1, "lastEntryAt":null, "stale":true, "staleDays":10,
            "dormant":false, "dormantSince":null, "orderKey":null, "undocumented":true,
            "nextStep":null, "badgeLabel":null, "badgeEmphasis":"stale" } }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(Topic.self, from: json)
        #expect(t.progress?.entryCount == 1)
        #expect(t.progress?.badgeEmphasisKind == .stale)
        #expect(t.progress?.nextStep == nil)
    }

    /// Randfall: Meeting mit mehreren Topics, nur eines liefert `progress` —
    /// darf die Decodierung des gesamten Meetings/Arrays nicht zum Scheitern
    /// bringen (heterogene Listenergebnisse sind bei additiven Feldern erlaubt).
    @Test func decodesMeetingWithMixedTopicsWithAndWithoutProgress() throws {
        let json = """
        { "id":"m1", "title":"M", "description":"", "participants":[], "isRecurring":false,
          "recurrencePattern":"", "nextDate":"", "color":"#000000", "createdAt":"2026-08-01T00:00:00.000Z",
          "topics": [
            { "id":"to1", "title":"A", "description":"", "done":false, "result":"", "resultDate":"",
              "isTodo":false, "createdAt":"2026-08-01T00:00:00.000Z",
              "progress": { "entryCount":1, "lastEntryAt":null, "stale":false, "staleDays":null,
                "dormant":false, "dormantSince":null, "orderKey":null, "undocumented":false,
                "nextStep":"X", "badgeLabel":null, "badgeEmphasis":"normal" } },
            { "id":"to2", "title":"B", "description":"", "done":false, "result":"", "resultDate":"",
              "isTodo":false, "createdAt":"2026-08-01T00:00:00.000Z" }
          ] }
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(Meeting.self, from: json)
        #expect(m.topics.count == 2)
        #expect(m.topics[0].progress?.nextStep == "X")
        #expect(m.topics[1].progress == nil)
    }
}

// MARK: - 2. Push-Dialog-Vorbelegung (StackPushPrefillLogic)

struct StackPushPrefillLogicTests {

    @Test func usesListNextStepWhenNoteEmpty() {
        let v = StackPushPrefillLogic.prefillValue(currentNote: "", listNextStep: "Weiter mit X", storeNextStep: nil)
        #expect(v == "Weiter mit X")
    }

    @Test func neverOverwritesExistingUserInput() {
        let v = StackPushPrefillLogic.prefillValue(currentNote: "Schon getippt", listNextStep: "Weiter mit X", storeNextStep: "Y")
        #expect(v == nil)
    }

    @Test func fallsBackToStoreNextStepWhenListNextStepMissing() {
        let v = StackPushPrefillLogic.prefillValue(currentNote: "", listNextStep: nil, storeNextStep: "Aus dem Store")
        #expect(v == "Aus dem Store")
    }

    @Test func whitespaceOnlyListNextStepIsTreatedAsMissing() {
        let v = StackPushPrefillLogic.prefillValue(currentNote: "", listNextStep: "   ", storeNextStep: "Fallback")
        #expect(v == "Fallback")
    }

    @Test func returnsNilWhenNeitherSourceHasAValue() {
        let v = StackPushPrefillLogic.prefillValue(currentNote: "", listNextStep: nil, storeNextStep: nil)
        #expect(v == nil)
    }

    @Test func returnsNilWhenBothSourcesAreWhitespaceOnly() {
        let v = StackPushPrefillLogic.prefillValue(currentNote: "", listNextStep: "  ", storeNextStep: "\n")
        #expect(v == nil)
    }
}

// MARK: - 3. Pop-Resolution -> Progress-Source (StackPopCheckpointLogic)

struct StackPopCheckpointLogicTests {

    @Test func mapsDoneToPopDone() {
        #expect(StackPopCheckpointLogic.progressSource(forResolution: "done") == "pop_done")
    }

    @Test func mapsSnoozedToPopSnoozed() {
        #expect(StackPopCheckpointLogic.progressSource(forResolution: "snoozed") == "pop_snoozed")
    }

    @Test func mapsDroppedToPopDropped() {
        #expect(StackPopCheckpointLogic.progressSource(forResolution: "dropped") == "pop_dropped")
    }

    /// "resumed" hat serverseitig keinen eigenen Progress-Source-Wert (siehe
    /// `SOURCES` in `lib/progress/routes.js`) — das Zwischenstand-Feld wird für
    /// diese Resolution in `StackPopSheet` konsequent nicht angeboten, statt
    /// eingegebenen Text stillschweigend zu verwerfen.
    @Test func resumedHasNoProgressSource() {
        #expect(StackPopCheckpointLogic.progressSource(forResolution: "resumed") == nil)
    }

    @Test func unknownResolutionHasNoProgressSource() {
        #expect(StackPopCheckpointLogic.progressSource(forResolution: "some_future_value") == nil)
    }
}

// MARK: - 4. End-to-End: Listen-Item (`progress?.dormant`) -> Reentry-Sichtbarkeit

/// Wiederverwendet exakt das Mock-Muster aus `ProgressStoreTests.swift`
/// (`KnowledgeMockURLProtocol` + `ProgressAPISession.setOverride`) — kein
/// neuer Netzwerk-Mock-Mechanismus für dieses Paket.
@MainActor
private func makeIntegrationTestState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "progress-integration-mock-\(UUID().uuidString).invalid"
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

@MainActor
struct ProgressHistorySheetWiringTests {

    /// Simuliert exakt den Ablauf, den A3 in `TodoFormView`/`TopicFormView`
    /// verdrahtet: ein Listen-Item mit `progress.dormant == true` wird
    /// geöffnet, `ProgressHistorySheet` reicht refType/refId an denselben
    /// `ProgressStore` durch, `ProgressTimelineView` (über deren `.task`)
    /// löst `store.load(...)` aus — anschliessend muss die vom Server
    /// gelieferte `reentry.show`-Bedingung (hier bewusst `true`, passend zu
    /// einem ruhenden Vorhaben) in `store.shouldShowReentry` ankommen, exakt
    /// wie es `ProgressReentryCardView` selbst abfragt.
    @Test func dormantListItemLeadsToVisibleReentryCardAfterStoreLoad() async throws {
        let todoJSON: [String: Any] = [
            "id": "a1", "title": "Slides finalisieren", "description": "", "done": false, "isPrivate": false,
            "result": "", "resultDate": "", "createdAt": "2026-08-01T00:00:00.000Z",
            "progress": [
                "entryCount": 3, "lastEntryAt": "2026-07-30T10:00:00.000Z",
                "stale": true, "staleDays": 24, "dormant": true,
                "dormantSince": "2026-07-30T10:00:00.000Z", "orderKey": NSNull(),
                "undocumented": false, "nextStep": "Feedback einholen",
                "badgeLabel": "3 Zwischenstände · vor 24 Tagen", "badgeEmphasis": "stale"
            ]
        ]
        let todo = try JSONDecoder().decode(TodoItem.self, from: jsonData(todoJSON))
        #expect(todo.progress?.dormant == true)

        let detailJSON: [String: Any] = [
            "ref": ["type": "todo", "id": todo.id, "title": todo.title, "done": false, "exists": true],
            "goal": "Präsentation fertigstellen", "goalUpdatedAt": NSNull(),
            "nextStep": "Feedback einholen", "nextStepUpdatedAt": NSNull(),
            "stats": ["entryCount": 3, "firstEntryAt": NSNull(), "lastEntryAt": "2026-07-30T10:00:00.000Z",
                       "lastActivityAt": "2026-07-30T10:00:00.000Z",
                       "dormant": true, "dormantDays": 24, "stale": true, "staleDays": 24],
            "reentry": ["show": true, "dormantSince": "2026-07-30T10:00:00.000Z", "dormantLabel": "3 Wochen",
                         "empty": false, "ai": ["available": false, "frameId": NSNull()]],
            "entries": [],
            "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]
        ]
        let state = makeIntegrationTestState { _ in (200, jsonData(detailJSON)) }
        let defaults = UserDefaults(suiteName: "progress-integration-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)

        // Wie in ProgressHistorySheet: dieselben refType/refId, die A3 aus dem
        // Listen-Item ("todo", todo.id) an den Store weiterreicht.
        await store.load(refType: "todo", refId: todo.id)

        #expect(store.shouldShowReentry(refType: "todo", refId: todo.id) == true)
    }

    /// Gegenprobe: server-seitig `reentry.show == false` (z. B. Vorhaben war
    /// gar nicht lange genug inaktiv) — Karte bleibt trotz optimistischem
    /// Listen-Badge unsichtbar, die Store-Entscheidung bleibt autoritativ.
    @Test func reentryStaysHiddenWhenServerSaysShowFalseEvenIfListLookedStale() async throws {
        let detailJSON: [String: Any] = [
            "ref": ["type": "topic", "id": "to1", "title": "Thema", "done": false, "exists": true],
            "goal": "", "goalUpdatedAt": NSNull(), "nextStep": "", "nextStepUpdatedAt": NSNull(),
            "stats": ["entryCount": 1, "firstEntryAt": NSNull(), "lastEntryAt": NSNull(), "lastActivityAt": NSNull(),
                       "dormant": false, "dormantDays": NSNull(), "stale": false, "staleDays": NSNull()],
            "reentry": ["show": false, "dormantSince": NSNull(), "dormantLabel": NSNull(),
                         "empty": false, "ai": ["available": false, "frameId": NSNull()]],
            "entries": [],
            "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]
        ]
        let state = makeIntegrationTestState { _ in (200, jsonData(detailJSON)) }
        let defaults = UserDefaults(suiteName: "progress-integration-test-\(UUID().uuidString)")!
        let store = ProgressStore(appState: state, defaults: defaults)

        await store.load(refType: "topic", refId: "to1")

        #expect(store.shouldShowReentry(refType: "topic", refId: "to1") == false)
    }
}
