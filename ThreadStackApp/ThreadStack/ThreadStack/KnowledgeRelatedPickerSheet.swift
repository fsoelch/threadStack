//
//  KnowledgeRelatedPickerSheet.swift
//  ThreadStack
//
//  Arbeitspaket 5 ("knowledge-pickers"): Auswahl-Sheet zum Verknüpfen einer
//  Wissensseite mit einer anderen. Nutzt die von Paket 1 bereitgestellte
//  `AppState.searchKnowledge(query:)`-API (GET /api/knowledge/search?q=).
//
//  WICHTIG (Cross-Paket-Abhängigkeit): `KnowledgeSearchHit` und
//  `AppState.searchKnowledge(query:)` werden von Arbeitspaket 1 implementiert.
//  Diese Datei konsumiert die Signaturen ausschließlich gemäß Vertrag und
//  ändert sie nicht. Bis Paket 1 in denselben Branch/Worktree gemergt ist,
//  kompiliert diese Datei nicht eigenständig (siehe Abschlussbericht).
//

import SwiftUI

// MARK: - Pure helpers (testable via @testable import, ohne AppState/KnowledgeSearchHit-Abhängigkeit)

/// Ob bei der aktuellen Sucheingabe eine Serversuche ausgelöst werden soll.
/// Der Vertrag von `searchKnowledge` liefert bei < 2 Zeichen ohnehin eine leere
/// Liste; dieses Gate vermeidet zusätzlich unnötige Netzwerk-Roundtrips/Flackern
/// in der UI.
func knowledgeRelatedPickerShouldSearch(_ query: String) -> Bool {
    query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
}

/// Schließt die aktuelle Seite (`currentPageId`) aus der Trefferliste aus und
/// markiert bereits verknüpfte Treffer (`alreadyLinked`), statt sie zu entfernen —
/// damit sie ausgegraut/deaktiviert dargestellt werden können (keine
/// Duplikat-Auswahl möglich).
///
/// Generisch über `Hit: Identifiable` mit `ID == String` gehalten, damit die
/// Filterlogik unabhängig von der konkreten (in Paket 1 definierten)
/// `KnowledgeSearchHit`-Struct unit-testbar ist.
func knowledgeRelatedPickerAnnotate<Hit: Identifiable>(
    _ hits: [Hit],
    currentPageId: String?,
    alreadyLinked: Set<String>
) -> [(hit: Hit, isLinked: Bool)] where Hit.ID == String {
    hits
        .filter { $0.id != currentPageId }
        .map { (hit: $0, isLinked: alreadyLinked.contains($0.id)) }
}

// MARK: - View

struct KnowledgeRelatedPickerSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    /// Aktuelle Seite selbst — wird aus der Trefferliste ausgeschlossen.
    /// `nil` bei neuer, noch ungespeicherter Seite: Verknüpfung ist dann
    /// deaktiviert, da sie erst nach dem ersten Speichern sinnvoll ist.
    let currentPageId: String?
    /// Bereits verknüpfte IDs — nicht erneut auswählbar/ausgegraut.
    let alreadyLinked: Set<String>
    let onPicked: (KnowledgeSearchHit) -> Void

    @State private var query = ""
    @State private var results: [KnowledgeSearchHit] = []
    @State private var loading = false
    @State private var errorText: String?
    @State private var searchTask: Task<Void, Never>?

    private var annotated: [(hit: KnowledgeSearchHit, isLinked: Bool)] {
        knowledgeRelatedPickerAnnotate(results, currentPageId: currentPageId, alreadyLinked: alreadyLinked)
    }

    var body: some View {
        NavigationStack {
            Group {
                if currentPageId == nil {
                    unsavedPageHint
                } else {
                    searchContent
                }
            }
            .navigationTitle("Seite verknüpfen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen") {
                        searchTask?.cancel()
                        dismiss()
                    }
                    .accessibilityLabel("Schließen")
                }
            }
        }
        .onDisappear { searchTask?.cancel() }
    }

    private var unsavedPageHint: some View {
        VStack(spacing: 8) {
            Image(systemName: "link.badge.plus")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Verknüpfen erst nach dem Speichern möglich")
                .font(.headline)
            Text("Bitte speichere diese Seite zuerst, um sie mit anderen Wissensseiten zu verknüpfen.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var searchContent: some View {
        List {
            if loading {
                HStack {
                    ProgressView()
                    Text("Suche …").foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Suche läuft")
            } else if let errorText {
                Text(errorText).foregroundStyle(.red).font(.footnote)
            } else if knowledgeRelatedPickerShouldSearch(query) && annotated.isEmpty {
                Text("Keine Treffer für „\(query)“.")
                    .foregroundStyle(.secondary)
            }

            ForEach(annotated, id: \.hit.id) { entry in
                hitRow(entry)
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, prompt: "Wissensseiten durchsuchen")
        .onChange(of: query) { _, newValue in
            triggerSearch(newValue)
        }
    }

    private func hitRow(_ entry: (hit: KnowledgeSearchHit, isLinked: Bool)) -> some View {
        Button {
            guard !entry.isLinked else { return }
            onPicked(entry.hit)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.hit.title)
                if let snippet = entry.hit.snippet, !snippet.isEmpty {
                    Text(snippet)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(entry.isLinked)
        .opacity(entry.isLinked ? 0.5 : 1.0)
        .accessibilityLabel(entry.hit.title)
        .accessibilityHint(entry.isLinked ? "Bereits verknüpft" : "Doppeltippen zum Verknüpfen")
    }

    /// Debounced Suche: löst bei Eingabeänderung eine neue Serversuche aus
    /// (Vertrag: `searchKnowledge` selbst liefert bei < 2 Zeichen bereits eine
    /// leere Liste; das lokale Gate verhindert zusätzlich unnötige Requests).
    /// Es werden ausschließlich Nutzereingaben über die bereitgestellte
    /// `searchKnowledge`-Funktion übertragen — kein eigenes URL-/Query-Building.
    private func triggerSearch(_ q: String) {
        searchTask?.cancel()
        errorText = nil
        guard knowledgeRelatedPickerShouldSearch(q) else {
            results = []
            loading = false
            return
        }
        searchTask = Task {
            loading = true
            defer { loading = false }
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            do {
                let hits = try await state.searchKnowledge(query: q)
                if Task.isCancelled { return }
                results = hits
            } catch is CancellationError {
                // Nutzer hat weitergetippt / Sheet geschlossen — kein Fehlertext nötig.
            } catch {
                if Task.isCancelled { return }
                results = []
                errorText = "Suche fehlgeschlagen. Bitte erneut versuchen."
            }
        }
    }
}
