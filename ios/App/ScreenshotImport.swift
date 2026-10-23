import Foundation
import Vision
import CryptoKit
import NabaoCore

enum ScreenshotImport {
    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func recognize(_ data: Data) async throws -> ParseResult {
        try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(data: data).perform([request])
            let lines = (request.results ?? []).compactMap { result -> OCRLine? in
                guard let text = result.topCandidates(1).first?.string else { return nil }
                let rect = result.boundingBox
                return OCRLine(text: text, x: rect.minX, y: 1 - rect.maxY, width: rect.width, height: rect.height)
            }
            return ScreenshotParser.parse(lines)
        }.value
    }
}

struct ReviewBatch: Identifiable {
    let id = UUID()
    var drafts: [PlanDraft]
    var messages: [String] = []
    var isEditing = false
}
