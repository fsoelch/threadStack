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
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var hasSnooze = false
    @State private var snoozeDate = Date()
    @State private var snoozeHasTime = false
    @State private var hasDueDate = false
    @State private var dueDate = Date()
    @State private var isPrivate = false
    @State private var loading = false
    @State private var error: String?
    @State private var showLinkSheet = false

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
                        DatePicker("Fällig am", selection: $dueDate, displayedComponents: .date)
                    }
                } footer: {
                    Text("Todos mit Fälligkeit werden zuerst angezeigt — frühestes oben.")
                }
                Section {
                    Toggle("😴 Schlafen bis", isOn: $hasSnooze)
                    if hasSnooze {
                        DatePicker("Wacht auf am", selection: $snoozeDate, displayedComponents: .date)
                        Toggle("🕐 zu bestimmter Uhrzeit", isOn: $snoozeHasTime)
                        if snoozeHasTime {
                            DatePicker("Uhrzeit", selection: $snoozeDate, displayedComponents: .hourAndMinute)
                        }
                    }
                } footer: {
                    Text(snoozeHasTime ? "Wacht exakt zu dieser Uhrzeit auf — mit Benachrichtigung." : "Bis zu diesem Datum ausblenden.")
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
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(title.isEmpty || loading)
                }
            }
            .onAppear { populate() }
            .sheet(isPresented: $showLinkSheet) {
                LinkInsertSheet(onInsert: { text in
                    description += (description.isEmpty ? "" : "\n\n") + text
                })
            }
        }
    }

    private func populate() {
        guard let t = todo else { return }
        title = t.title
        description = stripHTML(t.description)   // show plain text in editor
        isPrivate = t.isPrivate
        if let s = t.snoozedUntil, !s.isEmpty {
            if s.count > 10, let d = parseFlexDate(s) {
                hasSnooze = true; snoozeDate = d; snoozeHasTime = true
            } else if let d = Self.parseDate(s) {
                hasSnooze = true; snoozeDate = d
            }
        }
        if let s = t.dueDate, !s.isEmpty, let d = Self.parseDate(s) {
            hasDueDate = true; dueDate = d
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
        let snooze: String? = hasSnooze
            ? (snoozeHasTime ? ISO8601DateFormatter().string(from: snoozeDate) : Self.formatDate(snoozeDate))
            : nil
        let due:    String? = hasDueDate ? Self.formatDate(dueDate)    : nil
        let notificationTitle = title
        let fireAt: Date? = (hasSnooze && snoozeHasTime) ? snoozeDate : nil
        Task {
            do {
                if let t = todo {
                    try await state.updateTodo(
                        id: t.id, title: title, description: description,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        snoozedUntil: snooze, dueDate: due, isPrivate: isPrivate
                    )
                    NotificationScheduler.shared.reschedule(id: "todo-\(t.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate)
                } else {
                    let created = try await state.createTodoReturning(title: title, description: description,
                                               snoozedUntil: snooze, dueDate: due,
                                               isPrivate: isPrivate)
                    NotificationScheduler.shared.reschedule(id: "todo-\(created.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate)
                    if let presetThemeId {
                        try? await state.addThemeLink(themeId: presetThemeId, refType: "todo", refId: created.id)
                    }
                }
                onSaved?()
                dismiss()
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
