import XCTest
@testable import NabaoCore

final class PlanOverviewTests: XCTestCase {
    func testOnlyActivePlansContributeAndDifferentSchedulesRemainSeparate() {
        let plans = [plan(100, "每日"), plan(200, "每日"), plan(500, "每交易日"),
                     plan(800, "每周三"), plan(900, "每周五"), plan(700, "每周一、三"),
                     plan(99_900, "每日", status: .paused), plan(99_900, "每日", status: .terminated),
                     plan(99_900, "每日", status: .unknown)]
        let summary = PlanOverview(plans: plans, table: nil, previous: nil)
        XCTAssertEqual(summary.totalCount, 9)
        XCTAssertEqual(summary.activeCount, 6)
        XCTAssertEqual(summary.schedules.count, 5)
        let daily = summary.schedules.first { $0.frequency == "每日" }
        XCTAssertEqual(daily?.count, 2)
        XCTAssertEqual(daily?.amountMinor, 300)
        XCTAssertEqual(daily?.amountText, "3.00")
        XCTAssertTrue(summary.schedules.prefix(2).allSatisfy { ["每日", "每交易日"].contains($0.frequency) })
        XCTAssertTrue(summary.changedPlanIDs.isEmpty)
    }

    func testLargeTotalsDoNotOverflowInt64OrLoseCents() {
        let summary = PlanOverview(plans: [plan(Int64.max - 99, "每月1日"), plan(Int64.max - 99, "每月1日")], table: nil, previous: nil)
        XCTAssertEqual(summary.schedules[0].amountMinor, Decimal(Int64.max - 99) * 2)
        XCTAssertEqual(summary.schedules[0].amountText, "184,467,440,737,095,514.16")
    }

    func testChangesMatchExactCodesAndRetainSeparatePlansForSameFund() throws {
        let first = plan(100, "每日", code: "016452")
        let second = plan(200, "每日", code: "016452")
        let different = plan(300, "每日", code: "016453")
        let missing = plan(400, "每日")
        let current = try table(distributor: "5", direct: "100")
        let old = try table(distributor: "10", direct: "100")
        let summary = PlanOverview(plans: [first, second, different, missing], table: current, previous: old)
        XCTAssertEqual(summary.changedPlanIDs, [first.id, second.id])
        XCTAssertEqual(summary.totalCount, 4)
    }

    func testNoBaselineOrConditionalValueDoesNotInventChanges() throws {
        let plans = [plan(100, "每日", code: "016452")]
        let old = try table(distributor: "10", direct: "100")
        XCTAssertTrue(PlanOverview(plans: plans, table: old, previous: nil).changedPlanIDs.isEmpty)
        for value in ["10", "待更新", "部分渠道5", "5*", ""] {
            let current = try table(distributor: value, direct: "100")
            XCTAssertTrue(PlanOverview(plans: plans, table: current, previous: old).changedPlanIDs.isEmpty)
        }
        let paused = try table(distributor: "10", direct: "暂停")
        XCTAssertEqual(PlanOverview(plans: plans, table: paused, previous: old).changedPlanIDs, [plans[0].id])
    }

    func testEmptyAndInactiveOnlyPlansHaveNoScheduleTotals() {
        XCTAssertEqual(PlanOverview(plans: [], table: nil, previous: nil).activeCount, 0)
        let summary = PlanOverview(plans: [plan(100, "每日", status: .paused)], table: nil, previous: nil)
        XCTAssertEqual(summary.totalCount, 1)
        XCTAssertTrue(summary.schedules.isEmpty)
        let ordered = PlanOverview(plans: [plan(100, "每月1日"), plan(200, "每周三"), plan(300, "每日")], table: nil, previous: nil)
        XCTAssertEqual(ordered.schedules.map(\.frequency), ["每日", "每周三", "每月1日"])
    }

    private func plan(_ amount: Int64, _ frequency: String, status: PlanStatus = .active, code: String? = nil) -> Plan {
        Plan(fundName: "南方纳指100", fundCode: code, channel: .alipay, amountMinor: amount, frequency: frequency, status: status)
    }

    private func table(distributor: String, direct: String) throws -> DailyFundTable {
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "dataDate": "2026-10-25",
            "updatedAt": "2026-10-25T01:00:00Z", "source": ["name": "投票结果", "url": "https://example.test"],
            "rows": [["fundCode": "016452", "fundName": "南方纳指100A", "distributorLimit": distributor, "directLimit": direct]]])
        return try DailyFundTable.decode(data)
    }
}
