import SwiftUI
import NabaoCore

struct FundTableDetailView: View {
    let fundCode: String
    @EnvironmentObject private var tables: DailyTableStore
    @AppStorage("backendBaseURL") private var baseURL = AppConfiguration.defaultBackendURL
    private var previous: DailyFundTable.Row? { tables.previousRow(code: fundCode) }
    private var comparisonDate: String? { tables.comparisonTable?.dataDate }
    private var dataDate: String { tables.table?.dataDate ?? "" }
    private var notes: [String] { tables.table?.notes ?? [] }
    @EnvironmentObject private var store: PlanStore
    @Environment(\.openURL) private var openURL
    @State private var actionMessage: String?

    var body: some View {
        List {
            if let row = tables.row(code: fundCode) {
                Section {
                    Text(row.fundName).font(.headline)
                    LabeledContent("基金代码", value: row.fundCode)
                    LabeledContent("数据日期", value: dataDate)
                    if let table = tables.table, !table.isCurrent() {
                        Text("非今日数据，请留意日期。").font(.caption).foregroundStyle(.orange)
                    }
                    LabeledContent("费率", value: DailyFundTable.display(row.feeRate))
                    LabeledContent("代销", value: DailyFundTable.display(row.distributorLimit))
                    LabeledContent("直销", value: DailyFundTable.display(row.directLimit))
                    LabeledContent("跟踪误差", value: DailyFundTable.display(row.trackingError))
                    LabeledContent("近一年", value: DailyFundTable.display(row.return1y))
                }
                let distributorChange = DailyFundTable.limitChange(from: previous?.distributorLimit, to: row.distributorLimit)
                let directChange = DailyFundTable.limitChange(from: previous?.directLimit, to: row.directLimit)
                if distributorChange != nil || directChange != nil {
                    Section("本机额度变化记录") {
                        if let distributorChange { LabeledContent("代销", value: distributorChange) }
                        if let directChange { LabeledContent("直销", value: directChange) }
                        if let comparisonDate {
                            Text("与本机留存的 \(comparisonDate) 额度比较，请在渠道内核对。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if !notes.isEmpty {
                    Section("表格说明") {
                        ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                            Text(note).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("渠道入口") {
                    if let url = KnownFund.alipayDetailURL(for: row.fundCode) {
                        Button("去支付宝核对", systemImage: "arrow.up.right.square") { openChannel(url, name: "支付宝") }
                        Text("管理路径：基金详情 → 定投中 → 选择计划 → 管理。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let url = KnownFund.southernDetailURL(for: row.fundCode) {
                        Button("去南方基金核对", systemImage: "arrow.up.right.square") { openChannel(url, name: "南方基金") }
                    }
                    Button("复制基金名称与代码", systemImage: "doc.on.doc") {
                        Clipboard.copyFund(name: row.fundName, code: row.fundCode)
                        actionMessage = "已复制，可在对应渠道内搜索。"
                    }
                    Text("代销与直销为公开参考，请在购买渠道核对实际额度和定投状态。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                let plans = store.plans.filter { $0.fundCode == row.fundCode }
                if !plans.isEmpty {
                    Section("本机定投") {
                        ForEach(plans) { plan in
                            NavigationLink {
                                PlanDetailView(planID: plan.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("\(plan.channel.title) · ¥\(Money.text(plan.amountMinor)) · \(plan.frequency)")
                                    Text(plan.status.title).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            } else {
                ContentUnavailableView("暂无此基金额度", systemImage: "tablecells",
                    description: Text("当前服务没有这个代码的数据，可刷新后重试。"))
            }
            if let message = tables.message {
                Section { Text(message).font(.footnote).foregroundStyle(.orange) }
            }
        }
        .navigationTitle("基金详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button { Task { await tables.load(baseURL: baseURL) } } label: {
                Label("刷新额度", systemImage: "arrow.clockwise")
            }
            .disabled(tables.loading)
            .accessibilityIdentifier("refreshFundQuota")
        }
        .refreshable { await tables.load(baseURL: baseURL) }
        .accessibilityIdentifier("fundQuotaDetail")
        .alert("渠道核对", isPresented: Binding(get: { actionMessage != nil }, set: { if !$0 { actionMessage = nil } })) {
            Button("知道了", role: .cancel) {}
        } message: { Text(actionMessage ?? "") }
    }

    private func openChannel(_ url: URL, name: String) {
        openURL(url) { accepted in
            if !accepted { actionMessage = "未能打开\(name)，可复制基金代码后在渠道内搜索。" }
        }
    }
}
