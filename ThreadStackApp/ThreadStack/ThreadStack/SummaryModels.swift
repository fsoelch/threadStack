//
//  SummaryModels.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("App-Datenschicht", Redesign Todo/Task-Übersicht):
//  reine Datenmodelle für die serverseitig ereignisgetrieben generierten
//  KI-Zusammenfassungen ("Fortschritt"/"Beschreibung"). Bildet exakt das
//  JSON-Format ab, das der Server unter `GET /api/summaries` bzw. additiv in
//  den Listen-Endpunkten (`GET /api/todos`/`GET /api/themes` als `aiSummary`)
//  liefert (siehe Schnittstelle 12 im Vertrag).
//
//  Diese Datei enthält ausschließlich Datentypen (kein Networking, keine
//  UI) — der API-Zugriff lebt in `SummaryAPI.swift`, der Zustand in
//  `SummaryStore.swift`.
//

import Foundation

/// Robuste, typisierte Sicht auf `AISummaryView.status`. Bewusst nicht als
/// Decodierungs-Ziel selbst verwendet (siehe `AISummaryView.status: String`)
/// — ein zukünftiger, unbekannter Server-Wert fällt auf `.unknown`, statt die
/// Dekodierung des gesamten `AISummaryView` zum Absturz zu bringen (siehe
/// Vertrag: "String, NICHT enum — unbekannte Serverwerte dürfen das Decoding
/// NIE brechen").
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

/// Eine einzelne KI-Zusammenfassung (Fortschritt ODER Beschreibung) für eine
/// Ref. `status` bleibt bewusst `String` (siehe Vertrag) — `kind` bietet
/// Aufrufern trotzdem eine typisierte, robuste Sicht ohne eigenes
/// String-Matching.
struct AISummaryView: Codable, Equatable {
    let status: String
    let text: String?
    let generatedAt: String?
    let model: String?
    let errorCode: String?

    var kind: AISummaryStatus { AISummaryStatus(rawValue: status) }
}

/// Fortschritts- und Beschreibungs-Zusammenfassung einer Ref, wie sie sowohl
/// von `GET /api/summaries` je Ref-Schlüssel als auch additiv als
/// `aiSummary` in Listen-Endpunkten geliefert wird. Beide Felder optional:
/// eine Zusammenfassungsart kann fehlen (z.B. wenn für diesen Ref-Typ nicht
/// anwendbar), ohne dass die Dekodierung des gesamten Objekts scheitert.
struct AISummaryPair: Codable, Equatable {
    let progress: AISummaryView?
    let description: AISummaryView?
}

/// Fehler-Vertrag für das Summary-Feature. `errorDescription` liefert
/// ausschließlich deutsche, nutzerfreundliche Texte ohne interne Details
/// (Stacktraces, Query-Strings, Serverpfade) — sicher für die direkte
/// Anzeige in der UI (siehe Sicherheits-Baseline in CLAUDE.md). Der Vertrag
/// listet für die Summary-Endpunkte (anders als bei `ProgressError`) keine
/// stabilen, dokumentierten `code`-Werte auf — die Zuordnung erfolgt daher
/// primär über den HTTP-Status, der servergelieferte `error`-Text wird nach
/// Möglichkeit direkt übernommen (das Backend liefert dort bereits
/// nutzerverständlichen deutschen Text, analog zu allen anderen
/// Fehlerpfaden dieser App).
enum SummaryError: LocalizedError, Equatable {
    case invalidRequest(String)   // 400
    case notFound                  // 404
    case conflict(String)          // 409
    case budgetExceeded            // 402
    case rateLimited                // 429
    case offline                    // Netzwerkfehler (kein Server erreicht)
    case server(String)             // 500/sonstige, mit deutschem Nutzertext aus der Server-Response

    var errorDescription: String? {
        switch self {
        case .invalidRequest(let m): return m
        case .notFound: return "Dieser Eintrag existiert nicht mehr."
        case .conflict(let m): return m
        case .budgetExceeded: return "KI-Budget aufgebraucht."
        case .rateLimited: return "Zu viele Anfragen. Bitte kurz warten."
        case .offline: return "Keine Verbindung zum Server."
        case .server(let m): return m
        }
    }

    /// Bildet einen HTTP-Fehlerstatus + optionale Server-Nachricht auf den
    /// passenden `SummaryError`-Case ab. Fehlende/leere Nachrichten fallen
    /// auf einen generischen, sicheren deutschen Text zurück statt interne
    /// Details preiszugeben.
    static func map(status: Int, message: String?) -> SummaryError {
        let text = (message?.isEmpty == false) ? message : nil
        switch status {
        case 400: return .invalidRequest(text ?? "Ungültige Anfrage.")
        case 404: return .notFound
        case 409: return .conflict(text ?? "Aktion aktuell nicht möglich.")
        case 402: return .budgetExceeded
        case 429: return .rateLimited
        default: return .server(text ?? "Ein unerwarteter Fehler ist aufgetreten.")
        }
    }
}
