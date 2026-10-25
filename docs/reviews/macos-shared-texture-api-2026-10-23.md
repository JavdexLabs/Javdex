# macOS 共享纹理 API 与 DOM 消费路径调查

历史调查：当前正式采用 Canvas2D，未采用的消费候选已退出活动代码；见 [正式化记录](macos-canvas-default-2026-10-23.md)。这里的固定 API／引用研究保留，不把候选建议当作已实现或已测收益。

2026-10-23，适用 Javdex `a994e5169d00d6016731486ee681997cc65695dd` 及调查时已有的未提交性能修改。结论是：完整释放后可以复用原生 IOSurface 槽位；没有公开合同证明可以把一个长期存活的 Electron 导入对象当作不断更新的生产者帧。固定版本也没有接收原生 CGL fence 的公开入口。消费端可优先考虑 WebGL、其次 bitmaprenderer，再考虑生成视频轨道；三者都不能据此预先宣称消除复制或改善 CPU。

本调查仅涉及 API、引用及同步边界。没有执行应用修改、测试、构建、GUI、采样或基准测量，也不继承其他评审的性能结论。

## 固定版本与来源边界

仓库 [package.json](../../package.json) 固定 Electron `43.8.0`。上游 [v43.8.0 对应提交][e-commit] 为 `071a136f896e2a4b6c4dacc65bee38678f00e0bd`；其 [DEPS][e-deps] 指定 Chromium `150.0.7871.250`，对应 [Chromium 提交][c-commit] `f916f1b7136907af19d96b95b891533d091d932a`。下文 Electron 引用固定 tag，Chromium 引用固定此提交，不用最新版实现替代。

Electron 还有 [Chromium patch 清单][e-patches]。该清单中的补丁没有修改下文所依赖的 frame 引用、generator 写入、WebGL 上传和 compositor release token 函数；相关 [breakout box 补丁][e-breakout-patch] 修复 processor 的跨上下文 source 转移，不是这里采用的 Window generator 写入路径。Electron 内部设计 README 自称基于 Electron 37／Chromium 137，因此同步结论采用 43.8.0 文档和实际代码。[设计 README][e-design]

## 支持范围

这里的“支持”指固定公开 API 的合同；“实现支持”指固定源码可追踪的行为；“未证明”不能作为回收或性能优化的依据。“不可行”仅限定于固定版本的公开 API。

| 操作 | 判断 | 原因 |
| --- | --- | --- |
| 对同一份有效且未改写的纹理，多次取得 VideoFrame 或转移引用 | 支持 | 每份引用分别释放；`getVideoFrame` 创建当前进程的 frame。[导入对象][e-imported]、[subtle 对象][e-subtle] |
| 旧帧 `allReferencesReleased` 后，在同一原生槽位生产下一帧并重新导入 | 支持的所有权组合 | 下一轮仍须先完成生产；上一轮消费者已全部退出。回调是该次导入的终点，不是生产完成信号。[sharedTexture][e-api] |
| 释放后重新使用同一个 Electron 导入对象 | 不可行 | 释放后的包装对象拒绝 `getVideoFrame` 和 transfer；重新导入产生新的对象。[C++ 方法][e-native-methods] |
| 把已有导入对象改绑到另一 IOSurface、尺寸或格式 | 不可行 | 公开方法没有更新或替换 handle 的入口。[导入信息][e-info]、[subtle 对象][e-subtle] |
| 长期保留每槽导入对象，消费者回调后改写同一 IOSurface 内容 | 未证明为受支持协议 | 有消费者退出信号不等于有外部内容更新协议；下一节解释缺口。 |
| 消费者还持有 frame 时覆写槽位，或按相同指针值命中缓存后复用 | 不满足本项目所有权要求 | JS 对象关闭不代表其原生 frame 及 GPU 使用已经结束。[Blink handle][c-handle]、[原生 frame 生命周期][c-frame] |

## 导入与释放生命周期

### 公开合同

`importSharedTexture` 的 `allReferencesReleased` 表示所有进程的引用都已释放，源纹理必须保持有效直到回调。`getVideoFrame` 产生一个使用该纹理的对象；`VideoFrame.close()` 后，底层资源仍按内部 GPU 同步等待。`release()` 释放的是本对象的引用，不能替代其他 frame 或导入对象的释放。[sharedTexture][e-api]、[导入对象][e-imported]

`startTransferSharedTexture` 产生可序列化的 opaque transfer；`finishTransferSharedTexture` 在目标进程取得新对象。subtle 使用者必须释放每一个对象。目标的 `release(callback)` 是文档明确提供的依赖资源释放点，允许从回调通知源进程继续释放。[subtle 对象][e-subtle]、[transfer 结构][e-transfer]

### 固定实现

`ImportedSharedTexture` 是 `RefCountedThreadSafe`。`getVideoFrame` 用 `WrapSharedImage` 创建 `media::VideoFrame`，其 mailbox release callback 持有导入结构；包装对象 `release` 只清除自身引用。各原生 frame 析构时交回各自的 release token；最后一个引用退出后，导入结构析构，更新 SharedImage destruction token，并经 `SignalSyncToken` 触发 callback。GPU context 不可用时存在直接运行 callback 的分支，不能把故障回调当成健康 GPU 完成的独立证明。[Electron C++ 生命周期][e-native-lifetime]

Blink 的 `clone()` 创建另一个 handle，持有同一个 `scoped_refptr<media::VideoFrame>`；`close()` 只清除该 handle 的引用。`WrapVideoFrame` 也保留被包装 frame，release token 更新会向内转发。因此一个 JS frame 已关闭，仍可能有 clone、内部任务或 compositor 继续持有原生 frame。[Blink handle][c-handle]、[原生 frame 生命周期][c-frame]

### 两种 SyncToken 不可混用

| token | 固定实现中的作用 | 不能证明什么 |
| --- | --- | --- |
| import 的 `frame_creation_sync_token` | 来自创建 SharedImage 的 token | 不包含外部 CGL 绘制完成的通知。 |
| finishTransfer 后的 creation token | 在导入目标 SharedImage、等待源 token 后生成，代表目标 GPU 侧取得引用的顺序 | 不表示目标已经完成消费。 |
| frame 的 release token | 消费路径更新，原生 frame 析构时交回 Electron | 不是生产者 fence，也不是屏幕呈现时间。 |

前两行由 [C++ import 与 transfer][e-native-transfer] 确定。`getFrameCreationSyncToken` 回传源端并调用 `setReleaseSyncToken`，用于防止源端早于异步取得引用而释放；公开文档也允许用目标释放回调串联生命周期。[同步方法合同][e-subtle] 第三行由 [media::VideoFrame][c-frame] 的 release callback 与 token 更新确定。`SignalSyncToken` 的底层合同是 token 被 signal 后运行 callback，不能延伸为物理上屏证明。[ContextSupport][c-context]

高层 JS 会在 renderer 完成导入时回复 creation token，main 设置 release token 并登记 renderer 引用；renderer 的释放回调再通知 main 撤销引用。`sendSharedTexture()` 的 Promise 是转移完成，另有固定 1000ms 超时，不是消费完成。[main JS][e-main-js]、[renderer JS][e-renderer-js]

本地 [macSharedTexture.ts](../../apps/desktop/src/main/player/macSharedTexture.ts) 使用 main 高层 import 加手工 subtle transfer；[sharedTextureReceiver.ts](../../apps/desktop/src/preload/sharedTextureReceiver.ts) 关闭 frame 后调用目标 subtle release，在回调中发 ACK；main 收到 ACK 才释放原始 import，最后 `allReferencesReleased` 归还 native ticket。高层引用表不会自动登记这次手工 transfer，手工 ACK 链因而是这里不可省略的依赖。本地 [CGL 生产端](../../apps/desktop/src/main/player/native/macSharedTexture.mm) 在导出前使用 `glFinish`。这些是所有权上下文，不是新增评审或验收结果。

### 持久导入缺少的协议

保持 main 导入引用不释放，就不会收到该次导入的 `allReferencesReleased`。可以设想每轮只释放 renderer 对象，再等待其 callback；这证明的是那一轮目标引用退出，不能自动变成整个持久对象的每帧释放回调。[main JS][e-main-js]、[subtle 合同][e-subtle]

更关键的是 Chromium 原生接口专门提供 `UpdateSharedImage`，用于 GpuMemoryBuffer 被 CPU 或外部设备修改后通知更新，并有可带 acquire fence 的重载；Electron 公开对象没有对应方法。[SharedImageInterface][c-sii] 因此“同一地址、先等消费者、再 `glFinish`、再次取 frame”仍缺少公开的外部更新及重新取得内容合同。它可能在某一后端工作，但不能从现有源码推导为跨帧安全保证。不同帧实际换了 IOSurface 时，旧对象更不会跟随指针变量改绑。要保留本项目每轮 `allReferencesReleased` 边界，采用完整释放后的新导入。

## 原生 CGL 异步同步的边界

没有公开参数接收 `GLsync`、CGL context、原生 fence handle 或 Metal shared event。macOS handle 只有本进程有效的 `IOSurfaceRef` Buffer；导入信息没有 producer acquire fence。[handle 合同][e-handle]、[导入信息][e-info]

`setReleaseSyncToken` 接受 Chromium 的 opaque token，用途是延迟底层释放；它不把原生 GL fence 注册到 Chromium，也不能补上生产者的 acquire 同步。transfer 的 `syncToken` 同样是只读 opaque 数据。[token 合同][e-token]、[transfer 合同][e-transfer] WebGL 的 fence API 接受 `WebGLSync`，没有原生 CGL fence 导入入口。[固定 Blink WebGL2 IDL][c-webgl-sync]

结论限定为：当前 API 不能表达“尚在 CGL 执行的帧，附带 fence 交给 Chromium 异步等待”。应保留现有 `glFinish` 完成边界。若以后将原生等待移到其他线程，那仍是先确认生产完成、再发布，不是已经建立 GPU 间 fence 桥。直接操作 Chromium SharedImage 或增设 fence／update API 属于 Electron 上游改动、fork 或额外原生集成的边界；内部 C++ 接口存在不等于本 addon 可以通过公开 Electron API 使用。

## 保留 DOM 控件的消费候选

### WebGL 接收 VideoFrame

固定 Blink IDL 直接支持 `texImage2D`／`texSubImage2D` 的 VideoFrame 重载。实现先克隆内部 handle，再进入 media frame 上传；可直接复制 SharedImage 到目标 GL texture，也可能经中间 SharedImage 或软件路径。成功的直接复制路径调用 `SynchronizeVideoFrameRead` 更新源 frame 的 release token。因此这是公开的纹理上传方案，不是把 IOSurface 无复制地绑定成 WebGL texture。[WebGL IDL][c-webgl-idl]、[WebGL 实现][c-webgl]、[读取同步][c-paint-sync]

可保留现有 DOM 覆盖控件，在独立 WebGL canvas 绘制完整矩形。实验应先固定 alpha、方向、纹理尺寸和颜色转换，验证 context loss、解绑及 resize；源 ticket 仍只由原有释放链归还，WebGL draw 返回不是回收点。性能收益尚未证明。

### createImageBitmap 与 bitmaprenderer

`createImageBitmap(frame)` 接受 VideoFrame；Blink 会克隆内部 handle，经 `CreateImageFromVideoFrame` 生成图像。已有不可变 SkImage 可复用，但 Electron 导入的 SharedImage frame 走的是图像生成路径；其加速分支通过 `PaintCanvasVideoRenderer::Paint` 绘制并 snapshot，另有软件分支。[VideoFrame 图像创建][c-blink-frame]、[图像生成实现][c-image-util]

`transferFromImageBitmap` 把 bitmap 内容交给 canvas 并使输入失效，规范在这一步不要求复制；Blink 把图像交给 layer bridge 后关闭输入 bitmap。这不能消除上一步的 snapshot 成本。[HTML bitmaprenderer][html-bitmap]、[Blink bitmaprenderer][c-bitmap] 实验必须等待创建 bitmap 的 Promise，处理期间到来的 seek／解绑并关闭未提交 bitmap；不能在已有 2D context 的同一个 canvas 上直接换 context 类型。保留 frame／import 的正常释放链，不从 Promise 完成时间推导 GPU 或显示完成。

### 生成视频轨道交给 video 元素

固定 Chromium 可用的名称是 Window 上的 `MediaStreamTrackGenerator({ kind: 'video' })`，其本身继承 MediaStreamTrack，`writable` 接受 frame；可组成 `MediaStream` 交给 `video.srcObject`。构造路径直接创建 pushable source，不调用摄像头或屏幕捕获。[generator IDL][c-generator-idl]、[generator 实现][c-generator]、[HTML srcObject][html-media]

不能以规范中的 `VideoTrackGenerator` 名称代替实际支持：此版本该名称及其 Window exposure 均为 `test`，worker 实现还被代码明确拒绝。应在实际隔离 preload 中检测已有 API，不为候选打开实验开关。[运行时特性][c-features]、[VideoTrackGenerator IDL][c-vtg-idl]、[其实现][c-vtg]

引用链可以支持异步消费，但须分开理解以下事件：

1. sink 的 `write` 先取得 `scoped_refptr<media::VideoFrame>`，再关闭输入 JS frame，最后交给 source；直接路径此时即可 resolve。规范的生成轨道算法同样先给轨道 clone、再关闭输入、返回 resolved Promise。`await writer.write(frame)` 不是 compositor 或 GPU 完成。[sink][c-sink]、[生成轨道规范][stream-spec]
2. source 把原生引用移入跨线程任务。MediaStream 播放器可继续传递引用或转为其他 backing；compositor 保存当前 frame，返回的仍是强引用。JS frame 关闭不影响这些持有者。[pushable source][c-source]、[MediaStream 播放器][c-player]、[compositor][c-compositor]
3. 视频提交器通过 resource provider 把资源交给 compositor，资源从 parent 归还后才走 release。`VideoResourceUpdater` 的硬件路径把强 frame 引用绑定在 `ReturnTexture` callback 中，并用归还的 token 更新 frame；wrapped frame 会把 token 更新传给原始 frame，最终交回 Electron。正常路径因而有“持有引用及归还 GPU 依赖”的实现依据，不依赖 JS write 完成来保活。[提交器][c-submitter]、[provider][c-provider]、[资源归还][c-resource-return]、[视频资源更新][c-updater]、[原生 frame][c-frame]

如果原始 SharedImage frame 一直进入 compositor，上述链路能延续 Electron 导入结构及 release token；应用仍可在写入交接后释放本地 import 引用，让内部持有者延后 callback。若先复制／转换到另一 frame，源引用只需保护读取源的那段 GPU 工作，随后 compositor 持有的是转换结果；原始源提前于显示结束释放本身不代表错误。[Electron 生命周期][e-native-lifetime]、[视频资源更新][c-updater]

这里有实际转换风险：sink 默认启用 RGB 到 NV12 mappable frame 的 eager conversion，另一个默认特性允许不等下游 mapped-frame 信号就转换；是否触发仍取决于格式、alpha 可丢弃状态和 GPU 能力。转换绑定保留源引用；native-mappable 分支使用 GPU completion query 后交付结果。macOS 位于允许该转换的编译分支，故不能预设本项目 BGRA 一定直接进入 compositor，也不能要求转换后源 frame 一直存活到 compositor 完成。[sink 转换条件][c-sink]、[转换池][c-conversion]

尚未证明的是本机实际分支、macOS CGL／Chromium 消费组合中的最终安全回收，以及停止时最后一帧的有界释放。`SignalSyncToken` 源码证明了 token 等待，不独立证明所有后端的外部存储可覆写条件；这里应继续依赖 Electron 的公开释放合同，并保留 GPU／renderer 故障隔离。compositor 可以继续保存末帧，因此停止写入、暂停 video 或停止 track 都不能直接等同于 ticket 已归还。[ContextSupport][c-context]、[compositor][c-compositor]

流候选的先决条件是：保留每帧导入与完整 ACK 链；设置明确的微秒 timestamp 和 seek generation；限制未释放 native ticket 数量，不能用 stream 的 high-water mark 代替槽位预算；先完成写入交接再清理输入，避免 `write()` 尚在排队时手动关闭 frame。停止时取消队列、关闭未交接 frame、断开 `srcObject` 并清理 track，最后仍等待真实释放回调；回调缺失则保留隔离。音频继续由现有播放引擎负责，生成流只交付图像，需另验证与音频及已有 target-time 调度的关系。高水位为 1 是 generator 内部 stream 队列策略，不是下游全部引用的上限。[generator 实现][c-generator]、[HTML 资源释放][html-media]、[sink][c-sink]

## 有界实验顺序与准入条件

排序按改动及所有权验证成本，不代表预计性能排序。

| 顺序 | 候选 | 开始前必须满足的条件 | 仍待回答 |
| --- | --- | --- | --- |
| 1 | VideoFrame → WebGL texture → canvas | 使用已有 API；保留生产完成和逐帧释放；先确定颜色、alpha、方向与 context-loss 清理 | 是否比现有 2D drawImage 减少实际工作，而非转移成本 |
| 2 | VideoFrame → ImageBitmap → bitmaprenderer | 使用独立 canvas；处理异步取消及 bitmap 关闭；保留 GPU 释放 ACK | snapshot 是否抵消 canvas 最终替换的收益 |
| 3 | Window MediaStreamTrackGenerator → MediaStream → video | 实际 preload 可用；确认原始或转换 frame 路径；队列有界；末帧释放、seek、停止和音画调度有明确协议 | 是否避免 snapshot，是否引入 NV12 转换，以及回收和显示时序是否满足产品要求 |

三者只替换 DOM 内的画面承载元素，可继续由现有 DOM 提供播放按钮、滑杆和全屏控件。共同准入条件是消费者持有期间不改写源、迟到和异常交付不强制回收，并在以后独立实验中核对色彩、字幕、缩放及控件行为。这里不执行这些实验，也不为独立 stage-ablation harness 添加实现要求。

持久导入及原生异步 fence 桥不进入上述列表：它们需要先补齐上游合同或原生集成证明。引入新的媒体／渲染依赖需另立范围。通过 desktopCapturer／系统屏幕捕获再回灌 video 还会引入 macOS 用户授权，属于另一条产品边界，不能作为这三个现有 DOM API 候选的隐式前提。[Electron 捕获权限][e-capture]

[e-commit]: https://github.com/electron/electron/commit/071a136f896e2a4b6c4dacc65bee38678f00e0bd
[e-deps]: https://github.com/electron/electron/blob/v43.8.0/DEPS#L2-L6
[c-commit]: https://chromium.googlesource.com/chromium/src/+/f916f1b7136907af19d96b95b891533d091d932a
[e-patches]: https://github.com/electron/electron/blob/v43.8.0/patches/chromium/.patches
[e-breakout-patch]: https://github.com/electron/electron/blob/v43.8.0/patches/chromium/cherry-pick-8121a1e94492.patch
[e-design]: https://github.com/electron/electron/blob/v43.8.0/shell/common/api/shared_texture/README.md
[e-api]: https://github.com/electron/electron/blob/v43.8.0/docs/api/shared-texture.md
[e-imported]: https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-imported.md
[e-subtle]: https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-imported-subtle.md
[e-info]: https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-import-texture-info.md
[e-handle]: https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-handle.md
[e-token]: https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-sync-token.md
[e-transfer]: https://github.com/electron/electron/blob/v43.8.0/docs/api/structures/shared-texture-transfer.md
[e-native-methods]: https://github.com/electron/electron/blob/v43.8.0/shell/common/api/electron_api_shared_texture.cc#L379-L497
[e-native-lifetime]: https://github.com/electron/electron/blob/v43.8.0/shell/common/api/electron_api_shared_texture.cc#L152-L357
[e-native-transfer]: https://github.com/electron/electron/blob/v43.8.0/shell/common/api/electron_api_shared_texture.cc#L784-L871
[e-main-js]: https://github.com/electron/electron/blob/v43.8.0/lib/browser/api/shared-texture.ts
[e-renderer-js]: https://github.com/electron/electron/blob/v43.8.0/lib/renderer/api/shared-texture.ts
[c-handle]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webcodecs/video_frame_handle.cc#L120-L165
[c-frame]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/media/base/video_frame.cc
[c-context]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/gpu/command_buffer/client/context_support.h#L25-L47
[c-sii]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/gpu/command_buffer/client/shared_image_interface.h#L180-L192
[c-webgl-sync]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgl/webgl2_rendering_context_base.idl#L478-L485
[c-webgl-idl]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.idl#L634-L677
[c-webgl]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#L6467-L6675
[c-paint-sync]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/media/renderers/paint_canvas_video_renderer.cc#L1206-L1225
[c-blink-frame]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webcodecs/video_frame.cc#L1546-L1606
[c-image-util]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/graphics/video_frame_image_util.cc#L95-L165
[html-bitmap]: https://html.spec.whatwg.org/multipage/canvas.html#the-imagebitmaprenderingcontext-interface
[c-bitmap]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/canvas/imagebitmap/image_bitmap_rendering_context.cc#L102-L119
[c-generator-idl]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/breakout_box/media_stream_track_generator.idl
[c-generator]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/breakout_box/media_stream_track_generator.cc
[html-media]: https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject
[c-features]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/runtime_enabled_features.json5#L6434-L6444
[c-vtg-idl]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/breakout_box/video_track_generator.idl
[c-vtg]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/breakout_box/video_track_generator.cc
[c-sink]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc
[stream-spec]: https://www.w3.org/TR/mediacapture-transform/#dom-videotrackgenerator-writable
[c-source]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/breakout_box/pushable_media_stream_video_source.cc#L60-L85
[c-player]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/mediastream/web_media_player_ms.cc#L185-L237
[c-compositor]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/mediastream/web_media_player_ms_compositor.cc
[c-submitter]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/graphics/video_frame_submitter.cc
[c-provider]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/graphics/video_frame_resource_provider.cc#L68-L158
[c-resource-return]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/components/viz/client/client_resource_provider.cc#L275-L335
[c-updater]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/media/renderers/video_resource_updater.cc
[c-conversion]: https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/graphics/web_graphics_context_3d_video_frame_pool.cc#L240-L372
[e-capture]: https://github.com/electron/electron/blob/v43.8.0/docs/api/desktop-capturer.md#L102-L105
