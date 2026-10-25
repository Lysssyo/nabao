import XCTest
@testable import NabaoCore

final class DailyTableOrderingTests: XCTestCase {
    func testDistributorBucketsAndStableTiesPreserveOriginalRows() throws {
        let values = ["待更新", "5", "部分渠道100", "暂停", "无", "不限额", "200", "100*", "0", "10→5", "5.00元", "未知"]
        let rows = try makeRows(values)
        let sorted = DailyTableOrdering.distributorDescending(rows)
        XCTAssertEqual(sorted.map(\.distributorLimit), ["不限额", "200", "5", "5.00元", "部分渠道100", "100*", "10→5", "暂停", "0", "无", "待更新", "未知"])
        XCTAssertEqual(rows.map(\.distributorLimit), values)
        XCTAssertEqual(Set(sorted.map(\.id)), Set(rows.map(\.id)))
        for row in sorted { XCTAssertEqual(row, rows.first { $0.id == row.id }) }
    }

    func testRMBFormatsNormalizeOnlyForOrdering() {
        for value in ["1,000", "￥1，000．00元/日", "人民币 1千元／天", "0.1万", "¥ 1000.00元"] {
            XCTAssertEqual(DailyTableOrdering.key(value), .init(bucket: 1, amount: 100_000), value)
        }
        for value in ["不限额", "不限", "无限额"] {
            XCTAssertEqual(DailyTableOrdering.key(value), .init(bucket: 0, amount: nil))
        }
        for value in ["0", "0.00元", "人民币0元/日", "暂停", "暂停申购"] {
            XCTAssertEqual(DailyTableOrdering.key(value), .init(bucket: 3, amount: nil))
        }
    }

    func testConditionalValuesRemainSeparateAndDoNotInferAmbiguousAmounts() {
        for value in ["100*", "100†", "部分渠道100", "100（部分渠道）"] {
            XCTAssertEqual(DailyTableOrdering.key(value), .init(bucket: 2, amount: 10_000), value)
        }
        for value in ["10→5", "10-50", "10至50", "合并100", "累计100", "分别100", "100美元", "$100", "港元100",
                      "100（代码021000）", "每人100，每渠道200", "-100", "1,00", "1.123", ".5", "100.", "部分渠道.5", "100，部分渠道", "100%", "100％", "90071992547409.92"] {
            XCTAssertEqual(DailyTableOrdering.key(value), .init(bucket: 2, amount: nil), value)
        }
        XCTAssertEqual(DailyTableOrdering.key("90071992547409.91"), .init(bucket: 1, amount: 9_007_199_254_740_991))
        XCTAssertEqual(DailyTableOrdering.key("90071992547409.91万"), .init(bucket: 2, amount: nil))
    }

    func testFilteringUsesOriginalAvailabilityAndCodesAfterSorting() throws {
        let rows = try makeRows(["部分渠道900", "5", "100*", "暂停", "10"])
        let sorted = DailyTableOrdering.distributorDescending(rows)
        XCTAssertEqual(sorted.filter(\.hasPositiveLimit).map(\.distributorLimit), ["10", "5"])
        let plan = Plan(fundName: "本机名称", fundCode: rows[2].fundCode, channel: .alipay, amountMinor: 100, frequency: "每日")
        XCTAssertEqual(sorted.filter { $0.isInPlans([plan]) }, [rows[2]])
        XCTAssertEqual(sorted.filter { $0.matches(rows[0].fundCode) }, [rows[0]])
    }

    private func makeRows(_ limits: [String]) throws -> [DailyFundTable.Row] {
        let rows = limits.enumerated().map { index, limit in
            ["fundCode": String(format: "%06d", index), "fundName": "测试纳指100 \(index)",
             "distributorLimit": limit, "directLimit": "待更新"]
        }
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "dataDate": "2026-10-25",
            "updatedAt": "2026-10-25T00:00:00Z", "source": ["name": "投票结果", "url": "https://example.test"], "rows": rows])
        return try DailyFundTable.decode(data).rows
    }
}
