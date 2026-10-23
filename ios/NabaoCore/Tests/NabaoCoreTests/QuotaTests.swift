import XCTest
@testable import NabaoCore

final class QuotaTests: XCTestCase {
    private let date = "2026-10-20"
    private var plan: Plan {
        Plan(fundName: "示例基金", fundCode: "016452", channel: .southern,
             amountMinor: 2000, frequency: "每日")
    }

    func testSameDayConfirmedDCAReferenceCanIndicatePossibleImpact() throws {
        let quota = try decode()
        XCTAssertEqual(quota.potentiallyAffectedPlans([plan], businessDate: date).count, 1)
    }

    func testPurchaseAndUnknownBusinessCannotBecomeDCALimit() throws {
        for kind in ["PURCHASE", "UNSPECIFIED"] {
            let quota = try decode(overrides: ["businessType": kind])
            XCTAssertTrue(quota.potentiallyAffectedPlans([plan], businessDate: date).isEmpty)
        }
    }

    func testDistributorReferenceCannotClaimSpecificChannelVerified() throws {
        var alipayPlan = plan
        alipayPlan.channel = .alipay
        let quota = try decode(overrides: ["channelScope": "DISTRIBUTOR"])
        XCTAssertTrue(quota.potentiallyAffectedPlans([alipayPlan], businessDate: date).isEmpty)
    }

    func testOldDataOrInactivePlanDoesNotProduceCurrentImpact() throws {
        let quota = try decode()
        var paused = plan
        paused.status = .paused
        XCTAssertTrue(quota.potentiallyAffectedPlans([plan], businessDate: "2026-10-21").isEmpty)
        XCTAssertTrue(quota.potentiallyAffectedPlans([paused], businessDate: date).isEmpty)
    }

    func testConflictWithNullAmountDecodesButHasNoConsensusValue() throws {
        let quota = try decode(overrides: [
            "status": "CONFLICT", "limitKind": NSNull(), "amountMinor": NSNull()
        ])
        XCTAssertNil(quota.limitKind)
        XCTAssertNil(quota.amountMinor)
        XCTAssertTrue(quota.potentiallyAffectedPlans([plan], businessDate: date).isEmpty)
    }

    func testZeroAndPauseAreDifferentObservations() throws {
        let zero = try decode(overrides: ["amountMinor": 0])
        let pause = try decode(overrides: ["limitKind": "PAUSED", "amountMinor": NSNull()])
        XCTAssertEqual(zero.limitKind, "LIMITED")
        XCTAssertEqual(zero.amountMinor, 0)
        XCTAssertEqual(pause.limitKind, "PAUSED")
        XCTAssertNil(pause.amountMinor)
    }

    func testPauseDoesNotRequireCurrencyOrAmountPeriodButStillRequiresScope() throws {
        let fields: [String: Any] = [
            "limitKind": "PAUSED", "amountMinor": NSNull(),
            "currency": "UNSPECIFIED", "period": "UNSPECIFIED"
        ]
        let pause = try decode(overrides: fields)
        let current = plan
        XCTAssertEqual(pause.potentiallyAffectedPlans([current], businessDate: date).map(\.id), [current.id])
        for (field, value) in [("businessType", "PURCHASE"), ("channelScope", "DISTRIBUTOR"), ("status", "CONFLICT")] {
            let unknownScope = try decode(overrides: fields.merging([field: value]) { _, new in new })
            XCTAssertTrue(unknownScope.potentiallyAffectedPlans([plan], businessDate: date).isEmpty)
        }
    }

    func testDailyLimitAggregatesDailyPlansAndPerOrderLimitDoesNot() throws {
        let first = scheduled(amount: 10_000, frequency: "每日")
        let second = scheduled(amount: 10_000, frequency: "每交易日")
        let daily = try decode(overrides: ["amountMinor": 15_000])
        XCTAssertEqual(daily.potentiallyAffectedPlans([first, second], businessDate: date).map(\.id), [first.id, second.id])
        let perOrder = try decode(overrides: ["amountMinor": 15_000, "period": "PER_ORDER"])
        XCTAssertTrue(perOrder.potentiallyAffectedPlans([first, second], businessDate: date).isEmpty)
    }

    func testMatchingExplicitDatesAggregateEvenWithDifferentFrequencies() throws {
        let first = scheduled(amount: 10_000, frequency: "每周三", nextDate: "2026-10-21")
        let second = scheduled(amount: 10_000, frequency: "每月21日", nextDate: "2026-10-21")
        let quota = try decode(overrides: ["amountMinor": 15_000])
        XCTAssertEqual(quota.potentiallyAffectedPlans([first, second], businessDate: date).count, 2)
    }

    func testDifferentOrStaleExplicitDatesAndUnknownSchedulesAreNotCombined() throws {
        let quota = try decode(overrides: ["amountMinor": 15_000])
        let plans = [
            scheduled(amount: 10_000, frequency: "每周三", nextDate: "2026-10-21"),
            scheduled(amount: 10_000, frequency: "每周四", nextDate: "2026-10-22"),
            scheduled(amount: 10_000, frequency: "每月19日", nextDate: "2026-10-19"),
            scheduled(amount: 10_000, frequency: "每月19日", nextDate: "2026-10-19"),
            scheduled(amount: 10_000, frequency: "每周三"),
            scheduled(amount: 10_000, frequency: "每周三")
        ]
        XCTAssertTrue(quota.potentiallyAffectedPlans(plans, businessDate: date).isEmpty)
        let individuallyOver = scheduled(amount: 16_000, frequency: "待确认")
        XCTAssertEqual(quota.potentiallyAffectedPlans(plans + [individuallyOver], businessDate: date).map(\.id),
                       [individuallyOver.id])
    }

    func testDailyPlanCombinesWithAnExplicitDateWithoutDoubleCounting() throws {
        let daily = scheduled(amount: 10_000, frequency: "每日")
        let weekly = scheduled(amount: 10_000, frequency: "每周三", nextDate: "2026-10-21")
        let later = scheduled(amount: 4_000, frequency: "每月22日", nextDate: "2026-10-22")
        let quota = try decode(overrides: ["amountMinor": 15_000])
        XCTAssertEqual(quota.potentiallyAffectedPlans([daily, weekly, later], businessDate: date).map(\.id),
                       [daily.id, weekly.id])
    }

    func testDailyAggregationDoesNotIncludeOtherFundsChannelsOrInactivePlans() throws {
        let active = scheduled(amount: 10_000, frequency: "每日")
        var alipay = scheduled(amount: 10_000, frequency: "每日")
        alipay.channel = .alipay
        var otherFund = scheduled(amount: 10_000, frequency: "每日")
        otherFund.fundCode = "021000"
        var inactive = scheduled(amount: 10_000, frequency: "每日")
        inactive.status = .paused
        let quota = try decode(overrides: ["amountMinor": 15_000])
        XCTAssertTrue(quota.potentiallyAffectedPlans([active, alipay, otherFund, inactive], businessDate: date).isEmpty)
    }

    func testDailyAggregationHandlesIntegerOverflowAndExactLimit() throws {
        let huge = [scheduled(amount: Int64.max - 1, frequency: "每日"),
                    scheduled(amount: Int64.max - 1, frequency: "每日")]
        let quota = try decode(overrides: ["amountMinor": Int64.max])
        XCTAssertEqual(quota.potentiallyAffectedPlans(huge, businessDate: date).count, 2)
        let exact = [scheduled(amount: 5_000, frequency: "每日"), scheduled(amount: 10_000, frequency: "每日")]
        XCTAssertTrue(try decode(overrides: ["amountMinor": 15_000])
            .potentiallyAffectedPlans(exact, businessDate: date).isEmpty)
    }

    func testPublicPauseSuggestsReviewWithoutClaimingDCAImpact() throws {
        let current = plan
        for business in ["UNSPECIFIED", "PURCHASE"] {
            let quota = try reviewReference(overrides: ["businessType": business])
            XCTAssertEqual(quota.plansNeedingChannelReview([current], businessDate: date).map(\.id), [current.id])
            XCTAssertTrue(quota.potentiallyAffectedPlans([current], businessDate: date).isEmpty)
            XCTAssertEqual(current.status, .active)
        }
    }

    func testDistributorReviewMatchesAlipayAndJDWhileDirectStaysWithSouthern() throws {
        let southern = plan
        var alipay = plan
        alipay.channel = .alipay
        var jd = plan
        jd.channel = .jd
        let direct = try reviewReference()
        let distributor = try reviewReference(overrides: ["channelScope": "DISTRIBUTOR"])
        XCTAssertEqual(direct.plansNeedingChannelReview([southern, alipay, jd], businessDate: date).map(\.id),
                       [southern.id])
        XCTAssertEqual(distributor.plansNeedingChannelReview([southern, alipay, jd], businessDate: date).map(\.id),
                       [alipay.id, jd.id])
    }

    func testReviewExcludesUncertainOldInactiveAndUnrelatedReferences() throws {
        let current = plan
        let rejected: [[String: Any]] = [
            ["status": "CONFLICT"], ["status": "INSUFFICIENT"],
            ["supportCount": 1, "sourceCount": 1], ["observedForDate": "2026-10-19"],
            ["channelScope": "PARTIAL"], ["channelScope": "UNSPECIFIED"],
            ["fundName": "摩根纳斯达克100指数(QDII)A"],
            ["businessType": "DCA"], ["limitKind": "UNAVAILABLE"]
        ]
        for fields in rejected {
            XCTAssertTrue(try reviewReference(overrides: fields)
                .plansNeedingChannelReview([current], businessDate: date).isEmpty)
        }
        var paused = current
        paused.status = .paused
        var terminated = current
        terminated.status = .terminated
        var unknown = current
        unknown.channel = .unknown
        var otherFund = current
        otherFund.fundCode = "021000"
        var missingCode = current
        missingCode.fundCode = nil
        XCTAssertTrue(try reviewReference()
            .plansNeedingChannelReview([paused, terminated, unknown, otherFund, missingCode], businessDate: date).isEmpty)
    }

    func testZeroQuotaSuggestsReviewWithoutBecomingPauseOrComparingNonzeroAmounts() throws {
        var current = plan
        current.channel = .alipay
        let fields: [String: Any] = ["channelScope": "DISTRIBUTOR", "limitKind": "LIMITED", "amountMinor": 0]
        let zero = try reviewReference(overrides: fields)
        XCTAssertEqual(zero.plansNeedingChannelReview([current], businessDate: date).map(\.id), [current.id])
        XCTAssertEqual(zero.limitKind, "LIMITED")
        XCTAssertEqual(zero.amountMinor, 0)
        XCTAssertTrue(zero.potentiallyAffectedPlans([current], businessDate: date).isEmpty)
        let nonzero = try reviewReference(overrides: fields.merging(["amountMinor": 1]) { _, new in new })
        XCTAssertTrue(nonzero.plansNeedingChannelReview([current], businessDate: date).isEmpty)
    }

    private func reviewReference(overrides: [String: Any] = [:]) throws -> Quota {
        let fields: [String: Any] = [
            "fundName": "南方纳斯达克100指数发起(QDII)A", "businessType": "UNSPECIFIED",
            "limitKind": "PAUSED", "amountMinor": NSNull(), "currency": "UNSPECIFIED", "period": "UNSPECIFIED"
        ]
        return try decode(overrides: fields.merging(overrides) { _, new in new })
    }

    private func scheduled(amount: Int64, frequency: String, nextDate: String? = nil) -> Plan {
        Plan(fundName: "示例基金", fundCode: "016452", channel: .southern,
             amountMinor: amount, frequency: frequency, nextExecutionDate: nextDate)
    }

    private func decode(overrides: [String: Any] = [:]) throws -> Quota {
        var fields: [String: Any] = [
            "fundCode": "016452", "fundName": "示例基金", "channelScope": "DIRECT",
            "businessType": "DCA", "period": "DAILY", "limitKind": "LIMITED",
            "amountMinor": 1000, "currency": "CNY", "observedForDate": date,
            "status": "AGREED", "supportCount": 2, "sourceCount": 2,
            "votes": [[
                "authorId": "sample", "noteId": "sample-note", "noteRevision": "sample-hash",
                "limitKind": "LIMITED", "amountMinor": 1000,
                "evidenceRef": "https://example.com/test", "counted": true,
                "sourceGroupId": NSNull(), "extraServerField": true
            ]],
            "updatedAt": "2026-10-20T12:00:00.123456Z"
        ]
        fields.merge(overrides) { _, new in new }
        return try JSONDecoder().decode(Quota.self, from: JSONSerialization.data(withJSONObject: fields))
    }
}
