import SwiftUI

struct AdminView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var users: [AdminUser] = []
    @State private var showNew = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(users) { user in
                    UserRowView(user: user, onDelete: { deleteUser(user) })
                }
            }
            .navigationTitle("Benutzerverwaltung")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                }
            }
            .task { await load() }
            .sheet(isPresented: $showNew, onDismiss: { Task { await load() } }) {
                NewUserSheet()
            }
            .alert("Fehler", isPresented: Binding(
                get: { error != nil }, set: { if !$0 { error = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }

    private func load() async {
        do { users = try await state.fetchUsers() }
        catch { self.error = error.localizedDescription }
    }

    private func deleteUser(_ user: AdminUser) {
        Task {
            do { try await state.deleteUser(id: user.id); await load() }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct UserRowView: View {
    let user: AdminUser
    let onDelete: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.username).font(.subheadline).fontWeight(.medium)
                Text(user.isAdmin ? "Admin" : "Benutzer")
                    .font(.caption).foregroundStyle(user.isAdmin ? .orange : .secondary)
            }
            Spacer()
            Button(role: .destructive) { onDelete() } label: {
                Image(systemName: "trash").foregroundStyle(.red)
            }.buttonStyle(.plain)
        }
    }
}

struct NewUserSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var username = ""
    @State private var password = ""
    @State private var isAdmin = false
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Benutzername", text: $username)
                        .autocorrectionDisabled()
                        .noAutocapitalize()
                    SecureField("Passwort", text: $password)
                }
                Section { Toggle("Admin-Rechte", isOn: $isAdmin) }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Neuer Benutzer")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Erstellen") { create() }
                        .disabled(username.isEmpty || password.isEmpty || loading)
                }
            }
        }
    }

    private func create() {
        loading = true
        Task {
            do {
                try await state.createUser(username: username, password: password, isAdmin: isAdmin)
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}
