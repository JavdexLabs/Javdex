# macOS video 消费者接入

2026-10-26（Asia/Shanghai）。以 `dev@7e522df2fb3385015f16a55a2097ed53c511f263` 及保留的本地源码交付工作为起点。用户确认升级 Electron 并在 Mac 采用原型方案；遇到 macOS 钥匙串授权阻塞后，另授权临时跳过读取。当前为源码工作区验证，未发布安装包。

同日后续按用户确认，将 Mac CPU 显示接到 video，见 [CPU 接入记录](macos-cpu-video-integration-2026-10-26.md)。下文保留初次 GPU 接入时的 Canvas CPU 路径与测试范围。

## 实现与边界

Electron 与原生构建 SDK 固定为 **44.9.3**，实际应用报告 Chromium **152.0.7977.167**、Node **24.22.0**、模块 ABI **149**。同步 Linux ANGLE revision `4f2e7d39252ed0e8387ebee1b222d4715f2dea7d` 与 Electron 的 44 个固定补丁；已核对上游 Git blob 及本地摘要，并在该版本的原始 DisplayVkXcb 源码检查 Javdex X11 补丁可应用。这不是 Linux ANGLE 原生重建或 GUI 验收。

Mac GPU 使用 `共享 BGRA IOSurface → Electron VideoFrame → MediaStreamTrackGenerator → video`，由 preload 消费原始帧，保留现有 HTML 控件；正常播放不经过 Canvas2D 缓存绘制。Windows/Linux GPU 和全部 CPU 路径继续使用 Canvas。原生生产者、视频解码与音频仍由隔离宿主和 libmpv 管理，没有替换为浏览器解码器，也没有新增 CPU 兼容模式的隐藏 GPU 依赖。

共用绑定、单调时钟、时间轴、物理尺寸、三槽租约及一次 CPU 恢复语义保持。`writer.write` 或 video 帧回调只表示消费／呈现进展，不能归还原生租约；仍须经过 consumer GPU 完成回调、main 源引用释放和 `allReferencesReleased`。换时间轴、停止和解绑停止旧轨道并重置流；迟到操作不能提交到新绑定。

固定色块检查经过实际挂载的 video：隐藏合成色块，等待真实视频帧回调，以一次临时 sRGB Canvas 读取 640×360 固定样本，再恢复影片流。该读回是自检／显式诊断，正常影片逐帧提交没有读回。输出仍为 BGRA8、BT.709 primaries／sRGB transfer／RGB full 的 SDR；不宣称全链路零拷贝。

Electron 升级是前提：[共享 VideoFrame 跨线程析构修复](https://github.com/electron/electron/pull/53738)包含在 [44.9.3](https://github.com/electron/electron/releases/tag/v44.9.3)。旧 43.8.1 原型的崩溃及短时 CPU 配对保留在[原型记录](../performance/macos-video-consumer-prototype-2026-10-26.md)，不把独立原型的 CPU 数字充当正常应用性能对照。

## 发现与修复

- 异步 video 自检与立即跳转／几何变更可并发：旧流取消后主进程仍等待旧回执。新增回归先得到 `pending` 而非 `passed`，修复为只在 Mac 显示中的待完成自检被刷新时重新申请；旧结果按序列隔离。相关 60 项测试全部通过。
- Electron 44 的剪贴板写入返回 Promise；“复制模型下载地址”现在等待写入完成，错误经现有 IPC 返回。首轮完整 lint 的真实失败保留。
- 验收脚本适配 video 的实际帧计数、固有尺寸和 sRGB 显示采样；调整窗口后等待真实物理尺寸，避免把重置中的 0×0 当作验收结果。宿主停止后保留先前观察的三槽峰值，不伪造退出后的原生计数；仍拒绝活跃宿主缺失计数或超过三槽。

## 本机结果

Apple M4／macOS 26.5 arm64，当前源码重建的开发 addon 与 Homebrew libmpv 0.41；原生核心及 Mach/IOSurface 预检通过。以下均运行真实编译后的正常业务应用、隔离资料库与 utility-process 生产者。

| 检查 | 实际结果 |
| --- | --- |
| Electron 安装、better-sqlite3 重编译、原生构建、桌面生产构建 | 成功 |
| 定向接入测试 | 133 通过；后续自检取消回归相关 60 通过，无跳过 |
| 24／30／60fps | 实际 video、原生与提交速率符合各自帧率门槛，新增 mpv 丢帧为零 |
| 最终源码重建复验 | 桌面生产构建成功；1080p24 与 4K24 输入各八秒正常 GPU 播放、实际 video 约 24fps、停止归零、正常退出通过；4K 指片源，不将窗口输出夸大为完整 4K 上屏验收 |
| 操作与几何 | 暂停、连续跳转、全屏、Escape、滑杆与焦点、隐藏／恢复、停止释放通过；Retina 2100×1105／DPR 2，125% 缩放 2100×1039／DPR 2.5，与实际 CSS 尺寸对应 |
| 色彩 | SDR limited/full、HDR10、HLG、缺省元数据 PQ 五组及各展示状态通过；独立保留 sRGB 数值和窗口截图 |
| 回退 | 一次原生帧故障后真实 CPU 接管通过；强制 CPU Canvas 通过 |
| 字幕 | 复杂 ASS 合成／矢量裁剪／卡拉 OK，以及原创 PGS 透明度／时序／暂停跳转／同会话展示检查通过；报告仍保留 `partial-pass` 范围标记 |
| 背压与生命周期 | 五轮 1.5 秒阻塞消费者后停止重开通过，峰值三槽，停止后 9–14ms 归零；自有 renderer 崩溃后未知资源有界隔离直到退出通过 |
| 临时钥匙串入口 | 6 项隔离／拒绝测试通过；租约计数回归 2 项通过，已加入常规测试入口 |
| 完整源码门禁 | `npm test` 退出 0：架构、lint、类型、打包／源码配方／夹具等门禁通过；Electron 4,593 项，4,558 通过、0 失败、35 项宿主跳过 |

上述 GUI 子进程均正常退出，`forced=false / code=0 / signal=null`；主动崩溃测试只终止自有验收 renderer。

## 钥匙串与证据

正常启动最初阻塞，采样确认主线程位于 `SecItemCopyMatching`。用户暂时无法处理授权，因而显式设置 `JAVDEX_ACCEPTANCE_NO_KEYCHAIN=1`，由测试包装入口把 safeStorage 标记为不可用，拒绝加解密调用，再加载同一应用入口。包装只允许未打包的 Mac、临时验收资料目录和明确参数；拒绝常规资料目录及越界符号链接。未读取密码、修改系统钥匙串权限或提供明文替代；正常应用凭据代码保持原样。因此本次 GUI 结果不覆盖钥匙串／凭据集成验收。

原始证据与失败保留于 `out/playback-acceptance/mac-video-integration-29sq5ph2/`：初始快照和构建备份、安装／编译／测试日志、启动栈、自检回归红绿日志、GUI JSON／截图、上游版本和 ANGLE 补丁核对材料。`gui-summary.json` 保留速率、实际几何和清理结果；最终进度与文件摘要保存在同目录，不把临时路径作为仓库永久产物。

未执行新 Windows/Linux 原生构建或 GUI、Intel Mac、多显示器迁移、物理 HDR、声音／口型人工判断、长时功耗、签名安装包或独立公开软件产物验收。没有提交、推送、发布或改动公开版本资产。
