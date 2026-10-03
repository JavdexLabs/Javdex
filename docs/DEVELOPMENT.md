# Javdex 开发指南

[返回产品介绍](../README.md) · [使用指南](USER_GUIDE.md) · [版本与发布](VERSIONING_AND_RELEASE.md)

本文面向从源码运行、修改或打包 Javdex 的开发者。安装和日常操作见使用指南。

## 环境与本地启动

使用 Node.js 22、npm，以及 Windows、macOS 或 Linux。CI 使用 Node.js 22；依赖版本以仓库锁文件为准。

```bash
git clone https://github.com/JavdexLabs/Javdex.git
cd Javdex
npm ci
npm run setup:desktop
npm run dev
```

`npm ci` 安装锁定的 workspace 依赖，根安装不再自动触发 Electron rebuild。桌面开发/测试随后显式运行 `npm run setup:desktop`；如原生模块构建失败，按日志补齐开发环境后重试。服务端产物使用独立的生产依赖安装，不运行该桌面准备命令。

开发启动使用应用的用户数据目录，测试隔离机制见 [appIdentity.ts](../packages/contracts/src/appIdentity.ts) 与相关测试。调试数据库、扫描或删除行为前，使用测试资料与独立测试目录。

## 0.8.0 数据库迁移

v0.6.2 使用 schema 15，v0.7.x 使用 schema 16，v0.8.0 使用 **schema 19**：17 引入 catalog 身份、写入凭据和操作回执；18 引入图片上传及关联实体版本保护；19 引入持久任务表。0.7.x 升级时执行 16 → 19；0.8.0 Beta 已使用 schema 19，不因正式版版本号变化重复升级。具体迁移以 `packages/library/src/db/migrations.ts` 为准。

已运行旧开发分支的数据库不属于已发布升级路径。旧不完整 schema 16 与开发 schema 17/18 会明确拒绝打开，保持数据和版本不变；使用匹配的开发构建或升级前备份处理，不要手动降低 `user_version`。合并迁移不会替用户改写已有开发数据库。正式 17 仍靠协议表结构识别，不能仅靠 `user_version = 17` 接受历史实验快照。

旧性能报告和原始证据中的 V17/V18 编号保留为当时的历史记录；当前迁移以 `packages/library/src/db/migrations.ts` 为准。回归测试使用从官方 v0.6.2 冻结的 schema SQL，验证数据保留、DDL 一致性及各阶段失败回滚。

## 检查与构建

```bash
npm run typecheck       # 主进程与渲染端类型检查
npm run lint            # TypeScript 与 CSS 检查
npm run check:encoding  # 检查可疑编码字符
npm test                # 完整检查与测试
npm run test:ui         # 小型真实浏览器交互回归（PR CI）
npm run test:ui:matrix   # 完整主题/尺寸/页面矩阵（独立入口）
npm run build           # 生产构建与运行时资源校验
npm run measure:renderer # 已构建 renderer 的静态闭包体积与选择性加载检查
npm start               # 预览生产构建
```

`npm test` 会先运行架构边界、lint、CSS 架构和 UI 控件检查，再执行类型检查、打包运行时测试及 Electron 测试。Electron 测试自动发现 `apps/` 与 `packages/` 下的 `*.test.ts` / `*.test.tsx`，排除 `apps/server`。服务端测试单独运行 `npm run server:test`，发布元数据测试运行 `node --test scripts/release-metadata.test.mjs`；两者各有 CI 入口。测试具体入口见 [package.json](../package.json)。

`test:ui` 是独立的真实浏览器交互回归，不由 `npm test` 隐式启动；PR CI 提供稳定版 Chrome。默认使用本机 Chrome，可用 `JAVDEX_BROWSER_EXECUTABLE` 指定可执行文件，或用 `JAVDEX_BROWSER_CHANNEL` 选择已安装通道。完整矩阵默认使用 Chrome，支持后者；`JAVDEX_CSS_FIXTURE` 可传入逗号分隔的场景名运行定向检查。两个入口使用合成资料，不读取个人媒体库；完整矩阵记录截图和几何/行为断言，不是像素差异或完整 Electron GUI 验收。

需要运行特定 Electron 测试文件时：

```bash
node scripts/run-electron-tests.mjs packages/library/src/nfo/nfoArtifactCodec.test.ts
```

测试应验证真实模块的输出、交互或外部副作用。不要用 JSX 源码字符串、固定控件总数或逐项复制 CSS 声明代替行为验证；虚拟列表行高等跨模块数值约束可以保留。类型契约使用 `*.typecheck.ts`，由 TypeScript 检查，不交给运行时测试器计数。平台或系统能力不满足时应明确 `skip` 并注明原因，不能直接返回并计为通过。清理记录与保留依据见 [测试检视记录](TEST_AUDIT_2026-09-27.md)。

`npm run build` 生成 `out/`，并校验人脸检测资源与 Pi 运行时。生产构建通过不等于各平台安装包已完成验证。

桌面构建同时生成 renderer manifest 并运行 `measure:renderer`：按静态依赖闭包去重统计 JS/CSS 与 gzip 字节，检查设置页及四个低频面板仍为延迟 chunk。该报告衡量产物体积，不宣称已验证启动时间或内存收益。职责边界、阶段计划与本轮证据见 [UI 架构优化记录](UI_ARCHITECTURE_OPTIMIZATION.md)。

## 打包与发布

```bash
npm run packaging:list       # 查看启用目标和构建平台
npm run packaging:configure  # 交互选择目标
npm run dist                 # 构建配置中全部启用的目标
npm run dist:win             # Windows 目标
npm run dist:mac             # macOS 目标
npm run dist:linux           # Linux 目标
```

目标开关和架构位于 [packaging.targets.json](../build/packaging.targets.json)，基础构建配置位于 [electron-builder.config.mjs](../electron-builder.config.mjs)。本地通常选择对应平台命令；不带平台参数的 `npm run dist` 会尝试全部启用目标，不会自动筛选当前操作系统。请在目标要求的平台构建，指定 `dist:mac` 等命令不会提供跨平台编译环境。安装包输出到 `dist/`。

版本号、标签、数据库升级说明、Release 工作流和发布验证统一遵循 [版本与发布规范](VERSIONING_AND_RELEASE.md)。

### 内置播放运行库（开发分支）

内置播放的实现与尚未通过的关口见 [实施计划](BUILTIN_PLAYBACK_DESIGN_PROPOSAL.md)。`npm run playback:native:build` 只生成链接本机开发库的 addon，不是可分发运行库。普通桌面打包明确排除 `out/native-playback`、`out/playback-acceptance`、`out/libmpv-prototype` 与 `out/playback-runtime`，不把合成素材、截图、临时 Electron bundle 或 Homebrew addon 收入 `app.asar`。

原生核心的初始化、异步命令、事件复制、状态缓存与帧计数共用 `native/mpvCore.h`；Cocoa/WGL/X11 仅拥有平台窗口、GL context 和原生输入。macOS 构建先编译运行 C++ 的键位与核心回归，再生成 Cocoa addon；Linux CMake 构建运行共用核心与私有 X11 几何／句柄／键盘回归。`npm run test:playback:build` 检查构建命令选择，已纳入根测试；它本身不编译其它平台源码，也不证明可播放。

Windows WGL 适配源码与 CMake 入口已加入，**尚未在 Windows 编译或验收**。开发构建需要 Windows 本机的 MSVC、Visual Studio CMake generator、同架构 libmpv headers/import library/DLL，以及对应 Electron 的 headers 和 `node.lib`。设置 `JAVDEX_MPV_PREFIX` 为已安装开发前缀；默认 Electron 输入为 `~/.electron-gyp/<version>/include/node` 与 `<arch>/node.lib`，可分别用 `JAVDEX_ELECTRON_HEADERS` / `JAVDEX_ELECTRON_NODE_LIBRARY` 覆盖。运行时须让该开发库的 `bin` 进入启动应用的 PATH；构建器只为自己的测试子进程加入此目录，不复制 DLL、不下载依赖、不修改用户系统环境。WGL 不等于 ANGLE 直接硬解，硬解结果须从实际内核状态核对。

Windows 构建还直接编入已安装 `@electron/rebuild` 所依赖的 node-gyp 延迟加载钩子，并链接 `delayimp`、`/DELAYLOAD:node.exe`；仅链接 `node.lib` 不足以在 Electron 或改名后的应用可执行文件中加载。构建器解析依赖自身的钩子路径，不下载或修改上游文件。缺少钩子时停止构建；对应许可见 [第三方说明](THIRD_PARTY_NOTICES.md#node-gyp-延迟加载钩子)。依据为 [Electron 原生模块说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules#a-note-about-win_delay_load_hook)，命令及配置回归不等于 Windows 实际编译/加载通过。

Linux X11／XWayland adapter 与显式启动选项已加入，原生 Wayland 后续补齐。先退出应用，再以 `--javdex-x11`（或 Electron 的 `--ozone-platform=x11`）启动；未显式选择时内置播放不可用，不依据环境变量或 Buffer 宽度猜测 backend。冲突的 ozone 选项拒绝启动；缺少 `DISPLAY` / X server 时给出不可用原因，不自动回退外部播放器。当前提供命令行选择，尚未提供设置页启动开关；不切换系统桌面、不静默强制 X11。开发构建需要 CMake、C++17 编译器、make、pkg-config、X11/GLX/OpenGL/Xft 开发库及同架构 libmpv；设置 `JAVDEX_MPV_PREFIX`（系统前缀如 `/usr`），然后运行 `npm run playback:native:build`。库路径须由开发环境提供，构建器不复制 `.so` 或安装依赖。实际源码、隔离编译及未验收项见 [平台记录](BUILTIN_PLAYBACK_PLATFORM_ADAPTERS.md#10-本轮实施记录2026-10-03)。

可选的 Linux 无 GUI 编译检查使用 `scripts/playback-linux-compile.Dockerfile`；需要本机已有可用 Docker，不能替代 GUI、GPU、音频或干净安装验收。用 `mktemp -d` 创建专用构建目录，只复制 `apps/desktop/src/main/player/native/` 为 `native/`、匹配 Electron 版本的 `include/node/` 为 `electron-headers/`，及 `scripts/playback-runtime.mjs`、`playback-runtime.test.mjs`、`packaging-runtime.mjs` 为 `scripts/`，再将该 Dockerfile 复制到专用目录。不要把整个仓库、用户资料或凭据作为 context。镜像内安装 Debian 开发依赖、运行 C++ 回归及真实 ELF 搬移测试；`docker run --rm <构建镜像>` 仅验证 Node 加载、显式 backend／句柄校验和空会话清理。镜像中的系统 libmpv 没有来源闭包清单，检查必须拒绝将该 addon 单独作为正式运行库。

经审核的运行库通过 `JAVDEX_PLAYBACK_RUNTIME_DIR` 显式指定矩阵目录，每个目标在 `<platform>-<arch>/` 下独立提供 `playback.node`、依赖库及 `runtime.json`，例如 `darwin-arm64/` 和 `darwin-x64/`。未指定时不加入运行库；已指定但目录、架构、版本或文件不匹配时停止打包，不静默生成缺少运行库的内置播放包。已有 macOS Mach-O 与 Linux ELF 技术检查，Windows PE 检查尚未实现、指定 Windows 运行库仍拒绝打包；各平台的正式运行库/安装验收均未完成，不能用清单或命令选择测试代替。

`runtime.json` v1 的输入合同如下；清单由实际运行库构建生成，不手工填入虚假的摘要：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | `1` |
| `hashStage` | `pre-sign`；这是签名前构建输入清单，不是签名后运行库的逐字节摘要 |
| `platform` / `arch` / `electronVersion` | 匹配正在打包的 Electron 平台、架构及实际版本；当前架构为 `arm64` / `x64` |
| `mpvVersion` | 与 `components` 中名为 `mpv` 的版本一致 |
| `files` | 相对路径到 SHA-256 的对象；精确覆盖全部文件，唯独不包含清单自身。禁止越界路径、符号链接和额外文件 |
| `components` | 每项包含 `name`、`version`、`license`、`binaries`，以及指向清单内非空文件的 `licenseFile`、`sourceArchive`、`buildRecipe`；所有二进制有且仅有一个来源所有者，包括 Javdex addon |

`beforePack` 核查输入；`afterPack` 再核查并复制到应用 Resources 的 `native-playback/`，复核复制结果，随后才由现有流程签名。不会覆盖已存在的运行库目录。macOS 二进制必须包含目标架构；非系统动态依赖必须通过 `@loader_path` 指向该运行库清单内的二进制，禁止开发机绝对路径、依赖搜索型 `@rpath`、越界依赖和外部 rpath。动态库自身的 install name 可为规范的 `@rpath/<文件名>`，它不是一次依赖搜索。技术检查与搬移回归入口为 `npm run test:packaging`。

Linux 使用 ELF header 和 GNU `readelf -dW` 核对 64 位小端、shared object、目标 x64/arm64、SONAME 与动态依赖，不执行输入库或用 `ldd`。RPATH/RUNPATH 只允许位于运行库内的 `$ORIGIN` 相对目录，RUNPATH 存在时不误用被覆盖的 RPATH；非系统 NEEDED 必须在这些目录中精确命中清单。禁止绝对／逃逸／空搜索项及动态 audit/filter 间接加载。系统依赖仅放行代码中明确列出的 glibc/C++ ABI、X11、GLVND 和 Xft/fontconfig/freetype 名称（不同架构 loader 分开）；这些是宿主提供的显示/字体前提，不代表可省略 mpv、FFmpeg、其它解码依赖或许可记录。该静态检查不能发现运行时 `dlopen` 的全部插件，也不核对最低 GLIBC/C++ 符号版本；目标发行版、驱动及 ABI 基线仍须实际分发审核与干净安装。

代码签名可能改变二进制字节，因此保留的 `pre-sign` 摘要只证明输入与搬移阶段一致，不能拿它比较签名后的文件。最终包须另做签名完整性和分发产物摘要检查；正式播放运行库的签名/安装验收仍未完成，不由此输入清单自动推断。

**摘要不是签名，清单不是许可合规或播放验收证明。** Javdex 采用 GPL-3.0-or-later，应用 `LICENSE`、`NOTICE`、workspace 元数据、锁文件及当前公开许可说明已同步；此前 MIT 声明保留在 `LICENSES/Javdex-MIT.txt`，既有版本不追溯改写。构建来源、选项、源码与二进制对应关系、全部间接依赖及分发义务仍需复核，第三方代码保留各自版权和许可。mpv 默认构建与可选 LGPL 构建、FFmpeg 构建选项及依赖的许可边界分别见 [mpv Copyright](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright) 和 [FFmpeg 官方说明](https://ffmpeg.org/legal.html)。当前 macOS 开发库仍依赖 Homebrew，Linux 隔离检查使用 Debian 开发库；尚未提供经过这些关口的正式运行库或干净安装包。

部分 macOS 播放回归以隔离资料目录运行：先生成 `playback:native:build`、`desktop:build`（远程另需 `server:build`），再运行 `node scripts/playback-media-acceptance.mjs` 检查合成素材，或 `node scripts/playback-subtitle-acceptance.mjs` 定向检查复杂 ASS 与原创 PGS；可加 `--bitmap-only` 缩短图像字幕回归。`npm run test:playback:fixtures` 独立核对原创 PGS 字节/像素结构，不依赖 FFmpeg、GUI 或播放运行库，已纳入根 `npm test`。远程使用 `node scripts/playback-remote-acceptance.mjs --media-matrix`；追加 `--system-subtitle-picker` 时会等待真实系统选择器分别选择生成的 SRT/ASS，不适合无人值守 CI，也不 mock 文件选择器。具体文件、像素证据、失败诊断及未覆盖范围见 [字幕验收说明](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md) 与 [PGS 验收合同/结果](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md)。GUI 回归命令仅接受 macOS，依赖开发机运行库；不代表发布、其它平台或干净安装验收。

`node scripts/playback-close-acceptance.mjs` 检查播放中正常关闭主窗口：窗口确实销毁，进程退出前内核已释放，随后应用正常退出。不要把清理移到可能被否决的 `close` 事件；本机实测还发现该事件中拆除活跃原生视图会让窗口留存。Windows 源码为 `closed` 清理保留私有隐藏 drawable/context，不用独立可见播放窗口代替主窗口嵌入；该 Windows 生命周期路径尚未实机验证。

## 官网开发

服务端源码构建、Docker 部署及更新备份见 [服务端部署指南](SERVER_MODE.md)。当前能力与接口见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)，未完成验收和历史测试边界见 [当前状态](SERVER_MODE_NEXT_STEPS.md)。服务端部署不需要 Electron，也不运行 `setup:desktop`。

官网源码位于 `website/`，图片使用 `docs/images/` 中的资源。

```bash
npm run pages:build          # 读取最新正式 Release，生成下载信息
npm run pages:preview        # 构建并本地预览
npm run pages:build:offline  # 离线构建，用于本地检查页面
```

生成目录为 `dist-pages/`。离线构建不代表线上最新下载信息已经验证。

自动部署条件见 [Pages 工作流](../.github/workflows/pages.yml)：包括 `main` 上指定官网相关路径的变更、正式 Release 发布及成功结束的 Release 工作流。部署使用默认分支内容。

README 介绍产品与首次使用，官网承接展示和下载；两者复用图片时，应说明演示数据与截图版本，避免将旧截图标成当前界面。

## 代码结构与实现边界

Javdex 使用 Electron、React、TypeScript、Vite 和 `better-sqlite3`。主要目录如下：

| 目录 | 职责 |
|---|---|
| `apps/desktop/src/main` | 扫描、刮削、图片资产、AI 工作流与应用生命周期；本地装配仍打开资料库连接 |
| `apps/desktop/src/preload` | 通过 `contextBridge` 暴露受控 IPC API |
| `apps/desktop/src/renderer` | React 页面、组件、交互与查询状态 |
| `packages/contracts/src` | 跨进程类型和 IPC 通道 |
| `apps/desktop/src/mcp` | 插件开发 MCP 服务 |
| `apps/web/src` | 独立构建的只读浏览页面 |
| `packages/library/src` | Node 路径/资源身份工具、资料库数据库、图片存储、扫描辅助、NFO、维护闸门与路径清理；扫描编排、Electron 封面导出和业务服务仍在抽离 |
| `packages/http/src` | 局域网浏览 HTTP、配对/会话、浏览 DTO 与静态资源；桌面 webAccess 生命周期仍在 desktop |
| `packages/ui/src` | 桌面和网页真实共用的纯展示组件 |
| `apps/server` | 独立 Node 入口：配置、`dataDir`/`imagesDir`/挂载、SQLite/图片、查询 worker、浏览 HTTP、管理 HTTP、writer 认主、备份恢复与播放授权；生产闭包 `out/server`。容器烟测 `server:smoke`（单容器）与 `server:smoke:backup`（隔离 Docker 双向备份恢复；需先 `setup:desktop`、`desktop:build`，并构建 `javdex-server:backup-verification` 镜像，或以 `JAVDEX_BACKUP_SMOKE_IMAGE` 指定镜像）取决于本机是否有 Docker；同版本 Linux 桌面包 + 镜像安装烟测 `smoke:same-version-install`（先 `server:build` 与 `dist:linux`）。Cursor Cloud 见根目录 `AGENTS.md` 的 Cursor Cloud specific instructions |

根通过 npm workspaces 管理内部包，统一版本；运行 `npm run check:workspaces` 检查边界。可以用 `npm run build -w @javdex/web` 单独构建网页，或 `npm run build -w @javdex/desktop` 构建桌面及附带网页。根仍暂时持有桌面打包 metadata 与生产依赖，产物目录维持 `out/`；服务端生产闭包由 `npm run server:build` 写入 `out/server`（仅 better-sqlite3 与 sharp）。调整产品版本时必须同时更新所有 workspace 的版本、内部依赖版本和 lockfile。

渲染进程不直接访问 Node.js、数据库或文件系统，相关操作通过主进程处理。图片通过应用的 `media://` 协议读取：本地模式由主进程解析 MediaAssetStore；远程模式由主进程携带管理凭据代理，不把长期凭据拼进页面地址。

插件在 Worker 沙箱中执行，通过受控 `ctx` API 访问宿主能力。内置插件开发助手支持页面探测、生成代码、试运行与验证，也可通过可选 MCP 服务接入外部工具。插件产物规范与助手实现分别查阅下表中的文档。

桌面 Agent 工作记录与正式 catalog 使用独立连接：启动在 composition root 显式绑定运行存储和草稿仓储，远程模式只打开 workStore。远程 Agent 预览发送无本机路径的候选摘要，应用时只上传已选资源；服务端不得接管 Agent runtime 或依赖桌面草稿表。本地影片详情、演员编辑及清单正式写入与 Node 宿主共用 library 用例；传输权限、资源输入及能力差异仍由宿主负责，业务 schema 由 contracts 提供。新增工作记录访问不能回退到 `getDb()`，也不能通过 SQL 表名改写选择数据库。

草稿应用、丢弃和影片删除后的工作清理依靠持久意图、catalog 回执及可重试清理恢复，不依赖跨库原子性。首次旧记录迁移保留源数据，ready 后不再复制。具体连接归属和提交顺序见 [服务端合同中的工作存储说明](SERVER_MODE_CONTRACT_INVENTORY.md#桌面工作存储与恢复)，实施与验收证据见 [架构优化方案](ARCHITECTURE_SIMPLIFICATION_PLAN.md)。涉及这些路径时，用独立 catalog/work 数据库及关闭重开测试验证恢复；同库测试不能代替跨存储验证。

### 0.8.0 后的四项维护性优化

本轮按以下顺序实施，不改变数据库 schema、业务取舍、HTTP 输入或界面布局：

| 阶段 | 实现与职责 | 验收入口 |
|---|---|---|
| 1. 清单导入身份模块 | `playlistImportIdentity.ts` 统一候选查找、强信号交集和预览有效性判断；`playlistImportRepository.ts` 保留任务状态、检查点和事务。URL 规范化独立共享，避免反向依赖仓储。 | 原有 Repository、CatalogLookup、Module 行为测试，覆盖跨库候选、陈旧预览与提交重试 |
| 2. 远程返回契约 | `catalogVideoSourceSchemas.ts` 与 `videoLifecycleSchemas.ts` 定义来源分页和影片生命周期预览／结果，类型由 schema 推导；远程适配器在接收 JSON 后校验。 | `catalogRemoteResults.test.ts` 与 Node `runtime.test.ts` 的真实 HTTP 往返 |
| 3. 详情操作流程 | `useVideoLifecycleController` 拥有预览、提交、失败重读和操作 ID；`useVideoResourceController` 拥有资源读取、标签编辑和删除。页面只接线、展示与导航，旧请求不能修改新的影片操作状态。 | `videoDetailControllers.test.tsx` 的用户操作、重复提交、失败重试及换页测试 |
| 4. 共享查询入口 | `packages/library/src/catalog/videoQueryService.ts` 拥有作用域详情、资源归属检查和投影；桌面保留查询 worker，服务端显式提供路径投影和无成员资料读取策略。 | `videoQueryService.test.ts`、Node HTTP 测试、desktop/server 边界检查及 `catalog-query-boundary.test.mjs` |

本轮远程 schema 收敛范围为 `videos.sources` 和生命周期预览／提交结果，不是宣称全部管理响应已经迁移。六个旧操作名的 schema 仍保留，但手动移出已停用；移动后的无来源成员归属自动清理，兼容结果 schema 不代表重新开放旧操作。共享包也未一刀切取消通配导出：已迁移的两个宿主入口禁止重新直接引用影片仓储，其余旧入口按业务改动逐步迁移。保留本地直连、服务端 HTTP、宿主路径策略和独立 workStore，不引入通用 RPC 框架或全局依赖注入容器。

回检约束：

- 身份模块通过 `planDetail` 返回可持久化决策，仓储不再修改强信号证据；详情计划与提交前有效性检查共用自动复用规则。列表的单番号快速路径、显式用户选择和事务推进仍保持各自职责。
- `CatalogResultSchemas` 逐操作约束 schema 输出类型；`actresses.edit` 的回执到布尔值转换也在校验器中完成。`catalogRemoteResults.typecheck.ts` 用预期编译错误防止预览、提交和布尔结果校验器互换。
- 资源控制器提供打开／关闭／完成动作，不暴露目标状态 setter。影片作用域之外另有编辑和移动会话编号：同影片关闭后重开也隔离旧响应；同步提交锁防双击，失败可重试。成功的旧请求仍使列表缓存失效，但不关闭新会话、不提示或导航到新页面。
- 回归入口为 `npm test` 与 `npm run server:test`；本机自动化通过不代表完整 GUI、跨平台安装或 Linux 故障注入验收。环境跳过项需单独报告。

2026-09-28 本轮回检：`npm test` 退出码为 0（包含架构检查、lint、类型检查、打包脚本测试；Electron 3297 通过、2 项 Windows 路径语义测试跳过）；`npm run server:test` 退出码为 0（47 通过、6 项真实挂载／mpv／Linux 环境测试跳过）。详情控制器新增用例先复现重复保存与关闭后延迟重开，再验证修复；本轮未执行完整 GUI 或跨平台安装验收。

## 按任务查阅文档

先阅读根目录 [AGENTS.md](../AGENTS.md) 的仓库约定，再按实际改动选择文档，无需通读全部设计与研究资料。

| 工作区域 | 文档 |
|---|---|
| 领域术语与数据归属 | [领域上下文](../CONTEXT.md)、[多媒体库设计](MULTI_LIBRARY_DESIGN.md) |
| UI、样式和交互 | [UI 设计规范](UI_DESIGN_GUIDELINES.md)、[组件契约](UI_COMPONENT_CONTRACTS.md) |
| 局域网 Web 移动端 | [移动端 Web 规范](MOBILE_WEB_GUIDELINES.md) |
| 服务端模式部署与双模式 | [服务端模式](SERVER_MODE.md)、[ADR-0029](adr/0029-server-mode-extends-root-and-web-isolation.md) |
| 服务端模式现状与实现 | [当前状态与后续范围](SERVER_MODE_NEXT_STEPS.md)、[实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md) |
| 共享用例、合同与工作存储优化（已完成，保留历史范围与验收） | [架构优化方案](ARCHITECTURE_SIMPLIFICATION_PLAN.md) |
| 服务端历史研究与验收证据 | [归档索引](archive/server-mode/README.md) |
| 路由、筛选、返回栈 | [路由设计](ROUTING_DESIGN.md) |
| 刮削插件与沙箱 API | [刮削插件规范](SCRAPER_PLUGIN_FORMAT.md) |
| 插件开发助手与 MCP | [插件开发 Agent](PLUGIN_DEV_AGENT.md) |
| NFO 导出格式与验证范围 | [NFO 兼容性](NFO_COMPATIBILITY.md) |
| 大媒体库性能与优化计划 | [性能审计](performance/large-library-performance-audit.md)、[实施计划](performance/large-library-optimization-plan.md)、[基准复跑](performance/large-library-results/README.md) |
| 数据库结构与迁移 | [schema.ts](../packages/library/src/db/schema.ts)、[migrations.ts](../packages/library/src/db/migrations.ts) |
| Issue、PRD 与分类标签 | [Issue 约定](agents/issue-tracker.md)、[标签约定](agents/triage-labels.md) |
| 版本与发布 | [发布规范](VERSIONING_AND_RELEASE.md)、[更新日志](../CHANGELOG.md) |
| 第三方集成与许可 | [第三方说明](THIRD_PARTY_NOTICES.md)、[GPL v3 或后续版本](../LICENSE)、[项目声明](../NOTICE) |

提交改动时说明解决的问题、最终行为和验证结果。用户可见的功能与入口变化应同步更新使用指南；README 保持产品概览，版本细节记录在更新日志，实现约束留在对应设计文档。

### 局域网 Web 端

浏览器入口与桌面 renderer 独立，构建、认证、只读目录约束和验证命令见 [LAN_WEB.md](LAN_WEB.md)。`npm run dev` 会先构建 Web 页面；`npm run web:dev` 可持续监听重建。
