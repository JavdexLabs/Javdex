# CI 内置播放源码构建复核

日期：2026-10-14。基线：`dev` / `dcc2129`；修复提交：`f52b03b340bd358cec5cee4ed22a3458df725345`。本文件是修复验收记录，不是新版本发布记录。

**本次修复验收已完成。** [第八轮 run 38551710888](https://github.com/JavdexLabs/Javdex/actions/runs/38551710888) 从 `cef4ff1cc66b3b6f37291bc3b7e925d65060f2ba` 执行，四个平台包任务全部成功；六个桌面包与四份配套源码已复核。实际加载、PCM EOF、源码及签名证据见文末“第八轮最终验收”。仅验证，未发布或覆盖已公开 Beta.1，未合并 main。

## 原因与修复

发布任务没有准备 `JAVDEX_PLAYBACK_RUNTIME_DIR`，原打包器允许缺省运行库，而产物门禁只检查 Agent。`out/native-playback` 的开发产物本来就不应该进入正式安装包，因此没有放宽排除规则。缺库回归在修复前以 `Missing expected exception: win32/1` 失败，当前四个发布目标均拒绝无来源矩阵的 CI 打包。

选择固定源码自动构建，mpv 0.41.0 / FFmpeg 9.0.2 及字幕、字体、AV1、TLS、Lua 依赖按大小/SHA-256 锁定。libplacebo 所需 fast_float 与 Vulkan headers 使用固定提交，禁止隐式子模块下载。原生适配器使用对应 Electron 43.4.1 / Node 24.18.1 headers；源码、配方、第三方许可随 `Javdex-Playback-Sources-*` 分发。两套 macOS 架构分别在原生 runner 打包，Windows x64 和 Linux x64 独立构建。

真实构建复核还发现并修复：FFmpeg 不读取 `PKG_CONFIG` 环境变量，需要显式 `--pkg-config`；私有 pkgconf 默认过滤自身前缀的 `-L/-I` 会让 Linux Meson 误选系统 FFmpeg；Lua 完全关闭会令现有核心的安全初始化选项不存在；macOS Swift 需要独立最低部署目标；addon 的 LC_ID_DYLIB 与 libmpv 依赖必须迁移为包内相对路径。没有跳过这些失败或忽略必需选项。

## 已运行的证据

- `npm run playback:runtime:build`：macOS arm64 从固定源码构建通过；实际 Mach-O 架构、安装名/RPATH、文件闭包与许可证/源材料验证通过；libmpv 约 27 MiB。源码构建日志在 `out/playback-source-build-mac-final.log`。
- 再次执行构建入口：缓存命中仍经过原始文件 SHA-256、依赖检查、真实 Electron addon 加载与 PCM 解码到 EOF，见 `out/playback-source-cache-recheck.log`。不以缓存命中代替验收。
- 实际 Electron app 打包：`npx electron-builder --config electron-builder.config.mjs --mac --arm64 --dir --publish never -c.directories.output=out/playback-ci-app`；不是只复制库到假 Resources。外层 app 与每个原生文件的 ad-hoc 签名通过，源归档摘要与分发投影通过，包内 addon 能在 Electron 43.4.1 加载，迁移后的 libmpv 解码 PCM 到 EOF。原始日志为 `out/playback-packaged-mac.log`、`out/playback-packaged-mac-check.log`。最终材料另在 `out/playback-ci-app-final` 重打包、重验，日志为 `out/playback-packaged-mac-final.log`、`out/playback-packaged-mac-final-check.log`。
- Linux arm64：隔离 Debian 12 容器中从同一源码清单构建静态依赖、共享 libmpv 和 X11 helper，CMake 核心/控制测试、helper 私有协议/EOF/无显示失败路径、真实 ELF 依赖检查和迁移后 PCM 解码到 EOF 均通过。保留实际输入于 `out/playback-linux-arm64-proof`，日志 `out/playback-source-build-linux-arm64-final.log`。不是 macOS 上对 ELF 做伪执行，也不是服务端容器 smoke。临时验收容器已删除，产物与日志仍可检查。
- `CI=true GITHUB_ACTIONS=true npm run test:packaging`：42 通过、0 失败；Windows PE 与 Linux ELF 两项平台专属加载测试在 macOS 跳过，不把它们算作平台验收。包含真实 Mach-O 移位、实际 codesign 及篡改后拒绝的回归。
- `npm run test:playback:build`：固定源码/摘要、构建缓存身份、静态依赖补丁漂移、私有 pkgconf 路径、原生构建命令、单架构打包选择、SDK 来源、Debian 宿主依赖和发布门禁测试。`npm run typecheck`、`npm run check:encoding`、`git diff --check` 通过。

最终 macOS 输入的构建指纹为 `54db97d0be596c9aaad10680fbe1b2e2842592559c0b713ad103e581a9dbae27`；`--fingerprint` 与缓存复验记录一致。最终 app 由自身已签名的 `Contents/MacOS/Javdex` 加载包内 `playback.node` 成功（不是只用开发 Electron 代替），然后独立解码检查通过。配套源码包 SHA-256 为 `37fe4f09c59c56a527ac0a21eb3eeeda66cdce63a03dec912dc9d6987b56b017`，分发投影绑定的原输入清单摘要为 `06aa3eb434b21b0bc4ea3412c1e63c1c72bae4c29138a9ee027429ca3924ee02`。最终构建/发布规划测试为 20 通过、0 失败、0 跳过；打包测试为 42 通过、0 失败、2 个既有平台专属跳过。

## 验收范围与边界

四目标统一源码构建、打包与包内加载/PCM EOF 验收已完成；实际原生 runner 和产物证据见下文。Linux arm64 容器的早期证明不能代替此后的 Ubuntu 22.04 x64 原生结果；本轮仍不是 AppImage/DEB/NSIS/DMG 独立干净机器安装或 GUI/GL 验收。macOS 使用 ad-hoc 签名，不是 Developer ID/公证；Windows 安装包未作可信发布者签名。PCM EOF 不代表 H.264/HEVC/AV1/字幕/网络/硬解的完整矩阵通过。

Release 新增 `verify_only=true` 的手动入口，只生成/核验桌面 CI 产物；服务镜像、镜像 manifest 和 GitHub Release 三道发布边界都拒绝此模式。2026-10-14 用户已授权将修复提交并推送 `dev`，随后执行四目标验证 CI；实际提交与 CI 证据在执行后补录。已公开 `v0.9.0-beta.1` 的标签、镜像和资产不改写，下一次正式分发需要新版本编号；没有合并 `main`。

2026-10-14 用户已确认仅保留软件用到的基础播放能力，不包含开发库中额外的蓝光/DVD 导航、SFTP/SRT 网络协议等依赖。现有常用媒体解码、系统字幕字体/布局、内置网络协议及原生硬解接口保留，但实际多格式/硬解行为仍按上述未验收边界处理。

## 四目标 CI 跟进

修复已提交、推送到 `dev`，工作树干净。提交前复验：构建/发布规划 20 通过；打包 42 通过、0 失败、2 个平台专属跳过；编码与 diff 检查通过。

已使用 `gh workflow run release.yml --ref dev -f verify_only=true` 启动 [run 38514777077](https://github.com/JavdexLabs/Javdex/actions/runs/38514777077)，源码 `f52b03b340bd358cec5cee4ed22a3458df725345`。2026-10-14 05:05 UTC 的实际快照为 metadata 成功、Windows 完整测试正在运行，四个平台打包尚未开始；不记作 CI 验收完成。独立的“Javdex 内置播放四目标 CI 验收”跟进已启用，旧 Beta 发布跟进保持暂停。只在失败、需要决策或全部核验完成时通知，并在完成后补充实际产物和发布任务 skipped 的证据。

### 首轮失败：既有 CSS 重复规则

Run 38514777077 在 Windows `pretest` 的 CSS lint 失败：`ModelProvidersPanel.module.css:294` 重复声明 `.availableProvider:hover`（首项在 290 行）。尚未进入四平台源码构建/打包；server、server-manifest、release 均为 skipped，没有公开任何新产物。

定向反馈命令 `npx stylelint apps/desktop/src/renderer/src/components/settings/ModelProvidersPanel.module.css` 在本机先以相同 `no-duplicate-selectors` 错误、exit 2 失败。合并相邻的两个 hover 声明，不更改选择器、声明值或顺序，保留原边框与文字效果；再次运行该命令及完整 `npm run lint:css` 均 exit 0。另用 PostCSS 逐选择器对比修复前后的声明值与顺序，完全一致。沿用现有 stylelint 门禁作为回归，不禁用规则、不跳过检查；随后重跑完整 pretest，并以新源码启动 verify-only CI。

修复提交 `c2f0d1dfbd6de3055657cbec86da491e4aec9bcb` 已推送 `dev`，使用同一显式 `verify_only=true` 命令启动 [run 38516660322](https://github.com/JavdexLabs/Javdex/actions/runs/38516660322)。已核对 headSha 与修复提交一致，metadata 成功、完整测试运行中，四目标包验收仍未完成。

本机完整 `npm run pretest` 随后 exit 0，包含全部边界、TypeScript/CSS lint、CSS 架构及共享控件检查；编码与 diff 检查也通过。没有新增调试日志或降低检查规则。

### 第二轮失败：测试假定 POSIX 路径与 LF

Run 38516660322 的完整 pretest、类型检查和打包回归通过，随后 `test:playback:build` 16 通过、4 失败。两项源码计划断言写死 `/` 路径而 Windows 的 `path.join` 返回反斜线；两项 workflow 文本断言假定 LF，而实际 checkout 为 CRLF。四目标包任务仍未开始，三个发布任务仍 skipped。

定向复现使用隔离 Node 进程预加载器：只把测试夹具的 `path.join` 替换为 `path.win32.join`、把实际 `release.yml` 的读取结果替换为 CRLF，然后导入两个真实测试文件。本机稳定复现相同四个失败（11 通过、4 失败）；只修正路径期望后剩两个换行失败（13 通过、2 失败）；规范换行后 18 通过、0 失败。没有把本机文本模拟算作 Windows 编译或包验收。

修复只调整测试的宿主路径表示及换行规范化，并让全部 workflow 门禁同时覆盖 LF/CRLF；不改生产构建配方、源码 pin、运行库校验或发布条件。额外在隔离进程分别移除源码构建步骤、移除 verify-only 发布条件，两种变体在 LF 与 CRLF 都被原门禁拒绝（各两个失败），证明没有以减少要求取得通过。`npm run test:playback:build` 当前 23 通过、0 失败、0 跳过；`CI=true GITHUB_ACTIONS=true npm run test:packaging` 42 通过、0 失败、两个原有平台专属跳过；编码/diff 检查通过。无临时源码文件或调试日志遗留。

修复 `2e54083418be4656ba9bef1466be7baaaba6c403` 已推送 `dev`，第三轮 [run 38518449745](https://github.com/JavdexLabs/Javdex/actions/runs/38518449745) 以显式 `verify_only=true` 启动，已核对 headSha 一致；启动后的首个快照为 queued，继续跟进，不记作验收成功。

### 第三轮失败：模型管理器关闭未等待启动

Run 38518449745 已通过 pretest、类型检查、打包/夹具和 23 项构建规划测试，进入完整 Electron 回归后，“new configuration starts with exact defaults and invalid variant identities cannot change it” 以模型目录 `lstat ENOENT` 失败。四目标包尚未执行，三个发布任务均 skipped。

该原有用例在本机定向与整文件运行均通过，因此没有把它当作确定性复现或临时基础设施错误重跑。新增确定性启动屏障回归：暂停真实模型目录首次 lstat，在启动尚未完成时调用 `close()`，断言关闭不得释放随后可清理的 profile；修复前定向命令 `node scripts/run-electron-tests.mjs '--test-name-pattern=close drains delayed initialization' apps/desktop/src/main/services/localModels/localModelManager.test.ts` 稳定失败为 `close must not release the profile while startup still accesses its model directory`。`close()` 原先只等待下载 pending、未等待初始化 ready，因此测试清理 profile 后，较慢的启动文件检查仍可能继续。

修复关闭边界：先标记关闭/取消，等待初始化结束（即使初始化失败，也完成关闭清理），再等待下载及关闭推理引擎。启动失败仍经 snapshot/mode 报告，另有失败启动回归证明没有隐藏它。两个新增回归通过；完整本地模型相关 Electron 测试 68 通过、0 失败、0 跳过；Node 类型检查、定向 ESLint、编码和 diff 检查通过。临时 profile 在回归 finally 中等待初始化结束后清理，没有改写用户资料或放宽任何平台验收。真实 Windows 故障是否消除仍须下一轮 CI 确认。

修复 `1ce45d2379cab7024660dfa9d5078d93309f200f` 已推送 `dev`，第四轮 [run 38521347227](https://github.com/JavdexLabs/Javdex/actions/runs/38521347227) 以显式 `verify_only=true` 启动，继续跟进四目标真实验收。

### 第四轮 attempt 1：Windows 宿主原生退出故障

第四轮的两个启动/关闭回归及原“new configuration starts…”用例在真实 Windows 全部通过，确认上次模型目录竞态回归不再失败。完整 Electron 测试统计 2512 项：2487 通过、1 个文件级失败、24 个既有平台专属跳过。

本次失败文件 `scanner.test.ts` 的 70 项扫描断言全部通过（`scanFolders` suite 成功），随后子进程输出 `PostQueuedCompletionStatus: (6) The handle is invalid.` 并异常退出。上一轮同一扫描源码成功退出，本轮本机定向运行 70 通过、0 失败、0 跳过；两轮之间扫描模块、Electron/Node 锁定版本和测试宿主脚本均无改动。这是宿主原生退出失败而非扫描业务断言失败，但尚未确定其底层原因；[libuv Windows 异步关闭代码](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/async.c) 可用于后续 IOCP 生命周期诊断，不据其最新源码推断当前 Electron 已包含某项修复。

仅作一次有界的疑似临时宿主故障验证：执行 `gh run rerun 38521347227 --failed`，保留原源码 `1ce45d2379cab7024660dfa9d5078d93309f200f` 与 verify-only 输入，启动 attempt 2。不修改扫描业务，不排除失败文件，不自动将非零退出视为通过；若同类原生退出故障复现，必须转入 Windows 定向诊断而非继续盲重跑。三个发布任务在 attempt 1 均 skipped，四平台打包未执行；不记作本轮验收成功。

### 第四轮 attempt 2：macOS 两架构通过，Windows/Linux 源码构建失败

Run 38521347227 attempt 2 的真实 Windows 完整测试 job `115720203959` 成功，未再次出现 IOCP 原生退出故障；这不证明已查明或修复 libuv 底层退出原因。macOS arm64 job `115728199404` 与 Intel job `115728199405` 的源码构建、DMG 打包、包内真实 addon 加载、迁移后 PCM 解码到 EOF、配套源码与真实签名检查全部成功。

- [arm64 CI 产物](https://github.com/JavdexLabs/Javdex/actions/runs/38521347227/artifacts/11876771842)：`Javdex-mac-arm64`，234945079 字节，上传 ZIP SHA-256 `cbd6494f4a6535165b3a9c902567dae79c2a115b9cc735b5933d809826b1d248`。
- [Intel CI 产物](https://github.com/JavdexLabs/Javdex/actions/runs/38521347227/artifacts/11877224282)：`Javdex-mac-x64`，242553265 字节，上传 ZIP SHA-256 `3260b765708b82d2883b70fa64d9a3f6cccb992a5ecc922684f6bcc0668769b9`。包内 `Contents/MacOS/Javdex` 实际加载成功，配套源码名为 `Javdex-Playback-Sources-0.9.0-beta.1-darwin-x64-84cb55c6f5a5-a5ada0e8.tar.gz`。

这仍不是四目标验收完成：Windows job `115728199353` 和 Linux job `115728199394` 在固定源码构建阶段失败。最终 server、server-manifest、Publish GitHub release 均 skipped；上述材料只在 CI artifacts，不是覆盖已公开 Beta 资产。

Windows 在 pkgconf 的 make 阶段报 `No rule to make target '/d/.../source/pkgconf/Makefile.am'`；归档中实际有该文件，日志中的 GCC/ld 却来自 `C:/mingw64`。构建入口写死另一套 `C:/msys64` shell/PATH，而 [setup-msys2](https://github.com/msys2/setup-msys2#outputs) 返回此次安装位置。新增回归在隔离 Node 子进程驱动真实 `--fingerprint` 入口，只替换工具执行/存在检查：输入 `D:\a\_temp\msys64`，修复前实际调用 C 盘 shell 而失败，修复后 shell 与 UCRT64 PATH 均来自所传安装根。它不是 Windows 原生编译证明。

修复使用 action 的 `msys2-location`，指纹和实际构建传入同一 `JAVDEX_PLAYBACK_MSYS2_ROOT`，校验 shell/make/GCC 存在并明确 UCRT64；不再猜测默认目录。还将 Windows **打包** runner 固定为 `windows-2022`，对应现有 Visual Studio 17 2022 generator；本轮 `windows-latest` 已使用 VS 18，不能继续假定 VS 17 存在。[官方 Windows 2022 镜像工具表](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)列出 VS 2022。根完整测试仍使用 windows-latest，未减少测试覆盖。

Linux 共享 libmpv 链接时，Meson 对静态 libass 递归选择系统 `fontconfig.a`/`uuid.a`，Ubuntu 22.04 的 UUID 静态对象以 `R_X86_64_TPOFF32` 拒绝进入共享库。隔离 Ubuntu 22.04 **amd64** 容器实际编译固定 libass 0.17.5（归档 SHA-256 `2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc`，`b_staticpic=true`），以同一私有 `libass.a` 驱动最小共享库链接：原 Meson static dependency 稳定报相同 UUID relocation；改用真实补丁生成的链接声明后成功，`readelf -d` 无 `libass.so` 依赖，系统 fontconfig 采用共享库。

Linux 修复保留私有 pkgconf 的静态 `-l`/其它链接旗标和私有 `-L` 前缀，让宿主字体提供者按动态 ABI 解析，避免递归固定到非 PIC 系统归档。FFmpeg、libass、HarfBuzz 等正式自建依赖仍在私有前缀编为 PIC 静态库；没有改用系统 codec、关闭字幕字体或放宽闭包白名单。该最小复现只构建 libass 和共享库，部分字体布局依赖由隔离系统提供，**不**代表正式 libmpv/安装包全闭包或原生 CI 已通过。

新增配方漂移回归与 Windows 真入口路径回归，workflow 绑定在 LF/CRLF 均检查；另在隔离进程将打包 runner 改回 windows-latest，两种换行的门禁均拒绝（7 通过、2 失败），未改写工作树。构建/发布规划 25 通过、0 失败、0 跳过；打包 42 通过、0 失败、两个既有平台专属跳过；编码与 diff 检查通过。诊断夹具在忽略的 `out/playback-link-repro`，不进入安装包或提交；两个临时容器已删除，隔离复现镜像保留以便复查，没有生产调试日志。两处实际源码失败需新提交、新 verify-only run 验证，不继续重跑旧源码。

提交前完整 `npm run pretest` exit 0，包含全部生产边界、TypeScript/CSS lint、CSS 架构与共享控件检查。

修复 `a12d1614da447fca3fd6332743e3ea51d0f40f4b` 已推送 `dev`，使用显式 `verify_only=true` 启动第五轮 [run 38531429780](https://github.com/JavdexLabs/Javdex/actions/runs/38531429780)，已核对 headSha 一致。2026-10-14 07:54 UTC 快照为 in_progress，仍待完整 Windows 回归与四目标包验收；不记作修复验收完成。现有跟进继续核对最新 run 和本记录，不重复触发，不发布或改写公开版本。

### 第五轮：静态 pkgconf API 与 Linux 搬移前测试加载

第五轮完整 Windows 回归 job `115744071716` 成功。Windows 打包 job `115752397259` 已使用正确的 `D:/a/_temp/msys64/ucrt64` GCC/ld 并通过原来失败的 configure/make 路径，随后 pkgconf/bomtool 静态链接报 `undefined reference to __imp_pkgconf_*`。Linux job `115752397121` 的共享 libmpv 与 X11 helper 编译/链接均成功，确认前轮 UUID 非 PIC 修复在真实 Ubuntu 22.04 x64 生效；之后 `mpv-core-test` 以找不到 `libmpv.so.2`、exit 127 失败，尚未执行搬移后的运行库或包验收。macOS arm64 job `115752397117` 已成功；Intel job `115752397165` 在修复时仍运行，不据部分成功宣称本轮完成。

Windows 定向复现使用隔离 Ubuntu 22.04 容器中的 MinGW x64 交叉链接器，实际编译相同 pkgconf 2.5.1 归档（SHA-256 `cd05c9589b9f86ecf044c10a2269822bc9eb001eced2582cfffd658b0a50c243`）。完整静态 CLI 重现相同 `__imp_pkgconf_*` 链接失败；最小客户端调用一个公开函数、显式指定实际私有 `.a` 时仍以 `__imp_pkgconf_compare_version` 失败，排除误选归档。复现使用 GCC 10.3，原 CI 为 16.2，同类错误并不依赖新 GCC。

只给客户端定义静态 API 仍不能解决库内跨对象调用；固定上游头文件 `libpkgconf-api.h` 以 `PKGCONFIG_IS_STATIC` 控制该声明。仅为 Windows 的 pkgconf configure 添加此定义，让库与 CLI 一致，随后完整 pkgconf/bomtool 编译和安装成功；再次用真实 `playbackSourcePlan` 输出的 configure 参数进行交叉构建/安装也成功。PE 只依赖 ADVAPI32/KERNEL32/msvcrt，不要求 libpkgconf DLL。该证明是 PE 交叉链接，不是 Windows 原生执行，正式 UCRT64 原生 CI 仍待通过；pkgconf 是 toolOnly，不进入播放安装包，也没有更改 codec 的编译定义。

Linux 的 CMake 构建目标提前使用最终 `$ORIGIN` RPATH，但测试执行时共享 libmpv 尚在私有 prefix/lib，未搬移到测试程序旁。最小真实 ELF 复现生成 SONAME 为 `libmpv.so.2` 的测试库及 `$ORIGIN` 客户端：无开发路径时稳定 exit 127，同一二进制只为子进程添加私有 prefix/lib 后 exit 0，RPATH 仍为 `$ORIGIN`。它验证 loader 合同，不冒充真实 libmpv 解码。

修复只为 Linux 搬移前的核心/控制/helper 测试命令添加步骤级环境，驱动在 spawn 时合并，不改变全局构建环境；之后的运行库与包验收仍去除 LD_LIBRARY_PATH/开发 PATH，并检查相对依赖与 PCM EOF。没有改成绝对 RPATH 或跳过失败测试。两个新增配方回归先以 11 通过、2 失败验证红灯，修复后全部构建/发布规划 27 通过、0 失败、0 跳过；打包 42 通过、0 失败、两个既有平台专属跳过；脚本语法、编码和 diff 检查通过。夹具位于忽略目录 `out/playback-pkgconf-repro`，隔离工具镜像保留用于复查，不进入提交或安装包。

四个临时诊断容器已删除，复现镜像及夹具保留。修复 `2ab2b91e8de55b22225c509284ef4e300e3e93bd` 已推送 `dev`，显式 `verify_only=true` 启动第六轮 [run 38536746800](https://github.com/JavdexLabs/Javdex/actions/runs/38536746800)，headSha 已核对一致。2026-10-14 08:40 UTC 为 pending，等待同一 dev 发布并发组中第五轮 Intel 任务完成；不取消正常工作的旧任务，不重复触发。四目标统一验收仍未完成，没有公开新版本、覆盖 Beta.1 或合并 main。

### 第五轮结束：Intel SDK 下载连接超时

第五轮 Intel job `115752397165` 已完成共享 libmpv 的编译/安装，随后 node-gyp 获取固定 Electron 43.4.1 headers 时以 `ConnectTimeoutError` 失败：连接 `electronjs.org:443` 超过 10000ms。尚未执行原生适配器或 DMG 打包，不能记为 Intel 本轮通过；server、server-manifest、Publish GitHub release 最终均 skipped。

这是日志直接指出的外部连接故障，本机对完全相同 SDK URL 的限时 HEAD/重定向检查返回 HTTP 200，但它不证明原 runner 的网络已经恢复。没有据暂时连接失败假设或修改业务/构建源码，也不跳过 SDK 校验。第六轮已经针对 Windows/Linux 的新修复开始运行（源码仍为 `2ab2b91`，metadata 成功、完整测试 in_progress），它会重新获取和验证同一 SDK；不额外重跑旧源码或重复启动任务。若新轮仍发生下载失败，再按实际日志处理有界的基础设施重试。

### 第六轮：Windows 必需线程后端被精简选项关闭

第六轮完整 Windows 回归成功；Linux job `115770957924` 与 macOS arm64 job `115770958244` 完整包验收成功。Linux 实际 helper 私有协议、搬移后 PCM EOF、AppImage/DEB 打包、包内运行库与对应源码门禁通过，确认前轮步骤级加载环境修复没有替代最终无开发路径验收。Intel job `115770957917` 已通过固定 SDK 下载与源码构建，进入 Package；在本次定向修复时尚未结束，不重复处理第五轮超时。

Windows job `115770957935` 已完成固定源码依赖构建，libmpv 编译到 `osdep/timer-win32.c` 时以 `redefinition of mp_thread_cpu_time_ns` 失败，前一处定义来自 `threads-posix.h`。固定 mpv 0.41.0 的 `win32-threads` 默认是 feature/auto；统一 `auto_features=disabled` 也将其关闭，选到 POSIX 线程头，与仍启用的 Windows 原生计时实现不配套。

隔离 MinGW x64 编译循环直接使用已校验的固定 mpv 归档（SHA-256 `ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209`），未改动计时或线程源文件。诊断配置 `HAVE_WIN32_THREADS=0` 时只以同一重复定义失败；同一命令只改成 1 后完整计时文件编译通过，目标对象只包含一个该函数定义。旧 MinGW SDK 的计时常量/clock 声明只在诊断命令补齐，不进入生产配方；这是该编译单元的交叉编译证明，不冒充完整 libmpv、原生适配器或安装包验收。

修复仅为 Windows mpv setup 显式增加官方 `-Dwin32-threads=enabled`，不修改上游源码、不放开自动探测、不移除计时功能，也不改变另外两平台后端。新增配方回归在修复前为 13 通过、1 失败，修复后完整构建/发布规划 28 通过、0 失败、0 跳过；打包 42 通过、0 失败、两个既有平台专属跳过；编码、语法与 diff 检查通过。诊断源码/配置保留在忽略的 `out/playback-win-threads-repro`，容器均自动清理，无生产调试日志。

第六轮最终结果为三个非 Windows 包 job 成功、Windows 失败，server、server-manifest、Publish GitHub release 均 skipped。修复 `ed1efd7c1e462cd193147244dc6ae6610b0a5a0b` 已推送 `dev`，显式 `verify_only=true` 启动第七轮 [run 38544445106](https://github.com/JavdexLabs/Javdex/actions/runs/38544445106)，已核对 headSha 一致；四目标统一成功仍待此新源码的实际结果。未发布版本、覆盖已有资产或合并 main。

### 第七轮：GNU objdump 导出名称表格式变化

第七轮完整 Windows 回归成功，macOS arm64 job `115795406154` 与 Linux job `115795406237` 完整包验收成功。Windows job `115795406346` 已编译全部 238 个 libmpv 目标并安装 `libmpv-2.dll`，确认必需线程后端修复生效；固定 Electron SDK 下载/校验成功，随后以 `Could not extract libmpv exports` 失败，尚未构建 MSVC addon 或安装包。本次修复时 Intel job `115795406403` 已通过源码构建，仍在 Package，不据部分成功记作四目标完成。

实际 CI 安装 Binutils `2.47-3`。旧代码只识别 `[ordinal] mpv_name`；[官方 2.47 分支 PE 输出实现](https://gnu.googlesource.com/binutils-gdb/+/refs/heads/binutils-2_47-branch/bfd/peXXigen.c) 的导出名称表已增加 base 与十六进制 hint 列。原 runner 没有输出捕获的 objdump 文本，因此未将本机输出冒充它的原始日志。

定向差分复现对同一个真实 MinGW x64 小型 DLL 分别运行隔离工具镜像中的 GNU objdump 2.38 和 2.44，DLL 包含 26 个诊断导出函数，并非 libmpv 实现。生产提取规则在旧工具输出中读取 26 个名称，新工具输出中读取 0 个，稳定触发相同数量门禁错误；只换解析逻辑后，两份原始工具输出均读取相同的 26 个名称，数量仍要求大于 20。该证明验证 PE 导出提取，不冒充原生 Windows addon、libmpv 解码或安装包验收。

将调用处的解析移到可直接回归的纯函数，兼容两种名称表与 LF/CRLF，并限定表范围和符号字符；不从导入表、地址/forwarder 行或损坏条目误生成导入库。两项新增回归先为 0 通过、2 失败，修复后通过；完整构建/发布规划 30 通过、0 失败、0 跳过，打包 42 通过、0 失败、两个既有平台专属跳过，脚本语法、编码与 diff 检查通过。没有变更源码 pin、关闭门禁、复制外部 libmpv SDK 或增加播放功能。

诊断输入与真实工具输出保留在忽略的 `out/playback-exports-repro`，临时容器自动删除，无生产调试日志；未完成的诊断工具源码下载已清除。修复须以新提交、新 verify-only run 验证，继续保留已有公开 Beta.1 资产与 main 不变。

提交前第七轮已结束：Intel job `115795406403` 完整包验收也成功，最终仍为三个非 Windows 包通过、Windows 失败；server job `115810388305`、server-manifest job `115810389692`、Publish GitHub release job `115810390209` 全部 skipped，没有发布任何新版本。

修复 `cef4ff1cc66b3b6f37291bc3b7e925d65060f2ba` 已推送 `dev`，显式 `verify_only=true` 启动第八轮 [run 38551710888](https://github.com/JavdexLabs/Javdex/actions/runs/38551710888)，已核对 headSha 一致。2026-10-14 10:44 UTC 为 in_progress，继续跟进真实四目标包验收；不重复触发，不将本机解析回归替代 Windows 实际链接、加载和 EOF 门禁。

## 第八轮最终验收

2026-10-14 11:36:47 UTC，run `38551710888` attempt 1 最终为 `success`，事件为 `workflow_dispatch`、源码 `cef4ff1cc66b3b6f37291bc3b7e925d65060f2ba`。完整 Windows 类型检查/测试 job `115811048562` 成功，构建规划 30 项通过；Electron 回归 2487 通过、0 失败、24 个既有平台专属跳过，后续 Node 回归 1323 通过、0 失败、1 个既有跳过。没有排除失败测试、放宽闭包或重跑旧源码来替代修复。

| 目标 | 原生包 job | CI 产物 | 实际证据 |
| --- | --- | --- | --- |
| Windows x64 / VS 2022 + UCRT64 | `115819718824` | [Javdex-win-x64](https://github.com/JavdexLabs/Javdex/actions/runs/38551710888/artifacts/11890468353) | 固定源码 DLL、MSVC addon、EXE/ZIP 成功；`Javdex.exe` 从实际打包目录加载 addon；搬移后 libmpv PCM 达到 EOF |
| macOS Intel | `115819719199` | [Javdex-mac-x64](https://github.com/JavdexLabs/Javdex/actions/runs/38551710888/artifacts/11890865593) | DMG 成功；实际 `Contents/MacOS/Javdex` 加载 addon；PCM EOF；外层 app 和原生二进制真实签名检查通过 |
| macOS arm64 | `115819718644` | [Javdex-mac-arm64](https://github.com/JavdexLabs/Javdex/actions/runs/38551710888/artifacts/11890171136) | DMG 成功；实际 `Contents/MacOS/Javdex` 加载 addon；PCM EOF；外层 app 和原生二进制真实签名检查通过 |
| Ubuntu 22.04 x64 | `115819718723` | [Javdex-linux-x64](https://github.com/JavdexLabs/Javdex/actions/runs/38551710888/artifacts/11888967773) | AppImage/DEB 成功；包内 X11 helper 私有协议、EOF/destroy、无显示受控失败；搬移后 libmpv PCM EOF |

四个 `Verify packaged playback runtime and corresponding source delivery` 和 Agent 验证步骤均成功，各目标均为两份原生运行库二进制；实际执行日志不是只检查目录或 `require`。加载/解码进程清除开发库搜索路径；macOS/Windows 还由打包后实际宿主加载。Mac 签名步骤均有 `valid on disk` 与 `satisfies its Designated Requirement`；其它平台该 Mac 专属步骤正确 skipped，不将其算作可信签名通过。

### 实际产物摘要

已完整读取四个上传 ZIP，核对实际字节与 SHA-256，均同时匹配 GitHub artifacts API 和上传日志；并逐一计算 ZIP 内安装产物和对应源码文件的摘要。归档为 CI artifacts，不是 Release 资产，当前过期时间为 2027-01-12 10:44:49 UTC。

| CI 归档 | 字节 | 实际 SHA-256 |
| --- | ---: | --- |
| Javdex-win-x64 | 385720153 | `ef354f74eef81bb0167738a1c06dc39c9f0ab8838435f0144a601117674a2c41` |
| Javdex-mac-x64 | 242553954 | `116a25307e3cf1c27753b7b5945c2a9e6055637203119a90734da6e0e9a2977a` |
| Javdex-mac-arm64 | 234945158 | `825b1e962bce82247fe092923ad887f19e8a18743a062ab4e0d843628bfd3007` |
| Javdex-linux-x64 | 429312882 | `79587b17a39146dc54e532b0fb921a739ad6b64ec64b47f7101f3b55516b5bd9` |

六个桌面包：

| 文件 | 字节 | 实际 SHA-256 |
| --- | ---: | --- |
| Javdex-Setup-0.9.0-beta.1-x64.exe | 139282056 | `b9fa7a610144bb69ee07efa77cf458b5b503d84bffa40235ccbedad841b93baf` |
| Javdex-Setup-0.9.0-beta.1-x64.zip | 188887823 | `de3983af22ce08925c143699b9804c8ef268762922594ff3e4bdfb2c882dd2ce` |
| Javdex-0.9.0-beta.1-x64.dmg | 189897564 | `eb06bc989d755b2c42238e882fc46d910f3883ba9d597fdd6cc165b178f5b1a7` |
| Javdex-0.9.0-beta.1-arm64.dmg | 182309781 | `74ea48a7858470bb6f62d794119814ce869b5a5f9accb7d2c28e5f0fc71c0670` |
| Javdex-0.9.0-beta.1-amd64.deb | 143411312 | `b6fd611c84c25e29b6e7fa5f82877769a58c5be20b0b2039693a07e328d8c511` |
| Javdex-0.9.0-beta.1-x86_64.AppImage | 180495773 | `647712e0d9391349b0026b5e29ef7a4083b035ae7781dfd80dd5082a3577ffd1` |

四份对应源码：

| 文件 | 字节 | 实际 SHA-256 |
| --- | ---: | --- |
| Javdex-Playback-Sources-0.9.0-beta.1-win32-x64-ed1391d1d039-270ed01c.tar.gz | 57898461 | `da6b1a248aa58c42b35a33929aa7085219f9fde6cb257668860efe271008e432` |
| Javdex-Playback-Sources-0.9.0-beta.1-darwin-x64-18f3cccdab23-a5ada0e8.tar.gz | 52754162 | `79084fd941b7cc816d6d4c44ab87ddb61a813c36895a637309af184340780f06` |
| Javdex-Playback-Sources-0.9.0-beta.1-darwin-arm64-734580fd5446-a5ada0e8.tar.gz | 52754181 | `b977dd9c6f9620a37395acffea4b5eeaf34c011890b833fd8b6bba60fdabb613` |
| Javdex-Playback-Sources-0.9.0-beta.1-linux-x64-844ea45646b0-a5ada0e8.tar.gz | 105994675 | `686eecf7c6351cb60172bcca655fcea7ec0ff36b0aa2e6c0817273c23d3add60` |

实际解析四份源码归档，确认 README、原始 input inventory、build receipt、libmpv 原始源码集合、Javdex 首选原生源码/SDK、许可证和 packaging-tools 均在；清单的输入摘要前缀匹配归档名称，receipt 的目标/SDK/构建指纹及各来源 pin 匹配本轮原生构建。三份关键配方 `scripts/playback-source-build.mjs`、`scripts/build-playback-runtime.mjs`、`build/playback-sources.json` 与源码提交一致。Windows checkout 保留 CRLF，比较时仅规范此换行表示；已用 Git 原文转换为 CRLF 复现相同字节摘要，未忽略内容变化或改写源码归档。

额外随机读取实际 Windows ZIP 的 `resources/native-playback`：`playback.node` 为 `3d45c3990f4bc77febee08b383b2e8f46afe61f66eae92a876d61c6d93d55600`，`libmpv-2.dll` 为 `00de23fa0fb8cc01a83fed6c187cae8daaff397b6bae4d0aed129dba2042f44a`；二进制、许可证、SOURCE-ACCESS 的字节摘要均匹配包内 runtime.json，sourceBundle 的名称、完整摘要和输入清单摘要与实际配套源码一致。未在 Mac 上冒充 Windows 执行或重新运行下载的安装程序。

本机首次并发下载因磁盘不足中断，仅清除本轮四个未完成 ZIP；之后三个目标流式核对，Windows 采用一次受控文件下载和随机读取。临时工具最初遇到 Windows CRLF 比较及嵌套 ZIP 流关闭问题，均只修正核对方式，未改生产代码、忽略验收失败或重触发 CI。所有四份完整上传数据与十个文件摘要最终核对通过。原始 job 日志与结构化证据保留在忽略目录 `out/playback-ci-final-38551710888-ap0dwm`；仅用于核对的 Windows 上传 ZIP 清理后可从上述 CI artifact 再取，不删除已有构建材料或用户文件。

### 发布边界

server job `115831142042`、server-manifest job `115831142908`、Publish GitHub release job `115831143516` 最终全部 skipped。公开 `v0.9.0-beta.1` 标签仍为 `d10f8c1aea09a74de4d788a9445a22ff4110ac89`，Release 仍为原 14 个资产；稳定 `releases/latest` 仍为 `v0.8.0`，远程 main 仍为 `004dc15d303dde90eb2829ca01d4f092b9f0ed2d`。本轮没有更新服务镜像、访问签名私钥、改写 Beta.1 或合并 main。

公开 Beta.1 的旧安装包仍不包含此次修复；本节中同版本名称是 verify-only 的 CI 验证产物，不可覆盖旧 Release。修复后的正式分发须由用户授权新版本编号。本次四目标 CI 修复验收结束，保存并推送本记录后停用本次跟进。
