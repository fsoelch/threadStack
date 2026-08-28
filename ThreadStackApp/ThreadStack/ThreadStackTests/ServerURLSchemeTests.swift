//
//  ServerURLSchemeTests.swift
//  ThreadStackTests
//
//  Security-Nachbesserung: `isAllowedServerURLScheme` (Extensions.swift) ist
//  die einzige Verteidigungslinie gegen einen Nutzer, der versehentlich (oder
//  über eine manipulierte Server-URL) Session-Cookie und Klartext-Passwort
//  (biometrischer Unlock) per http:// an einen fremden Host sendet. Dieser
//  Test deckt die Allow-/Deny-Matrix explizit ab, unabhaengig vom jeweiligen
//  Aufrufer (AppState/ProgressAPI/SummaryAPI nutzen alle dieselbe Funktion).
//

import Testing
import Foundation
@testable import ThreadStack

struct ServerURLSchemeTests {

    @Test func allowsHttps() throws {
        #expect(isAllowedServerURLScheme(URL(string: "https://soelch.com/threadStack")!))
    }

    @Test func allowsHttpsWithPort() throws {
        #expect(isAllowedServerURLScheme(URL(string: "https://example.com:8443/api")!))
    }

    @Test(arguments: ["localhost", "127.0.0.1", "::1", "LOCALHOST"])
    func allowsHttpOnlyForLocalDevHosts(_ host: String) throws {
        let raw = host.contains(":") ? "http://[\(host)]:3000/api" : "http://\(host):3000/api"
        let url = try #require(URL(string: raw))
        #expect(isAllowedServerURLScheme(url))
    }

    @Test func rejectsHttpForRemoteHost() throws {
        #expect(!isAllowedServerURLScheme(URL(string: "http://soelch.com/threadStack")!))
    }

    @Test func rejectsHttpForArbitraryLanIP() throws {
        #expect(!isAllowedServerURLScheme(URL(string: "http://192.168.1.42/api")!))
    }

    @Test(arguments: ["ftp", "file", "javascript", "data"])
    func rejectsNonHttpSchemes(_ scheme: String) throws {
        #expect(!isAllowedServerURLScheme(URL(string: "\(scheme)://example.com/api")!))
    }
}

struct SettingsServerURLInputTests {

    @Test func trimsWhitespaceAndTrailingSlashes() throws {
        #expect(trimmedServerURLInput("  https://example.com/  ") == "https://example.com")
        #expect(trimmedServerURLInput("https://example.com///") == "https://example.com")
    }

    @Test func acceptsValidHttps() throws {
        #expect(isValidServerURLInput(trimmedServerURLInput("https://soelch.com/threadStack")))
    }

    @Test func rejectsEmptyInput() throws {
        #expect(!isValidServerURLInput(trimmedServerURLInput("   ")))
    }

    @Test func rejectsHttpForRemoteHost() throws {
        #expect(!isValidServerURLInput(trimmedServerURLInput("http://example.com")))
    }

    @Test func acceptsHttpForLocalhost() throws {
        #expect(isValidServerURLInput(trimmedServerURLInput("http://localhost:3000")))
    }

    @Test func rejectsUnparsableInput() throws {
        // Leerzeichen innerhalb der URL machen sie fuer URL(string:) ungueltig.
        #expect(!isValidServerURLInput(trimmedServerURLInput("not a url at all")))
    }
}
