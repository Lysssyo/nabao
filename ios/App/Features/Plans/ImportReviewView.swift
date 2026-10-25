import SwiftUI
import NabaoCore

struct ImportReviewView: View {
    @EnvironmentObject private var store: PlanStore
    @Environment(\.dismiss) private var dismiss
    @State var batch: ReviewBatch
    @State private var error: String?
    private var selected: [PlanDraft] { batch.drafts.filter(\.selected) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("核对名称、份额、金额、周期和状态后保存。截图未显示的基金代码可以稍后补充。")
                        .foregroundStyle(.secondary)
                    ForEach(batch.messages, id: \.self) { Text($0).font(.footnote) }
                }
                ForEach($batch.drafts) { $draft in
                    Section {
                        if batch.drafts.count > 1 {
                            Toggle("保留这笔计划", isOn: $draft.selected)
                        }
                        FundSelectionFields(name: $draft.fundName, code: $draft.fundCode)
                        Picker("渠道", selection: $draft.channel) {
                            ForEach(Channel.allCases) { Text($0.title).tag($0) }
                        }
                        HStack {
                            Text("每期金额 ¥")
                            TextField("0.00", text: $draft.amount).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                        TextField("执行周期，如每日、每周三", text: $draft.frequency)
                        TextField("下次执行日期 YYYY-MM-DD（可选）", text: $draft.nextDate)
                            .keyboardType(.numbersAndPunctuation)
                        Picker("计划状态", selection: $draft.status) {
                            ForEach(PlanStatus.allCases) { Text($0.title).tag($0) }
                        }
                        ForEach(draft.notes, id: \.self) {
                            Text($0).font(.caption).foregroundStyle(.orange)
                        }
                        if draft.selected && !draft.isValid {
                            Text(draft.validationMessage ?? "请核对填写内容。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle(batch.isEditing ? "编辑定投" : "确认定投记录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        do {
                            try store.save(selected.map { $0.plan() }, imported: Set(selected.compactMap(\.imageDigest)))
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                    .disabled(selected.isEmpty || !selected.allSatisfy(\.isValid))
                    .accessibilityIdentifier("savePlans")
                }
            }
            .alert("未能保存", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }
}
