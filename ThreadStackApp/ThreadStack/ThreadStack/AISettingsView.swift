import SwiftUI

struct AISettingsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    @State private var provider:  String = ""
    @State private var model:     String = ""
    @State private var apiKey:    String = ""
    @State private var azureEndpoint:   String = ""
    @State private var azureApiVersion: String = ""
    @State private var budgetCents:    Int = 0
    @State private var thresholdCents: Int = 10
    @State private var globallyDisabled: Bool = false
    @State private var features = AIFeatures.defaults
    @State private var driftDays:      Int    = 21
    @State private var themeThreshold: Double = 0.7
    @State private var digestEnabled:  Bool   = false
    @State private var digestDow:      Int    = 0
    @State private var digestHour:     Int    = 18

    @State private var loading = false
    @State private var testResult: String?
    @State private var error: String?
    @State private var usage: AIUsageResponse?

    private let providers: [(value: String, label: String)] = [
        ("", "— bitte wählen —"),
        ("anthropic", "Anthropic (Claude)"),
        ("openai",    "OpenAI"),
        ("azure",     "Azure OpenAI"),
    ]
    private let modelDefaults: [String: [String]] = [
        "anthropic": ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
        "openai":    ["gpt-5", "gpt-5-mini", "gpt-4o"],
        "azure":     [],
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Provider & Modell") {
                    Picker("Provider", selection: $provider) {
                        ForEach(providers, id: \.value) { p in Text(p.label).tag(p.value) }
                    }
                    TextField("Modell", text: $model)
                        .autocorrectionDisabled().noAutocapitalize()
                    if let opts = modelDefaults[provider], !opts.isEmpty {
                        Text("Übliche Modelle: " + opts.joined(separator: ", "))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if provider == "azure" {
                        TextField("Azure Endpoint", text: $azureEndpoint)
                            .autocorrectionDisabled().noAutocapitalize()
                        TextField("API-Version", text: $azureApiVersion)
                            .autocorrectionDisabled().noAutocapitalize()
                    }
                }

                Section("API-Key") {
                    if let last4 = state.aiSettings?.api_key_last4, !last4.isEmpty {
                        Text("Gespeichert: ••••\(last4)").font(.footnote).foregroundStyle(.secondary)
                    }
                    SecureField("Neuen Key hier eintragen", text: $apiKey)
                    HStack {
                        Button("Verbindung testen") { Task { await testConnection() } }
                            .buttonStyle(.bordered)
                        Button("Key entfernen", role: .destructive) { Task { await removeKey() } }
                            .buttonStyle(.bordered)
                    }
                    if let testResult { Text(testResult).font(.caption).foregroundStyle(.secondary) }
                }

                Section("Features") {
                    Toggle("Pre-Meeting-Briefing", isOn: $features.brief)
                    Toggle("Notizen-Erfassung",    isOn: $features.capture)
                    Toggle("Ergebnis-Vorschlag",   isOn: $features.result_draft)
                    Toggle("Re-Entry-Briefing",    isOn: $features.reentry)
                    Toggle("Auto-Theme-Tagging",   isOn: $features.theme_tagging)
                    Toggle("Wochen-Digest",        isOn: $features.digest)
                    Toggle("Cross-Meeting-Insight",isOn: $features.cross_meeting)
                    Toggle("Drift-Detection",      isOn: $features.drift)
                    Toggle("Link-Zusammenfassung",  isOn: Binding(
                        get: { features.linkSummaryOn },
                        set: { features.link_summary = $0 }
                    ))
                }

                Section("Budget & Bestätigung") {
                    HStack { Text("Monats-Budget (Cent)"); Spacer()
                        TextField("0", value: $budgetCents, format: .number)
                            .multilineTextAlignment(.trailing).numberKeyboard()
                    }
                    HStack { Text("Bestätigungs-Schwelle (Cent)"); Spacer()
                        TextField("10", value: $thresholdCents, format: .number)
                            .multilineTextAlignment(.trailing).numberKeyboard()
                    }
                    Toggle("AI komplett deaktivieren", isOn: $globallyDisabled)
                }

                Section("Übergreifende Analysen") {
                    HStack { Text("Drift-Schwelle (Tage)"); Spacer()
                        TextField("21", value: $driftDays, format: .number)
                            .multilineTextAlignment(.trailing).numberKeyboard()
                    }
                    HStack { Text("Theme-Tag-Schwelle"); Spacer()
                        TextField("0.7", value: $themeThreshold, format: .number.precision(.fractionLength(2)))
                            .multilineTextAlignment(.trailing).numberKeyboard()
                    }
                    Toggle("Wochen-Digest automatisch", isOn: $digestEnabled)
                    Picker("Wochentag", selection: $digestDow) {
                        Text("Sonntag").tag(0); Text("Montag").tag(1); Text("Dienstag").tag(2)
                        Text("Mittwoch").tag(3); Text("Donnerstag").tag(4); Text("Freitag").tag(5)
                        Text("Samstag").tag(6)
                    }
                    HStack { Text("Stunde (0–23)"); Spacer()
                        TextField("18", value: $digestHour, format: .number)
                            .multilineTextAlignment(.trailing).numberKeyboard()
                    }
                }

                if let u = usage {
                    Section("Verbrauch (\(u.period))") {
                        HStack { Text("Gesamt:"); Spacer(); Text("\(u.total_cost_cents) Cent").fontWeight(.semibold) }
                        ForEach(u.entries) { e in
                            HStack {
                                Text(e.feature).font(.caption)
                                Spacer()
                                Text("\(e.calls)× · \(e.cost_cents) Cent").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("AI-Einstellungen")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { Task { await save() } }.disabled(loading)
                }
            }
            .task { await loadInitial() }
        }
    }

    private func loadInitial() async {
        await state.loadAiSettings()
        guard let s = state.aiSettings else { return }
        provider = s.provider; model = s.model
        azureEndpoint = s.azure_endpoint; azureApiVersion = s.azure_api_version
        budgetCents = s.max_monthly_cost_cents
        thresholdCents = s.confirm_threshold_cents
        globallyDisabled = s.globally_disabled
        features = s.features_enabled
        driftDays      = s.drift_days ?? 21
        themeThreshold = s.theme_tag_threshold ?? 0.7
        digestEnabled  = s.weekly_digest_enabled ?? false
        digestDow      = s.weekly_digest_dow ?? 0
        digestHour     = s.weekly_digest_hour ?? 18
        usage = try? await state.aiUsage(period: "month")
    }

    private func save() async {
        loading = true; error = nil
        var body: [String: Any] = [
            "provider": provider, "model": model,
            "azure_endpoint": azureEndpoint, "azure_api_version": azureApiVersion,
            "max_monthly_cost_cents": budgetCents,
            "confirm_threshold_cents": thresholdCents,
            "globally_disabled": globallyDisabled,
            "features_enabled": [
                "brief":         features.brief,
                "capture":       features.capture,
                "result_draft":  features.result_draft,
                "reentry":       features.reentry,
                "theme_tagging": features.theme_tagging,
                "digest":        features.digest,
                "cross_meeting": features.cross_meeting,
                "drift":         features.drift,
                "link_summary":  features.linkSummaryOn,
            ],
            "drift_days": driftDays,
            "theme_tag_threshold": themeThreshold,
            "weekly_digest_enabled": digestEnabled,
            "weekly_digest_dow": digestDow,
            "weekly_digest_hour": digestHour,
        ]
        if !apiKey.isEmpty { body["api_key"] = apiKey }
        do { _ = try await state.saveAiSettings(body); apiKey = "" }
        catch { self.error = error.localizedDescription }
        loading = false
    }

    private func testConnection() async {
        testResult = "teste …"
        await save()
        do {
            let ok = try await state.testAiConnection()
            testResult = ok ? "✓ Verbindung OK" : "Fehler"
        } catch { testResult = "Fehler: \(error.localizedDescription)" }
    }

    private func removeKey() async {
        do { try await state.removeAiKey(); apiKey = "" }
        catch { self.error = error.localizedDescription }
    }
}
