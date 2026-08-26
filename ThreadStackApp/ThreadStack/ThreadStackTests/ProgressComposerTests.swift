//
//  ProgressComposerTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A1 (UX-Nachbesserung "Zielbild und Fortschrittsverlauf"):
//  Tests für `ProgressEntrySource` und `ProgressEntryComposer` (siehe
//  `ProgressEntryComposerView.swift`) — insbesondere die im Vertrag
//  vorgegebenen Randfälle: `refId == nil`/leerer Text -> `.noop`, Fehlerfall
//  behält Text + `clientToken`, Doppelaufruf löst nur EINEN Request aus.
//
//  Netzwerk-Mocking: wiederverwendet `KnowledgeMockURLProtocol` (siehe
//  `KnowledgeAPITests.swift`) über die bestehende `ProgressAPISession`-
//  Testseam, exakt wie bereits `ProgressAPITests.swift`/`ProgressStoreTests.swift`.
//

import Testing
import Foundation
@testable import ThreadStack

@MainActor
private func makeComposerTestState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "progress-composer-mock-\(UUID().uuidString).invalid"
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

/// `URLSession` liefert den Request-Body an ein `URLProtocol` je nach OS-Version/
/// Session-Konfiguration entweder über `httpBody` ODER als `httpBodyStream` —
/// dieser Helper (identisch zum Vorbild in `ProgressAPITests.swift`) deckt
/// beide Fälle ab.
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

private func entryJSON(id: String = "e1") -> [String: Any] {
    [
        "id": id, "refType": "todo", "refId": "a1", "kind": "note",
        "source": "manual", "bodyHtml": "<p>x</p>", "excerpt": "x",
        "createdAt": "2026-08-01T00:00:00.000Z", "editedAt": NSNull(),
        "gapDaysBefore": 0, "showDormancyMarker": false, "editable": true
    ]
}

private func detailJSON() -> [String: Any] {
    [
        "ref": ["type": "todo", "id": "a1", "title": "T", "done": false, "exists": true],
        "goal": "", "goalUpdatedAt": NSNull(),
        "nextStep": "", "nextStepUpdatedAt": NSNull(),
        "stats": ["entryCount": 1, "firstEntryAt": NSNull(), "lastEntryAt": NSNull(), "lastActivityAt": NSNull(),
                   "dormant": false, "dormantDays": NSNull(), "stale": false, "staleDays": NSNull()],
        "reentry": ["show": false, "dormantSince": NSNull(), "dormantLabel": NSNull(),
                     "empty": false, "ai": ["available": false, "frameId": NSNull()]],
        "entries": [],
        "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]
    ]
}

@MainActor
private func makeStore(_ state: AppState) -> ProgressStore {
    ProgressStore(appState: state, defaults: UserDefaults(suiteName: "progress-composer-test-\(UUID().uuidString)")!)
}

// MARK: - ProgressEntrySource.derive(hasSnooze:)

struct ProgressEntrySourceTests {
    @Test func derivesSnoozeWhenHasSnoozeTrue() {
        #expect(ProgressEntrySource.derive(hasSnooze: true) == "snooze")
    }

    @Test func derivesManualWhenHasSnoozeFalse() {
        #expect(ProgressEntrySource.derive(hasSnooze: false) == "manual")
    }
}

// MARK: - ProgressPlainTextEncoding.encode(_:) (Security Review, Mittel: Fund 2)
//
// Der Composer liefert reinen Klartext (TextEditor), `bodyHtml` wird
// serverseitig aber als HTML interpretiert und sanitisiert
// (`sanitizeProgressHtml`, `lib/progress/sanitize.js`) — ungeschützt
// durchgereichter Klartext mit `<`/`>`/`&` verlor dabei still Inhalt (z.B.
// "wenn a<b dann fertig" -> serverseitig nur "wenn a" gespeichert, da "<b "
// als vermeintlicher Tag-Start interpretiert wurde).

struct ProgressPlainTextEncodingTests {
    @Test func plainTextWithoutSpecialCharsIsPreservedInsideParagraph() {
        let result = ProgressPlainTextEncoding.encode("Einfacher Text ohne Sonderzeichen")
        #expect(result == "<p>Einfacher Text ohne Sonderzeichen</p>")
    }

    /// & MUSS zuerst escaped werden — sonst würden die durch das Escaping
    /// von `<`/`>` neu erzeugten Entities selbst nochmal escaped
    /// (`&amp;lt;` statt `&lt;`).
    @Test func escapesAmpersandBeforeAngleBrackets() {
        let result = ProgressPlainTextEncoding.encode("a < b & c > d")
        #expect(result == "<p>a &lt; b &amp; c &gt; d</p>")
    }

    /// Regression für den verifizierten Datenverlust-Fall aus dem Security
    /// Review: ohne Encoding wurde daraus serverseitig nur "wenn a".
    @Test func regressionForVerifiedDataLossCase() {
        let result = ProgressPlainTextEncoding.encode("wenn a<b dann fertig")
        #expect(result == "<p>wenn a&lt;b dann fertig</p>")
    }

    @Test func singleNewlineBecomesLineBreakWithinParagraph() {
        let result = ProgressPlainTextEncoding.encode("Zeile eins\nZeile zwei")
        #expect(result == "<p>Zeile eins<br>Zeile zwei</p>")
    }

    @Test func doubleNewlineStartsNewParagraph() {
        let result = ProgressPlainTextEncoding.encode("Erster Absatz\n\nZweiter Absatz")
        #expect(result == "<p>Erster Absatz</p><p>Zweiter Absatz</p>")
    }

    @Test func emptyStringYieldsEmptyString() {
        #expect(ProgressPlainTextEncoding.encode("") == "")
    }
}

// MARK: - isDirty / isOverLimit

@MainActor
struct ProgressEntryComposerStateTests {
    @Test func isDirtyFalseForEmptyText() {
        let composer = ProgressEntryComposer()
        #expect(composer.isDirty == false)
    }

    @Test func isDirtyFalseForWhitespaceAndNewlineOnlyText() {
        let composer = ProgressEntryComposer()
        composer.text = "   \n\t  \n"
        #expect(composer.isDirty == false)
    }

    @Test func isDirtyTrueForNonEmptyText() {
        let composer = ProgressEntryComposer()
        composer.text = "Etwas Text"
        #expect(composer.isDirty == true)
    }

    @Test func isOverLimitFalseExactlyAtLimit() {
        let composer = ProgressEntryComposer()
        composer.text = String(repeating: "x", count: 5000)
        #expect(composer.isOverLimit == false)
    }

    @Test func isOverLimitTrueOneOverLimit() {
        let composer = ProgressEntryComposer()
        composer.text = String(repeating: "x", count: 5001)
        #expect(composer.isOverLimit == true)
    }
}

// MARK: - commit(...)

@MainActor
struct ProgressEntryComposerCommitTests {

    @Test func commitIsNoopWhenRefIdIsNil() async throws {
        var requestCount = 0
        let state = makeComposerTestState { _ in
            requestCount += 1
            return (200, jsonData(entryJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Ein neuer Zwischenstand"
        let result = await composer.commit(store: store, refType: "todo", refId: nil, hasSnooze: false)
        #expect(result == .noop)
        #expect(requestCount == 0)
        #expect(composer.text == "Ein neuer Zwischenstand")
    }

    @Test func commitIsNoopWhenTextIsEmpty() async throws {
        var requestCount = 0
        let state = makeComposerTestState { _ in
            requestCount += 1
            return (200, jsonData(entryJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        let result = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        #expect(result == .noop)
        #expect(requestCount == 0)
    }

    @Test func commitIsNoopWhenTextIsWhitespaceOnly() async throws {
        var requestCount = 0
        let state = makeComposerTestState { _ in
            requestCount += 1
            return (200, jsonData(entryJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "   \n  \t "
        let result = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        #expect(result == .noop)
        #expect(requestCount == 0)
    }

    @Test func commitSucceedsClearsTextAndClearsError() async throws {
        var callCount = 0
        let state = makeComposerTestState { _ in
            callCount += 1
            if callCount == 1 { return (200, jsonData(entryJSON())) }
            return (200, jsonData(detailJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Neuer Stand"
        let result = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        #expect(result == .saved)
        #expect(composer.text == "")
        #expect(composer.errorText == nil)
    }

    /// Security Review, Mittel: Fund 2 — der über den TextEditor eingegebene
    /// Klartext muss VOR dem Versand über `ProgressPlainTextEncoding.encode`
    /// laufen, statt ungeschützt als `bodyHtml` durchgereicht zu werden.
    @Test func commitEncodesPlainTextAsHtmlBeforeSendingBodyHtml() async throws {
        var receivedBodyHtml: String?
        // Filtert explizit nach der POST-Methode statt nach Aufreihenfolge
        // (`callCount == 1`) — robust gegenüber der tatsächlichen
        // Request-Reihenfolge, analog zu
        // `concurrentCommitsTriggerOnlyOneAddEntryRequest` weiter unten in
        // dieser Datei.
        let state = makeComposerTestState { req in
            if req.httpMethod == "POST" {
                if let body = requestBodyData(req),
                   let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                    // Server-Vertrag (`ProgressAPI.swift`, `addProgressEntry`):
                    // das Request-Feld heisst `body` (NICHT `bodyHtml` — das ist
                    // ausschliesslich der Feldname in der Server-ANTWORT,
                    // `ProgressEntry.bodyHtml`).
                    receivedBodyHtml = obj["body"] as? String
                }
                return (200, jsonData(entryJSON()))
            }
            return (200, jsonData(detailJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "wenn a<b dann fertig"
        _ = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        #expect(receivedBodyHtml == "<p>wenn a&lt;b dann fertig</p>")
    }

    /// Security Review, Niedrig: Fund 3 — das Textfeld ist während eines
    /// laufenden Commits nicht gesperrt. Tippt der Nutzer währenddessen
    /// weiter, darf ein erfolgreicher Commit den inzwischen geänderten Text
    /// NICHT stillschweigend verwerfen.
    @Test func inFlightEditIsNotDiscardedWhenCommitSucceeds() async throws {
        var callCount = 0
        let state = makeComposerTestState { _ in
            callCount += 1
            if callCount == 1 {
                // Simuliert eine langsame Verbindung, damit der Test genug
                // Zeit hat, `text` zu ändern, während der Request noch läuft.
                Thread.sleep(forTimeInterval: 0.05)
                return (200, jsonData(entryJSON()))
            }
            return (200, jsonData(detailJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Ausgangstext"
        let commitTask = Task { await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false) }
        // Lässt commit() Zeit, den Ausgangstext einzufrieren, bevor wir ihn
        // während des laufenden Requests weiter bearbeiten.
        try? await Task.sleep(nanoseconds: 15_000_000)
        composer.text = "Ausgangstext weitergetippt"
        let result = await commitTask.value
        #expect(result == .saved)
        #expect(composer.text == "Ausgangstext weitergetippt")
    }

    /// Gegenprobe zu obigem Test: hat der Nutzer NICHT weitergetippt, wird
    /// nach Erfolg weiterhin wie gehabt geleert (Fund 3 darf den
    /// Normalfall nicht regressieren).
    @Test func textIsClearedOnSuccessWhenUnchangedDuringCommit() async throws {
        var callCount = 0
        let state = makeComposerTestState { _ in
            callCount += 1
            if callCount == 1 { return (200, jsonData(entryJSON())) }
            return (200, jsonData(detailJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Unverändert bis zum Erfolg"
        let result = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        #expect(result == .saved)
        #expect(composer.text == "")
    }

    @Test func commitSendsDerivedSourceBasedOnHasSnooze() async throws {
        var receivedSource: String?
        // Filtert explizit nach der POST-Methode statt nach Aufreihenfolge
        // (`callCount == 1`) — robust gegenüber der tatsächlichen
        // Request-Reihenfolge, analog zu
        // `concurrentCommitsTriggerOnlyOneAddEntryRequest` weiter unten in
        // dieser Datei.
        let state = makeComposerTestState { req in
            if req.httpMethod == "POST" {
                if let body = requestBodyData(req),
                   let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                    receivedSource = obj["source"] as? String
                }
                return (200, jsonData(entryJSON()))
            }
            return (200, jsonData(detailJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Direkt beim Snoozen erfasst"
        _ = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: true)
        #expect(receivedSource == "snooze")
    }

    @Test func commitFailureKeepsTextAndSetsErrorText() async throws {
        let state = makeComposerTestState { _ in
            (500, jsonData(["error": "Serverfehler"]))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Bleibt erhalten"
        let result = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        #expect(result == .failed)
        #expect(composer.text == "Bleibt erhalten")
        #expect(composer.errorText == "Serverfehler")
    }

    /// Vertrag: "kein zweiter Request bei Doppelaufruf/Doppel-Tap" — zwei
    /// gleichzeitige `commit`-Aufrufe teilen sich dasselbe Ergebnis, es wird
    /// nur EIN `addEntry`-Request (POST) ausgelöst.
    @Test func concurrentCommitsTriggerOnlyOneAddEntryRequest() async throws {
        var addEntryCallCount = 0
        let state = makeComposerTestState { req in
            if req.httpMethod == "POST" {
                addEntryCallCount += 1
                return (200, jsonData(entryJSON()))
            }
            return (200, jsonData(detailJSON()))
        }
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Gleichzeitig gespeichert"
        async let a = composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        async let b = composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        let (resultA, resultB) = await (a, b)
        #expect(addEntryCallCount == 1)
        #expect(resultA == .saved)
        #expect(resultB == .saved)
    }

    /// Vertrag: nach einem Fehler bleibt derselbe `clientToken` für den
    /// nächsten Versuch bestehen (Idempotenz-Kontinuität) — `store.addEntry`
    /// verwirft den Token nur bei Erfolg.
    @Test func sameClientTokenIsReusedAfterFailedCommit() async throws {
        let state = makeComposerTestState { _ in
            (500, jsonData(["error": "Serverfehler"]))
        }
        let store = makeStore(state)
        let before = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        let composer = ProgressEntryComposer()
        composer.text = "Erster Versuch"
        _ = await composer.commit(store: store, refType: "todo", refId: "a1", hasSnooze: false)
        let after = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        #expect(before == after)
    }
}

// MARK: - discard(...)

@MainActor
struct ProgressEntryComposerDiscardTests {
    @Test func discardClearsTextAndDiscardsClientToken() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Entwurf"
        let before = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        composer.discard(store: store, refType: "todo", refId: "a1")
        #expect(composer.text == "")
        #expect(composer.errorText == nil)
        let after = store.clientTokenForPendingEntry(refType: "todo", refId: "a1")
        #expect(before != after)
    }

    @Test func discardWithNilRefIdOnlyClearsTextWithoutTouchingStore() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        let store = makeStore(state)
        let composer = ProgressEntryComposer()
        composer.text = "Entwurf ohne gespeichertes Vorhaben"
        composer.discard(store: store, refType: "todo", refId: nil)
        #expect(composer.text == "")
    }
}
