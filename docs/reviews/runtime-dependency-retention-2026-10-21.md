# 本地 AI 依赖留存与 macOS 按需下载

2026-10-21（Asia/Singapore）。维护者授权实施 FFmpeg/VAD 留存、Whisper/llama/CUDA 镜像，以及 macOS AI 与播放器归档；macOS AI 工具改为按需下载，不再随主应用交付。本次没有替换 Javdex 0.9.0 安装包、标签或镜像。

## 固定发行

以下五个 Javdex Runtime 发行已公开，GitHub API 均确认 `draft=false`、`immutable=true`。共 37 个有效载荷附件，另有每发行的 `release.json` 和 `SHA256SUMS.txt`。附件集合、大小及 GitHub SHA-256 均已核对；37 个有效载荷的公开 URL 均返回 HTTP 200，Content-Length 与固定大小一致。

| 发行 | 范围 |
| --- | --- |
| [ffmpeg-8.1.3-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/ffmpeg-8.1.3-r1) | Windows x64、Linux x64/arm64、macOS x64/arm64 的自建最小音频提取工具及逐目标完整源码/配方 |
| [whisper-b5130-r2](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-r2) | Windows/Linux CPU 和 Windows CUDA 原包镜像，以及 macOS 两架构原生构建、源码和许可材料 |
| [llama-b11435-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/llama-b11435-r1) | 五目标 CPU、Windows CUDA/Vulkan 与 CUDA 依赖原包、上游源码和 CUDA 12.4 条款 |
| [silero-v6.2-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/silero-v6.2-r1) | 固定 VAD 文件和 MIT 许可；其他模型权重没有迁移 |
| [playback-0.41.0-9.0.2-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/playback-0.41.0-9.0.2-r1) | 从原 Javdex 0.9.0 安装包提取的四目标播放器运行库与原始对应源码总包 |

既有 `whisper-b5130-r1` Vulkan 发行保持不变。运行库独立发布，不跟随 `latest`；没有自动删除 Release 的任务。Actions 中间产物的 30 天保留期不影响公开附件。

## 来源与发布门禁

原生构建提交为 `82d60bdf45c78141ea787f429ddc24fdd96298cc`，[构建 run 39618483098](https://github.com/JavdexLabs/javdex-runtime/actions/runs/39618483098) 的合同、镜像、两个 macOS、三个 FFmpeg 和四个播放器任务均成功。该 run 仅在 Draft 发布阶段因 HTTP 错误响应的字符串状态码比较而失败，不能称为整个 run 成功。

修复后的发布提交为 `3d550506bbb4326ecdac769e3921a5ab8fb1f569`，[发布 run 39621089417](https://github.com/JavdexLabs/javdex-runtime/actions/runs/39621089417) 整体成功。恢复路径核对全部原生任务的真实成功结果，并以 git diff 确认来源锁、许可输入及所有原生构建/归档脚本均未变化；取得原附件后重新计算大小和摘要，再准备 Draft。清单分别记录原构建与本次发布的提交、run 和真实结果，不把原发布失败或跳过记为原生通过。

维护者身份的最终步骤再次核对 CI、原构建证据、五个 Draft 的来源、附件身份、不可变设置和标签，再公开；公开后没有追加或替换附件。Windows FFmpeg 包保留实际 MinGW/GCC 运行库许可与包版本，macOS 记录 clang/CMake/SDK/系统版本。完整 FFmpeg 官方源码在运行库仓库及对应源码附件留存，不再依赖源码站临时可用性。

## 消费方与验证

`localModels/runtimeDistributions.json` 固定 20 个本次实际发布的工具/VAD 附件，另保留原 Vulkan pin。镜像保留原始字节、SHA-256 和下载缓存文件名，已有有效 Whisper/llama/CUDA 安装继续复用。新 FFmpeg 使用独立的 `8.1.3-r1` 目录；旧 macOS b5130 Whisper 仅对已审查的 r2 下载身份允许完整逐文件验证后的复用。

主应用移除 macOS AI 的本机构建、资源拷贝及 CLI 签名钩子；开发、启动、预览和生产构建不再准备这类随包资源。所有平台沿用统一的下载、续传、校验和原子安装。打包同时拒绝残留的 `Resources/ai-runtime` 目录，保留外层应用签名流程。

本轮检查：

- 本地模型与字幕测试：148 通过、17 按既有平台条件跳过、0 失败。
- 打包回归：50 通过、3 按平台条件跳过、0 失败。
- Node/Web/Browser 类型检查、修改模块 lint、桌面生产构建及桌面架构检查通过。
- 文档站离线构建与检查通过：28 页、2,045 个本地引用。
- Linux x64 在隔离临时目录从公开 Release 实际下载并安装 FFmpeg/VAD，校验成功；真实 FFprobe HTTP 探测及 FFmpeg HTTP 定位/音频提取通过，输出为单声道 16 kHz PCM WAV。

新构建的原生 CLI/音频转换、macOS 固定 Kotoba/VAD CPU 烟测和 ad-hoc CLI 签名检查由对应 runner 执行。原包镜像只增加字节身份检查，历史播放器只增加归档证据；本次不宣称新的真实 GPU/Metal 推理、播放器 GUI、Developer ID 公证或主应用新安装包验收。四目标播放器归档对应原 0.9.0，不能替代当前 Wayland 工作区的运行库验收。
