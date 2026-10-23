import Foundation

public struct QuotaPage: Decodable, Sendable {
    public let items: [Quota]
}

public struct Quota: Decodable, Identifiable, Sendable {
    public let fundCode: String
    public let fundName: String
    public let channelScope: String
    public let businessType: String
    public let period: String
    public let limitKind: String?
    public let amountMinor: Int64?
    public let currency: String
    public let observedForDate: String
    public let status: String
    public let supportCount: Int
    public let sourceCount: Int
    public let votes: [Vote]
    public let updatedAt: String

    public var id: String {
        [fundCode, channelScope, businessType, period, currency, observedForDate].joined(separator: "|")
    }

    public struct Vote: Decodable, Sendable {
        public let authorId: String
        public let noteId: String
        public let noteRevision: String
        public let limitKind: String
        public let amountMinor: Int64?
        public let evidenceRef: String
        public let counted: Bool
        public let sourceGroupId: String?
    }

    /// Only a same-day direct-channel DCA reference may support a personal comparison.
    /// Distributor-wide / unspecified rules remain reference data, not verified channel limits.
    public func potentiallyAffectedPlans(_ plans: [Plan], businessDate: String) -> [Plan] {
        guard status == "AGREED", observedForDate == businessDate,
              businessType == "DCA", channelScope == "DIRECT" else { return [] }
        let candidates = plans.filter {
            $0.status == .active && $0.channel == .southern && $0.fundCode == fundCode
        }
        // A business suspension has no monetary unit or per-order/daily amount.
        if limitKind == "PAUSED" { return candidates }
        guard limitKind == "LIMITED", currency == "CNY", ["DAILY", "PER_ORDER"].contains(period),
              let limit = amountMinor, limit >= 0 else { return [] }
        var affected = Set(candidates.filter { $0.amountMinor > limit }.map(\.id))
        guard period == "DAILY" else { return candidates.filter { affected.contains($0.id) } }

        let daily = candidates.filter { isDaily($0.frequency) }
        func includeIfOverLimit(_ group: [Plan]) {
            var total: Int64 = 0
            for plan in group where plan.amountMinor >= 0 {
                let (next, overflow) = total.addingReportingOverflow(plan.amountMinor)
                if overflow || next > limit {
                    affected.formUnion(group.map(\.id))
                    return
                }
                total = next
            }
        }
        includeIfOverLimit(daily)
        // A screenshot's old "next date" is not an executable calendar. Group
        // non-daily plans only by an explicit upcoming date, not a frequency label.
        let dates = Set(candidates.compactMap(\.nextExecutionDate).filter {
            $0 >= businessDate && validExecutionDate($0)
        })
        for date in dates {
            includeIfOverLimit(candidates.filter { plan in
                if plan.nextExecutionDate == date { return true }
                guard isDaily(plan.frequency) else { return false }
                guard let next = plan.nextExecutionDate else { return true }
                return validExecutionDate(next) && next <= date
            })
        }
        return candidates.filter { affected.contains($0.id) }
    }

    /// A public purchase/unspecified reference can suggest checking the original
    /// channel; it cannot establish that an existing DCA plan has failed.
    public func plansNeedingChannelReview(_ plans: [Plan], businessDate: String) -> [Plan] {
        guard status == "AGREED", supportCount >= 2, sourceCount >= 2,
              observedForDate == businessDate,
              ["UNSPECIFIED", "PURCHASE"].contains(businessType),
              limitKind == "PAUSED" || (limitKind == "LIMITED" && amountMinor == 0) else { return [] }
        return plans.filter { plan in
            guard plan.status == .active, plan.fundCode == fundCode else { return false }
            switch channelScope {
            case "DIRECT":
                return plan.channel == .southern
                    && fundName.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("南方")
            case "DISTRIBUTOR":
                return plan.channel == .alipay || plan.channel == .jd
            default:
                return false
            }
        }
    }

    private func isDaily(_ frequency: String) -> Bool {
        let value = frequency.components(separatedBy: .whitespacesAndNewlines).joined()
        return ["每日", "每天", "每交易日", "每日定投", "每天定投", "每交易日定投"].contains(value)
    }

    private func validExecutionDate(_ value: String) -> Bool {
        guard value.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil else { return false }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter.date(from: value) != nil
    }
}
