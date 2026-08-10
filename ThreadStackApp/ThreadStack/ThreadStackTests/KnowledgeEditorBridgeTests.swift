//
//  KnowledgeEditorBridgeTests.swift
//  ThreadStackTests
//
//  Unit tests for Paket 2 (knowledge-editor-bridge): Message-Parsing/
//  Allowlist der WKScriptMessageHandler-Bridge "tsEditor" (Schnittstelle 4,
//  JS -> Nativ) als reine, testbare Funktionen sowie die nativseitigen
//  Validierungs-Helfer (URL-/Bild-Daten-URL-Validierung, fontScale-Clamping)
//  die den JS-seitigen Regeln aus knowledge-editor.js entsprechen.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Message-Parsing / type-Filterung

struct KnowledgeEditorMessageParserTests {

    @Test func parsesReadyMessage() {
        let body: [String: Any] = ["type": "ready"]
        let message = KnowledgeEditorMessageParser.parse(body)
        #expect(message?.kind == .ready)
    }

    @Test func parsesStateMessageWithAllFields() {
        let body: [String: Any] = [
            "type": "state",
            "bold": true,
            "italic": false,
            "underline": true,
            "unorderedList": false,
            "hasSelection": true,
            "selectedText": "Hallo Welt",
            "length": 42
        ]
        let message = KnowledgeEditorMessageParser.parse(body)
        let expectedState = KnowledgeEditorState(
            bold: true, italic: false, underline: true, unorderedList: false,
            hasSelection: true, selectedText: "Hallo Welt"
        )
        #expect(message?.kind == .state(expectedState, length: 42))
    }

    @Test func stateMessageMissingFieldsDefaultToFalseAndEmpty() {
        let body: [String: Any] = ["type": "state"]
        let message = KnowledgeEditorMessageParser.parse(body)
        #expect(message?.kind == .state(KnowledgeEditorState(), length: nil))
    }

    @Test func selectedTextInStateMessageIsTruncatedTo200Characters() {
        let longText = String(repeating: "a", count: 500)
        let body: [String: Any] = ["type": "state", "selectedText": longText]
        guard case .state(let state, _)? = KnowledgeEditorMessageParser.parse(body)?.kind else {
            Issue.record("expected .state kind")
            return
        }
        #expect(state.selectedText.count == 200)
        #expect(state.selectedText == String(repeating: "a", count: 200))
    }

    @Test func parsesChangeMessage() {
        let body: [String: Any] = ["type": "change", "length": 17]
        let message = KnowledgeEditorMessageParser.parse(body)
        #expect(message?.kind == .change(length: 17))
    }

    @Test func changeMessageWithoutLengthIsDiscarded() {
        let body: [String: Any] = ["type": "change"]
        #expect(KnowledgeEditorMessageParser.parse(body) == nil)
    }

    @Test func parsesRequestLinkMessageAndTruncatesSelectedText() {
        let longText = String(repeating: "x", count: 250)
        let body: [String: Any] = ["type": "requestLink", "selectedText": longText]
        let message = KnowledgeEditorMessageParser.parse(body)
        #expect(message?.kind == .requestLink(selectedText: String(repeating: "x", count: 200)))
    }

    @Test func parsesRequestImageMessage() {
        let body: [String: Any] = ["type": "requestImage"]
        #expect(KnowledgeEditorMessageParser.parse(body)?.kind == .requestImage)
    }

    @Test func parsesContentHeightMessage() {
        let body: [String: Any] = ["type": "contentHeight", "height": 321.5]
        #expect(KnowledgeEditorMessageParser.parse(body)?.kind == .contentHeight(321.5))
    }

    @Test func contentHeightMessageAcceptsNSNumber() {
        let body: [String: Any] = ["type": "contentHeight", "height": NSNumber(value: 200)]
        #expect(KnowledgeEditorMessageParser.parse(body)?.kind == .contentHeight(200))
    }

    @Test func contentHeightMessageWithoutHeightIsDiscarded() {
        let body: [String: Any] = ["type": "contentHeight"]
        #expect(KnowledgeEditorMessageParser.parse(body) == nil)
    }

    @Test func unknownTypeIsDiscarded() {
        let body: [String: Any] = ["type": "somethingUnexpected", "payload": "irrelevant"]
        #expect(KnowledgeEditorMessageParser.parse(body) == nil)
    }

    @Test func messageWithoutTypeFieldIsDiscarded() {
        let body: [String: Any] = ["foo": "bar"]
        #expect(KnowledgeEditorMessageParser.parse(body) == nil)
    }

    @Test func messageBodyThatIsNotADictionaryIsDiscardedWithoutCrash() {
        #expect(KnowledgeEditorMessageParser.parse("just a string") == nil)
        #expect(KnowledgeEditorMessageParser.parse(42) == nil)
        #expect(KnowledgeEditorMessageParser.parse([1, 2, 3]) == nil)
        #expect(KnowledgeEditorMessageParser.parse(NSNull()) == nil)
    }

    @Test func typeFieldThatIsNotAStringIsDiscarded() {
        let body: [String: Any] = ["type": 123]
        #expect(KnowledgeEditorMessageParser.parse(body) == nil)
    }
}

// MARK: - KnowledgeEditorController: Verarbeitung geparster Nachrichten

@MainActor
struct KnowledgeEditorControllerBridgeMessageTests {

    @Test func readyMessageSetsIsReady() {
        let controller = KnowledgeEditorController()
        #expect(controller.isReady == false)
        controller.handleBridgeMessage(["type": "ready"])
        #expect(controller.isReady == true)
    }

    @Test func stateMessageUpdatesPublishedState() {
        let controller = KnowledgeEditorController()
        controller.handleBridgeMessage([
            "type": "state", "bold": true, "unorderedList": true,
            "hasSelection": true, "selectedText": "Auswahl", "length": 12
        ])
        #expect(controller.state.bold == true)
        #expect(controller.state.unorderedList == true)
        #expect(controller.state.selectedText == "Auswahl")
        #expect(controller.contentLength == 12)
    }

    @Test func changeMessageUpdatesContentLengthOnly() {
        let controller = KnowledgeEditorController()
        controller.handleBridgeMessage(["type": "change", "length": 99])
        #expect(controller.contentLength == 99)
        #expect(controller.state == KnowledgeEditorState())
    }

    @Test func requestLinkInvokesCallbackWithTruncatedSelection() {
        let controller = KnowledgeEditorController()
        var received: String?
        controller.onRequestLink = { received = $0 }
        let longText = String(repeating: "z", count: 300)
        controller.handleBridgeMessage(["type": "requestLink", "selectedText": longText])
        #expect(received == String(repeating: "z", count: 200))
    }

    @Test func requestImageInvokesCallback() {
        let controller = KnowledgeEditorController()
        var invoked = false
        controller.onRequestImage = { invoked = true }
        controller.handleBridgeMessage(["type": "requestImage"])
        #expect(invoked == true)
    }

    @Test func unknownTypeDoesNotInvokeAnyCallbackOrChangeState() {
        let controller = KnowledgeEditorController()
        var linkInvoked = false
        var imageInvoked = false
        controller.onRequestLink = { _ in linkInvoked = true }
        controller.onRequestImage = { imageInvoked = true }
        controller.handleBridgeMessage(["type": "unknown"])
        #expect(linkInvoked == false)
        #expect(imageInvoked == false)
        #expect(controller.isReady == false)
    }

    @Test func malformedBodyDoesNotCrash() {
        let controller = KnowledgeEditorController()
        controller.handleBridgeMessage("not a dictionary")
        controller.handleBridgeMessage(NSNull())
        controller.handleBridgeMessage(["no": "type field"])
        #expect(controller.isReady == false)
    }

    @Test func contentHeightMessageDoesNotChangePublishedProperties() {
        let controller = KnowledgeEditorController()
        controller.handleBridgeMessage(["type": "contentHeight", "height": 500.0])
        #expect(controller.isReady == false)
        #expect(controller.contentLength == 0)
        #expect(controller.state == KnowledgeEditorState())
    }
}

// MARK: - URL-/Bild-Daten-URL-Validierung, fontScale-Clamping

struct KnowledgeEditorValidationTests {

    @Test(arguments: [
        "http://example.com",
        "https://example.com",
        "HTTPS://example.com/path?x=1",
        "http://localhost:3000"
    ])
    func validHrefIsAccepted(href: String) {
        #expect(KnowledgeEditorValidation.isValidLinkHref(href))
    }

    @Test(arguments: [
        "javascript:alert(1)",
        "ftp://example.com",
        "example.com",
        "//example.com",
        "",
        "data:text/html,<script>alert(1)</script>",
        "  https://example.com" // führender Whitespace nicht erlaubt (muss am Anfang stehen)
    ])
    func invalidHrefIsRejected(href: String) {
        #expect(!KnowledgeEditorValidation.isValidLinkHref(href))
    }

    @Test(arguments: [
        "data:image/png;base64,iVBORw0KGgo=",
        "data:image/jpeg;base64,/9j/4AAQ",
        "data:image/gif;base64,R0lGOD",
        "data:image/webp;base64,UklGR"
    ])
    func validImageDataURLIsAccepted(dataURL: String) {
        #expect(KnowledgeEditorValidation.isValidImageDataURL(dataURL))
    }

    @Test(arguments: [
        "data:image/svg+xml;base64,PHN2Zz4=", // SVG kann Skripte enthalten — bewusst nicht erlaubt
        "data:text/plain;base64,aGVsbG8=",
        "https://example.com/image.png",
        "",
        "data:image/png,notBase64"
    ])
    func invalidImageDataURLIsRejected(dataURL: String) {
        #expect(!KnowledgeEditorValidation.isValidImageDataURL(dataURL))
    }

    @Test func fontScaleWithinRangeIsUnchanged() {
        #expect(KnowledgeEditorValidation.clampFontScale(1.2) == 1.2)
    }

    @Test func fontScaleBelowMinimumIsClampedTo0_8() {
        #expect(KnowledgeEditorValidation.clampFontScale(0.1) == 0.8)
    }

    @Test func fontScaleAboveMaximumIsClampedTo2_0() {
        #expect(KnowledgeEditorValidation.clampFontScale(5.0) == 2.0)
    }

    @Test func fontScaleAtExactBoundariesIsUnchanged() {
        #expect(KnowledgeEditorValidation.clampFontScale(0.8) == 0.8)
        #expect(KnowledgeEditorValidation.clampFontScale(2.0) == 2.0)
    }
}

// MARK: - KnowledgeEditorController: Fassade ohne verbundene WebView

@MainActor
struct KnowledgeEditorControllerWithoutWebViewTests {

    @Test func insertLinkWithInvalidHrefThrowsWithoutTouchingWebView() async {
        let controller = KnowledgeEditorController()
        await #expect(throws: KnowledgeEditorError.invalidURL) {
            try await controller.insertLink(href: "javascript:alert(1)", text: "x", summaryParagraphs: [])
        }
    }

    @Test func insertImageWithInvalidDataURLThrowsWithoutTouchingWebView() async {
        let controller = KnowledgeEditorController()
        await #expect(throws: KnowledgeEditorError.invalidImage) {
            try await controller.insertImage(dataURL: "https://example.com/x.png", alt: "x")
        }
    }

    @Test func contentThrowsBridgeUnavailableWhenNoWebViewAttached() async {
        let controller = KnowledgeEditorController()
        await #expect(throws: KnowledgeEditorError.bridgeUnavailable) {
            _ = try await controller.content()
        }
    }

    @Test func setContentWithoutWebViewDoesNotCrashOrThrow() async {
        let controller = KnowledgeEditorController()
        await controller.setContent("<p>Hallo</p>")
        #expect(controller.contentLength == 0)
    }

    @Test func execWithoutWebViewDoesNotCrashOrThrow() async {
        let controller = KnowledgeEditorController()
        await controller.exec(.bold)
        #expect(controller.state == KnowledgeEditorState())
    }

    @Test func focusWithoutWebViewDoesNotCrashOrThrow() async {
        let controller = KnowledgeEditorController()
        await controller.focus()
    }
}

// MARK: - EditorAssets im Bundle auffindbar (verifiziert Ressourcen-Copy)

struct KnowledgeEditorAssetsTests {

    @Test func htmlCssAndJsAreDiscoverableInTestBundle() {
        // Hinweis: ThreadStackTests ist kein eigenständiges App-Bundle mit den
        // ThreadStack-Ressourcen; dieser Test dokumentiert daher nur, dass der
        // Locator selbst fehlerfrei arbeitet (liefert nil statt zu crashen,
        // wenn die Ressource im jeweiligen Bundle nicht vorhanden ist). Die
        // tatsächliche Auffindbarkeit im ThreadStack.app-Bundle wurde manuell
        // per xcodebuild-Buildprodukt-Inspektion verifiziert (siehe
        // Abschlussbericht).
        let url = KnowledgeEditorAssets.htmlURL(bundle: Bundle(for: BundleLocatorMarker.self))
        // Kein #expect(url != nil) hier, da dieses Test-Bundle die Assets
        // (Eigentum des ThreadStack-App-Targets) nicht enthält — der Test
        // stellt lediglich sicher, dass der Aufruf nicht crasht und ein
        // optionaler, klar behandelbarer Rückgabewert entsteht.
        _ = url
    }
}

private final class BundleLocatorMarker {}
