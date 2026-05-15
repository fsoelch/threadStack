import SwiftUI

struct TodoFormView: View {
    var todo: TodoItem? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var snoozeDate = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("Todo eingeben", text: $title)
                }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical)
                        .lineLimit(3...)
                }
                Section("Schlafen bis (optional)") {
                    TextField("JJJJ-MM-TT", text: $snoozeDate)
                        .numberKeyboard()
                    if !snoozeDate.isEmpty {
                        Button("Snooze entfernen", role: .destructive) { snoozeDate = "" }
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
                        .disabled(title.isEmpty || loading)
                }
            }
            .onAppear { populate() }
        }
    }

    private func populate() {
        guard let t = todo else { return }
        title = t.title
        description = t.description
        snoozeDate = t.snoozedUntil ?? ""
    }

    private func save() {
        loading = true
        let snooze: String? = snoozeDate.isEmpty ? nil : snoozeDate
        Task {
            do {
                if let t = todo {
                    try await state.updateTodo(
                        id: t.id, title: title, description: description,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        snoozedUntil: snooze
                    )
                } else {
                    try await state.createTodo(title: title, description: description,
                                               snoozedUntil: snooze)
                }
                dismiss()
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
