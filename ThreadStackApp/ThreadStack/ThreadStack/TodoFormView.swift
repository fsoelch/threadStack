import SwiftUI

/// Reine, von SwiftUI entkoppelte Entscheidungslogik für `TodoFormView.save()`:
/// sobald für das aktuell bearbeitete Todo bereits eine Server-ID bekannt ist
/// — entweder weil ein bestehendes Todo bearbeitet wird ODER weil ein
/// vorheriger Speicherversuch im Anlegen-Modus das Todo bereits erfolgreich
/// angelegt hat (nur der anschliessende, optionale Zwischenstand-Commit ist
/// danach fehlgeschlagen, siehe `createdId`) — MUSS der nächste
/// Speicherversuch ein Update sein, niemals ein zweites Create (sonst
/// Duplikat, Security Review, Mittel: Fund 1).
enum TodoSaveTarget: Equatable {
    case create
    case update(id: String)

    static func resolve(existingTodoId: String?, createdId: String?) -> TodoSaveTarget {
        if let existingTodoId { return .update(id: existingTodoId) }
        if let createdId { return .update(id: createdId) }
        return .create
    }
}

struct TodoFormView: View {
    var todo: TodoItem? = nil
    /// Nur im Anlegen-Modus wirksam: verknüpft das neu erstellte Todo nach
    /// erfolgreichem Speichern automatisch mit diesem Topic (analog zum
    /// presetThemeId-Muster von KnowledgeEditorView).
    var presetThemeId: String? = nil
    /// Wird nach erfolgreichem Anlegen/Bearbeiten aufgerufen, bevor das Sheet
    /// schliesst — Aufrufer nutzen das zum gezielten Nachladen (z. B. der
    /// Themen-gescopten Todo-Liste in ThemeDetailScreen).
    var onSaved: (() -> Void)? = nil
    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore // Fortschrittsverlauf-Zugriff
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var hasSnooze = false
    @State private var snoozeDate = Date()
    @State private var hasDueDate = false
    @State private var dueDate = Date()
    @State private var dueReminderEnabled = false
    @State private var isPrivate = false
    @State private var loading = false
    @State private var error: String?
    @State private var showLinkSheet = false
    // Immer sichtbare Eingabe für einen neuen Zwischenstand (Paket A1),
    // direkt unter der Beschreibung eingebettet (Paket A2 dieser
    // Nachbesserung). Ersetzt den bisherigen "Wo stehe ich gerade?"-Block.
    @StateObject private var progressComposer = ProgressEntryComposer()
    @FocusState private var progressComposerFocused: Bool
    @State private var showDiscardConfirm = false
    // Wird gesetzt, sobald save() im Anlegen-Modus erfolgreich ein neues
    // Todo erzeugt hat — auch wenn der anschliessende, optionale
    // Zwischenstand-Commit fehlschlaegt und das Sheet deshalb offen bleibt.
    // Ein erneuter Klick auf "Speichern" muss dann als Update auf dieses
    // bereits angelegte Todo laufen statt erneut createTodoReturning
    // aufzurufen (das wuerde sonst ein Duplikat anlegen).
    @State private var createdId: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("Todo eingeben", text: $title)
                }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical)
                        .lineLimit(3...)
                    Button {
                        showLinkSheet = true
                    } label: {
                        Label("Link mit KI-Zusammenfassung einfügen", systemImage: "link")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityHint("Öffnet einen Dialog zum Einfügen eines Links, optional mit KI-Zusammenfassung.")
                }
                Section("Fortschritt") {
                    progressSection
                }
                Section {
                    Toggle("📅 Fälligkeitsdatum", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Fällig am", selection: $dueDate,
                                    displayedComponents: dueReminderEnabled ? [.date, .hourAndMinute] : [.date])
                        Toggle("🔔 Erinnerung", isOn: $dueReminderEnabled)
                    }
                } footer: {
                    Text(dueReminderEnabled
                         ? "Erinnert dich per Benachrichtigung zu dieser Uhrzeit."
                         : "Todos mit Fälligkeit werden zuerst angezeigt — frühestes oben.")
                }
                Section {
                    Toggle("😴 Schlafen bis", isOn: $hasSnooze)
                    if hasSnooze {
                        DatePicker("Wacht auf am", selection: $snoozeDate, displayedComponents: .date)
                    }
                } footer: {
                    Text("Bis zu diesem Datum ausblenden.")
                }
                Section {
                    Toggle(isOn: $isPrivate) {
                        Label("Privat", systemImage: "lock")
                    }
                } footer: {
                    Text("Nur für dich — lässt sich in der Todos-Liste schnell ausblenden.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(todo == nil ? "Neues Todo" : "Todo bearbeiten")
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
                    progressComposer.discard(store: progressStore, refType: "todo", refId: todo?.id)
                    dismiss()
                }
                Button("Weiter bearbeiten", role: .cancel) {}
            }
            .sheet(isPresented: $showLinkSheet) {
                LinkInsertSheet(onInsert: { text in
                    description += (description.isEmpty ? "" : "\n\n") + text
                })
            }
        }
    }

    @ViewBuilder
    private var progressSection: some View {
        if let t = todo {
            ProgressTimelineView(refType: "todo", refId: t.id, store: progressStore) {
                ProgressEntryComposerView(composer: progressComposer, isFocused: $progressComposerFocused) {
                    Task { await commitProgressComposer(refId: t.id) }
                }
            } reentry: {
                ProgressReentryCardView(refType: "todo", refId: t.id, store: progressStore) {
                    progressComposerFocused = true
                }
            }
        } else {
            // Noch keine refId — nur der Composer, ohne Zielbild/Verlauf/
            // Wiedereinstiegskarte (ergeben für ein noch nicht existierendes
            // Todo keinen Sinn). Der eigentliche Commit erfolgt erst in
            // save(), sobald die id feststeht.
            ProgressEntryComposerView(composer: progressComposer, isFocused: $progressComposerFocused, onSave: {})
        }
    }

    private func commitProgressComposer(refId: String) async {
        await progressComposer.commit(store: progressStore, refType: "todo", refId: refId, hasSnooze: hasSnooze)
    }

    private func handleCancelTapped() {
        if progressComposer.isDirty {
            showDiscardConfirm = true
        } else {
            dismiss()
        }
    }

    private func populate() {
        guard let t = todo else { return }
        title = t.title
        description = stripHTML(t.description)   // show plain text in editor
        isPrivate = t.isPrivate
        if let s = t.snoozedUntil, !s.isEmpty, let d = parseFlexDate(s) {
            hasSnooze = true; snoozeDate = d
        }
        if let s = t.dueDate, !s.isEmpty {
            if s.count > 10, let d = parseFlexDate(s) {
                hasDueDate = true; dueDate = d; dueReminderEnabled = true
            } else if let d = Self.parseDate(s) {
                hasDueDate = true; dueDate = d
            }
        }
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

    private func save() {
        loading = true
        let snooze: String? = hasSnooze ? Self.formatDate(snoozeDate) : nil
        let due:    String? = hasDueDate
            ? (dueReminderEnabled ? ISO8601DateFormatter().string(from: dueDate) : Self.formatDate(dueDate))
            : nil
        let notificationTitle = title
        let fireAt: Date? = (hasDueDate && dueReminderEnabled) ? dueDate : nil
        Task {
            do {
                var savedId: String?
                switch TodoSaveTarget.resolve(existingTodoId: todo?.id, createdId: createdId) {
                case .update(let id) where todo?.id == id:
                    let t = todo! // sicher: id stammt hier nachweislich aus todo?.id
                    try await state.updateTodo(
                        id: t.id, title: title, description: description,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        snoozedUntil: snooze, dueDate: due, isPrivate: isPrivate
                    )
                    savedId = t.id
                    NotificationScheduler.shared.reschedule(id: "todo-\(t.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                case .update(let existingId):
                    // Ein vorheriger Speicherversuch hat das Todo bereits
                    // angelegt (nur der Zwischenstand-Commit ist danach
                    // fehlgeschlagen) — jetzt updaten statt erneut anlegen.
                    try await state.updateTodo(
                        id: existingId, title: title, description: description,
                        done: false, result: "", resultDate: "",
                        snoozedUntil: snooze, dueDate: due, isPrivate: isPrivate
                    )
                    savedId = existingId
                    NotificationScheduler.shared.reschedule(id: "todo-\(existingId)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                case .create:
                    let created = try await state.createTodoReturning(title: title, description: description,
                                               snoozedUntil: snooze, dueDate: due,
                                               isPrivate: isPrivate)
                    savedId = created.id
                    createdId = created.id
                    NotificationScheduler.shared.reschedule(id: "todo-\(created.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                    if let presetThemeId {
                        try? await state.addThemeLink(themeId: presetThemeId, refType: "todo", refId: created.id)
                    }
                }
                // Der Snooze/das Anlegen/Aktualisieren ist an dieser Stelle
                // bereits serverseitig erfolgt — ein Fehler beim optionalen
                // Zwischenstand darf ihn NICHT als fehlgeschlagen erscheinen
                // lassen, das Sheet bleibt aber offen (Text bleibt erhalten).
                let progressResult = await progressComposer.commit(
                    store: progressStore, refType: "todo", refId: savedId, hasSnooze: hasSnooze
                )
                loading = false
                if progressResult != .failed {
                    onSaved?()
                    dismiss()
                }
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
