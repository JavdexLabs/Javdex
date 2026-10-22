# Linux 最终包解码兼容性检查（2026-10-22）

后续 NVDEC / Intel VA-API 补齐结果见 [硬解验证记录](linux-hardware-decode-2026-10-22.md)。以下保留改动前的历史证据。

本轮落实 [改进计划](../LINUX_COMPATIBLE_PLAYBACK.md#compatibility-improvement-plan-2026-10-22) 第一步：建立真实包能力清单、可重跑的编码测试和明确的待验证矩阵。没有修改播放实现、安装系统包或更换驱动，也没有重建或替换旧包。

## 对象和证据

- 应用源码基线：`b8de3bc`，附本地 Linux 非目标二进制过滤改动。
- 实测包：`dist/linux-x64-pruned/Javdex-0.9.0-x86_64.AppImage`。
- SHA-256：`e8a939f408b9a8f756926e6d015ab0d22be5f33a3fcac485ac29847989f38438`。
- 原始能力清单、样片摘要/元数据、环境、逐秒状态、截图和日志：`out/linux-codec-acceptance/`。该目录为本地忽略产物，不是随仓库发布的证据附件；迁移机器时须另行保存。
- Intel UHD 770：`renderD128`、PCI `8086:4680`、i915；NVIDIA RTX 4080：`renderD129`、PCI `10de:2704`、nvidia。主桌面为 GNOME Wayland，X11 测试通过 XWayland。
- GUI runner 使用临时测试资料库；没有访问或修改用户影片。采样末尾才做像素读回，截图另行目视复核；没有把帧计数当成画面正常的唯一证据。

## 最终包能力清单

直接分别加载包内 GPU/CPU libmpv 查询，而非依赖宿主 ffmpeg 或只看构建参数：

| 能力 | GPU runtime | CPU runtime |
| --- | --- | --- |
| libmpv / FFmpeg | 0.41.0 / 9.0.2 | 0.41.0 / 9.0.2 |
| H.264 / HEVC 软件解码器 | 存在 | 存在 |
| AV1 解码器 | libdav1d、原生 av1 | libdav1d、原生 av1 |
| 编译入的硬件设备 API | 仅 VA-API | 无，符合隔离目标 |
| CUDA/NVDEC 硬解 | 当前包未编译入 | 不适用 |

GPU helper 的 `auto-copy` 与 GPU 显示属于不同阶段。当前 NVIDIA 显示路径可以成功，但不代表 NVIDIA 解码硬件被使用。

## 本机硬解探测

对同一包内 GPU libmpv 另做 `vo=null`、`ao=null`、`hwdec=vaapi-copy` 的有界 H.264 解码探测，日志保存在 `intel-vaapi-probe.log`、`nvidia-vaapi-probe.log`。这是解码诊断，不算 GUI 验收。

Intel 日志尝试加载 `/usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so` 与 `i965_drv_video.so`，均失败；检查对应文件不存在。`hwdec-current=no`，软件解码仍推进。未安装驱动，也不能据此判断其他已正确配置 Intel 驱动的电脑不能硬解。

NVIDIA 当前包没有 NVDEC；VA-API 也需要另行满足驱动条件。后续应优先评估显式启用 NVDEC 的构建及实机验证，避免将“GPU 模式”宣传为“硬解已启用”。

## 本轮样片范围

自生成 testsrc2 彩条、运动图案、计时及 880 Hz 音轨，1920×1080、30 fps：

- H.264 Constrained Baseline / yuv420p / AAC，70 秒；各模式连续检查 65 秒。
- HEVC Main10 / yuv420p10le / AAC，12 秒；各模式检查 8 秒。
- AV1 Main / yuv420p / Opus，12 秒；各模式检查 8 秒。

HEVC Main10 此处是 SDR 10-bit 样片，**不是 HDR 验收**。H.264 Baseline 不涵盖 High Profile/B 帧。AAC/Opus 的输出状态不能替代听音或同步验收。

工具来自任务目录内解压的 `imageio-ffmpeg 0.6.0` manylinux wheel，下载时对照 PyPI 元数据校验 SHA-256，URL/摘要存于 `tools/source.json`；不安装到宿主或应用包。重跑可用 `scripts/linux-codec-fixtures.mjs` 指定现有 FFmpeg。

## 实际播放结果

| 实测路径 | H.264（65 秒） | HEVC Main10（8 秒） | AV1（8 秒） |
| --- | --- | --- | --- |
| GNOME Wayland GPU | 通过 | 通过 | 通过 |
| XWayland GPU | 通过 | 通过 | 通过 |
| Wayland CPU | 通过 | 通过 | 通过 |

九项均通过播放状态、实际编码/尺寸/模式、时间推进及末尾彩色像素检查，并由 Agent 查看实际应用截图确认图案与计时可见。九项最后采样的 `droppedFrames` 均为 0，`hardwareDecoder` 均为 `no`。这不是物理屏幕零丢帧或硬解通过的证明。GPU 测试使用当前 Chromium 的 NVIDIA 显示路径；CPU 测试没有自动回退冒充 GPU 成功。

本轮完成初始能力清单和本机九格矩阵；NVDEC 缺失和 Intel VA-API 驱动缺失均明确记录，未以改驱动或修改系统方式掩盖。其他机器矩阵、人工听音、HDR 和 4K 性能仍待验证。本轮没有新增产品行为，未重打包。

## 待扩展矩阵

| 维度 | 当前证据 | 下一批验收 |
| --- | --- | --- |
| NVIDIA / Intel / AMD | 当前双显卡主机；硬解未成功 | NVDEC 构建、正确驱动下 Intel VA-API、AMD 实机 |
| Wayland / X11 | GNOME Wayland、XWayland | KDE Wayland、原生 Xorg |
| 编码 | 上述三种 1080p30 SDR 样片 | H.264 High/B 帧、HEVC 8-bit、AV1 10-bit、坏帧和异常封装 |
| 分辨率/帧率 | 1080p30 | 4K/60、高码率、23.976/25/29.97/50/59.94、VFR |
| 音频/字幕 | 本轮 AAC/Opus 输出状态；此前 SRT 操作回归 | 人工音画同步、多声道、HDMI/蓝牙、ASS 字体附件、PGS |
| 长期稳定性 | H.264 65 秒；另两种短测 | 长片、休眠恢复、跨屏、音频热切换、网络中断 |
| 分发环境 | 当前 AppImage | 干净发行版、deb 安装、其他 glibc 环境 |

“当前机器实测通过”“包内编译支持”“未验证”“已知缺失”必须分别记录，不把整个矩阵标为完成。

## 可重跑入口

- `scripts/linux-playback-capabilities.py`：每次只加载一个包内 libmpv，输出所有解码器和编译硬件 API，不创建播放窗口。
- `scripts/linux-codec-fixtures.mjs`：显式指定测试 FFmpeg，生成新的合成样片目录，拒绝覆盖已有目录。
- `scripts/linux-codec-acceptance.mjs`：运行最终 AppImage，创建隔离资料库，保存包/样片摘要、实际模式、解码器、逐秒状态、截图与像素检查。拒绝覆盖已有证据目录。

主流程不依赖诊断开关、调试版 helper 或新的系统包。未验证范围不通过补开布尔选项自动标记支持。
