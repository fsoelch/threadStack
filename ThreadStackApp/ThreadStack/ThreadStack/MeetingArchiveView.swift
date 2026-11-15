import SwiftUI

/// Archiv-Bereich (Paket A1, "Meetings archivieren statt löschen"). Zeigt alle
/// archivierten Meetings serverseitig gefiltert/durchsuchbar an und erlaubt
/// Wiederherstellen (sofort) sowie endgültiges Löschen (mit Preflight + Bestätigung).
/// Server-Vertrag: `GET/POST/DELETE /api/archive/meeting(s)/...` (bereits gemergt,
/// siehe Paket B1-B3) — Details in `AppState.swift` (`loadArchivedMeetings`,
/// `restoreMeeting`, `archivePreflight`, `permanentlyDeleteMeeting`).
struct MeetingArchiveView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @State private var loadFailedOffline = false
    @State private var search = ""
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var searchTask: Task<Void, Never>?
    @State private var infoMessage: String?
    @State private var error: String?

    // Endgültig-löschen-Flow: erst Preflight laden, dann Bestätigungsdialog mit
    // den geladenen Zahlen zeigen (Vertrag Punkt 2).
    @State private var deleteCandidate: ArchivedMeetingListItem?
    @State private var deletePreflight: ArchivePreflight?
    @State private var isLoadingPreflight = false
    @State private var showPermanentDeleteConfirm = false

    var body: some View {
        Group {
            if OfflineFeatureBLogic.showsUnavailable(isOffline: offline.isOffline,
                                                     hasContent: !state.archivedMeetings.isEmpty,
                                                     loadFailedWithTransport: loadFailedOffline) {
                // Archiv wird nicht zwischengespeichert (UX S1/S11, Screen 8).
                OfflineUnavailableView(reason: .notLoadedYet) { Task { await reload() } }
            } else if isLoading && state.archivedMeetings.isEmpty && loadError == nil {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError, state.archivedMeetings.isEmpty {
                VStack(spacing: 12) {
                    Text(loadError).foregroundStyle(.secondary).font(.footnote)
                    Button("Erneut versuchen") { Task { await reload() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if state.archivedMeetings.isEmpty {
                ContentUnavailableView(
                    "Noch keine archivierten Meetings",
                    systemImage: "archivebox",
                    description: Text("Archivierte Meetings landen hier — du kannst sie jederzeit wiederherstellen oder endgültig löschen.")
                )
            } else {
                list
            }
        }
        .navigationTitle("Archiv")
        .searchable(text: $search, prompt: "Archiv durchsuchen")
        .onChange(of: search) { _, newValue in triggerSearch(newValue) }
        .onChange(of: offline.isOffline) { was, now in
            // Verbindung zurueck: ohne Neustart nachladen.
            if OfflineFeatureBLogic.shouldReloadAfterConnectivityChange(
                wasOffline: was, isOffline: now, hasContent: !state.archivedMeetings.isEmpty) {
                Task { await reload() }
            }
        }
        .task { await reload() }
        .errorAlert($error)
        .alert("Erfolg", isPresented: Binding(get: { infoMessage != nil }, set: { if !$0 { infoMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(infoMessage ?? "") }
        .confirmationDialog(
            "Meeting endgültig löschen?",
            isPresented: $showPermanentDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Endgültig löschen", role: .destructive) { performPermanentDelete() }
            Button("Abbrechen", role: .cancel) { deleteCandidate = nil; deletePreflight = nil }
        } message: {
            if let candidate = deleteCandidate, let preflight = deletePreflight {
                Text(archiveDeleteImpactText(title: candidate.title, impact: preflight.impact))
            } else {
                Text("Löschumfang konnte nicht ermittelt werden. Bitte versuche es erneut.")
            }
        }
    }

    private var list: some View {
        List(state.archivedMeetings) { item in
            NavigationLink {
                MeetingDetailView(meetingId: item.id, isReadOnly: true)
            } label: {
                row(item)
            }
            .swipeActions(edge: .leading) {
                Button {
                    restore(item)
                } label: {
                    Label("Wiederherstellen", systemImage: "tray.and.arrow.up")
                }
                .disabledWhenOfflineCompact(offline.isOffline)
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await requestPermanentDelete(item) }
                } label: {
                    Label("Endgültig löschen", systemImage: "trash")
                }
                .disabledWhenOfflineCompact(offline.isOffline)
            }
        }
        .listStyle(.plain)
    }

    private func row(_ item: ArchivedMeetingListItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(Color(hex: item.color)).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.subheadline).fontWeight(.medium).lineLimit(1)
                HStack(spacing: 6) {
                    Text(archiveTopicsSummaryText(topicCount: item.topicCount, openTopicCount: item.openTopicCount))
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(DS.accent.opacity(0.12))
                        .foregroundStyle(DS.accent)
                        .clipShape(Capsule())
                    Label(archiveArchivedAtChipText(item.archivedAt), systemImage: "archivebox")
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.12))
                        .foregroundStyle(.secondary)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func reload() async {
        // Offline gar nicht erst anfragen (kein Fehlerflackern, UX S1).
        guard OfflineFeatureBLogic.shouldPerformRequest(isOffline: offline.isOffline) else { return }
        isLoading = true
        loadError = nil
        loadFailedOffline = false
        do {
            try await state.loadArchivedMeetings(q: search)
        } catch {
            loadFailedOffline = isTransportFailure(error)
            loadError = "Archiv konnte nicht geladen werden."
        }
        isLoading = false
    }

    /// Debounced serverseitige Suche (kein lokales Filtern) — analog zum
    /// bestehenden `KnowledgeRelatedPickerSheet.triggerSearch`-Muster (300ms
    /// Debounce über `Task.sleep` + Cancel-Check), aber ohne Mindestlängen-Gate:
    /// der Server liefert bei leerer Query bereits alle archivierten Meetings.
    private func triggerSearch(_ q: String) {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await reload()
        }
    }

    /// Wiederherstellen ist laut Vertrag eine sofortige Aktion ohne Bestätigung
    /// (reversibel). Der Server entfernt den Eintrag aus der Archivliste; wir
    /// stoßen zusätzlich einen Reload an, da `restoreMeeting` selbst nur
    /// `archivedMeetings` optimistisch bereinigt, ein serverseitiger Offset/Total-
    /// Abgleich aber der Suchsituation treu bleiben soll.
    private func restore(_ item: ArchivedMeetingListItem) {
        guard !offline.isOffline else { state.showToast(OfflineFeatureBLogic.blockedToast); return }
        Task {
            do {
                try await state.restoreMeeting(item.id)
                infoMessage = "Meeting wiederhergestellt."
            } catch {
                self.error = "Meeting konnte nicht wiederhergestellt werden. Bitte versuche es erneut."
            }
        }
    }

    private func requestPermanentDelete(_ item: ArchivedMeetingListItem) async {
        guard !offline.isOffline else { state.showToast(OfflineFeatureBLogic.blockedToast); return }
        deleteCandidate = item
        isLoadingPreflight = true
        do {
            deletePreflight = try await state.archivePreflight(item.id)
            showPermanentDeleteConfirm = true
        } catch {
            self.error = "Löschumfang konnte nicht ermittelt werden. Bitte versuche es erneut."
            deleteCandidate = nil
        }
        isLoadingPreflight = false
    }

    private func performPermanentDelete() {
        guard let candidate = deleteCandidate else { return }
        Task {
            do {
                try await state.permanentlyDeleteMeeting(candidate.id)
                infoMessage = archiveDeletedSuccessText(title: candidate.title)
            } catch {
                self.error = "Meeting konnte nicht endgültig gelöscht werden. Bitte versuche es erneut."
            }
            deleteCandidate = nil
            deletePreflight = nil
        }
    }
}

// MARK: - Reine Formatierungs-Hilfsfunktionen (unit-testbar, top-level analog
// zu `knowledgeRelatedPickerShouldSearch` in KnowledgeRelatedPickerSheet.swift)

/// Chip-Text "{N} Themen · {N} erledigt" (Vertrag Punkt 2). `openTopicCount`
/// kommt vom Server; bei unerwarteten Werten (z.B. openTopicCount > topicCount)
/// wird die erledigt-Zahl defensiv auf 0 statt negativ geklemmt.
func archiveTopicsSummaryText(topicCount: Int, openTopicCount: Int) -> String {
    let done = max(0, topicCount - openTopicCount)
    return "\(topicCount) Themen · \(done) erledigt"
}

/// Chip-Text "Archiviert am {Datum}" (Vertrag Punkt 2), nutzt dieselbe
/// Datumsformatierung wie der Rest der App (`formatDateOnly`, Models.swift).
func archiveArchivedAtChipText(_ archivedAt: String) -> String {
    "Archiviert am \(formatDateOnly(String(archivedAt.prefix(10))))"
}

/// Text für den "Endgültig löschen?"-Bestätigungsdialog: nennt Titel UND die
/// wichtigsten Zahlen aus dem Preflight-Impact (Vertrag Punkt 2/3).
func archiveDeleteImpactText(title: String, impact: ArchiveImpact) -> String {
    "„\(title)\" wird endgültig gelöscht: \(impact.topics) Themen, " +
    "\(impact.progressEntries) Fortschrittseinträge, \(impact.attachments) Anhänge. " +
    "Diese Aktion kann nicht rückgängig gemacht werden."
}

/// Erfolgstext nach endgültigem Löschen (Vertrag: „{Titel}\" endgültig gelöscht.").
func archiveDeletedSuccessText(title: String) -> String {
    "„\(title)\" endgültig gelöscht."
}
