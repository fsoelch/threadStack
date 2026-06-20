import SwiftUI

/// Sperrt die App beim Start, wenn gespeicherte Anmeldedaten existieren.
/// Auto-Triggert Face ID / Touch ID Unlock beim Erscheinen.
struct LockScreenView: View {
    @EnvironmentObject var state: AppState
    @State private var error: String?
    @State private var attempting = false
    @State private var didAutoAttempt = false
    @State private var showForgetConfirm = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "lock.shield.fill")
                .font(.system(size: 80))
                .foregroundStyle(Color(hex: "#6366f1"))

            VStack(spacing: 6) {
                Text("ThreadStack").font(.title).fontWeight(.bold)
                Text("Geschützt mit \(Keychain.biometryTypeDescription)")
                    .font(.callout).foregroundStyle(.secondary)
            }

            if let error {
                Text(error)
                    .font(.caption).foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            if attempting {
                ProgressView()
            } else {
                Button { Task { await unlock() } } label: {
                    Label("Entsperren", systemImage: lockIconName)
                        .frame(maxWidth: 220)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            Button("Anmeldedaten vergessen", role: .destructive) {
                showForgetConfirm = true
            }
            .font(.caption)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(hex: "#f2f2f7"))
        .task {
            // Genau einmal beim Erscheinen automatisch Face ID auslösen
            if !didAutoAttempt {
                didAutoAttempt = true
                await unlock()
            }
        }
        .alert("Anmeldedaten verwerfen?", isPresented: $showForgetConfirm) {
            Button("Verwerfen", role: .destructive) {
                state.forgetStoredCredentials()
                state.isLocked = false
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Beim nächsten Start musst du dich wieder mit Server-URL, Benutzername und Passwort anmelden.")
        }
    }

    private var lockIconName: String {
        let t = Keychain.biometryTypeDescription
        if t == "Face ID"  { return "faceid" }
        if t == "Touch ID" { return "touchid" }
        if t == "Optic ID" { return "opticid" }
        return "lock"
    }

    private func unlock() async {
        attempting = true
        error = nil
        do {
            try await state.unlockAndAutoLogin()
            try? await state.loadAll()
            await state.loadAiSettings()
            await state.loadStack()
            await state.aiLoadDrift()
        } catch let e as KeychainError {
            switch e {
            case .userCancelled:
                self.error = nil   // User abgebrochen — Retry-Button zeigen
            case .itemNotFound:
                state.forgetStoredCredentials()
                state.isLocked = false
            default:
                self.error = e.errorDescription
            }
        } catch let other {
            self.error = other.localizedDescription
        }
        attempting = false
    }
}
