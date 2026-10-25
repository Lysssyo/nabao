# nabao iOS

SwiftUI iPhone App，最低 iOS 17。`App/` 按入口、功能页面、服务和共享界面划分；`NabaoCore` 提供可独立测试的业务规则、协议及共用数据服务。真机准备见 [iPhone 快速上手](../docs/iphone-quickstart.md)。

## 代码结构

- `App/Entry/`：App 依赖组装、生命周期和通知导航。
- `App/Features/Plans/`：定投列表、详情、导入确认及编辑草稿。
- `App/Features/Quotas/`：额度列表、基金详情和表格单元格。
- `App/Features/Settings/`：设置、备份选择和恢复预览界面。
- `App/Services/`：计划持久化、照片读取与 Vision、备份文件访问、本地提醒、远程通知和剪贴板等系统交互。
- `App/Shared/`：跨功能复用的基金选择界面。
- `NabaoCore/`：基金身份、金额与截图文本规则、备份编解码与合并、额度展示排序、共享额度 Store/缓存及匿名通知 HTTP 协议。

View 只组织显示、交互和草稿，调用 Store/服务执行读取与保存；不直接访问文件、Photos 数据、通知中心或 HTTP。系统文件选择器和 `openURL` 等界面动作仍留在 View。App 共用一个 `DailyTableStore`；IO 失败、后端切换和旧响应隔离由数据层处理。未引入通用仓储框架或为每页添加一层透传 ViewModel。

额度列表在搜索和筛选后按代销额度排序：不限额；明确正金额从高到低；带条件额度（单一可确认金额从高到低，范围、合并、多个数字等保留原序）；暂停/零；无/不可用；待更新/未知。同值保留原表顺序。千、万与人民币单位仅用于排序，原文和条件不改写；“有额度”筛选与本机计划匹配规则不变。页面显示投票采用值，缺失项统一为“待更新”。

## 当前功能

- 首次连接引导支持“连接并开始”和“稍后设置”。设置中的“测试连接”读取实际公开额度接口，显示数据日期与份额数；“保存地址”可离线完成。测试不会改变当前服务或缓存，修改输入后旧请求不能显示成功。真机拒绝把回环地址当成Mac服务，未配置时可先使用本地计划。
- 定投首页显示全部计划数、进行中数量和额度变化数量；金额只合计进行中的计划，按原执行周期分别展示，先日、再周、再月，不折算月投入。暂停、终止和待确认计划不计入合计。同基金的不同计划分别保留，点击变化数量可筛选对应计划；无比较快照时显示“—”。
- 额度页压缩顶部信息和间距，默认行高72点、表头34点；行高和字体随系统文字大小缩放，两侧保持一致。固定基金列、横滑、投票值、代销降序及条件文字继续保留。
- 定投列表、手动新增、编辑、状态确认及删除本地记录。
- 新增、编辑和截图确认都可从本机41份额目录选择基金；支持名称、六位代码、份额和币种检索。明确点选才填入名称和代码，目录外仍可手填，已有记录不静默回填。
- 计划详情按精确代码关联公开额度、数据日期和已确认变化，可刷新并进入基金详情；三个页面共用按后端隔离的缓存和比较快照，公开额度不会自动修改计划。
- PhotosPicker 批量选图，Vision 在本机 OCR，适配支付宝“投资计划”和南方基金“我的定投”两种版式。
- 导入确认中编辑名称、基金代码、渠道、金额、周期、下次执行日期和状态；支持只保留部分识别结果。
- 原图不落盘、不上传；SHA-256 图片指纹识别完全重复图片并显示提示。不会按基金名和金额合并计划。
- 记录以原子 JSON 文件保存在 Application Support，读取异常时保留原文件并阻止覆盖。设置中可导出、恢复版本化JSON备份，无账号或自动计划云同步。
- `GET /api/v1/table` 读取服务端发布的每日纳指额度表。按代码、基金名称、费率、代销、直销、跟踪误差、近一年顺序展示，可横向滚动并按名称或代码搜索。
- 额度页只展示发布结果及数据日期；点击行进入基金详情，保留已验证的渠道入口和本机同基金计划导航。
- 刷新显示进行中状态及完成时间（精确到秒）；表格内容相同时显示“已刷新，内容无变化”。请求总时限15秒，失败保留旧表并提供连接设置入口。刷新时间与表格数据日期分别显示，刷新不会发起服务端采集；未配置地址时点击刷新进入连接引导。
- 上次成功取得的非空表以原子 JSON 缓存在本机。网络失败、空响应或格式错误不会覆盖旧表；日期始终来自表文件，非今日数据明确标注。切换服务地址不会复用另一个服务的缓存。
- 未提供的费率、误差和近一年等字段显示 `待更新`，`无`、`暂停`、`部分渠道100` 等原始额度文字分别保留。表格不会直接将代销参考等同于某一渠道的个人定投状态。
- 设置中配置后端地址、每日本地提醒、5 秒测试通知。通知支持前台展示，点击后打开额度页并刷新；App 回到前台也会刷新额度。
- 额度变化远程通知使用匿名安装身份和 APNs token 登记，不上传个人计划或截图。后端明确就绪且 APNs 环境匹配后才可开启；关闭结果未知时保留退订凭据和关闭意图，不会在重启时自动再次登记。
- 支付宝基金 `016452`、`016453`、`019172`、`539001` 使用精确公开产品映射打开基金详情，具体真机验证范围见下表。管理路径仍为“详情 → 定投中 → 选择计划 → 管理”，后续操作由用户完成。
- 南方基金计划可打开“我的定投”，选择对应计划查看详情及管理；`021000` 另外提供产品详情入口，供核对直销额度、定投和购买条件。其他基金或渠道保留名称/代码复制入口。

本地定时通知不会后台抓取额度。远程通知代码已接入，真实 APNs 投递需要开发者账号与签名配置，尚未验收。Share Extension、跨渠道汇总额度和目录外的在线基金主数据搜索尚未接入。截图未显示代码时，已核对的摩根 A、建信 A、南方 A/C/I 精确名称可本地补全代码；OCR 将 `1` 推测成 `I` 时仍须确认，不会自动填入代码。已有记录不静默回填。

## 计划备份与恢复

设置 → 计划备份与恢复。备份只包含计划和图片指纹；截图原图、后端地址、通知身份与凭据不在其中。用户通过系统文件选择器决定保存位置，App不上传备份。

无需云盘即可选择“我的 iPhone → nabao → 备份”。Files只开放用户保存文件的Documents目录；运行中的计划仍在Application Support，通知凭据仍在Keychain。默认文件名采用设备本地日期。

导入先检查格式、版本、大小（5 MiB）、记录数量（5,000）、图片指纹和计划字段，再展示新增、相同和冲突记录。按UUID识别，同名同金额的不同计划分别保留；冲突默认保留本机内容，可逐条明确替换。确认前检查本机快照是否变化，原子写入成功才更新内存。重复恢复不重复添加，失败不覆盖原文件；旧版长文本和多行名称原样兼容。

`sh ios/verify-plan-backup.sh` 编译实际 App `PlanStore` 并在临时目录验证恢复、重载、冲突、预览过期及写入失败。它不操作模拟器或真实用户文件。

`sh ios/verify-push-settings.sh` 编译实际 App `RemotePushStore`，通过内存替身验证慢通知检查期间保存地址、旧响应隔离、旧订阅清理、重复保存、钥匙串读取失败与未配置 APNs 的路径。它不读取真实钥匙串，不访问网络或设备。

设置页顶部的“后端连接”可直接修改地址；后台通知检查不会禁用保存。首页右上角 ＋ 提供“手动新增”和“从截图导入”，识别后的核对与重复截图检查保持不变。

## 构建与测试

2026-10-25 体验优化回归：93项核心测试、8项实际通知设置状态机检查通过，独立iPhone 17模拟器构建通过。模拟器已验证首次连接、接口成功状态、计划周期汇总及变化筛选、紧凑额度表与横向列切换。测试使用独立Bundle ID、合成计划及比较快照；未操作真机、未修改后端。日志、截图和逐项记录位于 `.local/ios-usability/2026-10-25/`。

打开 `Nabao.xcodeproj`，选择 `Nabao` scheme 和 iPhone 模拟器。模拟器构建无需 Apple Developer 账号：

```sh
xcodebuild -project ios/Nabao.xcodeproj -scheme Nabao \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build

swift test --package-path ios/NabaoCore
```

核心测试覆盖取错累计金额、缺失金额串到下一条、截断行、同名计划、I/1 份额歧义、金额溢出，以及申购/代销/过期数据不误判定投等反例。

实际运行模拟器并调试 Keychain 通知身份时，使用 Xcode 本地 ad-hoc 签名，无需开发者账号：

```sh
xcodebuild -project ios/Nabao.xcodeproj -scheme Nabao \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath ios/DerivedData \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES build
```

选择本机已有的模拟器名称。Xcode 自动生成模拟器 application identifier；这不会加入 APNs entitlement。`CODE_SIGNING_ALLOWED=NO` 仍适合 CI 编译检查，但实际运行时可能使 Keychain 返回 -34018；不要因此删除旧身份或改用明文存储。

私有样例图放在根目录被忽略的 `.local/screenshot-samples/`。如文件存在，可运行真实 Vision 验证：

```sh
swift run --package-path ios/NabaoCore VerifyScreenshots \
  .local/screenshot-samples/alipay-1.jpg \
  .local/screenshot-samples/alipay-2.jpg \
  .local/screenshot-samples/southern-1.jpg
```

该命令只输出计划字段，不输出支付账户，也不上传图片。按上述三图顺序校验完整计划数量为 2、2、1。

## 本地联调

模拟器默认读取 `http://127.0.0.1:18081`。真机首次安装不预填回环地址，通过首次引导或“设置 → 服务地址”填写Mac局域网地址（本机示例 `http://Admin.local:18081`），并允许系统本地网络访问。已保存的地址保留，不自动改写；曾保存回环地址的真机可通过引导重新配置。个人计划不发送给该接口。

当前 bundle identifier 为 `com.example.nabao`，签名 Team 未配置。默认模拟器构建没有 APNs 环境，在设置中明确展示远程通知暂不可用；本地提醒仍可用。真机签名、正式 bundle ID 和实际 APNs 投递在开发者账号准备后验收。

## 已验证与待验证（2026-10-20）

已验证：

- Xcode 27.1 通用 iOS 模拟器构建成功，`CODE_SIGNING_ALLOWED=NO`。
- iPhone 17 / iOS 27.0 模拟器通过 `simctl` 安装并启动，使用 Xcode 27 的 `DeviceHub.app` 图形界面完成真实页面操作。
- 系统 PhotosPicker 多选三张用户截图，App 内 Vision 识别、确认、保存共 5 笔（支付宝 4 笔、南方基金 1 笔）。两笔同名摩根计划各有独立 ID，强退重启后恢复；本地文件包含 3 个图片指纹，没有支付账户字段。
- 系统权限弹窗授权后，5 秒本地通知在前台实际显示，并可从通知中心点击进入额度页。每日提醒的开启和关闭已验证。点击通知后从本地开发后端成功获取真实空列表，页面展示“暂无已发布额度”。
- Swift Package 25 条测试通过，包括严格定投判断与独立核对提示的来源、日期、渠道和状态边界。
- 用 App 相同的 Swift DTO 解码真实开发服务的 HTTP 200 空列表，以及后端隔离测试生成的非空响应（2 个 votes、微秒时间）。后者仅为测试夹具，没有写入开发库。
- 用户提供的三张截图经 macOS Vision + 实际解析器运行得到 2/2/1 条完整计划。同名、同金额的两条计划分别保留；已逐条核对金额、周期和日期正确。
- 南方截图的 I 被 Vision 识别为 1，解析结果保留显式核对提示；这不是全量截图准确率结论。

Xcode 27 的设备图形界面位于 `/Applications/Xcode.app/Contents/Applications/DeviceHub.app`。Debug 配置使用 `ONLY_ACTIVE_ARCH=YES`，避免指定 arm64 模拟器时 App 与本地 Swift Package 编译架构不一致。

待验证：

- iOS 真机照片选择、权限拒绝、更多长截图和不同字号。
- nabao 自身跳出到渠道 App 的实际落地页面、未安装/未登录场景；京东业务直达。已完成的外部 HTTPS 链接真机核对见下表。
- 本地通知在真实 iPhone 上的展示与权限回归；APNs 真实登记、系统投递及关闭回归。
- 上线前的应用图标、完整隐私披露、签名及真实设备兼容性。

## 真实额度与渠道入口联调

最新构建已从本地 8080 取得两位作者的真实额度，核对南方 A/I 的直销、代销、两位来源及未知口径提示；原有 5 笔计划文件保持不变。证据在 `.local/ios-validation/quotas-live-verification.json`。

额度卡现提供同基金本机计划的详情入口、已验证的 016452 支付宝核对入口，以及基金名称/代码复制。最新编译和覆盖安装通过，复制按钮在真实数据页面显示正常；新增本机详情导航与支付宝按钮的最后点击回归因 Mac 锁定未完成，未尝试解锁绕过。此前验证的公开链接与映射没有改变。

随后增加的“暂停／0 额度建议核对”已通过核心规则测试和编译检查；Mac 仍锁定，本轮没有继续 UI 操作，该提示尚未进行模拟器点击回归。它只说明公开参考需要到渠道核对，不代表已有定投已失效。

## 渠道链接核对（2026-10-21）

公开映射核对与真机导航是两项独立证据。当前精确白名单如下；公开产品 ID 的存在不等于可申购，也不等于已验证所有后续页面。

| 渠道 / 基金 | 公开映射或路由 | 真机导航验证 |
| --- | --- | --- |
| 支付宝 南方 A `016452` | fund123 基金身份及 productId 已核对 | 此前已验证基金详情、买入入口与定投管理路径 |
| 支付宝 摩根 A `019172` | fund123 基金身份及 productId 已核对 | 本轮已到正确详情、定投中、两笔计划列表、计划详情及修改/暂停/终止菜单；取消菜单，未更改计划 |
| 支付宝 建信 A `539001` | fund123 基金身份及 productId 已核对 | 本轮已到正确详情和空白买入金额表单；未提交 |
| 支付宝 南方 C `016453` | fund123 基金身份及 productId 已核对 | 本轮真机导航尚待验证 |
| 南方基金 我的定投 | HTTPS `MyInvestment` 桥接 | 用户本人登录后直接到“我的定投”，已进入计划详情并看到修改/暂停/终止入口；未操作 |
| 南方基金 南方 I `021000` | HTTPS `FundsDetails` 桥接及精确 fundcode | 本轮已到正确产品详情，定投/购买入口可见；购买填写页尚待核对 |

支付宝 I 份额 `021000` 不提供入口。南方基金产品详情只接入已实测的 `021000`，没有按参数规律扩展到其他份额。京东具体业务路由未接入。

这些记录描述外部 HTTPS 链接在真机上的落地结果，不代替 nabao 自身的真机签名、跳出和未安装/未登录回归。代码保留支付宝的两层查询参数编码，语义测试逐基金解码到相应 productId，并拒绝未知或格式异常的基金代码。

本轮 29 条 Swift 测试通过，iPhone 17 模拟器构建、覆盖安装和进程启动通过；安装前后 5 笔计划文件的 SHA-256 完全一致。本轮没有操作 CUA 或用户其他 App。测试、构建与安装记录分别保存于 `.local/ios-validation/channel-links-swift-tests-2026-10-21.log`、`channel-links-xcodebuild-2026-10-21.log`、`channel-links-install-2026-10-21.json`。

## 匿名远程通知（2026-10-21）

`PushHTTPClient` 是 App 和 `VerifyPushClient` 共用的客户端，调用健康检查、匿名登记和注销接口。它不使用 Cookie、凭据缓存或 URL 缓存，拒绝 HTTP 重定向，不会把安装 secret 转发到新地址。每个规范化后端地址对应独立的 Keychain 身份；登记请求发出之前保存“可能已登记”，网络超时后仍可注销。

设置操作整体串行执行，APNs token 回调在当前操作结束后处理。退出意图在 DELETE 前保存，即使注销失败并重启也不会自动重新登记；只有确认旧订阅已关闭后才保存新的后端地址。本地提醒与远程订阅分别控制。

启用签名构建时：

1. 复制 `PushSigning.xcconfig.example` 为 `PushSigning.xcconfig`，复制 `App/NabaoPush.entitlements.example` 为 `App/NabaoPush.entitlements`；两个实际配置文件都已忽略。
2. 在本地 xcconfig 配置真实 `PRODUCT_BUNDLE_IDENTIFIER`、`DEVELOPMENT_TEAM`，并让 Apple App ID 和 provisioning profile 具有 Push Notifications 能力。后端 APNs topic 必须与 bundle ID 一致。
3. 开发签名使用 `NABAO_APNS_ENVIRONMENT = development`，分发/TestFlight 使用 `production`；该值同时写入 entitlement 和 Info.plist。后端对应 `sandbox` / `production`。
4. 使用 `xcodebuild -project ios/Nabao.xcodeproj -scheme Nabao -xcconfig ios/PushSigning.xcconfig ...` 明确选中本地配置，或在 Xcode 里配置对应构建设置。样板不会自动开启签名，不能把改 Info.plist 当成已取得 APNs 权限。

只使用可见通知，点击 `screen=quotas` 后打开额度页并刷新，没有添加 silent push 或后台轮询模式。隐私清单将匿名安装标识与 APNs token 归入 Device ID / App Functionality，Linked=true、Tracking=false；这些标识用于维护同一设备的订阅，既有个人计划和截图仍不上传。

本轮核心包 43 项测试通过，覆盖匿名字段、关闭意图跨重启、未知请求结果、token 轮换和 HTTP 契约。iPhone 17 模拟器 unsigned 构建、覆盖安装和进程启动通过；安装前后 5 笔计划、3 个图片指纹文件的 SHA-256 相同，打包后 APNs 环境为空。日志与记录分别为 `.local/ios-validation/push-swift-tests-2026-10-21.log`、`push-xcodebuild-2026-10-21.log`、`push-install-2026-10-21.json`。真实 APNs 接入与投递不属于该验证结果；本轮未操作真实 iPhone。

随后完成实际本地链路：共用 Swift 客户端登记/退订、Java 后端向模拟 APNs 发送、503 后重启持久重试均通过。服务端生成的 `notification.apns` 注入模拟器后，前台通知显示、后台与冷启动点击进入额度页并刷新均通过。最终安装采用上述 ad-hoc 签名，Keychain 读取正常，界面准确显示当前尚未配置 APNs；原计划文件摘要保持一致。记录见 `.local/push-validation/run-lg2ljjpq/results.json`、`.local/ios-validation/push-ui-verification-2026-10-21.json` 和 `push-adhoc-install-2026-10-21.json`。复现脚本见 `docs/development.md`。

## 每日额度表（2026-10-21）

额度页已切换到 `GET /api/v1/table`，通知点击仍沿用 `quotaRefreshID` 触发刷新。接口版本为 1，包含 `dataDate`、`updatedAt`、`source` 和 `rows`；每行以六位基金代码为唯一标识。无效日期、重复代码、不支持的版本均拒绝替换当前表。公开表缓存独立于 `plans.json`，不会改写个人定投。

本轮 49 项 Swift 测试通过，iPhone 17 ad-hoc 签名构建通过。测试包括发布日期的上海时区边界、缺失指标、特殊额度文字、搜索、坏数据拒绝、空更新保留旧缓存和后端地址隔离。日志为 `.local/ios-validation/daily-table-swift-tests-2026-10-21.log`、`daily-table-xcodebuild-2026-10-21.log`。真实当天表的联网加载与 UI 展示需随采集发布完成后验收，编译结果不代表已拿到当天数据。

## 表格浏览与本机额度变化（2026-10-21）

基金简称和代码固定在左侧，五项数据列统一横向滚动，两侧共用一个纵向滚动容器。表格上方的“额度／表现”按钮可直接定位前后数据列，支持辅助功能操作。新增“全部／有额度／我的定投”筛选：有额度只计明确正数，保留原表的部分渠道及脚注条件；我的定投仅按已填写代码匹配，缺代码提供补充入口，不修改个人记录。未确定字段显示“待更新”，客户端只消费发布表。

本地公开表缓存增加前次额度对比表，旧缓存自动兼容。仅明确数值或暂停状态之间的变化显示 `10 → 5`；未知或带条件值不推断变化，日期和收益更新不重置对比，重启保留标记。详情说明对比日期。公开说明最多 30 条、每条 2000 UTF-16 字符，与文件和后端契约一致。57 项 Swift 测试和 iPhone 17 ad-hoc 构建通过，覆盖筛选边界、无代码不猜匹配、变化语义、缓存迁移及说明长度边界。日志位于 `.local/ios-validation/five-source-table-*.log`，此处构建结果不代表模拟器 UI 已验收。
