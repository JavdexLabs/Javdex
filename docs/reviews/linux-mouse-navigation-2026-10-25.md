# Linux 导航与播放器点击验收

日期：2026-10-25。初始复现基线为 `2285e89c`，最终修复基于更新后的 `dev` / `acc56cfc`。本机 Ubuntu 26.04.1 / GNOME Wayland，最终使用 Electron 43.8.1 / Chromium 150.0.7871.250；X11 项为本机 XWayland。

本轮只修改源码、测试和文档，未替换桌面的正式 AppImage，也未重新发布安装包。应用 GPU 修复、CPU 回退及播放内核保持原有实现。

## 根因与导航修复

Linux 鼠标侧键按下先触发窗口 `app-command`，应用遍历一个历史项；同一点击继续进入 Chromium，松开还可能执行默认返回。`app-command` 是通知，对它取消不能消费另一条鼠标路径。旧代码的本机原生 XWayland 注入得到历史索引 5 → 3；旧原生 Wayland 那轮未复现第二次遍历，不将其算作复现。Chromium 鼠标事件配合窗口命令重放在两种显示协议均能复现。

保留 `app-command` 入口，在 Linux `before-mouse-event` 消费 `back` / `forward`。前景任务禁止导航时也消费默认动作，普通鼠标按钮继续放行。没有时间去抖，没有另建返回栈，Router / overlay history / NavigationGuard 继续拥有业务策略。

Linux 专用 `BrowserBack` / `BrowserForward` 未处理时，按下、松开均可能被 Electron 转成 `app-command`。初始原生 XWayland 分别得到 5 → 3、5 → 7。现在由 `before-input-event` 在有效初次按下遍历一次，并消费松开、重复、输入法及组合键的其它事件；不修改 Windows/macOS 的导航分支。

对应 Electron 源码：[Linux 按下通知](https://github.com/electron/electron/blob/v43.8.1/shell/browser/native_window_views.cc)、[窗口 app-command 通知](https://github.com/electron/electron/blob/v43.8.1/shell/browser/api/electron_api_base_window.cc)、[可取消鼠标入口](https://github.com/electron/electron/blob/v43.8.1/shell/browser/api/electron_api_web_contents.cc)。Electron 43 运行时返回 `back` / `forward`，类型声明仍只列前三个鼠标按钮，代码仅局部拓宽按钮值进行比较。

## 手势与平台时序的收敛

旧播放器单击等 300ms，合法的慢速双击晚于计时器，因此先切换播放状态，再全屏。最小浏览器复现：100ms 只有全屏，350ms 先 pause 再全屏。GNOME 的双击偏好不能直接代表 Chromium 实际判定。

首次修复提高等待并在第二次按下时取消，解决了本机慢速双击和按住问题。随后架构审查又复现：把取消放进通用 `control()` 会吞掉单击后紧接着的静音或跳转。旧代码发送静音/跳转和暂停，待审版本只发送前者；GPU/CPU Canvas 标识均复现。该回归已修复。

最终职责如下：

- `desktop/pointerTiming.ts` 提供运行时规则，受控无参数 IPC 只返回间隔及来源。Windows/Linux 使用 Chromium Aura 的 500ms；macOS 用系统自带 `/usr/bin/osascript` 执行固定的只读 AppKit 查询，读取 `NSEvent.doubleClickInterval`。无 shell、无 renderer 输入、无新增运行库或系统配置。
- AppKit 查询限时 2 秒，值限制在 0–5000ms 内；失败使用保守的 5000ms 单击等待，明确按钮和键盘仍即时。窗口回到前台时刷新，同一时刻的 IPC 查询合并，不让 renderer 读系统路径或调用任意程序。
- `usePlaybackPointerGestures` 只管理单击/多击的等待、确认、取消和会话清理。等待平台答复后，按原点击时间计算间隔加 50ms 余量；取消或卸载后的迟到结果不能重建计时器。第二次按下立即取消，浏览器标为独立新单击时确认前一单击。
- `PlaybackPanel` 保留播放语义和命令发送。明确播放/暂停、重播、续播、停止、展示切换及历史收起替代待判定的手势；静音、音量、按钮/键盘/滑杆跳转、倍速和选轨保留原单击。换片、通道变化、错误和卸载清理旧手势。

来源：[Electron 43.8.1 DEPS](https://github.com/electron/electron/blob/v43.8.1/DEPS)、[Chromium 多击时间与计数](https://github.com/chromium/chromium/blob/150.0.7871.250/ui/events/event.cc#L110)、[500ms 常量](https://github.com/chromium/chromium/blob/150.0.7871.250/ui/events/event_constants.h#L105)、[Windows 构造 ui::MouseEvent](https://github.com/chromium/chromium/blob/150.0.7871.250/ui/views/win/hwnd_message_handler.cc#L3141)、[macOS 使用 NSEvent 点击计数](https://github.com/chromium/chromium/blob/150.0.7871.250/components/input/web_input_event_builders_mac.mm#L332)。Windows 的系统偏好未被误当作其 Aura 判定依据。

## 最终验证

| 检查 | 结果与边界 |
| --- | --- |
| `npm test` | 退出 0；架构、lint、类型、打包/构建脚本与 Electron 套件通过。Electron 4549 通过、25 条件跳过、0 失败；其它脚本阶段另有 4 项非 Linux 工具链用例跳过 |
| 后续补充 IPC/交叉操作 | 最终 `desktopSessionHandlers.test.ts` 和 `PlaybackPanel.test.tsx` 合计 77 通过。包含新增无参数 IPC 验证和 GPU/CPU × 播放/暂停的七类交叉操作；生产实现与完整套件运行时相同 |
| Hook/平台单元 | 覆盖 800/1500ms 系统间隔、按住、焦点刷新、时序查询迟到/失败、取消及会话/通道/展示/错误/停止清理；包含在完整 Electron 套件中 |
| `npm run test:ui` | 完整入口退出 0；嵌套返回、输入法、焦点、Modal、播放设置与模型页通过。播放器矩阵含 32 个双击、16 个真实鼠标交叉控件、两个自定义时序，以及单击、独立单击、键盘和明确控件检查 |
| 原生鼠标 | Wayland / XWayland 各 12 项通过：GPU/CPU 标识 × 播放/暂停 × 慢速双击/第二次按住/边界外独立两击。真实按下计数分别为 1、2 或 1、1，命令断言同时验证无临时 pause/restart 和独立点击均生效 |
| 导航集成 | Electron 43.8.1 在 Wayland / XWayland 各 5 轮通过；检查播放收起、业务前进/后退及前景任务保护。使用 Chromium 鼠标事件配合窗口命令重放 |
| `npm run server:test` | 两阶段合计 55 通过、2 项真实 mpv 条件用例跳过、0 失败；包含 Node 宿主类型检查 |
| 构建与静态检查 | `npm run build`（desktop + web）、最终 TypeScript、针对性 ESLint、编码、脚本语法及 `git diff --check` 通过 |

跳过项未计作通过：完整 Electron 套件主要为 Windows 路径/文件锁、macOS/Windows 原生播放 addon 以及受环境条件控制的 AI 运行库用例。没有在 Linux 假装验证 Windows/macOS GUI 或其原生系统间隔。

新增原生入口 `npm run test:playback:pointer:native`，`-- --x11` 切到 XWayland。它不人工指定点击数，检查当前运行时收到的原生多击计数；不支持 GNOME/Mutter/Python dbus 时失败。测试仅向自己的聚焦窗口注入指针，结束停止临时 DBus 会话并关闭窗口。当前系统限制开发版 Electron 沙箱，因此本机测试入口显式使用 `--no-sandbox`；只影响隔离夹具，不修改系统设置或应用启动策略。

浏览器夹具、原生鼠标夹具都模拟帧绑定与播放 RPC。GPU/CPU 标识表示两种 Canvas 分支，不是本轮视频解码、GPU 像素、音画同步、读屏或安装包验收。Windows/macOS 实机、多种鼠标驱动及重映射工具仍是未覆盖范围。

## 本地证据

原始日志和前后对照保存在忽略目录 `out/mouse-navigation-diagnostic/`：

- `review-independent-controls.json`：审查时的旧代码/待审版本交叉操作回归对照。
- `input-full-test-v1.log`、`input-cross-final.log`、`input-typecheck-final.log`、`input-build-v1.log`、`input-ui-full.log`、`input-browser-final.log`、`input-server-test.log`。
- `input-native-wayland-final.log`、`input-native-x11-final.log` 以及 `input-navigation-wayland.log`、`input-navigation-x11.log`；各入口打印独立临时目录中的 JSON 报告。
- 初始诊断的 `canvas-click-audit.json`、`key-native-baseline-x11.json` 和 `key-native-guarded-fixed-*.json` 保留，属于早期 Electron 43.8.0 证据。

最初的普通 `npm ci` 在宿主缺少 make 时尝试重编本地依赖而失败。改用锁定依赖的 `npm ci --ignore-scripts`，运行项目 Sharp 准备脚本及 Electron 43.8.1 安装脚本，并验证已有 SQLite 预编译包可在 Node/Electron 测试宿主加载。实际安全覆盖校验及 npm audit 通过；没有为此安装系统包或跳过产品测试。原生验收初次构建漏指定 tsconfig，未解析到共享别名，补正后两种协议完整重跑通过，失败记录亦保留。
