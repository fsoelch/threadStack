import SwiftUI

//  PendingChangeDetailView.swift
//  Arbeitspaket P4: Fehlerausloesung fuer einen Eintrag (UX "FailedEntrySheet").
//  Bearbeiten laeuft ueber die bestehenden Formulare (PendingEditForm); die
//  Aktionen Neu zuordnen / Als Todo uebernehmen / Verwerfen / Erneut senden
//  gehen ueber `OfflineStatusStore.intents`.

// MARK: - Logik (rein, testbar)

enum PendingDetailAction: Equatable {
    case edit, retry, reassign, convertToTodo, copy, discard
}

enum PendingDetailLogic {
    static let failedTitle = "Änderung fehlgeschlagen"
    static let blockedTitle = "Änderung wartet"
    static let pendingTitle = "Ausstehende Änderung"

    /// Sheet-Titel nach Status.
    static func title(for status: PendingItemStatus) -> String {
        switch status {
        case .failed: return failedTitle
        case .blocked: return blockedTitle
        case .pending, .syncing: return pendingTitle
        }
    }
    static let editTitle = "Bearbeiten und erneut senden"
    static let retryTitle = "Erneut senden"
    static let reassignTitle = "Anderem Meeting zuordnen"
    static let convertTitle = "Als Todo übernehmen"
    static let copyTitle = "Inhalt kopieren"
    static let discardTitle = OfflineTexts.discardButton
    static let copiedToast = "Kopiert"
    static let convertedToast = "Als Todo übernommen."
    static let sentToast = "Übertragen."
    static let pendingReason = OfflineTexts.pendingNote
    static let syncingReason = "Wird synchronisiert …"

    static func actionTitle(_ a: PendingDetailAction) -> String {
        switch a {
        case .edit: return editTitle
        case .retry: return retryTitle
        case .reassign: return reassignTitle
        case .convertToTodo: return convertTitle
        case .copy: return copyTitle
        case .discard: return discardTitle
        }
    }

    static func actionIcon(_ a: PendingDetailAction) -> String {
        switch a {
        case .edit: return "pencil"
        case .retry: return "arrow.clockwise"
        case .reassign: return "arrow.triangle.swap"
        case .convertToTodo: return "checkmark.circle"
        case .copy: return "doc.on.doc"
        case .discard: return "trash"
        }
    }

    /// Aktionsmenge je Typ/Status in UX-Reihenfolge.
    /// - failed: Bearbeiten, Erneut senden, (Thema: Zuordnen, Als Todo), Kopieren, Verwerfen
    /// - blocked (abhaengig von einem fehlgeschlagenen/wartenden Vorhaben): nur Kopieren, Verwerfen
    /// - pending: Bearbeiten, Kopieren, Verwerfen
    /// - syncing: nur Kopieren (Verwerfen/Bearbeiten erst nach der Uebertragung)
    static func actions(kind: PendingChangeKind, status: PendingItemStatus) -> [PendingDetailAction] {
        switch status {
        case .syncing:
            return [.copy]
        case .blocked:
            return [.copy, .discard]
        case .pending:
            return [.edit, .copy, .discard]
        case .failed:
            var a: [PendingDetailAction] = [.edit, .retry]
            if kind == .createTopic { a += [.reassign, .convertToTodo] }
            a += [.copy, .discard]
            return a
        }
    }

    /// Statustext (Grund) fuer die Kopfzeile.
    static func reasonText(for status: PendingItemStatus) -> String {
        switch status {
        case .failed(let m), .blocked(let m): return m
        case .pending: return pendingReason
        case .syncing: return syncingReason
        }
    }

    /// Text fuer die Zwischenablage: gesamter Inhalt, ersatzweise der Titel.
    static func copyText(for item: PendingItemSummary) -> String {
        let full = item.fullText.trimmingCharacters(in: .whitespacesAndNewlines)
        return full.isEmpty ? item.title : item.fullText
    }
}

// MARK: - View

struct PendingChangeDetailView: View {
    let itemId: UUID

    @EnvironmentObject private var offline: OfflineStatusStore
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var isSending = false
    @State private var editTarget: PendingEditTarget?
    @State private var showPicker = false
    @State private var discardRequest: OfflineDiscardRequest?
    @State private var errorText: String?

    private var item: PendingItemSummary? { offline.items.first { $0.id == itemId } }

    var body: some View {
        NavigationStack {
            Group {
                if let item { content(item) } else { Color.clear }
            }
            .navigationTitle(item.map { PendingDetailLogic.title(for: $0.status) } ?? PendingDetailLogic.failedTitle)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 440)
        #endif
        .onChange(of: item == nil) { _, gone in
            // Uebertragen oder verworfen: Sheet schliesst (Toast entscheidet nur der Retry-Task).
            if gone { dismiss() }
        }
        .sheet(item: $editTarget) { PendingEditForm(target: $0) }
        .sheet(isPresented: $showPicker) {
            PendingMeetingPickerSheet(currentMeetingId: currentMeetingId) { newId in reassign(to: newId) }
        }
        .offlineDiscardDialog($discardRequest) { request in
            guard let it = PendingChangesLogic.item(for: request, in: offline.items) else { return }
            do { try offline.intents.discard(it.id) } catch { errorText = PendingChangesLogic.errorMessage(for: error) }
        }
        .errorAlert($errorText)
    }

    private var currentMeetingId: String? {
        if case .topic(let p)? = offline.intents.payload(itemId) { return p.meetingId }
        return nil
    }

    @ViewBuilder
    private func content(_ item: PendingItemSummary) -> some View {
        let isFailed = PendingChangesLogic.isFailed(item.status)
        Form {
            Section("Grund") {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: PendingSyncBadgeLogic.iconName(for: PendingSyncBadgeLogic.kind(for: item.status)))
                        .foregroundStyle(isFailed ? DS.dangerFg : Color.secondary)
                        .accessibilityHidden(true)
                    Text(PendingDetailLogic.reasonText(for: item.status))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            Section("Inhalt") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(PendingChangesLogic.typeLabel(item.kind)).scaledFont(.caption).foregroundStyle(.secondary)
                    Text(PendingChangesLogic.displayTitle(item)).scaledFont(.headline)
                    if let c = item.contextText, !c.isEmpty {
                        Text(c).scaledFont(.caption).foregroundStyle(.secondary)
                    }
                    Text(PendingDetailLogic.copyText(for: item))
                        .scaledFont(.body)
                        .textSelection(.enabled)
                }
                .accessibilityElement(children: .contain)
            }
            Section {
                ForEach(PendingDetailLogic.actions(kind: item.kind, status: item.status), id: \.self) { action in
                    actionButton(action, item: item)
                }
                if isSending {
                    HStack { ProgressView(); Text("Wird gesendet …") }.accessibilityElement(children: .combine)
                }
            }
        }
        #if os(macOS)
        .formStyle(.grouped)
        #endif
    }

    @ViewBuilder
    private func actionButton(_ action: PendingDetailAction, item: PendingItemSummary) -> some View {
        let label = Label(PendingDetailLogic.actionTitle(action), systemImage: PendingDetailLogic.actionIcon(action))
        switch action {
        case .discard:
            Button(role: .destructive) { discardRequest = PendingChangesLogic.discardRequest(for: item, offline: offline) } label: { label }
                .keyboardShortcut(.delete, modifiers: .command)
                .disabled(isSending)
        case .reassign, .convertToTodo, .retry, .edit, .copy:
            Button { perform(action, item: item) } label: { label }
                .disabled(isSending && action != .copy)
        }
    }

    private func perform(_ action: PendingDetailAction, item: PendingItemSummary) {
        switch action {
        case .copy:
            LocalClipboard.copyPlainText(PendingDetailLogic.copyText(for: item))
            state.showToast(PendingDetailLogic.copiedToast)
        case .edit:
            if let t = PendingEditTarget.make(summary: item, payload: offline.intents.payload(item.id)) {
                editTarget = t
            } else {
                errorText = PendingChangesLogic.genericError
            }
        case .retry:
            retry(item)
        case .reassign:
            showPicker = true
        case .convertToTodo:
            do {
                try offline.intents.convertTopicToTodo(item.id)
                state.showToast(PendingDetailLogic.convertedToast)
            } catch { errorText = PendingChangesLogic.errorMessage(for: error) }
        case .discard:
            discardRequest = PendingChangesLogic.discardRequest(for: item, offline: offline)
        }
    }

    private func retry(_ item: PendingItemSummary) {
        do {
            try offline.intents.retry(item.id)
        } catch {
            errorText = PendingChangesLogic.errorMessage(for: error)
            return
        }
        isSending = true
        Task {
            await offline.intents.syncNow()
            isSending = false
            // Nur nach erfolgreicher Uebertragung (Eintrag verschwunden) - nicht nach Verwerfen.
            if !offline.items.contains(where: { $0.id == item.id }) { state.showToast(PendingDetailLogic.sentToast) }
        }
    }

    private func reassign(to meetingId: String) {
        do {
            try offline.intents.reassignTopic(itemId, meetingId)
            // Der Eintrag ist wieder ausstehend; Uebertragung anstossen, Fehler zeigt der Store.
            Task { await offline.intents.syncNow() }
        } catch {
            errorText = PendingChangesLogic.errorMessage(for: error)
        }
    }
}
