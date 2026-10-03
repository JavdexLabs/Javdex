# 桌面内置播放：成熟产品参考与功能取舍

调研日期：2026-10-02。状态：产品研究与已确认取舍记录，供方案讨论；下列用户决定已确认，其余建议不是实施承诺或验收结果。

范围：Javdex 桌面客户端的内置播放。本地文件与远程媒体库共用 libmpv 播放内核，端侧解码，服务器提供原始文件；本轮不扩展 Web，不引入服务器转码。

本文件只补充产品证据与取舍，不改写已有技术研究。当前实现边界以 [原生渲染验证记录](LIBMPV_NATIVE_RENDER_PROTOTYPE.md) 为准：macOS 原型可行，但跨平台、分发、真实长片和 HTML 任意叠层尚未验收。

## 用户已确认的决定

1. 参考 Plex 的交互方向，在 Javdex 应用内播放，并可收起为应用底部操作栏；不是另开独立 OS 播放窗口。用户随后明确：底栏同时显示实时小视频，不采用仅声音/文字操作栏。
2. 续播记录默认关闭。只有用户主动开启后才持久保存和使用续播位置；同一次活动会话的收起/恢复不属于跨会话续播。
3. Windows、macOS、Linux 同时发布内置播放，不采用 macOS 先正式开放、其他平台以后补齐的发布策略。可以分平台开展验证，但正式发布以三平台共同达标为门槛。

这三项及实时小视频的补充要求来自用户决定，不依赖 Plex 当前实现能否逐项获得官方证据；Javdex 的已确认需求不等于对当前 Plex Desktop 行为的事实认定。

## 结论先行

建议将 Javdex 内置播放定位为“媒体库里的可靠观看工具”，而不是再造一个通用 VLC：按用户决定采用应用内展开/底栏收起，参考 Plex 的媒体库浏览与播放器衔接；同时借鉴 IINA 的轻量观看体验、Kodi 的可选续播与轨道选择、Jellyfin Desktop 的媒体库客户端分工。Plex 的具体证据边界见下文。

首期优先形成闭环：选定资源 → 应用内展开播放 → 可靠播放/跳转与轨道选择 → 收起底栏继续浏览 → 恢复同一会话 → 停止释放；用户主动开启续播时才增加位置持久化。画中画、缩略图预览、完整历史、自动连播和高级画质设置可以独立后置。应用内底栏收起不等于 OS 画中画。

上述是针对 Javdex 的建议，不是竞品功能覆盖统计。下表只列本次实际读到的第一手证据；没有证据的格子不推断为“不支持”。

## 参考对象与证据边界

| 产品 | 官方可核查内容 | 本次借鉴方向 |
| --- | --- | --- |
| Plex Desktop / Plex Web（分别核对） | 桌面介绍说明应用采用 Web 类似布局；Windows/macOS 1.37.0 公告提到 mini-player 进度条修复；Web 播放文档明确收起和底部控件。见 [桌面介绍](https://support.plex.tv/articles/windows-and-macos-intro-installation/)、[桌面 1.37.0 公告](https://forums.plex.tv/t/plex-for-mac-windows-and-linux/446435/50)、[Web 播放文档](https://support.plex.tv/articles/200392226-plex-web-app-player/)。 | 应用内展开/收起与浏览衔接；不据 Web 文档承诺当前三平台桌面视频 mini-player 的完整行为。 |
| IINA | 官方仓库列有字幕、播放列表、章节、可调整 OSC、缩略图、历史与快捷键；官网展示原生画中画。见 [仓库功能说明](https://github.com/iina/iina#features)、[官网](https://iina.io/)。 | 桌面轻量观看与渐进展开，而不是复制所有定制功能。 |
| VLC | 桌面 3.0 文档分别介绍全屏、截图、音轨、字幕、章节和指定时间跳转。见 [视频](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/video.html)、[音频](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/audio.html)、[字幕](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/subtitles.html)、[播放](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/playback.html)。 | 找到基础操作的完整边界，不照搬菜单数量或专业工具。 |
| mpv | 官方稳定手册提供 OSC、键盘控制、续播、音频设备与统计说明。见 [稳定手册](https://mpv.io/manual/stable/)。 | 播放内核能力与产品界面分开，避免将全部内核选项直接暴露为设置。 |
| Kodi | 官方播放文档说明续播入口、播放 OSD、章节/书签及音轨/字幕设置。见 [Video playback](https://kodi.wiki/view/Video_playback)。 | 媒体库与观看状态的衔接；不照搬客厅遥控器界面。 |
| Jellyfin Desktop | 官方仓库说明 Qt WebEngine＋libmpv、硬解和音频直通；官方客户端列表仍称 Jellyfin Media Player。见 [当前仓库](https://github.com/jellyfin/jellyfin-desktop)、[客户端列表](https://jellyfin.org/downloads/clients/)。 | 原生内核承接媒体库播放，不把浏览器媒体能力当成桌面能力上限。 |

资料注意事项：VLC 来源明确为桌面 3.0 文档；Kodi 播放页标注更新至 v20，不据此判断其最新 HDR 支持。源码引用来自调研当日的 IINA `develop`、Jellyfin `master`，说明当前代码意图，不保证已进入稳定发行版。本文不据此承诺 Javdex 的平台、格式或硬件支持。

## Plex：应用内播放、收起与恢复的证据核对

本小节只使用实际读取的 Plex 官方支持文章与官方发布公告；未安装或运行 Plex 做版本级 UI 验收。部分支持页的网页读取工具返回 403，已通过 HTTP 读取其 HTML 正文和修改日期；桌面公告同时核对了官方 HTML / JSON 正文。以下区分文档事实、适用范围与不能据此证明的行为。

### 官方证据与适用范围

| 官方来源 | 可以确认的内容 | 适用范围与证据边界 |
| --- | --- | --- |
| [Introduction and Installation](https://support.plex.tv/articles/windows-and-macos-intro-installation/)（修改于 2022-06-10） | 桌面应用采用类似 Web 应用的布局，并提供更强的播放能力；文中列有 Windows、macOS 和 Linux 安装方式。 | 这里的 standalone application 指 Plex 桌面应用本身，不等于影片另开 OS 窗口。文章不规定收起栏的视频、尺寸或恢复交互，也不标明对应客户端构建版本。 |
| [Configuration and Usage Options](https://support.plex.tv/articles/configuration-and-usage-options/)（修改于 2020-07-14） | 说明 Windows/macOS 桌面应用的基础界面和配置与常规 Web 应用相同，多数 Web 文章可参考；另列桌面专有设置和快捷键。 | 这是布局共性的官方说明，不是“全部 Web 视频控件在当前三平台桌面版本完全一致”的保证；正文没有逐项说明 mini-player，亦未覆盖 Linux 的具体控件行为。 |
| [桌面 1.37.0 官方发布公告](https://forums.plex.tv/t/plex-for-mac-windows-and-linux/446435/50)（2021-11-10） | Windows/macOS 1.37.0 修复了 mini-player 的 seek handle 被裁切问题，能直接证明该版本存在带进度拖动控件的 mini-player。 | 公告未说明这一控件属于视频还是音乐场景，未展示收起后的画面，也不覆盖 Linux；不能用它证明当前三平台桌面视频都以同一底栏呈现。 |
| [Plex Web App Player](https://support.plex.tv/articles/200392226-plex-web-app-player/)（修改于 2019-02-28） | 列出底部播放、跳转、进度、音量等控件；`Minimize Player` 收起展开的播放器并继续通过 mini-player 播放；进入/退出全屏是另一项操作。 | 明确是浏览器播放器文档，且仍提及旧的 Flash 场景。可以借鉴“收起不等于停止、界面收起与全屏切换分开”的交互区分，不能当成当前 Plex Desktop 视频实现的直接证据。 |
| [Cast from Browser or Desktop](https://support.plex.tv/articles/201206866-cast-from-browser-or-desktop/)（修改于 2019-04-04） | 在文中限定的 Chrome Web 投放场景，左上向下箭头切到 mini-player，可继续浏览；底部左侧 artwork 上的向上箭头恢复 Now Playing。 | 实际视频在 Chromecast 上播放，浏览器是控制端；底部 artwork 不足以证明桌面本机视频在收起状态仍显示动态图像。尽管标题含 Desktop，正文并不是 Plex Desktop 本机视频教程。 |

**尚无足够官方证据的项目**：当前 Plex Desktop 视频收起后是否显示实时小画面、是否仅剩海报/文字操作栏、三平台是否完全一致，以及恢复时是否存在特定动画/尺寸。没有取得证据不等于认定“不支持”。本小节不把 Plex Web、Plexamp、Plex HTPC 或旧 Plex Media Player 的能力移植为当前 Plex Desktop 视频事实。

### 用户需求、Javdex 建议与技术未验证

- **已确认需求**：应用内播放、可收起为同时显示实时小视频的底部操作栏、续播默认关闭、三平台同时正式发布。
- **Javdex 建议**：展开态、底栏态、全屏态属于同一活动播放会话。收起/恢复只变更呈现，不重新打开资源，不改变暂停状态，不因呈现切换而重复获取播放授权；授权失效仍按播放协议处理。底栏仍有暂停、进度、音量、恢复和停止入口。页面浏览不应自动终止会话；停止后底栏及占位退出。
- **收起画面已确认**：持续显示实时小视频与操作控件，不能用静态海报/截图或仅声音代替。收起/恢复使用同一会话，具体原生视图处理由主方案定义，不能将产品确认当作技术验收通过。
- **技术未验证**：把当前原生画面接入应用内容区、收起后的隐藏/缩放、路由与弹层切换、全屏进出、DPI/窗口变化、三平台一致性。Plex 有相似交互不能证明 Electron＋libmpv 的原生视图合成已经解决；实现方案另由设计文档定义，本文件不指定其内部架构。

## 按用户任务比较，而不是堆功能

### 1. 专注观看与窗口控制

**官方证据**：VLC 文档明确全屏控件可消失，通过鼠标移动或键盘恢复；mpv OSC 是基础鼠标控制界面，随鼠标移动显示并可自动隐藏。IINA 源码分别定义 OSC 位置、自动隐藏与开片全屏偏好。见 [VLC 全屏](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/video.html#full-screen)、[mpv OSC](https://mpv.io/manual/stable/#on-screen-controller)、[IINA Preference.swift](https://raw.githubusercontent.com/iina/iina/develop/iina/Preference.swift)。

**Javdex 建议**：

- 按已确认决定，播放器位于 Javdex 应用内，不开独立 OS 播放窗口；建议首期只保留一个活动会话。收起为底栏后仍可浏览媒体库，恢复时回到同一会话；切换影片时只在用户已开启续播记录的前提下保存旧位置。
- 展开态使用紧凑控制栏：暂停、前后跳转、进度/时间、音量、音轨、字幕、倍速、收起、全屏；收起态只保留高频控制与恢复/停止入口。低频命令收进菜单，不增加一排调试按钮。
- 全屏目标是控件可唤出、可隐藏，暂停、拖动、键盘聚焦或菜单打开时不自动隐藏。控制条隐藏后不应永久预留空白。
- **应用内嵌播放同样不能靠 CSS 解决原生视图遮挡 HTML**。沿当前原型路线，应先验证视频区域与控制区域不重叠、菜单/侧栏显式避让及收起时的原生视图处理；只有另行证实原生叠层或同一渲染面的控件合成，才能承诺 IINA 式悬浮覆盖。不能靠 CSS `z-index` 宣称解决。
- 默认保持原比例完整显示，不裁切、不拉伸；置顶、裁切、旋转放低频入口。自动全屏不是必选默认。

### 2. 定位片段、续播与隐私

**官方证据**：Kodi 有续播点时提供“从头”和“从指定时间继续”；VLC 提供章节和指定时间跳转。mpv 可保存位置与部分播放选项，续播文件以完整路径散列命名。见 [Kodi 播放入口](https://kodi.wiki/view/Video_playback#Play)、[VLC 播放控制](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/playback.html)、[mpv 续播与文件](https://mpv.io/manual/stable/#resuming-playback)、[mpv 文件说明](https://mpv.io/manual/stable/#files)。

**官方证据**：IINA 源码将 `recordPlaybackHistory`、`recordRecentFiles`、`resumeLastPosition` 分开，历史写入受记录开关控制。见 [偏好定义](https://raw.githubusercontent.com/iina/iina/develop/iina/Preference.swift)、[HistoryController.swift](https://raw.githubusercontent.com/iina/iina/develop/iina/HistoryController.swift)。这能证明职责可拆分，不能证明其满足 Javdex 的全部隐私要求。

**Javdex 建议**：

- 进度条支持点击、拖动、键盘调整；拖动期间显示目标时间，松手提交跳转，避免远程媒体每次鼠标移动都发起精确 seek。恢复先前播放/暂停状态，不用 seek 自动解除暂停。
- 提供短跳转与长跳转两档、指定时间、已有章节列表；章节不存在时不显示空的章节入口。缩略图预览不属于基础定位的前提。
- 用应用稳定的资料库/资源身份关联进度，不以临时 PlayGrant URL、标题或客户端路径作为唯一键；不同资源版本不能未经确认共用同一位置。
- 续播记录默认关闭，不写入或读取跨会话位置；同一会话收起/恢复保留内存中的当前进度。用户主动开启后才保存“最近可续播位置”，不把拖到结尾等同于实际看完。是否存在已观看标记、其阈值与“稍后观看”的变更应作为独立产品决策，不从播放器事件直接推导。
- 首期可只做用户选开的续播数据，不做完整浏览式播放历史。进度记录、历史列表、系统最近文件及系统媒体信息分别管理；提供开启记录和清除数据入口。再次关闭记录后不使用旧位置，但不偷偷删除旧数据，清除需要明确范围。
- 默认关闭已确认，不再列为待决策问题。建议仅在用户已开启记录且有有效位置时提供“继续 / 从头”；是否自动继续仍可进一步取舍，不以“参考 Plex”为由隐含开启记录或自动续播。

### 3. 音轨、字幕、倍速与章节

**官方证据**：Kodi 提供音轨选择、音频偏移、字幕语言选择与偏移、浏览外挂字幕；VLC 提供内嵌/外挂字幕与显示设置。见 [Kodi 字幕和音频设置](https://kodi.wiki/view/Video_playback#Subtitles)、[VLC 字幕](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/subtitles.html)。IINA 官方功能列表包含章节和本地字幕匹配；mpv 手册列有速度调整、逐帧与 A–B 循环。见 [IINA 功能](https://github.com/iina/iina#features)、[mpv 键盘控制](https://mpv.io/manual/stable/#keyboard-control)。

**Javdex 建议**：

- 首期音轨/字幕是显式菜单：语言、名称、可用时的声道/编码、当前选项；字幕必须有“关闭”，没有音轨时显示“无音轨”，不是“静音”。
- 字幕至少覆盖内嵌选择和用户在本机选择的外挂文件；文本字幕与图像字幕的可调整能力不同，界面依据实际能力启用选项。字体/字号、字幕延迟和音频延迟放二级设置。
- 本地同名外挂自动发现、语言偏好可下一步加入；**远程服务端同目录字幕不是客户端本机路径**，需要额外授权的发现与下载契约，不能靠把服务器路径传给播放器实现。在线字幕搜索后置，不默认发送影片名给外部服务。
- 倍速用少量常见预设、明确显示当前值、一键回到 1×；不做任意滤镜链编辑器。逐帧与 A–B 循环可以后置在菜单/快捷键中，不抢占常驻底栏。

### 4. 键盘、系统行为与音频设备

**官方证据**：VLC 文档列有 Space、F、Esc、静音、速度与跳转快捷键；IINA 官方列表声明可配置键盘、鼠标和手势。Jellyfin Desktop 源码观察音频设备列表、响应热插拔、对已断开的选择提供状态，并在设备不在列表时选 `auto`。见 [VLC 快捷键](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/hotkeys.html)、[IINA 控制方式](https://github.com/iina/iina#features)、[Jellyfin PlayerComponent.cpp](https://raw.githubusercontent.com/jellyfin/jellyfin-desktop/master/src/player/PlayerComponent.cpp)。不据 VLC 文档的措辞推断所有按键默认是系统级全局热键。

**Javdex 建议**：

- 首期提供一套固定、可发现的应用内播放器快捷键：Space 暂停、左右短跳、组合键长跳、F 全屏、Esc 先关最上层菜单再退出全屏、M 静音；菜单中展示键位。收起后浏览媒体库时，快捷键须按焦点/交互上下文处理；输入框、滑杆编辑和输入法组合期间不能误触播放命令。
- 优先跟随系统音频输出；恢复/切换设备的行为必须实际测试。手动设备选择可第二阶段提供；显式设备断开时提示并允许选择，不把静默回退伪装成仍在原设备播放。
- 首期默认端侧解码成常规音频输出；HDMI 直通、独占输出和声道调校后置，需要设备级验收，不能“libmpv 支持”就视为产品已支持。
- 防止播放时休眠、关闭停止、系统休眠后的恢复策略纳入生命周期验收；媒体键/系统正在播放信息独立设计，并允许不公开标题和封面。

### 5. 播放信息和故障定位

**官方证据**：Kodi 把媒体、播放器和调试信息分层，播放器信息包含实际解码器、硬件/软件解码、分辨率、帧率、缓存和音频信息；Jellyfin Desktop 信息汇总读取 `hwdec-current`、音频输出、A/V、丢帧与缓存属性。见 [Kodi Player process info](https://kodi.wiki/view/Player_process_info)、[Jellyfin 信息汇总源码](https://raw.githubusercontent.com/jellyfin/jellyfin-desktop/master/src/player/PlayerComponent.cpp)。

**Javdex 建议**：

- “播放信息”作为低频面板，默认只显示来源类型、容器/编码、分辨率/帧率、实际硬解方式、音频输出及轨道；进阶展开缓存、掉帧和 A/V 状态。
- 当前生效状态与设置分开：`自动硬解` 是偏好，`当前使用 VideoToolbox / 软件解码` 才是运行结果。未取得数据时显示未知，不能填成功默认值。
- 开片失败、缓冲、用户暂停、设备无输出、自然结束必须可区分。提供重试、复制脱敏信息及显式外部播放器入口；不悄悄换资源、启用服务器转码或把错误当成播放成功。
- 正常观看不常驻性能计数，不记录带凭据的 URL。复制诊断前去除播放 token、完整个人路径和其他敏感信息，必要时让用户主动包含文件名。

### 6. 队列、画中画、截图及高级能力

**官方证据**：IINA 官方列有播放列表、缩略图和原生画中画；源码分别提供截图保存、复制到剪贴板、包含字幕的偏好。VLC 文档说明截图和重复定位用书签。见 [IINA 功能](https://github.com/iina/iina#features)、[IINA 画中画](https://iina.io/)、[IINA 截图偏好](https://raw.githubusercontent.com/iina/iina/develop/iina/Preference.swift)、[VLC 截图](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/video.html#snapshot)、[VLC 书签](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/playback.html#bookmarks)。

**Javdex 建议**：

- 首期只播放用户明确选定的资源，结束停留在结束状态；不自动把整个目录、筛选结果或“稍后观看”变成队列，也不默认连播下一部。
- 后续队列应来自显式“加入播放队列”，与收藏/清单/稍后观看区分；每项关联稳定资源身份，不持久保存授权 URL。切换与失败策略由用户可理解的队列行为决定。
- 截图可优先于画中画进入第二阶段：用户主动保存/复制，明确是否带字幕和输出位置；不自动写海报、样张或媒体库资源，不用截图证明持续零拷贝。
- 画中画、进度缩略图和书签单独评估。缩略图需要额外解码与远程读取预算；PiP 需要独立平台窗口/渲染方案，不能把“置顶小窗口”当作原生 PiP 验收。
- HDR/杜比视界、直通、自动刷新率切换、色彩校准、shader、在线内容下载、录屏/剪辑/转码、第三方脚本/插件均不建议纳入首期。这是范围建议，不是对竞品能力的否定。

## 建议的阶段边界

| 阶段 | 应回答的问题 | 建议完成内容 |
| --- | --- | --- |
| P0：接入前验证 | 三平台能否安全分发？原生画面与控件如何相处？ | 实际库构建/许可证/打包；Windows/macOS/Linux 验证矩阵；应用内展开、实时小视频底栏收起/恢复与全屏策略；播放来源资格。实时小视频、续播默认关闭、三平台同时发布不再是待决策项。 |
| P1：可靠观看闭环 | 用户能否从媒体库稳定观看、收起浏览并退出？ | 同一内核的本地/远程播放；展开/底栏/全屏的同一会话；基础控制、键盘、内嵌轨道/手动字幕、倍速、章节；默认关闭的可选续播；状态/错误/诊断；停止后撤去底栏和占位；身份切换清理。三平台共同验收后同时正式发布。 |
| P2：高频增强 | 有哪些明确使用收益？ | 本地字幕自动发现/语言偏好、设备选择、截图、显式队列；缩略图/PiP 按实际需求和技术验证再定。 |
| 不随首期扩张 | 是否把播放器变成另一个产品？ | Web 接入、服务器转码、完整播放历史/跨设备同步、在线字幕服务、画质实验和专业编辑功能独立立项。 |

这不是“P1 已有全部底层能力”的判断：原型只证实有限媒体的原生播放路径。应把音轨/字幕、持续播放、实际音频、错误/恢复与资源切换纳入后续真实素材验收，再形成支持清单。

## 已确认决定之后的评审清单

以下不重问应用内播放、实时小视频底栏、默认关闭续播和三平台同时发布的已确认决定。其余由主方案提出默认建议或 S0 验证后再按需确认，并不是要求用户现在重答全部问题。

1. 全屏控件合成验证后，如确实只能固定区域避让，用户是否接受这种取舍？默认以可自动隐藏的控制条为产品目标，不自行降级。底栏实时小视频已确认，不再询问。
2. 用户主动开启续播后，采用“继续 / 从头”选择还是自动继续？是否只记录本机进度，暂不做完整历史和跨设备同步？
3. 成功打开播放是否仍触发现有“稍后观看”等动作，还是改为独立的手动/播放完成行为？应由主方案核对当前业务后确认。
4. 首期是否默认结束停止、不开自动队列/连播？截图、画中画、字幕自动发现中哪个最值得优先？
5. 三平台同时发布已确认，仍需明确对应的 OS 最低版本、处理器架构、Linux 桌面环境与安装包验收矩阵；不把平台共同发布等同于所有驱动和格式完全相同。

## 媒体库客户端分工的补充证据

Jellyfin 服务端源码把播放开始、进度和停止作为独立会话上报接口，而不是将历史责任放进 libmpv。见 [PlaystateController.cs](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/PlaystateController.cs)。

由此可借鉴的**设计推论**：播放内核提供事件与当前位置，Javdex 应由自己的会话/进度业务决定保存、清除与权限。它不意味着本轮需要照搬 Jellyfin 的服务端会话、用户系统或跨设备进度接口。
