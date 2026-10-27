# 第一版边界与接口约定

项目名 nabao。代码分为 `ios/`、`backend/`、`collector/` 和 `frontend/`。

## 已确认的边界

- 不做用户账号和计划云同步。个人定投、截图和个性化影响判断保存在 iOS 本地。
- 额度主流程为每日文件表；已配置作者按基金、当天数据与字段分别投票。匿名设备通知只订阅公开额度变化，不上传个人计划或金额。
- 后端自动发现指定作者的新笔记及修改，正常路径不依赖每日人工录入。专用登录会话下已验证单轮自动采集；长期稳定性与服务器环境另行验证。
- 模型 API 尚未配置时，状态必须明确为未配置；不生成伪造结果或声称没有变化。
- Apple 开发者账号后补；已实现匿名注册、APNs 签名、发送及持久重试。本地假 APNs 与模拟器验证不等于 Apple 接受或真机送达。
- 新表每作者每字段最多一票，单一有效来源直接采用，多来源按唯一最高票采用，平票待更新；明细写入私有报告和后端投票日志表，iOS不感知。旧观察 API 仅保留兼容，不驱动当前表格。
- 业务类型未知不能当作定投限制；代销不能宣称具体渠道已核实；`无`、`暂停`、`部分渠道`不能都映射为零。
- 截图中的同名、同金额计划可以是不同记录；精确重复图片可以识别，不能静默按基金去重。
- 用户原始截图仅放在被 Git 忽略的 `.local/`，不提交或发送给外部模型。

## HTTP

当前 iOS 使用 `GET /api/v1/table`，从 `NABAO_TABLE_FILE` 只读文件；无文件404，文件无效503，不回退到数据库旧值。格式为：

```json
{
  "schemaVersion": 1,
  "dataDate": "2026-10-21",
  "updatedAt": "2026-10-21T14:00:00Z",
  "source": {"name": "来源名称", "url": "公开笔记链接", "publishedAt": "2026-10-21T01:00:00Z"},
  "rows": [{"fundCode": "六位代码", "fundName": "基金名称", "feeRate": null,
    "distributorLimit": "原表值", "directLimit": "原表值", "trackingError": null, "return1y": null}],
  "notes": ["原表脚注"]
}
```

示例仅说明字段，不是可发布数据。发布器校验41份额；百分比未知为null，额度未知为待更新，业务脚注保留原意。notes最多30条、每条2000 UTF-16字符。采集过程、AI输出、票数不进入该接口。推送仅监测已确认直代销额度/状态变化；日期、费率、收益变化不提醒；未知或带附加条件的值不清除旧确认基线。文件缺失/损坏跳过判断。匿名设备登记仍沿用独立存储，额度文件流程不写观察数据库。

### 每日表状态与管理

- `GET /api/v1/readiness`：表文件可读且校验通过返回200，体为 `{status:"READY",table:{status:"AVAILABLE",dataDate,updatedAt}}`；缺失或无效返回503，`status:"NOT_READY"`、表状态 `MISSING` / `INVALID`。此接口检查可读性，不宣称数据今天已更新或采集常驻正常。
- `GET /internal/v1/table-status`：使用 `X-Internal-Key`，未配置503、错误/缺失401。返回实际公开表及独立安全摘要，均为 `Cache-Control: no-store`。Vue管理端使用此接口展示当前额度投票结果；不提供历史任务、旧额度或旧来源页面。
- 原 `/api/v1/health` 保留服务/数据库/推送配置状态契约。表缺失不阻断设备注册或凭证正确的退订，也不会把推送配置状态改写为表状态。

管理响应字段：`tableState`（AVAILABLE/MISSING/INVALID）、`table`（实际每日表或null）、`summaryState`（AVAILABLE/MISSING/INVALID/STALE/INCONSISTENT）、`stale`、`staleAfterSeconds` 与 `summary`（安全摘要或null）。缺失/损坏的状态文件不隐藏有效表；摘要与表的原始字节SHA256、日期、更新时间或统计不一致时 `summary=null`，避免拼接旧来源状态和新表。

安全摘要版本1仅允许：

| 字段 | 含义 |
| --- | --- |
| schemaVersion | 固定1 |
| lastAttempt / lastSuccess | 最后检查开始/最后成功核验或发布时间；后者允许null，失败不得刷新 |
| attemptedDate | 本轮目标表日期，与当前发布日分开 |
| status / errorCode | 白名单状态及安全错误码，不返回原始错误消息 |
| published | 当前表dataDate、updatedAt、digest（SHA256）、rowCount、adoptedFields、pendingFields；无有效文件为null |
| sources | 本轮名单快照，0～50个唯一authorId；每项为authorId、name（旧摘要可缺省）、status、rowCount、errorCode |

每行五个统计字段，非null指标和非“待更新”额度计为采用；含明确条件的已展示值也计入。下一天无新表时，已发布表仍保留其自身日期/统计。后端从固定 `NABAO_STATUS_FILE` 读取不超过64KiB的普通文件，拒绝符号链接、重复/额外字段、无效日期/时间、超过当前5分钟的时间和未知码；不接受请求传入文件路径。`NABAO_STATUS_STALE_SECONDS` 默认43200且最小60，以lastAttempt判断状态陈旧。lastSuccess可以晚于本轮开始时间，不能用开始时间作为成功完成的上限。

Compose专用 `status-data` 卷仅存安全摘要，后端只读挂载；私有 `collector-data` 不共享给后端。摘要原子发布为0644，私有状态保持0600。原文、图片、笔记ID、私有路径、模型结果、token、cookie与签名链接均不属于摘要字段。摘要写入失败不能改变已完成发布的结果。

### 采集控制、作者管理与本人账号登录

Java提供 `/internal/v1/collector` 系列接口，统一要求 `X-Internal-Key` 并返回 `no-store`：

| 方法与路径后缀 | 行为 |
| --- | --- |
| `GET /`（前缀本身） | 当前采集、会话、登录任务和定时状态 |
| `POST /runs` | 202启动当前配置作者的真实采集，完成后页面重读投票表 |
| `POST /authors` | 昵称与主页链接新增作者，201返回完整状态 |
| `DELETE /authors/{id}` | 移除作者，200返回完整状态 |
| `POST /login` | 202创建隔离登录任务，显示正常小红书登录页 |
| `GET /login/preview` | 返回鉴权PNG预览，不在URL中传递密钥 |
| `POST /login/complete` | 校验实际登录证据，通过后保存会话；未完成返回409 |
| `DELETE /login` | 取消登录，保留原正式会话 |
| `POST /session/check` | 202异步检查已保存会话 |

状态包含 `available`、`busy`、`session`、`run`、`schedule`、`login` 和当前作者 `sources`（id、name、profileUrl）。单个操作只代理固定内部路径，不接受命令、代理目标或文件路径。重复任务返回409，控制服务不可用返回503。单次代理完整响应最多55秒，JSON最大128KiB、PNG最大2MiB；不返回上游原始错误、Cookie或密钥。

新增请求仅含 `{name, profileUrl}`，最多4KiB。昵称去除首尾空白后1～80字符；主页须为 `https://www.xiaohongshu.com/user/profile/<24位十六进制ID>`，可粘贴带查询参数的主页，保存时去除参数。禁止凭据、端口和其他域名，不支持短链接。名单最多50位，允许空名单用于维护，至少1位即可采集。格式错误400、作者不存在404、重复或服务忙409。配置原子保存于采集器私有目录，重启保留；增删本身不访问小红书或触发采集。历史摘要继续保留当轮作者名单。

`restricted` 表示小红书返回访问限制或安全验证页，不等于登录失效或等待扫码；没有可见二维码不提示用户扫码。控制服务默认每360分钟检查一次，手动采集、定时采集和登录互斥。没有新数据时保留已发布文件和真实表日期。

### 既有兼容接口

以下观察接口为既有兼容接口，匿名设备和健康接口继续供主流程使用。

统一前缀 `/api/v1`。列表使用 `{"items": [...]}`。

- `GET /api/v1/health`：服务状态与推送配置状态；模型由采集器管理。
- `GET /api/v1/sources`：公开来源配置。
- `GET /api/v1/quotas?fundCode=016452`：参考额度及一致性状态。没有数据返回空列表。
- `POST /api/v1/push-devices`：匿名安装注册或刷新 APNs token，不使用采集器密钥。
- `DELETE /api/v1/push-devices/{installationId}`：使用 `X-Installation-Key` 退订，成功返回 204，可重复调用。
- `POST /internal/v1/note-snapshots`：自动发布当前笔记中可明确核对的观察集合，支持删除旧行和幂等。请求失败、缺图、全不可解析不会变成空快照。来源不确定行不投票，报告保持 partial。
- `POST /internal/v1/observations`：兼容诊断用观察批次，体为 `{"items": [...]}`；已使用完整快照的笔记不能绕回行批次接口。
- `PUT /internal/v1/runs/{runId}`、`GET /internal/v1/runs`、`GET /internal/v1/runs/{runId}`：旧流程上传、查看任务摘要。所有内部接口使用 `X-Internal-Key`；当前管理页不请求这些接口。

完整字段示例见 `backend/README.md`。

候选观察字段：

| 字段 | 类型/口径 |
| --- | --- |
| authorId | 稳定作者 ID |
| noteId | 笔记 ID |
| noteRevision | 发布版本哈希：原始内容版本、模型/提示词和校验后的观察集合共同决定；原始内容摘要另保留在 capture/publication 证据中 |
| fundCode | 六位字符串；不确定时不提交 |
| fundName | 原始名称或确认后的名称 |
| channelScope | DIRECT / DISTRIBUTOR / PARTIAL / UNSPECIFIED |
| businessType | PURCHASE / DCA / UNSPECIFIED |
| period | DAILY / PER_ORDER / UNSPECIFIED |
| limitKind | LIMITED / PAUSED / UNAVAILABLE / UNLIMITED / UNKNOWN |
| amountMinor | 非负整数或 null；仅 LIMITED 必须有值，不能用 0 代表暂停 |
| currency | CNY / USD / UNSPECIFIED |
| observedForDate | 作者明确的数据日期，YYYY-MM-DD |
| sourcePublishedAt | 原笔记发布时间，带时区 ISO-8601；缺失时进入待核验，不自动提交 |
| sourceUpdatedAt | 原笔记明确的修改时间，可为 null |
| capturedAt | 本次完整采集的时间，带时区 ISO-8601；不能当作业务数据日期 |
| evidenceRef | 原始笔记链接/证据位置 |
| sourceGroupId | 可选；明确同源转载归组，不额外增加票数；完整图片摘要集合相同的笔记自动归组 |

额度结果保留以上口径字段，并增加 `status`（AGREED / CONFLICT / INSUFFICIENT）、`supportCount`、`sourceCount`、`votes` 和 `updatedAt`。冲突不得伪造一个统一数值；投票先按同一天、同基金、同渠道范围、同业务类型、同周期、同币种归组，每作者每组仅采用其最新观察。新旧顺序先按 `sourceUpdatedAt ?? sourcePublishedAt`，相同时再按 `capturedAt`；重试接收时间不能改变业务顺序。缺少定投/周期等信息的观察只能形成相同未知口径的参考信息。

`votes` 是对象列表，每项包含 `authorId`、`noteId`、`noteRevision`、`limitKind`、`amountMinor`、`evidenceRef`、`counted`（boolean）及 `sourceGroupId`（nullable）。`updatedAt` 为当前存活观察的接收时间（撤销后可能倒退，不能用作增量游标），统一 UTC ISO-8601，例如 `2026-10-20T12:00:00Z`。未形成一致参考值时，结果顶层 `limitKind` 和 `amountMinor` 为 null，原始值仍在 votes 中。

## 匿名远程推送

注册请求仅包含以下字段，未知字段返回 400：

| 字段 | 类型/口径 |
| --- | --- |
| installationId | iOS 本地生成的 UUID；服务端统一为小写 |
| installationSecret | iOS 随机生成并本地保存；32–256 个字符，字符集为字母、数字及 `_+/=-`；服务端只保存带安装 ID 的 SHA-256 摘要 |
| token | 系统注册回调给出的 APNs token，编码为 32–512 个小写十六进制字符且长度为偶数；不能用模拟值注册生产环境 |
| environment | `sandbox` 或 `production`，与 App 签名配置和服务端环境一致 |

注册响应：`installationId`、`status: REGISTERED`、`deliveryEnabled`（boolean）、`providerStatus` 和 `environment`。`REGISTERED` 只表示安装记录已保存；只有提供方已就绪、环境一致且 token 未失效时，`deliveryEnabled` 才为 true。

`providerStatus` 使用 `DISABLED`、`NOT_CONFIGURED`、`INVALID_CONFIGURATION`、`READY` 或 `ENVIRONMENT_MISMATCH`。健康接口的 `push` 对象为 `{status, enabled, environment}`；未配置有效环境时 `environment` 为 null，健康接口不会返回 `ENVIRONMENT_MISMATCH`，因为该状态需要与具体安装比较。`READY` 仅说明本地配置可用，不代表 Apple 验证过凭据或通知已送达。

已有安装的 token 更新及退订必须携带同一安装密钥；错误密钥返回 401。`environment + token` 在数据库中唯一；跨安装重复认领返回 409，不会同时向同一 token 推送。原安装退订或换 token 后释放归属。退订不需要公共采集接口的 `X-Internal-Key`。

每次成功刷新注册都增加 token 版本；不同 token 或失效 token 的重新注册会恢复发送资格。同 token 的正常重复注册保留已有基线和重试期限。旧请求的完成结果只能更新其对应版本，不能覆盖更新后的 token。410 或 `BadDeviceToken` 使 token 失效；410 时间早于最新注册时间时按过期响应退避重试。

每个安装首次对应非空额度集合时建立基线，不发送历史额度提醒。此后只比较基金、渠道、业务、周期、币种、数据日期、一致性状态及额度等业务值；仅证据链接或采集时间变化不重复通知。每个安装保存已接受摘要、待发送摘要和下次重试时间，重启后保留。新的额度结果替换旧待发送内容；恢复为已确认的额度结果时取消未发送变化。

每轮每台设备最多请求一次。网络错误、429 和服务端错误按 60、120、240、480、960 秒重试，此后每小时重试；`Retry-After` 可延长前期等待，最长采用一小时。其他提供方拒绝也每小时重试。只有 APNs 返回 200 才记为提供方已接受，不能据此宣称用户已收到；次数上限不删除待发送状态。当前调度器按单后端实例运行，多实例不能直接同时开启。

通知载荷仅为通用公开额度更新提示和 `screen: quotas`，不含用户定投、金额或截图。客户端点击后刷新公开额度并在本地判断计划影响；通知本身不判定用户定投已失败，也不执行交易或关闭计划。退订删除服务端记录，停止后续请求；已经在途或被 APNs 接受的通知仍可能送达。

APNs 使用 HTTP/2、ES256 和明确的 bundle topic，默认关闭。签名私钥由运行时只读文件提供，不进入 Git 或 Docker 镜像。`APNS_TEST_ENDPOINT` 只在 `test` profile 下允许数字 loopback 的 HTTP 根地址，不接收域名、用户信息、查询或片段。`scripts/push-smoke.py` 使用随机测试身份、临时数据库及临时签名密钥，结果明确标记 `realAppleContacted: false`；CI 执行相同本地验证，不依赖 Apple 账号。

## 初始公开来源

- 老纳：`6168030000000000020278b5`
- 纳宝：`64ea885c0000000001004087`

匿名浏览器读取分享页已有成功样例，普通 HTTP 可能返回登录 HTML。不得把 HTTP 200 当成功；图片缺失、访问受限、模型未配置都应明确记录。

## 渠道入口

支付宝 016452、019172、539001 的外部详情链接，以及南方基金“我的定投”和 021000 产品详情已有真机导航记录；016453 已核对公开映射，京东业务直达尚待验证。具体后续页面范围见 `ios/README.md` 的渠道表。nabao 自身跳出和未安装/未登录回归后续再测，购买或管理操作由用户完成。

## 工程约定

直接按业务写少量模块；不引入通用采集插件框架、抽象基类、通用规则 DSL 或用户系统。关键规则需要有反例测试。只在实际有重复需求时提取公共逻辑。


## 投票日志

`POST /internal/v1/vote-audits` 由采集器通过管理密钥写入，以批次 UUID 幂等；相同内容重试不会重复入库，内容不同返回409。批次及字段明细在同一数据库事务内保存到 `vote_audit_batch`、`vote_audit_entry`。

`GET /internal/v1/vote-audits` 返回最近50轮批次；`GET /internal/v1/vote-audits/{id}?authorId=...&field=...&page=0` 每页100条，可按博主、字段和 `fundCode` 筛选。`GET /internal/v1/vote-audits/{id}/funds` 返回该批次基金目录。管理端按基金加载完整记录后，将五个字段与全部博主并排对照，展示已保存的结果，不在浏览器重新投票。接口均要求 `X-Internal-Key` 并禁止缓存。字段明细包括作者名称快照、公开笔记链接、表日期、采集时间、基金、字段、转录原值、标准化票值、业务口径、是否计票、最终结果及支持数。非本轮日期、撤回、未形成有效票和被同作者新记录替代的字段也保留。没有有效表的作者记录在批次来源摘要中。

采集器在发布前先写私有持久化待同步文件，发布后补充发布结果再提交；失败时保留待同步文件，服务启动和每轮处理时重试。成功后移入已同步归档，后端保留历史日志，不因作者移除或下一轮采集覆盖。会话 Cookie、带令牌链接和模型密钥不进入日志。
