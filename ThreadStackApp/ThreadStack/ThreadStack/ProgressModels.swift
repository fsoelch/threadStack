//
//  ProgressModels.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("App-Datenschicht Progress"): reine Datenmodelle für das
//  Zielbild-/Fortschrittsverlauf-Feature. Feldnamen und -typen bilden exakt
//  das JSON-Format ab, das Paket S1 serverseitig liefert (siehe Vertrag) —
//  Datumsfelder bleiben bewusst `String` (ISO-8601-Text), analog zu allen
//  bestehenden Modellen in `Models.swift` (z.B. `TodoItem.createdAt`,
//  `Topic.resultDate`), nicht `Date`, damit Formatierung/Parsing weiterhin
//  zentral über die bestehenden Helfer (`parseFlexDate` etc.) läuft.
//
//  Diese Datei enthält ausschließlich Datentypen (kein Networking, keine
//  UI) — der API-Zugriff lebt in `ProgressAPI.swift`, der Zustand in
//  `ProgressStore.swift`.
//

import Foundation

/// Eingebettet in `TodoItem`/`Topic` als optionales Feld `progress` (wird von
/// Paket A3 dort ergänzt — nicht Teil dieses Pakets, siehe Abschlussbericht).
struct ProgressSummary: Codable, Equatable {
    let entryCount: Int
    let lastEntryAt: String?
    let stale: Bool
    let staleDays: Int?
    let dormant: Bool
    let dormantSince: String?
    let orderKey: String?
    let undocumented: Bool
    let nextStep: String?
    let badgeLabel: String?
    /// Bewusst `String` statt `enum` (siehe Vertrag: "modelliere als String
    /// (nicht enum) oder als enum: String, Codable mit unknown-Fallback für
    /// Robustheit") — ein zukünftig vom Server neu eingeführter Wert (z.B.
    /// eine dritte Emphasis-Stufe) darf die Decodierung nie zum Absturz
    /// bringen. `badgeEmphasisKind` unten bietet trotzdem eine typisierte,
    /// robuste Sicht für Aufrufer, die keinen String-Vergleich wollen.
    let badgeEmphasis: String
}

/// Typisierte, robuste Sicht auf `ProgressSummary.badgeEmphasis` für Aufrufer,
/// die kein Rohstring-Matching wollen. Unbekannte/zukünftige Server-Werte
/// fallen auf `.unknown`, statt die Decodierung von `ProgressSummary` selbst
/// zum Scheitern zu bringen.
enum ProgressBadgeEmphasis: String {
    case normal
    case stale
    case unknown

    init(rawValue value: String) {
        switch value {
        case "normal": self = .normal
        case "stale": self = .stale
        default: self = .unknown
        }
    }
}

extension ProgressSummary {
    var badgeEmphasisKind: ProgressBadgeEmphasis { ProgressBadgeEmphasis(rawValue: badgeEmphasis) }
}

struct ProgressEntry: Codable, Equatable, Identifiable {
    let id: String
    let refType: String
    let refId: String
    let kind: String       // "note" | "result"
    let source: String
    let bodyHtml: String
    let excerpt: String
    let createdAt: String
    let editedAt: String?
    let gapDaysBefore: Int
    let showDormancyMarker: Bool
    let editable: Bool

    // Custom init(from:) unten deaktiviert die automatische Synthese des
    // memberwise Initializers — hier explizit wiederhergestellt, u.a. fuer
    // Tests, die ProgressEntry direkt konstruieren (siehe ProgressViewLogicTests.swift).
    init(id: String, refType: String, refId: String, kind: String, source: String,
         bodyHtml: String, excerpt: String, createdAt: String, editedAt: String?,
         gapDaysBefore: Int, showDormancyMarker: Bool, editable: Bool) {
        self.id = id
        self.refType = refType
        self.refId = refId
        self.kind = kind
        self.source = source
        self.bodyHtml = bodyHtml
        self.excerpt = excerpt
        self.createdAt = createdAt
        self.editedAt = editedAt
        self.gapDaysBefore = gapDaysBefore
        self.showDormancyMarker = showDormancyMarker
        self.editable = editable
    }

    private enum CodingKeys: String, CodingKey {
        case id, refType, refId, kind, source, bodyHtml, excerpt, createdAt, editedAt, gapDaysBefore, showDormancyMarker, editable
    }

    // Der Server liefert aktuell kein `excerpt`-Feld (siehe lib/progress/routes.js) —
    // solange das so ist, wird es hier defensiv aus bodyHtml abgeleitet, damit das
    // Decodieren echter Server-Antworten nicht mit keyNotFound scheitert.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        refType = try c.decode(String.self, forKey: .refType)
        refId = try c.decode(String.self, forKey: .refId)
        kind = try c.decode(String.self, forKey: .kind)
        source = try c.decode(String.self, forKey: .source)
        bodyHtml = try c.decode(String.self, forKey: .bodyHtml)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        gapDaysBefore = try c.decode(Int.self, forKey: .gapDaysBefore)
        showDormancyMarker = try c.decode(Bool.self, forKey: .showDormancyMarker)
        editable = try c.decode(Bool.self, forKey: .editable)
        if let serverExcerpt = try c.decodeIfPresent(String.self, forKey: .excerpt), !serverExcerpt.isEmpty {
            excerpt = serverExcerpt
        } else {
            excerpt = ProgressEntry.deriveExcerpt(fromBodyHtml: bodyHtml)
        }
    }

    static func deriveExcerpt(fromBodyHtml html: String, limit: Int = 280) -> String {
        let plain = stripHTML(html).trimmingCharacters(in: .whitespacesAndNewlines)
        guard plain.count > limit else { return plain }
        let cut = plain.index(plain.startIndex, offsetBy: limit)
        return String(plain[..<cut]) + "…"
    }
}

struct ProgressStats: Codable, Equatable {
    let entryCount: Int
    let firstEntryAt: String?
    let lastEntryAt: String?
    let lastActivityAt: String?
    let dormant: Bool
    let dormantDays: Int?
    let stale: Bool
    let staleDays: Int?
}

struct ProgressReentryAI: Codable, Equatable {
    let available: Bool
    let frameId: String?
}

struct ProgressReentry: Codable, Equatable {
    let show: Bool
    let dormantSince: String?
    let dormantLabel: String?
    let empty: Bool
    let ai: ProgressReentryAI
}

struct ProgressRef: Codable, Equatable {
    let type: String
    let id: String
    let title: String
    let done: Bool
    let exists: Bool
}

struct ProgressPage: Codable, Equatable {
    let limit: Int
    let hasMore: Bool
    let nextCursor: String?
}

struct ProgressDetail: Codable, Equatable {
    let ref: ProgressRef
    /// DEPRECATED (Zielbild entfällt vollständig aus der App-UI, siehe
    /// Produktentscheidung): der Server liefert dieses Feld ggf. weiterhin
    /// aus Kompatibilitätsgründen, es wird aber clientseitig nirgends mehr
    /// angezeigt oder editiert. Optional, damit ein zukünftig entfernter
    /// oder leerer Wert die Decodierung nicht zum Absturz bringt.
    let goal: String?
    let goalUpdatedAt: String?
    let nextStep: String
    let nextStepUpdatedAt: String?
    let stats: ProgressStats
    let reentry: ProgressReentry
    let entries: [ProgressEntry]
    let page: ProgressPage
}

struct ProgressEntriesPage: Codable, Equatable {
    let entries: [ProgressEntry]
    let page: ProgressPage
}

struct ProgressMeta: Codable, Equatable {
    let goal: String?
    let goalUpdatedAt: String?
    let nextStep: String?
    let nextStepUpdatedAt: String?
}

/// Fehler-Vertrag für das Progress-Feature. `errorDescription` liefert
/// ausschließlich deutsche, nutzerfreundliche Texte ohne interne Details
/// (Stacktraces, Query-Strings, Serverpfade) — sicher für die direkte
/// Anzeige in der UI (siehe Sicherheits-Baseline in CLAUDE.md).
enum ProgressError: LocalizedError, Equatable {
    case notFound          // 404 ref_not_found
    case entryGone         // 404 entry_not_found
    case refDone            // 409 ref_done
    case notEditable       // 409 entry_not_editable
    case tooLong(field: String, limit: Int)   // 400 *_too_long
    case empty             // 400 body_empty
    case rateLimited       // 429 rate_limited
    case offline           // Netzwerkfehler (kein Server erreicht)
    case server(String)    // 500/sonstige, mit deutschem Nutzertext aus der Server-Response

    var errorDescription: String? {
        switch self {
        case .notFound: return "Das Vorhaben existiert nicht mehr."
        case .entryGone: return "Dieser Zwischenstand wurde bereits gelöscht."
        case .refDone: return "Vorhaben ist erledigt — zuerst wieder öffnen."
        case .notEditable: return "Dieser Eintrag kann nicht bearbeitet werden."
        case .tooLong(let field, let limit): return "\(field) darf höchstens \(limit) Zeichen haben."
        case .empty: return "Bitte gib einen Text ein."
        case .rateLimited: return "Zu viele Änderungen. Bitte kurz warten."
        case .offline: return "Keine Verbindung zum Server. Deine Eingabe bleibt erhalten."
        case .server(let msg): return msg
        }
    }
}
