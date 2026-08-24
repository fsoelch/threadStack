//
//  ProgressEntryComposerView.swift
//  ThreadStack
//
//  Arbeitspaket A1 (UX-Nachbesserung "Zielbild und Fortschrittsverlauf"):
//  immer sichtbare Eingabemöglichkeit für einen neuen Zwischenstand, die von
//  Paket A2 als ERSTES interaktives Element direkt in `TodoFormView`/
//  `TopicFormView` eingebettet wird — ersetzt den bisherigen Sheet-Einstieg
//  (`ProgressEntryEditorSheet.Mode.create`, entfällt), der erst geöffnet
//  werden musste.
//
//  Bewusst Klartext (`TextEditor`) statt Rich Text: der bestehende
//  Rich-Text-Editor (`KnowledgeEditorController`/`KnowledgeEditorWebView`,
//  weiterhin genutzt vom Bearbeiten-Sheet `ProgressEntryEditorSheet`) bräuchte
//  eine WKWebView, die hier dauerhaft in eine scrollende Form eingebettet
//  werden müsste — bewusste Architekturentscheidung laut Vertrag, kein
//  Duplikat/keine zweite, abweichende Editor-Lösung, sondern ein bewusst
//  einfacheres Feld für einen anderen Kontext, analog zum bereits
//  bestehenden Klartext-Checkpoint-Feld in `TodoFormView`/`StackPopSheet`
//  ("Wo stehe ich gerade?").
//
//  Wiederverwendet die bestehende Zeichenzähler-Logik `ProgressEntryCharLimit`
//  (siehe `ProgressEntryEditorSheet.swift`) unverändert, statt eine eigene,
//  zweite Grenzwertlogik zu bauen. Idempotenz beim Speichern läuft
//  ausschließlich über den bereits bestehenden Mechanismus
//  (`ProgressStore.addEntry` / `.clientTokenForPendingEntry` /
//  `.discardPendingEntryToken`) — kein neuer Idempotenz-Mechanismus.
//

import SwiftUI
import Combine

// MARK: - Reine Logik (testbar)

/// Bildet den `source`-Wert für einen neu erfassten Zwischenstand ab (siehe
/// `ProgressEntry.source` / Server-Vertrag `lib/progress/routes.js`:
/// 'manual' | 'snooze' | 'pop_snoozed' | ...). Der Composer wird sowohl aus
/// dem normalen Formularkontext als auch beim direkten Snoozen (`hasSnooze`)
/// verwendet — nur dieser eine Unterschied ist hier relevant, alle anderen
/// `source`-Werte entstehen an anderer Stelle (Stack-Pop-Flows).
enum ProgressEntrySource {
    static func derive(hasSnooze: Bool) -> String {
        hasSnooze ? "snooze" : "manual"
    }
}

/// Zustand + Speicherlogik des immer sichtbaren Composers, getrennt vom
/// View-Body (analog zu den bereits bestehenden `*CharLimit`/`*Logic`-Enums
/// in diesem Feature).
@MainActor
final class ProgressEntryComposer: ObservableObject {
    @Published var text: String = ""
    @Published private(set) var isSaving = false
    @Published private(set) var errorText: String?

    enum CommitResult: Equatable {
        case noop
        case saved
        case failed
    }

    /// Läuft bereits ein `commit(...)`, wird dessen Ergebnis für alle
    /// weiteren, währenddessen eintreffenden Aufrufe geteilt — verhindert
    /// einen zweiten Request bei Doppelaufruf/Doppel-Tap (siehe Vertrag).
    private var inFlightCommit: Task<CommitResult, Never>?

    /// Getrimmter Text ist nicht leer (Whitespace/Newlines werden getrimmt).
    var isDirty: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var isOverLimit: Bool {
        ProgressEntryCharLimit.isOverLimit(length: text.count)
    }

    /// Speichert den aktuellen Entwurf als neuen Zwischenstand.
    ///
    /// - `refId == nil` (Vorhaben noch nicht gespeichert) ODER `!isDirty`:
    ///   `.noop`, es wird KEIN Request ausgelöst.
    /// - Läuft bereits ein Commit: wartet auf dessen Ergebnis, statt einen
    ///   zweiten Request auszulösen.
    /// - Erfolg: `text` wird geleert, `errorText` auf `nil` gesetzt (der vom
    ///   `ProgressStore` verwaltete `clientToken` wird dabei intern bereits
    ///   von `store.addEntry` verworfen) -> `.saved`.
    /// - Fehler: `errorText` wird gesetzt, `text` bleibt UNVERÄNDERT
    ///   erhalten (kein Datenverlust), derselbe `clientToken` bleibt für den
    ///   nächsten Versuch bestehen (Idempotenz bei Retry, da `store.addEntry`
    ///   den Token bei einem Fehler nicht verwirft) -> `.failed`.
    @discardableResult
    func commit(store: ProgressStore, refType: String, refId: String?, hasSnooze: Bool) async -> CommitResult {
        if let inFlightCommit {
            return await inFlightCommit.value
        }
        guard let refId, isDirty else { return .noop }

        let bodyHTML = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = ProgressEntrySource.derive(hasSnooze: hasSnooze)

        let task = Task<CommitResult, Never> { @MainActor [weak self] in
            guard let self else { return .noop }
            self.isSaving = true
            self.errorText = nil
            defer { self.isSaving = false }
            do {
                _ = try await store.addEntry(refType: refType, refId: refId, bodyHTML: bodyHTML, source: source)
                self.text = ""
                self.errorText = nil
                return .saved
            } catch {
                self.errorText = (error as? ProgressError)?.errorDescription
                    ?? "Speichern fehlgeschlagen. Bitte erneut versuchen."
                return .failed
            }
        }
        inFlightCommit = task
        let result = await task.value
        inFlightCommit = nil
        return result
    }

    /// Verwirft Entwurfstext UND den vorbereiteten `clientToken` (z.B. beim
    /// "Verwerfen" im Abbrechen-Dialog des einbettenden Formulars).
    func discard(store: ProgressStore, refType: String, refId: String?) {
        text = ""
        errorText = nil
        if let refId {
            store.discardPendingEntryToken(refType: refType, refId: refId)
        }
    }
}

// MARK: - View

/// Einfache Text-Eingabe (kein Rich-Text-Editor, siehe Datei-Kopfkommentar).
/// Setzt NIEMALS selbst den Fokus — nur eine Nutzeraktion von AUSSEN (z.B.
/// der Reentry-Card-CTA über `ProgressReentryCardView.onRequestCompose`) darf
/// `isFocused.wrappedValue = true` setzen.
struct ProgressEntryComposerView: View {
    @ObservedObject var composer: ProgressEntryComposer
    var isFocused: FocusState<Bool>.Binding
    let onSave: () -> Void

    init(composer: ProgressEntryComposer, isFocused: FocusState<Bool>.Binding, onSave: @escaping () -> Void) {
        self.composer = composer
        self.isFocused = isFocused
        self.onSave = onSave
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Neuer Zwischenstand")
                .scaledFont(.footnote).foregroundStyle(.secondary)

            TextEditor(text: $composer.text)
                .frame(minHeight: 80)
                .focused(isFocused)
                .accessibilityLabel("Neuer Zwischenstand")

            if ProgressEntryCharLimit.shouldShowCounter(length: composer.text.count) {
                Text("\(composer.text.count) / \(ProgressEntryCharLimit.maxLength)")
                    .scaledFont(.caption)
                    .foregroundStyle(composer.isOverLimit ? .red : .secondary)
                    .accessibilityLabel("\(composer.text.count) von \(ProgressEntryCharLimit.maxLength) Zeichen")
            }

            if let errorText = composer.errorText {
                Text(errorText)
                    .scaledFont(.footnote).foregroundStyle(.red)
                    .accessibilityLabel(errorText)
            }

            HStack {
                Spacer()
                Button {
                    onSave()
                } label: {
                    if composer.isSaving {
                        ProgressView()
                    } else {
                        Label("Speichern", systemImage: "checkmark")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!composer.isDirty || composer.isOverLimit || composer.isSaving)
                .accessibilityLabel("Zwischenstand speichern")
            }
        }
    }
}
