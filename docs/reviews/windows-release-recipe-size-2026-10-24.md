# Windows 正式配方重建与体积对比，2026-10-24

基于 `dev` / `eac0571feae3010a80ca1a5d927b708bb6dd2800` 及本次工作区构建、打包和测试改动，在 Windows 11 x64 本机完成。应用版本保持 0.9.0，本轮是未签名本地测试包；没有更新公开 Release。CPU 回退、取消 1080p 上限和既有核显兼容实现均保留。

后续已合入远程 `c2829c1fd822234c9acdf3b65e8923dee4e45e97` 的 [Arc B390 纯核显字幕与恢复修复](windows-arc-b390-canvas-fix-2026-10-24.md)。本记录的旧包早于该修复，其摘要和本机验证边界保持原样，不能当作含新修复的安装包；下方纯核显待测说明仅描述当时这套产物。

## 对照与结果

已发布版本使用用户提供的 `D:/GreenSoft/Javdex-Setup-0.9.0-x64`，只读核对其播放库清单及实际 mpv 配置，没有下载安装包。EXE/ZIP 原始字节数来自 [v0.9.0 Release 元数据](https://api.github.com/repos/JavdexLabs/Javdex/releases/tags/v0.9.0)，对应当前公开源码 `9d48f4fe80df614137a3b67480309aa17e3e6161`。优化前对照为 `dist/local-uhd770-20261024` 的测试包及 `dist/win-unpacked`；原文件均保留。

| 产物 | 已发布 0.9.0 | 优化前测试包 | 本次重建 | 较优化前减少 |
| --- | ---: | ---: | ---: | ---: |
| NSIS EXE | 140,295,848 B | 164,401,806 B | 140,397,201 B | 24,004,605 B（14.60%） |
| ZIP | 190,652,923 B | 223,135,152 B | 190,697,703 B | 32,437,449 B（14.54%） |
| 解包目录 | 501,815,072 B | 589,854,198 B | 502,284,612 B | 87,569,586 B |
| libmpv DLL | 44,383,304 B | 120,826,880 B | 44,252,480 B | 76,574,400 B |

EXE 为 133.893 MiB，ZIP 为 181.864 MiB，较已发布包分别增加 101,353 B、44,780 B。最终解包目录包含 NSIS 加入的 107,520 B `elevate.exe`；用户提供的已发布 ZIP 目录不含它。安装包压缩率受文件内容和排序影响，不把原始字节减少量当成压缩包减少量。

按磁盘实际文件统计，播放运行库目录从 123,498,659 B 降至 45,252,923 B，应用及依赖从 133,652,882 B 降至 124,329,032 B。Windows 不再携带 9,322,130 B 的 `@img/sharp-wasm32`。共享依赖 `@emnapi/runtime` 继续保留，不猜测其全部消费者。SQLite 清理后不存在的 unpacked 文件不计入分发体积。

## 构建与平台依赖

运行正式 `playback:runtime:build` 入口，使用 `build/playback-sources.json` 的固定源码、原始归档摘要及工具版本：mpv 0.41.0、FFmpeg 9.0.2、Electron 43.8.0 / Node headers 24.22.0。MSYS2 只提供 UCRT64 GCC 16.2.0、工具和系统 ABI；使用 VS 2022 / MSVC 19.44 构建原生适配器。新的运行库包含两个二进制，不复用开发版全功能 libmpv 或 VC runtime/Vulkan DLL 集。

本机首次正式重建暴露新版 MinGW CRT 默认浮点环境符号的静态链接问题。检测到 `libmingw32.a` 的真实定义后显式保留它，实测浮点环境 DLL 加载通过；没有提供桩函数。同时固定私有静态库查找路径，并为 zlib 自建 `libzs.a` 提供相同字节的规范 `libz.a` 名称，最终 mpv 链接记录确认 iconv/zlib 均来自本次固定源码前缀。指纹记录 GCC/CRT/headers 包版本，命中缓存仍重验闭包和解码。

Windows/macOS 平台文件匹配器排除 Sharp WASM，同时继承桌面允许列表；Linux 仍保留 WASM 和既有 GLib 隔离补丁，Node 服务端维持原生后端。归一化匹配器及实际文件选择回归覆盖三平台。本机只生成并实测 Windows x64 安装包，不以匹配器测试替代 macOS/Linux 成品验收。

最终源码构建指纹为 `0c40230bf21d0692d824643fe013e31bc6a193a8b80811c8fde0f50ef21b6b55`。包内 `playback.node` SHA-256 为 `e0f22607a6ce44f3f2c10aad4bad5c4156bfae6e98cb00cc68d6e40aaab306b8`，`libmpv-2.dll` 为 `e13168d1d46471fb11395cdfbc4d94cae2258e527f66a242e75a427715c7aa74`。

## 实际包验收

全部 GUI 检查从 `dist/windows-release-recipe-20261024/win-unpacked/Javdex.exe` 启动，`app.isPackaged=true`，使用隔离资料库和合成媒体，清除开发库搜索路径。各次原生摘要均与新包一致，正常停止及关闭后 `forced=false / code=0`。

| 检查 | 结果 |
| --- | --- |
| 正式构建与搬移 | 原生控制/滑块/纹理票据检查通过；新目录加载、PCM 正常 EOF、PE 闭包及对应源码摘要通过 |
| 安装包和 ZIP | 完整性通过；分别解出 126 个应用及原生依赖文件，与最终解包目录逐字节摘要一致 |
| 应用依赖 | 95 个生产构建文件与工作区输出一致；实际包内数据库、Agent 依赖、4K CPU 帧通过 |
| Sharp | 包内不存在 WASM，原生后端实际完成 PNG/JPEG/WebP/GIF/AVIF 编解码、缩放及像素核对 |
| 默认 GPU | 三种 4K24 H.264/HEVC/AV1 均为 `d3d11va-copy`；彩色动态画面、暂停跳转、底栏/展开/全屏、停止释放通过 |
| UHD 770 混合配置 | Chromium 实际 Intel ANGLE；三种 4K24 的原生解码器均为 `d3d11va-copy`，主进程 Intel VideoDecode 引擎采样最大分别为 14%/13%/14%，实际画面及控制通过 |
| 混合 Canvas | Intel D3D11 与 NVIDIA WGL 的跨设备互操作不兼容，三种 4K24 自动回退 CPU；动态像素和控制通过 |
| GPU 禁用 | 三种 4K24 自动 CPU 解码，2394×1247 物理 viewport 未被缩到 1080p；画面、音频时钟、控制、背压及停止通过 |
| 字幕 | CPU 模式 ASS/PGS 开关造成的真实像素差分别为 164,869 / 44,580，均通过 |
| 故障恢复 | GL 创建失败注入及播放中实际终止自有 GPU 子进程后回退 CPU；恢复位置、继续播放、音量 31、静音及 1.25 倍速，实际画面通过 |
| 自动化回归 | 构建/打包 74 通过、3 项仅适用 Linux/macOS 而跳过；新 addon 的真实 CPU 测试 1 通过，回退行为测试 19 通过；类型检查、定向 lint、应用构建通过 |

UHD 770 驱动为 `32.0.101.7092`，RTX 4080 为 `32.0.16.1742`。显示器仍连接 NVIDIA，因此 WGL 仍由 NVIDIA 提供。只对本次测试包 exe 临时设置用户 GPU 偏好，原值和原先不存在的空键均已恢复；没有禁用显卡、调整驱动或改变显示接线。上述采样只证明实际硬解设备与短时功能，不是吞吐量基准。

## 交付与边界

交付目录 `dist/windows-release-recipe-20261024/` 包含 EXE、ZIP、SHA256SUMS、测试说明、BUILD-INFO，以及本次对应源码包和绑定 sidecar：

- EXE SHA-256：`20f3ae203658b4e53175b18cc7c3e3821b15b3f1ea1d68aa6f4a66644863e3a4`。
- ZIP SHA-256：`d55b7a4457fb6d43f34b4369641f74b252519036f3df11e3bade81b2bfe0048a`。
- 对应源码 `Javdex-Playback-Sources-0.9.0-win32-x64-3ddda7401818-daed6ad6.tar.gz`：57,976,572 B，SHA-256 `8b0730493ee34d6fb2d1dbc25b17dd5eb9c7c656577124a751776a06706fd9b4`。单独交付，不嵌入安装包；继续分发二进制时须保留对应来源访问方式，旧公开源码不替代本轮材料。

本机日志和截图在 `out/release-recipe-validation-20261024/`，编译日志为 `out/playback-release-recipe-build-4-20261024.log`，打包日志为 `out/windows-release-recipe-package-20261024.log`。`BUILD-INFO.json` 记录本次基线提交、工作区差异摘要及产物身份。

尚未覆盖纯 Intel 显示链路/独立核显设备、物理无 GPU 机器、其它驱动/AMD、长时间播放、HDR 物理显示和公开签名发行。CPU 功能保留不保证所有 4K60 或复杂素材实时播放；本机 GPU 禁用检查不能替代独立无 GPU 设备验收。
