import SwiftUI

//  OfflineStatusBanner.swift
//  Arbeitspaket P4: globale Status-Leiste des Offline-Modus (UX "SyncStatusBar",
//  Konsistenzentscheidung 1). Wird einmal in ContentView eingebunden (P7).
//  Die Leiste liest ausschliesslich den `OfflineStatusStore`; die Textableitung
//  steckt in der reinen, testbaren `OfflineBannerLogic`.

// MARK: - Zaehl- und Textlogik (rein, testbar)

enum OfflineCountText {
    /// "1 Änderung" / "N Änderungen".
    static func changes(_ n: Int) -> String { n == 1 ? "1 Änderung" : "\(n) Änderungen" }

    /// Angabe der Anzahl fuer die Leiste: "N ausstehend".
    static func outstanding(_ n: Int) -> String { "\(n) ausstehend" }

    /// "M fehlgeschlagen".
    static func failed(_ n: Int) -> String { "\(n) fehlgeschlagen" }

    /// "Bitte neu anmelden, um 1 Änderung / N Änderungen zu übertragen."
    static func reauthText(_ n: Int) -> String {
        "Bitte neu anmelden, um \(changes(n)) zu übertragen."
    }

    /// Logout-Warnung (Singular/Plural).
    static func logoutWarning(_ n: Int) -> String {
        n == 1
            ? "1 Änderung ist noch nicht übertragen und geht verloren."
            : "\(n) Änderungen sind noch nicht übertragen und gehen verloren."
    }
}

struct OfflineBannerContent: Equatable {
    var icon: String
    var text: String
    /// Zusatzzeile (caption2), z.B. "Stand vom 15.11., 14:32".
    var detail: String?
    /// Zaehler als Capsule, z.B. "3 ausstehend, 1 fehlgeschlagen".
    var summary: String?
    var showsSpinner: Bool
    /// Warnfarbe (fehlgeschlagen, Speicherproblem, Kontowechsel).
    var isWarning: Bool
    var showsRetry: Bool
    var showsReauthButton: Bool
    /// Tipp auf die Leiste oeffnet die Liste (nur wenn es Eintraege gibt).
    var opensList: Bool
    var accessibilityLabel: String

    /// Aendert sich nur beim Zustandswechsel (Symbol/Spinner/Warnung), nicht bei Fortschrittszaehlern.
    var announcementKey: String { showsSpinner ? "syncing" : icon + (isWarning ? "!" : "") }
}

enum OfflineBannerLogic {
    static let largeBatchThreshold = 50
    static let serverUnsupportedText = "Der Server unterstützt die Übertragung noch nicht. Deine Änderungen bleiben gespeichert."
    static let userMismatchText = OfflineError.scopeMismatch.errorDescription ?? ""
    static let retryLaterText = "Wird später erneut versucht."
    static let openListHint = "Doppeltippen öffnet die Liste der ausstehenden Änderungen."
    static let reauthButtonTitle = "Anmelden"

    /// "Wird synchronisiert … (2 von 5)"; ab 50 Eintraegen "(N verbleibend)".
    static func syncingText(done: Int, total: Int) -> String {
        let t = max(0, total)
        let d = min(max(0, done), t)
        if t >= largeBatchThreshold { return "Wird synchronisiert … (\(t - d) verbleibend)" }
        return "Wird synchronisiert … (\(d) von \(t))"
    }

    private static let monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
                                     "August", "September", "Oktober", "November", "Dezember"]

    /// Sprechbare Zeit fuer VoiceOver: "15. November, 14 Uhr 32" / "heute, 14 Uhr 32".
    static func spokenDate(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let time = "\(c.hour ?? 0) Uhr \(c.minute ?? 0)"
        switch OfflineDataAsOfFormatter.dayKind(for: date, now: now, calendar: calendar) {
        case .today: return "heute, \(time)"
        case .yesterday: return "gestern, \(time)"
        case .other:
            let m = monthNames[max(0, min(11, (c.month ?? 1) - 1))]
            var s = "\(c.day ?? 1). \(m)"
            if c.year != calendar.component(.year, from: now) { s += " \(c.year ?? 0)" }
            return s + ", " + time
        }
    }

    /// "Stand: 15. November, 14 Uhr 32" (VoiceOver).
    static func spokenDataAsOf(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return "Noch kein Stand geladen" }
        // Gleiche dayKind-Weiche wie OfflineDataAsOfFormatter.label ("Stand: heute" / "Stand vom 15. November").
        switch OfflineDataAsOfFormatter.dayKind(for: date, now: now, calendar: calendar) {
        case .today, .yesterday: return "Stand: " + spokenDate(date, now: now, calendar: calendar)
        case .other: return "Stand vom " + spokenDate(date, now: now, calendar: calendar)
        }
    }

    static func summaryText(outstanding: Int, failed: Int) -> String? {
        var parts: [String] = []
        if outstanding > 0 { parts.append(OfflineCountText.outstanding(outstanding)) }
        if failed > 0 { parts.append(OfflineCountText.failed(failed)) }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private static func spokenCounts(outstanding: Int, failed: Int) -> String? {
        var parts: [String] = []
        if outstanding > 0 { parts.append("\(OfflineCountText.changes(outstanding)) ausstehend") }
        if failed > 0 { parts.append("\(OfflineCountText.changes(failed)) fehlgeschlagen") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// `nil` = Leiste unsichtbar (online und nichts zu melden).
    static func content(connection: OfflineConnectionState,
                        activity: OfflineSyncActivity,
                        dataAsOf: Date?,
                        unsyncedCount: Int,
                        failedCount: Int,
                        storageProblemMessage: String? = nil,
                        now: Date = Date(),
                        calendar: Calendar = .current) -> OfflineBannerContent? {
        let failed = max(0, failedCount)
        let unsynced = max(unsyncedCount, failed)
        let outstanding = unsynced - failed
        let summary = summaryText(outstanding: outstanding, failed: failed)
        let opensList = unsynced > 0
        let isOffline = connection != .online

        func make(icon: String, text: String, detail: String? = nil, summary: String? = nil,
                  spinner: Bool = false, warning: Bool = false, retry: Bool = false, reauth: Bool = false,
                  spoken: String) -> OfflineBannerContent {
            OfflineBannerContent(icon: icon, text: text, detail: detail, summary: summary, showsSpinner: spinner,
                                 isWarning: warning, showsRetry: retry, showsReauthButton: reauth,
                                 opensList: opensList, accessibilityLabel: spoken)
        }

        if case .paused(let reason) = activity {
            switch reason {
            case .storageProblem:
                let t = storageProblemMessage ?? (OfflineError.localStorageFailed.errorDescription ?? "")
                return make(icon: "externaldrive.badge.exclamationmark", text: t, warning: true, spoken: t)
            case .needsReauth where outstanding > 0:
                let t = OfflineCountText.reauthText(outstanding)
                return make(icon: "person.crop.circle.badge.exclamationmark", text: t, warning: true,
                            reauth: true, spoken: t)
            case .needsReauth:
                break
            case .userMismatch:
                return make(icon: "person.crop.circle.badge.exclamationmark", text: userMismatchText,
                            warning: true, spoken: userMismatchText)
            case .serverUnsupported:
                return make(icon: "exclamationmark.triangle", text: serverUnsupportedText,
                            warning: true, spoken: serverUnsupportedText)
            }
        }

        if case .syncing(let done, let total) = activity {
            let t = syncingText(done: done, total: total)
            return make(icon: "arrow.triangle.2.circlepath", text: t, spinner: true, spoken: t)
        }

        if isOffline {
            let asOf = OfflineDataAsOfFormatter.label(for: dataAsOf, now: now, calendar: calendar)
            var spoken = "Offline. \(spokenDataAsOf(dataAsOf, now: now, calendar: calendar))."
            if let c = spokenCounts(outstanding: outstanding, failed: failed) { spoken += " \(c)." }
            return make(icon: "wifi.slash", text: "Offline", detail: asOf, summary: summary,
                        warning: failed > 0, retry: true, spoken: spoken)
        }

        if failed > 0 {
            var spoken = "\(OfflineCountText.changes(failed)) fehlgeschlagen."
            if outstanding > 0 { spoken += " \(OfflineCountText.changes(outstanding)) ausstehend." }
            return make(icon: "exclamationmark.triangle", text: OfflineCountText.failed(failed),
                        detail: outstanding > 0 ? OfflineCountText.outstanding(outstanding) : nil,
                        warning: true, spoken: spoken)
        }

        if outstanding > 0 {
            var detail: String?
            var spoken = "\(OfflineCountText.changes(outstanding)) ausstehend."
            if case .waitingRetry = activity { detail = retryLaterText; spoken += " \(retryLaterText)" }
            return make(icon: "arrow.triangle.2.circlepath", text: OfflineCountText.outstanding(outstanding),
                        detail: detail, spoken: spoken)
        }
        return nil
    }
}

// MARK: - View

struct OfflineStatusBanner: View {
    @EnvironmentObject private var offline: OfflineStatusStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showChanges = false

    private var content: OfflineBannerContent? {
        OfflineBannerLogic.content(connection: offline.connection, activity: offline.activity,
                                   dataAsOf: offline.dataAsOf, unsyncedCount: offline.unsyncedCount,
                                   failedCount: offline.failedCount,
                                   storageProblemMessage: offline.storageProblemMessage)
    }

    var body: some View {
        Group {
            if let c = content {
                bar(c)
                    .transition(reduceMotion ? .identity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: content)
        .onChange(of: content?.announcementKey) { _, key in
            // Nur bei Zustandswechsel, nicht bei jedem Fortschrittsschritt.
            if key != nil, let label = content?.accessibilityLabel {
                AccessibilityNotification.Announcement(label).post()
            }
        }
        .sheet(isPresented: $showChanges) { PendingChangesSheet() }
    }

    @ViewBuilder
    private func bar(_ c: OfflineBannerContent) -> some View {
        HStack(spacing: 8) {
            Button {
                if c.opensList { showChanges = true }
            } label: {
                HStack(spacing: 8) {
                    if c.showsSpinner {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: c.icon).accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        Text(c.text).scaledFont(.caption).fontWeight(.medium)
                        if let d = c.detail {
                            Text(d).scaledFont(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if let s = c.summary {
                        Text(s)
                            .scaledFont(.caption2).fontWeight(.medium)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(c.isWarning ? DS.warningBg : DS.accentLight))
                            .foregroundStyle(c.isWarning ? DS.warningFg : DS.accentDark)
                    }
                    Spacer(minLength: 4)
                    if c.opensList {
                        Image(systemName: "chevron.right").scaledFont(.caption2)
                            .foregroundStyle(.secondary).accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!c.opensList)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(c.accessibilityLabel)
            .accessibilityHint(c.opensList ? OfflineBannerLogic.openListHint : "")
            .accessibilityAddTraits(c.opensList ? .isButton : [])

            if c.showsReauthButton {
                Button(OfflineBannerLogic.reauthButtonTitle) { offline.intents.requestReauth() }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            if c.showsRetry {
                Button(OfflineTexts.retry) { Task { await offline.intents.syncNow() } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .background(.thinMaterial)
        .foregroundStyle(c.isWarning ? DS.warningFg : Color.primary)
    }
}
