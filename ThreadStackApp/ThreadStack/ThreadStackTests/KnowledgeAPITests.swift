//
//  KnowledgeAPITests.swift
//  ThreadStackTests
//
//  Unit tests for Arbeitspaket 1 ("knowledge-api"): decoding of the new
//  Knowledge endpoints/models, structured `KnowledgeAPIError` behaviour
//  (code/limit preservation, 404-as-success handling), and the tolerant
//  decoding of `KnowledgePage.relatedPageIds`.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Test double: intercepts URLSession(.default)-based requests so we
// can exercise AppState's real request path without hitting the network.

final class KnowledgeMockURLProtocol: URLProtocol {
    // Swift Testing runs `@Test` functions concurrently by default, so a
    // single shared/global handler would be racy (one test's response could
    // be delivered to another). Handlers are therefore keyed by a
    // test-unique mock host name instead, guarded by a lock.
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
    let host = "mock-\(UUID().uuidString).invalid"
    KnowledgeMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
    let session = URLSession(configuration: cfg)
    let s = AppState(session: session)
    s.serverURL = "https://\(host)"
    return s
}

private func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

// MARK: - KnowledgeAPIError

struct KnowledgeAPIErrorTests {

    @Test func isGoneOnlyForStatus404() {
        let gone = KnowledgeAPIError(status: 404, code: "KNOWLEDGE_PAGE_GONE", message: "weg", limit: nil)
        #expect(gone.isGone == true)
        let other = KnowledgeAPIError(status: 400, code: "TITLE_REQUIRED", message: "Überschrift erforderlich", limit: nil)
        #expect(other.isGone == false)
    }

    @Test func errorDescriptionPassesThroughServerMessage() {
        let e = KnowledgeAPIError(status: 400, code: "TITLE_TOO_LONG", message: "Überschrift zu lang", limit: 300)
        #expect(e.errorDescription == "Überschrift zu lang")
        #expect(e.limit == 300)
    }

    @Test func equatableComparesAllFields() {
        let a = KnowledgeAPIError(status: 404, code: "NOT_FOUND", message: "x", limit: nil)
        let b = KnowledgeAPIError(status: 404, code: "NOT_FOUND", message: "x", limit: nil)
        let c = KnowledgeAPIError(status: 404, code: "NOT_FOUND", message: "y", limit: nil)
        #expect(a == b)
        #expect(a != c)
    }
}

// MARK: - Models: KnowledgePage.relatedPageIds tolerant decoding

struct KnowledgePageRelatedIdsDecodingTests {

    @Test func decodesRelatedPageIdsWhenPresent() throws {
        let json = """
        { "id": "k1", "title": "T", "content": "<p>c</p>", "sortOrder": 0,
          "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
          "themeIds": ["th1"], "relatedPageIds": ["k2", "k3"] }
        """.data(using: .utf8)!
        let page = try JSONDecoder().decode(KnowledgePage.self, from: json)
        #expect(page.relatedPageIds == ["k2", "k3"])
    }

    @Test func defaultsRelatedPageIdsToEmptyWhenAbsent() throws {
        // z.B. GET /themes/:id/knowledge liefert (noch) kein relatedPageIds.
        let json = """
        { "id": "k1", "title": "T", "content": "<p>c</p>", "sortOrder": 0,
          "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
          "themeIds": [] }
        """.data(using: .utf8)!
        let page = try JSONDecoder().decode(KnowledgePage.self, from: json)
        #expect(page.relatedPageIds == [])
    }

    @Test func decodesOriginThemeFieldsWhenPresent() throws {
        let json = """
        { "id": "k1", "title": "T", "content": "", "sortOrder": null,
          "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
          "themeIds": ["th1"], "originThemeId": "th0", "originThemeTitle": "Vererbt von" }
        """.data(using: .utf8)!
        let page = try JSONDecoder().decode(KnowledgePage.self, from: json)
        #expect(page.originThemeId == "th0")
        #expect(page.originThemeTitle == "Vererbt von")
        #expect(page.relatedPageIds == [])
    }
}

// MARK: - AppState knowledge API: success paths

@MainActor
struct KnowledgeAPISuccessTests {

    @Test func createKnowledgePageDecodesFullPage() async throws {
        let state = makeAppState { req in
            #expect(req.httpMethod == "POST")
            #expect(req.url?.path.hasSuffix("/api/knowledge") == true)
            let body = jsonData([
                "id": "k1", "title": "Neu", "content": "<p>hi</p>", "sortOrder": 0,
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "themeIds": ["th1"], "relatedPageIds": []
            ])
            return (201, body)
        }
        let page = try await state.createKnowledgePage(title: "Neu", content: "<p>hi</p>", themeIds: ["th1"])
        #expect(page.id == "k1")
        #expect(page.title == "Neu")
        #expect(page.themeIds == ["th1"])
    }

    @Test func updateKnowledgePageReturnsUpdatedAt() async throws {
        let state = makeAppState { req in
            #expect(req.httpMethod == "PUT")
            return (200, jsonData(["ok": true, "updatedAt": "2026-02-02T00:00:00Z"]))
        }
        let updatedAt = try await state.updateKnowledgePage(id: "k1", title: "T", content: "c")
        #expect(updatedAt == "2026-02-02T00:00:00Z")
    }

    @Test func setKnowledgeThemesDecodesAppliedAndDropped() async throws {
        let state = makeAppState { _ in
            (200, jsonData(["ok": true, "appliedThemeIds": ["th1"], "droppedCount": 2]))
        }
        let r = try await state.setKnowledgeThemes(id: "k1", themeIds: ["th1", "gone1", "gone2"])
        #expect(r.appliedThemeIds == ["th1"])
        #expect(r.droppedCount == 2)
    }

    @Test func deleteKnowledgePageSucceedsAndRemovesFromState() async throws {
        let state = makeAppState { _ in (200, jsonData(["ok": true])) }
        state.knowledgePages = [KnowledgePage(id: "k1", title: "T", content: "", sortOrder: 0,
                                               createdAt: "", updatedAt: "", themeIds: [])]
        try await state.deleteKnowledgePage(id: "k1")
        #expect(state.knowledgePages.isEmpty)
    }

    /// Verbindlicher Vertrag: DELETE wirft bei 404 NICHT — gilt als Erfolg.
    @Test func deleteKnowledgePageTreats404AsSuccess() async throws {
        let state = makeAppState { _ in
            (404, jsonData(["error": "Diese Wissensseite existiert nicht mehr.", "code": "KNOWLEDGE_PAGE_GONE"]))
        }
        state.knowledgePages = [KnowledgePage(id: "k1", title: "T", content: "", sortOrder: 0,
                                               createdAt: "", updatedAt: "", themeIds: [])]
        try await state.deleteKnowledgePage(id: "k1")
        #expect(state.knowledgePages.isEmpty)
    }

    @Test func knowledgeLinksDecodesListWithNullableUpdatedAt() async throws {
        let state = makeAppState { _ in
            (200, jsonData([
                ["linkId": "l1", "page": ["id": "k2", "title": "Anderes", "updatedAt": NSNull()]]
            ]))
        }
        let links = try await state.knowledgeLinks(pageId: "k1")
        #expect(links.count == 1)
        #expect(links[0].id == "l1")
        #expect(links[0].page.title == "Anderes")
        #expect(links[0].page.updatedAt == nil)
    }

    @Test func addKnowledgeLinkDuplicateDoesNotThrow() async throws {
        // created:false (Duplikat) kommt als HTTP 200 zurück — kein Fehler.
        let state = makeAppState { _ in
            (200, jsonData(["linkId": "l1", "created": false,
                             "page": ["id": "k2", "title": "Ziel", "updatedAt": "2026-01-01T00:00:00Z"]]))
        }
        let link = try await state.addKnowledgeLink(pageId: "k1", targetId: "k2")
        #expect(link.linkId == "l1")
        #expect(link.page.id == "k2")
    }

    @Test func removeKnowledgeLinkIsIdempotentOn404() async throws {
        let state = makeAppState { _ in
            (404, jsonData(["error": "Nicht gefunden", "code": "NOT_FOUND"]))
        }
        try await state.removeKnowledgeLink(pageId: "k1", linkId: "gone")
        // no throw = success
    }

    @Test func searchKnowledgeDecodesWrappedResults() async throws {
        let state = makeAppState { req in
            #expect(req.url?.query?.contains("q=hallo") == true)
            return (200, jsonData([
                "query": "hallo",
                "results": [["id": "k1", "title": "Hallo Welt", "snippet": "…Hallo…", "themeIds": ["th1"]]]
            ]))
        }
        let hits = try await state.searchKnowledge(query: "hallo")
        #expect(hits.count == 1)
        #expect(hits[0].id == "k1")
        #expect(hits[0].snippet == "…Hallo…")
    }

    @Test func searchKnowledgePercentEncodesQuery() async throws {
        let state = makeAppState { req in
            // Space and umlaut must be percent-encoded, never sent raw.
            let raw = req.url?.absoluteString ?? ""
            #expect(!raw.contains(" "))
            return (200, jsonData(["query": "ä b", "results": []]))
        }
        let hits = try await state.searchKnowledge(query: "ä b")
        #expect(hits.isEmpty)
    }

    @Test func reloadKnowledgePageUpdatesStateAndReturnsPage() async throws {
        let state = makeAppState { _ in
            (200, jsonData([
                ["id": "k1", "title": "Aktualisiert", "content": "", "sortOrder": 0,
                 "createdAt": "", "updatedAt": "", "themeIds": []]
            ]))
        }
        let page = await state.reloadKnowledgePage(id: "k1")
        #expect(page?.title == "Aktualisiert")
        #expect(state.knowledgePages.first?.title == "Aktualisiert")
    }

    @Test func reloadKnowledgePageReturnsNilWhenPageGoneFromList() async throws {
        let state = makeAppState { _ in (200, jsonData([])) }
        let page = await state.reloadKnowledgePage(id: "k1")
        #expect(page == nil)
    }
}

// MARK: - AppState knowledge API: structured error paths

@MainActor
struct KnowledgeAPIErrorPathTests {

    @Test func createKnowledgePageThrowsTitleTooLongWithLimit() async throws {
        let state = makeAppState { _ in
            (400, jsonData(["error": "Überschrift zu lang", "code": "TITLE_TOO_LONG", "limit": 300]))
        }
        do {
            _ = try await state.createKnowledgePage(title: String(repeating: "x", count: 400), content: "", themeIds: [])
            Issue.record("expected KnowledgeAPIError")
        } catch let e as KnowledgeAPIError {
            #expect(e.code == KnowledgeErrorCode.titleTooLong)
            #expect(e.limit == 300)
            #expect(e.status == 400)
        }
    }

    @Test func createKnowledgePageThrowsTitleRequired() async throws {
        let state = makeAppState { _ in
            (400, jsonData(["error": "Überschrift erforderlich", "code": "TITLE_REQUIRED"]))
        }
        do {
            _ = try await state.createKnowledgePage(title: "", content: "", themeIds: [])
            Issue.record("expected KnowledgeAPIError")
        } catch let e as KnowledgeAPIError {
            #expect(e.code == KnowledgeErrorCode.titleRequired)
            #expect(e.limit == nil)
        }
    }

    @Test func updateKnowledgePageThrowsContentTooLongWithLimit() async throws {
        let state = makeAppState { _ in
            (400, jsonData(["error": "Inhalt zu lang", "code": "CONTENT_TOO_LONG", "limit": 500_000]))
        }
        do {
            _ = try await state.updateKnowledgePage(id: "k1", title: "T", content: "c")
            Issue.record("expected KnowledgeAPIError")
        } catch let e as KnowledgeAPIError {
            #expect(e.code == KnowledgeErrorCode.contentTooLong)
            #expect(e.limit == 500_000)
        }
    }

    @Test func updateKnowledgePageThrowsKnowledgePageGoneAndIsGoneTrue() async throws {
        let state = makeAppState { _ in
            (404, jsonData(["error": "Diese Wissensseite existiert nicht mehr.", "code": "KNOWLEDGE_PAGE_GONE"]))
        }
        do {
            _ = try await state.updateKnowledgePage(id: "gone", title: "T", content: "c")
            Issue.record("expected KnowledgeAPIError")
        } catch let e as KnowledgeAPIError {
            #expect(e.code == KnowledgeErrorCode.knowledgePageGone)
            #expect(e.isGone == true)
        }
    }

    @Test func setKnowledgeThemesThrowsValidationFailed() async throws {
        let state = makeAppState { _ in
            (400, jsonData(["error": "themeIds muss ein Array sein", "code": "VALIDATION_FAILED"]))
        }
        do {
            _ = try await state.setKnowledgeThemes(id: "k1", themeIds: [])
            Issue.record("expected KnowledgeAPIError")
        } catch let e as KnowledgeAPIError {
            #expect(e.code == KnowledgeErrorCode.validationFailed)
        }
    }

    /// 401 muss weiterhin als APIError.unauthorized geworfen werden (nicht als
    /// KnowledgeAPIError) — bestehendes Session-Expiry-Handling darf nicht brechen.
    @Test func unauthorizedStaysAPIErrorUnauthorized() async throws {
        let state = makeAppState { _ in (401, Data()) }
        do {
            _ = try await state.createKnowledgePage(title: "T", content: "", themeIds: [])
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
    }

    @Test func errorWithoutCodeYieldsEmptyStringCode() async throws {
        let state = makeAppState { _ in
            (500, jsonData(["error": "Serverfehler"]))
        }
        do {
            _ = try await state.createKnowledgePage(title: "T", content: "", themeIds: [])
            Issue.record("expected KnowledgeAPIError")
        } catch let e as KnowledgeAPIError {
            #expect(e.code == "")
            #expect(e.message == "Serverfehler")
        }
    }
}
