import SwiftUI
import NabaoCore

/// Used by both manual entry and screenshot review. Only an explicit tap writes
/// a catalog identity; opening the picker never rewrites an existing draft.
struct FundSelectionFields: View {
    @Binding var name: String
    @Binding var code: String

    var body: some View {
        NavigationLink {
            FundPickerView(selectedCode: code) { fund in
                name = fund.name
                code = fund.code
            }
        } label: {
            Label("从基金目录选择", systemImage: "magnifyingglass")
        }
        .accessibilityIdentifier("chooseCatalogFund")
        TextField("基金名称", text: $name, axis: .vertical)
            .accessibilityIdentifier("planFundName")
        TextField("基金代码（可选，六位）", text: $code)
            .keyboardType(.numberPad)
            .accessibilityIdentifier("planFundCode")
        if let fund = FundCatalog.fund(code: code) {
            Text("代码对应：\(fund.name) · \(fund.shareDescription)")
                .font(.caption).foregroundStyle(.secondary)
            if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !FundCatalog.name(name, matches: fund) {
                Text("名称中的公司或份额与当前代码不一致，可从目录重新选择。")
                    .font(.caption).foregroundStyle(.orange)
            }
        } else {
            Text("目录含 41 个纳指100份额。目录外基金可手填，代码不确定时可暂时留空。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct FundPickerView: View {
    let selectedCode: String
    let select: (FundCatalog.Fund) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    private var funds: [FundCatalog.Fund] { FundCatalog.search(query) }

    var body: some View {
        List {
            Section {
                Text("输入公司和份额即可，例如“南方 I”；也可搜索名称或代码。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if funds.isEmpty {
                ContentUnavailableView("目录中没有匹配基金", systemImage: "magnifyingglass",
                    description: Text("试试公司简称和份额，例如“南方 I”；也可以返回手动填写。"))
            } else {
                ForEach(funds) { fund in
                    Button {
                        select(fund)
                        dismiss()
                    } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(fund.name).foregroundStyle(.primary)
                                Text("\(fund.code) · \(fund.shareDescription)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if selectedCode == fund.code {
                                Image(systemName: "checkmark").accessibilityLabel("当前代码")
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .accessibilityIdentifier("catalogFund-\(fund.code)")
                }
            }
        }
        .navigationTitle("选择基金")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "公司和份额，如南方 I；或六位代码")
        .accessibilityIdentifier("fundCatalogPicker")
    }
}
