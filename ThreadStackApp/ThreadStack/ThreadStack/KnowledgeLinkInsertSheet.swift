import SwiftUI
import Foundation

// MARK: - Pure helpers (internal, testable via @testable import)
//
// Diese Datei ist Teil von Arbeitspaket 3 ("knowledge-link") des Features
// "Nativer Rich-Text-Editor für Wissen (iOS/macOS)". Sie liefert ein Sheet,
// das (anders als `LinkInsertSheet.swift`, das reinen Klartext zurückgibt)
// ein strukturiertes `KnowledgeLinkResult` zurückgibt. Das eigentliche
// Einfügen als formatiertes Rich-Text-Element inkl. HTML-Escaping übernimmt
// erst Arbeitspaket 6/2 über die JS-Bridge — dieses Sheet liefert bewusst nur
// rohe Strings und konstruiert selbst kein HTML.
//
// Wiederverwendet werden ausschließlich (rein lesend, unverändert) aus
// `LinkInsertSheet.swift`:
//   - linkInsertNormalizeUrl(_:)
//   - linkInsertMapError(_:)
//   - linkInsertFormatEuro(cents:)
// sowie aus `AppState.swift`:
//   - AppState.aiLinkFetch(url:)
//   - AppState.aiLinkSummarize(pageToken:length:confirm:)

/// Ergebnis des Link-Einfüge-Dialogs für den Wissens-Editor. Wird von Paket 6
/// über die JS-Bridge (Paket 2) als formatiertes Rich-Text-Element eingefügt.
/// `summaryParagraphs` ist bei Modus "Nur Link" leer.
struct KnowledgeLinkResult: Equatable {
    let href: String
    let text: String
    let summaryParagraphs: [String]
}

/// Teilt einen KI-Zusammenfassungstext an Absätzen (eine oder mehrere Leerzeilen)
/// auf, trimmt jeden Absatz und verwirft leere Elemente. Reine Hilfsfunktion ohne
/// jegliche HTML-Konstruktion — die Bridge (Paket 2) übernimmt das Escaping.
func knowledgeLinkSplitSummary(_ s: String) -> [String] {
    s.split(separator: /\n\n+/, omittingEmptySubsequences: true)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

/// Prüft, ob eine (ggf. schemalose) Eingabe nach `linkInsertNormalizeUrl` eine
/// gültige http/https-URL mit vorhandenem Host ergibt. Verwendet ausschließlich
/// die bestehende Normalisierungsfunktion, keine eigene Schema-Regex.
func knowledgeLinkIsValidHttpURL(_ s: String) -> Bool {
    let normalized = linkInsertNormalizeUrl(s)
    guard !normalized.isEmpty else { return false }
    guard let components = URLComponents(string: normalized) else { return false }
    guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
        return false
    }
    guard let host = components.host, !host.isEmpty else { return false }
    return true
}

/// Sheet zum Einfügen eines Links (optional mit KI-Zusammenfassung) in den
/// nativen Rich-Text-Editor für Wissen. Liefert im Gegensatz zu
/// `LinkInsertSheet` ein strukturiertes `KnowledgeLinkResult` statt Klartext.
struct KnowledgeLinkInsertSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    /// Vom Editor übergebener, aktuell markierter Text (falls vorhanden), ≤200 Zeichen.
    let selectedText: String
    let onInsert: (KnowledgeLinkResult) -> Void

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
    private var trimmedSelectedText: String { selectedText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var linkSummaryFeatureOn: Bool { state.aiSettings?.features_enabled.linkSummaryOn ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section("Link") {
                    TextField("https://…", text: $url)
                        .urlKeyboard()
                        .noAutocapitalize()
                        .autocorrectionDisabled()
                        .accessibilityLabel("Adresse")
                        .onChange(of: url) { _, _ in resetFetchState() }

                    if trimmedURL.isEmpty {
                        Text("Bitte eine Adresse eingeben.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Bitte eine Adresse eingeben.")
                    }
                }

                Section("Einfügen als") {
                    Picker("Einfügen als", selection: $mode) {
                        Text("Nur Link").tag(Mode.link)
                        Text("Link + KI-Zusammenfassung").tag(Mode.summary)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityLabel("Einfügen als")
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
                                insertLinkOnly()
                            }
                            .accessibilityLabel("Nur Link einfügen")
                        }
                    }
                }
            }
            .navigationTitle("Link einfügen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { task?.cancel(); dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityLabel("Abbrechen")
                }
                if mode == .link || preview == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(mode == .link ? "Link einfügen" : "Zusammenfassung erzeugen") {
                            primaryAction()
                        }
                        .keyboardShortcut(.defaultAction)
                        .disabled(trimmedURL.isEmpty || loading)
                        .accessibilityLabel(mode == .link ? "Link einfügen" : "Zusammenfassung erzeugen")
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
            .accessibilityLabel("Länge der Zusammenfassung")
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
                    .accessibilityLabel("Abbrechen")
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
                .accessibilityLabel("Trotzdem erzeugen")
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
                    .accessibilityLabel("Neu erzeugen")
                    Spacer()
                    Button("Übernehmen") {
                        insertSummary(preview)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel("Übernehmen")
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

    /// Linktext gemäß UX-Vorgabe: markierter Text, falls vorhanden, sonst die
    /// URL selbst.
    private func linkOnlyDisplayText(href: String) -> String {
        trimmedSelectedText.isEmpty ? href : trimmedSelectedText
    }

    /// Fügt den reinen Link ein. Validiert die URL erneut, auch wenn dies der
    /// "Nur Link einfügen"-Fallback nach einem Fehler ist — es darf niemals eine
    /// unzulässige (z. B. `javascript:`-)URL an `onInsert` gelangen.
    private func insertLinkOnly() {
        let href = linkInsertNormalizeUrl(finalUrl ?? trimmedURL)
        guard knowledgeLinkIsValidHttpURL(href) else {
            error = trimmedURL.isEmpty
                ? "Bitte eine Adresse eingeben."
                : "Bitte eine gültige URL eingeben (z. B. https://example.com)."
            return
        }
        onInsert(KnowledgeLinkResult(href: href, text: linkOnlyDisplayText(href: href), summaryParagraphs: []))
        dismiss()
    }

    private func insertSummary(_ summary: String) {
        let href = linkInsertNormalizeUrl(finalUrl ?? trimmedURL)
        guard knowledgeLinkIsValidHttpURL(href) else {
            error = "Bitte eine gültige URL eingeben (z. B. https://example.com)."
            return
        }
        let text = title ?? (trimmedSelectedText.isEmpty ? href : trimmedSelectedText)
        onInsert(KnowledgeLinkResult(href: href, text: text, summaryParagraphs: knowledgeLinkSplitSummary(summary)))
        dismiss()
    }

    private func primaryAction() {
        error = nil
        guard knowledgeLinkIsValidHttpURL(trimmedURL) else {
            error = trimmedURL.isEmpty
                ? "Bitte eine Adresse eingeben."
                : "Bitte eine gültige URL eingeben (z. B. https://example.com)."
            return
        }
        if mode == .link {
            insertLinkOnly()
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
                let f = try await state.aiLinkFetch(url: linkInsertNormalizeUrl(trimmedURL))
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
