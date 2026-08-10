import SwiftUI

// Globale Wissens-Ansicht — Wissen kann direkt in der App angelegt, bearbeitet
// (nativer Rich-Text-Editor, siehe KnowledgeEditorView) und gelöscht werden.
struct KnowledgeView: View {
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var themeFilter: String? = nil
    @State private var showNew = false
    @State private var deleteCandidate: KnowledgePage?
    @State private var error: String?

    private var themeOptions: [Theme] {
        state.themes.sorted {
            state.themeAncestorsPath($0.id).map(\.title).joined(separator: " › ") <
            state.themeAncestorsPath($1.id).map(\.title).joined(separator: " › ")
        }
    }

    private var filtered: [KnowledgePage] {
        var list = state.knowledgePages
        if let themeFilter { list = list.filter { $0.themeIds.contains(themeFilter) } }
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return list }
        return list.filter {
            $0.title.localizedCaseInsensitiveContains(q) ||
            stripHTML($0.content).localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Wissen suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
                Picker("Topic", selection: $themeFilter) {
                    Text("Alle Topics").tag(String?.none)
                    ForEach(themeOptions) { t in
                        Text(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › "))
                            .tag(Optional(t.id))
                    }
                }
            }
            #endif

            if state.knowledgePages.isEmpty {
                Section {
                    VStack(spacing: 10) {
                        Text("Noch kein Wissen hinterlegt.")
                            .foregroundStyle(.secondary).font(.subheadline)
                            .multilineTextAlignment(.center)
                        Button { showNew = true } label: {
                            Label("Neues Wissen", systemImage: "plus.circle")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            } else if filtered.isEmpty {
                Section {
                    Text("Keine Treffer.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filtered) { k in
                    NavigationLink { KnowledgeDetailView(page: k) } label: { KnowledgeRowView(page: k) }
                }
                #if os(iOS)
                .onDelete { offsets in
                    if let first = offsets.first { deleteCandidate = filtered[first] }
                }
                #endif
            }

            #if os(macOS)
            Section {
                Button { showNew = true } label: {
                    Label("Neues Wissen", systemImage: "plus.circle").foregroundStyle(.secondary)
                }.buttonStyle(.plain)
            }
            #endif
        }
        .navigationTitle("Wissen")
        #if os(iOS)
        .searchable(text: $search, prompt: "Wissen suchen")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button("Alle Topics") { themeFilter = nil }
                    ForEach(themeOptions) { t in
                        Button(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › ")) {
                            themeFilter = t.id
                        }
                    }
                } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
            }
        }
        #endif
        .sheet(isPresented: $showNew) {
            KnowledgeEditorView(mode: .create(presetThemeId: nil))
        }
        .confirmationDialog(
            "Wissensseite löschen?",
            isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("Löschen", role: .destructive) { performDelete() }
            Button("Abbrechen", role: .cancel) { deleteCandidate = nil }
        } message: {
            if let c = deleteCandidate {
                Text("„\(c.title)\u{201C} wird endgültig gelöscht. Das kann nicht rückgängig gemacht werden.")
            }
        }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    private func performDelete() {
        guard let candidate = deleteCandidate else { return }
        deleteCandidate = nil
        Task {
            do {
                try await state.deleteKnowledgePage(id: candidate.id)
            } catch {
                self.error = "Löschen fehlgeschlagen. Bitte versuche es erneut."
            }
        }
    }

}
