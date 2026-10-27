# 本地开发与交付

## 边界

本期没有账号和个人计划同步接口。原始定投截图、计划金额及个性化匹配保留在 iOS；服务端管理公开额度及匿名通知订阅。模型使用采集器本地环境配置；Apple 推送配置后补，缺配置必须显示实际状态。

## 组件开发

直接在本人iPhone体验，先按[真机体验指南](iphone-quickstart.md)配置局域网后端和Xcode签名；无需先接通远程推送。

当前额度主链路为文件表：在 `collector/` 执行 `npm run build && node dist/src/cli.js table`，输出 `.local/public/latest.json` 与日期文件。管理端操作使用常驻 `control` 服务，默认每360分钟检查，也支持立即采集。额度数据不再提交数据库，旧观察API保留兼容；iOS只请求 `/api/v1/table`。

- iOS：打开 `ios/Nabao.xcodeproj`；核心解析测试用 `swift test --package-path ios/NabaoCore`。
- 后端：Java 21，详见 `backend/README.md`。本地 profile 使用文件型数据库，Docker profile 使用 MySQL。
- 管理端：Node >=22.12，`cd frontend && npm ci && npm test && npm run build`；先构建Vue产物，再打包Java。开发服务器用 `npm run dev`，详见 `frontend/README.md`。
- 采集器：Node 22，`cd collector && npm ci && npm test`。实时扫描需单独安装浏览器并按组件 README 执行。

macOS 已有 Homebrew Java 21 时，可仅对当前命令设置：

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" \
mvn -B verify
```

这不会修改系统默认 Java，也不会影响其他项目。构建后可用以下命令运行稳定的 JAR 副本，避免后续 Maven 重建正在运行的文件：

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21 python3 scripts/dev-backend.py start
python3 scripts/dev-backend.py status
python3 scripts/dev-backend.py stop
```

已有私有JSON运行配置时，使用 `start --env-file /绝对路径/environment.json` 保留该环境的端口、数据库和表路径。文件必须为环境变量名到字符串值的对象，覆盖继承环境和默认`.env`。仅在需要同一局域网真机访问时加 `--lan`，将本次监听地址设为`0.0.0.0`；它不会改写配置文件。再次不带`--lan`启动即可恢复配置中的监听地址。坏配置会在停止现有服务前报错，日志不输出配置值。

### 管理端登录与采集

在 `collector/` 执行 `npm run build` 后，从根目录启动稳定的编译副本：

```sh
python3 scripts/dev-collector.py start --env-file /绝对路径/environment.json
python3 scripts/dev-collector.py status
python3 scripts/dev-collector.py stop
```

Node不在PATH时给start增加 `--node /绝对路径/node`。脚本复用配置文件中的 `INTERNAL_API_KEY` 作为控制服务鉴权密钥，不输出密钥；仍从 `collector/.env` 读取模型与项目专用浏览器配置。默认控制地址为 `127.0.0.1:18082`，Java的 `NABAO_CONTROL_URL` 与之对应。有采集或登录任务时，启动脚本拒绝替换正在运行的服务。

本机需要看到小红书登录窗口时，在私有环境中设置 `NABAO_LOGIN_HEADLESS=false`，重启采集服务。此项只影响管理端登录；采集与会话检查仍由 `NABAO_CONTROL_HEADLESS` 决定。登录优先复用项目专用profile，失败或取消保留旧会话。可见窗口尚未识别到二维码时会保留窗口，并在管理端展示页面预览；在该窗口完成正常登录后点击“已完成登录”。确认前不会保存新会话，10分钟后超时关闭。受限后只有实际确认已登录才恢复定时采集；管理端显示最近一次检查结果，平台错误截图按需展开。

打开后端 `/admin/index.html` 并输入管理密钥连接。先检查采集账号状态；失效时点击登录，在页面显示的二维码上用本人小红书App扫码，完成验证后点“已完成登录”。遇到小红书安全限制会显示“访问受限”，停止当前登录并暂停当前进程的定时检查；本人处理平台提示后再手动检查或登录，不自动绕过验证。会话保存在运行采集器的机器上，有效期间会复用；平台使其失效后需重新登录，不保证固定有效天数。采集账号是你自己的账号，无需登录各作者账号。作者管理区可填昵称和完整主页链接新增，也可确认移除；配置重启后保留，下一轮采集使用新名单。至少保留一位作者才能采集。

“刷新结果”只读当前结果；“立即采集”访问当前配置作者、抽取并投票，页面显示任务状态，完成后自动刷新。关闭管理页不停止服务器任务；Mac休眠或服务停止期间不采集。最新表日期以来源原图为准。

## 本地远程通知联调

先在 `backend/` 使用 Java 21 执行 `mvn verify`，再在项目根目录运行：

```sh
swift build --package-path ios/NabaoCore --product VerifyPushClient
JAVA_HOME=/opt/homebrew/opt/openjdk@21 python3 scripts/push-smoke.py
```

需要 Python 3、Swift 和 OpenSSL。脚本启动独立端口的真实后端与文件型 H2 数据库、生成临时 P-256 签名密钥，并用 App 共用的 Swift HTTP 客户端登记和退订。测试覆盖历史基线抑制、重复变更去重、鉴权、通知签名与载荷、503 后重启服务并等待持久重试、退订后停止发送。重试场景约需一分钟；整体通常需要几分钟。

结果保存在 `.local/push-validation/run-*/results.json`。测试结束停止临时进程并删除生成的私钥；不修改 8080 开发库，不读取真实 Apple 凭据，不联系 Apple。模拟服务的 HTTP 接收成功不验证 Apple HTTP/2/TLS、真实设备 token 或实际送达。

生成的 `notification.apns` 可用 Xcode `simctl push <模拟器 UUID> com.example.nabao <文件路径>` 注入已安装的模拟器 App，再通过系统通知点击核对跳转。此步骤验证通知 UI 和路由，仍不经过 Apple 网络。

## Docker

首次执行前，复制 `.env.example` 为 `.env` 并更换三个本地密码/密钥。凭据文件已被 Git 忽略。

```sh
docker compose config --quiet
docker compose up --build -d
docker compose exec collector node dist/src/cli.js doctor
```

服务默认只监听主机的 `127.0.0.1:8080`。数据库不发布主机端口。真实 iPhone 联调时单独配置可访问的后端地址；生产应通过 HTTPS 入口访问。

Compose默认运行常驻control，控制端口不发布到主机，登录和采集由管理端操作。公开表文件通过public-data卷写入，后端只读挂载；私有会话和原始证据放collector-data，不对iOS提供。`table`仍可用于一次性、有范围上限的诊断，与control共用数据目录锁。10/27已验证阿里云的实际登录与采集；其他运行环境及多日持续稳定性仍需分别验证。

### 后续启用 Apple 推送

默认 `APNS_ENABLED=false`。取得 Apple 凭据后，配置 `.env.example` 中的 team、key ID、bundle ID 和环境，并以运行时只读文件提供 `.p8`。例如在被忽略的 `compose.push.local.yml` 中添加：

```yaml
services:
  backend:
    environment:
      APNS_PRIVATE_KEY_PATH: /run/secrets/apns.p8
    volumes:
      - ./private/apns.p8:/run/secrets/apns.p8:ro
```

部署时显式指定 `docker compose -f compose.yml -f compose.push.local.yml up -d backend`。宿主机密钥需能被容器非 root 用户读取；不要把 `.p8` 写入 Dockerfile、构建参数或镜像。当前后端推送调度按单实例设计。既有旧版 `push_device` 表需先执行 `backend/migrations/001-push-token-ownership.sql`，新库无需重复执行。生产不配置 `APNS_TEST_ENDPOINT`。

## CI/CD

- `CI`：后端测试、采集器离线测试、Swift 核心测试、真实 Java + Swift 客户端 + 模拟 APNs 联调、iOS 模拟器编译和容器构建。联调使用生成的测试凭据；上传结果、服务日志和通用载荷，不上传身份、私钥或数据库。
- `Publish images`：发布 Release 或手动触发后，先运行同一套源码构建、单元测试、MySQL 与 Chromium 验收，再把已验证的两个镜像原样标记并发布到当前仓库 GHCR；标签包含完整提交 SHA。
- 阿里云单机部署、已有Nginx入口、小内存配置和回滚说明见 `deploy/aliyun/README.md`。镜像通过环境文件固定版本，启动时同时包含 `mysql backend collector`；已有Nginx的主机叠加production与nginx配置，避免另一个入口占用80/443。真实凭据和SSH连接不写入仓库。

没有远程仓库时，工作流仅作为工程文件存在，不能声称远程 CI 或镜像发布已经通过。当前阶段也不配置 App Store/TestFlight 自动上传。

## 私人测试样本

用户提供的原图仅保存在 `.local/screenshot-samples/`，不提交到 Git。公共测试使用脱敏的文字/版式 fixture，不带银行卡及个人资产。CI 不读取这些原图，也不自动访问小红书。
