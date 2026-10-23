import Foundation

/// The app consumes a published table; collection and reconciliation remain server-side.
public struct DailyFundTable: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let dataDate: String
    public let updatedAt: String
    public let source: Source
    public let rows: [Row]
    public let notes: [String]?

    public struct Source: Codable, Equatable, Sendable {
        public let name: String
        public let url: String
        public let publishedAt: String?
    }

    public struct Row: Codable, Equatable, Identifiable, Sendable {
        public var id: String { fundCode }
        public let fundCode: String
        public let fundName: String
        public let feeRate: String?
        public let distributorLimit: String
        public let directLimit: String
        public let trackingError: String?
        public let return1y: String?

        public func matches(_ query: String) -> Bool {
            let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
            return query.isEmpty || fundCode.localizedCaseInsensitiveContains(query)
                || fundName.localizedCaseInsensitiveContains(query)
        }

        /// A qualified limit such as "100*部分渠道" is deliberately not treated
        /// as a generally available amount. The original string remains visible.
        public var hasPositiveLimit: Bool {
            [distributorLimit, directLimit].contains {
                if case let .amount(amount) = TableLimit($0) { return amount > 0 }
                return false
            }
        }

        public func isInPlans(_ plans: [Plan]) -> Bool {
            plans.contains { $0.fundCode == fundCode }
        }

        public var shortName: String {
            fundName.replacingOccurrences(of: "纳斯达克100", with: "纳指100")
                .replacingOccurrences(of: "指数发起式", with: "")
                .replacingOccurrences(of: "指数发起", with: "")
                .replacingOccurrences(of: "指数", with: "")
                .replacingOccurrences(of: "(QDII)", with: "")
                .replacingOccurrences(of: "（QDII）", with: "")
        }
    }

    public static func decode(_ data: Data) throws -> DailyFundTable {
        let table = try JSONDecoder().decode(DailyFundTable.self, from: data)
        guard table.schemaVersion == 1 else { throw DailyTableError.unsupportedVersion }
        let formatter = dateFormatter()
        guard let date = formatter.date(from: table.dataDate),
              formatter.string(from: date) == table.dataDate else { throw DailyTableError.invalidData }
        guard Set(table.rows.map(\.fundCode)).count == table.rows.count,
              table.rows.allSatisfy({
                  $0.fundCode.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil
                      && !$0.fundName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              }) else { throw DailyTableError.invalidData }
        if let notes = table.notes {
            // Match the file/API contract, including Java/JavaScript UTF-16 lengths.
            guard notes.count <= 30, notes.allSatisfy({ note in
                !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && note.utf16.count <= 2_000
                    && !note.contains("<") && !note.contains(">")
                    && !note.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
            }) else { throw DailyTableError.invalidData }
        }
        return table
    }

    public func isCurrent(on date: Date = Date()) -> Bool {
        dataDate == Self.dateFormatter().string(from: date)
    }

    public static func display(_ value: String?) -> String {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "待更新" }
        return value
    }

    /// Unknown, missing, annotated and partial-channel values are not amount
    /// changes. Neither a date change nor a performance change reaches this path.
    public static func limitChange(from previous: String?, to current: String) -> String? {
        guard let previous, let before = TableLimit(previous), let after = TableLimit(current),
              before != after else { return nil }
        return "\(before.label) → \(after.label)"
    }

    private static func dateFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter
    }
}

private enum TableLimit: Equatable {
    case amount(Int64), paused

    init?(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text == "暂停" || text == "暂停申购" { self = .paused; return }
        let number = text.hasSuffix("元") ? String(text.dropLast()) : text
        guard let amount = Money.minorUnits(number) else { return nil }
        self = .amount(amount)
    }

    var label: String {
        switch self {
        case .paused: return "暂停"
        case let .amount(amount):
            if amount.isMultiple(of: 100) { return String(amount / 100) }
            if amount.isMultiple(of: 10) { return String(format: "%.1f", Double(amount) / 100) }
            return Money.text(amount)
        }
    }
}

public enum DailyTableError: LocalizedError {
    case unsupportedVersion, invalidData, emptyTable
    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion: return "额度表版本暂不支持，请更新 App。"
        case .invalidData: return "额度表格式不完整，请稍后重试。"
        case .emptyTable: return "服务端尚未发布可用额度表。"
        }
    }
}

/// Two small public snapshots keep amount-change labels across launches. Date or
/// performance-only refreshes retain the comparison instead of erasing a change.
public struct DailyTableCache {
    private let fileURL: URL
    private struct Saved: Codable {
        let backend: String
        let table: DailyFundTable
        let comparisonTable: DailyFundTable?
    }

    public struct Snapshot: Equatable, Sendable {
        public let table: DailyFundTable
        public let comparisonTable: DailyFundTable?
    }

    public init(fileURL: URL) { self.fileURL = fileURL }

    public func load(backend: String) throws -> DailyFundTable? {
        try loadSnapshot(backend: backend)?.table
    }

    public func loadSnapshot(backend: String) throws -> Snapshot? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let saved = try JSONDecoder().decode(Saved.self, from: Data(contentsOf: fileURL))
        guard saved.backend == backend else { return nil }
        let table = try DailyFundTable.decode(JSONEncoder().encode(saved.table))
        let previous = try saved.comparisonTable.map { try DailyFundTable.decode(JSONEncoder().encode($0)) }
        return Snapshot(table: table, comparisonTable: previous)
    }

    @discardableResult public func save(_ table: DailyFundTable, backend: String) throws -> Snapshot {
        // Empty or malformed refreshes must never replace the last useful table.
        guard !table.rows.isEmpty else { throw DailyTableError.emptyTable }
        _ = try DailyFundTable.decode(JSONEncoder().encode(table))
        let prior = try? loadSnapshot(backend: backend)
        let comparison: DailyFundTable?
        if let prior {
            let before = Dictionary(uniqueKeysWithValues: prior.table.rows.map { ($0.fundCode, [$0.distributorLimit, $0.directLimit]) })
            let after = Dictionary(uniqueKeysWithValues: table.rows.map { ($0.fundCode, [$0.distributorLimit, $0.directLimit]) })
            comparison = before == after ? prior.comparisonTable : prior.table
        } else {
            comparison = nil
        }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(Saved(backend: backend, table: table, comparisonTable: comparison)).write(to: fileURL, options: .atomic)
        return Snapshot(table: table, comparisonTable: comparison)
    }
}
