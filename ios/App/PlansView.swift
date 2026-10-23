import SwiftUI
import PhotosUI
import NabaoCore

struct PlansView: View {
    @EnvironmentObject private var store: PlanStore
    @State private var photos: [PhotosPickerItem] = []
    @State private var batch: ReviewBatch?
    @State private var importing = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("把分散的定投放在一起")
                            .font(.title3.bold())
                        Text("记录保存在本机。截图识别后由你确认，同名计划也可以分别保留。")
                            .font(.subheadline).foregroundStyle(.secondary)
                        PhotosPicker(selection: $photos, maxSelectionCount: 20, matching: .images) {
                            Label(importing ? "正在识别…" : "从截图导入", systemImage: "photo.badge.plus")
                                .fontWeight(.semibold)
                        }
                        .disabled(importing)
                        .accessibilityIdentifier("importScreenshots")
                    }
                    .padding(.vertical, 6)
                }
                if let failure = store.storageError {
                    Section { Text(failure).foregroundStyle(.red) }
                }
                if importing {
                    Section { ProgressView("正在本机识别，不上传截图") }
                }
                if store.plans.isEmpty && !importing {
                    ContentUnavailableView("还没有定投记录", systemImage: "tray",
                        description: Text("导入支付宝或南方基金截图，也可以手动添加。"))
                }
                ForEach(Channel.allCases.filter { channel in store.plans.contains { $0.channel == channel } }) { channel in
                    Section(channel.title) {
                        ForEach(store.plans.filter { $0.channel == channel }) { plan in
                            NavigationLink {
                                PlanDetailView(planID: plan.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(plan.fundName).font(.headline)
                                    HStack {
                                        Text("¥\(Money.text(plan.amountMinor)) · \(plan.frequency)")
                                        Spacer()
                                        Text(plan.status.title).font(.caption).foregroundStyle(.secondary)
                                    }
                                    if plan.fundCode == nil {
                                        Text("补充基金代码后可匹配公开额度")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
            .navigationTitle("我的定投")
            .toolbar {
                Button {
                    batch = ReviewBatch(drafts: [PlanDraft()])
                } label: { Label("手动添加", systemImage: "plus") }
                .accessibilityIdentifier("addPlan")
            }
            .sheet(item: $batch) { value in ImportReviewView(batch: value) }
            .onChange(of: photos) { _, items in
                guard !items.isEmpty else { return }
                Task { await importPhotos(items) }
            }
            .alert("导入提示", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }

    @MainActor
    private func importPhotos(_ items: [PhotosPickerItem]) async {
        importing = true
        defer { importing = false; photos = [] }
        var drafts: [PlanDraft] = []
        var messages: [String] = []
        var seen = store.importedDigests
        for (index, item) in items.enumerated() {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    messages.append("第 \(index + 1) 张图片读取失败。")
                    continue
                }
                let digest = ScreenshotImport.digest(data)
                if seen.contains(digest) {
                    messages.append("第 \(index + 1) 张与已导入或本批图片完全相同，已跳过。若是另一笔计划，请手动新增。")
                    continue
                }
                seen.insert(digest)
                let result = try await ScreenshotImport.recognize(data)
                drafts.append(contentsOf: result.plans.map { PlanDraft(parsed: $0, digest: digest) })
                if result.plans.isEmpty {
                    messages.append("第 \(index + 1) 张未识别到完整计划，可补充完整截图或手动添加。")
                }
                if result.incompleteCount > 0 {
                    messages.append("第 \(index + 1) 张有 \(result.incompleteCount) 条信息不完整，未导入。")
                }
            } catch {
                messages.append("第 \(index + 1) 张识别失败：\(error.localizedDescription)")
            }
        }
        if drafts.isEmpty {
            error = messages.joined(separator: "\n\n")
        } else {
            batch = ReviewBatch(drafts: drafts, messages: messages)
        }
    }
}

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
                        TextField("基金名称", text: $draft.fundName, axis: .vertical)
                        TextField("基金代码（可选，六位）", text: $draft.fundCode)
                            .keyboardType(.numberPad)
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
                            Text("请填写名称、有效金额、周期及渠道；代码和日期如有填写须符合格式。")
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
