import Foundation

/// Coordinates normalized to [0, 1], with y measured from the image top.
public struct OCRLine: Sendable {
    public let text: String
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(text: String, x: Double, y: Double, width: Double = 0.8, height: Double = 0.018) {
        self.text = text
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct ParsedPlan: Identifiable, Sendable {
    public let id = UUID()
    public let fundName: String
    public let fundCode: String?
    public let amountMinor: Int64
    public let frequency: String
    public let nextExecutionDate: String?
    public let channel: Channel
    public let notes: [String]
}

public struct ParseResult: Sendable {
    public let plans: [ParsedPlan]
    public let incompleteCount: Int
    public let channel: Channel
}

public enum ScreenshotParser {
    public static func parse(_ input: [OCRLine]) -> ParseResult {
        // Never retain payment / account fields in parser results.
        let lines = input.filter {
            !$0.text.contains("银行") && !$0.text.contains("储蓄")
                && !$0.text.contains("关联账号") && !$0.text.contains("快捷购")
        }.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
        let text = lines.map(\.text).joined(separator: "\n")
        let channel: Channel = text.contains("投资计划") && text.contains("买入金额")
            ? .alipay : (text.contains("我的定投") && text.contains("定投金额") ? .southern : .unknown)
        let titles = lines.filter(isFundTitle)
        var plans: [ParsedPlan] = []
        var incomplete = 0
        for (index, title) in titles.enumerated() {
            let bottom = index + 1 < titles.count ? titles[index + 1].y : 1.0
            let block = lines.filter { $0.y >= title.y - 0.004 && $0.y < bottom - 0.004 }
            guard let amount = amount(in: block), let frequency = frequency(in: block) else {
                incomplete += 1
                continue
            }
            var name = cleanedName(title.text)
            var notes: [String] = []
            var inferredShareClass = false
            // Vision can mistake I for 1. Surface this correction for human confirmation.
            if name.range(of: #"[)）]\s*1$"#, options: .regularExpression) != nil {
                name = String(name.dropLast()) + "I"
                inferredShareClass = true
                notes.append("份额 I 由 OCR 字符 1 推测，请核对原图")
            }
            let code = inferredShareClass ? nil : KnownFund.code(for: name)
            if code == nil { notes.append("截图未提供基金代码，可补充六位代码以匹配额度") }
            if channel == .unknown { notes.append("渠道未识别，请选择") }
            plans.append(ParsedPlan(
                fundName: name, fundCode: code, amountMinor: amount,
                frequency: frequency, nextExecutionDate: nextDate(in: block),
                channel: channel, notes: notes
            ))
        }
        return ParseResult(plans: plans, incompleteCount: incomplete, channel: channel)
    }

    private static func isFundTitle(_ line: OCRLine) -> Bool {
        let text = line.text
        return (text.contains("纳斯达克") || text.contains("纳指") || text.contains("标普"))
            && !text.contains("收益") && !text.contains("市场解读")
            && !text.contains("额度")
    }

    private static func cleanedName(_ input: String) -> String {
        input.replacingOccurrences(of: "详情", with: "")
            .replacingOccurrences(of: #"^[\s：:·]*定投\s*"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "：:·")))
    }

    private static func amount(in lines: [OCRLine]) -> Int64? {
        guard let anchor = lines.first(where: { $0.text.contains("买入金额") || $0.text.contains("定投金额") }) else { return nil }
        // Match the amount label's row, never the earlier "累计定投" value.
        let row = lines.filter { abs($0.y - anchor.y) <= 0.012 && $0.x >= anchor.x - 0.01 }
            .sorted { $0.x < $1.x }.map(\.text).joined(separator: " ")
        guard let number = capture(#"([0-9]+(?:\.[0-9]{1,2})?)\s*元"#, in: row) else { return nil }
        return Money.minorUnits(number)
    }

    private static func frequency(in lines: [OCRLine]) -> String? {
        for line in lines {
            if let value = capture(#"定投周期\s*(.+)$"#, in: line.text) { return value }
            if let value = capture(#"((?:每日|每交易日|每周[一二三四五六日天]?|每月[0-9一二三四五六七八九十]*日?))定投"#, in: line.text) {
                return value
            }
            if line.text.trimmingCharacters(in: .whitespaces) == "定投周期",
               let value = lines.first(where: { abs($0.y - line.y) <= 0.012 && $0.x > line.x && $0.text.hasPrefix("每") }) {
                return value.text
            }
        }
        return nil
    }

    private static func nextDate(in lines: [OCRLine]) -> String? {
        guard let anchor = lines.first(where: { $0.text.contains("下次定投") || $0.text.contains("下次扣款") }) else { return nil }
        let row = lines.filter { abs($0.y - anchor.y) <= 0.012 }.map(\.text).joined(separator: " ")
        guard let date = capture(#"([0-9]{4}-[0-9]{2}-[0-9]{2})"#, in: row) else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter.date(from: date) == nil ? nil : date
    }

    private static func capture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}
