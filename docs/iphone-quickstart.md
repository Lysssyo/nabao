# 在自己的 iPhone 上体验 nabao

这份说明用于当前 Mac 上的源码体验。可以体验计划记录、截图导入、额度投票结果、渠道入口、本地提醒和备份。当前没有 TestFlight 安装包；真实远程推送需另行配置 Apple 推送签名及后端凭据。

2026-10-25 本机已在 Xcode 选择现有 Personal Team、配置专用开发 Bundle ID，并成功签名安装到已连接的 iPhone，Xcode 显示 App 正在真机运行。随后已覆盖安装包含“＋”截图入口和地址保存修复的新版。18081 后端已用 `--lan` 启动。当前设备还需在 App 设置保存 `http://Admin.local:18081` 并允许本地网络访问；本轮尚未确认手机读取额度成功。下文保留从头配置步骤，已有配置无需重复更换。

## 1. 把后端开放给同一局域网的 iPhone

Mac 和 iPhone 连接同一个可信 Wi-Fi，Mac 在体验期间保持运行。使用`--lan`启动18081服务后手机才能访问；手机不能使用127.0.0.1连接Mac。

这台 Mac 已有私有运行配置。执行以下命令，以原来的端口、数据库、表文件和管理密钥重启服务，只将监听地址改为局域网可达：

```sh
cd /Users/Admin/openSource/nabao
JAVA_HOME=/Users/Admin/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home \
  python3 scripts/dev-backend.py start \
  --env-file .local/app-validation/2026-10-24/backend/environment.json --lan
```

`--lan` 本次监听 `0.0.0.0`，不会修改私有配置文件。不要改用其他项目占用的8080。启动脚本运行已构建JAR的稳定副本；修改Java或管理页后先在backend中重新执行Maven构建。

在Mac终端查询局域网名称：

```sh
scutil --get LocalHostName
```

例如本机检查时返回 `Admin`，手机可用的后端地址就是 `http://Admin.local:18081`。名称以后若变化，以命令输出为准。优先使用 `.local` 名称，项目已经声明本地网络访问用途和ATS本地网络例外。

先在 iPhone 的 Safari 打开 `http://Admin.local:18081/api/v1/readiness`，看到 `READY` 表示能访问额度文件；它不代表表格日期是今天。此测试需要先执行上面的局域网启动命令。

若连不上，检查是否同一Wi-Fi、Mac仍在运行、路由器是否隔离访客设备，以及macOS防火墙是否允许该Java服务的传入连接。可用系统设置中当前Wi-Fi的Mac局域网IP诊断连通性。不要关闭整个防火墙。手机需要访问的是Mac，不能填写 `127.0.0.1` 或 `0.0.0.0`。

体验结束后，去掉 `--lan` 再执行同一个启动命令，即恢复私有配置里的本机监听地址。

## 2. 连接 iPhone 并启用开发者模式

用数据线连接Mac与iPhone，解锁手机，并在手机上选择信任此电脑。Xcode中选择或配对设备；若提示开启开发者模式，到 iPhone「设置 → 隐私与安全性 → 开发者模式」打开，按提示重启并确认。新设备可能要先与Xcode配对，设置中才会出现该入口。[Apple开发者模式说明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)

## 3. 在 Xcode 选择自己的签名账号

1. 打开项目根目录下的 `ios/Nabao.xcodeproj`。
2. 在「Xcode → Settings → Apple Accounts」登录自己的Apple账号。
3. 选中项目中的 `Nabao` target，进入「Signing & Capabilities」，启用「Automatically manage signing」，Team选择自己的团队或Personal Team。
4. 若仍为默认 `com.example.nabao`，改为自己可注册的唯一Bundle Identifier，例如 `com.yourname.nabao.dev`（将yourname替换为自己的标识）。本机已配置专用标识，继续保留即可。后续覆盖安装保持相同Bundle ID，这样才能继续使用该App的本地数据。
5. 本次普通体验沿用默认配置；不要启用Push Notifications能力，也不要套用 `PushSigning.xcconfig`。该可选配置用于后续真实APNs验收。

Xcode会按所选账号为设备创建开发签名。可以先使用免费Personal Team体验；其安装描述文件7天到期，到期后通过Xcode重新构建安装。无需先购买会员来体验本地计划和额度表。[Apple真机运行说明](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)、[Personal Team期限](https://developer.apple.com/help/account/basics/about-your-developer-account/)

## 4. 安装并连接额度表

Xcode顶部scheme选择 `Nabao`，运行目标选择你的真实iPhone，然后点击运行（⌘R）。若设备提示信任开发者，按系统提示在「设置 → 通用 → VPN与设备管理」完成信任，再运行。

首次打开可在“连接纳宝”引导中填写地址并点击“连接并开始”，也可以选择“稍后设置”先使用本地计划。已跳过引导时，打开App的设置，在顶部“服务地址”将地址设为 `http://Admin.local:18081`，按“保存地址”完成切换，并允许本地网络访问。保存后点击“测试连接”，看到“连接成功”及数据日期、份额数，再到额度页查看。地址也可以在离线时保存，测试失败不会覆盖旧额度缓存。后台通知服务检查不再禁用地址保存按钮。这里不需要管理密钥或模型密钥。若之前拒绝权限，到「设置 → 隐私与安全性 → 本地网络」允许nabao访问，然后回App刷新。

额度页应显示已发布表的实际日期与41份额，按代销额度倒序展示。当前保存的表为2026-10-23，不把安装或刷新时间当成新的数据日。

## 5. 按这个顺序体验

1. 计划页点右上角“＋ → 手动新增”，从基金目录选择名称与代码，设置金额和周期。
2. 打开计划详情，看对应基金的额度投票结果，再进入基金详情。
3. 点“＋ → 从截图导入”，选择支付宝或南方基金定投截图，核对识别内容后保存。个人计划与截图处理在手机本地。
4. 在设置中测试5秒本地通知；额度远程推送暂未配置。
5. 导出计划备份到「我的iPhone → nabao → 备份」，重新导入先看预览，再确认恢复。

Mac服务停止或离开该局域网后，个人计划仍可用，额度页会保留上次成功读取的缓存和日期。要在外网持续获取新表，需要部署可访问的HTTPS后端并启用常驻采集。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| Xcode要求选择Development Team | 在Signing & Capabilities中选自己的账号团队 |
| Bundle Identifier无法注册 | 换一个属于自己的唯一标识 |
| Personal Team提示不支持Push Notifications | 确认未使用可选PushSigning配置，默认体验不需要远程推送 |
| 找不到开发者模式 | 先通过Xcode与设备配对，再检查隐私与安全性设置 |
| Safari也打不开readiness | 先查后端的局域网监听、同Wi-Fi与防火墙 |
| Safari能打开，App请求失败 | 核对地址、本地网络权限，优先使用Mac的.local名称 |
| 手机显示旧日期 | 检查已发布表日期；刷新页面不会启动采集 |
| 7天后无法打开 | 用相同Bundle ID在Xcode重新构建安装，不必删除App |

本机已完成实际真机安装和启动；换手机时，账号登录、设备信任和开发者模式仍按本人设备的提示完成。额度读取、截图导入及提醒等功能需在真机继续体验确认。
