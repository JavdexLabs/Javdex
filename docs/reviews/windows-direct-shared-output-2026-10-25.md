# Windows ANGLE 共享输出槽直接渲染

> 历史候选路径与实验记录。当前实现已按用户决定收敛为 ANGLE＋共享槽直接渲染＋`glFinish`；WGL、桥接复制、异步 fence 与对照开关已移除。下文数据只描述当时构建，不代表当前运行库。见[最终收敛记录](windows-angle-finish-consolidation-2026-10-25.md)。


2026-10-25。在 `dev/b9f7adce` 的未提交 ANGLE／计时改动上继续实施；前两步的独立证据见[直接硬解记录](windows-angle-direct-decode-2026-10-25.md)。本轮更新本机开发 addon，不发布安装包或正式运行库。

此记录保留共享槽直接渲染阶段的独立证据。后续已增加异步 GL fence 与 Chromium 显卡对齐，最新实现和新旧性能对照见[流水线接续记录](windows-playback-pipeline-2026-10-25.md)；下文 `glFinish` 与旧产物数字仅对应该阶段。

## 实现与资源约束

- ANGLE 默认先探测同设备、非 keyed NT 共享纹理的 pbuffer 绑定。支持时，mpv 直接把 BGRA 画面渲染到空闲共享槽，省去全尺寸私有输出 bridge 和应用提交的那次 `CopyResource`。未声称 ANGLE／Chromium 内部、跨适配器或显示扫描全链路无复制。
- 三个槽各自缓存 EGL pbuffer，尺寸不变时复用。只在槽空闲时写入、重建尺寸或替换资源 ID；满池时保持背压。消费端关闭 VideoFrame 后仍需等待 GPU 完成、导入对象最终释放，才能归还原生租约。
- 单独保留 1×1 私有 pbuffer 承担 mpv 更新、skip 和关闭。不将消费端持有的槽用于这些 GL 操作。每次输出后解绑，交付和消费期间不再次写入该槽。
- 保留 `glFinish` 作为直接输出的完整生产完成边界。实测沿用无复制工作的 D3D event query 会持续返回 S_FALSE，因此直接路径不再提交该空查询，而在下一次 owner-thread 调用交付已经完成的帧。未把 Flush、发出消息或 Canvas 提交回执当作 GPU 完成。
- 不支持共享 pbuffer 的正常探测失败保留 ANGLE 私有 bridge／复制；WGL 继续使用原桥接复制与异步 D3D 完成查询。设备移除或 EGL 清理不明时隔离宿主，不能冒险复用。自动模式的独立 CPU 恢复与显式 GPU 失败语义保持。
- 关闭时先结束生产与 mpv，再退休 EGL 视图。仍在消费的 D3D 纹理和句柄保留到最终释放；下一会话不能复用旧租约的槽，迟到释放按资源代退休。

## 诊断与对照

`producerOutput` 为 `direct-shared` 或 `bridge-copy`，`directOutputFrames`／`outputCopyFrames` 分别记录提交的输出。直接路径复制计时零样本表示没有执行该复制，不表示渲染或同步零耗时。`bridgeAcquire` 在直接路径测量 EGL 目标切换；`outputSubmit` 测量提交后的 Flush，`outputCompletionWall` 是生产已完成到下次原生帧交付的宿主调度时间，不能当作 GPU 执行时间或物理显示延迟。

诊断对照可设置 `JAVDEX_WINDOWS_VIDEO_OUTPUT=auto|direct|copy`，沿用 `node scripts/windows-gpu-profile.mjs 合成视频 angle 5`。默认 auto 优先直接输出；强制 direct 不支持必须报错，不能把复制路径算作直接输出成功。WGL 不能强制 direct。

## 本机验收

Windows 11，Electron 43.8.1，RTX 4080／Intel UHD 770。本轮原始材料在忽略目录 `out/windows-direct-output-20261025/`，产物摘要及源码清单见该目录的 `validation-receipt.json`。

- RTX 4080：4K H.264／30fps、HEVC Main10 均为实际 `d3d11va`、`direct-shared`，窗口 Canvas 色块、时钟推进及普通退出通过，`outputCopyFrames=0`。直接路径无 copySubmit／copyGpu 样本。
- 同一 4K 素材、2394×1247 输出、每条路径采样 5 秒：direct 与 ANGLE bridge-copy 的 renderCall 均值约 0.800／0.804ms，glFinishWait 约 5.600／5.624ms。桥接路径实际复制 GPU 时间均值约 0.030ms，复制完成墙钟约 0.312ms；直接路径没有该复制，下一次原生交付调度均值约 0.103ms。这些不同阶段不能直接相减推导端到端收益；短测主要证明复制已去除，未承诺大幅帧率提升。
- UHD 770：仅以诊断设备选择 `8086:4680` 进行约 6 秒原生预检，自动输出选择 `direct-shared`，实际 `d3d11va`，145 次直接产帧、零输出复制。未修改显卡偏好或接线；此结果不覆盖纯核显 Chromium 消费端或完整窗口。
- 直接 ANGLE、复制 ANGLE、WGL 各通过两项真实原生回归：待交付帧跨时间线保留原时间信息；三槽占满时背压、复用、尺寸变化、旧租约跨会话和迟到释放。总计 6 项通过。
- 产品 Canvas 检查通过三次停止重开、真实慢消费、暂停 seek、全屏、ASS／PGS 展开与全屏的实际字幕像素；峰值输出租约不超过三，停止后归零。抽查 4K 窗口及 ASS 全屏截图，方向、色块和文字正常。
- 五组 SDR limited／full、HDR10、HLG、无 PQ 亮度元数据的 sRGB Canvas 检查全部通过，最大参考误差约 0.642 字节值。保留原 SDR 输出目标；不证明物理 HDR 输出或显示校准。
- 模式故障验收通过：显式 GPU 初始化失败不启动 CPU；自动模式失败恢复 CPU；手动 CPU 与重新尝试 GPU 正常。原生构建、Node 类型检查、定向 ESLint、编码和 diff 空白检查通过。

## 剩余范围

未验收所有 Intel／AMD 驱动、纯核显完整窗口、混合显卡跨设备导入、切屏／热插拔／远程桌面、长期内存／功耗或新安装包。直接输出只改变 Windows ANGLE 生产端；macOS／Linux、共享 Canvas 消费端及原 CPU 软件实现没有更改。没有移除 `glFinish`，没有放宽最终释放协议，尚未提交或推送代码。
