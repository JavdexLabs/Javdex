# 内置播放合同

桌面播放器在主窗口中使用 libmpv，支持本机和远程资料库的文件资源；服务器不解码或转码。日常操作见[播放指南](../website/src/content/docs/guides/playback.md)，构建与分发见[开发指南](DEVELOPMENT.md#内置播放运行库)。

三平台能力与行为统一的目标、实施顺序和跨设备接续条件见 [ADR-0033](adr/0033-unify-desktop-playback-capabilities.md)。2026-10-24 已整合 Mac CPU 代码并实施共用层；新原生构建后的各平台实测范围分别记录，旧证据不追溯覆盖新宿主。

## 默认行为与来源

- 新设置默认内置播放并开启本机续播；已有显式播放方式、程序路径及续播设置保持。外部播放须配置程序路径，失败不自动换播放器或资源。
- 本机文件由主进程核对媒体库、影片、资源、根目录及可用性。远程文件经服务端授权及本机代理读取原始 Range 流，长期管理凭据和播放地址不交给 Renderer。
- 网页、Magnet、ED2K 等非文件链接继续由外部应用处理，不把“已交给系统”当作内置解码成功。
- 内置播放只有在真实输出画面且时钟推进后才记录最近播放或执行“稍后观看”的播放后移除；暂停首帧和续播选择不算开始。异步完成不能跨资料库产生副作用。

## 展示与交互

展开、底栏实时小视频和全屏使用同一播放会话；切换展示不重开影片。恢复同一资源不从头播放，停止后释放播放内核和画面占位。标题栏、设置、轨道、字幕及基础控制复用现有面板，不另建三套产品界面。

系统后退统一收起播放并关闭播放设置，保留会话与当前业务页面；Esc 依次关闭设置、退出全屏、收起播放。图片、播放与设置离开保护共同遵守[共享返回合同](ROUTING_DESIGN.md#overlay-history)，组件订阅或 Effect cleanup 不写历史。输入框、中文 IME、弹层和平台导航组合键优先于播放快捷键。

展开／全屏画面的双击只切换展示，保持原播放、暂停或结束状态。主进程提供运行时点击时序：Electron 44 / Chromium 152 的 Windows／Linux Aura 路径为 500ms，macOS 通过系统自带解释器只读查询 AppKit `NSEvent.doubleClickInterval`；不以桌面设置或浏览器 UA 猜测其它平台的规则。查询有 2 秒超时，失败时采用保守的 5 秒单击等待上界，明确控件和键盘仍即时执行。窗口重新获得焦点时刷新，renderer 手势 hook 等待该结果并增加 50ms 投递余量；已取消的手势不能被迟到结果重新调度。

浏览器在第二次按下给出多击计数时立即取消单击，不等待松开。独立的新单击确认前一单击，键盘激活即时执行。明确播放／暂停、重播、续播选择、停止、展示切换及历史收起取消旧手势；静音、音量、跳转、倍速和选轨保留原单击意图。命令发送不承担手势取消策略；换片、画面通道变化、错误和卸载由 hook 清理。输入复检与平台边界见[验收记录](reviews/linux-mouse-navigation-2026-10-25.md)，浏览器回归入口为 `node scripts/playback-pointer-ui-check.mjs`，GNOME 原生多击计数入口为 `npm run test:playback:pointer:native`。

音量、倍速、章节、选轨、定位和播放信息读取内核实际状态。未知时长不显示虚假百分比；ASS 与图像字幕不套用纯文本字号能力。暂停时重选字幕，在内核确认选轨后刷新原位置；保持暂停，不重开会话，也不绕过续播选择或不可定位限制。手动字幕与 AI 字幕选择不能被迟到命令覆盖。

## 续播与隐私

续播点只保存在本机，按资料库、资源及修订的摘要身份隔离，不保存路径或授权。全局开关与全部进度清除保留，不再提供单次临时不记录或单资源清除入口。有效进度先准备暂停画面，再由用户选择继续或从头；收起不是停止，也不是新的续播记录。

最近播放是另一份本机历史：独立快照、容量和删除规则见[开发指南](DEVELOPMENT.md#数据格式与数据库迁移)。两者都不属于服务端资料、跨设备同步或资料库备份，也不能形成清单引用保护。

## 原生与远程边界

共用核心拥有 mpv 生命周期、异步命令、状态、事件和字幕叠加层；macOS 使用 IOSurface 共享纹理到主窗口 video，Windows 使用 D3D11 共享纹理／CPU 内存帧到主窗口 video；旧 HWND 显示和原生工具栏已移除；Linux 的 X11／XWayland 和原生 Wayland 共用共享纹理／CPU 内存帧到 video 的显示方式。正常关闭由实际接受的窗口关闭与退出生命周期释放内核，不在可能被否决的 `close` 回调提前拆除活跃视图。

Linux 默认复用 video 消费者，移除 Canvas 消费入口与 `--javdex-linux-video` 实验开关。CPU 4K60 的已测吞吐下降为用户接受的取舍，不承诺实时 4K60。共享 video 自检在新流首帧被观察前有界重送同一像素的引用，处理显示端异步连接竞态；普通 GPU 帧不等待 video 回调，引用重送不提前释放原生纹理。验收与性能边界见 [Wayland video 修复记录](performance/linux-wayland-video-validation-2026-10-26.md)。

三平台采用同一“自动 / GPU / CPU 兼容”设置，在重新打开影片时应用。自动模式优先 GPU，图形初始化、自检或可检测运行故障最多触发一次 CPU 恢复；GPU 模式失败直接报告错误；CPU 模式使用软件解码和 libmpv 软件绘制，显示合成由 Chromium 执行。显式选择 GPU 后重开可重新探测。`--javdex-cpu` 可强制使用 CPU（`--` 后不生效）。未发布设置直接使用 `playbackRenderMode`，不读取或迁移旧平台专属字段。

CPU 使用 `hwdec=no`、libmpv SW Render API 和 opaque RGBA，preload 在三平台将私有像素缓冲区按真实 stride 包装为 opaque `RGBX VideoFrame`，使用同一 video 消费者。Windows/macOS 的私有 MessagePort 直接连接隔离宿主与 preload，主进程只认证绑定、校验元数据和管理调度／信用额度，不中转像素；VideoFrame 复制私有端口输入。Windows 直接绘制到 JavaScript 拥有的 64 字节对齐输出视图，每帧独立分配，不再从 scratch 整帧复制；x64 使用 SSE2 批量设置不透明通道，ARM64 保留逐像素处理。对齐视图前后与行尾均清零，生命周期由 JavaScript 持有，不依赖消费回执提前回收内存。Mac 保留原生对齐 scratch 和输出复制。Linux 紧密排列时转移私有缓冲区，存在行尾填充时由 VideoFrame 复制规范化，避开 Chromium 转移带填充 RGB 帧时窗口输出红蓝互换的问题。不另设 Canvas 显示路径，不创建播放端 GL context 或 D3D 设备；Windows/macOS video 在禁用 Chromium GPU 时仍可使用软件合成。三平台共用实际物理尺寸 `round(逻辑尺寸 × 缩放)`，不额外降至 1080p；保留缩放不超过 8、单边 8192、单帧 256MiB 的安全边界。Windows/macOS 复制帧最多两帧在途，复制信用额度跨宿主和接收方共同约束；Linux 沿用三个槽位的有界 memfd／ACK 传输池。

`PlaybackEngine` 复用当前已授权来源，恢复位置、暂停意图、音量、静音、倍速、音轨、外挂字幕和 AI 时间轴；恢复中的新控制意图优先，停止或换片取消旧恢复。媒体、授权、音频和页面错误不触发图形回退；软件解码与 CPU 画面输出分别报告。未知 GPU 租约不强行回收，迟到回调继续归属原宿主与资源代。

图形初始化包括创建设备、检查导入能力、构造桥接和启动宿主；部分创建失败的桥接由工厂负责清理。播放进程通信及帧 IPC 回调中的故障必须进入可读取的受控失败状态，CPU 侧故障不再次恢复。接收器／首帧等待从请求显示开始计时，隐藏期间不消耗这段等待预算。环境与故障阶段检查见[回退审计](reviews/playback-fallback-audit-2026-10-24.md)。

应用启动使用三平台共用的独立保护：在主窗口首次显示前，明确的 GPU 进程崩溃、异常退出、启动失败或完整性失败，允许主实例自动重启一次；重启前等待已开始的初始化与既有退出清理完成。新进程关闭 Electron 硬件加速并强制 CPU 视频，保留显示后端、用户目录与其他启动参数，不改写播放设置。一次性标记防止第二次自动重启；恢复后的提示允许用户主动重试 GPU。正常窗口显示后的 GPU 故障仍由播放引擎处理，普通初始化／数据库／加载错误、用户退出、单实例拒绝以及 OOM 不作为自动切换依据。详细实现与真实验收见[启动保护记录](reviews/startup-graphics-recovery-2026-10-24.md)。

`--javdex-software` 是三平台的手动软件启动入口，同时关闭界面硬件加速并选择 CPU 视频；`--javdex-cpu` 只强制视频 CPU。两者均只解析 `--` 之前的参数。进程在入口代码执行前直接崩溃、操作系统杀死主进程或驱动使主进程完全失去响应时，不保证自动恢复，也不安装常驻守护进程。

Windows/macOS 的 libmpv、GL 和软件生产者运行在独立 utility process；主进程只加载不链接 libmpv/GL/D3D 的资源互操作模块。Windows 复制子进程 NT 共享句柄，macOS 用 Mach right 传递 IOSurface；以每次分配的资源 ID 区分同一槽的后续分配，接收方保持稳定导入，直到实际引用释放后才退休。宿主退出或 5 秒无心跳按统一规则处理，关闭超时由主进程终止，不让原生调用阻塞界面。Linux 继续使用独立 helper、私有管道和 FD 通道；绑定变化直接通知可见性，不再依赖会话的 16ms 轮询。

GPU/CPU 均以 BT.709 primaries、sRGB transfer、RGB full-range 的 8-bit SDR 为显示目标，参考白为 203nit，HDR 采用固定元数据和 BT.2390，不启用动态峰值统计。CPU 在解码后、字幕合成前进行色彩转换，避免改变字幕颜色；不依赖 GL 或额外色彩运行库。缺失 PQ 亮度元数据按共同默认值处理。共同色彩验收入口为 `scripts/playback-color-fixtures.mjs` 与 `scripts/playback-color-acceptance.mjs`，GPU/CPU 输出允许最多 4 个字节值差异；截图不证明物理 HDR 输出或显示器校准。

普通 BT.709 SDR 不需要色域或色调映射时，CPU 采用 16-bit 平面 RGB 每通道查表，避免在最终软件缩放及输出前重复量化；查表线程不超过可用逻辑核的一半且最多四个，给解码、缩放和界面留出资源。HDR 和其他色域继续使用 RGB16/四面体三维转换。软件画面按同一 bilinear 策略配置 swscale 与可用的 zimg，保留实际物理视口及帧内存上界。色彩数值验收读取显示器色彩转换前的 sRGB Canvas，窗口截图同时断言三原色主通道，防止 Canvas 正常而合成输出红蓝互换；两种取像来源不能混作同一比较基准。最终输出为 8-bit，低于一个字节值的参考灰阶允许量化为同一值；仍检查灰阶顺序、可分辨层次及原像素误差门槛。

帧绑定与时钟交换由 `frameEndpoint.ts` 统一认证主 frame；预算和已知色块自检由共用模块处理。自检通过真实纹理及实际显示通道采样固定 640×360 色块（三平台均为 video；临时 Canvas 仅用于固定色块采样），不检查任意影片的黑色内容。异步复制中的帧保留独立时间信息，切换时间轴不能清零待发送帧的时间戳。应用生成字幕采用系统默认字体（`sans-serif`）；外挂 ASS 和内嵌字体保留片源样式。


Windows GPU 生产者统一使用私有 ANGLE 的 GLES3／D3D11 上下文。libmpv 从该上下文取得同一 D3D11 设备，按 `d3d11va,auto-copy` 尝试直接硬解；正常支持的 NV12／P010 画面不回读系统内存。编解码不支持时，解码器自己的回退与 GPU 画面路径分别报告。WGL 和私有全尺寸 bridge／复制输出已移除；ANGLE 初始化、共享目标、自检或可检测运行故障直接进入统一图形故障处理，自动模式最多恢复一次独立 CPU，手动 GPU 模式报告错误。

ANGLE 直接渲染到空闲的非 keyed NT 共享输出槽，不经过全尺寸私有 bridge 或 `CopyResource`。每个槽缓存自己的 EGL pbuffer；仅空闲槽允许写入或更换尺寸，资源 ID 与三槽租约仍约束跨代回收。独立 1×1 私有 pbuffer 承担内核更新、skip 和关闭，不能把仍由消费端持有的输出槽用于这些操作。渲染后调用 `glFinish` 确认写入完成，检查错误并解绑输出，随后才能交付；消费端最终释放前仍不能复用槽位。已移除异步 fence、完成轮询和多帧生产队列试验。GPU 保持 mpv 默认缩放算法，不因设备、视口或吞吐不足更改缩放、色彩或输出分辨率；低性能设备可能卡顿，性能不足本身不触发 CPU 回退。

Electron 44 已将消费端 ANGLE 静态链接，不再携带 EGL／GLES DLL。Windows 生产端从 `playback.node` 所在目录按绝对路径加载独立固定的 `libEGL.dll`／`libGLESv2.dll`；使用 `build/windows-angle-runtime.json` 固定的官方 Electron 43.8.1 发行中的 ANGLE D3D11 库（不运行该旧 Electron），核对官方发行 ZIP 的 SHA-256，再提取两个 DLL 及完整许可。Windows 的 ABI 头文件与该生产端修订对齐，和 Linux 的 Electron 44 ANGLE 构建配置分别校验。生产／消费双方只交接 D3D11 原生纹理，不交接 ANGLE 对象或原生指针。开发构建、本地打包和正式运行库包含动态加载依赖、来源摘要、上游 ANGLE 与供应方源码及许可。

Windows GPU 与 CPU 复用 `sharedTextureVideo.ts`：GPU 导入帧保留生产端单调时间戳，自检在跳转／视口刷新取消后重新申请；CPU 的 RGBA 按真实 stride 构造 `RGBX VideoFrame`，带填充的行使用复制规范化。GPU 普通帧不等待 video 呈现回调，CPU 保留有界呈现背压；两者的引用与信用额度继续分别回收。正常播放没有逐帧 Canvas 绘制或读回，音频仍由 libmpv／WASAPI 输出。Windows 实机范围与构建发现见[接入记录](reviews/windows-video-integration-2026-10-27.md)。

Windows CPU 后续复用 Mac 私有帧通道：像素从隔离宿主直达 preload，主进程不再接收或序列化整帧像素。surface／binding 与独立通道代认证、两路有界配对、未来时间线保留、先退休再回收生产额度，以及活动端口意外关闭后的五秒故障预算均保持共用；正常解绑不当作故障。默认缩放与 CPU 自动接管保持，实机证据见[私有 CPU 通道记录](reviews/windows-cpu-private-frame-channel-2026-10-27.md)。

`JAVDEX_PLAYBACK_DIAGNOSTICS=1` 时，Windows CPU 额外聚合原生分配、软件绘制、像素整理和输出复制计时；预加载侧分开记录 `postMessage` 执行、跨进程投递及元数据配对、VideoFrame 构造、写入等待和观察等待，主进程每 30 个成功提交输出一条 `[playback-cpu-timings]`。各项可能跨帧重叠、时钟校准存在误差，不能相加解释为物理显示延迟；软件绘制计时也不单独代表异步解码。直接输出的实机结果及剩余瓶颈见 [CPU 原生缓冲区对照](performance/windows-cpu-native-buffer-2026-10-27.md)。

Windows GPU 创建前最多等待两秒取得 Chromium 活动设备的 PCI 身份与 GPU preference；CPU 不查询或等待显卡。与 Chromium 当前的 DXGI preference 定义一致，低功耗／高性能分别解析 `EnumAdapterByGpuPreference(0)` 的 LUID，再核对 PCI 身份；没有 preference 时要求 PCI 匹配唯一。重复同型号但不同 LUID 的物理／虚拟设备不能按枚举顺序猜测。明确目标找不到、变更或存在歧义时按模式报告图形失败／恢复 CPU；GPUInfo 未知或超时时保留系统默认设备与真实画面自检，诊断保持未知。停止、换片或迟到 GPUInfo 结果不能初始化旧宿主；不改写系统显卡偏好。

Windows 私有诊断包括生产端 DXGI 名称／vendor／device／LUID、选择来源、GL renderer、实际解码器及 copy-back 帧所属设备的 DXGI LUID，以及 Chromium 活动设备／driver／preference 信息。`producerBackend=angle-d3d11`、`producerOutput=direct-shared`、`producerSynchronization=gl-finish` 标明唯一 GPU 实现，`directOutputFrames` 记录实际渲染次数。`producerTimings` 分别记录渲染调用、`glFinishWait`、`outputAcquire`、`outputRelease` 和 `producerReadyWall`。最后一项包含渲染、完成等待及 owner-thread 交付调度，非物理显示延迟；渲染调用可能包含上传，跨阶段均值不能直接相加当作端到端延迟。`JAVDEX_PLAYBACK_DIAGNOSTICS=1` 时从固定 mpv 源码收集每 30 帧批量上报的实际回读调用墙钟时间，用于区分解码器回退。

诊断命令为 `node scripts/windows-gpu-profile.mjs 合成视频 gpu|cpu [秒数]`，使用产品默认算法，输出设备、原始样本、区间均值、进程 CPU／工作集及计时后的截图。`JAVDEX_WINDOWS_VIDEO_ADAPTER=VVVV:DDDD` 仅在诊断模式选择唯一硬件适配器，不能覆盖已知且不同的 Chromium 消费设备。原 GPU backend／output／sync 与 pipeline 试验开关已移除。最终实现及验收见 [ANGLE 同步直接输出收敛记录](reviews/windows-angle-finish-consolidation-2026-10-25.md)，早期候选路径与性能对照仅作为历史证据。

macOS 正常构建和启动默认使用共享纹理 video 消费者，无需试验参数；旧 NSOpenGLView 显示后端及其原生全屏控件已移除。GPU 路径的 `playback.node` 在隔离宿主以 CGL/OpenGL 把 libmpv 输出写入三槽 IOSurface，`hwdec=auto` 保持原策略；独立 `software` 导出提供 CPU 回退，不使用 Linux DMA-BUF 或原生子窗口。资源互操作模块先接收 Mach right 并获取本进程 IOSurfaceRef，Electron 再在主进程导入，随后用公开的 `SharedTextureImportedSubtle` 转移对象交给隔离 preload；原始指针不进入应用 JSON、页面或共用播放合同。video、全屏、键盘、滑杆与焦点使用现有 HTML 面板。

Mac CPU 的正式实现保留原生 64 字节行对齐、复用 scratch 和输出缓冲区复制；像素通过私有 MessagePort 从隔离宿主直达 preload，主进程只传递经过校验的尺寸、时间线及调度信息。此路径同时用于手动 CPU 兼容和自动回退，无需实验开关。端口绑定由主 frame 认证的 surface／binding 和独立通道代共同限定，不向公共 Renderer API 暴露。preload 有界配对两路消息，跳转保留尚未到达控制通道的新时间线像素；丢弃、解绑和换代清理旧消息。回收标记与像素走同一有序端口，生产端先发送标记再复用信用额度，避免旧像素尚未清理时新帧抢先到达；连带丢弃的较早待配对帧也须归还额度。意外关闭仍在使用的端口按五秒预算进入受控失败，正常解绑不触发故障。

Mac CPU 的 `VideoFrame` 复制私有端口输入，以降低外部缓冲区转移方案的工作集；原生帧池不进入 video。消费或丢弃后归还 CPU 复制信用额度；帧本身由消费端关闭。跳转或解绑取消旧写入，迟到完成不能提交旧时间轴，也不能误报新显示失败。GPU 的租约仍等待真实 GPU 完成及 `allReferencesReleased`，不能与 CPU 信用额度混用。初次接入见 [CPU video 记录](reviews/macos-cpu-video-integration-2026-10-26.md)，本次私有通道、CPU 收益和 4K 工作集代价见 [配对实测](performance/macos-cpu-private-frame-channel-2026-10-27.md)。

Mac CPU video 保留生产者的单调时间戳，只有交付等待转换到页面时钟；提交按实际视频帧回调串行背压，避免本地 MediaStream 突发写入覆盖尚未呈现的帧。CPU 消费等待沿用复制通道的五秒预算，GPU 固定色块自检仍为 1.5 秒。视频帧回调仅用于 CPU 消费背压，不代表物理扫描输出或 GPU 资源最终释放。

Mac video 的固定色块自检仍通过实际挂载的显示元素：暂时隐藏合成色块，等待视频帧回调后以一次临时 sRGB Canvas 读取固定样本，随后销毁该流并恢复影片流；影片帧等待自检结束。正常播放没有逐帧 Canvas 读回。Electron 固定为 44.9.3，其中共享 VideoFrame 的跨线程释放修复是此消费者的前提；不在旧 43.8.1 上开启。

该 addon 只允许宿主的 Node 主线程初始化。mpv 的帧通知与非视频事件经长度为一的非阻塞队列合并唤醒该线程，几何、可见性、时间线变化及租约归还也能唤醒；mpv 回调不执行 JS 或 GL。250ms 兜底继续处理故障、背压及事件，正常 200ms 状态观察保留，但不再为这个自驱动后端另设 16ms 渲染检查。兜底不是视频帧率上限，字幕、暂停 seek 和隐藏时的 skip 仍由正常内核处理。

GPU 生产端必须确认实际完成后交付：Windows／macOS／Linux 均使用 `glFinish` 确认渲染完成。三平台 GPU／CPU 在 preload 将 VideoFrame 写入 MediaStreamTrackGenerator，GPU 使用原始导入帧，CPU 使用私有像素帧，video 使用独立视频合成通路，不经过正常 Canvas 缓存绘制。暂停仍显示最后一帧；换时间轴取消旧观察及待提交任务，保留同一流和最后画面等待新帧，避免连续跳转闪黑；仍在自检时重置隐藏测试流。解绑和停止重置流并停止旧轨道。消费端关闭 VideoFrame 后，从 `subtle.release` 的 GPU 完成回调确认释放；main 再释放源引用，最后在 `allReferencesReleased` 中归还原生租约。提交回执、`drawImage`、writer.write 或视频呈现回调、转移消息已发送都不能提前复用槽位。窗口正常停止仍接收迟到释放；交付结果不明时隔离最多三张未确认表面，最终由应用退出清理。可检测图形故障可在保留原 GPU 租约的同时切换独立 CPU 输出；renderer 页面关闭不触发回退，不能靠软件模式恢复已经消失的页面。

macOS 输出固定为 8-bit BGRA、opaque、BT.709 primaries／sRGB transfer／RGB full range，并将相同标记交给 Electron。CPU 的 RGBA 字节按不透明 `RGBX` 包装，明确设置 BT.709 primaries／sRGB transfer／RGB full range；GPU video 保留导入帧的相同标记。HDR 由 libmpv 映射到该 SDR 目标，不提供 HDR 直通或广色域保证。原生生产者仍是 OpenGL；Chromium 的 ANGLE Metal 消费后端不代表 IOSurface 本身是 Metal，也不证明全链路零拷贝或物理扫描输出。旧 Canvas 与原生视图的对照保留在 [历史正式化记录](reviews/macos-canvas-default-2026-10-23.md)。当前 video 接入、Electron 44.9.3 前置条件和实际验证边界见 [接入记录](reviews/macos-video-consumer-integration-2026-10-26.md)，构建与验证入口见[开发指南](DEVELOPMENT.md#内置播放运行库)。

Linux GPU 模式在 X11 和 Wayland 下均使用隔离 helper 导出 DMA-BUF，由 Electron 导入并提交到主窗口 video。主进程按 Chromium 报告的活动 GPU PCI vendor/device 唯一匹配候选 DRM render node，无法唯一匹配时停止创建播放内核；不按 renderD128 的编号推断消费设备。显式 `JAVDEX_DRM_RENDER_NODE` 或 Chromium `--render-node-override` 仍用于本机对照，不能据此推定跨 GPU 导入可用。helper 优先分配线性缓冲；设备不支持时，在具备显式 modifier 导入能力的前提下分配原生布局，核对单平面 BGRA、实际大小并传递真实 modifier。生产端 `glFinish`、三槽租约及消费端引用释放后的 ACK 仍共同约束复用。`--javdex-x11` 仅选择窗口系统，不再启用 X11 原生子窗口；CPU 回退仍使用同一 video 消费者。

默认不强制更换 Chromium 所选 GPU。应用内部目标是同卡解码／绘制与纹理消费；Chromium 窗口到桌面／显示器的呈现由系统与驱动负责。活动设备枚举是选卡依据，不是同卡互通的独立证明：helper 验证实际 EGL render node（扩展可用时），启动自检验证导入像素，验收另记录 Chromium renderer 与 producer 身份。显式环境变量可能使枚举和实际 renderer 不一致，不能用候选匹配代替实测。强制 Intel 向 NVIDIA 桌面呈现的失败归入系统兼容性边界，不阻塞已验证的 NVIDIA 同卡默认路径；纯 Intel／AMD 完整链路仍待实机验证。播放器 CPU 回退不保证救回窗口创建阶段的主进程崩溃。

X11 的固定 Vulkan 消费路径在冷启动时可能短暂报告软件合成。首次打开影片前最多等待两秒，随后仍由原来的严格设备检查决定是否可用；软件启动和手动 CPU 不等待。等待期间停止或换片不能创建旧会话或申请旧媒体授权。Linux GPU 预算结合处理成本与持续上游丢帧学习会话下限，保留原有上下界，且同一 helper 跳转时保留下限。详细计时、重置和安全边界见 [Linux 兼容播放](LINUX_COMPATIBLE_PLAYBACK.md)；这些统计不等于物理呈现反馈。

实验黑屏诊断须区分 producer、导入的 VideoFrame、Canvas 与最终屏幕。Linux 的 `submittedFrames` 只计 video 提交回执，不是画面验收证据；不再填充 `presentedFrames`。`JAVDEX_TEXTURE_PIXEL_DIAGNOSTICS=1` 默认关闭，只对输出纹理为 640×360 的前三个指定间隔帧读取有界像素摘要；媒体自身的宽高不能证明 viewport 纹理符合采样条件。触发按符合尺寸的帧数计算，避免初始化 viewport 提前耗尽绝对帧号。读回可能改变同步或 Canvas 后端，修复验收应关闭该开关，并检查真实窗口画面、持续播放、暂停恢复、跳转、字幕、缩放及重开。

远程播放的会话 URL、授权续期、内外两类代理池及回收规则集中维护在[服务端合同](SERVER_MODE_CONTRACT_INVENTORY.md#保留的边界与限制)。AI 音频读取复用播放会话 URL；切换、停止、失败和断开时取消旧读取，迟到回调不能恢复已释放地址。

## 代码与验证入口

| 职责 | 入口 |
| --- | --- |
| 会话与业务副作用 | [desktopPlayback.ts](../apps/desktop/src/main/player/desktopPlayback.ts)及同目录测试 |
| 内核包装 | [libmpvPlayback.ts](../apps/desktop/src/main/player/libmpvPlayback.ts)、[native](../apps/desktop/src/main/player/native) |
| 本机续播 | [playbackResumeStore.ts](../apps/desktop/src/main/player/playbackResumeStore.ts) |
| 返回与交互 | [路由规范](ROUTING_DESIGN.md#overlay-history) |
| Windows 原生验证 | [Windows 记录](BUILTIN_PLAYBACK_WINDOWS_ACCEPTANCE.md) |
| 字幕 fixture 与像素检查 | [字幕说明](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md)、[PGS 记录](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md) |
| 历史开发与平台适配 | [实施记录](reviews/builtin-playback-implementation-2026-10.md)、[平台记录](archive/playback/platform-validation-2026-10.md) |

按改动选择真实会话、原生关闭、素材、字幕或远程连接检查，命令见开发指南。已有记录不代表任意格式、声音听感、物理 GPU、跨屏设备或独立干净机器已经验收；正式分发的源码、许可及签名门禁仍独立执行。

Linux x86_64 当前新增 GPU/CPU 双运行库及手动模式和一次自动回退；构建、边界与验收约定见 [Linux 兼容播放](LINUX_COMPATIBLE_PLAYBACK.md)。既有第一阶段测试包保留为基线。
