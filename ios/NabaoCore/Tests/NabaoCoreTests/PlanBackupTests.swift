import XCTest
@testable import NabaoCore

final class PlanBackupTests: XCTestCase {
    private let digestA = String(repeating: "a", count: 64)
    private let digestB = String(repeating: "b", count: 64)
    private let timestamp = Date(timeIntervalSince1970: 1_792_800_000.123456)

    private func plan(id: UUID = UUID(), amount: Int64 = 12_345) -> Plan {
        Plan(id: id, fundName: "南方纳斯达克100指数发起(QDII)I", fundCode: "021000",
             channel: .southern, amountMinor: amount, frequency: "每周三",
             nextExecutionDate: "2026-10-28", status: .paused, confirmedAt: timestamp)
    }

    func testRoundTripPreservesEveryPlanFieldAndFractionalTimeWithoutPrivatePayloads() throws {
        let original = plan()
        let data = try PlanBackupCodec.encode(plans: [original], importedDigests: [digestB, digestA], exportedAt: timestamp)
        let decoded = try PlanBackupCodec.decode(data)
        XCTAssertEqual(decoded.plans, [original])
        XCTAssertEqual(decoded.exportedAt, timestamp)
        XCTAssertEqual(decoded.importedDigests, [digestA, digestB])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["format", "schemaVersion", "exportedAt", "plans", "importedDigests"])
        let fields = try XCTUnwrap((object["plans"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(fields.keys), ["id", "fundName", "fundCode", "channel", "amountMinor", "frequency", "nextExecutionDate", "status", "confirmedAt"])
    }

    func testDefaultKeepsConflictAndExplicitChoiceReplacesOnlySelectedID() throws {
        let first = plan()
        let second = plan()
        let unchanged = plan()
        let incomingFirst = plan(id: first.id, amount: 50_000)
        let incomingSecond = plan(id: second.id, amount: 60_000)
        let archive = PlanBackupArchive(plans: [incomingFirst, incomingSecond, unchanged], importedDigests: [digestB])
        let current = [first, second, unchanged]
        let preview = try PlanBackupMerger.preview(archive, plans: current, importedDigests: [digestA])
        XCTAssertEqual(preview.addedCount, 0)
        XCTAssertEqual(preview.identicalCount, 1)
        XCTAssertEqual(preview.conflicts.count, 2)
        let kept = try PlanBackupMerger.merge(preview, plans: current, importedDigests: [digestA])
        XCTAssertEqual(kept.plans, current)
        XCTAssertEqual(kept.updatedCount, 0)
        XCTAssertEqual(kept.keptConflictCount, 2)
        let updated = try PlanBackupMerger.merge(preview, plans: current, importedDigests: [digestA], replacing: [first.id])
        XCTAssertEqual(updated.plans, [incomingFirst, second, unchanged])
        XCTAssertEqual(updated.updatedCount, 1)
        XCTAssertEqual(updated.keptConflictCount, 1)
        XCTAssertEqual(updated.identicalCount, 1)
        XCTAssertEqual(updated.importedDigests, [digestA, digestB])
        XCTAssertEqual(current, [first, second, unchanged])
    }

    func testLegacyLongMultilineTextRoundTripsWithoutNormalizationOrFalseConflict() throws {
        var original = plan()
        original.fundName = String(repeating: "旧版允许的名称", count: 50) + "\n原第二行"
        original.frequency = String(repeating: "每周三", count: 50) + "\n特殊安排"
        let data = try PlanBackupCodec.encode(plans: [original], importedDigests: [digestA])
        let archive = try PlanBackupCodec.decode(data)
        XCTAssertEqual(archive.plans, [original])
        let preview = try PlanBackupMerger.preview(archive, plans: [original], importedDigests: [digestA])
        XCTAssertEqual(preview.identicalCount, 1)
        XCTAssertTrue(preview.conflicts.isEmpty)
    }

    func testDifferentIDsWithSameFundAndAmountAreSeparateAndRepeatRestoreIsIdempotent() throws {
        let existing = plan()
        let incoming = plan()
        let archive = PlanBackupArchive(plans: [existing, incoming], importedDigests: [digestA])
        let preview = try PlanBackupMerger.preview(archive, plans: [existing], importedDigests: [])
        XCTAssertEqual(preview.addedCount, 1)
        XCTAssertEqual(preview.identicalCount, 1)
        XCTAssertTrue(preview.conflicts.isEmpty)
        let once = try PlanBackupMerger.merge(preview, plans: [existing], importedDigests: [])
        XCTAssertEqual(once.plans, [existing, incoming])
        let again = try PlanBackupMerger.preview(archive, plans: once.plans, importedDigests: once.importedDigests)
        let twice = try PlanBackupMerger.merge(again, plans: once.plans, importedDigests: once.importedDigests)
        XCTAssertEqual(twice.plans, once.plans)
        XCTAssertEqual(twice.importedDigests, once.importedDigests)
        XCTAssertEqual(twice.addedCount, 0)
        XCTAssertEqual(twice.identicalCount, 2)
    }

    func testStalePreviewCannotOverwriteEditsDeletionsNewPlansOrDigestChanges() throws {
        let current = plan()
        let archive = PlanBackupArchive(plans: [plan(id: current.id, amount: 200)], importedDigests: [])
        let preview = try PlanBackupMerger.preview(archive, plans: [current], importedDigests: [])
        for changed in [[plan(id: current.id, amount: 300)], [], [current, plan()]] {
            assertError(.stalePreview) {
                _ = try PlanBackupMerger.merge(preview, plans: changed, importedDigests: [], replacing: [current.id])
            }
        }
        assertError(.stalePreview) {
            _ = try PlanBackupMerger.merge(preview, plans: [current], importedDigests: [digestA])
        }
        assertError(.invalidSelection) {
            _ = try PlanBackupMerger.merge(preview, plans: [current], importedDigests: [], replacing: [UUID()])
        }
    }

    func testCorruptMissingWrongTypeAndUnknownEnumDataAreRejected() throws {
        assertError(.invalidFile) { _ = try PlanBackupCodec.decode(Data("not json".utf8)) }
        assertError(.invalidFile) { _ = try PlanBackupCodec.decode(Data("{}".utf8)) }
        let valid = try PlanBackupCodec.encode(plans: [plan()], importedDigests: [])
        for field in ["plans", "importedDigests", "exportedAt"] {
            let data = try mutate(valid) { $0.removeValue(forKey: field) }
            assertError(.invalidFile) { _ = try PlanBackupCodec.decode(data) }
        }
        for (field, value) in [("channel", "future-channel"), ("status", "future-status"), ("amountMinor", "123")] {
            let data = try mutatePlan(valid) { $0[field] = value }
            assertError(.invalidFile) { _ = try PlanBackupCodec.decode(data) }
        }
        assertError(.invalidFile) { _ = try PlanBackupCodec.decode(try mutatePlan(valid) { $0.removeValue(forKey: "id") }) }
    }

    func testFutureVersionIsRejectedEvenBeforeItsUnknownBodyIsDecoded() {
        let future = Data(#"{"format":"nabao-plan-backup","schemaVersion":2,"futurePlans":[]}"#.utf8)
        assertError(.unsupportedVersion) { _ = try PlanBackupCodec.decode(future) }
        let wrongFormat = Data(#"{"format":"other-app","schemaVersion":1}"#.utf8)
        assertError(.invalidFile) { _ = try PlanBackupCodec.decode(wrongFormat) }
    }

    func testSizeCountAndDuplicateIDLimits() throws {
        assertError(.tooLarge) { _ = try PlanBackupCodec.decode(Data(repeating: 32, count: PlanBackupCodec.maximumBytes + 1)) }
        let record = plan()
        assertError(.duplicatePlanID) { _ = try PlanBackupCodec.encode(plans: [record, record], importedDigests: []) }
        assertError(.tooManyPlans) {
            _ = try PlanBackupCodec.encode(plans: Array(repeating: record, count: PlanBackupCodec.maximumPlans + 1), importedDigests: [])
        }
        let valid = try PlanBackupCodec.encode(plans: [], importedDigests: [])
        let tooMany = try mutate(valid) { $0["importedDigests"] = Array(repeating: digestA, count: PlanBackupCodec.maximumDigests + 1) }
        assertError(.tooManyDigests) { _ = try PlanBackupCodec.decode(tooMany) }
        let duplicateID = try mutate(valid) { object in
            let encoded = try! JSONEncoder().encode([record, record])
            object["plans"] = try! JSONSerialization.jsonObject(with: encoded)
        }
        assertError(.duplicatePlanID) { _ = try PlanBackupCodec.decode(duplicateID) }
    }

    func testInvalidPlanFieldsAndDigestCannotEnterRestore() throws {
        let original = plan()
        let alterations: [(inout Plan) -> Void] = [
            { $0.fundName = "  " }, { $0.frequency = "" },
            { $0.amountMinor = 0 }, { $0.amountMinor = -1 }, { $0.channel = .unknown },
            { $0.fundCode = "12345" }, { $0.fundCode = "１２３４５６" },
            { $0.nextExecutionDate = "2026-02-29" }, { $0.nextExecutionDate = "2026-13-01" },
            { $0.nextExecutionDate = "0000-01-01" }, { $0.nextExecutionDate = "2026-2-01" },
            { $0.confirmedAt = Date(timeIntervalSince1970: -1) }
        ]
        for alter in alterations {
            var changed = original
            alter(&changed)
            XCTAssertNotNil(PlanBackupCodec.planValidationMessage(changed))
            // Encode directly to exercise the untrusted file decoder, bypassing encode's validator.
            let raw = try JSONEncoder().encode(PlanBackupArchive(plans: [changed], importedDigests: []))
            assertError(.invalidPlan) { _ = try PlanBackupCodec.decode(raw) }
        }
        for digest in ["", "image.jpeg", String(repeating: "A", count: 64), String(repeating: "g", count: 64)] {
            assertError(.invalidDigest) { _ = try PlanBackupCodec.encode(plans: [original], importedDigests: [digest]) }
        }
        var valid = original
        valid.nextExecutionDate = "2028-02-29"
        valid.status = .unknown
        XCTAssertNoThrow(try PlanBackupCodec.encode(plans: [valid], importedDigests: [digestA]))
    }

    func testCombinedCountFailureLeavesExistingStateUnchanged() throws {
        let current = (0..<PlanBackupCodec.maximumPlans).map { _ in plan() }
        let untouched = current
        let archive = PlanBackupArchive(plans: [plan()], importedDigests: [digestB])
        let preview = try PlanBackupMerger.preview(archive, plans: current, importedDigests: [digestA])
        assertError(.tooManyPlans) {
            _ = try PlanBackupMerger.merge(preview, plans: current, importedDigests: [digestA])
        }
        XCTAssertEqual(current, untouched)
    }

    private func assertError(_ expected: PlanBackupError, file: StaticString = #filePath, line: UInt = #line,
                             _ operation: () throws -> Void) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? PlanBackupError, expected, file: file, line: line)
        }
    }

    private func mutate(_ data: Data, _ edit: (inout [String: Any]) -> Void) throws -> Data {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        edit(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func mutatePlan(_ data: Data, _ edit: (inout [String: Any]) -> Void) throws -> Data {
        try mutate(data) { object in
            var records = object["plans"] as! [[String: Any]]
            edit(&records[0])
            object["plans"] = records
        }
    }
}
