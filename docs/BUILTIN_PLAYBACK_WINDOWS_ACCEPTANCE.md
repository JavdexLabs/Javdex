# 内置播放 Windows 验收记录

日期：2026-10-03 至 2026-10-04。用户授权完成 Windows 平台验收，并授权自行准备运行库矩阵。范围包含 Windows x64 开发应用、对应源码/许可材料、实际 ZIP 解压版及 NSIS 安装版；全部在同一 Windows 开发机和隔离合成媒体上检查。

**当前状态：本机 Windows 开发应用及未签名 ZIP/NSIS 的验收范围通过，源码/许可运行库矩阵已自行准备。** 最新四项优化包为 NSIS 152.4 MB、ZIP 208.0 MB；重新编译播放库后，实际安装版通过本地 14 组、远程 8 组及 601.25 秒 4K/60 长测（59.94 fps、丢帧 17），实际卸载通过，详见下方进一步精简记录。前两轮包及对应证据保持历史范围，安装文件与独立源码包分别交付。完整设备、人工听感/读屏、可信签名及独立干净机器验收仍未完成；最新汇总为 `out/playback-acceptance/windows-playback-optimization/distribution-acceptance.json`。

## 环境与构建

| 项目 | 实际环境 |
| --- | --- |
| 系统 | Windows 11 专业版 x64，10.0.26200 |
| 显示设备 | Intel Arc B390，驱动 32.0.101.8359；3120×2080 主屏实际系统缩放四档已检查；另有 RemoteControl Virtual Display，未验收跨屏 |
| 应用宿主 | Electron 43.4.1 x64，仓库构建入口 |
| 原生工具链 | Visual Studio Build Tools 17.14、MSVC 19.44.35225、Windows SDK 10.0.26100、CMake Visual Studio generator |
| libmpv 开发输入 | shinchiro `mpv-dev-x86_64-20261003-git-3186d369f9.7z` 的 headers / `libmpv-2.dll`；由导出表生成同架构 MSVC import library |
| 素材生成器 | FFmpeg N-127054-g9d3f0f2c58-20261001，GPL 开发构建 |
| 实际播放输出 | H.264、HEVC Main10 SDR 为 `d3d11va-copy`，有音轨时为 `wasapi` |

开发输入来自 [mpv 上游列出的 Windows 构建](https://mpv.io/installation/)、[shinchiro 对应版本](https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261003) 和 [BtbN FFmpeg builds](https://github.com/BtbN/FFmpeg-Builds/releases)。仅用于隔离验收，未将其称为经过源码、构建选项和完整许可审计的分发运行库。没有修改系统 PATH、个人媒体库或真实影片；依赖、素材、报告和截图保留在被忽略的 `out/playback-acceptance/`。

`npm run setup:desktop`、`npm run playback:native:build`、`npm run desktop:build` 和 `npm run server:build` 均正常退出。原生构建实际生成并在 Electron 加载 WGL addon，共用核心 C++ 回归执行通过；不是仅测试构建命令。

## 已通过的应用检查

下表的屏幕、输入、系统 DPI 和首轮 10 分钟性能证据使用 shinchiro 开发运行库；不追溯当作新 MSYS2 分发运行库的通过记录。后续运行库和安装包结果另列。

| 检查 | 证据及边界 |
| --- | --- |
| 主播放流程（最终构建） | 23 个检查项：正常播放入口与播放器偏好、展开/底栏/全屏同一会话、暂停/精确定位、指定时间校验、SRT 字号/延迟、字幕避让和控制栏自动隐藏、可选续播、错误/重试/释放、返回协调及显式停止。新帧通知修复后重跑通过，见 `report.json`、`windows-basic-wakeup.log`；清理 `forced=false`、退出码 0。前轮与锁屏/鼠标悬停失败记录分别保留。 |
| 本地素材 | 新帧通知修复后重跑 14 组：AAC、AC-3、E-AC-3、DTS，暂停章节定位，ASS 样式/延迟/全屏避让，HEVC Main10 SDR，无音轨，六档倍速及换片复位，720×576 SAR 64:45、360×640 竖屏、640×270 超宽，复杂 ASS，原创 PGS。`media-matrix/report.json` 与 `windows-media-wakeup.log`；清理 `forced=false`、退出码 0。 |
| 字幕和画面几何 | 在同一暂停帧开关字幕，比对真正 WGL 帧像素；复杂 ASS 含中英文、定位/旋转、矢量裁剪、卡拉 OK；PGS 检查透明性、显示/清除、冷跳与往返定位。展开、最小窗口、底栏和全屏的比例/居中测量来自帧内画面边界，不只读取 viewport 大小。完整判据复用 [字幕记录](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md) 和 [PGS 合同](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md)。 |
| 远程原文件与本机外挂字幕 | 同源码独立 Node 服务端 loopback 正常 writer 认主，客户端实际 HTTP Range 与解码播放。新帧通知修复后重跑 8 组远程素材含四种音轨、章节/ASS、Main10、复杂 ASS、PGS，见 `remote-media-report.json`、`windows-remote-wakeup.log`。此前另通过真实 Windows 文件对话框选择生成的 SRT 和 ASS，共 10 组，保持暂停/同一会话/单次 load，字号合同、帧像素与全屏避让通过；该轮四个原文件共 4 次 grant、11 次 Range/206，传输 85,517,535 字节，见 `remote-picker-request.json` 与 `windows-remote-composition-final.log`。字幕/轨道操作不重新授权，快照不含 grant URL 或字幕路径，远程桌面不打开本地 catalog。成功回归均清理 `forced=false`、退出码 0，不是独立机器/网络或 Docker 验收。 |
| 正常关闭 | 新帧通知修复后重跑：活跃播放中接受主窗口关闭时内核仍存活，原窗口确实销毁，`will-quit` 前内核释放且剩余窗口为 0，进程正常退出。`close-report.json`、`windows-close-trace.json` 和 `windows-close-wakeup.log`。 |
| 可见画面与原生鼠标 | 同环境用未启用兼容开关的隔离构建复现黑屏；最终产品入口自动选择兼容路径，无需诊断启动参数。系统窗口截图实际显示展开、底栏、全屏的色条、时间码和字幕，以及可见全屏按钮/滑杆。暂停全屏原生 drawable 为 3120×1904，字幕完整处于控制栏上方；隐藏后恢复 3120×2080。实拖进度 20→60.033 秒、音量 50→89；随后方向键进度为 65.033、音量 90，没有键释放回退。播放中自动隐藏后首次点击原“收起”位置，回到底栏且保持播放、同一会话/单次 load。见 `windows-input-report.json` 和下列屏幕证据。 |
| 辅助技术名称与暂停恢复 | UIA 实际发现进度滑杆缺名、音量被相邻时间文本命名；修复后为“播放进度”“音量”，原生按钮名称及数值可读取。真实 Tab/方向键检查维持暂停、20→25 秒和单次 load。暂停最小化再恢复、全屏切换均实际显示已有色条/字幕，没有用诊断捕获补绘。`windows-accessibility-before.txt`、`windows-accessibility-final.txt`、`windows-paused-restore-final.png`、`windows-paused-fullscreen-redraw-final.png`；结构可达不等于朗读听感通过。 |
| 实际 Windows DPI | 从系统“显示”设置切换 100%、125%、150%、200%，每档实际截图检查展开和全屏色条、字幕及控件。`GetDpiForWindow` 分别为 96/120/144/192，Electron scale 为 1/1.25/1.5/2，原生像素尺寸与 surface×scale 一致（全屏扣除 88 DIP 控制栏，舍入容差 2 像素）；八次保持同一会话、暂停 20 秒、一次 load。`windows-dpi-report.json`、各档状态及截图；最后实际设置恢复原来的 200%，隔离应用正常关闭。没有用网页 zoom 代替系统 DPI。 |
| 异常退出后恢复 | 仅强制终止验收宿主拥有的进程树，随后用同一隔离 catalog 重启。起始无旧会话、native 未存活，重新播放产生新 sessionId、一次 load、0 commandErrors，随后正常关闭 `forced=false`、退出码 0。`windows-restart-report.json`；故意强制退出本身不算正常关闭，也不代表崩溃根因已测试。 |
| 4K/60 连续播放及长时间轴 | 最终源码完整连续 600.645 秒，提交 35,944 帧，平均 59.8423 帧/秒、丢帧 46（0.1276%）；期间展开→底栏→展开→全屏→展开，音视频时钟推进、同一会话/单次 load、0 commandErrors。14 个丢帧在进入全屏附近、32 个在退出附近，其余采样未新增；不是零丢帧或物理面板刷新率证明。两小时循环素材暂停定位 3599/3601/7198/0 秒、末尾 EOF、五档网页 zoom 与原生像素尺寸，以及正常关闭均通过，共 12 项。`windows-shinchiro-extended-summary.json`（原完整报告随后被短测覆盖，保留摘要），真实系统截图为 `windows-4k60-expanded-screen.jpg` / `windows-4k60-fullscreen-screen.jpg`。 |

上述成功回归均记录 `forced=false`、退出码 0。WASAPI 状态及音频时钟推进只证明实际输出链路，不能替代人工听感、声道定位和音画同步；倍速保调同样未获听感验收。Main10 SDR 不代表 HDR、杜比视界或 HDMI 直通。

4K 素材是自行生成的 12 秒 H.264/AAC 色条与时间码片段，循环封装到 7200.021 秒，3840×2160、60/1 fps，2,290,954,047 字节；SHA-256 为 `dcdc9a71e2c05896e220bd1cba3612d63635a003f4de37f0da2b5d86496f8be7`。完整复测实际播放 10 分钟，其余长时间轴由精确定位与 EOF 检查，不冒充观看两小时真实电影。本轮复用既有文件，生成日志及 ffprobe 元数据留存；脚本备用生成配方不追溯描述该文件。2 秒采样最大音视频时钟差为 0.2002 秒（分次观察，仍不等于人工口型同步）；主进程 private memory 为 985,620–1,538,164 KiB，开始/结束为 1,102,308/1,191,620 KiB。不同展示尺寸会改变分配，这个有界观察不能证明没有内存泄漏。

## MSYS2 运行库与实际安装包

后续按用户“没有，你能自己处理吗”的授权，自行准备 `out/playback-runtime/win32-x64/`，并生成实际 0.8.0 x64 ZIP 与 NSIS。原 shinchiro DLL 缺少足以绑定其构建的完整对应源码，未为它补造清单；新输入采用 MSYS2 CLANG64 的 mpv `0.41.0-8`、FFmpeg `9.0.2-1`，原生 adapter 用匹配的 Clang 22.1.8/Ninja 实际编译。

- 运行库包含 131 个二进制、106 个独立来源组件和 449 个文件（含 runtime.json）；每个二进制有唯一源码/配方/许可所有者，实际输入、ZIP 内目录与 NSIS 安装目录均通过摘要、PE 架构、普通/延迟导入和同目录依赖闭包检查。组件上限由 100 调整为 128，保留各包身份；没有把多个来源并为虚构组件。`staging-report.json`、`windows-zip-inventory.json`、`windows-nsis-inventory.json`。
- 105 个上游包的 preferred source、补丁与固定 Git 版本按 `.BUILDINFO`、匹配 PKGBUILD 及上游 checksum 核对，`SOURCE-REVIEW.json` 为零错误。完整源码包和原始许可文本随运行库提供，`UPSTREAM-PACKAGES.json`、`TOOLCHAIN-LOCK.json` 留存包/工具链身份。LLVM、MinGW CRT/headers、Electron 接口和本仓库构建源码集中于 `sources/native-toolchain.tar.gz`；其中也保留矩阵准备脚本和冻结的 MSYS2 数据库。
- rav1e/librsvg 补充 Cargo.lock 对应的 1020 个去重 crate 源码及 Rust 标准库源码；librsvg 的 PKGBUILD 执行 windows-sys 精确降版，使用匹配 Cargo 重建的锁文件明确标注为 reconstructed。Whisper 的固定 Git 树、必要祖先与 tag 保留，确认 tree SHA 及 `git describe` 一致。源码与环境配方是可审查材料，不声明输出可逐字节重现或代替独立许可审查。
- DLL 收集曾将同名 MSYS2 Mesa `opengl32.dll` 误纳入候选；已改为 Windows WGL 系统库，保留过度收集记录。最终实际加载的 131 个非系统播放模块全部来自安装目录，OpenGL 来自 `C:\Windows\System32\opengl32.dll`，见 `windows-nsis-loaded-modules.json`。
- ZIP 是从实际 `.zip` 提取并启动，NSIS 是实际 `/S /currentuser` 安装，未用 `win-unpacked` 替代。测试子进程 cwd 为空目录，PATH 仅为 `C:\Windows\System32;C:\Windows`，移除开发 mpv prefix；父进程只负责生成/索引隔离素材。两种应用主流程各 23 项通过，安装版另通过本地 14 组、远程 8 组、播放中正常关闭与强制退出后重启，正常清理均 `forced=false`、退出码 0。分别见 `windows-zip-basic-report.json` 与 `windows-nsis-*-report.json`。这是同一开发机去除开发路径的实际安装验收，未冒充独立干净机器。
- 初次 NSIS 资源下载出现 `The server aborted pending request`，ZIP 已生成而该次 NSIS 失败；保留 `windows-runtime-dist.log`，NSIS 独立重试实际退出 0。ZIP 首次检查失败于截图写入只读 app.asar，已让验收输出使用绝对证据目录；后续一次全屏焦点超时也保留，实际激活窗口后的完整重跑通过。包内播放修复与测试脚本修复分别记录。
- 最终包摘要和大小见 `windows-distribution-artifacts.json`。安装器、包内 exe 均未签名；ZIP 不适用 Authenticode。源清单 `pre-sign` 摘要不是可信代码签名，也不证明最低 Windows/驱动兼容性。

新运行库开发应用已独立重跑主流程 23 项、本地 14 组、远程 8 组及 30.180 秒 4K 短测（1811 帧、60.0066 帧/秒、0 丢帧），均正常退出；不继承旧 DLL 的通过结果。完整 `npm test` 为 3521 通过、24 跳过、0 失败，见 `windows-tests-reviewed-runtime.log`；原生核心、真实 PE 搬移、`libc++.dll` 邻接/缺失与系统库负向合同另见 `windows-release-build-contracts-final.log`。

安装版完整长测实际连续 601.183 秒、提交 36,060 帧，59.9817 帧/秒、丢帧 7；其中 6 帧、1 帧分别在进入全屏后的两次采样新增。展开→底栏→展开→全屏→展开，同一会话/一次 load/0 commandErrors、两小时定位/EOF 和五档应用 zoom 合共 12 项通过，正常退出 `forced=false`、code 0。同期内核音视频最大时钟差 0.028773 秒，界面进度与音频最大差 0.200159 秒；主进程 private memory 为 1,021,132–1,505,932 KiB，开始/结束 1,151,896/1,126,092 KiB。仍是循环合成媒体及帧提交观察，不等于物理刷新率、听感或内存泄漏证明。`windows-nsis-extended-report.json` / `windows-nsis-extended-summary.json`；实际安装版屏幕为 `windows-nsis-4k60-expanded-screen.jpg` / `windows-nsis-4k60-fullscreen-screen.jpg`。展开截图来自首次长测，完整重跑期间另检查并保存全屏截图，均为系统窗口原图。

首次新安装版长测约 146 秒触发原脚本的“界面进度 vs 音频时钟”差值断言，判失败并保留 `windows-nsis-extended-sampling-failure.json` / `.log`。原脚本未保存失败瞬间的采样，不能证明仅由分次读取造成；改为在同一次 native state 观察内比较音频/视频时钟，继续保留界面值，并在断言前保存包括失败样本在内的全部记录。0.5 秒容差不变，完整 10 分钟重跑通过；不将首次失败抹去或计为通过。

测试窗口全部正常退出后，使用本任务 NSIS 安装目录自己的卸载器 `/S /currentuser`，实际退出 0；应用 exe、安装目录、当前用户卸载注册项及开始菜单快捷方式均移除，未请求删除应用数据。`windows-nsis-uninstall-report.json` 为 passed。ZIP、NSIS、矩阵、隔离资料和验收证据保留，未发布产物。

## 重新本地打包：运行文件与源码资料分离

此前把完整 v1 审核矩阵直接整体复制进应用，源码与构建资料造成约 863 MB 额外归档负担。现保留完整 v1 门禁，只投影全部 131 个二进制、106 个许可文件与源码获取说明到应用，分发清单使用 v2，来源档案位于独立 `.tar.gz`。安装后的播放目录为 239 个文件、197,815,537 字节；所有二进制摘要与首轮完全一致。

实际重新执行 `npm run dist:win`，构建与打包退出 0。NSIS 为 176,502,689 字节（176.5 MB，首轮 1,038,147,584 字节），ZIP 为 240,100,990 字节（240.1 MB，首轮 1,103,334,287 字节），分别减少约 83.0% 与 78.2%。旧大包移至 `out/playback-acceptance/windows-full-evidence-packages/` 并更新历史报告中的产物路径，未删除证据。

配套 `dist/Javdex-Playback-Sources-0.8.0-win32-x64-65f2b3e68b1a-937ba35a.tar.gz` 为 864,800,857 字节，包含 328 个文件：完整非二进制审核材料、原 v1 清单、当前打包工具与说明，无运行二进制重复。SHA-256、归档条目、嵌入输入清单和当前打包脚本均核对通过，见 `windows-lean-source-audit.json`。包内 `sourceBundle` / `SOURCE-ACCESS.txt` 提供文件名和摘要；需与应用包配套交付，不把本地文件名当作已完成公网源码托管。

新增分发检查拒绝源码泄漏、输出清单冒充已审输入、二进制改动和复用源码包摘要不匹配；`npm run test:packaging` 为 25 通过、3 个其它平台条件跳过、0 失败，见 `windows-lean-packaging-tests-final.log`。没有更换或重编播放二进制，精简包的实际应用/安装回归单独记录在 `windows-lean-*-report.json`，不声称重新做过首轮 14/8 素材和完整 10 分钟矩阵。

精简 ZIP 实际解压版和 NSIS 实际安装版各通过主流程 23 项，安装版再通过 30.240 秒 4K/60 短测、两小时定位/EOF 和应用缩放共 12 项：59.9868 帧/秒、0 丢帧，同次 native 音视频最大时钟差 0.001339 秒。子进程 cwd 为空目录、PATH 仅 Windows 系统目录、开发 mpv prefix 为空；所有 GUI 检查正常退出 `forced=false`、code 0。播放中正常关闭的 2 项断言与实际卸载均通过，安装目录、注册项及开始菜单快捷方式移除，未请求删除应用数据。签名检查仍为 NotSigned。精简包最终摘要、源码包绑定和验收汇总为 `windows-lean-artifacts.json` / `windows-lean-distribution-acceptance.json`；首轮旧包与其完整长测证据继续保留。

## 进一步精简：原生模块、服务端产物、WASM 与播放库

用户要求执行四项优化后，重新构建 Windows x64 FFmpeg/mpv 并生成 ZIP/NSIS。其它平台及其它架构 clipboard/console 原生模块不再进入 Windows 包，保留本架构模块；桌面排除 `out/server`，保留局域网前端 `out/web`；Photon 仅保留主进程 chunk 旁的 WASM。实际解压版与安装目录均核查上述内容，并实际加载 Pi 资源扩展、Cheerio/Undici、Photon PNG 编码及 Windows clipboard/console 绑定。

播放库保留解码、网络、字幕、WGL/WASAPI 及 D3D11VA/DXVA2/CUDA 接口，去除主要视频编码器、封装器、VapourSynth/Python、采集及终端画面依赖，仅保留 PNG/MJPEG 图像写入。使用 `build-windows-playback-libraries.mjs` 构建后，`stage-windows-playback-profile.mjs` 根据未改动 addon 的实际 PE 导入闭包生成新矩阵；原矩阵保持完整。未知来源、缺失依赖或仍导入重型编码器/Python 会拒绝。新输入为 `out/playback-runtime/optimized/win32-x64`，89 个二进制、76 个来源组件；二进制从 179,552,768 降到 99,635,712 字节，减少 42 个文件及约 44.5% 大小。

| 产物（十进制 MB） | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| NSIS | 176.5 MB | 152.4 MB | 24.1 MB（13.7%） |
| ZIP | 240.1 MB | 208.0 MB | 32.1 MB（13.4%） |
| ZIP 解压目录 | 659.4 MB | 547.7 MB | 111.7 MB（16.9%） |

本轮没有改变 ZIP/NSIS 压缩参数。NSIS 为 152,405,461 字节，SHA-256 `3e084e95ab835f1cf8265fa2a652420ed4085f1f714d9f65ca4003676538269f`；ZIP 为 207,966,317 字节，SHA-256 `293355b80017ab23907deb0cd72a65b9ddef534fc6798ac8b42d3d02bf9c32ae`。上一轮安装包及配套源码包移至 `out/playback-acceptance/windows-playback-optimization/prior-packages/`，历史报告路径同步，保留原摘要。

配套源码为 `dist/Javdex-Playback-Sources-0.8.0-win32-x64-0331181067cb-7501d05b.tar.gz`，520,563,139 字节，SHA-256 `a426e448fb63ffe3ee042f5e161362d8523e345da1d18b58619a682743ca969a`。核查全部 230 个非二进制输入文件摘要、原 v1 清单及当前打包工具；源码包含 241 个文件，不重复运行二进制。实际包播放目录只有 167 个文件（89 个二进制、76 份许可、来源访问说明和 v2 清单），共 103,684,364 字节；独立源码及构建资料不进入应用。

初次打包发现 Windows 专属 `files` 只有排除项，打包器将该文件集默认扩成全部仓库文件，产生错误的大归档；已停止该次构建并保留 `dist-rejected-filter.log`。修复为平台文件集同时保留桌面允许列表，新增覆盖配置归一化后的真实 matcher 回归；最终实际 ZIP/安装目录内容审计通过，错误产物未交付。修复后的 `npm run test:packaging` 为 27 通过、4 个其它平台/模式条件跳过、0 失败；本轮 `npm test` 的应用测试仍为 3521 通过、24 跳过、0 失败（最后仅调整打包配置及对应测试，定向检查另跑）。共享 mpv 核心 C++ 回归与隔离加载精简 DLL 的编解码能力检查均通过。

实际 ZIP 解压版与 NSIS 安装版各通过主流程 23 项，安装版完整本地素材 14 组、远程素材 8 组（另含远程模式/授权等 9 条断言）、播放中关闭 2 项均通过。重编播放库后的 4K/60 连续播放为 601.25 秒、59.9385 fps、丢帧 17，含两小时合成媒体定位/EOF 与应用缩放共 12 项；同次 native 音视频最大时钟差为 0.030759 秒，该时钟观察不代替人工听感。HEVC Main10 仍为 `d3d11va-copy` 和 WASAPI。所有应用正常退出，`forced=false`、code 0；安装版使用空 cwd、仅 Windows 系统目录的 PATH、无开发 mpv prefix。实际静默卸载后安装目录、exe、注册项、桌面及开始菜单快捷方式均不存在，未请求删除应用数据。

本轮证据统一位于 `out/playback-acceptance/windows-playback-optimization/`：`distribution-acceptance.json`、`artifacts.json`、`package-content-audit.json`、`source-audit.json`、`runtime-review.json`、`install-report.json` / `uninstall-report.json`、各 `zip-*` / `nsis-*` 报告和日志。签名仍为 NotSigned；同一 Windows 开发机的隔离进程回归不扩大到独立干净机器、可信签名、其它 GPU 或人工听感的正式验收。

## 提交前检视（2026-10-05）

检视发现并修复两项工具问题：主流程、本地素材、远程、字幕和关闭验收现在统一记录退出结果，强制清理、非零退出码或信号退出会将报告置为失败并返回非零，不把有界清理当成正常退出；回归覆盖包含“强制清理但退出码为 0”的情况。运行库准备入口从 `--evidence` 中的 `toolchain-lock.json` 或显式 `--toolchain-lock` 读取工具链材料，缺失时在写入目标前拒绝，移除对旧验收缓存目录的硬编码依赖。

重新执行 `npm test` 退出 0，边界、lint、类型检查及 Electron 回归通过，Electron 3521 通过、24 跳过、0 失败，日志 `windows-code-review-tests.log`。最后的打包测试为 29 通过、4 条件跳过、0 失败，日志 `windows-code-review-packaging-final.log`；跳过包含其它平台/文件模式以及本次普通 PowerShell 中未提供 MSVC 的真实 PE fixture，之前实际 MSVC 编译及加载记录保持其历史范围。

修复后的脚本在实际 ZIP 解压应用上重跑主流程 23 项、本地 14 组及远程 8 组，播放中关闭 2 项另跑通过；均正常退出 `forced=false`、code 0，报告为 `windows-code-review-basic-report.json`、`windows-code-review-media-report.json` 、`windows-code-review-remote-report.json` 和 `windows-code-review-close-report.json`；包内 Agent/Photon/Windows 模块加载重查通过。使用独立材料目录重新执行运行库准备，新矩阵全部 89 个二进制摘要与此前完整安装/长测的矩阵一致，来源材料及 PE 闭包校验通过，记录在 `windows-code-review-profile-stage.log` 和 `windows-code-review-profile/`。上述证据均位于 `out/playback-acceptance/`。

## 修复与工程验证

- 实际屏幕黑屏：Chromium DirectComposition 合成树遮住同一主窗口中的 WGL 子窗口。Windows 正常桌面入口只有检测到原生播放 addon 才在 `ready` 前添加 `disable-direct-composition`；没有 addon 的普通包、刮削 helper、macOS 与 Linux 不改变该选择。实际 `getGPUFeatureStatus()` 的 GPU compositing、rasterization、video decode、WebGL/WebGPU 仍 enabled。采用 Chromium 正常 GPU swap chain，没有关闭硬件加速。相关合同见 [Chromium 合成路径源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/gl/direct_composition_support.cc) 和 [Microsoft HWND composition layers](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondevice-createtargetforhwnd)。
- 全屏过渡重绘：给 Electron parent 加标准 `WS_CLIPCHILDREN`，给现有直接 child sibling 加 `WS_CLIPSIBLINGS`，让网页/原生区域在重绘时互相避让；按 Win32 父子关系处理，不依赖 Chromium 私有窗口类名，释放时只撤销本 adapter 增加的位。视频 `WM_SIZE` 投递主窗口线程消息，在 `SetWindowPos` 完成后重绘已有帧；避免回调内读到尚未提交的 drawable 尺寸。周期检查可见性恢复，暂停最小化后也重绘一次。修复旧 framebuffer 尺寸和字幕位置问题；真实屏幕检查没有在每次输入后调用诊断帧捕获补绘。
- 原生滑杆名字：标准 trackbar 代理忽略 caption 并借用相邻静态文本。通过 `IAccPropServices` 注解 MSAA/UIA Name，拆除前清理注解并释放 COM 引用；实际 UIA 树核对修复。依据 [Microsoft direct annotation](https://learn.microsoft.com/en-us/windows/win32/winauto/using-direct-annotation)。
- 4K/60 性能：首次完整 10 分钟提交约 42.28 帧/秒、丢帧 10,652，判失败并保留 `windows-extended-baseline-report.json`。实际 render/swap 均值仅约 1.6 毫秒，JavaScript 16 毫秒轮询实际约 41 次/秒；提高 timer 精度及保持前台的短对照没有改善，定时精度实验已撤回。最终将 libmpv 新帧回调通过 `PostMessage` 唤醒 HWND 所在线程，合并通知，所有 WGL 操作仍在拥有线程，失败由常规观察回传；共享核心的默认调用保持其它平台原路径。30 秒对照为 60.01 帧/秒、0 丢帧，见 `windows-wakeup-diagnostic-report.json`；最终完整 10 分钟按预设 ≥55 提交帧/秒、≤5% 丢帧判据通过，实际值及切换瞬间丢帧见上表，并已重跑主/本地/远程/关闭回归。线程约束见 [mpv render API](https://github.com/mpv-player/mpv/blob/master/include/mpv/render.h)。
- 首次真实 MSVC 配置复现 CMake 将 `D:\PROJECT` 当作转义序列。输入路径统一经 `file(TO_CMAKE_PATH)` 规范化，原生构建随后通过。
- Windows 全屏自动隐藏失败：周期几何/显隐产生 `WM_MOUSEMOVE`，反复重置最后交互时间。停止按该消息无条件计时，继续在渲染循环比较真实指针位置，并保留按钮/滑杆/键盘交互。回归验证控件隐藏与 native viewport 恢复。
- 中文输入法激活时，原生视频 M/F 键被 IME 消费。仅对没有文本输入的原生视频/控件 HWND 解除 IME context，保留 Electron 网页输入的 context，并链接 `imm32`。实际按 M 切换静音、F 进入/退出全屏；返回网页搜索框用中文候选提交“在”成功。
- 原生 trackbar 在被自定义处理的方向键释放时仍发送 `TB_ENDTRACK`，旧滑杆值抵消相对命令。仅鼠标拖动可以提交绝对 thumb 值；实际键盘验证暂停位置 20→25 秒、Shift+Left 限制到 0、音量 50→51，保持相同会话/单次 load，键释放后不回退。Tab/Shift+Tab、Space/Return 按钮与 F 返回 HTML 也通过。最终屏幕修复后另外实拖鼠标，并交替用方向键检查，数值正常保持。证据为 `windows-input-report.json`；读屏朗读仍待验。
- Windows 来源检查的测试把 JSON 身份中的转义路径当原始子串。改为解析身份后比较 canonical 路径，不修改生产身份或放宽授权。
- GUI 验收宿主支持 Windows Electron 直接启动。缓存属于验收的进程引用，避免最后窗口自然退出后读取已失效的 Playwright dispatcher；退出等待也覆盖系统模态框令 inspector evaluation 挂起的情况。Windows 超时清理终止其拥有的进程树，避免只结束 launcher 后留下模态窗口。正常退出与超时强制清理分别记录。最新主/远程失败会覆盖对应最新报告，避免读取旧通过记录。
- Windows addon 增加只在验收使用的单次 WGL BGRA 帧诊断，与其它平台复用像素判据；不增加产品 IPC 或日常视频帧传输。
- PE 技术检查加入目标 Machine、PE32+ DLL、sections/RVA、普通/延迟导入、本目录依赖闭包和 Electron delay-load 合同；VC++ runtime、Vulkan 与 codec 依赖不获系统库豁免。真实 MSVC fixture addon/DLL 移到新目录并删除原目录后，在不含 DLL 的工作目录由 Electron 加载成功；移除依赖正确拒绝。该 fixture 不是 libmpv 分发库。
- 真实 Vulkan loader 导入 `CfgMgr32.dll`，它属于 Windows Configuration Manager 系统组件，加入 OS 库清单并保留 Vulkan 本身必须邻接的负向回归；依据 [Microsoft ConfigManager API](https://learn.microsoft.com/en-us/windows/win32/api/cfgmgr32/nf-cfgmgr32-cm_get_devnode_propertyw)。实际最终 addon、libmpv、三份 VC++ DLL、Vulkan loader 共六个文件的 PE 静态闭包通过。最终 addon SHA-256 为 `f1a99880c84c0d6e49df8cac18d0fe90790ecd6b06e7b6baf4a816dea077bc2c`，复制至新目录，在空工作目录和移除开发 PATH/prefix 的 Electron 子进程中实际加载成功；`windows-runtime-preflight.json`、`windows-relocated-runtime-load.json`。仍是同一开发机，System32 模块存在，不是干净安装；正式 runtime.json 缺失时打包校验正确拒绝。

最终 `npm test` 退出 0：pretest/lint、类型与架构合同、打包及素材/构建测试通过；Electron 测试 3545 项，3521 通过、24 条件跳过、0 失败，包括 Windows 启动选择、真实 PE fixture 搬移和系统库/缺依赖检查。日志为 `windows-tests-extended-final.log`。单独 `npm run test:packaging` 为 26 项，23 通过、3 跳过（其它平台的真实 Mach-O/ELF 和 POSIX mode 检查），见 `windows-packaging-extended.log`；构建命令测试另外 5 项通过。最终 MSVC 原生构建及共享核心 C++ 回归通过，见 `windows-native-wakeup-final.log`。没有将跳过项算成通过；其它平台共享回调默认参数由编译合同覆盖，未声称在本 Windows 主机重跑了 macOS/Linux GUI。

屏幕证据保留在 `out/playback-acceptance/`：`windows-screen-composition-baseline.png` 为同环境黑屏对照，`windows-screen-expanded-final.png`、`windows-screen-docked-final.png`、`windows-screen-fullscreen-controls-final.png`、`windows-screen-fullscreen-hidden-final.png` 分别为最终三种展示及全屏隐藏状态。截图直接来自系统窗口观察，未裁剪/加工；`windows-composition-baseline-state.json` 和输入报告同时保留启动开关、GPU feature status 与播放状态。对照构建仅临时改动被忽略的输出入口，随后按备份摘要核对恢复；源码和最终入口均使用正常产品启动逻辑。

## 未通过或尚未执行的关口

1. **Windows 读屏与设备矩阵。** 当前已区分并修复真实显示缺陷，三种展示的屏幕画面、原生输入和隐藏后收起有实机证据；UIA 名称问题已修复，但可读取原生视频、按钮、滑杆及其数值，不等于完成读屏朗读验收。锁屏焦点超时记录 `windows-basic-locked.log` / `windows-basic-locked-failure.json` 继续保留。两次最终主流程自动隐藏回归曾因鼠标停留在全屏“收起”区域而失败（悬停保持可见符合产品合同），保留 `windows-basic-pointer-hover.log` / `windows-basic-pointer-hover-failure.json`；将物理指针移出控制区域后重新检查，不修改隐藏断言。`playback-windows-input-acceptance.mjs` 只提供隔离暂停素材和只读观察，真实动作与屏幕检查另存报告；已正常关闭隔离窗口。
2. **选择器历史失败。** 锁屏时两次等待超时，记录为 `windows-remote-picker-locked-failure.json` / `windows-remote-picker-locked.log`。解锁后的首次操作未能完成输入，也超时且强制清理，记录为 `windows-remote-picker-ui-failure.json` / `.log`；不将该次清理称为正常退出。之后根据主窗口截图及可见焦点框操作成功，SRT/ASS 最终重跑通过，没有 mock 对话框。工具返回的模态 UIA 焦点/控件缓存未同步，不能仅凭它宣称输入失败或已成功。
3. **一次 Chromium 异常。** 早期素材矩阵运行期间并发做系统窗口观察，Chromium 报 `Must be called on Chrome_UIThread; actually called on Unknown Thread`，退出码 2147483651；后续完整矩阵通过。原日志在 `media-application.log`，尚未证明根因或排除重现，不因重跑通过而抹去异常记录。
   本轮重启脚本首次带 shell 输出重定向的启动退出码为 1、日志为空，遗留一个未进入播放的隔离 catalog 主窗口；原因未确认，已用实际窗口关闭并复核进程消失。不重定向的重试完成全部重启断言且正常关闭；首次启动不算通过。该记录独立于故意强制退出的测试步骤。
4. **实际观看与设备矩阵。** 人工音画/倍速听感、真实长片、高复杂度/高码率 4K、真实影片 ASS/更多图像字幕、物理跨显示器/DPI 与驱动切换、独立机器网络未验收。主屏系统缩放四档及隔离进程硬退出后恢复已有证据；两小时循环合成媒体的时间轴定位/EOF 与 10 分钟播放，不等于实际观看两小时影片。
5. **正式分发。** Windows x64 对应源码、许可、配方清单和实际未签名 NSIS/ZIP 已提供，去除开发路径的本机安装回归已执行。仍缺可信代码签名、独立干净 Windows 机器/最低版本/驱动矩阵、同版本完整服务端安装及其它平台的分发验收；同源码 Node loopback 远程播放不替代这些关口。清单和材料核对不自动构成独立许可审查或发布授权，三平台共同发布关口保持。

## 复现入口

在仓库根目录的 VS Developer PowerShell 中准备同架构 libmpv 开发前缀、匹配 Electron headers/node.lib、FFmpeg，并使该次进程 PATH 包含开发 DLL。

```powershell
$env:JAVDEX_MPV_PREFIX = 'D:/your-reviewed-dev-prefix'
$env:Path = "$env:JAVDEX_MPV_PREFIX/bin;$env:Path"
npm run playback:native:build
npm run desktop:build
npm run server:build
node scripts/playback-acceptance.mjs
node scripts/playback-media-acceptance.mjs
node scripts/playback-close-acceptance.mjs
node scripts/playback-remote-acceptance.mjs --media-matrix
node scripts/playback-windows-input-acceptance.mjs
# 完成真实输入并关闭窗口后，串行运行扩展检查：
node scripts/playback-windows-restart-acceptance.mjs
node scripts/playback-windows-extended-acceptance.mjs --require-focus
# 默认连续播放 600 秒；--soak-seconds=30 只用于短性能对照。
# 完成原生输入检查并正常关闭隔离窗口后，再运行需要人工选择的检查：
node scripts/playback-remote-acceptance.mjs --media-matrix --system-subtitle-picker
```

各 GUI 回归使用独立临时资料目录；不要以强制清理、进度值、解码器名称、帧读回或单元测试替代未获证实的屏幕、输入、声音和安装关口。

本轮已准备的矩阵可在仓库根目录用于打包（普通 npm 开发构建仍使用 MSVC；该矩阵的 Clang 构建配方在 `recipes/Javdex.txt`）：

```powershell
$env:JAVDEX_PLAYBACK_RUNTIME_DIR = (Resolve-Path 'out/playback-runtime').Path
npm run dist:win
# 对实际解压后的 ZIP 或 NSIS 安装目录执行，子进程会自行移除开发 PATH：
$env:JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE = (Resolve-Path 'out/playback-acceptance/windows-zip-extracted/Javdex.exe').Path
node scripts/playback-acceptance.mjs
# 切换该变量到实际安装后的 exe，再串行运行素材/远程/关闭/重启/扩展检查。
```

NSIS 验收使用本任务独立安装目录、当前用户注册项，不删除应用数据；最终应使用该目录自己的静默卸载器检查 exe、注册项和快捷方式移除。可信签名不在本轮输入中。
