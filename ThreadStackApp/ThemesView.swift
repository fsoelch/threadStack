import SwiftUI

struct ThemesView: View {
    @EnvironmentObject var state: AppState
    @State private var showNew = false
    @State private var editTheme: Theme? = nil
    @State private var error: String?

    var body: some View {
        List {
            #if os(macOS)
            Section {
                Button { showNew = true } label: {
                    Label("Neues Topic", systemImage: "plus.circle").foregroundStyle(.secondary)
                }.buttonStyle(.plain)
            }
            #endif

            if state.themes.isEmpty {
                Section {
                    Text("Noch keine Topics — tippe auf + um das erste hinzuzufügen.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(state.themes) { theme in
                    ThemeCardView(theme: theme, onEdit: { editTheme = theme })
                }
                .onDelete { idx in
                    let ids = idx.map { state.themes[$0].id }
                    Task {
                        for id in ids {
                            do { try await state.deleteTheme(id: id) }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }
        }
        .navigationTitle("Meine Topics")
        #if os(iOS)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
            ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
        }
        #endif
        .sheet(isPresented: $showNew)  { ThemeFormView() }
        .sheet(item: $editTheme)       { ThemeFormView(theme: $0) }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }
}

// MARK: - Theme Card

struct ThemeCardView: View {
    let theme: Theme
    let onEdit: () -> Void
    @EnvironmentObject var state: AppState

    private var linkedItems: [(type: String, title: String, meetingId: String?)] {
        state.themeLinksForTheme(themeId: theme.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(theme.title).scaledFont(.subheadline).fontWeight(.semibold)
                    if !theme.description.isEmpty {
                        Text(theme.description).scaledFont(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button { onEdit() } label: {
                    Image(systemName: "pencil").font(.caption)
                }.buttonStyle(.plain).foregroundStyle(.secondary)
            }

            if !linkedItems.isEmpty {
                Divider()
                ForEach(Array(linkedItems.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 6) {
                        Text(item.type == "topic" ? "📋" : "✅").scaledFont(.caption2)
                        Text(item.title).scaledFont(.caption).lineLimit(1)
                        Spacer()
                        if let mid = item.meetingId,
                           let m = state.meetings.first(where: { $0.id == mid }) {
                            Text(m.title).scaledFont(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Theme Form

struct ThemeFormView: View {
    var theme: Theme? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") { TextField("Topic-Name", text: $title) }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical).lineLimit(3...)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(theme == nil ? "Neues Topic" : "Topic bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }.disabled(title.isEmpty || loading)
                }
            }
            .onAppear {
                if let t = theme { title = t.title; description = t.description }
            }
        }
    }

    private func save() {
        loading = true
        Task {
            do {
                if let t = theme {
                    try await state.updateTheme(id: t.id, title: title, description: description)
                } else {
                    try await state.createTheme(title: title, description: description)
                }
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}
