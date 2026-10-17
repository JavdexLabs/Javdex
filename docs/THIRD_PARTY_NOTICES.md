# 第三方说明

本文记录 Javdex 功能直接对接或随应用分发、且需要单独披露的第三方项目。各项目名称和商标归其权利人所有；列出项目不表示存在从属、合作或背书关系。

## 项目许可与历史声明

当前 Javdex 源码整体采用 GPL-3.0-or-later，完整许可见 [LICENSE](../LICENSE)，项目授权和无保证声明见 [NOTICE](../NOTICE)。此前按 MIT 发布的代码保留原版权及许可声明，原文见 [Javdex MIT 声明](../LICENSES/Javdex-MIT.txt)；既有版本的授权不追溯改写。

第三方代码、模型与图标仍按各自许可分发，不因 Javdex 采用 GPL 而改写其声明。官网图标声明保留在 `website/assets/LUCIDE-LICENSE.txt`、`website/assets/platforms/LICENSE.txt`，随桌面使用的模型声明保留在 `apps/desktop/src/renderer/public/models/LICENSE-APACHE-2.0.txt`。

## 内置播放运行库

内置播放使用固定源码构建的 mpv 0.41.0 与 FFmpeg 9.0.2；[源码清单](../build/playback-sources.json) 将二者记录为 GPL-3.0-or-later，[构建配方](../scripts/playback-source-build.mjs) 显式启用 mpv GPL 及 FFmpeg GPL/version3 选项，不是本地 AI 工具所用的 LGPL FFmpeg 构建。实际输入、包内材料与验证合同见 [开发指南](DEVELOPMENT.md#固定源码构建与分发验证)。上游许可说明见 [mpv Copyright](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright) 与 [FFmpeg 官方说明](https://ffmpeg.org/legal.html)。

固定源码清单单独保留 FreeType、HarfBuzz、FriBidi、libass、libunibreak、libplacebo/fast_float/Vulkan headers、dav1d、zlib、Lua 及平台 TLS/字符转换依赖的版本、原始来源、摘要和许可文件。依赖静态嵌入 libmpv 时，原许可全文合并展示但不改写各项目许可；Node headers、Windows node-gyp 钩子及适用的 GCC runtime exception 声明一并保留。当前 SDK 固定为 Electron 43.4.1／Node headers 24.18.1；`build.json` 记录实际来源、构建选项、工具链与配方，`runtime.json` 绑定 `mpv` 和 `javdex-native` 两个二进制所有者。

应用 Resources 的 `native-playback/` 包含二进制、`licenses/libmpv.txt`、`licenses/javdex.txt`、`SOURCE-ACCESS.txt` 与分发清单。完整对应源码和配方独立交付为一个 `Javdex-Playback-Sources-<version>.tar.gz`，纳入 Release 的 `SHA256SUMS.txt`，不装入应用。总包按内容摘要去重四目标材料，保留原始上游归档、Javdex 原生源码、SDK headers、许可、构建和打包工具，以及六个最终安装产物的来源绑定；附 `restore.mjs`，可分别恢复 Windows x64、macOS x64／arm64、Linux x64 的原始材料。四份单平台源码包及 `.runtime.json`／`.installers.json` 回执保留为 CI 产物，不作为额外 Release 附件。具体恢复方法见 [开发指南](DEVELOPMENT.md#固定源码构建与分发验证)。

[历史源码与产物核验](reviews/v0.9.0-beta.3-release-audit.md) 保留公开总源码包、四目标恢复和六个安装产物来源核对的历史证据；0.9.0 当前准备状态见 [发布准备](reviews/v0.9.0-readiness.md)，本文不宣称稳定版已经发布或重新完成分发验收。源码材料、签名与摘要校验不能替代逐版本许可复核。macOS 系统框架与 Linux 显示/字体/音频/GPU driver ABI 仍由宿主提供，不能据此省略解码依赖的源码材料。

## 容器更新管理器

容器更新管理器使用 node-semver 进行正式／预发布版本比较、node-tar 处理完整发行归档、Zod 校验更新合同。依赖采用各自上游许可，不改为 Javdex 项目许可；构建时从锁定安装复制其许可原文到管理入口的 `LICENSES/`，随镜像放在 `/opt/javdex-manager/LICENSES/`。当前锁定版本的 node-semver 为 ISC、node-tar 为 BlueOak-1.0.0、Zod 为 MIT；具体版权与授权以该目录原文为准。

## 云端服务品牌图标

AI 服务设置使用 LM Studio、DeepSeek、MiniMax、Ollama、OpenAI、OpenRouter、Moonshot、智谱、SiliconFlow 与 Anthropic 官网提供的品牌图标，随应用本地打包。原始来源和处理方式见 [图标来源清单](../apps/desktop/src/renderer/src/assets/providers/README.md)。图标及商标归各权利人所有，仅用于识别相应服务，不适用 Javdex 源码许可，也不表示合作或背书。

## node-gyp 延迟加载钩子

Windows 原生播放 addon 的 MSVC 构建复用已安装的 [node-gyp](https://github.com/nodejs/node-gyp) 中 `src/win_delay_load_hook.cc`，将 Electron 导出的 Node 符号解析到当前可执行文件；构建不修改上游源码。该钩子采用 MIT，原声明保留于 [node-gyp MIT 声明](../LICENSES/node-gyp-MIT.txt)，随项目许可材料打包。固定源码构建将实际使用的钩子、node-gyp 原许可、依赖锁文件和构建配方复制进 `sources/javdex-native.tar.gz`，随上述总源码包交付，并将许可合并到包内 `licenses/javdex.txt`。历史 CLANG64 本地构建使用仓库自身的宿主重定向钩子，具体构建路径见开发指南。

## 本地 AI 运行库

- whisper.cpp b5130 与 llama.cpp b11435：MIT；固定下载地址、大小、SHA-256 见 [资产清单](../apps/desktop/src/main/services/localModels/runtimeManifest.ts)。各系统的资产独立，不能用 Windows ZIP 代替 POSIX 运行库。安装保留上游许可文件，模型许可与运行库许可分别记录。
- macOS 随应用分发固定源码构建的 whisper-cli、FFmpeg／ffprobe；来源与摘要见 [源码清单](../scripts/ai-runtime-sources.json)，构建步骤见 [构建器](../scripts/ai-runtime-build.mjs)。FFmpeg 8.1.3 为 LGPL-2.1-or-later 静态构建，不启用 GPL／nonfree／自动探测外部编解码依赖；bundle 内附 `COPYING.LGPLv2.1`、`SOURCE.txt` 和完整构建来源清单。
- Windows／Linux 的 FFmpeg 按需下载 BtbN 固定日期 LGPL shared 发布资产，保留包中的许可文件，不能把 macOS 自建工具的 LGPL 版本用于判断这些上游包的全部间接依赖许可。
- Windows 可选 CUDA 资产固定于同一 whisper／llama 发布版本，另含 NVIDIA CUDA Runtime／cuBLAS，不能以引擎的 MIT 许可覆盖这些 NVIDIA 组件；它们按需从上游下载，适用 [NVIDIA CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/index.html)。GPU 下载地址、大小及 SHA-256 见 `localModels/gpuManifest.ts`。
- Windows 随包提供固定源码构建的 Vulkan whisper：引擎 MIT、Vulkan headers／loader Apache-2.0，bundle 内附许可、来源和完整文件摘要；构建器与固定开发材料见 `scripts/windows-vulkan-runtime.mjs`、`scripts/windows-vulkan-build-tools.json`。shaderc、glslang、SPIR-V 与 GCC 工具 DLL 只用于构建，不随应用分发。GPU 驱动由系统提供，不作为运行库打包。

分发 macOS 工具时应一并提供对应 Javdex 源码版本中的构建器、固定源码清单及可获得的完整对应源码，不以二进制哈希代替许可义务。源资料和构建来源不是正式分发验收证明；播放器 libmpv 的许可／来源闭包仍独立检查。

## MetaTube

连接与使用步骤见 [MetaTube 配置指南](METATUBE_SETUP.md)。

- 上游项目：[`metatube-community/metatube-sdk-go`](https://github.com/metatube-community/metatube-sdk-go)
- 许可：Apache License 2.0
- Javdex 集成：内置影片插件仅作为用户自建 `metatube-server` 的 REST 客户端。Javdex 不嵌入、下载、启动或分发 MetaTube Go 服务端、Provider 模块或数据库。
- 数据边界：用户配置服务端后，Javdex 才会向该地址发送影片番号并读取影片元数据。Token 保存在 Javdex 主进程的独立凭证文件中；MetaTube 原生 `/v1/images` 路由为公开路由，因此生成的封面和样张 URL 不携带 Token。
- 字段约定：MetaTube 的 `actors` 全部按女性演员导入；`label` 近似映射为 Javdex 的发行方。该语义差异同时在插件说明与设置界面披露。

Javdex 中的 MetaTube 适配代码为本项目实现；上述说明用于标明所对接 API、上游来源和许可边界。
