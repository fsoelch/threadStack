import SwiftUI

struct MeetingDetailView: View {
    // Zwei Einstiegspunkte teilen sich exakt dieselbe View/Logik (CLAUDE.md
    // "Wiederverwendung vor Neuentwicklung" — KEINE zweite View für den
    // Archiv-Nur-Lesen-Fall):
    // - `init(meeting:)`: bestehender Pfad für aktive Meetings, bereits in
    //   `state.meetings` geladen — `current` ist sofort verfügbar, kein Warten.
    // - `init(meetingId:isReadOnly:)`: neuer Pfad für archivierte Meetings
    //   (MeetingArchiveView) — lädt die Nur-Lesen-Momentaufnahme selbst über
    //   `AppState.loadArchivedMeetingDetail(_:)`, bis dahin Ladezustand/Fehler.
    private let providedMeeting: Meeting?
    private let providedMeetingId: String
    let isReadOnly: Bool

    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore
    // Zentrale, app-weite Instanz (analog `progressStore` oben), registriert
    // in `ThreadStackApp.swift` und über `.environmentObject(...)` injiziert.
    @EnvironmentObject var summaryStore: SummaryStore
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var showEdit = false
    @State private var showNewTopic = false
    @State private var error: String?
    @State private var infoMessage: String?
    // v1.1
    @State private var showBrief   = false
    @State private var showCapture = false
    @State private var cmiExpanded = false
    // Story 9 ("Ruhende Vorhaben gezielt wiederfinden") — bislang nur im Web
    // vorhanden (Tester-Fund), hier analog nachgezogen.
    @State private var sortOldestProgressFirst = false
    @State private var showOnlyUndocumented = false

    // Archiv (Nur-Lesen)
    @State private var archivedMeeting: Meeting?
    @State private var isLoadingArchived = false
    @State private var archiveLoadError: String?
    @State private var isRestoring = false
    @State private var isLoadingPreflight = false
    @State private var isDeletingPermanently = false
    @State private var permanentDeletePreflight: ArchivePreflight?
    @State private var showPermanentDeleteConfirm = false

    init(meeting: Meeting, isReadOnly: Bool = false) {
        self.providedMeeting = meeting
        self.providedMeetingId = meeting.id
        self.isReadOnly = isReadOnly
    }

    /// Vertrag (Paket A1, Punkt 2): `MeetingArchiveView` navigiert über
    /// `MeetingDetailView(meetingId:, isReadOnly: true)` zu einer Nur-Lesen-
    /// Momentaufnahme eines archivierten Meetings, das nicht (mehr) in
    /// `state.meetings` enthalten ist (`GET /meetings` liefert keine archivierten
    /// Meetings). Der eigentliche Netzwerk-Load passiert lazy in `.task`, sobald
    /// diese View tatsächlich gerendert wird (NavigationLink-Destinations werden
    /// von SwiftUI nicht vorab ausgewertet) — daher ist die Konstruktion hier billig.
    init(meetingId: String, isReadOnly: Bool = false) {
        self.providedMeeting = nil
        self.providedMeetingId = meetingId
        self.isReadOnly = isReadOnly
    }

    private var current: Meeting? {
        if let providedMeeting {
            return state.meetings.first(where: { $0.id == providedMeeting.id }) ?? providedMeeting
        }
        return archivedMeeting
    }

    var body: some View {
        Group {
            if let current {
                mainBody(current)
            } else if isLoadingArchived {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 12) {
                    Text(archiveLoadError ?? "Archiv konnte nicht geladen werden.")
                        .foregroundStyle(.secondary).font(.footnote)
                    Button("Erneut versuchen") { Task { await loadArchivedIfNeeded(force: true) } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: providedMeetingId) { await loadArchivedIfNeeded() }
        .onAppear {
            if let current { summaryStore.ingest(from: Self.summaryIngestItems(current.topics)) }
        }
        .onChange(of: current?.topics) { _, newValue in
            if let newValue { summaryStore.ingest(from: Self.summaryIngestItems(newValue)) }
        }
    }

    // Additive KI-Zusammenfassungs-Anreicherung aus der bereits geladenen
    // Liste (kein zusätzlicher Netzwerk-Request, siehe SummaryStore.ingest).
    private static func summaryIngestItems(_ items: [Topic]) -> [(refKey: String, pair: AISummaryPair)] {
        items.compactMap { item in
            guard let pair = item.aiSummary else { return nil }
            return (refKey: "topic:\(item.id)", pair: pair)
        }
    }

    private func loadArchivedIfNeeded(force: Bool = false) async {
        guard providedMeeting == nil, isReadOnly else { return }
        guard force || archivedMeeting == nil else { return }
        isLoadingArchived = true
        archiveLoadError = nil
        do {
            archivedMeeting = try await state.loadArchivedMeetingDetail(providedMeetingId)
        } catch {
            archiveLoadError = "Archiv konnte nicht geladen werden."
        }
        isLoadingArchived = false
    }

    // Identisch zum Web-Comparator TSProgress.compareByProgress (public/progress.js).
    private func sortByOldestProgress(_ list: [Topic]) -> [Topic] {
        list.sorted { a, b in
            let aKey = a.progress?.orderKey
            let bKey = b.progress?.orderKey
            if (aKey == nil) != (bKey == nil) { return aKey != nil }
            guard let ak = aKey, let bk = bKey else { return false }
            return ak < bk
        }
    }

    @ViewBuilder private func mainBody(_ current: Meeting) -> some View {
        let filtered: [Topic] = search.isEmpty ? current.topics : current.topics.filter {
            $0.title.localizedCaseInsensitiveContains(search) ||
            $0.description.localizedCaseInsensitiveContains(search)
        }
        let openTopicsBase: [Topic] = {
            var list = filtered.filter { !$0.done && !$0.isSnoozed }
            if showOnlyUndocumented { list = list.filter { $0.progress?.undocumented == true } }
            return list
        }()
        let openTopics:    [Topic] = sortOldestProgressFirst ? sortByOldestProgress(openTopicsBase) : openTopicsBase
        let snoozedTopics: [Topic] = filtered.filter { !$0.done &&  $0.isSnoozed }
        let doneTopics:    [Topic] = filtered.filter {  $0.done }.sorted { $0.resultDate > $1.resultDate }

        List {
            #if os(macOS)
            Section {
                TextField("Themen suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
            }
            #endif

            // Meeting header
            Section {
                meetingHeader(current)
            }

            Section {
                Picker("Sortierung", selection: $sortOldestProgressFirst) {
                    Text("Standard").tag(false)
                    Text("Ältester Stand zuerst").tag(true)
                }
                Toggle("Länger nicht dokumentiert", isOn: $showOnlyUndocumented)
            }

            // Offen
            if openTopics.isEmpty && showOnlyUndocumented {
                Section {
                    Text("✓ Alles aktuell dokumentiert")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else if !openTopics.isEmpty {
                Section(header: sectionHeader("Offen", count: openTopics.count, color: DS.accent)) {
                    if isReadOnly {
                        ForEach(openTopics) { t in
                            TopicRowView(topic: t, meetingId: current.id, isReadOnly: true,
                                         progressStore: progressStore, summaryStore: summaryStore)
                        }
                    } else {
                        ForEach(openTopics) { t in
                            TopicRowView(topic: t, meetingId: current.id,
                                         progressStore: progressStore, summaryStore: summaryStore)
                        }
                            .onDelete { deleteTopic(from: openTopics, at: $0, meetingId: current.id) }
                            .onMove   { moveTopics(in: openTopics, from: $0, to: $1, meetingId: current.id) }
                    }
                }
            }

            // Schlafend
            if !snoozedTopics.isEmpty {
                Section(header: sectionHeader("Schlafend", count: snoozedTopics.count,
                                              color: .gray, icon: "moon.zzz.fill")) {
                    ForEach(snoozedTopics) { t in
                        TopicRowView(topic: t, meetingId: current.id, isReadOnly: isReadOnly,
                                     progressStore: progressStore, summaryStore: summaryStore)
                    }
                }
            }

            // Erledigt
            if !doneTopics.isEmpty {
                Section(header: sectionHeader("Erledigt", count: doneTopics.count, color: .secondary)) {
                    if isReadOnly {
                        ForEach(doneTopics) { t in
                            TopicRowView(topic: t, meetingId: current.id, isReadOnly: true,
                                         progressStore: progressStore, summaryStore: summaryStore)
                        }
                    } else {
                        ForEach(doneTopics) { t in
                            TopicRowView(topic: t, meetingId: current.id,
                                         progressStore: progressStore, summaryStore: summaryStore)
                        }
                            .onDelete { deleteTopic(from: doneTopics, at: $0, meetingId: current.id) }
                    }
                }
            }

            if current.topics.isEmpty {
                Section {
                    Text(isReadOnly
                         ? "Keine Themen vorhanden."
                         : "Noch keine Themen — tippe auf + um das erste hinzuzufügen.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .navigationTitle(current.title)
        #if os(iOS)
        .searchable(text: $search, prompt: "Themen suchen")
        #endif
        #if os(iOS)
        .toolbar {
            if !isReadOnly {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showNewTopic = true } label: { Image(systemName: "plus") }
                }
                ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
            }
        }
        #endif
        .sheet(isPresented: $showEdit)     { MeetingFormView(meeting: current) }
        .sheet(isPresented: $showNewTopic) { TopicFormView(meetingId: current.id) }
        .sheet(isPresented: $showBrief)    { AIBriefSheet(meetingId: current.id) }
        .sheet(isPresented: $showCapture)  { AICaptureSheet(meetingId: current.id) }
        .errorAlert($error)
        .alert("Erfolg", isPresented: Binding(
            get: { infoMessage != nil },
            set: { if !$0 { infoMessage = nil; dismiss() } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(infoMessage ?? "") }
        .confirmationDialog(
            "Meeting endgültig löschen?",
            isPresented: $showPermanentDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Endgültig löschen", role: .destructive) { permanentlyDelete(current) }
            Button("Abbrechen", role: .cancel) { permanentDeletePreflight = nil }
        } message: {
            if let preflight = permanentDeletePreflight {
                Text(archiveDeleteImpactText(title: current.title, impact: preflight.impact))
            } else {
                Text("Löschumfang konnte nicht ermittelt werden. Bitte versuche es erneut.")
            }
        }
        .task(id: current.id) {
            guard !isReadOnly else { return }
            await state.aiCmiLoad(meetingId: current.id)
        }
    }

    // ── Meeting header card ──────────────────────────────────
    @ViewBuilder private func meetingHeader(_ current: Meeting) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if isReadOnly, let archivedAt = current.archivedAt {
                archivedBanner(current, archivedAt: archivedAt)
            }

            // Info-Zeilen mit Accent-Streifen links
            HStack(alignment: .top, spacing: 0) {
                Rectangle()
                    .fill(DS.accent)
                    .frame(width: 4)
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                    .padding(.trailing, 10)
                VStack(alignment: .leading, spacing: 4) {
                    if !current.description.isEmpty {
                        Text(current.description)
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if !current.participants.isEmpty {
                        Label(current.participants.joined(separator: ", "), systemImage: "person.2")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let d = current.nextDateFormatted {
                        Label(d, systemImage: "calendar")
                            .font(.caption)
                            .foregroundStyle(current.isPast ? DS.orange : .secondary)
                    }
                    if current.isRecurring {
                        Label(recLabel(current.recurrencePattern), systemImage: "repeat")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .frame(minHeight: 40)

            // Action-Chips (horizontal scrollend auf iOS) — bei isReadOnly
            // vollständig ausgeblendet (nicht nur deaktiviert): archivierte
            // Meetings sind serverseitig ohnehin schreibgeschützt (409
            // ARCHIVED_READONLY), die UI soll das gar nicht erst anbieten.
            if !isReadOnly {
                #if os(iOS)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        actionChip("Bearbeiten", icon: "pencil", accent: false) { showEdit = true }
                        if current.isRecurring && !current.nextDate.isEmpty {
                            actionChip("Nächster Termin", icon: "arrow.clockwise", accent: false) {
                                Task { do { try await state.advanceDate(current.id) }
                                      catch { self.error = error.localizedDescription } }
                            }
                        }
                        if state.aiFeatureEnabled(\.brief) {
                            actionChip("Briefing", icon: "sparkles", accent: true) { showBrief = true }
                        }
                        if state.aiFeatureEnabled(\.capture) {
                            actionChip("Notizen", icon: "square.and.pencil", accent: true) { showCapture = true }
                        }
                    }
                    .padding(.horizontal, 1)
                }
                #else
                HStack(spacing: 8) {
                    Button { showEdit = true } label: {
                        Label("Bearbeiten", systemImage: "pencil")
                    }.buttonStyle(.bordered).controlSize(.small)
                    Button { showNewTopic = true } label: {
                        Label("Neues Thema", systemImage: "plus")
                    }.buttonStyle(.bordered).controlSize(.small)
                    if current.isRecurring && !current.nextDate.isEmpty {
                        Button {
                            Task { do { try await state.advanceDate(current.id) }
                                  catch { self.error = error.localizedDescription } }
                        } label: {
                            Label("Nächster Termin", systemImage: "arrow.clockwise")
                        }.buttonStyle(.bordered).controlSize(.small)
                    }
                    if state.aiFeatureEnabled(\.brief) {
                        Button { showBrief = true } label: {
                            Label("Briefing", systemImage: "sparkles")
                        }.buttonStyle(.bordered).controlSize(.small).tint(DS.accent)
                    }
                    if state.aiFeatureEnabled(\.capture) {
                        Button { showCapture = true } label: {
                            Label("Notizen", systemImage: "square.and.pencil")
                        }.buttonStyle(.bordered).controlSize(.small).tint(DS.accent)
                    }
                }
                #endif
            }

            // v1.1: CMI banner
            if !isReadOnly, state.aiFeatureEnabled(\.cross_meeting),
               let cmi = state.cmiByMeeting[current.id], !cmi.matches.isEmpty {
                cmiBanner(cmi)
            }
        }
        .padding(.vertical, 4)
    }

    /// Hinweis-Banner für den Nur-Lesen-Modus (Vertrag Punkt 3): Datum +
    /// "Wiederherstellen" (sofortige Aktion, kein Dialog) + "Endgültig löschen"
    /// (Preflight + Bestätigungsdialog, analog `MeetingArchiveView`).
    @ViewBuilder private func archivedBanner(_ current: Meeting, archivedAt: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(archiveArchivedAtChipText(archivedAt), systemImage: "archivebox.fill")
                .font(.subheadline).fontWeight(.semibold)
            HStack(spacing: 8) {
                Button {
                    restore(current)
                } label: {
                    Label("Wiederherstellen", systemImage: "tray.and.arrow.up")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(isRestoring)

                Button(role: .destructive) {
                    Task { await loadPreflightAndConfirm(current) }
                } label: {
                    Label("Endgültig löschen", systemImage: "trash")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(isLoadingPreflight || isDeletingPermanently)
            }
        }
        .padding(10)
        .background(DS.orange.opacity(0.1))
        .overlay(RoundedRectangle(cornerRadius: DS.radiusS).stroke(DS.orange.opacity(0.3)))
        .clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
    }

    private func restore(_ current: Meeting) {
        isRestoring = true
        Task {
            do {
                try await state.restoreMeeting(current.id)
                infoMessage = "Meeting wiederhergestellt."
            } catch {
                self.error = "Meeting konnte nicht wiederhergestellt werden. Bitte versuche es erneut."
            }
            isRestoring = false
        }
    }

    private func loadPreflightAndConfirm(_ current: Meeting) async {
        isLoadingPreflight = true
        do {
            permanentDeletePreflight = try await state.archivePreflight(current.id)
            showPermanentDeleteConfirm = true
        } catch {
            self.error = "Löschumfang konnte nicht ermittelt werden. Bitte versuche es erneut."
        }
        isLoadingPreflight = false
    }

    private func permanentlyDelete(_ current: Meeting) {
        isDeletingPermanently = true
        Task {
            do {
                try await state.permanentlyDeleteMeeting(current.id)
                infoMessage = archiveDeletedSuccessText(title: current.title)
            } catch {
                self.error = "Meeting konnte nicht endgültig gelöscht werden. Bitte versuche es erneut."
            }
            isDeletingPermanently = false
            permanentDeletePreflight = nil
        }
    }

    #if os(iOS)
    private func actionChip(_ label: String, icon: String, accent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 12))
                Text(label).font(.system(size: 13))
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(accent ? DS.accent.opacity(0.12) : Color(.systemBackground))
            .foregroundStyle(accent ? DS.accent : .primary)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(accent ? DS.accent.opacity(0.3) : Color(.systemGray4), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
    #endif

    @ViewBuilder private func cmiBanner(_ cmi: CMIContent) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("\(cmi.matches.count) ähnliche Thema(s) in anderen Meetings",
                      systemImage: "link")
                    .font(.caption).fontWeight(.semibold)
                    .foregroundStyle(DS.accent)
                Spacer()
                Button(cmiExpanded ? "Einklappen" : "Details") { cmiExpanded.toggle() }
                    .font(.caption).buttonStyle(.borderless)
                Button {
                    Task {
                        do { _ = try await state.aiCmiRecompute(meetingId: providedMeetingId) }
                        catch { self.error = error.localizedDescription }
                    }
                } label: { Text("Neu").font(.caption) }.buttonStyle(.borderless)
            }
            if cmiExpanded {
                ForEach(cmi.matches) { m in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(m.this_topic_title).font(.caption2).fontWeight(.semibold)
                            Text("↔").foregroundStyle(.secondary).font(.caption2)
                            Text(m.other_topic_title).font(.caption2).fontWeight(.semibold)
                            Text("\(Int(m.confidence * 100))%")
                                .font(.caption2).foregroundStyle(DS.accent)
                        }
                        Text("\(m.reason) — in \(m.other_meeting)")
                            .font(.caption2).foregroundStyle(.secondary).italic()
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background)
                    .clipShape(RoundedRectangle(cornerRadius: DS.radiusXS))
                }
            }
        }
        .padding(10)
        .background(DS.accentLight)
        .overlay(RoundedRectangle(cornerRadius: DS.radiusS).stroke(DS.accent.opacity(0.3)))
        .clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
    }

    private func sectionHeader(_ label: String, count: Int, color: Color,
                                icon: String? = nil) -> some View {
        HStack(spacing: 4) {
            if let icon {
                Image(systemName: icon).scaledFont(.caption2).foregroundStyle(color)
            }
            Text(label).foregroundStyle(color)
            Text("· \(count)").foregroundStyle(.secondary)
        }.scaledFont(.footnote).fontWeight(.semibold)
    }

    private func deleteTopic(from list: [Topic], at offsets: IndexSet, meetingId: String) {
        let ids = offsets.map { list[$0].id }
        Task {
            for id in ids {
                do { try await state.deleteTopic(meetingId: meetingId, id: id) }
                catch { self.error = error.localizedDescription }
            }
        }
    }

    private func moveTopics(in list: [Topic], from source: IndexSet, to destination: Int, meetingId: String) {
        var arr = list
        arr.move(fromOffsets: source, toOffset: destination)
        Task {
            do { try await state.reorderTopics(meetingId: meetingId, ids: arr.map(\.id)) }
            catch { self.error = error.localizedDescription }
        }
        // Optimistic update in state
        if let mi = state.meetings.firstIndex(where: { $0.id == meetingId }) {
            let allTopics = state.meetings[mi].topics
            let openIds = Set(list.map(\.id))
            let others = allTopics.filter { !openIds.contains($0.id) }
            state.meetings[mi].topics = others + arr
        }
    }

    func recLabel(_ p: String) -> String {
        ["weekly": "Wöchentlich", "biweekly": "Zweiwöchentlich", "monthly": "Monatlich"][p] ?? p
    }
}

// MARK: - Topic Row

struct TopicRowView: View {
    let topic: Topic
    let meetingId: String
    var isReadOnly: Bool = false
    // A3: Fortschritt/KI-Zusammenfassung/Inline-Composer nutzen dieselben,
    // von `MeetingDetailView` gehaltenen Store-Instanzen — keine eigenen pro Zeile.
    @ObservedObject var progressStore: ProgressStore
    @ObservedObject var summaryStore: SummaryStore
    @EnvironmentObject var state: AppState
    @State private var showEdit = false
    @State private var showComplete = false
    @State private var showShare = false
    @State private var showMove = false
    @State private var showThemes = false
    @State private var showSnooze = false
    @State private var showPush   = false
    @State private var error: String?

    private var themeLinks: [(theme: Theme, link: ThemeLink)] { state.themeLinks(for: topic.id) }

    var body: some View {
        if isReadOnly {
            rowContent
                .opacity(topic.isSnoozed ? 0.7 : 1)
        } else {
            rowContent
                .opacity(topic.isSnoozed ? 0.7 : 1)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { do { try await state.deleteTopic(meetingId: meetingId, id: topic.id) }
                              catch { self.error = error.localizedDescription } }
                    } label: { Label("Löschen", systemImage: "trash") }

                    if !topic.done {
                        Button { showComplete = true } label: {
                            Label("Erledigt", systemImage: "checkmark.circle")
                        }.tint(.green)
                    } else {
                        Button {
                            Task { do { try await state.reopenTopic(meetingId: meetingId, id: topic.id) }
                                  catch { self.error = error.localizedDescription } }
                        } label: { Label("Öffnen", systemImage: "arrow.uturn.left") }
                    }
                }
                .swipeActions(edge: .leading) {
                    Button { showSnooze = true } label: {
                        Label(topic.isSnoozed ? "Wecken" : "Schlafen", systemImage: "moon.zzz.fill")
                    }.tint(DS.accent)
                }
                .contentShape(Rectangle())
                .onTapGesture { showEdit = true }
                .contextMenu { contextMenuItems }
                .sheet(isPresented: $showEdit)     { TopicFormView(meetingId: meetingId, topic: topic) }
                .sheet(isPresented: $showComplete) { CompleteSheet(meetingId: meetingId, topicId: topic.id) }
                .sheet(isPresented: $showShare)    { ShareTopicSheet(meetingId: meetingId, topicId: topic.id) }
                .sheet(isPresented: $showMove)     { MoveItemSheet(type: .topic(meetingId: meetingId, id: topic.id)) }
                .sheet(isPresented: $showThemes)   { ThemeLinkSheet(refType: "topic", refId: topic.id, title: topic.title) }
                .sheet(isPresented: $showSnooze)   { SnoozeSheet(onSnooze: { until in
                    Task { do { try await state.snoozeTopic(meetingId: meetingId, id: topic.id, until: until) }
                          catch { self.error = error.localizedDescription } }
                }, onWake: topic.isSnoozed ? {
                    Task { do { try await state.snoozeTopic(meetingId: meetingId, id: topic.id, until: nil) }
                          catch { self.error = error.localizedDescription } }
                } : nil) }
                .sheet(isPresented: $showPush) {
                    StackPushSheet(target: PushTarget(refType: "topic", refId: topic.id, title: topic.title,
                                                       nextStep: topic.progress?.nextStep)) // A3: Vorbelegung
                }
                .errorAlert($error)
        }
    }

    private var rowContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                // Status dot
                statusIcon
                VStack(alignment: .leading, spacing: 3) {
                    Text(topic.title)
                        .scaledFont(.subheadline).fontWeight(.medium)
                        .strikethrough(topic.done)
                        .foregroundStyle(topic.done ? .secondary : .primary)

                    if !topic.description.isEmpty {
                        Text(htmlAttributedString(topic.description))
                            .scaledFont(.caption)
                            .lineLimit(2)
                    }

                    if topic.isSnoozed, let wake = topic.snoozeWakeFormatted {
                        Label("Wacht auf am \(wake)", systemImage: "moon.zzz.fill")
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                    // Erledigte Themen: keine Fortschrittszeile (Vertrag) —
                    // schlafende Themen behalten sie weiterhin sichtbar.
                    if TodoOverviewLogic.showsProgressBadge(done: topic.done) {
                        ProgressBadgeView(summary: topic.progress) // A3
                    }
                    // Theme chips
                    if !themeLinks.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 4) {
                                ForEach(themeLinks, id: \.link.id) { tl in
                                    themeChip(tl.theme.title)
                                }
                            }
                        }
                    }

                    // Shared with other meetings
                    let sharedIn = state.meetings.filter {
                        $0.id != meetingId && $0.topics.contains(where: { $0.groupId != nil && $0.groupId == topic.groupId })
                    }
                    if topic.groupId != nil && !sharedIn.isEmpty {
                        ForEach(sharedIn) { m in
                            Label(m.title, systemImage: "link")
                                .scaledFont(.caption2).foregroundStyle(DS.accent)
                        }
                    }
                    // Archivierte Meetings (isReadOnly): kein Composer, keine
                    // KI-Zusammenfassung (bestehender Schreibschutz, Vertrag).
                    if TodoOverviewLogic.showsAISummary(done: topic.done, isReadOnly: isReadOnly) {
                        AISummaryCardView(kind: .progress, summary: aiSummary?.progress,
                                          refType: "topic", refId: topic.id, store: summaryStore,
                                          onShowAllEntries: { showEdit = true })
                        AISummaryCardView(kind: .description, summary: aiSummary?.description,
                                          refType: "topic", refId: topic.id, store: summaryStore)
                    }
                }
                Spacer()
                // Todo pin
                if topic.isTodo {
                    Image(systemName: "pin.fill").font(.caption).foregroundStyle(.green)
                }
            }

            // Story 6: Zwischenstand direkt in der Zeile erfassen — kein
            // Angebot bei erledigten Themen oder archivierten Meetings (Vertrag).
            if TodoOverviewLogic.showsInlineComposer(done: topic.done, isReadOnly: isReadOnly) {
                InlineEntryComposerView(refType: "topic", refId: topic.id, hasSnooze: topic.isSnoozed,
                                        store: progressStore)
            }

            // Done result
            if topic.done && !topic.result.isEmpty {
                Text(htmlAttributedString(topic.result))
                    .scaledFont(.caption)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
            }
        }
        .onAppear {
            if TodoOverviewLogic.shouldStartPolling(done: topic.done, isReadOnly: isReadOnly, pair: aiSummary) {
                Task { await summaryStore.poll(refs: [summaryRef]) }
            }
        }
        .onDisappear {
            summaryStore.cancelPolling(for: summaryRef)
        }
    }

    private var summaryRef: String { "topic:\(topic.id)" }
    private var aiSummary: AISummaryPair? { summaryStore.pair(for: summaryRef) }

    @ViewBuilder private var statusIcon: some View {
        if topic.done {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).scaledFont(.subheadline)
        } else if topic.isSnoozed {
            Image(systemName: "moon.zzz.fill").foregroundStyle(.gray).scaledFont(.subheadline)
        } else {
            // Neutraler Ring statt Akzentfarbe — konsistent mit `TodoRowView`
            // (`TodosView.swift`) und dem Web-Pendant `.topic-status-icon.open`.
            Circle().stroke(DS.neutralRing, lineWidth: 1.5)
                .frame(width: 16, height: 16)
        }
    }

    @ViewBuilder private var contextMenuItems: some View {
        Button { showEdit = true } label: { Label("Bearbeiten", systemImage: "pencil") }
        Button { showThemes = true } label: { Label("Topic zuweisen", systemImage: "tag") }
        Button { showShare = true } label: { Label("Teilen", systemImage: "link") }
        Button { showMove = true } label: { Label("Verschieben", systemImage: "arrow.right") }
        if !topic.done {
            Button { showPush = true } label: { Label("Auf Stack legen", systemImage: "square.stack.3d.up") }
        }
        Divider()
        Button { showSnooze = true } label: { Label(topic.isSnoozed ? "Wecken" : "Schlafen legen", systemImage: "moon.zzz.fill") }
        Button {
            Task { do { try await state.toggleTopicTodo(meetingId: meetingId, id: topic.id) }
                  catch { self.error = error.localizedDescription } }
        } label: {
            Label(topic.isTodo ? "Aus Todos entfernen" : "Als Todo markieren", systemImage: topic.isTodo ? "pin.slash" : "pin")
        }
        Divider()
        if !topic.done {
            Button { showComplete = true } label: { Label("Als erledigt markieren", systemImage: "checkmark.circle") }
        } else {
            Button {
                Task { do { try await state.reopenTopic(meetingId: meetingId, id: topic.id) }
                      catch { self.error = error.localizedDescription } }
            } label: { Label("Wieder öffnen", systemImage: "arrow.uturn.left") }
        }
        Divider()
        Button(role: .destructive) {
            Task { do { try await state.deleteTopic(meetingId: meetingId, id: topic.id) }
                  catch { self.error = error.localizedDescription } }
        } label: { Label("Löschen", systemImage: "trash") }
    }

    private func themeChip(_ title: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "tag.fill").font(.system(size: 8))
            Text(title)
        }
        .scaledFont(.caption2).fontWeight(.medium)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(DS.purple.opacity(0.1))
        .foregroundStyle(DS.purple)
        .clipShape(Capsule())
    }
}
