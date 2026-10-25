import Foundation

/// Display order only. Original strings, availability filters and vote results stay unchanged.
/// The public web client uses the same buckets, money grammar and safe-integer cents bound.
public enum DailyTableOrdering {
    public static func distributorDescending(_ rows: [DailyFundTable.Row]) -> [DailyFundTable.Row] {
        rows.enumerated().map { (index: $0.offset, row: $0.element, key: key($0.element.distributorLimit)) }
            .sorted {
                if $0.key.bucket != $1.key.bucket { return $0.key.bucket < $1.key.bucket }
                if $0.key.amount != $1.key.amount { return ($0.key.amount ?? -1) > ($1.key.amount ?? -1) }
                return $0.index < $1.index
            }.map(\.row)
    }

    struct Key: Equatable {
        let bucket: Int
        let amount: Int64?
    }

    static func key(_ raw: String) -> Key {
        let text = raw.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "，", with: ",").replacingOccurrences(of: "．", with: ".")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if ["不限额", "不限", "无限额"].contains(text) { return Key(bucket: 0, amount: nil) }
        if let amount = amount(text) { return Key(bucket: amount > 0 ? 1 : 3, amount: amount > 0 ? amount : nil) }
        if ["暂停", "暂停申购"].contains(text) { return Key(bucket: 3, amount: nil) }
        if ["无", "无代销", "未销售", "不可用"].contains(text) { return Key(bucket: 4, amount: nil) }
        if ["", "待更新", "未知", "—", "-"].contains(text) { return Key(bucket: 5, amount: nil) }

        let ambiguous = #"美元|美金|港元|港币|USD|HKD|\$|[%％]|合并|共享|共用|合计|总计|累计|分别|代码|[→⇒~～至]|->|[-–—]"#
        guard text.range(of: ambiguous, options: [.regularExpression, .caseInsensitive]) == nil else {
            return Key(bucket: 2, amount: nil)
        }
        let matches = numbers.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard matches.count == 1, let range = Range(matches[0].range, in: text) else { return Key(bucket: 2, amount: nil) }
        // Do not turn malformed decimals such as .5 or 100. into another amount.
        let before = text[..<range.lowerBound].last
        let after = text[range.upperBound...].first
        guard before != ".", before != ",", after != ".", after != "," else { return Key(bucket: 2, amount: nil) }
        let tail = String(text[range.upperBound...])
        let unit = tail.range(of: #"^\s*(?:千|万)?\s*元?"#, options: .regularExpression).map { String(tail[$0]) } ?? ""
        return Key(bucket: 2, amount: amount(String(text[range]) + unit))
    }

    private static let money = try! NSRegularExpression(pattern:
        #"^(?:人民币\s*|[¥￥]\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*(千|万)?\s*元?(?:\s*[/／]\s*(?:日|天))?$"#)
    private static let numbers = try! NSRegularExpression(pattern: #"[0-9]+(?:[,.][0-9]+)*"#)
    private static let maximumCents: Int64 = 9_007_199_254_740_991

    private static func amount(_ text: String) -> Int64? {
        guard let match = money.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let numberRange = Range(match.range(at: 1), in: text) else { return nil }
        let parts = text[numberRange].replacingOccurrences(of: ",", with: "").split(separator: ".")
        guard let whole = Int64(parts[0]), whole <= maximumCents / 100 else { return nil }
        let fraction = parts.count == 2 ? Int64(String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0))! : 0
        let cents = whole * 100 + fraction
        let unit = Range(match.range(at: 2), in: text).map { String(text[$0]) }
        let multiplier: Int64 = unit == "万" ? 10_000 : unit == "千" ? 1_000 : 1
        guard cents <= maximumCents / multiplier else { return nil }
        return cents * multiplier
    }
}
