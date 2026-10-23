# 支付宝基金详情映射核验

核验时间：2026-10-21 00:26–00:28（Asia/Shanghai）。

通过蚂蚁基金公开产品页的匿名 HTTP 请求，核实了以下五组映射。均返回 HTTP 200，页面内 `context.success=true`，`context.materialInfo.fundCode` 与 `context.materialInfo.fundBrief.fundCode` 一致；份额来自同一对象的 `fundNameAbbr` 和 `fundName`。没有登录、读取用户 token 或操作交易。

| 基金代码 | 页面基金名称／份额 | `context.materialInfo.productId` | 可复查来源 |
| --- | --- | --- | --- |
| 019172 | 摩根纳斯达克100指数(QDII)A | `20230825000230030000000001247900` | [公开产品页](https://www.fund123.cn/matiaria?fundCode=019172) |
| 539001 | 建信纳斯达克100指数(QDII)A | `20150718000230030000000000003391` | [公开产品页](https://www.fund123.cn/matiaria?fundCode=539001) |
| 021000 | 南方纳斯达克100指数(QDII)I | `20240319000230030000000011108881` | [公开产品页](https://www.fund123.cn/matiaria?fundCode=021000) |
| 016453 | 南方纳斯达克100指数(QDII)C | `20221103000230030000000000141044` | [公开产品页](https://www.fund123.cn/matiaria?fundCode=016453) |
| 016452 | 南方纳斯达克100指数(QDII)A | `20221103000230030000000000141045` | [公开产品页](https://www.fund123.cn/matiaria?fundCode=016452) |

这次复核的 016452 映射与此前真机验证使用的映射相同。其他四项已证明公开代码与产品 ID 的对应关系，尚未在本次调研中验证 App 落点。

## 路由依据

支付宝官方静态资源仍可匿名读取：

[基金详情路由代码](https://gw.alipayobjects.com/os/f/cms/assets/a764f3e8c5d5e6257a5d5942e0b22b28.js)

其 `fund_detail` 分支使用以下形式：

```text
内部页面 = /www/detail.html?productId=<已核实的 productId>
Scheme = alipays://platformapi/startApp?appId=20000793&pullRefresh=NO&url=<编码后的内部页面>
HTTPS 唤起入口 = https://ds.alipay.com/?scheme=<编码后的 Scheme>
```

每一层各编码一次。公开资源证明这个路由曾由官方页面使用；当前 App 是否仍接受、登录后能否到达相应基金，以及买入／定投管理入口是否展示，需要真机验证，不能仅靠打开 HTTPS 或检测安装状态确认。

## 本地证据

证据目录：`.local/deeplink-research/alipay-2026-10-21/`，已被项目 `.gitignore` 排除。

- `{code}.html`：原始公开页面。
- `{code}.context.json`：从静态 JSON 赋值中解析的页面数据，没有执行页面脚本。
- `{code}.metadata.json`：原始 URL、最终 URL、HTTP 状态、UTC 获取时间、响应大小和 SHA-256。
- `verified-mappings.json`：已核实映射与完整候选 HTTPS 链接。
- `official-fund-route.js` 及对应 metadata：路由代码与获取证据。

公共网页阅读工具无法访问这些产品页，但普通匿名 HTTP 请求成功，不能将阅读工具失败视为来源不可用。

## 接入建议

以五个明确映射作为初始表，优先真机测试截图里实际出现的 019172、539001，再测试 016453、021000。链接落地后核对基金名称、份额和代码；买入及已有定投管理仍分别记录验证状态。

`productId` 存在不代表该渠道可买、可建定投或用户已有计划。五个页面的 `titleInfo.fundLimit` 都返回 `0--`，该值不具备可靠额度语义，本次只用页面核对产品身份。
