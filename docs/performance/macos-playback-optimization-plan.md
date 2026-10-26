# macOS 内置播放拷贝核查与优化方向

日期：2026-10-25。调查时状态：源码核查完成，优化未实施；本轮未执行新构建的播放性能测量。

2026-10-26 后续：[独立 video 消费原型](macos-video-consumer-prototype-2026-10-26.md)已在本机验证绕过 Canvas 缓存复制和短时 CPU 收益，但需要包含跨线程释放修复的 Electron 44.9.3；调查时的仓库 43.8.1 会崩溃。随后按用户确认实施 [Electron 升级与产品接入](../reviews/macos-video-consumer-integration-2026-10-26.md)。以下保留调查时的方向，不替代后续结果及其边界。

基线：`dev@7e522df2fb3385015f16a55a2097ed53c511f263`。本地已快进到该提交，保留此前未提交的 Release 文案和 ANGLE 源码交付调整；它们不作为 Mac 性能改动或性能证据。

## 结论

当前显示链路有额外的整帧复制，位置在 Chromium 的 Canvas 消费端：`drawImage(VideoFrame)` 先复制源共享纹理到内部缓存 SharedImage，再将缓存图像绘制到 Canvas。应用生产端已直接渲染到 IOSurface，没有 Windows 本轮移除的私有 bridge／输出 `CopyResource`。不能把 IOSurface 引用共享等同于整条显示链路零拷贝。

优先检查消费端缓存复制与后续绘制的成本。单独把生产者换成 ANGLE／Metal 不会移除 `drawImage` 的这一层，也不能预设更低 CPU；以下分阶段方案仅作后续方向。

## 当前逐帧拷贝链

| 环节 | 源码核查结果 |
| --- | --- |
| VideoToolbox 解码表面 → mpv GL 输入 | mpv 的直接 VideoToolbox GL mapper 通过 `CVPixelBufferGetIOSurface`／`CGLTexImageIOSurface2D` 映射解码表面；但应用配置 `hwdec=auto` 不保证每个片源实际走直接硬解，须区分 `videotoolbox`、copy 模式及软件解码。 |
| mpv → 输出 IOSurface | 输出表面直接绑定 FBO，mpv 在该 FBO 上完成缩放、色彩和字幕；未发现应用额外复制一个全尺寸输出纹理。 |
| 隔离宿主 → main → Electron VideoFrame | Mach 传资源权利、Electron 保留 IOSurface 并 `WrapSharedImage`；不是逐帧传像素。宿主交接已按 resourceId 缓存，N-API 的 `buffer_copy` 仅复制 8 字节指针。 |
| VideoFrame → Chromium 缓存图像 | **存在整帧 GPU 复制命令**：`PaintCanvasVideoRenderer::UpdateLastImage` 创建缓存纹理，`CopyVideoFrameToSharedImage` 对源／目标不同的 SharedImage 发出 `ri->CopySharedImage`，此处采用完整 coded size。 |
| 缓存图像 → Canvas → 页面合成 | 另有 Canvas 绘制和后续页面合成；不是直接把源 IOSurface 当 Canvas 的 backing store。不能仅由源码推导实际 GPU 带宽、合成 pass 数或物理上屏延迟。 |

应用入口是 [sharedTextureReceiver.ts](../../apps/desktop/src/preload/sharedTextureReceiver.ts) 的正常 `drawImage(frame, 0, 0)`。仓库固定 Electron `43.8.1`，其 DEPS 固定 Chromium `150.0.7871.250`。调用链依据为固定源码：

- [Canvas2DRecorderContext](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/modules/canvas/canvas2d/canvas_2d_recorder_context.cc#L2181)：共享 VideoFrame 走 `DrawVideoFrameIntoCanvas`，不先创建 JS ImageBitmap。
- [DrawVideoFrameIntoCanvas](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/platform/graphics/video_frame_image_util.cc#L297)：每次创建局部 `PaintCanvasVideoRenderer` 并调用 Paint；该缓存对象不跨这里的逐帧调用复用。
- [UpdateLastImage](https://github.com/chromium/chromium/blob/150.0.7871.250/media/renderers/paint_canvas_video_renderer.cc#L1586)／[CopyVideoFrameToSharedImage](https://github.com/chromium/chromium/blob/150.0.7871.250/media/renderers/paint_canvas_video_renderer.cc#L1674)：分配缓存 backing、复制源共享图像，再交给 Canvas 绘制。
- [Electron IOSurface 导入](https://github.com/electron/electron/blob/v43.8.1/shell/common/api/electron_api_shared_texture.cc#L739)：保留资源引用并用该 handle 创建 SharedImage，不把整帧像素复制进 JS 内存。

没有发现正常 GPU 热路径主动执行整帧 GPU → CPU → GPU 搬运。640×360 启动自检的 `getImageData` 与显式诊断的 `copyTo` 不是正常逐帧操作；CPU 兼容模式的内存帧复制单列。`glFinish` 是逐帧同步等待，`glClear` 是额外清屏写入，均不能计作纹理复制。实际 Canvas 是否保持 GPU 加速、特定片源的解码模式及驱动内部搬运，仍须用当前构建测量；历史 trace 未出现 copy 名称不构成无复制证据。

该 Canvas 入口由三平台共用，因此这次确认的缓存复制也不只发生在 Mac。Windows 最新优化去掉的是应用生产端的另一处复制，并未消除当前 Canvas 消费链。后续若尝试别的消费 API，应先验证该版本、BGRA 格式的实际复制次数，不能仅凭 WebGPU 或共享纹理名称宣称零拷贝。

## 最新提交与已有能力

本次拉取的三个提交：

- `dfba98b8`：桌面前进／后退事件归一化，播放器单击／双击仲裁。属于已有交互修复，优化时继续保留。
- `b9f7adce`：仓库浅色社交预览图，与播放热路径无关。
- `7e522df2`：Windows GPU 改为 ANGLE／D3D11 直接硬解与共享槽直接渲染，增加设备与耗时诊断。

Windows 以[最终收敛记录](../reviews/windows-angle-finish-consolidation-2026-10-25.md)和当前代码为准：`d3d11va,auto-copy` → 空闲共享槽 → `glFinish` → 解绑 → Electron／Canvas。WGL、桥接复制、异步 fence、高精度完成计时器和旧候选开关已移除。[早期对照数据](../reviews/windows-playback-pipeline-2026-10-25.md)保留历史价值，但不能当作最终提交的全套性能结果，更不能外推为 Mac 的预期降幅。

当前 Mac 路径为：libmpv／`hwdec=auto` → CGL／OpenGL → IOSurface FBO → `glFinish` → Mach 资源交接 → Electron SharedTexture／VideoFrame／Canvas2D。实现位于 [macSharedTexture.mm](../../apps/desktop/src/main/player/native/macSharedTexture.mm)。

已经具备、无需重复建设的能力：

- 直接写入空闲 IOSurface；尺寸不变时复用槽、纹理与 FBO。
- 三槽背压、资源 ID／时间轴隔离，以及消费端 GPU 完成和最终引用释放后才复用的租约规则。
- 长度为一的 mpv 唤醒队列、事件驱动生产和低频故障兜底；不是以 16ms 轮询驱动视频。
- 隔离播放宿主。Mach right 只在槽资源首次发布或资源 ID 变化时交接，父进程已缓存原生资源；无需再增加同样的缓存。
- 自动／GPU／CPU 统一模式、图形故障的一次 CPU 恢复、统一字幕与 SDR 输出合同。

## Windows 方案的适用性

| Windows 本轮措施 | Mac 当前情况 | 处理方式 |
| --- | --- | --- |
| WGL 改 ANGLE／D3D11，减少硬解回读 | Mac 已配置 `hwdec=auto`，且源构建启用 VideoToolbox GL；当前具体片源是否直接导入仍需测量 | 先记录实际解码器与导入方式，不能仅凭 `auto` 宣称没有回读 |
| 省去私有 bridge 与输出复制 | Mac 已直接渲染到 IOSurface FBO | 保留现有直接输出，不虚构一项可删除的复制 |
| 对齐 Chromium 活动 DXGI 适配器 | Windows LUID／preference 不适用于 CGL | 先记录 Mac 实际渲染器和可取得的设备身份；多 GPU／跨屏单列验证，不用型号或枚举顺序猜测 |
| 分别记录渲染、完成等待、输出交接 | Mac 主要只有帧数、尺寸和租约数量 | 优先补齐，以相同统计定义定位开销 |
| 私有控制 pbuffer，避免用消费中的输出做控制工作 | Mac 没有独立的控制 FBO，渲染后也没有显式解绑输出 FBO | 先核对 update／skip／teardown 的 GL 行为，再验证私有控制 FBO 与显式解绑；收益待测，不先判定现有路径有错误 |
| `glFinish` 确认生产完成 | Mac 已使用相同完成边界 | 第一阶段保留，不把 `glFlush`、消息送达或 Canvas 提交当作 GPU 完成 |
| 产品默认画质下对照 | Mac 有较早的开发构建记录 | 在新基线重新测量，保持输出尺寸、缩放、色彩和字幕条件一致 |

## 第一阶段：诊断与当前路径优化

### 1. 建立当前基线

先冻结源码、Electron、addon、interop 与 libmpv 的版本及摘要，使用隔离资料库和合成视频。先确认应用能正常进入播放；此前额外验收曾停于系统钥匙串等待，若重现则记录为未完成，不混入性能样本，也不修改系统凭据权限。

首批素材采用 1080p 与 4K H.264 30／60fps、HEVC Main10、HDR10／HLG；24fps、音轨及字幕另作功能矩阵。记录真实物理 viewport、Retina 缩放、屏幕刷新率、实际硬解和 GPU／CPU 模式。先测 Apple Silicon，本机结果不能代替 Intel Mac。

测量先预热 5 秒、采样 30 秒，至少五对交错顺序的同条件运行；持续播放另观察至少 10 分钟。测量区间结束后再读回像素和截图，避免改变被测路径。

### 2. 补齐低开销诊断

主要修改位置建议为：

- [macSharedTexture.mm](../../apps/desktop/src/main/player/native/macSharedTexture.mm)：记录 `renderCall`、`glFinishWait`、上下文／FBO 准备、输出交接的样本数、累计值、最大值；默认只保留有界统计，不新增逐帧日志。
- [mpvCore.h](../../apps/desktop/src/main/player/native/mpvCore.h)：沿用实际 `hwdec-current`，必要时为 Mac 增加有界的回读诊断；区分 `videotoolbox`、`videotoolbox-copy` 和软件解码。诊断未启用时不把零样本解释为零回读。
- [nativePlayback.ts](../../apps/desktop/src/main/player/nativePlayback.ts)：扩展 Mac 的可选私有诊断类型，避免套用 Windows 的 `angle-d3d11`、LUID 或解码设备字段。设备身份未知时明确记录未知。
- 新增 `scripts/macos-gpu-profile.mjs`，复用现有隔离启动、合成素材、退出和结果保存工具；保持平台原生计时与硬解断言独立，不让 Mac 脚本依赖 Windows DLL 名称。

分别观察解码、生产渲染／完成等待、宿主交接、main 导入／传输和 Canvas 提交。宿主墙钟等待、GPU 执行时间及屏幕显示延迟不是同一指标，不能直接相加或互相替代。

CPU 同时记录主进程、播放宿主、Renderer、GPU 等进程及总和。优先按累计 CPU 时间差分计算：`100 × 各进程 CPU 秒增量之和 ÷ 墙钟秒增量`，此口径一核满载为 100%；如另给逻辑核数归一化结果，明确列出核数和算法。复用 `app.getAppMetrics()` 时只设一个采样者，丢弃首次零值，避免其他读调用重置区间。内存求和可能重复统计共享页，不作为独占显存。

### 3. 按测量结果选择改动

- 若实际落到硬解回读，优先查明 VideoToolbox 导入失败、格式或上下文原因；先修正当前 CGL 互操作，不以强制一条 `hwdec` 配置代替直接导入证据。
- 若上下文／输出准备开销明显，验证私有控制 FBO、渲染后解绑和尺寸稳定时的复用；不重绑消费端仍持有的输出。不能在未验证 mpv 绘制覆盖范围前删除清屏等操作。
- 若空唤醒、无变化状态或 IPC 占比明显，再减少重复工作；保持事件驱动和现有故障观察，不通过降低视频帧率、省略控制反馈或延长故障发现来换取低 CPU。
- 若 Electron 逐帧 import／Canvas 合成占主导，先保留证据，再单独评估其接口限制。当前每帧 import 与最终释放绑定，不能直接缓存一个长期存活的 import，否则三槽可能一直不能归还。
- 若主要成本是有效的渲染或 `glFinish` 等待，先保留同步边界，进入第二阶段可行性验证；不先加入异步 fence／轮询候选。

这一阶段保持 CGL、Canvas2D、CPU 回退、既有默认缩放及色彩策略，避免把后端重写混入小范围性能修正。

## 第二阶段：有条件验证 ANGLE／Metal

这是独立的可行性验证，不是第一阶段的默认实施项。

候选链路为：VideoToolbox CVPixelBuffer／IOSurface → ANGLE GLES／Metal 中的输入纹理 → mpv 色彩、缩放与字幕 → 空闲 BGRA IOSurface 输出槽 → 完成与解绑 → 现有 Electron／Canvas 消费。

需先通过以下关口：

1. 核对当前 Electron 43.8.1 Mac arm64／x64 实际随附库、可用入口和扩展。不能照搬 Windows DLL 位置，也不能假设较新文档中的能力已在当前运行库可用。
2. 保持 libmpv Render API 接口，验证 GLES／Metal 下的完整 mpv 渲染、字幕与固定 SDR 映射。现用 API 提供 OpenGL／软件接口，不能直接换成一个未接入的 Metal Render API。
3. 单独解决 VideoToolbox 直接导入。mpv 0.41 的 Mac GL 互操作显式依赖 `CGLGetCurrentContext()` 和 `CGLTexImageIOSurface2D()`，不能直接用于 EGL／Metal。仅成功创建 ANGLE 上下文不算完成；须验证 NV12／P010 输入、解码器状态、无隐式回读及资源保活，必要时才评估固定 mpv 的小型互操作适配。
4. 验证 `EGL_ANGLE_iosurface_client_buffer` 对 BGRA 输出的实际支持、生产完成与解绑要求，以及三槽在慢消费、尺寸变化和旧会话迟到释放时的安全性。继续以已验证的同步方式交付，不预设某种 fence 能跨接口使用。
5. Apple Silicon 与 Intel／多 GPU 的设备选择分别验证；只记录可可靠获得的身份，原生 64 位 ID 不经不安全的 JS number 截断。

如果只能经 CPU 回读、功能／色彩退化、引用不能安全释放，或收益不足以抵偿复杂度，则不采用该候选。通过后再单独确定正式路径和失败处理，避免把试验开关长期留在产品中。第一阶段不恢复旧原生窗口、不改为 WebGPU，也不扩大到完整 Metal 播放器重写。

## 测试与采用标准

| 范围 | 必须保留的结果 |
| --- | --- |
| 状态与恢复 | 暂停 seek、换片、字幕、音量／倍速、展开／底栏／全屏和停止重开保持一致；自动仅对图形故障恢复 CPU，手动 GPU 报错，性能不足本身不触发回退 |
| 资源 | 三槽上限、慢消费背压、尺寸变化、跨会话迟到释放、宿主退出和 Renderer 故障；不以超时或提交回执回收未确认租约 |
| 画面 | SDR full／limited、HDR10、HLG、缺亮度元数据 PQ，沿用现有色彩与字幕误差标准；保留物理输出尺寸、默认缩放和 ASS／PGS 合成 |
| 性能 | 同素材、同设备、同实际输出尺寸对照。对基线能实时播放的样本，至少达到源帧率 97%，30 秒区间新增丢帧不超过一帧；超出设备能力的样本单列，不降分辨率或画质来通过 |
| 收益 | 建议采用门槛为总进程 CPU 中位数相对降低至少 10%，且超过跨轮波动；或明确改善原有吞吐瓶颈而无 CPU／内存回归。此为拟定标准，不是收益预测 |
| 构建 | 开发构建与定向原生／会话／色彩检查先通过；采用正式实现时同步 Mac arm64／x64 源构建配方、许可／源码绑定与正常 CI，开发运行库不能替代正式发行验证 |

本轮没有启动新的 Mac GUI、性能测试、原生构建或软件发行；源码比较和 Node 类型检查通过不作为性能结论。后续报告分别注明本机开发验证、其他平台 CI 和未执行的硬件范围，不另下载公开软件产物做独立验收。

## 接续顺序

1. 补诊断并取得当前 Mac 基线，先交付瓶颈分布。
2. 只实施测量支持的 CGL 路径小改动，逐项做同条件对照。
3. 第一阶段收益不足且成本定位支持时，单独验证 ANGLE／Metal 的硬解导入与输出。
4. 达到功能、质量、安全和收益标准后，再确定正式实现与跨架构 CI 范围。

## 核对来源

- 仓库：[统一播放决策](../adr/0033-unify-desktop-playback-capabilities.md)、[当前合同](../BUILTIN_PLAYBACK.md)、[Windows 最终实现](../reviews/windows-angle-finish-consolidation-2026-10-25.md)、[Mac 历史 Canvas 记录](../reviews/macos-canvas-default-2026-10-23.md)。Mac 的旧短测不是当前隔离宿主与新基线的性能结果。
- [mpv 0.41 Render API](https://github.com/mpv-player/mpv/blob/v0.41.0/include/mpv/render.h)：OpenGL／软件接口与上下文约束。
- [mpv 0.41 Mac VideoToolbox GL 映射](https://github.com/mpv-player/mpv/blob/v0.41.0/video/out/hwdec/hwdec_mac_gl.c)：CGL 与 IOSurface 输入约束。
- [ANGLE IOSurface 扩展](https://chromium.googlesource.com/angle/angle/+/main/extensions/EGL_ANGLE_iosurface_client_buffer.txt)：EGL 表面导入能力的规范依据，不能代替当前版本／设备的可用性验证。
- [Electron SharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture)：跨进程共享与最终引用释放；[CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage)：采样区间与累计时间说明。实现前仍需对照固定 Electron 版本。
