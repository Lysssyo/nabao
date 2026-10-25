import SwiftUI
import PhotosUI
import NabaoCore

struct PlansView: View {
    @EnvironmentObject private var store: PlanStore
    @EnvironmentObject private var tables: DailyTableStore
    @State private var changesOnly = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var showingPhotoPicker = false
    @State private var batch: ReviewBatch?
    @State private var importing = false
    @State private var error: String?

    private var overview: PlanOverview {
        PlanOverview(plans: store.plans, table: tables.table, previous: tables.comparisonTable)
    }
    private var visiblePlans: [Plan] {
        changesOnly ? store.plans.filter { overview.changedPlanIDs.contains($0.id) } : store.plans
    }

    var body: some View {
        NavigationStack {
            List {
                if let failure = store.storageError {
                    Section { Text(failure).foregroundStyle(.red) }
                }
                if importing {
                    Section { ProgressView("正在本机识别，不上传截图") }
                }
                if !store.plans.isEmpty {
                    PlanOverviewView(overview: overview, dataDate: tables.table?.dataDate,
                                     comparisonDate: tables.comparisonTable?.dataDate, changesOnly: $changesOnly)
                }
                if changesOnly && visiblePlans.isEmpty {
                    Section {
                        Text("当前没有额度变化的计划").foregroundStyle(.secondary)
                        Button("查看全部计划") { changesOnly = false }
                    }
                }
                if store.plans.isEmpty && !importing {
                    ContentUnavailableView("还没有定投记录", systemImage: "tray",
                        description: Text("点击右上角 ＋，导入截图或手动新增。"))
                }
                ForEach(Channel.allCases.filter { channel in visiblePlans.contains { $0.channel == channel } }) { channel in
                    Section(channel.title) {
                        ForEach(visiblePlans.filter { $0.channel == channel }) { plan in
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
                                    if overview.changedPlanIDs.contains(plan.id) {
                                        Label("公开额度有变化", systemImage: "arrow.left.arrow.right")
                                            .font(.caption).foregroundStyle(.indigo)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
            .navigationTitle("我的定投")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Menu {
                    Button {
                        batch = ReviewBatch(drafts: [PlanDraft()])
                    } label: { Label("手动新增", systemImage: "square.and.pencil") }
                    .accessibilityIdentifier("addPlan")
                    Button {
                        showingPhotoPicker = true
                    } label: { Label("从截图导入", systemImage: "photo.badge.plus") }
                    .disabled(importing)
                    .accessibilityIdentifier("importScreenshots")
                } label: { Label("新增定投", systemImage: "plus") }
                .accessibilityIdentifier("addPlanMenu")
            }
            .photosPicker(isPresented: $showingPhotoPicker, selection: $photos,
                          maxSelectionCount: 20, matching: .images)
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
        let result = await ScreenshotImport.load(items, alreadyImported: store.importedDigests)
        if result.plans.isEmpty {
            error = result.messages.joined(separator: "\n\n")
        } else {
            batch = ReviewBatch(drafts: result.plans.map { PlanDraft(parsed: $0.plan, digest: $0.digest) },
                                messages: result.messages)
        }
    }
}
