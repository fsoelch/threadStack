import Testing
import Foundation
@testable import ThreadStack

//  Paket P6: Entscheidungslogik des Offline-Gatings der Feature-Views B
//  (Archiv, Digest, Momentum, Admin, KI, Wissen, Kontakte, Themen, Stack).

@MainActor @Suite(.serialized)
struct OfflineFeatureViewsBLogicTests {
    typealias L = OfflineFeatureBLogic

    // MARK: S1 - nie geladene Bereiche

    @Test func offlineWithoutContentShowsUnavailable() {
        #expect(L.showsUnavailable(isOffline: true, hasContent: false, loadFailedWithTransport: false))
    }

    @Test func onlineEmptyDataIsNormalEmptyState() {
        #expect(!L.showsUnavailable(isOffline: false, hasContent: false, loadFailedWithTransport: false))
    }

    @Test func offlineWithContentKeepsContent() {
        #expect(!L.showsUnavailable(isOffline: true, hasContent: true, loadFailedWithTransport: false))
    }

    @Test func transportFailureWithoutContentShowsUnavailableEvenBeforeStatusFlips() {
        #expect(L.showsUnavailable(isOffline: false, hasContent: false, loadFailedWithTransport: true))
        #expect(!L.showsUnavailable(isOffline: false, hasContent: true, loadFailedWithTransport: true))
    }

    @Test func snapshotListsShowPlaceholderOnlyWhenNeverLoaded() {
        let now = Date()
        // offline, leer, nie geladen -> Platzhalter
        #expect(L.showsUnavailableForList(isOffline: true, isEmpty: true, dataAsOf: nil))
        // offline, leer, aber Stand vorhanden (echt leere Liste) -> Leerzustand
        #expect(!L.showsUnavailableForList(isOffline: true, isEmpty: true, dataAsOf: now))
        // online leer -> Leerzustand
        #expect(!L.showsUnavailableForList(isOffline: false, isEmpty: true, dataAsOf: nil))
        // nicht leer -> Inhalt
        #expect(!L.showsUnavailableForList(isOffline: true, isEmpty: false, dataAsOf: nil))
    }

    // MARK: S11 - deaktivierte Aktionen, Wiederverbindung

    @Test func actionsDisabledOfflineAndWhileBusy() {
        #expect(L.isActionDisabled(isOffline: true))
        #expect(L.isActionDisabled(isOffline: false, isBusy: true))
        #expect(!L.isActionDisabled(isOffline: false, isBusy: false))
    }

    @Test func saveGating() {
        #expect(!L.canSave(isOffline: true, inputValid: true, isBusy: false))
        #expect(!L.canSave(isOffline: false, inputValid: false, isBusy: false))
        #expect(!L.canSave(isOffline: false, inputValid: true, isBusy: true))
        #expect(L.canSave(isOffline: false, inputValid: true, isBusy: false))
    }

    @Test func reconnectReloadsOnlyWhenNothingLoadedYet() {
        #expect(L.shouldReloadAfterConnectivityChange(wasOffline: true, isOffline: false, hasContent: false))
        #expect(!L.shouldReloadAfterConnectivityChange(wasOffline: true, isOffline: false, hasContent: true))
        #expect(!L.shouldReloadAfterConnectivityChange(wasOffline: false, isOffline: true, hasContent: false))
        #expect(!L.shouldReloadAfterConnectivityChange(wasOffline: false, isOffline: false, hasContent: false))
    }

    @Test func requestsAreSkippedOffline() {
        #expect(!L.shouldPerformRequest(isOffline: true))
        #expect(L.shouldPerformRequest(isOffline: false))
    }

    // MARK: Fehlermeldungen

    @Test func transportErrorsMapToUxWording() {
        let msg = L.message(for: APIError.network, fallback: "x")
        #expect(msg == L.blockedDialogMessage)
        #expect(L.message(for: URLError(.notConnectedToInternet), fallback: "x") == L.blockedDialogMessage)
    }

    @Test func nonTransportErrorsKeepFallback() {
        #expect(L.message(for: APIError.unauthorized, fallback: "fallback") == "fallback")
    }

    @Test func uxWordingMatchesSpecification() {
        #expect(L.blockedToast == "Offline nicht verfügbar")
        #expect(L.blockedDialogMessage ==
                "Keine Verbindung – dein Inhalt bleibt im Dialog erhalten. Bitte versuche es erneut, sobald du wieder online bist.")
        #expect(L.aiUnavailableReason.explanation.contains("KI-Funktionen"))
    }
}
