import SwiftUI

// MARK: - Pure helpers (internal, testable via @testable import)

/// Formatiert einen Cent-Betrag als deutsche Euro-Anzeige, z. B. 1234 -> "12,34 €".
func linkInsertFormatEuro(cents: Int) -> String {
    let euros = Double(cents) / 100.0
    return String(format: "%.2f", euros).replacingOccurrences(of: ".", with: ",") + " €"
}

/// Klartext-Format "nur Link" gemäß Schnittstellenvertrag: `🔗 FINAL_URL`.
func linkInsertLinkOnlyText(_ link: String) -> String {
    "🔗 \(link)"
}

/// Klartext-Format "Link + Zusammenfassung" gemäß Schnittstellenvertrag:
/// `🔗 FINAL_URL\n\n✨ KI-Zusammenfassung: SUMMARY_TEXT`.
func linkInsertSummaryText(link: String, summary: String) -> String {
    "🔗 \(link)\n\n✨ KI-Zusammenfassung: \(summary)"
}

/// Deutsche Fehlermeldung für einen von `/api/ai/link/fetch` bzw. `/api/ai/link/summarize`
/// gelieferten Fehlercode. Unbekannte/Feature-Gating-Codes fallen auf die Server-Nachricht
/// zurück (die bereits deutschsprachig ist).
func linkInsertMapError(_ e: APIAIError) -> String {
    switch e.code {
    case "invalid_url":              return "Keine gültige http/https-Adresse."
    case "blocked_target":           return "Diese Adresse kann nicht abgerufen werden."
    case "no_text_content":          return "Auf der Seite wurde zu wenig Text gefunden."
    case "fetch_timeout":            return "Die Seite hat nicht rechtzeitig geantwortet."
    case "fetch_failed":             return "Die Seite ist nicht erreichbar."
    case "too_large":                return "Die Seite ist zu groß."
    case "unsupported_content_type": return "Dieser Inhaltstyp lässt sich nicht zusammenfassen."
    case "empty_summary":            return "Die KI hat keine Zusammenfassung geliefert."
    case "page_token_expired":       return "Der Seiteninhalt ist nicht mehr verfügbar, bitte erneut laden."
    case "fetch_http_error":         return "Die Seite konnte nicht geladen werden."
    case "too_many_redirects":       return "Zu viele Weiterleitungen."
    case "fetch_in_progress":        return "Ein Abruf läuft bereits, bitte kurz warten."
    case "invalid_length":           return "Ungültige Länge ausgewählt."
    case "budget_exceeded":          return "Monatliches KI-Budget ist erreicht."
    default:
        if e.budgetExceeded { return "Monatliches KI-Budget ist erreicht." }
        return e.message
    }
}

/// Sheet zum Einfügen eines Links in eine (reine Klartext-)Beschreibung, optional
/// ergänzt um eine KI-Zusammenfassung der Zielseite. Die native App hat keinen
/// Rich-Text-Editor — der resultierende Text wird deshalb als einfacher, an die
/// Beschreibung angehängter Absatz übergeben (kein klickbarer Link, keine Formatierung).
struct LinkInsertSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    /// Fertiger Text, der an die Beschreibung angehängt werden soll.
    let onInsert: (String) -> Void

    @State private var url = ""
    @State private var mode: Mode = .link
    @State private var length: Length = .medium
    @State private var loading = false
    @State private var preview: String?
    @State private var pageToken: String?
    @State private var finalUrl: String?
    @State private var title: String?
    @State private var error: String?
    @State private var needsConfirmation = false
    @State private var estimatedCostCents: Int?
    @State private var task: Task<Void, Never>?

    enum Mode: String, Hashable { case link, summary }
    enum Length: String, Hashable { case short, medium, long }

    private var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var linkSummaryFeatureOn: Bool { state.aiSettings?.features_enabled.linkSummaryOn ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section("Link") {
                    TextField("https://…", text: $url)
                        .urlKeyboard()
                        .noAutocapitalize()
                        .autocorrectionDisabled()
                        .onChange(of: url) { _, _ in resetFetchState() }
                }

                Section("Einfügen als") {
                    Picker("Einfügen als", selection: $mode) {
                        Text("Nur Link").tag(Mode.link)
                        Text("Link + KI-Zusammenfassung").tag(Mode.summary)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    if !linkSummaryFeatureOn {
                        Text("Die KI-Zusammenfassung ist für dein Konto aktuell nicht aktiviert. Du kannst sie trotzdem ausprobieren — falls sie serverseitig deaktiviert ist, erscheint eine entsprechende Meldung.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if mode == .summary {
                    summarySection
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red).font(.footnote)
                        if !trimmedURL.isEmpty {
                            Button("Nur Link einfügen") {
                                onInsert(linkInsertLinkOnlyText(finalUrl ?? trimmedURL))
                                dismiss()
                            }
                        }
                    }
                }
            }
            .navigationTitle("Link einfügen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { task?.cancel(); dismiss() }
                }
                if mode == .link || preview == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(mode == .link ? "Link einfügen" : "Zusammenfassung erzeugen") {
                            primaryAction()
                        }
                        .disabled(trimmedURL.isEmpty || loading)
                    }
                }
            }
        }
    }

    @ViewBuilder private var summarySection: some View {
        Section {
            Picker("Länge", selection: $length) {
                Text("Kurz").tag(Length.short)
                Text("Mittel").tag(Length.medium)
                Text("Lang").tag(Length.long)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: length) { _, _ in preview = nil }
        } header: {
            Text("Länge")
        } footer: {
            Text("Der Inhalt der Zielseite wird zur Zusammenfassung an den konfigurierten KI-Anbieter übertragen.")
        }

        if loading {
            Section {
                HStack {
                    ProgressView("Erzeuge Zusammenfassung …")
                    Spacer()
                    Button("Abbrechen", role: .cancel) {
                        task?.cancel()
                        loading = false
                    }
                }
            }
        }

        if needsConfirmation {
            Section {
                Text(confirmationHintText)
                    .font(.footnote)
                Button("Trotzdem erzeugen") {
                    task = Task { await generateSummary(confirm: true) }
                }
                .disabled(loading)
            }
        }

        if let preview {
            Section("Vorschau") {
                Text(preview).font(.callout)
                HStack {
                    Button("Neu erzeugen") {
                        task = Task { await generateSummary() }
                    }
                    .disabled(loading)
                    Spacer()
                    Button("Übernehmen") {
                        onInsert(linkInsertSummaryText(link: finalUrl ?? trimmedURL, summary: preview))
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private var confirmationHintText: String {
        if let cents = estimatedCostCents {
            return "Geschätzte Kosten: \(linkInsertFormatEuro(cents: cents)). Trotzdem erzeugen?"
        }
        return "Diese Anfrage könnte Kosten verursachen. Trotzdem erzeugen?"
    }

    private func primaryAction() {
        error = nil
        if mode == .link {
            onInsert(linkInsertLinkOnlyText(trimmedURL))
            dismiss()
        } else {
            task = Task { await generateSummary() }
        }
    }

    /// Eingegebene URL geändert — vorheriger Fetch/Vorschau gehört zur alten URL und wird verworfen.
    private func resetFetchState() {
        pageToken = nil; finalUrl = nil; title = nil
        preview = nil; needsConfirmation = false; estimatedCostCents = nil
        error = nil
    }

    private func generateSummary(confirm: Bool = false) async {
        loading = true
        error = nil
        if !confirm { needsConfirmation = false }
        defer { loading = false }
        do {
            var token = pageToken
            if token == nil {
                let f = try await state.aiLinkFetch(url: trimmedURL)
                if Task.isCancelled { return }
                pageToken = f.page_token
                finalUrl = f.final_url
                title = f.title
                token = f.page_token
            }
            guard let token else { return }
            let r = try await state.aiLinkSummarize(pageToken: token, length: length.rawValue, confirm: confirm)
            if Task.isCancelled { return }
            preview = r.summary
            needsConfirmation = false
        } catch let e as APIAIError where e.needsConfirmation {
            needsConfirmation = true
            estimatedCostCents = e.detail?.estimated_cost_cents
        } catch let e as APIAIError {
            if e.code == "page_token_expired" { pageToken = nil }
            error = linkInsertMapError(e)
        } catch is CancellationError {
            // Nutzer hat abgebrochen — kein Fehlertext nötig.
        } catch {
            self.error = "Unbekannter Fehler beim Abrufen der Seite."
        }
    }
}
