import Foundation
import SwiftUI
import PhotosUI
import Vision
import CryptoKit
import NabaoCore

enum ScreenshotImport {
    struct ImportedPlan {
        let plan: ParsedPlan
        let digest: String
    }
    struct Result {
        var plans: [ImportedPlan] = []
        var messages: [String] = []
    }

    /// The screen receives reviewable values; photo bytes live only during this operation.
    @MainActor
    static func load(_ items: [PhotosPickerItem], alreadyImported: Set<String>) async -> Result {
        var result = Result()
        var seen = alreadyImported
        for (index, item) in items.enumerated() {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    result.messages.append("第 \(index + 1) 张图片读取失败。")
                    continue
                }
                let hash = digest(data)
                if seen.contains(hash) {
                    result.messages.append("第 \(index + 1) 张与已导入或本批图片完全相同，已跳过。若是另一笔计划，请手动新增。")
                    continue
                }
                seen.insert(hash)
                let parsed = try await recognize(data)
                result.plans.append(contentsOf: parsed.plans.map { ImportedPlan(plan: $0, digest: hash) })
                if parsed.plans.isEmpty {
                    result.messages.append("第 \(index + 1) 张未识别到完整计划，可补充完整截图或手动添加。")
                }
                if parsed.incompleteCount > 0 {
                    result.messages.append("第 \(index + 1) 张有 \(parsed.incompleteCount) 条信息不完整，未导入。")
                }
            } catch {
                result.messages.append("第 \(index + 1) 张识别失败：\(error.localizedDescription)")
            }
        }
        return result
    }

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
