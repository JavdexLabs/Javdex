# 内置播放合同

桌面播放器在主窗口中使用 libmpv，支持本机和远程资料库的文件资源；服务器不解码或转码。日常操作见[播放指南](../website/src/content/docs/guides/playback.md)，构建与分发见[开发指南](DEVELOPMENT.md#内置播放运行库)。

## 默认行为与来源

- 新设置默认内置播放并开启本机续播；已有显式播放方式、程序路径及续播设置保持。外部播放须配置程序路径，失败不自动换播放器或资源。
- 本机文件由主进程核对媒体库、影片、资源、根目录及可用性。远程文件经服务端授权及本机代理读取原始 Range 流，长期管理凭据和播放地址不交给 Renderer。
- 网页、Magnet、ED2K 等非文件链接继续由外部应用处理，不把“已交给系统”当作内置解码成功。
- 内置播放只有在真实输出画面且时钟推进后才记录最近播放或执行“稍后观看”的播放后移除；暂停首帧和续播选择不算开始。异步完成不能跨资料库产生副作用。

## 展示与交互

展开、底栏实时小视频和全屏使用同一播放会话；切换展示不重开影片。恢复同一资源不从头播放，停止后释放播放内核和画面占位。标题栏、设置、轨道、字幕及基础控制复用现有面板，不另建三套产品界面。

系统后退统一收起播放并关闭播放设置，保留会话与当前业务页面；Esc 依次关闭设置、退出全屏、收起播放。图片、播放与设置离开保护共同遵守[共享返回合同](ROUTING_DESIGN.md#overlay-history)，组件订阅或 Effect cleanup 不写历史。输入框、中文 IME、弹层和平台导航组合键优先于播放快捷键。

音量、倍速、章节、选轨、定位和播放信息读取内核实际状态。未知时长不显示虚假百分比；ASS 与图像字幕不套用纯文本字号能力。手动字幕与 AI 字幕选择不能被迟到命令覆盖。

## 续播与隐私

续播点只保存在本机，按资料库、资源及修订的摘要身份隔离，不保存路径或授权。全局开关与全部进度清除保留，不再提供单次临时不记录或单资源清除入口。有效进度先准备暂停画面，再由用户选择继续或从头；收起不是停止，也不是新的续播记录。

最近播放是另一份本机历史：独立快照、容量和删除规则见[开发指南](DEVELOPMENT.md#数据格式与数据库迁移)。两者都不属于服务端资料、跨设备同步或资料库备份，也不能形成清单引用保护。

## 原生与远程边界

共用核心拥有 mpv 生命周期、异步命令、状态、事件和字幕叠加层；macOS 使用 IOSurface 共享纹理到 Canvas，Windows 默认使用 D3D11 共享纹理到主窗口 Canvas，并提供 CPU 内存帧到 Canvas 的兜底；旧 HWND 显示和原生工具栏已移除；Linux 的 X11／XWayland 和原生 Wayland 共用共享纹理／CPU 内存帧到 Canvas 的显示方式。正常关闭由实际接受的窗口关闭与退出生命周期释放内核，不在可能被否决的 `close` 回调提前拆除活跃视图。

Windows 在图形初始化失败、可检测的原生视频渲染／共享纹理故障，或 Electron 已禁用硬件加速时，自动改用同一运行库中的独立 CPU 后端；`--javdex-cpu` 可在启动时强制使用它（`--` 后不生效）。该后端使用 `hwdec=no`、libmpv SW Render API 和复制的 RGBA 帧，preload 在新建的软件 Canvas 上通过 `putImageData` 绘制，防止继承失效的加速画布；不创建 GL context、D3D 设备或共享 GPU 纹理。最多两帧在途，与 Linux 一样按 `round(逻辑尺寸 × 缩放)` 渲染实际显示帧，不额外降至 1080p；保留单边 8192、单帧 256 MiB 的安全边界，超出时拒绝。高分辨率输入仍由 CPU 解码，流畅度取决于处理器和编码复杂度，不提供 HDR 直通保证。

回退复用当前已授权来源，重新打开后恢复可定位资源的位置、暂停／播放意图、音量、静音、倍速、音轨、外挂字幕和 AI 字幕时间轴；停止或新来源取消旧恢复。一次图形故障后，本次应用运行继续使用 CPU，重启才重新尝试 GPU。旧 GPU 的未知租约保持隔离，不强行复用；页面已关闭、媒体／授权／音频错误及 CPU 自身故障不进入反复回退。线程被驱动完全挂死等不可检测故障不保证进程内恢复。实测与边界见 [Windows CPU 记录](reviews/windows-cpu-fallback-2026-10-24.md)。

macOS 正常构建和启动使用唯一的共享纹理 Canvas2D 路径，无需试验参数；旧 NSOpenGLView 显示后端及其原生全屏控件已移除。`playback.node` 在主进程以 CGL/OpenGL 把 libmpv 输出写入三槽 IOSurface；`hwdec=auto` 保持原策略，不使用 Linux DMA-BUF、CPU 回退或原生子窗口。Electron 在主进程导入当前进程的 IOSurfaceRef，随后用公开的 `SharedTextureImportedSubtle` 转移对象交给隔离 preload；原始指针不进入应用 JSON、页面或共用播放合同。Canvas、全屏、键盘、滑杆与焦点使用现有 HTML 面板。

该 addon 只允许主线程初始化。mpv 的帧通知与非视频事件经长度为一的非阻塞队列合并唤醒主线程，几何、可见性、时间线变化及租约归还也能唤醒；mpv 回调不执行 JS 或 GL。250ms 兜底继续处理故障、背压及事件，正常 200ms 状态观察保留，但不再为这个自驱动后端另设 16ms 渲染检查。兜底不是视频帧率上限，字幕、暂停 seek 和隐藏时的 skip 仍由正常内核处理。

生产端以 `glFinish` 建立完成边界。Canvas2D 使用 `copy` 覆盖，解绑清理 backing store。消费端关闭 VideoFrame 后，从 `subtle.release` 的 GPU 完成回调确认释放；main 再释放源引用，最后在 `allReferencesReleased` 中归还原生租约。提交回执、`drawImage`、转移消息已发送都不能提前复用槽位。窗口正常停止仍接收迟到释放；消费进程崩溃或交付结果不明时隔离最多三张未确认表面，需退出应用清理，不猜测已释放或静默换 CPU。正式采用不代表这类故障可自动恢复。

macOS 输出固定为 8-bit BGRA、opaque、BT.709 primaries／sRGB transfer／RGB full range，并将相同标记交给 Electron，Canvas 为 `alpha:false, colorSpace:srgb`。HDR 由 libmpv 映射到该 SDR 目标，不提供 HDR 直通或广色域保证。原生生产者仍是 OpenGL；Chromium 的 ANGLE Metal 消费后端不代表 IOSurface 本身是 Metal，也不证明全链路零拷贝或物理扫描输出。既有短时对照的播放态 CPU 高于旧原生视图；采用此路径是统一合成与交互的取舍，不是性能优化结论。范围与证据见 [正式化记录](reviews/macos-canvas-default-2026-10-23.md)，构建与验证入口见[开发指南](DEVELOPMENT.md#内置播放运行库)。

Linux GPU 模式在 X11 和 Wayland 下均使用隔离 helper 导出 DMA-BUF，由 Electron 导入并绘制到主窗口 Canvas。主进程按 Chromium 活动 GPU 的 PCI vendor/device 匹配 DRM render node，无法唯一匹配时停止创建播放内核；不按 renderD128 的编号推断消费设备。显式 `JAVDEX_DRM_RENDER_NODE` 或 Chromium `--render-node-override` 仍用于本机对照，不能据此推定跨 GPU 导入可用。helper 优先分配线性缓冲；设备不支持时，在具备显式 modifier 导入能力的前提下分配原生布局，核对单平面 BGRA、实际大小并传递真实 modifier。生产端 `glFinish`、三槽租约及消费端引用释放后的 ACK 仍共同约束复用。`--javdex-x11` 仅选择窗口系统，不再启用 X11 原生子窗口；CPU 回退仍使用同一 Canvas。

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
