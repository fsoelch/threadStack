import SwiftUI

// MARK: - Sichtbarer Fortschritt (Arbeitspaket M5) — generischer Toast
//
// Es gibt in der iOS-App bisher KEINE wiederverwendbare transiente Toast-/
// Snackbar-Komponente (nur `.errorAlert` in Extensions.swift, ein dauerhafter
// Alert-Dialog - kein automatisch verschwindender Hinweis). Dieses Modul
// ergänzt genau das, analog zum bestehenden Web-Pendant (public/app.js#toast,
// `#toast-container`). Angebunden über `AppState.toastQueue`/`showToast`.
struct ToastOverlayView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack {
            if let toast = state.currentToast {
                ToastBubble(toast: toast)
                    .id(toast.id)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: toast.id) {
                        let seconds = toast.emphasized ? 4.2 : 3.5
                        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                        state.dismissCurrentToast(id: toast.id)
                    }
            }
            Spacer()
        }
        .padding(.top, 8)
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: state.currentToast)
        .allowsHitTesting(false)
    }
}

private struct ToastBubble: View {
    let toast: ToastMessage

    var body: some View {
        Text(toast.text)
            .font(.footnote).fontWeight(.medium)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.15), radius: 6, x: 0, y: 2)
            .padding(.horizontal, 24)
    }
}
