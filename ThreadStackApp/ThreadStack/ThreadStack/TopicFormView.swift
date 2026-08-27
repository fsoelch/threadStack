import SwiftUI

/// Reine, von SwiftUI entkoppelte Entscheidungslogik für `TopicFormView.save()`:
/// sobald für das aktuell bearbeitete Thema bereits eine Server-ID bekannt ist
/// — entweder weil ein bestehendes Thema bearbeitet wird ODER weil ein
/// vorheriger Speicherversuch im Anlegen-Modus das Thema bereits erfolgreich
/// angelegt hat (nur der anschliessende, optionale Zwischenstand-Commit ist
/// danach fehlgeschlagen, siehe `createdId`) — MUSS der nächste
/// Speicherversuch ein Update sein, niemals ein zweites Create (sonst
/// Duplikat, Security Review, Mittel: Fund 1).
enum TopicSaveTarget: Equatable {
    case create
    case update(id: String)

    static func resolve(existingTopicId: String?, createdId: String?) -> TopicSaveTarget {
        if let existingTopicId { return .update(id: existingTopicId) }
        if let createdId { return .update(id: createdId) }
        return .create
    }
}

/// Reine Logik für die einklappbare "Weitere Details"-Gruppe (Schlafen bis +
/// Aufwach-Uhrzeit) — siehe `TodoFormDetailsSummary` (analoges Muster für
/// `TodoFormView`), hier auf die für Themen relevanten Felder reduziert.
enum TopicFormDetailsSummary {
    static func summaryText(hasSnooze: Bool, snoozeDateText: String) -> String? {
        hasSnooze ? "Schlafen bis \(snoozeDateText)" : nil
    }

    static func isExpandedByDefault(hasSnooze: Bool) -> Bool {
        hasSnooze
    }

    static func shortGermanDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "d.M."
        return f.string(from: date)
    }
}

struct TopicFormView: View {
    let meetingId: String
    var topic: Topic? = nil
    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore // Fortschrittsverlauf-Zugriff
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    /// Rich-Text-HTML der Beschreibung (siehe `DescriptionReadView`/
    /// `DescriptionEditorSheet`) — bewusst NICHT mehr Klartext (siehe
    /// zentrale Bug-Behebung dieses Pakets in `TodoFormView.swift`).
    @State private var description = ""
    @State private var showDescriptionEditor = false
    /// Nur im Anlegen-Modus verwendet: die Beschreibung ist dort sofort
    /// editierbar (kein Stift-Klick nötig, siehe UX-Vorgabe).
    @StateObject private var createDescriptionController = KnowledgeEditorController()
    @State private var createDescriptionContentLoaded = false
    @State private var isTodo = false
    @State private var hasSnooze = false
    @State private var snoozeDate = Date()
    @State private var snoozeHasTime = false
    @State private var detailsExpanded = false
    @State private var loading = false
    @State private var error: String?
    // Immer sichtbare Eingabe für einen neuen Zwischenstand (Paket A1),
    // direkt unter der Beschreibung eingebettet (Paket A2 dieser
    // Nachbesserung). Ersetzt den bisherigen "Wo stehe ich gerade?"-Block.
    @StateObject private var progressComposer = ProgressEntryComposer()
    @FocusState private var progressComposerFocused: Bool
    @State private var showDiscardConfirm = false
    // Wird gesetzt, sobald save() im Anlegen-Modus erfolgreich ein neues
    // Thema erzeugt hat — auch wenn der anschliessende, optionale
    // Zwischenstand-Commit fehlschlaegt und das Sheet deshalb offen bleibt.
    // Ein erneuter Klick auf "Speichern" muss dann als Update auf dieses
    // bereits angelegte Thema laufen statt erneut createTopicReturning
    // aufzurufen (das wuerde sonst ein Duplikat anlegen).
    @State private var createdId: String?

    private var detailsSummaryText: String? {
        TopicFormDetailsSummary.summaryText(
            hasSnooze: hasSnooze, snoozeDateText: TopicFormDetailsSummary.shortGermanDate(snoozeDate)
        )
    }

    private var detailsHeaderText: String {
        if let detailsSummaryText { return "Weitere Details – \(detailsSummaryText)" }
        return "Weitere Details"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("Thema eingeben", text: $title)
                }
                Section {
                    descriptionSection
                }
                Section("Fortschritt") {
                    progressSection
                }
                Section {
                    Toggle("Als Todo markieren", isOn: $isTodo)
                }
                Section {
                    DisclosureGroup(isExpanded: $detailsExpanded) {
                        detailsGroupContent
                    } label: {
                        Text(detailsHeaderText)
                            .accessibilityLabel(detailsHeaderText)
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(topic == nil ? "Neues Thema" : "Thema bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { handleCancelTapped() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(title.isEmpty || loading || progressComposer.isOverLimit)
                }
            }
            .onAppear { populate() }
            .interactiveDismissDisabled(progressComposer.isDirty)
            .confirmationDialog(
                "Zwischenstand verwerfen? Dein eingegebener Text ist noch nicht gespeichert.",
                isPresented: $showDiscardConfirm,
                titleVisibility: .visible
            ) {
                Button("Verwerfen", role: .destructive) {
                    progressComposer.discard(store: progressStore, refType: "topic", refId: topic?.id)
                    dismiss()
                }
                Button("Weiter bearbeiten", role: .cancel) {}
            }
            .sheet(isPresented: $showDescriptionEditor) {
                DescriptionEditorSheet(initialHTML: description, title: "Beschreibung bearbeiten") { newHTML in
                    description = newHTML
                }
            }
        }
    }

    @ViewBuilder
    private var descriptionSection: some View {
        if topic == nil {
            // Neuanlage: sofort editierbar, kein Stift-Klick nötig (UX-Vorgabe).
            VStack(alignment: .leading, spacing: 6) {
                Text("Beschreibung").scaledFont(.footnote).foregroundStyle(.secondary)
                DescriptionRichTextEditor(controller: createDescriptionController)
            }
            .onChange(of: createDescriptionController.isReady) { _, ready in
                guard ready else { createDescriptionContentLoaded = false; return }
                Task {
                    await createDescriptionController.setContent("")
                    createDescriptionContentLoaded = true
                }
            }
        } else {
            DescriptionReadView(html: description) {
                showDescriptionEditor = true
            }
        }
    }

    @ViewBuilder
    private var detailsGroupContent: some View {
        Toggle("😴 Schlafen bis", isOn: $hasSnooze)
        if hasSnooze {
            DatePicker("Wacht auf am", selection: $snoozeDate, displayedComponents: .date)
            Toggle("🕐 zu bestimmter Uhrzeit", isOn: $snoozeHasTime)
            if snoozeHasTime {
                DatePicker("Uhrzeit", selection: $snoozeDate, displayedComponents: .hourAndMinute)
            }
            Text(snoozeHasTime ? "Wacht exakt zu dieser Uhrzeit auf — mit Benachrichtigung." : "Bis zu diesem Datum ausblenden.")
                .scaledFont(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var progressSection: some View {
        if let t = topic {
            ProgressTimelineView(refType: "topic", refId: t.id, store: progressStore, descriptionHTML: description) {
                ProgressEntryComposerView(composer: progressComposer, isFocused: $progressComposerFocused) {
                    Task { await commitProgressComposer(refId: t.id) }
                }
            } reentry: {
                ProgressReentryCardView(refType: "topic", refId: t.id, store: progressStore) {
                    progressComposerFocused = true
                }
            }
        } else {
            // Noch keine refId — nur der Composer, ohne Nächster-Schritt/
            // Verlauf/Wiedereinstiegskarte (ergeben für ein noch nicht
            // existierendes Thema keinen Sinn). Der eigentliche Commit
            // erfolgt erst in save(), sobald die id feststeht.
            ProgressEntryComposerView(composer: progressComposer, isFocused: $progressComposerFocused, onSave: {})
        }
    }

    private func commitProgressComposer(refId: String) async {
        await progressComposer.commit(store: progressStore, refType: "topic", refId: refId, hasSnooze: hasSnooze)
    }

    private func handleCancelTapped() {
        if progressComposer.isDirty {
            showDiscardConfirm = true
        } else {
            dismiss()
        }
    }

    private func populate() {
        guard let t = topic else { return }
        title = t.title
        description = t.description
        isTodo = t.isTodo
        if let s = t.snoozedUntil, !s.isEmpty {
            if s.count > 10, let d = parseFlexDate(s) {
                hasSnooze = true; snoozeDate = d; snoozeHasTime = true
            } else if let d = Self.parseDate(s) {
                hasSnooze = true; snoozeDate = d
            }
        }
        detailsExpanded = TopicFormDetailsSummary.isExpandedByDefault(hasSnooze: hasSnooze)
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(s.prefix(10)))
    }

    private static func formatDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// Liefert die zu speichernde Beschreibung als HTML — siehe
    /// `TodoFormView.resolveDescriptionHTML` (analoges Muster).
    private func resolveDescriptionHTML() async -> String {
        guard topic == nil else { return description }
        guard createDescriptionController.isReady, createDescriptionContentLoaded else { return "" }
        return (try? await createDescriptionController.content()) ?? ""
    }

    private func save() {
        loading = true
        let snooze: String? = hasSnooze
            ? (snoozeHasTime ? ISO8601DateFormatter().string(from: snoozeDate) : Self.formatDate(snoozeDate))
            : nil
        let notificationTitle = title
        let fireAt: Date? = (hasSnooze && snoozeHasTime) ? snoozeDate : nil
        Task {
            let descriptionHTML = await resolveDescriptionHTML()
            do {
                var savedId: String?
                switch TopicSaveTarget.resolve(existingTopicId: topic?.id, createdId: createdId) {
                case .update(let id) where topic?.id == id:
                    let t = topic! // sicher: id stammt hier nachweislich aus topic?.id
                    try await state.updateTopic(
                        meetingId: meetingId, id: t.id,
                        title: title, description: descriptionHTML,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        isTodo: isTodo, snoozedUntil: snooze
                    )
                    savedId = t.id
                    NotificationScheduler.shared.reschedule(id: "topic-\(meetingId)-\(t.id)", title: notificationTitle, fireAt: fireAt)
                case .update(let existingId):
                    // Ein vorheriger Speicherversuch hat das Thema bereits
                    // angelegt (nur der Zwischenstand-Commit ist danach
                    // fehlgeschlagen) — jetzt updaten statt erneut anlegen.
                    try await state.updateTopic(
                        meetingId: meetingId, id: existingId,
                        title: title, description: descriptionHTML,
                        done: false, result: "", resultDate: "",
                        isTodo: isTodo, snoozedUntil: snooze
                    )
                    savedId = existingId
                    NotificationScheduler.shared.reschedule(id: "topic-\(meetingId)-\(existingId)", title: notificationTitle, fireAt: fireAt)
                case .create:
                    let created = try await state.createTopicReturning(
                        meetingId: meetingId, title: title,
                        description: descriptionHTML, isTodo: isTodo,
                        snoozedUntil: snooze
                    )
                    savedId = created.id
                    createdId = created.id
                    NotificationScheduler.shared.reschedule(id: "topic-\(meetingId)-\(created.id)", title: notificationTitle, fireAt: fireAt)
                }
                // Das Anlegen/Aktualisieren ist an dieser Stelle bereits
                // serverseitig erfolgt — ein Fehler beim optionalen
                // Zwischenstand darf es NICHT als fehlgeschlagen erscheinen
                // lassen, das Sheet bleibt aber offen (Text bleibt erhalten).
                let progressResult = await progressComposer.commit(
                    store: progressStore, refType: "topic", refId: savedId, hasSnooze: hasSnooze
                )
                loading = false
                if progressResult != .failed {
                    dismiss()
                }
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
