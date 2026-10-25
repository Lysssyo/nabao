import Foundation

public enum PlanBackupError: LocalizedError, Equatable {
    case invalidFile, unsupportedVersion, tooLarge, tooManyPlans, tooManyDigests
    case invalidPlan, duplicatePlanID, invalidDigest, stalePreview, invalidSelection

    public var errorDescription: String? {
        switch self {
        case .invalidFile: return "文件不是有效的 nabao 计划备份，现有记录未改变。"
        case .unsupportedVersion: return "此备份版本尚不支持，请使用更新版本的 nabao。"
        case .tooLarge: return "备份文件超过 5 MB，未读取或恢复。"
        case .tooManyPlans: return "备份最多支持 5,000 条计划，未恢复。"
        case .tooManyDigests: return "备份中的图片指纹数量超出上限，未恢复。"
        case .invalidPlan: return "备份包含无效的计划字段，现有记录未改变。"
        case .duplicatePlanID: return "备份中同一记录出现多次，无法确认应恢复哪条内容。"
        case .invalidDigest: return "备份中的图片指纹格式无效，现有记录未改变。"
        case .stalePreview: return "本机记录在预览后已改变，请返回并重新选择备份文件。"
        case .invalidSelection: return "冲突选择已失效，请重新预览备份。"
        }
    }
}

public struct PlanBackupArchive: Codable, Equatable, Sendable {
    public let format: String
    public let schemaVersion: Int
    public let exportedAt: Date
    public let plans: [Plan]
    public let importedDigests: [String]

    public init(plans: [Plan], importedDigests: Set<String>, exportedAt: Date = Date()) {
        format = "nabao-plan-backup"
        schemaVersion = 1
        self.exportedAt = exportedAt
        self.plans = plans
        self.importedDigests = importedDigests.sorted()
    }
}

public enum PlanBackupCodec {
    public static let maximumBytes = 5 * 1_024 * 1_024
    public static let maximumPlans = 5_000
    public static let maximumDigests = 10_000

    public static func encode(plans: [Plan], importedDigests: Set<String>, exportedAt: Date = Date()) throws -> Data {
        let archive = PlanBackupArchive(plans: plans, importedDigests: importedDigests, exportedAt: exportedAt)
        try validate(archive)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        // Keep Foundation's exact numeric Date representation, as in plans.json.
        // Formatting timestamps to whole seconds would create false conflicts on restore.
        let data = try encoder.encode(archive)
        guard data.count <= maximumBytes else { throw PlanBackupError.tooLarge }
        return data
    }

    public static func decode(_ data: Data) throws -> PlanBackupArchive {
        guard data.count <= maximumBytes else { throw PlanBackupError.tooLarge }
        struct Header: Decodable { let format: String; let schemaVersion: Int }
        do {
            let header = try JSONDecoder().decode(Header.self, from: data)
            guard header.format == "nabao-plan-backup" else { throw PlanBackupError.invalidFile }
            guard header.schemaVersion == 1 else { throw PlanBackupError.unsupportedVersion }
            let archive = try JSONDecoder().decode(PlanBackupArchive.self, from: data)
            try validate(archive)
            return archive
        } catch let error as PlanBackupError { throw error }
        catch { throw PlanBackupError.invalidFile }
    }

    public static func validateState(plans: [Plan], importedDigests: Set<String>) throws {
        guard plans.count <= maximumPlans else { throw PlanBackupError.tooManyPlans }
        guard importedDigests.count <= maximumDigests else { throw PlanBackupError.tooManyDigests }
        guard Set(plans.map(\.id)).count == plans.count else { throw PlanBackupError.duplicatePlanID }
        for plan in plans {
            guard planValidationMessage(plan) == nil else { throw PlanBackupError.invalidPlan }
        }
        guard importedDigests.allSatisfy({ $0.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil })
        else { throw PlanBackupError.invalidDigest }
    }

    public static func validate(_ archive: PlanBackupArchive) throws {
        guard archive.format == "nabao-plan-backup" else { throw PlanBackupError.invalidFile }
        guard archive.schemaVersion == 1 else { throw PlanBackupError.unsupportedVersion }
        guard validTimestamp(archive.exportedAt) else { throw PlanBackupError.invalidFile }
        guard archive.importedDigests.count <= maximumDigests else { throw PlanBackupError.tooManyDigests }
        try validateState(plans: archive.plans, importedDigests: Set(archive.importedDigests))
    }

    /// Shared by manual entry and backup validation so every newly saved plan can be exported.
    public static func planValidationMessage(_ plan: Plan) -> String? {
        if !validText(plan.fundName) { return "请填写基金名称。" }
        if plan.amountMinor <= 0 { return "请填写大于零的有效金额，最多两位小数。" }
        if !validText(plan.frequency) { return "请填写执行周期。" }
        if plan.channel == .unknown { return "请选择计划所属渠道。" }
        if let code = plan.fundCode, code.range(of: #"^[0-9]{6}$"#, options: .regularExpression) == nil {
            return "基金代码须为 6 位数字，或留空。"
        }
        if let date = plan.nextExecutionDate, !validDate(date) { return "下次执行日期须为有效的 YYYY-MM-DD 日期，或留空。" }
        if !validTimestamp(plan.confirmedAt) { return "计划确认时间无效。" }
        return nil
    }

    private static func validText(_ value: String) -> Bool {
        // Earlier app versions allowed multiline and arbitrarily long text.
        // Preserve that content verbatim; the whole-file byte limit bounds backup size.
        !value.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func validTimestamp(_ value: Date) -> Bool {
        let time = value.timeIntervalSince1970
        return time.isFinite && time >= 0 && time < 253_402_300_800
    }

    private static func validDate(_ value: String) -> Bool {
        guard value.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil else { return false }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...9999).contains(parts[0]) else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard let date = calendar.date(from: components) else { return false }
        let checked = calendar.dateComponents([.year, .month, .day], from: date)
        return checked.year == parts[0] && checked.month == parts[1] && checked.day == parts[2]
    }
}

public struct PlanBackupEntry: Identifiable, Sendable {
    public enum Kind: Sendable { case added, identical, conflict }
    public var id: UUID { incoming.id }
    public let incoming: Plan
    public let existing: Plan?
    public let kind: Kind
}

public struct PlanBackupPreview: Identifiable, Sendable {
    public let id = UUID()
    public let archive: PlanBackupArchive
    public let entries: [PlanBackupEntry]
    fileprivate let originalPlans: [Plan]
    fileprivate let originalDigests: Set<String>
    public var addedCount: Int { entries.filter { $0.kind == .added }.count }
    public var identicalCount: Int { entries.filter { $0.kind == .identical }.count }
    public var conflicts: [PlanBackupEntry] { entries.filter { $0.kind == .conflict } }
}

public struct PlanBackupMergeResult: Sendable {
    public let plans: [Plan]
    public let importedDigests: Set<String>
    public let addedCount: Int
    public let updatedCount: Int
    public let identicalCount: Int
    public let keptConflictCount: Int
}

public enum PlanBackupMerger {
    public static func preview(_ archive: PlanBackupArchive, plans: [Plan], importedDigests: Set<String>) throws -> PlanBackupPreview {
        try PlanBackupCodec.validate(archive)
        try PlanBackupCodec.validateState(plans: plans, importedDigests: importedDigests)
        let existing = Dictionary(uniqueKeysWithValues: plans.map { ($0.id, $0) })
        let entries = archive.plans.map { incoming in
            let current = existing[incoming.id]
            return PlanBackupEntry(incoming: incoming, existing: current,
                kind: current == nil ? .added : current == incoming ? .identical : .conflict)
        }
        return PlanBackupPreview(archive: archive, entries: entries, originalPlans: plans, originalDigests: importedDigests)
    }

    public static func merge(_ preview: PlanBackupPreview, plans: [Plan], importedDigests: Set<String>,
                             replacing conflictIDs: Set<UUID> = []) throws -> PlanBackupMergeResult {
        guard plans == preview.originalPlans && importedDigests == preview.originalDigests else { throw PlanBackupError.stalePreview }
        guard conflictIDs.isSubset(of: Set(preview.conflicts.map(\.id))) else { throw PlanBackupError.invalidSelection }
        var merged = plans
        for entry in preview.entries {
            if entry.kind == .added { merged.append(entry.incoming) }
            else if entry.kind == .conflict && conflictIDs.contains(entry.id),
                    let index = merged.firstIndex(where: { $0.id == entry.id }) { merged[index] = entry.incoming }
        }
        let digests = importedDigests.union(preview.archive.importedDigests)
        try PlanBackupCodec.validateState(plans: merged, importedDigests: digests)
        return PlanBackupMergeResult(plans: merged, importedDigests: digests, addedCount: preview.addedCount,
            updatedCount: conflictIDs.count, identicalCount: preview.identicalCount,
            keptConflictCount: preview.conflicts.count - conflictIDs.count)
    }
}
