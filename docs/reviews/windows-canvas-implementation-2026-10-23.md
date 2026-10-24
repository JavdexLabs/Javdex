# Windows Canvas 本地接入

2026-10-23，在 Mac 上为 Windows 增加 `sharedTexture → VideoFrame → Canvas2D` 候选路径。基线为 `332f78e18187835ce49668e2029e2462cd1f3eab`；本轮不提交、推送或发布。Windows 实机准入前不切默认，Mac 正式 Canvas 与 Linux GPU／CPU 的后端选择保持。

## 启用与回滚

Windows 完整原生构建和桌面构建后，从仓库根目录直接运行 `.\node_modules\electron\dist\electron.exe . --javdex-windows-canvas`，或给实际 Javdex 可执行程序追加该参数。不要把参数直接交给 `electron-vite preview` 的选项解析器。应用收到的参数必须在独立的 `--` 前；Mac 不需要且忽略它。普通启动仍选择旧 HWND/WGL。移除参数并完整退出重启是回滚，不在存活会话中切换或遇错静默替换后端。旧 Windows 原生控件、截图、输入、slider 与遮挡接口均保留。

同一个 `playback.node` 保留旧导出，并新增 `sharedTexture` 对象；没有新增动态库下载或额外图形驱动分发。候选启动不添加旧后端的 `disable-direct-composition`。

## 生产与资源所有权

`windowsSharedTexture.cpp` 在 addon owner 线程创建私有隐藏 WGL drawable、硬件 D3D11 device 和 BGRA bridge。实际检查 interop／interop2 扩展、函数入口、设备打开和 FBO，缺失即报错。GL 只锁定并绘制私有 bridge，`glFinish`、成功 unlock 后，D3D11 再 copy 到空闲导出槽。导出纹理为 DEFAULT、BGRA8、单采样、无 mipmap、非 keyed 的 `SHARED | SHARED_NTHANDLE`；首版多一次明确的 GPU copy。

copy 后 `End(EVENT)`、`Flush`，通过 libuv 的 owner 线程唤醒异步查询；只有 `GetData == S_OK && done == TRUE` 才产生 `producerComplete` 帧。pending 时不覆写 bridge，也不阻塞正常主循环等待 query。超时／设备丢失／WGL 交接不明会停止、暂停该内核并隔离完整 session，不用释放 fence 或重建新池假装完成。正常关闭最多等待 50ms 排空未发布 copy；未确认则同样要求进程重启。`glFinish` 自身仍无可取消超时，这是后续设备挂起检查的风险。

`windowsTextureTickets.h` 的三个额度覆盖 producing、exported、quarantined 和旧 generation。序号不因 destroy/create 重置；只有 query 完成才能转 exported，只有精确原序号的最终 release 才归还。旧会话 COM texture 与根 NT handle 继续保活，迟到或重复释放不能命中新帧。三个导出纹理之外另有一张私有 bridge，不把它隐藏在“共三张纹理”的显存说法里。

## 共用传输与 Canvas

`nativeSharedTexture.ts` 抽取现有 Mac 传输实现，Mac wrapper 固定选择 IOSurface，Windows 固定选择 NT handle；拒绝混入另一平台句柄、错误大小、未完成生产或非法票据。页面 IPC 只接收 Electron 的 opaque transfer 与绑定／时序元数据。preload 复用同一 Canvas2D `copy`、VideoFrame close、取消与迟到帧过滤。

释放顺序保持为消费者 `subtle.release` 的 GPU 回调 → main 原 import release → `allReferencesReleased` → 原生精确 ticket release。提交、消息送达、停播、超时和新绑定都不能提前归还。传递结果不明保留原租约；renderer／GPU 退出仍要求重启，不换成 CPU 或旧 HWND 掩盖失败。

固定 [Electron 43.8 handle 合同](https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-handle.md)使用进程本地 NT handle；[固定 C++ 导入实现](https://github.com/electron/electron/blob/v43.8.0/shell/common/api/electron_api_shared_texture.cc)先 DuplicateHandle，再以 DXGI GpuMemoryBuffer 导入，生产者保留自己的根 handle。Windows／WGL 的上游约束与待验证组合见 [API 调查](windows-canvas-api-2026-10-23.md)。

## 修改文件

- 原生生产与额度：`native/windowsSharedTexture.cpp`、`windowsTextureTickets.h`、`windowsTextureTickets.test.cpp`；旧 `windowsPlayback.cpp` 仅注册新导出，`CMakeLists.txt` 同时构建两条路径。
- 应用接入：`nativeSharedTexture.ts`、`macSharedTexture.ts`、`libmpvPlayback.ts`、`playbackDisplay.ts`、preload `sharedTextureReceiver.ts`，及相应 wrapper／transport／preload／display／portable C++ 测试。
- 构建闭包：`playback-native-build.mjs`、`check-playback-load.mjs`、`aggregate-playback-sources.mjs` 与计划／聚合回归；已有完整原生目录归档自动收录新增源码。
- 后续设备入口与观察：`windows-canvas-acceptance.mjs`、`windows-canvas-checks.mjs`、共用 `playback-acceptance-support.mjs` 及辅助测试；Windows Canvas 读取新 producer 的生产计数和 Chromium 窗口，默认旧后端仍读原生呈现计数与截图。提交计数验证 sender/main frame、当前 surface 与递增 sequence；截图检查合成 testsrc2 的不透明彩色区域及推进后的不同像素摘要，不以尺寸或旧会话计数代替画面。媒体辅助在失败时额外保存应用状态，保留原异常。
- 文档：本记录、API 调查、开发指南与评审索引。

## 实际检查

Apple M4、macOS 26.5 arm64、Electron 43.8.0／Node 24.22.0。检查日志与失败记录保存在 `/tmp/javdex-windows-canvas.voFTyo`，GUI 材料在 `out/playback-acceptance/windows-canvas-voFTyo`。

| 检查层级 | 实际结果 |
| --- | --- |
| 传输／wrapper／preload／启动选择／便携 C++ | 62 项 pass、0 fail、0 skip；含真实 clang 编译并执行 ticket 状态机，不是 Windows 图形编译 |
| Mac 原生与 Linux bridge／传输回归 | 61 项中 40 pass、0 fail、21 宿主 skip；三个 Mac CGL／IOSurface 原生用例实际运行，Linux 设备与平台跳过不计通过 |
| 原生构建计划与源码聚合 | 38 项 pass、0 fail、0 skip |
| 验收辅助的计数和 Canvas／旧 Windows 截图选择 | 审查修正后 24 项 pass、0 fail、0 skip；Windows 分支为隔离接口测试 |
| TS／browser 类型、全量 TS lint 与最终定向 lint | 退出 0 |
| 修正后完整 `npm test` | 最终代码冻结后退出 0；Node 各组含前置架构检查共 186 项／183 pass／3 宿主 skip，Electron 4316 项／4276 pass／40 宿主 skip，均 0 fail；不是只运行定向测试 |
| 桌面生产构建与运行时资产／renderer 闭包检查 | 退出 0 |
| Mac GUI 媒体复测 | 14 组检查完成，脚本退出 0，报告 `partial-pass` 保留听感／物理设备等边界；AAC／AC3／EAC3／DTS、HEVC Main10 SDR、无音轨、倍速、画幅／缩放／全屏、复杂 ASS 与 PGS |
| Mac 快速停止重开与正常关闭 | 分别 8 轮及 2 个关闭检查；正常退出 code 0、无信号、未强制结束 |

首轮媒体检查在 fixture 4 曾报 producer 已停止，保留在 `mac-media/media-matrix/report.json`，不记成功。缩小为交替打开／停止／重开 8 轮未复现；原链路在补充失败状态采集后完成 14 组，没有更改播放逻辑或放宽断言。首轮原因未确定，仍是间歇性风险，不用复测成功覆盖它。Chromium mailbox 警告在此前基线成功材料中也出现过，不能单凭该警告归因或宣称修复。

Mac 原生源码与共享 `mpvCore.h` 未改，本轮未重编 Mac addon；三个真实合同使用既有正常构建，SHA-256 为 `728de6ee56494982ecf191bfcf38b0af7bd191a18c7673e481723b103bb6af57`。新生产构建与 GUI 执行当前 TS／preload 路径，不把旧二进制当作新 Windows 编译证据。审查修正前的 28 文件候选完整 `npm test` 退出 0：Node 各组含前置架构测试共 183 项／180 pass／3 宿主 skip，Electron 4316 项／4276 pass／40 宿主 skip，均 0 fail。该记录保留为 `npm-test-initial-full.log` 和对应源摘要，不替代修正后的最终源码结果。未启用远程设备或执行独立软件产物验收。

## Standards

固定 `332f78e1`，审查覆盖全部未提交 tracked diff 与新增文件，并在修正后复审增量。标准轴没有确认的文档规范违规。两项启发式建议分别为 renderbuffer 误称 buffer，以及待处理 copy 的 sequence／slot／timeline／开始和目标时间分散在 Session 字段中。

renderbuffer 函数指针已准确更名，复审确认只是名称改变，没有改驱动调用或资源顺序。`PendingCopy` 归组保留为非阻断建议；本轮不为它重构尚未实机验证的 Windows 生命周期。标准轴最终为 0 明确违规、1 未实施的启发式建议。

## Spec

需求轴发现的三个 P2 已最小修正并复审：文档改为直接启动 Electron 可执行文件；提交计数从跨会话累计改为可信 main frame、当前 surface 的新 sequence；截图从只查尺寸改为实际合成彩色像素与后续变化。新增三个行为回归分别覆盖旧会话／伪造／重复提交、黑白空白／透明／截断像素、画面冻结。实际 Mac 合成视频截图也通过新的可见彩色像素检查，但不据此记 Windows 通过。

需求轴复审未发现未解决的可操作缺陷或扩大范围。Windows 原生／设备验证属于明确后置边界；首轮 Mac 间歇故障原因未定，不计已修复。同步、三导出槽、旧后端默认和 Mac/Linux 选择均未因审查修正改变。

## 首帧故障成对调查

在 `/tmp/javdex-windows-canvas.voFTyo/baseline` 创建 detached 干净 `332f78e1`，独立构建 baseline 的主进程与 renderer；依赖及未改的 Mac addon 通过只读使用相同已安装输入保持一致。基线构建不含 Windows Canvas 参数或传输通道，当前构建包含，核对实际 bundle 而非仅比较目录名。对比在完整测试退出后逐个启动，避免与 CGL 原生测试同时运行。两个版本均使用相同的临时观测包装，记录 create/destroy/nextFrame 调用、原生异常、最后 16 帧元数据、消费失败和 GPU 退出，不改变产品源码、原生函数或释放条件。

| 场景 | 基线 | 当前候选 |
| --- | --- | --- |
| 六档倍速后立即停止并打开 anamorphic | 6 次打开、6 次停止、3 次引用归零检查完成 | 同样完成 |
| renderer 阻塞 1 秒后停止并重开 | 6 次打开、6 次停止、3 次引用归零检查完成 | 同样完成 |
| 暂停期间 resize 与前后 seek 后停止重开 | 6 次打开、6 次停止、3 次引用归零检查完成 | 同样完成 |

六个宿主均 exit 0、无 signal、未强制结束。每个版本共 18 次打开／停止和 9 次归零检查，所有 trace 均为 0 原生异常、0 消费失败、0 GPU 退出；本轮也没有 mailbox 警告。逐场景材料在 `diagnostic-pairs/`，汇总为临时目录下的 `paired-summary.json`；原先失败与后续媒体复测材料未覆盖。

预先限定的三组成对场景没有复现首帧停止，不能据此选择“旧竞态”“抽取回归”或“观察辅助错误”中的任一原因为定论。首次材料只保留停止后的 alive=false 和 Chromium 警告，缺少触发停止时的精确 fault，无法追溯证明驱动或引用释放原因。故障仍作为剩余风险，至此停止追加重跑；未来若再次发生，保留当次停止前 native/consumer trace 后再定位，不放宽验收门槛或合成释放。

最终 `npm-test-final-full.log` 对应冻结的 25 个代码／构建／测试文件，摘要在 `final-code-lock.json`，退出后再次核对一致；之后仅追加本审计。修正前后完整日志、最终源码与日志摘要、审查处置和成对结果汇总见临时目录的 `final-verification-receipt.json`。最终为 29 个未提交文件（含 4 份文档），暂存区为空，HEAD 仍为本记录基线；没有提交、推送、合并、标签、发布或 Windows 远程操作。隔离基线和诊断材料保留，原工作区及用户资料未撤回或清理。

## 后续 Windows 准入

本机只有 Apple clang，交叉语法检查直接报 `windows.h` 缺失；未完成 Windows 交叉编译、MSVC／MinGW 原生编译或设备播放。便携 C++ 测试、TS mock 和 Mac CGL 结果均不能替代这些层级。

D3D11 暂选系统默认硬件 adapter，WGL 打开失败即停止，并记录 producer LUID；尚未把 Chromium 的 adapter LUID 与其可靠绑定。混合显卡／跨屏／远程桌面必须后测，不能由成功创建 device 推断可导入。另需验证非 keyed NT 的创建／第二设备打开／真实 Electron 导入、方向与红蓝顺序、SDR／HDR 映射、PGS／ASS、慢消费／三槽、关闭与迟到释放、GPU/renderer 崩溃和设备 removed/hung、长播显存与 handle 上界、实际性能及签名安装包。完成这些前保留显式开关和旧后端，不宣称零复制、物理上屏或完整 Windows 验收。

## Windows 实机复核，2026-10-24

以下补充前文的 Windows 后置检查，不改写此前 Mac 结果。Windows checkout 为 `dev`，HEAD `ccd131b073639e96f1c35fad425c5ab93d766858`；原备份分支 `codex/preserve-qwen-asr-20261023` 未改，没有提交、推送或发布。主要材料位于仓库 `out/playback-acceptance/windows-canvas-validation-20261023-232754/`，旧环境与二进制另存于 `windows-canvas-recheck-20261023-224431/`。源码摘要为 `final-code-lock.json`；冻结的 10 个代码／测试文件和 103 个编译产物在最后一次检查时全部一致，本文是冻结之后追加的记录。

宿主为 Windows 11 x64、i5-12600K、RTX 4080、驱动 `32.0.16.1742`，单个 M27P20 显示器 3840×2160／144Hz、175% 缩放。实际 Electron `43.8.0`（Node `24.22.0`、ABI 148）、CLI Node `22.22.1`、Python `3.12.10`、VS Build Tools 2022 `17.14.42`、MSVC `19.44.35229`、Windows SDK `10.0.26100`。Canvas 和 Chromium GPU 均观察到同一 RTX 4080；该结果不能推广到混合显卡或跨适配器。

### 本轮修正

- `windowsSharedTexture.cpp` 在 `windows.h` 前定义 `WIN32_LEAN_AND_MEAN`，解决 Winsock 1 与 `uv.h` 间接引入 Winsock 2 的头文件冲突，完整原生与桌面生产构建均退出 0。保留旧 HWND/WGL 默认路径和显式 Canvas 开关。
- Windows import 在 `finishTransfer()` 后取得并验证 frame creation sync token，再建立 VideoFrame。没有更改消费者 GPU 回调、原 import 和原生 ticket 的最终释放链。
- 首三次时钟采样均偏慢时，等待帧可按每 mount 至少 50ms 的间隔重试，仍执行 20ms 不确定性上界和 1s 截止；旧实现的可控失败与修正后的真实宿主复测均保留。
- 直接替换仍存活的 Canvas 绑定时，统一取消等待任务、清理并将旧 backing 的宽高置零；旧 cleanup 无权清除新绑定，也不提前 ACK。实际宿主交替播放／暂停替换 6 次均重新呈现真实像素，最终正常退出 0。
- 修正远程媒体本机 SRT 全屏辅助的未定义 `prefix`；先红后绿的行为回归保留。ASS 抗锯齿颜色检查、受控 PGS 白色 alpha 覆盖率和 Canvas 全屏遮罩处理保留几何、透明孔、裁剪、四象限、cue 时间断言。全屏截图时隐藏控件，不声称可见工具栏绝不遮挡字幕。
- Windows 测试路径预期改用宿主 `path.join()`。运行时清单拒绝遍历测试使用真实目录 junction 并断言其符号链接属性；其余需要真实文件链接的用例没有被替换，已在管理员进程复验。

### 构建与自动测试

| 检查 | 最终结果与材料 |
| --- | --- |
| 原生完整构建及三个 C++ 执行程序 | 退出 0；`native-final-build.log`，仍有既有 C4244 警告 |
| 最终 receiver 修正后的桌面生产构建及运行时资源校验 | 退出 0；`desktop-rebind-build.log` |
| 架构／workspace／边界、全量 TS/CSS lint、CSS/UI 控件前置检查 | 首轮完整 `npm test` 的 pretest 退出 0；之后变更的三个 TS 文件再做定向 lint，退出 0 |
| 最终 Node/Web/Browser 类型及编码 | 退出 0；`typecheck-final-background.log`、`lint-final-background.log`、`encoding-final-background.log` |
| 打包运行时 | 79 项，73 pass、6 skip、0 fail；`npm-test-completion.log` |
| Windows PE relocation 补测 | 设置已安装 VS 开发环境后真实编译、移动并由 Electron 加载，1 pass、0 skip；`pe-relocation-msvc-final.log`，覆盖上行的 MSVC PATH 环境跳过项 |
| 播放 fixture | 7 项，6 pass、1 POSIX 编译 skip、0 fail；`npm-test-completion.log` |
| 构建／发布计划、验收辅助、备份 smoke | 分别 63、29、15 pass，均 0 fail／skip；构建／备份见 `checks-after-rebind.log`，最终辅助见 `srt-noise-guard-after.log` |
| 最终 Electron 全发现测试 | 两批 350／247 个文件，共 4,325 项，4,290 pass、35 平台 skip、0 fail；管理员脚本退出 0，`elevated-electron-tests.log` 和 `elevated-electron-receipt.json` |
| 独立只读复核 | 两名审查者核对最终源码；生命周期审查另核对全部 103 个编译产物。未发现新增阻断；`independent-review-final.json` |

完整 `npm test` 首次命令失败的日志仍保留，不将其改记为退出 0。之后按失败点恢复并完成所有测试组，最后对变更文件重做类型／lint／编码检查。早期失败包括 Microsoft Store 的 `python3` 别名、未进入 PATH 的已有 OpenSSL、Windows 路径预期，以及 9 项文件链接权限；分别通过使用实际 Python 3.12、已有 Git OpenSSL、宿主路径和经用户 UAC 确认的管理员测试进程解决。没有修改开发者模式、系统安全设置或用 junction 代替后九项。

### SDR、字幕与生命周期

| 层级 | 实际结果 |
| --- | --- |
| Canvas 输入矩阵 | 1080p／4K × 24／30／60 × H.264／HEVC／AV1 的 18 项均实际 nvdec、动态彩色像素、暂停 seek／继续、交替换片和 stop 归零通过。`canvas-resolution-report.json` 总体仍为失败，原因是随后 HDR 白色阈值失败；不将全文件改记通过 |
| 旧后端对照 | 相同 18 个输入另加两个颜色样本完成，默认 legacy 单独标记；`legacy-resolution-report.json`，正常退出 0 |
| 软件解码 | H.264 1080p24 与 4K24 实际 `hwdec=no`，像素推进、stop 归零、退出 0；`canvas-software-resolution-report.json` |
| 媒体检查 | 14 组完成，报告仍为 `partial-pass`，保留听感和物理设备边界；AAC／AC3／EAC3／DTS、章节、HEVC Main10 SDR、无音轨、六档倍速、三种画幅、resize／docked／fullscreen、ASS 与 PGS；`media-matrix/report.json` |
| 最终字幕补测 | receiver 最后修正后，复杂 ASS 和 PGS 两组再通过；含向量裁剪、karaoke、透明孔、alpha 面积、自然 cue 开关、delay、seek 和全屏；`subtitle-completion-report.json` |
| 最终有界资源压力 | 3 个隔离宿主，共 36 次打开、30 次正常停止；普通播放、活动换片、暂停 seek/resize、750ms 慢消费、stop 期间 renderer 阻塞各两轮／宿主。所有停止均 native 不存活、尺寸 0、outstanding 0，峰值不超过 3，stop 返回后最长归零等待 18ms，三个进程正常退出 0；`final-stress-{alpha,beta,gamma}-report.json` |
| 直接 rebind | 实际公用 bind API 的 6 次替换通过旧 backing 清零、旧 cleanup 隔离、新像素和最终引用归零；`direct-rebind-real-report.json` |
| renderer／GPU 故障 | 在刻意扣留 3 个未知 transfer 后分别实际触发故障；生产停止、尺寸清零、3 个未知租约保留、要求重启，无自动 legacy 回退。最终主进程退出 0；`renderer-fault-report.json`、`gpu-fault-report.json`，不把故障子进程退出记作正常播放 |
| 后台远程／缩放补测 | 隐藏窗口中同源 Node 业务、HTTPS 配对后正常重启，两个媒体授权／两个 HTTP 206 Range 响应；远程无音轨媒体上 SRT 和 ASS 的实际 GPU capture 字幕像素通过，保持同一暂停会话；80%／100%／125% web zoom 的 CSS×DPR／原生尺寸匹配及合成彩色像素通过。两次 stop 引用归零、进程正常退出 0；`background-remote-report.json` |

上述 4K 指输入尺寸。窗口态 Canvas 输出约 2395×1248，旧后端约 2394×1247，差一像素来自 fractional DPI 的取整策略；没有将这 18 项描述为 4K 全屏输出验收。所有压力检查没有截图、强制 GC、逐帧日志或租约改写。此前正常停止曾残留一个 exported lease，分别记录为 seq178／seq117，旧报告保留；最终有限压力未复现，不能由此证明历史原因已唯一定位或排除长播、设备挂起问题。

`Database not initialised` 的退出提示另以仅有一条合成视频、无导入任务的隔离资料库复核：`app.quit` 先处置数据库，renderer 销毁后的异步 playlist snapshot 再访问已关闭数据库并记录警告；普通 window close 无此警告。前后 SQLite integrity 均为 `ok`、视频数不变、两个主进程均正常退出 0。此警告对本轮无活动导入的 Canvas 场景非阻断，证据为 `app-quit-database-report.json` 和 `window-close-database-report.json`；活动导入退出不在该结论内，未扩展修改产品退出流程。

### 后台阶段未完成和隔离边界

以下保留用户使用电脑期间的状态；选择器、性能及 HDR 排查由下一节的补验结果更新。

HDR→SDR 仍待定。SDR 红绿蓝方向与 BGRA 正确；PQ 标签样本仅有色相及中性灰 smoke 通过。相同白色区域 Canvas 约 `[150,150,150]`，默认 legacy 约 `[163,163,163]`，统一运行时 sRGB 的控制组也未消除全部差异。此样本是 100nit SDR 图案转 PQ、无 mastering／CLL metadata，不是完整 HDR 基准；没有降低原白色门槛或修改产品色彩策略来宣布通过。

真实 Windows 文件选择器曾在用户中止桌面操作后超时，`interrupted-remote-picker-report.json`／日志保留，不计通过。用户继续使用电脑并要求禁用 Computer Use 后，只执行 CLI、后台测试和隐藏测试窗口；不再执行系统选择器或可见窗口切换。文件选择器和三组成对的 legacy／Canvas 可见播放、暂停、隐藏性能采样仍待桌面空闲，不能据现有资源峰值推断性能收益。

同源 Node 远程业务宿主已另构建，在 Node 22（进程 ABI 127）下实际加载的是独立依赖目录中 better-sqlite3 13.0.3 附带的 `prebuilds/win32-x64.node`，不是一次新产出的 ABI 127 addon。此前 node-gyp 退出 0 只代表配置发现 prebuild 后的空构建，不作为重新编译成功的证据。根目录 Electron（进程 ABI 148）依赖未因此替换。Windows 网关测试宿主只在隔离夹具中省略不支持的 POSIX 目录 fsync，保留文件 fsync／原子 rename；这不是 Linux 管理器持久化、容器或独立服务安装验收。真实选择器、额外 GPU／驱动／显示器、OS DPI 改动、远程桌面、设备 removed/hung、长播、物理听感、HDR 和签名安装包仍不在通过结论内。默认后端保持 legacy。

后台补测通过仅限 GPU 导入和 capture，不是物理可见画面验收。测试入口使用相同冻结的主进程／preload／renderer／addon 产物，测试宿主在窗口构造时屏蔽 show／focus／fullscreen，并禁用其后台节流；没有运行 Computer Use、显示窗口或改系统设置。字幕路径由可信原生测试宿主直接 `sub-add` 合成夹具，未经过产品选择器与外挂字幕授权流程，不能填补真实选择器的待测项。80%／100%／125% 仅为该隔离窗口的 web zoom，不等于不同 OS DPI／显示器组合。测试宿主与业务二进制摘要另见 `final-verification-receipt.json`。

## 电脑空闲后的补验结果

用户允许继续可见窗口验收，并另行允许两次选择器使用 Computer Use。最终完成真实外挂字幕选择、三组成对性能采样及 HDR 受控排查；没有修改产品默认后端或色彩策略。此阶段只改动两个 Node 验收脚本／测试，其他锁定源码和 103 个编译产物均保持。管理员 Electron 全量结果绑定此前的 `elevated-test-code-lock.json`；最后新增的辅助判据已单独复验，不宣称再次运行了全量 Electron。

### 真实选择器及黑屏疑问

`remote-picker-report.json` 为通过：SRT 在真正的 Windows 文件选择器中由 Computer Use 选择，ASS 的第二个选择器因工具缓存失效，按恢复规则重试后交由用户手选。没有替换 `showOpenDialog`、通过 renderer 注入路径或上传字幕。保持同一远程暂停会话，SRT 字号调整、展开／底栏／全屏，以及 ASS 向量裁剪、karaoke、字幕布局均完成；一个原媒体授权与真实 Range 请求、配对后正常重启、两个宿主正常退出、stop 后尺寸／引用归零均有记录。

首轮在 238×160 的底栏图像上失败：字幕能看见，但大于 180 的亮白核心仅 3 个，低于原门槛 8。保留 `real-picker-first-docked-failure.json` 和 on/off 截图。最终使用同一暂停帧的开关差分白色覆盖面积，仍要求每个计入的中性像素亮度差 **大于 50**，展开／全屏面积大于 150、底栏大于 8。独立复核曾指出不带差分门槛的积分会把整帧 17→18 的微小漂移误当字幕，该中间版本未收口；恢复门槛后，原真实截图重新计算为 7674.6／117.4／23332.3，三种呈现均通过。`remote-picker-final-pixel-audit.json` 明确是既有真实截图重算，不是再次操作选择器。

实际 helper 的 VM 行为回归保留无亮白核心的 136 灰度抗锯齿字正例，新增无字幕背景不变、整帧微小漂移两个拒绝负例，先红后绿；最终 29 pass。PGS 继续使用原先全部 alpha 覆盖积分和独立几何守卫，未新增 SRT 的对比度截断。

用户看到的近黑画面来自 `color=c=0x202020` 静态灰底合成片，用来隔离字幕像素。随后另用动态彩色无音轨片加载相同 SRT，实际彩色像素保持、继续播放后摘要变化、native render 增加、媒体只加载一次，stop 归零并退出 0；见 `dynamic-srt-report.json`。此补测通过可信原生测试宿主挂载合成字幕，真实系统选择流程已由前项单独覆盖，不将它再记作一次 picker 操作。

### 可见窗口性能

六个隔离宿主按 legacy-alpha／canvas-alpha／canvas-beta／legacy-beta／legacy-gamma／canvas-gamma 串行执行，均正常退出 0；每种状态预热 3s，固定 CPU 采样窗口约 12s，期间无截图、构建、逐帧 trace 或其他验收宿主。输入同一份 1080p60 H.264、实际 nvdec、1×，窗口尺寸一致，Canvas 在采样外调用真实 `setBounds`，将原生输出与 legacy 对齐为 2242×1170。主窗口 hide 会按现有产品逻辑自动暂停，因此第三种状态是隐藏后暂停，不是后台继续解码。

| 状态 | 旧路径 CPU 中位数（范围） | Canvas CPU 中位数（范围） |
| --- | --- | --- |
| 可见播放 | 29.1%（28.6–30.8） | 64.2%（53.9–65.0） |
| 可见暂停 | 6.6%（6.5–9.4） | 5.5%（4.8–6.1） |
| 隐藏后自动暂停 | 9.6%（5.5–9.7） | 10.3%（4.2–21.7） |

CPU 为 Electron Browser／GPU／Tab／Utility 累计 CPU 时间之和，**100% 等于一个逻辑核**，不是任务管理器全机归一化百分比。播放中位数之比约 2.20；本轮没有 Canvas 性能收益，隐藏样本波动也完整保留。六个播放窗口的 frame-drop 计数差均为 0，原生 render 次数包含 redraw，不能称作独立视频帧率或物理上屏率。材料为各 `*-performance.json`、`*-samples.json` 和 `performance-summary.json`。初始 sampler 选用受本机策略限制的 Windows PowerShell、隐藏状态断言及错误的临时 resize 方法名失败均保留；正式样本使用已有 PowerShell 7 和真实产品隐藏行为，没有调整系统执行策略。

进程级 `GPUProcessMemory.DedicatedUsage` 在 Canvas 下显著增长，不能直接解释为驻留显存。额外无 GC／租约改写的有界对照中，Canvas 该计数从 1537MiB 增至 18058MiB，超过显卡 16376MiB 的物理容量；同一时间适配器统计约 2191–2211MiB，`nvidia-smi` 约 2184–2203MiB，GPU handle 为 725–727。暂停后引用为 0，stop 后 NVIDIA 全卡统计下降到 1625MiB、适配器约 1632MiB，进程计数却仍约 17618MiB。`residency-summary.json` 保留所有读数。这证明该进程计数在这里不能作为物理驻留量比较，不确定其归属／记账的具体原因；本窗口没有观察到物理驻留线性增长，仍不替代长播验收。全卡读数包含其它桌面程序，不能由这两次 trace 宣称 Canvas 更省显存。

### HDR 差异的进一步定位

原始无 mastering／CLL 的 PQ 四色片在默认路径仍不同：白色区域 legacy 约 163、Canvas 约 150。统一 BT.709／sRGB／full 后，单独固定 `target-peak=203` 或单独指定 `tone-mapping=bt.2390` 均仍不同；单独设置 `hdr-compute-peak=no` 则两条路径全部采样通道的均值最大差仅 0.13。这将现象缩小到自动峰值检测路径，未唯一归因于驱动、算法、FBO 或刷新历史。固定版本 [mpv 自动峰值选项](https://github.com/mpv-player/mpv/blob/v0.41.0/DOCS/man/options.rst)说明它会用帧间统计代替元数据；[固定 shader 实现](https://github.com/mpv-player/mpv/blob/v0.41.0/video/out/gpu/video_shaders.c)也区分这两种输入。材料为 `*-hdr-policy-report.json`、`*-hdr-factors-report.json` 和 `hdr-summary.json`。

另生成 PQ 中性灰阶，名义 0／100／203／1000nit，实际解码 10bit limited 码值 64／509／573／723，经独立 PQ EOTF 计算目标 sRGB203 的 clip 输出为 0／186／255／255。最终 v2 样本具有 BT.2020／PQ 标签、mastering metadata，MaxCLL／MaxFALL 按实际编码亮度分别取 1005／327；早期 MaxFALL 203 的样本保留为初始材料，不作为最终灰阶参考。固定色彩目标、关闭自动峰值并使用 clip 后，legacy／Canvas 的最大参考误差分别 0.17／0 个字节码值，均通过预设 4 的门槛；正常 stop、引用及退出检查均通过。见 `*-hdr-neutral-v2-report.json` 与 `hdr-policy/neutral-reference.json`。

由此确认本组固定映射的 PQ→SDR 传输一致性；没有为了匹配截图而更改产品默认色调映射、降低原 HDR 白色断言或宣布完整 HDR 验收通过。默认自动峰值差异仍保留，物理 HDR 输出、色度计校准、不同显示器和长播未测。综合本轮播放 CPU 上升与剩余边界，继续保留显式 Canvas 开关和 legacy 默认。
