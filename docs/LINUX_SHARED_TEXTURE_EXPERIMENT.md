# Linux 共享纹理播放：实现方案与实验验收

本开发分支：`feat/linux-wayland-shared-texture`，起点 `acb19b00b3a70cafd0b6c9ff9c4a28a459966a9d`。这是一条可选择的实验后端，供本地 Linux 真机验收；不宣称已经通过 GPU 出图或发行级兼容性验证。

## 目标与范围

保留现有 X11/GLX 原生子窗口方案，新增同一套可运行于 Electron X11 与原生 Wayland 窗口内的共享纹理路径。播放器的资源授权、播放控制、字幕、续播与既有 HTML 控件继续使用当前代码。libmpv 仍在独立 helper 进程，不把 FFmpeg/libmpv 加载进 Electron 主进程。

不在本轮加入 Windows/macOS 纹理后端、纯软件 CPU 帧回退、HDR/色彩管理、远程发布或自动更新。无需独立显卡；集成 GPU 只要提供相容 DRM/GBM/EGL 驱动也可使用。视频可以 CPU 解码；DMA-BUF 图像共享本身仍要求可用的图形缓冲分配与导入能力。

## 数据链路

1. 主进程选择 `dmabuf` 后端，加载只处理文件描述符的 `playback-fd.node`。
2. addon 创建匿名 `AF_UNIX/SOCK_SEQPACKET` socketpair；helper 通过继承 fd 3 获得另一端。无监听端口、磁盘 socket 或全局 GPU handle。
3. `playback-dmabuf-helper` 打开 DRM render node，创建 GBM device 和 EGL/OpenGL 上下文。
4. 三个槽位分别持有单平面线性 ARGB8888 GBM BO、EGLImage、GL texture/FBO。libmpv render API 渲染到指定 FBO，包含原有字幕/AI 字幕叠加。
5. 完成 GPU 写入后执行 `glFinish()`，经 `SCM_RIGHTS` 发送 DMA-BUF FD 和有界 JSON 元数据；不传输 CPU 像素。
6. 主进程验证元数据、序号、slot 所有权，再调用 Electron 43.8.0 `sharedTexture.importSharedTexture`，发送给已确认的主 renderer frame。
7. 沙箱 preload 根据当前 surface token 与每次挂载的 binding token 接收纹理，将 VideoFrame 绘入当前 Canvas；HTML 控件正常覆盖其上。Renderer 不获取 FD、媒体 locator 或任意 mpv 命令入口。

采用保守的 `auto-copy` 解码模式；硬件解码不可用时允许 mpv CPU 解码。首版只接受可证明线性的单平面 BGRA，暂不声称适配全部 modifier、驱动与混合 GPU 组合。`glFinish()` 优先正确性，会影响吞吐；没有端到端零拷贝或性能保证。

## 生命周期、背压与失败

- 单 helper 最多三个 outstanding slot。只有 Electron `allReferencesReleased` 回调触发的 ACK 才允许 producer 复用；传输 Promise 完成不是释放条件。
- ACK 协议是 `JXAK`、LE uint32 版本 1、LE uint64 sequence。重复、未知或畸形 ACK 拒绝；接收器会关闭畸形包包含的所有已接收 FD。
- 主进程收到的 FD 只由 addon 关闭；Electron 导入后持有自己的引用。VideoFrame.close 与 importedSharedTexture.release 均在 finally 中执行。
- resize 只重新分配空闲/已 ACK 的槽位，不销毁仍被 Electron 使用的槽位；总量保持有界。
- 暂停画面可能保留一个消费引用，不能仅因单帧年龄超时而失败。满三槽停滞、ACK 背压、接收器未准备、GPU/renderer 退出或导入错误均会停止该 helper，不回收仍被消费的 buffer。
- 隐藏/最小化或 Canvas 尚未绑定时不发布新帧，仍消费 mpv 更新并处理 ACK；隐藏期间暂停满槽超时。主进程仅在窗口可见且接收器已绑定时令 helper 可见。helper 的独立心跳若超过 10 秒不更新，终止卡在 EGL/libmpv/驱动中的进程。
- `presentedFrames` 来自验证过的 Canvas draw 提交回执，不把 helper 导出或发送成功算作显示；此计数也不等价于物理屏幕扫描输出。
- 每次 helper 创建生成新的不可预测 surface token；每次 Canvas 重新绑定生成 mount token。旧 token 的延迟帧只释放、不绘制。IPC 只接受既有主窗口的 mainFrame。
- helper 关闭先走现有 destroy/EOF，随后有界强制终止；运行中传输失败立即终止。helper 有父进程死亡信号，不应遗留解码器进程。

## 选择方式

| 启动参数 | 显示后端 | 视频后端 |
| --- | --- | --- |
| `--javdex-x11` | X11/XWayland | 原有 X11 子窗口 |
| `--javdex-x11 --javdex-dmabuf` | X11/XWayland | 实验共享纹理 |
| `--javdex-dmabuf --ozone-platform=x11` | X11/XWayland | 实验共享纹理 |
| `--javdex-wayland` | 原生 Wayland | 实验共享纹理 |
| `--javdex-dmabuf --ozone-platform=wayland` | 原生 Wayland | 实验共享纹理 |

单独 `--javdex-dmabuf` 选择 Wayland。冲突显示参数在启动时拒绝；Wayland 窗口 handle 不转换为 XID。

`JAVDEX_DRM_RENDER_NODE` 可显式选择 render node，例如 `/dev/dri/renderD128`。应选择与 Chromium/compositor 相容的 GPU；混合显卡导入不保证成立。设置 `JAVDEX_PLAYBACK_DIAGNOSTICS=1` 可输出不含媒体路径/URL 的有限帧计数，便于反馈。实验失败会在终端输出固定的安全诊断码，避免泄露媒体地址或系统路径：`DRM_RENDER_NODE_UNAVAILABLE`、`GBM_LINEAR_BUFFER_UNAVAILABLE`、`EGL_DMABUF_UNAVAILABLE`、`FRAME_RENDER_FAILED`、`TEXTURE_IMPORT_FAILED`、`RECEIVER_NOT_READY`、`FRAME_RELEASE_TIMEOUT`、`HELPER_HEARTBEAT_TIMEOUT`、`GPU_PROCESS_EXITED` 等。界面沿用既有受控播放失败提示；反馈时请附终端诊断码。不自动改成外部播放器或软件像素回退。

## 测试包与数据隔离

专用 AppImage 使用 `javdexExperimentalLinux: true` 的打包标记、独立 appId/productName 和预发布版本。默认资料目录为用户配置目录下的 `Javdex-Linux-Texture-Experimental`，不会自动打开或迁移正式 Javdex 资料库；测试请导入少量复制的媒体样本。`JAVDEX_TEST_USER_DATA` 仍是显式测试覆盖项，切勿把它设为正式资料目录。

该包禁止自动及手动正式版本检查，不发布更新元数据。旧的已审核 Linux 播放运行库保持原目录与验证合同；新 helper/addon 及其严格测试清单放在独立 `linux-texture-experimental` 资源目录。代码与对应源码材料一起交付；不混用未审核的同名第三方 codec 库。

## 本地 Linux 验收

先校验交付 SHA-256，再赋予 AppImage 执行权限。以默认沙箱运行；不要用 `--no-sandbox` 作为通过条件。若 FUSE 不可用，可以使用 AppImage 官方的解包运行方式；这不改变 Electron 沙箱要求。

```bash
chmod +x Javdex-Linux-Texture-Experimental-*.AppImage
JAVDEX_PLAYBACK_DIAGNOSTICS=1 ./Javdex-Linux-Texture-Experimental-*.AppImage --javdex-x11 --javdex-dmabuf
# 完全退出后，在 Wayland 会话中：
JAVDEX_PLAYBACK_DIAGNOSTICS=1 ./Javdex-Linux-Texture-Experimental-*.AppImage --javdex-wayland
```

建议按次序检查：

1. 独立空资料目录启动；设置中版本为实验版；正式资料未被改动。
2. X11 共享纹理先播 H.264/AAC 短片：出图、声音、颜色、方向、比例正确；确认非原有 X11 子窗口路径。
3. 暂停至少 30 秒、最小化至少 10 秒再恢复、seek、多次开关、切换资源；不出现旧画面、helper 泄漏或持续增长的 FD/内存。
4. 窗口反复缩放、底栏/展开/全屏切换；控件、弹层覆盖正常，键盘、鼠标、焦点与返回栈正常。
5. 外挂 SRT/ASS、容器字幕与已有 AI 字幕显示；音轨/字幕轨切换。
6. 原生 Wayland 重复上述检查，确保 `--ozone-platform=wayland` 真正运行；XWayland 不能替代此项。
7. 重启/关闭播放、renderer reload、GPU 错误恢复；应可停止并重开，不复用旧会话纹理。
8. 用 `--javdex-x11` 回归原有播放器，比较同一媒体；最后再测试 4K、HEVC、高帧率及不同驱动。

反馈请提供发行版与版本、CPU/GPU、驱动、X11/Wayland 会话、实际启动命令、首次错误、诊断帧计数，以及不含私密内容的截图或公开样片。先不要提供媒体路径、服务器凭据或完整个人库。

## 验证边界

当前构建环境没有 DRM render node，实际 OpenGL 是 llvmpipe，且命名 Unix socket 受环境限制，因此不能在这里声称 GPU 图像或原生 Wayland 验收通过。可在云端执行的验证包括：C++ 编译/纯状态机、真实 SCM_RIGHTS FD 传输与清理、控制协议、主进程纹理引用/ACK/security 的替身测试、preload/Canvas 绑定测试、类型检查、lint、打包闭包与 ELF ABI 检查。最终每项通过/失败/未运行状态应记录在交付说明。

## 构建与复现

完整依赖、原生构建命令与 AppImage 包装步骤见 [构建说明](LINUX_TEXTURE_EXPERIMENTAL.md)。主要回归入口：

```bash
npm run typecheck
NODE_OPTIONS=--max-old-space-size=4096 npm run lint
node scripts/run-electron-tests.mjs
node --test scripts/wayland-experimental-package.test.mjs
node scripts/linux-fd-transport.test.cjs
./out/native-playback/linux-dmabuf-test
```

主进程、preload、Canvas 的纹理 API 测试使用替身；SCM_RIGHTS/FD 传递测试是真实进程与内核对象，不应将它们混称为 GPU 测试。新 helper 的最高符号要求实测 GLIBC 2.34 / GLIBCXX 3.4.21；携带的已审核 libmpv 最高 GLIBC 2.35。完整 AppImage 仍需宿主图形/音频库，建议首先在 Ubuntu 22.04 或更新系统验收；ELF 版本下限本身不证明全部发行版兼容。

## 依据与许可证

实现独立编写，依据官方 API：

- [Electron 43.8.0 sharedTexture API](https://github.com/electron/electron/blob/v43.8.0/docs/api/shared-texture.md)
- [Linux nativePixmap 描述](https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-handle.md)
- [共享纹理生命周期](https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-imported.md)
- [libmpv 0.41 render_gl API](https://github.com/mpv-player/mpv/blob/v0.41.0/include/mpv/render_gl.h)
- [Khronos EGL_EXT_image_dma_buf_import](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_image_dma_buf_import.txt)
- [Mesa GBM API](https://gitlab.freedesktop.org/mesa/mesa/-/blob/main/src/gbm/main/gbm.h)
- [Linux SCM_RIGHTS / unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html)

sbtlTV 是架构参考，但根 AGPL-3.0 与子包 README 的 MPL-2.0 说明不一致，本分支不复制其实现。Javdex 与携带的 libmpv/FFmpeg 等材料继续遵循现有 GPL/第三方许可证和对应源码交付要求。
