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
