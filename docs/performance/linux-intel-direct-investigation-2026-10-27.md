# Intel 直接硬解与混合显卡呈现调查（2026-10-27）

此记录区分 producer、Electron 纹理导入与桌面窗口呈现，不将 helper 出帧或窗口启动当作完整播放通过。证据目录：`out/linux-intel-investigation-20261026/`；最终重建：`out/linux-intel-fd-fix-20261027/`。未更改系统设置或驱动。

## VAAPI producer

Intel UHD 770 为 `/dev/dri/renderD128`，NVIDIA RTX 4080 为 `renderD129`。旧实现将 GBM 使用的同一 DRM 文件描述符交给 libmpv 的 VAAPI display。实验仅改变该文件描述符的来源：在同一设备节点上独立 `open`，不使用共享底层 file description 的 `dup`，并验证设备身份相同。解码器生命周期先结束，然后关闭该 FD。

| 对照 | 结果 | 证据 |
| --- | --- | --- |
| 同一 GBM FD，严格 `vaapi` | 退为软件解码；短测 27 帧 | `helper-shared-fd-control.log` |
| 独立打开同一 GPU，严格 `vaapi` | 持续 `vaapi`；短测 321 帧，硬解下载采样为 0，三次 DMA-BUF 像素非黑 | `helper-independent-fd-structured.log` |

该对照将失败定位到两个子系统共享 DRM 文件描述符的互通边界，支持隔离 GEM handle 所有权的修复。尚未对驱动内部每一次 handle close 做内核追踪，不声称已证明具体驱动内部缺陷。短测含同步像素读回，不作为吞吐性能指标。

最终 Ubuntu 22.04 重建运行库的 67 秒独立复测：67 个状态采样全部为 `vaapi`，约 3152 帧、3 次像素采样各 9216 个非黑像素，正常退出、硬解下载计数为 0。证据为 `out/linux-intel-fd-fix-20261027/intel-direct-67s.log` 和 `intel-summary.json`。本次 4K60 输入、1080p 输出仍有 829 个 mpv 丢帧，`glFinish` 平均等待约 20ms；因此只确认解码稳定性与 producer 像素修复，不声称 Intel 已达到 60fps 或完成 GUI 流畅度验收。

## 强制 Intel 消费、NVIDIA 桌面呈现

本机是 NVIDIA 驱动桌面的混合显卡环境，不是纯 Intel 桌面。此实验仍失败，归入系统跨卡窗口呈现兼容性边界，不作为默认同卡播放的待修复阻塞项，也不能用于宣称 Intel 完整 video 播放验收通过。

| 实验 | 结果 |
| --- | --- |
| Wayland 强制 Intel GL / Vulkan | 窗口 DMA-BUF 被 GNOME 拒绝，EGLImage/CoglTexture2D 导入失败 |
| Wayland 协议追踪 | 提交的窗口缓冲区已是 linear modifier 0，不能仅归因为压缩／平铺 |
| Intel helper 输出 → NVIDIA EGL 独立读回 | EGLImage 后的 FBO 不完整，未得到有效像素证据 |
| XWayland Intel Vulkan，Mesa 软件 WSI | 初始窗口及 Intel WebGL 可建立；完整播放创建表面仍出现无效 external handle / swapchain 错误，GPU 进程退出 |
| Wayland Intel GL，关闭 GPU 窗口合成 | 初始窗口可建立；实际播放失败为 `TEXTURE_IMPORT_FAILED` |

后两项仅是进程内诊断对照，未加入产品默认配置。没有关闭全局安全限制、替换驱动、设置 Mesa 全局变量，也没有将软件窗口合成宣传为直接 GPU 播放修复。默认使用桌面匹配的 NVIDIA 路径与 CPU 回退仍需保留。移除 Linux Canvas 的工作区变更不表示此处 Intel 全链路限制已经解除。

## 新包回归

AppImage：`dist/linux-intel-fd-fix-20261027/Javdex-0.9.1-x86_64.AppImage`。保留旧包与旧 native 运行库；打包验收阶段未提交、推送或发布。

- 针对性 TS 测试 109/109 通过；类型检查、应用构建、GPU/CPU helper 重建及包内 FD/依赖闭包/PCM 解码校验通过。
- 实际 AppImage，NVIDIA Wayland，4K60 输出连续 60 秒：默认 `nvdec`，native 59.97fps，video 60.02fps，两侧统计均零丢帧；进程树 CPU 约 82.4%（100% 为一核）。计时后捕获合成画面验证彩色内容与运动；没有物理扫描输出或人工音画同步证明。
- 实际 AppImage Wayland Auto：启动期间跳转、自检、暂停恢复、隐藏显示、renderer 暂停超过 2 秒后恢复、缩放全屏、停止释放重开，以及终止 GPU helper 后 CPU video 接管画面全部通过。

继续默认 video 的代码已入新包，但这不把 Intel 混合显卡链路标记为修复完成。纯 Intel、AMD 及其他桌面环境仍需真实环境验收。

- 同一构建 `linux-unpacked/AppRun`，NVIDIA XWayland，4K60 输入、1920×1081 输出，可见置顶 60 秒：默认 `nvdec`，native 60.02fps / video 60.00fps，均零丢帧，CPU 94.1%。当前 XWayland 全屏 backing 不满足 3840×2160，拒绝冒充等尺寸 4K 对照。
- 初轮 XWayland 窗口没有固定可见性，前几秒正常，随后纹理全占用，平均仅 8.18fps；加入测试专用置顶后全程恢复 60fps，支持遮挡影响的解释。保留原始数据，不将其改写为通过；测试脚本仅在隔离验收窗口设置置顶，不改产品窗口策略。
- 一次 AppImage 包装进程与调试连接提前断开，但实际 GUI 仍在；清理明确属于该次测试的进程后，改用同一构建 AppRun。该轮记为 incomplete，不作为应用崩溃或性能通过证据。

- 同构建 XWayland CPU video：启动跳转、暂停恢复、隐藏显示、缩放全屏与运动画面、停止重开、页面重载和资源释放全部通过。

## 收敛决定与审查（2026-10-27）

按用户确认，结束本机强制 Intel → NVIDIA 桌面互通实验；保留结果与 Intel DRM FD 修复，不将实验绕行措施加入默认配置。默认目标为播放端与 Chromium 同卡；窗口跨卡呈现交给系统。候选设备取自唯一 PCI 身份匹配，实际导入仍由自检与画面验收约束；显式选卡时不能只凭枚举 active 字段证明实际 renderer。

Linux 默认直接硬解＋video，移除 Linux Canvas 消费入口，保留解码器 copy/software fallback 与独立 CPU video 接管。CPU 4K60 性能下降已获接受。继续保留 glFinish、三槽上限、最终引用释放后 ACK，以及不把提交／rVFC 当作物理扫描输出的语义。纯 Intel、AMD、原生 Xorg和其他桌面为未验证矩阵项，不由本机 XWayland/NVIDIA 结果代填。

收敛阶段只统一文档与复核测试，不改变候选包的产品代码；未重复打包。后续按用户要求对整个改动集执行提交前审查并推送，结果见下节。

收尾复核证据：`out/linux-convergence-20261027/`。播放器/main/preload 测试 424 通过、10 个平台限定跳过；native transport、时序、构建与运行库测试 49 通过、3 个平台限定跳过。初次 transport 运行缺测试夹具，编译隔离夹具后复跑通过，未更改产品代码。修改 TS 文件 ESLint 与 `git diff --check` 通过。逐文件核对包内 GPU 91 个、CPU 95 个运行库文件哈希，以及 app.asar 内 90 个 main/preload/renderer 产物，均与本地构建一致。审查未发现新增阻塞项；既有实机和音画同步验证边界保持不变。

## 提交前完整审查（2026-10-27）

审查范围包含本次全部生产代码、原生 FD watcher／销毁协议、三槽纹理引用释放与迟到消息、video 首帧重送、DRM FD 所有权、直接解码回退、构建配方／源码交付、验收脚本和文档。未发现新的阻塞缺陷；补齐 Unreleased 说明，保留已明确的系统边界与未验证矩阵。

完整 `npm test` 退出 0：架构检查、全仓库 ESLint/CSS、类型检查、打包合同、播放构建／样片、备份 smoke 通过；最终 Electron 测试 4589 通过、27 跳过、0 失败（4616 项）。日志：`out/linux-final-review-20261027/npm-test.log`。另有前述 49 项 native transport／时序／运行库验证和真实包画面验收。Linux 上的测试不替代 Windows/macOS 实机回归。

本次只提交源码、测试、脚本与文档到 dev；AppImage、运行库二进制、源码归档、临时实验和测试日志不进入 Git，也不执行版本发布。候选包的产品代码与本地构建逐文件核对一致，后续文档和 changelog 收尾不改变包内播放实现。
