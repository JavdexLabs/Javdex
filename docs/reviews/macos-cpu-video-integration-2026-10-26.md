# macOS CPU video 接入验证

2026-10-26（Asia/Shanghai）。在 `dev@7e522df2fb3385015f16a55a2097ed53c511f263` 和保留的本地 Electron 44.9.3／GPU video 工作之上，按用户确认将 Mac CPU 显示统一到 video。GPU 默认路径、软件解码／绘制、自动 CPU 恢复及用户设置保持原语义；Windows/Linux 继续使用 Canvas。本次为源码工作区验证。

## 显示与资源合同

Mac CPU 的隔离软件宿主继续使用 `hwdec=no` 和 libmpv SW Render API，main 继续复制并通过有界 IPC 交付像素。preload 按真实 stride 把私有 ArrayBuffer 的所有权转移给不透明 `RGBX VideoFrame`，明确标记 BT.709 primaries、sRGB transfer、RGB full range，再通过现有 MediaStreamTrackGenerator 写入 video。正常播放移除逐行 ImageData 复制和 `putImageData`；既有原生输出和 IPC 复制仍然存在，不宣称全链路零拷贝。

只转移 main 已复制的私有缓冲区，原生帧池和 GPU 分配不进入该接口。CPU 消费／丢弃后归还复制信用额度，preload 关闭自己构造的 VideoFrame；浏览器继续持有的帧引用由其生命周期管理。GPU 原始导入帧、真实 GPU 完成回调及 `allReferencesReleased` 仍使用原合同。CPU video 不依赖共享 GPU 纹理接收器注册成功。

GPU 与 CPU 的 surface token 切换会挂载不同的 video，保留同一套 HTML 控件。跳转、解绑和停止取消旧观察及写入，停止旧轨道并清空 srcObject；迟到结果不能提交到新绑定或误报新时间轴故障。尺寸、stride、字节数和既有 8192 单边／256MiB 上界在转移前验证。

## 时序问题及修复

初次接入在 1080p60 出现 Chromium video 丢帧，而 mpv 报告为零。页面相对时钟与生产者单调时钟的定向切换，分别得到 4／0／11 帧丢帧；生产者时基修正后的完整矩阵仍出现 2 帧丢帧。因此保留时基修正，并继续处理突发提交，不把单次零丢帧当作根因已全部解决。

VideoFrame 保留生产者的 `targetTime`／`renderStartUs` 单调时基；只有交付等待映射到 renderer 的 `performance.now()`。固定 Chromium 152 源码中，[本地 MediaStream 消费者](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/mediastream/web_media_player_ms_compositor.cc)不采用远端流的平滑帧队列，替换尚未呈现的当前帧会计入丢帧。CPU 提交增加单帧视频回调背压，前一帧交给合成器后才提交下一帧，避免短时突发覆盖；取消或停止立即结束旧等待。它不改变 GPU 提交／租约语义，也不保证物理扫描输出。

另一个确定性回归复现了复用自检 1.5 秒超时导致短暂 UI 阻塞被误判失败的问题。CPU 观察改用原复制通道的五秒消费预算，GPU 自检保持 1.5 秒。短时阻塞测试先失败后通过，源码定向测试最终为 **162 通过、0 失败、0 跳过**，覆盖所有权转移、行填充、过期帧、并发背压、写入失败、跳转／解绑和时间戳。

## 本机结果

Apple M4／macOS 26.5 arm64，Electron 44.9.3、Chromium 152.0.7977.167；使用本地既有同版开发 addon 和 Homebrew libmpv 0.41。本次没有改动或重新编译原生生产者。以下 GUI 检查运行重建后的正常业务应用、隔离资料库和真实 utility-process 软件宿主。

连续八秒采样的最终完整帧率矩阵如下；原生计数通过异步状态采样，video 计数来自 Chromium，均不等于物理显示器扫描反馈。

| 输入与实际输出 | 原生 fps | video fps | 新增 mpv／video 丢帧 |
| --- | ---: | ---: | ---: |
| 1080p24 → 1920×1080 | 23.72 | 24.10 | 0／0 |
| 1080p30 → 1920×1080 | 29.84 | 29.97 | 0／0 |
| 1080p60 → 1920×1080 | 59.44 | 60.06 | 0／0 |
| 4K24 → 3840×2160 全屏 | 23.97 | 24.09 | 0／0 |

| 检查 | 实际结果 |
| --- | --- |
| 慢消费者与生命周期 | 阻塞 renderer 1.5 秒期间生产停止增加、队列不超过既有两帧预算；暂停跳转、隐藏 2.1 秒后恢复、停止后信用额度归零及旧 video 断开通过 |
| 色彩 | SDR limited/full、HDR10、HLG、缺省 PQ 五组及展示状态通过；相对先前 CPU Canvas 的固定采样最大通道差为 0，最大参考误差 1.79，最大状态漂移 0.20，未放宽原门槛 |
| 禁用 Chromium GPU | 实际 VIDEO、软件解码／软件绘制、2760×1425 窗口和 3840×2160 全屏通过；独立 GPU 播放宿主未启动 |
| 实际故障接管 | 终止本次应用的 Chromium GPU 进程或隔离原生 GPU 宿主后，CPU video 接管；位置、暂停、音量、静音、倍速、音轨和字幕状态保留 |
| 字幕 | 原创复杂 ASS 合成／矢量裁剪／卡拉 OK、PGS 透明度／时序／暂停跳转与同会话展示检查通过；报告保留 `partial-pass` 的夹具范围 |
| GPU 回归 | 正常 GPU video 播放、原生租约有界和停止清理通过 |
| 编译与静态检查 | 桌面生产构建、完整 TypeScript 类型检查、改动 TS／TSX 的 ESLint 通过 |
| 完整 Electron 源码测试 | 4,605 项，4,570 通过、0 失败、35 项宿主跳过；包含最终超时回归 |
| 五秒预算修正后重建复验 | 正常应用 1080p24 video 23.96fps、原生 23.84fps，新增 mpv／video 丢帧均为 0；1.5 秒阻塞、暂停跳转、隐藏／恢复和停止清理通过 |

GUI 子进程均正常退出，`forced=false / code=0 / signal=null`。编码检查、改动文档本地链接与 `git diff --check` 通过。CPU Canvas 与 video 的配对 CPU／内存数据仍见[此前性能比较](../performance/macos-cpu-video-comparison-2026-10-26.md)：整体 CPU 基本持平，本次接入不据此声称显著降低整机 CPU。

## 证据与验证边界

本轮证据保存在 `out/playback-acceptance/mac-cpu-video-integration-BajmoT/`，包括改动前文件摘要／构建备份、定向红绿日志、真实 GUI JSON／截图、完整 Electron 日志及最终文件摘要。最初时基错误、60fps 丢帧和过短等待超时的失败结果均保留。

正常应用凭据代码未改动；GUI 沿用用户授权的 `JAVDEX_ACCEPTANCE_NO_KEYCHAIN=1` 隔离验收包装，因此结果不覆盖系统钥匙串集成。未执行 Windows/Linux 或 Intel Mac 原生 GUI、无物理 GPU 的机器、物理 HDR、人工听音／口型、长期功耗、签名安装包或独立公开软件产物验收。没有提交、推送或发布。
