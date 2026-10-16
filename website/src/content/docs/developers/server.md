---
title: "服务端源码构建与进阶管理"
description: "Javdex 0.9.0-beta.6 · 服务端源码构建与进阶管理"
---

从仓库根目录构建：

```bash
npm ci
npm run server:build
```

产物为 `out/server`，包含网页和服务端入口，另有 `out/updater` 容器内管理入口。独立 Node 部署仍可在产物目录安装生产依赖后，以 `node index.js start --config /etc/javdex/server.json` 启动，但不包含托管更新；不需要 Electron rebuild。源码方式的 `docker build` 和 `npm run server:smoke` 前必须先运行 `npm run server:build`，烟测会在产物不完整时直接报错。管理入口监督非 root 业务子进程，初始化并保留程序卷，不会替你选择媒体挂载；业务 Web 资源始终来自当前发行目录，不沿用旧镜像的 `/app/web`。若 Docker 构建环境无法访问默认 npm 源，可设置 `JAVDEX_SMOKE_NPM_REGISTRY`，脚本会将其传给 Dockerfile 的 `NPM_CONFIG_REGISTRY` 构建参数。

`server:smoke` 在 Windows Docker Desktop 上使用 Docker 数据卷保存 SQLite；`server:smoke:backup` 使用独立测试容器和卷验证双向备份恢复及桌面本机导入，不覆盖已有资料。后者还需桌面导出 worker 和测试镜像，构建步骤见 [开发说明](https://github.com/JavdexLabs/Javdex/blob/main/docs/DEVELOPMENT.md)。

配置示例（目录及地址替换为服务机器实际值）：

```json
{
  "listenHost": "0.0.0.0",
  "port": 8096,
  "accessHosts": ["192.168.1.10"],
  "dataDir": "/data/javdex",
  "imagesDir": "/data/javdex/media_assets",
  "mediaMounts": { "media": "/media/videos" },
  "web": { "username": "viewer" }
}
```

此示例需通过环境变量 `JAVDEX_WEB_PASSWORD` 提供网页密码，或在 web 中配置 `passwordHash`。`accessHosts` 填客户端访问的主机名/IP，不是监听地址。使用 `deploy/docker-compose.example.yml` 前，必须把 `deploy/javdex-server.example.json` 中的示例地址 `192.168.1.10` 换成 NAS 实际访问地址，同时替换媒体挂载路径；否则局域网客户端会收到 403。`staticRoot` 可省略，CLI 默认使用产物旁的 web 目录；手动指定时必须是含 index.html 的绝对目录。

环境覆盖项为 `JAVDEX_DATA_DIR`、`JAVDEX_IMAGES_DIR`、`JAVDEX_STATIC_ROOT`、`JAVDEX_LISTEN_HOST`、`JAVDEX_LISTEN_PORT`、`JAVDEX_ACCESS_HOSTS`（逗号分隔）、`JAVDEX_WEB_USERNAME`、`JAVDEX_WEB_PASSWORD`。配置文件仍为必需；字段及默认值以 [config.ts](https://github.com/JavdexLabs/Javdex/blob/main/apps/server/src/config.ts) 为准。日常部署使用固定端口；端口 0 仅用于需要系统分配端口的场景。

## 启动与设备授权

配置文件经 `--config` 或 `JAVDEX_SERVER_CONFIG` 提供。官方托管容器由 Compose 启动，管理员通过固定管理入口生成一次性令牌；管理器会使用程序卷中当前版本的业务 CLI：

```bash
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js token --config /config/server.json
```

不要直接运行镜像内 `/app/index.js`：它是初始化种子，不一定是当前业务版本。独立 Node 源码部署不含托管更新；运行构建产物时使用 `node /部署目录/index.js`，安装了 `javdex-server` 命令时使用下列形式：

```bash
javdex-server start --config /etc/javdex/server.json
```

统一 HTTPS 入口仅提供管理器 `token` 命令：尚未认主时首次授权，其后新增一台可信设备并保留现有设备。命令输出一次性令牌，桌面将地址与令牌提交 `/connect/v1/claim`，成功后保存独立设备秘密。已移除 `bind`、`recover`、`pair` 和 `pair-recover` CLI；遗失设备由新授权电脑在可信设备列表逐台撤销。首次自动保存证书，合法公开证书按系统信任及主机名校验后自动更新，自签名证书指纹变化需在发送凭据前取得用户确认。网页 Cookie 不授权管理或更新接口。

交接/恢复领取遇到扫描、维护任务或未完成的文件操作时返回 `MAINTENANCE_BUSY`。请求不排队、不占用交接资格，也不消耗一次性令牌；操作者应完成或取消任务后重试（令牌过期需重新签发）。原 writer 在交接成功前保持有效，新维护任务不会因一次失败的交接而被禁止。成功领取仍是原子操作，同一成功 claim 的重试不增加写入代次。`writer.status.maintenanceBusy` 表示当前有维护任务，不表示有人排队。

桌面在“设置 → 存储与导出 → 资料库连接”选择远程地址后重启生效。远程模式只使用桌面设置、凭据与 `desktop-work.db`，不打开原 `library.db`。工作记录未复制完成时拒绝远程启动。

## 备份、恢复与本机导入

统一在桌面“设置 → 存储与导出 → 备份与恢复”操作。远程资料库须先连接并领取有效写入授权；支持已认主的空库或非空库，不需要额外迁库令牌。

- **创建备份**：备份当前本地或服务端资料库，保存到这台电脑。也可把文件带到另一台电脑后恢复。
- **从备份恢复**：选择备份，按向导对应目标资源目录并核对覆盖影响；执行前自动备份目标，再替换正式资料与图片。目标服务配置、挂载配置和认主关系保留。
- **从本机资料库导入**：在远程模式中由桌面隔离导出本机资料，再上传并恢复到服务端。来源资料库保留且可独立使用，两份资料不自动同步。

原始视频不会打包或上传；服务端资源需位于配置的挂载目录内。备份包含正式资料、图片、清单和评分，不包含登录凭据、插件/模型配置及桌面工作记录。加密图片只在备份副本中解密，备份文件不加密。压缩包和展开内容分别上限 64 GiB，传输分块为 8 MiB，支持断点续传。

恢复前会处理目录映射、缺失资源与自动保护备份；提交阶段不可取消。操作失败或连接中断时，在操作记录中检查原任务并按提示继续，避免重复发起恢复。详细范围与流程见 [使用指南](/Javdex/guide/backup/)。

旧离线迁库尚未正式发布，现已移除其 CLI、管理接口及专用包格式；不提供旧包或旧任务兼容入口。

## 更新与恢复限制

当前源码使用单容器内置更新管理器，提供与客户端完全同版本（含预发布）的在线升级与完整签名包离线上传。0.8.0 镜像没有这项能力：首次升级须正常停服并完整备份 `dataDir`、`imagesDir`、部署配置及旧镜像，再采用当前版本基础镜像、增加独立 `/program` 卷并配置统一 HTTPS 入口；新卷首次启动直接采用镜像中的业务程序并迁移数据库，不生成升级备份。具体步骤见 [部署与首次采用](/Javdex/server/adoption/)。

已有托管程序卷时，更改 `.env` 的 `JAVDEX_VERSION` 并 `pull` / `up -d` 会更换基础镜像；镜像业务版本更高时还会自动执行停服、升级与验证，同版或更旧时保留当前业务。业务升级文件仍可独立安装，但不能更新管理器。服务端落后时，客户端在线检查固定读取自身版本的 Release；目标不存在时明确失败，不改选其他版本。同版本重装、降级、错误架构、未知签名和不支持的 schema 路径均不能绕过。

保留原数据与程序卷，不要执行 `docker compose down -v`。schema 21 不能交给 0.8.0 或其他旧版应用；回退需恢复升级前完整备份及匹配程序，不可手工降低 `user_version`、修改模型文档版本或清空程序卷强制切换。未发布或不完整的开发 schema 快照会被拒绝，应恢复受支持的升级前备份。升级本身不复制资料库或图片；仅在安装尚未开始且原部署未变时重启原业务。安装或验证失败、中断时保持维护状态并要求人工恢复，提交后只继续激活，不自动覆盖新写入。保留现场并按 [安装、验证和恢复](/Javdex/server/recovery/) 处理。

服务端备份不包含桌面采集草稿和运行记录，后者在桌面 `desktop-work.db` 中，桌面数据目录也需单独备份。资料库维护期间不能领取写入凭据。

## 功能与使用边界

远程资料管理、文件重命名、待确认队列定位与精确查询、审计筛选、来源匹配、单条/批量刮削及清单影片链接已接线。刮削插件、Agent、模型调用、浏览器登录、网络采集、候选草稿和暂存图片仍在桌面运行；预览时服务端校验权威资料，最终应用时才接收候选与已选图片，服务端只保存正式资料、正式图片或待确认候选。批量直接选择最多 200 个 ID，更大范围用筛选；取消采集不会撤回已经受理的写入。

远程模式在媒体库的“来源与扫描 → 添加目录”中浏览部署配置 `mediaMounts` 列出的挂载（例如 `library`）及其子目录，确认服务端路径后添加。服务端会重新校验所选目录始终位于配置的挂载内；此入口不选择桌面本机文件夹。

服务端扫描启用“自动导入本地 NFO”后，使用与桌面相同的来源解析、候选暂存和资料应用流程，支持标题、演员及挂载目录内的封面、样张、演员头像。多候选按现有策略进入待确认；正式应用递增影片版本，旧编辑须刷新后重试。图片只通过已授权根目录能力读取，不接受 NFO 中的远程图片作为下载授权。NFO 导出仍支持 XML。

远程桌面连接且取得写入权限后，可在“网页访问”中开启配对、核对并批准/拒绝配对码，管理已配对设备。服务端地址、端口和登录配置仍由部署配置管理；会话断开或资料库冻结时隐藏操作控件。网页配对只授予浏览权限，不授予管理 API 权限。

远程不支持本机文件夹操作、根重绑、图片加密或资产目录搬迁。服务端首版无转码，挂载使用固定标记保护，不识别换卷。能力细节和代码入口统一见 [实现与合同](https://github.com/JavdexLabs/Javdex/blob/main/docs/SERVER_MODE_CONTRACT_INVENTORY.md)。
