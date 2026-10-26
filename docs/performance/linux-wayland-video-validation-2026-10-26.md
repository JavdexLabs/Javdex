# Wayland GPU video 首帧与消费者对照（2026-10-26）

## 范围与修复

接续 [Linux 优化验收](linux-playback-optimization-validation-2026-10-26.md)，保留默认 Canvas、`auto-copy`、GPU 完成回调／三槽租约、CPU 回退及旧包。本轮仅修复 opt-in `--javdex-linux-video` 的首帧启动竞态，不更改驱动、系统设置、ANGLE、libmpv 或原生 helper。

在上一轮最终包复现了 Wayland GPU video 首帧自检超时。临时诊断确认 `writer.write()` 已完成但没有 video 帧回调；相同导入路径仅在自检首次写入前等待 100ms，便通过真实像素自检及完整生命周期验收。正式修复没有采用固定启动延时。

固定 Chromium 152 源码说明 `write` 成功不意味着显示 sink 已连接：

- [generator sink](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc) 将帧推送给 source 后即可完成写入。
- [pushable source](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/breakout_box/pushable_media_stream_video_source.cc) 在尚无 callback 时直接返回；轨道和视频 sink 通过异步任务连接。
- [renderer sink](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/mediastream/media_stream_video_renderer_sink.cc) 未启动时也会丢帧。

以上源码与延后写入对照共同支持“自检只发一次，帧早于显示端连接”的原因；没有对 Chromium 每个内部丢帧分支做插桩，不能声称已区分其中的具体分支。之前仅禁用 eager conversion、改变 opacity／ANGLE 均失败，不能归因于 NV12 转换或 DMA-BUF 导入不兼容。

`sharedTextureVideo.ts` 的自检现在保持原始 VideoFrame，写入独立 `clone()` 引用；显示端尚未观察到首帧时每 32ms 最多再提交一次，实际回调立即结束重送，仍受原 1500ms 自检截止时间约束。clone 共享像素所有权，不做 Canvas 或 CPU 像素复制。CPU video 冷启动同样处理，保留 5 秒消费者预算和单帧背压。停止、跳转、卸载取消旧代的观察和重送。`writer.write()`、JS close 和 video 回调均不提前归还 DMA-BUF 槽位，仍等待 Electron GPU 引用真正释放。

普通 GPU film 提交不等待 video 回调：尝试将它也改成逐帧观察时，隐藏窗口会抑制回调并触发超时，该尝试已撤回，失败记录保留。自检重送与稳态调度不是同一条策略。

## 证据与边界

原始目录：`out/linux-wayland-video-20261026/`。`baseline/` 为旧最终包失败，`write-probe-r2/` 记录写入成功无呈现，`delayed-write/` 为固定延时的因果对照，`fixed-dev/` 保存曾引入的隐藏超时，`fixed-dev-r2/` 及新包矩阵验证收敛后的实现。全部使用独立测试资料库和合成片。

环境沿用 Ubuntu 26.04.1／GNOME Wayland、NVIDIA RTX4080、Electron44.9.3／Chromium152；X11 项实际是 XWayland。新包目录 `dist/linux-wayland-video-20261026/`；旧 `dist/linux-optimization-20261026-final/` 保留。

帧计数、video quality 与合成截图分别记录，不能代表物理扫描输出、耳听音画同步或原生 HDR。Intel 直接硬解、其他显卡／桌面、原生 Xorg 的既有未验收项不由本轮推定通过。Linux video 继续 opt-in。

## 新包性能对照

同一新包、固定物理输出尺寸，预热 5 秒后每项独占采样 60 秒；截图／像素检查在计时后执行。CPU 为整个进程树，100% 表示一个逻辑核。60fps 行使用同一 H.264 4K60 片源，24／30fps 使用对应 1080p 合成片。

| 输出／源帧率 | 解码 | 消费者 | CPU % | 生产 fps | video 计数 fps | mpv 丢帧 | video 丢帧 |
|---|---|---|---:|---:|---:|---:|---:|
| 1080p／60 | auto-copy | Canvas | 135.6 | 59.95 | — | 4 | — |
| 1080p／60 | auto-copy | video | 123.1 | 59.93 | 59.93 | 0 | 0 |
| 4K／60 | auto-copy | Canvas | 140.7 | 59.97 | — | 0 | — |
| 4K／60 | auto-copy | video | 128.0 | 59.98 | 59.98 | 0 | 0 |
| 1080p／24 | auto-copy | video | 51.7 | 23.97 | 23.98 | 0 | 0 |
| 1080p／30 | auto-copy | video | 64.8 | 29.98 | 29.98 | 0 | 0 |
| 4K／60 | nvdec | video | 80.5 | 60.00 | 59.98 | 0 | 0 |
| 4K／60 | nvdec | Canvas | 96.6 | 59.98 | — | 0 | — |

所有 performance 项 `status=measured`，实际截图检查有彩色内容和运动变化。video 的 `getVideoPlaybackQuality()` 统计另列，Canvas 的提交回执不能当作物理呈现。只有单机单轮数据，不给出统计显著性或通用性能承诺。

4K auto-copy 中，video 的 GPU 租约均值约 25.6ms，Canvas 约 7.8ms；CPU 较低不意味着端到端延迟较低。没有移除 Chromium 可能的 RGB → NV12 转换，也没有宣称 video 是零拷贝。继续保持 Canvas 默认。

## 完整性与功能验收

- 新包五个生命周期场景全部通过：Wayland GPU video、Wayland Auto video（杀 helper 后真实 CPU video 接管）、XWayland GPU video、Wayland CPU video、Wayland GPU Canvas。覆盖启动时跳转／自检取消、暂停恢复、隐藏后恢复、renderer 停顿超过 2 秒、缩放／全屏、停止重开、页面重载；清理不需要强制杀进程，旧 producer 与引用最终归零。
- 另直接执行最终 AppImage，再完成 Wayland Auto video 的生命周期和故障回退，`appimage-wayland-auto-video/report.json` 通过。
- 五类新样片（SDR limited/full、HDR10、HLG、无亮度元数据 PQ）验证文件摘要、编码像素及实际 HDR side data；Canvas/video 各执行五片 × 八种操作。两条路径均通过参考值、黑白位、灰阶、色相和亮度稳定性检查；同相位灰阶／色块最大采样差异为 0.12 字节值，门槛 4。见 `color-canvas-r3/`、`color-video-r3/`、`color-comparison.json`。
- Wayland GPU video 的复杂 ASS 和原始 PGS 字幕像素检查通过，见 `subtitles-video/subtitle-report.json`。
- 播放主进程／preload 测试共 431：421 通过，10 个不适用的原生平台项目跳过；完整类型检查、修改 TS 的 ESLint、桌面构建、`git diff --check` 通过。
- 包内 GPU／CPU ELF 依赖闭包、源码材料、两个 FD addon 加载、私有通道拒绝、libmpv PCM 解码至 EOF 均通过。提取最终 AppImage 后再次验证运行库，并核对 AppRun、Electron、两份 ANGLE 库及 app.asar 与已测 unpacked 的摘要一致。

生成样片的初次失败来自误用无 x265 编码能力的 AI FFmpeg；之后使用已有的完整测试 FFmpeg 编码、AI ffprobe 检查元数据。另一次色彩 harness 启动包装器未满足“资源位于可执行文件旁”的验收约定，失败在启动前；已给正式 `scripts/playback-color-acceptance.mjs` 增加显式显示后端／Linux video 参数和实际消费者断言，最终直接验收包内 AppRun。以上失败记录保留，不计入通过项。

## 文件与重现

本轮代码主要修改 `apps/desktop/src/preload/sharedTextureVideo.ts`；`sharedTextureReceiver.ts` 补 clone 类型合同；对应 video／receiver 测试覆盖迟接收、超时、不采伪造像素、取消与引用关闭。色彩 harness 现在接受 `--javdex-wayland`、`--javdex-x11`、`--javdex-linux-video`，拒绝同时指定两个显示后端。

包：`dist/linux-wayland-video-20261026/Javdex-0.9.1-x86_64.AppImage`，195717133 字节（约 186.7 MiB）。SHA-256：`1e5a07d21e71cb79e0bc92e6498e8755e5198b0488120b655c56720e2535c5ce`。同目录保留配套源码材料。

在仓库根目录启动修复后的实验路径：

```sh
./dist/linux-wayland-video-20261026/Javdex-0.9.1-x86_64.AppImage --javdex-wayland --javdex-linux-video
```

省略 `--javdex-linux-video` 即为默认 Canvas。按已保存用户设置选择 Auto／GPU／CPU；本轮验收使用隔离配置，不改用户资料库。没有提交、推送、发布或系统设置变更。

性能重现入口为 `scripts/linux-playback-profile.mjs`，video 设置 `JAVDEX_PROFILE_VIDEO=1`；完整命令、环境、逐秒采样、截图和失败记录见证据目录中的 `run-matrix.py`、`run-followup.py` 及各 report。色彩最终命令使用 `scripts/playback-color-acceptance.mjs color-fixtures-r2 gpu --javdex-wayland [--javdex-linux-video]`，并通过 `JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE` 指向包内 AppRun、`JAVDEX_PLAYBACK_ACCEPTANCE_OUTPUT` 指向新的绝对输出目录。

仍未验证：真实物理扫描时刻、耳听／口型同步、原生 HDR、其它 Linux 机器、原生 Xorg、AMD／Intel 直接 video 消费及 macOS 原生运行。既有 Intel 直接硬解失败、CPU 4K 性能和更长时间压力测试不由这次首帧修复宣告解决。
