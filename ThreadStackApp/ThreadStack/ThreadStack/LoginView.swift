import SwiftUI

struct LoginView: View {
    @EnvironmentObject var state: AppState
    @State private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var loading = false
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 24) {
                // Logo
                VStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color(hex: "#6366f1").opacity(0.12))
                            .frame(width: 72, height: 72)
                        Text("💬").font(.system(size: 36))
                    }
                    Text("ThreadStack")
                        .font(.title2).fontWeight(.bold)
                    Text("Melden Sie sich an, um fortzufahren")
                        .font(.subheadline).foregroundStyle(.secondary)
                }

                // Server URL hint
                if state.serverURL.isEmpty {
                    Button { showSettings = true } label: {
                        Label("Server-URL einrichten", systemImage: "gear")
                            .font(.footnote)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                } else {
                    Text(state.serverURL)
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }

                // Form
                VStack(spacing: 12) {
                    TextField("Benutzername", text: $username)
                        .textContentType(.username)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .textFieldStyle(.roundedBorder)

                    SecureField("Passwort", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await doLogin() } }

                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }

                    Button {
                        Task { await doLogin() }
                    } label: {
                        Group {
                            if loading { ProgressView() } else { Text("Anmelden") }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(hex: "#6366f1"))
                    .disabled(loading || username.isEmpty || password.isEmpty)
                    .controlSize(.large)
                }
            }
            .padding(32)
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: .black.opacity(0.08), radius: 24, x: 0, y: 8)
            .frame(maxWidth: 380)

            Spacer()

            Button("Einstellungen") { showSettings = true }
                .font(.footnote).foregroundStyle(.secondary)
                .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(hex: "#f2f2f7"))
        .sheet(isPresented: $showSettings) { SettingsURLView() }
    }

    private func doLogin() async {
        error = nil; loading = true
        defer { loading = false }
        do {
            try await state.login(username: username, password: password)
            try await state.loadAll()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
