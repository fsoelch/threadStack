//
//  AISummaryCardView.swift
//  ThreadStack
//
//  Arbeitspaket A3 ("App-UI Übersicht und Meeting-Detail"): zeigt eine KI-
//  Zusammenfassung (Fortschritt ODER Beschreibung) in der Kartenliste an,
//  analog zum Web-Pendant `TSProgress.mountCardSummary` (`public/progress.js`).
//
//  WICHTIG (Merge-Abstimmung mit Paket S3, siehe Abschlussbericht): der
//  Status `not_applicable` deckt laut bekannter Server-Einschränkung sowohl
//  "wirklich nicht anwendbar" als auch "Bestandsdaten ohne bisherige
//  Generierung" ab. Diese View rendert bei `not_applicable` deshalb
//  GRUNDSÄTZLICH NICHTS (sicherer Default, kein "Jetzt zusammenfassen"-Button)
//  — siehe `AISummaryCardLogic.shouldRender`.
//
//  Texte ausschließlich über SwiftUI `Text` (kein `Text(verbatim:)`, keine
//  HTML-Interpretation) — KI-generierter Text wird nie als Markup ausgeführt.
//

import SwiftUI

/// Welche der beiden möglichen Zusammenfassungen einer Ref dargestellt wird.
/// Bestimmt sowohl die Kennzeichnung ("KI-Zusammenfassung" vs.
/// "KI-Kurzfassung") als auch den `kind`-Wert für `SummaryStore.regenerate`.
enum AISummaryCardKind: Equatable {
    case progress
    case description

    var badgeLabel: String {
        switch self {
        case .progress: return "KI-Zusammenfassung"
        case .description: return "KI-Kurzfassung"
        }
    }

    /// Wert für die API/`SummaryStore.regenerate(kind:...)` — bewusst ein
    /// stabiler String-Schlüssel, kein Rohtext der UI-Kennzeichnung.
    var apiValue: String {
        switch self {
        case .progress: return "progress"
        case .description: return "description"
        }
    }
}

// MARK: - Reine Logik (testbar ohne SwiftUI-View-Rendering)

/// Reine Sichtbarkeits-/Zustandslogik für `AISummaryCardView`, getrennt vom
/// View-Body (analog zu `ProgressBadgeLogic`), damit sie ohne Rendering
/// unit-testbar ist (siehe `TodoOverviewLogicTests`).
enum AISummaryCardLogic {
    /// `true`, wenn für diesen Status überhaupt etwas gerendert werden soll.
    /// `disabled`, `notApplicable` und `unknown` rendern NICHTS (siehe
    /// Datei-Kopfkommentar) — keine leere Fläche, kein toter Button.
    static func shouldRender(_ status: AISummaryStatus) -> Bool {
        switch status {
        case .ready, .stale, .pending, .error: return true
        case .disabled, .notApplicable, .unknown: return false
        }
    }

    /// Ein rotierender Spinner ist im `pending`-Zustand NIE erlaubt, wenn
    /// Reduce-Motion aktiv ist (Barrierefreiheits-Vorgabe) — dann stattdessen
    /// ein statischer Ladehinweis.
    static func showsSpinner(status: AISummaryStatus, reduceMotion: Bool) -> Bool {
        status == .pending && !reduceMotion
    }

    /// VoiceOver-Text für den `stale`-Zustand: alter Text bleibt sichtbar,
    /// der Hinweis "wird aktualisiert" wird zusätzlich als eigenständige
    /// Information ergänzt (nicht nur optisch dezent, siehe Vertrag).
    static func staleAccessibilityLabel(text: String, badgeLabel: String) -> String {
        "\(badgeLabel): \(text) — wird aktualisiert"
    }
}

// MARK: - View

struct AISummaryCardView: View {
    let kind: AISummaryCardKind
    let summary: AISummaryView?
    let refType: String
    let refId: String
    @ObservedObject var store: SummaryStore
    /// Nur bei `kind == .progress` relevant: Link zu allen Zwischenständen.
    /// `nil` (Default) bedeutet: kein Link angeboten. Öffnet bewusst die
    /// bereits bestehende Bearbeiten-Ansicht (`TodoFormView`/`TopicFormView`,
    /// die den vollständigen Fortschrittsverlauf zeigt) statt eine zweite,
    /// neue "alle Zwischenstände"-Ansicht zu bauen (Wiederverwendung vor
    /// Neuentwicklung).
    var onShowAllEntries: (() -> Void)? = nil

    @EnvironmentObject private var offline: OfflineStatusStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isRegenerating = false
    @State private var regenerateError: String?

    var body: some View {
        if let summary, AISummaryCardLogic.shouldRender(summary.kind) {
            content(summary)
        }
    }

    @ViewBuilder
    private func content(_ summary: AISummaryView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            switch summary.kind {
            case .ready:
                readyBody(summary)
            case .stale:
                staleBody(summary)
            case .pending:
                pendingBody
            case .error:
                errorBody(summary)
            case .disabled, .notApplicable, .unknown:
                EmptyView()
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: DS.radiusXS))
    }

    @ViewBuilder
    private func readyBody(_ summary: AISummaryView) -> some View {
        badgeLabel
        if let text = summary.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            Text(text).scaledFont(.footnote)
        }
        if kind == .progress, let onShowAllEntries {
            Button("Alle Zwischenstände ansehen", action: onShowAllEntries)
                .buttonStyle(.plain)
                .scaledFont(.caption)
                .foregroundStyle(DS.accentDark)
        }
    }

    @ViewBuilder
    private func staleBody(_ summary: AISummaryView) -> some View {
        badgeLabel
        let text = summary.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !text.isEmpty {
            Text(text).scaledFont(.footnote)
        }
        Text("Wird aktualisiert…")
            .scaledFont(.caption2)
            .foregroundStyle(.secondary)
            .accessibilityLabel(AISummaryCardLogic.staleAccessibilityLabel(text: text, badgeLabel: kind.badgeLabel))
    }

    @ViewBuilder
    private var pendingBody: some View {
        HStack(spacing: 6) {
            if AISummaryCardLogic.showsSpinner(status: .pending, reduceMotion: reduceMotion) {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "hourglass").scaledFont(.caption2).foregroundStyle(.secondary)
            }
            Text("\(kind.badgeLabel) wird erstellt…")
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // `confirmation_required` bekommt einen eigenen Zustand statt eines
    // generischen Fehlers: ein einfacher "Erneut versuchen"-Klick darf die
    // Kostenbestätigung nicht unbemerkt mit confirmed:true umgehen
    // (Security Review, Mittel, A04).
    @ViewBuilder
    private func errorBody(_ summary: AISummaryView) -> some View {
        let requiresConfirmation = summary.errorCode == "confirmation_required"
        VStack(alignment: .leading, spacing: 4) {
            Text(requiresConfirmation
                 ? "Diese Zusammenfassung überschreitet dein Kosten-Limit für automatische Erstellung."
                 : "Zusammenfassung momentan nicht verfügbar.")
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
            if let regenerateError {
                Text(regenerateError).scaledFont(.caption2).foregroundStyle(.red)
            }
            Button {
                Task { await regenerate(confirmed: requiresConfirmation) }
            } label: {
                if isRegenerating {
                    ProgressView().controlSize(.small)
                } else {
                    Text(requiresConfirmation ? "Trotzdem jetzt erstellen" : "Erneut versuchen")
                }
            }
            .buttonStyle(.plain)
            .scaledFont(.caption)
            .foregroundStyle(DS.accentDark)
            .disabled(isRegenerating)
            .offlineGated(regenerateDisabledReason)
            .accessibilityLabel(requiresConfirmation
                ? "\(kind.badgeLabel) trotz Kosten-Limit jetzt erstellen"
                : "\(kind.badgeLabel) erneut versuchen")
        }
    }

    private var badgeLabel: some View {
        Label(kind.badgeLabel, systemImage: "sparkles")
            .scaledFont(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(DS.accentDark)
    }

    /// Server-Aktion: offline und fuer lokale (noch nicht uebertragene) Vorhaben gesperrt.
    private var regenerateDisabledReason: String? {
        OfflineGating.serverActionDisabledReason(id: refId, isOffline: offline.isOffline)
    }

    private func regenerate(confirmed: Bool = false) async {
        guard regenerateDisabledReason == nil else {
            regenerateError = regenerateDisabledReason
            return
        }
        isRegenerating = true
        regenerateError = nil
        do {
            try await store.regenerate(kind: kind.apiValue, refType: refType, refId: refId, confirmed: confirmed)
        } catch {
            regenerateError = OfflineGating.message(
                for: error,
                fallback: (error as? ProgressError)?.errorDescription
                    ?? "Erneut versuchen fehlgeschlagen. Bitte später erneut versuchen.")
        }
        isRegenerating = false
    }
}
