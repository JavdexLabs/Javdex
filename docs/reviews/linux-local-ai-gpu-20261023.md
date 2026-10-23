# Linux 本地 AI GPU 验收（2026-10-23）

## 范围和分发边界

基于 332f78e1，修改设备枚举、平台门控、固定运行库资产、子进程加载路径和状态文案；独立 CPU 引擎、权重、精度及最多一次回退规则不变。没有修改播放模块、驱动或系统设置；Javdex 应用仓库未推送或发布。维护者单独授权后，仅发布了本批运行库。

- Linux x64：NVIDIA 优先 CUDA，Vulkan 支持经原生后端确认的离散/统一内存 GPU；软件 Vulkan 适配器不视为 GPU。
- 核显预算同时受系统可用内存约束，同卡 CUDA/Vulkan 共用预算。
- 固定 llama.cpp b11435 官方 CUDA 12.8、Vulkan、CUDA 依赖包，校验尺寸/SHA-256，再通过既有安全解包和逐文件验证原子安装。
- Whisper b5130 的 Linux CUDA/Vulkan 已从固定源码构建并发布为 [whisper-b5130-linux-gpu-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-linux-gpu-r1)，GitHub 已确认 immutable=true。应用按固定大小和 SHA-256 消费，不跟随远程目录。CUDA 归档 652,513,972 字节，Vulkan 归档 18,120,772 字节；仅按需下载，不打进主 AppImage。
- 现有 Linux AI 基线仍为 glibc 2.38+、GCC 14 C++ 运行库，不能将本次原生构建基线解释为整套应用支持 Ubuntu 22.04。

## 实机验证

Ubuntu 26.04 GNOME Wayland，RTX 4080 / NVIDIA 595.99.02，Intel UHD 770。模型使用固定 Kotoba Q5_0 与 Qwen3-1.7B Q4_K_M；测试使用合成短音频或公开日语问候文本，不读取影片或麦克风。

| 引擎/设备 | 原生执行证据 | 结果 |
| --- | --- | --- |
| Qwen / NVIDIA CUDA | 非零层 offload + 成功生成 | 通过 |
| Qwen / NVIDIA Vulkan | 非零层 offload + 成功生成 | 通过 |
| Qwen / Intel Vulkan | 非零层 offload + 成功生成 | 通过 |
| Kotoba / NVIDIA Vulkan | Vulkan backend + 编解码短推理 | 通过，安装后的候选包复测通过 |
| Kotoba / Intel Vulkan | Vulkan backend + 编解码短推理 | 通过，安装后的候选包复测通过 |
| Kotoba / NVIDIA CUDA | CUDA backend + 编解码短推理 | 通过，安装后的候选包复测通过 |
| 独立 CPU / GPU 缺失故障 | 同一权重成功重试，状态明确 CPU | 文本、语音均通过 |

短样本返回非空结果不代表翻译质量正确：部分 Qwen 测试返回原文。此次验证证明后端执行和回退，不是翻译质量或吞吐量基准。未验证 AMD、其他 NVIDIA 架构、其他发行版及长时间并发压力。

本地模型和设置页测试合计 159 通过，10 项平台条件跳过，0 失败；完整类型检查、修改文件 ESLint、桌面构建通过。独立配置 GUI 和最终 AppImage 实测列出 RTX 4080 CUDA/Vulkan、Intel UHD 770 Vulkan，Kotoba 自动配置验证实际显示 CUDA / RTX 4080 通过；未改动用户现有模型配置。

证据保存在 `out/linux-ai-gpu/`：`text-inference.json`、`recognition-fallback.json`、`cuda-NVIDIA-inference.json`、`vulkan-NVIDIA-inference.json`、`vulkan-Intel-inference.json`、`ui-snapshot.json`、`ui-gpu.png` 及各构建/测试日志。

## 构建与发行

固定来源、构建、打包及发布门禁已迁入 [Javdex Runtime 的 Linux Whisper 目录](https://github.com/JavdexLabs/javdex-runtime/tree/whisper-b5130-linux-gpu-r1/runtimes/whisper/linux)，应用仓库只消费固定发行。构建工具不安装系统依赖，打包检查 ELF 闭包、glibc 上限并保留来源与许可。

构建使用既有 Ubuntu 22.04 编译器/头文件；CUDA 12.8.1 编译工具和 Vulkan shader 工具仅解包到任务目录。CC/CXX 必须指向隔离 sysroot 包装器，显式优先链接该 sysroot 内的 libm/libstdc++；宿主绝对库软链接会导致错误引入较新 glibc。打包检查曾拦截 GLIBC_2.43，修复链接搜索路径后重新链接通过，没有放宽上限。

CUDA 编译架构为 75-real、89-real、75-virtual；只有 RTX 4080 已实测。候选包包含 cudart/cuBLAS/cuBLASLt，不包含驱动或 stub。Vulkan 包需要宿主 Vulkan loader 和厂商 ICD，初始化失败保留 CPU 路径。CUDA 子进程私有 LD_LIBRARY_PATH，不污染 Electron 或系统环境。

## 本地产物与发布证据

- 运行库提交 `2da6811ac0618eb0fc4f0b092cacb79c2c52d2cb`；[CI 39948127326](https://github.com/JavdexLabs/javdex-runtime/actions/runs/39948127326) 的合同与候选附件验证均通过。首次只读 token 无法枚举草稿，随后将必要权限限定到候选核验任务；草稿元数据更新前的尝试被提交身份检查拒绝，更新后完整重跑通过，未放宽检查。
- 本地 AppImage：`dist/linux-ai-gpu-20261023/Javdex-0.9.0-x86_64.AppImage`，SHA-256 `174e4c839a7751f10213e05da0bd9d37d13ab8d3c4401448bf3d68616921ab45`。
- AppImage 与源码构建的 95 个文件逐字节匹配，ANGLE、GPU/CPU 播放运行库库存与输入一致；内置 Agent 运行库检查通过。旧包保留。本轮未重做视频播放画面验收。
- 运行库仓库单独保存配方和源码，不修改 Javdex 已发布的 0.9.0 附件。

公开分发复测：生产安装器从公开 URL 完整下载、校验并安装 Vulkan 包（不是本地 fetch 替身），安装后再次执行 NVIDIA/Intel 推理；CUDA 公开 URL 返回 HTTP 200 且大小匹配，完整 CUDA 附件摘要由 CI 下载核验，本机使用同摘要安装包完成推理。证据：`public-install.json` 与 `public-vulkan-*-inference.json`。
