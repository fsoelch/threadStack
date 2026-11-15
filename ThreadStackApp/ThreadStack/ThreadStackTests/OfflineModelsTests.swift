import Testing
import Foundation
@testable import ThreadStack

//  Paket P2, S-6: Modelle, Texte (UX-Wortlaut), IDs, Scope.

@MainActor @Suite(.serialized)
struct OfflineModelsTests {
    typealias T = OfflineTestSupport

    // MARK: Texte (UX-Wortlaut)

    @Test func failureReasonTextsFollowUXWording() {
        #expect(PendingFailureReason.meetingArchived.userMessage ==
                "Das Meeting wurde inzwischen archiviert. Ordne das Thema einem anderen Meeting zu oder übernimm es als Todo.")
        #expect(PendingFailureReason.meetingGone.userMessage ==
                "Das Meeting existiert nicht mehr. Ordne das Thema einem anderen Meeting zu oder übernimm es als Todo.")
        #expect(PendingFailureReason.refGone.userMessage ==
                "Das zugehörige Vorhaben existiert nicht mehr. Kopiere den Text, falls du ihn behalten willst.")
        #expect(PendingFailureReason.refDone.userMessage ==
                "Das Vorhaben wurde inzwischen erledigt. Kopiere den Text, falls du ihn behalten willst.")
        #expect(PendingFailureReason.validation(message: "Titel zu lang.").userMessage ==
                "Der Server hat den Eintrag abgelehnt: Titel zu lang. Bitte bearbeite den Eintrag und sende ihn erneut.")
        #expect(PendingFailureReason.tokenConflict.userMessage ==
                "Der Eintrag konnte nicht eindeutig zugeordnet werden. Bitte erneut senden.")
        #expect(PendingFailureReason.rejected(message: "Nein").userMessage == "Nein")
        #expect(PendingFailureReason.rejected(message: nil).userMessage == "Der Server hat den Eintrag abgelehnt.")
        #expect(PendingFailureReason.rejected(message: "  ").userMessage == "Der Server hat den Eintrag abgelehnt.")
    }

    @Test func offlineErrorTexts() {
        #expect(OfflineError.pendingNotSynced.errorDescription ==
                "Dieser Eintrag ist noch nicht synchronisiert. Diese Aktion ist erst danach möglich.")
        #expect(OfflineError.notAvailableOffline.errorDescription ==
                "Keine Verbindung – dein Inhalt bleibt im Dialog erhalten. Bitte versuche es erneut, sobald du wieder online bist.")
        #expect(OfflineError.localStorageFailed.errorDescription ==
                "Der Eintrag konnte auf diesem Gerät nicht gespeichert werden. Bitte kopiere den Text und versuche es später erneut.")
        #expect(OfflineError.offlineLoginUnavailable.errorDescription == "Keine Verbindung – Anmeldung erst mit Netz möglich.")
        #expect(OfflineError.scopeMismatch.errorDescription ==
                "Die Änderungen gehören zu einem anderen Konto und werden nicht übertragen.")
        #expect(OfflineError.validation("x").errorDescription == "x")
    }

    // MARK: Modelle

    @Test func scopeNormalizationAndKey() {
        #expect(OfflineScope.normalize(serverURL: "  https://a.test/// ") == "https://a.test")
        #expect(OfflineScope(serverURL: "https://a", userId: "u").key == "https://a\nu")
    }

    @Test func idHelpers() {
        #expect(OfflineIds.isLocal("local-abc") && !OfflineIds.isLocal("abc"))
        #expect(OfflineIds.isSafeServerId("abc_DEF-1"))
        for bad in ["", "local-x", "a b", "a/b", "..", String(repeating: "a", count: 65)] {
            #expect(!OfflineIds.isSafeServerId(bad), "\(bad)")
        }
    }

    @Test func pendingChangeCodableRoundTrip() throws {
        let c = PendingChange(id: UUID(), seq: 7, clientToken: UUID().uuidString, capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123),
                              payload: .progress(T.progress(ref: .local(changeId: UUID()))),
                              state: .failed(.validation(message: "x")), revision: 3, followUp: .update,
                              isTombstone: false, attemptCount: 2, lastAttemptAt: Date(),
                              acknowledgedObject: .topic(meetingId: "m1", T.serverTopic("t1", meeting: "m1")))
        let data = try JSONEncoder().encode(c)
        #expect(try JSONDecoder().decode(PendingChange.self, from: data) == c)
    }
}
