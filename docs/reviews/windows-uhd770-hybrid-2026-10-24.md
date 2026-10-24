# UHD 770／RTX 4080 混合配置实测，2026-10-24

在 `dev` / `ccd131b073639e96f1c35fad425c5ab93d766858` 的现有未提交工作区和已构建产物上继续检查。用户启用核显后，Windows 已正常枚举 Intel UHD 770；用户明确选择暂不换视频线，先检查混合显卡配置。本记录不声明纯 Intel WGL 显示链路已经验收。

产品代码和编译产物未改。本轮只增加本地探针、隔离验收脚本和文档，并把通用 CPU 验收入口中写死的“核显未枚举”待测说明改为真实剩余范围。没有提交、推送或发布。

## 环境与选择方法

- Windows 11 x64、i5-12600K；显示器仍沿用 NVIDIA 输出，没有禁用 RTX 4080 或改变显示连接。
- Intel UHD Graphics 770：PCI `8086:4680`，驱动 `32.0.101.7092`，PnP 状态正常；本次启动的适配器 LUID 为 `0x00000000:00010B57`。
- RTX 4080：PCI `10DE:2704`，驱动 `32.0.16.1742`；本次 LUID 为 `0x00000000:0000F83A`。LUID 仅用于关联本次运行，不能作为永久设备身份。
- Electron 43.8.0 原始运行库完整复制到 `out/uhd770-validation-20261024/electron-runtime/`，保持 `electron.exe` 文件名；实际产品宿主断言 `app.isPackaged=false`，使用原工作区生产构建和隔离资料库。复制前后的 executable 摘要一致，不使用修改过的图形运行库。
- 只给独立探针 exe 和隔离 Electron 副本临时写入当前用户的 `UserGpuPreferences / GpuPreference=1;`。每次运行均保存旧值并在 `finally` 恢复；原来不存在的空键也已删除。未修改日常应用的显卡偏好。Windows 为应用选择 GPU 的说明见 [Intel 指南](https://www.intel.com/content/www/us/en/support/articles/000090168.html)和 [NVIDIA 说明](https://www.nvidia.com/content/Control-Panel-Help/vLatest/en-us/mergedProjects/3D%20Settings/Setting_the_Preferred_Graphics_Processor.htm)。

材料位于 `out/uhd770-validation-20261024/`，包括 `controllers.json`、独立 D3D／WGL 探针源码和二进制、Chromium GPU 信息、每次偏好备份／恢复收据、实际窗口截图和 `receipt.json`。产品 native SHA256 保持 `cc363c3b676e06c790218933b45104ed1974bb1b34f9cdc62a9817796923322f`，99 个原产品编译产物也保持。

## 实际设备分工

设置核显偏好后，独立 D3D11 设备确实选中 Intel UHD 770，Chromium 完整 GPU 信息也报告 Intel 的 ANGLE D3D11 renderer 与活动 vendor `0x8086`。但同一偏好下的 WGL 仍为 NVIDIA；产品旧后端的实际 current context 经只读 Node-API 探针确认是 `NVIDIA GeForce RTX 4080/PCIe/SSE2`、OpenGL 3.2.0。只读探针不 make-current、创建 context、渲染或 swap。

因此，当前应用进程可能同时有 Intel 的 D3D／Chromium 和 NVIDIA 的 WGL。不能仅凭“Windows 选择了核显”或任务管理器出现核显负载，就把 OpenGL 视频显示算成核显显示。

## 已完成检查

最终选用 4 个通过场景、11 次媒体检查；每个所选宿主均普通停止并退出，`forced=false / code=0 / signal=null`。原始失败文件继续保留，未把失败报告整体改写为通过。

| 场景 | 实际结果与证据 |
| --- | --- |
| 默认旧路径，3 个 1080p30 输入 | H.264／HEVC／AV1 动态 GL 读回、播放推进、暂停 seek、底栏／展开／全屏及停止通过。Chromium 是 Intel，WGL 与自动解码仍是 NVIDIA／`nvdec`，不能算 Intel OpenGL 或自动核显硬解。来源为 `hybrid-final-report.json` 中独立通过的 `legacy` 场景 |
| 候选 Canvas 的真实跨设备失败，3 个 1080p30 输入 | 生产端实际报 `GL cannot access the selected D3D11 adapter`，没有故障注入。现有逻辑自动回退 CPU，`hwdec=no`、`GPU_INITIALIZATION_FAILED`；三个编码的彩色动态窗口截图、控制、停止和引用归零通过。来源为同一报告中独立通过的 `canvas` 场景 |
| Intel 硬解组件，3 个 4K24 输入 | 仅在自有验收会话显式设置 `hwdec=d3d11va-copy`，H.264／HEVC／AV1 均显示该实际解码器，并在对应播放主进程的 Intel LUID 上采到 VideoDecode 负载；动态 GL 读回、时钟推进、暂停 seek、展示切换及停止通过。显示仍是 NVIDIA WGL。这证明本机 Intel 解码可用，不代表产品默认策略已经自动选择核显。来源为 `hybrid-report.json` 的 `intel-decode` 场景 |
| CPU 回退后的 ASS／PGS，2 项 | Intel Chromium 合成下，实际窗口截图差分分别有 164737／44576 个通道差大于 40 的像素；PGS 另有位置和尺寸守卫，排除整帧空白、背景变化和错误 cue。底栏／展开／全屏、停止和引用归零通过。来源为 `hybrid-subtitles-verified-report.json` |

解码引擎采样为播放主进程自身，而非浏览器 GPU 子进程或其他程序：H.264 采到约 17%，HEVC 8–12%，AV1 11–13%；实例名含 Intel LUID `00010B57`。这些是短时引擎利用率，不是吞吐基准、物理上屏帧率或端到端音画同步证明。`d3d11va-copy` 含复制，不声称零复制。

Canvas 跨设备失败的原因已由独立探针和产品调用分别确认：NVIDIA WGL 虽有 `WGL_NV_DX_interop2`，仍不能打开本次选中的 Intel D3D11 设备。由此不能推断“Intel 永远不支持 Canvas”或“核显自身没有 OpenGL”；纯 Intel 的 WGL／D3D 组合尚未测试。

## 失败与采样边界

`hybrid-final-report.json` 整体保留失败，因为首次 PGS 检查只在开关后固定等 250ms，截图未看到 cue。之后按既有字幕验收的异步约定，等待轨道反馈和重定位完成，再按原通道差门槛检查；PGS 增加几何守卫。复验第一次截图即通过，实际 native 状态为 paused、position=2、sid=1、seeking=false、subtitleCommandsPending=0。未修改产品字幕逻辑，也未降低像素门槛。选择旧报告中独立通过场景时，在总收据中保留其原总体失败状态。

旧路径图像来自既有 native capture 的真实 GL 输出读回；CPU 回退图像来自 Chromium 窗口截图。两者均不替代物理扫描输出、外部采集卡或色度计验收。每次探针／产品宿主退出后均恢复临时 GPU 偏好，原始日志、截图与失败留存。

仍未验收：显示器接主板口后的 Intel 原生 WGL／单显卡链路、Intel 同适配器 GPU Canvas、完整 HDR、长播、RDP／虚拟机、设备 removed/hung、声音设备与物理听感、签名安装包及其他 Intel／AMD 驱动组合。现有产品默认路径和硬解策略保持。
