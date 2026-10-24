# Windows Canvas 生产与同步 API 调查

2026-10-23。范围是 Microsoft 与 Khronos 的 Windows 纹理生产、句柄和同步合同。主会话已确认 Electron 43.8.0 本地 d.ts 提供 BGRA 输出与 NT handle，未暴露 keyed mutex 协议；固定版本实际导入实现仍由主会话核对。本次仅在 Mac 调查资料，没有构建、GUI、Windows 设备或远程 Windows 验证。

建议实现有条件启用的 `libmpv GL → WGL interop2 私有 D3D11 纹理 → GPU copy → 三个非 keyed NT 导出槽 → Chromium → Canvas`。发布前在生产端等待 GPU 完成，消费期间保持导出纹理不变，最终释放后才复用；这包含一次明确的 GPU copy，不是零复制结论。非 keyed NT 创建及真实 Chromium 导入必须作为后续原生 Windows 准入检查。

## BGRA 纹理与句柄所有权

首版限定 `ID3D11Texture2D`、`DXGI_FORMAT_B8G8R8A8_UNORM`、`D3D11_USAGE_DEFAULT`、`MipLevels=ArraySize=1`、`SampleDesc={1,0}`、`CPUAccessFlags=0`、`BindFlags=RENDER_TARGET|SHADER_RESOURCE`。D3D11.1 的共享格式包括此 BGRA 格式；不引入 MSAA、staging、YUV 多平面或 typeless。[共享资源范围][sharing]

设备设置 `D3D11_CREATE_DEVICE_BGRA_SUPPORT`，不设置 `D3D11_CREATE_DEVICE_SINGLETHREADED`；后者也被 interop2 示例明确排除。设备线程安全不代表 immediate context 线程安全：GL、WGL 交接、copy、query 统一由原生渲染线程串行执行。[设备标志][device]、[线程合同][threads]、[interop2][interop2]

| 类型 | 导出与打开 | 生命周期与关闭 |
| --- | --- | --- |
| NT handle | `IDXGIResource1::CreateSharedHandle` → `ID3D11Device1::OpenSharedResource1` | handle 持有底层内存引用，可 `DuplicateHandle`，由拥有者 `CloseHandle`。[创建][create]、[打开][open]、[Khronos 句柄定义][handles] |
| 旧式全局 KMT handle | `IDXGIResource::GetSharedHandle` → `ID3D11Device::OpenSharedResource` | 自身不保活资源；不能 `CloseHandle` 或 `DuplicateHandle`。不能塞入要求 NT handle 的接口。[旧式句柄][legacy]、[Khronos 句柄定义][handles] |

每个纹理 allocation 只调用一次 `CreateSharedHandle`；需要更多句柄时使用 `DuplicateHandle`。建议匿名、默认不继承，权限与消费端实际打开要求一致；起步可用 `DXGI_SHARED_RESOURCE_READ|DXGI_SHARED_RESOURCE_WRITE`，不把只读权限当成已验证兼容。[CreateSharedHandle][create]

NT handle 数值属于进程的句柄表；跨进程必须复制到目标进程或由已核实的框架传递机制处理，复制 Buffer 字节不等于复制 handle。生产者保留根 handle 和纹理 COM 引用，交给导入层独立副本；副本由导入合同指定的一方关闭，不能双方重复关闭。[DuplicateHandle][duplicate]

`OpenSharedResource1` 每次返回新的 COM 资源对象，即使 handle 相同；返回对象、输入 handle、包装对象引用必须分别记账。打开成功不证明 GPU 完成，关闭 handle 也不表示消费者停止使用。保守策略是保留生产者资源直到该帧所有消费者的最终释放，再允许改写；池销毁时另行关闭仍归本方所有的根 handle。[OpenSharedResource1][open]、[句柄保活][handles]

## 非 keyed 与 keyed 的兼容边界

- 候选导出槽使用 `MiscFlags=D3D11_RESOURCE_MISC_SHARED|D3D11_RESOURCE_MISC_SHARED_NTHANDLE`，不设置 `SHARED_KEYEDMUTEX`。互斥由“生产完成后发布、消费者退出后改写”实现，NT handle 本身不是同步原语。[标志定义][flags]
- 微软推荐的 keyed 组合是 `SHARED_NTHANDLE|SHARED_KEYEDMUTEX`；`SHARED` 与 `SHARED_KEYEDMUTEX` 互斥。keyed 资源要求参与设备按协议 acquire/release；提前等完 GPU 不能免除这个要求。[标志定义][flags]

需保留文档差异：`CreateSharedHandle` 的 Remarks 把 NT 场景写成 `NTHANDLE+KEYEDMUTEX`；`GetSharedHandle` 的替代建议及 `OpenSharedResource1` 步骤则只要求共享资源使用 `NTHANDLE`。这些文字不足以证明任意驱动都接受上述非 keyed 组合，故必须检查创建、导出、独立设备打开及真实导入的结果；失败不能悄悄换成 keyed。[创建][create]、[旧式句柄][legacy]、[打开][open]

`AcquireSync` 初次无主状态只有 key 0 成功；以后必须匹配上次 `ReleaseSync` 的 key。微软示例的 `ReleaseSync(1)` 不是 Chromium key 协议；WGL lock/unlock 也不是 `IDXGIKeyedMutex`。本方案不自创 0/1 或 0/0 消费协议。若将来启用 keyed，需先核对固定消费实现；精确检查 `S_OK`，`WAIT_TIMEOUT`、`WAIT_ABANDONED` 不能用 `SUCCEEDED` 放行，abandoned 必须重建资源。[AcquireSync][acquire]、[ReleaseSync][release]

## WGL 接入现有 OpenGL 输出

`WGL_NV_DX_interop2` 扩展原 interop，支持 `ID3D11Device`，并允许把 `D3D11_USAGE_DEFAULT` 的 `ID3D11Texture2D` 注册为 `GL_RENDERBUFFER` 或 `GL_TEXTURE_2D`。原规范要求 OpenGL 2.1，interop2 还要求原 interop、WDDM 与 D3D11 能力；必须实际检查扩展字符串及函数入口，不能由 Windows 或显卡品牌推断存在。[interop2][interop2]

建议用同一生产者 D3D11 device 创建一张私有 BGRA bridge 纹理（`MiscFlags=0`），`wglDXOpenDeviceNV(device)` 后以 `WGL_ACCESS_READ_WRITE_NV` 注册 renderbuffer，挂到 FBO，检查 framebuffer complete 后接给现有 libmpv 的 GL 输出。interop2 的官方示例正是 D3D11 renderbuffer 挂 FBO；libmpv 的上下文和 FBO 接入细节由主实现核对。[interop2][interop2]

WGL 注册传入的是 D3D 资源指针，不是导出 NT handle；D3D10/11 不需要 `wglDXSetResourceShareHandleNV`，调用也无效。私有 bridge 再 copy 到导出槽，可避免首版同时依赖 WGL 对 NT 共享纹理组合的驱动支持；直接注册导出槽只作为后续减少 copy 的候选。[interop2][interop2]

锁定期间只允许 GL 访问，D3D 访问该资源属于未定义行为；成功 unlock 后 D3D 才可安全访问。原规范 Issue 2 明确 lock/unlock 是 GL 与 D3D 驱动的同步交接点，禁止两者并行渲染同一资源。它不证明 Chromium 另一设备上的消费者已退出。[WGL 同步合同][interop]

`wglDXOpenDeviceNV` 可因 D3D adapter 对当前 GL 不可访问而返回 `ERROR_NOT_SUPPORTED`。首版策略限定 GL、生产者 D3D11 与 Chromium 消费者同适配器，记录 adapter LUID 和实际驱动；混合显卡、远程桌面、软件后端或适配器切换不在此路径保证内。扩展前缀 NV 不是跨厂商驱动支持承诺。[WGL 打开设备][interop]

## 可执行的保守完成顺序

以下是工程组合方案，不是已测 Windows 结果；前提是非 keyed NT 导入通过主会话的固定实现核对及后续原生准入。

1. 取得一个空闲导出 ticket；没有空闲槽就跳过此次输出，不覆写已发布帧。bridge 与导出槽使用相同尺寸、格式和采样数。
2. 在 GL context 所在线程成功 `wglDXLockObjectsNV`，让 libmpv 画入 bridge FBO；执行 `glFinish()`，再成功 `wglDXUnlockObjectsNV`。`glFinish` 等此前 GL 命令效果完成；保留它作为首版额外保守等待，不以 `glFlush` 替代。[glFinish][finish]、[WGL][interop]
3. 解锁后在同一 D3D immediate context 调用 `CopyResource(exportTexture, bridgeTexture)`。它是异步 GPU copy，不做翻转、缩放或色彩转换；不能依赖它修正 RGBA/BGRA 或上下颠倒。[CopyResource][copy]
4. copy 后 `End(eventQuery)`，再 `Flush()`；轮询 `GetData(query,&done,sizeof(BOOL),D3D11_ASYNC_GETDATA_DONOTFLUSH)`，仅在 `hr==S_OK && done==TRUE` 时进入可发布状态。event query 不调用 `Begin`；`S_FALSE` 继续等待，其他错误停止发布。[EVENT][query]、[GetData][getdata]
5. `Flush` 只提交、不等待；先显式 Flush 再 DONOTFLUSH 轮询，避免命令仍滞留导致永远无结果。等待放在原生线程并设 watchdog；超时仅停产隔离，不能取消 GPU 使用或立即释放。`glFinish` 自身没有超时参数。[Flush][flush]、[DONOTFLUSH][donotflush]、[glFinish][finish]
6. copy 完成后才能再次让 GL 改写 bridge；此时发布该 ticket 的 handle 副本和不可变尺寸/格式。导出槽仍冻结，直到本次导入的完整释放链终结；不能把传递成功、绘制返回、单个 `VideoFrame.close()` 或普通 IPC ACK 当成最终 GPU 释放证明。

可选的本地完成等待是成功取得 `ID3D11Device5`、`ID3D11DeviceContext4` 后 `CreateFence`，copy 后对递增值 `Signal`、提交，再 `SetEventOnCompletion` 等待并检查设备状态；不支持则保留 EVENT query。GPU `Signal` 表示此前工作完成后更新 fence；CPU 写值不能替代它。本地 fence 不是自动交给 Chromium 的 acquire fence。[CreateFence][fence]、[Signal][signal]、[完成事件][fenceevent]

## 三 ticket 生命周期与故障隔离

以下为实现约束，最终 consumer-release 信号必须由固定 Electron 实现的完整引用与 GPU 释放链提供。

- 状态为 `FREE → PRODUCING → GPU_PENDING → EXPORTED → FREE`；只有生产完成且本轮消费者全部释放才能回到 FREE。每轮重新导入，避免把长期导入对象当作有外部更新协议的流。
- ticket 使用 `(generation,slot,sequence)`，不以 HANDLE 数值或纹理指针识别帧。延迟、重复、乱序回调只能命中原 ticket，回收幂等，不能释放新一轮槽。
- 三个额度覆盖所有尚未安全回收的导出 ticket，包括隔离槽、旧尺寸和旧会话；池满丢弃新输出或暂停，不增加临时第四槽。resize/seek/切换片源先退休旧 generation，释放多少额度才创建多少新槽。
- WGL lock/unlock 失败、context lost、copy/query 异常、等待超时、导入状态不明或消费者断联，均进入 `QUARANTINED`。未知结果不合成成功释放；能证明从未发布且生产已完成时才可回收。
- 持有隔离资源与 native owner，停止新发布并走已有回退；不能先析构纹理/GL context 再等待迟到回调。无法证明旧消费者退出时保持有界隔离，不循环分配新池。
- 设备 removed/reset/hung 时记录 `GetDeviceRemovedReason`，退休该设备所有 ticket；正常回调也不能让旧设备的纹理重新上线。正常清理需在 GPU 与消费者都退出后，按 GL owner 线程解除 FBO/注册、关闭 interop device、释放 COM 和仍归本方的 NT handle。[设备故障][removed]、[WGL 清理][interop]

## 图像约束与 EGL 替代成本

GL FBO 通常以底左为原点，D3D 纹理以顶左为原点；这里的 handedness 问题主要是图像 Y 方向，不应对视频套用三维左右手投影变换。让生产输出与消费约定只翻转一次，用四角标记验证；`CopyResource` 不翻转。[GL 坐标][clip]、[D3D 坐标][coordinates]、[CopyResource][copy]

BGRA 仅说明通道存储及 UNORM 数值类型，不等于色域、transfer、range 或 HDR 合同。首版约束 opaque alpha=1、8-bit SDR；由生产者完成所需 SDR 输出，消费元数据与实际像素匹配，不把 `_UNORM` 当成 `_UNORM_SRGB` 自动转换。红蓝色块、灰阶、字幕透明边缘与方向均需后测。[DXGI 格式][formats]

`EGL_ANGLE_d3d_texture_client_buffer` 的 ANGLE 官方 Draft 规范（v12，2026-10-09）允许 `eglCreatePbufferFromClientBuffer(...,EGL_D3D_TEXTURE_ANGLE,texture,...)`，接受 DEFAULT BGRA D3D11 texture；存在 `EGL_ANGLE_device_d3d` 时须来自该 EGLDisplay 对应的同一 D3D device。可作为替代生产后端，但需固定并部署 ANGLE EGL/GLES 依赖、重建 EGL/GLES context/proc-loader、确认 libmpv GLES 支持和设备共享，不能假定 Electron 的内部 ANGLE 可直接复用；这些是实现成本判断，不是现有工程能力结论。[ANGLE 规范][angle]、[设备查询][egldevice]

不要混淆 Khronos 已登记的旧 `EGL_ANGLE_d3d_share_handle_client_buffer`：其描述的是 D3D9Ex/GetSharedHandle 来源的 share handle，不能据此认定接受 NT handle。EGL 替代也仍需生产完成与完整消费释放协议。[旧 EGL 扩展][egllegacy]

后续原生 Windows 验证必须覆盖：非 keyed NT 创建/导出/第二设备打开及 Electron 真实导入；目标驱动上的 WGL 注册和 FBO；多适配器选择；慢消费者与三槽耗尽；resize/seek/关闭/崩溃的迟到释放；设备故障隔离；方向、BGRA 与 SDR 一致性；长播放显存/handle 上界。GPU copy、阻塞等待和 Canvas 消费的实际成本均须实测，Mac 文档调查不能作为 Windows 正确性或性能验收。

[sharing]: https://learn.microsoft.com/en-us/windows/win32/direct3d11/direct3d-11-1-features#extended-support-for-shared-texture2d-resources
[device]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_create_device_flag
[threads]: https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-render-multi-thread-intro
[create]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgiresource1-createsharedhandle
[open]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11device1-opensharedresource1
[handles]: https://registry.khronos.org/vulkan/specs/latest/man/html/VkExternalMemoryHandleTypeFlagBits.html
[legacy]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiresource-getsharedhandle
[duplicate]: https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle
[flags]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_resource_misc_flag
[acquire]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgikeyedmutex-acquiresync
[release]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgikeyedmutex-releasesync
[interop2]: https://registry.khronos.org/OpenGL/extensions/NV/WGL_NV_DX_interop2.txt
[interop]: https://registry.khronos.org/OpenGL/extensions/NV/WGL_NV_DX_interop.txt
[finish]: https://github.com/KhronosGroup/OpenGL-Refpages/blob/main/gl4/glFinish.xml
[copy]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copyresource
[query]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_query
[getdata]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-getdata
[flush]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-flush
[donotflush]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_async_getdata_flag
[fence]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11_4/nf-d3d11_4-id3d11device5-createfence
[signal]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11_3/nf-d3d11_3-id3d11devicecontext4-signal
[fenceevent]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11_3/nf-d3d11_3-id3d11fence-seteventoncompletion
[removed]: https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-getdeviceremovedreason
[clip]: https://registry.khronos.org/OpenGL/extensions/ARB/ARB_clip_control.txt
[coordinates]: https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-resources-coordinates
[formats]: https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format
[angle]: https://github.com/google/angle/blob/main/extensions/EGL_ANGLE_d3d_texture_client_buffer.txt
[egldevice]: https://registry.khronos.org/EGL/extensions/ANGLE/EGL_ANGLE_device_d3d.txt
[egllegacy]: https://registry.khronos.org/EGL/extensions/ANGLE/EGL_ANGLE_d3d_share_handle_client_buffer.txt
