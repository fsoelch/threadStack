import SwiftUI

// MARK: - PushTarget (shared)

struct PushTarget: Identifiable {
    var id: String { refType + refId }
    let refType: String
    let refId:   String
    let title:   String
}

// MARK: - Floating Stack Panel

struct StackPanelView: View {
    @EnvironmentObject var state: AppState
    @State private var collapsed = true
    @State private var popFrame:    StackFrame? = nil
    @State private var noteFrame:   StackFrame? = nil
    @State private var detailFrame: StackFrame? = nil
    @State private var showHistory = false
    @State private var showEod     = false
    @State private var showQuickPush = false
    @State private var reentry: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !collapsed {
                Divider()
                bodyContent
                Divider()
                footer
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.background)
                .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 4)
        )
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.gray.opacity(0.2)))
        .frame(width: collapsed ? nil : 320)
        .sheet(item: $popFrame)    { f in StackPopSheet(frame: f) }
        .sheet(item: $noteFrame)   { f in StackNoteSheet(frame: f) }
        .sheet(item: $detailFrame) { f in
            FrameDetailSheet(frame: f, isActive: f.id == state.stackFrames.first?.id)
        }
        .sheet(isPresented: $showHistory)   { StackHistoryView() }
        .sheet(isPresented: $showEod)       { EndOfDayView() }
        .sheet(isPresented: $showQuickPush) { QuickPushSheet() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("📚")
            Text("Stack").fontWeight(.semibold).font(.subheadline)
            Text("\(state.stackDepth)")
                .font(.caption2).bold().foregroundStyle(.white)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color(hex: "#6366f1")).clipShape(Capsule())
            Spacer()
            if !collapsed {
                Button { showQuickPush = true } label: { Text("＋") }
                    .buttonStyle(.plain).help("Schnell auf Stack legen")
                Button { showEod = true } label: { Text("🌙") }
                    .buttonStyle(.plain).help("Tagesabschluss")
                Button { showHistory = true } label: { Text("📜") }
                    .buttonStyle(.plain).help("Historie")
            }
            Image(systemName: collapsed ? "chevron.up" : "chevron.down")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeInOut(duration: 0.15)) { collapsed.toggle() } }
    }

    @ViewBuilder private var bodyContent: some View {
        if state.stackFrames.isEmpty {
            VStack(spacing: 4) {
                Text("Kein offenes Frame.").font(.caption).foregroundStyle(.secondary)
                Text("Tippe 📚 auf einem Topic/Todo.").font(.caption2).foregroundStyle(.tertiary)
            }
            .padding().frame(maxWidth: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(state.stackFrames.enumerated()), id: \.element.id) { idx, f in
                        frameCard(frame: f, isActive: idx == 0)
                    }
                }.padding(8)
            }
            .frame(maxHeight: 320)
        }
    }

    private var footer: some View {
        HStack {
            Text("Push & Pop per Kontextmenü auf Topic/Todo")
                .font(.caption2).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    @ViewBuilder
    private func frameCard(frame f: StackFrame, isActive: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(f.ref_type == "topic" ? "💬" : "✓").font(.caption)
                Text(f.title).font(.subheadline).fontWeight(.semibold).lineLimit(1)
                if !isActive {
                    Spacer()
                    Text("👁 öffnen").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Text(f.next_step_note).font(.caption).lineLimit(3)
            HStack {
                Text(isActive ? "läuft seit \(f.ageFormatted)" : "geparkt seit \(f.ageFormatted)")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
            }
            if isActive {
                HStack(spacing: 6) {
                    Button { popFrame = f } label: {
                        Label("Pop", systemImage: "eject").font(.caption)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    Button { noteFrame = f } label: {
                        Label("Notiz", systemImage: "square.and.pencil").font(.caption)
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    if state.aiFeatureEnabled(\.reentry) {
                        Button { Task { await runReentry(f) } } label: {
                            Label("Re-Entry", systemImage: "sparkles").font(.caption)
                        }
                        .buttonStyle(.bordered).controlSize(.small).tint(.indigo)
                    }
                }
                if let r = reentry[f.id] {
                    Text(r).font(.caption2).padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(hex: "#6366f1").opacity(0.10))
                        .foregroundStyle(Color(hex: "#4338ca"))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isActive ? Color(hex: "#6366f1").opacity(0.10) : Color(hex: "#f8fafc"))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(isActive ? Color(hex: "#6366f1") : Color(hex: "#e2e8f0"),
                              lineWidth: isActive ? 1.5 : 1)
        )
        .opacity(isActive ? 1 : 0.8)
        .contentShape(Rectangle())
        .onTapGesture { detailFrame = f }
    }

    private func runReentry(_ f: StackFrame) async {
        do {
            let r = try await state.aiReentry(frameId: f.id)
            reentry[f.id] = r.content.summary
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                let r = try await state.aiReentry(frameId: f.id, confirm: true)
                reentry[f.id] = r.content.summary
            } catch { reentry[f.id] = "Fehler: \(error.localizedDescription)" }
        } catch {
            reentry[f.id] = "Fehler: \(error.localizedDescription)"
        }
    }
}

// MARK: - Push Sheet

struct StackPushSheet: View {
    let target: PushTarget
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var note: String = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Ziel") {
                    HStack {
                        Text(target.refType == "topic" ? "💬" : "✓")
                        Text(target.title).bold()
                    }
                }
                Section("Was ist der nächste Schritt?") {
                    TextEditor(text: $note).frame(minHeight: 100)
                    Text("\(note.count) / 1000").font(.caption).foregroundStyle(.secondary)
                }
                if state.stackDepth >= 4 {
                    Section {
                        Label("Stack-Tiefe ≥ 4 — bewusst entscheiden", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Auf Stack legen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Push") { submit() }
                        .disabled(loading || note.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
    private func submit() {
        loading = true; error = nil
        Task {
            do {
                _ = try await state.stackPush(refType: target.refType, refId: target.refId,
                                              nextStepNote: note.trimmingCharacters(in: .whitespaces))
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}

// MARK: - Pop Sheet

struct StackPopSheet: View {
    let frame: StackFrame
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var resolution: String = "done"
    @State private var resultText: String = ""
    @State private var resultDate: Date   = Date()
    @State private var snoozeUntil: Date  = Date().addingTimeInterval(24*3600)
    @State private var loading = false
    @State private var error: String?
    @State private var showDriftAlert = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Frame") {
                    HStack {
                        Text(frame.ref_type == "topic" ? "💬" : "✓")
                        Text(frame.title).bold()
                    }
                    Text(frame.next_step_note).font(.caption).foregroundStyle(.secondary)
                }
                Section("Wie schließen?") {
                    Picker("Resolution", selection: $resolution) {
                        Text("✓ Erledigt").tag("done")
                        Text("😴 Schlafend").tag("snoozed")
                        Text("✗ Verworfen").tag("dropped")
                        Text("↻ Wieder aktiv").tag("resumed")
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
                if resolution == "done" {
                    Section("Ergebnis (optional)") {
                        TextEditor(text: $resultText).frame(minHeight: 80)
                        DatePicker("Datum", selection: $resultDate, displayedComponents: .date)
                    }
                }
                if resolution == "snoozed" {
                    Section("Aufwachen am") {
                        DatePicker("", selection: $snoozeUntil).labelsHidden()
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Frame schließen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pop") { submit() }.disabled(loading)
                }
            }
            .alert("In Backlog verschieben?", isPresented: $showDriftAlert) {
                Button("Ja", role: .destructive) {
                    Task { await snoozeRefToTomorrow(); dismiss() }
                }
                Button("Nein", role: .cancel) { dismiss() }
            } message: {
                Text("Der Frame wurde innerhalb 30 s wieder geschlossen — soll das Topic/Todo bis morgen 9:00 gesnoozed werden?")
            }
        }
    }

    private func submit() {
        loading = true; error = nil
        Task {
            do {
                let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd"
                let resultDateStr = df.string(from: resultDate)
                let snoozeStr = ISO8601DateFormatter().string(from: snoozeUntil)
                let r = try await state.stackPop(
                    frameId: frame.id, resolution: resolution,
                    result: resolution == "done" ? resultText : nil,
                    resultDate: resolution == "done" ? resultDateStr : nil,
                    snoozedUntil: resolution == "snoozed" ? snoozeStr : nil
                )
                if r.drift_warning { showDriftAlert = true } else { dismiss() }
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }

    private func snoozeRefToTomorrow() async {
        guard let tomorrow9 = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0,
                                                    of: Calendar.current.date(byAdding: .day, value: 1, to: Date())!)
        else { return }
        let iso = ISO8601DateFormatter().string(from: tomorrow9)
        do {
            if frame.ref_type == "topic" {
                if let m = state.meetings.first(where: { $0.topics.contains { $0.id == frame.ref_id } }) {
                    try await state.snoozeTopic(meetingId: m.id, id: frame.ref_id, until: iso)
                }
            } else {
                try await state.snoozeTodo(id: frame.ref_id, until: iso)
            }
        } catch { /* silent */ }
    }
}

// MARK: - Note Edit

struct StackNoteSheet: View {
    let frame: StackFrame
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var note: String = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Notiz") {
                    TextEditor(text: $note).frame(minHeight: 100)
                    Text("\(note.count) / 1000").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Notiz bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { submit() }
                        .disabled(loading || note.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { note = frame.next_step_note }
        }
    }
    private func submit() {
        loading = true; error = nil
        Task {
            do { try await state.stackUpdateNote(frameId: frame.id, note: note); dismiss() }
            catch { self.error = error.localizedDescription; loading = false }
        }
    }
}

// MARK: - History

struct StackHistoryView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var frames: [StackFrame] = []
    @State private var resolutionFilter: String = ""

    var body: some View {
        NavigationStack {
            List {
                Picker("Filter", selection: $resolutionFilter) {
                    Text("Alle").tag("")
                    Text("done").tag("done")
                    Text("snoozed").tag("snoozed")
                    Text("dropped").tag("dropped")
                }
                .pickerStyle(.segmented)

                if frames.isEmpty {
                    Text("Keine Einträge").foregroundStyle(.secondary).font(.subheadline)
                }
                ForEach(frames) { f in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(f.ref_type == "topic" ? "💬" : "✓")
                            Text(f.title).font(.subheadline).fontWeight(.medium)
                            Spacer()
                            if let r = f.pop_resolution {
                                Text(r).font(.caption2).bold()
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(badgeColor(r).opacity(0.18))
                                    .foregroundStyle(badgeColor(r))
                                    .clipShape(Capsule())
                            }
                        }
                        Text(f.next_step_note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        if let p = f.popped_at {
                            Text("gepoppt \(p.prefix(16))").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Stack-Historie")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Schließen") { dismiss() } } }
            .task { await reload() }
            .onChange(of: resolutionFilter) { _, _ in Task { await reload() } }
        }
    }
    private func badgeColor(_ r: String) -> Color {
        switch r {
        case "done": return .green
        case "snoozed": return .indigo
        case "dropped": return .red
        case "resumed": return .orange
        default: return .secondary
        }
    }
    private func reload() async {
        do { frames = try await state.stackHistory(resolution: resolutionFilter.isEmpty ? nil : resolutionFilter) }
        catch { frames = [] }
    }
}

// MARK: - End-of-Day Review

struct EndOfDayView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationStack {
            List {
                if state.stackFrames.isEmpty {
                    Text("Kein offenes Frame — alles erledigt.").foregroundStyle(.secondary)
                }
                ForEach(state.stackFrames) { f in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(f.ref_type == "topic" ? "💬" : "✓")
                            Text(f.title).font(.subheadline).fontWeight(.semibold)
                            Spacer()
                            Text("läuft seit \(f.ageFormatted)").font(.caption2).foregroundStyle(.secondary)
                        }
                        Text(f.next_step_note).font(.caption).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            Button("Morgen weiter") { Task { await actTomorrow(f) } }
                                .buttonStyle(.borderedProminent).controlSize(.small)
                            Button("Droppen", role: .destructive) {
                                Task { try? await state.stackPop(frameId: f.id, resolution: "dropped") }
                            }.controlSize(.small)
                        }
                    }
                }
            }
            .navigationTitle("Tagesabschluss")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Schließen") { dismiss() } } }
        }
    }
    private func actTomorrow(_ f: StackFrame) async {
        guard let tomorrow9 = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0,
                                                    of: Calendar.current.date(byAdding: .day, value: 1, to: Date())!)
        else { return }
        let iso = ISO8601DateFormatter().string(from: tomorrow9)
        do {
            if f.ref_type == "topic" {
                if let m = state.meetings.first(where: { $0.topics.contains { $0.id == f.ref_id } }) {
                    try await state.snoozeTopic(meetingId: m.id, id: f.ref_id, until: iso)
                }
            } else {
                try await state.snoozeTodo(id: f.ref_id, until: iso)
            }
        } catch { }
    }
}

// MARK: - Frame Detail Sheet (peek / activate)

struct FrameDetailSheet: View {
    let frame: StackFrame
    let isActive: Bool
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Ziel") {
                    HStack {
                        Text(frame.ref_type == "topic" ? "💬" : "✓")
                        Text(frame.title).bold()
                    }
                }
                Section("Nächster Schritt") {
                    Text(frame.next_step_note.isEmpty ? "— keine Notiz —" : frame.next_step_note)
                        .font(.body)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Section {
                    Text(isActive ? "läuft seit \(frame.ageFormatted)" : "geparkt seit \(frame.ageFormatted)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(isActive
                         ? "Du arbeitest gerade hier weiter — schließe einfach diesen Dialog."
                         : "Mit 'Auf dieses Frame zurück' wird es das aktive — alle anderen Frames bleiben offen geparkt.")
                        .font(.caption2).foregroundStyle(.secondary).italic()
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(isActive ? "📚 Aktives Frame" : "📚 Geparktes Frame")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                if !isActive {
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            Task { await activate() }
                        } label: {
                            Label("Auf dieses Frame zurück", systemImage: "arrow.uturn.backward")
                        }.disabled(loading)
                    }
                }
            }
        }
    }

    private func activate() async {
        loading = true; error = nil
        do { try await state.stackResume(frameId: frame.id); dismiss() }
        catch { self.error = error.localizedDescription; loading = false }
    }
}

// MARK: - Quick-Push (neues Todo + sofort auf Stack)

struct QuickPushSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title: String = ""
    @State private var note:  String = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("z. B. Slides finalisieren", text: $title)
                }
                Section("Nächster Schritt") {
                    TextEditor(text: $note).frame(minHeight: 80)
                    Text("\(note.count) / 1000").font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Text("Es wird automatisch ein Todo angelegt und sofort auf den Stack gelegt.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Schnell auf Stack")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Anlegen & pushen") { submit() }
                        .disabled(loading
                                  || title.trimmingCharacters(in: .whitespaces).isEmpty
                                  || note.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() {
        loading = true; error = nil
        Task {
            do {
                let cleanTitle = title.trimmingCharacters(in: .whitespaces)
                let cleanNote  = note.trimmingCharacters(in: .whitespaces)
                let t = try await state.createTodoReturning(title: cleanTitle, description: "")
                _ = try await state.stackPush(refType: "todo", refId: t.id, nextStepNote: cleanNote)
                dismiss()
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}

