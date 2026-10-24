# Windows Canvas HDR 转 SDR 映射修复，2026-10-24

基于 `ac072bf37e2c54a97f6d8c4effa6adc219a471be`，保留默认 Canvas、OpenGL 3.2 core 和独立 CPU 回退。本轮修复的是 SDR 输出的亮度映射，不新增 HDR 直通，也不把截图码值当作显示器实际 nit。

## 定位

本机为 RTX 4080 显示输出与 UHD 770 混合配置。当前正式配方库在默认 3.2 core 下，早期 PQ 四色片的白色约为 164，已经与静态映射一致。没有把旧日志中的 150 直接记作当前默认路径的复现结果。

用同一 libmpv、Canvas 传输、片源及接收端，在隔离的原生源码副本中只把 GL context 请求改为 4.3 core，重新编译后白色约为 150；运行时关闭 `hdr-compute-peak` 后恢复约 164。带完整亮度元数据的灰阶也有较小差异。该诊断没有恢复旧 HWND 播放器，也没有改动系统驱动。

固定版本 [mpv 选项说明](https://github.com/mpv-player/mpv/blob/v0.41.0/DOCS/man/options.rst)明确说明，自动峰值检测依赖 compute shaders，并用逐帧峰值及平均亮度替代元数据；[GPU 渲染源码](https://github.com/mpv-player/mpv/blob/v0.41.0/video/out/gpu/video.c)在 compute/SSBO 能力不足时关闭检测，[映射 shader](https://github.com/mpv-player/mpv/blob/v0.41.0/video/out/gpu/video_shaders.c)还依据检测到的平均亮度缩放信号。因此自动模式会使同一片源随 GL 能力与统计历史使用不同映射参数。本次已复现这一能力差异，不将其归因于某一家显卡驱动损坏。

## 修复

Windows 共享纹理 Canvas 保持 BT.709 primaries、sRGB transfer、RGB full range，显式设置 `target-peak=203`、`tone-mapping=bt.2390` 和 `hdr-compute-peak=no`。203nit 是 SDR 信号参考白；没有根据截图临时加 gamma 或整体提亮。使用片源亮度信息和既有缺省值进行静态映射，保留高光压缩，不采用硬裁剪作为产品策略。

设置仅在 Windows 的共享纹理 sRGB 初始化中执行；CPU 的 FFmpeg 感知映射、软件解码/绘制、状态恢复和内存边界保持。macOS 与 Linux 的产品映射策略不随本次改动变化。

## 实测

新增可复现的 `windows-hdr-fixtures.mjs` 与 `windows-hdr-acceptance.mjs`。五组素材包含 SDR limited/full、具有 mastering/CLL 元数据的 HDR10、HLG，以及没有亮度元数据的 PQ 均匀亮场；编码后复核实际 tags、灰阶码值和 HDR side data。独立 ST2084/HLG/BT.2390 参考与实际 Chromium 合成的 Canvas 像素比较，GPU 判据为最大误差不超过 4 个 8-bit 码值，阶段漂移不超过 3，没有降低门槛来接受失败。

| 检查 | 结果 |
| --- | --- |
| 修复前 4.3 core、无元数据 PQ 亮场 | 按预设亮度参考失败，最大误差 27.715；截图与失败收据保留 |
| 修复后默认 3.2 core、五组素材 | 全部通过，亮度参考最大误差 0.682，阶段漂移最大 0.48 |
| 修复后诊断 4.3 core、五组素材 | 全部通过，与 3.2 的参考误差及各阶段输出一致 |
| 强制 CPU、五组素材 | 黑位/峰值、灰阶顺序、原色色相及各阶段稳定性通过，阶段漂移为 0；SDR 参考最大误差 1.206 |
| HDR10 生产异常接管 | 暂停、定位、音量与倍速恢复，真实 CPU 画面及继续播放通过；停止后两个生产者关闭、GPU 租约归零 |

阶段包括播放、暂停、暂停跳转、底栏、展开、全屏、向后跳转及继续。宿主均正常退出，未用强制结束作为通过。4.3 core 仅用于诊断及验证能力差异，测试后已恢复实际产品的 3.2 core 原生模块。

原生共用核心与纹理票据回归通过；相关 Electron 测试 27 项通过；素材/参考测试 8 项通过、1 项 POSIX 条件跳过；构建计划测试 29 项通过、1 项未配置工具链环境的条件跳过。另检查新增脚本语法及差异格式。没有将上一轮全量 4507 项结果追溯为本轮新增代码的全量测试。

完整证据在 `out/windows-hdr-investigation-20261024/`，最终报告选择 `final-default/hdr-gpu.json`、`fixed-gl43-final/hdr-gpu.json`、`fixed-cpu/hdr-cpu.json` 与 `recovery-verified/hdr-recovery.json`；修复前失败为 `regression-before/`。一次诊断候选构建因复制头文件保留旧时间戳而未重新编译，已通过 clean-first 构建并重新完整验收，未使用该候选的失败报告充当修复结果。

本地 `out/native-playback` 已重新编译，实际 addon SHA256 为 `efa932c62f3011a7158febcebf397aed4240b4550bac3ef4b5e29e916237fa16`；libmpv 保持 `11adc45d801486a1eda63496e7ff03f798e21a22fa5b013efc6485e81eb28f31`。原 `dist/windows-final-20261024/` 是前一轮安装包，不能作为包含本次修复的包。

## 边界

GPU/CPU 使用不同映射算法，不承诺回退前后亮度或色彩逐像素相等；此前 100/203nit PQ 灰阶在 GPU 约为 185/229、CPU 约为 142/173，本次没有改动 CPU 曲线。CPU 的 HDR 检查验证可用性与稳定性，不作为 BT.2390 精度证明。

尚未新增纯 Intel/其他驱动、物理 HDR 输出、色度计校准、长期播放或新安装包验收。基于元数据的静态映射也不会自动纠正片源错误的亮度标签；本次不保证 HDR10+／Dolby Vision 动态元数据的完整处理。
