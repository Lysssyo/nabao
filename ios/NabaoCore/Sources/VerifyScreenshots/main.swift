import Foundation
import Vision
import NabaoCore

// Explicit local image input only. Outputs recognized plan fields, never raw OCR or accounts.
let expectedCounts = [2, 2, 1]
var passed = true
for (index, path) in CommandLine.arguments.dropFirst().enumerated() {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(url: URL(fileURLWithPath: path)).perform([request])
    let lines = (request.results ?? []).compactMap { observation -> OCRLine? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        let rect = observation.boundingBox
        return OCRLine(text: text, x: rect.minX, y: 1 - rect.maxY, width: rect.width, height: rect.height)
    }
    let result = ScreenshotParser.parse(lines)
    print("\(URL(fileURLWithPath: path).lastPathComponent): \(result.plans.count) complete plans, \(result.channel.title)")
    for plan in result.plans {
        print("  \(plan.fundName) | \(Money.text(plan.amountMinor)) | \(plan.frequency) | \(plan.nextExecutionDate ?? "unknown")")
    }
    if index < expectedCounts.count && result.plans.count != expectedCounts[index] { passed = false }
}
if !passed { exit(1) }
