//
//  SummaryStoreTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A1 ("App-Datenschicht", Redesign Todo/Task-Übersicht):
//  Tests für die Summary-Datenschicht (Schnittstelle 12 im Vertrag) —
//  Modell-Decodierung (inkl. Robustheit gegen unbekannte/fehlende
//  Server-Felder), API-Fehler-Mapping/Erfolgspfade über den echten
//  Request-Pfad, sowie `SummaryStore`-Verhalten (`ingest`, `regenerate`,
//  `poll`/`cancelPolling`).
//
//  Netzwerk-Mocking: wiederverwendet `KnowledgeMockURLProtocol` (siehe
//  `KnowledgeAPITests.swift`/`ProgressAPITests.swift`) — kein neuer
//  Mock-Mechanismus (siehe CLAUDE.md: "Wiederverwendung vor Neuentwicklung").
//
//  Polling-Timing: `SummaryStore` erlaubt über einen zusätzlichen Test-Seam-
//  Initializer die Konfiguration von Intervall/Versuchszahl (siehe
//  `SummaryStore.swift`-Kopfkommentar) — Polling-Tests nutzen dort winzige
//  Werte, damit sie nicht 10×2000ms real abwarten müssen. Ein separater Test
//  bestätigt, dass die PRODUKTIONS-Defaults exakt den vertraglichen Werten
//  (2000ms / 10 Versuche) entsprechen.
//

import Testing
import Foundation
@testable import ThreadStack

@MainActor
private func makeSummaryTestState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "summary-mock-\(UUID().uuidString).invalid"
    KnowledgeMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
    let mockSession = URLSession(configuration: cfg)
    let state = AppState(session: URLSession(configuration: .ephemeral))
    state.serverURL = "https://\(host)"
    SummaryAPISession.setOverride(mockSession, for: state)
    return state
}

private func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

// MARK: - 1. Modell-Decodierung (AISummaryView/AISummaryPair)

struct AISummaryViewDecodingTests {

    @Test func decodesReadySummaryWithAllFields() throws {
        let json = """
        { "status":"ready", "text":"Zusammenfassung", "generatedAt":"2026-08-20T10:00:00.000Z",
          "model":"claude-sonnet-4-6", "errorCode":null }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(AISummaryView.self, from: json)
        #expect(s.status == "ready")
        #expect(s.text == "Zusammenfassung")
        #expect(s.kind == .ready)
    }

    @Test func decodesPendingSummaryWithNullTextAndModel() throws {
        let json = """
        { "status":"pending", "text":null, "generatedAt":null, "model":null, "errorCode":null }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(AISummaryView.self, from: json)
        #expect(s.kind == .pending)
        #expect(s.text == nil)
    }

    @Test func decodesErrorSummaryWithErrorCode() throws {
        let json = """
        { "status":"error", "text":null, "generatedAt":null, "model":null, "errorCode":"budget_exceeded" }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(AISummaryView.self, from: json)
        #expect(s.kind == .error)
        #expect(s.errorCode == "budget_exceeded")
    }

    @Test func decodesAllDocumentedStatusValues() throws {
        let cases: [(String, AISummaryStatus)] = [
            ("ready", .ready), ("stale", .stale), ("pending", .pending),
            ("error", .error), ("disabled", .disabled), ("not_applicable", .notApplicable)
        ]
        for (raw, expected) in cases {
            let json = """
            { "status":"\(raw)", "text":null, "generatedAt":null, "model":null, "errorCode":null }
            """.data(using: .utf8)!
            let s = try JSONDecoder().decode(AISummaryView.self, from: json)
            #expect(s.kind == expected)
        }
    }

    /// Vertrag: "String, NICHT enum — unbekannte Serverwerte dürfen das
    /// Decoding NIE brechen". Ein zukünftiger, unbekannter Status muss
    /// decodierbar bleiben und auf `.unknown` fallen.
    @Test func unknownStatusDoesNotFailDecodingAndMapsToUnknownKind() throws {
        let json = """
        { "status":"future-status", "text":null, "generatedAt":null, "model":null, "errorCode":null }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(AISummaryView.self, from: json)
        #expect(s.status == "future-status")
        #expect(s.kind == .unknown)
    }
}

struct AISummaryPairDecodingTests {

    @Test func decodesPairWithBothFields() throws {
        let json = """
        { "progress": { "status":"ready", "text":"P", "generatedAt":null, "model":null, "errorCode":null },
          "description": { "status":"stale", "text":"D", "generatedAt":null, "model":null, "errorCode":null } }
        """.data(using: .utf8)!
        let p = try JSONDecoder().decode(AISummaryPair.self, from: json)
        #expect(p.progress?.text == "P")
        #expect(p.description?.kind == .stale)
    }

    /// Eine Zusammenfassungsart kann fehlen (z.B. nicht anwendbar für diesen
    /// Ref-Typ) — darf die Dekodierung des gesamten Paares nicht scheitern
    /// lassen.
    @Test func decodesPairWithMissingDescription() throws {
        let json = """
        { "progress": { "status":"ready", "text":"P", "generatedAt":null, "model":null, "errorCode":null } }
        """.data(using: .utf8)!
        let p = try JSONDecoder().decode(AISummaryPair.self, from: json)
        #expect(p.progress != nil)
        #expect(p.description == nil)
    }

    @Test func decodesPairWithBothFieldsMissing() throws {
        let json = "{}".data(using: .utf8)!
        let p = try JSONDecoder().decode(AISummaryPair.self, from: json)
        #expect(p.progress == nil)
        #expect(p.description == nil)
    }
}

// MARK: - 2. TodoItem/Topic: rückwärtskompatible Decodierung von `aiSummary`

struct TodoItemAISummaryDecodingTests {

    @Test func decodesTodoItemWithoutAiSummaryField() throws {
        // Älterer Server (vor diesem Feature) — kein "aiSummary"-Schlüssel.
        let json = """
        { "id":"t1", "title":"Titel", "description":"", "done":false, "isPrivate":false,
          "result":"", "resultDate":"", "createdAt":"2026-08-01T00:00:00.000Z" }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(TodoItem.self, from: json)
        #expect(t.aiSummary == nil)
    }

    @Test func decodesTodoItemWithNullAiSummaryField() throws {
        let json = """
        { "id":"t1", "title":"Titel", "description":"", "done":false, "isPrivate":false,
          "result":"", "resultDate":"", "createdAt":"2026-08-01T00:00:00.000Z", "aiSummary": null }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(TodoItem.self, from: json)
        #expect(t.aiSummary == nil)
    }

    @Test func decodesTodoItemWithFullAiSummary() throws {
        let json = """
        { "id":"t1", "title":"Titel", "description":"", "done":false, "isPrivate":false,
          "result":"", "resultDate":"", "createdAt":"2026-08-01T00:00:00.000Z",
          "aiSummary": { "progress": { "status":"ready", "text":"P", "generatedAt":null, "model":null, "errorCode":null },
                         "description": { "status":"pending", "text":null, "generatedAt":null, "model":null, "errorCode":null } } }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(TodoItem.self, from: json)
        #expect(t.aiSummary?.progress?.kind == .ready)
        #expect(t.aiSummary?.description?.kind == .pending)
    }
}

struct TopicAISummaryDecodingTests {

    @Test func decodesTopicWithoutAiSummaryField() throws {
        let json = """
        { "id":"to1", "title":"Thema", "description":"", "done":false,
          "result":"", "resultDate":"", "isTodo":false, "createdAt":"2026-08-01T00:00:00.000Z" }
        """.data(using: .utf8)!
        let t = try JSONDecoder().decode(Topic.self, from: json)
        #expect(t.aiSummary == nil)
    }
}

// MARK: - 3. AIFeatures: neue optionale Feature-Schalter

struct AIFeaturesSummaryToggleDecodingTests {

    @Test func decodesFeaturesWithoutNewKeys() throws {
        // Älterer Server-Stand — kennt progress_summary/description_summary noch nicht.
        let json = """
        { "brief":true, "capture":true, "result_draft":true, "reentry":true,
          "theme_tagging":false, "digest":false, "cross_meeting":false, "drift":false }
        """.data(using: .utf8)!
        let f = try JSONDecoder().decode(AIFeatures.self, from: json)
        #expect(f.progressSummaryOn == false)
        #expect(f.descriptionSummaryOn == false)
    }

    @Test func decodesFeaturesWithNewKeysEnabled() throws {
        let json = """
        { "brief":true, "capture":true, "result_draft":true, "reentry":true,
          "theme_tagging":false, "digest":false, "cross_meeting":false, "drift":false,
          "progress_summary":true, "description_summary":true }
        """.data(using: .utf8)!
        let f = try JSONDecoder().decode(AIFeatures.self, from: json)
        #expect(f.progressSummaryOn == true)
        #expect(f.descriptionSummaryOn == true)
    }

    @Test func defaultsHaveNewTogglesOff() {
        #expect(AIFeatures.defaults.progressSummaryOn == false)
        #expect(AIFeatures.defaults.descriptionSummaryOn == false)
    }
}

// MARK: - 4. SummaryError-Mapping (reine Funktion)

struct SummaryErrorMappingTests {

    @Test func mapsKnownStatusCodes() {
        #expect(SummaryError.map(status: 404, message: "x") == .notFound)
        #expect(SummaryError.map(status: 402, message: "x") == .budgetExceeded)
        #expect(SummaryError.map(status: 429, message: "x") == .rateLimited)
        #expect(SummaryError.map(status: 400, message: "Ungültig") == .invalidRequest("Ungültig"))
        #expect(SummaryError.map(status: 409, message: "Konflikt") == .conflict("Konflikt"))
        #expect(SummaryError.map(status: 500, message: "Serverfehler") == .server("Serverfehler"))
    }

    @Test func missingMessageFallsBackToGenericGermanText() {
        #expect(SummaryError.map(status: 500, message: nil) == .server("Ein unerwarteter Fehler ist aufgetreten."))
        #expect(SummaryError.map(status: 400, message: "") == .invalidRequest("Ungültige Anfrage."))
        #expect(SummaryError.map(status: 409, message: "") == .conflict("Aktion aktuell nicht möglich."))
    }
}

// MARK: - 5. AppState Summary-API: Erfolgs-/Fehlerpfade über den echten Request-Pfad

@MainActor
struct SummaryAPITests {

    @Test func loadSummariesBuildsExpectedQueryAndDecodesResult() async throws {
        let state = makeSummaryTestState { req in
            #expect(req.httpMethod == "GET")
            #expect(req.url?.path == "/api/summaries")
            #expect(req.url?.query?.contains("refs=") == true)
            return (200, jsonData([
                "summaries": [
                    "todo:a1": [
                        "progress": ["status": "ready", "text": "P", "generatedAt": NSNull(), "model": NSNull(), "errorCode": NSNull()],
                        "description": NSNull()
                    ]
                ]
            ]))
        }
        let result = try await state.loadSummaries(refs: ["todo:a1", "topic:b2"])
        #expect(result["todo:a1"]?.progress?.kind == .ready)
        #expect(result["todo:a1"]?.description == nil)
    }

    @Test func loadSummariesWithEmptyRefsSkipsNetworkCallAndReturnsEmpty() async throws {
        var callCount = 0
        let state = makeSummaryTestState { _ in
            callCount += 1
            return (200, jsonData(["summaries": [String: Any]()]))
        }
        let result = try await state.loadSummaries(refs: [])
        #expect(result.isEmpty)
        #expect(callCount == 0)
    }

    @Test func regenerateSummaryBuildsExpectedPathWithConfirmTrue() async throws {
        let state = makeSummaryTestState { req in
            #expect(req.httpMethod == "POST")
            #expect(req.url?.path == "/api/summaries/progress/todo/a1/regenerate")
            #expect(req.url?.query == "confirm=true")
            return (202, jsonData(["status": "pending"]))
        }
        try await state.regenerateSummary(kind: "progress", refType: "todo", refId: "a1")
    }

    @Test func regenerateSummaryThrowsBudgetExceededOn402() async throws {
        let state = makeSummaryTestState { _ in
            (402, jsonData(["error": "KI-Budget aufgebraucht.", "code": "budget_exceeded"]))
        }
        do {
            try await state.regenerateSummary(kind: "description", refType: "todo", refId: "a1")
            Issue.record("expected SummaryError.budgetExceeded")
        } catch let e as SummaryError {
            #expect(e == .budgetExceeded)
        }
    }

    @Test func regenerateSummaryThrowsNotFoundOn404() async throws {
        let state = makeSummaryTestState { _ in
            (404, jsonData(["error": "Nicht gefunden", "code": "not_found"]))
        }
        do {
            try await state.regenerateSummary(kind: "progress", refType: "todo", refId: "gone")
            Issue.record("expected SummaryError.notFound")
        } catch let e as SummaryError {
            #expect(e == .notFound)
        }
    }

    @Test func regenerateSummaryThrowsRateLimitedOn429() async throws {
        let state = makeSummaryTestState { _ in
            (429, jsonData(["error": "Zu viele Anfragen", "code": "rate_limited"]))
        }
        do {
            try await state.regenerateSummary(kind: "progress", refType: "todo", refId: "a1")
            Issue.record("expected SummaryError.rateLimited")
        } catch let e as SummaryError {
            #expect(e == .rateLimited)
        }
    }

    /// 401 muss weiterhin `APIError.unauthorized` bleiben (nicht in
    /// `SummaryError` verpackt), analog zu `ProgressAPI`/`KnowledgeAPI`.
    @Test func unauthorizedStaysAPIErrorUnauthorized() async throws {
        let state = makeSummaryTestState { _ in (401, Data()) }
        do {
            _ = try await state.loadSummaries(refs: ["todo:a1"])
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
    }

    /// Reiner Transportfehler (kein Server erreicht) muss als `.offline`
    /// ankommen.
    @Test func transportFailureMapsToOffline() async throws {
        let host = "summary-mock-unregistered-\(UUID().uuidString).invalid"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
        let mockSession = URLSession(configuration: cfg)
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.serverURL = "https://\(host)"
        SummaryAPISession.setOverride(mockSession, for: state)

        do {
            _ = try await state.loadSummaries(refs: ["todo:a1"])
            Issue.record("expected SummaryError.offline")
        } catch let e as SummaryError {
            #expect(e == .offline)
        }
    }
}

// MARK: - 6. SummaryStore: ingest

@MainActor
struct SummaryStoreIngestTests {

    @Test func ingestPopulatesSummariesByRefKey() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        let store = SummaryStore(appState: state)
        let pair = AISummaryPair(progress: AISummaryView(status: "ready", text: "P", generatedAt: nil, model: nil, errorCode: nil),
                                  description: nil)
        store.ingest(from: [(refKey: "todo:a1", pair: pair)])
        #expect(store.pair(for: "todo:a1")?.progress?.text == "P")
    }

    @Test func ingestOverwritesPreviousEntryForSameRefKey() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        let store = SummaryStore(appState: state)
        let first = AISummaryPair(progress: AISummaryView(status: "pending", text: nil, generatedAt: nil, model: nil, errorCode: nil), description: nil)
        let second = AISummaryPair(progress: AISummaryView(status: "ready", text: "Fertig", generatedAt: nil, model: nil, errorCode: nil), description: nil)
        store.ingest(from: [(refKey: "todo:a1", pair: first)])
        store.ingest(from: [(refKey: "todo:a1", pair: second)])
        #expect(store.pair(for: "todo:a1")?.progress?.kind == .ready)
        #expect(store.pair(for: "todo:a1")?.progress?.text == "Fertig")
    }
}

// MARK: - 7. SummaryStore: regenerate

@MainActor
struct SummaryStoreRegenerateTests {

    @Test func regenerateSucceedsAndClearsPreviousError() async throws {
        let state = makeSummaryTestState { _ in (202, jsonData(["status": "pending"])) }
        let store = SummaryStore(appState: state)
        try await store.regenerate(kind: "progress", refType: "todo", refId: "a1")
        #expect(store.regenerateErrors["progress:todo:a1"] == nil)
    }

    @Test func regenerateThrowsMappedErrorAndRecordsIt() async throws {
        let state = makeSummaryTestState { _ in
            (409, jsonData(["error": "Zusammenfassung nicht anwendbar", "code": "not_applicable"]))
        }
        let store = SummaryStore(appState: state)
        do {
            try await store.regenerate(kind: "description", refType: "topic", refId: "t1")
            Issue.record("expected SummaryError to be thrown")
        } catch let e as SummaryError {
            #expect(e == .conflict("Zusammenfassung nicht anwendbar"))
            #expect(store.regenerateErrors["description:topic:t1"] == .conflict("Zusammenfassung nicht anwendbar"))
        }
    }
}

// MARK: - 8. SummaryStore: Polling-Vertrag (Intervall/Versuchszahl/Abbruch)

@MainActor
struct SummaryStorePollDefaultsTests {

    /// Vertrag: "exakt 2000ms Intervall / max. 10 Versuche" — die
    /// Produktions-Defaults (ohne Test-Seam-Override) müssen exakt diesen
    /// Werten entsprechen.
    @Test func productionDefaultsMatchContract() {
        #expect(SummaryStore.defaultPollIntervalNanoseconds == 2_000_000_000)
        #expect(SummaryStore.defaultMaxPollAttempts == 10)
    }
}

@MainActor
struct SummaryStorePollBehaviorTests {

    @Test func pollStopsEarlyOnceStatusIsNoLongerPending() async throws {
        var callCount = 0
        let state = makeSummaryTestState { _ in
            callCount += 1
            let status = callCount >= 2 ? "ready" : "pending"
            return (200, jsonData([
                "summaries": ["todo:a1": ["progress": ["status": status, "text": callCount >= 2 ? "Fertig" : NSNull(),
                                                        "generatedAt": NSNull(), "model": NSNull(), "errorCode": NSNull()]]]
            ]))
        }
        // Winzige Werte im Test — nur der Ablaufmechanismus wird geprüft, nicht
        // das reale 2000ms-Timing (siehe Datei-Kopfkommentar).
        let store = SummaryStore(appState: state, pollIntervalNanoseconds: 1_000_000, maxPollAttempts: 5)
        store.ingest(from: [(refKey: "todo:a1",
                              pair: AISummaryPair(progress: AISummaryView(status: "pending", text: nil, generatedAt: nil, model: nil, errorCode: nil), description: nil))])

        await store.poll(refs: ["todo:a1"])

        #expect(store.pair(for: "todo:a1")?.progress?.kind == .ready)
        #expect(callCount == 2)
    }

    @Test func pollGivesUpAfterMaxAttemptsIfStillPending() async throws {
        var callCount = 0
        let state = makeSummaryTestState { _ in
            callCount += 1
            return (200, jsonData([
                "summaries": ["todo:a1": ["progress": ["status": "pending", "text": NSNull(),
                                                        "generatedAt": NSNull(), "model": NSNull(), "errorCode": NSNull()]]]
            ]))
        }
        let store = SummaryStore(appState: state, pollIntervalNanoseconds: 1_000_000, maxPollAttempts: 3)
        await store.poll(refs: ["todo:a1"])
        #expect(callCount == 3)
        #expect(store.pair(for: "todo:a1")?.progress?.kind == .pending)
    }

    /// Vertrag: "pro Karte startbar/abbrechbar" — mehrere Refs pollen
    /// unabhängig, ein Fehler/frühzeitiges Ende einer Ref darf die andere
    /// nicht beeinflussen.
    @Test func pollHandlesMultipleRefsIndependently() async throws {
        var callCounts: [String: Int] = [:]
        let lock = NSLock()
        let state = makeSummaryTestState { req in
            let refKey = req.url?.query?.contains("a1") == true ? "todo:a1" : "todo:b2"
            lock.lock(); callCounts[refKey, default: 0] += 1; let n = callCounts[refKey]!; lock.unlock()
            let status = (refKey == "todo:a1" && n >= 1) ? "ready" : "pending"
            return (200, jsonData([
                "summaries": [refKey: ["progress": ["status": status, "text": NSNull(),
                                                     "generatedAt": NSNull(), "model": NSNull(), "errorCode": NSNull()]]]
            ]))
        }
        let store = SummaryStore(appState: state, pollIntervalNanoseconds: 1_000_000, maxPollAttempts: 3)
        await store.poll(refs: ["todo:a1", "todo:b2"])
        #expect(store.pair(for: "todo:a1")?.progress?.kind == .ready)
        #expect(store.pair(for: "todo:b2")?.progress?.kind == .pending)
    }

    /// `cancelPolling(for:)` stoppt gezielt eine einzelne Ref, ohne die
    /// Poll-Zusicherung als Ganzes (die `await store.poll(refs:)`-Rückkehr)
    /// zu verhindern — nach dem Abbruch wird nicht mehr weiter nachgeladen.
    @Test func cancelPollingStopsFurtherRefreshesForThatRef() async throws {
        var callCount = 0
        let state = makeSummaryTestState { _ in
            callCount += 1
            return (200, jsonData([
                "summaries": ["todo:a1": ["progress": ["status": "pending", "text": NSNull(),
                                                        "generatedAt": NSNull(), "model": NSNull(), "errorCode": NSNull()]]]
            ]))
        }
        let store = SummaryStore(appState: state, pollIntervalNanoseconds: 20_000_000, maxPollAttempts: 10)
        let pollTask = Task { await store.poll(refs: ["todo:a1"]) }
        // Kurz warten, bis mindestens ein Poll-Zyklus lief, dann gezielt abbrechen.
        try await Task.sleep(nanoseconds: 60_000_000)
        store.cancelPolling(for: "todo:a1")
        await pollTask.value
        let countAfterCancel = callCount
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(callCount == countAfterCancel)
    }

    /// Kein Leak von Hintergrund-Polling: bricht der AUFRUFENDE `Task` (z.B.
    /// weil die zugehörige View verschwindet) ab, muss das interne Polling
    /// ebenfalls aufhören, weiter Netzwerk-Requests zu senden.
    @Test func cancellingCallingTaskStopsPolling() async throws {
        var callCount = 0
        let state = makeSummaryTestState { _ in
            callCount += 1
            return (200, jsonData([
                "summaries": ["todo:a1": ["progress": ["status": "pending", "text": NSNull(),
                                                        "generatedAt": NSNull(), "model": NSNull(), "errorCode": NSNull()]]]
            ]))
        }
        let store = SummaryStore(appState: state, pollIntervalNanoseconds: 20_000_000, maxPollAttempts: 10)
        let outerTask = Task { await store.poll(refs: ["todo:a1"]) }
        try await Task.sleep(nanoseconds: 60_000_000)
        outerTask.cancel()
        // Der Cancellation-Handler braucht selbst einen kurzen Moment, um den
        // internen Poll-Task zu stoppen.
        try await Task.sleep(nanoseconds: 40_000_000)
        let countAfterCancel = callCount
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(callCount == countAfterCancel)
    }
}
