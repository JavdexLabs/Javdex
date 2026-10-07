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

### 本地 AI 运行库（开发分支）

本地识别／翻译与模型商店共用 [运行库安装器](../apps/desktop/src/main/player/aiSubtitles/runtimeInstaller.ts)：Windows x64 保留原目录与 ZIP；macOS、Linux 的 arm64／x64 工具在 `tools/<platform>-<arch>/` 隔离，权重目录和默认精度保持。macOS 最低 13.3；Linux 当前使用固定 Ubuntu 发布资产，需 glibc 2.38+、GCC 14 C++ 运行库及 xz-utils（例如已更新的 Ubuntu 24.04）。旧 glibc／musl 仍可管理权重，但不能推理；仅检查 CPU 架构不能代表 ABI 兼容。

macOS 上 `npm run ai-runtime:build` 使用固定 commit 的 whisper.cpp b5130 与 FFmpeg 8.1.3 源码，验证 SHA-256 后编译静态 CLI。首次开发构建需要 Xcode Command Line Tools、CMake、make 及网络；不自动安装系统工具。`dev`、`desktop:build`、`start`／`preview` 自动准备本机产物，后续复用已验证的构建缓存。Mac 打包另按目标架构编译，输出 `out/ai-runtime/darwin-<arch>/`，支持 arm64 和 x64 单架构包，不支持 universal AI 工具包。

工具只链接系统库，识别启用 Metal／Accelerate，FFmpeg 仅输出 PCM／WAV，不启用 GPL、nonfree 或自动探测的第三方编解码库。源文件、构建参数、许可证与哈希写入 bundle 清单；打包放入 `Resources/ai-runtime`，不进 asar。CLI 在外层 app 签名前单独签名并更新清单，外层签名跳过重复签 CLI；`afterSign` 只校验，不能修改已封装资源。此流程有真实 ad-hoc 签名回归，不等于正式 DMG、Developer ID 签名或公证已经验收。源码与构建资料发布要求见 [第三方说明](THIRD_PARTY_NOTICES.md#本地-ai-运行库)。

Windows／Linux 及 macOS 翻译工具按需下载固定发布资产；安装校验压缩包 SHA，保留 POSIX `bin/lib` 布局，把安全的库别名转为普通文件。解压在独立暂存目录，完成后替换工具目录，失败保留旧安装。模型目录迁移不需要放宽原有禁止符号链接的规则。开发构建源码、合成音频、下载权重与验收产物均从安装包排除。

无 GUI 的实际推理检查：生成／提供一段公开或合成日语音频后，运行 `node --import tsx scripts/local-ai-platform-acceptance.ts --audio <音频>`。默认仅使用忽略目录 `out/ai-runtime-acceptance/`，不访问应用用户目录；首次联网下载权重，后续可用 `--offline`。Linux 验证镜像由 `scripts/local-ai-linux-acceptance.Dockerfile` 构建，只挂载此专用目录，在 `--network none` 下运行编译后的检查脚本；不是服务端或 GUI 验收。详细命令与边界见 [AI 字幕实施记录](AI_SUBTITLES_IMPLEMENTATION.md#macoslinux-运行库适配2026-10-07)。

### 内置播放运行库（开发分支）

Windows 新版 adapter 通过 `rendererFullscreenControls` 能力统一使用 renderer 经典工具栏与播放设置，原生 child window 只负责画面、输入和帧提交；旧 adapter 保留原生全屏控件。全屏按指针所在的顶部／底部区域分别显示标题栏／控制栏，鼠标在画面中间移动或暂停不会唤出它们；打开播放设置时同时固定显示标题栏与控制栏，关闭后恢复分区触发；键盘焦点、拖动和子菜单所有权保持操作区域可见。原生指针由 Windows 客户区像素换算为 DIP，再按网页缩放倍率换算为 CSS 像素，不能用播放时钟更新或任意鼠标活动唤出控制栏。全屏视频始终占满窗口，标题栏、控制栏和设置使用覆盖布局，显隐不改变 drawable 尺寸；renderer 报告这些表面及菜单与视频的交叠矩形，Windows 用窗口区域裁剪让 HTML 控件可见，关闭覆盖层后恢复完整画面。此改动同时涉及 renderer 与 addon，开发调试需重建两者并完整退出、重启 Electron；仅刷新页面仍会保留已加载的旧 addon。

内置播放的实现与尚未通过的关口见 [实施计划](BUILTIN_PLAYBACK_DESIGN_PROPOSAL.md)。`npm run playback:native:build` 只生成链接本机开发库的运行文件：macOS/Windows 为 addon，Linux 为独立 `playback-helper`，均不是可分发运行库。普通桌面打包明确排除 `out/native-playback`、`out/playback-acceptance`、`out/libmpv-prototype` 与 `out/playback-runtime`，不把合成素材、截图、临时 Electron bundle 或开发运行文件收入 `app.asar`。

原生核心的初始化、异步命令、事件复制、状态缓存与帧计数共用 `native/mpvCore.h`；Cocoa/WGL/X11 仅拥有平台窗口、GL context 和原生输入。macOS 构建先编译运行 C++ 的键位与核心回归，再生成 Cocoa addon；Linux CMake 构建运行共用核心与私有 X11 几何／句柄／键盘回归。`npm run test:playback:build` 检查构建命令选择，已纳入根测试；它本身不编译其它平台源码，也不证明可播放。

Windows WGL 适配已在 Windows 11 x64 用 MSVC 实际编译，并在 Electron 中加载、播放本地与 loopback 远程合成素材；范围及剩余关口见 [Windows 验收记录](BUILTIN_PLAYBACK_WINDOWS_ACCEPTANCE.md)。开发构建需要 Windows 本机的 MSVC、Visual Studio CMake generator、同架构 libmpv headers/import library/DLL，以及对应 Electron 的 headers 和 `node.lib`。设置 `JAVDEX_MPV_PREFIX` 为已安装开发前缀；默认 Electron 输入为 `~/.electron-gyp/<version>/include/node` 与 `<arch>/node.lib`，可分别用 `JAVDEX_ELECTRON_HEADERS` / `JAVDEX_ELECTRON_NODE_LIBRARY` 覆盖。Windows 开发构建完成后按实际 PE 导入闭包，从该前缀的 `bin` 复制所需 DLL 到 `out/native-playback`，普通 `npm run dev` / `npm start` 无需额外配置 libmpv PATH；缺失依赖或架构不匹配会拒绝构建，前缀中的 Mesa `opengl32.dll` 不复制，以保留系统 WGL。旧的 addon-only 开发产物需重新构建并正常退出、重启应用。构建器不下载依赖、不修改用户系统环境；这些开发文件仍排除在正式安装包之外。WGL 不等于 ANGLE 直接硬解，本轮 H.264/HEVC Main10 的实际内核状态为 `d3d11va-copy`。

Windows 正常桌面入口检测到 `out/native-playback/playback.node`（开发）或 `resources/native-playback/playback.node`（分发）时，会在应用 ready 前选择 Chromium 的非 DirectComposition 合成路径，避免 WGL 主窗口 child 被遮挡。没有原生 addon 的包及刮削 helper 不改变该选择；仍保留 GPU compositing、rasterization 和视频硬解，不是关闭硬件加速或用户设置项。原生 adapter 用标准 Win32 child/sibling 裁剪，释放时还原其添加的样式位；暂停 resize 在尺寸提交后重绘，最小化恢复也重绘已有帧。libmpv 新帧通知通过 `PostMessage` 唤醒拥有 HWND/WGL 的线程，避免依靠 JavaScript 定时轮询限制 60fps 提交；回调本身不执行 GL 或 N-API。新构建需正常退出再启动，不能在 ready 后切换该后端。

默认 Windows MSVC 构建直接编入已安装 `@electron/rebuild` 所依赖的 node-gyp 延迟加载钩子，并链接 `delayimp`、`/DELAYLOAD:node.exe`；仅链接 `node.lib` 不足以在 Electron 或改名后的应用可执行文件中加载。构建器解析依赖自身的钩子路径，不下载或修改上游文件，缺少钩子时停止。CMake 也支持 LLVM MinGW/CLANG64：使用 Ninja、显式指定匹配的 `clang++.exe` 与 libmpv 前缀、Electron headers/node.lib，编入仓库的 `windowsElectronDelayHook.cpp` 并使用 `--delayload=node.exe`。npm 开发构建命令仍默认 MSVC。两条路径均重定向到当前应用宿主；MinGW 路径已在实际改名的 ZIP/NSIS 应用中加载。MSVC 钩子许可见 [第三方说明](THIRD_PARTY_NOTICES.md#node-gyp-延迟加载钩子)，宿主要求见 [Electron 原生模块说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules#a-note-about-win_delay_load_hook)。

Linux X11／XWayland adapter 与显式启动选项已加入，原生 Wayland 后续补齐。先退出应用，再以 `--javdex-x11`（或 Electron 的 `--ozone-platform=x11`）启动；未显式选择时内置播放不可用，不依据环境变量或 Buffer 宽度猜测 backend。冲突的 ozone 选项拒绝启动；缺少 `DISPLAY` / X server 时给出不可用原因，不自动回退外部播放器。当前提供命令行选择，尚未提供设置页启动开关；不切换系统桌面、不静默强制 X11。开发构建需要 CMake、C++17 编译器、make、pkg-config、X11/GLX/OpenGL/Xft 开发库及同架构 libmpv；设置 `JAVDEX_MPV_PREFIX`（系统前缀如 `/usr`），然后运行 `npm run playback:native:build`。库路径须由开发环境提供，构建器不复制 `.so` 或安装依赖。实际源码、隔离编译及未验收项见 [平台记录](BUILTIN_PLAYBACK_PLATFORM_ADAPTERS.md#10-本轮实施记录2026-10-03)。

Linux 的 `playback-helper` 在独立进程直接链接 libmpv，拥有 X11 child windows、GLX context 和播放器核心；子窗口仍嵌入原 Electron parent，不另开可见顶层播放窗口。Electron 通过私有继承管道传送带长度的命令字段并缓存返回状态，不经 shell 或监听端口。此边界用于隔离 Electron 全局导出的 FFmpeg／分配器符号；同进程的 `RTLD_DEEPBIND`、`dlmopen` 实验未通过真实播放／清理检查，未作为支持方案。独立进程不等于解码器沙箱，仍须验收异常退出、关闭／重开、输入焦点和媒体行为。

检测到 OpenGL renderer 名称含 `llvmpipe` 或 `softpipe` 时，Linux helper 使用软件 OpenGL 兼容策略：亮度、色度及缩小采用 bilinear，关闭 correct-downscaling，并启用 `gpu-dumb-mode`。这会牺牲高级 shader 缩放以换取该软件渲染路径的兼容性，不是硬解或真实 GPU 通过的声明。其它 renderer 不自动应用此策略；真实 GPU／驱动及高阶画质路径仍待分别验收。

显示选择只读取启动参数，不将 Electron 在 ready 前返回的默认 `ozone-platform=x11` 当成用户选择。解析遵循最后一个 ozone 参数生效、`--` 终止选项的规则；ozone 值使用 `=`，例如 `--ozone-platform=x11`。`--javdex-x11` 与最终显式非 X11 选择冲突时拒绝启动，不静默覆盖。

可选的 Linux 无 GUI 编译检查使用 `scripts/playback-linux-compile.Dockerfile`；需要本机已有可用 Docker，不能替代 GUI、GPU、音频或干净安装验收。用 `mktemp -d` 创建专用构建目录，只复制 `apps/desktop/src/main/player/native/` 为 `native/`、匹配 Electron 版本的 `include/node/` 为 `electron-headers/`，及 `scripts/playback-runtime.mjs`、`playback-runtime.test.mjs`、`packaging-runtime.mjs`、`playback-linux-helper-smoke.mjs` 为 `scripts/`，再将该 Dockerfile 复制到专用目录。不要把整个仓库、用户资料或凭据作为 context。镜像内安装 Debian 开发依赖、运行 C++ 回归及真实 ELF 搬移测试；`docker run --rm <构建镜像>` 仅验证 helper 加载、私有协议、EOF／destroy、无效 backend／句柄及无显示时的受控失败。此检查也由 Linux 开发构建调用，不创建 GL context，不播放素材。镜像中的系统 libmpv 没有来源闭包清单，检查必须拒绝将该 helper 单独作为正式运行库。

经审核的运行库通过 `JAVDEX_PLAYBACK_RUNTIME_DIR` 显式指定矩阵目录，每个目标在 `<platform>-<arch>/` 下独立提供入口、依赖库及 `runtime.json`，例如 `darwin-arm64/`、`win32-x64/` 和 `linux-x64/`。macOS/Windows 的入口为 `playback.node`；Linux 必须为有执行权限的 `playback-helper`，不接受旧的同进程 `playback.node`。未指定时不加入运行库；已指定但目录、架构、版本或文件不匹配时停止打包，不静默生成缺少运行库的内置播放包。已有 macOS Mach-O、Windows PE 与 Linux ELF 技术检查；Windows x64 已准备实际源码/许可闭包并生成未签名 ZIP/NSIS，实际解压版与安装版在去除开发 PATH 的子进程中通过播放回归，见 Windows 验收记录。可信签名、独立干净机器及其它平台的正式安装关口仍须实际验证，不能用清单或命令选择测试代替。

`runtime.json` v1 的输入合同如下；清单由实际运行库构建生成，不手工填入虚假的摘要：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | `1` |
| `hashStage` | `pre-sign`；这是签名前构建输入清单，不是签名后运行库的逐字节摘要 |
| `platform` / `arch` / `electronVersion` | 匹配正在打包的 Electron 平台、架构及实际版本；当前架构为 `arm64` / `x64` |
| `mpvVersion` | 与 `components` 中名为 `mpv` 的版本一致 |
| `files` | 相对路径到 SHA-256 的对象；精确覆盖全部文件，唯独不包含清单自身。禁止越界路径、符号链接和额外文件 |
| `components` | 1–128 个组件；每项包含 `name`、`version`、`license`、`binaries`，以及指向清单内非空文件的 `licenseFile`、`sourceArchive`、`buildRecipe`；所有二进制有且仅有一个来源所有者，包括 Javdex addon 或 Linux helper。首轮 Windows 闭包含 106 个分别保留来源身份的组件，因此上限由 100 调整为 128；本轮精简配置为 76 个组件 |

`beforePack` 核查完整 v1 输入；`afterPack` 再核查后，只将全部二进制、各组件的许可文件与 `SOURCE-ACCESS.txt` 复制到应用 Resources 的 `native-playback/`，随后由现有流程签名。分发目录的 `runtime.json` 为 v2：`files` 精确覆盖安装内容，保留组件来源引用，`sourceBundle` 绑定独立源码包的文件名、SHA-256、原 v1 清单摘要及当前打包工具摘要。`validatePackagedPlaybackRuntime` 验证该投影，拒绝源码/构建资料混入；v2 不能用作经过完整材料校验的 v1 打包输入。

完整非二进制材料、原 v1 清单和当前打包工具另生成 `Javdex-Playback-Sources-<version>-<platform>-<arch>-<input hash>-<tools hash>.tar.gz`，位于 `dist/`，不装入应用。使用已有系统 `tar`，不存在或归档失败会停止打包；复用源码包前重新验证摘要。分发应用包时同时提供这个配套源码包，公开发布时须落实源码访问方式，不能只提供一个未交付的文件名。输入目录保持完整，不通过删除源码或伪造许可绕过门禁。

Windows 桌面打包保留当前架构的 clipboard/console 原生模块，排除其它平台与架构；桌面 `out/server` 不进入应用，局域网前端 `out/web` 保留。Photon 使用主进程 chunk 旁的 WASM，排除 node_modules 中的重复文件。Windows `files` 规则必须同时保留桌面允许列表：打包器把平台规则建成独立文件集，只有排除项会默认包含仓库全部文件；配置归一化回归及实际包内容检查共同覆盖这个边界。

Windows x64 精简播放库的本地构建入口为 `scripts/build-windows-playback-libraries.mjs`，显式传入 `--sources`、`--prefix`、`--toolchain`、`--msys`、`--python`、`--work` 和可选 `--jobs`。需要已准备的 FFmpeg 9.0.2/mpv 0.41.0 源码、CLANG64 依赖前缀、Clang、MSYS make/bash 及 Python Meson；入口不下载或安装工具。它保留解码、网络、字幕、WGL/WASAPI 和硬解接口，移除视频编码/封装、VapourSynth/Python、采集与终端画面依赖，仅保留 PNG/MJPEG 图像编码器。

构建后以 `scripts/stage-windows-playback-profile.mjs --original <完整已审输入> --prefix <构建前缀> --destination <新空目录> --build <工作目录> --evidence <准备材料目录>` 生成独立 v1 输入；准备材料目录必须包含 `preparation.json` 与 `toolchain-lock.json`，工具链清单也可用 `--toolchain-lock <文件>` 显式指定。缺少清单在写入目标前拒绝，不依赖某次验收缓存的固定目录。之后从原 addon 的 PE 导入闭包选取 DLL，保留每个组件的源码、许可及配方，并加入本轮构建脚本、配置和工具记录。未知来源或缺失依赖会停止，不直接修改原矩阵。当前本机矩阵为 `out/playback-runtime/optimized/win32-x64`，打包设置 `JAVDEX_PLAYBACK_RUNTIME_DIR` 为 `out/playback-runtime/optimized`；实际安装/播放范围见 Windows 验收记录。

不会覆盖已存在的应用运行库目录。macOS 二进制必须包含目标架构；非系统动态依赖必须通过 `@loader_path` 指向该运行库清单内的二进制，禁止开发机绝对路径、依赖搜索型 `@rpath`、越界依赖和外部 rpath。动态库自身的 install name 可为规范的 `@rpath/<文件名>`，它不是一次依赖搜索。技术检查与搬移回归入口为 `npm run test:packaging`。

Windows 直接解析 PE32+ 的 Machine、DLL 标志、section/RVA、普通与延迟导入，不执行待审核 DLL，也不依赖 `dumpbin`。入口须编入对应工具链的宿主重定向钩子，并延迟加载 `node.exe`，普通导入必须含 libmpv；非系统依赖按大小写不敏感名称在同目录清单内命中，拒绝路径依赖、重复名称和缺失 DLL。VC++ runtime、Vulkan loader 和 codec DLL 不因开发机已安装就获豁免。真实 MSVC/Electron 测试将自建 addon/DLL 搬移、删除原目录，在无 DLL 的工作目录加载成功；它不是 libmpv 分发或许可证明。静态导入检查不能发现全部运行时 `LoadLibrary`、驱动依赖或最低 Windows API 版本，正式源码闭包与干净安装仍须独立验证。

Linux 使用 ELF header 和 GNU `readelf -dW` 核对 64 位小端、目标 x64/arm64、SONAME 与动态依赖，不执行待审核输入或用 `ldd`。仅入口 `playback-helper` 接受 ELF `ET_EXEC` 或 PIE `ET_DYN`，同时检查执行权限、非零入口、完整 program headers 及目标架构的标准 glibc interpreter；动态库仍只接受 `ET_DYN`。当前分发检查面向 glibc，musl 等运行时未纳入支持范围，也不从 ELF 类型推断最低发行版兼容性。

RPATH/RUNPATH 只允许位于运行库内的 `$ORIGIN` 相对目录，RUNPATH 存在时不误用被覆盖的 RPATH；helper 直接链接的 libmpv 及所有非系统 NEEDED 必须在这些目录中精确命中清单。helper 与库均计入摘要、许可／源码所有者并在复制后复核；执行权限不在内容摘要中，另行检查。禁止绝对／逃逸／空搜索项及动态 audit/filter 间接加载。系统依赖仅放行代码中明确列出的 glibc/C++ ABI、X11、GLVND 和 Xft/fontconfig/freetype 名称（不同架构 loader 分开）；这些是宿主提供的显示/字体前提，不代表可省略 mpv、FFmpeg、其它解码依赖或许可记录。该静态检查不能发现运行时 `dlopen` 的全部插件，不阻止用户自行设置 `LD_LIBRARY_PATH`／`LD_PRELOAD` 等 loader 环境，也不核对最低 GLIBC/C++ 符号版本；目标发行版、驱动及 ABI 基线仍须实际分发审核与干净安装。

代码签名可能改变二进制字节，因此保留的 `pre-sign` 摘要只证明输入与搬移阶段一致，不能拿它比较签名后的文件。最终包须另做签名完整性和分发产物摘要检查；正式播放运行库的签名/安装验收仍未完成，不由此输入清单自动推断。

**摘要不是签名，清单不是许可合规或播放验收证明。** Javdex 采用 GPL-3.0-or-later，应用 `LICENSE`、`NOTICE`、workspace 元数据、锁文件及当前公开许可说明已同步；此前 MIT 声明保留在 `LICENSES/Javdex-MIT.txt`，既有版本不追溯改写。构建来源、选项、源码与二进制对应关系、全部间接依赖及分发义务仍需复核，第三方代码保留各自版权和许可。mpv 默认构建与可选 LGPL 构建、FFmpeg 构建选项及依赖的许可边界分别见 [mpv Copyright](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright) 和 [FFmpeg 官方说明](https://ffmpeg.org/legal.html)。当前 macOS 开发库仍依赖 Homebrew，Linux 隔离检查使用 Debian 开发库；尚未提供经过这些关口的正式运行库或干净安装包。

部分 macOS/Windows 播放回归以隔离资料目录运行：先生成 `playback:native:build`、`desktop:build`（远程另需 `server:build`），再运行 `node scripts/playback-media-acceptance.mjs` 检查合成素材，或 `node scripts/playback-subtitle-acceptance.mjs` 定向检查复杂 ASS 与原创 PGS；可加 `--bitmap-only` 缩短图像字幕回归。`npm run test:playback:fixtures` 独立核对原创 PGS 字节/像素结构，不依赖 FFmpeg、GUI 或播放运行库，已纳入根 `npm test`。远程使用 `node scripts/playback-remote-acceptance.mjs --media-matrix`；追加 `--system-subtitle-picker` 时会等待真实系统选择器分别选择生成的 SRT/ASS，不适合无人值守 CI，也不 mock 文件选择器。具体文件、像素证据、失败诊断及未覆盖范围见 [字幕验收说明](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md) 与 [PGS 验收合同/结果](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md)。Windows 原生输入可运行 `node scripts/playback-windows-input-acceptance.mjs`，它准备隔离暂停素材并写入只读状态，仍需实际鼠标/键盘检查及解锁的桌面。Windows GUI 宿主还接受 `JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE` 指向实际解压/安装后的绝对 exe 路径；该子进程不带源码入口参数，使用空 cwd、Windows 系统 PATH 并移除开发 mpv prefix，诊断桥从包内 Resources 加载。仍不代表独立干净机器或发布验收。

`node scripts/playback-close-acceptance.mjs` 检查播放中正常关闭主窗口：窗口确实销毁，进程退出前内核已释放，随后应用正常退出。不要把清理移到可能被否决的 `close` 事件；本机实测还发现该事件中拆除活跃原生视图会让窗口留存。Windows 为 `closed` 清理保留私有隐藏 drawable/context，实际接受关闭时内核仍存活，原窗口销毁后内核释放、零窗口正常退出已通过；不用独立可见播放窗口代替主窗口嵌入。

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
