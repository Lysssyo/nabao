import SwiftUI
import NabaoCore

struct PlanDetailView: View {
    @EnvironmentObject private var store: PlanStore
    @EnvironmentObject private var tables: DailyTableStore
    @AppStorage("backendBaseURL") private var baseURL = AppConfiguration.defaultBackendURL
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    let planID: UUID
    @State private var editor: ReviewBatch?
    @State private var error: String?
    @State private var confirmDelete = false
    private var plan: Plan? { store.plans.first { $0.id == planID } }

    var body: some View {
        Group {
            if let plan {
                List {
                    Section {
                        Text(plan.fundName).font(.title3.bold())
                        LabeledContent("渠道", value: plan.channel.title)
                        LabeledContent("基金代码", value: plan.fundCode ?? "待补充")
                        LabeledContent("每期金额", value: "¥\(Money.text(plan.amountMinor))")
                        LabeledContent("周期", value: plan.frequency)
                        LabeledContent("状态", value: plan.status.title)
                        if let next = plan.nextExecutionDate { LabeledContent("截图中的下次日期", value: next) }
                    }
                    quotaSection(for: plan)
                    Section("前往渠道") {
                        if plan.channel == .alipay, let url = KnownFund.alipayDetailURL(for: plan.fundCode) {
                            Button("打开支付宝基金详情", systemImage: "arrow.up.right.square") {
                                openURL(url) { accepted in
                                    if !accepted { error = "未能打开链接。请检查支付宝是否安装，或在渠道内搜索基金代码。" }
                                }
                            }
                            Text("买入：详情 → 买入。\n管理：详情 → 定投中 → 选择计划 → 管理。")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else if plan.channel == .southern, let url = KnownFund.southernInvestmentURL() {
                            Button("打开南方基金我的定投", systemImage: "arrow.up.right.square") {
                                openURL(url) { accepted in
                                    if !accepted { error = "未能打开链接。请检查南方基金是否安装，或在 App 内进入“我的定投”。" }
                                }
                            }
                            Text("进入“我的定投”后，选择对应计划查看详情和管理入口。")
                                .font(.footnote).foregroundStyle(.secondary)
                            if let detailURL = KnownFund.southernDetailURL(for: plan.fundCode) {
                                Button("打开南方基金产品详情", systemImage: "arrow.up.right.square") {
                                    openURL(detailURL) { accepted in
                                        if !accepted { error = "未能打开产品详情，可复制基金代码后在南方基金内搜索。" }
                                    }
                                }
                                Text("产品详情中可查看定投和购买入口，请核对当前可用额度。")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        } else {
                            Text("此渠道或基金的业务直达尚未验证")
                            Text("可复制基金名称／代码，在原渠道中处理。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Button("复制基金名称与代码", systemImage: "doc.on.doc") {
                            Clipboard.copyFund(name: plan.fundName, code: plan.fundCode)
                        }
                    }
                    Section("在原渠道处理后") {
                        Text("打开渠道不代表已修改定投。完成后在这里更新本地记录。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("已调整金额或周期") { editor = ReviewBatch(drafts: [PlanDraft(plan: plan)], isEditing: true) }
                        Button("确认已暂停") { setStatus(.paused, for: plan) }
                        Button("确认已终止") { setStatus(.terminated, for: plan) }
                        if plan.status != .active { Button("确认已恢复") { setStatus(.active, for: plan) } }
                    }
                    Section {
                        Button("删除本地记录", role: .destructive) { confirmDelete = true }
                    } footer: {
                        Text("删除本地记录不会取消原渠道的定投。")
                    }
                }
            } else {
                ContentUnavailableView("记录已删除", systemImage: "tray")
            }
        }
        .navigationTitle("定投详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let plan { Button("编辑") { editor = ReviewBatch(drafts: [PlanDraft(plan: plan)], isEditing: true) } }
        }
        .sheet(item: $editor) { ImportReviewView(batch: $0) }
        .confirmationDialog("删除这笔本地记录？原渠道计划仍会保留。", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除本地记录", role: .destructive) {
                guard let plan else { return }
                do { try store.remove(plan); dismiss() } catch { self.error = error.localizedDescription }
            }
        }
        .alert("操作提示", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("知道了", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    @ViewBuilder
    private func quotaSection(for plan: Plan) -> some View {
        Section {
            if let row = tables.row(code: plan.fundCode), let table = tables.table {
                Text(row.fundName).font(.subheadline)
                LabeledContent("数据日期", value: table.dataDate)
                if !table.isCurrent() {
                    Text("非今日数据，请留意日期。").font(.caption).foregroundStyle(.orange)
                }
                LabeledContent("代销参考", value: DailyFundTable.display(row.distributorLimit))
                LabeledContent("直销参考", value: DailyFundTable.display(row.directLimit))
                let previous = tables.previousRow(code: row.fundCode)
                let distributorChange = DailyFundTable.limitChange(from: previous?.distributorLimit, to: row.distributorLimit)
                let directChange = DailyFundTable.limitChange(from: previous?.directLimit, to: row.directLimit)
                if let distributorChange { LabeledContent("代销明确变化", value: distributorChange) }
                if let directChange { LabeledContent("直销明确变化", value: directChange) }
                if distributorChange != nil || directChange != nil, let date = tables.comparisonTable?.dataDate {
                    Text("与本机留存的 \(date) 公开额度比较。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                NavigationLink {
                    FundTableDetailView(fundCode: row.fundCode)
                } label: {
                    Label("查看额度详情和表格说明", systemImage: "tablecells")
                }
                .accessibilityIdentifier("planQuotaDetail")
            } else if plan.fundCode?.isEmpty ?? true {
                Text("先核对并补充基金代码，才能对应公开额度。")
                Button("选择基金并补充代码") {
                    editor = ReviewBatch(drafts: [PlanDraft(plan: plan)], isEditing: true)
                }
                .accessibilityIdentifier("completePlanFund")
            } else {
                Text(tables.table == nil ? "尚未取得公开额度表。" : "当前额度表没有这个代码，保留本机记录供你核对。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let message = tables.message {
                Text(message).font(.footnote).foregroundStyle(.orange)
            }
            Button {
                Task { await tables.load(baseURL: baseURL) }
            } label: {
                if tables.loading { ProgressView("正在刷新额度") }
                else { Label("刷新公开额度", systemImage: "arrow.clockwise") }
            }
            .disabled(tables.loading)
            .accessibilityIdentifier("refreshPlanQuota")
        } header: {
            Text("公开额度参考")
        } footer: {
            Text("按已填写的基金代码对应。代销、直销额度不代表\(plan.channel.title)的实际额度，也不代表已有定投仍可执行；请结合详情中的条件和原渠道核对。刷新不会调整这笔计划。")
        }
        .accessibilityIdentifier("planQuotaSection")
    }

    private func setStatus(_ status: PlanStatus, for plan: Plan) {
        var next = plan
        next.status = status
        next.confirmedAt = Date()
        do { try store.save([next]) } catch { self.error = error.localizedDescription }
    }

}
