//
//  ArchiveTests.swift
//  ThreadStackTests
//
//  Unit tests für Paket A1 ("Meetings archivieren statt löschen" — Native App):
//  Modell-Dekodierung der neuen Archiv-Typen, AppState-Methoden gegen den
//  dokumentierten Server-Vertrag (via URLProtocol-Stub, gleiches Muster wie
//  KnowledgeAPITests.swift), sowie reine Formatierungs-/Text-Hilfsfunktionen
//  aus SidebarView.swift und MeetingArchiveView.swift.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Test double: intercepts URLSession(.default)-based requests so we
// can exercise AppState's real request path without hitting the network.
// Eigene Klasse (statt Wiederverwendung von KnowledgeMockURLProtocol aus
// KnowledgeAPITests.swift), da Swift Testing Test-Dateien unabhängig
// kompiliert werden und pro Datei ein eigener, klar benannter Stub klarer ist
// als eine geteilte, aber datei-übergreifend private Hilfsklasse.

final class ArchiveMockURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (URLRequest) -> (Int, Data)] = [:]

    static func register(host: String, handler: @escaping (URLRequest) -> (Int, Data)) {
        lock.lock(); handlers[host] = handler; lock.unlock()
    }

    private static func handler(forHost host: String?) -> ((URLRequest) -> (Int, Data))? {
        guard let host else { return nil }
        lock.lock(); defer { lock.unlock() }
        return handlers[host]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler(forHost: request.url?.host) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                        httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
private func makeAppState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "archive-mock-\(UUID().uuidString).invalid"
    ArchiveMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [ArchiveMockURLProtocol.self]
    let session = URLSession(configuration: cfg)
    let s = AppState(session: session)
    s.serverURL = "https://\(host)"
    return s
}

private func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

private func sampleMeeting(id: String = "m1", archived: Bool? = nil, archivedAt: String? = nil) -> Meeting {
    Meeting(id: id, title: "Sprint Planning", description: "", participants: [],
            isRecurring: false, recurrencePattern: "", nextDate: "", color: "#6366f1",
            sortOrder: nil, createdAt: "2026-01-01T00:00:00Z", topics: [],
            archived: archived, archivedAt: archivedAt)
}

// MARK: - Modell-Dekodierung: Meeting.archived/archivedAt (additiv, optional)

struct MeetingArchiveFieldsDecodingTests {

    @Test func decodesWithoutArchivedFieldsForBackwardCompatibility() throws {
        // Älterer Server-Stand / GET /meetings-Antwort ohne die neuen Felder
        // darf nicht fehlschlagen — beide Felder sind laut Vertrag optional.
        let json = """
        { "id": "m1", "title": "T", "description": "", "participants": [],
          "isRecurring": false, "recurrencePattern": "", "nextDate": "", "color": "#000",
          "createdAt": "2026-01-01T00:00:00Z", "topics": [] }
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(Meeting.self, from: json)
        #expect(m.archived == nil)
        #expect(m.archivedAt == nil)
        #expect(m.isArchived == false)
    }

    @Test func decodesArchivedTrueWithTimestamp() throws {
        let json = """
        { "id": "m1", "title": "T", "description": "", "participants": [],
          "isRecurring": false, "recurrencePattern": "", "nextDate": "", "color": "#000",
          "createdAt": "2026-01-01T00:00:00Z", "topics": [],
          "archived": true, "archivedAt": "2026-03-01T10:00:00Z" }
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(Meeting.self, from: json)
        #expect(m.archived == true)
        #expect(m.archivedAt == "2026-03-01T10:00:00Z")
        #expect(m.isArchived == true)
    }
}

// MARK: - Modell-Dekodierung: neue Archiv-Typen

struct ArchiveModelsDecodingTests {

    @Test func decodesArchivedMeetingListItem() throws {
        let json = """
        { "id": "m1", "title": "Sprint Planning", "description": "d", "color": "#6366f1",
          "participants": ["Anna", "Ben"], "nextDate": "2026-01-01T10:00:00Z",
          "createdAt": "2026-01-01T00:00:00Z", "archivedAt": "2026-02-01T00:00:00Z",
          "topicCount": 5, "openTopicCount": 2 }
        """.data(using: .utf8)!
        let item = try JSONDecoder().decode(ArchivedMeetingListItem.self, from: json)
        #expect(item.id == "m1")
        #expect(item.topicCount == 5)
        #expect(item.openTopicCount == 2)
        #expect(item.participants == ["Anna", "Ben"])
    }

    @Test func decodesArchiveListResponseWrapper() throws {
        let json = """
        { "items": [], "total": 12, "limit": 20, "offset": 0 }
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(ArchiveListResponse.self, from: json)
        #expect(r.total == 12)
        #expect(r.limit == 20)
        #expect(r.items.isEmpty)
    }

    @Test func decodesArchiveImpactAllCounts() throws {
        let json = """
        { "topics": 3, "progressEntries": 7, "attachments": 2, "attachmentBytes": 4096,
          "themeLinks": 1, "stackFrames": 0, "aiArtifacts": 4 }
        """.data(using: .utf8)!
        let impact = try JSONDecoder().decode(ArchiveImpact.self, from: json)
        #expect(impact.topics == 3)
        #expect(impact.progressEntries == 7)
        #expect(impact.attachments == 2)
        #expect(impact.attachmentBytes == 4096)
        #expect(impact.themeLinks == 1)
        #expect(impact.stackFrames == 0)
        #expect(impact.aiArtifacts == 4)
    }

    @Test func decodesArchivePreflightWithOpenFramesConflict() throws {
        let json = """
        { "archived": false, "archivedAt": null,
          "impact": { "topics": 1, "progressEntries": 0, "attachments": 0, "attachmentBytes": 0,
                      "themeLinks": 0, "stackFrames": 1, "aiArtifacts": 0 },
          "conflicts": { "openFrames": [
            { "frameId": "f1", "topicId": "t1", "topicTitle": "Migration planen",
              "nextStepNote": "Mit Team abstimmen", "pushedAt": "2026-01-05T00:00:00Z" }
          ] } }
        """.data(using: .utf8)!
        let preflight = try JSONDecoder().decode(ArchivePreflight.self, from: json)
        #expect(preflight.archived == false)
        #expect(preflight.archivedAt == nil)
        #expect(preflight.conflicts.openFrames.count == 1)
        #expect(preflight.conflicts.openFrames[0].topicTitle == "Migration planen")
    }
}

// MARK: - AppState.archiveMeeting

@MainActor
struct ArchiveMeetingTests {

    @Test func archivesSuccessfullyAndRemovesFromMeetings() async throws {
        let state = makeAppState { req in
            #expect(req.httpMethod == "POST")
            #expect(req.url?.path.hasSuffix("/api/archive/meeting/m1") == true)
            return (200, jsonData(["ok": true, "refType": "meeting", "refId": "m1",
                                    "archived": true, "archivedAt": "2026-03-01T00:00:00Z",
                                    "alreadyArchived": false]))
        }
        state.meetings = [sampleMeeting(id: "m1")]
        try await state.archiveMeeting("m1")
        #expect(state.meetings.isEmpty)
    }

    @Test func sendsAcknowledgeStackConflictWhenTrue() async throws {
        let state = makeAppState { req in
            let body = req.httpBodyStreamOrData()
            let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            #expect(obj?["acknowledgeStackConflict"] as? Bool == true)
            return (200, jsonData(["ok": true, "archived": true]))
        }
        state.meetings = [sampleMeeting(id: "m1")]
        try await state.archiveMeeting("m1", acknowledgeStackConflict: true)
    }

    @Test func throwsArchiveConflictErrorOn409WithOpenFrames() async throws {
        let state = makeAppState { _ in
            (409, jsonData([
                "error": "Offene Stack-Frames", "code": "ARCHIVE_STACK_CONFLICT",
                "conflicts": ["openFrames": [
                    ["frameId": "f1", "topicId": "t1", "topicTitle": "Migration planen",
                     "nextStepNote": "Note", "pushedAt": "2026-01-05T00:00:00Z"]
                ]]
            ]))
        }
        state.meetings = [sampleMeeting(id: "m1")]
        do {
            try await state.archiveMeeting("m1")
            Issue.record("expected ArchiveConflictError")
        } catch let e as ArchiveConflictError {
            #expect(e.openFrames.count == 1)
            #expect(e.openFrames[0].topicTitle == "Migration planen")
        }
        // Bei Konflikt darf das Meeting nicht optimistisch entfernt werden.
        #expect(state.meetings.count == 1)
    }

    @Test func throws404AsPlainAPIServerError() async throws {
        let state = makeAppState { _ in
            (404, jsonData(["error": "Nicht gefunden", "code": "NOT_FOUND"]))
        }
        do {
            try await state.archiveMeeting("unknown")
            Issue.record("expected APIError.server")
        } catch let e as APIError {
            if case .server(let msg) = e { #expect(msg == "Nicht gefunden") }
            else { Issue.record("wrong APIError case") }
        }
    }

    @Test func unauthorizedStaysAPIErrorUnauthorized() async throws {
        let state = makeAppState { _ in (401, Data()) }
        do {
            try await state.archiveMeeting("m1")
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
    }
}

// MARK: - AppState.restoreMeeting / archivePreflight / permanentlyDeleteMeeting

@MainActor
struct ArchiveRestoreAndDeleteTests {

    @Test func restoreRemovesFromArchivedMeetingsList() async throws {
        let state = makeAppState { req in
            if req.httpMethod == "DELETE" && req.url?.path.hasSuffix("/api/archive/meeting/m1") == true {
                return (200, jsonData(["ok": true, "archived": false, "alreadyActive": false]))
            }
            // refreshAll()-Folgeaufrufe (GET /meetings, /todos, /themes, /contacts,
            // /knowledge, /stack) — leere, aber gültige Antworten reichen hier aus.
            if req.url?.path.hasSuffix("/api/stack") == true {
                return (200, jsonData(["frames": [], "depth": 0]))
            }
            return (200, jsonData([]))
        }
        state.archivedMeetings = [ArchivedMeetingListItem(
            id: "m1", title: "T", description: "", color: "#000", participants: [],
            nextDate: "", createdAt: "", archivedAt: "2026-01-01T00:00:00Z",
            topicCount: 0, openTopicCount: 0)]
        try await state.restoreMeeting("m1")
        #expect(state.archivedMeetings.isEmpty)
    }

    @Test func preflightDecodesImpactAndConflicts() async throws {
        let state = makeAppState { req in
            #expect(req.httpMethod == "GET")
            #expect(req.url?.path.hasSuffix("/preflight") == true)
            return (200, jsonData([
                "archived": true, "archivedAt": "2026-01-01T00:00:00Z",
                "impact": ["topics": 2, "progressEntries": 1, "attachments": 0, "attachmentBytes": 0,
                           "themeLinks": 0, "stackFrames": 0, "aiArtifacts": 0],
                "conflicts": ["openFrames": []]
            ]))
        }
        let preflight = try await state.archivePreflight("m1")
        #expect(preflight.impact.topics == 2)
        #expect(preflight.conflicts.openFrames.isEmpty)
    }

    @Test func permanentDeleteRemovesFromArchivedMeetingsList() async throws {
        let state = makeAppState { req in
            #expect(req.httpMethod == "DELETE")
            #expect(req.url?.path.hasSuffix("/permanent") == true)
            return (200, jsonData(["ok": true, "deleted": [
                "topics": 2, "progressEntries": 1, "attachments": 0,
                "themeLinks": 0, "stackFrames": 0, "aiArtifacts": 0
            ]]))
        }
        state.archivedMeetings = [ArchivedMeetingListItem(
            id: "m1", title: "T", description: "", color: "#000", participants: [],
            nextDate: "", createdAt: "", archivedAt: "2026-01-01T00:00:00Z",
            topicCount: 0, openTopicCount: 0)]
        try await state.permanentlyDeleteMeeting("m1")
        #expect(state.archivedMeetings.isEmpty)
    }

    @Test func permanentDeleteThrowsOnNotArchived409() async throws {
        let state = makeAppState { _ in
            (409, jsonData(["error": "Nicht archiviert", "code": "NOT_ARCHIVED"]))
        }
        do {
            try await state.permanentlyDeleteMeeting("m1")
            Issue.record("expected APIError.server")
        } catch let e as APIError {
            if case .server = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
    }
}

// MARK: - AppState.loadArchivedMeetings / loadArchivedMeetingDetail

@MainActor
struct ArchiveListAndDetailTests {

    @Test func loadArchivedMeetingsEncodesQueryAndOffset() async throws {
        let state = makeAppState { req in
            let query = req.url?.query ?? ""
            #expect(query.contains("q=hallo"))
            #expect(query.contains("offset=10"))
            return (200, jsonData(["items": [], "total": 0, "limit": 20, "offset": 10]))
        }
        try await state.loadArchivedMeetings(q: "hallo", offset: 10)
        #expect(state.archiveTotal == 0)
        #expect(state.archivedMeetings.isEmpty)
    }

    @Test func loadArchivedMeetingsPopulatesStateFromItems() async throws {
        let state = makeAppState { _ in
            (200, jsonData(["items": [
                ["id": "m1", "title": "T", "description": "", "color": "#000", "participants": [],
                 "nextDate": "", "createdAt": "", "archivedAt": "2026-01-01T00:00:00Z",
                 "topicCount": 3, "openTopicCount": 1]
            ], "total": 1, "limit": 20, "offset": 0]))
        }
        try await state.loadArchivedMeetings()
        #expect(state.archivedMeetings.count == 1)
        #expect(state.archiveTotal == 1)
    }

    @Test func loadArchivedMeetingDetailDecodesMeetingIgnoringUnknownReadOnlyKey() async throws {
        let state = makeAppState { req in
            #expect(req.url?.path.hasSuffix("/api/archive/meetings/m1") == true)
            return (200, jsonData([
                "id": "m1", "title": "Archiviertes Meeting", "description": "", "participants": [],
                "isRecurring": false, "recurrencePattern": "", "nextDate": "", "color": "#000",
                "createdAt": "2026-01-01T00:00:00Z", "topics": [],
                "archived": true, "archivedAt": "2026-02-01T00:00:00Z", "readOnly": true
            ]))
        }
        let m = try await state.loadArchivedMeetingDetail("m1")
        #expect(m.title == "Archiviertes Meeting")
        #expect(m.isArchived == true)
        #expect(m.archivedAt == "2026-02-01T00:00:00Z")
    }
}

// MARK: - Reine Text-/Formatierungs-Hilfsfunktionen (SidebarView.swift)

struct ArchiveConflictTopicsTextTests {

    @Test func joinsMultipleTopicTitlesWithComma() {
        let frames = [
            ArchiveStackConflict(frameId: "f1", topicId: "t1", topicTitle: "A", nextStepNote: "", pushedAt: ""),
            ArchiveStackConflict(frameId: "f2", topicId: "t2", topicTitle: "B", nextStepNote: "", pushedAt: "")
        ]
        #expect(ThreadStack.archiveConflictTopicsText(frames) == "A, B")
    }

    @Test func emptyListProducesEmptyString() {
        #expect(ThreadStack.archiveConflictTopicsText([]) == "")
    }

    @Test func singleFrameProducesJustItsTitle() {
        let frames = [ArchiveStackConflict(frameId: "f1", topicId: "t1", topicTitle: "Solo", nextStepNote: "", pushedAt: "")]
        #expect(ThreadStack.archiveConflictTopicsText(frames) == "Solo")
    }
}

// MARK: - Reine Text-/Formatierungs-Hilfsfunktionen (MeetingArchiveView.swift)

struct ArchiveTopicsSummaryTextTests {

    @Test func computesDoneCountFromTopicAndOpenCounts() {
        #expect(archiveTopicsSummaryText(topicCount: 5, openTopicCount: 2) == "5 Themen · 3 erledigt")
    }

    @Test func allOpenYieldsZeroDone() {
        #expect(archiveTopicsSummaryText(topicCount: 3, openTopicCount: 3) == "3 Themen · 0 erledigt")
    }

    @Test func zeroTopicsYieldsZeroZero() {
        #expect(archiveTopicsSummaryText(topicCount: 0, openTopicCount: 0) == "0 Themen · 0 erledigt")
    }

    @Test func defensivelyClampsNegativeDoneCount() {
        // Sollte serverseitig nie vorkommen (openTopicCount > topicCount), aber die
        // reine Formatierung darf niemals eine negative Zahl anzeigen.
        #expect(archiveTopicsSummaryText(topicCount: 2, openTopicCount: 5) == "2 Themen · 0 erledigt")
    }
}

struct ArchiveArchivedAtChipTextTests {

    @Test func containsFormattedDate() {
        let text = archiveArchivedAtChipText("2026-03-15T10:00:00Z")
        #expect(text.hasPrefix("Archiviert am "))
        #expect(text.contains("2026") || text.contains("26")) // lokalisiertes Format, Jahr in irgendeiner Form enthalten
    }
}

struct ArchiveDeleteImpactTextTests {

    @Test func containsTitleAndAllThreeCounts() {
        let impact = ArchiveImpact(topics: 4, progressEntries: 6, attachments: 2,
                                    themeLinks: 0, stackFrames: 0, aiArtifacts: 0,
                                    attachmentBytes: 0)
        let text = archiveDeleteImpactText(title: "Sprint Planning", impact: impact)
        #expect(text.contains("Sprint Planning"))
        #expect(text.contains("4 Themen"))
        #expect(text.contains("6 Fortschrittseinträge"))
        #expect(text.contains("2 Anhänge"))
    }
}

struct ArchiveDeletedSuccessTextTests {

    @Test func formatsTitleWithClosingQuoteAndFullStop() {
        #expect(archiveDeletedSuccessText(title: "Sprint Planning") == "„Sprint Planning\" endgültig gelöscht.")
    }
}

// MARK: - Test helper

private extension URLRequest {
    /// `httpBody` wird von `URLSession` beim Zustellen an ein `URLProtocol` nicht
    /// immer zuverlässig durchgereicht — je nach Timing/Ausführungsreihenfolge
    /// (beobachtet: seriell vs. parallel laufende Tests) liefert der Request hier
    /// stattdessen nur `httpBodyStream`, `httpBody` ist dann `nil`. Ein reiner
    /// `httpBody ?? Data()`-Fallback würde den Body in diesem Fall still zu einem
    /// leeren `Data()` machen (Assertions auf den Body-Inhalt schlagen dann
    /// fehl statt einen Decode-Fehler zu zeigen) — deshalb hier explizit auch aus
    /// `httpBodyStream` lesen, bevor auf leer zurückgefallen wird.
    func httpBodyStreamOrData() -> Data {
        if let body = httpBody { return body }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let bytesRead = stream.read(&buffer, maxLength: bufferSize)
            if bytesRead > 0 {
                data.append(buffer, count: bytesRead)
            } else {
                break
            }
        }
        return data
    }
}
