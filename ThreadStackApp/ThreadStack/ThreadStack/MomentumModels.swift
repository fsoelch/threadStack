import Foundation

// MARK: - Sichtbarer Fortschritt (Arbeitspaket M5, Momentum)
//
// Modulname bewusst `Momentum`, nicht `Progress*` - die App hat bereits ein
// eigenständiges Feature namens "Fortschrittsverlauf" (ProgressModels.swift/
// ProgressAPI.swift/ProgressStore.swift, Zwischenstand-Notizen an Todos/
// Themen), das mit dieser neuen Streak-/Wochen-Rückblick-Funktion NICHTS zu
// tun hat (siehe .claude/agent-memory der Backend-Arbeitspakete). Alle JSON-
// Felder sind camelCase (identisch zum Server-Vertrag), daher kein
// benutzerdefinierter CodingKeys-Aufwand nötig (Konvention siehe Theme).

struct MomentumSettings: Codable, Equatable {
    var completionToastEnabled: Bool
    var streakEnabled: Bool
    var weeklyReviewEnabled: Bool
}

struct MomentumStreak: Codable, Equatable {
    let current: Int
    let activeToday: Bool
}

struct MomentumMilestone: Codable, Equatable, Identifiable {
    let type: String   // "topic" | "contact"
    let id: String
    let name: String
}

struct MomentumWeek: Codable, Equatable {
    let startDate: String
    let endDate: String
    let createdCount: Int
    let completedCount: Int
    let milestones: [MomentumMilestone]
}

struct MomentumOverview: Codable {
    let settings: MomentumSettings
    let streak: MomentumStreak?
    let week: MomentumWeek?
}

struct MomentumPauseDaysResponse: Codable {
    let pauseDays: [String]
}

/// Additives Feld in der Antwort von `PUT /todos/:id` bzw.
/// `PUT /meetings/:mid/topics/:tid`, NUR vorhanden wenn `done` sich in diesem
/// Aufruf tatsächlich geändert hat (siehe Architektur-Vertrag M1/M2).
struct MomentumCompletionResult: Codable, Equatable {
    let weeklyCompletedCount: Int
    let milestones: [MomentumMilestone]
}

/// Antwortform von `PUT /todos/:id` / `PUT /meetings/:mid/topics/:tid` -
/// `momentum` ist optional und wird beim `decodeIfPresent`-Standardverhalten
/// synthetisierter `Decodable`-Structs automatisch zu `nil`, wenn der Server
/// (oder ein Alt-Client-Testfixture ohne dieses Feature) es nicht mitschickt.
struct CompleteMutationResponse: Codable {
    let ok: Bool?
    let momentum: MomentumCompletionResult?
}

/// Reine UI-Warteschlangen-Nachricht für den Erledigt-Moment-/Meilenstein-
/// Toast (siehe AppState.toastQueue, ToastOverlay.swift). `emphasized`
/// entspricht der "deutlicheren" Meilenstein-Variante des Konzepts.
struct ToastMessage: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let emphasized: Bool
}
