//
//  ProgressBadgeView.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI-Bausteine Progress"): kompaktes Badge für
//  Listenzeilen (z.B. Todo-/Topic-Zeilen), das den Fortschrittsverlauf-Status
//  eines Vorhabens auf einen Blick zeigt. Stil-Vorbild ist bewusst das
//  bestehende `dueBadge(text:status:)`-Muster aus `TodosView.swift` (gleicher
//  Aufbau: Icon + Text in einer Capsule, `scaledFont`, Farbe NIE alleiniger
//  Bedeutungstraeger) — keine neue, abweichende Badge-Optik.
//
//  Wird von Paket A3 in Listenzeilen eingebunden (nicht Teil dieses Pakets).
//

import SwiftUI

// MARK: - Reine Logik (testbar ohne SwiftUI-View-Rendering)

/// Reine Ableitungs-Logik für `ProgressBadgeView`, getrennt vom View-Body,
/// damit sie ohne Rendering unit-testbar ist (siehe `ProgressViewLogicTests`).
enum ProgressBadgeLogic {
    /// `true`, wenn für diese Summary überhaupt ein Badge angezeigt werden
    /// soll. `nil` oder `entryCount == 0` → kein Badge (siehe Vertrag).
    static func isVisible(_ summary: ProgressSummary?) -> Bool {
        guard let summary else { return false }
        return summary.entryCount > 0
    }

    /// Sichtbarer Badge-Text. Nutzt bevorzugt den vom Server gelieferten,
    /// bereits deutschsprachig aufbereiteten `badgeLabel`; fällt auf einen
    /// generischen, ebenfalls deutschen Text zurück, falls der Server (noch)
    /// keinen `badgeLabel` liefert (defensiv gegen künftige/abweichende
    /// Server-Antworten, siehe Sicherheits-Baseline "jede Eingabe von außen
    /// validieren").
    static func displayText(_ summary: ProgressSummary) -> String {
        if let label = summary.badgeLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
            return label
        }
        return summary.entryCount == 1 ? "1 Zwischenstand" : "\(summary.entryCount) Zwischenstände"
    }

    /// SF-Symbol-Name, der GEMEINSAM mit der Farbe wechselt, wenn
    /// `badgeEmphasis == "stale"` — Farbe ist damit nie alleiniger
    /// Bedeutungsträger (Barrierefreiheits-Vorgabe).
    static func iconName(for emphasis: ProgressBadgeEmphasis) -> String {
        switch emphasis {
        case .stale: return "hourglass"
        case .normal, .unknown: return "chart.line.uptrend.xyaxis"
        }
    }

    /// Vollständiger Satz für VoiceOver, z.B.
    /// "Fortschritt: 5 Zwischenstände — länger nicht aktualisiert."
    static func accessibilityLabel(_ summary: ProgressSummary) -> String {
        let base = "Fortschritt: \(displayText(summary))"
        if summary.badgeEmphasisKind == .stale {
            return base + " — länger nicht aktualisiert"
        }
        return base
    }
}

// MARK: - View

/// Kompaktes Badge für Listenzeilen. Rendert nichts, wenn `summary` `nil`
/// ist oder keine Einträge vorhanden sind (siehe `ProgressBadgeLogic.isVisible`).
struct ProgressBadgeView: View {
    let summary: ProgressSummary?

    var body: some View {
        if ProgressBadgeLogic.isVisible(summary), let summary {
            let emphasis = summary.badgeEmphasisKind
            let (bg, fg): (Color, Color) = emphasis == .stale
                ? (DS.warningBg, DS.warningFg)
                : (DS.accentLight, DS.accentDark)
            HStack(spacing: 3) {
                Image(systemName: ProgressBadgeLogic.iconName(for: emphasis))
                    .font(.system(size: 9))
                Text(ProgressBadgeLogic.displayText(summary))
            }
            .scaledFont(.caption2).fontWeight(.medium)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(bg)
            .foregroundStyle(fg)
            .clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ProgressBadgeLogic.accessibilityLabel(summary))
        }
    }
}
