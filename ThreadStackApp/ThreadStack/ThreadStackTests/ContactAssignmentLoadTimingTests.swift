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
//  `makeMockAppState`/`mockJSONData`/`requestBodyJSON`/`HandlerCallBox`: siehe
//  `TestNetworkHelpers.swift` (Fund 3, Code-Review — zuvor hier UND in
//  `ContactAPITests.swift` wörtlich dupliziert und bereits auseinander-
//  gelaufen; jetzt EINE gemeinsame Implementierung).
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - 1. `loadAssignedContactIds` unterscheidet Erfolg/Fehlschlag

@MainActor
struct LoadAssignedContactIdsTests {

    @Test func returnsEmptySuccessImmediatelyInCreateModeWithoutRefId() async {
        // Anlegen-Modus: kein `refId` -> kein Netzwerk-Request nötig, sofort
        // ein erfolgreiches, leeres Ergebnis (nichts zu laden, nichts zu
        // verlieren).
        let state = makeMockAppState { _ in
            Issue.record("kein Request im Anlegen-Modus erwartet")
            return (500, Data())
        }
        let result = await loadAssignedContactIds(state: state, refType: "todo", refId: nil)
        #expect(result == .success([]))
    }

    @Test func returnsSuccessWithLoadedContactIds() async {
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/assignments/todo/t1")
            return (200, mockJSONData([
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
        let state = makeMockAppState { _ in (500, mockJSONData(["error": "Interner Fehler"])) }
        let result = await loadAssignedContactIds(state: state, refType: "todo", refId: "t1")
        guard case .failure(let message) = result else {
            Issue.record("expected .failure for a server error")
            return
        }
        #expect(!message.contains("Verbindung"))
    }
}

// MARK: - 2. `ContactAssignmentPickerLogic.shouldCommitAssignments`: reine Entscheidungslogik
//
// Niedrig-Fund (Code-Review): die Signatur wurde von
// `shouldCommitAssignments(savedId:assignmentsLoaded:)` auf
// `shouldCommitAssignments(assignmentsLoaded:)` vereinfacht — der
// `savedId`-Parameter war redundant, da jede Aufrufstelle (`TodoFormView`/
// `TopicFormView.save()`) ohnehin zusätzlich per `let savedId` prüft/
// entpackt. Der `savedId`-Aspekt bleibt also weiterhin abgesichert, nur eben
// nicht mehr innerhalb dieser Funktion.

struct ShouldCommitAssignmentsTests {

    @Test func commitsWhenLoadedSuccessfully() {
        #expect(ContactAssignmentPickerLogic.shouldCommitAssignments(assignmentsLoaded: true) == true)
    }

    /// Kernfall des Blockers: das Laden ist fehlgeschlagen ODER (durch das
    /// Timing-Problem) nie abgeschlossen -> `assignmentsLoaded` bleibt
    /// `false` -> niemals committen, selbst wenn das Speichern des Todos/
    /// Themas selbst erfolgreich war.
    @Test func neverCommitsWhenNotLoaded() {
        #expect(ContactAssignmentPickerLogic.shouldCommitAssignments(assignmentsLoaded: false) == false)
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
        if ContactAssignmentPickerLogic.shouldCommitAssignments(assignmentsLoaded: assignmentsLoaded) {
            _ = try await state.setAssignments(refType: refType, refId: savedId, contactIds: Array(contactIdsToCommit))
        }
    }

    /// Fund 2 (Code-Review): `loadAssignments` (GET) und `setAssignments`
    /// (PUT) laufen über denselben Pfad `/api/assignments/todo/t1` — eine
    /// reine `lastPath`-Prüfung würde daher schon durch den (erwarteten)
    /// fehlgeschlagenen GET erfüllt, OHNE dass ein fälschlich zusätzlich
    /// abgesetzter PUT das aufdecken würde. `callCount`/`methods` machen die
    /// tatsächliche Anzahl UND Art der Requests beobachtbar.
    @Test func failedLoadNeverTriggersASetAssignmentsRequest() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.record(req)
            return (500, mockJSONData(["error": "Interner Fehler"]))
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
        // 3. Der einzige Request, der beim `makeMockAppState`-Handler ankam, war
        //    der (fehlgeschlagene) Ladeversuch selbst (GET) — KEIN
        //    zusätzlicher `PUT /api/assignments/todo/t1`-Request mit der
        //    leeren Auswahl. Ein fälschlich abgesetzter PUT würde
        //    `callCount == 1` UND `!methods.contains("PUT")` beide brechen.
        #expect(box.wasCalled == true) // vom Ladeversuch, nicht vom Commit
        #expect(box.lastPath == "/api/assignments/todo/t1")
        #expect(box.callCount == 1)
        #expect(!box.methods.contains("PUT"))
    }

    /// Timing-Regression selbst (Kern des Blockers): das Laden wurde
    /// überhaupt nicht ausgeführt (z.B. weil das `.task` nie lief, exakt der
    /// ursprüngliche Bug) — `assignmentsLoaded` bleibt bei seinem
    /// Startwert `false`, ganz ohne dass überhaupt ein Ladeversuch
    /// stattgefunden hat.
    @Test func neverAttemptedLoadNeverTriggersASetAssignmentsRequestEvenWithStaleEmptySelection() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.record(req)
            box.lastContactIds = requestBodyJSON(req)["contactIds"] as? [String]
            return (200, mockJSONData([]))
        }
        // Kein Aufruf von `loadAssignedContactIds` -- exakt das Timing-Bug-
        // Szenario, in dem das `.task` (an der falschen Stelle hängend)
        // niemals lief.
        try await runSaveFlow(
            state: state, savedId: "t1", refType: "todo",
            assignmentsLoaded: false, contactIdsToCommit: []
        )
        #expect(box.wasCalled == false)
        #expect(box.callCount == 0)
        #expect(!box.methods.contains("PUT"))
    }

    /// Gegenprobe (kein falsches Positiv durch den Fix): erfolgreiches Laden
    /// erlaubt weiterhin den regulären Commit-Pfad mit der tatsächlich
    /// ausgewählten Menge.
    @Test func successfulLoadStillAllowsCommitWithActualSelection() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.record(req)
            box.lastContactIds = requestBodyJSON(req)["contactIds"] as? [String]
            return (200, mockJSONData([
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
        #expect(box.callCount == 1)
        #expect(box.methods == ["PUT"])
    }
}

// MARK: - 4. Zweiter Blocker-Fund (Review "Ja mit Auflagen"): Picker-"Fertig"
// umging den Guard bislang trotzdem
//
// Deckt exakt die drei im Review benannten Abläufe ab, die trotz Fund 1
// (`shouldCommitAssignments`) noch zum selben Datenverlust führten, weil der
// Auswahl-Button NIE gesperrt war und `onDone` bedingungslos `loaded = true`
// setzte:
//   (a) Laden schlägt fehl, Nutzer tippt trotzdem "Fertig" ohne Änderung.
//   (b) Laden läuft noch (langsame Verbindung), Nutzer tippt sofort "Fertig".
//   (c) Laden kommt NACH einer bereits bestätigten Auswahl zurück und würde
//       diese sonst kommentarlos überschreiben.
struct ContactAssignmentPickerEntryGuardTests {

    // -- (a) + (b): der Auswahl-Button ist gesperrt, solange die bestehende
    // Zuordnung im Bearbeiten-Modus noch nicht bekannt ist — unabhängig
    // davon, OB das Laden fehlgeschlagen ist (a) oder einfach nur noch läuft
    // (b). Beides drückt sich im selben Zustand aus: `loaded == false`.

    @Test func editModeEntryIsDisabledWhileLoadIsInFlightOrFailed() {
        // (b) Laden noch unterwegs -> `loaded` weiterhin `false`.
        #expect(ContactAssignmentPickerLogic.isPickerEntryDisabled(refId: "todo-1", loaded: false) == true)
        // (a) Laden fehlgeschlagen -> `loaded` bleibt ebenfalls `false`
        // (siehe `loadContactAssignments()`: nur der `.success`-Zweig setzt
        // `assignmentsLoaded = true`).
        #expect(ContactAssignmentPickerLogic.isPickerEntryDisabled(refId: "todo-1", loaded: false) == true)
    }

    @Test func editModeEntryIsEnabledOnceLoadedSuccessfully() {
        #expect(ContactAssignmentPickerLogic.isPickerEntryDisabled(refId: "todo-1", loaded: true) == false)
    }

    /// Anlegen-Modus (`refId == nil`): bleibt nutzbar, da `loaded` dort
    /// sofort über `.success([])` `true` wird — keine Regression durch den
    /// neuen Guard.
    @Test func createModeEntryStaysEnabledRegardlessOfLoadedFlag() {
        #expect(ContactAssignmentPickerLogic.isPickerEntryDisabled(refId: nil, loaded: false) == false)
        #expect(ContactAssignmentPickerLogic.isPickerEntryDisabled(refId: nil, loaded: true) == false)
    }

    // -- (c) Race: eine (ggf. verspätet zurückkommende) erfolgreiche
    // Ladeantwort darf eine bereits vom Nutzer im Picker bestätigte Auswahl
    // nicht überschreiben.

    @Test func loadedSelectionIsNotAppliedAfterUserConfirmedAPickerSelection() {
        #expect(ContactAssignmentPickerLogic.shouldApplyLoadedSelection(userConfirmedSelection: true) == false)
    }

    @Test func loadedSelectionIsAppliedWhenUserHasNotConfirmedYet() {
        #expect(ContactAssignmentPickerLogic.shouldApplyLoadedSelection(userConfirmedSelection: false) == true)
    }

    /// End-to-End-Nachbildung von Fall (c) über den tatsächlichen
    /// `loadContactAssignments()`-Ablauf (`.success`-Zweig aus
    /// `TodoFormView`/`TopicFormView`): erst bestätigt der Nutzer im Picker
    /// eine neue Auswahl (`userConfirmedSelection = true`), DANACH kommt ein
    /// (jetzt veralteter) erfolgreicher Ladevorgang zurück — die frische
    /// Auswahl darf nicht verloren gehen.
    @MainActor
    @Test func staleSuccessfulLoadDoesNotOverwriteAlreadyConfirmedSelection() async {
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/assignments/todo/t1")
            return (200, mockJSONData([
                ["contactId": "c-server-stand", "name": "Alt", "role": "", "email": "", "assignedAt": "2026-01-01T00:00:00.000Z"]
            ]))
        }
        // Nachbildung des View-Zustands: Nutzer hat im Picker bereits eine
        // frische Auswahl bestätigt, BEVOR die (spät zurückkommende)
        // Ladeantwort eintrifft.
        var contactIds: Set<String> = ["c-user-selected"]
        let userConfirmedSelection = true

        switch await loadAssignedContactIds(state: state, refType: "todo", refId: "t1") {
        case .success(let ids):
            if ContactAssignmentPickerLogic.shouldApplyLoadedSelection(userConfirmedSelection: userConfirmedSelection) {
                contactIds = ids
            }
        case .failure:
            Issue.record("Testvoraussetzung verletzt: Laden sollte erfolgreich sein")
        }

        #expect(contactIds == ["c-user-selected"])
    }
}
