# Linux Electron 图片测试失败修复（2026-10-22）

## 范围与根因

起点为本地基线 `092d5d6`。此前完整测试记录 4219 项、4187 通过、12 失败、20 跳过；同一失败集合在 `257af93` 上亦可复现，非最近播放修复引入。

12 个失败计数来自 11 个文件：`remoteClassificationImage`、`catalogRemoteScrapeWorkflow`、`catalogActressEdit`、`catalogAgentMetadata`、`catalogImageApply`、`catalogImageCrash`、`catalogImageRecovery`、`catalogUploads`、`mediaAssetStore`、`pixelBudget`、`thumbnail`。`catalogImageCrash` 的子用例和文件退出各计一次失败，不能视作 12 个独立业务缺陷。

2×2 PNG 的 Sharp 编码正常，但随后读取 metadata 时：普通 Node 24.22.0 正常，Electron 43.8.0 的 Node 模式 SIGSEGV。GDB 显示在系统 `libgobject-2.0.so.0` 的 `g_object_unref` 调入空地址，同时 Sharp 私有 libvips 含另一份 GLib。与 [Sharp 官方 Electron/Linux 说明](https://sharp.pixelplumbing.com/install/#electron-and-linux) 和 [Electron #46323](https://github.com/electron/electron/issues/46323) 描述的符号冲突一致。

分类：这是 **Linux Electron 原生库组合的运行时兼容性缺陷**，会影响真实图片上传、校验和缩略图，不能通过跳过测试或改用 Node 测试规避。原失败集合修复后未发现额外业务断言缺陷。

另有一个独立的构建环境问题：干净 `npm ci` 首次因宿主缺少 `make` 失败。复用此前已授权的 Ubuntu 22.04 构建目录中的 GNU Make 4.3，只在本次构建 PATH 中加入本地链接后，`npm ci` 和 `setup:desktop` 成功；未安装系统包或更改系统设置。

## 实现与边界

- 显式锁定生产依赖 `@img/sharp-wasm32@0.35.5`，不依赖可选传递依赖碰巧存在。
- 安装时对 Sharp 固定版本 loader 加一个平台分支：Linux Electron 使用官方 WASM；普通 Node（独立服务器）与其他平台沿用上游原生选择。
- 补丁核对原文件 SHA-256、Sharp 和 WASM 版本，可重复运行；上游变化或依赖缺失明确失败。WASM 加载失败不尝试原生 libvips。未使用 `RTLD_DEEPBIND`、全局预加载或修改系统 GLib。
- 测试与打包入口校验补丁。保留打包后的 WASM、JS worker 和 `@emnapi/runtime`，并以实际包内依赖验证五种格式的解码、缩放、编码与像素。
- WASM 的原生文字渲染、瓦片输出限制不涉及现有受支持图片校验和 WebP 缩略图路径。EXIF 旋转、动画首帧、像素上限、取消和解码槽位继续由原业务测试覆盖。

## 验证记录

原始日志存放于工作区外相邻目录 `../evidence/linux-image-failures/`，此前失败对照仍在 `../evidence/linux-baseline-review/`。

- 11 个原失败文件：78 项通过，0 失败；原崩溃阻止后续用例执行，因此新旧总数不同。
- 补丁与后端测试：6 项通过，验证 Linux Electron / Node / macOS / Windows 选择、幂等、变更拒绝、缺依赖不回退及 Node/Electron 真实图片处理。
- 独立服务器 imageCodec 测试：1 项通过，确认 Node 原生 Sharp。
- 干净依赖安装、桌面原生依赖重建、桌面生产构建通过。
- 新 AppImage 在隔离合成资料库启动，主窗口和预加载 API 就绪，截图留存；本次没有操作用户资料库。
- 新包内 Sharp PNG/JPEG/WebP/GIF/AVIF 像素处理通过，确认 WASM，进程未加载原生 libvips。直接给 AppImage 传 Node 参数会与 AppRun 的 Chromium 参数冲突，因此图片命令使用包内 `javdex` 可执行文件及 `resources/app.asar`；GUI 启动使用完整 AppImage。
- GPU / CPU 播放运行库及 ANGLE 190 个文件与旧包摘要逐一一致。保留旧包，本次未重新做人工播放验收，不将二进制一致性表述为新的完整播放验收。
- 简单 1920×1080 单色 JPEG、连续 10 次 320px WebP 缩略图：开发环境原生均值约 7.1ms、WASM 约 9.1ms。小规模合成测试，不代表真实图库吞吐量；冷启动、并行负载和大图性能仍有进一步测量空间。

完整 `npm test` 退出 0：架构边界、Lint、类型检查、打包/播放/备份检查全部通过；最终 Electron 测试 4274 项，4254 通过、0 失败、20 按原条件跳过。总数比旧结果增加 55，是原失败文件不再被崩溃提前中断，并未删除或跳过失败用例。SQLite 原生模块与旧包 SHA-256 相同。

新产物目录 `dist/linux-image-runtime-fix/`，旧 `dist/linux-playback-self-test-wide/` 保留：

| 产物 | SHA-256 |
| --- | --- |
| `Javdex-0.9.0-x86_64.AppImage` | `ac8b48d69ffad675ee0b46bfeb6eb54c30feebee20cf2e6d95f320a924412dd7` |
| `Javdex-0.9.0-amd64.deb` | `10f82cf1b377a1acaa9c606551ee3269eec093116b35291b7a9fab4f967da727` |

deb 仅解包至 `out/linux-image-deb-check/` 运行包内图片检查，未安装到宿主。新 AppImage 可直接运行；正常 GUI 启动继续沿用已有 AppRun 兼容逻辑。

## 未覆盖

本次实际平台为 Linux x64 glibc / GNOME Wayland；macOS、Windows 仅验证选择分支，未运行这些系统的原生安装包。deb 已构建，未安装到宿主。未进行整套服务器 Docker 验收、跨发行版或大规模图库压力测试。没有推送、合并或发布。
