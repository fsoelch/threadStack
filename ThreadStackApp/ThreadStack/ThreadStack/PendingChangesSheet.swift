import SwiftUI

//  PendingChangesSheet.swift
//  Arbeitspaket P4: Liste der ausstehenden Aenderungen (UX Screen 3).
//  Bearbeiten erfolgt AUSSCHLIESSLICH ueber die bestehenden Formulare
//  (TodoFormView, TopicFormView, ProgressEntryEditorSheet) mit der lokalen ID;
//  es gibt hier keine eigenen Bearbeiten-Formulare. Daten und Aktionen kommen
//  nur aus dem `OfflineStatusStore` und dessen `intents`.

// MARK: - Logik (rein, testbar)

enum PendingChangesLogic {
    static let title = "Ausstehende Änderungen"
    static let emptyText = "Alles übertragen. Es gibt keine ausstehenden Änderungen."
    static let failedSectionTitle = "Fehlgeschlagen"
    static let pendingSectionTitle = "Ausstehend"
    static let syncNowTitle = "Jetzt synchronisieren"
    static let offlineSyncHint = "Keine Verbindung"
    static let genericError = "Die Aktion konnte nicht ausgeführt werden."

    static func isFailed(_ s: PendingItemStatus) -> Bool { if case .failed = s { return true } else { return false } }

    /// Kopf: "N ausstehend, M fehlgeschlagen" (Teile mit 0 entfallen); `nil` bei leerer Liste.
    static func headerText(items: [PendingItemSummary]) -> String? {
        let failed = items.filter { isFailed($0.status) }.count
        return OfflineBannerLogic.summaryText(outstanding: items.count - failed, failed: failed)
    }

    /// Fehlgeschlagene oben, dann der Rest; innerhalb der Gruppen Erfassungsreihenfolge (Eingabe ist nach seq sortiert).
    static func failedItems(_ items: [PendingItemSummary]) -> [PendingItemSummary] { items.filter { isFailed($0.status) } }
    static func outstandingItems(_ items: [PendingItemSummary]) -> [PendingItemSummary] { items.filter { !isFailed($0.status) } }

    static func typeLabel(_ kind: PendingChangeKind) -> String {
        switch kind {
        case .createTodo: return "Todo"
        case .createTopic: return "Thema"
        case .createProgressEntry: return "Zwischenstand"
        }
    }

    static func typeIcon(_ kind: PendingChangeKind) -> String {
        switch kind {
        case .createTodo: return "checkmark.circle"
        case .createTopic: return "text.bubble"
        case .createProgressEntry: return "chart.line.uptrend.xyaxis"
        }
    }

    /// Anzeigetitel; leere Titel (z.B. leerer Zwischenstand-Vorschau) bekommen den Typnamen.
    static func displayTitle(_ item: PendingItemSummary) -> String {
        let t = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? typeLabel(item.kind) : t
    }

    /// Zusatzzeile: Kontext (Meeting/Vorhaben) und Erfassungszeit (UX-Entscheidung 9: in der Liste immer).
    static func subtitle(_ item: PendingItemSummary, now: Date = Date(), calendar: Calendar = .current) -> String {
        var parts: [String] = []
        if let c = item.contextText, !c.isEmpty { parts.append(c) }
        parts.append("erfasst " + OfflineDataAsOfFormatter.string(for: item.capturedAt, now: now, calendar: calendar))
        return parts.joined(separator: " · ")
    }

    /// VoiceOver-Beschreibung der Zeile, z.B. "Todo 'Titel'".
    static func itemDescription(_ item: PendingItemSummary) -> String {
        "\(typeLabel(item.kind)) '\(displayTitle(item))'"
    }

    static func rowAccessibilityLabel(_ item: PendingItemSummary, now: Date = Date(), calendar: Calendar = .current) -> String {
        let kind = PendingSyncBadgeLogic.kind(for: item.status)
        var s = PendingSyncBadgeLogic.accessibilityLabel(for: kind, itemDescription: itemDescription(item))
        switch item.status {
        case .failed(let m), .blocked(let m): s += ". \(m)"
        default: break
        }
        if let c = item.contextText, !c.isEmpty { s += ". \(c)" }
        s += ". Erfasst " + OfflineBannerLogic.spokenDate(item.capturedAt, now: now, calendar: calendar)
        return s
    }

    enum RowTap: Equatable { case detail, editForm }

    /// Fehlgeschlagene und wartende Eintraege oeffnen die Fehlerauflösung, ausstehende/sendende das Formular.
    static func tapTarget(for status: PendingItemStatus) -> RowTap {
        switch status {
        case .failed, .blocked: return .detail
        case .pending, .syncing: return .editForm
        }
    }

    /// Anfrage fuer den gemeinsamen Verwerfen-Dialog (`offlineDiscardDialog`). Der Hinweis auf
    /// abhaengige Zwischenstaende entfaellt fuer Zwischenstaende selbst.
    @MainActor
    static func discardRequest(for item: PendingItemSummary, offline: OfflineStatusStore) -> OfflineDiscardRequest {
        let hint = item.kind != .createProgressEntry
        if let entityId = item.entityId {
            return offline.discardRequest(forEntityId: entityId, title: item.title, showsDependentsHint: hint)
        }
        return OfflineDiscardRequest(id: item.id.uuidString, title: item.title,
                                     dependents: offline.intents.dependentsCount(item.id),
                                     showsDependentsHint: hint)
    }

    /// Loest die Anfrage wieder auf den Eintrag auf (Entity-ID oder, ohne Entity-ID, UUID).
    static func item(for request: OfflineDiscardRequest, in items: [PendingItemSummary]) -> PendingItemSummary? {
        items.first { $0.entityId == request.id || $0.id.uuidString == request.id }
    }

    /// Fehlertext fuer Nutzer; interne Fehler leaken keine Details.
    static func errorMessage(for error: Error) -> String {
        if let e = error as? OfflineError, let d = e.errorDescription { return d }
        return genericError
    }
}

/// Ziel fuer die bestehenden Bearbeiten-Formulare.
enum PendingEditTarget: Identifiable {
    case todo(TodoItem)
    case topic(meetingId: String, topic: Topic)
    case progress(entry: ProgressEntry, refType: String, refId: String)

    var id: String {
        switch self {
        case .todo(let t): return t.id
        case .topic(_, let t): return t.id
        case .progress(let e, _, _): return e.id
        }
    }

    /// Baut das lokale Objekt ueber die `PendingChange.local*`-Builder aus P2 (keine zweite Implementierung).
    /// `nil`, wenn Payload fehlt (z.B. inzwischen uebertragen) oder die Referenz eines Zwischenstands unbekannt ist.
    static func make(summary: PendingItemSummary, payload: PendingPayload?) -> PendingEditTarget? {
        guard let payload else { return nil }
        // Annahme: Schein-PendingChange dient nur als Huelle fuer die P2-Builder
        // (`local*`). Die lokale ID leitet sich allein aus `id` ab; seq, Token, Status
        // usw. sind fuer die Builder ohne Bedeutung.
        let change = PendingChange(id: summary.id, seq: 0, clientToken: "", capturedAt: summary.capturedAt,
                                   payload: payload, state: .pending, revision: 0, followUp: .none,
                                   isTombstone: false, attemptCount: 0, lastAttemptAt: nil,
                                   acknowledgedObject: nil)
        switch payload {
        case .todo:
            return change.localTodoItem().map { .todo($0) }
        case .topic(let p):
            return change.localTopic().map { .topic(meetingId: p.meetingId, topic: $0) }
        case .progress:
            guard let rt = summary.refType, let rid = summary.refId,
                  let e = change.localProgressEntry(resolvedRef: (refType: rt, refId: rid)) else { return nil }
            return .progress(entry: e, refType: rt, refId: rid)
        }
    }
}

// MARK: - Sheet

struct PendingChangesSheet: View {
    @EnvironmentObject private var offline: OfflineStatusStore
    @Environment(\.dismiss) private var dismiss

    @State private var detailItem: PendingItemSummary?
    @State private var editTarget: PendingEditTarget?
    @State private var discardRequest: OfflineDiscardRequest?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Group {
                if offline.items.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle(PendingChangesLogic.title)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(PendingChangesLogic.syncNowTitle) { Task { await offline.intents.syncNow() } }
                        .disabledWhenOfflineCompact(offline.isOffline, hint: PendingChangesLogic.offlineSyncHint)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 420)
        #endif
        .sheet(item: $detailItem) { item in
            PendingChangeDetailView(itemId: item.id)
        }
        .sheet(item: $editTarget) { target in
            PendingEditForm(target: target)
        }
        .offlineDiscardDialog($discardRequest) { request in
            guard let item = PendingChangesLogic.item(for: request, in: offline.items) else { return }
            do { try offline.intents.discard(item.id) } catch { errorText = PendingChangesLogic.errorMessage(for: error) }
        }
        .errorAlert($errorText)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 44)).foregroundStyle(.secondary).accessibilityHidden(true)
            Text(PendingChangesLogic.emptyText)
                .scaledFont(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var list: some View {
        let failed = PendingChangesLogic.failedItems(offline.items)
        let rest = PendingChangesLogic.outstandingItems(offline.items)
        return List {
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    if let h = PendingChangesLogic.headerText(items: offline.items) {
                        Text(h).scaledFont(.subheadline).fontWeight(.medium)
                    }
                    OfflineDataAsOfLabel(date: offline.dataAsOf)
                }
                .accessibilityElement(children: .combine)
            }
            if !failed.isEmpty {
                Section(PendingChangesLogic.failedSectionTitle) { ForEach(failed) { row($0) } }
            }
            if !rest.isEmpty {
                Section(PendingChangesLogic.pendingSectionTitle) { ForEach(rest) { row($0) } }
            }
        }
    }

    private func row(_ item: PendingItemSummary) -> some View {
        Button { open(item) } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: PendingChangesLogic.typeIcon(item.kind))
                    .foregroundStyle(.secondary).frame(width: 22).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(PendingChangesLogic.typeLabel(item.kind)).scaledFont(.caption2).foregroundStyle(.secondary)
                    Text(PendingChangesLogic.displayTitle(item)).scaledFont(.body).lineLimit(2)
                    Text(PendingChangesLogic.subtitle(item)).scaledFont(.caption).foregroundStyle(.secondary)
                    PendingSyncBadge(status: item.status)
                }
                Spacer(minLength: 4)
                if item.status == .syncing { ProgressView().controlSize(.small) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PendingChangesLogic.rowAccessibilityLabel(item))
        .accessibilityAddTraits(.isButton)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { discardRequest = PendingChangesLogic.discardRequest(for: item, offline: offline) } label: { Label(OfflineTexts.discardButton, systemImage: "trash") }
        }
        .contextMenu {
            Button(role: .destructive) { discardRequest = PendingChangesLogic.discardRequest(for: item, offline: offline) } label: { Label(OfflineTexts.discardButton, systemImage: "trash") }
        }
    }

    private func open(_ item: PendingItemSummary) {
        switch PendingChangesLogic.tapTarget(for: item.status) {
        case .detail:
            detailItem = item
        case .editForm:
            if let t = PendingEditTarget.make(summary: item, payload: offline.intents.payload(item.id)) {
                editTarget = t
            } else {
                // Inzwischen uebertragen oder verworfen: Liste aktualisiert sich ueber den Store.
                errorText = PendingChangesLogic.genericError
            }
        }
    }
}

/// Oeffnet die BESTEHENDEN Formulare fuer ein lokales Objekt (keine eigenen Bearbeiten-Formulare).
struct PendingEditForm: View {
    let target: PendingEditTarget
    @EnvironmentObject private var progressStore: ProgressStore

    var body: some View {
        switch target {
        case .todo(let t): TodoFormView(todo: t)
        case .topic(let mid, let t): TopicFormView(meetingId: mid, topic: t)
        case .progress(let e, let rt, let rid):
            ProgressEntryEditorSheet(entry: e, refType: rt, refId: rid, store: progressStore)
        }
    }
}
