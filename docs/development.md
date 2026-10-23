# 本地开发与交付

## 边界

本期没有账号和个人计划同步接口。原始定投截图、计划金额及个性化匹配保留在 iOS；服务端管理公开额度及匿名通知订阅。模型使用采集器本地环境配置；Apple 推送配置后补，缺配置必须显示实际状态。

## 组件开发

当前额度主链路为文件表：在 `collector/` 执行 `npm run build && node dist/src/cli.js table`，输出 `.local/public/latest.json` 与日期文件。`table-watch --interval-minutes 360` 可在持续在线的运行环境低频检查；本轮只验收单轮命令，未部署常驻服务。额度数据不再提交数据库，旧观察API保留兼容；iOS只请求 `/api/v1/table`。

- iOS：打开 `ios/Nabao.xcodeproj`；核心解析测试用 `swift test --package-path ios/NabaoCore`。
- 后端：Java 21，详见 `backend/README.md`。本地 profile 使用文件型数据库，Docker profile 使用 MySQL。
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
docker compose up --build -d mysql backend
docker compose --profile tools run --rm collector doctor
docker compose --profile tools run --rm collector table
```

服务默认只监听主机的 `127.0.0.1:8080`。数据库不发布主机端口。真实 iPhone 联调时单独配置可访问的后端地址；生产应通过 HTTPS 入口访问。

采集器的 table 是一次性、有范围上限的执行。目标环境单轮验证通过后，可运行 table-watch --interval-minutes 360。公开表文件通过 public-data 卷写入，后端只读挂载；私有会话和原始证据放 collector-data，不对iOS提供。服务器环境仍需验证网络、登录会话和稳定性。

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
- 服务器尚未确定，部署自动化不预填主机或凭据。服务器准备好后，通过环境文件固定镜像 SHA，再执行 `docker compose pull` 和 `docker compose up -d --no-build mysql backend`。

没有远程仓库时，工作流仅作为工程文件存在，不能声称远程 CI 或镜像发布已经通过。当前阶段也不配置 App Store/TestFlight 自动上传。

## 私人测试样本

用户提供的原图仅保存在 `.local/screenshot-samples/`，不提交到 Git。公共测试使用脱敏的文字/版式 fixture，不带银行卡及个人资产。CI 不读取这些原图，也不自动访问小红书。
