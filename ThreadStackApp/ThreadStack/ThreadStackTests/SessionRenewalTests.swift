//
//  SessionRenewalTests.swift
//  ThreadStackTests
//
//  Unit tests für die automatische Sitzungserneuerung (Arbeitspaket iOS
//  "Sitzungs-Handling"): `AppState.performRequest` versucht bei einem 401
//  EINMAL, die Sitzung über `tryServerReLogin()` zu erneuern und wiederholt
//  die ursprüngliche Anfrage danach transparent, bevor als letzter Ausweg
//  `APIError.unauthorized` geworfen wird.
//
//  `tryServerReLogin()` selbst geht über die echte, Biometrie-geschützte
//  Keychain (siehe Keychain.swift) — in einem automatisierten Testlauf wäre
//  das entweder leer oder würde einen System-Prompt auslösen. Die Tests
//  nutzen daher den Test-only-Seam `AppState.sessionRenewalOverride`, um das
//  Ergebnis der Erneuerung ohne echten Keychain-/Netzwerkzugriff zu steuern,
//  und `AppState.hasStoredCredentials` (kein `private`, direkt setzbar), um
//  den "keine gespeicherten Zugangsdaten"-Fall ohne echten Keychain-Zustand
//  zu simulieren.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Test double: intercepts URLSession(.default)-based requests so we
// can exercise AppState's real request path without hitting the network.
// Eigene Klasse (analog zu ArchiveMockURLProtocol/KnowledgeMockURLProtocol),
// zusätzlich mit einem Aufruf-Zähler pro Host, damit Tests prüfen können,
// ob/wie oft ein Request tatsächlich wiederholt wurde.

final class SessionRenewalMockURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (Int, URLRequest) -> (Int, Data)] = [:]
    private static var callCounts: [String: Int] = [:]

    static func register(host: String, handler: @escaping (Int, URLRequest) -> (Int, Data)) {
        lock.lock(); handlers[host] = handler; callCounts[host] = 0; lock.unlock()
    }

    static func callCount(forHost host: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return callCounts[host] ?? 0
    }

    private static func handler(forHost host: String?) -> ((Int, URLRequest) -> (Int, Data))? {
        guard let host else { return nil }
        lock.lock(); defer { lock.unlock() }
        return handlers[host]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let host = request.url?.host, let handler = Self.handler(forHost: host) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        Self.lock.lock()
        let callIndex = Self.callCounts[host] ?? 0
        Self.callCounts[host] = callIndex + 1
        Self.lock.unlock()
        let (status, data) = handler(callIndex, request)
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
private func makeAppState(handler: @escaping (Int, URLRequest) -> (Int, Data)) -> (AppState, String) {
    let host = "session-renewal-mock-\(UUID().uuidString).invalid"
    SessionRenewalMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [SessionRenewalMockURLProtocol.self]
    let session = URLSession(configuration: cfg)
    let s = AppState(session: session)
    s.serverURL = "https://\(host)"
    return (s, host)
}

private func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

@MainActor
struct SessionRenewalTests {

    @Test func renewalSucceedsAndRetriesOriginalRequestTransparently() async throws {
        let (state, host) = makeAppState { callIndex, _ in
            callIndex == 0 ? (401, Data()) : (200, jsonData(["ok": true]))
        }
        state.sessionRenewalOverride = { true }

        let result: OKResponse = try await state.request("GET", "/todos/reorder")

        #expect(result.ok == true)
        #expect(SessionRenewalMockURLProtocol.callCount(forHost: host) == 2)
    }

    @Test func withoutStoredCredentialsStillThrowsUnauthorized() async throws {
        let (state, host) = makeAppState { _, _ in (401, Data()) }
        state.hasStoredCredentials = false
        state.sessionRenewalOverride = nil

        do {
            let _: OKResponse = try await state.request("GET", "/todos/reorder")
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
        // Kein Retry ohne erfolgreiche Erneuerung — genau ein Aufruf.
        #expect(SessionRenewalMockURLProtocol.callCount(forHost: host) == 1)
    }

    @Test func failedRenewalThrowsUnauthorizedWithoutInfiniteRetry() async throws {
        let (state, host) = makeAppState { _, _ in (401, Data()) }
        state.sessionRenewalOverride = { false }

        do {
            let _: OKResponse = try await state.request("GET", "/todos/reorder")
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
        #expect(SessionRenewalMockURLProtocol.callCount(forHost: host) == 1)
    }

    @Test func concurrentRequestsShareASingleRenewalAttempt() async throws {
        // Bewusst NICHT über eine feste Aufrufreihenfolge (z.B. "die ersten
        // zwei Calls sind 401") modelliert: wie viele 401-Antworten anfallen,
        // bevor der gemeinsame Renewal-Task durchläuft, hängt vom exakten
        // Scheduling der beiden nebenläufigen Requests ab. Stattdessen steuert
        // ein von der Erneuerung selbst gesetztes Flag den Mock — das prüft
        // die eigentliche Garantie (genau ein Renewal-Versuch für beide
        // Requests) unabhängig von Timing-Details.
        let renewed = RenewedFlag()
        let (state, _) = makeAppState { _, _ in
            renewed.isSet ? (200, jsonData(["ok": true])) : (401, Data())
        }
        let renewalCallCount = Counter()
        state.sessionRenewalOverride = {
            await renewalCallCount.increment()
            renewed.set()
            return true
        }

        async let first: OKResponse = state.request("GET", "/todos/reorder")
        async let second: OKResponse = state.request("GET", "/todos/reorder")
        let (r1, r2) = try await (first, second)

        #expect(r1.ok == true)
        #expect(r2.ok == true)
        #expect(await renewalCallCount.value == 1)
    }

    @Test func loginPathNeverTriggersRenewalAttempt() async throws {
        let (state, _) = makeAppState { _, _ in (401, Data()) }
        let renewalCallCount = Counter()
        state.sessionRenewalOverride = {
            await renewalCallCount.increment()
            return true
        }

        do {
            try await state.login(username: "u", password: "p")
            Issue.record("expected APIError.unauthorized")
        } catch let e as APIError {
            if case .unauthorized = e { /* ok */ } else { Issue.record("wrong APIError case") }
        }
        #expect(await renewalCallCount.value == 0)
    }

    @Test func logoutPathNeverTriggersRenewalAttempt() async throws {
        let (state, _) = makeAppState { _, _ in (401, Data()) }
        let renewalCallCount = Counter()
        state.sessionRenewalOverride = {
            await renewalCallCount.increment()
            return true
        }

        // logout() ist best-effort und schluckt Serverfehler bewusst (siehe
        // AppState.logout) — der Test prüft daher nicht auf einen Throw,
        // sondern nur, dass kein Renewal-Versuch für /logout ausgelöst wird.
        try await state.logout()
        #expect(await renewalCallCount.value == 0)
    }
}

/// Kleiner Actor-basierter Zähler für nebenläufige Test-Assertions (kein
/// `@unchecked Sendable`/Locking nötig, Actor übernimmt das).
private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}

/// Lock-geschütztes Flag, das der (synchrone) Mock-Handler in
/// `concurrentRequestsShareASingleRenewalAttempt` abfragt, um ab dem
/// erfolgreichen Renewal-Versuch auf 200 umzuschalten — unabhängig davon,
/// wie viele 401-Antworten vorher wegen des nebenläufigen Schedulings
/// tatsächlich angefallen sind. Eine eigene Klasse (statt `Counter`), weil
/// der Mock-Handler synchron ist und keinen Actor awaiten kann.
private final class RenewedFlag {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}
