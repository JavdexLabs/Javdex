# Linux GPU helper 长播内存调查（2026-10-22）

## 结论与定位

本轮从 `17c69ea` 工作区继续，保留之前未提交的 CPU 色彩修复、小纹理 modifier 修复及旧包。未修改系统设置、驱动或新增系统包。

此前 300 秒 Wayland GPU 长测 RSS 368.7→414.4 MiB、FD 固定 171，尚不能判定正常缓存。此次先用桌面原包（SHA-256 `f1dc77799d7050a1363fdbc009aa813a9a25d75f0305030ca76b0168c208f600`）复测，再运行直接 helper 的立即 ACK 消费端，排除 Electron/Canvas。诊断用合成 `h264-1080p30-long.mkv`，不访问用户媒体。

证据链：

1. `/proc/smaps` 的增长主要在 heap，文件映射基本稳定。
2. 用进程级 `LD_PRELOAD` 诊断读取 glibc `mallinfo2` 与 libmpv 缓存：活跃分配持续增加，demux 缓存仅约 2 MiB 且稳定。RSS 上升不是只由空闲堆保留或视频预读缓存解释。
3. 本机已有 jemalloc 的采样 profile 显示预热后每 30 秒增加约 4.2 MiB，集中在 NVIDIA EGL 分配 → `ra_gl_ctx_submit_frame` → `done_frame` → libmpv render 的调用栈。其他一次性的大块解码/驱动分配与持续增长分开记录。采样对象数不能直接当作完整分配计数。
4. 拦截诊断进程的 `eglGetProcAddress` 返回函数，仅记录 GL fence 创建/删除计数；旧 helper 每帧创建 fence、未删除。5 秒左右已有 135 个，约 70 秒达到 2084 个。这一层对象泄漏不会必然增加 Linux FD：本机 NVIDIA 的 FD 固定并不能证明资源无泄漏。
5. 固定源码 mpv 0.41.0 的 `video/out/opengl/context.c` 无条件为有 `FenceSync` 的路径创建 swapchain fence，清理只在 `ra_gl_ctx_swap_buffers`；libmpv render API 不调用该路径。源码和本机分配栈吻合。

上游已在 [f74adc4243bd9e1a8ee96d187c939e6232510650](https://github.com/mpv-player/mpv/commit/f74adc4243bd9e1a8ee96d187c939e6232510650) 修复，对应 [#17217](https://github.com/mpv-player/mpv/issues/17217)。本轮回移植同一条件：仅存在 native `swap_buffers` 时创建其配套的 vsync fence。

## 改动与边界

- `scripts/playback-source-build.mjs`：精确匹配并应用上游补丁，源码漂移、重复匹配、已应用都会报错，要求升级依赖时重新评审。
- `scripts/build-playback-runtime.mjs`：GPU 构建接入补丁并写入 provenance；CPU 构建不编译 GL，不需要该补丁。源码归档包含回移植配方。
- `scripts/playback-source-build.test.mjs`：验证补丁及漂移拒绝。
- `scripts/linux-load-acceptance.mjs`：helper 内存记录补充 PSS、匿名页、私有/共享页；内核不允许读取时保持缺失，不伪装为 0。

不通过伪造 `report_swap` 回执、周期重启 helper、调用 `malloc_trim`、禁用硬解或缩减缓存掩盖增长。DMA-BUF 三槽、producer 完成同步、consumer release fence、按目标时间呈现、自适应提前量和 CPU 回退均保留。

## 验证记录

证据目录 `out/linux-rss-investigation/`。原包 10 分钟内存复测与独立 helper 分配诊断有部分并行；这些数据用于内存归因，不能作为独占性能基准。最终修复版长测应单独运行，不与构建或其他播放测试并行。

- 34 项构建相关针对性测试通过，最终构建及长测结果见下文。
- `helper-memory.err`：缓存与 glibc 活跃分配。
- `heap-*.heap`、`heap-growth-final.txt`：采样调用栈及映射，`addr2line` 解析到 libmpv 函数。
- `before-phases.*`：旧 helper 播放/暂停/恢复/停止/重新加载过程的 fence 计数。
- 所有诊断预加载仅用于单独测试进程，不进入运行库或安装包。

隔离增量构建曾遇到旧 context 的 `cuda-interop=disabled` 和重配置时缺少私有 pkg-config 环境导致的失败。修复为当前源码已有的 `cuda-interop=enabled` 并恢复私有依赖环境；这些失败日志保留，不计为产品运行通过。旧 prefix、源码和运行包未覆盖。

原包 600 秒复测：RSS 第 1/60/300/600 秒为 368.6/378.2/415.4/461.1 MiB，结束截图和彩色像素检查通过。尽管 mpv 丢帧增量为 0，本轮原包与诊断/构建部分并行，不作独占流畅度基准。

新 GPU runtime 与前一版比较，仅 `libmpv.so.2` 和 `build.json` 变化；helper、FD bridge 及其余运行库文件哈希一致，CPU runtime 未替换。旧 GPU runtime 保存在 `out/linux-portable-runtime.before-memory-20261022`，桌面旧 AppImage 不覆盖。

新包目录为 `dist/linux-gpu-memory-fixed/`。初次打包未显式指定 `.mjs` 配置而失败，该目录 `dist/linux-gpu-memory-fix/` 不是可交付包；使用明确的 `--config electron-builder.config.mjs` 重新打包通过。最终包与运行库一致性校验及长测结果见下文。


独立 helper 生命周期对照（glibc 活跃分配，不是 RSS；时间为约数）：

| 阶段 | 旧版活跃堆 MiB | 修复版活跃堆 MiB | 旧版未删除 fence | 修复版未删除 fence |
|---|---:|---:|---:|---:|
| 播放 5 秒 | 74.99 | 74.37 | 135 | 0 |
| 播放 95 秒 | 88.91 | 74.79 | 2834 | 0 |
| 暂停后 115 秒 | 89.69 | 74.81 | 2992 | 0 |
| 恢复后 145 秒 | 93.40 | 74.81 | 3734 | 0 |
| 停止后 165 秒 | 55.32 | 35.95 | 3892 | 0 |

旧版停止播放时解码缓冲释放，但渲染上下文存活、fence 仍残留；重新加载继续增长。修复版 210 秒含重新加载的全程 fence 计数为 0，帧数 5082，NVDEC-copy 正常。初始化、解码池、驱动及分配器保留仍会占内存，不能要求 RSS 回到零；本修复针对已确认的逐帧对象泄漏。

实际产物 AppImage SHA-256：`6a3f488400621fefb524a787692e7ae07c7b5cfb25b7276bd28832f725fb1ad4`，188,122,796 字节；deb 165,214,072 字节（仅构建，未安装）。集成包校验匹配 95 个文件，确认 GPU/CPU 闭包及源码包来源。34 项构建相关测试通过；最终包重用未变化的 main/preload/renderer 产物，替换专用 libmpv。用户确认“Javdex GPU 内存修复长测”画面及音画大致同步正常；不是量化音频时差测量。


## 最终包长测与回归

最终包 `fixed-wayland-600-traced/` 独占播放 600 秒，没有并行构建/其他播放，没有诊断预加载或中途像素读回。只记录测试进程的窗口事件和暂停命令（排查之前中断），不改命令行为。使用 NVIDIA NVDEC-copy，实际输出 2070×1060。结束截图和彩色像素检查通过，mpv 丢帧增量 0，FD 固定 169。

| 数据 | 原包 | 修复包 |
|---|---:|---:|
| 第 1 秒 RSS MiB | 368.621 | 368.676 |
| 第 600 秒 RSS MiB | 461.133 | 372.398 |
| 10 分钟增量 MiB | 92.512 | 3.722 |
| 第 300–600 秒 RSS 增量 MiB | 45.730 | 0.563 |
| 第 300–600 秒线性拟合 MiB/分钟 | 9.142 | 0.127 |

这证明确认的逐帧 fence 泄漏已消除，不应把修复包仍有的少量 RSS 变化称作绝对零增长或无限期稳定。进一步通过实际 AppImage 的短期分配器读数区分活跃对象和空闲堆保留，见下方补充。

其他最终包回归：

- `fixed-x11-controls/`：XWayland GPU / NVDEC-copy 65 秒、丢帧增量 0；暂停恢复、三次跳转、外挂字幕、两次缩放、停止重开通过。字幕截图已检查。
- `fixed-cpu-fallback/`：注入自检黑帧，自动进入 CPU，原因 `DISPLAY_SELF_TEST_FAILED`，实际彩色输出检查通过。
- `fixed-small-texture/`：64×64 XWayland GPU 下 SDR limited/full、HDR10→SDR、HLG→SDR 的 Canvas 和截图检查通过，保留上一轮修复。

### 两次暂停中断

`fixed-wayland-600/` 在约 143 秒进入 paused，`fixed-wayland-600-retry/` 启动后也停在 paused；两次均判失败并留存。用户明确表示没有手动暂停，不能归咎于用户。对应时间的系统日志没有发现 suspend 事件；应用本身在 hide/minimize/suspend 时会暂停，但前两次缺少事件日志，不能断言具体触发源。随后只增加测试事件记录的 600 秒重测未出现隐藏/最小化/休眠或额外暂停命令。**这两次非人工暂停的触发原因仍未定位，不能宣称已修复**，与已确证的 GL fence 泄漏分开记录。

验证限于本机 NVIDIA / GNOME Wayland 与 XWayland；不等于其他 GPU、数小时/数天、所有媒体的稳定性保证。deb 未安装，本轮未重跑全仓 JS 测试；未提交、推送、合并或发布。


### 剩余小幅 RSS 变化

`fixed-app-allocator/` 使用同一 AppImage、Wayland 2070×1060、NVDEC-copy 再运行 180 秒，仅给 helper 进程加载诊断库，记录 glibc 分配数据和缓存，不作为性能基准。画面检查通过，fence 累积始终为 0。

- RSS：367.07→369.68 MiB。
- 第 60 秒之后活跃堆在 71.15–71.66 MiB 间波动；最终 71.61 MiB。
- 同段 arena 从约 94.81 增至 95.81 MiB；最终空闲堆约 24.20 MiB，较第 5 秒约 22.64 MiB 增加。缓存约 2 MiB，随当前帧大小波动。
- 因而 RSS 的小幅增长不能等同于同等规模的未释放活跃对象；有明显的分配器空闲内存保留和预热成分。本轮已经排除原来的每帧 fence 累积，但 **未证明任意时长下所有剩余增长都仅为缓存**，也不宣称 RSS 严格恒定。数小时/更多媒体的趋势仍是后续验收边界。

最终 `git diff --check` 通过，测试进程均已结束。启动（也可双击同一 AppImage）：

```sh
./dist/linux-gpu-memory-fixed/Javdex-0.9.0-x86_64.AppImage --javdex-wayland
# XWayland：将参数换成 --javdex-x11
```
