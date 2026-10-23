import XCTest
@testable import NabaoCore

final class DailyFundTableTests: XCTestCase {
    func testOptionalFootnotesAndMarkedValuesArePreserved() throws {
        XCTAssertNil(try decode().notes)
        let notes = ["收益截至2026-10-19", "* 公告上限", "† 万家合并限额/渠道状态差异", "‡ 收益来源分歧"]
        let table = try decode(overrides: ["notes": notes], rowOverrides: [
            "distributorLimit": "10†", "directLimit": "100*", "return1y": "12.69%‡"
        ])
        XCTAssertEqual(table.notes, notes)
        XCTAssertEqual(table.rows[0].distributorLimit, "10†")
        XCTAssertEqual(table.rows[0].directLimit, "100*")
        XCTAssertEqual(table.rows[0].return1y, "12.69%‡")
        XCTAssertEqual(try DailyFundTable.decode(JSONEncoder().encode(table)), table)
    }

    func testDecodesPublishedTableWithoutAnalysisFields() throws {
        let table = try decode()
        XCTAssertEqual(table.dataDate, "2026-10-21")
        XCTAssertEqual(table.rows[0].fundCode, "019441")
        XCTAssertEqual(table.rows[0].distributorLimit, "5")
        XCTAssertEqual(table.rows[0].directLimit, "100")
        XCTAssertEqual(table.rows[0].feeRate, "0.65%")
        XCTAssertEqual(table.rows[0].return1y, "16.00%")
    }

    func testNotesMatchThirtyByTwoThousandCharacterContract() throws {
        let maximum = Array(repeating: String(repeating: "注", count: 2_000), count: 30)
        XCTAssertEqual(try decode(overrides: ["notes": maximum]).notes, maximum)
        XCTAssertThrowsError(try decode(overrides: ["notes": maximum + ["额外说明"]]))
        XCTAssertThrowsError(try decode(overrides: ["notes": [String(repeating: "注", count: 2_001)]]))
        XCTAssertNoThrow(try decode(overrides: ["notes": [String(repeating: "😀", count: 1_000)]]))
        XCTAssertThrowsError(try decode(overrides: ["notes": [String(repeating: "😀", count: 1_001)]]))
        for invalid in [" ", "两行\n说明", "<说明>"] {
            XCTAssertThrowsError(try decode(overrides: ["notes": [invalid]]))
        }
    }

    func testMissingValuesAndSpecialLimitsRemainDistinct() throws {
        let table = try decode(rowOverrides: ["feeRate": NSNull(), "trackingError": NSNull(),
                                             "return1y": NSNull(), "distributorLimit": "无", "directLimit": "暂停"])
        XCTAssertEqual(DailyFundTable.display(table.rows[0].feeRate), "待更新")
        XCTAssertEqual(DailyFundTable.display(""), "待更新")
        XCTAssertEqual(table.rows[0].distributorLimit, "无")
        XCTAssertEqual(table.rows[0].directLimit, "暂停")
        XCTAssertEqual(try decode(rowOverrides: ["distributorLimit": "部分渠道100"]).rows[0].distributorLimit, "部分渠道100")
    }

    func testInvalidSchemaDatesAndAmbiguousRowsAreRejected() throws {
        XCTAssertThrowsError(try decode(overrides: ["schemaVersion": 2]))
        XCTAssertThrowsError(try decode(overrides: ["dataDate": "2026-02-30"]))
        XCTAssertThrowsError(try decode(overrides: ["dataDate": "10/21"]))
        XCTAssertThrowsError(try decode(rowOverrides: ["fundCode": "19441"]))
        XCTAssertThrowsError(try decode(rowOverrides: ["fundName": " "]))
        let object = fixture()
        let rows = object["rows"] as! [[String: Any]]
        XCTAssertThrowsError(try decode(overrides: ["rows": rows + rows]))
    }

    func testSearchAndShanghaiDateBoundary() throws {
        let table = try decode()
        XCTAssertTrue(table.rows[0].matches(" 万家 "))
        XCTAssertTrue(table.rows[0].matches("019441"))
        XCTAssertTrue(table.rows[0].matches("qdii"))
        XCTAssertFalse(table.rows[0].matches("019442"))
        let parser = ISO8601DateFormatter()
        XCTAssertTrue(table.isCurrent(on: parser.date(from: "2026-10-20T16:00:00Z")!))
        XCTAssertFalse(table.isCurrent(on: parser.date(from: "2026-10-20T15:59:59Z")!))
    }

    func testCacheKeepsActualDateAndCannotBeUsedForAnotherBackend() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("table.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let cache = DailyTableCache(fileURL: url)
        let old = try decode(overrides: ["dataDate": "2026-10-20"])
        try cache.save(old, backend: "https://example.test")
        XCTAssertEqual(try cache.load(backend: "https://example.test")?.dataDate, "2026-10-20")
        XCTAssertNil(try cache.load(backend: "https://other.test"))
        XCTAssertThrowsError(try cache.save(try decode(overrides: ["rows": []]), backend: "https://example.test"))
        XCTAssertEqual(try cache.load(backend: "https://example.test"), old)
    }

    func testBrokenCacheIsNotSilentlyOverwrittenOnRead() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let data = Data("broken".utf8)
        try data.write(to: url)
        XCTAssertThrowsError(try DailyTableCache(fileURL: url).load(backend: "https://example.test"))
        XCTAssertEqual(try Data(contentsOf: url), data)
    }

    func testAvailableFilterRequiresAnExplicitPositiveAmount() throws {
        for value in ["5", "10.00", " 200元 "] {
            XCTAssertTrue(try decode(rowOverrides: ["distributorLimit": value, "directLimit": "待更新"]).rows[0].hasPositiveLimit)
        }
        for value in ["0", "0.00", "暂停", "待更新", "无", "无代销", "部分渠道100", "100*部分渠道", "100*", "10†", "10→5"] {
            XCTAssertFalse(try decode(rowOverrides: ["distributorLimit": value, "directLimit": "待更新"]).rows[0].hasPositiveLimit, value)
        }
        // A qualified distributor amount does not hide a separately clear direct amount.
        XCTAssertTrue(try decode(rowOverrides: ["distributorLimit": "部分渠道100", "directLimit": "5"]).rows[0].hasPositiveLimit)
    }

    func testMyPlansOnlyMatchesSavedCodeWithoutGuessingOrMutatingPlans() throws {
        let row = try decode().rows[0]
        let missing = Plan(fundName: row.fundName, channel: .alipay, amountMinor: 500, frequency: "每日")
        let wrong = Plan(fundName: row.fundName, fundCode: "019442", channel: .alipay, amountMinor: 500, frequency: "每日")
        let matched = Plan(fundName: "本机名称", fundCode: row.fundCode, channel: .alipay, amountMinor: 500, frequency: "每日")
        XCTAssertFalse(row.isInPlans([missing, wrong]))
        XCTAssertTrue(row.isInPlans([missing, matched]))
        XCTAssertNil(missing.fundCode)
    }

    func testLimitChangesIgnoreUnknownQualifiersAndNumberFormatting() {
        XCTAssertEqual(DailyFundTable.limitChange(from: "10", to: "5"), "10 → 5")
        XCTAssertEqual(DailyFundTable.limitChange(from: "5.50元", to: "5.05"), "5.5 → 5.05")
        XCTAssertEqual(DailyFundTable.limitChange(from: "10", to: "暂停"), "10 → 暂停")
        XCTAssertEqual(DailyFundTable.limitChange(from: "暂停申购", to: "5"), "暂停 → 5")
        XCTAssertEqual(DailyFundTable.limitChange(from: "0", to: "5"), "0 → 5")
        XCTAssertEqual(DailyFundTable.limitChange(from: "0", to: "暂停"), "0 → 暂停")
        XCTAssertEqual(DailyFundTable.limitChange(from: "暂停", to: "0"), "暂停 → 0")
        XCTAssertNil(DailyFundTable.limitChange(from: "10.00元", to: "10"))
        for unknown in ["待更新", "无代销", "部分渠道100", "10†", "100*", "10→5", "", "99999999999999999999999"] {
            XCTAssertNil(DailyFundTable.limitChange(from: unknown, to: "5"), unknown)
            XCTAssertNil(DailyFundTable.limitChange(from: "5", to: unknown), unknown)
        }
        XCTAssertNil(DailyFundTable.limitChange(from: nil, to: "5"))
    }

    func testComparisonSurvivesRestartAndDatePerformanceOnlyRefresh() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("table.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let cache = DailyTableCache(fileURL: url)
        let old = try decode(overrides: ["dataDate": "2026-10-20"], rowOverrides: ["distributorLimit": "10"])
        XCTAssertNil(try cache.save(old, backend: "local").comparisonTable)
        let next = try decode()
        XCTAssertEqual(try cache.save(next, backend: "local").comparisonTable, old)

        let restarted = DailyTableCache(fileURL: url)
        XCTAssertEqual(try restarted.loadSnapshot(backend: "local")?.comparisonTable, old)
        let daily = try decode(overrides: ["dataDate": "2026-10-22", "updatedAt": "2026-10-22T07:00:00Z"],
                               rowOverrides: ["feeRate": "0.70%", "return1y": "17.00%"])
        let snapshot = try restarted.save(daily, backend: "local")
        XCTAssertEqual(snapshot.table, daily)
        XCTAssertEqual(snapshot.comparisonTable, old)
        XCTAssertEqual(DailyFundTable.limitChange(from: snapshot.comparisonTable?.rows[0].distributorLimit,
                                                to: snapshot.table.rows[0].distributorLimit), "10 → 5")
        XCTAssertNil(try restarted.loadSnapshot(backend: "other"))
        XCTAssertNil(try restarted.save(next, backend: "other").comparisonTable)
    }

    func testUnknownTransitionDoesNotReuseOldConfirmedChange() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let cache = DailyTableCache(fileURL: url)
        try cache.save(try decode(rowOverrides: ["distributorLimit": "10"]), backend: "local")
        try cache.save(try decode(), backend: "local")
        let unknown = try decode(rowOverrides: ["distributorLimit": "待更新"])
        let missing = try cache.save(unknown, backend: "local")
        XCTAssertNil(DailyFundTable.limitChange(from: missing.comparisonTable?.rows[0].distributorLimit,
                                              to: missing.table.rows[0].distributorLimit))
        let recovered = try cache.save(try decode(), backend: "local")
        XCTAssertEqual(recovered.comparisonTable, unknown)
        XCTAssertNil(DailyFundTable.limitChange(from: recovered.comparisonTable?.rows[0].distributorLimit,
                                              to: recovered.table.rows[0].distributorLimit))
    }

    func testExistingSingleTableCacheUpgradesWithoutLosingTable() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let legacy = try JSONSerialization.data(withJSONObject: ["backend": "local", "table": fixture()])
        try legacy.write(to: url)
        let snapshot = try DailyTableCache(fileURL: url).loadSnapshot(backend: "local")
        XCTAssertEqual(snapshot?.table, try decode())
        XCTAssertNil(snapshot?.comparisonTable)
    }

    private func decode(overrides: [String: Any] = [:], rowOverrides: [String: Any] = [:]) throws -> DailyFundTable {
        try DailyFundTable.decode(JSONSerialization.data(withJSONObject: fixture(overrides: overrides, rowOverrides: rowOverrides)))
    }

    private func fixture(overrides: [String: Any] = [:], rowOverrides: [String: Any] = [:]) -> [String: Any] {
        let row: [String: Any] = ["fundCode": "019441", "fundName": "万家纳斯达克100指数(QDII)A",
                                  "feeRate": "0.65%", "distributorLimit": "5", "directLimit": "100",
                                  "trackingError": "2.18%", "return1y": "16.00%"]
        return ["schemaVersion": 1, "dataDate": "2026-10-21", "updatedAt": "2026-10-21T07:00:00.123Z",
                "source": ["name": "来源", "url": "https://www.xiaohongshu.com/explore/example", "publishedAt": NSNull()],
                "rows": [row.merging(rowOverrides) { _, new in new }]]
            .merging(overrides) { _, new in new }
    }
}
