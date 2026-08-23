//
//  ProgressReentryCardView.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI-Bausteine Progress"): Wiedereinstiegskarte für
//  ein ruhendes Vorhaben. Für die optionale KI-Zusammenfassung wird
//  AUSSCHLIESSLICH das bestehende AI-Re-Entry-Muster wiederverwendet
//  (`AppState.aiReentry(frameId:confirm:)` + `APIAIError.needsConfirmation`-
//  Retry, siehe `StackPanelView.runReentry` in `StackViews.swift`) — kein
//  neuer KI-Aufruf-Mechanismus.
//

import SwiftUI

// MARK: - Reine Logik (testbar)

/// Sichtbarkeitslogik für die Wiedereinstiegskarte/den KI-Button, getrennt
/// vom View-Body.
enum ProgressReentryLogic {
    /// Modell-Bedingung für "Karte grundsätzlich zeigen" (ohne
    /// Dismiss-Zustand — der wird vom `ProgressStore` separat verwaltet,
    /// siehe `store.shouldShowReentry`, das diese Bedingung bereits
    /// einschließt).
    static func shouldShowCard(_ reentry: ProgressReentry) -> Bool {
        reentry.show
    }

    /// Der KI-Button erscheint NUR, wenn der Server einen Re-Entry-Kontext
    /// anbietet UND das bestehende KI-Feature aktiviert ist — kein
    /// deaktivierter/toter Button (siehe Vertrag).
    static func shouldShowAIButton(available: Bool, aiFeatureEnabled: Bool) -> Bool {
        available && aiFeatureEnabled
    }

    /// Reduzierte Kartenvariante (nur Hinweistext + CTA) statt leerer
    /// Teilblöcke, wenn noch gar keine Historie existiert.
    static func isReducedVariant(_ reentry: ProgressReentry) -> Bool {
        reentry.empty
    }
}

// MARK: - View

struct ProgressReentryCardView: View {
    let refType: String
    let refId: String
    @ObservedObject var store: ProgressStore
    @EnvironmentObject var appState: AppState

    @State private var showEntryEditor = false
    @State private var aiSummary: String?
    @State private var aiError: String?
    @State private var aiLoading = false

    var body: some View {
        if let detail = store.detail(refType: refType, refId: refId),
           store.shouldShowReentry(refType: refType, refId: refId) {
            cardBody(detail: detail)
        }
    }

    @ViewBuilder
    private func cardBody(detail: ProgressDetail) -> some View {
        let reentry = detail.reentry
        VStack(alignment: .leading, spacing: 10) {
            header(reentry: reentry)
            if ProgressReentryLogic.isReducedVariant(reentry) {
                Text("Noch kein Zwischenstand erfasst.")
                    .scaledFont(.subheadline).foregroundStyle(.secondary)
            } else {
                content(detail: detail)
            }
            actions(reentry: reentry)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: DS.cardRadius).fill(DS.accentLight.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: DS.cardRadius).strokeBorder(DS.accent.opacity(0.25)))
        .sheet(isPresented: $showEntryEditor) {
            ProgressEntryEditorSheet(mode: .create, refType: refType, refId: refId, store: store)
        }
    }

    private func header(reentry: ProgressReentry) -> some View {
        HStack(alignment: .top) {
            Text("🌙 \(reentry.dormantLabel ?? "Ruht seit einiger Zeit")")
                .scaledFont(.subheadline).fontWeight(.semibold)
            Spacer()
            Button {
                store.dismissReentry(refType: refType, refId: refId)
            } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Wiedereinstiegskarte ausblenden")
        }
    }

    @ViewBuilder
    private func content(detail: ProgressDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            let trimmedGoal = detail.goal.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedGoal.isEmpty {
                Label(trimmedGoal, systemImage: "target")
                    .scaledFont(.footnote)
                    .accessibilityLabel("Zielbild: \(trimmedGoal)")
            }
            if let last = store.entries(refType: refType, refId: refId).first {
                VStack(alignment: .leading, spacing: 2) {
                    Text(last.excerpt).scaledFont(.footnote).lineLimit(3)
                    if let dateText = ProgressDateFormatting.absoluteAndRelative(last.createdAt) {
                        Text(dateText).scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            let trimmedNextStep = detail.nextStep.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedNextStep.isEmpty {
                Label(trimmedNextStep, systemImage: "arrow.right.circle")
                    .scaledFont(.footnote)
                    .accessibilityLabel("Nächster Schritt: \(trimmedNextStep)")
            } else {
                Text("Noch kein nächster Schritt notiert.")
                    .scaledFont(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func actions(reentry: ProgressReentry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let aiSummary {
                Text(aiSummary).scaledFont(.footnote).padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(DS.accent.opacity(0.10))
                    .foregroundStyle(DS.accentDark)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            if let aiError {
                Text(aiError).scaledFont(.caption2).foregroundStyle(.red)
                    .accessibilityLabel(aiError)
            }
            HStack(spacing: 8) {
                if ProgressReentryLogic.shouldShowAIButton(
                    available: reentry.ai.available,
                    aiFeatureEnabled: appState.aiFeatureEnabled(\.reentry)
                ), let frameId = reentry.ai.frameId {
                    Button {
                        Task { await runAI(frameId: frameId) }
                    } label: {
                        if aiLoading { ProgressView() } else { Label("KI-Zusammenfassung", systemImage: "sparkles") }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(aiLoading)
                    .accessibilityLabel("KI-Zusammenfassung anfordern")
                }
                Button {
                    showEntryEditor = true
                } label: {
                    Label("Zwischenstand erfassen", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .accessibilityLabel("Zwischenstand erfassen")
            }
        }
    }

    private func runAI(frameId: String) async {
        aiLoading = true
        aiError = nil
        do {
            let r = try await appState.aiReentry(frameId: frameId)
            aiSummary = r.content.summary
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                let r = try await appState.aiReentry(frameId: frameId, confirm: true)
                aiSummary = r.content.summary
            } catch {
                aiError = error.localizedDescription
            }
        } catch {
            aiError = error.localizedDescription
        }
        aiLoading = false
    }
}
