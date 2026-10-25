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
    var canWrite: Bool { writable }

    private struct SavedData: Codable {
        var schemaVersion = 1
        var plans: [Plan]
        var importedDigests: Set<String>
    }

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? URL.applicationSupportDirectory
            .appending(path: "nabao", directoryHint: .isDirectory)
            .appending(path: "plans.json")
        guard FileManager.default.fileExists(atPath: self.fileURL.path) else { return }
        do {
            let saved = try JSONDecoder().decode(SavedData.self, from: Data(contentsOf: self.fileURL))
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

    func exportBackup() throws -> Data {
        guard writable else { throw StorageError.unreadable }
        return try PlanBackupCodec.encode(plans: plans, importedDigests: importedDigests)
    }

    func previewRestore(_ data: Data) throws -> PlanBackupPreview {
        guard writable else { throw StorageError.unreadable }
        return try PlanBackupMerger.preview(PlanBackupCodec.decode(data), plans: plans, importedDigests: importedDigests)
    }

    func restore(_ preview: PlanBackupPreview, replacing conflictIDs: Set<UUID> = []) throws -> PlanBackupMergeResult {
        guard writable else { throw StorageError.unreadable }
        let result = try PlanBackupMerger.merge(preview, plans: plans, importedDigests: importedDigests, replacing: conflictIDs)
        try persist(result.plans, digests: result.importedDigests)
        return result
    }

    private func persist(_ next: [Plan], digests: Set<String>) throws {
        guard writable else { throw StorageError.unreadable }
        // Validate before touching the file; newly saved state must also be exportable.
        _ = try PlanBackupCodec.encode(plans: next, importedDigests: digests)
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
