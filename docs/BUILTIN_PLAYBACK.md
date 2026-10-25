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

展开／全屏 Canvas 的双击只切换展示，保持原播放、暂停或结束状态。主进程提供运行时点击时序：Electron 43 / Chromium 150 的 Windows／Linux Aura 路径为 500ms，macOS 通过系统自带解释器只读查询 AppKit `NSEvent.doubleClickInterval`；不以桌面设置或浏览器 UA 猜测其它平台的规则。查询有 2 秒超时，失败时采用保守的 5 秒单击等待上界，明确控件和键盘仍即时执行。窗口重新获得焦点时刷新，renderer 手势 hook 等待该结果并增加 50ms 投递余量；已取消的手势不能被迟到结果重新调度。

浏览器在第二次按下给出多击计数时立即取消单击，不等待松开。独立的新单击确认前一单击，键盘激活即时执行。明确播放／暂停、重播、续播选择、停止、展示切换及历史收起取消旧手势；静音、音量、跳转、倍速和选轨保留原单击意图。命令发送不承担手势取消策略；换片、画面通道变化、错误和卸载由 hook 清理。输入复检与平台边界见[验收记录](reviews/linux-mouse-navigation-2026-10-25.md)，浏览器回归入口为 `node scripts/playback-pointer-ui-check.mjs`，GNOME 原生多击计数入口为 `npm run test:playback:pointer:native`。

音量、倍速、章节、选轨、定位和播放信息读取内核实际状态。未知时长不显示虚假百分比；ASS 与图像字幕不套用纯文本字号能力。暂停时重选字幕，在内核确认选轨后刷新原位置；保持暂停，不重开会话，也不绕过续播选择或不可定位限制。手动字幕与 AI 字幕选择不能被迟到命令覆盖。

## 续播与隐私

续播点只保存在本机，按资料库、资源及修订的摘要身份隔离，不保存路径或授权。全局开关与全部进度清除保留，不再提供单次临时不记录或单资源清除入口。有效进度先准备暂停画面，再由用户选择继续或从头；收起不是停止，也不是新的续播记录。

最近播放是另一份本机历史：独立快照、容量和删除规则见[开发指南](DEVELOPMENT.md#数据格式与数据库迁移)。两者都不属于服务端资料、跨设备同步或资料库备份，也不能形成清单引用保护。

## 原生与远程边界

共用核心拥有 mpv 生命周期、异步命令、状态、事件和字幕叠加层；macOS 使用 IOSurface 共享纹理到 Canvas，Windows 默认使用 D3D11 共享纹理到主窗口 Canvas，并提供 CPU 内存帧到 Canvas 的兜底；旧 HWND 显示和原生工具栏已移除；Linux 的 X11／XWayland 和原生 Wayland 共用共享纹理／CPU 内存帧到 Canvas 的显示方式。正常关闭由实际接受的窗口关闭与退出生命周期释放内核，不在可能被否决的 `close` 回调提前拆除活跃视图。

三平台采用同一“自动 / GPU / CPU 兼容”设置，在重新打开影片时应用。自动模式优先 GPU，图形初始化、自检或可检测运行故障最多触发一次 CPU 恢复；GPU 模式失败直接报告错误；CPU 模式使用软件解码和绘制。显式选择 GPU 后重开可重新探测。`--javdex-cpu` 可强制使用 CPU（`--` 后不生效）。未发布设置直接使用 `playbackRenderMode`，不读取或迁移旧平台专属字段。

CPU 使用 `hwdec=no`、libmpv SW Render API 和 opaque RGBA，preload 通过新建的软件 Canvas 的 `putImageData` 绘制，不创建播放端 GL context 或 D3D 设备。三平台共用实际物理尺寸 `round(逻辑尺寸 × 缩放)`，不额外降至 1080p；保留缩放不超过 8、单边 8192、单帧 256MiB 的安全边界。Windows/macOS 复制帧最多两帧在途，复制信用额度跨宿主和接收方共同约束；Linux 沿用三个槽位的有界 memfd／ACK 传输池。

`PlaybackEngine` 复用当前已授权来源，恢复位置、暂停意图、音量、静音、倍速、音轨、外挂字幕和 AI 时间轴；恢复中的新控制意图优先，停止或换片取消旧恢复。媒体、授权、音频和页面错误不触发图形回退；软件解码与 CPU 画面输出分别报告。未知 GPU 租约不强行回收，迟到回调继续归属原宿主与资源代。

图形初始化包括创建设备、检查导入能力、构造桥接和启动宿主；部分创建失败的桥接由工厂负责清理。播放进程通信及帧 IPC 回调中的故障必须进入可读取的受控失败状态，CPU 侧故障不再次恢复。接收器／首帧等待从请求显示开始计时，隐藏期间不消耗这段等待预算。环境与故障阶段检查见[回退审计](reviews/playback-fallback-audit-2026-10-24.md)。

应用启动使用三平台共用的独立保护：在主窗口首次显示前，明确的 GPU 进程崩溃、异常退出、启动失败或完整性失败，允许主实例自动重启一次；重启前等待已开始的初始化与既有退出清理完成。新进程关闭 Electron 硬件加速并强制 CPU 视频，保留显示后端、用户目录与其他启动参数，不改写播放设置。一次性标记防止第二次自动重启；恢复后的提示允许用户主动重试 GPU。正常窗口显示后的 GPU 故障仍由播放引擎处理，普通初始化／数据库／加载错误、用户退出、单实例拒绝以及 OOM 不作为自动切换依据。详细实现与真实验收见[启动保护记录](reviews/startup-graphics-recovery-2026-10-24.md)。

`--javdex-software` 是三平台的手动软件启动入口，同时关闭界面硬件加速并选择 CPU 视频；`--javdex-cpu` 只强制视频 CPU。两者均只解析 `--` 之前的参数。进程在入口代码执行前直接崩溃、操作系统杀死主进程或驱动使主进程完全失去响应时，不保证自动恢复，也不安装常驻守护进程。

Windows/macOS 的 libmpv、GL 和软件生产者运行在独立 utility process；主进程只加载不链接 libmpv/GL/D3D 的资源互操作模块。Windows 复制子进程 NT 共享句柄，macOS 用 Mach right 传递 IOSurface；以每次分配的资源 ID 区分同一槽的后续分配，接收方保持稳定导入，直到实际引用释放后才退休。宿主退出或 5 秒无心跳按统一规则处理，关闭超时由主进程终止，不让原生调用阻塞界面。Linux 继续使用独立 helper、私有管道和 FD 通道；绑定变化直接通知可见性，不再依赖会话的 16ms 轮询。

GPU/CPU 均以 BT.709 primaries、sRGB transfer、RGB full-range 的 8-bit SDR 为显示目标，参考白为 203nit，HDR 采用固定元数据和 BT.2390，不启用动态峰值统计。CPU 在解码后、字幕合成前进行色彩转换，避免改变字幕颜色；不依赖 GL 或额外色彩运行库。缺失 PQ 亮度元数据按共同默认值处理。共同色彩验收入口为 `scripts/playback-color-fixtures.mjs` 与 `scripts/playback-color-acceptance.mjs`，GPU/CPU 输出允许最多 4 个字节值差异；截图不证明物理 HDR 输出或显示器校准。

普通 BT.709 SDR 不需要色域或色调映射时，CPU 采用 16-bit 平面 RGB 每通道查表，避免在最终软件缩放及输出前重复量化；查表线程不超过可用逻辑核的一半且最多四个，给解码、缩放和界面留出资源。HDR 和其他色域继续使用 RGB16/四面体三维转换。软件画面按同一 bilinear 策略配置 swscale 与可用的 zimg，保留实际物理视口及帧内存上界。色彩数值验收读取显示器色彩转换前的 sRGB Canvas，窗口截图另行留存；两种取像来源不能混作同一比较基准。最终输出为 8-bit，低于一个字节值的参考灰阶允许量化为同一值；仍检查灰阶顺序、可分辨层次及原像素误差门槛。

帧绑定与时钟交换由 `frameEndpoint.ts` 统一认证主 frame；预算和已知色块自检由共用模块处理。自检通过真实纹理/Canvas 通道采样固定 640×360 色块，不检查任意影片的黑色内容。异步复制中的帧保留独立时间信息，切换时间轴不能清零待发送帧的时间戳。应用生成字幕采用系统默认字体（`sans-serif`）；外挂 ASS 和内嵌字体保留片源样式。


macOS 正常构建和启动默认使用共享纹理 Canvas2D，无需试验参数；旧 NSOpenGLView 显示后端及其原生全屏控件已移除。GPU 路径的 `playback.node` 在隔离宿主以 CGL/OpenGL 把 libmpv 输出写入三槽 IOSurface，`hwdec=auto` 保持原策略；独立 `software` 导出提供 CPU 回退，不使用 Linux DMA-BUF 或原生子窗口。资源互操作模块先接收 Mach right 并获取本进程 IOSurfaceRef，Electron 再在主进程导入，随后用公开的 `SharedTextureImportedSubtle` 转移对象交给隔离 preload；原始指针不进入应用 JSON、页面或共用播放合同。Canvas、全屏、键盘、滑杆与焦点使用现有 HTML 面板。

该 addon 只允许宿主的 Node 主线程初始化。mpv 的帧通知与非视频事件经长度为一的非阻塞队列合并唤醒该线程，几何、可见性、时间线变化及租约归还也能唤醒；mpv 回调不执行 JS 或 GL。250ms 兜底继续处理故障、背压及事件，正常 200ms 状态观察保留，但不再为这个自驱动后端另设 16ms 渲染检查。兜底不是视频帧率上限，字幕、暂停 seek 和隐藏时的 skip 仍由正常内核处理。

GPU 生产端以 `glFinish` 建立完成边界。Canvas2D 使用 `copy` 覆盖，解绑清理 backing store。消费端关闭 VideoFrame 后，从 `subtle.release` 的 GPU 完成回调确认释放；main 再释放源引用，最后在 `allReferencesReleased` 中归还原生租约。提交回执、`drawImage`、转移消息已发送都不能提前复用槽位。窗口正常停止仍接收迟到释放；交付结果不明时隔离最多三张未确认表面，最终由应用退出清理。可检测图形故障可在保留原 GPU 租约的同时切换独立 CPU 输出；renderer 页面关闭不触发回退，不能靠软件模式恢复已经消失的页面。

macOS 输出固定为 8-bit BGRA、opaque、BT.709 primaries／sRGB transfer／RGB full range，并将相同标记交给 Electron，Canvas 为 `alpha:false, colorSpace:srgb`。HDR 由 libmpv 映射到该 SDR 目标，不提供 HDR 直通或广色域保证。原生生产者仍是 OpenGL；Chromium 的 ANGLE Metal 消费后端不代表 IOSurface 本身是 Metal，也不证明全链路零拷贝或物理扫描输出。既有短时对照的播放态 CPU 高于旧原生视图；采用此路径是统一合成与交互的取舍，不是性能优化结论。范围与证据见 [正式化记录](reviews/macos-canvas-default-2026-10-23.md)，构建与验证入口见[开发指南](DEVELOPMENT.md#内置播放运行库)。

Linux GPU 模式在 X11 和 Wayland 下均使用隔离 helper 导出 DMA-BUF，由 Electron 导入并绘制到主窗口 Canvas。主进程按 Chromium 活动 GPU 的 PCI vendor/device 匹配 DRM render node，无法唯一匹配时停止创建播放内核；不按 renderD128 的编号推断消费设备。显式 `JAVDEX_DRM_RENDER_NODE` 或 Chromium `--render-node-override` 仍用于本机对照，不能据此推定跨 GPU 导入可用。helper 优先分配线性缓冲；设备不支持时，在具备显式 modifier 导入能力的前提下分配原生布局，核对单平面 BGRA、实际大小并传递真实 modifier。生产端 `glFinish`、三槽租约及消费端引用释放后的 ACK 仍共同约束复用。`--javdex-x11` 仅选择窗口系统，不再启用 X11 原生子窗口；CPU 回退仍使用同一 Canvas。

X11 的固定 Vulkan 消费路径在冷启动时可能短暂报告软件合成。首次打开影片前最多等待两秒，随后仍由原来的严格设备检查决定是否可用；软件启动和手动 CPU 不等待。等待期间停止或换片不能创建旧会话或申请旧媒体授权。Linux GPU 预算结合处理成本与持续上游丢帧学习会话下限，保留原有上下界，且同一 helper 跳转时保留下限。详细计时、重置和安全边界见 [Linux 兼容播放](LINUX_COMPATIBLE_PLAYBACK.md)；这些统计不等于物理呈现反馈。

实验黑屏诊断须区分 producer、导入的 VideoFrame、Canvas 与最终屏幕。Linux 的 `submittedFrames` 只计 Canvas 提交回执，不是画面验收证据；不再填充 `presentedFrames`。`JAVDEX_TEXTURE_PIXEL_DIAGNOSTICS=1` 默认关闭，只对输出纹理为 640×360 的前三个指定间隔帧读取有界像素摘要；媒体自身的宽高不能证明 viewport 纹理符合采样条件。触发按符合尺寸的帧数计算，避免初始化 viewport 提前耗尽绝对帧号。读回可能改变同步或 Canvas 后端，修复验收应关闭该开关，并检查真实窗口画面、持续播放、暂停恢复、跳转、字幕、缩放及重开。

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
