import Foundation
import Combine
import NabaoCore

@MainActor
final class PlanStore: ObservableObject {
    @Published private(set) var plans: [Plan] = []
    @Published private(set) var importedDigests: Set<String> = []
    @Published private(set) var storageError: String?
    private let fileURL: URL
    private var writable = true

    private struct SavedData: Codable {
        var schemaVersion = 1
        var plans: [Plan]
        var importedDigests: Set<String>
    }

    init() {
        fileURL = URL.applicationSupportDirectory
            .appending(path: "nabao", directoryHint: .isDirectory)
            .appending(path: "plans.json")
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let saved = try JSONDecoder().decode(SavedData.self, from: Data(contentsOf: fileURL))
            guard saved.schemaVersion == 1 else { throw StorageError.unsupportedVersion }
            plans = saved.plans
            importedDigests = saved.importedDigests
        } catch {
            storageError = "本地记录读取失败，已保留原文件。请先备份并排查：\(error.localizedDescription)"
            writable = false
        }
    }

    func save(_ records: [Plan], imported images: Set<String> = []) throws {
        var next = plans
        for record in records {
            if let index = next.firstIndex(where: { $0.id == record.id }) {
                next[index] = record
            } else {
                next.append(record)
            }
        }
        try persist(next, digests: importedDigests.union(images))
    }

    func remove(_ plan: Plan) throws {
        try persist(plans.filter { $0.id != plan.id }, digests: importedDigests)
    }

    private func persist(_ next: [Plan], digests: Set<String>) throws {
        guard writable else { throw StorageError.unreadable }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(SavedData(plans: next, importedDigests: digests))
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        plans = next
        importedDigests = digests
    }

    private enum StorageError: LocalizedError {
        case unreadable, unsupportedVersion
        var errorDescription: String? {
            switch self {
            case .unreadable: return "原记录无法读取，已阻止覆盖。"
            case .unsupportedVersion: return "本地数据版本尚不支持。"
            }
        }
    }
}

struct PlanDraft: Identifiable {
    var id = UUID()
    var fundName = ""
    var fundCode = ""
    var channel: Channel = .unknown
    var amount = ""
    var frequency = "每日"
    var nextDate = ""
    var status: PlanStatus = .active
    var notes: [String] = []
    var imageDigest: String?
    var selected = true

    init() {}

    init(plan: Plan) {
        id = plan.id
        fundName = plan.fundName
        fundCode = plan.fundCode ?? ""
        channel = plan.channel
        amount = Money.text(plan.amountMinor)
        frequency = plan.frequency
        nextDate = plan.nextExecutionDate ?? ""
        status = plan.status
    }

    init(parsed: ParsedPlan, digest: String) {
        fundName = parsed.fundName
        fundCode = parsed.fundCode ?? ""
        channel = parsed.channel
        amount = Money.text(parsed.amountMinor)
        frequency = parsed.frequency
        nextDate = parsed.nextExecutionDate ?? ""
        notes = parsed.notes
        imageDigest = digest
    }

    var isValid: Bool {
        !fundName.trimmingCharacters(in: .whitespaces).isEmpty
            && (Money.minorUnits(amount) ?? 0) > 0
            && !frequency.trimmingCharacters(in: .whitespaces).isEmpty
            && channel != .unknown
            && (fundCode.isEmpty || fundCode.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil)
            && validDate
    }

    private var validDate: Bool {
        guard !nextDate.isEmpty else { return true }
        guard nextDate.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil else { return false }
        let format = DateFormatter()
        format.calendar = Calendar(identifier: .gregorian)
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd"
        format.isLenient = false
        return format.date(from: nextDate) != nil
    }

    func plan() -> Plan {
        Plan(id: id, fundName: fundName.trimmingCharacters(in: .whitespaces),
             fundCode: fundCode.isEmpty ? nil : fundCode, channel: channel,
             amountMinor: Money.minorUnits(amount) ?? 0,
             frequency: frequency, nextExecutionDate: nextDate.isEmpty ? nil : nextDate,
             status: status, confirmedAt: Date())
    }
}
