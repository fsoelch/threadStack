import SwiftUI

//  OfflineGating.swift
//  Gemeinsame Offline-Entscheidungslogik und kleine UI-Bausteine der
//  Feature-Views (Todos, Themen, Meetings, Formulare, Zwischenstaende,
//  Stack, Kontakte, Wissen). Eine Stelle fuer die Regeln, damit die Views
//  nicht jeweils eigene, leicht abweichende Varianten bauen.
//
//  Regeln: Neu anlegen bleibt offline aktiv. Bearbeiten/Verwerfen ist offline
//  nur fuer lokale (noch nicht synchronisierte, `local-…`) Eintraege moeglich.
//  Aktionen, die den Server brauchen (Erledigen, Wieder oeffnen, Snooze,
//  Verschieben, Teilen, Topics, Ansprechpartner, Stack, Reorder, KI ...), sind
//  fuer bestehende Eintraege offline und fuer lokale Eintraege immer (auch
//  online) deaktiviert, weil die AppState-Fassade dort
//  `OfflineError.pendingNotSynced` wirft.
//  Texte stammen ausschliesslich aus `OfflineTexts` bzw. `OfflineError`.

// MARK: - Reine Logik (testbar)

enum OfflineGating {
    static func isLocal(_ id: String) -> Bool { OfflineIds.isLocal(id) }

    /// Aktionen ohne Bezug zu einem bestehenden Eintrag, die nur online gehen
    /// (Meeting bearbeiten, KI, Archiv ...). `nil` = erlaubt.
    static func onlineOnlyReason(isOffline: Bool) -> String? {
        isOffline ? OfflineTexts.unavailableTitle : nil
    }

    /// Grund, warum eine Server-Aktion auf einen BESTEHENDEN Eintrag gesperrt ist; `nil` = erlaubt.
    static func serverActionDisabledReason(id: String, isOffline: Bool) -> String? {
        if isLocal(id) { return OfflineError.pendingNotSynced.errorDescription }
        return onlineOnlyReason(isOffline: isOffline)
    }

    /// Bearbeiten: lokale Eintraege immer, synchronisierte nur online.
    static func editDisabledReason(id: String, isOffline: Bool) -> String? {
        isLocal(id) ? nil : onlineOnlyReason(isOffline: isOffline)
    }

    enum DeleteMode: Equatable {
        /// Normales Loeschen auf dem Server.
        case server
        /// Lokaler Eintrag: Verwerfen (mit Bestaetigung) ueber `deleteX` der Fassade.
        case discardLocal
        case disabled(reason: String)

        var disabledReason: String? {
            if case .disabled(let reason) = self { return reason }
            return nil
        }
        var isDisabled: Bool { disabledReason != nil }
    }

    static func deleteMode(id: String, isOffline: Bool) -> DeleteMode {
        if isLocal(id) { return .discardLocal }
        if let reason = onlineOnlyReason(isOffline: isOffline) { return .disabled(reason: reason) }
        return .server
    }

    /// Topic-/Ansprechpartner-Zuordnung: offline sowie fuer lokale Eintraege
    /// deaktiviert (Server-Request noetig).
    static func relationFieldsDisabled(isOffline: Bool, entryId: String?) -> Bool {
        isOffline || (entryId.map(isLocal) ?? false)
    }

    static func relationFieldsHint(isOffline: Bool) -> String {
        isOffline ? OfflineTexts.unavailableTitle
                  : (OfflineError.pendingNotSynced.errorDescription ?? OfflineTexts.unavailableTitle)
    }

    /// Hinweistext oder `nil`, wenn die Zuordnungsfelder aktiv sind.
    static func relationFieldsHintIfDisabled(isOffline: Bool, entryId: String?) -> String? {
        relationFieldsDisabled(isOffline: isOffline, entryId: entryId) ? relationFieldsHint(isOffline: isOffline) : nil
    }

    /// Zuordnungs-Requests nur fuer Server-IDs; ein lokales Ergebnis (offline
    /// eingereiht) darf sie nicht senden (sonst `pendingNotSynced`).
    static func shouldCommitRelations(savedId: String) -> Bool { !isLocal(savedId) }

    static func discardMessage(title: String, dependents: Int, showsDependentsHint: Bool = true) -> String {
        var text = "'\(title)' wird nicht übertragen und gelöscht."
        if !showsDependentsHint { return text }
        text += " "
        if dependents > 0 {
            text += dependents == 1
                ? "Der zugehörige ausstehende Zwischenstand wird ebenfalls verworfen."
                : "Die \(dependents) zugehörigen ausstehenden Zwischenstände werden ebenfalls verworfen."
        } else {
            text += "Zugehörige ausstehende Zwischenstände werden ebenfalls verworfen."
        }
        return text
    }

    /// Ausstehende Zwischenstaende eines Vorhabens, neueste zuerst. `excludingIds`:
    /// bereits im Server-Verlauf enthaltene IDs (kein Duplikat anzeigen).
    static func pendingEntriesNewestFirst(_ items: [PendingItemSummary],
                                          excludingIds: Set<String> = []) -> [PendingItemSummary] {
        items.filter { item in item.entityId.map { !excludingIds.contains($0) } ?? true }
             .sorted { $0.capturedAt > $1.capturedAt }
    }

    /// Baut aus einem ausstehenden Zwischenstand einen `ProgressEntry` (id `local-…`),
    /// damit `ProgressEntryEditorSheet` unveraendert wiederverwendet wird.
    static func pendingProgressEntry(summary: PendingItemSummary, payload: PendingPayload?,
                                     refType: String, refId: String) -> ProgressEntry? {
        guard let entityId = summary.entityId, case .progress(let p)? = payload else { return nil }
        return p.makeEntry(id: entityId, refType: refType, refId: refId, capturedAt: summary.capturedAt)
    }

    /// Verlauf eines lokalen Vorhabens wird nie vom Server geladen (kein Request mit `local-`-Pfad).
    static func shouldLoadHistory(refId: String) -> Bool { !isLocal(refId) }

    /// Erklaertext zu einem Status (nur fehlgeschlagen/wartend).
    static func statusMessage(for status: PendingItemStatus) -> String? {
        switch status {
        case .failed(let message), .blocked(let message): return message
        case .pending, .syncing: return nil
        }
    }

    // MARK: Platzhalter "Offline nicht verfuegbar"

    /// Verlauf nie geladen und offline -> Platzhalter statt Fehlertext.
    static func showsOfflineUnavailable(for error: ProgressError) -> Bool { error == .offline }

    /// Platzhalter nur offline UND ohne darstellbaren Inhalt (oder wenn der
    /// Ladeversuch offline gescheitert ist und es keinen Inhalt gibt).
    static func showsUnavailable(isOffline: Bool, hasContent: Bool, loadFailedOffline: Bool = false) -> Bool {
        guard !hasContent else { return false }
        return isOffline || loadFailedOffline
    }

    /// Fuer Listen: Platzhalter nur offline, wenn die Liste leer ist UND nie
    /// ein Stand geladen wurde (`dataAsOf == nil`). Eine leere, aber einmal
    /// geladene Liste bleibt ein normaler Leerzustand.
    static func showsUnavailableForList(isOffline: Bool, isEmpty: Bool, dataAsOf: Date?) -> Bool {
        isOffline && isEmpty && dataAsOf == nil
    }

    /// Nutzertext zu einem Fehler: Transportfehler -> "Offline nicht verfuegbar. Deine Eingaben bleiben
    /// erhalten."; `OfflineError` -> sein eigener Text; sonst `fallback`.
    static func message(for error: Error, fallback: String) -> String {
        if let offlineError = error as? OfflineError { return offlineError.errorDescription ?? fallback }
        if isTransportFailure(error) { return OfflineError.notAvailableOffline.errorDescription ?? fallback }
        return fallback
    }
}

/// Wert-Typ, der die Gating-Entscheidungen fuer EINEN Eintrag (Todo, Thema,
/// Zwischenstand) buendelt - ersetzt je View kopierte Computed-Property-Bloecke.
struct OfflineEntryGate: Equatable {
    let id: String
    let isOffline: Bool

    var isLocal: Bool { OfflineGating.isLocal(id) }
    var serverActionReason: String? { OfflineGating.serverActionDisabledReason(id: id, isOffline: isOffline) }
    var editReason: String? { OfflineGating.editDisabledReason(id: id, isOffline: isOffline) }
    var deleteMode: OfflineGating.DeleteMode { OfflineGating.deleteMode(id: id, isOffline: isOffline) }
    var deleteDisabledReason: String? { deleteMode.disabledReason }
    var isDeleteDisabled: Bool { deleteMode.isDisabled }
    /// Lokale Eintraege werden "verworfen", bestehende "geloescht".
    var deleteLabel: String { deleteMode == .discardLocal ? OfflineTexts.discardButton : "Löschen" }
}

/// Anfrage "lokalen Eintrag verwerfen" (Bestaetigungsdialog).
struct OfflineDiscardRequest: Identifiable, Equatable {
    let id: String        // local-… Entity-ID
    let title: String
    let dependents: Int
    /// Hinweis auf abhaengige Zwischenstaende (nur fuer Todo/Thema sinnvoll).
    var showsDependentsHint: Bool = true
}

extension OfflineStatusStore {
    func discardRequest(forEntityId id: String, title: String, showsDependentsHint: Bool = true) -> OfflineDiscardRequest {
        let dependents = summary(forEntityId: id).map { intents.dependentsCount($0.id) } ?? 0
        return OfflineDiscardRequest(id: id, title: title, dependents: dependents,
                                     showsDependentsHint: showsDependentsHint)
    }
}

// MARK: - View-Bausteine

extension View {
    /// Deaktiviert (inkl. accessibilityHint) wenn `reason != nil`; nutzt den
    /// bestehenden `disabledWhenOfflineCompact` ohne Zusatzzeile.
    func offlineGated(_ reason: String?) -> some View {
        disabledWhenOfflineCompact(reason != nil, hint: reason ?? "")
    }

    /// Einheitlicher Bestaetigungsdialog fuer "Eintrag verwerfen?".
    func offlineDiscardDialog(_ request: Binding<OfflineDiscardRequest?>,
                              onConfirm: @escaping (OfflineDiscardRequest) -> Void) -> some View {
        confirmationDialog(
            OfflineTexts.discardTitle,
            isPresented: Binding(get: { request.wrappedValue != nil },
                                 set: { if !$0 { request.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: request.wrappedValue
        ) { r in
            Button(OfflineTexts.discardButton, role: .destructive) { onConfirm(r) }
            Button("Abbrechen", role: .cancel) {}
        } message: { r in
            Text(OfflineGating.discardMessage(title: r.title, dependents: r.dependents,
                                              showsDependentsHint: r.showsDependentsHint))
        }
    }

    /// Laedt neu, sobald die Verbindung zurueck ist (offline -> online) und noch
    /// kein Inhalt vorhanden ist. Liest den `OfflineStatusStore` selbst aus dem Environment.
    func reloadWhenBackOnline(hasContent: Bool, perform action: @escaping () -> Void) -> some View {
        modifier(ReloadWhenBackOnlineModifier(hasContent: hasContent, action: action))
    }
}

private struct ReloadWhenBackOnlineModifier: ViewModifier {
    let hasContent: Bool
    let action: () -> Void
    @EnvironmentObject private var offline: OfflineStatusStore

    func body(content: Content) -> some View {
        content.onChange(of: offline.isOffline) { wasOffline, isOffline in
            if wasOffline && !isOffline && !hasContent { action() }
        }
    }
}

/// Kleiner Zusatztext unter deaktivierten Feldern (z.B. "Offline nicht verfuegbar").
struct OfflineUnavailableHint: View {
    let text: String
    init(_ text: String = OfflineTexts.unavailableTitle) { self.text = text }

    var body: some View {
        Text(text)
            .scaledFont(.caption2)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
    }
}

/// Hinweiszeile in Formularen (z.B. "Offline nicht verfuegbar" bei gesperrtem Speichern).
struct OfflineFormNotice: View {
    let text: String

    var body: some View {
        Section {
            Label(text, systemImage: "wifi.slash")
                .scaledFont(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// Kopf eines Formulars fuer einen lokalen, noch nicht uebertragenen Eintrag:
/// Badge, Hinweis "Dieser Eintrag ist noch nicht uebertragen." und ggf. der Fehler-/Wartetext.
/// Muss in einer `Form`/`List` stehen (liefert eine `Section`).
struct OfflineEntryFormHeader: View {
    let entityId: String
    let title: String
    /// z.B. "Todo", "Thema", "Zwischenstand" (VoiceOver-Label "Todo 'Titel'").
    let accessibilityPrefix: String
    @EnvironmentObject private var offline: OfflineStatusStore

    var body: some View {
        let summary = offline.summary(forEntityId: entityId)
        Section {
            VStack(alignment: .leading, spacing: 6) {
                PendingSyncBadge(status: summary?.status ?? .pending,
                                 accessibilityItem: "\(accessibilityPrefix) '\(title)'")
                Text(OfflineTexts.pendingNote)
                    .scaledFont(.footnote).foregroundStyle(.secondary)
                if let summary, let message = OfflineGating.statusMessage(for: summary.status) {
                    Text(message).scaledFont(.footnote).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}
