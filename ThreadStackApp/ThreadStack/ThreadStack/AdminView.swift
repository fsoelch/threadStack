import SwiftUI

struct AdminView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @Environment(\.dismiss) var dismiss
    @State private var users: [AdminUser] = []
    @State private var hasLoaded = false
    @State private var loadFailedOffline = false
    @State private var showNew = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if OfflineFeatureBLogic.showsUnavailable(isOffline: offline.isOffline,
                                                         hasContent: hasLoaded,
                                                         loadFailedWithTransport: loadFailedOffline) {
                    OfflineUnavailableView(reason: .notLoadedYet) { Task { await load() } }
                } else {
                    List {
                        ForEach(users) { user in
                            UserRowView(user: user, isOffline: offline.isOffline, onDelete: { deleteUser(user) })
                        }
                    }
                }
            }
            .navigationTitle("Benutzerverwaltung")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                        .disabledWhenOfflineCompact(offline.isOffline)
                        .accessibilityLabel("Neuer Benutzer")
                }
            }
            .onChange(of: offline.isOffline) { was, now in
                if OfflineFeatureBLogic.shouldReloadAfterConnectivityChange(
                    wasOffline: was, isOffline: now, hasContent: hasLoaded) {
                    Task { await load() }
                }
            }
            .task { await load() }
            .sheet(isPresented: $showNew, onDismiss: { Task { await load() } }) {
                NewUserSheet()
            }
            .errorAlert($error)
        }
    }

    private func load() async {
        guard OfflineFeatureBLogic.shouldPerformRequest(isOffline: offline.isOffline) else { return }
        loadFailedOffline = false
        do { users = try await state.fetchUsers(); hasLoaded = true }
        catch {
            if isTransportFailure(error) { loadFailedOffline = true }
            else { self.error = error.localizedDescription }
        }
    }

    private func deleteUser(_ user: AdminUser) {
        guard !offline.isOffline else { state.showToast(OfflineFeatureBLogic.blockedToast); return }
        Task {
            do { try await state.deleteUser(id: user.id); await load() }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct UserRowView: View {
    let user: AdminUser
    var isOffline: Bool = false
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
                .disabledWhenOfflineCompact(isOffline)
                .accessibilityLabel("Benutzer \(user.username) löschen")
        }
    }
}

struct NewUserSheet: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
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
                if offline.isOffline {
                    Section {
                        Text(OfflineFeatureBLogic.blockedDialogMessage)
                            .foregroundStyle(.secondary).font(.footnote)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Neuer Benutzer")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Erstellen") { create() }
                        .disabled(!OfflineFeatureBLogic.canSave(isOffline: offline.isOffline,
                                                                inputValid: !username.isEmpty && !password.isEmpty,
                                                                isBusy: loading))
                        .accessibilityHint(offline.isOffline ? OfflineTexts.unavailableTitle : "")
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
            } catch {
                self.error = isTransportFailure(error)
                    ? OfflineFeatureBLogic.blockedDialogMessage : error.localizedDescription
                loading = false
            }
        }
    }
}
