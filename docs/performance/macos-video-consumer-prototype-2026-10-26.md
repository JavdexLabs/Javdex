# macOS 视频合成消费原型验证

2026-10-26（Asia/Shanghai），固定源码 `dev@7e522df2fb3385015f16a55a2097ed53c511f263`。本轮只验证独立原型，没有修改正式播放器、三平台共用层、Electron 依赖、安装包或发布资产；此前未提交的 Release 文案和 ANGLE 源码交付改动保留。

同日后续按用户确认完成的 Electron 升级与正常应用验证，单独记录在 [产品接入](../reviews/macos-video-consumer-integration-2026-10-26.md)；下文运行时版本、CPU 数字和失败均为原型阶段的历史证据。

## 结论

`共享 BGRA IOSurface → Electron VideoFrame → MediaStreamTrackGenerator → video` 在本机可绕过 Canvas2D 的缓存纹理复制，并在短时对照中降低 CPU。该结论的运行时条件是独立 Electron **44.9.3**；仓库固定的 **43.8.1** 会崩溃，不能直接把原型接入现有程序。

Apple M4／macOS 26.5 arm64。两种消费者均使用同一份当前源码重编译的开发 addon、Homebrew libmpv 0.41、`hwdec=auto`、CGL／IOSurface、BGRA8／BT.709／sRGB／RGB full 输出和 `glFinish`。正式运行库未重建。原型把原生生产者放在独立窗口宿主的 main 中；它不是正常应用的隔离 utility-process、业务会话和控件验收。

## 当前运行时的阻挡与上游修复

43.8.1 下，直接共享帧送入视频轨道，在 3 帧后稳定出现 renderer `crashed / exitCode=11`，未确认的三张表面保留到进程退出，没有伪造完成或提前复用。相同生产者的 Canvas 对照约 4 秒生产／归还 97 帧，停止归零。

逐项对照保留了以下结果：

- 关闭视频轨道 eager NV12 转换仍崩溃；正常原型不带这些诊断开关。
- 先把画面复制到 CPU 内存再送入 video 可以播放；这是定位对照，不作为优化候选。
- 保留源帧 clone 可避免立即崩溃，但三槽耗尽而停帧；该方案失败，没有以保留引用规避资源检查。
- 本地 minidump 的异常线程为 `VideoFrameCompositor`，PC 落在 `v8::MicrotasksScope`。这与上游修复描述的“共享帧可在任意线程析构，JS 回调和 GPU 清理却必须回到所属线程”吻合。完整私有符号未加载，不把每个匿名栈帧解释为已精确符号化。

[Electron 修复 #53738](https://github.com/electron/electron/pull/53738) 将共享纹理改为所属 sequence 析构，并把 VideoFrame release 回调投递回该 sequence。[44.9.3 固定源码](https://github.com/electron/electron/blob/v44.9.3/shell/common/api/electron_api_shared_texture.cc) 包含修复；[43.8.3 固定源码](https://github.com/electron/electron/blob/v43.8.3/shell/common/api/electron_api_shared_texture.cc) 仍没有。44.9.3 原型使用 Chromium `152.0.7977.167`／Node `24.22.0`；同一直接帧原型的崩溃消失，停止释放正常。没有升级仓库依赖或修改 Electron 二进制。

## 复制与分配核查

稳定区间的 source 映射与 trace 相互印证：

| 消费者 | 原始 buffer 导入 | 额外 SharedImage 创建 | 合成器接收 |
| --- | ---: | ---: | --- |
| Canvas2D，约 3 秒 | 72 | 72，恰好每个新帧一次 | Canvas 图像 |
| video，约 3.78 秒 | 91 | 0 | 91 个硬件帧 |

video 提交记录仍标记 `BGRA_8888`、`label: SharedTextureVideoFrame`；稳定区间没有 `CopyVideoFrameToMappableSharedImage`／`CopyRowsToNV12Buffer` 转换事件。截图产生的 NV12／读回事件位于测量区间结束之后，单列排除。这里支持“绕过现有 Canvas 缓存复制”，不证明驱动内部没有搬运、固定 GPU pass 数、物理显存带宽或整条链路零拷贝。

原生输出表面的生产完成、consumer GPU 依赖及最终 `allReferencesReleased` 仍分别确认。`writer.write()` 完成与视频帧回调都不作为原生槽位可复用的依据。CPU 兼容 Canvas 未修改。

## 同版本 CPU 对照

所有对照都使用 **Electron 44.9.3**，避免把运行时升级误归因为消费者收益。每次预热 3 秒、采样 15 秒，按配对交替先后顺序串行运行；测量期间没有 trace、截图、像素读回或逐帧日志。使用进程集合稳定的 `app.getAppMetrics()` 累计 CPU 时间差，**100% 表示一核满载**；GPU 进程 CPU 不是 GPU 利用率。截图在采样后采集。

| 输入／实际输出 | 配对数 | Canvas CPU | video CPU | 均值相对变化 |
| --- | ---: | ---: | ---: | ---: |
| 1080p24／1920×1080 | 3 | 30.68% | 27.08% | −11.7% |
| 4K24／1920×1080 | 3 | 31.10% | 28.78% | −7.5% |
| 4K24／3840×2160，实际全屏 | 2 | 37.73% | 32.05% | −15.1% |

1080p 三对 video−Canvas 分别为 −4.21、−3.29、−3.31 个百分点。4K 输入缩放到 1080p 的三对为 +0.19、−3.57、−3.59，第一对没有改善，不能将该组均值描述为稳定降幅。实际全屏两对 Canvas／video 分别为 38.42%／32.58%、37.05%／31.52%。样本少、区间短，不能外推长期功耗或所有素材收益。

各配对的实际原生／消费速率约 24fps、mpv 丢帧增量为零，正常停止租约归零。另有 1080p60 和 4K HEVC Main10 30fps 的短时 video 检查，实际硬解均为 VideoToolbox，原生及 video 回调约 60／30fps，视频质量计数 dropped／corrupted 均为零。后者输出仍为 1920×1080，不是 4K60 输出验收。

## 生命周期、字幕与色彩

- 暂停后媒体时钟保持；暂停 seek 到 5 秒后输出新帧并继续暂停，同一会话未重开。
- 暂停时 resize 到 1440×810，再恢复 1920×1080，租约继续有界。
- 外挂原创 ASS 在暂停画面实际出现，字幕开／关截图有 24,699 个显著变化像素，并已查看真实窗口图像。
- 隐藏／恢复后继续播放；阻塞 renderer 1.5 秒时最多三槽，没有强制释放或覆写。
- 两次追加停止／重开均恢复真实视频回调；整组 217 帧生产／归还全部对应，最终零租约，无强制结束。
- SDR limited／full、HDR10、HLG、无亮度元数据 PQ 五类夹具分别比较 Canvas／video；16 个采样位置的最大通道差均为 **0**，输出 opaque，灰阶保持中性。PQ 均匀 100-nit 夹具另与独立 BT.2390／sRGB 参考约 164.27 字节值比较，误差不超过 3。HDR 结果是既有 SDR 映射，不是 HDR 直通或显示器校准。

## 保留的验证器失败

没有改写失败结果：

1. 初次把均匀 PQ 夹具误套为递增灰阶，单调断言失败。核对固定夹具的 `shape=uniform` 后，使用均匀度和独立亮度参考，Canvas／video 数据均不改写。
2. 初批 native 4K 输出虽然是 3840×2160，但 macOS 限制普通窗口高度，截图只有 3840×1920。尺寸断言拒绝该组；旧样本仍保留，不用于完整 4K 显示结论。改为真实 macOS 全屏后重新完成两对，窗口内容、原生帧和截图均为 3840×2160。

## 复跑与证据

独立原型和全部原始结果在 `out/playback-acceptance/mac-video-prototype-nv1lz723/`，没有进入应用入口。该目录包含本轮 addon／源码摘要、旧运行时崩溃与 minidump、43／44 对照、12 组初始配对、色彩、生命周期、尺寸失败及正确全屏重测。`validation-summary.json` 是结果汇总，`evidence-manifest.json` 绑定关键文件的实际大小与 SHA-256。

从仓库根目录复跑单个候选（每次生成新的结果目录，不覆盖旧证据）：

```sh
JAVDEX_PROTOTYPE_ELECTRON="$PWD/out/playback-acceptance/mac-video-prototype-nv1lz723/electron-44.9.3/Electron.app/Contents/MacOS/Electron" node out/playback-acceptance/mac-video-prototype-nv1lz723/prototype/run.mjs video /tmp/javdex-mac-perf.3vkp96/synthetic-1080p24.mp4 3 trace default safety
```

既有结果分析：`node out/playback-acceptance/mac-video-prototype-nv1lz723/prototype/analyze.mjs`。本机原型开发运行时已独立准备；该命令不安装依赖、不改产品设置。合成媒体路径需仍存在。

## 后续判断与边界

可以继续设计正式接入，但必须先解决 Electron 运行时版本条件，并单独评估升级对三平台的影响。之后再将消费实现接入现有隔离宿主、播放会话和通路自检，验证当前 UI、音画时序及故障恢复；不能用这次独立窗口结果替代。

本轮未验证 Windows／Linux／Intel Mac 原生 GUI、数小时持续播放、多屏／跨 GPU、真实驱动故障、主观听音／唇音同步、物理扫描延迟或功耗。未做安装包／签名／独立公开软件产物验收，未提交、推送或发布代码；GPU 默认、CPU 回退和用户设置均未改变。
