import Foundation
import NabaoCore

/// Run with ios/verify-plan-backup.sh. Uses only temporary files, never the app's data directory.
@main
struct PlanStoreBackupChecks {
    @MainActor static func main() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "nabao-backup-check-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appending(path: "plans.json")
        let store = PlanStore(fileURL: file)
        let original = Plan(fundName: "本机计划", fundCode: "021000", channel: .southern,
                            amountMinor: 10_000, frequency: "每日")
        let digest = String(repeating: "a", count: 64)
        try store.save([original], imported: [digest])
        let initial = try Data(contentsOf: file)
        var incoming = original
        incoming.amountMinor = 20_000
        var added = original
        added.id = UUID()
        let backup = try PlanBackupCodec.encode(plans: [incoming, added], importedDigests: [digest])
        let preview = try store.previewRestore(backup)
        try require(store.plans == [original] && Data(contentsOf: file) == initial, "Preview changed stored data")
        let defaultResult = try store.restore(preview)
        try require(defaultResult.addedCount == 1 && defaultResult.keptConflictCount == 1, "Incorrect default merge")
        try require(store.plans == [original, added], "Default conflict overwrote local plan")
        let repeated = try store.previewRestore(backup)
        let repeatedResult = try store.restore(repeated)
        try require(repeatedResult.addedCount == 0 && repeatedResult.identicalCount == 1, "Repeat restore duplicated plans")
        let replace = try store.previewRestore(backup)
        _ = try store.restore(replace, replacing: [original.id])
        try require(store.plans == [incoming, added], "Explicit update not persisted")
        let reloaded = PlanStore(fileURL: file)
        try require(reloaded.plans == store.plans && reloaded.importedDigests == [digest], "Disk round trip changed state")

        let stale = try store.previewRestore(backup)
        var edited = incoming
        edited.frequency = "每周三"
        try store.save([edited])
        let editedBytes = try Data(contentsOf: file)
        try expectFailure { _ = try store.restore(stale, replacing: [original.id]) }
        try require(store.plans == [edited, added] && Data(contentsOf: file) == editedBytes, "Stale preview changed later edits")
        for bad in [Data("invalid json".utf8), Data(#"{"format":"nabao-plan-backup","schemaVersion":99}"#.utf8)] {
            try expectFailure { _ = try store.previewRestore(bad) }
            try require(Data(contentsOf: file) == editedBytes && store.plans == [edited, added], "Invalid input changed existing state")
        }
        var invalid = edited
        invalid.frequency = ""
        try expectFailure { try store.save([invalid]) }
        try require(Data(contentsOf: file) == editedBytes && store.plans == [edited, added], "Invalid new fields changed stored state")

        // Simulate a failed atomic write after a successful preview. In-memory state must stay unchanged.
        let writeFailure = try store.previewRestore(backup)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        let marker = file.appending(path: "preserve-me")
        try Data("original directory".utf8).write(to: marker)
        try expectFailure { _ = try store.restore(writeFailure, replacing: [original.id]) }
        try require(store.plans == [edited, added], "Failed write changed in-memory state")
        try require(Data(contentsOf: marker) == Data("original directory".utf8), "Failed write removed existing file contents")

        let corruptFile = root.appending(path: "corrupt.json")
        let corruptBytes = Data("{corrupt original file".utf8)
        try corruptBytes.write(to: corruptFile)
        let corrupt = PlanStore(fileURL: corruptFile)
        try require(!corrupt.canWrite && corrupt.storageError != nil, "Corrupt storage was writable")
        try expectFailure { try corrupt.save([original]) }
        try expectFailure { _ = try corrupt.exportBackup() }
        try expectFailure { _ = try corrupt.previewRestore(backup) }
        try require(Data(contentsOf: corruptFile) == corruptBytes, "Corrupt original file was overwritten")

        let futureFile = root.appending(path: "future.json")
        let futureBytes = Data(#"{"schemaVersion":2,"plans":[],"importedDigests":[],"futureField":"preserve"}"#.utf8)
        try futureBytes.write(to: futureFile)
        let future = PlanStore(fileURL: futureFile)
        try expectFailure { try future.save([original]) }
        try require(!future.canWrite && Data(contentsOf: futureFile) == futureBytes, "Future storage schema was overwritten")

        // Text accepted by earlier versions must remain editable and exportable.
        let legacyFile = root.appending(path: "legacy.json")
        var legacyPlan = original
        legacyPlan.fundName = String(repeating: "旧名称", count: 100) + "\n第二行"
        legacyPlan.frequency = String(repeating: "旧周期", count: 50) + "\n第二行"
        struct LegacyData: Encodable { let schemaVersion = 1; let plans: [Plan]; let importedDigests: [String] }
        try JSONEncoder().encode(LegacyData(plans: [legacyPlan], importedDigests: [digest])).write(to: legacyFile)
        let legacy = PlanStore(fileURL: legacyFile)
        try require(legacy.canWrite && legacy.plans == [legacyPlan], "Legacy text was rejected while loading")
        let legacyArchive = try PlanBackupCodec.decode(legacy.exportBackup())
        try require(legacyArchive.plans == [legacyPlan], "Legacy text changed on export")
        try legacy.save([added])
        try require(legacy.plans == [legacyPlan, added], "Legacy text blocked adding another plan")
        var changedAdded = added
        changedAdded.amountMinor += 1
        try legacy.save([changedAdded])
        try require(legacy.plans == [legacyPlan, changedAdded], "Legacy text blocked editing another plan")
        let legacyRoundTrip = try legacy.previewRestore(legacy.exportBackup())
        let legacyResult = try legacy.restore(legacyRoundTrip)
        try require(legacyResult.identicalCount == 2 && legacyResult.addedCount == 0, "Legacy restore was not idempotent")
        print("PlanStore backup checks passed: preview, default/explicit conflict, repeat restore, reload, stale preview, invalid input, failed write, corrupt/future file protection.")
    }

    private static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw Failure(message: message) }
    }

    private static func expectFailure(_ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw Failure(message: "Expected an operation to fail")
    }

    private struct Failure: Error { let message: String }
}
