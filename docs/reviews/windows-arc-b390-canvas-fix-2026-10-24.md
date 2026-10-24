# Windows Arc B390 Canvas 字幕修复与复验

本次基于 `origin/dev` 的 `eac0571feae3010a80ca1a5d927b708bb6dd2800`，修复 Windows 候选 Canvas 后端的 ASS／PGS 字幕绘制及运行故障自动 CPU 回退。默认 HWND 后端保持默认。结果针对本机、本次本地开发运行库及解压应用，不代表公开安装包或其他显卡已通过。

## 环境与复现

- Intel Core Ultra X7 358H／Arc B390，驱动 `32.0.101.8359`；内屏 3120×2080、200% 缩放、60 Hz。另枚举到远程控制虚拟显示适配器，没有第二块物理 GPU。
- Electron 43.8.0，Chromium ANGLE D3D11 与生产端均使用 Intel；生产设备 LUID `0x00000000:00010FB9`。原包播放时 H.264、HEVC、AV1 的进程 VideoDecode 计数与该 LUID 对应，加载 Intel `igxe3icd64.dll`。
- 原包目录为 `C:/Users/nutge/Desktop/Javdex-Setup-0.9.0-x64`。候选 Canvas 的六个普通视频用例通过，复杂 ASS 和 PGS 在各自新进程中稳定失败；默认 HWND 和禁用 GPU 后的 CPU 字幕正常。

临时原生诊断确认：绘制前的 framebuffer 操作无 GL 错误，首次 mpv 字幕绘制产生 `GL_INVALID_OPERATION (1282)`。Canvas 只使用 `wglCreateContext` 的兼容 context；改成与 HWND 后端相同的 OpenGL 3.2 core context 后，在同一设备、同一 libmpv DLL 上恢复字幕。临时诊断回调已移除，正常 GL 错误检查保留，并附带错误编号。

另一个故障来自错误分类：原始 GL 异常被共享帧桥改写为“Windows 共享视频生产失败”，旧回退正则无法识别。桥现在保留主进程私有 `playbackFailureKind`，CPU 回退优先按分类判断；页面退出使用 `page` 分类，不会误触发接管。原有原生初始化错误文案匹配继续支持，没有加入媒体／授权错误或 CPU 故障的循环回退。

## 构建身份

MSVC 14.44／Windows SDK 10.0.26100 实际编译 Windows addon，使用匹配 Electron 43.8.0 的头文件、导入库及 delay-load hook。完成正常生产构建，以项目 electron-builder 配置及钩子生成 `app.isPackaged=true` 的独立解压目录，原始应用与用户资料未改动。

可运行文件：`out/windows-canvas-fix-20261024/package-fixed/win-unpacked/Javdex.exe`。该目录是本地开发运行库包，版本仍为 0.9.0；不是签名 NSIS 或新的公开发行。

| 文件 | SHA-256 |
| --- | --- |
| `Javdex.exe` | `c07d2e58a28202ee916db7072c0eea158822660bedfcb0a3e23543e7146f16ac` |
| `resources/app.asar` | `bfa4a7374547af928841410a4be31d4b5abf042384e7f34d13f7cef80d371a4b` |
| `resources/native-playback/playback.node` | `c749938d1490f20ea60b3be14b0525562d0d79ac0c4753a30ef8724a04623a2e` |
| `resources/native-playback/libmpv-2.dll` | `525d5f99a484f0ddca2fd00f3f3e0402733f2218a22be522facbcdf09ea70088` |

libmpv 与原包完全一致；新 addon 与本地运行库清单摘要已核对。

## 复验结果

所有应用验收使用隔离资料库、合成媒体和修复版解压应用。候选测试显式使用 `--javdex-windows-canvas`。

| 检查 | 结果 |
| --- | --- |
| 定向 Electron 回归 | 77 通过，0 跳过；覆盖共享桥、故障分类／恢复、原生 CPU 与传输 |
| 原生构建计划回归 | Node 5 通过 |
| 实际编译的 C++ 回归 | 核心、slider feedback、Windows texture tickets 三个程序退出 0 |
| 工程检查 | `npm run typecheck`、`npm run pretest`、`npm run build` 通过 |
| Canvas 媒体矩阵 | 9/9：H.264／HEVC 10-bit／AV1 10-bit 各 1080p30 与 4K24，复杂 ASS、PGS、多音轨；始终 GPU 模式，无 CPU 回退 |
| 默认 HWND 矩阵 | 同样 9/9 通过 |
| 仓库 Canvas 验收入口 | 三轮停止／重开与慢消费，加 ASS／PGS 展开／全屏字幕像素检查通过，停止后引用归零 |
| 原生生产异常接管 | ASS、PGS 分别在新进程注入一次 `nextFrame` 异常；真实 CPU 解码、Canvas 提交与字幕像素检查通过 |
| GPU 子进程退出接管 | 实际终止自有测试应用的 GPU 子进程，CPU 自动恢复与复杂 ASS 字幕通过 |
| Canvas 4K60 连续播放 | 连续约 45.10 秒，生产帧率约 59.97 fps，新增丢帧 0；硬解 `d3d11va-copy`，最多三个未释放槽位 |

媒体矩阵还包含 dock／展开／全屏、进度与音量点击／拖动、倍速、750 ms 慢消费和停止释放。ASS 开关差异为 214733 像素，PGS 为 59298 像素；复杂 ASS 的定位、矢量、裁剪、卡拉 OK 及多行字幕均有实际截图。CPU 故障接管保留暂停、指定进度、31% 音量、静音、1.25 倍速及选中字幕，并验证继续播放、显示尺寸变化与停止释放。

`producer-fault` 是在已正常 GPU 播放后注入一次原生调用异常，用于覆盖实际共享帧桥的错误改写及恢复链路；不宣称再次制造了真实驱动故障。真实 GPU 子进程退出另有独立记录。全部七个复验宿主正常退出（非强制结束、code=0、signal=null）。

机器可读汇总及完整截图／日志在 `out/windows-canvas-fix-20261024/report.json` 及其引用路径；原始失败证据保留在 `out/windows-igpu-acceptance-20261024/`。这些本地证据目录不进入安装包。

未覆盖 HDR、数小时长播、多显示器／其他驱动、物理扫描输出与声音听感、干净机器安装及签名 NSIS／公开附件验收。短时生产帧率与 Canvas 提交不能替代物理上屏帧率。
