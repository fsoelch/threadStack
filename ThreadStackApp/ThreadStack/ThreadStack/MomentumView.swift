import SwiftUI

// MARK: - Sichtbarer Fortschritt (Arbeitspaket M5) — Hauptansicht
//
// Struktur/Zustände (loading/content/error/empty) folgen exakt dem
// bestehenden Muster aus DigestView.swift (dem einzigen vergleichbaren
// "Wochen-Zusammenfassung"-Screen in dieser App).
struct MomentumView: View {
    @EnvironmentObject var state: AppState
    @State private var settings: MomentumSettings?
    @State private var streak: MomentumStreak?
    @State private var week: MomentumWeek?
    @State private var pauseDays: [String] = []
    @State private var loading = false
    @State private var error: String?
    @State private var newPauseDate = Date()
    @State private var settingsError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if loading && settings == nil {
                    ProgressView("Lade …").frame(maxWidth: .infinity).padding(.top, 24)
                } else if let error {
                    VStack(spacing: 8) {
                        Text(error).foregroundStyle(.red).font(.footnote)
                        Button("Erneut versuchen") { Task { await reload() } }
                    }.frame(maxWidth: .infinity).padding(.top, 24)
                } else if let settings {
                    if streak == nil && week == nil {
                        emptyState
                    } else {
                        cards
                    }
                    settingsSection(settings)
                }
            }
            .padding()
        }
        .navigationTitle("Fortschritt")
        .task { await reload() }
    }

    private var header: some View {
        HStack {
            Text("📈 Fortschritt").font(.title3).fontWeight(.semibold)
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text("Der Fortschritt-Bereich ist deaktiviert.").foregroundStyle(.secondary)
            Text("Aktiviere mindestens einen Baustein unten, um wieder Zahlen zu sehen.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 16)
    }

    @ViewBuilder private var cards: some View {
        if let streak {
            VStack(alignment: .leading, spacing: 6) {
                Text("Tages-Serie").font(.subheadline).fontWeight(.semibold)
                Text("🔥 \(streak.current) \(streak.current == 1 ? "Tag" : "Tage")")
                    .font(.title2).fontWeight(.bold)
                Text(streak.activeToday
                     ? "Heute schon aktiv gewesen."
                     : "Heute noch keine Aktivität - die Serie bleibt bis Tagesende erhalten.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(DS.cardBg).clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
        }
        if let week {
            VStack(alignment: .leading, spacing: 8) {
                Text("Diese Woche").font(.subheadline).fontWeight(.semibold)
                HStack(spacing: 24) {
                    VStack(alignment: .leading) {
                        Text("Neu erfasst").font(.caption2).foregroundStyle(.secondary)
                        Text("\(week.createdCount)").font(.title3).fontWeight(.bold)
                    }
                    VStack(alignment: .leading) {
                        Text("Erledigt").font(.caption2).foregroundStyle(.secondary)
                        Text("\(week.completedCount)").font(.title3).fontWeight(.bold)
                    }
                }
                if week.milestones.isEmpty {
                    Text("Diese Woche noch keine vollständig abgeschlossenen Themen/Kontakte.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(week.milestones) { m in
                        HStack(alignment: .top, spacing: 6) {
                            Text("✓").foregroundStyle(DS.green).fontWeight(.bold)
                            Text("\(m.type == "topic" ? "Thema" : "Kontakt") „\(m.name)“ abgeschlossen")
                                .font(.footnote)
                        }
                    }
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(DS.cardBg).clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
        }
    }

    private func settingsSection(_ settings: MomentumSettings) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Einstellungen").font(.subheadline).fontWeight(.semibold)
            Toggle("Erledigt-Moment anzeigen", isOn: settingBinding(\.completionToastEnabled, field: "completionToastEnabled"))
            Toggle("Tages-Serie anzeigen", isOn: settingBinding(\.streakEnabled, field: "streakEnabled"))
            Toggle("Wochen-Rückblick anzeigen", isOn: settingBinding(\.weeklyReviewEnabled, field: "weeklyReviewEnabled"))
            if let settingsError {
                Text(settingsError).font(.caption).foregroundStyle(.red)
            }
            pauseDaysSection
        }
        .padding(12)
        .background(DS.cardBg).clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
    }

    // Rein informativ fuer die DatePicker-Obergrenze - die verbindliche
    // Pruefung des 90-Tage-Planungshorizonts (Requirements-Freigabe) liegt
    // serverseitig in lib/momentum/queries.js#addPauseDay.
    private var maxPauseDate: Date {
        Calendar.current.date(byAdding: .day, value: 90, to: Date()) ?? Date()
    }

    private var pauseDaysSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().padding(.vertical, 4)
            Text("Pausentage (unterbrechen die Serie nicht)").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
            HStack {
                DatePicker("", selection: $newPauseDate, in: Date()...maxPauseDate, displayedComponents: .date)
                    .labelsHidden()
                Button("Als Pause markieren") { Task { await addPauseDay() } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            if pauseDays.isEmpty {
                Text("Keine Pausentage geplant.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(pauseDays, id: \.self) { day in
                    HStack {
                        Text(day).font(.footnote)
                        Spacer()
                        Button {
                            Task { await removePauseDay(day) }
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func settingBinding(_ path: WritableKeyPath<MomentumSettings, Bool>, field: String) -> Binding<Bool> {
        Binding(
            get: { settings?[keyPath: path] ?? true },
            set: { newValue in
                let previous = settings?[keyPath: path] ?? true
                settings?[keyPath: path] = newValue
                Task {
                    do {
                        settings = try await state.momentumSaveSettings([field: newValue])
                        settingsError = nil
                        await reloadOverviewOnly()
                    } catch {
                        settings?[keyPath: path] = previous
                        settingsError = "Einstellung konnte nicht gespeichert werden."
                    }
                }
            }
        )
    }

    private func reload() async {
        loading = true; error = nil
        do {
            let overview = try await state.momentumOverview()
            settings = overview.settings; streak = overview.streak; week = overview.week
            pauseDays = try await state.momentumPauseDays()
        } catch {
            self.error = "Fortschrittsdaten konnten nicht geladen werden."
        }
        loading = false
    }

    private func reloadOverviewOnly() async {
        guard let overview = try? await state.momentumOverview() else { return }
        streak = overview.streak; week = overview.week
    }

    private func addPauseDay() async {
        let fmt = ISO8601DateFormatter(); fmt.formatOptions = [.withFullDate]
        do {
            try await state.momentumAddPauseDay(fmt.string(from: newPauseDate))
            pauseDays = try await state.momentumPauseDays()
        } catch {
            settingsError = "Pausentag konnte nicht gespeichert werden."
        }
    }

    private func removePauseDay(_ day: String) async {
        do {
            try await state.momentumRemovePauseDay(day)
            pauseDays.removeAll { $0 == day }
        } catch {
            settingsError = "Pausentag konnte nicht entfernt werden."
        }
    }
}
