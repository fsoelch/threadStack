//
//  ProgressGoalEditorSheet.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI-Bausteine Progress"): Sheet zum Bearbeiten des
//  dauerhaften Zielbilds eines Vorhabens. Bewusst Klartext-Eingabe (kein
//  Rich-Text-Editor — das Zielbild ist laut Vertrag bewusst Klartext, anders
//  als die Zwischenstände in `ProgressEntryEditorSheet`).
//
//  Sheet-/Formular-Muster folgt den bestehenden Form-Sheets (siehe
//  `StackNoteSheet`/`StackPushSheet` in `StackViews.swift`,
//  `TodoCompleteSheet` in `TodosView.swift`): `NavigationStack` + `Form`,
//  Abbrechen/Speichern als `ToolbarItem`, Fehlertext inline in eigener
//  `Section`.
//

import SwiftUI

// MARK: - Reine Logik (testbar)

/// Zeichenzähler-/Grenzwertlogik für das Zielbild, getrennt vom View-Body.
/// Grenze (500) wird serverseitig final durchgesetzt (`ProgressError.tooLong`);
/// hier nur UX-Komfort (frühzeitiges Feedback, Speichern-Button deaktivieren).
enum ProgressGoalCharLimit {
    static let warnThreshold = 400
    static let maxLength = 500

    /// Zähler wird erst ab `warnThreshold` sichtbar (kein permanentes
    /// "0 / 500" für kurze Zielbilder).
    static func shouldShowCounter(length: Int) -> Bool {
        length >= warnThreshold
    }

    /// `true`, wenn die aktuelle Länge das serverseitige Limit überschreitet
    /// (exakt `maxLength` ist noch erlaubt, Randfall siehe Tests).
    static func isOverLimit(length: Int) -> Bool {
        length > maxLength
    }

    /// Speichern ist deaktiviert bei leerem/nur-Whitespace-Text oder wenn das
    /// Limit überschritten ist.
    static func isSaveDisabled(trimmedText: String, length: Int) -> Bool {
        trimmedText.isEmpty || isOverLimit(length: length)
    }
}

// MARK: - View

struct ProgressGoalEditorSheet: View {
    let refType: String
    let refId: String
    @ObservedObject var store: ProgressStore
    /// Wird nach erfolgreichem Speichern aufgerufen, bevor das Sheet
    /// schließt — analog zu `KnowledgeEditorView.onSaved`/`TodoFormView.onSaved`.
    var onSaved: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var text: String = ""
    @State private var loading = false
    @State private var errorText: String?

    private var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var saveDisabled: Bool {
        loading || ProgressGoalCharLimit.isSaveDisabled(trimmedText: trimmedText, length: text.count)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Wofür steht dieses Vorhaben?", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                    if ProgressGoalCharLimit.shouldShowCounter(length: text.count) {
                        Text("\(text.count) / \(ProgressGoalCharLimit.maxLength)")
                            .scaledFont(.caption)
                            .foregroundStyle(ProgressGoalCharLimit.isOverLimit(length: text.count) ? .red : .secondary)
                            .accessibilityLabel("\(text.count) von \(ProgressGoalCharLimit.maxLength) Zeichen")
                    }
                } header: {
                    Text("Zielbild")
                } footer: {
                    Text("Ein kurzer Ankertext — wofür lohnt sich das Dranbleiben?")
                }
                if let errorText {
                    Section {
                        Text(errorText).scaledFont(.footnote).foregroundStyle(.red)
                            .accessibilityLabel(errorText)
                    }
                }
            }
            .navigationTitle("Zielbild bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: {
                        if loading { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(saveDisabled)
                    .accessibilityLabel("Speichern")
                }
            }
            .onAppear {
                if text.isEmpty {
                    text = store.detail(refType: refType, refId: refId)?.goal ?? ""
                }
            }
        }
    }

    private func save() {
        loading = true
        errorText = nil
        Task {
            do {
                try await store.saveGoal(refType: refType, refId: refId, goal: trimmedText)
                onSaved?()
                dismiss()
            } catch {
                // Text bleibt im Editor erhalten (kein Datenverlust), Fehler
                // wird inline angezeigt — siehe Vertrag.
                errorText = (error as? ProgressError)?.errorDescription ?? error.localizedDescription
                loading = false
            }
        }
    }
}
