import SwiftUI
import NabaoCore

struct QuotasView: View {
    let refreshID: UUID
    @EnvironmentObject private var store: PlanStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("backendBaseURL") private var baseURL = "http://127.0.0.1:8080"
    @State private var table: DailyFundTable?
    @State private var comparisonTable: DailyFundTable?
    @State private var loading = false
    @State private var message: String?
    @State private var search = ""
    @State private var filter: TableFilter = .all
    @State private var loadedBackend: String?
    @State private var requestID = UUID()

    private let cache = DailyTableCache(fileURL: URL.applicationSupportDirectory
        .appending(path: "nabao", directoryHint: .isDirectory).appending(path: "daily-table.json"))

    private enum TableFilter: String, CaseIterable {
        case all = "全部", available = "有额度", mine = "我的定投"
    }

    private var rows: [DailyFundTable.Row] {
        table?.rows.filter { row in
            guard row.matches(search) else { return false }
            switch filter {
            case .all: return true
            case .available: return row.hasPositiveLimit
            case .mine: return row.isInPlans(store.plans)
            }
        } ?? []
    }
    private var plansWithoutCode: [Plan] {
        store.plans.filter { $0.fundCode?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true }
    }

    private func previousRow(for row: DailyFundTable.Row) -> DailyFundTable.Row? {
        comparisonTable?.rows.first { $0.fundCode == row.fundCode }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                tableSummary
                if table != nil { tableFilters }
                if let message {
                    Label(message, systemImage: "exclamationmark.circle")
                        .font(.footnote).foregroundStyle(.orange)
                        .padding(.horizontal).padding(.bottom, 10)
                }
                if loading && table == nil {
                    Spacer()
                    ProgressView("正在获取额度表").frame(maxWidth: .infinity)
                    Spacer()
                } else if table == nil {
                    ContentUnavailableView("暂无额度表", systemImage: "tablecells",
                        description: Text("发布后会显示在这里，可点击右上角刷新。"))
                } else if rows.isEmpty {
                    if !search.isEmpty {
                        ContentUnavailableView.search(text: search)
                    } else {
                        ContentUnavailableView(filter == .mine ? "暂无匹配的定投" : "暂无明确正数额度",
                            systemImage: filter == .mine ? "list.bullet.rectangle" : "tablecells",
                            description: Text(filter == .mine ? "根据本机定投中已填写的基金代码匹配。" : "有附加条件或待更新的额度请在全部表格中查看。"))
                    }
                } else {
                    // Both sides live inside one vertical scroll. The numeric
                    // side uses one horizontal scroll, so rows cannot drift.
                    GeometryReader { geometry in
                        ScrollViewReader { reader in
                            VStack(spacing: 0) {
                                columnNavigation(reader)
                                ScrollView(.vertical) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        HStack(alignment: .top, spacing: 0) {
                                            VStack(spacing: 0) {
                                                FundIdentityCell(row: nil)
                                                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                                    NavigationLink { detail(for: row) } label: {
                                                        FundIdentityCell(row: row).background(rowBackground(index))
                                                    }
                                                    .buttonStyle(.plain)
                                                }
                                            }
                                            .frame(width: FundIdentityCell.width)
                                            .overlay(alignment: .trailing) { Divider() }
                                            .zIndex(1)

                                            ScrollView(.horizontal) {
                                                VStack(spacing: 0) {
                                                    FundMetricsLine(row: nil, previous: nil)
                                                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                                        NavigationLink { detail(for: row) } label: {
                                                            FundMetricsLine(row: row, previous: previousRow(for: row))
                                                                .background(rowBackground(index))
                                                        }
                                                        .buttonStyle(.plain)
                                                    }
                                                }
                                                .frame(width: FundMetricsLine.width)
                                            }
                                            .frame(width: max(0, geometry.size.width - FundIdentityCell.width),
                                                   height: FundMetricsLine.headerHeight + CGFloat(rows.count) * FundMetricsLine.rowHeight)
                                        }
                                        if let notes = table?.notes, !notes.isEmpty {
                                            VStack(alignment: .leading, spacing: 6) {
                                                ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                                                    Text(note).font(.caption).foregroundStyle(.secondary)
                                                }
                                            }
                                            .padding()
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                    }
                                    .frame(width: geometry.size.width, alignment: .leading)
                                }
                                .refreshable { await load() }
                                .accessibilityIdentifier("dailyFundTable")
                            }
                        }
                    }
                }
            }
            .navigationTitle("纳指额度")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "基金名称或代码")
            .toolbar {
                Button { Task { await load() } } label: {
                    if loading { ProgressView() } else { Label("刷新", systemImage: "arrow.clockwise") }
                }
                .disabled(loading)
                .accessibilityLabel("刷新额度表")
            }
            .task(id: "\(baseURL)|\(refreshID)") { await load() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && !loading { Task { await load() } }
            }
        }
    }

    private var tableSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(table.map { "数据日期 \($0.dataDate)" } ?? "等待发布")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let table { Text(rows.count == table.rows.count ? "\(table.rows.count) 只" : "\(rows.count) / \(table.rows.count) 只")
                    .font(.caption).foregroundStyle(.secondary) }
            }
            if let table, !table.isCurrent() {
                Text("非今日数据，请留意日期。")
                    .font(.caption).foregroundStyle(.orange)
            }
            if table != nil {
                Text("基金名称固定在左侧，横滑查看指标。点击查看详情。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
    }

    private func columnNavigation(_ reader: ScrollViewProxy) -> some View {
        HStack(spacing: 8) {
            Text("查看列").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button("额度") { reader.scrollTo("fund-table-header-column-0", anchor: .leading) }
                .accessibilityLabel("查看费率和额度列")
                .accessibilityIdentifier("showQuotaColumns")
            Button("表现") { reader.scrollTo("fund-table-header-column-4", anchor: .trailing) }
                .accessibilityLabel("查看跟踪误差和近一年列")
                .accessibilityIdentifier("showPerformanceColumns")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.horizontal).padding(.bottom, 8)
    }

    private var tableFilters: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("额度筛选", selection: $filter) {
                ForEach(TableFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("fundTableFilter")
            if filter == .available {
                Text("至少一栏为明确正数额度；部分渠道、脚注条件请在全部中核对。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if filter == .mine && !plansWithoutCode.isEmpty {
                NavigationLink {
                    List(plansWithoutCode) { plan in
                        NavigationLink { PlanDetailView(planID: plan.id) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(plan.fundName)
                                Text("\(plan.channel.title) · 请核对并补充基金代码")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .navigationTitle("补充基金代码")
                } label: {
                    Label("\(plansWithoutCode.count) 笔定投未填代码，点此补充", systemImage: "info.circle")
                        .font(.caption)
                }
                .accessibilityIdentifier("plansMissingFundCode")
            }
        }
        .padding(.horizontal).padding(.bottom, 10)
    }

    private func detail(for row: DailyFundTable.Row) -> some View {
        FundTableDetailView(row: row, previous: previousRow(for: row),
            comparisonDate: comparisonTable?.dataDate, dataDate: table?.dataDate ?? "", notes: table?.notes ?? [])
    }

    private func rowBackground(_ index: Int) -> Color {
        index.isMultiple(of: 2) ? Color(.systemBackground) : Color(.secondarySystemBackground)
    }

    @MainActor private func load() async {
        let currentRequest = UUID()
        requestID = currentRequest
        loading = true
        message = nil
        defer { if requestID == currentRequest { loading = false } }
        do {
            let backend = try PushBackend(baseURL)
            let scope = backend.identityScope
            if loadedBackend != scope {
                table = nil
                comparisonTable = nil
                loadedBackend = scope
                // Corrupt cache cannot prevent a fresh network request.
                let saved = try? cache.loadSnapshot(backend: scope)
                table = saved?.table
                comparisonTable = saved?.comparisonTable
            }
            var request = URLRequest(url: backend.endpoint("api/v1/table"))
            request.timeoutInterval = 15
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let next = try DailyFundTable.decode(data)
            guard requestID == currentRequest, !Task.isCancelled else { return }
            guard !next.rows.isEmpty else { throw DailyTableError.emptyTable }
            do {
                let saved = try cache.save(next, backend: scope)
                table = saved.table
                comparisonTable = saved.comparisonTable
            } catch {
                table = next
                comparisonTable = nil
                message = "额度表已更新，本地缓存保存失败。"
            }
        } catch {
            guard requestID == currentRequest, !Task.isCancelled else { return }
            let prefix = table == nil ? "暂时无法获取额度表。" : "刷新未成功，仍显示上次取得的额度表。"
            message = prefix + (error is DailyTableError ? error.localizedDescription : "请检查网络与设置中的服务地址。")
        }
    }
}

private struct FundIdentityCell: View {
    let row: DailyFundTable.Row?
    static let width: CGFloat = 146

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let row {
                Text(row.shortName).font(.system(size: 13, weight: .medium))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Text(row.fundCode).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            } else {
                Text("基金 / 代码").font(.caption.weight(.semibold))
            }
        }
        .padding(.horizontal, 10)
        .frame(width: Self.width, height: row == nil ? FundMetricsLine.headerHeight : FundMetricsLine.rowHeight, alignment: .leading)
        .background(row == nil ? Color(.secondarySystemBackground) : Color.clear)
        .overlay(alignment: .bottom) { Divider() }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct FundMetricsLine: View {
    let row: DailyFundTable.Row?
    let previous: DailyFundTable.Row?
    static let headerHeight: CGFloat = 40
    static let rowHeight: CGFloat = 82
    private static let widths: [CGFloat] = [76, 110, 110, 90, 90]
    static let width = widths.reduce(0, +)
    private var values: [String] {
        guard let row else { return ["费率", "代销", "直销", "跟踪误差", "近一年"] }
        return [DailyFundTable.display(row.feeRate),
                DailyFundTable.display(row.distributorLimit), DailyFundTable.display(row.directLimit),
                DailyFundTable.display(row.trackingError), DailyFundTable.display(row.return1y)]
    }

    private func change(at index: Int) -> String? {
        guard let row else { return nil }
        switch index {
        case 1: return DailyFundTable.limitChange(from: previous?.distributorLimit, to: row.distributorLimit)
        case 2: return DailyFundTable.limitChange(from: previous?.directLimit, to: row.directLimit)
        default: return nil
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                VStack(spacing: 5) {
                    Text(value)
                        .font(row == nil ? .caption.weight(.semibold) : .system(size: 13))
                        .monospacedDigit()
                        .foregroundStyle(value == "待更新" ? .secondary : .primary)
                        .lineLimit(3)
                    if let change = change(at: index) {
                        Text(change).font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.indigo).monospacedDigit()
                    }
                }
                .multilineTextAlignment(.center)
                .padding(.horizontal, 6)
                .frame(width: Self.widths[index])
                .id("fund-table-\(row?.fundCode ?? "header")-column-\(index)")
            }
        }
        .frame(height: row == nil ? Self.headerHeight : Self.rowHeight)
        .background(row == nil ? Color(.secondarySystemBackground) : Color.clear)
        .overlay(alignment: .bottom) { Divider() }
        .contentShape(Rectangle())
    }
}

private struct FundTableDetailView: View {
    let row: DailyFundTable.Row
    let previous: DailyFundTable.Row?
    let comparisonDate: String?
    let dataDate: String
    let notes: [String]
    @EnvironmentObject private var store: PlanStore
    @Environment(\.openURL) private var openURL
    @State private var actionMessage: String?

    var body: some View {
        List {
            Section {
                Text(row.fundName).font(.headline)
                LabeledContent("基金代码", value: row.fundCode)
                LabeledContent("数据日期", value: dataDate)
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
                    UIPasteboard.general.string = "\(row.fundName) \(row.fundCode)"
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
        }
        .navigationTitle("基金详情")
        .navigationBarTitleDisplayMode(.inline)
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
