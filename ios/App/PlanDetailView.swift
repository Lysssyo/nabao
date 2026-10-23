import SwiftUI
import NabaoCore

struct PlanDetailView: View {
    @EnvironmentObject private var store: PlanStore
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
                            UIPasteboard.general.string = [plan.fundName, plan.fundCode].compactMap { $0 }.joined(separator: " ")
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

    private func setStatus(_ status: PlanStatus, for plan: Plan) {
        var next = plan
        next.status = status
        next.confirmedAt = Date()
        do { try store.save([next]) } catch { self.error = error.localizedDescription }
    }

}
