//
//  KnowledgeImagePicker.swift
//  ThreadStack
//
//  Arbeitspaket 4 (knowledge-image): Bild-Auswahl (Fotobibliothek/Kamera auf iOS,
//  NSOpenPanel auf macOS) für den nativen Rich-Text-Editor. Bilder werden
//  ausschließlich als Data-URL direkt ins HTML eingebettet (kein Upload-Endpoint,
//  kein Anhang-Feature) – identisch zum Fallback-Verhalten des Web-Editors ohne
//  gespeicherte Seite.
//
//  UX-Vorgabe: vor `onPicked` wird der Nutzer nach einer optionalen
//  Bildbeschreibung (Alt-Text) gefragt.
//
//  Sicherheit: Downscaling/Re-Encoding erfolgt ausschließlich über
//  `KnowledgeImageEncoder` (native ImageIO-APIs, kein JS-Canvas-Weg in der
//  WebView). Es werden keine Bildinhalte oder Dateipfade geloggt.
//

import SwiftUI

#if os(iOS)
import PhotosUI
import UIKit
#elseif os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

/// Ergebnis eines abgeschlossenen Bild-Einfüge-Vorgangs: fertige Data-URL
/// (`data:image/jpeg;base64,...`) plus vom Nutzer eingegebener Alt-Text.
struct KnowledgeImageResult: Equatable {
    let dataURL: String
    let alt: String
}

/// View zum Einfügen eines Bildes in eine Wissensseite. Kapselt Quellauswahl
/// (Fotobibliothek/Kamera bzw. Dateidialog), natives Downscaling/Re-Encoding via
/// `KnowledgeImageEncoder` sowie die Alt-Text-Abfrage. Ruft `onPicked` erst auf,
/// nachdem der Nutzer den Alt-Text-Schritt bestätigt hat.
struct KnowledgeImagePicker: View {
    let onPicked: (KnowledgeImageResult) -> Void

    @State private var pendingDataURL: String?
    @State private var altText = ""
    @State private var showAltSheet = false
    @State private var errorMessage: String?

    #if os(iOS)
    @State private var photoPickerItem: PhotosPickerItem?
    @State private var showPhotosPicker = false
    @State private var showCamera = false
    #endif

    private var errorBinding: Binding<Bool> {
        Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
    }

    var body: some View {
        #if os(iOS)
        Menu {
            Button {
                showPhotosPicker = true
            } label: {
                Label("Fotobibliothek", systemImage: "photo.on.rectangle")
            }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    showCamera = true
                } label: {
                    Label("Kamera", systemImage: "camera")
                }
            }
        } label: {
            Label("Bild einfügen", systemImage: "photo.badge.plus")
        }
        .photosPicker(isPresented: $showPhotosPicker, selection: $photoPickerItem, matching: .images)
        .onChange(of: photoPickerItem) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self) {
                    handlePicked(data: data, filename: "photo.jpg")
                } else {
                    errorMessage = "Das Bild konnte nicht verarbeitet werden."
                }
                photoPickerItem = nil
            }
        }
        .sheet(isPresented: $showCamera) {
            KnowledgeImageCameraCaptureView { data in
                if let data {
                    handlePicked(data: data, filename: "camera.jpg")
                }
            }
        }
        .sheet(isPresented: $showAltSheet, onDismiss: resetPending) {
            altTextSheet
        }
        .alert("Fehler", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        #elseif os(macOS)
        Button {
            openPanel()
        } label: {
            Label("Bild einfügen", systemImage: "photo.badge.plus")
        }
        .sheet(isPresented: $showAltSheet, onDismiss: resetPending) {
            altTextSheet
        }
        .alert("Fehler", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        #endif
    }

    @ViewBuilder private var altTextSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "Beschreibung für Screenreader (optional, aber empfohlen)",
                        text: $altText,
                        axis: .vertical
                    )
                    .lineLimit(1...4)
                } footer: {
                    Text("Beschreibe kurz, was auf dem Bild zu sehen ist.")
                }
            }
            .navigationTitle("Bild einfügen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        showAltSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Einfügen") {
                        confirmInsert()
                    }
                }
            }
        }
    }

    private func handlePicked(data: Data, filename: String) {
        do {
            let encoded = try KnowledgeImageEncoder.dataURL(from: data, filename: filename)
            pendingDataURL = encoded.dataURL
            altText = ""
            showAltSheet = true
        } catch KnowledgeImageError.tooLarge {
            errorMessage = "Das Bild ist auch nach Verkleinerung zu groß."
        } catch {
            errorMessage = "Das Bild konnte nicht verarbeitet werden."
        }
    }

    private func confirmInsert() {
        guard let dataURL = pendingDataURL else {
            showAltSheet = false
            return
        }
        let trimmedAlt = altText.trimmingCharacters(in: .whitespacesAndNewlines)
        showAltSheet = false
        onPicked(KnowledgeImageResult(dataURL: dataURL, alt: trimmedAlt))
        pendingDataURL = nil
        altText = ""
    }

    private func resetPending() {
        pendingDataURL = nil
        altText = ""
    }

    #if os(macOS)
    private func openPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.jpeg, .png, .heic, .heif, .gif, .tiff, .bmp, .webP]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            guard let data = try? Data(contentsOf: url) else {
                errorMessage = "Das Bild konnte nicht verarbeitet werden."
                return
            }
            handlePicked(data: data, filename: url.lastPathComponent)
        }
    }
    #endif
}

#if os(iOS)
/// Kapselt `UIImagePickerController` mit Kamera-Quelle als SwiftUI-Sheet-Inhalt.
/// `PhotosPicker` unterstützt keine Kameraaufnahme, daher wird für diesen Fall
/// weiterhin `UIImagePickerController` verwendet (gemäß Schnittstellenvertrag).
private struct KnowledgeImageCameraCaptureView: UIViewControllerRepresentable {
    let completion: (Data?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(completion: completion)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (Data?) -> Void

        init(completion: @escaping (Data?) -> Void) {
            self.completion = completion
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            picker.dismiss(animated: true)
            if let image = info[.originalImage] as? UIImage,
               let data = image.jpegData(compressionQuality: 0.95) {
                completion(data)
            } else {
                completion(nil)
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            completion(nil)
        }
    }
}
#endif
