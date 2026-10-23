# macOS 共享视频帧实验验证

2026-10-23，在 `23c761bc` 之上的未提交开发修改上完成 Apple M4 / macOS 26.5 arm64 验证。Electron 为 43.8.0，开发 libmpv 为 Homebrew 0.41.0。保留 Linux 时序、色彩与正式发布流水线修改，未改 Windows 后端、默认播放路径、公开安装包或版本。

当前状态是可运行的显式实验，不是默认后端迁移完成。默认仍使用 `NSOpenGLView`；关闭 `--javdex-mac-shared-texture` 并重启即可回滚。实验构建入口与租约合同见[开发指南](../DEVELOPMENT.md#内置播放运行库)和[播放合同](../BUILTIN_PLAYBACK.md#原生与远程边界)。正式运行库构建、macOS x64、签名及安装包输入未迁移。

## 共享边界

原生 CGL/OpenGL 生产端写入 IOSurface；Electron 在 main 导入，再由其公开的 opaque transfer 交给沙箱 preload。IOSurfaceRef 仅在本进程 N-API 返回值和 main 导入调用中使用，不经过 helper JSON，也不进入页面 API 或共享合同。`sharedTextureReceiver.ts` 复用 Linux 的 Canvas 消费、单调时钟校准、目标时间等待、取消、旧帧丢弃和提交语义；`frameBudget.ts` 共用 8–40ms 有界预算调整。native/core 的既有 `hwdec=auto` 保持。

三槽不能在 producer 完成前导入，也不能在 consumer 完成前复用。当前用 `glFinish`、preload 的 GPU-complete release callback 和 main 的 `allReferencesReleased` 串联边界。真实 renderer 崩溃检查中生产者停止，三张未确认表面被隔离至进程退出，未提前回收；这不是“崩溃后可直接重开已验收”。GPU 进程异常的受控停止有回归测试，未主动杀死本机共享 GPU 进程。

依据为 Electron 43.8.0 的 [sharedTexture API](https://github.com/electron/electron/blob/v43.8.0/docs/api/shared-texture.md)、[subtle release 与同步合同](https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-imported-subtle.md)及 [transfer 对象](https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-transfer.md)。生产者不是 Metal；Chromium 报告 `ANGLE_METAL` 只描述消费端，不是物理上屏或端到端零拷贝证明。

## 实际发现与修复

1. 高层 `sendSharedTexture` 固定 1000ms 超时，阻塞 renderer 1.5 秒会丢失迟到导入的跟踪并关闭会话。改用文档支持的 subtle 转移与 GPU-complete 确认；仍最多三槽，超过可用槽时跳过生产更新，不静默换 CPU。
2. 一次三素材整组停止后残留一张表面。单独素材可通过，归零 backing store 后三素材整组也可通过，但延长重开又残留一张，不能把短测归零当作解决。该帧已提交、消费端 GPU 释放回调未返回，后续帧释放正常。最终对完整帧使用 `copy` 绘制而非默认 `source-over` 叠加，同时解绑时清空 backing store；同一五轮慢消费／全屏／缩放／停止重开复测均归零。这支持旧叠加记录持有帧的判断，但不构成数小时稳定性保证；没有加入超时强制回收。
3. 异常元数据在导入前需归还新租约，但不能释放重复的消费中 ticket。交付结果不明则隔离；页面已销毁导致 flush 发送失败也必须完成原生销毁。相应回归均先失败后修复。
4. 最终全套检查暴露原有 AI 字幕测试的发布竞态：`translatedSeconds` 已完成时，异步 ASS 写入与 native 更新可能尚未完成，读取空更新列表失败。仅让该测试等待真实更新回调，仍核对旧音轨取消与新音轨字幕内容；产品逻辑未改。

初次独立探针曾因 `data:` 页面缺少安全上下文中的 `crypto.randomUUID` 失败，换成本地测试页后通过，没有放宽沙箱。另一次组合夹具跨越隔离媒体库根，被产品路径核对拒绝；后续使用同根合成素材，不扩大资料库权限。这些失败日志保留，不记作通过。

## 窗口与控制检查

使用隔离资料库和合成 H.264 1080p24、4K24、AAC／AC3／EAC3／DTS 多音轨及 ASS 素材。真实 Javdex 窗口截图已查看，视频和字幕可见；不使用 native FBO 冒充新路径窗口证据。通过的范围包括暂停恢复、连续绝对 seek、全屏／Escape、滑杆方向键 5 秒步进、Tab 留在播放器、DOM 可访问名称、Retina 2×、125% zoom、resize、隐藏恢复、停止重开。音轨切换读取实际 CoreAudio 状态且不重开媒体，ASS 可关闭与恢复。

最终五轮重开各阻塞消费端 1.5 秒，50 次逐秒/边界采样和 20 组控制检查通过，全部正常停止后租约归零。它覆盖数分钟短循环，不等于数小时连续播放，也不取消崩溃表面的隔离规则。

只有一块可用显示器，未做多屏移动。DOM/键盘检查不是系统读屏语音、物理输入设备、人耳听感或口型同步验收。

## 色彩

实验路径明确输出 opaque BGRA8、BT.709 primaries、sRGB transfer、RGB full range，Electron 导入与 `alpha:false` sRGB Canvas 使用同一标记。libmpv 把 HDR 映射到 SDR；[mpv 0.41 的目标色彩选项](https://github.com/mpv-player/mpv/blob/v0.41.0/DOCS/man/options.rst)决定转换，不将色彩标签等同于转换本身。

真实窗口截图检查 SDR limited/full 灰阶及原色、PQ 与 HLG 的黑位、中性灰递增和高光区分，未做 Canvas 读回辅助首次截图。SDR 的显示参考按 BT.1886 gamma 2.4 映射到 sRGB，误差界限 3/255；与旧路径未标记字节直出的中灰不同是明确目标转换，不宣称像素一致。实测红通道灰阶：

| 输入 | 八块输出值 |
| --- | --- |
| SDR limited | 0, 0, 8, 45, 120, 187, 238, 255 |
| SDR full | 0, 0, 8, 45, 120, 188, 239, 255 |
| HDR10 | 0, 1, 15, 62, 135, 185, 249, 255 |
| HLG | 0, 1, 15, 62, 135, 185, 249, 255 |

这些是合成参考与截图数值，不是显示器校准、真实 HDR／EDR 输出、广色域、动态元数据或任意影片色彩保证。一次与其他 GUI 验证并行的 HLG 捕获为黑，断言失败并保留日志；最终色块检查独立顺序执行通过，不将该并行检查记作通过。

## 新旧短时对照

同源应用、相同合成素材、顺序独立运行，无并行构建或测试。每项取约 8 秒稳态，截图窗口均为 2760×1696；新路径纹理为 2760×1425，4K 是输入而非原生 4K 扫描输出。CPU 由 Browser、GPU、Tab、Utility 的累计 CPU 秒增量除以墙钟间隔计算，100% 为一个逻辑核心。工作集为各进程采样值之和，包含共享页，不能当作独占内存。GPU 进程 CPU 不是 GPU 利用率；普通权限的 `powermetrics` 拒绝运行，未提权或增加授权，功耗／能耗未测。

| 路径 | 输入 | 实际 hwdec | CPU 单核百分比 | 峰值工作集之和 MiB | mpv 丢帧增量 |
| --- | --- | --- | ---: | ---: | ---: |
| 旧原生视图 | 1080p24 | videotoolbox | 18.5% | 651.3 | 0 |
| 新 IOSurface Canvas | 1080p24 | videotoolbox | 37.3% | 651.5 | 0 |
| 旧原生视图 | 4K24 | videotoolbox | 20.5% | 719.2 | 0 |
| 新 IOSurface Canvas | 4K24 | videotoolbox | 38.3% | 726.3 | 0 |

两条路径原生 render 计数约 24fps。新路径约 8 秒分别有 195／195 次 Canvas 提交；接收至提交的 P95 间隔为 12.5／8.9ms，包含目标时间等待，不是解码到屏幕延迟。短测显示 CPU 开销上升，不能据此宣传性能或省电改善，也不能把 mpv 丢帧为零解释为物理显示不丢帧。

## 检查与剩余关口

完整 `npm test` 退出 0，包括架构、lint、类型、打包与来源、播放夹具、构建选择和备份状态检查。Electron 部分 4296 项，4255 通过、0 失败、41 条件跳过。另显式加载本机 IOSurface addon 的播放相关组合 74 项全部通过、0 跳过；这与默认宿主跳过分开记录。正常 `npm run build` 和显式双 addon 原生开发构建通过。

默认切换前仍需处理 CPU 开销、崩溃后的应用重启边界，补 macOS x64／正式运行库与签名输入、多屏、系统辅助技术和声音、数小时连续播放、GPU／能耗与物理显示验证。没有改 Windows 后端或重跑 Windows 原生验收；Linux 共用消费与预算的回归通过，不冒充本机能进行 Linux GUI 验收。

本轮不提交、不推送、不合并、不发布，也未下载验收公开软件产物。原有 Linux 和正式流水线提交保持不变。

本地证据保存在 `out/playback-acceptance/macos-shared-20261023-*/`，包含各场景报告、实际窗口 PNG、最终全套与定向检查日志、失败日志、`summary.json`、源码摘要及文件清单；这些目录不进入安装包或公开源码验收结论。
