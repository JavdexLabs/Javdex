# Windows GPU／CPU 统一 video 接入

2026-10-27；从 ASR 保留分支切回 `dev`，快进到远程 `b463974a` 后实施。验收时为未提交开发改动与本机源码运行验收，没有发布或新安装包。

## 实现

Windows GPU／CPU 与 Mac/Linux 共用 `sharedTextureVideo.ts` 的 `VideoFrame → MediaStreamTrackGenerator → video`。删除 Renderer 和 preload 的常规 Canvas 显示分支；保留固定色块自检及显式色彩诊断的一次临时 sRGB Canvas 采样。现有 HTML 控件、libmpv 解码、字幕、音频和会话恢复保持共用。

GPU 继续采用同卡 D3D11／ANGLE、共享槽直接渲染和 `glFinish`；保留三槽租约、最终引用释放后复用和未知资源隔离。为 Windows 导入帧补上生产端时间戳，跳转／视口刷新取消待完成 video 自检后重新申请。GPU 普通帧不以 video 帧回调等待资源释放，`writer.write` 与呈现回调不能提前归还原生槽。

CPU 继续使用独立软件解码／绘制、原有像素复制 IPC 和两帧信用额度；按真实 stride 构造 RGBX VideoFrame，带行尾填充时复制规范化，避免显示合成的红蓝交换。Mac 私有 MessagePort 保持原实现，本次没有把通道性能优化扩展到 Windows。默认 GPU 缩放、CPU 既有缩放、色彩合同及实际物理输出尺寸均未改变，没有 UHD 770 特判或画质降级。

## Electron 44 与私有 ANGLE

首次真实原生检查发现 `Electron ANGLE library is unavailable`：Electron 44 已静态链接 ANGLE，Windows 分发中也不再含 `libEGL.dll`／`libGLESv2.dll`，所以仅修正头文件版本不足以启动现有生产者。上游说明见 [Electron 44](https://www.electronjs.org/blog/electron-44-0)。

生产端改从 `playback.node` 的相邻目录按绝对路径加载私有 ANGLE。`build/windows-angle-runtime.json` 固定官方 Electron **43.8.1** 发行中的两个独立 ANGLE DLL，修订 `c5bf49e…`，支持供应归档 x64／arm64；不运行旧 Electron。消费应用与 SDK 均为 **44.9.3**，双方只共享 D3D11 原生纹理，不共享 ANGLE 对象，兼容性由本次 Windows 实机验证。

供应 ZIP 的 SHA-256 已与官方发行 `SHASUMS256.txt` 核对；归档校验先于提取，只提取固定 DLL 和完整上游许可。运行库记录逐文件摘要，拒绝符号链接和未知 PE 依赖。开发入口自动准备私有库；Electron 44 本地打包缺少私有库时直接失败，并显式纳入 PE 导入表看不到的动态依赖。正式源码构建将 ANGLE 与供应方源码归档、原始许可、版本、摘要和配方作为独立组件交付。

Windows ABI 头与 Windows 私有供应修订对齐，解除与 Linux Electron 44 ANGLE 配置的错误耦合。新增检查防止供应归档篡改和旧式打包漏 DLL。另修复本机原生构建默认误选 Ninja／动态 CRT 的问题：开发配方明确使用 VS 2022 与静态 MSVC CRT。

## 本机验收

Windows x64，当前默认活动 GPU 为 RTX 4080。Electron 44.9.3、对应 SQLite 重编译、桌面构建和标准 `playback:native:build` 成功。后者重建 addon／互操作模块并执行 core 与票据原生检查；libmpv 沿用本机既有固定源码配方构建的 0.41 DLL。本次没有重跑全量第三方依赖编译或正式发行配方。

最终同一组原生二进制运行九组正常业务应用，每组均使用隔离资料库及合成媒体，全部正常退出 `code=0 / forced=false`：

| 检查 | 结果 |
| --- | --- |
| GPU video | 三次停止重开、真实画面推进、暂停 seek、全屏、慢消费通过；峰值不超过三槽，停止归零 |
| 字幕 | ASS／PGS 在展开与全屏的实际差异像素通过，保持同一会话和 GPU 输出 |
| 软件界面 CPU | `--javdex-software` 下真实 video、软件解码、暂停／播放／展示切换及释放通过 |
| GPU 色彩 | SDR limited/full、HDR10、HLG、缺失 PQ 元数据五类通过，最大参考误差约 0.642 字节值 |
| CPU 色彩 | 同样五类通过，最大参考误差约 1.042 字节值；独立检查窗口主色与 sRGB 数值 |
| 连续跳转 | GPU／CPU 各采集 122 张合成截图，零空白，重复暂停／播放 seek 后恢复通过 |
| 生产进程故障 | 主动退出当前验收宿主，播放中的真实 CPU video 接管与状态恢复通过 |
| GPU 进程故障 | 仅终止当前验收应用的 GPU 子进程，真实 CPU video 接管、后续操作与停止通过 |
| 模式 | 自动、手动 GPU／CPU、原生适配器不匹配、显式 GPU 失败不静默回退、正常 GPU 重试通过 |

定向消费者测试 71 项通过；宿主／桥接／Renderer 测试 136 项通过；真实 Windows 原生测试 3 项通过。构建、运行库与源码聚合恢复测试 67 项通过、5 项因宿主／工具链边界跳过，新增私有 ANGLE 组件的来源材料可随聚合包恢复。类型检查、定向 ESLint、编码与架构边界检查通过。另已实际验证本地打包文件选择：两个 ANGLE DLL、许可和来源元数据与播放库一起纳入，没有重新制作安装包。

初轮连续 seek 夹具只有约 14 秒，而原脚本固定跳转到 20 秒，导致 EOF；脚本现按真实时长选择测试范围，仍执行相同次数和零黑帧门槛。初轮 CPU 彩色检查误用了均匀单色素材，改用原有动态 testsrc 夹具后通过；不修改像素判据。这些初始失败均保留在忽略目录。

原始报告位于 `out/windows-video-integration-20261027/final/`；`summary.json` 绑定九组测试的同一二进制摘要，最终源码、供应归档、依赖和报告绑定见同目录上级 `validation-receipt.json`。开发运行库说明已更新到 `out/native-playback/development-source.json`。

## 边界

本机结果不代替纯核显／AMD／ARM64、远程桌面、热插拔、物理音画延迟与长期资源测试。未针对 UHD 770 调优，也未承诺低性能设备实时播放 4K。验收时没有重新验收 Mac/Linux 原生窗口、制作签名安装包、提交或推送。
