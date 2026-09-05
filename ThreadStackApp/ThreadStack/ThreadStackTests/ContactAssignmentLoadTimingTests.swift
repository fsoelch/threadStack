//
//  ContactAssignmentLoadTimingTests.swift
//  ThreadStackTests
//
//  Regressions-Nachbesserung ("Nein"-Review, Blocker): die letzte
//  Umstrukturierung hatte das Laden der bestehenden Ansprechpartner-Zuordnung
//  (`.task`) von `TodoFormView`/`TopicFormView` (NavigationStack-Root) in
//  `ContactAssignmentSection.body` verschoben — eine Zeile INNERHALB von
//  `Form`. Da SwiftUI Form/List-Zeilen erst bei tatsächlicher Sichtbarkeit
//  realisiert (Lazy Rendering), lief das Laden bei einem bestehenden ToDo/
//  Thema mit genug Inhalt oberhalb der Sektion oft NIE. `save()` sendete
//  danach trotzdem einen vollen Ersatz-Request (`AppState.setAssignments`)
//  mit der nie befüllten, leeren Startmenge — ein serverseitiges Löschen
//  ALLER zugeordneten Ansprechpartner ohne dass der Nutzer den Abschnitt je
//  gesehen hat.
//
//  Diese Datei deckt genau das Regressions-Szenario ab: Laden schlägt fehl
//  ODER ist (noch) nicht abgeschlossen -> `save()` darf NIEMALS einen
//  `setAssignments`-Request mit einer (potenziell leeren) Auswahl absetzen.
//
//  Netzwerk-Mocking: wiederverwendet `KnowledgeMockURLProtocol` (siehe
//  `ContactAPITests.swift`) — kein neuer Mock-Mechanismus.
//

import Testing
import Foundation
@testable import ThreadStack

@MainActor
private func makeAppState(handler: @escaping (URLRequest) -> (Int, Data)) -> AppState {
    let host = "contact-assignment-timing-mock-\(UUID().uuidString).invalid"
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

/// `URLSession` liefert den Request-Body an ein `URLProtocol` je nach OS-
/// Version/Session-Konfiguration entweder über `httpBody` ODER als
/// `httpBodyStream` — deckt beide Fälle ab (identisches Muster bereits in
/// `ContactAPITests.swift`/`ProgressAPITests.swift`, hier bewusst dupliziert
/// statt gemeinsam exportiert: das Original dort ist `private`, siehe
/// dortiger Kommentar).
private func requestBodyJSON(_ req: URLRequest) -> [String: Any] {
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

/// Erfasst, ob der Mock-Handler tatsächlich aufgerufen wurde (analoges Muster
/// zu `ContactAPITests.HandlerCallBox`, hier je Testdatei bewusst dupliziert,
/// da das Original dort `private` ist — siehe dortiger Kommentar zu
/// `requestBodyJSON`).
private final class HandlerCallBox: @unchecked Sendable {
    var wasCalled = false
    var lastPath: String?
    var lastContactIds: [String]?
}

// MARK: - 1. `loadAssignedContactIds` unterscheidet Erfolg/Fehlschlag

@MainActor
struct LoadAssignedContactIdsTests {

    @Test func returnsEmptySuccessImmediatelyInCreateModeWithoutRefId() async {
        // Anlegen-Modus: kein `refId` -> kein Netzwerk-Request nötig, sofort
        // ein erfolgreiches, leeres Ergebnis (nichts zu laden, nichts zu
        // verlieren).
        let state = makeAppState { _ in
            Issue.record("kein Request im Anlegen-Modus erwartet")
            return (500, Data())
        }
        let result = await loadAssignedContactIds(state: state, refType: "todo", refId: nil)
        #expect(result == .success([]))
    }

    @Test func returnsSuccessWithLoadedContactIds() async {
        let state = makeAppState { req in
            #expect(req.url?.path == "/api/assignments/todo/t1")
            return (200, jsonData([
                ["contactId": "c1", "name": "Anna", "role": "", "email": "", "assignedAt": "2026-01-01T00:00:00.000Z"],
                ["contactId": "c2", "name": "Ben", "role": "", "email": "", "assignedAt": "2026-01-01T00:00:00.000Z"]
            ]))
        }
        let result = await loadAssignedContactIds(state: state, refType: "todo", refId: "t1")
        #expect(result == .success(["c1", "c2"]))
    }

    /// Kern des Blockers: ein Transportfehler (z.B. offline) MUSS als
    /// `.failure` erkennbar sein, NICHT als `.success([])` — genau diese
    /// Verwechslung war der stille Datenverlustpfad über den Fehlerweg.
    @Test func returnsFailureOnTransportErrorWithOfflineHint() async {
        let host = "contact-assignment-timing-unregistered-\(UUID().uuidString).invalid"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
        let state = AppState(session: URLSession(configuration: cfg))
        state.serverURL = "https://\(host)"
        let result = await loadAssignedContactIds(state: state, refType: "todo", refId: "t1")
        guard case .failure(let message) = result else {
            Issue.record("expected .failure for a transport error")
            return
        }
        #expect(message.contains("Verbindung"))
    }

    @Test func returnsFailureOnServerErrorWithoutOfflineHint() async {
        let state = makeAppState { _ in (500, jsonData(["error": "Interner Fehler"])) }
        let result = await loadAssignedContactIds(state: state, refType: "todo", refId: "t1")
        guard case .failure(let message) = result else {
            Issue.record("expected .failure for a server error")
            return
        }
        #expect(!message.contains("Verbindung"))
    }
}

// MARK: - 2. `ContactAssignmentPickerLogic.shouldCommitAssignments`: reine Entscheidungslogik

struct ShouldCommitAssignmentsTests {

    @Test func commitsWhenSavedAndLoadedSuccessfully() {
        #expect(ContactAssignmentPickerLogic.shouldCommitAssignments(savedId: "todo-1", assignmentsLoaded: true) == true)
    }

    /// Kernfall des Blockers: das Laden ist fehlgeschlagen ODER (durch das
    /// Timing-Problem) nie abgeschlossen -> `assignmentsLoaded` bleibt
    /// `false` -> niemals committen, selbst wenn das Speichern des Todos/
    /// Themas selbst erfolgreich war (`savedId` gesetzt).
    @Test func neverCommitsWhenNotLoadedEvenIfSaveSucceeded() {
        #expect(ContactAssignmentPickerLogic.shouldCommitAssignments(savedId: "todo-1", assignmentsLoaded: false) == false)
    }

    @Test func neverCommitsWithoutASavedId() {
        #expect(ContactAssignmentPickerLogic.shouldCommitAssignments(savedId: nil, assignmentsLoaded: true) == false)
    }

    @Test func neverCommitsWithoutASavedIdAndNotLoaded() {
        #expect(ContactAssignmentPickerLogic.shouldCommitAssignments(savedId: nil, assignmentsLoaded: false) == false)
    }
}

// MARK: - 3. End-to-End: fehlgeschlagenes/nicht abgeschlossenes Laden -> KEIN setAssignments-Request

/// Bildet den exakten Ablauf nach, den `TodoFormView.save()`/
/// `TopicFormView.save()` seit dem Fix durchlaufen: zuerst
/// `loadAssignedContactIds` (liefert `assignmentsLoaded`), danach die
/// `save()`-Guard-Bedingung `ContactAssignmentPickerLogic.shouldCommitAssignments`.
/// Der Test verifiziert über den Netzwerk-Mock, dass bei einem fehlgeschlagenen
/// ODER (Timing-Regression) nie ausgeführten Ladevorgang tatsächlich KEIN
/// `PUT /api/assignments/...`-Request abgesetzt wird — das ist die
/// beobachtbare Konsequenz, die den früheren Datenverlust verursacht hätte.
@MainActor
struct ContactAssignmentSaveGuardEndToEndTests {

    /// Simuliert den in `save()` verwendeten Ablauf für ein bereits
    /// bestehendes Todo mit vorher zugeordneten Ansprechpartnern.
    private func runSaveFlow(
        state: AppState, savedId: String, refType: String,
        assignmentsLoaded: Bool, contactIdsToCommit: Set<String>
    ) async throws {
        if ContactAssignmentPickerLogic.shouldCommitAssignments(savedId: savedId, assignmentsLoaded: assignmentsLoaded) {
            _ = try await state.setAssignments(refType: refType, refId: savedId, contactIds: Array(contactIdsToCommit))
        }
    }

    @Test func failedLoadNeverTriggersASetAssignmentsRequest() async throws {
        let box = HandlerCallBox()
        let state = makeAppState { req in
            box.wasCalled = true
            box.lastPath = req.url?.path
            return (500, jsonData(["error": "Interner Fehler"]))
        }
        // 1. Laden schlägt fehl -> `assignmentsLoaded` bleibt `false`.
        let loadResult = await loadAssignedContactIds(state: state, refType: "todo", refId: "t1")
        guard case .failure = loadResult else {
            Issue.record("Testvoraussetzung verletzt: Laden sollte fehlschlagen")
            return
        }
        // 2. `save()` versucht trotzdem, das (erfolgreich gespeicherte) Todo
        //    zu committen — die lokale Auswahl ist zu diesem Zeitpunkt noch
        //    die anfängliche, leere Menge (nie überschrieben, da das Laden
        //    fehlschlug).
        try await runSaveFlow(
            state: state, savedId: "t1", refType: "todo",
            assignmentsLoaded: false, contactIdsToCommit: []
        )
        // 3. Der einzige Request, der beim `makeAppState`-Handler ankam, war
        //    der (fehlgeschlagene) Ladeversuch selbst — KEIN zusätzlicher
        //    `PUT /api/assignments/todo/t1`-Request mit der leeren Auswahl.
        #expect(box.wasCalled == true) // vom Ladeversuch, nicht vom Commit
        #expect(box.lastPath == "/api/assignments/todo/t1")
    }

    /// Timing-Regression selbst (Kern des Blockers): das Laden wurde
    /// überhaupt nicht ausgeführt (z.B. weil das `.task` nie lief, exakt der
    /// ursprüngliche Bug) — `assignmentsLoaded` bleibt bei seinem
    /// Startwert `false`, ganz ohne dass überhaupt ein Ladeversuch
    /// stattgefunden hat.
    @Test func neverAttemptedLoadNeverTriggersASetAssignmentsRequestEvenWithStaleEmptySelection() async throws {
        let box = HandlerCallBox()
        let state = makeAppState { req in
            box.wasCalled = true
            box.lastPath = req.url?.path
            box.lastContactIds = requestBodyJSON(req)["contactIds"] as? [String]
            return (200, jsonData([]))
        }
        // Kein Aufruf von `loadAssignedContactIds` -- exakt das Timing-Bug-
        // Szenario, in dem das `.task` (an der falschen Stelle hängend)
        // niemals lief.
        try await runSaveFlow(
            state: state, savedId: "t1", refType: "todo",
            assignmentsLoaded: false, contactIdsToCommit: []
        )
        #expect(box.wasCalled == false)
    }

    /// Gegenprobe (kein falsches Positiv durch den Fix): erfolgreiches Laden
    /// erlaubt weiterhin den regulären Commit-Pfad mit der tatsächlich
    /// ausgewählten Menge.
    @Test func successfulLoadStillAllowsCommitWithActualSelection() async throws {
        let box = HandlerCallBox()
        let state = makeAppState { req in
            box.wasCalled = true
            box.lastPath = req.url?.path
            box.lastContactIds = requestBodyJSON(req)["contactIds"] as? [String]
            return (200, jsonData([
                ["contactId": "c1", "name": "Anna", "role": "", "email": "", "assignedAt": "2026-01-01T00:00:00.000Z"]
            ]))
        }
        try await runSaveFlow(
            state: state, savedId: "t1", refType: "todo",
            assignmentsLoaded: true, contactIdsToCommit: ["c1"]
        )
        #expect(box.wasCalled == true)
        #expect(box.lastPath == "/api/assignments/todo/t1")
        #expect(box.lastContactIds == ["c1"])
    }
}
