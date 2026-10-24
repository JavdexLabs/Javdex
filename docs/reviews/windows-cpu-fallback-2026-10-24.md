# Windows CPU 播放兜底，2026-10-24

基于 `dev` / `ccd131b073639e96f1c35fad425c5ab93d766858` 和工作区既有 Windows Canvas 修正继续实现。没有提交、推送或发布；此前未提交改动及备份分支保持。材料在 `out/playback-acceptance/windows-cpu-validation-20261024/`，构建和测试日志在 `out/windows-cpu-*.log`。

## 实现与适用范围

Windows 正常路径仍为 HWND／WGL，候选 GPU Canvas 开关保持。`windowsSoftwarePlayback.cpp` 使用同一个随包 libmpv 的 SW Render API、`hwdec=no` 和既有 CPU SDR 转换；不创建 OpenGL context、D3D 设备或共享 GPU 纹理。对齐内存先渲染，填充不透明 alpha 并清零行 padding，再复制 RGBA 帧到隔离 preload。复用 `putImageData` 接收器，允许 Windows 在 Electron 共享纹理 API 不可用时绑定 CPU Canvas，并用 `willReadFrequently:true` 请求软件 backing。图形库 DLL 仍可被同一个 addon 静态导入，软件路径不调用其图形创建 API，不随包提供驱动。

首轮显示帧曾按实际 viewport 等比限制在 1920×1080 内；用户随后要求与 Linux 对齐，当前已取消该质量上限，按 `round(逻辑尺寸 × 缩放)` 渲染，保留单边 8192、单帧 256 MiB、缩放不超过 8 的安全边界，超出时拒绝。下方首轮材料仍对应当时的 1080p 上限，取消上限的检查另记于末节。输入解码仍按媒体分辨率执行。主进程最多两帧在途，可信主 frame 的绑定／序列／时间线及 ACK 约束背压，隐藏时继续泵事件并 skip，拒绝迟到绑定和无效尺寸；超时停止，清理监听器和内存。Canvas 提交不视为物理上屏。CPU 性能不保证所有 4K／60fps 或复杂编码实时播放。

`windowsPlaybackFallback.ts` 在图形创建异常、可检测的 native/video 故障或 Electron 硬件加速关闭后，改用独立 CPU 内核。保留当前授权来源、暂停与 seek 意图、音量／静音／倍速、轨道、外挂及 AI 字幕；在重新加载和 seek 后恢复。旧 GPU 先隐藏并停止，未知资源保持隔离，不强行释放；本次进程固定 CPU，重启才再试 GPU。新来源和停止使旧异步恢复失效。媒体／授权／音频错误、页面销毁和 CPU 自身错误不进入循环回退；驱动调用完全挂死主线程不保证进程内恢复。`--javdex-cpu` 为显式 CPU 诊断入口，`--` 后不生效。

## 实机与证据

Windows 11 x64、i5-12600K、RTX 4080、Electron 43.8.0，沿用前轮 4K／144Hz 显示器及 175% 缩放。`--disable-gpu` 的真实应用报告为硬件加速关闭，OpenGL off、GPU compositor／rasterizer／video decode 为 software；软件路径实际 `hwdec=no`，旧两种生产端未启动。它验证应用软件渲染与软件合成路径，不能冒充物理移除 GPU 后的独立机器验收。

初始原生烟测在 4 秒内生成 119 帧 H.264 1080p30 的 640×360 软件画面，彩色像素、WASAPI、时钟及正常退出通过。初始完整应用禁用 GPU 后通过彩色视频、暂停 seek、展开／底栏／全屏、慢消费、停止归零。GL 初始化失败注入只替换自有测试宿主的 native `create`，CPU 解码与显示是真实实现；不将注入视为物理坏驱动测试。

实际 GPU 故障检查仅终止自有验收宿主的 GPU 子进程，没有禁用显卡、重置驱动或改用户显示设置。CPU 在同一播放会话恢复 3 秒位置、暂停、31 音量、静音、1.25 倍速与嵌入 ASS；原生最终状态及 Canvas on/off 字幕差分均核对。首轮错误地要求暂停后的原生帧数持续大于 2，次轮过早读取异步 volume 观察值，失败材料分别保留在 `gpu-fault/`、`gpu-fault-final/`。修正后等待实际已恢复帧及原生参数的异步确认，`gpu-fault-verified/` 通过，不改产品的恢复门槛或伪造原生状态。

首次扩大输入矩阵时，前六个 1080p30／4K24 × H.264／HEVC／AV1 均完成；随后因跨素材目录不属于 seed 的授权根而被拒绝，`matrix/` 整体仍失败，保留原记录。验收入口随后增加同目录前置检查，后续按授权根分别运行，不放宽产品路径守卫。

PGS 首轮在 cue 恰好结束的 3 秒取样，`final/subtitles/` 保留失败；按夹具已定义的 1–3 秒 cue 中点 2 秒重新检查，`final/subtitles-verified/` 通过，不改变字幕像素差分门槛。

继续补验播放状态下的 GPU 故障时暴露真实呈现问题：CPU 位置／参数及提交回执已恢复，但复用的加速 Canvas 出现空白／失效资源图标；`final/gpu-fault-playing/` 保留截图和失败。产品修正为按 surface token 更换 Canvas DOM 实例，CPU 绑定请求软件 backing；普通时钟及展示形态更新保持同一实例。`recovery-final/gpu-fault-playing{,-beta,-gamma}/` 三个独立宿主实际终止 GPU 子进程后，恢复彩色动态截图、继续推进、31 音量、静音和 1.25 倍速，均通过；另有暂停 ASS 故障恢复通过。没有用提交计数代替呈现检查，也没有删除这次真实失败。

原生检查另外覆盖 4K／2× viewport 的尺寸上限、17 像素宽的行 padding 清零、opaque alpha、停止归零，以及 Worker 导入被拒后主线程 CPU 内核仍存活。修正 addon 初始化顺序：共享生产者拒绝 Worker 时直接返回，禁止继续注册针对主线程全局 CPU 内核的清理钩子。

## 首次接入的收口结果

以下全部 GUI 结果来自修正后的同一套产物，材料在 `recovery-final/`。9 个隔离宿主、16 次打开均正常停止和退出，`forced=false / code=0 / signal=null`；最终来源和编译产物摘要见 `final-receipt.json`。

| 检查 | 结果 |
| --- | --- |
| 禁用 GPU 的视频输入矩阵 | `video/`：1080p30／4K24 × H.264／HEVC／AV1，6 项通过；实际 CPU 解码、软件合成、彩色动态截图、音视频原生时钟差小于 500ms、暂停 seek、展开／底栏／全屏、慢消费、停止归零 |
| Main10／字幕 | `subtitles/`：HEVC Main10 SDR、复杂 ASS、PGS 3 项通过；字幕在同一暂停帧开关，实际窗口截图差分超过原门槛，实际查看了 ASS 与 PGS 图像 |
| 图形初始化故障 | `initialization/`：可信测试宿主仅注入 GL 创建失败，自动 CPU 的真实解码／绘制及普通停止通过 |
| 实际 GPU 子进程退出 | `gpu-fault-paused/` 及三个 `gpu-fault-playing*`：暂停及播放意图、位置、参数、字幕或彩色视频恢复，4 项通过 |
| 显式 CPU 与默认路径 | `forced/`、`legacy/` 各 1 项通过；默认仍 GPU，正常运行不自动改用 CPU |
| 原生及桌面生产构建 | 均退出 0；C++ core、slider、ticket 执行程序通过；保留共用核心已有 C4244 与配置宏警告 |
| Electron 定向回归 | 131 pass、0 fail、0 skip；包含真实 CPU addon、拒绝 Worker、接收器、回退、播放面板与原生命周期测试；未宣称重跑 4,325 项全量 |
| 构建／来源合同 | Node 16 pass、0 fail；Windows 源码材料要求包含新 CPU 生产者，加载烟测要求 `software` 导出 |
| 类型／lint／架构／文档 | Node/Web/Browser 类型通过，变更 TS/TSX lint、桌面架构和编码检查通过，网站内容测试 18 pass |

此前仅增加验收观察的测试适配错误及失败日志保持，不覆盖为通过记录。没有修改用户系统显卡／驱动、BIOS、真实资料库或正式安装包。

## UHD 770 与未测边界

CPU 首次接入阶段仅枚举 RTX 4080，用户当时选择“先完成 CPU 回退，核显实测稍后进行”。随后用户启用 UHD 770，已完成 [Intel／NVIDIA 混合配置实测](windows-uhd770-hybrid-2026-10-24.md)：核显 D3D11／Chromium、显式核显硬解、旧路径与真实 Canvas 初始化故障后的 CPU 回退已有证据。用户暂不将显示器接到主板视频口，纯 Intel WGL 显示链路仍待测，不能把当前 NVIDIA OpenGL 的结果算作核显 OpenGL 验收。

物理无 GPU／Microsoft Basic Display Adapter 机器、纯 Intel WGL 显示链路、AMD 实机、远程桌面／虚拟机、设备 removed/hung、长播、完整物理 HDR／色度校准、声音设备矩阵及签名安装包不在本轮通过范围。

## 与 Linux 对齐，取消 1080p 上限

用户要求取消 Windows CPU 路径特有的降分辨率行为。生产端现在按 `round(逻辑尺寸 × 缩放)` 计算物理尺寸，和 Linux 相同；保留 8192 单边、256 MiB 单帧、缩放不超过 8 的边界，超出时拒绝，不按比例缩小。主进程接收端相应允许更大的帧，检查 64 字节 stride 对齐、32768 最大 stride 和单帧大小；preload 已有同样的安全边界，无须放宽。两帧背压、软件 Canvas 和自动回退策略保持。

此轮材料单独保存在 `native-size/`，不覆盖先前的 `final-receipt.json`。原生／桌面生产构建退出 0；新 native SHA256 为 `cc363c3b676e06c790218933b45104ed1974bb1b34f9cdc62a9817796923322f`。原生及传输定向测试 8 pass、0 fail、0 skip：实际生成完整 3840×2160 软件帧，验证 7680×4320 和 8192×8192 的尺寸计算／安全边界、超限拒绝、fractional DPI 取整，以及原先的 padding、alpha、停止和 Worker 保护。8192×8192 只验证尺寸接受，不声称实际 8K 播放性能。

3 个禁用加速／GPU 故障隔离宿主，共 5 次打开，均通过并正常停止和退出：

- `video/`：H.264 1080p30 与 4K24 输入；实际软件输出在窗口态为 2394×1247，全屏为 3842×2162，与 CSS×DPR 计算匹配（允许一像素取整差），Canvas backing 与原生尺寸一致；彩色动态截图、暂停 seek、慢消费和停止通过。全屏尺寸包含本机 fractional DPI／窗口边界的取整，不将其描述为固定 3840×2160 输出。
- `subtitles/`：复杂 ASS 与 PGS 在上述较大显示尺寸下通过实际截图差分、底栏／展开／全屏和停止检查。
- `gpu-fault-playing/`：实际终止自有 GPU 子进程后，CPU 继续播放并恢复位置／参数，较大窗口及全屏 backing、彩色动态画面和停止通过。

Node 类型检查、变更文件 lint、编码和 diff 检查通过，网站内容测试 18 pass。此轮未重跑首次接入的 131 项定向测试或全量 Electron。新来源与产物摘要见 `native-size/receipt.json`；UHD 770 和其他未测范围仍按上节保留。

## 提交前复核与本地测试包

用户随后要求本地打包并完整检视、提交、推送当前改动。逐文件复核时修正恢复中的新外挂字幕可能漏加载的问题：CPU 已开始恢复后，新增字幕直接交给当前内核，不等待已经执行过的恢复队列；后续恢复不得重放已被新选择替代的字幕轨道。12 项 Windows 回退回归通过，包含新增的恢复 seek 期间挂载字幕用例。旧 AI 字幕恢复失败时，也只清除该次恢复保存的时间轴，避免清除更新后的引用。

重新执行 `npm run dist:win:local -- --arch x64`，桌面／Web 生产构建、NSIS 与 ZIP 均退出 0。本地未签名开发包在 `dist/local-uhd770-20261024/`，未上传 Release；原生模块摘要仍为 `cc363c3b676e06c790218933b45104ed1974bb1b34f9cdc62a9817796923322f`。ZIP 和 NSIS 压缩内容完整性通过，分别抽取并核对主程序、`app.asar` 和播放运行库的 10 个文件；包内 95 个编译文件与当前构建摘要一致，未包含验收素材和开发运行库目录。

实际打包后的 `Javdex.exe` 在移除开发 DLL 搜索路径后，完成默认 GPU、显式 CPU、禁用 GPU 后自动 CPU 回退的三个隔离宿主试播；CPU 场景有彩色动态 Canvas 像素检查，三个主进程均普通退出 0。另由同一主程序加载包内数据库依赖，并实际生成完整 3840×2160 CPU 帧。材料见 `out/local-uhd770-package-prepush-20261024/` 的 `verification.json`、`packaged-launch.json` 和 `delivery.json`。这些检查不替代用户随后进行的纯核显异机验收。

网站内容测试 18 项通过，离线构建及站点检查覆盖 28 个页面、2045 个本地引用；编码和 diff 检查通过。

本次提交前重新完成全库规范／架构前置检查、Node／Web／Browser 类型、打包合同（79 项：73 pass、6 平台／工具 skip）、播放夹具（7 项：6 pass、1 平台 skip）、构建／发布计划 63 pass、验收辅助 29 pass、备份 smoke 15 pass。全发现 Electron 测试在用户确认的 UAC 管理员进程内覆盖两批 350／250 个文件，共 4,348 项：4,313 pass、35 平台 skip、0 fail；真实 Windows CPU addon 和本次新增字幕恢复回归均实际执行。

普通权限的 `npm test` 最后在 Electron 第一批报告 28 个环境失败：10 个文件符号链接 `EPERM`、18 个 `openssl ENOENT`，因此该单次命令仍记为退出 1；未改写失败日志或用目录 junction 替代这些文件链接。管理员完整回归使用同一份冻结源码，仅在测试子进程 PATH 加入本机已有 Git OpenSSL 和 Python；退出 0，无安装或系统设置改动。日志为 `out/pre-push-validation-20261024.log`、`out/pre-push-elevated-electron-20261024.log`，权限／退出收据及源码锁分别为同目录 `pre-push-elevated-electron-20261024.json`、`pre-push-elevated-code-lock-20261024.json`。这轮完整复核不扩大前文保留的实机与平台验收边界。
