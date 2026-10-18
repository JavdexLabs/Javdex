# 内置播放合同

桌面播放器在主窗口中使用 libmpv，支持本机和远程资料库的文件资源；服务器不解码或转码。日常操作见[播放指南](../website/src/content/docs/guide/playback.md)，构建与分发见[开发指南](DEVELOPMENT.md#内置播放运行库)。

## 默认行为与来源

- 新设置默认内置播放并开启本机续播；已有显式播放方式、程序路径及续播设置保持。外部播放须配置程序路径，失败不自动换播放器或资源。
- 本机文件由主进程核对媒体库、影片、资源、根目录及可用性。远程文件经服务端授权及本机代理读取原始 Range 流，长期管理凭据和播放地址不交给 Renderer。
- 网页、Magnet、ED2K 等非文件链接继续由外部应用处理，不把“已交给系统”当作内置解码成功。
- 内置播放只有在真实输出画面且时钟推进后才记录最近播放或执行“稍后观看”的播放后移除；暂停首帧和续播选择不算开始。异步完成不能跨资料库产生副作用。

## 展示与交互

展开、底栏实时小视频和全屏使用同一播放会话；切换展示不重开影片。恢复同一资源不从头播放，停止后释放原生视图和占位。标题栏、设置、轨道、字幕及基础控制复用现有面板，不另建三套产品界面。

系统后退统一收起播放并关闭播放设置，保留会话与当前业务页面；Esc 依次关闭设置、退出全屏、收起播放。图片、播放与设置离开保护共同遵守[共享返回合同](ROUTING_DESIGN.md#overlay-history)，组件订阅或 Effect cleanup 不写历史。输入框、中文 IME、弹层和平台导航组合键优先于播放快捷键。

音量、倍速、章节、选轨、定位和播放信息读取内核实际状态。未知时长不显示虚假百分比；ASS 与图像字幕不套用纯文本字号能力。手动字幕与 AI 字幕选择不能被迟到命令覆盖。

## 续播与隐私

续播点只保存在本机，按资料库、资源及修订的摘要身份隔离，不保存路径或授权。全局开关与全部进度清除保留，不再提供单次临时不记录或单资源清除入口。有效进度先准备暂停画面，再由用户选择继续或从头；收起不是停止，也不是新的续播记录。

最近播放是另一份本机历史：独立快照、容量和删除规则见[开发指南](DEVELOPMENT.md#数据格式与数据库迁移)。两者都不属于服务端资料、跨设备同步或资料库备份，也不能形成清单引用保护。

## 原生与远程边界

共用核心拥有 mpv 生命周期、异步命令、状态、事件和字幕叠加层；平台适配器只拥有原生窗口、绘制和输入。macOS 使用原生视图，Windows 使用主窗口 child，Linux 首版支持 X11／XWayland；原生 Wayland 不在当前后端范围。正常关闭由实际接受的窗口关闭与退出生命周期释放内核，不在可能被否决的 `close` 回调提前拆除活跃视图。

远程播放的会话 URL、授权续期、内外两类代理池及回收规则集中维护在[服务端合同](SERVER_MODE_CONTRACT_INVENTORY.md#保留的边界与限制)。AI 音频读取复用播放会话 URL；切换、停止、失败和断开时取消旧读取，迟到回调不能恢复已释放地址。

## 代码与验证入口

| 职责 | 入口 |
| --- | --- |
| 会话与业务副作用 | [desktopPlayback.ts](../apps/desktop/src/main/player/desktopPlayback.ts)及同目录测试 |
| 内核包装 | [libmpvPlayback.ts](../apps/desktop/src/main/player/libmpvPlayback.ts)、[native](../apps/desktop/src/main/player/native) |
| 本机续播 | [playbackResumeStore.ts](../apps/desktop/src/main/player/playbackResumeStore.ts) |
| 返回与交互 | [路由规范](ROUTING_DESIGN.md#overlay-history) |
| Windows 原生验证 | [Windows 记录](BUILTIN_PLAYBACK_WINDOWS_ACCEPTANCE.md) |
| 字幕 fixture 与像素检查 | [字幕说明](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md)、[PGS 记录](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md) |
| 历史开发与平台适配 | [实施记录](reviews/builtin-playback-implementation-2026-10.md)、[平台记录](archive/playback/platform-validation-2026-10.md) |

按改动选择真实会话、原生关闭、素材、字幕或远程连接检查，命令见开发指南。已有记录不代表任意格式、声音听感、物理 GPU、跨屏设备或独立干净机器已经验收；正式分发的源码、许可及签名门禁仍独立执行。
