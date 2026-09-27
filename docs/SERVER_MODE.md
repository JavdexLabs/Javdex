# 服务端模式：部署、认主与备份恢复

本页维护当前部署与操作方式。实现、合同和功能边界见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)，进度与验证结果见 [当前状态](SERVER_MODE_NEXT_STEPS.md)。桌面日常操作见 [使用指南](USER_GUIDE.md)，只读网页见 [LAN Web](LAN_WEB.md)。

本页按 **0.8.0-beta.3** 说明部署。桌面安装包与 `ghcr.io/javdexlabs/javdex-server:0.8.0-beta.3` 必须成对使用，不要把 0.7.1 安装包接到本版服务端。Beta 不代表全部部署环境已完成验收，首次试用建议使用独立测试资料库。

## 服务端能做什么

- 独立保存影片、演员、分类、清单、正式图片和待确认资料，扫描已配置的媒体目录，导入本地 NFO 与配套图片。
- 通过同版本桌面应用管理远程资料、处理扫描与刮削结果；桌面关闭后，服务端扫描与网页访问仍可继续。
- 向同一网络的浏览器提供搜索、浏览、原生播放和本地资源下载，支持密码登录、设备配对与授权撤销。
- 刮削插件、AI、浏览器会话和采集草稿在桌面运行，服务端接收确认后的资料和图片。不提供网页编辑后台、无人值守云端刮削或视频转码。

## Docker Compose 快速开始

正式发布流程提供 `ghcr.io/javdexlabs/javdex-server` 镜像，支持 Linux amd64 和 arm64，Docker 会自动选择对应架构。用户只需要 Docker 与 Compose 插件，无需 Node.js、npm 或编译源码。`0.8.0-beta.3` 镜像随该预发布条目一起提供，不会更新 `latest`。首次试用建议新建独立资料库。

1. 从所选 Release 下载 `docker-compose.example.yml` 和 `javdex-server.example.json`，放在同一个目录。在该目录创建 `.env`，填写与桌面安装包一致的版本号（不含 `v`）：

   ```dotenv
   JAVDEX_VERSION=0.8.0-beta.3
   ```

2. 编辑 [Compose 示例](../deploy/docker-compose.example.yml) 和 [服务配置](../deploy/javdex-server.example.json)：
   - 将 `JAVDEX_WEB_PASSWORD` 替换为独立的 12–128 字符密码。
   - 将 `/absolute/path/to/media` 替换为 NAS 上真实媒体目录；这是宿主机路径，容器内统一使用 `/media`。
   - 将 `accessHosts` 中的 `192.168.1.10` 替换为其他设备实际访问的 NAS IP 或主机名，不填写 `http://` 或端口。
   - **服务端媒体库目录必须具备读写权限**。媒体卷使用 `:rw` 挂载，并确保宿主机/NAS 的文件权限允许容器内 `node` 用户读写所选目录及其内容；具体要求见下文[媒体目录权限](#媒体目录权限)。
   - `/data` 使用持久数据卷，数据库与图片都保存在其中；不要将 SQLite 数据卷放在 SMB/NFS 共享上。

3. 在配置文件所在目录拉取并启动，再查看启动日志：

   ```bash
   docker compose -f docker-compose.example.yml pull
   docker compose -f docker-compose.example.yml up -d
   docker compose -f docker-compose.example.yml logs --tail=50 javdex
   ```

4. 在服务机器上生成首次连接令牌：

   ```bash
   docker compose -f docker-compose.example.yml exec javdex node index.js bind --config /config/server.json
   ```

   在同版本桌面应用打开“设置 → 存储与导出 → 资料库连接”，选择远程资料库，填写 `http://NAS实际IP:8096`，点击“测试连接”核对服务和版本，再保存并点击“立即重启”。在“正在使用”填写命令输出的一次性令牌，点击“领取写入凭据”。连接测试不会领取凭据。令牌有效期为 10 分钟，过期后重新生成。网页密码与桌面写入令牌用途不同，首次认主完成前网页不能浏览资料。

5. 在桌面创建媒体库，在“来源与扫描 → 添加目录”中选择服务端挂载 **`library`**（对应示例 `mediaMounts` 的键）或其中的子目录，然后启动扫描。不要选择桌面电脑的文件夹。
6. 其他设备在浏览器打开同一地址，用配置中的账号密码登录；或在连接服务端的桌面中开启网页配对并批准新设备。远程桌面播放可在“资料库连接”设置播放器程序，例如 mpv 的绝对路径。该播放器接收服务端授权的原文件流，由播放器决定能否解码；网页仍按浏览器原生播放能力选择资源，不支持的文件可下载。

关闭桌面不会关闭容器。示例已配置 `restart: unless-stopped`，Docker 启动后会恢复非手动停止的容器。服务配置修改后重新创建容器；密码不要提交到公开仓库。部署固定版本，不使用滚动标签，以免与桌面版本不匹配。

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

首版管理接口和网页面向可信局域网。应用本身不终止 TLS；跨不可信网络访问时，应由部署者在受控反向代理或私有网络入口终止 HTTPS，并限制来源。writer、网页登录 Cookie 和播放 grant 都应按凭据处理，不写入日志或分享链接。

`play.grant` 生成的资源地址固定有效 12 小时，持有者在期限内可读取对应资源。它是能力链接，不是永久媒体地址；不要转发到群聊、公开播放器列表或外部索引。需要立即收回时应撤销相关访问条件或停止服务，不能只等待网页退出。

## 版本

桌面应用、服务镜像与网页包必须来自同一源码版本。握手发现应用版本不一致时，桌面进入版本不符状态，不打开本机权威库，也不自动改连其他地址。

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
- **宿主机文件权限**：读写挂载不会自动授予文件系统权限。还需在宿主机或 NAS 上，让服务进程的 UID/GID 拥有所选目录及其内容的读写权限；官方镜像默认以 `node` 用户运行。Linux 目录还需要进入/遍历权限（`x`），上级目录也必须可遍历；网络共享需同时检查共享权限和 ACL。
- **分别检查数据与媒体目录**：`/data` 可写并不代表 `/media` 可写。使用挂载下的子目录创建媒体库或恢复目录映射时，也需检查该子目录的权限。

## 开发者源码构建与配置

从仓库根目录构建：

```bash
npm ci
npm run server:build
```

产物为 `out/server`，包含网页和服务端入口。独立部署时在产物目录安装生产依赖后，以 `node index.js start --config /etc/javdex/server.json` 启动；不需要 Electron rebuild。仓库的 Dockerfile 只打包已经生成的 `out/server`，因此 源码方式的 `docker build` 和 `npm run server:smoke` 前必须先运行 `npm run server:build`；烟测会在产物不完整时直接报错。镜像内以 `node` 用户运行，不会替你生成配置或挂载媒体目录。若 Docker 构建环境无法访问默认 npm 源，可在运行容器烟测前设置 `JAVDEX_SMOKE_NPM_REGISTRY`，脚本会将其传给 Dockerfile 的 `NPM_CONFIG_REGISTRY` 构建参数。

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

配置文件经 `--config` 或 `JAVDEX_SERVER_CONFIG` 提供。安装了 `javdex-server` 命令时使用下列形式；运行构建产物时将命令名替换为 `node /部署目录/index.js`，Docker 中使用镜像的 Node 入口：

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

更新前正常停止服务，完整备份 `dataDir`、`imagesDir` 及部署配置，桌面数据目录也需单独备份。将 `.env` 中的 `JAVDEX_VERSION` 改为新版本，执行上面的 `pull` 和 `up -d`；桌面安装包同时升级到相同版本。保留原数据卷，不要执行 `docker compose down -v`。

Beta 首次启动可能升级数据库。当前 schema 为 19，不应将升级后的库交给旧版应用；回退需恢复升级前完整备份及匹配版本，不可手工降低数据库版本。服务端备份不包含桌面采集草稿和运行记录，后者在桌面 `desktop-work.db` 中。资料库维护期间不能领取写入凭据。

## 功能与使用边界

远程资料管理、文件重命名、待确认队列定位与精确查询、审计筛选、来源匹配、单条/批量刮削及清单影片链接已接线。刮削插件、Agent、模型调用、浏览器登录、网络采集、候选草稿和暂存图片仍在桌面运行；预览时服务端校验权威资料，最终应用时才接收候选与已选图片，服务端只保存正式资料、正式图片或待确认候选。批量直接选择最多 200 个 ID，更大范围用筛选；取消采集不会撤回已经受理的写入。

远程模式在媒体库的“来源与扫描 → 添加目录”中浏览部署配置 `mediaMounts` 列出的挂载（例如 `library`）及其子目录，确认服务端路径后添加。服务端会重新校验所选目录始终位于配置的挂载内；此入口不选择桌面本机文件夹。

服务端扫描启用“自动导入本地 NFO”后，使用与桌面相同的来源解析、候选暂存和资料应用流程，支持标题、演员及挂载目录内的封面、样张、演员头像。多候选按现有策略进入待确认；正式应用递增影片版本，旧编辑须刷新后重试。图片只通过已授权根目录能力读取，不接受 NFO 中的远程图片作为下载授权。NFO 导出仍支持 XML。

远程桌面连接且取得写入权限后，可在“网页访问”中开启配对、核对并批准/拒绝配对码，管理已配对设备。服务端地址、端口和登录配置仍由部署配置管理；会话断开或资料库冻结时隐藏操作控件。网页配对只授予浏览权限，不授予管理 API 权限。

远程不支持本机文件夹操作、根重绑、图片加密或资产目录搬迁。服务端首版无转码，挂载使用固定标记保护，不识别换卷。能力细节和代码入口统一见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)。
