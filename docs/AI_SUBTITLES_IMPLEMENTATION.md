# AI 字幕与本地推理合同

桌面内置播放器默认使用 Kotoba 识别日语；Windows x64 也可选择 Qwen3-ASR 1.7B Q8_0，默认搭配 ForcedAligner 0.6B Q8_0 对齐时间轴，再用本机文本模型生成中文；音频和字幕不发送到在线模型。文本翻译可以独立选择本地模型或继承已配置的云端模型，两者不是同一用途。操作见[本地模型管理](../website/src/content/docs/guide/local-models.md)与[字幕指南](../website/src/content/docs/guide/subtitles.md)。

## 模型与配置

当前目录包含 Kotoba 两档、Qwen3 四档及 HY-MT2 7B 三档，加上 Qwen3-ASR 一档，共十个可选识别／翻译权重文件；Qwen 的对齐模型另作为配套依赖管理。下载、导入、精度选择和用途绑定是独立动作；不注册已移除的 Index-Translate。实际文件名、发布者、revision、大小与 SHA-256 以 [modelCatalog.ts](../apps/desktop/src/main/services/localModels/modelCatalog.ts) 及其资产表为准，历史来源见[依据索引](references/README.md)。

新配置分别使用 Kotoba Q5_0 做识别、HY-MT2 7B Q4_K_M 做字幕及文本翻译。已有本地用途保留；0.8.0 已有云端配置的用户继续继承应用默认模型。缺少所选权重或用途错误时明确失败，不暗改家族或切换在线服务。

`local-models.json` 的初始格式为 1，保存加速设置后使用格式 2；有效格式 1 默认自动模式，普通读取和重启不改写。未知或损坏配置保留原文件并阻止推理，显式保存有效设置后恢复。不为未发布开发快照的中间格式增加迁移；资料库 schema、云端模型文档和本地配置各自版本化。

## Qwen 语音识别

“语音模型”统一列出 Kotoba 和 Qwen3-ASR，各自管理引擎、权重与配置验证，共用 FFmpeg 和字幕流水线；用途页显式选择识别模型，下载不切换用途。Qwen 使用独立 audio.cpp CLI，不需要 Python，也不通过 Whisper 执行。当前仅提供 Windows x64 CPU／Vulkan 运行库，其他平台保留文件管理，不能启动 Qwen 推理。既有 Kotoba 默认与文件保留。

Qwen 引擎固定为 `v0.9.2-drama3-base-small`，CPU／Vulkan 上游发行记录集中在 `runtimeDistributions.json` 的 `optionalAssets`，由现有安装器按大小和 SHA-256 校验、原子安装；本次没有发布新的 Javdex Runtime 发行。两份权重使用固定 revision 的 audio-cpp 独立 GGUF，合计约 3.60 GB，不与 Qwen 文本翻译权重共用。只有显式准备该引擎才下载依赖。

ForcedAligner 默认开启，开关位于 Qwen 模型内；立即保存，对新任务生效，运行租约期间禁止切换。关闭后不要求对齐权重、不计入显存预算，已有文件保留；关闭上下文提取，整段文字使用最长 30 秒任务区间，不能逐句跟随对白。切换开关、ASR／对齐权重和分句策略均隔离识别缓存。

显式选择 Qwen 或保存对齐开关时，本地配置写入格式 3；有效格式 1／2 读取时保持 Kotoba 配置及原文件，显式保存才更新。没有为旧的未发布实验模块增加迁移。

对齐开启时按 16 kHz 样本偏移还原影片时间，以词中点归属片段，再按标点、停顿和长度分句；字母数字经过 Unicode 规范化后必须覆盖识别全文，缺失文字、损坏时间戳和无时长文字明确失败。空白／纯标点且没有对齐文件属于正常空片段，不阻断后续识别。失败日志记录阶段、片段、工具退出码及有界输出。

Qwen 采用 audio.cpp 原生 Vulkan 枚举，允许具有原生证据的硬件核显，排除软件／虚拟适配器；仅在该引擎枚举到所选设备且内存预算足够时使用 GPU。独立 CPU 工具在明确 GPU 故障时以同权重重试一次，随后片段沿用 CPU，不切换 Kotoba。仅由 audio.cpp 发现的核显标记为该引擎专用，不能把其设备序号传给 Whisper／llama。

本次移植仅进行类型检查、构建和定向回归；日语识别质量、整片时间轴、各显卡速度与可见界面由用户实测，不沿用历史短片结果作为本次实机验收。

## 工具安装与设备

CPU、GPU 工具和权重分别校验与维护。基础运行环境是必需项，GPU 支持可选；模型下载不隐式安装 GPU 工具。共享运行库修复、迁移、删除和推理租约互斥，失败不先删除可用旧安装。

Windows x64 NVIDIA 优先 CUDA，其他通过检测的独显使用 Vulkan；macOS 自动模式沿用 Metal。Linux x64 支持 NVIDIA CUDA 与经原生后端确认的 Vulkan 显卡（含硬件核显，排除软件渲染器），保留独立 CPU 回退；Linux arm64 暂保留 CPU。模型权重共用，各平台工具独立。Windows Whisper Vulkan 固定从 [Javdex Runtime whisper-b5130-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-r1) 按需下载，主安装包不再内置它；完整旧 b5130 安装可复用。文本 Vulkan 仍由固定 llama.cpp 上游包提供，不能把两套引擎或它们的许可混为一谈。

地址、哈希、目标架构、平铺包文件闭包及接口由 [gpuManifest.ts](../apps/desktop/src/main/services/localModels/gpuManifest.ts)、[runtimeManifest.ts](../apps/desktop/src/main/services/localModels/runtimeManifest.ts) 和安装器验证。macOS 随包识别及音频 CLI 继续按原签名流程分发；模型许可与运行库许可分别保留，见[第三方声明](THIRD_PARTY_NOTICES.md#本地-ai-运行库)。

配置验证按“模型＋精度”串行执行短推理，不读取影片或麦克风；正式任务优先，代次隔离旧结果。验证时成功不保证之后任务的显存仍可用。设备、驱动、加速组件或初始化失败最多回退一次独立 CPU 工具，保留同一权重和精度；取消、模型损坏和用途错误不作为回退理由。

## 字幕任务与显示

- 从已授权资源提取 16 kHz 单声道音频，不录制系统声音，不改变播放音轨或速度。远程任务复用[播放会话代理](SERVER_MODE_CONTRACT_INVENTORY.md#保留的边界与限制)，每段仍校验资源和资料库身份。
- 30 秒任务区间包含边界上下文，当前位置优先；定位、换音轨、换片和停止取消旧任务，迟到结果不能写入新会话。识别与译文缓存分开，按资源身份、音轨、模型权重及策略版本隔离。
- 原文先就绪时可以先显示；翻译失败保留原文。生成落后不阻止播放，不承诺任意硬件、对白或整片实时。
- 当前使用共用原生 ASS OSD 叠加层及内存时间轴，不再靠逐块 `sub-reload`。只更新当前显示内容，未来区间追加不能清空暂停画面；底部留白为视频显示高度的 5%。磁盘 ASS 是临时诊断与导出材料，不是原生显示的数据源。
- 手动选轨优先。停止仅在 AI 仍拥有选择时恢复原字幕；换片与销毁清空时间轴。显示错误仅影响字幕，保留重试、缓存和 ASS／SRT 导出，不重开影片。

共用模型存储独立于媒体库，标准 Windows 路径为 `%LOCALAPPDATA%/Javdex/local-ai`。字幕缓存和工作文件位于应用缓存区，不修改源影片，也不随模型目录迁移。准备、配置验证、运行、停止与缓存清理相互协调，不能在清理尚未完成时启动旧缓存任务。

## 平台与验证

运行要求以 [runtimeManifest.ts](../apps/desktop/src/main/services/localModels/runtimeManifest.ts) 为准：Windows x64、macOS 13.3+ arm64／x64，Linux arm64／x64 需要 glibc 2.38+、GCC 14 C++ 运行库。支持文件管理不代表宿主满足推理条件；拒绝不兼容环境，不静默选择旧引擎。

实现入口为 `services/localModels`、`services/aiSubtitles`、播放共用原生字幕层及对应同名测试。定向测试按目录、安装/回滚、用途、租约、取消、缓存和显示选择，重放命令与历史 CPU/GPU、Windows、macOS/Linux 证据见[实施与验收历史](archive/local-ai/implementation-and-validation-2026-10.md)。

当前固定运行库与整套 0.9.0 的发布 CI、来源及替换边界见[迁移审计](reviews/whisper-vulkan-runtime-migration.md)。历史 GPU 实测只证明当时设备与分发路径，新按需发行的托管 CPU 烟测不冒充物理 GPU 通过；独立公开软件产物验收按用户要求未执行。

## 固定依赖分发

已发布的平台语音、翻译、音频提取工具及小型 VAD 辅助模型由 Javdex Runtime 固定发行供应，客户端仍在源码中锁定附件大小和 SHA-256，不从远程清单自动换库。macOS AI 工具不再随应用打包；首次准备能力包含真实网络下载计划。原生构建、签名和对应源码移至运行库仓库，模型权重、用途、设备策略和 CPU 回退流程不变。有效旧 macOS b5130 Whisper 经完整逐文件验证后复用，损坏时下载固定发行修复。

Linux 新增文本 GPU 包暂固定使用 llama.cpp b11435 官方 Linux 发行（CUDA 12.8、Vulkan 和 CUDA 运行依赖），大小与 SHA-256 来自对应发行附件。Whisper Linux CUDA/Vulkan 固定使用已发布的 `whisper-b5130-linux-gpu-r1`，两种后端均通过本机实际推理与安装验证。构建配方与验收见 [Linux AI GPU 验收](reviews/linux-local-ai-gpu-20261023.md)。
