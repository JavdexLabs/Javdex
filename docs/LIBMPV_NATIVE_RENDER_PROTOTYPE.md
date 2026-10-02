# libmpv + 原生渲染可行性验证

日期：2026-10-02。分支：`codex/libmpv-native-render-prototype`。

## 问题与结论

本阶段只回答：**Electron 桌面端能否用同一个 libmpv 播放内核播放本地文件与远程媒体库的原始视频，并把画面原生渲染到应用窗口内？**

结论：**在本机 macOS arm64 上已验证可行，可以进入正式接入设计；不是成品播放器或跨平台验收通过。** Web 未改，正式应用入口、播放行为和正式资料库未改，服务器未增加转码。原型独立启动，不是外部 mpv 进程的窗口嵌入，也不是 HTML `<video>`。

这是一次性原型，不应直接合入 main 当作生产实现。

## 运行

开发前提：npm 依赖、Xcode Command Line Tools、Homebrew mpv/FFmpeg，以及当前 Electron 的 Node API headers。缺少 headers 时运行 `npm run setup:desktop`。本轮已获用户许可安装 `brew install mpv`；Homebrew 同时安装/升级了所需依赖，未打包这些系统库。

```sh
# 交互窗口；默认暂停，可选择本地/远程 H.264 或 HEVC
npm run prototype:libmpv

# 自动验证，失败退出非零，成功后自动关闭
npm run prototype:libmpv -- --smoke

# 仅远程传输夹具测试，不代表视频解码验收
node scripts/run-electron-tests.mjs apps/desktop/src/main/player/libmpvPrototype/remoteFixture.test.ts
```

生成的原生 addon、隔离 Electron bundle、合成视频、帧截图及 `smoke-report.json` 位于被 Git 忽略的 `out/libmpv-prototype/`。每次启动使用系统临时目录下新的 `javdex-libmpv-prototype-*` 目录；远程 SQLite 与凭据只存在该隔离目录。关闭会释放播放器、撤销凭据并关闭 HTTP/数据库；临时目录保留供检查，不会删除传入媒体或正式数据。

原型给复制的 Electron bundle 设置独立标识 `com.javdex.libmpv-prototype`，以免 GUI 检查误选用户正在运行的正式 Electron 窗口。它不是安装包，也没有完成签名、公证或分发验证。

## 接入边界

| 层 | 原型职责 |
| --- | --- |
| `prototype.html/js/css` + `preload.cjs` | 密集控制栏和状态；只提交来源 ID、受限控制指令与视口矩形；使用正式语义样式 token |
| `main.ts` | 独立宿主，校验 IPC；解析本地文件或远程 PlayGrant；控制生命周期；URL/凭据不交给 renderer |
| `nativeBridge.mm` | Node API 原生桥，NSOpenGLView/CGL + libmpv OpenGL render API；VideoToolbox 解码，CoreAudio 输出 |
| `remoteFixture.ts/remoteFixtureWorker.ts` | 隔离 Worker 中运行真实 WebServer、管理鉴权、SQLite catalog、PlayGrant 和 Range 文件流；不启动正式应用 |

本地路径与远程 `playbackHandle` 仅在 main/native 内进入同一个 `loadfile` 路径。没有服务器解码、转封装、转码或任意 URL 代理，也没有为 Web 添加写入权限。

libmpv 回调只置原子通知标记。Electron 主循环约每 16 ms 处理更新并绘制，控制采用异步 libmpv command，状态采用观察事件和零超时事件读取。渲染上下文先于 core 销毁，关闭可重复调用。正常播放不把帧拷到 JavaScript；smoke 的一次性 framebuffer 读回仅用于证明真实画面，不等于证明整条 GPU 链路零拷贝。

依据：mpv 官方 [OpenGL render API](https://github.com/mpv-player/mpv/blob/master/include/mpv/render_gl.h)、[render API 线程/生命周期约束](https://github.com/mpv-player/mpv/blob/master/include/mpv/render.h)、[异步客户端 API](https://github.com/mpv-player/mpv/blob/master/include/mpv/client.h)。实际编译使用本机 mpv 0.41 的 headers，不是把 master 文档当成已安装版本。

## 已验证证据

环境：macOS 26.5 arm64、Electron 43.4.1、Homebrew mpv 0.41.0、FFmpeg 9.0.2。素材是 18 秒、1280×720、30 fps 合成图案和 440 Hz AAC 音轨。

最终严格 smoke 退出 0。四条路径都实际加载并绘制出图案，运行状态报告 `hwdec-current=videotoolbox`、`current-ao=coreaudio`，不是仅检查配置值。

| 来源 | 容器/编码 | 精确跳转后暂停位置 | 一次性原生帧读回颜色数 |
| --- | --- | --- | --- |
| 本地 | MP4 / H.264 + AAC | 10.000 s | 1638 |
| 远程 | MP4 / H.264 + AAC | 10.000 s | 1638 |
| 本地 | MKV / HEVC Main10 + AAC | 10.000 s | 1938 |
| 远程 | MKV / HEVC Main10 + AAC | 10.033 s | 1924 |

还检查了：

- 播放后的音视频时钟推进；暂停后时钟稳定；音量设置生效。
- 窗口缩放后原生区更新到 2200×1095 像素；全屏更新到 3840×1719，退出后恢复。此处是渲染区大小，不是 4K 视频解码验收。
- 同一窗口重建播放会话 3 次；销毁后 native `alive=false`，HTTP 活跃请求为 0。
- 真实管理鉴权：缺少/错误 Bearer 返回 401；缺少/错误播放凭据返回 404；合法 HEAD 200、Range 206，测试片段与原始文件字节相等。
- 扣除启动探针后，播放器自身产生 5 次播放请求、5 次 Range 请求、34,393,224 个响应正文媒体字节。统计是服务端提交的字节，不宣称这些字节都被播放器消费。
- 独立夹具测试通过：双夹具隔离、关闭端口、原媒体不变，父进程数据库的哨兵内容及路径不变。
- 在真实原型窗口中手动检查了播放/暂停、±5 秒（9.8→14.8 秒）、远程 HEVC 来源切换、全屏/退出、会话重建；GUI 截图可见原生图案和窗口内控制栏，控制栏没有被原生视图遮住。
- HTML 弹层打开时隐藏原生视图，关闭后画面恢复；这只是显式避让策略，**不是 HTML 与视频任意叠层合成通过**。

声音只证明解码、音频时钟和 CoreAudio 输出路径工作，没有人工听感或音视频同步精度验收。`nativeFrames` 是绘制次数，不能当作解码帧数或性能基准。

以上数值是一次严格通过运行的记录，不是每轮完全相同的性能指标。另已通过 Node 类型检查、原型 TS ESLint、编码及桌面/服务端架构边界检查；没有把它作为完整产品测试或发布验收。

## 验证中发现并修正的陷阱

1. 每个 mpv 更新都用 GCD 立即驱动 AppKit 绘制，会拖延 Electron/Node 的控制事件。初轮宽松测试虽有画面，但严格跳转测试失败。改成主循环定时处理通知，并避免等待未来展示时间后，严格测试通过。首次宽松结果不作为最终跳转证据。
2. Node `fs.cpSync` 默认会把 framework 相对符号链接改成指向原包的绝对链接，隔离 bundle 的 helper 找不到 ICU 资源。生成运行时改为保留原始相对链接；未改用户正式 Electron 包。
3. 仅等待“位置 ≥ 10 秒”会让 EOF 或旧缓存状态误通过。最终测试先复位到 0、确认实际播放和时钟推进，再要求新的 playback restart 且位置接近 10 秒，并检查暂停稳定。

## 尚未验证 / 正式接入前需要决策

- **Windows/Linux**：原生视图宿主、GPU 上下文和线程实现另做适配；不能从 macOS 外推已支持。
- **macOS 渲染寿命**：当前 CGL/OpenGL 路线已运行，但 Apple 已弃用 OpenGL；这是长期维护风险。主线程定时绘制仅证明原型可用，长时间/高帧率/复杂页面负载下是否需要独立渲染线程尚未测量。
- **UI 合成**：控件固定在视频区外；字幕可由 mpv 合成，任意 HTML 弹层不能直接盖住原生视图。生产版需要确定采用原生视频独立窗口还是固定区域，以及弹层避让策略。
- **分发**：仍依赖开发机 Homebrew 动态库；没有选择可再分发的库构建、封装依赖、公证与更新机制。mpv 和依赖的许可证需按实际构建审核，当前仓库 MIT 不能自动覆盖它们，见官方 [Copyright / LGPL 构建说明](https://github.com/mpv-player/mpv/blob/master/Copyright)。
- **产品链路**：未接正式媒体库的播放按钮，未改变“稍后观看”等写入时机，未增加进度持久化或跨端历史。
- **媒体覆盖**：未验证真实长片、4K/HDR/杜比视界、DTS/TrueHD、多音轨、字幕选择、倍速、外接显示器、多窗口、内存泄漏长期趋势。
- **网络与服务器部署**：远程端是同机真实服务夹具，不是独立 Node/Docker 部署验收；未覆盖真实 LAN/HTTPS、凭据过期续签、断网重试、限速或故障注入。

建议下一步先确认原生播放区域/弹层策略和 libmpv 分发方案，再提取小型正式播放会话接口，接入已有 `playerService` 的本地/远程来源解析；不要直接推广原型 UI 或把平台适配、分发问题藏进通用前端播放器。
