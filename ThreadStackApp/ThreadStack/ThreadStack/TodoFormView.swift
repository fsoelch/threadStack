import SwiftUI

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
    @EnvironmentObject var progressStore: ProgressStore // A3: Fortschrittsverlauf-Zugriff
    @Environment(\.dismiss) var dismiss
    @State private var showProgressHistory = false // A3
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
    // Story 6 (Tester-Fund): optionaler Zwischenstand beim direkten Snoozen
    // (außerhalb des Stacks) — analog zum bereits vorhandenen Checkpoint-Feld
    // in StackPopSheet (StackViews.swift).
    @State private var whereAmI = ""
    @State private var checkpointError: String?

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
                if hasSnooze {
                    Section("Wo stehe ich gerade? (optional)") {
                        TextEditor(text: $whereAmI).frame(minHeight: 80)
                        Text("\(whereAmI.count) / \(ProgressEntryCharLimit.maxLength)")
                            .scaledFont(.caption).foregroundStyle(.secondary)
                        if let checkpointError {
                            Text(checkpointError).scaledFont(.caption).foregroundStyle(.orange)
                        }
                    }
                }
                Section {
                    Toggle(isOn: $isPrivate) {
                        Label("Privat", systemImage: "lock")
                    }
                } footer: {
                    Text("Nur für dich — lässt sich in der Todos-Liste schnell ausblenden.")
                }
                // A3: Verlaufs-Zugriff nur für bereits gespeicherte Todos (id vorhanden).
                if todo != nil {
                    Section {
                        Button { showProgressHistory = true } label: {
                            Label("Fortschrittsverlauf", systemImage: "chart.line.uptrend.xyaxis")
                        }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(todo == nil ? "Neues Todo" : "Todo bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(title.isEmpty || loading
                                  || (hasSnooze && ProgressEntryCharLimit.isOverLimit(length: whereAmI.count)))
                }
            }
            .onAppear { populate() }
            .sheet(isPresented: $showLinkSheet) {
                LinkInsertSheet(onInsert: { text in
                    description += (description.isEmpty ? "" : "\n\n") + text
                })
            }
            // A3: Fortschrittsverlauf-Sheet, nur für bereits gespeicherte Todos.
            .sheet(isPresented: $showProgressHistory) {
                if let t = todo {
                    ProgressHistorySheet(refType: "todo", refId: t.id, store: progressStore)
                }
            }
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
                var savedId = todo?.id
                if let t = todo {
                    try await state.updateTodo(
                        id: t.id, title: title, description: description,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        snoozedUntil: snooze, dueDate: due, isPrivate: isPrivate
                    )
                    NotificationScheduler.shared.reschedule(id: "todo-\(t.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                } else {
                    let created = try await state.createTodoReturning(title: title, description: description,
                                               snoozedUntil: snooze, dueDate: due,
                                               isPrivate: isPrivate)
                    savedId = created.id
                    NotificationScheduler.shared.reschedule(id: "todo-\(created.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                    if let presetThemeId {
                        try? await state.addThemeLink(themeId: presetThemeId, refType: "todo", refId: created.id)
                    }
                }
                // Story 6 (Tester-Fund): der Snooze ist an dieser Stelle bereits
                // serverseitig erfolgt — ein Fehler beim optionalen Zwischenstand
                // darf ihn NICHT als fehlgeschlagen erscheinen lassen.
                let checkpointOK = await saveCheckpointIfNeeded(refId: savedId)
                loading = false
                if checkpointOK {
                    onSaved?()
                    dismiss()
                }
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }

    private func saveCheckpointIfNeeded(refId: String?) async -> Bool {
        guard hasSnooze, let refId else { return true }
        let trimmed = whereAmI.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        do {
            _ = try await progressStore.addEntry(refType: "todo", refId: refId, bodyHTML: trimmed, source: "snooze")
            return true
        } catch {
            checkpointError = "Zwischenstand konnte nicht gespeichert werden — dein Text bleibt oben erhalten."
            return false
        }
    }
}
