import SwiftUI

struct DigestView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @State private var loadFailedOffline = false
    @State private var current: DigestResponse?
    @State private var archive: [DigestArchiveEntry] = []
    @State private var loading = false
    @State private var error: String?
    @State private var selected: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if OfflineFeatureBLogic.showsUnavailable(isOffline: offline.isOffline,
                                                         hasContent: current != nil,
                                                         loadFailedWithTransport: loadFailedOffline) {
                    OfflineUnavailableView(reason: .notLoadedYet) { Task { await reload() } }
                        .frame(minHeight: 300)
                } else if loading && current == nil {
                    ProgressView("Lade …").frame(maxWidth: .infinity).padding(.top, 24)
                } else if let c = current?.content {
                    sections(c)
                } else if let error {
                    VStack(spacing: 8) {
                        Text(error).foregroundStyle(.red).font(.footnote)
                        Button("Erneut versuchen") { Task { await reload() } }
                    }.frame(maxWidth: .infinity).padding(.top, 24)
                } else {
                    empty
                }
            }
            .padding()
        }
        .navigationTitle("Wochen-Digest")
        .onChange(of: offline.isOffline) { was, now in
            if OfflineFeatureBLogic.shouldReloadAfterConnectivityChange(
                wasOffline: was, isOffline: now, hasContent: current != nil) {
                Task { await reload() }
            }
        }
        .task { await reload() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("📊 Wochen-Digest").font(.title3).fontWeight(.semibold)
                Spacer()
            }
            HStack(spacing: 8) {
                Button { Task { await regenerate() } } label: {
                    Label("Neu erzeugen", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(OfflineFeatureBLogic.isActionDisabled(isOffline: offline.isOffline, isBusy: loading))
                .disabledWhenOfflineCompact(offline.isOffline)
                if archive.count > 1 {
                    Picker("Woche", selection: $selected) {
                        ForEach(archive) { a in
                            Text("\(a.week) — \(a.created_at.prefix(10))").tag(a.artifact_id)
                        }
                    }
                    .pickerStyle(.menu)
                    .onChange(of: selected) { _, new in
                        if let a = archive.first(where: { $0.artifact_id == new }) {
                            current = DigestResponse(artifact_id: a.artifact_id, content: a.content,
                                                     week: a.week, cached: true, cost_cents: 0)
                        }
                    }
                }
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Text("📊").font(.largeTitle)
            Text("Noch kein Digest für diese Woche.").foregroundStyle(.secondary)
            Button { Task { await regenerate() } } label: { Label("Jetzt erzeugen", systemImage: "sparkles") }
                .buttonStyle(.borderedProminent)
                .disabledWhenOffline(offline.isOffline)
        }
        .frame(maxWidth: .infinity).padding(.top, 24)
    }

    @ViewBuilder private func sections(_ c: DigestContent) -> some View {
        if let w = current?.week {
            Text("Woche \(w)").font(.caption).foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("Zusammenfassung").font(.subheadline).fontWeight(.semibold)
            Text(c.summary).font(.callout)
        }
        .padding(12).background(DS.cardBg)
        .clipShape(RoundedRectangle(cornerRadius: DS.radiusS))

        if let h = c.highlights, !h.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Highlights").font(.subheadline).fontWeight(.semibold)
                ForEach(Array(h.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundStyle(DS.brandIndigo).fontWeight(.bold)
                        Text(item).font(.callout)
                    }
                }
            }
            .padding(12).background(DS.cardBg)
            .clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
        }
        if let f = c.focus_next, !f.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Fokus nächste Woche").font(.subheadline).fontWeight(.semibold)
                ForEach(Array(f.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("→").foregroundStyle(.green).fontWeight(.bold)
                        Text(item).font(.callout)
                    }
                }
            }
            .padding(12).background(DS.cardBg)
            .clipShape(RoundedRectangle(cornerRadius: DS.radiusS))
        }
    }

    private func reload() async {
        guard OfflineFeatureBLogic.shouldPerformRequest(isOffline: offline.isOffline) else { return }
        loading = true; error = nil; loadFailedOffline = false
        do {
            current = try await state.aiDigestCurrent()
            archive = try await state.aiDigestArchive()
            selected = current?.artifact_id ?? ""
        } catch let e as APIAIError where e.budgetExceeded {
            error = "Monatsbudget erschöpft."
        } catch {
            loadFailedOffline = isTransportFailure(error)
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func regenerate() async {
        guard OfflineFeatureBLogic.shouldPerformRequest(isOffline: offline.isOffline) else {
            state.showToast(OfflineFeatureBLogic.blockedToast); return
        }
        loading = true; error = nil
        do {
            current = try await state.aiDigestRegenerate()
            archive = try await state.aiDigestArchive()
            selected = current?.artifact_id ?? ""
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                current = try await state.aiDigestRegenerate(confirm: true)
                archive = try await state.aiDigestArchive()
                selected = current?.artifact_id ?? ""
            } catch { self.error = error.localizedDescription }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
