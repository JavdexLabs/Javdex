# 三平台图形启动保护（2026-10-24）

验收基线为 `7af0c06375a65bad24fb5d8bbf635ede45afaed0` 加验收时尚未提交的工作区，包含前序播放回退修复；后续源码提交与推送以 Git 记录为准。本记录不代表 `0.9.1-beta.1` 发行附件已更新，也不是 macOS／Deepin 真机或安装器验收。

## 行为与职责

- Windows／macOS／Linux 使用同一个 `startupGraphicsRecovery.ts` 策略，`startupGraphics.ts` 只适配 Electron、日志和提示。
- 正常启动保留硬件加速。保护在导入 `appMain` 前安装，在主窗口第一次显示后不再因 GPU 退出重启整个应用。
- 只接受 GPU 子进程的 `crashed`、`abnormal-exit`、`launch-failed`、`integrity-failure`。正常退出、外部终止、OOM／memory-eviction、其他进程类型、启动缓慢以及普通异常都不是自动切换依据。
- 只有取得单实例锁的主实例可以重启。锁确认前发生的 GPU 故障暂存；次实例拒绝后丢弃，不抢占主实例。正常退出后也不再重试。
- 自动重启增加内部一次性标记和 `--javdex-software`，保留用户目录、显示后端、其他参数及 `--` 后的原始参数。软件启动在 `app.ready` 前调用 `disableHardwareAcceleration`，同时强制 CPU 视频，不改写设置文件。
- 带重试标记的启动再次失败时，保存诊断、显示错误并退出，绝不再自动重启。恢复成功后提供继续使用、重新尝试 GPU、查看启动日志；主动重试会去掉兼容标记，属于新的用户启动请求，不是第二次自动重试。
- 普通导入／资料库／页面加载错误受控报错，不按错误文本猜测 GPU 故障。已开始的运行时创建须完成后才能清理，尚未开始的 `whenReady` 不得阻塞退出；沿用原有播放、数据库、扫描及 Agent 清理顺序。

Electron 要求在 `ready` 前关闭硬件加速，因此故障后使用新进程恢复；`app.relaunch` 在原进程退出后执行，不能反复注册。接口依据见 [Electron app 文档](https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration)与[重启说明](https://www.electronjs.org/docs/latest/api/app#apprelaunchoptions)。

Linux AppImage 的原始启动器与临时挂载内的可执行文件分开处理：packaged + `APPIMAGE` 时验证绝对文件路径并显式设为重启目标，重新执行 AppRun 的显示／沙箱／运行库准备；deb、开发态和其他平台继续用当前可执行文件。该边界的上游问题见 [electron-builder #4650](https://github.com/electron-userland/electron-builder/issues/4650)。本次只做适配器测试，没有宣称已在 Linux 安装包上实际重启。

## 手动恢复与日志

`--javdex-software` 在三平台同时关闭界面加速并强制 CPU 视频；既有 `--javdex-cpu` 只影响视频。参数必须放在 `--` 之前。兼容模式不覆盖磁盘上的播放偏好；下一次完全退出、从普通入口启动时仍可尝试 GPU。

诊断位于 `app.getPath('userData')/logs/startup.log`，超过 256 KiB 尝试轮换至 `.previous`。记录时间、平台、PID、固定阶段码、软件／重试标志、已筛选的 GPU 原因及退出码；不记录完整启动参数。普通初始化异常保留限长错误信息供本机定位。日志写入或提示框失败不能阻止退出／恢复。

## 验证入口与结果

以下证据均为忽略的 `out/` 文件，不随安装包发布。

### 策略、适配器与生命周期

生产模块测试覆盖重复故障、第二次失败、锁前故障、次实例、ready 前／运行时创建中退出、无关故障类型、终止与重启失败、日志／提示不可用、显示选择、带空格路径及 `--` 参数。三平台实际播放注册测试确认软件启动会选择 CPU，Linux 的 X11／Wayland 标识不被更改。AppImage 目标选择覆盖 packaged 与开发态。

扩展回归包括 bootstrap、播放器、字幕、preload 和播放界面：581 项，559 通过、0 失败、22 条件跳过，日志为 `out/startup-recovery-full-regression.log`。跳过包括非 Windows 原生平台、限定宿主和文件符号链接能力检查，不计为通过。首次运行的 6 项 TLS 夹具因 `openssl ENOENT` 失败；仅在测试进程的 PATH 加入本机 Git 的 `usr/bin` 后重跑，不安装或修改系统配置，不跳过或削弱断言。保留首次日志 `out/startup-recovery-full-regression-missing-openssl.log`。

Node 类型检查、修改文件 ESLint、桌面生产构建与文档站离线构建均通过。对应日志为 `out/startup-recovery-typecheck.log`、`startup-recovery-lint.log`、`startup-recovery-build.log`、`startup-recovery-pages.log`；网站检查覆盖 28 页、2048 处本地引用。编码及 `git diff --check` 在交付前通过。

### Windows 真实 Electron 进程链

入口：`node scripts/startup-graphics-acceptance.mjs`。使用真实 Electron 的重启、退出、单实例锁、软件合成、隐藏窗口和 Canvas；只注入 GPU 退出事件，诊断框以测试接收器记录选项。没有重置物理驱动，也没有把提示框内容检查当成视觉验收。

7 个场景全部通过，最终证据为 `out/startup-graphics-acceptance-2026-10-24T15-43-00-231Z/results.json`，Electron 43.8.0：

| 场景 | 实际应用进程数 | 结果 |
| --- | --- | --- |
| 正常启动 | 1 | 保留硬件加速配置，Canvas 像素通过，无恢复提示。 |
| Electron ready 前图形故障 | 2 | 一次自动重启，软件界面恢复，Canvas 像素通过。 |
| 窗口显示前图形故障 | 2 | 一次自动重启，硬件加速关闭，显示恢复提示。 |
| 兼容模式再次故障 | 2 | 显示一次错误，没有第三个进程。 |
| 用户主动重新尝试 GPU | 3 | 一次自动重启加一次用户重启；去除兼容参数，恢复硬件加速配置。 |
| 手动软件启动 | 1 | 硬件加速关闭，无自动重启。 |
| 普通资料库初始化错误 | 1 | 报错退出，无图形重试。 |

每个成功窗口检查真实 Canvas `[10,20,30,255]` 像素；显示后的模拟 GPU 故障不会重新启动整个应用。正常启动的“加速”断言描述配置位，不扩大为所有驱动均健康的结论。

### Windows 完整应用

入口：`node scripts/startup-graphics-app-acceptance.mjs`，需要先 `npm run desktop:build`。使用两个独立合成资料库和实际生产入口、preload、renderer、IPC、隔离 CPU 播放宿主；测试窗口初始化后隐藏，不操作个人媒体库、全屏或系统文件选择器。

正常启动与 `--javdex-software` 两组通过。正常组保留加速；软件组确认加速关闭，实际 CPU 解码位置推进、`hwdec=no`，可停止播放。窗口已就绪后的 GPU 事件不导致全局重启。两组都由既有退出链正常退出，code 0、forced false。证据：`out/startup-full-app-acceptance/startup-app.json`。

## 保留边界

- macOS、Linux 桌面和 Hyper-V Deepin 25 尚未在本轮实际启动；共用逻辑和模拟平台测试不替代真机。AppImage 启动器重启仍需包内实测。
- 入口代码尚未执行就崩溃、主进程被系统终止、驱动令主进程完全卡死等，不能依赖本进程事件恢复；保留手动软件入口，不增加常驻看门狗。
- 缺失公共运行库、ABI／系统基线不兼容、数据库错误、内存不足不会因软件模式自动修复。不依据一次不正常退出或启动耗时永久关闭 GPU。
- 验收时未打包或发布；源码交付独立于安装包交付。软件 Canvas 功能仍受 CPU 能力、分辨率／内存边界约束，没有重做高帧率或 HDR 视觉验收。
