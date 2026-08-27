//
//  SummaryModels.swift
//  ThreadStack
//
//  ABWEICHUNG VOM ARBEITSPAKET-ZUSCHNITT (siehe Abschlussbericht Paket A3):
//  Dieser Datei-Inhalt gehört laut Vertrag zu Arbeitspaket A1
//  ("App-Datenschicht"), wurde dort aber in diesem Worktree-Stand nicht
//  gefunden (weder committed noch in einem erreichbaren Sibling-Worktree) —
//  auch nach Nachziehen des aktuellen `main`-Standes. Damit Paket A3
//  ("App-UI Übersicht/Meeting-Detail") die geforderte KI-Zusammenfassungs-
//  Karte überhaupt implementieren und testen kann, wird hier eine MINIMALE,
//  am beschriebenen Vertrag orientierte Stand-in-Fassung nachgezogen (analog
//  zum in der Aufgabenstellung beschriebenen Vorgehen von Paket A2 bei
//  `ProgressDetail.goal`). Feldnamen/Typen bilden bewusst 1:1 die im Vertrag
//  genannten Bezeichner ab (`AISummaryView`, `AISummaryPair`, `AISummaryStatus`,
//  `.kind`), damit ein späterer Merge mit dem echten Paket A1 möglichst
//  reibungslos verläuft. MUSS beim Merge mit dem echten Paket A1 abgeglichen
//  bzw. ersetzt werden — siehe Abschlussbericht.
//
//  Reine Datentypen (kein Networking, keine UI) — analog zu ProgressModels.swift.
//

import Foundation

/// Typisierte, robuste Sicht auf `AISummaryView.status`. Unbekannte/zukünftige
/// Server-Werte fallen auf `.unknown`, statt die Decodierung selbst zum
/// Scheitern zu bringen (siehe CLAUDE.md Sicherheits-Baseline: jede Eingabe
/// von außen validieren, defensiv gegen unbekannte Werte).
enum AISummaryStatus: String {
    case ready
    case stale
    case pending
    case error
    case disabled
    case notApplicable
    case unknown

    init(rawValue value: String) {
        switch value {
        case "ready": self = .ready
        case "stale": self = .stale
        case "pending": self = .pending
        case "error": self = .error
        case "disabled": self = .disabled
        case "not_applicable": self = .notApplicable
        default: self = .unknown
        }
    }
}

/// Eine einzelne KI-Zusammenfassung (Fortschritt ODER Beschreibung) für genau
/// eine Ref. `status` bleibt bewusst `String` (nicht enum), `.kind` bietet die
/// robuste, typisierte Sicht darauf (siehe `AISummaryStatus`).
struct AISummaryView: Codable, Equatable {
    let status: String
    let text: String?
    let updatedAt: String?

    var kind: AISummaryStatus { AISummaryStatus(rawValue: status) }

    init(status: String, text: String?, updatedAt: String?) {
        self.status = status
        self.text = text
        self.updatedAt = updatedAt
    }
}

/// Bündelt die beiden möglichen KI-Zusammenfassungen einer Ref (Fortschritt
/// und Beschreibung) — eingebettet in `TodoItem`/`Topic` als optionales Feld
/// `aiSummary`, analog zu `ProgressSummary` (`progress`-Feld).
struct AISummaryPair: Codable, Equatable {
    var progress: AISummaryView?
    var description: AISummaryView?

    init(progress: AISummaryView? = nil, description: AISummaryView? = nil) {
        self.progress = progress
        self.description = description
    }
}
