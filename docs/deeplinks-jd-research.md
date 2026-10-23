# 京东金融跳转核验

核验日期：2026-10-21。此次只读取官方公开 HTML、脚本与域名关联文件，未操作真实 iPhone。

**官方基金路由仍有证据；具体基金购买和定投管理的直达尚未证实。** 未找到南方纳指 A `016452` 对应的京东 `productId`，不能用基金代码代替。

## 官方证据与候选

当前 [JrBridge 3.0.0](https://jrb.jr.jd.com/common/jssdk/jrbridge/3.0.0/jrbridge.js) 内含以下映射：

| 路径 | 原生路由编号 | 可确认范围 |
|---|---:|---|
| `caifu/jijin/fundlist` | `1` | 基金列表路由存在 |
| `caifu/jijin/funddetail` | `3` | 基金详情路由存在；需要真实商品映射 |
| `hold/jijin/fundhold` | `61` | 基金持有路由存在；定投管理能力待验证 |

同一脚本把 `native/false` 映射到 `jumpType=6`、`native/true` 映射到 `jumpType=5`。当前 [jrBackFlow 2.0.1](https://mse.jd.com/downloadcpt/2.0.1/jrBackFlow.js) 使用 `jdmobile://share`，拼接 `jumpType`、`jumpUrl`、`productId` 等参数。据此可做只读真机测试：

```text
jdmobile://share?jumpType=6&jumpUrl=1
jdmobile://share?jumpType=5&jumpUrl=61
```

这些是按官方模板与映射组合的候选，**尚无本轮唤起、落地页验证**。详情候选为 `jumpUrl=3` 加真实 `productId`，此次不生成可点击的详情链接。脚本另有 `fundinvest=5009`，仅凭英文名称不足以认定其为定投管理。

JrBridge 也构造 `openjdjrapp://com.jd.jrapp/caifu/jijin/fundlist?jrcontainer=native&jrlogin=false` 形态，但该代码用于 App 内桥接，外部调用能力同样需验证。

## 旧 HTTPS 入口仍需实机判断

[原候选入口](https://m.jr.jd.com/jj/down/?jumpType=6&jumpUrl=1) 的当前网页只读取 `targetLink`；未提供时跳转通用增长页面。`targetLink` 只接受京东域名的 HTTPS 链接，不接受原生 scheme。

但官方 [AASA](https://m.jr.jd.com/.well-known/apple-app-site-association) 仍将 `/*/down/*` 关联到京东金融 App，包含 `56697L4LNB.com.jd.jinrong`。Apple 的 [公开应用查询](https://itunes.apple.com/lookup?id=895682747&country=cn) 返回相同 bundle ID；查询时商店版本为 `8.2.80`。

因此网页回退不能证明 Universal Link 已失效：安装 App 后，iOS 可能在加载 HTML 前接管链接。验收应从链接点击或 App `openURL` 进入，分别记录「系统接受／App 唤起」「具体页面」「登录或解锁中断」；Safari 地址栏访问和 `openURL` 成功回调都不能单独证明业务直达。

## 本期处理建议

- 精准详情入口只接纳官方商品页或用户分享链接提供的代码、名称、份额、`productId` 对应关系；当前 `016452` 的京东映射保持空值。
- 若基金列表或持有入口通过真机验证，按钮按实际落点命名，并保留复制基金名称／代码的回退。
- 当前未找到可核验的专门定投管理 URL；不要把基金详情、持有页面或 `fundinvest` 自动标成「管理定投」。
- 未安装或路由失败时，可提供[官方 App Store 页面](https://apps.apple.com/cn/app/id895682747)和复制代码，由用户选择后续操作。

旧官网导航的 `https://trade.jr.jd.com/jjdt/index.action` 此次 HTTP 请求回到金融首页；`fund.jd.com` 在当前环境请求失败。这些现象不作为原生路由无效或网站永久停用的证明。

原始公开证据保存在被 Git 忽略的 `.local/deeplink-research/`，其中 `jd-evidence-index.json` 含 URL、采集时间与 SHA-256；`jd-product/result.json` 记录商品映射查询边界。未调用登录接口、未执行交易、未修改 iOS 源码。
