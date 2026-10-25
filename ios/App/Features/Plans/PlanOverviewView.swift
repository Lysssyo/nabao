import SwiftUI
import NabaoCore

struct PlanOverviewView: View {
    let overview: PlanOverview
    let dataDate: String?
    let comparisonDate: String?
    @Binding var changesOnly: Bool
    @State private var showAllSchedules = false

    var body: some View {
        Section {
            HStack(alignment: .top) {
                metric("全部计划", count: overview.totalCount)
                Spacer()
                metric("进行中", count: overview.activeCount)
                Spacer()
                Button {
                    changesOnly.toggle()
                } label: {
                    metric(changesOnly ? "显示全部" : "额度变化", count: comparisonDate == nil ? nil : overview.changedPlanIDs.count)
                        .foregroundStyle(Color.indigo)
                }
                .buttonStyle(.borderless)
                .disabled(overview.changedPlanIDs.isEmpty && !changesOnly)
                .accessibilityIdentifier("filterChangedPlans")
                .accessibilityLabel(comparisonDate == nil ? "额度变化，尚无对比记录" : "\(overview.changedPlanIDs.count) 笔计划的公开额度有变化，\(changesOnly ? "显示全部计划" : "只看变化计划")")
            }
            .padding(.vertical, 4)
            if !overview.schedules.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("进行中 · 按执行周期合计").font(.caption).foregroundStyle(.secondary)
                    ForEach(showAllSchedules ? overview.schedules : Array(overview.schedules.prefix(3))) { total in
                        HStack(alignment: .firstTextBaseline) {
                            Text(total.frequency).font(.subheadline)
                            Text("\(total.count) 笔").font(.caption).foregroundStyle(.secondary)
                            Spacer(minLength: 8)
                            Text("¥\(total.amountText)").font(.subheadline.weight(.semibold)).monospacedDigit()
                        }
                    }
                    if overview.schedules.count > 3 {
                        Button(showAllSchedules ? "收起" : "查看全部 \(overview.schedules.count) 个周期") { showAllSchedules.toggle() }
                            .font(.caption).buttonStyle(.borderless)
                    }
                }
                .padding(.vertical, 4)
            }
            if !overview.changedPlanIDs.isEmpty, let date = dataDate, let previous = comparisonDate {
                Text("额度变化：\(date) 与本机留存的 \(previous) 数据比较。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("planOverview")
    }

    private func metric(_ title: String, count: Int?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(count.map(String.init) ?? "—").font(.title2.bold()).monospacedDigit()
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
    }
}
