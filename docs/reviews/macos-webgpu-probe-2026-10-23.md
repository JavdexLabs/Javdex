# macOS WebGPU 消费探针结果

历史实验：WebGPU 未采用，活动候选脚本已清理，源码与证据可从 [正式化归档](macos-canvas-default-2026-10-23.md#可恢复归档)恢复。下列命令是当时的复现入口，不再是当前开发指南。

WebGPU external texture 在当前 Electron 43.8.0 上可绘制并安全停止，但六对采样没有显示重复、明确的整体 CPU 收益。本轮保留独立探针，不接入 Javdex 产品、不切换默认后端。1080p 的平均 CPU 低 0.90 个百分点，4K 低 0.50 个百分点；单对差异不稳定，WebGPU 工作集合计还增加约 12 MiB。

## 条件与实现

2026-10-23，Apple M4／Mac16,10，macOS 26.5 arm64，Electron 43.8.0／Chromium 150.0.7871.250。显示器为同一台 1920×1080 logical、2× display；独立窗口内容 1380×848，视频 backing 2760×1425。1080p24、4K24 使用既有合成 H.264 素材，实际 `hwdec-current=videotoolbox`，原生渲染预算固定 8ms。

原生 addon 与上一轮相同，SHA-256 为 `cb14fd4536d66fe6d42efd06b76e36669d8dfd30a9eea2271c809805fc2ec58b`。产品源码未变；只扩展测试窗口、专用 preload 和自有 WebGPU consumer。第三方只作[固定源码对照](macos-webgpu-source-comparison-2026-10-23.md)，没有执行、移植其代码或 shader。

消费端持有 device、pipeline 和 sampler，但每个 VideoFrame 都新建 external texture 和 bind group。自有全屏三角形覆盖整个目标，不混合，clear load，opaque／sRGB；保持 BGRA8、BT.709／sRGB／RGB full，HDR 先由 libmpv 转 SDR。每帧等待 `queue.onSubmittedWorkDone`，再由调用方 close frame；Electron consumer GPU release callback 后 main 才释放原 import，最终 `allReferencesReleased` 归还 native ticket。原生 `glFinish` 和三槽租约不变。关闭与队列完成的区别、BGRA 的复制路径见 [API 合同](macos-webgpu-api-2026-10-23.md)。

这仍是独立诊断窗口，不等同正常 Javdex UI 的完整播放开销。没有新增权限、浏览器安全开关、依赖、Electron fork、Windows 改动或原生运行库构建。

## 实际安全探针

- 动态窗口使用 Apple `metal-3` 非 fallback adapter、`bgra8unorm` canvas。已查看真实窗口和两个去掉 DOM 时钟的视频裁剪；画面、烧录帧号与 native／GPU 完成计数推进。首轮 126 帧全部归还，停止约 1.10ms 归零。
- 关闭 VideoFrame 后再次导入，实际抛出 `OperationError`；提交旧 bind group 得到 destroyed texture validation error。错误被限定在预期 error scope 内，随后健康播放并正常停止归零，不能把“没有同步异常”当作有效提交。
- 在第一次 submit 后，先标记未知完成，再主动销毁自有逻辑 device；实际 `lost.reason=destroyed`、submitted=1、completed=0。初轮与补充的 native destroy 检查都保留原始 ticket 1；后者已确认 `alive=false`，再观察 500ms，produced=1、outstanding=1、pending=[1] 不变。没有 ACK、提前复用或强制回收，进程正常退出后才清理。这不是物理 GPU／驱动故障或整个 GPU 进程崩溃的验收。
- limited/full SDR、HDR10、HLG 四组分别运行 Canvas2D／WebGPU。实际窗口的 8 灰阶和 8 彩色色块中心 RGBA 采样最大差为 0，灰阶中性、单调且 alpha=255；八次正常停止均归零。HDR 结果只代表既有 SDR 映射，不是 HDR 直通保证。

灰阶结果依次为：limited `0,0,8,45,120,187,238,255`；full `0,0,8,45,120,188,239,255`；HDR10／HLG 均为 `0,1,15,62,135,185,249,255`。这是指定位置的相等，不是整个动态帧逐像素相等。

## 三对性能采样

每种输入各三对，10 秒预热、30 秒采样。第 1／3 对按 Canvas→WebGPU，第 2 对反序；窗口串行、隔离 profile，相同输出／颜色／解码。计时阶段无截图、像素读回、逐帧日志、构建或 profiler。CPU 按各进程累计 CPU 秒除以单调墙钟秒计算，100% 为一核；表内为三次均值与样本标准差。工作集为进程合计，可能重复计算共享页。

| 输入与消费 | CPU % | 工作集均值／峰值 MiB | 平均生产 fps | 租约峰值 | 停止归零 ms 范围 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1080p Canvas2D | 33.665 ± 0.830 | 450.75／454.27 | 23.997 | 2 | 0.810–0.817 |
| 1080p WebGPU | 32.767 ± 0.214 | 463.05／467.53 | 23.998 | 2 | 0.607–0.760 |
| 4K Canvas2D | 33.405 ± 0.333 | 494.86／498.64 | 24.006 | 2 | 0.603–0.858 |
| 4K WebGPU | 32.908 ± 0.444 | 507.42／513.33 | 23.997 | 2 | 0.615–0.656 |

1080p 三对 WebGPU−Canvas CPU 差分别为 `−2.065、−0.501、−0.129` 个百分点；4K 为 `+0.132、−1.325、−0.300`。均值相对变化为 −2.67%／−1.49%，不能只取首个 1080p 样本宣称约 6% 的稳定收益。

| 输入与消费 | Browser CPU % | GPU CPU % | Tab CPU % |
| --- | ---: | ---: | ---: |
| 1080p Canvas2D | 14.311 | 14.377 | 4.975 |
| 1080p WebGPU | 14.053 | 12.795 | 5.918 |
| 4K Canvas2D | 15.639 | 13.121 | 4.645 |
| 4K WebGPU | 15.622 | 11.771 | 5.514 |

GPU 进程 CPU 下降，但 renderer 成本上升，抵消了部分差异；总计还包含很小的 Utility 成本。十二次基准中进程集合稳定，mpv 丢帧增量均为 0，实际提交／WebGPU 完成速率约 24fps；共生产 11,523 帧并归还 11,523 帧，正常停止后 pending 和 native outstanding 均为 0。帧计数不代表物理扫描输出。

另用独立的 1080p 窗口采集两种消费的 12.5 秒 Browser／renderer CPU profile、Chromium trace，以及普通权限下 Browser／GPU／Tab 的 12 秒 native sample；六份 sample 均退出 0。这些窗口的 CPU 不进入上表。WebGPU renderer profile 中可见 `importExternalTexture`，trace 可见 WebGPU 命令；Canvas profile 中可见 `drawImage`。profile 不能据此给出精确复制次数或把采样命中数当作进程 CPU 百分比。

## 结论与复现

API 可用与正常生命周期已在该宿主上跑通，但收益量级小、配对变化明显且内存更高，不满足本轮“重复且明确收益才集成”的条件。保留现有 Canvas2D 与 NSOpenGLView 默认／回滚路径，不继续尝试更多消费候选。本轮不把上一轮 24／30／60、字幕、音轨、seek、隐藏、全屏、缩放、慢消费与 renderer crash 结果冒充 WebGPU 产品回归；这些产品集成检查本轮未启动。

测试入口：

```sh
node scripts/mac-shared-texture-cost.mjs --output <新目录> --media <24fps合成文件> --stages webgpu --scenario safety --warmup 2 --seconds 3
node scripts/mac-shared-texture-cost.mjs --output <另一新目录> --media <24fps合成文件> --stages webgpu --scenario expired --warmup 2 --seconds 3
node scripts/mac-shared-texture-cost.mjs --output <另一新目录> --media <24fps合成文件> --stages webgpu --scenario device-loss --warmup 2 --seconds 3
node scripts/mac-shared-texture-cost.mjs --output <每对新目录> --media <至少50秒24fps合成文件> --stages canvas,webgpu --warmup 10 --seconds 30
node scripts/mac-shared-texture-cost.mjs --output <独立profile目录> --media <24fps合成文件> --stages canvas,webgpu --warmup 2 --seconds 20 --profiles
node --test scripts/mac-shared-texture-webgpu.test.mjs
```

自有控制回归 3 pass／0 fail／0 skip；专用 preload 独立 TypeScript 检查、JS 诊断脚本 ESLint 和 `git diff --check` 退出 0。仓库 ESLint 没有为该测试 TS 文件配置匹配项，因此不将它称为已 lint。没有产品代码变化，不重复产品全量测试／原生构建。首次批处理的 4K 文件名拼接错误在窗口启动前被输入检查拒绝；正确文件名后的三对才计入结果。

原始结果在 `/tmp/javdex-webgpu.jwI7km`；保留副本与哈希清单在 `out/playback-acceptance/macos-webgpu-20261023-jwI7km`，排除隔离用户缓存。`benchmark-analysis.json`、`color-comparison.json`、`profile-analysis.json` 和各 case 的 `report.json`／`summary.json` 分别保留统计、像素采样、profile 摘要、准确释放与正常进程退出。没有提交、推送或发布操作。
