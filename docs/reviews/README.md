# 发布与评审记录

本目录保留特定源码、日期、平台及检查范围的证据，不是当前开发待办。用户操作见文档站，发布流程见[发布规范](../VERSIONING_AND_RELEASE.md)。

## 0.9.0 正式发布

0.9.0 首次正式发行见[原始发布审计](v0.9.0-release-audit.md)。随后经维护者明确授权，仅一次整套重建替换原始 0.9.0；当前公开版本的源码、运行库、完整 CI 和原资产归档见[Whisper Vulkan 迁移审计](whisper-vulkan-runtime-migration.md)及[发布元数据](whisper-vulkan-runtime-release-evidence.json)。原始审计中的源码和资产身份不代表替换后的版本。

两轮均按用户要求未做独立公开软件产物下载验收，不计为通过；正常源码、构建与发布 CI 仍保留。

## 运行库独立发行

[本地 AI 依赖留存与 macOS 按需下载](runtime-dependency-retention-2026-10-21.md)记录五个固定发行、原生与发布阶段的独立证据、公开附件检查及消费方验证；不代表 Javdex 0.9.0 安装包已更新。

## Linux 本地验证

[Linux 小尺寸纹理导入修复](linux-small-texture-2026-10-22.md)记录独立 EGL／ANGLE／Vulkan 对照与尺寸相关 modifier 选择修复。

[Linux 色彩与高分辨率验收](linux-color-load-2026-10-22.md)记录 CPU HDR 转 SDR 修复、参考色块、设备/缺库隔离及性能验证边界。

[Linux Electron 图片运行库修复](linux-sharp-runtime-2026-10-22.md)记录 12 项已有测试失败的同源崩溃、WASM 后端选择和本地验证边界。

[Linux 解码兼容性检查（2026-10-22）](linux-codec-compatibility-2026-10-22.md)记录当前本地 AppImage 的包内解码能力、真实画面矩阵与硬解缺口，不代表公开发行版或全部 Linux 环境。

## 其他历史证据

- `v0.8.0-*` 与 `v0.9.0-beta.*` 对应各自发行，不能替代后续版本的结果。
- [Agent 迁移基线](agent-platform-baseline-2026-08-20.md)保留旧平台对照，不代表当前配置或固定不变的工具数量。
- [内置播放审查](builtin-playback-2026-10-03.md)、[实施记录](builtin-playback-implementation-2026-10.md)与[观看历史回归](viewing-history-2026-10.md)保留实际发现、修复和未覆盖范围。
- 其余 UI、HTTP 与构建专项记录按各自标题、日期和源码范围理解。删除已落地的准备清单或计划不删除实际发布与失败证据。

[Linux NVDEC / Intel VA-API 验证（2026-10-22）](linux-hardware-decode-2026-10-22.md)记录硬解构建、宿主驱动 ABI 修正及新包验收边界。

[Linux 画面自检与恢复验证（2026-10-22）](linux-display-probe-recovery-2026-10-22.md)记录 XWayland 微小纹理对照、硬解操作、自检与运行中故障恢复及新包验收边界。

- [Linux GPU helper 长播内存调查（2026-10-22）](linux-gpu-memory-2026-10-22.md)
