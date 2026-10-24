# macOS WebGPU 第三方源码对照

electron-mpv-video 提供了真实的 WebGPU external texture 消费实现；sbtlTV 提供的是 WebGL2 消费、排队与故障处理实现。两者可帮助选择设计，但不能证明 Javdex 的三槽所有权合同、Electron 43.8.0 兼容性或性能收益。

2026-10-23。本地基线为 `a994e5169d00d6016731486ee681997cc65695dd` 加本轮开始已有的 21 项工作区改动。范围仅为两个固定提交的静态源码与本地三个文件、[已完成的 API 调查](macos-shared-texture-api-2026-10-23.md)对照；不重复 WebGPU 标准或 Chromium 研究，不执行第三方代码、安装、GUI、性能实验或全面审查。

## 固定源码与版本

| 项目 | 固定提交 | Electron 证据 | 源码许可 |
| --- | --- | --- | --- |
| yscoder/electron-mpv-video | `4944079b4133715848ea3c3bdaf99742b8c68406` | README 自述验证基线为 40.10.5；manifest 为 `^40.10.5`，lockfile 为 40.10.5。[README][e-readme]、[manifest][e-package]、[lockfile][e-lock] | MIT。[LICENSE][e-license] |
| thesubtleties/sbtlTV | `2417567a295688c6caa290277d59715d22e61df3` | manifest 为 `^44.3.0`，lockfile 为 44.3.0。[manifest][s-package]、[lockfile][s-lock] | GNU AGPL v3。[README][s-license-readme]、[LICENSE][s-license] |

Javdex [package.json](../../package.json) 固定 `43.8.0`。Electron 40.x 的实现和作者验证记录不是 43.8.0 的兼容证据；sbtlTV 的 44.3.0 也不能反推 43.8.0。其 preload 中的“Electron 40+”只是注释，实际能力检测也不等于跨版本验证。[sbtlTV preload][s-preload-gate]

## electron mpv video 的实际链路

- **消费端**：`drawVideoFrame` 等待初始化，按 frame 显示尺寸调整 canvas，逐帧调用 `importExternalTexture`，创建 bind group 和 command encoder，绘制后 `queue.submit()`。该 async 函数随后结束，没有等待 `queue.onSubmittedWorkDone`；这个函数的完成只能作为 JS 提交边界。固定类也没有 device loss 或异步 validation error 的处理。[WebGPU 类][e-gpu]
- **正常所有权**：main 设置单个 `sharedTextureFrameInFlight`，每帧重新 import；等待高层 `sendSharedTexture` 后释放 main 引用，再等待 `allReferencesReleased` 才完成本轮。frame pump 用一个 pending 布尔值合并更新，不积累逐帧任务。preload 把 VideoFrame 交给页面回调，逐个 await，最后 close frame 并释放接收端 import。[main][e-main]、[preload][e-preload]
- **异常不能照搬**：main catch 直接清除 inFlight 并调用 `imported?.release()`，外层 pump catch 再清一次标志；若 release 本身抛错，catch 还会再次调用 release。异常本身不能证明 renderer 没有取得引用，清除标志更不能成为 Javdex 归还 native ticket 的依据。preload 的 `getVideoFrame()` 位于 try 之前，finally 中 close 与 release 也没有嵌套保护，因此不能直接当成完整异常清理模板。[main][e-main]、[preload][e-preload]
- **暂停与尺寸**：pause 只是转交 native；切换管线和 destroy 会等 frame pump。ResizeObserver 将容器尺寸乘 DPR 后送到 main，并触发新帧；WebGPU 绘制又按收到的 frame 尺寸更新 canvas。canvas 的 hidden 用于模式切换，这些文件没有窗口隐藏后停止生产的专门协议。[main 生命周期][e-main-life]、[renderer 尺寸与显隐][e-resize]

README 的 `webgl` 模式是软件 libmpv 输出 RGBA 后上传，不能与 shared-texture 模式下的 WebGPU，或 sbtlTV 的 VideoFrame 到 WebGL2 上传混为同一条路径。[模式说明][e-readme]

## sbtlTV 的实际链路

顶层 README 展示 UI 截图；addon README 的架构图明确写 `VideoFrame → WebGL`，但下方 preload 示例使用 `receiveFromMain`，注释又泛称 WebGPU 或 Canvas。实际 preload 使用 `setSharedTextureReceiver`，`VideoCanvas` 创建 `webgl2` context，通过 `texImage2D(VideoFrame)` 上传，再画完整矩形。因此它不是 WebGPU external texture 的第二份实现；截图、图示和“zero-copy”描述也不能充当复制次数或性能测量。[顶层 README][s-readme]、[addon README][s-addon]、[context 初始化][s-init]、[实际绘制][s-draw]、[实际 preload][s-preload]

| 行为 | 固定源码中的做法 | 对本轮的限制 |
| --- | --- | --- |
| 发送与排队 | 最多两个 active sends，另保留一个最新 pending；新 pending 替换旧帧。active send 在 sendFrame 完成时减少，另用 outstandingTextureReferences 记录 allRefs。[bridge][s-send] | 两次发送加一个 pending 不等于最多三份未释放 GPU 引用。macOS 绘制立即上传；只有 Linux 另用最多 6 帧队列及 8 个自有 WebGL texture 槽，排队的是上传后的纹理。[VideoCanvas][s-slots]、[绘制分支][s-draw] |
| 迟到与异常 | preload 按 generation 和 index 丢弃旧代、逆序帧。send 已启动后若 reject，main 保留 import 到 webContents destroyed，销毁还等待 active sends 与 outstanding refs 归零。[preload][s-preload]、[bridge][s-send]、[销毁][s-destroy] | 这是值得参考的引用保留策略。bridge 的精确 bufferId 归还只用于 Linux nativePixmap，不能据此证明 macOS IOSurface 的逐槽回收。preload catch 释放 import，但 callback 抛错时仍依赖 VideoCanvas 履行 close 所有权。[bridge][s-destroy]、[preload][s-preload] |
| 暂停与隐藏 | pause 转交 mpv；visible 控制 CSS display 和恢复超时检测，没有在收帧入口按隐藏状态停绘。[pause][s-controls]、[显隐与健康检测][s-health]、[canvas][s-canvas] | 暂停、隐藏不代表已清空所有引用；不能作为 native 槽回收信号。 |
| resize 与 context loss | canvas backing size 随 codedWidth/Height 更新，不随容器做原生重配；丢失 context 后清理状态，恢复时重建，活跃且已有视频时设置 6 秒恢复期限。绘制用 finally close frame。[绘制][s-draw]、[尺寸][s-size]、[恢复期限][s-health]、[恢复与清理][s-lifecycle] | WebGL 的恢复机制可借鉴其职责分工，不能替代 WebGPU device loss 协议，也不证明本地 resize 时的 lease 安全。 |

### 内存增长记录

sbtlTV 的 0.11.1 记录曾把 macOS/Linux 主进程增长归因于每帧 shared-texture 交接，并报出 60 fps 下每小时约 1.5–3 GB；0.12.0 随后修正为大多趋稳、换台或切内容会释放，并明确早先描述夸大。0.13.0 又记录了停止或切换直播与点播时释放缓存的修复。这些是作者的历史记录，不能选取最早一条作为当前 Electron 泄漏的定论。[历史记录][s-memory-history]、[后续修复][s-memory-fix]

`player-memory.ts` 将停止后保留内存归于 libmpv 0.41 packet reuse pool，注释记录停止后 507 MB、销毁后 37 MB，并以缓存高水位决定是否重启播放器。这是该项目的诊断与规避逻辑，不是 WebGPU 泄漏证据。VideoCanvas 的调试计数是 JS heap，bridge 另记 refs 和 retained transfers；这些计数也不能彼此替代。[内存策略][s-memory]、[JS heap][s-heap]、[bridge 统计][s-stats]

## 对 Javdex 的取舍

以下“本地已有”只描述当前工作区代码，不新增验收结论。

| 可借鉴设计 | 本地已有 | 缺证明与不应照搬 |
| --- | --- | --- |
| 将消费绘制与 main 的帧生命周期分开；GPU device、pipeline、sampler 可跨帧持有 | VideoFrame 和 Electron API 留在隔离 preload，页面只绑定固定 canvas；当前消费为 2D drawImage。[receiver][j-receiver] | 第三方把 frame 传给页面回调，不能因此放宽 Javdex 的隔离边界；也不能把持久 GPU pipeline 类比为持久 Electron import。 |
| 用有界生产和更新合并控制压力，区分 send 与全部引用退出 | native 有三个槽及逐 sequence lease，只选无租约槽；生产后 `glFinish` 再导出，main 对 pending 数量设三帧限制。[native][j-native]、[main][j-main] | **single inFlight 不是三槽合同的完整证明**。仍须逐帧证明生产完成、目标 GPU 消费完成、原始 ticket 归还与 resize/销毁后的身份隔离；send 数量上限不能代替 lease 上限。 |
| 以 generation/index 拒绝迟到帧；绑定生命周期负责取消等待 | surfaceToken、bindingToken、timeline、sequence 过滤；flush 取消等待，resize 和播放命令推进 timeline，解绑清空 canvas backing。[receiver][j-receiver]、[main][j-main] | 不照搬 sbtlTV 的 Linux 排队深度、额外纹理和音频延迟策略；它们与当前 macOS 三槽及 target-time 调度不是同一合同。 |
| 已启动 transfer 失败时保留引用，销毁与最后引用退出分开 | subtle release 回调发送 ACK，main 收 ACK 后 release 原 import，最终 allRefs 才归还 native ticket；transfer 启动后投递异常保留租约，并处理 renderer/GPU 故障。[receiver 释放][j-release]、[main 释放与故障][j-main] | 不照搬 electron-mpv-video catch 的清 inFlight/release；也不能用 frame.close、draw 返回、超时或暂停代替 native ticket 回收条件。 |

既有 [API 调查](macos-shared-texture-api-2026-10-23.md)中每帧重新导入、消费者退出后复用原生槽位及保留生产完成边界的结论继续适用。这两个项目均不能补齐持久 import 的内容更新协议，也没有提供 Javdex 当前链路的 CPU、复制次数或长播内存对照。

## 许可边界与主代理交接

electron-mpv-video 的 MIT 条款要求在复制或实质复用时保留版权和许可声明；README 另外明确 libmpv 不受该 MIT 许可覆盖。不能把项目许可扩展到它使用的原生运行库。[MIT][e-license]、[运行库边界][e-runtime-license]

sbtlTV 的 AGPL v3 包含复制声明、修改与对应源码义务，以及适用时的远程网络交互源码提供条款。Javdex 自身标注 `GPL-3.0-or-later`，不会使所复制的 AGPL 部分自动变成普通 GPL；AGPL 第 13 节也明确组合时原 AGPL 部分继续受其约束。本轮只提炼设计，不移植源码或 WGSL。[AGPL 第 4 至 6 节][s-license-copy]、[第 13 节][s-license-network]、[本地许可声明](../../package.json)

主代理本轮交接已确认当前 Chromium 的 BGRA external texture 走 one-copy/paint 路径，且 VideoFrame.close 会立即 expire/destroyCache；其保守实验链为 `queue.onSubmittedWorkDone → VideoFrame.close → Electron GPU release callback → allReferencesReleased`。这些结论来自主代理的独立调查，不归因于上述第三方项目。本 sidecar 的交付是固定源码比较；独立安全探针由主代理自主实现。

[e-readme]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/README.md#L37-L45
[e-package]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/package.json#L37-L45
[e-lock]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/package-lock.json#L1429-L1440
[e-license]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/LICENSE#L1-L21
[e-gpu]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/src/renderer/mpv-video.ts#L186-L314
[e-main]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/src/main/mpv-service.ts#L324-L400
[e-preload]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/src/preload/index.cts#L28-L44
[e-main-life]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/src/main/mpv-service.ts#L175-L265
[e-resize]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/src/renderer/mpv-video.ts#L624-L638
[e-runtime-license]: https://github.com/yscoder/electron-mpv-video/blob/4944079b4133715848ea3c3bdaf99742b8c68406/README.md#L382-L394
[s-package]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/package.json#L35-L39
[s-lock]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/pnpm-lock.yaml#L43-L46
[s-license-readme]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/README.md#L170-L172
[s-license]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/LICENSE#L1-L12
[s-preload-gate]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/preload.cts#L356-L382
[s-readme]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/README.md#L8-L14
[s-addon]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/mpv-texture/README.md#L3-L122
[s-init]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L176-L185
[s-draw]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L345-L420
[s-preload]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/preload.cts#L403-L472
[s-send]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/mpv-texture-bridge.ts#L180-L318
[s-destroy]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/mpv-texture-bridge.ts#L507-L568
[s-slots]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L63-L74
[s-controls]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/mpv-texture-bridge.ts#L323-L372
[s-health]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L323-L343
[s-canvas]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L645-L665
[s-size]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L87-L106
[s-lifecycle]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L549-L643
[s-memory-history]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/CHANGELOG.md#L76-L108
[s-memory-fix]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/CHANGELOG.md#L5-L19
[s-memory]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/player-memory.ts#L1-L27
[s-heap]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/ui/src/components/VideoCanvas.tsx#L448-L456
[s-stats]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/packages/electron/src/mpv-texture-bridge.ts#L171-L178
[s-license-copy]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/LICENSE#L183-L237
[s-license-network]: https://github.com/thesubtleties/sbtlTV/blob/2417567a295688c6caa290277d59715d22e61df3/LICENSE#L540-L559
[j-receiver]: ../../apps/desktop/src/preload/sharedTextureReceiver.ts
[j-release]: ../../apps/desktop/src/preload/sharedTextureReceiver.ts#L189-L255
[j-native]: ../../apps/desktop/src/main/player/native/macSharedTexture.mm#L20-L184
[j-main]: ../../apps/desktop/src/main/player/macSharedTexture.ts
