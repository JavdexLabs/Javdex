# Linux llama GPU 下载来源统一（2026-10-24）

维护者授权将剩余三个 Linux x64 按需运行库统一接入 Javdex Runtime，并在本机完成 GitHub CLI 登录以发布所需附件。Javdex 应用修改保留在工作区，没有发布或替换应用安装包。

## 固定发行

新发行 [llama-b11435-linux-gpu-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/llama-b11435-linux-gpu-r1) 已公开，GitHub API 确认 `draft=false`、`immutable=true`。原 `llama-b11435-r1` 不可追加，本次使用独立身份，未覆盖旧标签或附件。

运行库提交为 `04d036632b5fb7a49f4e3ba1f6dd138fec482650`；[CI 40072175763](https://github.com/JavdexLabs/javdex-runtime/actions/runs/40072175763) 的合同、镜像和 Draft 准备任务成功，既有 macOS、FFmpeg、播放器任务按范围跳过，不计为本次原生验收。维护者身份的最终脚本核对成功 CI、固定提交、精确附件集合、大小、GitHub SHA-256 和仓库不可变设置后公开。

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `llama-b11435-bin-ubuntu-vulkan-x64.tar.gz` | 31,636,156 | `e8a9c44c8212c5e7ff1186864080ae49283131c60e7c07753a296faccd3a0324` |
| `llama-b11435-bin-ubuntu-cuda-12.8-x64.tar.gz` | 171,652,084 | `251ad225b60da6eab0591567b639dda5e405662589bdaee7bd54a159b8d87fa9` |
| `cudart-llama-b11435-bin-ubuntu-cuda-12.8-x64.tar.gz` | 594,377,810 | `c14f9b18c0e19623d2fb763e47ca6cd0e409206d462176af8ac0665331b64f74` |

另附固定 llama.cpp 源码提交 `43fe9c64281ef735046adc025e9e7559a1f659a5` 的完整归档、NVIDIA CUDA 12.8.1 条款、`release.json` 与 `SHA256SUMS.txt`。CI 完整下载全部输入并校验原始字节，不重新打包或宣称新的原生/GPU 推理结果。

## 消费方

`runtimeDistributions.json` 的三个下载 URL 和发行身份改为上述独立发行，并记录提交与 run。大小、SHA-256、缓存文件名、解压前缀、引擎版本及安装目录保持原身份；模型权重与设备策略不变。

清单测试移除 Linux GPU 上游 URL 例外，统一要求全部工具及 VAD 指向 Javdex Runtime，且 URL 与固定标签、附件名一致。新增测试锁定三个原包的大小、摘要、解压前缀和续传缓存身份；安装器回归确认已有 Linux CUDA/Vulkan 文本引擎及 CUDA 依赖不下载、不改写安装标识。

运行库 Linux CI 的 17 项测试全部通过，零失败、零跳过。本轮本地清单、安装器、组件、准备计划与存储测试共 38 项通过，零失败、零跳过；修改测试文件 ESLint 和定向 diff 检查通过。完整 Node 类型检查被当前工作区播放模块的类型错误阻断，包括 `PlaybackOcclusion`、`NativePlaybackState.actions` 及播放桥接口不一致；未将该检查记为通过，也未修改并行中的播放代码。

公开后逐项核对 GitHub 附件大小与 SHA-256；三个下载 URL 的 HEAD 均返回 HTTP 200，Content-Length 与锁定值一致。另从公开 URL 完整下载 Vulkan 归档并重新计算 SHA-256，结果匹配。两个较大的 CUDA 附件由 CI 完整下载上游原包并校验，公开附件身份由 GitHub 摘要确认；未将 HEAD 检查记为客户端完整下载。Vulkan 下载样本保留在忽略目录 `out/linux-llama-public/`。

本轮不包含 Linux GPU 真实推理、GUI 或新应用安装包验收；历史推理证据仍见 [Linux 本地 AI GPU 验收](linux-local-ai-gpu-20261023.md)。

0.9.1-beta.1 发布检视补记：工作区原先只保留了清单测试和文档，三个实际 URL 仍指向上游；现已补齐发行身份、下载 URL 和来源记录，再执行消费方回归。此前的类型错误已由播放统一工作修复，发布验证以新 CI 为准。
