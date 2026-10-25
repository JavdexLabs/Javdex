# Windows ANGLE 同步直接输出收敛

2026-10-25；基于 `dev/b9f7adce` 的未提交开发改动。本记录替代此前 Windows GPU 候选路径与同步试验的实现结论，不改写其历史测量结果。

## 最终实现

唯一 Windows GPU 画面路径：Chromium 活动显卡匹配 → 同设备 D3D11／ANGLE GLES3 → libmpv → 空闲 NT 共享输出槽 → `glFinish` → 检查 GL 错误并解绑 → Electron SharedTexture → VideoFrame／Canvas。

直接硬解优先 `d3d11va`，解码器不支持时保留 `auto-copy` 解码回退；这与已经移除的输出 bridge／`CopyResource` 路径不同。单个待交付帧已完成生产，保留原时间轴与时间戳；三槽池仍必须等消费端 GPU 完成与最终引用释放后才能复用。独立 1×1 私有控制 pbuffer 用于更新、skip 和关闭，不能重绑消费端持有的输出。

移除应用的 WGL／DXInterop 生产者、私有全尺寸 bridge、输出纹理复制及完成查询、GL fence、高分辨率完成通知、多帧生产队列与旧候选开关。清除缩放、色彩、解码器和合成实验注入以及旧路径性能对照脚本；保留使用产品默认配置的 GPU／CPU 诊断入口。上游 mpv 的 `egl-angle` 配置依赖 `gl-win32`，保留该构建能力，不再有应用 WGL 候选。

保留生产／消费显卡身份对齐、默认 GPU 缩放算法、既有 SDR／HDR 色彩合同、独立宿主和 CPU 回退。设备性能不足允许掉帧／卡顿，不按 UHD 770 特判，不自动调低画质或分辨率，吞吐不足本身不触发 CPU 恢复。自动模式对图形故障最多恢复一次 CPU；显式 GPU 模式仍报告错误。

## 本次验收

开发原生模块及桌面构建成功，已更新 `out/native-playback/playback.node` 和桌面 `out/`；本次没有重建安装包或发行运行库。

- 39 项 Electron 定向测试全部通过，包含三个真实 Windows 原生用例：待交付帧跨时间轴、三槽背压／resize／跨会话迟到释放、精确适配器匹配。其余为宿主顺序、GPU 查询超时、CPU 不等待 GPU、共享纹理交接等回归。
- 源码配方／构建计划测试 30 项通过，1 项因未配置该用例要求的工具链入口跳过。原生 mpv core 与纹理票据可执行测试均退出 0。
- Canvas 实际像素验收通过：三次停止重开、暂停 seek、全屏、慢消费、ASS／PGS 字幕。停止后租约归零，峰值不超过三槽。
- 五类 sRGB Canvas 色彩检查通过：SDR limited／full、HDR10、HLG、无亮度元数据 PQ，最大参考误差约 0.642 字节值。
- 模式验收通过：自动 GPU 初始化失败恢复 CPU、手动 CPU、显式 GPU 失败不启动 CPU、实际原生适配器不匹配的自动回退与手动 GPU 报错，以及恢复正常显卡后的 GPU 重试。
- 默认配置短时 4K H.264 30fps 检查：RTX 4080、3362×1870 输出，实际硬解 `d3d11va`、`direct-shared`、`gl-finish`；3 秒测量约 29.98 次 Canvas 提交／秒，未新增丢帧。仅用于确认最终路径与诊断可用，不是长期性能承诺或 UHD 770 优化结果。
- 上述四次 GUI 运行均正常退出 0，无强制终止。Node 类型检查、定向 ESLint、编码、架构边界与 diff 空白检查通过。

原始报告及绑定源码／二进制摘要见 `out/windows-angle-finish-20261025/validation-receipt.json`；本地开发运行库说明为 `out/native-playback/development-source.json`。旧实验二进制只保存在忽略的历史证据目录，不是当前运行库。

## 验收边界

没有重新进行 UHD 770 调优、全驱动矩阵、设备热拔插、远程桌面、物理显示延迟／功耗或长期压力测试；没有在本机证明 macOS／Linux 原生运行。Canvas 消费协议与两平台画面路径未变。上述检查不替代正式安装包、CI、签名或发布验收。
