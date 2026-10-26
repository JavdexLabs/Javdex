# Linux 播放优化机会：上游能力与待验证项

2026-10-26，基线 `189e9e9fc854d34de9ab6ef18913dc5f29e9c8c5`，开始时工作区干净。仅固定版本一手资料研究及同基线本地审计；本轮在 Mac 上没有运行 Linux GUI、测试、原生构建或性能采样。**候选收益全部未测量，以下顺序是验证顺序，不是性能排名。**

[package.json](../../package.json)／[playback-sources.json](../../build/playback-sources.json)固定 Electron **44.9.3**、libmpv **0.41.0**、FFmpeg **9.0.2**、libplacebo **7.351.0**、nv-codec-headers **12.1.14.0**。Electron 的固定 [DEPS](https://github.com/electron/electron/blob/v44.9.3/DEPS)对应 Chromium **152.0.7977.167**、Node **24.22.0**；本记录不套用 latest 文档推定其他版本能力。

Linux 实机执行进展与测量结果见 [2026-10-26 验证记录](linux-playback-optimization-validation-2026-10-26.md)。以下研究基线和历史判断保留，不能替代新包验收。

## Linux 设备接续入口

用户于 2026-10-26 明确将实际优化留待 Linux 设备执行；当前只保存核查与接续要求。上述 SHA 和版本是研究基线，接续时先拉取并整合最新 `dev`，保留本地工作与远程新增，重新核对实现差异；不回退到旧 SHA，也不把 Windows／Mac 或旧 Linux 包的结果当作新实现通过。

开工先读根目录 `AGENTS.md`、`CONTEXT.md`、[内置播放合同](../BUILTIN_PLAYBACK.md)、[ADR-0033](../adr/0033-unify-desktop-playback-capabilities.md)、[Linux 播放合同](../LINUX_COMPATIBLE_PLAYBACK.md)与[开发指南](../DEVELOPMENT.md#内置播放运行库)。记录源码、Electron／SDK、两份 helper、libmpv 和 ANGLE 的实际身份，以及发行版、桌面、显示协议、GPU／驱动、活动 DRM 设备、物理输出尺寸和缩放。改变原生代码或运行时版本后使用匹配的新构建，不复用不匹配的旧二进制。

执行顺序及完成条件：

- [x] **先保存 Linux 当前基线。** 使用合成素材，对同一编解码、帧率、物理输出尺寸和设置做对照；覆盖 1080p 24／30／60fps 及实际 4K 输出，性能采样每项至少 60 秒。预热和采样时长一致、交替执行基线／候选，截图与像素读回放到计时后；不与构建或其它播放验收并行。
- [x] **先完成传输与生命周期回归，再做 GPU／CPU video 原型。** 处理下文的时间戳、高层发送超时、迟到导入／释放、自检取消和旧流清理；GPU 使用原始导入帧，CPU 仅转移私有复制缓冲区。分别对照现有 Canvas；追踪 Chromium 是否额外转 NV12，不预先认定 video 更快。
- [x] **按实际设备验证直接硬解。** 先检查现有运行库，再接通同一 DRM／GL 设备上的 VA-API 或 NVDEC；与 auto-copy 单独配对，不与消费者变更混作一次实验。保留 copy／软件解码退路，区分解码器回退和 GPU 显示故障触发的 CPU 恢复。
- [x] **再调整 FD 调度。** 用 readiness、有界收包和 ACK 处理替代 5ms 空轮询，保留低频超时检查；验证暂停／隐藏、socket 压力、停止、页面退出和 FD 复用，不把 helper 的 16ms 等待当作帧率上限。
- [ ] **有数据支持后再处理 CPU 剩余成本。** 已完成分段测量；现有 Canvas 必须保留 alpha，异步读取的有界队列和取消合同尚未实施。 RGBX 端到端合同成立后评估 alpha 补写；单独测量同步 `pread` 对 main 的影响，再决定是否异步化。线程迁移和直接映射不能代替复制次数及所有权核查。
- [x] **收敛后复验正常应用。** 运行与改动相关的回归、类型／lint、原生与桌面构建检查；在可用的原生 Wayland、XWayland／Xorg 和实际 GPU 上验证色彩、ASS／PGS、暂停／跳转、缩放／全屏、停止重开、禁用 GPU 与故障接管。缺少设备的矩阵项保留待验；声音／口型、物理 HDR 只按实际执行报告。

每轮保留原始样本和失败记录，至少记录应用整个进程树的 CPU、RSS、mpv 丢帧、生产／提交／video 帧率、各阶段耗时与停止后的帧池／FD 释放。**进程 CPU 合计的 100% 表示一个逻辑核**；若另报整机归一化占用，记录逻辑核数与换算，不混用两种口径。缺少计时样本不能记成零耗时，视频时间推进也不能代替源帧率或物理呈现证明。

保留默认 GPU、一次自动 CPU 恢复、用户设置、输出尺寸、缩放／色彩／字幕质量及资源租约条件；不通过降低这些要求制造性能提升。公开软件包的独立下载验收仍按用户要求不做。接续结果在本记录更新已完成项，并把实际构建和性能证据保存到新的本地目录；本次记录不启动优化、CI 或发布任务。

## 上游能力与本地边界

### 1. GPU 原始 VideoFrame → generator → video 可以研究复用

Electron 44.9.3 的 Linux 导入实现接受 nativePixmap 的 plane FD／stride／offset／size／modifier，复制 FD 后创建 SharedImage，`getVideoFrame()` 用 `WrapSharedImage` 包装资源，Linux usage 含 `DISPLAY_READ`。对应跨线程析构／释放回调也已送回 owning sequence，见 [固定 native 实现](https://github.com/electron/electron/blob/v44.9.3/shell/common/api/electron_api_shared_texture.cc)。因此 Linux 有复用 Mac 消费者的 API 基础，不必为此更换解码器或 SDK。

但“输入原始帧”不保证下游没有转换或复制：[Chromium 152 generator sink](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc)持有底层帧、关闭传入 JS 帧，再向视频源交付；满足条件时还有 RGB SharedImage → REC709 NV12 的 eager conversion。当前 BGRA＋单个 video 是否在实际 Linux 路径避开该分支，留给原型追踪；不据此修改全局 feature 开关。`writer.write()` 完成不代表视频已经显示。

本地 GPU 已[按槽缓存 GBM／EGLImage／FBO](../../apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp#L197)，[直接渲染到 buffer.framebuffer](../../apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp#L404)，随后 [glFinish](../../apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp#L268)。**没有 Windows 式桥接 CopyResource 可再删。** Canvas `drawImage` 是绘制／缓存通路，不能仅凭该调用推定 CPU 读回或额外一次完整 GPU memcpy；移除后的 Linux 收益未知。

更换消费者仍须保持现有活动 GPU↔DRM render node 精确匹配、有效 FD、真实格式／plane／modifier 协商和完成／释放协议。X11 的私有 ANGLE Vulkan、Wayland EGL 是不同消费后端；生产者 EGL 支持导出不等于消费端支持导入。XWayland 通过不能代替原生 Xorg／Wayland，见 [Linux 当前合同](../LINUX_COMPATIBLE_PLAYBACK.md)。

### 2. CPU RGBX＋ArrayBuffer transfer 能减少接收端复制

固定 [Chromium VideoFrame 构造实现](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/webcodecs/video_frame.cc#L1038)在成功转移覆盖数据范围的 ArrayBuffer 时直接包装源内存，持有至帧析构；未成功转移时分配并复制。须使用可 detach 的私有普通 ArrayBuffer，正确设置 RGBX、真实 stride、尺寸、单调 timestamp 和现有 BT.709／sRGB／RGB full 色彩标记。

可复用 [submitCpu](../../apps/desktop/src/preload/sharedTextureVideo.ts#L118)替代 [逐行 ImageData 复制／putImageData](../../apps/desktop/src/preload/sharedTextureReceiver.ts#L268)；目前 [消费者选择](../../apps/desktop/src/preload/index.ts#L868)和 [video 挂载](../../apps/desktop/src/preload/sharedTextureReceiver.ts#L336)仅对 darwin 开启。但 Linux CPU 仍有[直接渲染到 memfd](../../apps/desktop/src/main/player/native/linuxSoftwarePlayback.cpp#L166)、[alpha255 扫描](../../apps/desktop/src/main/player/native/linuxSoftwarePlayback.cpp#L77)、main [Buffer 分配＋同步 pread](../../apps/desktop/src/main/player/native/linuxFdBridge.cpp#L251)和 [IPC](../../apps/desktop/src/main/player/linuxSharedTexture.ts#L278)。换 video 不消除这些复制，也不保证消除浏览器后续上传／合成。

不能直接把受租约约束的生产者映射交给 video 后提前复用。先建立 RGBX wire contract，再研究删除 alpha 扫描；搬离 main 的异步读取仍需独立的有界队列、取消与 FD 生命周期。现有 [Mac 配对比较](macos-cpu-video-comparison-2026-10-26.md)总 CPU 基本持平，不能承诺 CPU video 解决 Linux 4K60。

### 3. direct VAAPI／NVDEC 的目标是减少系统内存往返

Linux 使用 [RenderConfig 默认 auto-copy](../../apps/desktop/src/main/player/native/renderConfig.h#L32)，[创建宿主](../../apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp#L318)未提供解码器显示资源。Windows 则明确配置 [d3d11va,auto-copy](../../apps/desktop/src/main/player/native/windowsSharedTexture.cpp#L303)。GPU 输出已经共享，并不说明解码器输入没有 copy-back。

- **VAAPI：** 固定 [hwdec_vaapi.c](https://github.com/mpv-player/mpv/blob/v0.41.0/video/out/hwdec/hwdec_vaapi.c)可从 X11／Wayland 资源，或 `drm_params_v2.render_fd` 创建 VADisplay；DRM 路径调用 `vaGetDisplayDRM`。向 libmpv 接入同设备 render FD 是现有 GBM／surfaceless helper 的研究入口，不必为此增加原生视频窗口。解码表面须支持导出及 EGL 格式／modifier 导入；源码仍调用 `vaSyncSurface`，direct 不代表无同步。
- **NVDEC：** 固定 [hwdec_cuda.c](https://github.com/mpv-player/mpv/blob/v0.41.0/video/out/hwdec/hwdec_cuda.c#L228)仍逐 plane `cuMemcpy2DAsync` 到 mapper 纹理，`do_full_sync` 时调用 `cuStreamSynchronize`。需验证宿主 NVIDIA CUDA／GL 互操作、实际解码／GL 设备一致性与驱动支持；不称为所有阶段零拷贝。

现有 [Linux GPU 构建参数](../../scripts/playback-source-build.mjs#L130)已开启 CUDA hwaccel／interop、VAAPI／VAAPI DRM，关闭 native X11；[VAAPI render dependency 补丁](../../scripts/playback-source-build.mjs#L168)也已去掉原生 KMS 构建依赖，由 [runtime 构建入口](../../scripts/build-playback-runtime.mjs#L180)应用。**下一步先验证现有打包运行库及接入参数，不是假设功能未编译或要求新 SDK。** 当前 [mpvCore render 参数](../../apps/desktop/src/main/player/native/mpvCore.h#L292)没有传 DRM display V2；helper 的精确 DRM 设备和 EGL 条件仍须保持。

按设备研究 `vaapi,auto-copy`／`nvdec,auto-copy`，保留 copy／软件解码退路。编译成功、`hwdec-current` 或 Chromium ANGLE Vulkan 后端都不能单独证明 helper 解码互操作和最终可见画面。mpv 解码→GL 与 GL 输出→Chromium 是两段不同链路。

## 尚待验证与建议顺序

| 候选（均未测量） | 必须核对的边界 |
| --- | --- |
| **1. 共用 GPU／CPU video 有界原型** | 保持原生生产者、质量、尺寸、色彩、时序不变。Linux [textureInfo](../../apps/desktop/src/main/player/linuxSharedTexture.ts#L302)缺 timestamp，需对照 Mac [targetTimeUs／renderStartUs](../../apps/desktop/src/main/player/nativeSharedTexture.ts#L184)保留 producer 单调时基，仅交付等待映射页面时钟；timestamp 不保证 generator 按目标时刻呈现。核对实际背压／替帧、三槽持有、暂停／跳转／隐藏／缩放／重开、自检取消和旧流释放；覆盖 X11／XWayland／原生 Wayland、手动 CPU／禁用 GPU／故障接管及字幕／色彩。 |
| **传输是 1 的前置项** | Linux [await sendSharedTexture](../../apps/desktop/src/main/player/linuxSharedTexture.ts#L321)，Mac／Windows 已用 [subtle.startTransfer＋私有 IPC](../../apps/desktop/src/main/player/nativeSharedTexture.ts#L193)。固定 [Electron 高层发送实现](https://github.com/electron/electron/blob/v44.9.3/lib/browser/api/shared-texture.ts#L116)有 1000ms timeout，先 Promise.race、成功后才登记 renderer 引用；超时不撤销迟到导入，存在引用跟踪竞态，属于源码风险判断。原型须核对发送／接收 await 的真实含义、>1s 延迟、迟到导入／释放、页面退出、写入失败、自检取消；不能只打开平台 gate。 |
| **2. 按设备 direct VAAPI／NVDEC** | 理论上可减少较大系统内存往返，收益未知。以相同输出的 auto-copy 配对，验证现有运行库、设备／EGL／VADisplay／CUDA plumbing、实际 direct 与退路、可见画面／色彩／字幕。Linux 尚缺完整 render／finish／download 分段计数；Windows 的 copy-back 诊断不能直接充当 Linux 证据。 |
| **3. FD readiness 代替 main 5ms 轮询** | 当前 [interval](../../apps/desktop/src/main/player/linuxSharedTexture.ts#L341)刷 ACK、最多收一包，可研究 FD watch＋有界 ready drain、低频 watchdog、仅 pending ACK 时监听 POLLOUT。遵守 [libuv poll 合同](https://docs.libuv.org/en/stable/poll.html)：EAGAIN／虚假 readiness、同 FD 单 watcher、stop-before-close；常开可写监听会忙循环。helper 已有 [eventfd／条件 POLLOUT](../../apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp#L469)，`poll(...,16)` 是等待上限，**不是帧率上限**；50ms 状态输出也不是视频提交周期。 |
| **4. RGBX 合同后再改 alpha／同步读取** | 确认所有消费者按不透明 RGBX 解释后，再评估去掉 alpha255 扫描、把同步像素读取搬离 main；搬线程不等于删除复制，直接映射必须重新设计持帧生命周期。 |

所有候选继续区分 producer 完成、跨进程 acquisition、消费端 GPU 完成和最终引用释放。**保留 glFinish，直到有完整的显式 producer fence 交接／等待协议。** Electron 当前 nativePixmap import 没有外部 acquire-fence FD 参数，creation SyncToken 不能自动覆盖独立 helper 的 GL 工作。writer.write、JS close、rVFC、IPC 成功均不能归还 GPU 租约；最终 release／ACK、三槽限制、时间线隔离及交付不明时的有界留存仍必须成立。CPU 私有复制缓冲信用额度与 GPU 租约保持不同条件。

量级算术而非测量：真正 `3840×2160×4 = 33,177,600 B = 31.64 MiB/帧`；60fps 每次完整复制载荷 **1.990656 GB/s**，读＋写约 **3.981312 GB/s**，不代表实际复制次数或可获得收益。现有 [色彩 LUT／线程控制](../../apps/desktop/src/main/player/native/colorPipeline.h#L161)、[GPU 预算学习](../../apps/desktop/src/main/player/frameBudget.ts#L14)已经实现；[当前 Linux 导入](../../apps/desktop/src/main/player/linuxSharedTexture.ts#L303)已有色彩标记，不沿用旧 Linux 文档的未标记色彩结论。逐段成本与最终性能优先级留给后续 Linux 实机测量。

### Wayland video 后续验收

首帧失败的因果对照、引用重送修复和新包实测见 [Wayland GPU video 验收](linux-wayland-video-validation-2026-10-26.md)。成功写入 generator 不等于显示 sink 已连接；不再将该失败笼统归因于 Wayland DMA-BUF 或 eager conversion。该阶段保留实验开关；后续用户已选择 Linux 默认直接硬解＋video、接受 CPU 4K60 性能下降，并移除 Linux Canvas 入口。最终范围与兼容性边界见 [收敛记录](linux-intel-direct-investigation-2026-10-27.md#收敛决定与审查2026-10-27)，上文候选分析保留为当时的设计背景。
