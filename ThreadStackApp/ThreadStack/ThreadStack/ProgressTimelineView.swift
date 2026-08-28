//
//  ProgressTimelineView.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI-Bausteine Progress"): zeigt den nächsten Schritt
//  und den chronologischen Zwischenstand-Verlauf eines Vorhabens. Das frühere
//  "Zielbild" entfällt laut Produktentscheidung vollständig, ersatzlos, aus
//  der App-UI (`ProgressDetail.goal` ist DEPRECATED) — dieser Baustein zeigt/
//  editiert es nirgends mehr.
//  Reiner Inhaltsbaustein (kein eigener `NavigationStack`/Titel) — wird von
//  Paket A3 in bestehende Detail-Screens eingebettet (`TodosView`,
//  `TodoFormView`, `MeetingDetailView`, `StackViews`).
//
//  Wiederverwendet ausschließlich bestehende Bausteine: `HTMLContentView`
//  für gerenderten `bodyHtml`, das `.confirmationDialog`-Muster aus
//  `StackPopSheet`/`TodosView` für die Lösch-Bestätigung, `scaledFont` für
//  alle Texte.
//
//  Arbeitspaket A1 (UX-Nachbesserung "Zielbild und Fortschrittsverlauf"):
//  fest in `TodoFormView`/`TopicFormView` eingebettet statt in einem
//  separaten Sheet zu leben (`ProgressHistorySheet` entfällt, wird von
//  Paket A2 dieser Nachbesserung entfernt). Nimmt den immer sichtbaren
//  Composer (`ProgressEntryComposerView`) sowie die Wiedereinstiegskarte
//  (`ProgressReentryCardView`) als generische `@ViewBuilder`-Slots entgegen,
//  statt sie selbst zu instanziieren — der einbettende Aufrufer (Paket A2)
//  entscheidet, WIE der Composer angebunden wird (Fokus-State etc.), diese
//  View bestimmt nur noch die verbindliche REIHENFOLGE:
//  Composer → Nächster Schritt → Wiedereinstiegskarte → Verlauf.
//  `composer()`/`reentry()` werden dabei UNABHÄNGIG vom Ladezustand des
//  restlichen Bereichs gerendert (siehe `body` unten) — nur Nächster-
//  Schritt/Trenner/Verlauf schalten auf Lade-/Fehleranzeige um.
//
//  Der bisherige interne "+ Zwischenstand erfassen"-Einstieg (Kopfzeile UND
//  Empty-State) entfällt ersatzlos, da das Erfassen jetzt ausschließlich
//  über den immer sichtbaren, von außen übergebenen Composer läuft (siehe
//  CLAUDE.md "Wiederverwendung vor Neuentwicklung" — kein zweiter, paralleler
//  Erfassungs-Einstieg neben dem Composer).
//

import SwiftUI

// MARK: - Reine Logik (testbar)

/// Entscheidet, ob ein langer Zwischenstand gekürzt (Excerpt + "Mehr
/// anzeigen") oder direkt vollständig gerendert wird. Vergleicht den vom
/// Server gelieferten `excerpt` gegen den reinen Textinhalt von `bodyHtml`
/// (über das bestehende `stripHTML`-Hilfsmittel aus `Extensions.swift`) —
/// weichen sie voneinander ab, wurde server-seitig gekürzt.
enum ProgressEntryTruncation {
    static func isTruncated(excerpt: String, bodyHtml: String) -> Bool {
        let trimmedExcerpt = excerpt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedExcerpt.isEmpty else { return false }
        let plainBody = stripHTML(bodyHtml).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedExcerpt != plainBody
    }
}

/// Datumsformatierung (absolut + relativ, deutsch) für Einträge im Verlauf.
enum ProgressDateFormatting {
    /// z.B. "23. August 2026, 10:15 · vor 2 Tagen". `nil`, wenn `iso` nicht
    /// geparst werden kann (defensiv gegen unerwartete Server-Werte).
    static func absoluteAndRelative(_ iso: String, now: Date = Date()) -> String? {
        guard let date = parseFlexDate(iso) else { return nil }
        let absolute = absoluteFormatter.string(from: date)
        let relative = relativeFormatter.localizedString(for: date, relativeTo: now)
        return "\(absolute) · \(relative)"
    }

    /// z.B. "bearbeitet am 24. August 2026, 09:00". `nil` bei fehlendem/
    /// nicht parsbarem `editedAtISO`.
    static func editedSuffix(_ editedAtISO: String?) -> String? {
        guard let editedAtISO, let date = parseFlexDate(editedAtISO) else { return nil }
        return "bearbeitet am \(absoluteFormatter.string(from: date))"
    }

    private static let absoluteFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.unitsStyle = .full
        return f
    }()
}

/// Formatiert den Ruhephasen-Marker ("🌙 3 Wochen Pause") aus der vom Server
/// gelieferten reinen Tagesanzahl (`ProgressEntry.gapDaysBefore`) — der
/// Server liefert dafür (anders als für `ProgressReentry.dormantLabel`) kein
/// fertiges Label, daher eigene, einfache Rundung Tage/Wochen/Monate.
enum ProgressDormancyFormatting {
    static func label(gapDays: Int) -> String {
        "🌙 \(durationText(gapDays)) Pause"
    }

    static func accessibilityLabel(gapDays: Int) -> String {
        "Ruhephase: \(durationText(gapDays)) ohne Zwischenstand"
    }

    static func durationText(_ gapDays: Int) -> String {
        let days = max(gapDays, 0)
        if days < 14 {
            return days == 1 ? "1 Tag" : "\(days) Tage"
        }
        if days < 60 {
            let weeks = days / 7
            return weeks == 1 ? "1 Woche" : "\(weeks) Wochen"
        }
        let months = days / 30
        return months == 1 ? "1 Monat" : "\(months) Monate"
    }
}

/// Konfigurationskonstanten für den in `TodoFormView`/`TopicFormView`
/// eingebetteten Fortschrittsverlauf. Bewusst außerhalb der generischen
/// `ProgressTimelineView` gehalten — Swift erlaubt keine gespeicherten
/// `static`-Properties in generischen Typen ("static stored properties not
/// supported in generic types").
enum ProgressTimelineConfig {
    /// Seitengröße ist laut UX-Vorgabe bewusst auf 3 reduziert (statt des
    /// sonst üblichen Defaults von 20) — der Nutzer lädt bei Bedarf über
    /// "Weitere laden" nach.
    static let embeddedPageSize = 3

    /// Bewusst ein generischer, gleichbleibender Text statt der spezifischen
    /// `ProgressError.errorDescription` — UX-Vorgabe für den eingebetteten
    /// Fortschrittsverlauf-Bereich. Der Rest des Formulars bleibt
    /// währenddessen unverändert bedienbar, da dieser Fehlerzustand nur den
    /// Verlaufsbereich selbst betrifft.
    static let embeddedLoadErrorText = "Das hat leider nicht geklappt. Bitte später erneut versuchen."
}

// MARK: - View

struct ProgressTimelineView<Composer: View, Reentry: View>: View {
    let refType: String
    let refId: String
    @ObservedObject var store: ProgressStore
    /// Rohes HTML der Beschreibung des zugehörigen Todos/Themas — wird
    /// unverändert an `ProgressEntryEditorSheet` durchgereicht (Kontextzeile
    /// beim Bearbeiten eines Zwischenstands, siehe dortige Doku). `nil`
    /// (Default) erhält das bisherige Verhalten für Aufrufer ohne
    /// Beschreibungs-Kontext.
    var descriptionHTML: String? = nil
    private let composerContent: () -> Composer
    private let reentryContent: () -> Reentry

    @State private var showNextStepEditor = false
    @State private var entrySheetTarget: EntrySheetTarget?
    @State private var deleteCandidate: ProgressEntry?
    @State private var deleteErrorText: String?
    @State private var expandedEntryIds: Set<String> = []

    init(refType: String, refId: String, store: ProgressStore, descriptionHTML: String? = nil,
         @ViewBuilder composer: @escaping () -> Composer,
         @ViewBuilder reentry: @escaping () -> Reentry) {
        self.refType = refType
        self.refId = refId
        self.store = store
        self.descriptionHTML = descriptionHTML
        self.composerContent = composer
        self.reentryContent = reentry
    }

    private struct EntrySheetTarget: Identifiable {
        let id: String
        let entry: ProgressEntry
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // (1) Composer — immer sichtbar, unabhängig vom Ladezustand.
            composerContent()
            // (2) Nächster Schritt — nur im geladenen Zustand.
            headerSection
            // (4) Wiedereinstiegskarte — immer gemountet (verbirgt sich
            // selbst über store.shouldShowReentry, siehe Vertrag), NICHT vom
            // Ladezustand des restlichen Bereichs abhängig.
            reentryContent()
            // (5) Trenner — nur wenn der Verlaufsbereich Inhalt hat.
            if historyAreaHasVisibleContent {
                Divider()
            }
            // (6) Verlauf — Lade-/Fehleranzeige oder Einträge, je nach Zustand.
            historySection
        }
        .task { await loadIfNeeded() }
        .sheet(isPresented: $showNextStepEditor) {
            NextStepEditSheet(
                refType: refType, refId: refId, store: store,
                initialValue: store.detail(refType: refType, refId: refId)?.nextStep ?? ""
            )
        }
        .sheet(item: $entrySheetTarget) { target in
            ProgressEntryEditorSheet(entry: target.entry, refType: refType, refId: refId, store: store,
                                      descriptionHTML: descriptionHTML)
        }
        .confirmationDialog(
            deleteDialogTitle,
            isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("Löschen", role: .destructive) {
                if let entry = deleteCandidate {
                    Task { await performDelete(entry) }
                }
            }
            Button("Abbrechen", role: .cancel) { deleteCandidate = nil }
        }
        .errorAlert($deleteErrorText)
    }

    private func loadIfNeeded() async {
        if store.state(refType: refType, refId: refId) == .idle {
            await store.load(refType: refType, refId: refId, limit: ProgressTimelineConfig.embeddedPageSize)
        }
    }

    /// Ob der Verlaufsbereich (Lade-/Fehleranzeige oder Einträge/Empty-Hinweis)
    /// aktuell sichtbaren Inhalt hat — steuert den Trenner (5), siehe Vertrag
    /// "Divider() nur wenn der Verlaufsbereich Inhalt hat". Bei den aktuell
    /// vier `LoadState`-Fällen trifft das durchgängig zu (Ladeanzeige,
    /// Fehlermeldung, Einträge und der Leer-Hinweis rendern alle sichtbaren
    /// Text) — als expliziter Schalter statt eines fest verdrahteten `true`
    /// gehalten, damit ein künftiger, wirklich inhaltsloser Zwischenzustand
    /// (aktuell nicht Teil des Vertrags) den Trenner sauber ausblenden könnte,
    /// ohne die Aufrufstelle im `body` anzufassen.
    private var historyAreaHasVisibleContent: Bool {
        switch store.state(refType: refType, refId: refId) {
        case .idle, .loading, .failed, .loaded: return true
        }
    }

    @ViewBuilder
    private var headerSection: some View {
        if let detail = store.detail(refType: refType, refId: refId) {
            VStack(alignment: .leading, spacing: 16) {
                nextStepSection(detail: detail)
            }
        }
    }

    @ViewBuilder
    private var historySection: some View {
        switch store.state(refType: refType, refId: refId) {
        case .idle, .loading:
            loadingState
        case .failed(let error):
            errorState(error)
        case .loaded(let detail):
            entriesSection(detail: detail)
        }
    }

    private var loadingState: some View {
        ProgressView("Lädt Fortschritt…")
            .frame(maxWidth: .infinity)
            .padding()
    }

    private func errorState(_ error: ProgressError) -> some View {
        VStack(spacing: 8) {
            Text(ProgressTimelineConfig.embeddedLoadErrorText)
                .scaledFont(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Erneut versuchen") {
                Task { await store.retry(refType: refType, refId: refId, limit: ProgressTimelineConfig.embeddedPageSize) }
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .padding()
    }

    private var deleteDialogTitle: String {
        guard let entry = deleteCandidate else { return "" }
        let excerpt = entry.excerpt.isEmpty ? stripHTML(entry.bodyHtml) : entry.excerpt
        let short = excerpt.count > 80 ? String(excerpt.prefix(80)) + "…" : excerpt
        return "Diesen Zwischenstand löschen? \"\(short)\""
    }

    // MARK: - Nächster Schritt

    private func nextStepSection(detail: ProgressDetail) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Nächster Schritt").scaledFont(.footnote).foregroundStyle(.secondary)
                let trimmed = detail.nextStep.trimmingCharacters(in: .whitespacesAndNewlines)
                Text(trimmed.isEmpty ? "Noch kein nächster Schritt notiert." : trimmed)
                    .scaledFont(.subheadline)
                    .foregroundStyle(trimmed.isEmpty ? .secondary : .primary)
            }
            Spacer()
            Button { showNextStepEditor = true } label: {
                Image(systemName: "pencil")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Nächsten Schritt bearbeiten")
        }
    }

    // MARK: - Verlauf

    private func entriesSection(detail: ProgressDetail) -> some View {
        let entries = store.entries(refType: refType, refId: refId)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Verlauf").scaledFont(.headline)

            if entries.isEmpty {
                emptyState
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(entries) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            if entry.showDormancyMarker {
                                dormancyMarkerRow(gapDays: entry.gapDaysBefore)
                            }
                            entryRow(entry)
                        }
                    }
                }
                paginationSection
            }
        }
    }

    private var emptyState: some View {
        Text("Noch kein Zwischenstand erfasst — trag oben deinen ersten ein.")
            .scaledFont(.subheadline).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding()
    }

    private func dormancyMarkerRow(gapDays: Int) -> some View {
        HStack {
            Text(ProgressDormancyFormatting.label(gapDays: gapDays))
                .scaledFont(.caption).foregroundStyle(.secondary).italic()
            Spacer()
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ProgressDormancyFormatting.accessibilityLabel(gapDays: gapDays))
    }

    @ViewBuilder
    private func entryRow(_ entry: ProgressEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    if entry.kind == "result" {
                        Label("Abschluss aus Stack", systemImage: "checkmark.seal.fill")
                            .scaledFont(.caption2).foregroundStyle(DS.green).fontWeight(.semibold)
                    }
                    if let dateText = ProgressDateFormatting.absoluteAndRelative(entry.createdAt) {
                        Text(dateText).scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                    if let editedText = ProgressDateFormatting.editedSuffix(entry.editedAt) {
                        Text(editedText).scaledFont(.caption2).foregroundStyle(.secondary).italic()
                    }
                }
                Spacer()
                if entry.editable {
                    Button {
                        entrySheetTarget = EntrySheetTarget(id: entry.id, entry: entry)
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Zwischenstand bearbeiten")

                    Button {
                        deleteCandidate = entry
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Zwischenstand löschen")
                }
            }
            entryContent(entry)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: DS.radiusM)
                .fill(entry.kind == "result" ? DS.green.opacity(0.08) : DS.cardBg)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DS.radiusM)
                .strokeBorder(entry.kind == "result" ? DS.green.opacity(0.3) : Color.clear)
        )
    }

    @ViewBuilder
    private func entryContent(_ entry: ProgressEntry) -> some View {
        if ProgressEntryTruncation.isTruncated(excerpt: entry.excerpt, bodyHtml: entry.bodyHtml) {
            if expandedEntryIds.contains(entry.id) {
                HTMLContentView(html: entry.bodyHtml)
                Button("Weniger anzeigen") { expandedEntryIds.remove(entry.id) }
                    .buttonStyle(.plain).scaledFont(.caption).foregroundStyle(DS.accent)
                    .accessibilityLabel("Weniger anzeigen")
            } else {
                Text(entry.excerpt).scaledFont(.subheadline)
                Button("Mehr anzeigen") { expandedEntryIds.insert(entry.id) }
                    .buttonStyle(.plain).scaledFont(.caption).foregroundStyle(DS.accent)
                    .accessibilityLabel("Mehr anzeigen")
            }
        } else {
            HTMLContentView(html: entry.bodyHtml)
        }
    }

    private var loadMoreKey: String { "\(refType):\(refId)" }

    @ViewBuilder
    private var paginationSection: some View {
        if store.hasMoreEntries(refType: refType, refId: refId) {
            VStack(spacing: 4) {
                if store.isLoadingMore.contains(loadMoreKey) {
                    ProgressView()
                } else {
                    Button("Weitere laden") {
                        Task { await store.loadMoreEntries(refType: refType, refId: refId, limit: ProgressTimelineConfig.embeddedPageSize) }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Weitere Einträge laden")
                }
                if let err = store.loadMoreError[loadMoreKey] {
                    Text(err.errorDescription ?? "Fehler beim Laden.")
                        .scaledFont(.caption).foregroundStyle(.red)
                        .accessibilityLabel(err.errorDescription ?? "Fehler beim Laden weiterer Einträge.")
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func performDelete(_ entry: ProgressEntry) async {
        do {
            try await store.deleteEntry(refType: refType, refId: refId, entryId: entry.id)
            deleteCandidate = nil
        } catch {
            deleteErrorText = (error as? ProgressError)?.errorDescription ?? error.localizedDescription
            deleteCandidate = nil
        }
    }
}

// MARK: - Komfort-Init ohne Composer/Reentry-Slot

/// Rückwärtskompatibler Initializer OHNE `composer`/`reentry`-Slots (beide
/// rendern dann `EmptyView`). Wird u.a. von `ProgressHistorySheet` genutzt,
/// die ihre Wiedereinstiegskarte weiterhin selbst separat oberhalb dieser
/// View platziert (siehe dortiger Datei-Kopfkommentar) und keinen Composer
/// einbettet.
extension ProgressTimelineView where Composer == EmptyView, Reentry == EmptyView {
    init(refType: String, refId: String, store: ProgressStore) {
        self.init(refType: refType, refId: refId, store: store, composer: { EmptyView() }, reentry: { EmptyView() })
    }
}

// MARK: - Inline "Nächster Schritt"-Editor

/// Kleiner, ausschließlich intern von `ProgressTimelineView` verwendeter
/// Bearbeiten-Dialog für den nächsten Schritt (Klartext-Feld auf
/// `ProgressDetail`, kein eigenständiger Baustein laut Vertrag — daher
/// bewusst `private` statt eigene Datei).
private struct NextStepEditSheet: View {
    let refType: String
    let refId: String
    @ObservedObject var store: ProgressStore
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var loading = false
    @State private var errorText: String?

    init(refType: String, refId: String, store: ProgressStore, initialValue: String) {
        self.refType = refType
        self.refId = refId
        self.store = store
        _text = State(initialValue: initialValue)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Nächster Schritt") {
                    TextField("Was ist als Nächstes dran?", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                }
                if let errorText {
                    Section {
                        Text(errorText).scaledFont(.footnote).foregroundStyle(.red)
                            .accessibilityLabel(errorText)
                    }
                }
            }
            .navigationTitle("Nächster Schritt")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }.disabled(loading)
                        .accessibilityLabel("Speichern")
                }
            }
        }
    }

    private func save() {
        loading = true
        errorText = nil
        Task {
            do {
                try await store.saveNextStep(
                    refType: refType, refId: refId,
                    nextStep: text.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                dismiss()
            } catch {
                errorText = (error as? ProgressError)?.errorDescription ?? error.localizedDescription
                loading = false
            }
        }
    }
}
