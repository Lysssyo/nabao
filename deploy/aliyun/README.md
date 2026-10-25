# 阿里云单机部署

本目录在根 `compose.yml` 上叠加生产配置，保留 MySQL、Java 与 Node/Chromium 三个服务。Vue 的构建产物已经随 Java 镜像提供，生产不用启动 Vite。HTTPS 使用同一 Compose 项目中的 Caddy。这里不包含真实域名、SSH 地址或凭据。

## 2GiB 主机的资源边界

| 服务 | 容器内存上限 | 主要约束 |
| --- | --- | --- |
| MySQL | 384MiB | 64MiB buffer pool、20个连接、关闭 performance_schema |
| Java + Vue | 448MiB | Java heap 192MiB、40个 HTTP 工作线程、5个数据库连接 |
| collector + Chromium | 768MiB | Node heap 256MiB、共享内存最多256MiB |
| Caddy | 64MiB | Go软内存目标48MiB |

总上限1664MiB，余量留给宿主系统。共享内存按实际使用占用容器预算，不是额外的可用内存。建议在服务器侧准备2GiB swap用于短时峰值；swap不代替容量验收，也不保证 Chromium 能完成采集。资源值可在环境文件调整，但总量必须重新评估。首次保持定时关闭，实测一次采集；若发生 OOM 或持续换页，优先升级内存。不要在这台小主机上与正式服务并行执行镜像构建及全量测试。

需要 Docker Engine、**Docker Compose >=2.24.4**，镜像应与服务器 CPU 架构一致。配置使用官方的 [`!override` / `!reset` 合并规则](https://docs.docker.com/reference/compose-file/merge/)确保不会意外保留公网后端端口。

## 首次启动：仅 SSH 可访问

以下命令均在仓库根目录执行。使用固定项目名 `nabao`，否则 Compose 会创建另一组卷，看起来像数据丢失。

```sh
cp deploy/aliyun/.env.example deploy/aliyun/.env
chmod 600 deploy/aliyun/.env
```

在服务器上填写两个独立数据库密码、随机管理密钥、模型密钥、已验证镜像的版本或 digest。管理密钥同时供 Java 与 collector 内部鉴权，建议至少32个随机字节。不要把密钥放在命令参数、URL、Git或聊天记录中。MySQL环境密码只在新数据卷初始化时生效；已有数据库改密码需要实际执行数据库密码轮换。

镜像应来自同一源码版本；构建顺序为 `frontend npm ci / npm test / npm run build`，再构建后端与采集器镜像。发布前确认生成的 Vue 资源已同步。若镜像通过离线方式载入，跳过 `pull`。

```sh
docker compose --project-name nabao --env-file deploy/aliyun/.env \
  -f compose.yml -f deploy/aliyun/compose.production.yml config --quiet
docker compose --project-name nabao --env-file deploy/aliyun/.env \
  -f compose.yml -f deploy/aliyun/compose.production.yml pull
docker compose --project-name nabao --env-file deploy/aliyun/.env \
  -f compose.yml -f deploy/aliyun/compose.production.yml up -d --no-build --wait
```

不要把完整 `docker compose config`、`docker inspect` 或环境文件输出到共享日志，它们可能包含运行密钥。空模型密钥不会阻止控制服务启动，但无法完成真实提取。环境文件中的镜像字段必须填写，不能依赖根配置的开发镜像回退。

此时只发布 `127.0.0.1:8080`，不受根配置中 `BACKEND_BIND_ADDRESS` 的影响。管理员可从自己的电脑建立SSH隧道，例如 `ssh -L 18081:127.0.0.1:8080 <已配置的SSH别名>`，再访问 `http://127.0.0.1:18081/admin/index.html`。数据库3306、控制服务18082始终不发布。若修改 `BACKEND_PORT`，同步调整隧道目标端口。

## 启用 HTTPS

将真实域名解析到服务器，在环境文件填 `NABAO_DOMAIN`（仅主机名）与 `ACME_EMAIL`。安全组及宿主防火墙仅需为网站开放 TCP80/443；SSH按自己的管理来源限制。不要开放8080、3306、18082。此模板未开放HTTP/3的UDP443，HTTPS仍可正常使用。

```sh
docker compose --project-name nabao --env-file deploy/aliyun/.env \
  -f compose.yml -f deploy/aliyun/compose.production.yml -f deploy/aliyun/compose.https.yml config --quiet
docker compose --project-name nabao --env-file deploy/aliyun/.env \
  -f compose.yml -f deploy/aliyun/compose.production.yml -f deploy/aliyun/compose.https.yml up -d --no-build --wait
```

HTTPS配置去掉后端宿主端口，只由Caddy开放80/443；Caddy自动申请、续期证书并将HTTP转为HTTPS。域名、正确DNS、外部可达的80/443和持久化证书目录是[自动HTTPS的前提](https://caddyserver.com/docs/automatic-https)。不能以IP或自签证书替代手机可正常信任的域名证书。本模板关闭Caddy管理API，修改Caddyfile后重建该容器使配置生效。默认不启用访问日志，避免记录管理请求信息。

接入后访问 `https://<域名>/admin/index.html`；iOS后端地址设为 `https://<域名>`。以后更新、停止、查看状态应保持相同三个 `-f` 参数，避免误退回仅SSH模式。

## 验收及定时采集

1. 检查容器健康状态、`/api/v1/health` 与 `/admin/index.html`，确认无密钥的管理API返回401。
2. 检查管理端能连接collector、作者名单正确、定时处于关闭状态。容器健康检查只读服务状态，不启动浏览器、不请求小红书、不宣称已有新表。
3. 初始公开卷为空时，`/api/v1/readiness`返回503是尚无有效表。可以在停采集时迁移一致的已发布表、摘要及私有发布状态，或等待首次真实采集；不要用测试表初始化正式服务。
4. 在管理端使用服务器浏览器生成的二维码正常登录。验证成功后会话保存在 `collector-data`，重启复用；不承诺永久有效。服务器访问受限、会话过期或人工验证时，按平台提示处理。无头容器没有可见桌面，截图不是远程交互桌面；需要网页人工操作的验证必须另行处理，不能仅打开 `NABAO_LOGIN_HEADLESS=false`。
5. 手动执行一次真实采集，核对任务结果、表日期、各作者状态、日志与 `docker stats --no-stream`，确认没有OOM或持续换页；再填写 `NABAO_CONTROL_SCHEDULE_ENABLED=true` 并更新collector。平台限制状态仍会主动暂停定时。

`/api/v1/readiness`只证明已发布表可读，不证明今天已更新或登录有效。`--wait`检查容器启动/健康，HTTPS证书仍需从实际域名验证。当前部署按单实例设计，不要横向扩展Java推送调度或采集器。

## 数据、备份与回滚

根配置的五卷仍为 `nabao_mysql-data`、`nabao_collector-data`、`nabao_public-data`、`nabao_status-data`、`nabao_push-data`。HTTPS新增 `nabao_caddy-data`、`nabao_caddy-config` 保存证书及配置状态。普通重建容器不删除卷；**不要执行 `down --volumes`**。公开表及摘要对Java仍是只读挂载，模型密钥、会话和原始证据不对公网提供。

更新前等待采集/登录空闲，记录旧镜像digest与环境配置。数据库做一致性导出；停止写入服务后备份五个数据卷以及Caddy卷，保留文件所有者和权限。数据库数据目录不可在运行写入时直接打包；私有卷含会话，备份必须限制访问。定期验证恢复到隔离项目的能力，另将备份保存到服务器之外。日志每服务最多约30MiB，但原始采集证据没有自动保留期，需要监测40GiB磁盘余量，不要随意删除仍被采集状态引用的证据。

回滚应用时恢复之前同批的backend/collector镜像引用，沿用同一项目名与现有卷，执行同一组 `up -d --no-build --wait`，再验收。若涉及数据库或文件格式变更，先确认向后兼容；不兼容时需要恢复配套备份，不能只回退镜像。既有旧版数据库迁移与APNs私钥挂载见 `docs/development.md`，默认APNs保持关闭。

本目录仅提供配置；不包含自动云资源创建、DNS修改、证书已签发、服务器登录已完成或采集已通过的承诺。
