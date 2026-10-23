import XCTest
@testable import NabaoCore

final class ScreenshotParserTests: XCTestCase {
    func testAmountComesFromPurchaseRowNotCumulativeInvestment() {
        let result = ScreenshotParser.parse(alipay())
        XCTAssertEqual(result.plans.count, 1)
        XCTAssertEqual(result.plans[0].amountMinor, 1_000)
        XCTAssertEqual(result.plans[0].fundCode, "019172")
        XCTAssertEqual(result.plans[0].channel, .alipay)
        XCTAssertEqual(result.plans[0].nextExecutionDate, "2026-10-21")
    }

    func testTruncatedCardIsNotImported() {
        let lines = alipay() + [line("定投 建信纳斯达克100指数（QDII）A 详情", 0.7)]
        let result = ScreenshotParser.parse(lines)
        XCTAssertEqual(result.plans.count, 1)
        XCTAssertEqual(result.incompleteCount, 1)
    }

    func testSameNameAndAmountCanBeTwoPlans() {
        let second = alipay().filter { $0.y > 0.1 }.map {
            OCRLine(text: $0.text, x: $0.x, y: $0.y + 0.4)
        }
        let result = ScreenshotParser.parse(alipay() + second)
        XCTAssertEqual(result.plans.count, 2)
        XCTAssertNotEqual(result.plans[0].id, result.plans[1].id)
    }

    func testSouthernMergedLinesAndShareClassAmbiguity() {
        let result = ScreenshotParser.parse([
            line("我的定投", 0.08),
            line("南方纳斯达克100指数发起（QDII）1", 0.2),
            line("定投金额 200.00元", 0.24),
            OCRLine(text: "定投周期 每日", x: 0.5, y: 0.24),
            line("下次扣款 2026-10-21", 0.28),
            line("关联账号 招商银行 0000", 0.32)
        ])
        XCTAssertEqual(result.plans.count, 1)
        XCTAssertEqual(result.plans[0].channel, .southern)
        XCTAssertEqual(result.plans[0].amountMinor, 20_000)
        XCTAssertTrue(result.plans[0].fundName.hasSuffix("I"))
        XCTAssertNil(result.plans[0].fundCode)
        XCTAssertTrue(result.plans[0].notes.contains(where: { $0.contains("推测") }))
    }

    func testMissingAmountDoesNotBorrowNextCardAmount() {
        let lines = [
            line("投资计划", 0.08),
            line("摩根纳斯达克100指数（QDII）A", 0.2),
            line("每日定投", 0.25),
            line("南方纳斯达克100指数（QDII）A", 0.4),
            line("每日定投", 0.45),
            line("买入金额", 0.5),
            OCRLine(text: "10.00元", x: 0.7, y: 0.5)
        ]
        let result = ScreenshotParser.parse(lines)
        XCTAssertEqual(result.plans.count, 1)
        XCTAssertEqual(result.plans[0].fundCode, "016452")
        XCTAssertEqual(result.incompleteCount, 1)
    }

    func testMoneyValidationDoesNotRoundOrOverflow() {
        XCTAssertEqual(Money.minorUnits("10.1"), 1010)
        XCTAssertEqual(Money.minorUnits(" 200.00 "), 20000)
        XCTAssertNil(Money.minorUnits("-1"))
        XCTAssertNil(Money.minorUnits("10.123"))
        XCTAssertNil(Money.minorUnits("1,000"))
        XCTAssertNil(Money.minorUnits("9223372036854775807"))
    }

    func testVerifiedScreenshotAliasesPreserveShareClassAndCurrency() {
        XCTAssertEqual(KnownFund.code(for: "摩根纳斯达克100指数（QDII）A"), "019172")
        XCTAssertEqual(KnownFund.code(for: "摩根纳斯达克100指数(QDII)人民币A"), "019172")
        XCTAssertEqual(KnownFund.code(for: "建信纳斯达克100指数（QDII）A"), "539001")
        XCTAssertEqual(KnownFund.code(for: "建信纳斯达克100指数(QDII)A人民币"), "539001")
        XCTAssertEqual(KnownFund.code(for: "南方纳斯达克100指数（QDII）A"), "016452")
        XCTAssertEqual(KnownFund.code(for: "南方纳斯达克100指数（QDII）C"), "016453")
        XCTAssertEqual(KnownFund.code(for: "南方纳斯达克100指数发起（QDII）C"), "016453")
        XCTAssertEqual(KnownFund.code(for: "南方纳斯达克100指数发起（QDII）I"), "021000")
        XCTAssertNil(KnownFund.code(for: "南方纳斯达克100指数发起（QDII）1"))
        XCTAssertNil(KnownFund.code(for: "摩根纳斯达克100指数（QDII）美元A"))
        XCTAssertNil(KnownFund.code(for: "南方纳斯达克100指数发起（QDII）D"))
        XCTAssertNil(KnownFund.code(for: "建信纳斯达克科技指数（QDII）A"))
    }

    func testClearSouthernIReceivesCodeWhileInferredIRemainsUnconfirmed() {
        let result = ScreenshotParser.parse([
            line("我的定投", 0.08),
            line("南方纳斯达克100指数发起（QDII）I", 0.2),
            line("定投金额 200.00元", 0.24),
            OCRLine(text: "定投周期 每日", x: 0.5, y: 0.24)
        ])
        XCTAssertEqual(result.plans.count, 1)
        XCTAssertEqual(result.plans[0].fundCode, "021000")
        XCTAssertFalse(result.plans[0].notes.contains(where: { $0.contains("推测") }))
    }

    private func line(_ text: String, _ y: Double) -> OCRLine { OCRLine(text: text, x: 0.05, y: y) }
    private func alipay() -> [OCRLine] {
        [
            line("投资计划", 0.08),
            line("摩根纳斯达克100指数（QDII）A 详情", 0.2),
            line("每日定投", 0.25),
            line("已投7期，累计定投70.00元", 0.3),
            line("买入金额", 0.35),
            OCRLine(text: "10.00元", x: 0.7, y: 0.351),
            line("下次定投时间", 0.4),
            OCRLine(text: "2026-10-21（星期三）", x: 0.6, y: 0.401)
        ]
    }
}
