//
//  KnowledgeImageEncoder.swift
//  ThreadStack
//
//  Arbeitspaket 4 (knowledge-image): natives Downscaling + JPEG-Re-Encoding von
//  Nutzerbildern für den nativen Rich-Text-Editor. Ergebnis ist ausschließlich
//  eine "data:image/jpeg;base64,..."-URL (kein Upload-Endpoint, kein Anhang-Feature).
//
//  Sicherheits-Baseline:
//  - Es wird IMMER nach JPEG re-encodiert (kein Durchreichen des Quellformats) –
//    das verhindert das Einschleusen polyglotter/manipulierter Bilddateien mit
//    eingebettetem Fremd-Payload und garantiert einen einzigen, kontrollierten
//    MIME-Typ innerhalb der Server-Sanitizing-Allowlist (`data:image/jpeg`).
//  - Beim Re-Encoding werden KEINE Properties/Metadaten der Quelle übernommen
//    (kein Merge von `kCGImagePropertyExifDictionary` / `kCGImagePropertyGPSDictionary`),
//    dadurch werden EXIF- und insbesondere GPS-Standortdaten verworfen.
//  - Größenlimit wird strikt durchgesetzt (schützt das 500.000-Zeichen-
//    Gesamtlimit der Wissensseite vor einem einzelnen übergroßen Bild).
//  - Es werden keine Bildinhalte oder Dateipfade geloggt.
//

import Foundation
import ImageIO
import UniformTypeIdentifiers

enum KnowledgeImageError: Error {
    case unreadable
    case tooLarge
}

enum KnowledgeImageEncoder {
    /// Längste Kante nach Downscaling.
    static let maxPixel: CGFloat = 1200
    /// Standard-JPEG-Qualität.
    static let jpegQuality: CGFloat = 0.8
    /// Harte Obergrenze für die Größe der JPEG-Rohdaten (Bytes vor Base64).
    /// Bei Überschreitung wird die Qualität stufenweise reduziert (0.6, dann 0.4);
    /// danach wird ein Fehler geworfen.
    static let maxEncodedBytes = 300_000
    /// Obergrenze fuer die Rohgroesse der Quelldatei, bevor ueberhaupt decodiert
    /// wird — verhindert, dass eine manipulierte/exotische Datei (z. B. ohne
    /// auslesbare Pixel-Properties) als Dekompressionsbombe den Prozess per
    /// Speicherdruck beendet.
    static let maxSourceBytes = 40_000_000

    /// Downscaled ein Quellbild (beliebiges von ImageIO lesbares Format) auf maximal
    /// `maxPixel` an der längsten Kante, re-encodiert es verlustbehaftet als JPEG
    /// (ohne Übernahme von Quell-Metadaten, d. h. EXIF/GPS werden verworfen) und
    /// liefert das Ergebnis als vollständige Data-URL.
    ///
    /// - Parameters:
    ///   - data: Rohdaten der Quelldatei (z. B. aus Fotobibliothek, Kamera oder
    ///     `NSOpenPanel`-Auswahl).
    ///   - filename: Ursprünglicher Dateiname, ausschließlich zu Diagnosezwecken im
    ///     Aufrufer-Kontext (fließt nicht in die Kodierung oder das Ergebnis ein).
    /// - Throws: `KnowledgeImageError.unreadable`, wenn die Daten nicht als Bild
    ///   gelesen werden können; `KnowledgeImageError.tooLarge`, wenn das Bild auch
    ///   nach Qualitätsreduktion die Größengrenze überschreitet.
    static func dataURL(from data: Data, filename: String) throws -> KnowledgeImageResult {
        guard !data.isEmpty, data.count <= maxSourceBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else {
            throw KnowledgeImageError.unreadable
        }

        // Immer ueber den Thumbnail-Pfad decodieren (mit erzwungener
        // Erzeugung, auch wenn die Quell-Properties keine Pixelmasse liefern)
        // statt bei fehlenden Properties auf ein volles, unbegrenztes Decode
        // zurueckzufallen — das begrenzt den Speicherbedarf unabhaengig davon,
        // ob die Quelldatei verlaessliche Metadaten mitliefert.
        guard let image = boundedImage(source: source) else {
            throw KnowledgeImageError.unreadable
        }

        // Qualität stufenweise reduzieren, bis das Größenlimit eingehalten wird.
        let qualitySteps: [CGFloat] = [jpegQuality, 0.6, 0.4]
        for quality in qualitySteps {
            guard let encoded = encodeJPEG(image: image, quality: quality) else {
                throw KnowledgeImageError.unreadable
            }
            if encoded.count <= maxEncodedBytes {
                let base64 = encoded.base64EncodedString()
                return KnowledgeImageResult(dataURL: "data:image/jpeg;base64,\(base64)", alt: "")
            }
        }
        throw KnowledgeImageError.tooLarge
    }

    /// Erzeugt immer ueber den Thumbnail-Pfad ein auf maximal `maxPixel`
    /// begrenztes `CGImage` — unabhaengig davon, ob die Quell-Properties
    /// auslesbare Pixelmasse liefern. `kCGImageSourceCreateThumbnailFromImageAlways`
    /// erzwingt dabei die Erzeugung auch fuer Bilder ohne eingebettetes
    /// Thumbnail, und `kCGImageSourceThumbnailMaxPixelSize` begrenzt den
    /// Speicherbedarf des Decodings selbst bei sehr grossen/manipulierten
    /// Quellbildern (Schutz vor Dekompressionsbomben).
    ///
    /// Es werden bewusst keine Properties-/Metadaten-Optionen genutzt, die
    /// Quell-Metadaten (insbesondere EXIF/GPS) in das Ergebnis übernehmen würden.
    private static func boundedImage(source: CGImageSource) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maxPixel),
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Kodiert ein `CGImage` verlustbehaftet als JPEG. Es werden bewusst KEINE
    /// Quell-Properties/Metadaten übergeben (kein Properties-Dictionary aus der
    /// Quelle), damit EXIF/GPS-Daten nicht in das Ergebnis gelangen.
    private static func encodeJPEG(image: CGImage, quality: CGFloat) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            return nil
        }
        let destProperties: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: quality
        ]
        CGImageDestinationAddImage(destination, image, destProperties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
