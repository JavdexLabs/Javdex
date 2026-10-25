# Windows ANGLE 直接硬解与分段计时

> 历史候选路径与实验记录。当前实现已按用户决定收敛为 ANGLE＋共享槽直接渲染＋`glFinish`；WGL、桥接复制、异步 fence 与对照开关已移除。下文数据只描述当时构建，不代表当前运行库。见[最终收敛记录](windows-angle-finish-consolidation-2026-10-25.md)。


2026-10-25。基线 `dev/b9f7adce` 上的未提交开发改动；本轮仅实施设备／耗时诊断与 ANGLE 候选，不发布或替换运行库发行。

此记录保留第 1、2 步的独立结果；后续已实施共享槽直接渲染，当前实现与新产物验收见[接续记录](windows-direct-shared-output-2026-10-25.md)。下面保留输出复制的描述仅对应当时产物。

## 实现

- Windows 候选顺序为 ANGLE GLES3／D3D11、现有 WGL／D3D11，再由原 PlaybackEngine 按模式决定是否最多恢复一次 CPU。显式 GPU 不静默改为 CPU。
- ANGLE 使用 Electron 43.8.1 随附的 EGL／GLES DLL；通过 device creation 扩展使用生产端硬件 D3D11 设备。mpv 直接映射同设备 NV12／P010，配置 `d3d11va,auto-copy`，不把创建 GLES 上下文当作直接硬解证据。
- 固定 mpv 0.41.0 增加动态 EGL ANGLE 支持。真实试运行发现其只在 display 扩展列表查询 `EGL_EXT_device_query`，而当前 ANGLE 将该能力列在 client 扩展中；兼容补丁接受两种合法位置，仍验证函数入口与实际设备，不跳过硬件检查。
- 输出端仍是私有 BGRA bridge → 一次 CopyResource → 三个非 keyed NT 共享槽 → Electron／VideoFrame／Canvas。glFinish、生产完成查询和消费端最终释放约束保留；ANGLE pbuffer 在 D3D 复制期间解绑，不能提前重新绑定。
- 保留隔离宿主与不确定资源隔离；ANGLE 探测清理失败或设备被移除时不能继续尝试 WGL。CPU 软件路径不加载播放端 ANGLE。

## 诊断与含义

现有 `javdex.playback.host.statistics` 提供生产设备 DXGI 描述、vendor/device/LUID、GL vendor/renderer/version、候选失败原因、实际 `hwdec-current`、copy-back 解码帧的 DXGI 设备 vendor/device/LUID 及 Chromium 消费设备／驱动快照。消费端没有可靠 LUID 时保持未知；未实施自动跨 GPU 设备绑定。

`producerTimings` 包含 renderCall、glFinishWait、bridgeAcquire、bridgeRelease、copySubmit、copyCompletionWall。它们是宿主墙钟时间，渲染调用可包含纹理上传，copyCompletionWall 含 GPU 排队和 libuv 轮询。诊断模式下另有 D3D11 timestamp/disjoint 查询的 copyGpu；失效或不支持的时间戳不产生有效样本。

Windows 固定 mpv 源码在 `mp_image_hw_download` 两侧计时，每个解码器首帧记录 copy-back 解码帧所属的实际 D3D11 设备，首帧及每 30 帧批量上报累计回读墙钟；主线程消费有界日志为 hwdownloadSamples／MeanMs／MaxMs。默认关闭，不逐帧新增应用 IPC。零样本需与实际解码器一起解释，不能把未启用计时当成零耗时。

重放：`node scripts/windows-gpu-profile.mjs SYNTHETIC_VIDEO angle|wgl|auto|cpu 6`。脚本用隔离资料库，定向保存设置；先收集统计，之后才读取图像检查色块并截图，避免读回干扰已测区间。不使用真实影片或麦克风。

## 本机结果

Windows 11，RTX 4080，Intel UHD 770，Electron 43.8.1。

- RTX 4080：H.264、HEVC Main10（P010）真实产品路径使用 `d3d11va`，Canvas 合成色块自检、合成视频彩色画面及时间推进通过。WGL 对照为 `d3d11va-copy`，可选回读计时确有样本。
- 相同 3840×2160／30fps 合成 H.264、2394×1247 输出：各采样 3 秒，均未观察到 mpv 丢帧。最终 WGL 回读调用累计均值约 10.629ms；ANGLE 为直接硬解，无回读样本。最终测量区间 renderCall 均值约 3.254／0.727ms，glFinishWait 约 0.894／4.431ms（WGL／ANGLE）；说明阶段耗时会重新分布，不能把一个阶段减少量直接视为端到端收益。此前 profile-4k 对照的 WGL 回读均值约 9.805ms，短采样数字存在波动。
- 同次输出复制的 GPU 时间戳均值约 WGL 0.01495ms、ANGLE 0.01694ms；完成墙钟约 3.803／0.238ms，后者包含队列和轮询，不代表复制内存带宽相差同样比例。
- UHD 770：仅在隔离原生预检中按 `8086:4680` 选择设备，实际报告 Intel ANGLE renderer、`d3d11va`、约 6 秒推进及共享帧输出。未改变 Windows 显卡偏好或显示接线；此结果不代表 Intel 消费端的完整 Canvas／纯核显设备验收。
- 五组 SDR limited／full、HDR10、HLG、PQ 缺失元数据的 GPU Canvas 参考检查通过，最大参考误差小于 0.65 个字节值。
- CPU 模式短播通过；既有模式验收通过显式 GPU 初始化失败、不启动 CPU，自动模式失败恢复 CPU及重新尝试 GPU。共享帧异步复制期间更换时间线的原生回归通过。
- 源码配方与原生构建定向检查、隔离宿主回归、Node 类型检查通过；本地 MSVC addon 与包含 ANGLE 的 libmpv 已编译。各 GUI 检查普通退出，未强制终止。

最终短播记录为 final-angle／final-wgl，实际解码设备与生产设备 LUID 均为同一 RTX 4080；最终五组色彩记录为 final-colors/color-gpu.json，其绑定的 native／libmpv SHA-256 作为该轮产物身份。

原始材料在忽略目录 `out/windows-angle-implementation/`：profile-4k-angle／profile-4k-wgl、profile-angle-direct、profile-hevc、profile-cpu、colors、modes、intel-native.json，以及构建／类型／回归日志。首次仅创建上下文但仍回读的失败结果保留在 profile-angle 与 profile-angle-debug，不作为成功证据。

## 边界

短时合成素材不是持续吞吐、功耗或物理显示延迟基准。未验收所有 Intel／AMD 驱动、纯核显完整窗口、混合显卡跨设备导入、切屏／热插拔／远程桌面或新安装包。仍保留 WGL 与 CPU 路径。没有减少输出 CopyResource，没有移除 glFinish，没有宣称端到端零复制或物理 HDR 输出。
