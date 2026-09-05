//
//  TestNetworkHelpers.swift
//  ThreadStackTests
//
//  Gemeinsame Netzwerk-Mock-Helfer für Tests, die `AppState` gegen
//  `KnowledgeMockURLProtocol` (siehe `KnowledgeAPITests.swift`) testen.
//
//  Code-Review-Nachbesserung (Fund 3): `makeAppState`, `jsonData`,
//  `requestBodyJSON` und `HandlerCallBox` waren zuvor wörtlich sowohl in
//  `ContactAPITests.swift` ALS AUCH in `ContactAssignmentLoadTimingTests.swift`
//  dupliziert (dort jeweils `private`) — die Kopien waren bereits
//  auseinandergelaufen (`HandlerCallBox` in der einen Datei hatte zusätzliche
//  Felder). EINE gemeinsame, `internal` sichtbare Implementierung hier
//  (CLAUDE.md "Wiederverwendung vor Neuentwicklung"), von BEIDEN Testdateien
//  genutzt.
//
//  Namensabweichung von den Original-Helfern (`makeAppState`/`jsonData` ->
//  `makeMockAppState`/`mockJSONData`): mehrere BEREITS BESTEHENDE, an dieser
//  Nachbesserung unbeteiligte Testdateien (`KnowledgeAPITests.swift`,
//  `ArchiveTests.swift`, `ProgressAPITests.swift`,
//  `ProgressComposerTests.swift`, `ProgressIntegrationTests.swift`,
//  `ProgressStoreTests.swift`, `SummaryStoreTests.swift`) definieren
//  IHRERSEITS ein file-privates `makeAppState`/`jsonData` mit identischer
//  Signatur. Ein `internal` sichtbares Pendant mit demselben Namen hier
//  führt in Swift zu "invalid redeclaration" in genau diesen Fremd-Dateien
//  (die modulweit sichtbare `internal`-Deklaration kollidiert dort mit der
//  lokalen `private`-Deklaration gleichen Namens/gleicher Signatur), sobald
//  das gesamte Testmodul kompiliert wird — nicht nur ein Namenskonflikt
//  zwischen den beiden Contact-Testdateien selbst. Diese Dateien anzufassen
//  läge außerhalb dieses Arbeitspakets (Fund 3 nennt explizit nur
//  `ContactAPITests.swift`/`ContactAssignmentLoadTimingTests.swift`). Die
//  Kollision wird stattdessen durch eindeutige Namen vermieden;
//  `requestBodyJSON`/`HandlerCallBox` kollidieren mit keiner bestehenden
//  Datei und behalten daher ihren ursprünglichen Namen.
//

import Testing
import Foundation
@testable import ThreadStack

@MainActor
func makeMockAppState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "test-mock-\(UUID().uuidString).invalid"
    KnowledgeMockURLProtocol.register(host: host, handler: handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
    let session = URLSession(configuration: cfg)
    let s = AppState(session: session)
    s.serverURL = "https://\(host)"
    return s
}

func mockJSONData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
}

/// `URLSession` liefert den Request-Body an ein `URLProtocol` je nach OS-
/// Version/Session-Konfiguration entweder über `httpBody` ODER als
/// `httpBodyStream` — deckt beide Fälle ab.
func requestBodyJSON(_ req: URLRequest) -> [String: Any] {
    var data = req.httpBody
    if data == nil, let stream = req.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var collected = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            collected.append(buffer, count: read)
        }
        data = collected.isEmpty ? nil : collected
    }
    guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

/// Erfasst, ob und wie oft der Mock-Handler tatsächlich aufgerufen wurde —
/// die reine `#expect`-Prüfung INNERHALB des Handler-Closures reicht nicht
/// aus: würde der Handler nie (oder öfter als erwartet) aufgerufen, liefe ein
/// Test, der nur auf `lastPath`/`lastContactIds` prüft, unbemerkt grün durch.
/// `callCount`/`methods` (Fund 2, Code-Review) machen genau das beobachtbar,
/// z.B. um einen fälschlich zusätzlich abgesetzten `PUT`-Request neben einem
/// erwarteten `GET` aufzudecken, wenn beide denselben Pfad verwenden.
final class HandlerCallBox: @unchecked Sendable {
    var wasCalled = false
    var callCount = 0
    var methods: [String] = []
    var lastPath: String?
    var lastContactIds: [String]?

    func record(_ req: URLRequest) {
        wasCalled = true
        callCount += 1
        if let method = req.httpMethod { methods.append(method) }
        lastPath = req.url?.path
    }
}
