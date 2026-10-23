# AI 字幕与本地推理合同

桌面内置播放器默认使用 Kotoba 识别日语；Windows x64 另可选择 Qwen3-ASR 1.7B Q8_0，经 Qwen3-ForcedAligner 0.6B Q8_0 对齐后生成字幕。两者继续使用独立的本机文本模型生成中文，音频和字幕不发送到在线模型。文本翻译可以独立选择本地模型或继承已配置的云端模型，两者不是同一用途。操作见[字幕与本地模型指南](../website/src/content/docs/guides/ai-subtitles-and-models.md)。

## 模型与配置

当前目录包含 Kotoba 两档、Qwen3 文本模型四档、HY-MT2 7B 三档及 Qwen3-ASR 1.7B 一档，共十个可选权重文件。Qwen 的固定对齐模型作为配套依赖管理；识别、对齐权重合计约 3.60 GB。下载、导入、精度选择和用途绑定是独立动作；不注册已移除的 Index-Translate。实际文件名、发布者、revision、大小与 SHA-256 以 [modelCatalog.ts](../apps/desktop/src/main/services/localModels/modelCatalog.ts) 及其资产表为准，历史来源见[依据索引](references/README.md)。

新配置分别使用 Kotoba Q5_0 做识别、HY-MT2 7B Q4_K_M 做字幕及文本翻译。已有本地用途保留；0.8.0 已有云端配置的用户继续继承应用默认模型。缺少所选权重或用途错误时明确失败，不暗改家族或切换在线服务。

`local-models.json` 的初始格式为 1，保存加速设置后使用格式 2；有效格式 1 默认自动模式，普通读取和重启不改写。未知或损坏配置保留原文件并阻止推理，显式保存有效设置后恢复。不为未发布开发快照的中间格式增加迁移；资料库 schema、云端模型文档和本地配置各自版本化。

显式选用 Qwen3-ASR 或保存 ForcedAligner 开关后，本地模型配置使用格式 3，保存独立识别用途、模型身份及 `qwenForcedAligner`；缺少开关字段默认开启。读取旧格式不改写，旧 Kotoba 选择与文件保留，切回 Kotoba 不降低配置版本。Qwen3 文本翻译与 Qwen3-ASR 是不同家族，不共享权重或用途绑定。

## 工具安装与设备

CPU、GPU 工具和权重分别校验与维护。基础运行环境是必需项，GPU 支持可选；模型下载不隐式安装 GPU 工具。共享运行库修复、迁移、删除和推理租约互斥，失败不先删除可用旧安装。

Windows x64 NVIDIA 优先 CUDA，其他通过检测的独显使用 Vulkan；macOS 自动模式沿用 Metal，Linux 保留 CPU 路径。模型权重共用，各平台工具独立。Windows Whisper Vulkan 固定从 [Javdex Runtime whisper-b5130-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-r1) 按需下载，主安装包不再内置它；完整旧 b5130 安装可复用。文本 Vulkan 仍由固定 llama.cpp 上游包提供，不能把两套引擎或它们的许可混为一谈。

地址、哈希、目标架构、平铺包文件闭包及接口由 [gpuManifest.ts](../apps/desktop/src/main/services/localModels/gpuManifest.ts)、[runtimeManifest.ts](../apps/desktop/src/main/services/localModels/runtimeManifest.ts) 和安装器验证。macOS 随包识别及音频 CLI 继续按原签名流程分发；模型许可与运行库许可分别保留，见[第三方声明](THIRD_PARTY_NOTICES.md#本地-ai-运行库)。

Qwen 使用 [qwenAsrManifest.ts](../apps/desktop/src/main/services/localModels/qwenAsrManifest.ts) 固定的 audio.cpp Windows x64 CPU／Vulkan 发行与 audio-cpp 原生独立 GGUF。在临时“语音模型2”模块先安装基础环境（audio.cpp、开启对齐时的配套模型、共用音频工具），再下载识别权重；GPU 支持单独准备。原“语音模型”继续管理 Kotoba，两套环境、模型筛选、安装、修复和删除入口相互独立，不随字幕用途切换。已下载的引擎和权重沿用原存储身份，无需搬迁或重新下载；共用音频工具仍被另一模块的模型文件使用时保留。其他平台继续使用原有 Kotoba。Vulkan 原生枚举、共享显存预算与显式设备选择决定实际执行，GPU 运行故障最多回退同权重 CPU；不改用 Kotoba。

“语音模型2”的 ForcedAligner 开关默认开启，立即保存，对新任务生效；Qwen 有运行租约时禁止切换。关闭后不下载、不校验运行依赖中的对齐模型，也不计入显存预算，已存在的文件保留并在组件清单标记停用。识别直接返回当前最多 30 秒片段的完整文本和片段起止时间，不伪造逐词时间；关闭边界上下文提取，避免邻段文本重复。开启后恢复逐词对齐及边界上下文，缺少对齐模型时需补装环境。两种模式的识别缓存身份不同，旧格式及未设置该字段的配置维持开启行为。

配置验证按“模型＋精度”串行执行短推理，不读取影片或麦克风；正式任务优先，代次隔离旧结果。验证时成功不保证之后任务的显存仍可用。设备、驱动、加速组件或初始化失败最多回退一次独立 CPU 工具，保留同一权重和精度；取消、模型损坏和用途错误不作为回退理由。

## 字幕任务与显示

- 从已授权资源提取 16 kHz 单声道音频，不录制系统声音，不改变播放音轨或速度。远程任务复用[播放会话代理](SERVER_MODE_CONTRACT_INVENTORY.md#保留的边界与限制)，每段仍校验资源和资料库身份。
- 30 秒任务区间包含边界上下文，当前位置优先；定位、换音轨、换片和停止取消旧任务，迟到结果不能写入新会话。识别与译文缓存分开，按资源身份、音轨、模型权重及策略版本隔离。
- 原文先就绪时可以先显示；翻译失败保留原文。生成落后不阻止播放，不承诺任意硬件、对白或整片实时。
- Qwen 在带上下文的音频块上执行离线识别与对齐；16 kHz 样本偏移转换为影片时间，按词中点归属任务区间，再按标点、停顿与长度分句。识别缓存包含 ASR、对齐权重、运行库和分句策略身份。日志保留识别与对齐耗时、原文及时间轴，供用户实测；不将运行库启动或适配测试当作日语准确率、时间轴精度或实时速度验收。
- Qwen 返回空白、纯标点或符号且对齐列表为空时，按无可对齐文字处理。audio.cpp 正常退出但无可对齐文字时可能不生成时间戳文件，此时按空列表处理；有文字但缺失对齐、识别文本文件缺失、时间戳损坏或越界仍明确失败。片段失败日志保留阶段、起点、异常原因与运行库退出码，Qwen 原始结果及标准输出也写入有界的本机会话日志；错误详情不进入播放状态事件，远程授权 URL 从异常消息中移除。
- 当前使用共用原生 ASS OSD 叠加层及内存时间轴，不再靠逐块 `sub-reload`。只更新当前显示内容，未来区间追加不能清空暂停画面；底部留白为视频显示高度的 5%。磁盘 ASS 是临时诊断与导出材料，不是原生显示的数据源。
- 手动选轨优先。停止仅在 AI 仍拥有选择时恢复原字幕；换片与销毁清空时间轴。显示错误仅影响字幕，保留重试、缓存和 ASS／SRT 导出，不重开影片。

共用模型存储独立于媒体库，标准 Windows 路径为 `%LOCALAPPDATA%/Javdex/local-ai`。字幕缓存和工作文件位于应用缓存区，不修改源影片，也不随模型目录迁移。准备、配置验证、运行、停止与缓存清理相互协调，不能在清理尚未完成时启动旧缓存任务。

## 平台与验证

运行要求以 [runtimeManifest.ts](../apps/desktop/src/main/services/localModels/runtimeManifest.ts) 为准：Windows x64、macOS 13.3+ arm64／x64，Linux arm64／x64 需要 glibc 2.38+、GCC 14 C++ 运行库和 xz-utils。支持文件管理不代表宿主满足推理条件；拒绝不兼容环境，不静默选择旧引擎。

实现入口为 `services/localModels`、`services/aiSubtitles`、播放共用原生字幕层及对应同名测试。定向测试按目录、安装/回滚、用途、租约、取消、缓存和显示选择，重放命令与历史 CPU/GPU、Windows、macOS/Linux 证据见[实施与验收历史](archive/local-ai/implementation-and-validation-2026-10.md)。

当前固定运行库与整套 0.9.0 的发布 CI、来源及替换边界见[迁移审计](reviews/whisper-vulkan-runtime-migration.md)。历史 GPU 实测只证明当时设备与分发路径，新按需发行的托管 CPU 烟测不冒充物理 GPU 通过；独立公开软件产物验收按用户要求未执行。
