# Windows 播放同步、显卡对齐与性能对照

> 历史候选路径与实验记录。当前实现已按用户决定收敛为 ANGLE＋共享槽直接渲染＋`glFinish`；WGL、桥接复制、异步 fence 与对照开关已移除。下文数据只描述当时构建，不代表当前运行库。见[最终收敛记录](windows-angle-finish-consolidation-2026-10-25.md)。


2026-10-25；`dev/b9f7adce` 上的未提交开发实现。接续[直接硬解](windows-angle-direct-decode-2026-10-25.md)和[共享槽直接渲染](windows-direct-shared-output-2026-10-25.md)，更新开发运行库；不是正式安装包验收或发行。

## 完成边界与兼容路径

Windows ANGLE 直接输出在最终画面之后插入 GLES 3 `glFenceSync`、`glFlush`，解绑输出，并提交共享设备的 D3D 命令流。owner thread 只在私有控制 pbuffer 上调用零超时 `glClientWaitSync`；只有 `ALREADY_SIGNALED`／`CONDITION_SATISFIED` 才删除 fence、完成票据并交付。超时继续有界查询，失败或设备丢失隔离宿主；不能把 Flush、发出帧消息或 Canvas 提交当成 GPU 完成。

使用 `GL_SYNC_FLUSH_COMMANDS_BIT` 允许查询提交驱动命令，但 timeout 仍为零。本机 ANGLE D3D11 不提供 EGL fence；GLES core GLsync 可用。最初普通 libuv 计时器出现粗粒度唤醒，4K60 产帧跌至约 39fps；改为进程私有的高分辨率一次性计时器后恢复 60fps。另发现查询不带 flush bit 时，4K30 会周期性延迟返回结果；只补 D3D Flush 仍不能消除，带提交标志的零等待查询才通过重复源帧率门槛。调查失败记录保留，不能当作成功证据。[ANGLE 的 D3D11 查询实现](https://github.com/google/angle/blob/main/src/libANGLE/renderer/d3d/d3d11/Fence11.cpp)解释了该标志如何控制 `GetData` 的 `DONOTFLUSH`。

高分辨率通知仅在存在待完成帧时启用，后台线程只通知 owner thread，不访问 JS／GL／会话状态，不忙等，也不更改系统计时精度。停止后撤销通知；销毁只排空短回调，不在该回调中等待 GPU。设备不支持高分辨率唤醒时，auto 保留 `glFinish`；诊断强制 fence 必须失败。WGL／ANGLE 桥接复制仍保留 `glFinish` 与 D3D 复制完成查询，原 CPU 回退保持。

同一时间最多一个待完成的 GPU 帧，导出池仍为三槽。等待期间不重绑或写入输出槽；确认生产完成也不代表可复用，必须继续等消费端 GPU 完成与最终引用释放。暂停跳转、隐藏、尺寸变化、旧代租约和故障隔离沿用原协议。

## 消费设备与生产设备

Windows GPU 初始化最多等待两秒取得 Chromium GPUInfo。CPU 不调用该 API。主进程只选择唯一 active 设备，把 PCI vendor/device 与已知低功耗／高性能 preference 交给原生宿主；create 始终在排队命令之前，停止／换代后迟到结果不能创建旧内核。

GPUInfo 没有公开原始 Windows LUID。与本机 Chromium 当前实现一致，preference 2／3 对应 DXGI `EnumAdapterByGpuPreference(0, MINIMUM_POWER/HIGH_PERFORMANCE)`，原生宿主先得到 LUID，再核对 PCI 身份并显式创建设备。[Chromium preference 定义](https://github.com/chromium/chromium/blob/main/ui/gl/gpu_preference.h)与[Windows GPU 收集代码](https://github.com/chromium/chromium/blob/main/gpu/config/gpu_info_collector_win.cc)为解释来源；实际运行版本为 Electron 43.8.1。

本机同时存在两个 vendor/device 相同但 LUID 不同的 RTX 4080 记录，单看型号会产生歧义；活动记录的 preference 解析到 LUID `0:59579`。没有 preference 时只接受唯一 PCI／LUID 匹配；明确目标变化、缺失、歧义或软件设备不能靠枚举顺序猜测，按模式失败／恢复 CPU。GPUInfo 超时或不可用时维持默认设备与真实画面检查，并报告 unknown，不伪造消费端 LUID。不会设置注册表或改写用户显卡偏好。

## 性能测量方法

`scripts/windows-gpu-benchmark.mjs` 在本机依次运行四条真实路径：WGL copy-back＋输出复制＋finish，ANGLE 直接硬解＋输出复制＋finish，ANGLE 直接输出＋finish，ANGLE 直接输出＋fence。每种使用同一 native／libmpv 构建；两种合成 H.264 分别为 3840×2160／30fps、60fps，独立 FFprobe 已核对。每条预热两秒、采样八秒、两轮逆序对照，按实际物理输出尺寸和 GPU LUID 校验相同；计时结束后才读像素／截图。

进程 CPU 是 Electron 各进程 `percentCPUUsage` 之和，工作集也是进程求和，可能重复计算共享页，不是系统占用或独占显存。producer／Canvas submitted 是生产与提交计数，不是物理扫描输出。至少达到源帧率的 97%、新增丢帧不超过一帧才通过质量门槛；普通播放成功不足以证明性能通过。`producerReadyWall` 包含 GPU 执行与查询调度，不能当作屏幕延迟。原始计时阶段均值不能跨样本简单相加成端到端延迟。

对照、产物摘要、源码清单与最终验收见忽略目录 `out/windows-playback-pipeline-20261025/`。`benchmark`、`benchmark-final`、`flush-check-*` 是修复前调查；最终采用 `benchmark-validated/comparison.json`，不混合旧构建的成功项。

## RTX 4080 对照结果

16 轮全部通过源帧率与丢帧门槛，新增丢帧均为零。实际共享输出均为 3362×1870（175% DPI 下记录实际尺寸，不以请求的 DIP 尺寸替代），生产／解码 LUID 均为 `0:59579`；新路径实际为 `d3d11va`、direct-shared、gl-fence，回读与输出复制均不执行。以下为每种两轮均值：

| 输入／路径 | Canvas 提交 fps | 进程 CPU 总和 | 工作集 MiB | glFinish 等待 ms/帧 | 可交付墙钟 ms/帧 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K30 WGL copy-back／复制／finish | 29.98 | 5.76% | 1023.6 | 1.96 | 9.57 |
| 4K30 ANGLE 复制／finish | 29.99 | 3.35% | 909.2 | 6.29 | 9.15 |
| 4K30 ANGLE 直接／finish | 29.99 | 3.31% | 931.7 | 6.39 | 7.49 |
| 4K30 ANGLE 直接／fence | 29.97 | 3.06% | 921.9 | 0 | 8.32 |
| 4K60 WGL copy-back／复制／finish | 59.97 | 10.84% | 1037.7 | 2.10 | 8.64 |
| 4K60 ANGLE 复制／finish | 59.99 | 4.73% | 919.1 | 6.72 | 8.24 |
| 4K60 ANGLE 直接／finish | 60.02 | 4.55% | 924.7 | 6.67 | 7.67 |
| 4K60 ANGLE 直接／fence | 59.98 | 4.77% | 924.6 | 0 | 8.50 |

完整新路径相对原 WGL 的进程 CPU 总和约减少 47%／56%，工作集求和约减少 102／113MiB。相对上一步“直接输出＋finish”，fence 去掉每帧约 6.4–6.7ms 的 owner-thread GL 等待，但可交付墙钟约增加 0.8ms；60fps 进程 CPU 约增加 5%，30fps 约减少 8%。异步化的主要收益是释放线程等待，不能解释成所有指标都更快，也没有测量物理显示延迟。

## 验收与剩余范围

最终矩阵包含三种 ANGLE 配置与 WGL 的 12 项真实原生回归（待完成帧跨时间线、三槽背压／尺寸／跨会话／迟到释放、明确设备身份校验）；宿主 FIFO／超时／迟到 GPUInfo／CPU 不查显卡等 19 项检查通过。产品 Canvas 的三次重开、暂停 seek、全屏、慢消费、ASS／PGS 像素以及五组 SDR／HDR 转 SDR 色彩检查通过。明确 GPU 初始化失败与实际原生适配器匹配失败，均按 auto／GPU 规则正确恢复 CPU／报告错误，恢复后可重试真实 GPU。

macOS／Linux 原生同步路径不变；没有安装包、物理 HDR 输出、功耗、长期资源／所有驱动／热插拔／远程桌面或独立纯核显设备保证。UHD 770 的混合设备结果在下面单独记录，不能以 RTX 结果代替。

## UHD 770 混合设备检查

通过仅作用于验收进程的 Chromium `--use-adapter-luid=0,64400` 选择真实 Intel 消费设备。GPUInfo 的 active 记录和 GL renderer 均为 Intel；生产端自动跟随为 UHD 770、`chromium-active-preference`、LUID `0:64400`，实际 `d3d11va`／direct-shared／gl-fence，窗口色块检查通过。没有模拟 GPU 状态或仅强制生产端；显示器仍连接独显，不代表独立纯核显机器的显示性能。

- 1927×1100 实际输出、普通 H.264／24fps：Canvas 提交约 24.01fps，五秒采样零新增丢帧，普通退出和资源释放通过。
- 同一混合配置在 3362×1870 输出下播放 4K30：fence 约 10.59fps，finish 对照约 11.26fps，均未达到源帧率门槛。降低到 1927×1100 输出后，4K30 fence 仍只有约 16.07fps。这里的 GPU／Canvas 功能可用，4K 吞吐未通过，不宣称核显 4K 流畅；也不以进程 CPU 较低当作优化成功。
- 这些输入／输出负载不完全相同，不能把普通 H.264 和 4K 的数值合成一个新旧提升比例。CPU 兼容仍可手动选择；自动 CPU 恢复继续针对图形故障，不把低帧率自动判成设备故障。

原始记录为 `intel-window`、`intel-finish`、`intel-h264`、`intel-small-4k`、`intel-small-h264`。profile 的 `passed` 只表示基本播放／图像与退出检查；本段按实际源帧率另行说明性能是否通过，避免混淆。
