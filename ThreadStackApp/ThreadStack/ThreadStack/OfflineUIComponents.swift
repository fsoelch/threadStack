import SwiftUI

//  OfflineUIComponents.swift
//  Arbeitspaket P2: wiederverwendbare Basis-UI-Bausteine des Offline-Modus
//  (UX-Konsistenzentscheidungen 1 und 5, Screens/Komponenten 6 und 8).
//  Stilvorbild fuer das Badge: `dueBadge` (TodosView) / `ProgressBadgeView`:
//  Capsule mit Icon + Text, `scaledFont`, Farbe nie alleiniger Bedeutungstraeger.

// MARK: - Texte

enum OfflineTexts {
    static let unavailableTitle = "Offline nicht verfügbar"
    static let notLoadedYet = "Dieser Inhalt wurde noch nicht geladen. Er ist verfügbar, sobald du wieder online bist."
    static let requiresConnection = "Diese Funktion benötigt eine Verbindung zum Server."
    static let retry = "Erneut versuchen"
}

// MARK: - Badge

enum PendingSyncBadgeKind: Equatable { case pending, syncing, failed, blocked }

/// Reine Ableitung (testbar) fuer `PendingSyncBadge`.
enum PendingSyncBadgeLogic {
    static func kind(for status: PendingItemStatus) -> PendingSyncBadgeKind {
        switch status {
        case .pending: return .pending
        case .syncing: return .syncing
        case .failed: return .failed
        case .blocked: return .blocked
        }
    }

    static func text(for kind: PendingSyncBadgeKind) -> String {
        switch kind {
        case .pending: return "Nicht synchronisiert"
        case .syncing: return "Wird synchronisiert"
        case .failed: return "Fehlgeschlagen"
        case .blocked: return "Wartet"
        }
    }

    static func iconName(for kind: PendingSyncBadgeKind) -> String {
        switch kind {
        case .pending: return "icloud.slash"
        case .syncing: return "arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.triangle"
        case .blocked: return "clock"
        }
    }

    /// Z.B. "Todo 'Titel', nicht synchronisiert" (ohne Titel nur der Status).
    static func accessibilityLabel(for kind: PendingSyncBadgeKind, itemDescription: String?) -> String {
        let status = text(for: kind).lowercasedFirst
        guard let itemDescription, !itemDescription.isEmpty else { return text(for: kind) }
        return "\(itemDescription), \(status)"
    }
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}

struct PendingSyncBadge: View {
    let status: PendingItemStatus
    /// Nur Icon (z.B. enge Zeilen); der Text bleibt ueber das Accessibility-Label erhalten.
    var compact: Bool = false
    /// Optionaler Zeilenkontext fuer VoiceOver, z.B. "Todo 'Titel'".
    var accessibilityItem: String? = nil

    private var kind: PendingSyncBadgeKind { PendingSyncBadgeLogic.kind(for: status) }

    private var colors: (bg: Color, fg: Color) {
        switch kind {
        case .pending, .syncing: return (DS.accentLight, DS.accentDark)
        case .failed: return (DS.dangerBg, DS.dangerFg)
        case .blocked: return (DS.warningBg, DS.warningFg)
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: PendingSyncBadgeLogic.iconName(for: kind))
                .font(.system(size: 9))
                .accessibilityHidden(true)
            if !compact { Text(PendingSyncBadgeLogic.text(for: kind)) }
        }
        .scaledFont(.caption2).fontWeight(.medium)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(colors.bg)
        .foregroundStyle(colors.fg)
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PendingSyncBadgeLogic.accessibilityLabel(for: kind, itemDescription: accessibilityItem))
    }
}

// MARK: - Nicht verfuegbar (Platzhalter)

enum OfflineUnavailableReason: Equatable {
    /// Bereich wurde nie geladen.
    case notLoadedYet
    /// Funktion braucht grundsaetzlich den Server.
    case requiresConnection
    case custom(String)

    var explanation: String {
        switch self {
        case .notLoadedYet: return OfflineTexts.notLoadedYet
        case .requiresConnection: return OfflineTexts.requiresConnection
        case .custom(let s): return s
        }
    }
}

struct OfflineUnavailableView: View {
    var reason: OfflineUnavailableReason = .notLoadedYet
    var onRetry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(OfflineTexts.unavailableTitle)
                .scaledFont(.headline)
            Text(reason.explanation)
                .scaledFont(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let onRetry {
                Button(OfflineTexts.retry, action: onRetry)
                    .buttonStyle(.bordered)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - disabledWhenOffline

struct DisabledWhenOfflineModifier: ViewModifier {
    let isOffline: Bool
    let hint: String

    func body(content: Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            content
                .disabled(isOffline)
                .accessibilityHint(isOffline ? hint : "")
            if isOffline {
                Text(OfflineTexts.unavailableTitle)
                    .scaledFont(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
    }
}

extension View {
    /// Deaktiviert die Aktion offline und zeigt den sichtbaren Zusatz
    /// "Offline nicht verfügbar" (Pflicht laut UX) samt accessibilityHint.
    func disabledWhenOffline(_ isOffline: Bool, hint: String = OfflineTexts.unavailableTitle) -> some View {
        modifier(DisabledWhenOfflineModifier(isOffline: isOffline, hint: hint))
    }
}

// MARK: - Stand-Anzeige

/// Reine Formatierung (testbar, locale-unabhaengig):
/// "heute, 14:32" / "gestern, 14:32" / "15.11., 14:32"; in einem anderen
/// Kalenderjahr mit Jahr: "15.11.2025, 14:32".
enum OfflineDataAsOfFormatter {
    static func string(for date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let time = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        if calendar.isDate(date, inSameDayAs: now) { return "heute, \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return "gestern, \(time)" }
        let day = String(format: "%02d.%02d.", c.day ?? 0, c.month ?? 0)
        if c.year != calendar.component(.year, from: now) { return "\(day)\(c.year ?? 0), \(time)" }
        return "\(day), \(time)"
    }

    /// "Stand vom 15.11., 14:32" - der Zeitpunkt wird je nach Tag mit "heute"/"gestern" ersetzt.
    static func label(for date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return "Noch kein Stand geladen" }
        let s = string(for: date, now: now, calendar: calendar)
        if s.hasPrefix("heute") || s.hasPrefix("gestern") { return "Stand: \(s)" }
        return "Stand vom \(s)"
    }
}

struct OfflineDataAsOfLabel: View {
    let date: Date?

    var body: some View {
        Text(OfflineDataAsOfFormatter.label(for: date))
            .scaledFont(.caption2)
            .foregroundStyle(.secondary)
    }
}
