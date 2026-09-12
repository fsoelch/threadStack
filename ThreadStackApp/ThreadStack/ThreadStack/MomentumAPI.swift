import Foundation

// MARK: - Sichtbarer Fortschritt (Arbeitspaket M5) — Netzwerkschicht
//
// Folgt demselben Muster wie ProgressAPI.swift/SummaryAPI.swift: eine
// eigene Extension auf `AppState`, ausschließlich über die generischen
// `request<T>`-Helfer aus AppState.swift (kein eigener URLSession-Umgang).
extension AppState {

    /// Client-UTC-Offset in Minuten (z.B. Berlin im Sommer: 120). Wird bei
    /// JEDER Anfrage frisch berechnet, NIE zwischengespeichert - siehe
    /// Architektur-Vertrag (Zeitzonenwechsel/Reisen). Entspricht
    /// `-date.getTimezoneOffset()` im Web-Client.
    var utcOffsetMinutes: Int {
        TimeZone.current.secondsFromGMT() / 60
    }

    func momentumOverview() async throws -> MomentumOverview {
        try await request("GET", "/momentum/overview?utcOffsetMinutes=\(utcOffsetMinutes)")
    }

    /// Aktualisiert `momentumStreakCount` für den Sidebar-Badge - bewusst
    /// fehlertolerant (kein throws): ein langsamer/fehlschlagender Abruf darf
    /// den App-Bootstrap (siehe ContentView.reload()) nicht blockieren oder
    /// mit einem Fehler-Alert unterbrechen, analog zum Web-Pendant
    /// `loadMomentumBadge()` in public/app.js.
    func refreshMomentumStreakBadge() async {
        do {
            let overview = try await momentumOverview()
            let current = overview.streak?.current ?? 0
            momentumStreakCount = current > 0 ? current : nil
        } catch {
            momentumStreakCount = nil
        }
    }

    func momentumPauseDays() async throws -> [String] {
        let res: MomentumPauseDaysResponse = try await request("GET", "/momentum/pause-days")
        return res.pauseDays
    }

    @discardableResult
    func momentumSaveSettings(_ patch: [String: Bool]) async throws -> MomentumSettings {
        try await request("PUT", "/momentum/settings", body: patch)
    }

    func momentumAddPauseDay(_ date: String) async throws {
        let _: OKResponse = try await request(
            "POST", "/momentum/pause-days?utcOffsetMinutes=\(utcOffsetMinutes)", body: ["date": date]
        )
    }

    func momentumRemovePauseDay(_ date: String) async throws {
        let _: OKResponse = try await request("DELETE", "/momentum/pause-days/\(date)")
    }

    /// Übersetzt ein additives `MomentumCompletionResult` (siehe
    /// completeTodo/completeTopic) in eine oder mehrere Toast-Nachrichten und
    /// reiht sie in die Warteschlange ein - EIN Toast pro Meilenstein, damit
    /// bei mehreren betroffenen Kontakten/Themen keine Information verloren
    /// geht (identisches Verhalten zu public/momentum.js#showCompletionToast).
    func presentMomentumToasts(_ momentum: MomentumCompletionResult?) {
        guard let momentum else { return }
        guard !momentum.milestones.isEmpty else {
            showToast("Erledigt · diese Woche: \(momentum.weeklyCompletedCount)")
            return
        }
        for milestone in momentum.milestones {
            let label = milestone.type == "topic"
                ? "Thema „\(milestone.name)“ ist jetzt komplett abgeschlossen"
                : "Bei „\(milestone.name)“ ist jetzt alles erledigt"
            showToast("🎉 \(label)", emphasized: true)
        }
    }
}

