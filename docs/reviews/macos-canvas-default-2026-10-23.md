# macOS Canvas2D 播放正式化

2026-10-23，维护者明确选择 IOSurface → Electron 共享纹理 → Canvas2D 作为 macOS 正常播放路径。选择目的是统一画面合成、HTML 控件与焦点交互，不是宣称播放态 CPU 优于旧原生视图。正式化阶段只修改本地代码和验证；随后维护者另行授权的检视、提交与推送见末节。

## 实现与清理

普通 macOS 原生构建与正式源码构建均生成 `playback.node`，应用正常入口始终创建 `createMacSharedTextureBridge`，无需后端试验参数。源码聚合清单要求实际 IOSurface 源文件，加载烟测检查共享生产所需导出；Release 配置增加源构建 addon 的真实线程与租约合同检查。打包矩阵、签名、许可和来源闭包门禁保留，开发 Homebrew addon 不能替代正式运行库。

移除旧 NSOpenGLView 显示、原生全屏控件、其专用键位实现与编译目标，以及旧原型 UI／命令。远程 Range／授权 fixture 和测试移到 `player/testFixtures` 保留。未采用的 WebGL/video/WebGPU 消费、阶段剥离、垂直探针与旧新后端比较入口退出活动树；真实正常播放、色彩、帧率、生命周期、慢消费和异常退出回归保留。退出清理测试迁到正式 runner 使用的 `closeAcceptanceAndSave`，仍验证非零退出、信号、强制结束及原始错误不被覆盖。

Windows 的 WGL／child、原生输入与遮挡接口不迁移；Linux GPU 与 CPU 兼容 helper、其自动恢复合同不变。共用 `mpvCore.h`、字幕、Windows slider/输入合同及使用这些能力的类型不因旧 macOS 删除而移除。上游 libmpv 的 Cocoa／VideoToolbox-GL 构建能力也不等同已删除的 Javdex NSOpenGLView 显示代码。

## 保留的安全与性能限制

生产端仍以 `glFinish` 确认完成，三个 IOSurface 槽按独立 sequence 租约保护；main 逐帧导入，不缓存覆写仍存活的 import。沙箱 preload 的 Canvas2D `copy` 绘制、解绑 backing-store 清理、取消与迟到帧过滤不变。consumer GPU release 回调、main 原 import 释放、`allReferencesReleased` 共同决定归还；submit/draw/消息回执和超时都不能代替完成。

长度为一的非阻塞线程安全队列合并 mpv 唤醒，回调不运行 JS/GL，主线程初始化保护及结束 mpv 线程后再终止 dispatcher 的顺序保留。250ms 故障兜底与 200ms 状态观察仍在，不恢复无用的 16ms 视频轮询。

renderer/GPU 故障或交付不明会停止生产、隔离最多三份未确认引用到应用退出，不静默复用或切 CPU；正式采用不是完整自动恢复保证。CGL/OpenGL 仍是生产者，不是 Metal／端到端零拷贝。输出为 BGRA8、opaque、BT.709 primaries／sRGB transfer／RGB full；HDR 由 libmpv 映射到 SDR，不提供 HDR 直通、广色域或物理色度保证。

既有正常应用三对短时对照为：1080p 旧原生 18.996%、Canvas 36.872%；4K 20.437%／39.458%。这是所有相关进程累计 CPU 时间按一核满载为 100% 的标度，不是整机归一化占用；Canvas 确有额外成本。WebGPU 六对仅带来约 0.90／0.50 个百分点、不稳定的整体差异且工作集更大，未采用。本轮不重做或改写这些历史性能数字，详见 [旧新对照](macos-shared-texture-2026-10-23.md)和 [WebGPU 结果](macos-webgpu-probe-2026-10-23.md)。

## 本轮实际验证

Apple M4／macOS 26.5 arm64／Electron 43.8.0。正常构建不带实验环境变量，正常 GUI 入口不带后端试验参数，使用隔离资料库和既有合成媒体。

- 普通原生构建和生产构建成功；首轮构建／源码聚合定向回归 37 pass／0 skip，应用／真实 native 定向回归 56 pass／0 skip。此后没有再修改产品源码，验收辅助和测试夹具修正不使这些构建及 GUI 结果失效。
- 24／30／60fps 实际 native／Canvas 速率约为 24.06／23.94、29.98／29.98、59.94／60.06；VideoToolbox、AAC/AC3/EAC3/DTS 选轨、ASS 开关、暂停／连续 seek、全屏/Escape、DOM 焦点、Retina／125% 缩放及隐藏恢复通过。四次停止归零为 18、17、18、89ms。
- 五轮实际阻塞 renderer 消费 1.5 秒时，main 观察到持有三槽；恢复后立即停止并重开，归零为 16、21、17、20、17ms，没有强制复用。真实 renderer crash 后 native 已停止，三份未确认引用在追加观察中保持隔离，直到正常退出清理。
- limited/full SDR、HDR10、HLG 四种真实窗口色块通过中性、单调、opaque 和预定 SDR 映射断言；每次正常停止等待零租约。它们不是 HDR 直通或物理显示校色验收。
- 首轮 GUI 命令把实际 24fps 的多音轨文件误传为 30fps，被速率断言拒绝；原失败记录保留，修正参数后完整四夹具重验通过，没有放宽门槛。
- 业务 GUI 补充通过真实进度条键盘精确定位／暂停保持、设备音量、SRT 窗口像素、设置草稿保存、本机续播选择、格式错误与同资源重试、详情触发焦点、观看返回栈及停止后重开。页面重载触发受控重启提示，native 停止；最终复测引用正常归零，不把重载记作自动恢复，也不要求强行回收。公共截图辅助改用 Chromium Canvas 裁切，保留 Windows 原生截图，并经同一业务 GUI 复测。
- 旧脚本的“快捷字幕”和“指定时间”入口均已由此前产品提交移除。验收现使用真实设置页签和进度控件，没有恢复已删除 UI；两次超时及新增重载断言误用字段名的失败报告均保留。最终业务报告为正常退出、25 项检查及零页面异常。
- 首轮完整 `npm test` 的 Electron 组为 4306 项／4265 pass／1 fail／40 skip；唯一失败是既有远程进程隔离夹具在父进程 `lsof` 采样前已自然退出。新增 250ms 生命周期断言先稳定复现 `exitCode=0`，再以测试专用保活句柄修正；六项隔离测试及该文件 lint 通过。它不修改远程模式、资料库权限或播放产品逻辑，原失败日志保留。

修正测试夹具后，完整 `npm test` 实际退出 0：Node 脚本组共 173 项／170 pass／3 宿主 skip；Electron 组 4306 项／4266 pass／0 fail／40 宿主 skip。包含新增正式源码构建合同、Mac／Windows 截图辅助合同，以及三个真实 macOS 原生线程／租约／唤醒用例。未降低门禁或用跳过代替失败。

脚本 lint、Release YAML 解析、旧入口定向扫描和 `git diff --check` 通过。文档站 18 项测试通过，离线构建检查 28 页、2045 个本地引用、Pagefind 与站点地图；没有部署网站或新发软件。

macOS x64 的命令／源码配置由测试覆盖，但本机没有运行 x64 二进制；新的正式签名／公证安装包、干净机器、多显示器／跨 GPU、物理扫描输出、长期能耗／内存、完整读屏及主观听感／唇音同步均未验收。Linux／Windows 的配置和共享接口检查不等于本轮在其原生宿主实测。

## 可恢复归档

`out/playback-acceptance/macos-default-20261023-SLejxw/pre-change/manifest.json` 记录 41 份清理前源码／文档及 SHA-256，其中包括全部 26 份既有未提交文件。唯一的未跟踪候选脚本有完整副本；先复制并校验，再移除活动文件，没有永久销毁它们或清空系统 Trash。Git 跟踪的旧实现还可从 diff／历史恢复。

共退出 22 个旧路径：其中三份远程 fixture 迁移后保留，19 份旧后端／原型／候选实验文件移出活动树。完整路径与 82 份本轮 GUI 报告／截图的摘要在同目录 `gui-archive-manifest.json`。业务补充的旧入口失败、断言修正与通过报告分别保存在 `business-*` 和 `business/`，不抹去先前失败。

该阶段收尾的 `verification.json` 与 `final-manifest.json` 绑定真实结果、日志、当时源码副本、完整工作区 patch 和 SHA-256；远程隔离夹具改前副本另存 `pre-fix/`。当时 Git 为 `dev@a994e5169d00d6016731486ee681997cc65695dd`、领先远程两个提交，暂存区为空，既有未提交修改保留。该阶段没有提交、推送、删除 Git 分支、合并或发布。

此前 `macos-active-20261023-EG8QOP` 和 `macos-webgpu-20261023-jwI7km` 输出证据目录保持不变，包含真实截图、失败探针、profile 和哈希。历史研究只加当前决策指引，不改写当时的测量与故障。用户媒体、配置、旧输出及项目外文件未清理。

## 提交前复核

同日，维护者另行授权检视并提交、正常推送 `dev`，不授权合并、打标签、Release 或强推。fresh fetch 后的固定检视基线为 `origin/dev@57bd88bd`，范围包含未推送的 `23c761bc`（Linux 正式流水线／调度）与 `a994e516`（Mac 共享纹理接入），以及当前正式化工作区；既有提交不重写。

规范轴发现一项验收计数问题及一项低优先级的时序代码去重建议；需求轴发现三项问题，其中计数问题与规范轴重叠。三个实际问题均先用定向测试复现，再作最小修正：

- Linux 销毁发送 flush 时，已失效的 renderer frame 可能抛出异常，阻断 FD／监听器清理和所有者错误通知。现在只保护该发送，直接销毁、renderer 故障与 GPU 故障均继续清理；不 ACK 未知引用、不更改 CPU 回退策略。
- Mac 的原生 `presentedFrames=0` 不是缺失字段，不能用 `?? nativeFrames` 取得生产计数。验收辅助现在明确提供 `renderedFrames`，Mac 的呈现计数仍不填充；Windows 原有呈现计数保留。关闭、素材与远程脚本使用正确的生产就绪门槛，不把它当作物理上屏证明。
- Canvas 窗口截图补回可见全屏工具栏的真实背板像素坐标。检查通过实际鼠标操作唤出 HUD，再隐藏 HUD 做完整字幕像素／透明区检查，并断言视频尺寸不变；不能把白色 HTML 图标当作 PGS 残留。底栏控件在视频外，不作为全屏遮挡线。Windows 原生控件边界断言保留。

时序计算去重建议不构成阻断，本次不引入新架构。新增 Linux 清理与辅助截图／交互回归已通过。修正后完整 `npm test` 实际退出 0：Node 脚本组 179 项／176 pass／3 宿主 skip；Electron 4309 项／4269 pass／0 fail／40 宿主 skip，含三个真实 macOS 原生线程与租约检查。生产构建、脚本 lint 和 `git diff --check` 通过；Mac addon 及其原生源码未改变，核对摘要复用同一实际原生构建，不重复制造通过记录。

新的正常窗口素材矩阵 14 组检查通过：四音轨、章节、ASS、HEVC Main10、无音轨、倍速，变形像素／竖屏／超宽三类素材各自的展开／缩放／底栏／全屏，以及复杂 ASS、原创 PGS 的像素、透明区、时序和同会话切换。关闭生命周期两项检查也通过；两次 GUI 宿主均正常退出，未强制终止。文档站重新验证 18 项测试及 28 页／2045 个引用、搜索和地图。

本次复现失败、通过日志、截图、最终源码和摘要保存在 `out/playback-acceptance/review-push-eV2U6q/`；实际提交、推送读回与 CI 状态另记该目录的 `handoff.json`，不为补写提交自身 SHA 循环提交。原有恢复副本不变。没有新增正式包、Windows／Linux 原生宿主、远程 GUI、签名、公证、多屏、物理色彩／声音或长期能耗验收；前述性能代价和故障后重启边界仍适用。
