import SwiftUI
import NabaoCore

struct FundIdentityCell: View {
    let row: DailyFundTable.Row?
    static let width: CGFloat = 140
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight = FundMetricsLine.rowHeight
    @ScaledMetric(relativeTo: .caption) private var headerHeight = FundMetricsLine.headerHeight

    private var shareClass: String? {
        guard let suffix = row?.fundName.last, "ACDEFI".contains(suffix) else { return nil }
        return String(suffix)
    }

    private var displayName: String {
        guard let row else { return "" }
        let name = row.shortName
            .replacingOccurrences(of: "(QDII-LOF)", with: "(LOF)")
            .replacingOccurrences(of: "（QDII-LOF）", with: "（LOF）")
        return shareClass == nil ? name : String(name.dropLast())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let row {
                Text(displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(row.fundCode)
                        .font(.caption2.monospaced().weight(.medium))
                        .foregroundStyle(.secondary)
                    if let shareClass {
                        Text(shareClass)
                            .font(.caption2.bold())
                            .foregroundStyle(.indigo)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(.indigo.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
                    }
                }
            } else {
                Text("基金名称").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .frame(width: Self.width, height: row == nil ? headerHeight : rowHeight, alignment: .leading)
        .clipped()
        .background(row == nil ? Color(.secondarySystemGroupedBackground) : Color.clear)
        .overlay(alignment: .bottom) { Color(.separator).opacity(0.28).frame(height: 0.5) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.map { "\($0.fundName)，代码 \($0.fundCode)" } ?? "基金名称和代码")
    }
}

struct FundMetricsLine: View {
    let row: DailyFundTable.Row?
    let previous: DailyFundTable.Row?
    static let headerHeight: CGFloat = 34
    static let rowHeight: CGFloat = 72
    @ScaledMetric(relativeTo: .subheadline) private var scaledRowHeight = Self.rowHeight
    @ScaledMetric(relativeTo: .caption) private var scaledHeaderHeight = Self.headerHeight
    private static let widths: [CGFloat] = [104, 104, 72, 82, 84]
    static let width = widths.reduce(0, +)
    private var values: [String] {
        guard let row else { return ["代销额度 ↓", "直销额度", "费率", "跟踪误差", "近一年"] }
        return [DailyFundTable.display(row.distributorLimit), DailyFundTable.display(row.directLimit),
                DailyFundTable.display(row.feeRate),
                DailyFundTable.display(row.trackingError), DailyFundTable.display(row.return1y)]
    }

    private func change(at index: Int) -> String? {
        guard let row else { return nil }
        switch index {
        case 0: return DailyFundTable.limitChange(from: previous?.distributorLimit, to: row.distributorLimit)
        case 1: return DailyFundTable.limitChange(from: previous?.directLimit, to: row.directLimit)
        default: return nil
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                VStack(spacing: 4) {
                    Text(value)
                        .font(row == nil ? .caption.weight(.semibold) : (index < 2 ? Font.subheadline : Font.footnote).weight(index == 0 ? .semibold : .regular))
                        .monospacedDigit()
                        .foregroundStyle(textColor(value, at: index))
                        .lineLimit(3)
                    if let change = change(at: index) {
                        Text(change).font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary).monospacedDigit().lineLimit(2)
                    }
                }
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
                .frame(width: Self.widths[index])
                .id("fund-table-\(row?.fundCode ?? "header")-column-\(index)")
            }
        }
        .frame(height: row == nil ? scaledHeaderHeight : scaledRowHeight)
        .clipped()
        .background(row == nil ? Color(.secondarySystemGroupedBackground) : Color.clear)
        .overlay(alignment: .bottom) { Color(.separator).opacity(0.28).frame(height: 0.5) }
        .contentShape(Rectangle())
    }

    private func textColor(_ value: String, at index: Int) -> Color {
        if row == nil { return index == 0 ? .indigo : .secondary }
        if value == "待更新" || value == "无" || value.contains("暂停") { return .secondary }
        return index == 0 ? .indigo : .primary
    }
}
