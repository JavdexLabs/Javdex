# 服务端模式：部署、认主与备份恢复

本页维护当前部署与操作方式。实现、合同和功能边界见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)，进度与验证结果见 [当前状态](SERVER_MODE_NEXT_STEPS.md)。桌面日常操作见 [使用指南](USER_GUIDE.md)，只读网页见 [LAN Web](LAN_WEB.md)。

本页面向 **0.9.0 正式版的发布准备**：资料库 schema 为 **20**，桌面模型管理文档版本为 **4**。下列版本号是部署目标，不表示 Release、镜像或升级包已经发布；使用前须确认[正式 Release](https://github.com/JavdexLabs/Javdex/releases/latest) 已提供目标版本的桌面、双架构镜像和升级包。发布与待核验状态见 [发布准备检查](reviews/v0.9.0-readiness.md)。

官方部署使用单容器托管更新，必须持久保存 `/program` 程序卷；首次认主与 writer 恢复均通过容器管理入口执行。普通资料管理要求桌面与实际运行的服务端业务版本一致。已有部署先备份；从 0.8.0 首次采用、已有程序卷保留版本、签名信任和后续在线升级见 [服务端更新](SERVER_UPDATE.md)。

## 服务端能做什么

- 独立保存影片、演员、分类、清单、正式图片和待确认资料，扫描已配置的媒体目录，导入本地 NFO 与配套图片。
- 通过同版本桌面应用管理远程资料、处理扫描与刮削结果；桌面关闭后，服务端扫描与网页访问仍可继续。
- 向同一网络的浏览器提供搜索、浏览、原生播放和本地资源下载，支持密码登录、设备配对与授权撤销。
- 刮削插件、AI、浏览器会话和采集草稿在桌面运行，服务端接收确认后的资料和图片。不提供网页编辑后台、无人值守云端刮削或视频转码。

## Docker Compose 快速开始

正式发布流程为 `ghcr.io/javdexlabs/javdex-server` 生成 Linux amd64 和 arm64 镜像，Docker 自动选择架构。部署只需要 Docker 与 Compose 插件，无需安装 Node.js、npm 或编译源码。以下以固定基础镜像版本 `0.9.0` 为例，不使用滚动标签。新程序卷从镜像初始化业务；已有程序卷优先运行已选择的业务版本，因此基础镜像标签不能代替实际业务版本检查。

1. 确认目标正式 Release 可用后，从其发布说明中的对应源码版本链接保存 `deploy/docker-compose.example.yml` 和 `deploy/javdex-server.example.json`，放在同一个目录（保留文件名）。它们不是 Release 附件；不要混用其他分支的示例。在该目录创建 `.env`，填写基础镜像版本号（不含 `v`）；首次部署应与桌面安装包一致：

   ```dotenv
   JAVDEX_VERSION=0.9.0
   ```

2. 编辑 [Compose 示例](../deploy/docker-compose.example.yml) 和 [服务配置](../deploy/javdex-server.example.json)：
   - 将 `JAVDEX_WEB_PASSWORD` 替换为独立的 12–128 字符密码。
   - 将 `/absolute/path/to/media` 替换为 NAS 上真实媒体目录；这是宿主机路径，容器内统一使用 `/media`。
   - 将 `accessHosts` 中的 `192.168.1.10` 替换为其他设备实际访问的 NAS IP 或主机名，不填写 `http://` 或端口。
   - 将 `JAVDEX_UPDATE_PUBLIC_URL` 替换为桌面能访问的 HTTPS 根地址，例如 `https://NAS实际IP:8097`；业务 HTTP 8096 和更新 HTTPS 8097 均只向可信局域网或私有网络开放。
   - **服务端媒体库目录必须具备读写权限**。媒体卷使用 `:rw` 挂载，并确保宿主机/NAS 的文件权限允许容器内 `node` 用户读写所选目录及其内容；具体要求见下文[媒体目录权限](#媒体目录权限)。
   - `/data` 使用持久数据卷，数据库与图片都保存在其中；不要将 SQLite 数据卷放在 SMB/NFS 共享上。
   - `/program` 使用独立持久卷，保存业务发行选择、更新凭据、任务日志与升级前快照。不要与数据或图片目录互相包含，也不要用 Compose 的 `user:` 覆盖管理进程身份；管理器以容器内 root 启动非 root 业务子进程。

3. 在配置文件所在目录拉取并启动，再查看启动日志：

   ```bash
   docker compose -f docker-compose.example.yml pull
   docker compose -f docker-compose.example.yml up -d
   docker compose -f docker-compose.example.yml logs --tail=50 javdex
   ```

4. 在服务机器上生成首次连接令牌：

   ```bash
   docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js bind --config /config/server.json
   ```

   在同版本桌面应用打开“设置 → 存储与导出 → 资料库连接”，选择远程资料库，填写 `http://NAS实际IP:8096`，点击“测试连接”核对服务和版本，再保存并点击“立即重启”。在“正在使用”填写命令输出的一次性令牌，点击“领取写入凭据”。连接测试不会领取凭据。令牌有效期为 10 分钟，过期后重新生成。网页密码与桌面写入令牌用途不同，首次认主完成前网页不能浏览资料。

5. 在桌面创建媒体库，在“来源与扫描 → 添加目录”中选择服务端挂载 **`library`**（对应示例 `mediaMounts` 的键）或其中的子目录，然后启动扫描。不要选择桌面电脑的文件夹。
6. 其他设备在浏览器打开同一地址，用配置中的账号密码登录；或在连接服务端的桌面中开启网页配对并批准新设备。远程桌面默认用内置播放器读取服务端授权的原文件流，在此电脑解码；也可在“资料库连接 → 播放器”选择支持网络播放的外部程序。播放运行库和平台要求见 [播放影片](USER_GUIDE.md#播放影片)。网页仍按浏览器原生播放能力选择资源，不支持的文件可下载；服务端不转码。

关闭桌面不会关闭容器。示例已配置 `restart: unless-stopped`，Docker 启动后会恢复非手动停止的容器。服务配置修改后重新创建容器；密码不要提交到公开仓库。首次部署成功后，可按 [配对与客户端使用](SERVER_UPDATE.md#配对与客户端使用) 授权桌面托管更新。后续业务升级通过已配对入口安装签名 `.javdex-update`；管理器、Node 与系统更新仍由管理员更换基础镜像。

### 连接失败时

| 现象 | 先检查 |
|---|---|
| 浏览器返回 403 | `accessHosts` 是否包含实际访问地址的主机名/IP |
| 连接超时 | 容器是否运行、端口是否映射、防火墙是否允许同网设备访问 |
| 提示尚未认主 | 是否已在桌面领取写入凭据；网页登录不能代替认主 |
| 桌面提示版本不符 | 桌面安装包与服务端是否来自同一源码版本 |
| 添加目录、扫描或导出提示权限不足 | 媒体卷是否为 `:rw`，宿主机/NAS 权限是否允许服务进程读写所选目录及其子目录；详见[媒体目录权限](#媒体目录权限) |
| 扫描找不到文件 | 宿主机挂载路径、挂载名称及服务进程是否能访问实际文件 |
| 能浏览但不能播放 | 浏览器是否支持视频编码；当前不转码，可下载后用本地播放器打开 |

## 网络与凭据边界

业务管理接口和网页面向可信局域网，默认使用 HTTP 8096；业务入口本身不终止 TLS。跨不可信网络访问时，应由部署者在受控反向代理或私有网络入口终止 HTTPS，并限制来源。独立更新入口使用 HTTPS 8097，桌面通过管理员提供的配对信息固定证书指纹。writer、网页登录 Cookie、播放 grant 和更新配对 JSON 都应按凭据处理，不写入日志或分享链接。

`play.grant` 生成的资源地址固定有效 12 小时，持有者在期限内可读取对应资源。它是能力链接，不是永久媒体地址；不要转发到群聊、公开播放器列表或外部索引。需要立即收回时应撤销相关访问条件或停止服务，不能只等待网页退出。

## 版本

桌面应用、实际运行的服务端业务程序与其网页包必须来自同一源码版本。基础镜像标签只标识运行外壳及初始化种子；以业务握手/更新状态显示的版本为准。握手发现应用版本不一致时，桌面进入版本不符状态，不打开本机权威库，也不自动改连其他地址；独立更新配对仍可跨业务版本使用。

0.8.0 正式资料库为 schema 19，0.9.0 首次打开时迁移至 schema 20。模型管理文档版本 4 属于桌面配置，不是数据库 schema 或服务端更新协议版本；模型与凭据配置仍保存在桌面，不随服务端备份转移。升级前另行备份桌面数据目录。

## 存储与进程

- `dataDir`：绝对路径，存放 `library.db`、任务、备份与恢复暂存。不要与 `imagesDir` 设成同一目录。
- `imagesDir`：正式图片目录（默认 `{dataDir}/media_assets`）。
- 桌面远程模式下，“存储与导出 → 图片资源”只读显示服务端当前目录。更改 `imagesDir` 前先迁移现有图片并备份，随后重启服务；切换桌面模式不会移动或覆盖本机图片。
- `mediaMounts`：配置文件中的挂载名 → 绝对目录。扫描与 NFO 只使用这些目录。媒体库来源目录必须满足下述读写权限要求。
- 以专用 UID/GID 运行进程；数据目录与挂载应对该用户可读写。不要用桌面用户数据目录充当服务 `dataDir`。
- 同一 `dataDir` 同时只允许一个宿主进程。

### 媒体目录权限

**服务端媒体库的来源目录必须允许服务进程读写，包括实际使用的子目录及文件。** 即使只计划扫描和播放，首次添加来源目录也需要创建 `.javdex-root` 标记；重命名媒体文件、导出 NFO 和配套图片还会写入媒体目录。部署时不要将媒体库来源配置为只读目录。

- **Docker 挂载权限**：媒体卷使用读写挂载（示例为 `/absolute/path/to/media:/media:rw`），不能设为 `:ro` 或 `read_only: true`。配置文件 `/config/server.json` 的只读挂载可以保留。
- **宿主机文件权限**：读写挂载不会自动授予文件系统权限。还需在宿主机或 NAS 上，让业务进程的 UID/GID 拥有所选目录及其内容的读写权限；业务默认为 `node`（1000/1000），托管镜像由容器内 root 管理进程启动该非 root 子进程，可通过 `JAVDEX_SERVER_UID/GID` 调整。Linux 目录还需要进入/遍历权限（`x`），上级目录也必须可遍历；网络共享需同时检查共享权限和 ACL。
- **分别检查数据与媒体目录**：`/data` 可写并不代表 `/media` 可写。使用挂载下的子目录创建媒体库或恢复目录映射时，也需检查该子目录的权限。

## 开发者源码构建与配置

从仓库根目录构建：

```bash
npm ci
npm run server:build
```

产物为 `out/server`，包含网页和服务端入口，另有 `out/updater` 容器内管理入口。独立 Node 部署仍可在产物目录安装生产依赖后，以 `node index.js start --config /etc/javdex/server.json` 启动，但不包含托管更新；不需要 Electron rebuild。源码方式的 `docker build` 和 `npm run server:smoke` 前必须先运行 `npm run server:build`，烟测会在产物不完整时直接报错。管理入口监督非 root 业务子进程，初始化并保留程序卷，不会替你选择媒体挂载；业务 Web 资源始终来自当前发行目录，不沿用旧镜像的 `/app/web`。若 Docker 构建环境无法访问默认 npm 源，可设置 `JAVDEX_SMOKE_NPM_REGISTRY`，脚本会将其传给 Dockerfile 的 `NPM_CONFIG_REGISTRY` 构建参数。

`server:smoke` 在 Windows Docker Desktop 上使用 Docker 数据卷保存 SQLite；`server:smoke:backup` 使用独立测试容器和卷验证双向备份恢复及桌面本机导入，不覆盖已有资料。后者还需桌面导出 worker 和测试镜像，构建步骤见 [开发说明](DEVELOPMENT.md)。

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

环境覆盖项为 `JAVDEX_DATA_DIR`、`JAVDEX_IMAGES_DIR`、`JAVDEX_STATIC_ROOT`、`JAVDEX_LISTEN_HOST`、`JAVDEX_LISTEN_PORT`、`JAVDEX_ACCESS_HOSTS`（逗号分隔）、`JAVDEX_WEB_USERNAME`、`JAVDEX_WEB_PASSWORD`。配置文件仍为必需；字段及默认值以 [config.ts](../apps/server/src/config.ts) 为准。日常部署使用固定端口；端口 0 仅用于需要系统分配端口的场景。

## 启动与认主

配置文件经 `--config` 或 `JAVDEX_SERVER_CONFIG` 提供。官方托管容器由 Compose 启动，认主和恢复应执行程序卷中当前版本的业务 CLI：

```bash
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js bind --config /config/server.json
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js recover --config /config/server.json
```

不要直接运行镜像内 `/app/index.js`：它是初始化种子，不一定是当前业务版本。独立 Node 源码部署不含托管更新；运行构建产物时使用 `node /部署目录/index.js`，安装了 `javdex-server` 命令时使用下列形式：

```bash
javdex-server start --config /etc/javdex/server.json
javdex-server bind --config /etc/javdex/server.json
javdex-server recover --config /etc/javdex/server.json
```

`bind` 在尚未认主时签发一次性令牌；桌面用该令牌领取 writer，秘密只存在本机安全存储。`recover` 在丢失 writer 秘密后签发恢复令牌。`JAVDEX_BOOTSTRAP_TOKEN` 仅用于首次启动写入引导令牌，不是 occupancy 文件。网页账号使用 `web.passwordHash` 或环境变量 `JAVDEX_WEB_PASSWORD`；Cookie 不能调用管理接口。

交接/恢复领取遇到扫描、维护任务或未完成的文件操作时返回 `MAINTENANCE_BUSY`。请求不排队、不占用交接资格，也不消耗一次性令牌；操作者应完成或取消任务后重试（令牌过期需重新签发）。原 writer 在交接成功前保持有效，新维护任务不会因一次失败的交接而被禁止。成功领取仍是原子操作，同一成功 claim 的重试不增加写入代次。`writer.status.maintenanceBusy` 表示当前有维护任务，不表示有人排队。

桌面在“设置 → 存储与导出 → 资料库连接”选择远程地址后重启生效。远程模式只使用桌面设置、凭据与 `desktop-work.db`，不打开原 `library.db`。工作记录未复制完成时拒绝远程启动。

## 备份、恢复与本机导入

统一在桌面“设置 → 存储与导出 → 备份与恢复”操作。远程资料库须先连接并领取有效写入授权；支持已认主的空库或非空库，不需要额外迁库令牌。

- **创建备份**：备份当前本地或服务端资料库，保存到这台电脑。也可把文件带到另一台电脑后恢复。
- **从备份恢复**：选择备份，按向导对应目标资源目录并核对覆盖影响；执行前自动备份目标，再替换正式资料与图片。目标服务配置、挂载配置和认主关系保留。
- **从本机资料库导入**：在远程模式中由桌面隔离导出本机资料，再上传并恢复到服务端。来源资料库保留且可独立使用，两份资料不自动同步。

原始视频不会打包或上传；服务端资源需位于配置的挂载目录内。备份包含正式资料、图片、清单和评分，不包含登录凭据、插件/模型配置及桌面工作记录。加密图片只在备份副本中解密，备份文件不加密。压缩包和展开内容分别上限 64 GiB，传输分块为 8 MiB，支持断点续传。

恢复前会处理目录映射、缺失资源与自动保护备份；提交阶段不可取消。操作失败或连接中断时，在操作记录中检查原任务并按提示继续，避免重复发起恢复。详细范围与流程见 [使用指南](USER_GUIDE.md#备份与恢复)。

旧离线迁库尚未正式发布，现已移除其 CLI、管理接口及专用包格式；不提供旧包或旧任务兼容入口。

## 更新与恢复限制

0.9.0 使用单容器内置更新管理器，提供正式版在线更新与完整签名包离线上传。0.8.0 镜像没有这项能力：首次升级须正常停服并完整备份 `dataDir`、`imagesDir`、部署配置及旧镜像，再采用 0.9.0 基础镜像、增加独立 `/program` 卷和更新端口；新卷首次启动直接采用镜像中的业务程序并迁移数据库，不会先为这次部署变更生成托管升级快照。具体步骤见 [部署与首次采用](SERVER_UPDATE.md#部署与首次采用)。

已有托管程序卷时，更改 `.env` 的 `JAVDEX_VERSION` 并 `pull` / `up -d` 只更换基础镜像，不覆盖已选择的业务版本；后续业务切换需通过桌面配对入口完成。默认在线检查只读取正式 Release，预发布需显式离线导入；同版本、降级、错误架构、未知签名和不支持的 schema 路径均不能绕过。

保留原数据与程序卷，不要执行 `docker compose down -v`。schema 20 不能交给 0.8.0 或其他旧版应用；回退需恢复升级前完整备份及匹配程序，不可手工降低 `user_version`、修改模型文档版本或清空程序卷强制切换。未发布或不完整的开发 schema 快照会被拒绝，应恢复受支持的升级前备份。提交前托管更新失败可自动恢复，提交后不自动覆盖新写入；出现“需要人工恢复”时保留现场，按 [安装、验证和恢复](SERVER_UPDATE.md#安装验证和恢复) 处理。

服务端备份不包含桌面采集草稿和运行记录，后者在桌面 `desktop-work.db` 中，桌面数据目录也需单独备份。资料库维护期间不能领取写入凭据。

## 功能与使用边界

远程资料管理、文件重命名、待确认队列定位与精确查询、审计筛选、来源匹配、单条/批量刮削及清单影片链接已接线。刮削插件、Agent、模型调用、浏览器登录、网络采集、候选草稿和暂存图片仍在桌面运行；预览时服务端校验权威资料，最终应用时才接收候选与已选图片，服务端只保存正式资料、正式图片或待确认候选。批量直接选择最多 200 个 ID，更大范围用筛选；取消采集不会撤回已经受理的写入。

远程模式在媒体库的“来源与扫描 → 添加目录”中浏览部署配置 `mediaMounts` 列出的挂载（例如 `library`）及其子目录，确认服务端路径后添加。服务端会重新校验所选目录始终位于配置的挂载内；此入口不选择桌面本机文件夹。

服务端扫描启用“自动导入本地 NFO”后，使用与桌面相同的来源解析、候选暂存和资料应用流程，支持标题、演员及挂载目录内的封面、样张、演员头像。多候选按现有策略进入待确认；正式应用递增影片版本，旧编辑须刷新后重试。图片只通过已授权根目录能力读取，不接受 NFO 中的远程图片作为下载授权。NFO 导出仍支持 XML。

远程桌面连接且取得写入权限后，可在“网页访问”中开启配对、核对并批准/拒绝配对码，管理已配对设备。服务端地址、端口和登录配置仍由部署配置管理；会话断开或资料库冻结时隐藏操作控件。网页配对只授予浏览权限，不授予管理 API 权限。

远程不支持本机文件夹操作、根重绑、图片加密或资产目录搬迁。服务端首版无转码，挂载使用固定标记保护，不识别换卷。能力细节和代码入口统一见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)。
