# Linux CPU 帧播放实验（issue #124）

本分支 `feat/linux-cpu-frame-playback` 依赖 `feat/linux-wayland-shared-texture` 的隔离播放进程与实验打包，不合入或替换正式发行版。任务：[issue #124](https://github.com/JavdexLabs/Javdex/issues/124)。CPU 路径不初始化 DRM、GBM、EGL 或 OpenGL；适用于没有可用 DMA-BUF 显示能力但能正常运行 Electron 的 Linux 环境。

## 选择方式与边界

首版显式选择，暂不自动尝试 DMA-BUF 后回退，也不在播放中切换传输方式：

```sh
# X11 或 XWayland，允许 Chromium 使用软件合成；适合虚拟机诊断。
./Javdex-Linux-Texture-Experimental-0.9.1-linux-texture.2-x86_64.AppImage \
  --javdex-cpu-frame --javdex-x11 --disable-gpu

# 原生 Wayland，需要当前桌面确实提供 Wayland 会话。
./Javdex-Linux-Texture-Experimental-0.9.1-linux-texture.2-x86_64.AppImage \
  --javdex-cpu-frame --javdex-wayland
```

`--javdex-cpu-frame` 单独使用时保留 Electron 的显示后端选择。与 `--javdex-dmabuf` 冲突时明确报错。原来的 `--javdex-x11`、`--javdex-x11 --javdex-dmabuf`、`--javdex-wayland` 行为保持不变；强制 DMA-BUF 不会偷偷改用 CPU。显示后端和帧传输后端是两个独立选择。

初版为 SDR、RGBA8，输出画布不超过 1280×720，完整软件渲染上限 30 fps。按播放区域等比缩小输出，再由 mpv 在该画布内保留视频比例和黑边；高分辨率输入仍可能消耗较高解码资源。该上限不是实时性能保证。HDR、4K/高帧率性能、自动后备策略、用户可配置上限另行验收，不在首版完成声明中。

## 为什么使用 libmpv 软件 render API

独立 `playback-cpu-helper` 使用 `MPV_RENDER_API_TYPE_SW` 和 `MPV_RENDER_PARAM_SW_SIZE/FORMAT/STRIDE/POINTER`，让 mpv 把视频、字幕与受控 OSD 合成到 CPU 可寻址内存。API 保证的 `rgb0` 布局与字节序无关；发布前将第四字节置为 255，得到明确 RGBA。这里的 CPU 输出不依赖 llvmpipe GL framebuffer，也不做 GPU readback。

依据：[mpv 0.41.0 render.h](https://github.com/mpv-player/mpv/blob/v0.41.0/include/mpv/render.h)、[官方软件渲染示例](https://github.com/mpv-player/mpv-examples/blob/master/libmpv/sdl/main_sw.c)。独立实现，没有复制 OBS、vlcj 或其他播放器的代码。mpv 明确提示软件颜色转换、缩放和字幕合成为单线程、可能很慢；实现使用实际 0.41.0 支持的 `sws-fast` 选项，不能照抄 API 注释中不被运行库识别的 `sw-fast` 拼写。

## 数据流、协议与预算

1. 原有资源授权和控制层只把已授权媒体 locator 交给独立 helper。libmpv/FFmpeg 不进入 Electron 主进程或 renderer。
2. helper 持有三个 `memfd_create` 槽位，各自 `mmap`。封印禁止文件增大、缩小及新增封印，但允许生产者在拥有槽位时写像素。
3. 私有继承 `AF_UNIX/SOCK_SEQPACKET` socketpair 通过 `SCM_RIGHTS` 传 FD；没有监听端口、全局共享内存名称或文件系统 socket。
4. 头部只有小型 JSON：协议 `javdex-cpu-frame-v1`、单调安全整数 sequence、slot 0..2、uint32 generation、width/height、stride、size、`pixelFormat=rgba`、`producerComplete=true`。像素不经 JSON/base64。
5. 薄 N-API FD 桥接验证自身所有权、普通文件、精确长度与 extent seals，`pread` 复制成有界 Node Buffer，并消费关闭所收到的 FD，包括失败路径。
6. 主进程验证布局、sequence、槽位、generation、window/mainFrame 与绑定身份，通过二进制 structured clone 发送到 sandbox preload。renderer 页面不获得任意 FD、映射、mpv 命令或 locator。
7. preload 向已绑定 Canvas2D 执行 `putImageData`，同步返回后报告 drawn 或 dropped。仅真实 drawn 回执增加 Canvas 提交计数。主进程再 ACK 生产者；未 ACK 的槽位不能改写。

720p 每帧 3,686,400 字节，三个原生槽位最多 11,059,200 字节（约 10.55 MiB）。以 30 fps 计算，一次全帧复制约 110.6 MB/s（十进制）。当前路径至少包含 memfd→Node、Electron 二进制序列化/传输、preload→ImageData、ImageData→Canvas 的像素搬运；Electron 内部暂存、Canvas backing store 和 GC 不计入原生槽位预算，因此不能声称整个应用只有 10.55 MiB 或是零拷贝。生产/IPC outstanding 总数固定为三，失败回收有界，不靠无界排队吸收慢消费者。

## 生命周期与诊断

- 会话表面 token 与每次 Canvas 绑定 token 隔离停止/重开、卸载/重绑；旧绑定只能释放自己的帧，不能释放新绑定的槽位或增加新会话计数。
- load/seek 提升 generation，旧帧只释放不绘制；新帧等待相应播放重启。sequence 在 helper 生命周期内不重置，避免晚到 ACK 归属混淆。
- 暂停保留最后一个 Canvas 图像，但不持有生产者槽位。隐藏停止不必要的软件绘制，继续泵 mpv 事件、消费 ACK；恢复显示不能播放积压旧帧。
- 单帧释放和接收器准备超时、helper 心跳、renderer/helper 退出会明确终止；不进入反复自动重启/回退循环。TERM 后仍未退出时有界 KILL。
- `JAVDEX_PLAYBACK_DIAGNOSTICS=1` 显示 `cpu-rgba` 传输、软件解码状态、生产/复制/Canvas 提交/传输丢弃/当前 outstanding 等固定诊断。Canvas 提交不等于物理显示扫描；日志不记录媒体 locator、凭据或原始像素。
- sandbox、contextIsolation、资源授权、现有音频和播放控制均保留。不得加 `--no-sandbox` 规避运行环境限制。

### CPU 字幕字体

CPU helper 的字幕和 OSD 显式使用随包的原始 `NotoSans-Regular.ttf`，从自身可执行文件旁的 `fonts/` 读取，不修改系统 Fontconfig、字体缓存或其他播放后端。原因来自真实桌面测试：系统 `sans-serif` 别名选中了 libass 无法打开的 WOFF2 字体，导致字幕轨道已选中但像素中没有文字；同一个 helper 在另一执行环境选中 TTF 时正常。

字体是未经修改的 Debian `fonts-noto-core 20201225-2` 文件，OFL-1.1 许可、官方下载地址、发行包与 TTF 的 SHA-256 见 `resources/linux-cpu-fonts/`，随应用和对应源码归档交付。打包检查固定字体文件集合与摘要，缺少字体时明确失败。此基础字体不是完整中日韩字库；CJK 仍依赖兼容的宿主回退字体。本次桌面诊断已用宿主 Noto Sans CJK 显示中文与日文，但不能据此保证未安装 CJK 字体的其他主机。

## 可重复的真实媒体验证

先按 [实验打包说明](LINUX_TEXTURE_EXPERIMENTAL.md) 构建，开启 `JAVDEX_BUILD_LINUX_CPU=ON`。使用已审计的 libmpv 0.41.0，而不是系统任意版本。

```sh
node scripts/make-cpu-playback-fixture.mjs
# 开发输出尚未并置 libmpv 时，仅为本命令指定已审核运行库目录。
LD_LIBRARY_PATH="$JAVDEX_MPV_PREFIX/lib" \
  node scripts/linux-cpu-playback-smoke.cjs \
  out/cpu-playback-acceptance/cpu-720p30-h264-aac.mp4
```

样片完全本地生成：60 秒 H.264/AAC、1280×720/30 fps、SDR、动态测试图，四角红绿蓝黄标记、440 Hz 音频及嵌入字幕。脚本输出媒体哈希和流参数。真实 helper 验证包括实际解码、RGBA 颜色/方向/alpha、连续变化像素、字幕在同一暂停视频帧上的像素变化、暂停 30 秒、连续 seek、缩放/720p 上限、三个槽位背压、持有槽位隐藏 10 秒恢复、停止重开和 FD 回收。

`cpu-smoke.json` 记录 helper/addon/sample 哈希、稳态采样时长、接收 fps、字节吞吐、helper 单核 CPU 时间占比、helper RSS/FD 高水位。另将 AAC 通过真实 mpv PCM AO 解码成 WAV，验证有效非静音样本。null/PCM AO 的成功只证明解码和输出数据，不证明扬声器可听、主观音画同步或 Canvas 实际显示。

GUI 验证使用同一个真实应用和合成媒体，通过正常“来源目录→扫描→影片→内置播放”流程，单独测试可见运动、字幕、HTML 覆盖、暂停、seek、最小化、重开与音频。默认扫描最小时长须在隔离测试库降至 0；不修改正式资料库。截图及结果与命令行证据分开保存。

原生构建完成后，可从仓库根目录重复定向回归（开发输出未并置 libmpv 时给相应命令加上述 `LD_LIBRARY_PATH`）：

```sh
out/native-playback/linux-cpu-frame-test
out/native-playback/mpv-core-test
node scripts/linux-fd-transport.test.cjs
node apps/desktop/src/main/player/native/linuxCpuCopy.test.cjs
node apps/desktop/src/main/player/native/linuxCpuFonts.test.cjs
node apps/desktop/src/main/player/native/linuxCpuLifecycle.test.cjs \
  out/cpu-playback-acceptance/cpu-720p30-h264-aac.mp4
node scripts/run-electron-tests.mjs \
  apps/desktop/src/main/player/linuxCpuFrames.test.ts \
  apps/desktop/src/main/player/linuxPlaybackBridge.test.ts \
  apps/desktop/src/preload/linuxCpuFrames.test.ts \
  apps/desktop/src/renderer/src/playback/PlaybackPanel.test.tsx
node --test scripts/wayland-experimental-package.test.mjs
```

字体缺失/伪装为 TTF 的错误测试使用临时目录，不移动或修改系统字体。完整 AppImage 构建时指定 `JAVDEX_CPU_ACCEPTANCE_MEDIA` 为样片绝对路径，还会从实际 AppImage 提取并运行包内 helper/addon 的真实媒体快速检查；该快速检查不是 GUI 或稳态性能测量。

## 状态说明

实现和构建检查不能自动视为 issue 全部验收完成。实际本轮结果见随测试包提供的 `cpu-smoke.json`、GUI 验证记录与打包验证记录；未运行的原生 Wayland、真正 DMA-BUF、物理扬声器/主观音画同步、长时间资源趋势必须明确列为未验证。CPU 出图不能替代 DMA-BUF 验收。

实验包版本 `.2` 继续使用 `Javdex-Linux-Texture-Experimental` 独立资料目录并禁用官方自动更新；构建输出在 `dist/cpu-frame-experimental`，不会覆盖已交付的 `.1` 安装包。与完整应用源码和对应第三方播放源码一同交付。实测结果未达到目标时，报告数字和限制，不把帧率上限宣传成性能结果。
