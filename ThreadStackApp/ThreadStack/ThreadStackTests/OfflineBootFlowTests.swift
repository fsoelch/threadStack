import Testing
import Foundation
@testable import ThreadStack

//  Paket P7: Boot-Ablauf (AppState.bootstrap / unlockAndAutoLogin), Kaltstart offline, Lock-Screen offline,
//  Login-Hinweis ohne Netz, Wiederverbindung ohne Neustart, Nutzerwechsel/erneute Anmeldung (Story 2, 10, 12).

@MainActor
private func prepareStoredSession(biometric: Bool, pendingTodo: String? = nil) async throws -> P7Rig {
    let first = try P7Rig()
    first.serverTodos = [OfflineTestSupport.serverTodo("s1", title: "Server-Todo")]
    first.state.hasStoredCredentials = biometric
    try first.coordinator.activate(user: P7Rig.user, serverURL: "https://\(first.host)", biometricProtected: biometric)
    await first.coordinator.refresh(.manual)   // schreibt den Snapshot
    if let title = pendingTodo {
        first.goOffline()
        _ = try await first.state.createTodoReturning(title: title, description: "")
    }
    return first
}

@MainActor @Suite(.serialized)
struct OfflineBootFlowTests {
    typealias T = OfflineTestSupport

    // MARK: Online

    @Test func validSessionActivatesAndRunsColdStartRefresh() async throws {
        let r = try P7Rig(activate: false)
        r.serverTodos = [T.serverTodo("s1")]
        let route = await r.state.bootstrap()
        #expect(route == .online)
        #expect(r.state.currentUser == P7Rig.user && !r.state.isLocked)
        #expect(r.state.todos.map(\.id) == ["s1"] && r.state.meetings.count == 1)
        #expect(!r.status.isOffline && r.status.dataAsOf != nil && !r.status.isShowingCachedData)
        #expect(r.coordinator.activeScope == r.scope)
        #expect(r.snapshots.loadMarker()?.user == P7Rig.user)
        #expect(r.snapshots.loadSnapshot(scope: r.scope) != nil)
        #expect(r.state.hasCompletedInitialLoad)
    }

    @Test func noSessionWithoutCredentialsShowsLoginWithoutOfflineHint() async throws {
        let r = try P7Rig(activate: false)
        r.override = { _ in .json(401, ["error": "Nicht angemeldet"]) }
        r.state.hasStoredCredentials = false
        #expect(await r.state.bootstrap() == .login)
        #expect(r.state.currentUser == nil && r.state.loginNotice == nil && !r.state.isLocked)
    }

    @Test func noSessionWithCredentialsShowsLockScreen() async throws {
        let r = try P7Rig(activate: false)
        r.override = { _ in .json(401, ["error": "Nicht angemeldet"]) }
        r.state.hasStoredCredentials = true
        #expect(await r.state.bootstrap() == .lock)
        #expect(r.state.isLocked && r.state.lockNotice == nil && !r.state.bootedOffline)
    }

    // MARK: Kaltstart offline

    @Test func offlineColdStartWithMarkerAndSnapshotOpensStoredStateImmediately() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Offline-Idee")
        let r = try P7Rig(activate: false, reusing: first)
        r.pathOK = false   // Flugmodus: Probe entfaellt
        let started = Date()
        let route = await r.state.bootstrap()
        #expect(route == .offline)
        #expect(Date().timeIntervalSince(started) < 3)
        #expect(r.server.requests.isEmpty)   // kein Netzzugriff
        #expect(r.state.currentUser == P7Rig.user && !r.state.isLocked)
        #expect(r.status.isOffline && r.status.isShowingCachedData && r.status.dataAsOf != nil)
        #expect(r.state.todos.contains { $0.id == "s1" })
        // Ausstehender Eintrag ueberlebt den Neustart und liegt ueber dem Snapshot.
        #expect(r.state.todos.contains { $0.title == "Offline-Idee" && OfflineIds.isLocal($0.id) })
        #expect(r.status.unsyncedCount == 1)
        #expect(r.state.bootedOffline)
    }

    @Test func serverUnreachableBehavesLikeNoPath() async throws {
        let first = try await prepareStoredSession(biometric: false)
        let r = try P7Rig(activate: false, reusing: first)
        r.failTransport = true
        #expect(await r.state.bootstrap() == .offline)
        #expect(r.status.connection == .offline(.serverUnreachable))
    }

    @Test func captivePortalResponseCountsAsUnreachable() async throws {
        let first = try await prepareStoredSession(biometric: false)
        let r = try P7Rig(activate: false, reusing: first)
        r.override = { _ in .text(200, "<html>Willkommen im WLAN</html>") }
        #expect(await r.state.bootstrap() == .offline)
        #expect(r.state.currentUser == P7Rig.user)
    }

    @Test func markerOfAnotherServerIsIgnored() async throws {
        let first = try await prepareStoredSession(biometric: false)
        let r = try P7Rig(activate: false, reusing: first)
        r.state.serverURL = "https://other-server.invalid"
        r.pathOK = false
        #expect(await r.state.bootstrap() == .login)
        #expect(r.state.currentUser == nil)
        #expect(r.state.loginNotice == "Keine Verbindung – Anmeldung erst mit Netz möglich.")
    }

    @Test func biometricMarkerOffersLockScreenWithOfflineHint() async throws {
        let first = try await prepareStoredSession(biometric: true)
        let r = try P7Rig(activate: false, reusing: first)
        r.state.hasStoredCredentials = true
        r.pathOK = false
        #expect(await r.state.bootstrap() == .lock)
        #expect(r.state.isLocked && r.state.currentUser == nil)   // noch nichts offen
        #expect(r.state.lockNotice == "Offline – du kannst auf deinen letzten Stand zugreifen.")
        #expect(r.state.todos.isEmpty)
    }

    @Test func biometricMarkerWithForgottenCredentialsDoesNotOpenOffline() async throws {
        let first = try await prepareStoredSession(biometric: true)
        let r = try P7Rig(activate: false, reusing: first)
        r.state.hasStoredCredentials = false
        r.pathOK = false
        #expect(await r.state.bootstrap() == .login)
        #expect(r.state.currentUser == nil && r.state.todos.isEmpty && !r.status.isShowingCachedData)
        #expect(r.state.loginNotice == OfflineError.offlineLoginUnavailable.errorDescription)
    }

    @Test func neverLoggedInOfflineShowsLoginHint() async throws {
        let r = try P7Rig(activate: false)
        r.pathOK = false
        r.state.hasStoredCredentials = false
        #expect(await r.state.bootstrap() == .login)
        #expect(r.state.loginNotice == "Keine Verbindung – Anmeldung erst mit Netz möglich.")
    }

    @Test func credentialsWithoutLocalStateLeadToLockThatEndsWithOfflineLoginUnavailable() async throws {
        let r = try P7Rig(activate: false)
        r.pathOK = false
        r.state.hasStoredCredentials = true
        #expect(await r.state.bootstrap() == .lock)
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "pw") }
        await #expect(throws: OfflineError.offlineLoginUnavailable) { try await r.state.unlockAndAutoLogin() }
        #expect(r.state.isLocked && r.state.currentUser == nil && r.state.offlineUnlockCredentials == nil)
    }

    // MARK: Entsperren

    @Test func unlockOfflineOpensLocalStateAndKeepsCredentialsOnlyInMemory() async throws {
        let first = try await prepareStoredSession(biometric: true)
        let r = try P7Rig(activate: false, reusing: first)
        r.state.hasStoredCredentials = true
        r.pathOK = false
        #expect(await r.state.bootstrap() == .lock)
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "pw") }
        let outcome = try await r.state.unlockAndAutoLogin()
        #expect(outcome == .offline && !r.state.isLocked)
        #expect(r.state.currentUser == P7Rig.user && r.state.lockNotice == nil)
        #expect(r.state.offlineUnlockCredentials?.username == "anna")
        #expect(r.status.isOffline && r.state.todos.contains { $0.id == "s1" })
    }

    @Test func unlockOfflineThenReconnectBuildsSessionWithoutSecondBiometricPrompt() async throws {
        let first = try await prepareStoredSession(biometric: true, pendingTodo: "Aus dem Flugzeug")
        let r = try P7Rig(activate: false, reusing: first)
        r.state.hasStoredCredentials = true
        r.pathOK = false
        _ = await r.state.bootstrap()
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "pw") }
        try await r.state.unlockAndAutoLogin()

        // Verbindung kehrt zurueck, es gibt aber noch keine Serversitzung (401): Renewal ueber den Speicher.
        var sessionActive = false
        r.override = { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/login") { sessionActive = true; return .json(200, rigEncode(P7Rig.user)) }
            if !sessionActive { return .json(401, ["error": "Nicht angemeldet"]) }
            return nil
        }
        r.pathOK = true
        r.state.credentialLoader = { _ in throw KeychainError.userCancelled }   // darf nicht aufgerufen werden
        await r.coordinator.refresh(.reconnect)
        #expect(!r.status.isOffline)
        #expect(r.server.count(method: "POST", pathPrefix: "/login") == 1)
        #expect(r.server.count(method: "POST", pathPrefix: "/todos") == 1)   // Warteschlange uebertragen
        #expect(r.state.offlineUnlockCredentials == nil)
        #expect(r.status.items.isEmpty)
    }

    @Test func unlockOnlineWithValidCookieSkipsLogin() async throws {
        let r = try P7Rig(activate: false)
        r.state.hasStoredCredentials = true
        r.state.isLocked = true
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "pw") }
        let outcome = try await r.state.unlockAndAutoLogin()
        #expect(outcome == .online && !r.state.isLocked && r.state.currentUser == P7Rig.user)
        #expect(r.server.count(method: "POST", pathPrefix: "/login") == 0)
        #expect(r.state.offlineUnlockCredentials == nil)
    }

    @Test func unlockWithExpiredSessionLogsIn() async throws {
        let r = try P7Rig(activate: false)
        r.state.hasStoredCredentials = true
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "pw") }
        r.override = { req in req.url?.path.hasSuffix("/me") == true ? .json(401, ["error": "x"]) : nil }
        let outcome = try await r.state.unlockAndAutoLogin()
        #expect(outcome == .online && r.server.count(method: "POST", pathPrefix: "/login") == 1)
        #expect(r.state.currentUser == P7Rig.user)
    }

    @Test func connectionLostBetweenProbeAndLoginFallsBackToOfflinePath() async throws {
        let first = try await prepareStoredSession(biometric: true)
        let r = try P7Rig(activate: false, reusing: first)
        r.state.hasStoredCredentials = true
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "pw") }
        r.override = { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/me") { return .json(401, ["error": "x"]) }
            if path.hasSuffix("/login") { return .fail(.networkConnectionLost) }
            return nil
        }
        let outcome = try await r.state.unlockAndAutoLogin()
        #expect(outcome == .offline && r.state.currentUser == P7Rig.user)
    }

    @Test func wrongPasswordIsNotTreatedAsOffline() async throws {
        let r = try P7Rig(activate: false)
        r.state.hasStoredCredentials = true
        r.state.credentialLoader = { _ in StoredCredentials(username: "anna", password: "falsch") }
        r.override = { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/me") { return .json(401, ["error": "x"]) }
            if path.hasSuffix("/login") { return .json(401, ["error": "Falsche Zugangsdaten"]) }
            return nil
        }
        await #expect(throws: APIError.self) { try await r.state.unlockAndAutoLogin() }
        #expect(r.state.currentUser == nil)
    }

    // MARK: Wiederverbindung ohne Neustart

    @Test func offlineStartThenReconnectSyncsAndRefreshesWithoutRestart() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Spaeter senden")
        let r = try P7Rig(activate: false, reusing: first)
        r.serverTodos = [OfflineTestSupport.serverTodo("s1", title: "Server-Todo")]
        r.failTransport = true
        #expect(await r.state.bootstrap() == .offline)
        #expect(r.status.unsyncedCount == 1)

        r.failTransport = false
        r.serverTodos = [OfflineTestSupport.serverTodo("s1", title: "Server-Todo"),
                         OfflineTestSupport.serverTodo("srv-t1", title: "Spaeter senden")]
        await r.coordinator.refresh(.reconnect)
        #expect(!r.status.isOffline && r.status.items.isEmpty && !r.status.isShowingCachedData)
        #expect(r.state.todos.filter { $0.title == "Spaeter senden" }.map(\.id) == ["srv-t1"])
    }

    @Test func reconnectWithoutCredentialsRequestsReauthSheet() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Wartet")
        let r = try P7Rig(activate: false, reusing: first)
        r.pathOK = false
        _ = await r.state.bootstrap()
        r.state.hasStoredCredentials = false
        r.pathOK = true
        r.override = { _ in .json(401, ["error": "Nicht angemeldet"]) }
        await r.coordinator.refresh(.reconnect)
        #expect(r.status.activity == .paused(.needsReauth))
        #expect(r.status.unsyncedCount == 1)   // nichts geht verloren
        #expect(!r.state.reauthRequested)
        r.status.intents.requestReauth()
        #expect(r.state.reauthRequested)
    }

    // MARK: Nutzerwechsel / erneute Anmeldung

    @Test func loginOfSameUserKeepsPendingChanges() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Bleibt")
        let r = try P7Rig(activate: false, reusing: first)
        try await r.state.login(username: "anna", password: "pw")
        #expect(r.state.currentUser == P7Rig.user && r.status.unsyncedCount == 1)
        #expect(r.snapshots.loadMarker()?.user == P7Rig.user)
    }

    @Test func loginOfOtherUserWithPendingChangesIsHeldBackUntilConfirmed() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Gehoert Anna")
        let r = try P7Rig(activate: false, reusing: first)
        r.loggedInUser = AppUser(id: "u2", username: "bob", role: "user")
        r.pathOK = false
        _ = await r.state.bootstrap()      // Anna offline offen
        r.pathOK = true
        let oldMarker = r.snapshots.loadMarker()

        await #expect(throws: OfflineError.scopeMismatch) {
            try await r.state.login(username: "bob", password: "pw")
        }
        // Nichts wurde uebernommen, nichts geloescht; die fremde Serversitzung wurde beendet.
        #expect(r.state.currentUser == P7Rig.user)
        #expect(r.snapshots.loadMarker() == oldMarker)
        #expect(r.status.unsyncedCount == 1)
        #expect(r.server.count(method: "POST", pathPrefix: "/logout") == 1)

        // Bestaetigt: alter Bestand wird verworfen, Bob bekommt einen eigenen, leeren Scope.
        try await r.state.login(username: "bob", password: "pw", discardPreviousOfflineScope: true)
        #expect(r.state.currentUser?.id == "u2")
        #expect(r.snapshots.loadMarker()?.user.id == "u2")
        #expect(r.status.unsyncedCount == 0)
        #expect(r.coordinator.activeScope?.userId == "u2")
        let oldScope = OfflineScope(serverURL: r.scope.serverURL, userId: "u1")
        #expect(r.snapshots.loadSnapshot(scope: oldScope) == nil)
    }

    @Test func loginOfOtherUserWithoutPendingChangesReplacesScopeSilently() async throws {
        let first = try await prepareStoredSession(biometric: false)
        let r = try P7Rig(activate: false, reusing: first)
        r.loggedInUser = AppUser(id: "u2", username: "bob", role: "user")
        try await r.state.login(username: "bob", password: "pw")
        #expect(r.state.currentUser?.id == "u2" && r.snapshots.loadMarker()?.user.id == "u2")
        #expect(r.snapshots.loadSnapshot(scope: OfflineScope(serverURL: r.scope.serverURL, userId: "u1")) == nil)
    }

    @Test func coldStartWithSessionOfOtherUserNeverMixesData() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Annas Idee")
        let r = try P7Rig(activate: false, reusing: first)
        r.loggedInUser = AppUser(id: "u2", username: "bob", role: "user")
        #expect(await r.state.bootstrap() == .online)
        #expect(r.state.currentUser?.id == "u2")
        // Annas Warteschlange ist fuer Bob unsichtbar und wird nicht uebertragen.
        #expect(r.status.items.isEmpty)
        #expect(!r.state.todos.contains { $0.title == "Annas Idee" })
        #expect(r.server.count(method: "POST", pathPrefix: "/todos") == 0)
    }

    @Test func refreshAfterReauthClosesSheetAndSyncs() async throws {
        let first = try await prepareStoredSession(biometric: false, pendingTodo: "Nach Anmeldung")
        let r = try P7Rig(activate: false, reusing: first)
        r.state.currentUser = P7Rig.user
        try r.coordinator.activate(user: P7Rig.user, serverURL: "https://\(r.host)", biometricProtected: false)
        r.state.reauthRequested = true
        await r.state.refreshAfterReauth()
        #expect(!r.state.reauthRequested)
        #expect(r.server.count(method: "POST", pathPrefix: "/todos") == 1)
        #expect(r.status.items.isEmpty)
    }

    // MARK: Texte

    @Test func loginMessageMapsTransportErrorsToOfflineHint() {
        #expect(LoginOfflineTexts.message(for: APIError.network) == "Keine Verbindung – Anmeldung erst mit Netz möglich.")
        #expect(LoginOfflineTexts.message(for: URLError(.notConnectedToInternet)) == "Keine Verbindung – Anmeldung erst mit Netz möglich.")
        #expect(LoginOfflineTexts.message(for: APIError.server("Falsche Zugangsdaten")) == "Falsche Zugangsdaten")
        #expect(LoginOfflineTexts.pendingText(1) == "1 Änderung wartet auf die Übertragung.")
        #expect(LoginOfflineTexts.pendingText(3) == "3 Änderungen warten auf die Übertragung.")
    }
}
