import Foundation
import Combine
import WebKit

/// Formatierungs-Befehle, die der native Editor unterstützt (MVP-Scope,
/// siehe Architektur-Konsistenzcheck: ausschließlich Fett/Kursiv/
/// Unterstrichen/unsortierte Liste — keine Tabellen/Überschriften/Farbe).
enum KnowledgeEditorCommand: String {
    case bold
    case italic
    case underline
    case insertUnorderedList
}

/// Fehler, die die native Fassade werfen kann. `bridgeUnavailable`/`timeout`
/// betreffen die Kommunikation mit der WebView, `invalidURL`/`invalidImage`
/// spiegeln die serverseitig unabhängige, clientseitige Validierung in
/// `window.TSEditor.insertLink`/`insertImage` (knowledge-editor.js).
enum KnowledgeEditorError: Error, Equatable {
    case bridgeUnavailable
    case timeout
    case invalidURL
    case invalidImage
}

/// Formatierungs-/Selektionszustand des Editors (Spiegel des JS-seitigen
/// `State`-Typs, siehe Vertrag Schnittstelle 3 — ohne `length`, das wird
/// separat über `KnowledgeEditorController.contentLength` verfolgt).
struct KnowledgeEditorState: Equatable {
    var bold: Bool = false
    var italic: Bool = false
    var underline: Bool = false
    var unorderedList: Bool = false
    var hasSelection: Bool = false
    var selectedText: String = ""
}

/// Reine, ohne WebKit testbare Validierungs-Helfer. Sie spiegeln exakt die
/// Regeln, die `knowledge-editor.js` autoritativ selbst durchsetzt
/// (Defense-in-Depth / schnelles Fail-Fast auf nativer Seite, bevor
/// überhaupt ein Bridge-Aufruf gestartet wird).
enum KnowledgeEditorValidation {
    static func isValidLinkHref(_ href: String) -> Bool {
        href.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func isValidImageDataURL(_ dataURL: String) -> Bool {
        dataURL.range(
            of: "^data:image/(png|jpeg|gif|webp);base64,",
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    static func clampFontScale(_ scale: Double) -> Double {
        min(max(scale, 0.8), 2.0)
    }
}

/// Reine, ohne WebKit testbare Nachrichten-Verarbeitung für
/// Schnittstelle 4 (JS -> Nativ, `WKScriptMessageHandler`-Name `tsEditor`).
/// `message.body` MUSS `[String: Any]` mit `type: String` sein — alles
/// andere wird verworfen (kein Crash, kein Logging von Inhalt).
enum KnowledgeEditorMessageParser {
    enum Kind: Equatable {
        case ready
        case state(KnowledgeEditorState, length: Int?)
        case change(length: Int)
        case requestLink(selectedText: String)
        case requestImage
        case contentHeight(Double)
    }

    struct Message: Equatable {
        let kind: Kind
    }

    static let maxSelectedTextLength = 200

    static func parse(_ body: Any) -> Message? {
        guard let dict = body as? [String: Any] else { return nil }
        guard let type = dict["type"] as? String else { return nil }

        switch type {
        case "ready":
            return Message(kind: .ready)

        case "state":
            let state = KnowledgeEditorState(
                bold: boolValue(dict["bold"]),
                italic: boolValue(dict["italic"]),
                underline: boolValue(dict["underline"]),
                unorderedList: boolValue(dict["unorderedList"]),
                hasSelection: boolValue(dict["hasSelection"]),
                selectedText: truncate(stringValue(dict["selectedText"]), maxSelectedTextLength)
            )
            return Message(kind: .state(state, length: intValue(dict["length"])))

        case "change":
            guard let length = intValue(dict["length"]) else { return nil }
            return Message(kind: .change(length: length))

        case "requestLink":
            let text = truncate(stringValue(dict["selectedText"]), maxSelectedTextLength)
            return Message(kind: .requestLink(selectedText: text))

        case "requestImage":
            return Message(kind: .requestImage)

        case "contentHeight":
            guard let height = doubleValue(dict["height"]) else { return nil }
            return Message(kind: .contentHeight(height))

        default:
            // Unbekannte types werden verworfen (kein Crash, kein Logging).
            return nil
        }
    }

    static func truncate(_ value: String, _ maxLength: Int) -> String {
        if value.count <= maxLength { return value }
        return String(value.prefix(maxLength))
    }

    private static func stringValue(_ any: Any?) -> String {
        any as? String ?? ""
    }

    private static func boolValue(_ any: Any?) -> Bool {
        if let b = any as? Bool { return b }
        if let n = any as? NSNumber { return n.boolValue }
        return false
    }

    private static func intValue(_ any: Any?) -> Int? {
        if let i = any as? Int { return i }
        if let n = any as? NSNumber { return n.intValue }
        if let d = any as? Double { return Int(d) }
        return nil
    }

    private static func doubleValue(_ any: Any?) -> Double? {
        if let d = any as? Double { return d }
        if let n = any as? NSNumber { return n.doubleValue }
        if let i = any as? Int { return Double(i) }
        return nil
    }
}

/// Native Fassade für den Wissens-Editor. Kommuniziert ausschließlich über
/// `callAsyncJavaScript("return window.TSEditor.<fn>(a);", arguments: ["a": …],
/// in: nil, contentWorld: .page)` — niemals per String-Interpolation von
/// Nutzerinhalt in den JS-Quelltext (Injection-Risiko). `<fn>` ist an jeder
/// Aufrufstelle ein fest im Code verankerter Bezeichner, niemals von außen
/// beeinflussbar.
///
/// Wird NICHT von `KnowledgeEditorWebView` selbst erzeugt, sondern von außen
/// als `@StateObject`/Parameter hereingereicht — sonst geht bei jedem
/// SwiftUI-Re-Render der Editorinhalt verloren.
@MainActor
final class KnowledgeEditorController: ObservableObject {
    @Published private(set) var isReady: Bool = false
    @Published private(set) var state: KnowledgeEditorState = KnowledgeEditorState()
    @Published private(set) var contentLength: Int = 0

    /// Wird aufgerufen, wenn die JS-Seite eine `requestLink`-Nachricht
    /// sendet (aktuell per Tastaturkürzel Cmd/Ctrl+K aus
    /// knowledge-editor.js ausgelöst; die eigentliche Toolbar-UI folgt in
    /// Paket 6). Argument: die (auf 200 Zeichen gekürzte) aktuelle Auswahl.
    var onRequestLink: ((String) -> Void)?

    /// Wird aufgerufen, wenn die JS-Seite eine `requestImage`-Nachricht sendet.
    var onRequestImage: (() -> Void)?

    /// Wird von `KnowledgeEditorWebView`/dessen Coordinator gesetzt, sobald
    /// die zugehörige `WKWebView` existiert, und beim Abbau wieder auf `nil`
    /// gesetzt.
    weak var webView: WKWebView?

    private let bridgeTimeout: TimeInterval

    init(bridgeTimeout: TimeInterval = 2.0) {
        self.bridgeTimeout = bridgeTimeout
    }

    // MARK: - Nativ -> JS

    func setContent(_ html: String) async {
        guard let dict = try? await callBridge("setContent", argument: html) else { return }
        applyLengthIfPresent(dict)
    }

    func content() async throws -> String {
        guard let webView else { throw KnowledgeEditorError.bridgeUnavailable }
        do {
            let result = try await Self.withTimeout(seconds: bridgeTimeout) {
                try await webView.callAsyncJavaScript(
                    "return window.TSEditor.getContent();",
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
            }
            return (result as? String) ?? ""
        } catch is TimeoutError {
            throw KnowledgeEditorError.timeout
        } catch let error as KnowledgeEditorError {
            throw error
        } catch {
            throw KnowledgeEditorError.bridgeUnavailable
        }
    }

    func exec(_ cmd: KnowledgeEditorCommand) async {
        guard let dict = try? await callBridge("exec", argument: cmd.rawValue) else { return }
        guard (dict["ok"] as? Bool) == true else { return }
        if let stateDict = dict["state"] as? [String: Any] {
            state = Self.state(from: stateDict)
            if let length = Self.intValue(stateDict["length"]) {
                contentLength = length
            }
        }
    }

    func insertLink(href: String, text: String, summaryParagraphs: [String]) async throws {
        // Schnelles Fail-Fast auf nativer Seite (spiegelt exakt die
        // autoritative JS-Validierung; siehe KnowledgeEditorValidation-Doku).
        guard KnowledgeEditorValidation.isValidLinkHref(href) else {
            throw KnowledgeEditorError.invalidURL
        }
        let dict = try await callBridge("insertLink", argument: [
            "href": href,
            "text": text,
            "summaryParagraphs": summaryParagraphs
        ])
        guard (dict["ok"] as? Bool) == true else {
            throw Self.mapError(code: dict["code"] as? String)
        }
        applyLengthIfPresent(dict)
    }

    func insertImage(dataURL: String, alt: String) async throws {
        guard KnowledgeEditorValidation.isValidImageDataURL(dataURL) else {
            throw KnowledgeEditorError.invalidImage
        }
        let dict = try await callBridge("insertImage", argument: [
            "dataUrl": dataURL,
            "alt": alt
        ])
        guard (dict["ok"] as? Bool) == true else {
            throw Self.mapError(code: dict["code"] as? String)
        }
        applyLengthIfPresent(dict)
    }

    func focus() async {
        _ = try? await callBridgeNoArg("focus")
    }

    /// Wird bei Terminierung des Web-Content-Prozesses aufgerufen, BEVOR die
    /// Seite neu geladen wird. Setzt `isReady` zurueck, damit ein erneutes
    /// "ready" nach dem Reload wieder als Zustandswechsel erkannt wird (der
    /// zuletzt bekannte Inhalt muss dann von aussen erneut injiziert werden —
    /// sonst wuerde ein Speichern-Aufruf in der Zwischenzeit den leeren
    /// Editorinhalt fuer echt halten und persistieren).
    func handleWebContentProcessTerminated() {
        isReady = false
    }

    // MARK: - JS -> Nativ (WKScriptMessageHandler-Weiterleitung)

    /// Verarbeitet eine rohe `WKScriptMessage.body`. Wird vom
    /// `WKScriptMessageHandler` in `KnowledgeEditorWebView` aufgerufen.
    /// Unbekannte/fehlgeformte Nachrichten werden stillschweigend verworfen
    /// (kein Crash, kein Logging von Inhalt).
    func handleBridgeMessage(_ body: Any) {
        guard let message = KnowledgeEditorMessageParser.parse(body) else { return }
        switch message.kind {
        case .ready:
            isReady = true
        case .state(let newState, let length):
            state = newState
            if let length {
                contentLength = length
            }
        case .change(let length):
            contentLength = length
        case .requestLink(let selectedText):
            onRequestLink?(selectedText)
        case .requestImage:
            onRequestImage?()
        case .contentHeight:
            // Nur iOS-Layout — wird direkt vom UIViewRepresentable-Coordinator
            // konsumiert, nicht auf dem Controller gespiegelt.
            break
        }
    }

    // MARK: - Bridge-Aufruf-Helfer

    private func callBridge(_ function: String, argument: Any) async throws -> [String: Any] {
        guard let webView else { throw KnowledgeEditorError.bridgeUnavailable }
        let script = "return window.TSEditor.\(function)(a);"
        do {
            let result = try await Self.withTimeout(seconds: bridgeTimeout) {
                try await webView.callAsyncJavaScript(
                    script,
                    arguments: ["a": argument],
                    in: nil,
                    contentWorld: .page
                )
            }
            guard let dict = result as? [String: Any] else {
                throw KnowledgeEditorError.bridgeUnavailable
            }
            return dict
        } catch is TimeoutError {
            throw KnowledgeEditorError.timeout
        } catch let error as KnowledgeEditorError {
            throw error
        } catch {
            throw KnowledgeEditorError.bridgeUnavailable
        }
    }

    private func callBridgeNoArg(_ function: String) async throws -> [String: Any] {
        guard let webView else { throw KnowledgeEditorError.bridgeUnavailable }
        let script = "return window.TSEditor.\(function)();"
        do {
            let result = try await Self.withTimeout(seconds: bridgeTimeout) {
                try await webView.callAsyncJavaScript(
                    script,
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
            }
            guard let dict = result as? [String: Any] else {
                throw KnowledgeEditorError.bridgeUnavailable
            }
            return dict
        } catch is TimeoutError {
            throw KnowledgeEditorError.timeout
        } catch let error as KnowledgeEditorError {
            throw error
        } catch {
            throw KnowledgeEditorError.bridgeUnavailable
        }
    }

    private func applyLengthIfPresent(_ dict: [String: Any]) {
        if let length = Self.intValue(dict["length"]) {
            contentLength = length
        }
    }

    private static func mapError(code: String?) -> KnowledgeEditorError {
        switch code {
        case "INVALID_URL": return .invalidURL
        case "INVALID_IMAGE": return .invalidImage
        default: return .bridgeUnavailable
        }
    }

    private static func state(from dict: [String: Any]) -> KnowledgeEditorState {
        KnowledgeEditorState(
            bold: (dict["bold"] as? Bool) ?? false,
            italic: (dict["italic"] as? Bool) ?? false,
            underline: (dict["underline"] as? Bool) ?? false,
            unorderedList: (dict["unorderedList"] as? Bool) ?? false,
            hasSelection: (dict["hasSelection"] as? Bool) ?? false,
            selectedText: KnowledgeEditorMessageParser.truncate(
                (dict["selectedText"] as? String) ?? "",
                KnowledgeEditorMessageParser.maxSelectedTextLength
            )
        )
    }

    private static func intValue(_ any: Any?) -> Int? {
        if let i = any as? Int { return i }
        if let n = any as? NSNumber { return n.intValue }
        return nil
    }

    // MARK: - Timeout-Hilfe

    private struct TimeoutError: Error {}

    private static func withTimeout<T: Sendable>(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
                throw TimeoutError()
            }
            guard let result = try await group.next() else {
                throw TimeoutError()
            }
            group.cancelAll()
            return result
        }
    }
}
