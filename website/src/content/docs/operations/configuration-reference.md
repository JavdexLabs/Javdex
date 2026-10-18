---
title: 路径、配置与环境变量速查
description: Javdex 各平台真实存储路径、userData 与 /program 文件字典、server.json 配置规范、环境变量全表及 SQLite Schema v21（48 张表）全景参考。
---

本手册完全基于 Javdex `0.9.0` 源码整理，汇总了各操作系统的真实数据路径、目录文件拓扑、`/config/server.json` 字段合同、全部 `process.env` 环境变量以及 SQLite Schema v21 的 48 张数据表。

---

## 各操作系统与容器默认路径总表

依据 `apps/desktop/src/main/appPaths.ts` 与 `apps/desktop/src/main/services/localModels/modelStorage.ts`：

| 运行环境 | 核心应用数据目录 (`<userData>`) | 默认图片资源目录 (`media_assets`) | 默认本地 AI 模型与运行库目录 (`local-ai`) |
| :--- | :--- | :--- | :--- |
| **Windows 桌面端** | `%APPDATA%\Javdex`<br/>(`C:\Users\<用户名>\AppData\Roaming\Javdex`) | `%APPDATA%\Javdex\media_assets`<br/>（可在“设置 -> 存储 -> 图片资源”中迁移） | **`%LOCALAPPDATA%\Javdex\local-ai`**<br/>(`C:\Users\<用户名>\AppData\Local\Javdex\local-ai`，独立存放在 Local 目录避免撑爆漫游配置；可在设置中迁移) |
| **macOS 桌面端** | `~/Library/Application Support/Javdex` | `~/Library/Application Support/Javdex/media_assets` | `~/Library/Application Support/Javdex/local-ai` |
| **Linux 桌面端** | `${XDG_CONFIG_HOME:-~/.config}/Javdex` | `${XDG_CONFIG_HOME:-~/.config}/Javdex/media_assets` | `${XDG_CONFIG_HOME:-~/.config}/Javdex/local-ai` |
| **Docker 独立服务端** | `/data`（容器持久化数据卷，严禁 NFS/SMB/FUSE） | `/data/media_assets`（或由 `imagesDir` / `JAVDEX_IMAGES_DIR` 指定独立挂载卷） | 服务端不运行本地 AI 模型（另需挂载 `/program` 托管程序卷与 `/media` 媒体卷） |

---

## `<userData>` 与 `/program` 目录文件字典

### 1. 桌面端 `<userData>`（与服务端 `/data`）文件结构

| 文件 / 子目录 | 用途与技术说明 | 加密与安全保护 | 是否纳入 `.javdex-backup` |
| :--- | :--- | :--- | :---: |
| `library.db` (`-wal`, `-shm`) | 主资料库 SQLite 数据库（Schema v21，WAL 并发模式）。 | 明文 SQLite | ✅ 是（净化后） |
| `desktop-work.db` (`-wal`, `-shm`) | 桌面端专属 Agent 运行会话、工具账本与采集草稿数据库（10 张 `agent_*` 表）。 | 明文 SQLite | ❌ 否 |
| `media_assets/` | 受管图片根目录：含 `covers/`、`samples/`、`avatars/`、`avatar_sources/`、`actress_gallery/`、`playlists/`、`classifications/` 以及多尺寸缩略图缓存 `.javdex-derived-images/v1/`（上限 `512 MiB`）。 | 可选 AES-256-GCM（开启后文件后缀为 `.javdexenc`） | ✅ 仅正式引用图片（导出时还原为明文） |
| `.media_assets_key` | 开启图片磁盘加密时生成的 32 字节 AES-256-GCM 主密钥文件。 | 本机文件权限（`0o600`） | ❌ 否 |
| `settings.json` | 全局应用配置（默认刮削源、组合刮削器字段映射、请求延迟等）。 | 明文 JSON | ❌ 否 |
| `this-computer.json` | 当前电脑专属配置（本地/远程模式、局域网 Web 开关、7 项防窥遮罩、托盘驻留、播放器偏好、AI 字幕开关）。 | 明文 JSON | ❌ 否 |
| `ai-configuration.json` | 模型管理 Schema v4 配置（云端服务商列表、工作负载模型指派、本地模型目录与加速后端配置）。 | 明文 JSON | ❌ 否 |
| `ai-configuration.secrets.json` | 云端大模型服务商的 API Key 密文存储。 | Electron `safeStorage` | ❌ 否 |
| `scraper-service-secrets.json` | 自建 MetaTube 服务的 Bearer API Token 密文。 | Electron `safeStorage` | ❌ 否 |
| `writer-secrets.json` / `server-update-secrets.bin` | 远程资料库写入凭据与服务端更新配对元数据。 | Electron `safeStorage` | ❌ 否 |
| `server-certificates.bin` | 远程服务端 TOFU 首次信任固定的 TLS 自签名证书 SHA-256 指纹库。 | Electron `safeStorage` | ❌ 否 |
| `playback-progress.json` | 本机视频续播进度记录（上限 `5000` 条，播放满 `5s` 记录，距结尾 `30s` 内自动清除）。 | 明文 JSON | ❌ 否 |
| `ai-subtitle-cache/<64hex>/` | 实时生成的 AI 日中字幕 30 秒分片缓存（`<chunkIndex>.json`）。 | 明文 JSON | ❌ 否 |
| `scraper_plugins/{video,actress}/` | 用户导入或通过 Agent 创建的自定义刮削插件（`plugin.json` + `index.cjs`）。 | 明文代码 | ❌ 否（用 `.avscraper.json` 导出） |
| `scraper_resource_cache/` | 插件 `ctx.fetchBuffer` 持久化 HTTP 缓存（如 Gfriends `Filetree.json`）。 | 明文缓存 | ❌ 否 |
| `Partitions/scraper/` | 独立刮削辅助浏览器的 Chromium Cookie 与登录会话存储分区。 | Chromium 分区 | ❌ 否 |

### 2. Docker 服务端 `/program` 托管程序卷结构

```text
/program/
├── .javdex-program                 # 托管程序卷身份标记文件
├── releases/
│   └── 0.9.0/                      # 当前或已准备的业务版本生产闭包 (index.js, web/, node_modules/, release.json)
└── state/
    ├── active.json                 # 当前激活的业务版本指针
    ├── current.json                # 当前或最近一次更新任务状态账本
    ├── target.json                 # 已验证待安装的更新签名清单
    ├── image-attempts.json         # 已尝试自动升级的 Docker 镜像归档 SHA-256 记录
    ├── tls/                        # 自动生成的 3072-bit RSA 自签名 TLS 证书与私钥
    └── jobs/<jobUuid>/             # 离线分块上传暂存包 (release.tar.gz) 与任务记录 (job.json)
```

---

## 服务端 `/config/server.json` 字段规范表

依据 `apps/server/src/config.ts` 与 `deploy/javdex-server.example.json`，服务端配置文件采用扁平 JSON 结构：

```json
{
  "listenHost": "0.0.0.0",
  "port": 8096,
  "accessHosts": [
    "127.0.0.1",
    "localhost",
    "192.168.1.100",
    "nas.local"
  ],
  "dataDir": "/data",
  "imagesDir": "/data/media_assets",
  "mediaMounts": {
    "movies": "/media/movies"
  },
  "web": {
    "username": "admin"
  }
}
```

| 字段路径 | 类型 | 必填 | 默认值 | 校验规则与作用说明 |
| :--- | :--- | :---: | :--- | :--- |
| `listenHost` | `string` | 否 | `"0.0.0.0"` | 外部监听绑定地址（可被环境变量 `JAVDEX_LISTEN_HOST` 覆盖）。 |
| `port` | `number` | 否 | `8096` | 外部监听端口，范围 `0` 或 `1024..65535`（可被 `JAVDEX_LISTEN_PORT` 覆盖）。 |
| `accessHosts` | `string[]` | **是** | 无 | 允许访问的 `Host`/`Origin` 主机名或局域网 IP 列表（非空数组，支持通过 `JAVDEX_ACCESS_HOSTS` 逗号分隔覆盖）。 |
| `dataDir` | `string` | **是** | `"/data"` | 数据库与运行状态根目录（必须为本地物理文件系统，严禁与 `imagesDir` 或 `mediaMounts` 重叠）。 |
| `imagesDir` | `string` | 否 | `"<dataDir>/media_assets"` | 官方图片存储目录绝对路径（可被 `JAVDEX_IMAGES_DIR` 覆盖）。 |
| `mediaMounts` | `Record<string, string>` | **是** | `{}` | 媒体挂载点字典（键名为挂载标识，键值为容器内挂载的绝对路径，不可互相嵌套或与 `dataDir`/`imagesDir` 重叠）。 |
| `web.username` | `string` | **是** | `"viewer"` / `"admin"` | 局域网 Web 登录用户名（匹配 `/^[\w.-]{1,64}$/`，可被 `JAVDEX_WEB_USERNAME` 覆盖）。 |
| `web.passwordHash` | `string` | 条件必填 | 无 | `scrypt` 格式的密码哈希；若通过环境变量 `JAVDEX_WEB_PASSWORD` 提供 `12..128` 位明文密码，启动时会自动在内存派生哈希。 |

---

## 完整环境变量速查表 (`process.env`)

### 1. 独立服务端与容器托管网关环境变量

| 环境变量名 | 默认值 | 作用域 | 具体行为与约束说明 |
| :--- | :--- | :--- | :--- |
| `JAVDEX_SERVER_CONFIG` | `/config/server.json` | 服务端 / 管理器 | 未传 `--config <path>` CLI 参数时读取的 JSON 配置文件路径。 |
| `JAVDEX_LISTEN_HOST` | `config.listenHost` 或 `'0.0.0.0'` | 服务端 / 管理器 | 覆盖外部监听绑定地址。 |
| `JAVDEX_LISTEN_PORT` | `config.port` 或 `8096` | 服务端 / 管理器 | 覆盖外部监听端口（`0` 或 `1024..65535`）。 |
| `JAVDEX_ACCESS_HOSTS` | `config.accessHosts` | 服务端 / 管理器 | 逗号分隔的允许访问的主机名或局域网 IP 列表。 |
| `JAVDEX_DATA_DIR` | `config.dataDir`（`/data`） | 服务端 / 管理器 | 覆盖数据目录路径（强制检测本地文件系统且剩余空间 $\ge 64\text{ MiB}$）。 |
| `JAVDEX_IMAGES_DIR` | `<dataDir>/media_assets` | 服务端 / 管理器 | 覆盖官方图片存储目录绝对路径。 |
| `JAVDEX_RUNTIME_DIR` | `'/program'` | 容器管理器 | 托管更新器程序卷目录（不可与 `dataDir` 或 `imagesDir` 重叠）。 |
| `JAVDEX_SEED_DIR` | `'/app'` | 容器管理器 | 镜像内置的只读初始业务种子目录。 |
| `JAVDEX_STATIC_ROOT` | `<serverDir>/web` | 服务端 | 局域网 Web 前端静态资源目录（必须包含 `index.html`）。 |
| `JAVDEX_WEB_USERNAME` | `config.web.username` | 服务端 | 覆盖局域网 Web 登录用户名。 |
| `JAVDEX_WEB_PASSWORD` | 无 | 服务端 | 局域网 Web 登录明文密码（`12..128` 字符，启动时在内存生成 `scrypt` 哈希）。 |
| `JAVDEX_BUSINESS_UID` | `stat(dataDir).uid` 或 `1000` | 容器管理器 | 管理器通过 `setpriv --reuid` 降权启动业务子进程的 UID。 |
| `JAVDEX_BUSINESS_GID` | `stat(dataDir).gid` 或 `1000` | 容器管理器 | 管理器通过 `setpriv --regid` 降权启动业务子进程的 GID。 |
| `JAVDEX_BUSINESS_GROUPS` | `/etc/group` 中附加组 | 容器管理器 | 逗号分隔的附加 GID 列表，传给 `setpriv --groups`。 |
| `JAVDEX_INTERNAL_PORT` | `8098` | 容器管理器 | 管理器网关与内部业务子进程通信的本地回环端口（`1024..65535`）。 |
| `JAVDEX_UPDATE_STOP_TIMEOUT` | `120`（秒，范围 `5..600`） | 容器管理器 | 更新停服阶段等待业务子进程退出的超时秒数。 |
| `JAVDEX_RELEASE_KEYS_FILE` | `'/opt/javdex-manager/release-keys.json'` | 容器管理器 | 验证 `.javdex-update` 升级包 Ed25519 签名的公钥文件路径。 |
| `JAVDEX_GITHUB_API_BASE` | `'https://api.github.com'` | 容器管理器 | 在线检查服务端升级包时请求的 GitHub API 基础地址。 |
| `JAVDEX_GITHUB_REPO` | `'JavdexLabs/Javdex'` | 容器管理器 | 在线检查服务端升级包的目标仓库。 |
| `JAVDEX_BOOTSTRAP_TOKEN` | 无 | 仅裸 Node 宿主 | 长度 $\ge 16$ 的初始绑定令牌（**在 Docker 托管容器模式下被明确禁止**，容器模式须使用 `token` 命令）。 |

### 2. 桌面端、刮削辅助浏览器与 MCP 插件开发环境变量

| 环境变量名 | 默认值 | 作用域 | 具体行为与约束说明 |
| :--- | :--- | :--- | :--- |
| `DISPLAY` | 系统 X11 变量 | Linux 桌面端 | Linux 内置 `libmpv` 播放必需的 X11 / XWayland 显示服务地址（配合 `--javdex-x11`）。 |
| `XDG_CONFIG_HOME` | `~/.config` | Linux 桌面端 | 决定 Linux 下默认应用数据目录 `${XDG_CONFIG_HOME}/Javdex`。 |
| `JAVDEX_USER_DATA` / `JAVDEX_TEST_USER_DATA` | 系统默认 `userData` | 桌面端 / CLI | 覆盖默认 `<userData>` 数据目录路径，用于便携隔离运行或测试。 |
| `JAVDEX_BUNDLED_PLUGINS_ROOT` | 内置 `bundled-plugins` | 桌面端 | 当 `JAVDEX_TEST_USER_DATA` 启用时，可覆盖内置刮削插件加载根目录。 |
| `JAVDEX_BROWSER_EXECUTABLE` | 无 | 刮削辅助浏览器 | 非 Electron 环境独立运行刮削器时指定外部 Chromium 可执行文件路径。 |
| `JAVDEX_BROWSER_CHANNEL` | `'chrome'` | 刮削辅助浏览器 | 非 Electron 环境且未指定可执行文件时使用的浏览器通道。 |
| `AV_PLUGIN_DEV_KIND` | `'video'`（或 `'actress'`） | MCP 插件开发服务 | `npm run mcp:plugin-dev` 启动时指定开发影片插件还是演员插件。 |
| `AV_PLUGIN_DEV_SITE_NAME` | `'mcp-plugin-dev'` | MCP 插件开发服务 | 目标站点名称。 |
| `AV_PLUGIN_DEV_SITE_URL` | `undefined` | MCP 插件开发服务 | 目标站点主页 URL。 |
| `AV_PLUGIN_DEV_SUPPORTED_FIELDS` | `''` | MCP 插件开发服务 | 逗号分隔的插件声明支持字段列表。 |
| `AV_PLUGIN_DEV_TEST_TARGETS` | `undefined` | MCP 插件开发服务 | 逗号或换行分隔的测试番号或测试演员名列表。 |
| `AV_PLUGIN_DEV_WORKSPACE` | `<tmpdir>/javdex-plugin-dev-mcp/<id>` | MCP 插件开发服务 | MCP 插件开发会话的工作区目录路径。 |

---

## SQLite 数据库 Schema v21 表结构概览（共 48 张表）

依据 `packages/library/src/db/schema.ts`，Javdex 的 48 张持久化表（另有 10 张 `desktop-work.db` Agent 表与 8 张内存 `TEMP` 表）按七大业务领域组织：

| 业务领域 | 表数量 | 精确表名清单 |
| :--- | :---: | :--- |
| **1. 分类实体域** | 11 张 | `organizations`（片商/发行商，支持父子层级）、`organization_names`、`organization_name_ownership`、`organization_roles`（`maker`/`publisher`）、`organization_links`；`directors`、`director_names`、`director_links`；`series`（支持归属组织与父子系列）、`series_names`、`series_name_ownership`、`series_links`（注：含系列名所有权共 12 项分类表结构）。 |
| **2. 媒体库与影片目录域** | 13 张 | `media_libraries`、`media_library_configs`、`media_library_roots`、`videos`（含 `(publisher_organization_id, upper(trim(code)), release_date)` 唯一业务身份索引）、`library_video_memberships`、`video_lifecycle_operations`、`video_resources`（含单主资源唯一索引 `idx_video_resources_single_primary`）、`pending_local_file_deletions`（`.javdex-trash` 两阶段删除账本）、`video_sources`、`video_external_stats`、`video_assets`、`tags`、`video_tag`。 |
| **3. 演员与名称所有权域** | 9 张 | `actresses`、`video_actress`、`actress_names`、`actress_name_ownership`（`normalized_name` 全局唯一主键）、`pending_actress_name_claims`、`pending_actress_scrapes`、`pending_actress_scrape_conflicts`、`pending_actress_scrape_resources`、`actress_tags`、`actress_tag`、`actress_gallery_assets`。 |
| **4. 播放列表与外链域** | 5 张 | `playlists`（含内置 `'我喜欢'`/`favorites` 与 `'稍后观看'`/`watch_later`）、`playlist_video`、`video_links`、`actress_links`、`playlist_links`。 |
| **5. 待办中心与扫描审计域** | 11 张 | `pending_scan_groups`、`pending_scan_resources`、`pending_resource_identities`、`pending_video_scrapes`、`pending_video_scrape_sources`、`pending_video_scrape_candidates`、`pending_video_scrape_resources`、`library_scan_runs`、`media_library_scan_state`、`library_unrecognized_files`、`library_root_cleanup_jobs`、`library_scan_audit_manifests`、`library_scan_audit_entries`（触发器保护单调状态机）。 |
| **6. 远程协议与多设备授权域** | 11 张 | `catalog_identity`、`catalog_writer_credentials`（Schema 21 多可信设备表）、`catalog_one_time_tokens`、`catalog_writer_claims`、`catalog_operation_receipts`、`catalog_image_uploads`、`catalog_image_file_jobs`、`catalog_tasks`、`catalog_maintenance_plans`、`catalog_settings`、`catalog_root_markers`。 |
| **7. 桌面 Agent 工作台域 (`desktop-work.db`)** | 10 张 | `agent_runs`、`agent_resource_cleanup`、`agent_operations`、`agent_product_journal`、`agent_execution_history`、`agent_tool_ledger`、`agent_approvals`、`agent_artifacts`、`agent_metadata_drafts`、`agent_metadata_draft_resources`。 |
