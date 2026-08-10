//
//  KnowledgeImageEncoderTests.swift
//  ThreadStackTests
//
//  Unit-Tests für Arbeitspaket 4 (knowledge-image): `KnowledgeImageEncoder`.
//  Deckt gemäß Definition of Done ab: korrektes Downscaling-Verhalten,
//  Qualitätsreduktion bei Überschreiten von `maxEncodedBytes`, den Fehlerfall
//  bei nicht-lesbaren Daten sowie die Verifikation, dass keine EXIF-GPS-Daten
//  im Ergebnis-JPEG stecken. Zusätzlich: MIME-Type-Erzwingung (immer JPEG,
//  unabhängig vom Quellformat).
//

import Testing
import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers
@testable import ThreadStack

struct KnowledgeImageEncoderTests {

    // MARK: - Test-Hilfsfunktionen

    /// Erzeugt ein einfarbiges Testbild (komprimiert sehr gut, bleibt bei
    /// jeder Qualitätsstufe deutlich unter dem Größenlimit).
    private static func makeSolidImage(width: Int, height: Int, value: UInt8 = 128) -> CGImage {
        var pixels = [UInt8](repeating: value, count: width * height * 4)
        for i in stride(from: 3, to: pixels.count, by: 4) { pixels[i] = 255 } // Alpha opak
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return ctx.makeImage()!
    }

    /// Erzeugt ein Zufallsrausch-Testbild (komprimiert sehr schlecht, dient
    /// dazu, Qualitätsreduktion bzw. das Größenlimit deterministisch zu testen).
    private static func makeNoiseImage(width: Int, height: Int) -> CGImage {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for i in 0..<pixels.count { pixels[i] = UInt8.random(in: 0...255) }
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return ctx.makeImage()!
    }

    private static func jpegData(
        from image: CGImage, quality: CGFloat = 0.9, gpsDictionary: [CFString: Any]? = nil
    ) -> Data {
        let output = NSMutableData()
        let dest = CGImageDestinationCreateWithData(
            output as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil
        )!
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        if let gpsDictionary { properties[kCGImagePropertyGPSDictionary] = gpsDictionary }
        CGImageDestinationAddImage(dest, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(dest))
        return output as Data
    }

    private static let dataURLPrefix = "data:image/jpeg;base64,"

    private static func rawBytes(from dataURL: String) throws -> Data {
        #expect(dataURL.hasPrefix(dataURLPrefix))
        let base64 = String(dataURL.dropFirst(dataURLPrefix.count))
        return try #require(Data(base64Encoded: base64))
    }

    private static func pixelSize(of rawJPEGData: Data) throws -> (width: Int, height: Int) {
        let source = try #require(CGImageSourceCreateWithData(rawJPEGData as CFData, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let w = try #require(props[kCGImagePropertyPixelWidth] as? Int)
        let h = try #require(props[kCGImagePropertyPixelHeight] as? Int)
        return (w, h)
    }

    // MARK: - Downscaling

    @Test func downscalesImageLargerThanMaxPixelToLongestEdge1200() throws {
        let image = Self.makeSolidImage(width: 2400, height: 1600) // Seitenverhältnis 3:2
        let source = Self.jpegData(from: image, quality: 0.9)

        let result = try KnowledgeImageEncoder.dataURL(from: source, filename: "big.jpg")

        let raw = try Self.rawBytes(from: result.dataURL)
        let size = try Self.pixelSize(of: raw)
        #expect(max(size.width, size.height) == Int(KnowledgeImageEncoder.maxPixel))
        // Seitenverhältnis bleibt erhalten: 2400:1600 -> 1200:800
        #expect(size.width == 1200)
        #expect(size.height == 800)
    }

    @Test func doesNotUpscaleImageSmallerThanMaxPixel() throws {
        let image = Self.makeSolidImage(width: 200, height: 150)
        let source = Self.jpegData(from: image, quality: 0.9)

        let result = try KnowledgeImageEncoder.dataURL(from: source, filename: "small.jpg")

        let raw = try Self.rawBytes(from: result.dataURL)
        let size = try Self.pixelSize(of: raw)
        #expect(size.width == 200)
        #expect(size.height == 150)
    }

    // MARK: - Qualitätsreduktion bei Überschreiten von maxEncodedBytes

    @Test func reducesQualityStepwiseUntilUnderSizeLimit() throws {
        // 800x800 Zufallsrauschen: bei Qualität 0.8 und 0.6 liegt die JPEG-Größe
        // empirisch deutlich über 300_000 Bytes, erst bei 0.4 wird das Limit
        // unterschritten (~282 KB). Kein Downscaling nötig (800 < maxPixel).
        let image = Self.makeNoiseImage(width: 800, height: 800)
        let source = Self.jpegData(from: image, quality: 0.95)

        let result = try KnowledgeImageEncoder.dataURL(from: source, filename: "noise.jpg")

        let raw = try Self.rawBytes(from: result.dataURL)
        #expect(raw.count > 0)
        #expect(raw.count <= KnowledgeImageEncoder.maxEncodedBytes)
    }

    @Test func throwsTooLargeWhenEvenLowestQualityExceedsLimit() throws {
        // 1200x1200 Zufallsrauschen bleibt auch bei Qualität 0.4 deutlich über
        // dem 300_000-Byte-Limit (empirisch ~635 KB) -> muss als Fehler geworfen
        // werden statt eine übergroße Data-URL zurückzugeben.
        let image = Self.makeNoiseImage(width: 1200, height: 1200)
        let source = Self.jpegData(from: image, quality: 0.95)

        do {
            _ = try KnowledgeImageEncoder.dataURL(from: source, filename: "noise-large.jpg")
            Issue.record("Erwarteter KnowledgeImageError.tooLarge wurde nicht geworfen")
        } catch KnowledgeImageError.tooLarge {
            // erwartet
        } catch {
            Issue.record("Unerwarteter Fehlertyp: \(error)")
        }
    }

    // MARK: - Fehlerfall nicht-lesbare Daten

    @Test func throwsUnreadableForGarbageData() {
        let garbage = Data([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xAB, 0xCD])
        do {
            _ = try KnowledgeImageEncoder.dataURL(from: garbage, filename: "not-an-image.jpg")
            Issue.record("Erwarteter KnowledgeImageError.unreadable wurde nicht geworfen")
        } catch KnowledgeImageError.unreadable {
            // erwartet
        } catch {
            Issue.record("Unerwarteter Fehlertyp: \(error)")
        }
    }

    @Test func throwsUnreadableForEmptyData() {
        do {
            _ = try KnowledgeImageEncoder.dataURL(from: Data(), filename: "empty.jpg")
            Issue.record("Erwarteter KnowledgeImageError.unreadable wurde nicht geworfen")
        } catch KnowledgeImageError.unreadable {
            // erwartet
        } catch {
            Issue.record("Unerwarteter Fehlertyp: \(error)")
        }
    }

    // MARK: - EXIF/GPS-Strip

    @Test func stripsGPSMetadataFromReencodedJPEG() throws {
        let image = Self.makeSolidImage(width: 100, height: 100)
        let gps: [CFString: Any] = [
            kCGImagePropertyGPSLatitude: 52.5200,
            kCGImagePropertyGPSLatitudeRef: "N",
            kCGImagePropertyGPSLongitude: 13.4050,
            kCGImagePropertyGPSLongitudeRef: "E"
        ]
        let source = Self.jpegData(from: image, quality: 0.9, gpsDictionary: gps)

        // Sicherstellen, dass die Quelldatei die GPS-Daten tatsächlich enthält -
        // sonst wäre der Test auch bei einem fehlerhaften Encoder grün.
        let sourceImageSource = try #require(CGImageSourceCreateWithData(source as CFData, nil))
        let sourceProps = CGImageSourceCopyPropertiesAtIndex(sourceImageSource, 0, nil) as? [CFString: Any]
        #expect(sourceProps?[kCGImagePropertyGPSDictionary] != nil)

        let result = try KnowledgeImageEncoder.dataURL(from: source, filename: "gps.jpg")

        let raw = try Self.rawBytes(from: result.dataURL)
        let outSource = try #require(CGImageSourceCreateWithData(raw as CFData, nil))
        let outProps = CGImageSourceCopyPropertiesAtIndex(outSource, 0, nil) as? [CFString: Any]
        let gpsInOutput = outProps?[kCGImagePropertyGPSDictionary] as? [CFString: Any]
        #expect(gpsInOutput == nil || gpsInOutput!.isEmpty)
    }

    // MARK: - MIME-Type-Erzwingung (immer JPEG, unabhängig vom Quellformat)

    @Test func alwaysReturnsImageJpegDataURLEvenForPNGSource() throws {
        let image = Self.makeSolidImage(width: 50, height: 50)
        let pngOutput = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(
            pngOutput as CFMutableData, UTType.png.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(dest, image, nil)
        #expect(CGImageDestinationFinalize(dest))

        let result = try KnowledgeImageEncoder.dataURL(from: pngOutput as Data, filename: "input.png")

        #expect(result.dataURL.hasPrefix(Self.dataURLPrefix))
    }

    // MARK: - alt bleibt gemäß Vertrag leer (Alt-Text wird vom Picker separat gesetzt)

    @Test func encoderResultHasEmptyAltByContract() throws {
        let image = Self.makeSolidImage(width: 50, height: 50)
        let source = Self.jpegData(from: image, quality: 0.9)

        let result = try KnowledgeImageEncoder.dataURL(from: source, filename: "x.jpg")

        #expect(result.alt == "")
    }
}
