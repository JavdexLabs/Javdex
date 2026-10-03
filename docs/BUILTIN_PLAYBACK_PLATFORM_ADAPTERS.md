# 内置播放 Windows / Linux 平台适配研究

研究日期：2026-10-03。目标仍是三平台实现，主窗口展开、底栏实时视频和全屏共用一份 libmpv 会话；当前验收范围按任务限定为 macOS，Windows / Linux 验收暂缓。本研究只读取源码和一手资料，未编译、启动 GUI、播放或复核任何平台验收，未安装或下载运行库。

## 1. 本地定位事实

已先读 [AGENTS.md](../AGENTS.md)。下表是工作区观察，不能解读为完成或验收证据。

| 定位 | 读取时的状态 |
| --- | --- |
| [package.json](../package.json)、[package-lock.json](../package-lock.json) | Electron 均锁定 `43.4.1`；对应官方 [DEPS](https://github.com/electron/electron/blob/v43.4.1/DEPS) 锁定 Chromium `150.0.7871.224`。下文窗口 ABI 据此核对。 |
| [libmpvPlayback.ts](../apps/desktop/src/main/player/libmpvPlayback.ts) | `Bridge` 为 create / bounds / visible / presentation / command / render / state / destroy；availability 仅放行 darwin，viewport 已乘页面 zoom。 |
| [macPlayback.mm](../apps/desktop/src/main/player/native/macPlayback.mm) | `NSView*` + `NSOpenGLView`；handle 校验 `sizeof(void*)`；一个 core / render context；异步命令、原子更新通知、主循环 render；尚未传入 advanced-control。 |
| 同一 [macPlayback.mm](../apps/desktop/src/main/player/native/macPlayback.mm) | `nativeFrames` 随 render 调用递增，`presentedFrames` 在更新帧、未 hidden 且已 loaded 时递增；全屏原生控件、焦点和 actions 也在此文件，不能只移植 GL 绘制便认定交互等价。 |
| [build-playback-native.mjs](../scripts/build-playback-native.mjs)、[nativePlayback.ts](../apps/desktop/src/main/player/nativePlayback.ts) | 开发构建仅 darwin；已有私有会话 seam。共用核心、构建及现有 seam 改造由主 Agent 负责。 |

libmpv 合同引用固定的 **mpv v0.40.0** 官方头文件，便于复查；这不是对本地或未来打包运行库版本的认定，实施时须对目标实际头文件、ABI 和构建选项复核。

## 2. 平台事实：Electron 原生 handle

公开 [BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window#wingetnativewindowhandle) 将 Windows 写为 HWND、Linux 写为 `Window (unsigned long)`；本版本源码实际把 `NativeWindowHandle` 的原始字节复制到 Buffer，而非转换成统一指针。[BaseWindow 实现](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_base_window.cc#L785-L791)、[类型声明](https://github.com/electron/electron/blob/v43.4.1/shell/browser/native_window.h#L54-L58)

| 实际 backend | 43.4.1 返回值 | 一手依据 |
| --- | --- | --- |
| Windows | `HWND`，Buffer 宽度为该架构 `sizeof(HWND)` | [Chromium 类型](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/gfx/native_ui_types.h#L217-L237)、[Electron 转发](https://github.com/electron/electron/blob/v43.4.1/shell/browser/native_window_views.cc#L1744-L1753) |
| Linux X11，包括 Electron 运行于 XWayland | `uint32_t` AcceleratedWidget，语义为 X11 XID；Buffer **4 字节**，再扩展成 Xlib 的 `Window` | [Ozone 类型](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/gfx/native_ui_types.h#L235-L237)、[X11Window::GetWidget](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/ozone/platform/x11/x11_window.cc#L485-L491) |
| Linux 原生 Wayland | 同为 4 字节，但语义为 Chromium 自增的内部 widget 编号；**不是 XID，也不是 `wl_surface*`** | [WaylandWindow widget 来源](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/ozone/platform/wayland/host/wayland_window.cc#L91-L100)、[编号分配](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/ozone/platform/wayland/host/wayland_window_manager.cc#L316-L318) |

完整转发链为 Electron NativeWindowViews → Aura host → 平台 AcceleratedWidget；Aura 只存取平台传入的值。[Aura 实现](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/aura/window_tree_host_platform.cc#L118-L120)

由此推论：复制 macOS 的指针长度校验会拒绝 64 位 Linux 的正确 Buffer；把 Wayland 编号传入 Xlib 可能访问无关资源。必须区分 backend 后解码，不能用 `WAYLAND_DISPLAY` 是否存在或一次 XID 查询替代可靠的 backend 身份。

Electron 从 38 起默认 ozone-platform=auto，在 Wayland session 默认原生 Wayland；官方给出的 XWayland 选择是 `--ozone-platform=x11`，旧 `ELECTRON_OZONE_PLATFORM_HINT` 已移除。[43.4.1 breaking changes](https://github.com/electron/electron/blob/v43.4.1/docs/breaking-changes.md#removed-electron_ozone_platform_hint-environment-variable)

## 3. 平台事实：Windows

- `CreateWindowExW(..., WS_CHILD, ..., parentHwnd, ...)` 可直接创建子窗口；子窗口 x/y 相对父窗口 client area，尺寸为 device units。[CreateWindowExW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexw)
- OpenGL 窗口的 pixel format 只能设置一次；应使用独立 child DC，窗口带 `WS_CLIPCHILDREN | WS_CLIPSIBLINGS`，不可用 `CS_PARENTDC`。这支持为视频创建自有 child，而不是修改 Electron 父窗口的 pixel format。[SetPixelFormat](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-setpixelformat)
- WGL context 必须在调用 GL 的线程 current；同一 context 同时只能属于一个线程，换 DC 要同设备、同 pixel format。[wglMakeCurrent](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-wglmakecurrent)
- 扩展入口依赖 current context，地址与 pixel format 相关；现代版本/profile 可由 `wglCreateContextAttribsARB` 请求。libmpv 的 resolver 要补齐平台 resolver 不提供的标准 GL 函数。[wglGetProcAddress](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-wglgetprocaddress)、[WGL_ARB_create_context](https://registry.khronos.org/OpenGL/extensions/ARB/WGL_ARB_create_context.txt)、[render_gl.h](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render_gl.h#L106-L118)
- `SetFocus` 要求目标在调用线程的消息队列；独立视频 HWND 的输入不能假设会继续到 DOM。焦点切回 WebContents 可使用 Electron 的 `focusOnWebView()`。[SetFocus](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setfocus)、[Electron API](https://www.electronjs.org/docs/latest/api/browser-window#winfocusonwebview)
- 子窗口 DPI awareness 与父窗口一致；`GetDpiForWindow` 取该窗口 awareness 对应的 DPI，per-monitor 下随显示器变化，`WM_DPICHANGED` 指示新缩放。`SetParent` 在 awareness 不同的窗口间可能失败或重置 DPI 状态。[DPI 模型](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-improvements-for-desktop-applications)、[GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)、[WM_DPICHANGED](https://learn.microsoft.com/en-us/windows/win32/hidpi/wm-dpichanged)、[SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)
- 父窗口销毁会自动销毁 child / owned windows；`DestroyWindow` 不能由非创建线程调用，子窗口会收到 `WM_DESTROY / WM_NCDESTROY`。[DestroyWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-destroywindow)
- WGL 成功不等于直接硬解互操作：所查 libmpv GL 合同对 Windows 直接硬解要求 ANGLE；copy-back 可单独评估，`hwdec=auto-copy` 会把解码结果拷回 RAM，亦可能回退软件解码。[硬解合同](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render_gl.h#L81-L100)、[hwdec 选项](https://github.com/mpv-player/mpv/blob/v0.40.0/DOCS/man/options.rst#L1285-L1431)

## 4. 平台事实：Linux

### X11 / GLX

- X11 支持以给定 parent XID 创建 InputOutput 子窗口；坐标是 parent 内部原点的像素。visual/depth 须为该 screen 支持的组合，child depth 不必等于 parent；不能直接假设 Electron 的 visual 适合 GL。[XCreateWindow](https://www.x.org/releases/current/doc/man/man3/XCreateWindow.3.xhtml)
- GLX 用选定 visual 建 context 和 drawable；current drawable/context 的 screen、visual 不匹配会 BadMatch，context 已 current 于另一线程会 BadAccess。[GLX 概述](https://xorg.freedesktop.org/archive/X11R6.8.0/doc/glXIntro.3.html)、[glXMakeCurrent](https://xorg.freedesktop.org/archive/X11R6.8.0/doc/glXMakeCurrent.3.html)
- 多线程并发 Xlib 需要成功的 `XInitThreads`，且它必须在该进程任何其他 Xlib 调用之前完成；全体调用已串行时可不启用。独立 Display 并不能消除“进程第一次调用”要求。Chromium 自己的 InitXlib 有 XInitThreads，但这不足以证明 addon 初始化顺序已满足。[Xlib threading](https://xorg.freedesktop.org/archive/current/doc/libX11/libX11/libX11.html#Using_Xlib_with_Threads)、[Chromium InitXlib](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/gfx/x/xlib_support.cc)
- 父窗口销毁也销毁全部 subwindows，并产生 DestroyNotify；此后不能再引用其 XID。[Xlib destruction](https://xorg.freedesktop.org/archive/current/doc/libX11/libX11/libX11.html#Destroying_Windows)
- libmpv 合同对 Intel/Linux 的直接硬解要求 EGL 和 native display；NVIDIA 路线中 GLX/EGL 均可能可用，VDPAU 路线要求 GLX。GLX 普通播放与 VAAPI 直接互操作应分别验证。[render_gl.h](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render_gl.h#L81-L100)

### 原生 Wayland / XWayland

- Wayland 有合法的 subsurface，适合窗口内视频；`get_subsurface` 需要 surface 和 parent surface。对象 ID 在 client 的 namespace 中解析，新开 `wl_display_connect` 不能凭 Electron 内部编号取得其 parent。[subsurface 协议](https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_subcompositor)、[对象 namespace](https://wayland.freedesktop.org/docs/html/apc.html#Server-structwl__client_1ab9d04dffa9409db43154230c64bc1f84)
- subsurface 默认同步模式，位置和层级随 parent commit 应用；parent 销毁会将其 unmap；subsurface 本身不取得 seat 的键盘焦点。[wl_subsurface](https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_subsurface)
- **可行性推论**：仅凭现有公开 handle + 独立 Wayland connection，无法实现归属于 Electron 主窗口的 EGL subsurface。若取得 Chromium 所属连接和合法 parent，并协调事件队列、commit、输入及销毁，协议本身允许嵌入；这需要新的 Electron 集成能力，不能靠强制类型转换补齐。[handle 编号源](https://github.com/chromium/chromium/blob/150.0.7871.224/ui/ozone/platform/wayland/host/wayland_window_manager.cc#L316-L318)、[Wayland client 队列规则](https://wayland.freedesktop.org/docs/html/apb.html)
- Electron 43.4.1 另有实验性 `sharedTexture.importSharedTexture / sendSharedTexture`，将 native handle 转为可供 Web 合成的 VideoFrame；Linux handle 用 nativePixmap planes / dmabuf FD / modifier。它是原生 Wayland 的候选合成路径，而不是 child-window API。[sharedTexture](https://github.com/electron/electron/blob/v43.4.1/docs/api/shared-texture.md)、[Linux handle](https://github.com/electron/electron/blob/v43.4.1/docs/api/structures/shared-texture-handle.md)
- 此候选仍需验证：该版本相关官方测试只在 macOS arm64 启用；底层资源必须保留至全部引用释放，GPU 完成与 FD/texture 重用要协调。API 声明不能当作 Linux 已播放的证明。[测试范围](https://github.com/electron/electron/blob/v43.4.1/spec/api-shared-texture-spec.ts#L12-L14)、[资源生命周期](https://github.com/electron/electron/blob/v43.4.1/docs/api/structures/shared-texture-imported.md)
- XWayland 可作为用户显式选择：须在 Electron 建窗前选择 `--ozone-platform=x11`，并有可用 XWayland/X display；它仍是 **X11 backend**。仅让 libmpv 子窗口走 XWayland，不能把它挂在原生 Wayland Electron parent 下。[Electron 选择方式](https://github.com/electron/electron/blob/v43.4.1/docs/breaking-changes.md#removed-electron_ozone_platform_hint-environment-variable)、[Wayland 嵌入限制](https://wayland.freedesktop.org/docs/book/Compositors.html#embedding-compositor)

## 5. libmpv 事实：上下文、异步调用与帧证据

- 播放启动前创建 render context；每 core 同时最多一个；在销毁 core 前释放 renderer。GL 调用须 current 于同一个 GL context，并串行执行 render API。[生命周期和线程合同](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render.h#L55-L123)
- update callback 只通知，不能在其中调用任何 mpv API；advanced-control=1 后需及时服务每轮通知的 update，通知也可能是解码分配任务，并不必然有视频帧。render 线程不得等待调用非安全 client API 的线程，否则可能硬死锁。[callback / update](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render.h#L618-L670)、[advanced-control](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render.h#L249-L287)
- `mpv_command_async` 返回成功只表示解析/入队成功；执行错误见 COMMAND_REPLY。async get/set、observe 及 timeout=0 的 wait_event 是 render-thread 安全例外；wait_event 对同一 handle 必须单消费者，事件数据要在下次取事件前复制。[异步命令](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/client.h#L965-L992)、[属性 API](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/client.h#L1094-L1228)、[事件读取](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/client.h#L1685-L1716)
- OPENGL_FBO 的 w/h 必须为 framebuffer 实际像素，fbo=0 表示默认 framebuffer；页面 CSS rect、Electron DIP 和 native framebuffer pixels 不能混作一个单位。[FBO 合同](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render_gl.h#L128-L145)
- render 可重绘旧帧；NEXT_FRAME_INFO 的 PRESENT 仅表示有待渲染帧，REDRAW / REPEAT 可区分重绘和重复。FILE_LOADED 仅说明已读头信息并开始解码，PLAYBACK_RESTART 主要标识起播或 seek 后重新初始化，均不证明屏幕呈现。[帧 flags](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render.h#L473-L519)、[事件语义](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/client.h#L1283-L1348)
- `report_swap` 是应用报告交换时间，不是 libmpv 检测显示器呈现；一旦使用须持续一致。WGL SwapBuffers 有 BOOL 成功值；GLX SwapBuffers 为 void，无双缓冲时无效果，交换也不必在函数返回前发生。[libmpv 报告](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render.h#L711-L723)、[SwapBuffers](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-swapbuffers)、[glXSwapBuffers](https://xorg.freedesktop.org/archive/X11R6.8.0/doc/glXSwapBuffers.3.html)
- 禁用 BLOCK_FOR_TARGET_TIME 后需自行按 target_time 调度，或设置 video-timing-offset=0；否则会影响音画同步。SKIP_RENDERING 可服务隐藏帧，但仍遵守 update、GL 与 timing 合同，不能计为可见呈现。[timing / skip](https://github.com/mpv-player/mpv/blob/v0.40.0/include/mpv/render.h#L300-L338)

## 6. 推荐接口与线程模型（设计建议，尚未实现）

保持已有 NativePlayback 会话 seam；将平台 surface 与共用 mpv 命令/观察核心分开，建议平台能力与生命周期采用以下信息，而非 `process.platform` 一个布尔值。

```ts
type Backend = 'cocoa' | 'win32-wgl' | 'win32-angle' | 'x11-glx' | 'x11-egl' | 'wayland-subsurface' | 'wayland-texture'
type HostIdentity = { backend: Backend; handle?: Buffer; generation: number }
type Viewport = { contentBoundsDip: Rect; visible: boolean; presentation: Presentation; revision: number }
// surface: attach(host), applyViewport(viewport), requestRender(),
//          readDiagnostics(), drainActions(), detach()
// GL owner: makeCurrent(), framebufferPixels(), getProcAddress(),
//           swapOrSubmit(), releaseContext()
```

- bounds 继续接收 TS 已乘 zoom 的 DIP；补上 WebContents 原点至 parent client area 的偏移。Windows 在正确 DPI awareness 下以 DPI/96 换算 pixels，X11 使用实际 window scale，并在 resize / 跨屏 / zoom / fullscreen 后重新计算；framebuffer 尺寸由 native drawable 回读，避免重复乘 zoom 或 DPR。
- Windows UI/创建线程拥有 child、WndProc、焦点和销毁；专用 GL owner 承担 current context 和 render/swap。X11 使用自有 Display、同 screen 的子窗口及 GLX drawable，集中串行处理 Xlib/GLX；并发或硬解库额外线程访问 Display 时先明确满足 XInitThreads 初始化顺序。
- callback 只置位并唤醒 GL owner；命令保持 async，state 仅从一个消费者维护缓存，inspect 不消耗队列。geometry/actions/diagnostics 用短锁或快照，render 线程不等 JS、UI 同步消息或 mpv 同步结果。
- hidden / minimized 时仍服务 advanced update；需要处理帧时 render 或 skip。advanced-control 保留显式配置，待线程不变量与关闭路径检查后启用，不作为复制粘贴的优化开关。
- 正常关闭应在主窗口允许关闭、parent 仍有效时启动，不能等到 closed：阻止新任务、解除/排空回调 → GL owner 在 context current 时 free renderer → 在控制侧销毁 core → 释放 GL/DC/Display 和自有 child。WM_NCDESTROY / DestroyNotify 作为失效兜底，先置 closing/generation 失效并停绘；异常销毁需预备兼容的清理 drawable，不能对失效 child 再 makeCurrent/swap。清理须幂等，避免在窗口消息回调里等待 mpv core。
- 展开/底栏/全屏只改变同一 surface 的位置、可见性和控件布局，不 loadfile、不重建 core。原生 child 区域的控件应单独安排 native 层级或留出视频外区域；actions、Tab、Esc、历史前后退和焦点恢复必须与现有会话接通。

## 7. 小范围可实施路径（交给主 Agent 的建议）

| 路线 | 最小落点 | 必须明确的边界 |
| --- | --- | --- |
| Windows WGL | 新增 `native/windowsPlayback.cpp`：注册自有 child class、独立 DC、双缓冲 pixel format、bootstrap 后加载现代 GL、render owner、native actions 和销毁通知；基础链接 user32 / gdi32 / opengl32。 | WGL 基础路径不承诺 ANGLE 直接硬解；保留后续 ANGLE/EGL surface 实现同一接口的空间。 |
| Linux X11 GLX | 新增 `native/linuxX11Playback.cpp`：验证真实 X11 parent、选 RGBA 双缓冲 visual / colormap、创建 InputOutput child、GLX context、事件与 render loop；基础链接 X11 / GL。 | parent 与 GLX drawable 的兼容性、Xlib 初始化、Expose / ConfigureNotify / DestroyNotify 单独处理；直接 VAAPI 路线另用 X11 EGL。 |
| 原生 Wayland direct | 新的 Electron/Ozone 桥接提供同连接合法 parent 与 surface 生命周期，再建 subsurface + EGL；surface 与 Chromium 的提交/输入协调。 | 超出现有公开 handle 的能力，需新 seam；不采用独立顶层窗口冒充嵌入，也不把此项归到“Linux 已实现”。 |
| 原生 Wayland texture | 独立 EGL/GBM 输出到可导出的 FBO，生成 dmabuf planes/modifier；主进程 import/send，受控 preload receiver 将 VideoFrame 合成至同一播放区域。 | EGL 导出扩展是能力要求，需验证 format/modifier、GPU 同步、frame 引用回收和背压；此路改变呈现 seam，属于候选，未经 Linux 验证。[EGL 导出规范](https://registry.khronos.org/EGL/extensions/MESA/EGL_MESA_image_dma_buf_export.txt)、[导入格式](https://github.com/electron/electron/blob/v43.4.1/docs/api/structures/shared-texture-import-texture-info.md) |
| 显式 XWayland 选项 | 启动选项在 ready / 建窗前选择 x11；必要时由用户重启后使用 X11 adapter。 | 需要可用 XWayland，不能静默更改全应用 backend；不能据此把原生 Wayland 从原任务删除。 |

共用改动路径：`native/` 的核心与 surface 契约 → `libmpvPlayback.ts` 的 backend/handle/能力诊断 → `scripts/build-playback-native.mjs` 的平台选择 → runtime / packaging 的平台产物闭包。文件名仅为建议，具体共用核心和构建设计由主 Agent 决定；本侧任务不修改这些文件。

建议分别记录“实现存在 / 构建通过 / 可见视频通过 / 交互通过 / 媒体与硬解通过”，availability 给出具体缺项；Win/Linux 验收暂缓不能等价为仅增加 unsupported 分支，也不能提前置为已验证。

## 8. 后续帧证据与验收建议（本次未执行）

| 层级 | 建议保留的证据 | 能证明什么 |
| --- | --- | --- |
| Core | session/core generation、loadedFiles、COMMAND_REPLY、time-pos、audio-pts、codec、hwdec-current | 同一会话加载/控制/解码状态；不能独立证明可见视频。 |
| Render | update flags、NEXT_FRAME_INFO flags、render 返回码、drawable pixels、单次 FBO readback | 渲染目标内有正确视频/字幕；区分新帧、重绘、skip，不能独立证明屏幕显示。 |
| Submit | 成功 WGL swap / GLX 交换提交及错误 / texture 提交、单调时间、viewport revision | 帧提交给系统/合成链；`report_swap` 和提交计数不能当作显示确认。 |
| Visible | 平台运行时另采实际主窗口/屏幕的视频区域像素，与诊断帧对照；播放时连续帧变化，暂停时稳定 | 视频确实在展开、实时底栏和全屏可见；黑底/静态占位、仅音频和 FBO 独立输出应识别出来。 |

`presentedFrames` 若为兼容保留，注明其为“可见状态下提交计数”；新增 `videoFrames / redraws / skips / swapSubmissions / renderErrors` 比改名宣称“真实呈现”更可信。诊断不能消耗正式事件/actions，常规播放不应逐帧读回到 JS。

未来 Windows 覆盖 100/125/150/200% DPI、跨屏、反复 fullscreen/dock、输入焦点与关闭途中渲染；Linux 分开记 X11、XWayland 和原生 Wayland，并覆盖缩放、父窗口销毁、不同 GPU/driver。三种展示应核对 core generation 不变、底栏仍有变化视频、声音不重启、字幕/控制可用。记录平台运行证据之前均标为待验收。

## 9. 用户决策与剩余细化

2026-10-03 用户已确认：Linux 首版支持 X11／XWayland，原生 Wayland 后续补齐；Javdex 采用 GPL-3.0-or-later。以下具体方案与审核边界不因范围确认而自动通过。

1. 原生 Wayland 的呈现路径留待后续阶段决定：实验性 GPU texture 合成或扩展 Electron/Ozone 集成；现有 public handle 不当作合法父 surface。该项不再阻塞首版 X11／XWayland 实现，也不记为已支持。
2. 首版提供用户显式的 X11／XWayland 兼容显示选择，需要重启应用；不切换系统桌面、不静默更改全应用 backend，环境缺少 XWayland 时说明不可用并保留显式外部播放入口。
3. Windows/Linux 的直接硬解目标和目标 GPU/架构矩阵：若要求直接互操作，需把 Windows ANGLE、Linux EGL/VAAPI 纳入实现；仅 WGL/GLX 或 copy-back 不能自行替代这一目标。实施与验收状态仍分开记录。
4. GPL-3.0-or-later 已确认，应用许可、元数据与当前公开说明已同步，原 MIT 声明另行保留；运行库仍逐项保留第三方许可/版权、核对版本兼容性及对应源码/构建资料，不因应用采用 GPL 就省略审核。

## 10. 本轮实施记录（2026-10-03）

以下由主 Agent 在研究完成后补记，不是上面的研究代理执行结果。

| 范围 | 源码／构建状态 | 实际运行证据 | 尚未通过 |
| --- | --- | --- | --- |
| 共用 mpv 内核 | 新增 `native/mpvCore.h`、C++ 核心回归；Cocoa 改用它；main 仍是事件/actions 的唯一消费者，inspect 不排空队列。 | macOS 原生构建执行 JSON UTF-8/转义/非有限值、节点复制、属性失效、暂停缓存与重复 shutdown 的断言；真实应用仍可读多轨/章节并渲染字幕。 | Windows 编译及平台行为不能从这些结果推断。 |
| macOS arm64 | 保留 NSOpenGLView、焦点/AX 与控件。失败 render 不再累计可见提交计数，常规播放不向 JS 传帧。 | 本机素材 14 组；独立 Node v22.23.2 loopback 素材 8 组（原文件 4 次 grant、11 次 Range/206）；原主播放流程与正常关闭回归通过，退出 0、未强制清理。 | 真实长片/人工音画、完整 VoiceOver/设备输入/跨屏、x64 和正式运行库/安装。 |
| Windows WGL | 新增 `windowsPlayback.cpp` 与 `CMakeLists.txt`，同一 bridge 接口和 mpv 内核；child HWND 与 WGL，物理像素布局/按 DPI 更新系统控件字体，原生全屏按钮/滑杆、双向 Tab、快捷键、鼠标历史动作与自动隐藏。 | **没有 Windows 编译/播放/GUI 证据**；仅 3 项宿主构建命令计划测试通过。本机未安装 Windows SDK/MSVC/交叉编译器。 | 编译、DPI/焦点/UIA/实际图像/音频/硬解；PE 依赖与正式运行库。WGL 不作直接硬解承诺。 |
| Linux X11／GLX | 新增 `linuxX11Playback.cpp`：video/全屏控件均为同一 Electron parent 的 child，私有 pbuffer 用于清理；复用 core/bridge，不另开可见播放窗口。单独 `Display` 在 owner thread 串行调用，不把 Display 交给解码线程、不晚调用 `XInitThreads`。显式 `--javdex-x11` / `--ozone-platform=x11` 在 ready 前固定 backend，按 4 字节 `uint32_t` XID 扩展为 Xlib Window；Wayland 拒绝接入。 | Linux arm64 及 x64 的 Debian bookworm 隔离 CMake/GCC 编译、两项 C++ 回归、Node addon 加载/空会话/句柄验证通过；x64 在 arm64 daemon 的模拟环境运行。没有显示服务器，**未建 GL context、未播媒体、未做 GUI 验收**。 | 真实 Electron 嵌入与可见底栏/全屏、XWayland、跨屏/DPI、焦点/父窗口销毁、音频/硬解、全屏 AT-SPI 与原生样式一致性；正式运行库/安装；后续原生 Wayland。 |
| Linux ELF 输入检查 | ELF64 小端目标架构、shared object、SONAME、NEEDED 和运行库内 `$ORIGIN` 路径闭包，拒绝绝对/越界/空路径及 audit/filter 间接加载；沿用摘要、来源/许可所有者清单。Windows PE 仍 fail-closed。 | arm64 和 x64 容器分别执行 runtime 7 项中 6 通过、1 macOS-only 跳过；真实 `.so` fixture 搬移且删除原目录后 `dlopen` 返回预期值。实际开发 addon 缺少 mpv 依赖清单被拒绝作为正式输入。 | fixture 不是 libmpv 分发或合规证明；运行时 dlopen 插件、最低 GLIBC/C++ ABI、显示/字体宿主前提、源码/构建选项、签名/干净机器需另核对。 |

当前 Cocoa/WGL 使用创建窗口的 main/UI 线程串行调用 GL；update callback 仅置原子标记，命令保持 async，state 以 timeout=0 取事件。未开启 advanced-control，也未宣称已建立独立 render worker。WGL 代码检查 parent 与创建线程相符；用于清理的私有隐藏 drawable 留在相同 context 内，意在 parent 销毁后仍可 makeCurrent/free renderer，再销毁 core/DC/context。它不显示影片、不替代用户窗口；兼容性仍须 Windows 实机验证。

关闭检查保留真实失败历史：最初在主窗口 `close` 回调中调用 stop，实际内核已释放但原窗口 20 秒后仍存在；空窗口控制组正常，单独屏蔽焦点或 fullscreen 回写均未消除问题，没有 closed、renderer veto 或新建窗口事件。撤回本轮这段提前停播/拆视图后，`node scripts/playback-close-acceptance.mjs` 已实际销毁原窗口，quit 前 inspect 为 alive=false，正常退出；保留原有 `closed`/before-quit 清理。证据只定位到这条提前拆除调用链，不声称已证明 AppKit 内部的每个机制。诊断替换方法的临时参数已从回归脚本移除，失败报告位于忽略的 `out/playback-acceptance/close-diagnostics/`，正常报告为 `close-report.json`。

前轮共用核心改造的 `npm test` 退出 0：Electron 3484 项中 3482 通过、2 跳过、0 失败；根命令同时执行全量 lint、类型、架构、打包、PGS fixture 与新构建命令测试。关闭路径恢复后另重跑原生/桌面构建与正常关闭检查；不将前一次全量测试的时间与后续 GUI 检查混为一次执行，也不称为完成平台验收或发布。

### Linux 隔离编译增量

本次新增实现由主 Agent 后续执行，不改变第 1–9 节研究当时未编译/安装的事实。通过现有 Docker daemon，以仅包含 native 源码、Electron 43.4.1 headers 和三个校验脚本的专用 context 构建 `scripts/playback-linux-compile.Dockerfile`；依赖只安装在开发镜像，不安装到用户 macOS，也不用于发布。arm64：Debian bookworm、GCC 12.2.0、CMake 3.25.1、Node 22.23.2、libmpv-dev 0.35.1-4、X11 1.8.4、GLVND 1.6.0、Xft 2.3.6；这些是此次编译输入，不是选定的正式播放运行库版本。

同一 context 另以 `docker build --platform linux/amd64` 编译 x64，并以 `docker run --platform linux/amd64` 执行无显示加载检查；平台镜像分别确认为 arm64 / amd64，开发依赖版本相同。x64 是 Docker arm64 daemon 上的模拟执行，只增加源码/ABI/二进制检查证据，不增加实际 x64 GUI/GPU/音频证据。当前镜像 ID（本地开发产物，不推送）：arm64 `ff5e232b9961`、x64 `84d18e4f66e1`。

保留构建中的实际修正：Docker legacy builder 不支持 `--progress`、初次镜像漏装 make，修正后才构建通过；对照已核对的 Electron/Ozone 源码，将最初误用 Xlib Window 宽度的读取改为 4 字节并加零值/错误宽度断言。Linux 控件 pure test 在 macOS 可编译运行，只证明几何/键位/句柄模型；Linux 运行镜像里的 Node 加载检查没有 DISPLAY，不能称为 Electron GUI、GLX 输出或关闭活跃播放器验收。

显式兼容模式目前是命令行选择，需退出后重启；未提供设置页切换。没有显式选择或缺少 DISPLAY 时保持不可用并保留外部入口，不在打开影片时静默改变全应用 backend。全屏基础 Xft 控件有键盘操作，但尚未实现/验证 AT-SPI 暴露和产品原生样式，不能记成 S2 无障碍完成。静态 ELF 检查使用 [GNU readelf](https://sourceware.org/binutils/docs/binutils/readelf.html) 与 [loader 规则](https://man7.org/linux/man-pages/man8/ld.so.8.html)，未使用 `ldd` 运行待审核输入。

本次增量 `npm test` 退出 0：Electron 3487 项中 3485 通过、2 个 Windows 路径语义用例跳过、0 失败；包含全量 lint/类型/架构与打包/fixture/4 项构建命令计划测试。本机打包脚本中 Linux 实际 ELF fixture 另按平台跳过，已由上面的两个 Linux 容器执行，不能将此跳过忽略。macOS 原生及桌面重新构建通过，正常关闭回归再次通过（`close-report.json`，forced=false、code=0）；此次未重跑长片/远程媒体完整矩阵，也未做声音听感、VoiceOver 或设备输入验收。

下一步仍需 Windows 实际构建/PE 检查、平台显示与输入关口以及 GPL 运行库来源/许可审核；macOS 的人工与正式运行库验收继续列为未完成。上述增量记录当时未提交、推送或发布；用户随后授权提交前检视、提交并推送功能分支，本轮修复和独立验证结果见 [提交前审查](BUILTIN_PLAYBACK_REVIEW.md)，不是发布或跨平台验收记录。
