//
//  SummaryStore.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("App-Datenschicht", Redesign Todo/Task-Übersicht):
//  zentraler Zustands-Store für KI-Zusammenfassungen (Schnittstelle 12 im
//  Vertrag). Hält pro Ref ("refType:refId", z.B. "todo:a1…") das zuletzt
//  bekannte `AISummaryPair` (Fortschritt + Beschreibung), befüllt entweder
//  additiv aus Listen-Antworten (`ingest(from:)`) oder per gezieltem
//  Nachladen (`poll(refs:)` nach `regenerate(...)`, bis der Server die
//  Generierung abgeschlossen hat).
//
//  Konsumierende Views fassen ausschließlich die `@Published`-Properties und
//  die Methoden unten an, nie `AppState`/`SummaryAPI` direkt (analoges
//  Muster zu `ProgressStore`, siehe dortiger Kommentar).
//
//  Polling-Kontrakt (bindend, siehe Vertrag): exakt 2000ms Intervall,
//  maximal 10 Versuche, pro Ref ("Karte") unabhängig startbar/abbrechbar —
//  ein `cancelPolling(for:)` für eine Ref darf das Polling anderer, parallel
//  über denselben `poll(refs:)`-Aufruf gestarteter Refs nicht beeinflussen.
//  Intervall/Versuchszahl sind über einen zusätzlichen, im Vertrag nicht
//  spezifizierten Test-Seam-Initializer konfigurierbar (Default = exakt die
//  vertraglich geforderten Werte), analog zum bereits etablierten Muster
//  `ProgressStore.init(appState:defaults:)`/`AppState.init(session:)` —
//  ohne diesen Seam wären Tests entweder unrealistisch langsam (bis zu 20s
//  pro Testfall) oder müssten das Timing selbst gar nicht abdecken.
//

import Foundation
import Combine

@MainActor
final class SummaryStore: ObservableObject {

    /// Vertraglich exakt vorgegebene Default-Werte — siehe Datei-
    /// Kopfkommentar. Als `static let` exponiert (statt rein privat), damit
    /// Tests die tatsächlich für den Produktionspfad geltenden Defaults
    /// bestätigen können, ohne 10×2000ms real abwarten zu müssen.
    nonisolated static let defaultPollIntervalNanoseconds: UInt64 = 2_000_000_000
    nonisolated static let defaultMaxPollAttempts = 10

    // MARK: - Published state

    /// Zuletzt bekannte Zusammenfassungen je Ref (Schlüssel "refType:refId").
    @Published private(set) var summaries: [String: AISummaryPair] = [:]

    /// Fehler eines fehlgeschlagenen `regenerate(...)`-Aufrufs je Ref
    /// (Schlüssel "kind:refType:refId", da Fortschritt/Beschreibung
    /// unabhängig regeneriert werden können). Getrennt von `summaries`
    /// gehalten: ein Regenerierungsfehler darf die zuletzt sichtbare
    /// Zusammenfassung nicht verstecken (Fehler werden behandelt, nicht
    /// verschluckt, siehe CLAUDE.md).
    @Published private(set) var regenerateErrors: [String: SummaryError] = [:]

    // MARK: - Internals

    private let appState: AppState
    private let pollIntervalNanoseconds: UInt64
    private let maxPollAttempts: Int

    /// Laufende Poll-Tasks je Ref — ermöglicht das gezielte Abbrechen EINER
    /// Ref (`cancelPolling(for:)`), ohne die Polls anderer Refs zu berühren.
    private var pollTasks: [String: Task<Void, Never>] = [:]

    /// Generation-Zähler je Ref: verhindert, dass ein bereits überholter
    /// (durch einen neueren `startPolling`-Aufruf ersetzter) Task beim
    /// eigenen Abschluss fälschlich den NEUEN Eintrag aus `pollTasks`
    /// entfernt.
    private var pollGeneration: [String: Int] = [:]

    init(appState: AppState,
         pollIntervalNanoseconds: UInt64 = SummaryStore.defaultPollIntervalNanoseconds,
         maxPollAttempts: Int = SummaryStore.defaultMaxPollAttempts) {
        self.appState = appState
        self.pollIntervalNanoseconds = pollIntervalNanoseconds
        self.maxPollAttempts = maxPollAttempts
    }

    // MARK: - Accessors

    func pair(for refKey: String) -> AISummaryPair? { summaries[refKey] }

    // MARK: - Ingest (aus Listen-Antworten)

    /// Übernimmt additiv aus Listen-Antworten (`GET /api/todos`/`GET /api/themes`,
    /// Feld `aiSummary`) gelieferte Zusammenfassungen. Überschreibt bestehende
    /// Einträge für dieselbe Ref vollständig (die Liste ist die aktuellere
    /// Quelle) — ruft dabei bewusst kein Netzwerk auf.
    func ingest(from list: [(refKey: String, pair: AISummaryPair)]) {
        for item in list {
            summaries[item.refKey] = item.pair
        }
    }

    // MARK: - Regenerieren

    /// `POST /api/summaries/:kind/:refType/:refId/regenerate[?confirm=true]`.
    /// `confirmed` defaultet auf `false` (siehe `AppState.regenerateSummary`-
    /// Kommentar) — erst nach explizitem Nutzer-Opt-in bei einem Status
    /// `confirmation_required` erneut mit `confirmed: true` aufrufen.
    /// Wirft einen normalisierten `SummaryError`, den Aufrufer direkt für
    /// die UI-Anzeige verwenden können (siehe `SummaryError.errorDescription`).
    /// Löst selbst KEIN Polling aus — Aufrufer rufen bei Bedarf anschließend
    /// `poll(refs:)` für dieselbe Ref auf.
    func regenerate(kind: String, refType: String, refId: String, confirmed: Bool = false) async throws {
        let errorKey = "\(kind):\(refType):\(refId)"
        do {
            try await appState.regenerateSummary(kind: kind, refType: refType, refId: refId, confirmed: confirmed)
            regenerateErrors[errorKey] = nil
        } catch {
            let mapped = Self.mapError(error)
            regenerateErrors[errorKey] = mapped
            throw mapped
        }
    }

    // MARK: - Polling

    /// Startet für jede übergebene Ref (sofern nicht bereits eine eigene
    /// Poll-Schleife läuft) eine unabhängige Poll-Schleife mit dem
    /// konfigurierten Intervall/Versuchslimit (Default: exakt 2000ms / 10
    /// Versuche, siehe Vertrag) und wartet, bis ALLE beendet sind (Erfolg,
    /// externer Abbruch über `cancelPolling(for:)`/Task-Cancellation der
    /// aufrufenden Seite, oder Erreichen des Versuchslimits).
    ///
    /// Kooperativ abbrechbar: verschwindet die aufrufende View (z.B. via
    /// SwiftUI `.task { await store.poll(refs: [...]) }`), wird die
    /// umgebende `Task` automatisch abgebrochen — `withTaskCancellationHandler`
    /// unten sorgt dafür, dass dieser Abbruch explizit auf die intern
    /// gehaltenen Poll-Tasks (`pollTasks`) durchgereicht wird. Ein reines
    /// `Task.isCancelled`-Prüfen in der Schleife würde NICHT ausreichen, da
    /// die eigentliche Poll-Schleife in einem separaten, unstrukturierten
    /// `Task` läuft (siehe `startPolling`), damit `cancelPolling(for:)`
    /// gezielt NUR diese eine Ref stoppen kann — unstrukturierte Tasks
    /// erben Abbrüche ihres erzeugenden Kontexts sonst nicht automatisch.
    func poll(refs: [String]) async {
        await withTaskGroup(of: Void.self) { group in
            for refKey in refs {
                group.addTask { [weak self] in
                    guard let self else { return }
                    await withTaskCancellationHandler {
                        await self.startPolling(refKey)
                    } onCancel: {
                        Task { @MainActor in self.cancelPolling(for: refKey) }
                    }
                }
            }
        }
    }

    /// Bricht eine laufende Poll-Schleife für GENAU diese Ref ab — Polls
    /// anderer, ggf. über denselben `poll(refs:)`-Aufruf gestarteter Refs
    /// laufen unverändert weiter (siehe Vertrag: "pro Karte startbar/
    /// abbrechbar").
    func cancelPolling(for refKey: String) {
        pollTasks[refKey]?.cancel()
        pollTasks[refKey] = nil
    }

    private func startPolling(_ refKey: String) async {
        // Eine bereits laufende Schleife für dieselbe Ref wird ersetzt statt
        // parallel ein zweites Mal zu pollen (vermeidet doppelte Requests bei
        // wiederholtem `poll(refs:)`-Aufruf für dieselbe Karte).
        pollTasks[refKey]?.cancel()
        pollGeneration[refKey, default: 0] += 1
        let myGeneration = pollGeneration[refKey]!

        let interval = pollIntervalNanoseconds
        let attempts = maxPollAttempts
        // Explizit `@MainActor`: die Poll-Schleife liest/schreibt
        // `@Published`-Zustand des Stores und ruft dessen (isolierte)
        // Methoden auf — keine Isolations-Inferenz-Annahme nötig.
        let task = Task { @MainActor [weak self] in
            for _ in 0..<attempts {
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: interval)
                if Task.isCancelled { return }
                guard let self else { return }
                await self.refreshSummary(for: refKey)
                if !self.isPending(refKey) { return }
            }
        }
        pollTasks[refKey] = task
        await task.value
        // Nur aufräumen, wenn in der Zwischenzeit kein neuerer Poll für
        // dieselbe Ref gestartet wurde (siehe `pollGeneration`-Kommentar oben).
        if pollGeneration[refKey] == myGeneration {
            pollTasks[refKey] = nil
        }
    }

    private func refreshSummary(for refKey: String) async {
        guard let fetched = try? await appState.loadSummaries(refs: [refKey]) else { return }
        if let pair = fetched[refKey] {
            summaries[refKey] = pair
        }
    }

    private func isPending(_ refKey: String) -> Bool {
        let pair = summaries[refKey]
        return pair?.progress?.kind == .pending || pair?.description?.kind == .pending
    }

    // MARK: - Fehler-Normalisierung

    /// Normalisiert jeden von den `AppState`-Summary-Methoden geworfenen
    /// Fehler auf `SummaryError`, damit Aufrufer nur EINEN Fehlertyp
    /// behandeln müssen (analoges Muster zu `ProgressStore.mapError`).
    /// `APIError.unauthorized` (401) wird dabei NICHT generisch kaschiert,
    /// damit die zentrale Re-Login-Behandlung an anderer Stelle der App
    /// weiterhin auf den ursprünglichen `APIError.unauthorized` reagieren
    /// kann (dieses Mapping geschieht erst NACH dem `throw` in `AppState`).
    static func mapError(_ error: Error) -> SummaryError {
        if let e = error as? SummaryError { return e }
        if let e = error as? APIError {
            switch e {
            case .unauthorized: return .server("Sitzung abgelaufen — bitte neu anmelden.")
            case .invalidURL, .network: return .offline
            case .server(let m): return .server(m)
            }
        }
        return .offline
    }
}
