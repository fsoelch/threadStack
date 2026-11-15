import Testing
import Foundation
@testable import ThreadStack

//  Paket P2: UI-Bausteine (reine Logik: Badge, Stand-Anzeige, Platzhaltertexte).

@MainActor @Suite(.serialized)
struct OfflineUIComponentsTests {
    typealias T = OfflineTestSupport

    // MARK: Badge / Stand-Anzeige / Platzhalter

    @Test func badgeVariantsTextsAndIcons() {
        #expect(PendingSyncBadgeLogic.text(for: .pending) == "Nicht synchronisiert")
        #expect(PendingSyncBadgeLogic.text(for: .syncing) == "Wird synchronisiert")
        #expect(PendingSyncBadgeLogic.text(for: .failed) == "Fehlgeschlagen")
        #expect(PendingSyncBadgeLogic.text(for: .blocked) == "Wartet")
        #expect(PendingSyncBadgeLogic.iconName(for: .pending) == "icloud.slash")
        #expect(PendingSyncBadgeLogic.iconName(for: .syncing) == "arrow.triangle.2.circlepath")
        #expect(PendingSyncBadgeLogic.iconName(for: .failed) == "exclamationmark.triangle")
        #expect(PendingSyncBadgeLogic.iconName(for: .blocked) == "clock")
        #expect(PendingSyncBadgeLogic.kind(for: .failed(message: "x")) == .failed)
        #expect(PendingSyncBadgeLogic.kind(for: .blocked(message: "x")) == .blocked)
        #expect(PendingSyncBadgeLogic.accessibilityLabel(for: .pending, itemDescription: "Todo 'Titel'")
                == "Todo 'Titel', nicht synchronisiert")
        #expect(PendingSyncBadgeLogic.accessibilityLabel(for: .pending, itemDescription: nil) == "Nicht synchronisiert")
    }

    @Test func dataAsOfFormatting() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Date {
            cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
        }
        let now = date(2026, 11, 15, 18, 0)
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 11, 15, 14, 32), now: now, calendar: cal) == "heute, 14:32")
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 11, 14, 9, 5), now: now, calendar: cal) == "gestern, 09:05")
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 11, 13, 14, 32), now: now, calendar: cal) == "13.11., 14:32")
        #expect(OfflineDataAsOfFormatter.string(for: date(2025, 11, 15, 14, 32), now: now, calendar: cal) == "15.11.2025, 14:32")
        // Monats-/Jahresgrenze fuer "gestern".
        let newYear = date(2027, 1, 1, 8, 0)
        #expect(OfflineDataAsOfFormatter.string(for: date(2026, 12, 31, 23, 59), now: newYear, calendar: cal) == "gestern, 23:59")
        #expect(OfflineDataAsOfFormatter.label(for: date(2026, 11, 13, 14, 32), now: now, calendar: cal) == "Stand vom 13.11., 14:32")
        #expect(OfflineDataAsOfFormatter.label(for: date(2026, 11, 15, 14, 32), now: now, calendar: cal) == "Stand: heute, 14:32")
        #expect(OfflineDataAsOfFormatter.label(for: nil, now: now, calendar: cal) == "Noch kein Stand geladen")
    }

    @Test func unavailableViewTexts() {
        #expect(OfflineTexts.unavailableTitle == "Offline nicht verfügbar")
        #expect(OfflineUnavailableReason.notLoadedYet.explanation ==
                "Dieser Inhalt wurde noch nicht geladen. Er ist verfügbar, sobald du wieder online bist.")
        #expect(OfflineUnavailableReason.custom("x").explanation == "x")
        #expect(OfflineTexts.retry == "Erneut versuchen")
    }
}
