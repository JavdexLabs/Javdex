# CI 内置播放源码构建复核

日期：2026-10-14。基线：`dev` / `dcc2129`；修复提交：`f52b03b340bd358cec5cee4ed22a3458df725345`。本文件是修复验收记录，不是新版本发布记录。

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

## 尚未完成

Windows x64、macOS Intel、Ubuntu 22.04 x64 尚未在对应 runner 运行新源码构建和安装包验收。Linux arm64 容器证明 Linux 路径能构建/加载，不证明 x64 汇编、Ubuntu 的最低 ABI、AppImage/DEB 安装或 GUI/GL；macOS 的 `--dir` app 也不是 DMG 干净安装或 Developer ID/公证验收。PCM EOF 不代表 H.264/HEVC/AV1/字幕/网络/硬解的完整矩阵通过。

Release 新增 `verify_only=true` 的手动入口，只生成/核验桌面 CI 产物；服务镜像、镜像 manifest 和 GitHub Release 三道发布边界都拒绝此模式。2026-10-14 用户已授权将修复提交并推送 `dev`，随后执行四目标验证 CI；实际提交与 CI 证据在执行后补录。已公开 `v0.9.0-beta.1` 的标签、镜像和资产不改写，下一次正式分发需要新版本编号；没有合并 `main`。

2026-10-14 用户已确认仅保留软件用到的基础播放能力，不包含开发库中额外的蓝光/DVD 导航、SFTP/SRT 网络协议等依赖。现有常用媒体解码、系统字幕字体/布局、内置网络协议及原生硬解接口保留，但实际多格式/硬解行为仍按上述未验收边界处理。

## 四目标 CI 跟进

修复已提交、推送到 `dev`，工作树干净。提交前复验：构建/发布规划 20 通过；打包 42 通过、0 失败、2 个平台专属跳过；编码与 diff 检查通过。

已使用 `gh workflow run release.yml --ref dev -f verify_only=true` 启动 [run 38514777077](https://github.com/JavdexLabs/Javdex/actions/runs/38514777077)，源码 `f52b03b340bd358cec5cee4ed22a3458df725345`。2026-10-14 05:05 UTC 的实际快照为 metadata 成功、Windows 完整测试正在运行，四个平台打包尚未开始；不记作 CI 验收完成。独立的“Javdex 内置播放四目标 CI 验收”跟进已启用，旧 Beta 发布跟进保持暂停。只在失败、需要决策或全部核验完成时通知，并在完成后补充实际产物和发布任务 skipped 的证据。
