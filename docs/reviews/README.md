# 发布与评审记录

本目录保留特定源码、日期、平台及检查范围的证据，不是当前开发待办。用户操作见文档站，发布流程见[发布规范](../VERSIONING_AND_RELEASE.md)。

## 0.9.0 正式发布

0.9.0 首次正式发行见[原始发布审计](v0.9.0-release-audit.md)。随后经维护者明确授权，仅一次整套重建替换原始 0.9.0；当前公开版本的源码、运行库、完整 CI 和原资产归档见[Whisper Vulkan 迁移审计](whisper-vulkan-runtime-migration.md)及[发布元数据](whisper-vulkan-runtime-release-evidence.json)。原始审计中的源码和资产身份不代表替换后的版本。

两轮均按用户要求未做独立公开软件产物下载验收，不计为通过；正常源码、构建与发布 CI 仍保留。

## 三平台播放统一

[2026-10-24 播放统一验证](playback-unification-2026-10-24.md)记录共用控制器、隔离宿主、色彩对齐和当前平台验收边界。

## 运行库独立发行

[Linux llama GPU 下载来源统一](runtime-linux-llama-migration-2026-10-24.md)记录剩余三个 Linux x64 原包镜像的独立发行、消费锁定和缓存复用验证。

[本地 AI 依赖留存与 macOS 按需下载](runtime-dependency-retention-2026-10-21.md)记录五个固定发行、原生与发布阶段的独立证据、公开附件检查及消费方验证；不代表 Javdex 0.9.0 安装包已更新。

## Linux 本地验证

[最终 AppImage 自动验收（2026-10-23）](linux-final-appimage-20261023.md)记录合并 Linux AI 运行库与 ANGLE 源码校验修复后的实际包身份、播放矩阵、故障回退及 4K60 性能边界。

[Linux AI GPU 验收](linux-local-ai-gpu-20261023.md)记录 CUDA/Vulkan 按需运行库、真实推理及平台边界。

[Linux 小尺寸纹理导入修复](linux-small-texture-2026-10-22.md)记录独立 EGL／ANGLE／Vulkan 对照与尺寸相关 modifier 选择修复。

[Linux 色彩与高分辨率验收](linux-color-load-2026-10-22.md)记录 CPU HDR 转 SDR 修复、参考色块、设备/缺库隔离及性能验证边界。

[Linux Electron 图片运行库修复](linux-sharp-runtime-2026-10-22.md)记录 12 项已有测试失败的同源崩溃、WASM 后端选择和本地验证边界。

[Linux 解码兼容性检查（2026-10-22）](linux-codec-compatibility-2026-10-22.md)记录当前本地 AppImage 的包内解码能力、真实画面矩阵与硬解缺口，不代表公开发行版或全部 Linux 环境。

## macOS 播放正式化

[CPU 显示和自动回退（2026-10-24）](macos-cpu-fallback-2026-10-24.md)记录独立软件渲染、共用恢复调度，以及本机强制 CPU、禁用加速、图形故障、默认 GPU 和正常关闭检查。

[Canvas2D 正式化](macos-canvas-default-2026-10-23.md)记录正常构建／默认入口迁移、旧显示及候选清理、可恢复归档、安全／性能取舍与本地验证范围。代码采用不等于公开安装包或全部平台已验收。

## 其他历史证据

[Windows HDR 转 SDR 映射修复](windows-hdr-mapping-2026-10-24.md)记录 OpenGL 3.2/4.3 能力差异的复现、静态 BT.2390 策略、独立亮度参考与真实 Canvas/CPU 接管验证；不代表物理 HDR 输出或新安装包验收。

[Windows Canvas 默认播放与最终包验收](windows-canvas-default-2026-10-24.md)记录旧 HWND 显示/控件移除、正常 Canvas 与 CPU 接管、完整本机测试、新 EXE/ZIP 和对应源码身份；打包阶段的未提交快照与后续源码提交身份分别记录，不代表公开发布。

[Arc B390 Canvas 字幕修复（2026-10-24）](windows-arc-b390-canvas-fix-2026-10-24.md)记录纯 Intel 渲染设备上的 ASS／PGS GL 故障、OpenGL core context 修复、生产异常与真实 GPU 子进程退出的 CPU 恢复，以及修复版解压应用的播放矩阵和短时 4K60 复验；不扩大其他设备或正式安装包的验收范围。

[Windows 正式配方重建与体积对比](windows-release-recipe-size-2026-10-24.md)记录本机 Windows x64 新包与已发布 0.9.0 的尺寸差、Sharp 平台过滤、包内 CPU 回退与 UHD 770 混合配置验收，以及对应源码交付身份。

[Windows Canvas 本地接入](windows-canvas-implementation-2026-10-23.md)记录 D3D11 NT 生产端、共用帧传输及后续 Windows 11／RTX 4080 本机检查；当时默认仍为旧 HWND。[Windows CPU 兜底](windows-cpu-fallback-2026-10-24.md)记录软件渲染、故障恢复及取消 1080p 上限；[UHD 770 混合配置](windows-uhd770-hybrid-2026-10-24.md)区分 Intel 的 D3D／解码、NVIDIA 的 WGL 和真实跨设备失败后的 CPU 回退。完整 HDR、纯 Intel 显示、长播及正式安装包仍按各记录保留边界。[Windows 同步 API 调查](windows-canvas-api-2026-10-23.md)保留 Microsoft／Khronos 的句柄、互操作与完成条件。

[macOS 共享视频帧实验验证](macos-shared-texture-2026-10-23.md)保留正式化之前的真实窗口、控制、色彩和新旧短时对照；当时的启用／回滚入口已移出活动代码，性能证据不追溯改写。

- `v0.8.0-*` 与 `v0.9.0-beta.*` 对应各自发行，不能替代后续版本的结果。
- [Agent 迁移基线](agent-platform-baseline-2026-08-20.md)保留旧平台对照，不代表当前配置或固定不变的工具数量。
- [内置播放审查](builtin-playback-2026-10-03.md)、[实施记录](builtin-playback-implementation-2026-10.md)与[观看历史回归](viewing-history-2026-10.md)保留实际发现、修复和未覆盖范围。
- 其余 UI、HTTP 与构建专项记录按各自标题、日期和源码范围理解。删除已落地的准备清单或计划不删除实际发布与失败证据。

[Linux NVDEC / Intel VA-API 验证（2026-10-22）](linux-hardware-decode-2026-10-22.md)记录硬解构建、宿主驱动 ABI 修正及新包验收边界。

[Linux 画面自检与恢复验证（2026-10-22）](linux-display-probe-recovery-2026-10-22.md)记录 XWayland 微小纹理对照、硬解操作、自检与运行中故障恢复及新包验收边界。

- [Linux GPU helper 长播内存调查（2026-10-22）](linux-gpu-memory-2026-10-22.md)
