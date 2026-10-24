# Javdex 开发指南

[返回产品介绍](../README.md) · [使用指南](USER_GUIDE.md) · [版本与发布](VERSIONING_AND_RELEASE.md)

本文面向从源码运行、修改或打包 Javdex 的开发者。安装和日常操作见使用指南。

本文对应 0.9.0，升级基线为已发布的 0.8.0。资料库使用 schema 21，云端模型管理文档使用格式 4；实际正式发布、同版本替换及验证边界见 [发布记录](reviews/README.md)。本文描述当前源码与分发合同，不把历史 CI 或本机测试自动当作新一轮原生产物及 GUI 验收。

## 环境与本地启动

使用 Node.js 22、npm，以及 Windows、macOS 或 Linux。CI 使用 Node.js 22；依赖版本以仓库锁文件为准。

```bash
git clone https://github.com/JavdexLabs/Javdex.git
cd Javdex
npm ci
npm run setup:desktop
npm run dev
```

`npm ci` 安装锁定的 workspace 依赖，并通过 `scripts/patch-sharp-electron.mjs` 为固定版本 Sharp 选择 Linux Electron 专用 WASM 后端；安装不自动触发 Electron rebuild。桌面开发/测试随后显式运行 `npm run setup:desktop`；如原生模块构建失败，按日志补齐开发环境后重试。服务端产物使用独立的生产依赖安装，不运行该桌面准备命令。

Linux Electron 图片元数据读取和缩略图使用 Sharp 官方 WASM 后端，避免 Electron 系统 GLib 与原生 libvips 的符号冲突；普通 Node（含独立服务器）和其他桌面平台继续使用原生后端。补丁绑定 Sharp 0.35.5 的 loader 摘要，升级不匹配时中止，禁止静默退回冲突后端。跳过安装脚本后需运行 `npm run prepare:sharp`；测试和打包入口会检查补丁。`node scripts/check-sharp-runtime.cjs` 验证 Node，`ELECTRON_RUN_AS_NODE=1 <Electron或已解包的Javdex可执行文件> scripts/check-sharp-runtime.cjs [resources/app.asar]` 验证实际桌面运行库及 PNG/JPEG/WebP/GIF/AVIF 像素处理。WASM 不支持原生文字渲染和瓦片输出，现有服务图片/缩略图路径不使用这些功能。

桌面打包按平台保留 Sharp 后端：Windows／macOS 不携带 `@img/sharp-wasm32`，保留原生 addon 与 libvips；Linux 继续携带 WASM。此过滤仅影响桌面分发，不改变开发依赖安装、Linux 专用 loader 补丁或独立 Node 服务端的原生图像处理。新增平台文件匹配器必须继承桌面产物白名单，避免仅含排除项时默认收进整个仓库。

开发启动使用应用的用户数据目录，测试隔离机制见 [appIdentity.ts](../packages/contracts/src/appIdentity.ts) 与相关测试。调试数据库、扫描或删除行为前，使用测试资料与独立测试目录。

## 数据格式与数据库迁移

桌面本机“最近播放”不增加数据库表：`player/recentPlayback.ts` 在 Electron `userData/recent-playback.json` 中原子保存最多 1,000 个窄影片快照，同时限制 UTF-8 文件为 8 MiB，超出任一限制均从最旧记录开始淘汰，确保写入后仍可读取。按 mode／catalogId／serverId 的摘要隔离，不保存播放 URL、授权或资源路径。独立 `recentPlayback:*` IPC 读取／分页／移除／清空；桌面 `/playlists/0` 是虚拟入口，不能传给资料库清单接口。自动记录复用内置播放的真实启动信号与外部系统接受打开信号，晚到的资料读取不能跨资料库写入、覆盖较新播放或撤销已确认的清空／单条移除。资料库备份、服务器与 Web 不包含此数据。

历史版本中，v0.6.2 使用 schema 15，v0.7.x 使用 schema 16，v0.8.0 使用 schema 19：17 引入 catalog 身份、写入凭据和操作回执；18 引入图片上传及关联实体版本保护；19 引入持久任务表。0.7.x 升级至 0.8.0 时执行 16 → 19，已有相同结构不重复升级。当前 0.9.0 使用 **schema 21**；从旧版升级会继续执行至 21，具体迁移以 [migrations.ts](../packages/library/src/db/migrations.ts) 为准。

已运行旧开发分支的数据库不属于已发布升级路径。旧不完整 schema 16 与开发 schema 17/18 会明确拒绝打开，保持数据和版本不变；使用匹配的开发构建或升级前备份处理，不要手动降低 `user_version`。合并迁移不会替用户改写已有开发数据库。正式 17 仍靠协议表结构识别，不能仅靠 `user_version = 17` 接受历史实验快照。

旧性能报告和原始证据中的 V17/V18 编号保留为当时的历史记录；当前迁移以 `packages/library/src/db/migrations.ts` 为准。回归测试使用从官方 v0.6.2 冻结的 schema SQL，验证数据保留、DDL 一致性及各阶段失败回滚。

### 0.9.0：资料库升级至 schema 21

以已发布 0.8.0（`v0.8.0` 对应源码 `8a819bd1`，schema 19）为历史基线，评分与内置清单迁移仍为 schema 20；新增多可信设备授权独立使用 schema 21，保留已有管理凭据并调整其唯一约束、设备名称与新增设备令牌。19/20 均在一个事务内升级至当前结构，失败时结构、数据与 `user_version` 一起回滚。新库使用相同最终结构。版本号去掉预发布后缀本身不会触发额外迁移。

早期实验的 21（缺少设备结构）/22 以及结构不完整的 20 明确拒绝，不自动降级或猜测修复。保留匹配构建与升级前备份，不直接降低 `user_version`；开发备份也不会自动降版导入。

版本只按实际发布的格式递增：结构未变的备份归档、协议和扫描审计保持原版本；新增本地模型配置、播放记录、缓存与运行库清单从各自 v1 开始。第三方库、模型权重版本和哈希不属于应用数据格式版本，不为统一编号而改动。

内置云端模型目录在 0.8.0 中没有独立版本标记，0.9.0 定义为 1，而不是开发日期编号；后续随已发布目录逐次递增。模型管理文档因新增该字段从已发布 schema 3 一次升级到 4，已发布 schema 2/3 均直接迁入当前格式，不写中间版本，保存失败时不缓存或改写原文件。已有连接、用途、凭据引用及历史已发布设置升级路径保留。标为 schema 3 却含开发日期目录字段的未发布文档不会被当作正式 schema 3 自动迁移，原文件保留并明确报错。已有有效格式 4 配置不因应用版本号改变再次升级。

## 检查与构建

托管服务端的业务命令统一经 `updater/businessProcess.ts` 降权：Linux root 管理器使用镜像内 util-linux `setpriv` 显式设置 UID、主 GID 和 `JAVDEX_SERVER_GROUPS`，空配置清空附加组，不继承管理器组。启动与令牌命令共用入口；`group_add` 不作为业务授权来源。`updater/businessProcess.test.ts` 在 Linux root + setpriv 环境以真实业务子进程检查附加组、目录遍历和文件读取；其他宿主明确跳过，不能把 Windows 测试通过当作权限回归通过。此配置由管理器实现，从 0.8.0 升级须更换包含它的 0.9.0 基础镜像，不能只上传业务升级包；配置与排查命令见网站权限参考。

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

Fetch HTTP 测试夹具可使用 `scripts/test-http.ts` 的 `listenFetchServer`，在 49152–65535 范围内直接持有监听套接字，并对端口占用或系统保留端口重选。不要假定 `listen(0)` 总能获得 Fetch 允许的端口：宿主动态范围可能包含 4045、6000 等禁用端口，请求会在发出前以 `bad port` 失败。HTTP／GC 回归还要求请求确实到达服务端、GC 确实执行以及超时后对端连接关闭；不能仅以调用返回为通过。

`npm run server:updater:test` 包含真实目录 fsync 与 Linux 进程组检查，应在 Linux 宿主或 Linux 容器中运行。Windows 的目录 fsync 会返回 `EPERM`，不能通过忽略持久化错误替代 Linux 验证；HTTP、协议隔离及 Renderer 用例可另在 Windows 验证。

`test:ui` 是独立的真实浏览器交互回归，不由 `npm test` 隐式启动；PR CI 提供稳定版 Chrome。默认使用本机 Chrome，可用 `JAVDEX_BROWSER_EXECUTABLE` 指定可执行文件，或用 `JAVDEX_BROWSER_CHANNEL` 选择已安装通道。完整矩阵默认使用 Chrome，支持后者；`JAVDEX_CSS_FIXTURE` 可传入逗号分隔的场景名运行定向检查。两个入口使用合成资料，不读取个人媒体库；完整矩阵记录截图和几何/行为断言，不是像素差异或完整 Electron GUI 验收。

需要运行特定 Electron 测试文件时：

```bash
node scripts/run-electron-tests.mjs packages/library/src/nfo/nfoArtifactCodec.test.ts
```

测试应验证真实模块的输出、交互或外部副作用。不要用 JSX 源码字符串、固定控件总数或逐项复制 CSS 声明代替行为验证；虚拟列表行高等跨模块数值约束可以保留。类型契约使用 `*.typecheck.ts`，由 TypeScript 检查，不交给运行时测试器计数。平台或系统能力不满足时应明确 `skip` 并注明原因，不能直接返回并计为通过。清理测试时保留已发布升级、故障回滚、权限边界及不同宿主的端到端验证；仅在断言不能验证声称的行为或有更完整的同路径覆盖时删除，不能因短小、较慢或存在平台跳过而删除。

`npm run build` 生成 `out/`，并校验人脸检测资源与 Pi 运行时。生产构建通过不等于各平台安装包已完成验证。

云端模型协议在 `packages/contracts/src/llmProviders.ts` 统一声明，Agent 流式请求仍由 Pi 处理。Pi 0.84.2 的 Gemini 适配器没有自定义 fetch 入口，构建与测试加载器通过 `scripts/pi-google-transport.mjs` 对固定版本进行小范围网络透传补丁：把 Javdex 的 fetch 注入每个 Google SDK 客户端的 `apiClient.apiCall`，保持原生消息转换、工具调用和流式解析，不修改全局 fetch 或 `node_modules`。补丁匹配失败会中止构建；升级 Pi／Google SDK 时须复核该私有入口，并运行 Pi 原生协议测试和 `check-built-pi-runtime.mjs` 的 Responses／Gemini 构建产物验证。

内置云端模型的核对依据见 [云端模型目录](CLOUD_MODEL_CATALOG.md)。修改预设时同步递增 `BUILT_IN_LLM_CATALOG_VERSION`；配置文件的 `builtinCatalogVersion` 记录已应用的目录版本，缺失时视为旧目录。首次读取旧目录时，按连接的 providerId 和模型 ID 判断内置模型是否过时：仍在目录中的记录保持内置；退出目录且无用途引用的记录删除；有用途引用的记录转为手动模型，保留身份、能力覆盖和用途绑定。引用按显式 modelRef 判断，包括 app-default（其继承用途自然保留）；用户手动模型不参与自动删除。随后按连接和模型 ID 去重添加新预设，不改已有连接；原子写入成功后才缓存结果。同版本启动不再次添加已删除的手动模型。预设可声明模型级协议（如 OpenAI Responses），发现列表沿用连接协议，生成测试与实际调用使用模型有效协议。

仅调整新连接的默认协议或地址时，不触发目录刷新，也不覆盖已保存连接。MiniMax 新连接使用 Anthropic Messages；同一连接内的新模型沿用该连接协议，不强制将已有 Chat 连接的模型切换为 Messages。MiniMax 的连接测试与短文本翻译预留思考预算；Pi 注册该供应商时允许无签名 thinking 块，工具后续轮次及恢复保持其内容类型。

桌面构建同时生成 renderer manifest 并运行 `measure:renderer`：按静态依赖闭包去重统计 JS/CSS 与 gzip 字节，检查设置页及四个低频面板仍为延迟 chunk。该报告衡量产物体积，不宣称已验证启动时间或内存收益。UI 职责和样式约定见 [组件契约](UI_COMPONENT_CONTRACTS.md)，返回栈与浏览状态见 [路由设计](ROUTING_DESIGN.md)。

## 打包与发布

```bash
npm run packaging:list       # 查看启用目标和构建平台
npm run packaging:configure  # 交互选择目标
npm run dist                 # 构建配置中全部启用的目标
npm run dist:win             # Windows 目标
npm run dist:win:local       # Windows 本地包，携带已构建的内置播放运行库
npm run dist:mac             # macOS 目标
npm run dist:linux           # Linux 目标
```

目标开关和架构位于 [packaging.targets.json](../build/packaging.targets.json)，基础构建配置位于 [electron-builder.config.mjs](../electron-builder.config.mjs)。本地通常选择对应平台命令；不带平台参数的 `npm run dist` 会尝试全部启用目标，不会自动筛选当前操作系统。请在目标要求的平台构建，指定 `dist:mac` 等命令不会提供跨平台编译环境。安装包输出到 `dist/`。

Windows 本地使用内置播放时，先完成 `playback:native:build`，再运行 `dist:win:local`。该入口显式检查 `out/native-playback/playback.node` 的 PE 架构及普通／延迟 DLL 导入闭包，只复制实际依赖，不复制旧 addon、测试程序或开发目录；缺少依赖时停止打包。包内 `local-runtime.json` 标记本地开发用途及文件摘要。正式分发继续使用 `JAVDEX_PLAYBACK_RUNTIME_DIR` 的审核清单与对应源码材料；本地入口与该配置互斥，打包不执行发布。

Linux x64 普通打包与 Release 使用 GPU／CPU 双 helper 及匹配 Electron 的 ANGLE，构建和来源校验见 [Linux 播放](LINUX_COMPATIBLE_PLAYBACK.md)。[Linux portable phase 1](LINUX_PORTABLE_PHASE1.md) 仅保留为独立历史测试入口，不代替当前发行合同。

版本号、标签、数据库升级说明、Release 工作流和发布验证统一遵循 [版本与发布规范](VERSIONING_AND_RELEASE.md)。

Linux glibc 桌面包在创建 ASAR 前按目标架构过滤 Sharp/libvips、剪贴板及终端辅助模块的其他平台二进制；保留加载代码、元数据和许可证。此过滤不涉及 GPU/CPU 播放运行库、ANGLE 或 Electron 的图形兼容组件。`node --test scripts/packaging-runtime.test.mjs` 检查平台选择，`scripts/check-linux-integrated-appimage.mjs` 检查最终 x64 AppImage 的原生模块及播放闭包。

### 本地 AI 运行库

本地模型是独立底层能力，默认存储于 Windows 标准用户配置的 `%LOCALAPPDATA%/Javdex/local-ai`，其他平台及隔离配置使用 `<userData>/local-ai`，由 `main/services/localModels` 管理目录、文件、运行依赖及文本推理。该服务层不依赖播放器或字幕模块；AI 字幕通过注入的模型运行接口调用它，字幕缓存位于同级 `cache/ai-subtitles`，抽取音频和任务日志位于 `cache/local-ai/work/ai-subtitles`。普通文本翻译直接调用共用文本引擎，不创建字幕引擎或字幕工作目录。文件管理和各功能的用途绑定保持独立。权重路径为 `models/<family>/<publisher>/<revision>/<precision>/<upstream-filename>`，各精度附来源、哈希、大小与许可；引擎使用 `runtimes/<engine>/<version>/<platform-arch[-cpu]>`，不与模型家族版本绑在一起。`downloads/<sha256>` 保留续传数据七天，`staging/install-<uuid>` 与 `staging/import-<uuid>` 保留遗留文件一天；启动与下载前清理过期项，操作期间持有排他锁。迁移仅复制并逐文件校验模型、运行库、下载和存储标识，配置提交后清理原副本，保留无关文件；缓存不迁移。

AI 服务设置分为功能、云端服务、本地模型三个页签。提供商模型的能力覆盖在模型详情内维护；本地文件按语音输入／文本输入分组。本地配置 `local-models.json` 初版 v1 保存目录、下载来源、各家族所选精度、修订及三个用途的独立绑定；v2 增加 `acceleration`（自动／仅 CPU／指定 GPU）。既有 v1 按自动模式读取，只有显式保存计算设备才升级为 v2；普通启动及其他 v1 操作不自动重写。`usage` 仍是用途的唯一事实来源，不保存重复的 `translation`／`translationModel`，不兼容其他未发布开发快照。未知或损坏文档保持原文件并阻止推理，只允许用户显式保存有效用途设置来恢复；正常重启不改写修订，不重命名或重新下载权重。

共享组件目录由 `localModels/runtimeComponents.ts` 从固定资源清单派生，按语音／文本引擎与后端维护安装状态；模型权重仍按精确发布者、版本和精度标识。管理服务统一生成准备计划，下载精度包含 CPU 回退依赖与当前已识别后端；环境准备不携带权重。Vulkan 尚无设备枚举工具时标明检测未完成，显式准备时列出文本 Vulkan 探测组件。安装器的分阶段事件分别报告本次网络字节、校验、应用内置资源复制及复用，旧字幕宿主安装回调保持兼容。设备配置保存会重新读取组件与权重状态，再为当前选用精度自动排队短推理；此快照不写入新的配置格式。

Windows x64 的 CUDA／Vulkan 资产见 `localModels/gpuManifest.ts`，CPU 目录保持原身份，GPU 工具分别保存于 `win32-x64-cuda`／`win32-x64-vulkan`；CUDA 翻译依赖另放 `win32-x64-cuda-dependencies`。通过模型页“准备或修复加速”安装，权重不重复下载。NVIDIA 使用 UUID 隔离 CUDA 设备，Vulkan 使用原生设备列表与 `uma: 0` 证据排除核显；所有探测有超时。每次任务冻结策略、设备和工具路径；主进程设备设置遵守租约和 revision。内置工具移除继承的 `LLAMA_*`、`GGML_*`、CUDA 可见设备和外部 loader／代理覆盖，只注入本次受控设备与依赖路径。翻译按原生层卸载日志、识别按原生 GPU backend 初始化日志报告实际后端；诊断有界保存在内存，不进入普通日志或 Renderer。已知 GPU 初始化／分配错误最多回退一次独立 CPU 工具；取消、配置和模型错误不触发重试。CUDA/Vulkan 对同名显卡共享保守显存预算，文本模型允许自动分层并预留至少 2 GiB，识别预算不足时使用 CPU。

Windows Whisper Vulkan 改为从 [Javdex Runtime 固定发行](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-r1) 按需下载，主安装包不再编译或携带可选语音 Vulkan 工具。`gpuManifest.ts` 锁定实际 ZIP 大小、SHA-256、展开上限、原生 CI 源码与 run；客户端不跟随 `latest` 或远程清单自动更换运行库。首次准备 GPU 环境时显示下载计划，经现有续传与外层摘要检查后，在隔离暂存目录核对平铺包的目标、接口、来源、逐文件摘要及精确文件集合，再原子晋升；失败保留旧安装。

运行库仓库保留同一 b5130 上游提交、固定开发材料、静态 CRT 与原编译选项，以及完整 Zstandard 解码后再提取的修复；普通用户不安装编译器、SDK 或驱动。已安装且完整的旧 b5130 Windows Vulkan 工具继续复用，不改写其来源标识；缺失或损坏时下载固定新包。模型权重、计算策略、CUDA、macOS Metal 和 Linux CPU 路径保持不变。开发者构建配方与许可材料在独立运行库仓库，本仓库不再构建或随包交付 AI 工具，包含 macOS 在内的工具均按需下载。

每个运行租约冻结精度与路径，字幕使用自己的两阶段绑定，文本引擎使用文本用途绑定。文件 snapshot 区分权重存在、完整运行依赖、平台支持、配置引用和运行租约；引用文件删除在主进程阻止。用途保存通过 revision 检查避免覆盖并发更改。文件页下载／导入只维护资源，不暗改用途；用途草稿跨三个模型页签保持挂载，离开该组仍有保存保护。

本地识别／翻译与模型商店共用 [运行库安装器](../apps/desktop/src/main/services/localModels/runtimeInstaller.ts)：原包镜像保留既有摘要和安装身份；各平台工具在 `runtimes/` 中按引擎、版本、目标和后端隔离。新 FFmpeg 使用独立的 `8.1.3-r1` 目录，权重目录和默认精度保持。macOS 最低 13.3；Linux 当前使用固定 Ubuntu 发布资产，需 glibc 2.38+、GCC 14 C++ 运行库（例如已更新的 Ubuntu 24.04）。旧 glibc／musl 仍可管理权重，但不能推理；仅检查 CPU 架构不能代表 ABI 兼容。

macOS AI 工具也从 [Javdex Runtime](https://github.com/JavdexLabs/javdex-runtime) 固定发行按需下载。主应用的开发、构建、启动和打包不再编译、复制或签名 Whisper／FFmpeg，安装包不携带 `Resources/ai-runtime`。用户准备语音能力时，先展示包含语音引擎、音频提取工具和 VAD 的网络计划，再走统一续传、SHA-256、隔离解压和原子安装流程。完整旧 b5130 macOS Whisper 安装在逐文件摘要验证后可继续复用；损坏时下载修复，不从旧应用目录重新复制。

Whisper b5130 的 macOS arm64／x64 工具保留静态运行库、Metal／Accelerate 和内嵌 Metal shader；FFmpeg 8.1.3 的五目标最小音频工具禁用 GPL、nonfree 与外部库自动发现。固定配方、完整对应源码、ad-hoc CLI 签名及原生 Kotoba/VAD CPU 检查在运行库仓库维护；托管 CI 的 CPU 检查不代表 Metal／独显推理或 Developer ID 公证已验收。

所有平台的 AI 工具按需下载固定 Javdex Runtime 发布资产；安装校验压缩包 SHA，保留 POSIX `bin/lib` 布局，把安全的库别名转为普通文件。解压在独立暂存目录，完成后替换工具目录，失败保留旧安装。模型目录迁移不需要放宽原有禁止符号链接的规则。开发构建源码、合成音频、下载权重与验收产物均从安装包排除。

无 GUI 的实际推理检查：生成／提供一段公开或合成日语音频后，运行 `node --import tsx scripts/local-ai-platform-acceptance.ts --audio <音频>`。默认仅使用忽略目录 `out/ai-runtime-acceptance/`，不访问应用用户目录；首次联网下载权重，后续可用 `--offline`。Linux 验证镜像由 `scripts/local-ai-linux-acceptance.Dockerfile` 构建，只挂载此专用目录，在 `--network none` 下运行编译后的检查脚本；不是服务端或 GUI 验收。详细命令与边界见 [AI 字幕历史验证](archive/local-ai/implementation-and-validation-2026-10.md#macoslinux-运行库适配2026-10-07)。

<!-- 保留历史设计记录指向本节的链接。 -->
<a id="内置播放运行库开发分支"></a>

### 内置播放运行库

Windows、macOS 与 Linux 的正常内置播放均通过主窗口 Canvas 与 HTML 控件合成。Windows 使用 D3D11 共享纹理生产端，故障时自动使用 CPU 内存帧；旧 HWND 视频子窗口、原生工具栏和滑块实现已移除。

Windows Canvas 无需启动开关，使用正常 DirectComposition；不再按 addon 是否存在选择旧合成路径。同一个 `playback.node` 仅导出 `sharedTexture` 和 `software`，经 WGL 私有 D3D11 bridge、GPU copy、三个 BGRA NT 导出槽和 Electron 共享纹理进入现有 Canvas2D。不宣称零复制。生产完成、消费者 GPU 释放及 `allReferencesReleased` 分别确认；设备或同步状态不明时保持旧 GPU 租约有界隔离，不强行释放。历史试验材料见 [Windows Canvas 接入记录](reviews/windows-canvas-implementation-2026-10-23.md)。

Windows GPU 路径有独立的 CPU 故障回退，另可使用启动参数 `--javdex-cpu`。同一 addon 的 `software` 导出执行纯 CPU 解码／SW 渲染，通过最多两帧复制通道交给现有 preload Canvas，无需图形驱动互操作；与 Linux 一样按实际物理 viewport 渲染，保留 8192 单边／256 MiB 单帧边界，不额外限制 1080p。图形故障后恢复当前授权来源和播放状态，本次进程继续使用 CPU；页面销毁、媒体／授权／音频错误与 CPU 故障不触发循环重试。`node scripts/windows-software-acceptance.mjs --mode=disabled <合成媒体...>` 使用禁用 GPU 加速的真实应用验收；`initialization` 只注入 GL 创建失败，`gpu-fault` 实际终止自有测试宿主的 GPU 子进程。`producer-fault` 在真实 Canvas 播放后注入一次原生 `nextFrame` 异常，经正常共享帧桥验证 CPU 接管、字幕及控制状态恢复；每次只传一个素材并使用新宿主，因为回退会保持到进程重启。均使用隔离资料库，不改系统显卡设置。使用 `JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE` 检查实际包内程序时，原生诊断也从该包加载；`windowsSoftwareNative.test.ts` 可通过 `JAVDEX_TEST_WINDOWS_PLAYBACK_NATIVE` 指定新构建的 addon，显式路径缺失即失败。结果与未测范围见 [Windows CPU 记录](reviews/windows-cpu-fallback-2026-10-24.md)。

Windows Canvas 显式创建 OpenGL 3.2 core context；旧兼容 context 在 Arc B390 上可播放视频，却会在 mpv 绘制 ASS／PGS 时产生 GL 1282。共享帧桥在主进程错误对象中保留 `playbackFailureKind`，图形故障回退不依赖本地化错误文案，页面退出仍单独排除。`windows-canvas-acceptance.mjs` 还检查 ASS／PGS 在展开和全屏状态的字幕开关像素差异、GPU 模式及停止后引用归零。本机修复与实际打包复验见 [Arc B390 Canvas 字幕修复](reviews/windows-arc-b390-canvas-fix-2026-10-24.md)。

内置播放行为与平台边界见 [播放合同](BUILTIN_PLAYBACK.md)，实际源码构建及发布证据见下文。`npm run playback:native:build` 只生成链接本机开发库的运行文件：macOS/Windows 为 addon，Linux 为独立 `playback-helper`；正式打包输入由 `npm run playback:runtime:build` 从固定源码构建。普通桌面打包明确排除 `out/native-playback`、`out/playback-acceptance`、`out/libmpv-prototype` 与 `out/playback-runtime`，审核后的运行库通过打包钩子复制到 Resources，不把构建目录、合成素材、截图或临时 Electron bundle 收入 `app.asar`。

原生核心的初始化、异步命令、事件复制、状态缓存与帧计数共用 `native/mpvCore.h`；Windows WGL 只拥有共享生产所需的私有 drawable 和 GL context，macOS CGL 只生产离屏 IOSurface，Linux 使用独立 helper。macOS 构建先编译运行 C++ 核心回归，再将 `macSharedTexture.mm` 编译为唯一的 `playback.node`；Linux CMake 构建运行共用核心与 DMA-BUF 协议／槽位回归。`npm run test:playback:build` 检查构建命令选择，已纳入根测试；它本身不编译其它平台源码，也不证明可播放。

Windows CMake 编译 D3D11 共享生产端和 CPU 生产端，仍保留 Electron delay-load hook，新增的 `d3d11.dll`、`dxgi.dll` 使用系统 ABI，不下载或随包复制图形驱动。原生构建计划运行核心及三 ticket 生命周期回归；源码聚合要求新增生产源码和 ticket 合同，加载烟测检查两套导出。Mac 上的 ticket C++ 测试仅验证无平台依赖的状态机，不替代 Windows 源码编译。后续在解锁的 Windows 桌面完成正常原生构建和桌面构建后，可运行 `node scripts/windows-canvas-acceptance.mjs`；该入口显式选择候选后端、隔离资料库并检查真实生产／Canvas 提交、暂停 seek、全屏、慢消费和停止重开，非 Windows 直接拒绝。它不代替后续色彩、驱动故障或安装包检查。

macOS 正常运行 `npm run playback:native:build`，生成 `out/native-playback/playback.node`；完成 `npm run build` 后通过普通应用入口启动，无须试验参数。正式源码构建也复用同一原生编译计划，打包仍使用原有审核矩阵、许可材料和签名门禁；不会用本机开发 addon 替代正式运行库输入。旧 NSOpenGLView 后端及其专属构建目标已移除，不再有进程内旧后端切换或自动回退。

`node scripts/run-electron-tests.mjs apps/desktop/src/main/player/macSharedTextureNative.test.ts` 自动使用本机正常构建的 addon，在真实 CGL/IOSurface 上检查线程保护、事件合并、三槽、resize、destroy 与跨会话租约；非 macOS 或缺少编译产物时明确跳过，不当作原生通过。CI 用 `JAVDEX_TEST_MAC_PLAYBACK_NATIVE=<审核矩阵中的 playback.node 绝对路径>` 检查刚构建的同架构运行库；显式输入缺失即失败。

`node scripts/mac-shared-texture-acceptance.mjs <同目录下的合成媒体...> --fps=24,30,60` 通过不带后端参数的正常应用入口，捕获真实 Chromium 窗口并核对视频／Canvas 速率、VideoToolbox、暂停、连续 seek、轨道、全屏、焦点、缩放与停止释放。fps 数量需与文件对应；多音轨夹具的真实速率以文件为准。`--color` 检查四种参考色块；`--stress` 对首个文件运行五轮 1.5 秒阻塞消费、立即停止与重开；`--crash` 只崩溃自有验收 renderer，检查未知引用隔离到退出。正常退出须无强制结束、exit=0、无信号；实际故障隔离不代表自动恢复。物理上屏、声音听感、多显示器、长时间能耗及正式包另行判断。

共享帧的主线程调度使用有界 [Node-API 线程安全回调](https://nodejs.org/api/n-api.html#asynchronous-thread-safe-function-calls)，同一 dispatcher 只保留一个待处理唤醒；暂停时的非视频命令、字幕事件与关闭重开也有原生回归。dispatcher 不拥有 IOSurface 租约，停止先解绑 JS 回调，退出时先结束 mpv 线程再终止队列；不能用它替代 GPU 完成或 `allReferencesReleased`。

旧新后端对照、阶段剥离和 WebGL/video/WebGPU 候选已停止维护并移出活动入口；脚本、失败记录、profile 与逐文件哈希保留在 [正式化记录](reviews/macos-canvas-default-2026-10-23.md)指向的可恢复归档，不销毁研究证据。既有播放态 CPU 对照没有显示采用 Canvas 的性能收益，历史数字按一核满载为 100% 计量，不是整机归一化百分比。需要按需排查时仍可拉取 `javdex.playback.mac-shared-texture.statistics` 现有主进程统计；它不暴露原生句柄或媒体位置，也不是物理上屏回执。

历史 Windows WGL 子窗口适配曾在 Windows 11 x64 用 MSVC 实际编译，并在 Electron 中加载、播放本地与 loopback 远程合成素材；范围及剩余关口见 [Windows 验收记录](BUILTIN_PLAYBACK_WINDOWS_ACCEPTANCE.md)。开发构建需要 Windows 本机的 MSVC、Visual Studio CMake generator、同架构 libmpv headers/import library/DLL，以及对应 Electron 的 headers 和 `node.lib`。设置 `JAVDEX_MPV_PREFIX` 为已安装开发前缀；默认 Electron 输入为 `~/.electron-gyp/<version>/include/node` 与 `<arch>/node.lib`，可分别用 `JAVDEX_ELECTRON_HEADERS` / `JAVDEX_ELECTRON_NODE_LIBRARY` 覆盖。Windows 开发构建完成后按实际 PE 导入闭包，从该前缀的 `bin` 复制所需 DLL 到 `out/native-playback`，普通 `npm run dev` / `npm start` 无需额外配置 libmpv PATH；缺失依赖或架构不匹配会拒绝构建，前缀中的 Mesa `opengl32.dll` 不复制，以保留系统 WGL。旧的 addon-only 开发产物需重新构建并正常退出、重启应用。构建器不下载依赖、不修改用户系统环境；这些开发文件仍排除在正式安装包之外。WGL 不等于 ANGLE 直接硬解，本轮 H.264/HEVC Main10 的实际内核状态为 `d3d11va-copy`。

Windows 的播放、全屏、滑块与键盘输入均由现有 HTML 面板处理，不再创建显示用的原生子窗口、原生全屏工具栏或裁剪弹层。共享生产端的隐藏 WGL drawable 只服务 GPU 互操作，不承载输入或呈现。主线程通过有界唤醒消费 mpv 帧通知，常规观察继续处理故障；正常启动保留 Chromium DirectComposition，不再注入 `disable-direct-composition`。

默认 Windows MSVC 构建直接编入已安装 `@electron/rebuild` 所依赖的 node-gyp 延迟加载钩子，并链接 `delayimp`、`/DELAYLOAD:node.exe`；仅链接 `node.lib` 不足以在 Electron 或改名后的应用可执行文件中加载。构建器解析依赖自身的钩子路径，不下载或修改上游文件，缺少钩子时停止。CMake 也支持 LLVM MinGW/CLANG64：使用 Ninja、显式指定匹配的 `clang++.exe` 与 libmpv 前缀、Electron headers/node.lib，编入仓库的 `windowsElectronDelayHook.cpp` 并使用 `--delayload=node.exe`。npm 开发构建命令仍默认 MSVC。两条路径均重定向到当前应用宿主；MinGW 路径已在实际改名的 ZIP/NSIS 应用中加载。MSVC 钩子许可见 [第三方说明](THIRD_PARTY_NOTICES.md#node-gyp-延迟加载钩子)，宿主要求见 [Electron 原生模块说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules#a-note-about-win_delay_load_hook)。

Linux X11／XWayland 和原生 Wayland 共用 DMA-BUF／CPU 内存帧链路，原生子窗口代码及构建目标已移除。`--javdex-x11` 和 `--javdex-wayland` 只选择显示后端，冲突参数仍拒绝启动。原生开发构建需要 CMake、C++17、pkg-config、EGL/GBM/DRM 开发库及 libmpv，设置 JAVDEX_MPV_PREFIX 后运行 npm run playback:native:build，构建 GPU helper、CPU helper 和 FD addon。完整隔离双运行库构建见 LINUX_COMPATIBLE_PLAYBACK.md；旧包的验证合同仅用于历史回归。

Linux 的 playback-dmabuf-helper／playback-software-helper 在独立进程链接各自 libmpv，使用私有控制管道和 FD 3 帧通道，不接收 Electron 原生窗口句柄、不创建 X11 child 或 GLX context。主进程只持有 FD 桥，renderer 使用同一个 Canvas 显示。当前 Linux 源构建默认使用 dmabuf profile，不再构建 x11 profile。

Linux GPU 模式要求可用的硬件 EGL 设备；可检测故障按自动模式策略切换至 CPU 兼容模式。CPU 视频链路使用软件 render API，不依赖 GLX 或 X11 原生窗口。

显示选择只读取启动参数，不将 Electron 在 ready 前返回的默认 `ozone-platform=x11` 当成用户选择。解析遵循最后一个 ozone 参数生效、`--` 终止选项的规则；ozone 值使用 `=`，例如 `--ozone-platform=x11`。`--javdex-x11` 与最终显式非 X11 选择冲突时拒绝启动，不静默覆盖。

可选的 Linux 无 GUI 编译检查使用 `scripts/playback-linux-compile.Dockerfile`；需要本机已有可用 Docker，不能替代 GUI、GPU、音频或干净安装验收。用 `mktemp -d` 创建空的专用构建目录，再运行 `node scripts/stage-playback-linux-context.mjs <匹配 Electron 版本的 include/node 绝对路径> <该空目录>`。入口只复制原生源码、指定 headers、Dockerfile，以及五个脚本：`playback-runtime.mjs`、`playback-linux-elf.test.mjs`、`playback-source-materials.mjs`、`packaging-runtime.mjs`、`playback-linux-helper-smoke.mjs`。非空目标拒绝覆盖，不把整个仓库、用户资料或凭据作为 context。

构建该专用 context 后，用 `docker run --rm --init --network none <本轮开发镜像>` 执行默认 helper 烟测。必须保留 `--init`，避免 Node 成为 PID 1 后触发 helper 的孤儿进程保护；不为测试放宽生产保护。无显示烟测只检查加载、私有协议、EOF／销毁及预期失败，不创建 GL、播放媒体或验证辅助技术。

对该目录运行 `docker build -t <本轮专用标签> <该目录>`。镜像内安装 Debian 开发依赖，运行 C++ 回归及独立的真实 ELF 搬移测试；该 Docker 检查要求 Linux ELF 测试实际运行，跳过不能代替成功。完整安装包／源码绑定测试仍在仓库根的 `test:packaging` 中执行，不塞入最小编译 context。随后 `docker run --rm --init --network none <本轮专用标签>` 仅验证 helper 加载、私有协议、EOF／destroy、无效 backend／句柄及无显示时的受控失败。此 helper 协议检查也由 Linux 开发构建调用，不创建 GL context，不播放素材。镜像中的系统 libmpv 没有来源闭包清单，检查必须拒绝将该 helper 单独作为正式运行库。

Windows/macOS 经审核的运行库通过 `JAVDEX_PLAYBACK_RUNTIME_DIR` 显式指定矩阵目录，每个目标在 `<platform>-<arch>/` 下独立提供 `playback.node`、依赖库及 `runtime.json`，例如 `darwin-arm64/` 和 `win32-x64/`。这些目标在本机未指定时可不加入运行库；已指定但目录、架构、版本或文件不匹配时停止打包，不静默生成缺少运行库的内置播放包。历史 `linux-x64/playback-helper` 清单仅用于旧包检查；当前 Linux x64 普通打包始终要求双运行库和 ANGLE，不读取该旧矩阵作为替代。技术检查覆盖 macOS Mach-O、Windows PE 与 Linux ELF；Windows 本地 ZIP/NSIS 的合成媒体播放回归见 [Windows 验收记录](BUILTIN_PLAYBACK_WINDOWS_ACCEPTANCE.md)，四目标源码构建与最终安装产物的验证合同见下文。独立干净机器、可信分发签名、公证与 GUI／硬解等验收须按具体记录判断，不能由清单或命令选择测试推定。

上述“未指定时不加入”仅适用于 Windows/macOS 普通本机开发打包。CI／GitHub Actions 必须提供完整运行库输入，否则 `beforePack` 立即报错；本地开发专用目录不能替代 CI 的来源清单。打包后运行 `npm run packaging:verify-playback-runtime`，Windows/macOS 检查 Resources 的 `native-playback`，Linux 检查 `linux-playback-release.json` 绑定的两个 helper 闭包与 ANGLE，均核对平台／架构、准确文件集合、动态依赖、许可材料及配套源码归档。macOS 验证外层 app 与每个原生文件的真实签名，保留输入 `pre-sign` 摘要，不把签名改变的字节误判为输入损坏，也不在资源封装后改写清单；非二进制仍核对原摘要。其它平台继续核对全部文件摘要。各平台配套源码归档留存为 CI 产物；Release 交付下述总源码包，并将总包加入 SHA256SUMS。

历史上曾有未传入运行库矩阵的公开安装包，后续源码构建与打包门禁的完成不追溯改变这些旧附件。已公开版本的标签、镜像与安装包不覆盖；改变分发内容须使用新版本。

### 固定源码构建与分发验证

`npm run playback:runtime:build` 从 [固定源码清单](../build/playback-sources.json) 构建正式打包输入。Windows/macOS 输出到 `out/playback-runtime/<platform>-<arch>`；Linux x64 默认构建 dmabuf GPU profile 到 `out/linux-portable-runtime/linux-x64`，另以 `--linux-software` 构建 `out/linux-software-runtime/linux-x64`，并由 `scripts/build-linux-angle.py` 生成 `out/linux-angle-runtime/linux-x64`。下载前后的大小与 SHA-256 必须匹配；清单包含 libmpv、FFmpeg、字幕/字体、AV1、TLS 依赖及 libplacebo 的固定子模块，也锁定 Electron headers 的 Node 版本和许可来源。Meson 禁止自动下载或探测未声明的可选依赖，不复制 Homebrew／系统 FFmpeg。源码和配方变化后使用新空前缀；pkgconf 保留私有 `-I/-L`，避免从系统静态库解析 FFmpeg。工具安装在任务自己的 Python venv，不改本机系统 Python。

当前清单固定 mpv 0.41.0、FFmpeg 9.0.2、Electron 43.8.0 和 Node SDK headers 24.22.0；其余来源、版本、字节数、摘要与工具版本以清单及 [构建配方](../scripts/playback-source-build.mjs) 为准。这套播放 FFmpeg 与本地 AI 使用的 FFmpeg 8.1.3 是独立构建，不能混用版本或许可说明。

当前配置将解码和字幕依赖静态链接进一个共享 libmpv，另构建 Javdex 原生 addon／Linux helper；所有内置 FFmpeg 解码器保留，支持本地及内置网络协议，HTTPS 分别使用 macOS SecureTransport、Windows Schannel、Linux 自建 OpenSSL。视频编码／采集不进入播放配置，保留 PNG/MJPEG 图像编码。libass 保留系统字体提供者、HarfBuzz、FriBidi 和 libunibreak。Lua 5.2.4 是 mpv 0.41 支持的版本，保留它是为了使现有核心能够显式关闭脚本、ytdl、OSC，而不是忽略缺失的必需初始化选项。构建仅保留软件用到的基础播放能力，不加入额外的蓝光/DVD 导航、SFTP/SRT 等可选依赖；不能宣称与任意开发库的可选功能全集一致。

关闭 mpv 可选自动探测时，Windows 仍显式启用官方 `win32-threads` 核心后端，与其原生计时实现配套；它不是额外播放功能。macOS/Linux 保持各自原有线程后端，不通过重新打开全部自动探测解决核心依赖。

Release 分别在 Windows x64、macOS Intel、macOS arm64、Linux x64 的本架构 runner 上构建。Windows 打包使用 `windows-2022` 与 Visual Studio 17 2022；MSYS2 shell、make、UCRT64 GCC 必须来自同一次安装，CI 将 action 的 `msys2-location` 输出传给指纹和构建步骤。本机运行此正式源码构建入口时，需把 `JAVDEX_PLAYBACK_MSYS2_ROOT` 设为已安装 MSYS2 的绝对根路径，不猜测 `C:/msys64` 或混用另一套 MinGW。

Windows 的自建 pkgconf 仅为构建工具，静态配置显式声明 `PKGCONFIG_IS_STATIC`，同时覆盖它的库和 CLI，避免 DLL 导入声明与静态归档不一致；该定义不传播到播放依赖。Linux 原生核心/控制/helper 测试发生在搬移之前，只对这些测试子进程传入私有前缀的 `LD_LIBRARY_PATH`；不修改全局构建环境。正式 helper 保持 `$ORIGIN`，搬移后的运行库与包内加载/解码检查仍清除开发搜索路径。

Windows 源码构建还通过私有 `LIBRARY_PATH` 固定 GCC 的静态库搜索目录，避免 Meson 内置探测选中 MSYS2 自带的 iconv/zlib。zlib 1.3.2 在 Windows 生成 `libzs.a`，安装后以同一字节副本提供其 pkg-config 所声明的 `libz.a`，拒绝覆盖不同内容，并将摘要写入构建记录。构建结束核对编译器实际解析的两个归档均来自本次前缀。新版 MinGW 把 `__mingw_fe_dfl_env` 移入 `libmingw32.a` 后，只有检测到真实定义时才显式保留该 CRT 符号；不提供替代浮点环境实现。工具链指纹包含 GCC、CRT 与头文件包版本。

Windows 的 MSVC 导入库从此次自建 DLL 的导出名称表生成，不从其它 SDK 获取。解析同时支持 GNU objdump 旧格式及带 base/hint 列的新格式，只接收名称表中的安全 `mpv_*` 符号；导出数量、真实链接/加载和解码门禁不因工具输出格式变化而放宽。

Windows 依赖库由 GCC 构建，适配器另用 MSVC；进入适配器阶段前清除前者的编译／链接及库搜索变量，由 CMake 显式提供头文件、导入库和静态 CRT 设置，避免 GCC 专用参数传入 MSVC 后被静默忽略。

Linux 构建基线为 Ubuntu 22.04：libass 等自建依赖保持 PIC 静态库，系统 fontconfig 字体提供者采用动态 ABI，避免 Meson 递归选择非 PIC 的系统 UUID 静态库；没有改用系统 libass/FFmpeg 或放宽运行库闭包。macOS C/Swift 最低部署目标均显式为 12.0；这些基线不是对应旧系统的实际安装验收。根打包入口增加 `--arch x64|arm64`，各 macOS 任务只生产自己的 DMG。缓存键包含源码清单、构建/原生代码及依赖锁；构建器还核对编译器、SDK、Python、工具版本与架构，每次命中后重验精确文件、依赖和实际加载，不把缓存命中当作可信证明。

源输入保留各上游独立的版本、许可、原始归档和构建来源，静态嵌入依赖列于 `build.json`，不是把它们重新授权为 GPL。两个二进制所有者分别为 libmpv 和 Javdex 原生适配器；完整原始归档、Javdex 首选原生源码、Electron headers、Node/node-gyp 声明及构建配方随独立的 `Javdex-Playback-Sources-*` 交付，许可原文同时进入应用。系统编译器/SDK、音频、字体及 GPU driver ABI 仍是宿主前提，不由源码包替代。

`packaging:verify-playback-runtime` 除静态合同与签名检查，还在清除开发库搜索路径后实际加载包内 addon（Electron ABI）／helper，再从包内相对位置加载 libmpv，初始化核心所需的安全选项并解码原创 PCM WAV 到正常 EOF。不会以 `require` 成功代替解码，也不把无显示检查称作 GUI/GL、硬解、多格式、网络或独立干净机器验收。Linux `.deb` 声明保留 Electron 默认依赖，加上 X11/Xft、GL、ALSA、VA-API 的宿主包；AppImage 不安装系统包，宿主须具备这些显示/音频/驱动 ABI，不需要系统安装 mpv/FFmpeg。早期 verify-only CI 的实际验证及当时边界见 [源码构建复核](reviews/playback-ci-source-build.md)。

Windows/macOS 及历史 Linux 单运行库的 `runtime.json` v1 输入合同如下；清单由实际运行库构建生成，不手工填入虚假的摘要。当前 Linux 双运行库使用各自的 `portable-runtime.json` 与 ANGLE 的 `javdex-angle.json`，发行时由独立初版 `linux-playback-release.json` 统一绑定，不伪装成旧 `playback-helper` 合同：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | `1` |
| `hashStage` | `pre-sign`；这是签名前构建输入清单，不是签名后运行库的逐字节摘要 |
| `platform` / `arch` / `electronVersion` | 匹配正在打包的 Electron 平台、架构及实际版本；当前架构为 `arm64` / `x64` |
| `mpvVersion` | 与 `components` 中名为 `mpv` 的版本一致 |
| `files` | 相对路径到 SHA-256 的对象；精确覆盖全部文件，唯独不包含清单自身。禁止越界路径、符号链接和额外文件 |
| `components` | 1–128 个组件；每项包含 `name`、`version`、`license`、`binaries`，以及指向清单内非空文件的 `licenseFile`、`sourceArchive`、`buildRecipe`；所有二进制有且仅有一个来源所有者，包括 Javdex addon 或 Linux helper。当前固定源码构建记录 `mpv` 与 `javdex-native` 两个二进制所有者，静态依赖各自的来源、许可及构建选项保留在原始源码、许可汇编与 `build.json` 中；历史 Windows 多 DLL 配置的 106／76 项不代表当前构建 |

`beforePack` 核查完整 v1 输入；`afterPack` 再核查后，只将全部二进制、各组件的许可文件与 `SOURCE-ACCESS.txt` 复制到应用 Resources 的 `native-playback/`，随后由现有流程签名。分发目录的 `runtime.json` 也是独立的初版 v1 投影：`files` 精确覆盖安装内容，保留组件来源引用，`sourceBundle` 绑定独立源码包的文件名、SHA-256、原输入清单摘要及当前打包工具摘要。构建输入禁止出现 `sourceBundle`，分发投影必须包含它；`validatePackagedPlaybackRuntime` 验证该投影，拒绝源码/构建资料混入。两种用途不是 v1 → v2 的升级关系，不能互相替代，投影不能绕过完整输入材料校验。

完整非二进制材料、原 v1 清单和当前打包工具另生成 `Javdex-Playback-Sources-<version>-<platform>-<arch>-<input hash>-<tools hash>.tar.gz`，位于 `dist/`，不装入应用。使用已有系统 `tar`，不存在或归档失败会停止打包；复用源码包前重新验证摘要。同名 `.runtime.json` 为 CI 汇总使用的分发投影副本，包含原源码包绑定与二进制摘要，不进入 Release。输入目录保持完整，不通过删除源码或伪造许可绕过门禁。

Release 的 `playback-sources` 任务在四个平台打包门禁之后执行 `node scripts/aggregate-playback-sources.mjs <artifact-directory>`，verify-only 也运行此任务；总包成功后才允许发布服务端镜像。要求四种目标与六个桌面包齐全，核对原归档、输入清单、打包工具、原生源码版本、来源/许可证/配方及二进制绑定。Release 仅交付一个 `Javdex-Playback-Sources-<version>.tar.gz`，四份平台源码包仍保留为 CI 产物；既有公开版本的附件不变。`sources/` 和 `LICENSES/` 以完整 SHA-256 定址去重，`platforms/` 保留平台记录和打包脚本，`manifests/` 记录逻辑材料路径、原输入绑定及安装包摘要。同名不同内容不合并；原始上游压缩归档保持完整，外层未压缩 tar 拆成原始头部/数据/填充片段，以共享内部相同上游文件并精确恢复原 tar 字节。汇总过程逐文件往返验证，不把四个压缩包再次套一层作为去重。

原生 CI 在上传前执行 [check-playback-installers.mjs](../scripts/check-playback-installers.mjs)：检查六个实际安装产物内的运行库，与已通过包内验证的未封装应用逐文件匹配，macOS 同时核验挂载 app 签名并匹配签名后字节。生成 `.installers.json` 来源/摘要回执，仅留作 CI 产物；汇总验证最终文件摘要及嵌入清单摘要与回执一致，不仅按安装包文件名推定来源。提取器只在隔离 CI 执行安装器，不用于本机用户环境。原生源码归档还检查必需构建脚本、平台源码、版本、固定 SDK 与实际 Node headers；危险 tar 通过 parser.abort 拒绝并清理该次临时目录。

| 原生构建目标 | 最终安装产物 | 验证方式 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe`、`.zip` | 静默安装 EXE、提取 ZIP，匹配运行库及来源绑定 |
| macOS x64 | Intel `.dmg` | 只读挂载，匹配运行库及来源绑定，校验 app 签名 |
| macOS arm64 | Apple Silicon `.dmg` | 只读挂载，匹配运行库及来源绑定，校验 app 签名 |
| Linux x64 | `.deb`、`.AppImage` | 分别提取，匹配 GPU／CPU／ANGLE 统一投影，实际包内 FD 加载与双 libmpv PCM EOF；AppImage 另核对 uruntime 前缀 |

文件名映射以 [playback-source-materials.mjs](../scripts/playback-source-materials.mjs) 为准。[历史源码与产物核验](reviews/v0.9.0-beta.3-release-audit.md) 记录 Release run `38601458029` 的四目标构建、包内加载与 PCM EOF、六个最终安装产物核验，以及公开总源码包四目标恢复和摘要核对。每轮正式发布须对自身提交执行 [Release 工作流](../.github/workflows/release.yml)，不能沿用历史摘要或把无显示门禁记为新增 GUI、硬解或干净机器验证；0.9.0 原始发行及一次整套替换的实际结果见 [发布记录](reviews/README.md)。

解开总包后，使用 Node.js 22+ 执行 `node restore.mjs windows-x64 <新目录路径>`（目标还包括 `macos-x64`、`macos-arm64`、`linux-x64`）；目标目录必须尚不存在。恢复工具先验证全部引用材料，再恢复原 `reviewed-runtime/`、`packaging-tools/` 和说明文件，保留文件模式。按平台 `build.json` 的工具链、补丁和配方重建；恢复工具不执行构建脚本。原单平台压缩包摘要记录来源，不能用来校验总包；总包摘要见 Release 的 SHA256SUMS。`SOURCE-ACCESS.txt` 同时说明公开总包与原 CI 绑定；分发安装包时须继续提供对应源码访问方式，不能仅提供未交付的文件名。普通用户无需下载源码包；系统 SDK、编译器和签名不由恢复工具提供。

Windows 桌面打包保留当前架构的 clipboard/console 原生模块，排除其它平台与架构；桌面 `out/server` 不进入应用，局域网前端 `out/web` 保留。Photon 使用主进程 chunk 旁的 WASM，排除 node_modules 中的重复文件。Windows `files` 规则必须同时保留桌面允许列表：打包器把平台规则建成独立文件集，只有排除项会默认包含仓库全部文件；配置归一化回归及实际包内容检查共同覆盖这个边界。

历史 Windows x64 精简播放库另有本地构建入口 `scripts/build-windows-playback-libraries.mjs`，显式传入 `--sources`、`--prefix`、`--toolchain`、`--msys`、`--python`、`--work` 和可选 `--jobs`。需要已准备的 FFmpeg 9.0.2/mpv 0.41.0 源码、CLANG64 依赖前缀、Clang、MSYS make/bash 及 Python Meson；入口不下载或安装工具，也不是上述 Release 固定源码构建入口。它保留解码、网络、字幕、WGL/WASAPI 和硬解接口，移除视频编码/封装、VapourSynth/Python、采集与终端画面依赖，仅保留 PNG/MJPEG 图像编码器。

构建后以 `scripts/stage-windows-playback-profile.mjs --original <完整已审输入> --prefix <构建前缀> --destination <新空目录> --build <工作目录> --evidence <准备材料目录>` 生成独立 v1 输入；准备材料目录必须包含 `preparation.json` 与 `toolchain-lock.json`，工具链清单也可用 `--toolchain-lock <文件>` 显式指定。缺少清单在写入目标前拒绝，不依赖某次验收缓存的固定目录。之后从原 addon 的 PE 导入闭包选取 DLL，保留每个组件的源码、许可及配方，并加入该次构建脚本、配置和工具记录。未知来源或缺失依赖会停止，不直接修改原矩阵。历史本机验收使用 `out/playback-runtime/optimized/win32-x64`，当时打包设置 `JAVDEX_PLAYBACK_RUNTIME_DIR` 为 `out/playback-runtime/optimized`；实际安装/播放范围见 Windows 验收记录。

不会覆盖已存在的应用运行库目录。macOS 二进制必须包含目标架构；非系统动态依赖必须通过 `@loader_path` 指向该运行库清单内的二进制，禁止开发机绝对路径、依赖搜索型 `@rpath`、越界依赖和外部 rpath。动态库自身的 install name 可为规范的 `@rpath/<文件名>`，它不是一次依赖搜索。技术检查与搬移回归入口为 `npm run test:packaging`。

Windows 直接解析 PE32+ 的 Machine、DLL 标志、section/RVA、普通与延迟导入，不执行待审核 DLL，也不依赖 `dumpbin`。入口须编入对应工具链的宿主重定向钩子，并延迟加载 `node.exe`，普通导入必须含 libmpv；非系统依赖按大小写不敏感名称在同目录清单内命中，拒绝路径依赖、重复名称和缺失 DLL。VC++ runtime、Vulkan loader 和 codec DLL 不因开发机已安装就获豁免。真实 MSVC/Electron 测试将自建 addon/DLL 搬移、删除原目录，在无 DLL 的工作目录加载成功；它不是 libmpv 分发或许可证明。静态导入检查不能发现全部运行时 `LoadLibrary`、驱动依赖或最低 Windows API 版本，正式源码闭包与干净安装仍须独立验证。

Linux 使用 ELF header 和 GNU `readelf -dW` 核对 64 位小端、目标 x64/arm64、SONAME 与动态依赖，不执行待审核输入或用 `ldd`。仅入口 `playback-helper` 接受 ELF `ET_EXEC` 或 PIE `ET_DYN`，同时检查执行权限、非零入口、完整 program headers 及目标架构的标准 glibc interpreter；动态库仍只接受 `ET_DYN`。当前分发检查面向 glibc，musl 等运行时未纳入支持范围，也不从 ELF 类型推断最低发行版兼容性。

RPATH/RUNPATH 只允许位于运行库内的 `$ORIGIN` 相对目录，RUNPATH 存在时不误用被覆盖的 RPATH；helper 直接链接的 libmpv 及所有非系统 NEEDED 必须在这些目录中精确命中清单。helper 与库均计入摘要、许可／源码所有者并在复制后复核；执行权限不在内容摘要中，另行检查。禁止绝对／逃逸／空搜索项及动态 audit/filter 间接加载。系统依赖仅放行代码中明确列出的 glibc/C++ ABI、X11（含 Xrandr/Xss/Xpresent）、GLVND、Xft/fontconfig/freetype、ALSA 与 VA-API 名称（不同架构 loader 分开）；这些是宿主提供的显示/字体/音频/驱动前提，不代表可省略 mpv、FFmpeg、其它解码依赖或许可记录。该静态检查不能发现运行时 `dlopen` 的全部插件，不阻止用户自行设置 `LD_LIBRARY_PATH`／`LD_PRELOAD` 等 loader 环境，也不核对最低 GLIBC/C++ 符号版本；目标发行版、驱动及 ABI 基线仍须实际分发审核与干净安装。

代码签名可能改变二进制字节，因此保留的 `pre-sign` 摘要只证明输入与搬移阶段一致，不能拿它比较签名后的文件。最终包另做签名完整性、签名后字节与分发产物摘要检查；上述历史记录包含 macOS 签名及六包来源核验，但不由此推定可信签名身份、公证、独立干净机器或后续版本已通过。

**摘要不是签名，清单不是许可合规或播放验收证明。** Javdex 采用 GPL-3.0-or-later，应用 `LICENSE`、`NOTICE`、workspace 元数据、锁文件及当前公开许可说明已同步；此前 MIT 声明保留在 `LICENSES/Javdex-MIT.txt`，既有版本不追溯改写。构建来源、选项、源码与二进制对应关系、全部间接依赖及分发义务仍需逐版本复核，第三方代码保留各自版权和许可。实际版本、许可材料与源码交付见 [第三方说明](THIRD_PARTY_NOTICES.md#内置播放运行库)。本机原生开发可使用 Homebrew／系统开发库，Linux 隔离编译检查可使用 Debian 开发库；Release 使用固定源码构建并交付配套总源码包。两条构建路径及历史验收范围须分别判断。

部分 macOS/Windows 播放回归以隔离资料目录运行：先生成 `playback:native:build`、`desktop:build`（远程另需 `server:build`），再运行 `node scripts/playback-media-acceptance.mjs` 检查合成素材，或 `node scripts/playback-subtitle-acceptance.mjs` 定向检查复杂 ASS 与原创 PGS；可加 `--bitmap-only` 缩短图像字幕回归。`npm run test:playback:fixtures` 独立核对原创 PGS 字节/像素结构，不依赖 FFmpeg、GUI 或播放运行库，已纳入根 `npm test`。远程使用 `npm run test:playback:remote -- --media-matrix`，该入口注册 TypeScript 及共享路径加载器；追加 `--system-subtitle-picker` 时会等待真实系统选择器分别选择生成的 SRT/ASS，不适合无人值守 CI，也不 mock 文件选择器。具体文件、像素证据、失败诊断及未覆盖范围见 [字幕验收说明](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md) 与 [PGS 验收合同/结果](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md)。Windows 原生输入可运行 `node scripts/playback-windows-input-acceptance.mjs`，它准备隔离暂停素材并写入只读状态，仍需实际鼠标/键盘检查及解锁的桌面。Windows GUI 宿主还接受 `JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE` 指向实际解压/安装后的绝对 exe 路径；该子进程不带源码入口参数，使用空 cwd、Windows 系统 PATH 并移除开发 mpv prefix，诊断桥从包内 Resources 加载。仍不代表独立干净机器或发布验收。

`npm run test:playback:remote:connection` 是无媒体的开发启动检查：真实 Node 业务宿主经临时 HTTPS 网关完成统一配对，桌面 runtime 重开后复用原凭据且不打开本地资料库。它使用生产配对与代理实现，但不提供 Linux manager、环境查询或升级接口，不替代 Docker 更新检查、原生媒体或系统密钥存储 GUI 验收；PR 在 `server:build` 后执行。

`node scripts/playback-close-acceptance.mjs` 检查播放中正常关闭主窗口：窗口确实销毁，进程退出前内核已释放，随后应用正常退出。不要把清理移到可能被否决的 `close` 事件；本机实测还发现该事件中拆除活跃原生视图会让窗口留存。Windows 为 `closed` 清理保留私有隐藏 drawable/context，实际接受关闭时内核仍存活，原窗口销毁后内核释放、零窗口正常退出已通过；不用独立可见播放窗口代替主窗口嵌入。

## 服务端构建与更新

服务端源码构建、Docker 部署及更新备份见 [服务端部署指南](SERVER_MODE.md)。当前能力与接口见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)，未完成验收和历史测试边界见 [当前状态](SERVER_MODE_NEXT_STEPS.md)。服务端部署不需要 Electron，也不运行 `setup:desktop`。

`server:build` 同时生成业务入口 `out/server` 与容器内管理入口 `out/updater`，后者也可单独运行 `server:updater:build` 构建，不是需要用户额外安装的宿主机程序。镜像生成对应架构的完整发行描述，发布流程从已验证镜像取出 JS、worker、Web 和原生依赖，生成内层 `.tar.gz`，再与签名清单封装为每架构一个 `.javdex-update` 并验证读回摘要。只发布两个单文件包，不再发布分离 JSON 或裸归档，不在升级时运行 npm 安装。运输格式、在线读取与断点续传见 [服务端更新](SERVER_UPDATE.md)，实现位于 `packages/http/src/updateBundle.ts`；旧预发布格式不提供兼容分支。

更新流程测试为 `server:updater:test`，实际浏览器入口为 `test:ui:server-update`；`server:updater:smoke` 必须在 Linux Docker 环境运行，覆盖真实 0.8.0/schema 19 资料首次采用当前源码、原生闭包，以及同源码合成业务版本之间的 worker 失败、容器中断恢复、单容器计数、非 root 业务与持久版本选择，已接入 amd64/arm64 CI。不能把本机合成进程测试或构建通过当成 Linux 容器验收。运行外壳、程序卷、发布签名和两层更新说明见 [服务端更新](SERVER_UPDATE.md) 与 [ADR-0031](adr/0031-manage-server-releases-inside-one-container.md)。

## 官网开发

官网使用独立的 Astro Starlight 工作区 `website/`。公开文档正文位于 `website/src/content/docs/`，工程文档留在 `docs/`；现有产品介绍位于 `/product/`，下载集中到 `/download/`。完整维护说明见 [网站 README](../website/README.md)。

```bash
npm run pages:build          # 读取最新正式 Release，生成下载信息
npm run pages:preview        # 预览已经生成的 dist-pages，默认 4319 端口
npm run pages:dev            # 离线清单 + 文档热更新
npm run pages:build:offline  # 离线构建，用于本地检查页面
npm run pages:test           # Release 与旧地址合同
npm run pages:check          # 校验构建结果的链接、锚点、语言和索引
```

使用 Node 22.12+。仅安装网站依赖可运行 `npm ci --workspace @javdex/website --include-workspace-root=false`，不需要 `setup:desktop`。生成目录为 `dist-pages/`，预览地址带 `/Javdex/` 前缀。离线构建不代表线上最新下载信息已经验证。

自动部署条件见 [Pages 工作流](../.github/workflows/pages.yml)：包括 `main` 上指定官网相关路径的变更、正式 Release 发布及成功结束的 Release 工作流。部署使用默认分支内容。

README 介绍产品并链接使用文档，文档站承接任务指南、产品介绍和下载；两者复用图片时，应说明演示数据与截图版本，避免将旧截图标成当前界面。旧文件保留章节索引，迁移后的正文只在网站内容目录维护；更新日志与插件规范等仍链接其仓库权威来源。

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

草稿应用、丢弃和影片删除后的工作清理依靠持久意图、catalog 回执及可重试清理恢复，不依赖跨库原子性。首次旧记录迁移保留源数据，ready 后不再复制。具体连接归属和提交顺序见 [服务端合同中的工作存储说明](SERVER_MODE_CONTRACT_INVENTORY.md#桌面工作存储与恢复)。涉及这些路径时，用独立 catalog/work 数据库及关闭重开测试验证恢复；同库测试不能代替跨存储验证。

### 共享用例与控制器边界

以下四项维护性优化已实施；这些重构本身不改变数据库 schema、业务取舍、HTTP 输入或界面布局：

| 阶段 | 实现与职责 | 验收入口 |
|---|---|---|
| 1. 清单导入身份模块 | `playlistImportIdentity.ts` 统一候选查找、强信号交集和预览有效性判断；`playlistImportRepository.ts` 保留任务状态、检查点和事务。URL 规范化独立共享，避免反向依赖仓储。 | 原有 Repository、CatalogLookup、Module 行为测试，覆盖跨库候选、陈旧预览与提交重试 |
| 2. 远程返回契约 | `catalogVideoSourceSchemas.ts` 与 `videoLifecycleSchemas.ts` 定义来源分页和影片生命周期预览／结果，类型由 schema 推导；远程适配器在接收 JSON 后校验。 | `catalogRemoteResults.test.ts` 与 Node `runtime.test.ts` 的真实 HTTP 往返 |
| 3. 详情操作流程 | `useVideoLifecycleController` 拥有预览、提交、失败重读和操作 ID；`useVideoResourceController` 拥有资源读取、标签编辑和删除。页面只接线、展示与导航，旧请求不能修改新的影片操作状态。 | `videoDetailControllers.test.tsx` 的用户操作、重复提交、失败重试及换页测试 |
| 4. 共享查询入口 | `packages/library/src/catalog/videoQueryService.ts` 拥有作用域详情、资源归属检查和投影；桌面保留查询 worker，服务端显式提供路径投影和无成员资料读取策略。 | `videoQueryService.test.ts`、Node HTTP 测试、desktop/server 边界检查及 `catalog-query-boundary.test.mjs` |

此处远程 schema 收敛范围为 `videos.sources` 和生命周期预览／提交结果，不是宣称全部管理响应已经迁移。六个旧操作名的 schema 仍保留，但手动移出已停用；移动后的无来源成员归属自动清理，兼容结果 schema 不代表重新开放旧操作。共享包也未一刀切取消通配导出：已迁移的两个宿主入口禁止重新直接引用影片仓储，其余旧入口按业务改动逐步迁移。保留本地直连、服务端 HTTP、宿主路径策略和独立 workStore，不引入通用 RPC 框架或全局依赖注入容器。

回检约束：

- 身份模块通过 `planDetail` 返回可持久化决策，仓储不再修改强信号证据；详情计划与提交前有效性检查共用自动复用规则。列表的单番号快速路径、显式用户选择和事务推进仍保持各自职责。
- `CatalogResultSchemas` 逐操作约束 schema 输出类型；`actresses.edit` 的回执到布尔值转换也在校验器中完成。`catalogRemoteResults.typecheck.ts` 用预期编译错误防止预览、提交和布尔结果校验器互换。
- 资源控制器提供打开／关闭／完成动作，不暴露目标状态 setter。影片作用域之外另有编辑和移动会话编号：同影片关闭后重开也隔离旧响应；同步提交锁防双击，失败可重试。成功的旧请求仍使列表缓存失效，但不关闭新会话、不提示或导航到新页面。
- 回归入口为 `npm test` 与 `npm run server:test`；本机自动化通过不代表完整 GUI、跨平台安装或 Linux 故障注入验收。环境跳过项需单独报告。

历史回检（2026-09-28）：`npm test` 退出码为 0（包含架构检查、lint、类型检查、打包脚本测试；Electron 3297 通过、2 项 Windows 路径语义测试跳过）；`npm run server:test` 退出码为 0（47 通过、6 项真实挂载／mpv／Linux 环境测试跳过）。详情控制器新增用例先复现重复保存与关闭后延迟重开，再验证修复；该轮未执行完整 GUI 或跨平台安装验收，计数不代表当前版本重新运行的结果。

## 按任务查阅文档

先阅读根目录 [AGENTS.md](../AGENTS.md) 的仓库约定，再按实际改动选择文档，无需通读全部设计与研究资料。

| 工作区域 | 文档 |
|---|---|
| 领域术语与数据归属 | [领域上下文](../CONTEXT.md)、[多媒体库设计](MULTI_LIBRARY_DESIGN.md) |
| UI、样式和交互 | [UI 设计规范](UI_DESIGN_GUIDELINES.md)、[组件契约](UI_COMPONENT_CONTRACTS.md) |
| 局域网 Web 移动端 | [移动端 Web 规范](MOBILE_WEB_GUIDELINES.md) |
| 服务端模式部署与双模式 | [服务端模式](SERVER_MODE.md)、[ADR-0029](adr/0029-server-mode-extends-root-and-web-isolation.md) |
| 服务端模式现状与实现 | [当前状态与后续范围](SERVER_MODE_NEXT_STEPS.md)、[实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md) |
| 服务端更新与恢复 | [托管更新](SERVER_UPDATE.md)、[ADR-0031](adr/0031-manage-server-releases-inside-one-container.md) |
| 共享用例、合同与工作存储 | [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md#共享用例与结果校验) |
| 服务端历史研究与验收证据 | [归档索引](archive/server-mode/README.md) |
| 路由、筛选、返回栈 | [路由设计](ROUTING_DESIGN.md) |
| 刮削插件与沙箱 API | [刮削插件规范](SCRAPER_PLUGIN_FORMAT.md) |
| 插件开发助手与 MCP | [插件开发 Agent](PLUGIN_DEV_AGENT.md) |
| NFO 导出格式与验证范围 | [NFO 兼容性](NFO_COMPATIBILITY.md) |
| 内置播放、AI 字幕与清单导入 | [播放合同](BUILTIN_PLAYBACK.md)、[本地推理](AI_SUBTITLES_IMPLEMENTATION.md)、[清单导入](PLAYLIST_IMPORT.md) |
| 大媒体库性能与剩余范围 | [性能工作索引](performance/README.md)、[完整待办矩阵](performance/large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)、[基准复跑](performance/large-library-results/README.md) |
| 数据库结构与迁移 | [schema.ts](../packages/library/src/db/schema.ts)、[migrations.ts](../packages/library/src/db/migrations.ts) |
| Issue、PRD 与分类标签 | [Issue 约定](agents/issue-tracker.md)、[标签约定](agents/triage-labels.md) |
| 版本与发布 | [发布规范](VERSIONING_AND_RELEASE.md)、[更新日志](../CHANGELOG.md) |
| 第三方集成与许可 | [第三方说明](THIRD_PARTY_NOTICES.md)、[GPL v3 或后续版本](../LICENSE)、[项目声明](../NOTICE) |

提交改动时说明解决的问题、最终行为和验证结果。用户可见的功能与入口变化应同步更新使用指南；README 保持产品概览，版本细节记录在更新日志，实现约束留在对应设计文档。

完整分类见[工程文档索引](README.md)。过程计划和回检记录完成后，将仍有效的约定并入对应设计、合同或使用文档，再删除重复记录；历史原文可从 Git 查阅。仍有未完成验收的记录、发布来源与产物核验、性能基准及第三方许可证据继续保留，不因单轮检查通过而视为全部完成。

### 局域网 Web 端

浏览器入口与桌面 renderer 独立，构建、认证、只读目录约束和验证命令见 [LAN_WEB.md](LAN_WEB.md)。`npm run dev` 会先构建 Web 页面；`npm run web:dev` 可持续监听重建。

### Windows 播放窗口缩放回归

原生播放区域、弹层遮挡和全屏指针坐标使用 Electron 当前显示器的有效 `scaleFactor`，再结合网页 `zoomFactor` 换算。不能只用 `GetDpiForWindow / 96`：Windows 辅助功能文字缩放可能让 Chromium 的有效缩放与 HWND DPI 不同，例如 175% 显示缩放加 110% 文字缩放时为 192.5%。网页 DPR 变化时，即使 CSS 矩形未变，也需重新上报播放区域。

Windows 正常 Canvas 验收使用 `node scripts/windows-canvas-acceptance.mjs`，另以 `scripts/windows-software-acceptance.mjs` 检查 CPU 和故障恢复；关闭生命周期用 `scripts/playback-close-acceptance.mjs`。旧 HWND 的综合、几何、原生焦点和长播脚本已退出活动入口，本机可恢复材料及逐文件摘要在 `out/windows-hwnd-archive-20261024/inventory.json`；历史实测记录保留，不作为新 Canvas 的验收证据。

Linux x86_64 当前标准包的双播放运行库构建与验收见 [LINUX_COMPATIBLE_PLAYBACK.md](LINUX_COMPATIBLE_PLAYBACK.md)；CPU 专用源构建参数为 `--linux-software`，不修改系统驱动。旧第一阶段独立包仍可按原文档复现。

### Linux AppImage 自动解包回退

Linux x86_64 AppImage 的固定运行时与构建校验见 [兼容播放文档](LINUX_COMPATIBLE_PLAYBACK.md#direct-appimage-startup)。打包钩子在 electron-builder 生成更新摘要前接入 uruntime；直接双击同一个包可在 FUSE 失败时自动解包启动，不要求额外执行脚本或安装 libfuse2。`node --test scripts/linux-appimage-runtime.test.mjs scripts/linux-apprun.test.mjs` 包含本机 Linux x86_64 的运行时故障注入；需要现有 `aa-exec`、支持 seccomp-filter 的 `setpriv` 和可用的临时目录，不安装系统设置。普通用户最终包首页启动与播放验收分别记录。
