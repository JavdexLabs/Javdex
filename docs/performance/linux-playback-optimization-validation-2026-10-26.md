# Linux 播放优化实测与取舍（2026-10-26）

接续 [候选清单](linux-playback-optimization-opportunities-2026-10-26.md)。源码起点 `d9596f769c09e7b2e36b43c9043177b45a1f20f2`，本轮工作区修改尚未提交。原始报告、失败日志、输入摘要和截图保存在本机 `out/linux-optimization-20261026/`；该目录不随源码提交。旧包分别保留在 `dist/linux-optimization-20261026-{baseline,consumer-current,direct}/`。

## 环境与测量边界

Ubuntu 26.04.1、GNOME Wayland；Intel UHD 770 / i915 为 renderD128，RTX 4080 / NVIDIA 595.99.02 为 renderD129。Electron 44.9.3 / Chromium 152.0.7977.167，两份 helper、专用 libmpv 和私有 ANGLE 均重新核对并构建为匹配版本。物理显示器 3840×2160、144Hz、缩放 1.5。不改系统设置，不安装新系统包。

每项预热 5 秒、计时至少 60 秒，串行运行，不与构建、编码或其它播放并行。CPU 为整个进程树，100% 表示一个逻辑核心；RSS 求和可能重复计入共享页。截图、像素读取和额外 tracing 位于计时区间之外。记录真实输出 backing，不伪造 viewport：Wayland 全屏为 3840×2160，XWayland 原生全屏 backing 为 5120×2880，后者不能冒充同尺寸 4K 对照。普通窗口受分数缩放约束，1080 类对照为 1920×1079 或 1920×1081。

自动合成截图及运动像素检查证明有实际窗口内容，不证明物理扫描输出、显示器校准或听觉同步。当前机器不能代替 AMD、纯 Intel、原生 Xorg、KDE、其它发行版或干净安装矩阵。

## 基线与消费者原型

完成 Wayland GPU/CPU 1080p24/30/60、真实 4K60，以及 XWayland GPU/CPU 1080 与原生 backing 对照。Wayland GPU 基线 4K60 为约 142% CPU、60fps；CPU 4K60 仅约 14fps、约 670% CPU，不能称为流畅支持 4K60。

另发现固定 Chromium 152 默认采用静态 ANGLE，放置旁边的私有补丁库并不会自动生效。X11 GPU 初始化失败的同一基线包加 `--use-dynamic-angle` 后恢复。现在仅在现有版本匹配、X11 DMA-BUF、ANGLE Vulkan 路径选择私有动态库；其它平台、手动 CPU 和显式其它 ANGLE 路径不受影响。

先修复 Linux 传输生命周期，再作消费者对照：加入 producer 时间戳，使用低层 transfer 和受认证的 preload 完成通知，保留主引用直至消费端 GPU 完成；最终 `allReferencesReleased` 才 ACK。传输结果不明时隔离最多三个表面。停止、页面重载、旧 binding 的迟到释放和取消自检均独立处理。超过两秒 renderer 停顿、暂停/跳转、缩放/全屏、重开、页面退出和实际 CPU 故障接管已作独立窗口回归。

**保留默认 Canvas，video 仅由 `--javdex-linux-video` 开启实验。** 十二项配对采样并不支持全面切换：

| 对照 | Canvas | video | 结论 |
| --- | ---: | ---: | --- |
| XWayland GPU 1080，CPU | 123% | 103% | 有 CPU 收益；video 有 1 帧 mpv 丢帧 |
| XWayland GPU 原生 5K backing，CPU | 146% | 135% | video 丢 5 帧，Canvas 丢 2 帧 |
| Wayland CPU 1080，生产帧率 | 55.3fps | 58.5fps | video 有改善，但仍非稳定 60fps |
| Wayland CPU 4K，生产帧率 | 11.4fps | 9.3fps | video 吞吐回退 |
| Wayland GPU video | — | 首帧自检超时 | 不具备默认启用条件 |

Wayland GPU video 在可见 opacity、显式 GL、动态 ANGLE GL 和仅测试禁用 eager conversion 的对照中仍失败。trace 确实观察到 RGB→NV12 转换，但不能把它认定为唯一根因；没有改生产全局 feature 开关。CPU video 只转移私有复制缓冲区，绝不移交生产者池的可复用映射。

## 直接硬解与分段计时

同一新包、默认 Canvas、H.264 4K60 输入、相同输出逐对测量：

| 显示 / 输出 | 解码 | 整个进程树 CPU | 生产 fps | mpv 丢帧 | render 平均 | glFinish 平均 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Wayland / 4K | nvdec-copy | 135.95% | 60.034 | 0 | 5.152ms | 1.418ms |
| Wayland / 4K | nvdec | 92.18% | 60.001 | 0 | 0.853ms | 0.575ms |
| XWayland / 1080 | nvdec-copy | 141.04% | 59.984 | 0 | 4.804ms | 1.616ms |
| XWayland / 1080 | nvdec | 97.82% | 59.983 | 1 | 0.866ms | 0.578ms |

两端真实 renderer 均为 RTX 4080，helper EGL render node 校验通过；copy 路径有真实 hwdownload 采样，direct 路径样本数为零，不伪造零耗时均值。计时后的窗口截图和运动检查通过。这是本机单组配对证据，不能外推所有编解码或 GPU。NVDEC mapper 仍有 GPU 内部 plane copy，不称为全链路零拷贝。

Intel 的两个独立问题必须分开：强制 Intel Wayland 消费端在应用初始化时 EGLImage 导入失败；Intel XWayland Vulkan 消费端交换链创建失败，均未进入影片验收。producer 独立检查还发现专用 libmpv 的 `HAVE_EGL=0`，VAAPI/DRM 编译开启并不保证 VAAPI→GL mapper 可用。因此补齐 GPU profile 的 `-Degl=enabled`，并传递真实 GBM render FD；CPU profile 不加入 EGL/VAAPI 依赖。进一步补齐独立 DRM 头文件探测后，确认 `HAVE_EGL=1`、`HAVE_DMABUF_INTEROP_GL=1`、`HAVE_DRM=0`。Intel producer 可以选中 `vaapi`，但随后 FFmpeg 报 `Failed to end picture decode ... 23 (internal decoding error)`，mpv 自动切回 `nvdec-copy`；1080p30 复测也未保持 direct。非黑 DMA-BUF 读回发生在回退之后，不能标为 Intel direct 成功。这里确认了模块构建缺口和运行时失败点，尚不能把解码错误归因到某一个驱动/内核/互操作原因。默认继续 `auto-copy`，不因 NVIDIA 的成功而对 Intel 全局启用 direct。

## FD 调度与 CPU 成本

以 libuv readiness 取代 main 每 5ms 空轮询；单 FD 单 watcher，stop-before-close，只有待发 ACK 时监听可写。GPU 每轮最多处理三槽，CPU 每轮最多一包；250ms watchdog 只检查健康截止时间，不轮询 socket。关闭 watcher、立即复用 FD、队列压力及 worker 环境退出均通过实际 Electron 44 原生测试。GPU `glFinish`、三槽租约和 CPU 私有复制信用额度不变。

CPU 仍使用不透明 RGBA Canvas 合同。删除 alpha 补写必须先改变整个消费者合同；把 `pread` 搬到线程也不会消除私有复制。新增 alphaFill、renderCall、cpuRead 等分段统计，按实际成本决定后续变更，不以减少输出尺寸、颜色处理或字幕换取吞吐。

## 验证入口

- `scripts/linux-playback-profile.mjs`：真实窗口、至少 60 秒、CPU/RSS/生产与提交计数、阶段耗时、事后合成画面。`JAVDEX_PROFILE_HWDEC` 只在验收 main 钩子中选择 `auto-copy` / `nvdec,auto-copy` / `vaapi,auto-copy` / `no`，不开放产品任意 mpv 命令接口。
- `scripts/linux-texture-lifecycle-acceptance.mjs`：GPU/CPU、Canvas/video、延迟、重开、页面退出及独立 CPU 故障恢复。
- `scripts/linux-fd-transport.test.cjs`：真实 SCM_RIGHTS / uint64 ACK / readiness / FD 关闭复用与 worker 清理，memfd 传输测试不冒充 DMA-BUF 导入验收。

相关播放单元测试 85 项通过，类型检查、修改文件 ESLint、桌面构建通过；源码/打包/原生时序测试 52 项通过，1 项 Windows 专用工具链测试在 Linux 跳过。最终包四组生命周期验收通过：Wayland Auto、XWayland GPU、XWayland CPU、Wayland `--disable-gpu` CPU。覆盖启动期间 seek、自检、暂停/恢复、隐藏无忙循环、显式恢复后保持同一 producer、两秒 renderer 停顿、缩放/全屏、停止/重开、页面重载或 GPU helper 终止后的独立 CPU 恢复。首轮隐藏测试误将应用既有的“隐藏时暂停、显示后等待用户恢复”行为判为卡死；修正验收操作后复测通过，未改该产品行为。

## 最终包的性能复测

最终包：`dist/linux-optimization-20261026-final/Javdex-0.9.1-x86_64.AppImage`。同一最终包中的 copy/direct 对照如下；旧轮询包与最终 GPU 包还存在 EGL mapper 编译差异，不能把它们之间的所有 CPU 差异归因到 FD 调度。

| 测试 | CPU（单核100%） | 生产 fps | mpv 丢帧 |
| --- | ---: | ---: | ---: |
| final-wayland-copy | 142.38% | 60.034 | 0 |
| final-wayland-direct | 94.48% | 59.967 | 0 |
| final-x11-copy | 160.40% | 60.000 | 1 |
| final-x11-direct | 111.33% | 59.966 | 0 |
| poll-wayland-cpu4k | 644.41% | 8.950 | 2603 |
| final-wayland-cpu4k | 627.39% | 8.917 | 2606 |

所有这些行的“测量完成”只表示采样和画面检查成功，不代表达到 60fps。两轮 CPU 4K 的媒体时间在 60 秒采样中仅前进约 52 秒，仍是明确的性能不足。

正常 GPU 播放约 118–119 次 readiness 回调/秒，另有约 4 次健康检查/秒，减少了原来每 5ms 空轮询的唤醒。暂停/隐藏没有 socket 忙循环。最终包 Wayland copy 的 producer→ready 平均约 8.24ms、direct 约 2.99ms；这些是阶段时延，不是物理显示延迟。没有证据称 readiness 单独显著降低了整个应用 CPU。

CPU 4K 最终包：renderCall 45.44ms/帧、alphaFill 11.05ms/帧、main cpuRead 28.12ms/帧、rendererSubmit 20.96ms/帧。不同流水线阶段可重叠，不能直接相加为帧周期。当前 Canvas 仍需要有效 alpha；video 的 4K 原型反而更慢，所以不删除 alpha 补写。同步像素读取已有值得继续优化的证据，但安全异步化还需要全局有界工作队列、独立 FD 生命周期、停止取消及旧会话结果丢弃；本轮保留私有复制，不引入尚未验收的新线程所有权合同。

## 最终功能与构建检查

- 四组色彩矩阵：Wayland / XWayland × GPU / CPU，各覆盖 SDR 全范围、有限范围、HDR10、HLG，以及播放、暂停、前后跳转、停靠、展开、全屏、恢复共八种阶段；另验收 GPU 故障后 HDR→SDR 的 CPU 恢复。全部通过软件合成像素参考检查。首次使用旧样片清单被新版验证门禁拒绝，重新生成并验证编码标签和像素后的样片通过；没有放宽像素阈值。本轮未覆盖独立的无元数据 PQ 专项。
- Wayland GPU、XWayland CPU 的复杂 ASS（矢量裁切、卡拉 OK）和原始 PGS（透明区、提示时间、暂停跳转、多种显示状态）通过；样片为自制几何图形，PGS 另经 FFmpeg 独立像素解码验证。此字幕样片无音轨，不作为音画同步证据。
- 扩展播放测试：418 通过，10 项 Windows/macOS 原生实机测试明确跳过；构建/发布合同测试 76 通过、1 项 Windows 工具链测试跳过，设置合同 32 通过。修改的 TS 通过 lint，类型检查及桌面构建通过，`git diff --check` 无错误。
- 对最终 AppImage 真正解包，核对运行时前缀、app.asar、Electron、ANGLE、两份 helper、FD addon 和 libmpv 与被测 unpacked 目录逐项一致；重新验证源码伴随包、依赖闭包、两份 addon 加载、私有 FD 缺失拒绝及两份 libmpv PCM EOF。证据：`final-installer-identity.json`、`final-extracted-validation-r2.log`。

本轮不修改默认解码策略或默认 Canvas，不删除 glFinish，不改变系统设置，没有提交、推送或发布。NVIDIA direct 的收益值得下一步扩大编解码/操作覆盖后再正式选择；Intel direct 的解码错误和消费端初始化失败保留为未解决兼容性项。CPU 4K60、物理呈现反馈、原生 HDR、其它机器以及真实听觉同步仍不属于已通过范围。

AppImage 本体启动（通过 AppImage 运行时，而非直接调用 unpacked/AppRun）已通过同一 Wayland Auto 生命周期和实际 CPU 故障接管测试。两份最终解包 FD addon 也重新通过真实 SCM_RIGHTS、readiness、ACK 压力、关闭复用和 worker 退出测试。最终安装包 195712821 字节，SHA-256：`9b7bb10fc1991683438e09715fa0046ca5a250dc1dfb538c29c9bafba4ddd4ca`。未将失败记录删除或改记为通过。

## 后续：Wayland video 首帧修复

本记录中的 Wayland GPU video 自检失败属于当时构建的真实结果。后续通过首次写入延时对照定位为 MediaStream 显示端异步连接竞态，已以有界首帧引用重送修复；新包的生命周期、60 秒对照、色彩及字幕结果单独记录在 [Wayland video 验收](linux-wayland-video-validation-2026-10-26.md)。不覆盖本记录原始失败证据，默认 Canvas 仍保留。
