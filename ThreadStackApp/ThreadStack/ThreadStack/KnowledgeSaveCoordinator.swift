//
//  KnowledgeSaveCoordinator.swift
//  ThreadStack
//
//  Arbeitspaket 6 ("knowledge-editor-view"): reine, von SwiftUI entkoppelte
//  Orchestrierungslogik für das Speichern einer Wissensseite aus dem nativen
//  Rich-Text-Editor. Kapselt:
//   - die Entscheidung POST (create) vs. PUT (update) anhand einer einmal
//     gesetzten `pageId`,
//   - die Diff-Berechnung für Topic- und Verwandtes-Wissen-Auswahl gegen den
//     zuletzt bestätigt auf dem Server angewendeten Zustand,
//   - die Teilfehler-Zustandsmaschine (Inhalt gespeichert, Themes/Links-Sync
//     fehlgeschlagen) inkl. sicherem Retry (kein zweites `createKnowledgePage`).
//
//  `KnowledgeEditorView` hält selbst nur UI-Zustand (Ladeindikator, Banner-
//  Texte) und delegiert die eigentliche Speicher-Logik an diesen Typ.
//

import Foundation

/// Minimale, closure-basierte Schnittstelle zu den von diesem Koordinator
/// benötigten `AppState`-Operationen (Arbeitspaket 1). Erlaubt Unit-Tests,
/// eine netzwerkfreie Fake-Implementierung zu injizieren, statt echte
/// `AppState`-Instanzen (inkl. `URLSession`) aufzusetzen.
///
/// Bewusst als Bündel von Funktionswerten statt als Protokoll modelliert:
/// eine Protokoll-Konformitätserklärung für den `@MainActor`-isolierten
/// `AppState` erwies sich über die Modul-/Testtarget-Grenze hinweg
/// (`@testable import` aus `ThreadStackTests`) als nicht robust gegenüber
/// der in diesem Projekt aktivierten Vorschau-Concurrency-Feature-Kombination
/// (unerwartete Witness-Mismatches trotz identischem, druckbarem Funktionstyp
/// — vermutlich ein Toolchain-Randfall dieser experimentellen Flags, siehe
/// Abschlussbericht). Funktionswerte umgehen dieses Witness-Matching
/// vollständig und sind ebenso gut testbar (Fakes liefern schlicht andere
/// Closures statt eine andere Typkonformität).
///
/// `AppState` erfüllt diesen Vertrag bereits durch seine vorhandenen
/// Methoden (siehe `AppState.swift`, Arbeitspaket 1) — `AppState.asKnowledgeSaveCoordinatorOperations()`
/// baut lediglich das Bündel aus den (unveränderten) Methodenreferenzen,
/// ohne `AppState.swift` selbst zu verändern.
struct KnowledgeSaveCoordinatorOperations {
    var createKnowledgePage: (_ title: String, _ content: String, _ themeIds: [String]) async throws -> KnowledgePage
    var updateKnowledgePage: (_ id: String, _ title: String, _ content: String) async throws -> String
    var setKnowledgeThemes: (_ id: String, _ themeIds: [String]) async throws -> AppState.KnowledgeThemesResult
    var addKnowledgeLink: (_ pageId: String, _ targetId: String) async throws -> AppState.KnowledgeLink
    var removeKnowledgeLink: (_ pageId: String, _ linkId: String) async throws -> Void
}

extension AppState {
    /// Baut das Operationen-Bündel aus den vorhandenen `AppState`-Methoden
    /// (Arbeitspaket 1) — reine Verdrahtung, keine neue Logik.
    @MainActor
    func asKnowledgeSaveCoordinatorOperations() -> KnowledgeSaveCoordinatorOperations {
        KnowledgeSaveCoordinatorOperations(
            createKnowledgePage: { try await self.createKnowledgePage(title: $0, content: $1, themeIds: $2) },
            updateKnowledgePage: { try await self.updateKnowledgePage(id: $0, title: $1, content: $2) },
            setKnowledgeThemes: { try await self.setKnowledgeThemes(id: $0, themeIds: $1) },
            addKnowledgeLink: { try await self.addKnowledgeLink(pageId: $0, targetId: $1) },
            removeKnowledgeLink: { try await self.removeKnowledgeLink(pageId: $0, linkId: $1) }
        )
    }
}

/// Reine Orchestrierungslogik für das Speichern einer Wissensseite. Hält
/// ausschließlich den zuletzt gegenüber dem Server bestätigten Zustand
/// (`pageId`, angewendete Topics/Links) — keinerlei SwiftUI-/UI-Zustand.
///
final class KnowledgeSaveCoordinator {

    /// Verweis auf eine bereits mit dem Server synchronisierte Verknüpfung
    /// (Arbeitspaket 1: `AppState.KnowledgeLink`), reduziert auf die für die
    /// Diff-Berechnung nötigen Felder.
    struct LinkRef: Equatable {
        let linkId: String
        let targetPageId: String
    }

    /// Ergebnis eines abgeschlossenen (ggf. teilweise fehlgeschlagenen)
    /// Speichervorgangs. Ein `throw` aus `save(...)` bedeutet dagegen, dass
    /// bereits der Inhalt selbst (create/update) fehlgeschlagen ist — dann
    /// wurde nichts gespeichert.
    struct SaveOutcome: Equatable {
        /// Serverseitig bestätigte Seiten-ID (aus `createKnowledgePage` bzw.
        /// der bereits bekannten `pageId` im Edit-Modus).
        let pageId: String
        /// Nur im Create-Fall gesetzt: die vom Server zurückgegebene, frisch
        /// angelegte Seite. `nil` im Update-Fall (die PUT-Route liefert keine
        /// vollständige Seite zurück — Aufrufer lädt danach ohnehin per
        /// `reloadKnowledgePage` neu, siehe Vertrag Schritt 3).
        let createdPage: KnowledgePage?
        /// `true`, wenn der Themes-Sync (`setKnowledgeThemes`) fehlgeschlagen ist.
        let themesFailed: Bool
        /// `true`, wenn mindestens eine Links-Diff-Operation (`addKnowledgeLink`/
        /// `removeKnowledgeLink`) fehlgeschlagen ist.
        let linksFailed: Bool

        var isFullSuccess: Bool { !themesFailed && !linksFailed }
    }

    /// Serverseitig bestätigte Seiten-ID. `nil` bis zum ersten erfolgreichen
    /// `createKnowledgePage`-Aufruf — danach für die Lebensdauer dieser
    /// Koordinator-Instanz gesetzt, sodass jeder Folge-`save(...)`-Aufruf
    /// (auch ein Retry nach Teilfehler) zwingend den PUT/Themes/Links-Pfad
    /// nimmt und niemals ein zweites `createKnowledgePage` auslöst.
    private(set) var pageId: String?

    /// Zuletzt gegenüber dem Server bestätigte Topic-Zuordnung. Wird nach
    /// einem erfolgreichen Create (dort in der `createKnowledgePage`-Anfrage
    /// bereits enthalten) bzw. nach einem erfolgreichen `setKnowledgeThemes`
    /// aktualisiert.
    private(set) var appliedThemeIds: Set<String>

    /// Zuletzt gegenüber dem Server bestätigte Verknüpfungen (Verwandtes
    /// Wissen). Im Create-Modus zunächst leer (Verknüpfungen sind vor dem
    /// ersten Speichern nicht möglich, siehe Vertrag) und wird nach dem
    /// ersten erfolgreichen Speichern typischerweise per `setInitialLinks`
    /// bzw. durch erfolgreiche Diff-Operationen aktualisiert.
    private(set) var appliedLinks: [LinkRef]

    init(pageId: String?, initialThemeIds: Set<String>, initialLinks: [LinkRef] = []) {
        self.pageId = pageId
        self.appliedThemeIds = initialThemeIds
        self.appliedLinks = initialLinks
    }

    /// Wird vom Aufrufer gesetzt, sobald die tatsächlich verknüpften Seiten
    /// asynchron nachgeladen wurden (Edit-Modus: `AppState.knowledgeLinks(pageId:)`,
    /// im Konstruktor synchron noch nicht verfügbar).
    func setInitialLinks(_ links: [LinkRef]) {
        appliedLinks = links
    }

    /// Setzt den Koordinator auf einen frischen Create-Zustand zurück
    /// (`pageId = nil`). Genutzt für den `KNOWLEDGE_PAGE_GONE`-Fluss ("Als
    /// neue Seite anlegen"): die bisherige `pageId` existiert serverseitig
    /// nicht mehr, ein Retry muss also wieder `createKnowledgePage` (POST)
    /// auslösen, nicht `updateKnowledgePage` (PUT) auf eine tote ID.
    func resetForNewPage(themeIds: Set<String>) {
        pageId = nil
        appliedThemeIds = themeIds
        appliedLinks = []
    }

    /// Reine Diff-Berechnung (hinzugefügt/entfernt/unverändert) zwischen dem
    /// zuletzt bestätigten Verknüpfungs-Zustand und der aktuell in der UI
    /// gewählten Ziel-Seiten-ID-Menge. Als `static` unabhängig von
    /// Instanz-Zustand unit-testbar.
    static func computeLinksDiff(applied: [LinkRef], desiredTargetIds: Set<String>) -> (toAdd: Set<String>, toRemove: [LinkRef]) {
        let appliedTargetIds = Set(applied.map(\.targetPageId))
        let toAdd = desiredTargetIds.subtracting(appliedTargetIds)
        let toRemove = applied.filter { !desiredTargetIds.contains($0.targetPageId) }
        return (toAdd, toRemove)
    }

    /// Führt einen vollständigen Speichervorgang aus: create-oder-update des
    /// Inhalts, danach (nur bei Änderung) Themes-Sync, danach (nur bei
    /// Änderung) Links-Diff. Ein Fehler beim Inhalt selbst wird als `throw`
    /// weitergereicht (Aufrufer bildet daraus die exakten deutschen
    /// Fehlertexte ab, siehe UX-Vorgabe) — in diesem Fall wurde nichts
    /// gespeichert. Fehler bei Themes/Links werden dagegen NICHT geworfen,
    /// sondern als Teilfehler im `SaveOutcome` gemeldet, da der Inhalt zu
    /// diesem Zeitpunkt bereits erfolgreich gespeichert wurde.
    func save(
        title: String,
        content: String,
        themeIds: [String],
        relatedPageIds: [String],
        operations: KnowledgeSaveCoordinatorOperations
    ) async throws -> SaveOutcome {
        let desiredThemeIds = Set(themeIds)
        let desiredLinkTargets = Set(relatedPageIds)

        let resolvedPageId: String
        var createdPage: KnowledgePage?

        if let existingPageId = pageId {
            resolvedPageId = existingPageId
            _ = try await operations.updateKnowledgePage(existingPageId, title, content)
        } else {
            let page = try await operations.createKnowledgePage(title, content, themeIds)
            resolvedPageId = page.id
            pageId = page.id
            createdPage = page
            // Themes wurden bereits im Create-Request mitgeschickt.
            appliedThemeIds = desiredThemeIds
        }

        var themesFailed = false
        if appliedThemeIds != desiredThemeIds {
            do {
                let result = try await operations.setKnowledgeThemes(resolvedPageId, themeIds)
                appliedThemeIds = Set(result.appliedThemeIds)
            } catch {
                themesFailed = true
            }
        }

        var linksFailed = false
        let diff = Self.computeLinksDiff(applied: appliedLinks, desiredTargetIds: desiredLinkTargets)
        if !diff.toAdd.isEmpty || !diff.toRemove.isEmpty {
            for target in diff.toAdd {
                do {
                    let link = try await operations.addKnowledgeLink(resolvedPageId, target)
                    if !appliedLinks.contains(where: { $0.linkId == link.linkId }) {
                        appliedLinks.append(LinkRef(linkId: link.linkId, targetPageId: link.page.id))
                    }
                } catch {
                    linksFailed = true
                }
            }
            for ref in diff.toRemove {
                do {
                    try await operations.removeKnowledgeLink(resolvedPageId, ref.linkId)
                    appliedLinks.removeAll { $0.linkId == ref.linkId }
                } catch {
                    linksFailed = true
                }
            }
        }

        return SaveOutcome(
            pageId: resolvedPageId,
            createdPage: createdPage,
            themesFailed: themesFailed,
            linksFailed: linksFailed
        )
    }
}
