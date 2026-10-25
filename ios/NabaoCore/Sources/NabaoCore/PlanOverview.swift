import Foundation

/// Totals retain each plan's execution schedule. They are not monthly forecasts.
public struct PlanOverview {
    public struct ScheduleTotal: Identifiable, Equatable {
        public var id: String { frequency }
        public let frequency: String
        public let count: Int
        public let amountMinor: Decimal

        public var amountText: String {
            let formatter = NumberFormatter()
            formatter.locale = Locale(identifier: "zh_CN")
            formatter.numberStyle = .decimal
            formatter.minimumFractionDigits = 2
            formatter.maximumFractionDigits = 2
            formatter.usesGroupingSeparator = true
            return formatter.string(from: NSDecimalNumber(decimal: amountMinor / 100)) ?? "—"
        }
    }

    public let totalCount: Int
    public let activeCount: Int
    public let schedules: [ScheduleTotal]
    public let changedPlanIDs: Set<UUID>

    public init(plans: [Plan], table: DailyFundTable?, previous: DailyFundTable?) {
        totalCount = plans.count
        let active = plans.filter { $0.status == .active }
        activeCount = active.count
        // Exact schedule grouping avoids treating “每周一、三” as once weekly,
        // or mixing every calendar day with every trading day.
        let groups = Dictionary(grouping: active) { plan in
            let value = plan.frequency.trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? "未填写周期" : value
        }
        schedules = groups.map { frequency, records in
            ScheduleTotal(frequency: frequency, count: records.count,
                          amountMinor: records.reduce(Decimal.zero) { $0 + Decimal($1.amountMinor) })
        }.sorted {
            let first = Self.scheduleOrder($0.frequency), second = Self.scheduleOrder($1.frequency)
            return first == second ? $0.frequency.localizedStandardCompare($1.frequency) == .orderedAscending : first < second
        }

        let currentRows = Dictionary((table?.rows ?? []).map { ($0.fundCode, $0) }, uniquingKeysWith: { first, _ in first })
        let previousRows = Dictionary((previous?.rows ?? []).map { ($0.fundCode, $0) }, uniquingKeysWith: { first, _ in first })
        changedPlanIDs = Set(plans.compactMap { plan in
            guard let code = plan.fundCode, let row = currentRows[code], let old = previousRows[code],
                  DailyFundTable.limitChange(from: old.distributorLimit, to: row.distributorLimit) != nil
                    || DailyFundTable.limitChange(from: old.directLimit, to: row.directLimit) != nil else { return nil }
            return plan.id
        })
    }

    private static func scheduleOrder(_ frequency: String) -> Int {
        if ["每日", "每天", "每交易日"].contains(where: frequency.hasPrefix) { return 0 }
        if ["每周", "每星期"].contains(where: frequency.hasPrefix) { return 1 }
        if frequency.hasPrefix("每月") { return 2 }
        return 3
    }
}
