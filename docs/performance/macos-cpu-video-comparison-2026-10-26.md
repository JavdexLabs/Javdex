# macOS CPU Canvas 与 video 性能对照

2026-10-26。本机结果支持继续把 Mac 的 CPU 显示端收敛到 video，但总 CPU 基本在同一量级；主要收益是减少接收端复制和共用显示实现。此轮比较使用隔离测试副本，比较当时正式 CPU 路径仍为 Canvas。后续按用户确认实施的 [Mac CPU video 接入](../reviews/macos-cpu-video-integration-2026-10-26.md)单独记录，以下数字保留比较阶段的范围。

## 条件与方法

Apple M4、macOS 26.5 arm64、Electron 44.9.3、Chromium 152.0.7977.167，当前 `dev@7e522df2fb3385015f16a55a2097ed53c511f263` 加保留的本地改动。三种消费者都复用正常应用的隔离软件播放宿主、libmpv 0.41、软件解码／SW Render API、相同 RGBA 输出、IPC、播放控制和两帧复制信用额度。没有用 GPU 硬解代替 CPU 解码，也没有将原生生产者移到测试 main。

仅复制并修改编译后的测试 preload；业务 renderer 保留 Canvas 占位，测试副本为 CPU video 挂载同尺寸的 video。正式源码和原有 `out/main`、`out/preload`、`out/renderer` 保持原样。沿用用户授权的临时钥匙串隔离入口和全新测试资料目录。

主对照采用 Canvas 与 `RGBA VideoFrame + ArrayBuffer transfer → MediaStreamTrackGenerator → video`。每种条件两对，顺序为 Canvas→video、video→Canvas，串行运行；预热 3.5 秒，采样 12 秒。采样期间无截图、像素读回或 trace；每秒读取计数及进程累计 CPU 时间，要求进程集合稳定、约 24fps、无新增丢帧。1080p 使用实际 1920×1080 输出；4K 使用真正全屏的 3840×2160 输出，截图亦为该尺寸。

CPU 百分比为 **Javdex 全进程合计，100% 表示一核满载**；GPU 子进程的 CPU 不是 GPU 利用率。内存为进程工作集求和的 MiB，可能重复统计共享页，不是唯一物理内存或显存。

## 配对结果

| 条件 | Canvas 总 CPU | video 总 CPU | video 相对变化 | Canvas／video 内存 |
| --- | ---: | ---: | ---: | ---: |
| 1080p24 → 1080p，正常合成 | 101.18% | 103.14% | +1.93% | 994.5／991.8 MiB |
| 4K24 → 4K，正常合成 | 305.62% | 303.49% | −0.70% | 1652.2／1644.0 MiB |
| 1080p24 → 1080p，禁用 GPU | 102.02% | 99.84% | −2.13% | 1068.2／1061.0 MiB |

两对的 video−Canvas 总 CPU 分别为：1080p **+1.34／+2.57** 个百分点，4K **−1.44／−2.82**，禁用 GPU **−1.91／−2.43**。样本短且仅一台设备，这些小幅差异不足以宣称稳定的整体性能提升；内存也没有明显下降。十二次配对运行均维持约 24fps，mpv 无新增丢帧，video 计数无新增 dropped frame，停止及正常退出通过。

接收端从准备像素到提交完成的平均 JS 墙钟耗时，1080p 为 **0.709 → 0.064ms/帧**，4K 为 **2.725 → 0.048ms/帧**。它包含 Canvas 的行复制／`putImageData` 或 video 的构造／写入等待，**不是 GPU 完成或物理呈现时间**。该局部下降没有转化为相同比例的应用总 CPU 下降：软件宿主占大头，浏览器后续上传和合成也继续存在。

普通复制构造的 video 另做一次控制采样：1080p 总 CPU **106.00%**、内存 **1056.5 MiB**、接收端 **0.680ms/帧**。它不是配对统计。固定 Chromium 的构造逻辑中，转移缓冲区时直接包装其内存；未转移时另行分配并复制像素，见 [VideoFrame 构造实现](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/webcodecs/video_frame.cc#L1038)。不能把普通复制版视作相同的优化候选。

还检查了符合 opaque 输出合同的 `RGBX + transfer`：单次 1080p 控制采样为 **99.05%**、**1002.6 MiB**，没有做配对，不据此宣称它优于主对照。下面的色彩、字幕与故障检查使用此不透明格式；RGBA 转移版本的 `buffer.byteLength` 也逐帧确认归零。

## 显示与回退检查

- Canvas 与不透明 video 各跑 SDR limited/full、HDR10、HLG、无元数据 PQ 五组，覆盖播放、暂停、跳转、底栏、展开、全屏、后退跳转及继续；固定采样的最大通道差均为 **0**。这是 sRGB 数值对照，不是物理 HDR 输出或全图逐像素相等的证明。
- `--disable-gpu` 下，RGBA 转移版完成两对帧率／CPU 采样；不透明 video 另通过 PQ 的八种状态及色彩参考，采样与 Canvas 差异为 **0**。GPUInfo 被启动参数禁止时如实保留原因，不将查询失败当作画面失败。
- 真实终止自有应用的 GPU 子进程后，正常播放引擎接管到 CPU video；进度、暂停、音量、静音、1.25 倍速及字幕选择恢复，实际画面和全屏通过，停止后软件宿主／信用额度释放。
- 复杂 ASS 的合成、裁剪、卡拉 OK，以及原创 PGS 的透明度、时序、暂停跳转和同会话展示通过。字幕报告保留其原有 `partial-pass` 范围标记。

成功的功能检查均正常退出，无强制结束。测试脚本最初的错误也保留：错误读取解码状态字段、停止后读取已卸载元素、禁用 GPU 后查询 GPUInfo，以及用旧 Canvas 固有尺寸等待 video。修正观测位置或保留查询原因后重测，没有降低帧率、色彩或资源门槛。

## 收敛方式

本机证据支持在 Mac 共用现有 video 消费者：GPU 输入已导入的共享 VideoFrame，CPU 将已复制到 preload 的不透明 RGBA 缓冲区按真实 stride 包装为 `RGBX VideoFrame`，转移该缓冲区的所有权。共同管理 video 轨道、时序、暂停、刷新与卸载。

两类输入仍分别归还资源：GPU 继续等待实际 GPU 完成及 `allReferencesReleased`；CPU 归还已复制帧的信用额度，不把 writer 或视频回调混作 GPU 租约完成。模式设置、软件解码和一次恢复语义保持。正式接入还应把临时 DOM 挂载替换为正常组件，并补齐回归；其他平台需要各自在原生环境检查，不能直接套用本机的性能数值。

## 证据与复跑

原始文件在 `out/playback-acceptance/cpu-video-comparison-hXcz2Y/`：`paired-summary.json` 保存十二次配对及普通复制控制组，`comparison.json` 保存计算，`runs/` 保存采样、尺寸、进程及截图；色彩、字幕和真实 GPU 故障另存独立目录。`before.json`、最终保留检查与文件摘要绑定工作区及实际二进制。

单次复跑可使用新的结果标签：

```sh
node out/playback-acceptance/cpu-video-comparison-hXcz2Y/run.mjs \
  video-transfer /tmp/javdex-mac-perf.3vkp96/synthetic-1080p24.mp4 \
  1080 normal 12 rerun-1
```

需保留对应测试副本、开发二进制及合成素材；脚本拒绝覆盖既有结果。此轮未提交、推送、替换正式 CPU 显示路径或发布软件，也未执行其他平台 GUI、长时功耗、人工听音／口型或独立公开软件产物验收。
