# 共用内置播放器技术研究与接入建议

研究日期：2026-10-02。目标：Web、桌面本地媒体库、桌面远程媒体库共用播放器，端侧解码，服务器不转码。本文结合官方文档、源码及当前仓库实现，不是已验收实现；目标浏览器、编码档次/位深、LAN HTTP 有声与 seek、4K 性能、资产体积及维护指标均待实测，许可与支持表须随锁定版本复核。

结论：三模式共用 UI+Engine 契约可行，不代表唯一后端或兼容性相同。建议原生/MSE 优先，封装现成端侧引擎补软解。普通 LAN HTTP 手机/电视全覆盖 MKV+HEVC+DTS、服务器绝不转码，不能承诺；HTTP 并不禁止单线程 WASM。

## 能力边界

HTMLMediaElement 管理播放、缓冲、同步与 seek，实际解码由浏览器负责；类型探测不能替代播放验证。[HTML](https://html.spec.whatwg.org/multipage/media.html) MediaCapabilities 按编码、分辨率、码率及帧率预测支持/流畅/省电，不增加解码能力。[规范](https://www.w3.org/TR/media-capabilities/) MSE 向媒体元素追加受支持的分段，仍依赖浏览器解码；端侧 remux 能补容器，不能补缺失 codec。[规范](https://www.w3.org/TR/media-source-2/) WebCodecs 只提供编码包与帧/音频数据之间的转换，需另配解封装与播放引擎；不强制支持 codec，硬件偏好亦非保证。[规范](https://www.w3.org/TR/webcodecs/)

MP4+H264/AAC 是优先验证基线；HEVC、VP9、AV1 须按系统、编码档次、位深及分辨率探测。Chromium 已列 Matroska，“MKV 一律不能原生播”不准确；MKV/AVI 无跨端保证，普通 MP4 也不等于 MSE 分段。[Chromium](https://www.chromium.org/audio-video/)、[编码支持](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)、[字节流](https://www.w3.org/TR/mse-byte-stream-format-registry/)

AAC 覆盖较广，AC3 依赖客户端；Jellyfin 将四大桌面浏览器 DTS 列为不支持，测试范围有限。电视原生应用/直通能力不能外推到网页。[音频表](https://jellyfin.org/docs/general/clients/codec-support/#audio-compatibility)

## HTTP、传输与成本

私网 HTTP IP 不享有 localhost/loopback 例外。[安全上下文](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) WebCodecs 与 AudioWorklet 要求安全上下文。[WebCodecs](https://www.w3.org/TR/webcodecs/)、[AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) WASM 共享内存线程还需跨源隔离，常用 COOP: same-origin、COEP: require-corp，跨源资源须满足 CORS/CORP；单加响应头不能升级 HTTP。[共享内存](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)、[隔离](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) HTTPS 页面访问 HTTP 媒体仍有混合内容限制。[规范](https://www.w3.org/TR/mixed-content/)

libmedia 文档明确无共享内存时可回退；源码在已加载解码资产时可选 WASM，无 AudioWorklet 时改用 AudioSourceBufferNode，通过普通 Web Audio 缓冲源输出。单线程路线有源码依据，WebCodecs/共享内存线程可作增强；普通 Worker 与 WASM 多线程不同。[说明](https://github.com/zhaohappy/libmedia/blob/master/README.md)、[视频管线](https://github.com/zhaohappy/libmedia/blob/master/packages/avpipeline/src/VideoDecodePipeline.ts)、[音频回退](https://github.com/zhaohappy/libmedia/blob/master/packages/avplayer/src/AVPlayer.ts#L2398)、[缓冲节点](https://github.com/zhaohappy/libmedia/blob/master/packages/avrender/src/pcm/AudioSourceBufferNode.ts) 普通 LAN HTTP 的实际有声播放、连续 seek 和流畅性未验证，不能仅凭回退代码承诺。

跨源 JS fetch 需 CORS；Authorization 须显式允许/预检，仅安全列表内单段 Range 可免预检；读 Content-Range 等须 expose，原生 src 规则不同。[Fetch](https://fetch.spec.whatwg.org/#cors-protocol) 随机读取需验证 206/Content-Range、416、文件一致性及 seek 索引。[HTTP](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)

音频时钟、随机访问点起解、seek 取消/清队列和帧释放应交给现成引擎。[解码](https://www.w3.org/TR/webcodecs/#videodecoder-interface)、[调度](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs) FFmpeg 移植 WASM 属软解，SIMD/线程不等于视频硬解。按 3840×2160×4 算，RGBA 单帧约 33.2MB，30fps 一次整帧搬运约 1GB/s，是算术量级而非实测/网络码率；队列、色彩转换、发热耗电待测。

## 候选与决策

- WebAV/av-cliper（MP4Clip）偏 MP4 编辑；依赖 mp4box/OPFS，不是通用 HEVC/DTS 播放器。当日 MIT；编辑示例不能证明电视流播成熟度。[定位](https://github.com/WebAV-Tech/WebAV)、[资产](https://github.com/WebAV-Tech/WebAV/blob/main/packages/av-cliper/package.json)、[许可](https://github.com/WebAV-Tech/WebAV/blob/main/LICENSE)
- libmedia/AVPlayer 最接近完整候选，列 MKV/AVI 及本题各 codec，兼有 MSE/WebCodecs/WASM；覆盖是官方自述。安装须复制动态 JS，另托管不随 npm 发布、与包版本配套的分 codec WASM。[格式](https://github.com/zhaohappy/libmedia/blob/master/README.md)、[安装](https://github.com/zhaohappy/libmedia/blob/master/site/docs/guide/player.en-US.md)、[WASM](https://github.com/zhaohappy/libmedia/blob/master/site/docs/guide/wasm.en-US.md) 根许可为 LGPLv3，README 标注部分编码资产含 GPL；源码头写“3.1”与根许可不一致，具体版本须核对。[许可](https://github.com/zhaohappy/libmedia/blob/master/COPYING.LGPLv3)、[源码头](https://github.com/zhaohappy/libmedia/blob/master/packages/avplayer/src/AVPlayer.ts#L9) 修复记录涉及 seek/解析/音频，仍须验证稳定性。[记录](https://github.com/zhaohappy/libmedia/blob/master/Changelog)
- LibAV.js 支持异步 I/O，但不是现成播放器。默认变体有限，WebCodecs 变体的部分 parser 不含 decoder；软解可能须自编，另部署入口/WASM/Worker。wrapper 为 0BSD，FFmpeg 构建另适用 LGPL 等。[官方说明](https://github.com/Yahweasel/libav.js)
- ffmpeg.wasm 示例是写文件→执行→读出→播放，适合离线处理，不是成熟流播放器。该示例 core 约 31MB；wrapper 为 MIT，core 随 FFmpeg/依赖构建许可变化。[用法](https://ffmpegwasm.netlify.app/docs/getting-started/usage/)、[许可](https://ffmpegwasm.netlify.app/docs/faq/)
- hls.js 做 HLS/transmux，video.js 提供播放器层，均不补 codec；资产为 JS、后者另有 CSS。当日均 Apache-2.0。[hls.js](https://github.com/video-dev/hls.js)、[video.js](https://github.com/videojs/video.js)、[hls 许可](https://github.com/video-dev/hls.js/blob/master/LICENSE)、[video.js 许可](https://github.com/videojs/video.js/blob/main/LICENSE)

工程推断：共享 UI+Engine 可选择原生/MSE/现成软解；统一封装 AVPlayer，其内部仍多后端。强制唯一 WASM+WebCodecs 增加资产与性能负担，HTTP 须回退。优先复用引擎维护同步/seek，承诺限定实测设备、样本和性能。维护响应及回归覆盖未量化，须作为选型门槛。

Jellyfin Direct Play 要求容器、音视频与字幕兼容；Direct Stream 可能仍转音频，不是“服务器零转码”。不兼容须端侧处理或失败。[机制](https://jellyfin.org/docs/general/clients/codec-support/) 本文不作版权或专利法律结论。

## Javdex 现有实现与接入设计

以下是对当前仓库的代码核对及建议，**不是已经实现的播放器**。研究基线为 `dev` / `898a871`，Javdex 0.8.0，锁定 Electron 43.4.1；浏览器解码能力不能仅由 Electron 版本推断。

### 可以复用的部分

| 模式 | 当前播放链路 | 共用播放器需要的 Source Adapter |
|---|---|---|
| Web（桌面提供网页或独立服务端提供网页） | 原生 `<video>` + 同源只读 Cookie + `/api/videos/:videoId/media/:resourceId` | 仍通过原来的资源 ID 和浏览器会话读取原始流，不借用管理凭据 |
| 桌面本地媒体库 | 主进程查找资源，`shell.openPath` / `shell.openExternal` | 主进程将受控资源 ID 解析为临时播放会话，经专用媒体协议提供文件流；不依赖开启局域网网页服务 |
| 桌面远程媒体库 | 主进程签发 PlayGrant，再将 URL 交给外部播放器 | 复用 PlayGrant，由桌面主进程通过专用媒体协议桥接授权字节流；renderer 不获得原始授权 URL |

代码依据：[WebDetailPage](../apps/web/src/WebDetailPage.tsx)、[playerService](../apps/desktop/src/main/services/playerService.ts)、[PlayGrant 合同](../packages/contracts/src/protocol/play.ts)、[播放授权与资源检查](../packages/library/src/catalog/catalogPlay.ts)。

- [sendFile](../packages/http/src/http.ts) 已有 GET/HEAD、单段 Range、200/206/416、流式发送以及打开文件描述符后的身份复核；[play HTTP](../packages/http/src/play.ts) 按凭据跟踪连接，可在授权撤销时关闭相应流。服务端可以继续只做授权、原始字节读取和静态资源交付，不运行解码、重封装或转码任务。
- [WebCatalog](../packages/http/src/catalog.ts) 已包含 MKV MIME，但当前 `playable` 主要由扩展名、根目录和资源类型推导。它表示可提供媒体源，不证明当前设备能解码。未来应分开“有权限读取原始流”和“本设备具备播放能力”；AVI 等新增容器需要明确调整传输资格，不能只修改提示文字或把下载接口当播放权限绕过。
- [mediaProtocol](../apps/desktop/src/main/services/mediaProtocol.ts) 是图片读取协议，返回完整图片 Buffer。不能把长视频塞进图片读取或 IPC ArrayBuffer：要复用资源身份守卫，另建有背压、Range 和取消能力的流式媒体会话。

### 共用 Module，而不是三套播放器

建议新增浏览器可用的 `packages/player` Module，供两个 renderer 入口使用，不导入 Electron、Node、数据库或 `CatalogBackend`：

- 对外 Interface 只表达加载一个播放源、播放/暂停、跳转、轨道选择、销毁和状态/错误事件。UI 控件、能力判断、播放重试、缓冲、解码策略和清理留在同一 Implementation；不向各页面暴露解码队列和状态 setter。
- Source Adapter 是实际变化的 Seam：Web Cookie 源、桌面本机受控源、桌面远程授权源。调用方提供资源身份及源解析能力，播放器只消费受控 URL/流；不在播放器里写 `if (remoteMode)` 或查询资料库。
- 原生播放与增强引擎是 Module 内部的策略。优先复用 AVPlayer 等已有 Implementation 的同步、seek 和解码队列，不自己拼出一套 FFmpeg 调度器。即使统一采用 AVPlayer，也应隐藏其接口，便于替换而不重写两个应用。
- 初次加载、资源切换和销毁必须取消旧请求、释放 Worker/解码器/VideoFrame/音频节点/Object URL。seek 要丢弃旧代次帧并从关键帧重新同步，内存受缓冲策略限制，不能随视频时长增长。资源失效或认证失败不能当成“换个解码器”的理由。
- 桌面可保留“用外部播放器打开”作为明确的用户操作；Web 保留下载/打开外链。不自动切换另一影片资源，保持 [ADR-0014](adr/0014-unified-video-resource-runtime-contract.md) 的主资源与失败语义。

这是使用 `codebase-design` 的深 Module 取向：把播放复杂性集中在一个小 Interface 后面，三种 Source Adapter 只承担授权和字节访问。

### 不能忽略的安全与构建工作

1. **远程授权 URL 不能直接塞进 renderer。** 合同明确 `playbackHandle` 不向 renderer 显示；[server](../packages/http/src/server.ts) 的 Host/Origin/Fetch Metadata 守卫也位于播放路径之前，不能假定跨源渲染页的 video/fetch 请求会通过。主进程应保存 grant，只允许临时会话对应的 GET/HEAD 与单段 Range，桥接允许的状态和媒体响应头，不转发 writer secret、浏览器 Cookie 或任意 renderer 请求头，不开放任意 URL 代理。授权过期/源变化后停止或显式重新解析，不放宽旧凭据。
2. **本机文件不是任意路径协议。** 临时会话绑定资源 ID、所属媒体库及可信调用窗口，文件读取按当前根目录/文件身份复核；旧版无根资源不能为了“统一”静默获得 Web 权限，可维持外部打开能力并明确提示整理根目录。取消请求应关闭上游流和文件描述符。
3. **Electron 专用协议需要单独验收。** 官方支持 `protocol.handle` 返回 Response，并通过 `stream` / `supportFetchAPI` 配置媒体和 fetch；还需按播放器窗口所用 session 注册。建议保留 `contextIsolation`、sandbox 和 `nodeIntegration: false`，不启用 `bypassCSP` 或关闭 `webSecurity`。协议 URL 不含磁盘路径或远程 grant token，来源检查应适配锁定 Electron 版本、开发 URL 与生产页，而不是复制不受信任的 referrer。[Electron protocol](https://www.electronjs.org/docs/latest/api/protocol)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)
4. **当前 Web 构建尚不能直接承载增强引擎。** HTTP 静态白名单只有 `assets/*.js|css|png`，没有 wasm；Web CSP 未允许 WASM 编译及 MSE 常用的 blob 媒体地址。必须仅为实际打包资产扩充白名单和 MIME（如 `application/wasm`），定向配置 script/worker/media/connect 策略，不把整棵目录开放。桌面 [CSP](../apps/desktop/src/renderer/index.html) 已有 `wasm-unsafe-eval` 与 blob Worker，但媒体协议及 fetch 仍需显式纳入适当策略。
5. **HTTPS 不只是加一个反向代理。** 当前产品只接受局域网 HTTP 字面主机和同源 Origin，不信任转发头；HTTPS/自定义域名入口需要明确的部署和认证设计，不能在本任务中悄悄放宽。COOP/COEP 还会影响外链媒体、图片与 Worker，应按资源逐项核对，而不是为了线程性能直接全站开启。
6. **解码器不能拖进服务器生产依赖。** Worker/wasm 随 Web/桌面静态资源分发，按需加载，不进入 renderer 首屏静态闭包；服务端只交付这些资源。沿用 [生产依赖检查](../scripts/check-server-production-closure.mjs) 和 [renderer 体积报告](../scripts/renderer-bundle-report.mjs)，另记录增强引擎、每种 wasm、首播加载与内存的实际代价。

### 与现有领域合同的关系

这是建议，不修改 accepted ADR。实施时应明确更新 [ADR-0027](adr/0027-isolate-read-only-lan-web-access.md) 中“原生视频播放”的策略；若决定新增 HTTPS，再单独记录网络入口决策。[ADR-0029](adr/0029-server-mode-extends-root-and-web-isolation.md) 的只读浏览面、主进程管理秘密、无服务器转码/任意 URL 代理仍保留。

当前 [playerHandlers](../apps/desktop/src/main/ipc/playerHandlers.ts) 在外部播放器接受请求后执行“从稍后观看移出”。内置播放的“请求被接受”和“实际开始播放”不再相同，应将这一宿主动作绑定到有效播放会话的首次开始事件，避免源准备成功但解码失败就移出；Web 不获得此写权限。不自动加入跨端观看记录、进度同步、数据库迁移或追踪上报。

## 建议推进顺序与验收门槛

本轮只研究，没有安装引擎、运行解码原型、用用户影片测试或完成三端验收。以下是后续候选计划，不表示授权开始实现。

| 阶段 | 内容 | 通过条件 |
|---|---|---|
| P0：确定范围和引擎 | 明确目标设备/格式；验证 AVPlayer 的许可、构建、源 IO、HTTP 单线程音频与硬解选择；与轻量原生策略对比 | 用合成/获授权样本实际有声播放、seek；输出支持与不支持矩阵。未过则不锁定库 |
| P1：共用播放器与三种源 | 共用 Module + 控件/状态；接入 Web Cookie、本机媒体协议、远程 grant 桥接；先使用原生可播放样本 | 同一 MP4 H.264/AAC 在三种入口实际播放、暂停、跳转、关闭；无凭据/磁盘路径泄漏；未开 LAN 服务也可本机播放 |
| P2：端侧增强 | 按已确认范围加入解封装、WebCodecs/MSE 及必要 WASM 解码；按需交付 wasm/Worker | MKV/AVI 等容器及指定编码逐项验收，音视频同步和轨道行为有证据；不新增服务端媒体处理 |
| P3：真机与资源治理 | 真实桌面平台、iOS/Android/目标电视；长视频、4K/10-bit（若纳入）、频繁 seek、权限撤销和源变化 | 记录首播/seek 延迟、CPU/GPU、内存、掉帧、持续播放同步；不把模拟视口、加载事件或截图当解码通过 |

基准样本至少分开覆盖：MP4 H.264/AAC；MKV H.264/AAC（容器问题）；MKV HEVC Main10 + AAC（视频编码/10-bit 问题）；H.264 + AC3/DTS（音频问题）；MP4 尾部索引及 MKV 缺失索引（随机读取问题）。4K/HDR、多音轨、内嵌/外部 SRT/ASS 等只在用户确认后纳入必达项。对于普通 HTTP 浏览器，单独记录 WebCodecs/AudioWorklet/线程可用性和有声软件回退结果。

## 实施前需要用户确认

1. **格式与设备**：哪些组合必须播放？尤其 MKV、AVI、HEVC/10-bit、AC3/DTS，以及手机、电视是否为必达客户端。
2. **能力下限**：能否在弱设备上明确“不支持/性能不足”并提供下载或外部打开？若要求所有目标设备均流畅播放任意 4K 编码，当前约束下没有可承诺的通用方案。
3. **网络入口**：继续仅局域网 HTTP，还是允许单独设计 HTTPS？HTTP 下可做原生/MSE和部分软件路径，但不能把安全上下文增强能力作为默认能力。
4. **功能范围**：首版是否只包含播放、进度、音量、倍速、全屏及必要轨道选择；字幕、高级 HDR、多设备播放进度另行确认。是否接受引入符合分发要求的 LGPL/其他解码器产物，必须在锁定依赖前确认。

**推荐起点**：先做 P0 的短验证，再做 P1 共用播放器与原始流接入；若需要覆盖 MKV/HEVC/DTS，则优先验证 libmedia/AVPlayer，而不是只换 video.js 的外观。始终以目标设备的实际播放证据决定支持范围。
