import SwiftUI
import WebKit

#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Findet die Editor-Assets (`knowledge-editor.html` + zugehörige
/// `.css`/`.js`) im App-Bundle. Da `PBXFileSystemSynchronizedRootGroup`
/// Ressourcen je nach Xcode-Konfiguration entweder mit erhaltener
/// Unterordner-Struktur ("EditorAssets" als Subdirectory) oder
/// abgeflacht in die Resources-Wurzel kopieren kann, wird zuerst mit
/// `subdirectory` gesucht und andernfalls auf eine flache Suche
/// zurückgefallen. Siehe Abschlussbericht für die tatsächlich verifizierte
/// Bundle-Struktur dieses Projekts.
enum KnowledgeEditorAssets {
    static func htmlURL(bundle: Bundle = .main) -> URL? {
        bundle.url(forResource: "knowledge-editor", withExtension: "html", subdirectory: "EditorAssets")
            ?? bundle.url(forResource: "knowledge-editor", withExtension: "html")
    }
}

/// Wrapper, der den `WKScriptMessageHandler` nur schwach referenziert.
/// `WKUserContentController` hält seinen registrierten Handler stark; ohne
/// diesen Proxy würde das ein Retain-Cycle mit der WebView/dem Coordinator
/// riskieren, falls `removeScriptMessageHandler(forName:)` beim Abbau einmal
/// nicht zuverlässig rechtzeitig läuft.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// Eigener `WKNavigationDelegate` für den Wissens-Editor — bewusst NICHT
/// `HTMLContentNavigationDelegate` aus HTMLContentView.swift wiederverwendet
/// oder verändert (die Datei bleibt komplett unangetastet). Erlaubt
/// ausschließlich die initiale `file://`-Navigation auf
/// `knowledge-editor.html`; jede weitere Navigation wird abgebrochen.
/// http(s)-Links werden extern geöffnet, niemals in der WebView selbst.
@MainActor
final class KnowledgeEditorCoordinator: NSObject {
    static let messageHandlerName = "tsEditor"

    let controller: KnowledgeEditorController
    #if os(iOS)
    private let heightBinding: Binding<CGFloat>?
    #endif

    private weak var webView: WKWebView?
    private var expectedInitialURL: URL?

    #if os(iOS)
    init(controller: KnowledgeEditorController, heightBinding: Binding<CGFloat>?) {
        self.controller = controller
        self.heightBinding = heightBinding
    }
    #else
    init(controller: KnowledgeEditorController) {
        self.controller = controller
    }
    #endif

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // Kein Cache/localStorage mit Wissensinhalten auf Platte.
        config.websiteDataStore = .nonPersistent()

        let prefs = WKWebpagePreferences()
        // Bewusste Abweichung von HTMLContentView.swift (dort deaktiviert,
        // `allowsContentJavaScript = false`): Dieser native Rich-Text-Editor
        // benötigt JavaScript zwingend für die bidirektionale Bridge
        // (window.TSEditor / WKScriptMessageHandler "tsEditor"). Die Aktivierung
        // gilt AUSSCHLIESSLICH für diese Editor-WebView-Instanz und ist durch
        // eine statische, restriktive CSP (default-src 'none'; script-src 'self';
        // connect-src 'none'; ...) sowie einen dedizierten Navigation-/UI-Delegate
        // eingehegt (siehe unten und knowledge-editor.html).
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        let userContentController = WKUserContentController()
        userContentController.add(WeakScriptMessageHandler(self), name: Self.messageHandlerName)
        config.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        #if os(iOS)
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        #endif

        self.webView = webView
        controller.webView = webView

        if let htmlURL = KnowledgeEditorAssets.htmlURL() {
            expectedInitialURL = htmlURL.standardizedFileURL
            webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        }
        return webView
    }

    /// Laedt den Editor neu, falls der Web-Content-Prozess beendet wurde
    /// (z. B. durch Speicherdruck) — sonst bliebe die WebView dauerhaft leer.
    private func reloadInitialPage() {
        guard let webView, let expectedInitialURL else { return }
        webView.loadFileURL(expectedInitialURL, allowingReadAccessTo: expectedInitialURL.deletingLastPathComponent())
    }

    func tearDown() {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.messageHandlerName)
        controller.webView = nil
        webView = nil
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.messageHandlerName)
    }
}

// MARK: - WKNavigationDelegate

extension KnowledgeEditorCoordinator: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url,
           url.isFileURL, url.standardizedFileURL == expectedInitialURL {
            decisionHandler(.allow)
            return
        }
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            #if os(iOS)
            UIApplication.shared.open(url)
            #else
            NSWorkspace.shared.open(url)
            #endif
        }
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reloadInitialPage()
    }
}

// MARK: - WKUIDelegate (keine Popups, keine JS-Dialoge)

extension KnowledgeEditorCoordinator: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        // Der Web-Editor nutzt prompt()/alert() u. a. für Tabellen — dieser
        // Pfad wird bewusst nicht portiert (Tabellen-Erzeugung außerhalb des
        // MVP-Scopes). Dialoge werden abgelehnt, nicht angezeigt.
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(false)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        completionHandler(nil)
    }
}

// MARK: - WKScriptMessageHandler (Schnittstelle 4: JS -> Nativ)

extension KnowledgeEditorCoordinator: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageHandlerName else { return }
        let body = message.body

        #if os(iOS)
        if let parsed = KnowledgeEditorMessageParser.parse(body), case .contentHeight(let height) = parsed.kind {
            let binding = heightBinding
            DispatchQueue.main.async {
                binding?.wrappedValue = CGFloat(height)
            }
        }
        #endif

        controller.handleBridgeMessage(body)
    }
}

// MARK: - SwiftUI-Repräsentation

#if os(iOS)
/// `UIViewRepresentable` für den Wissens-Editor. Erzeugt den
/// `KnowledgeEditorController` NICHT selbst (wird von außen als
/// `@StateObject`/Parameter hereingereicht), sonst geht bei jedem
/// SwiftUI-Re-Render der Editorinhalt verloren.
struct KnowledgeEditorWebView: UIViewRepresentable {
    @ObservedObject var controller: KnowledgeEditorController
    var measuredHeight: Binding<CGFloat>?

    func makeCoordinator() -> KnowledgeEditorCoordinator {
        KnowledgeEditorCoordinator(controller: controller, heightBinding: measuredHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        context.coordinator.makeWebView()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Inhalt/Zustand werden ausschließlich über die Bridge-Methoden des
        // extern gehaltenen Controllers gesteuert, nicht über Re-Renders.
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: KnowledgeEditorCoordinator) {
        coordinator.tearDown()
    }
}
#else
/// `NSViewRepresentable` für den Wissens-Editor (macOS-Variante).
struct KnowledgeEditorWebView: NSViewRepresentable {
    @ObservedObject var controller: KnowledgeEditorController

    func makeCoordinator() -> KnowledgeEditorCoordinator {
        KnowledgeEditorCoordinator(controller: controller)
    }

    func makeNSView(context: Context) -> WKWebView {
        context.coordinator.makeWebView()
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Inhalt/Zustand werden ausschließlich über die Bridge-Methoden des
        // extern gehaltenen Controllers gesteuert, nicht über Re-Renders.
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: KnowledgeEditorCoordinator) {
        coordinator.tearDown()
    }
}
#endif
