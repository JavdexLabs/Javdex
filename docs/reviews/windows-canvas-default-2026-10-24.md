# Windows Canvas 默认播放与本地最终验收，2026-10-24

正式采用 Windows Canvas，移除旧 HWND 显示实现。本轮基于 `c2829c1fd822234c9acdf3b65e8923dee4e45e97` 及本地正式配方/Sharp 优化，版本保持 0.9.0；不是新的公开 Release。打包和验收阶段按当时要求保留未提交工作区；后续用户授权完整检视、提交及推送源码，包身份仍以本记录中的摘要为准。

## 最终实现

Windows 正常启动直接使用 D3D11 共享纹理到主窗口 Canvas，与 HTML 控件共同合成。移除试验开关、按 addon 存在与否选择合成路径的逻辑，以及 `disable-direct-composition` 注入；保留 Chromium 正常 DirectComposition。

删除 `windowsPlayback.cpp`、原生工具栏/滑块及其专用回归，新增简短的 `windowsPlaybackAddon.cpp` 作为模块入口。原生模块只导出 `sharedTexture` 和 `software`，加载门禁与真实原生测试均拒绝旧 HWND 接口。共享生产需要的隐藏 WGL drawable 仍保留，但不显示影片或承载输入。全屏、键盘、滑杆、菜单与焦点由现有 HTML 面板处理。

保留 Arc B390 修复中的 OpenGL 3.2 core context、结构化图形错误分类，以及独立 CPU 接管；CPU 按实际物理 viewport 输出，无 1080p 质量上限，安全尺寸/内存边界保持。未知 GPU 引用继续有界隔离，不能因采用 Canvas 就提前复用。显示路径统一本身不代表性能提升。

本地旧 HWND 综合/几何/原生焦点/长播验收脚本已归档到 `out/windows-hwnd-archive-20261024/`，`inventory.json` 保存原文件摘要。旧原生开发目录另存于其 `development-runtime-before-canvas/`；当前 `out/native-playback` 已换成与最终包相同的两份新二进制，并通过默认路径的真实 CPU/Worker 回归。历史实测与旧包记录保留，不能追溯成为新 Canvas 的验收证据。对应源码聚合仍可恢复已分发的旧 Windows 归档，同时接受新的入口文件。

## 构建与包身份

固定源码配方重新构建 mpv 0.41.0 / FFmpeg 9.0.2 与 Electron 43.8.0 适配器，静态依赖与正式来源门禁均保留。Windows/macOS 打包去除 Sharp WASM；Linux 继续保留 WASM。进入 MSVC 适配器阶段前清除 GCC 参数，实际构建不再产生 GCC 参数被 MSVC 忽略的警告。

运行库构建指纹：`58f18bc8151d547e32cdb4ca5d43d1231f36cf8e8a6023d87b746998fb4f43fc`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| EXE | 140,378,565 | `6be79433bbdcced2e8d32c68272e4efaafc8cd57c08880ce364a29c961e646a7` |
| ZIP | 190,673,156 | `896055e30d5213ee8900af38057f8d6ead59914176a349b1ddab83eef001498c` |
| playback.node | 387,072 | `5568a89bec6360aaf527a90f5d48ab735019b5a86725600c24748d8bdfe2c897` |
| libmpv-2.dll | 44,252,480 | `11adc45d801486a1eda63496e7ff03f798e21a22fa5b013efc6485e81eb28f31` |

EXE 约 133.88 MiB，ZIP 约 181.84 MiB。对应源码包 `Javdex-Playback-Sources-0.9.0-win32-x64-e0df4ecb34b7-daed6ad6.tar.gz` 为 57,964,180 B，SHA-256 为 `620eb7165cf2e019b7080c58e5b5948110b141515ff55dd3331e7f44e6864692`。实际核对该源码快照包含新入口，且不含旧 Windows 显示/滑块源码；新入口字节与本轮工作区一致。

## 本机验收结果

主机为 Windows 11 x64 / i5-12600K，RTX 4080 驱动 `32.0.16.1742`，UHD 770 驱动 `32.0.101.7092`，显示器仍连接 NVIDIA。所有 GUI 检查均启动实际新包或其 NSIS 提取程序，使用隔离资料库与合成媒体；不使用 Computer Use，不读取个人影片。

| 检查 | 最终结果 |
| --- | --- |
| 全仓预检查 | 架构边界、TypeScript/CSS lint、样式合同与控件合同通过 |
| 全量测试 | `npm run test --ignore-scripts` 退出 0，pretest 已独立完成；Node 部分 193 通过/6 条件跳过，Electron 两批合计 4314 通过/35 条件跳过，总计 4507 通过、41 跳过、0 失败 |
| 应用与文档 | 生产构建、完整类型检查通过；文档站 18 项测试通过 |
| 原生与包边界 | 实际 C++ 核心/纹理票据回归、搬移加载、PCM 正常 EOF、PE 闭包与对应源码摘要通过；95 个包内生产构建文件与工作区输出一致 |
| EXE/ZIP | 完整性通过；分别完整提取并核对 151/150 个文件。差异为 NSIS 专用 `resources/elevate.exe`；NSIS 提取后的实际程序另完成 CPU 播放 |
| 图片与数据库 | 实际包内数据库、Agent 依赖、4K CPU 帧，以及原生 Sharp 的 PNG/JPEG/WebP/GIF/AVIF 编解码、缩放和像素核对通过 |
| 正常默认 Canvas | 不带启用参数的三种 4K24 H.264/HEVC/AV1 均为 GPU Canvas、`d3d11va-copy`，彩色动态画面、暂停跳转、底栏/展开/全屏与停止释放通过 |
| Canvas 字幕/背压 | 三轮停止重开、750ms 慢消费、最多三个槽位，以及 ASS/PGS 在展开/全屏的真实字幕像素差通过；停止后引用归零 |
| 混合显卡 | Chromium 实际选择 UHD 770 时，Intel D3D11 与 NVIDIA WGL 跨设备互操作失败，三种 4K24 自动改用 CPU 且实际画面/控制通过；没有保留旧 HWND 作为隐式备选 |
| 生产异常恢复 | ASS、PGS 分别在新宿主注入一次 `nextFrame` 异常，真实 CPU 解码、字幕及暂停/进度/音量/倍速恢复通过 |
| GPU 进程退出恢复 | 暂停 ASS 与播放中 H.264 分别实际终止自有 GPU 子进程，CPU 自动接管、可见画面和继续播放通过 |
| CPU 与关闭 | 禁用 GPU 的三种 4K24、强制 CPU 的 ASS/PGS、GL 创建失败后的自动接管、正常窗口关闭/退出前释放内核均通过 |

12 组 GUI 宿主全部正常结束，`forced=false / code=0`。临时应用 GPU 偏好全部恢复，最终没有遗留测试包进程。只终止自有测试应用的 GPU 子进程，没有禁用显卡、改动系统驱动或更换视频线。

全量测试第一轮因测试进程将 Git GNU tar 放在系统工具之前，把 `C:` 路径当成远程地址而失败；调整该进程 PATH，让 Windows tar 与 MSVC 工具优先、Git OpenSSL 仍可找到后，完整重跑通过，没有修改产品或放宽断言。失败日志和收据以 `all-tests-first-path-collision*` 保留。

## 交付与边界

本地目录为 `dist/windows-final-20261024/`，包含 EXE、ZIP、对应源码及绑定 sidecar、SHA256SUMS、BUILD-INFO 和测试说明；继续分发二进制时须保留本次对应源码访问方式。完整日志/截图和最终收据位于 `out/windows-final-acceptance-20261024/`，原生编译日志为 `out/windows-canvas-final-runtime-build-20261024.log`。

此前 [Arc B390 纯核显实测](windows-arc-b390-canvas-fix-2026-10-24.md) 证明该修复在该设备上的结果，本轮新包仅在本机混合配置复验，不能将其扩大为新包的独立纯 Intel/其他驱动验收。尚未覆盖物理无 GPU 机器、HDR 物理显示、长时间吞吐/能耗、其他显示器组合，以及干净机器系统安装。本机提取并启动 NSIS 载荷，没有执行系统安装流程；包未签名，应用版本未提升，未发布公开 Release。

提交前复核覆盖全部本轮改动、远程基线、默认入口、GPU/CPU 生命周期、构建配方、平台依赖过滤及验收脚本。冻结清单中的 2426 个源码文件和三份交付归档摘要均与验收时一致，未发现新增阻断问题；仅补正文档的历史状态表述。源码提交及远程同步身份另记于本地交付目录的 `BUILD-INFO.json`，不改写构建时基线或二进制摘要。
