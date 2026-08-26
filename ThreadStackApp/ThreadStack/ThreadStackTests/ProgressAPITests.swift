//
//  ProgressAPITests.swift
//  ThreadStackTests
//
//  Arbeitspaket A1 ("App-Datenschicht Progress"): Fehler-Code-Mapping,
//  Erfolgspfade (Decodierung/Pfad-/Query-Aufbau) und `clientToken`-
//  Durchreichung für den Progress-API-Client.
//
//  Netzwerk-Mocking: nutzt bewusst das bereits vorhandene `KnowledgeMockURLProtocol`
//  aus `KnowledgeAPITests.swift` (Arbeitspaket "knowledge-api") wieder, statt
//  eine zweite, ähnliche `URLProtocol`-Stub-Klasse zu bauen (siehe CLAUDE.md:
//  "Wiederverwendung vor Neuentwicklung"). Da `ProgressAPI.swift` aus
//  Zugriffsgründen NICHT `AppState.session` (private) nutzt, sondern die
//  eigene `ProgressAPISession`-Testseam (siehe dortiger Kommentar), wird der
//  Mock hier über `ProgressAPISession.setOverride(_:for:)` eingehängt statt
//  über `AppState.init(session:)`.
//

import Testing
import Foundation
@testable import ThreadStack

@MainActor
private func makeProgressTestState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "progress-mock-\(UUID().uuidString).invalid"
    KnowledgeMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
    let mockSession = URLSession(configuration: cfg)
    // Die AppState-eigene Session wird von ProgressAPI nicht verwendet (siehe
    // Datei-Kopfkommentar in ProgressAPI.swift) — hier trotzdem über die
    // vorhandene Testseam konstruiert, um keine Produktions-Netzwerkkonfiguration
    // (echter `URLSession(configuration: .default)`) in Tests zu berühren.
    let state = AppState(session: URLSession(configuration: .ephemeral))
    state.serverURL = "https://\(host)"
    ProgressAPISession.setOverride(mockSession, for: state)
    return state
}

private func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

/// `URLSession` liefert den Request-Body an ein `URLProtocol` je nach OS-Version/
/// Session-Konfiguration entweder über `httpBody` ODER als `httpBodyStream` —
/// dieser Helper deckt beide Fälle ab, damit Tests den tatsächlich gesendeten
/// Body zuverlässig prüfen können.
private func requestBodyData(_ req: URLRequest) -> Data? {
    if let body = req.httpBody { return body }
    guard let stream = req.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let bufferSize = 4096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: bufferSize)
        if read <= 0 { break }
        data.append(buffer, count: read)
    }
    return data.isEmpty ? nil : data
}

private func sampleDetailJSON(entryId: String = "e1") -> [String: Any] {
    [
        "ref": ["type": "todo", "id": "a1", "title": "T", "done": false, "exists": true],
        "goal": "Ziel", "goalUpdatedAt": NSNull(),
        "nextStep": "Schritt", "nextStepUpdatedAt": NSNull(),
        "stats": ["entryCount": 1, "firstEntryAt": NSNull(), "lastEntryAt": NSNull(), "lastActivityAt": NSNull(),
                   "dormant": false, "dormantDays": NSNull(), "stale": false, "staleDays": NSNull()],
        "reentry": ["show": false, "dormantSince": NSNull(), "dormantLabel": NSNull(),
                     "empty": false, "ai": ["available": false, "frameId": NSNull()]],
        "entries": [
            ["id": entryId, "refType": "todo", "refId": "a1", "kind": "note",
             "source": "manual", "bodyHtml": "<p>x</p>", "excerpt": "x",
             "createdAt": "2026-08-01T00:00:00.000Z", "editedAt": NSNull(),
             "gapDaysBefore": 0, "showDormancyMarker": false, "editable": true]
        ],
        "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]
    ]
}

// MARK: - Fehler-Code-Mapping (reine Funktion)

struct ProgressErrorMappingTests {

    @Test func mapsAllKnownServerCodes() {
        #expect(ProgressError.map(code: "ref_not_found", message: "x") == .notFound)
        #expect(ProgressError.map(code: "entry_not_found", message: "x") == .entryGone)
        #expect(ProgressError.map(code: "ref_done", message: "x") == .refDone)
        #expect(ProgressError.map(code: "entry_not_editable", message: "x") == .notEditable)
        #expect(ProgressError.map(code: "goal_too_long", message: "x") == .tooLong(field: "Zielbild", limit: 500))
        #expect(ProgressError.map(code: "next_step_too_long", message: "x") == .tooLong(field: "Nächster Schritt", limit: 1000))
        #expect(ProgressError.map(code: "body_too_long", message: "x") == .tooLong(field: "Zwischenstand", limit: 5000))
        #expect(ProgressError.map(code: "body_empty", message: "x") == .empty)
        #expect(ProgressError.map(code: "rate_limited", message: "x") == .rateLimited)
    }

    @Test func unknownCodeWithMessageYieldsServerWithServerText() {
        let e = ProgressError.map(code: "some_future_code", message: "Server-Text")
        #expect(e == .server("Server-Text"))
    }

    @Test func missingCodeWithMessageYieldsServerWithServerText() {
        let e = ProgressError.map(code: nil, message: "Serverfehler")
        #expect(e == .server("Serverfehler"))
    }

    @Test func missingCodeAndMessageYieldsGenericFallback() {
        let e = ProgressError.map(code: nil, message: nil)
        #expect(e == .server("Ein unerwarteter Fehler ist aufgetreten."))
    }

    @Test func emptyMessageFallsBackToGenericText() {
        let e = ProgressError.map(code: nil, message: "")
        #expect(e == .server("Ein unerwarteter Fehler ist aufgetreten."))
    }
}

// MARK: - AppState Progress-API: Fehlerpfade über den echten Request-Pfad

@MainActor
struct ProgressAPIErrorPathTests {

    @Test func loadProgressThrowsNotFoundOnRefNotFound() async throws {
        let state = makeProgressTestState { _ in
            (404, jsonData(["error": "Das Vorhaben existiert nicht mehr.", "code": "ref_not_found"]))
        }
        do {
            _ = try await state.loadProgress(refType: "todo", refId: "gone")
            Issue.record("expected ProgressError.notFound")
        } catch let e as ProgressError {
            #expect(e == .notFound)
        }
    }

    @Test func saveProgressGoalThrowsTooLongWithLimitFromGoalTooLong() async throws {
        let state = makeProgressTestState { _ in
            (400, jsonData(["error": "Zielbild zu lang", "code": "goal_too_long"]))
        }
        do {
            _ = try await state.saveProgressGoal(refType: "todo", refId: "a1", goal: String(repeating: "x", count: 600))
            Issue.record("expected ProgressError.tooLong")
        } catch let e as ProgressError {
            #expect(e == .tooLong(field: "Zielbild", limit: 500))
        }
    }

    @Test func addProgressEntryThrowsRefDoneOn409() async throws {
        let state = makeProgressTestState { _ in
            (409, jsonData(["error": "Vorhaben ist erledigt", "code": "ref_done"]))
        }
        do {
            _ = try await state.addProgressEntry(refType: "todo", refId: "a1", bodyHTML: "<p>x</p>",
                                                  source: "manual", clientToken: "tok-1")
            Issue.record("expected ProgressError.refDone")
        } catch let e as ProgressError {
            #expect(e == .refDone)
        }
    }

    @Test func addProgressEntryThrowsRateLimitedOn429() async throws {
        let state = makeProgressTestState { _ in
            (429, jsonData(["error": "Zu viele Änderungen", "code": "rate_limited"]))
        }
        do {
            _ = try await state.addProgressEntry(refType: "todo", refId: "a1", bodyHTML: "<p>x</p>",
                                                  source: "manual", clientToken: "tok-1")
            Issue.record("expected ProgressError.rateLimited")
        } catch let e as ProgressError {
            #expect(e == .rateLimited)
        }
    }

    @Test func deleteProgressEntryThrowsEntryGoneOn404() async throws {
        let state = makeProgressTestState { _ in
            (404, jsonData(["error": "Zwischenstand bereits gelöscht", "code": "entry_not_found"]))
        }
        do {
            try await state.deleteProgressEntry(entryId: "e-gone")
            Issue.record("expected ProgressError.entryGone")
        } catch let e as ProgressError {
            #expect(e == .entryGone)
        }
    }

    @Test func updateProgressEntryThrowsNotEditableOn409() async throws {
        let state = makeProgressTestState { _ in
            (409, jsonData(["error": "Nicht bearbeitbar", "code": "entry_not_editable"]))
        }
        do {
            _ = try await state.updateProgressEntry(entryId: "e1", bodyHTML: "<p>neu</p>")
            Issue.record("expected ProgressError.notEditable")
        } catch let e as ProgressError {
            #expect(e == .notEditable)
        }
    }

    @Test func addProgressEntryThrowsEmptyOnBodyEmpty() async throws {
        let state = makeProgressTestState { _ in
            (400, jsonData(["error": "Bitte gib einen Text ein.", "code": "body_empty"]))
        }
        do {
            _ = try await state.addProgressEntry(refType: "todo", refId: "a1", bodyHTML: "",
                                                  source: "manual", clientToken: "tok-1")
            Issue.record("expected ProgressError.empty")
        } catch let e as ProgressError {
            #expect(e == .empty)
        }
    }

    /// 401 muss weiterhin `APIError.unauthorized` bleiben (nicht in
    /// `ProgressError` verpackt), damit das bestehende Session-Expiry-Handling
    /// der App unverändert funktioniert (siehe `AppState.knowledgeRequest`
    /// mit identischer Konvention).
    @Test func unauthorizedStaysAPIErrorUnauthorized() async throws {
        let state = makeProgressTestState { _ in (401, Data()) }
        do {
            _ = try await state.loadProgress(refType: "todo", refId: "a1")
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
    }

    @Test func serverErrorWithoutCodeYieldsServerWithMessage() async throws {
        let state = makeProgressTestState { _ in
            (500, jsonData(["error": "Interner Fehler"]))
        }
        do {
            _ = try await state.loadProgress(refType: "todo", refId: "a1")
            Issue.record("expected ProgressError.server")
        } catch let e as ProgressError {
            #expect(e == .server("Interner Fehler"))
        }
    }

    /// Reiner Transportfehler (kein HTTP-Response überhaupt) muss als
    /// `.offline` ankommen, nicht als generischer `.server`-Text — Vertrag:
    /// "offline: Netzwerkfehler (kein Server erreicht)".
    @Test func transportFailureMapsToOffline() async throws {
        // Kein Handler für diesen Host registriert -> KnowledgeMockURLProtocol
        // meldet einen URLProtocol-Fehler (siehe dortige Implementierung).
        let host = "progress-mock-unregistered-\(UUID().uuidString).invalid"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
        let mockSession = URLSession(configuration: cfg)
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.serverURL = "https://\(host)"
        ProgressAPISession.setOverride(mockSession, for: state)

        do {
            _ = try await state.loadProgress(refType: "todo", refId: "a1")
            Issue.record("expected ProgressError.offline")
        } catch let e as ProgressError {
            #expect(e == .offline)
        }
    }
}

// MARK: - AppState Progress-API: Erfolgspfade (Decodierung, Pfad-/Query-Aufbau)

@MainActor
struct ProgressAPISuccessTests {

    @Test func loadProgressBuildsExpectedPathAndQueryAndDecodesDetail() async throws {
        let state = makeProgressTestState { req in
            #expect(req.httpMethod == "GET")
            #expect(req.url?.path == "/api/progress/todo/a1")
            #expect(req.url?.query?.contains("limit=20") == true)
            return (200, jsonData(sampleDetailJSON()))
        }
        let detail = try await state.loadProgress(refType: "todo", refId: "a1")
        #expect(detail.ref.id == "a1")
        #expect(detail.entries.count == 1)
    }

    @Test func loadProgressUsesCustomLimit() async throws {
        let state = makeProgressTestState { req in
            #expect(req.url?.query?.contains("limit=5") == true)
            return (200, jsonData(sampleDetailJSON()))
        }
        _ = try await state.loadProgress(refType: "todo", refId: "a1", limit: 5)
    }

    @Test func loadProgressEntriesEncodesCursorContainingPipe() async throws {
        let state = makeProgressTestState { req in
            #expect(req.url?.path == "/api/progress/todo/a1/entries")
            // Der Cursor enthält "|" — muss korrekt percent-codiert übertragen
            // werden (nicht als rohes "|" im Query-String landen).
            #expect(req.url?.absoluteString.contains("|") == false)
            #expect(req.url?.query?.contains("cursor=") == true)
            return (200, jsonData(["entries": [], "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]]))
        }
        let page = try await state.loadProgressEntries(refType: "todo", refId: "a1",
                                                         cursor: "2026-07-01T10:00:00.000Z|k3f", limit: 20)
        #expect(page.entries.isEmpty)
    }

    @Test func refTypeAndRefIdAreURLPathEncoded() async throws {
        // refId enthält ein "/" — darf keine zusätzlichen Pfadsegmente erzeugen.
        // Hinweis: `URL.path` liefert den bereits percent-DEKODIERTEN Pfad
        // (Foundation-Standardverhalten), deshalb wird hier bewusst die rohe,
        // codierte Darstellung über `absoluteString` geprüft — nicht `.path`.
        let state = makeProgressTestState { req in
            #expect(req.url?.path == "/api/progress/todo/a/b")
            #expect(req.url?.absoluteString.contains("a%2Fb") == true)
            return (200, jsonData(sampleDetailJSON()))
        }
        _ = try await state.loadProgress(refType: "todo", refId: "a/b")
    }

    @Test func saveProgressGoalSendsGoalBodyAndDecodesMeta() async throws {
        let state = makeProgressTestState { req in
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/progress/todo/a1/goal")
            return (200, jsonData(["goal": "Neues Ziel", "goalUpdatedAt": "2026-08-01T00:00:00.000Z",
                                    "nextStep": NSNull(), "nextStepUpdatedAt": NSNull()]))
        }
        let meta = try await state.saveProgressGoal(refType: "todo", refId: "a1", goal: "Neues Ziel")
        #expect(meta.goal == "Neues Ziel")
    }

    @Test func saveProgressNextStepUsesNextStepPath() async throws {
        let state = makeProgressTestState { req in
            #expect(req.url?.path == "/api/progress/todo/a1/next-step")
            return (200, jsonData(["goal": NSNull(), "goalUpdatedAt": NSNull(),
                                    "nextStep": "Schritt", "nextStepUpdatedAt": "2026-08-02T00:00:00.000Z"]))
        }
        let meta = try await state.saveProgressNextStep(refType: "todo", refId: "a1", nextStep: "Schritt")
        #expect(meta.nextStep == "Schritt")
    }

    @Test func updateProgressEntryUsesEntriesPath() async throws {
        let state = makeProgressTestState { req in
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/progress/entries/e1")
            return (200, jsonData(["id": "e1", "refType": "todo", "refId": "a1", "kind": "note",
                                    "source": "manual", "bodyHtml": "<p>neu</p>", "excerpt": "neu",
                                    "createdAt": "2026-08-01T00:00:00.000Z", "editedAt": "2026-08-02T00:00:00.000Z",
                                    "gapDaysBefore": 0, "showDormancyMarker": false, "editable": true]))
        }
        let entry = try await state.updateProgressEntry(entryId: "e1", bodyHTML: "<p>neu</p>")
        #expect(entry.bodyHtml == "<p>neu</p>")
        #expect(entry.editedAt == "2026-08-02T00:00:00.000Z")
    }

    @Test func deleteProgressEntrySucceedsWithoutThrowing() async throws {
        let state = makeProgressTestState { req in
            #expect(req.httpMethod == "DELETE")
            #expect(req.url?.path == "/api/progress/entries/e1")
            return (200, jsonData(["ok": true]))
        }
        try await state.deleteProgressEntry(entryId: "e1")
    }
}

// MARK: - clientToken: Idempotenz-relevantes Durchreichen

@MainActor
struct ProgressAPIClientTokenTests {

    /// Prüft NUR, dass der API-Client den vom Aufrufer übergebenen
    /// `clientToken` unverändert im Request-Body überträgt (Idempotenz-Basis)
    /// — nicht, dass der Server idempotent antwortet (das ist Verantwortung
    /// von Paket S1, siehe Vertrag).
    @Test func sameClientTokenIsSentUnchangedOnRepeatedCalls() async throws {
        var receivedTokens: [String] = []
        let entryResponse: [String: Any] = [
            "id": "e1", "refType": "todo", "refId": "a1", "kind": "note",
            "source": "manual", "bodyHtml": "<p>x</p>", "excerpt": "x",
            "createdAt": "2026-08-01T00:00:00.000Z", "editedAt": NSNull(),
            "gapDaysBefore": 0, "showDormancyMarker": false, "editable": true
        ]
        let state = makeProgressTestState { req in
            if let body = requestBodyData(req),
               let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let token = obj["clientToken"] as? String {
                receivedTokens.append(token)
            }
            return (200, jsonData(entryResponse))
        }
        let fixedToken = "stable-token-123"
        _ = try await state.addProgressEntry(refType: "todo", refId: "a1", bodyHTML: "<p>x</p>",
                                              source: "manual", clientToken: fixedToken)
        _ = try await state.addProgressEntry(refType: "todo", refId: "a1", bodyHTML: "<p>x</p>",
                                              source: "manual", clientToken: fixedToken)
        #expect(receivedTokens == [fixedToken, fixedToken])
    }
}
