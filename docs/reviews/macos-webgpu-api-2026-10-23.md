# macOS WebGPU 外部纹理消费合同

2026-10-23，固定 Electron 43.8.0／Chromium 150.0.7871.250（提交 `f916f1b7136907af19d96b95b891533d091d932a`）。公开 API 和固定源码足以支持保守的隔离探针，不构成集成或性能资格。当前生产者输出 BGRA；这不满足 Chromium 外部纹理 NV12 快路径的格式条件，不能预设免复制或 CPU 收益。

## 生命周期与同步

WebGPU 规范按来源区别有效期：HTMLVideoElement 外部纹理在导入后的任务中自动过期；VideoFrame 来源在该帧关闭时过期。关闭后不能继续提交引用旧外部纹理的命令。这里固定核对 [gpuweb 规范提交 0ba4e226](https://github.com/gpuweb/gpuweb/blob/0ba4e22611c995abd3077e422cb82e5ad203974b/spec/index.bs#L5561-L5701)，不将其允许的“同一图像重复导入”扩展为覆写仍被消费的 IOSurface。

固定 Blink 的 `FromVideoFrame` 注册关闭回调；`OnVideoFrameClosed` 先 expire，再移出缓存并销毁外部纹理。HTMLVideoElement 的延迟失效是另一条分支。[GPUExternalTexture 实现](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgpu/gpu_external_texture.cc#L268-L295)、[关闭处理](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgpu/gpu_external_texture.cc#L411-L491)

`queue.submit()` 是提交，不是 GPU 完成。`onSubmittedWorkDone()` 承诺等待调用前队列工作结束；Blink 将成功与错误分别 resolve／reject，并显式 flush。这也不是物理显示回执。[规范](https://github.com/gpuweb/gpuweb/blob/0ba4e22611c995abd3077e422cb82e5ad203974b/spec/index.bs#L14619-L14656)、[GPUQueue 实现](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgpu/gpu_queue.cc#L470-L503)

原生 frame 包装到 WebGPU mailbox 时有强引用和 acquire token；结束访问会更新 frame 的 release token。复制分支则用独立资源及 completion token 保护后续读取。上下文丢失的释放分支仍会执行部分 callback，不能只凭某个故障 callback 宣称健康 GPU 工作已完成。[mailbox 引用](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/graphics/gpu/webgpu_mailbox_texture.cc#L178-L206)、[结束访问](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/platform/graphics/gpu/webgpu_mailbox_texture.cc#L266-L319)

隔离探针沿用 Javdex 的三槽和两段释放，不依赖第三方异常分支：

`producer glFinish → Electron 导入／转移 → WebGPU 提交 → queue completion → frame.close → consumer GPU release callback → main 释放原始引用 → allReferencesReleased → native 租约归还`

这是本轮选择的保守协议，不代表每帧 CPU 等待是最佳性能策略；也不把 WebGPU 队列完成替代 Electron 的末端回收。现有 Canvas2D 的 `copy` 绘制不变；替代探针用不混合的整面绘制和 clear load 操作，停止需清空／取消配置并真实等待租约归零。

## 颜色和复制路径

`importExternalTexture` 的 `colorSpace` 决定读取转换的目标，规范默认 sRGB。探针显式 sRGB 输入目标与 Canvas 配置、opaque 输出，保持原生 BGRA8／BT.709 primaries／sRGB transfer／RGB full；HDR 仍先由 libmpv 映射到 SDR，不测试 HDR 直通。

固定 `external_texture_helper.cc` 的快路径要求 SharedImage、NV12、兼容元数据及设备和目标色彩支持。其他格式通过复制到 SharedImage 或 PaintCanvas 生成可回收资源，再由 Dawn 处理必要的颜色转换；绘制分支本身使用 Src 覆盖。因此当前 BGRA 只能进入后者，不能从 API 名称或第三方 README 推导全链路零拷贝。[条件与分支](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgpu/external_texture_helper.cc#L274-L496)

## 故障与准入

`GPUDevice.destroy()` 会销毁外部纹理缓存并解除 mailbox，再销毁逻辑设备。主动 destroy 可检查应用级 device-lost 分支，但不等于真实驱动或整个 GPU 进程故障。[固定实现](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/third_party/blink/renderer/modules/webgpu/gpu_device.cc#L532-L540)

设备丢失、队列完成失败或交付不明时停止生产，受影响源引用保留隔离，不用超时或 submit 返回提前回收。过期帧验证应核对关闭后导入及过期绑定的拒绝，不将“未抛同步异常”当作成功。正常动态画面、有效帧计数、停止归零、颜色以及独立故障探针均通过后，才运行同条件三次 Canvas2D 对照；只有重复明确收益才考虑显式实验集成。权限变化、新依赖大迁移及 Electron fork 不在本轮范围。

实际隔离探针、安全检查及三对性能结果见 [WebGPU 探针结果](macos-webgpu-probe-2026-10-23.md)：该宿主上 API 可用，但未达到产品接入的收益条件。
