# MediaCrawler 参考结论

核验日期：2026-10-20。参考仓库为 [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)，本地只读快照提交为 `8f583999006d5b692272c608440e193ca282e73b`，保存在被忽略的 `.local/references/MediaCrawler/`。

## 适用能力与边界

- 有指定作者模式：作者信息 → 分页笔记列表 → 详情 → 有序图片清单。
- 主采集流程基于 Playwright/CDP，会检查登录状态，必要时进入登录流程；登录态模式仍需单独验证。
- 当前默认会尝试连接已有 Chrome 的 context；还会保存登录状态。nabao 没有运行该默认配置，也没有读取个人 Chrome 的 Cookie。
- 小红书客户端明确处理 `300012`（IP 风险）、`300011`、401/403/429 及验证挑战。源码本身不证明可以解决当前环境的访问限制。
- 媒体下载默认关闭，评论采集默认开启；若后续单独做研究验证，需要明确限定作者、数量和图片范围。

证据：

- [作者采集流程](https://github.com/NanmiCoder/MediaCrawler/blob/8f583999006d5b692272c608440e193ca282e73b/media_platform/xhs/core.py#L196)
- [列表分页与详情客户端](https://github.com/NanmiCoder/MediaCrawler/blob/8f583999006d5b692272c608440e193ca282e73b/media_platform/xhs/client.py#L583)
- [默认运行配置](https://github.com/NanmiCoder/MediaCrawler/blob/8f583999006d5b692272c608440e193ca282e73b/config/base_config.py#L50)
- [访问限制处理](https://github.com/NanmiCoder/MediaCrawler/blob/8f583999006d5b692272c608440e193ca282e73b/media_platform/xhs/client.py#L153)

## 本轮独立实现的改进

1. **一次扫描复用一个新的匿名浏览器上下文。**主页和笔记间保留正常导航会话，扫描结束后关闭；不加载用户浏览器配置、不持久保存登录状态。
2. **补充静态结构化笔记读取。**从已取得 HTML 内的初始化数据中读取目标笔记。优先使用确切笔记 ID、作者 ID、正文、图片数组和明确的发布时间字段，DOM 提取保留为降级。
3. **数据解析不执行脚本。**只接受 JSON 和字符串外的裸 `undefined`；正文中的同名文本保持原样，函数调用或附加语句均拒绝。
4. **完整性与受限判定继续生效。**结构化数据不能覆盖访问限制；目标身份不符不采用；缺图保留原数量和索引，图片总数冲突保持待核验。

MediaCrawler 的 HTML 原始字段是 `noteDetailMap / noteId / imageList / urlDefault / lastUpdateTime`；其内部归一化和存储字段会转换成 snake_case。两者不能混用。平台时间与采集写入时间也必须分开。

参考的是网页数据格式及流程事实，本轮没有复制 MediaCrawler 的源码、引入其运行依赖或执行其采集器。

## 许可与下一项验证

该快照使用 [NON-COMMERCIAL LEARNING LICENSE 1.1](https://github.com/NanmiCoder/MediaCrawler/blob/8f583999006d5b692272c608440e193ca282e73b/LICENSE)，限定非商业学习研究用途，商业使用需要版权所有者书面许可。

本轮改进针对“已经拿到网页之后如何准确读取”和“单次扫描会话连续性”，没有证明 `300012` 已解除。完整作者追新、全部配图和模型额度抽取仍需实际联调。
