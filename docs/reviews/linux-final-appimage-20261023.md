# Linux 最终 AppImage 自动验收（2026-10-23）

基于 `332f78e1`，合入当前 Linux AI 运行库改动及 ANGLE 配套源码校验修复。使用现有播放实现；暂停的直接互通实验仍保留在独立工作区，未纳入本次提交。用户要求全自动检查，因此没有请求人工画面或听感确认。

## 产物身份

- AppImage：`dist/linux-ai-angle-source-complete/Javdex-0.9.0-x86_64.AppImage`，188,168,222 字节（179.45 MiB）。
- SHA-256：`0532fb44bd92fad713357f6c3d43470cfa86a0833a4390f271d3e7036b5d7d11`。
- 配套源码：`Javdex-Playback-Sources-0.9.0-linux-x64-4707459fe52d-5b10798f.tar.gz`，SHA-256 `434b07942bb62b3406ea52f122215bc03d2e32dc89600b6ae59aa0834ba25e54`。
- 包内 95 个 JS/CSS/WASM 文件与构建输出逐字节匹配；GPU、CPU、ANGLE 运行库清单、对应源码、SDK 和 Ubuntu 源材料完整校验通过。证据：`out/angle-source-fix/final-verification.json`。
- 旧包保留，没有安装系统包、修改驱动或系统设置；本轮不创建 Release、不替换已发布附件。

## 播放结果

Ubuntu 26.04 GNOME Wayland；Intel UHD 770 为 renderD128（8086:4680），RTX 4080 为 renderD129（10de:2704）。X11 测试通过 XWayland，不是原生 Xorg。各测试串行运行，独立配置和合成媒体，不使用用户资料库。

| 路径 | H.264 / HEVC Main10 / AV1 | 控制操作 | 采样末尾丢帧计数 |
| --- | --- | --- | --- |
| Wayland / NVIDIA nvdec-copy | 全部通过 | 全部通过 | 均为 0 |
| XWayland / NVIDIA nvdec-copy | 全部通过 | 全部通过 | 均为 0 |
| Wayland / Intel vaapi-copy | 全部通过 | 全部通过 | 均为 0 |
| XWayland / Intel vaapi-copy | 全部通过 | 全部通过 | 均为 0 |
| Wayland / CPU no | 全部通过 | 全部通过 | 均为 0 |
| XWayland / CPU no | 全部通过 | 全部通过 | 均为 0 |

每组 H.264 连续采样 65 秒，HEVC/AV1 各采样 8 秒，然后分别执行暂停、恢复、三次跳转、外部 SRT 字幕、音量/倍速、两种窗口尺寸和关闭重开。核对实际解码器、播放状态及 Canvas 彩色像素，并检查播放、字幕和恢复截图；18 个正常用例均通过。截图和像素不等于屏幕实际扫描输出证明，丢帧计数也不是独立呈现测量。

三种注入故障通过：XWayland 自检黑帧、Wayland 自检超时均进入 CPU 并输出彩色画面；XWayland 模拟 GPU 进程退出后保留暂停位置、字幕、音量 37、倍速 1.25，恢复播放和重开通过。此测试注入进程退出通知，不代表真的杀死宿主 GPU 或模拟驱动挂死。

H.264 4K60 分别连续测量 65 秒，保持实时、结束截图正常，但 Wayland / XWayland 分别丢弃 359 / 382 帧，不能判为无丢帧流畅。实际 Canvas 为 2070×1060 / 2760×1487，输出尺寸不同，不作为两平台性能优劣对比，也不是原生 4K 输出测试。计时期间没有截图/像素读回；结束后才采集画面。当前没有同条件旧包性能对照，不将该结果直接归因于本次改动。

原始报告、日志、截图及串行运行脚本：`out/final-appimage-acceptance-20261023/`。`gpu-contact.png`、`cpu-fallback-contact.png` 是截图检查汇总；原始 report 中 human review 的 pending 标记保留。

## 审查结论与边界

审查了 Linux GPU 平台门控、固定资产摘要、解包及原子安装、私有子进程库路径、软件 Vulkan 过滤和设备预算；相关功能证据见 [AI 运行库验收](linux-local-ai-gpu-20261023.md)。本轮没有重跑 AI 模型推理。

ANGLE 修复排除两种命名的下载 sysroot，保留首选源码与构建配方，修正 XCB 源文件位置；仅 ANGLE 提高有界归档容量，所有路径、链接和重复项检查保留。GPU 仍要求 NVDEC 源码，关闭 NVDEC 的旧 CPU 收据可省略该项。回归测试覆盖上述边界，未发现阻止提交的问题。

未验证：人工连续流畅度和听感音画同步、真实物理呈现、跨机器/AMD/原生 Xorg/其他桌面、HDR 色准、无 GPU/缺驱动隔离重测、多小时长播，以及 AI 推理与播放并发性能。4K60 丢帧仍是明确性能改进项；本次功能验收不作全 Linux 兼容承诺。

## 完整回归中发现的测试问题

首轮 `npm test` 的 Electron 套件为 4,314 项：4,292 通过、1 失败、21 跳过。失败是最新上游 `desktopPlayback.test.ts` 的自驱动宿主测试继承了执行机的 Linux 平台：产品在 Linux 会增加回退包装器并保留轮询，而该测试本意是验证 macOS 无渲染轮询。单独复现后，夹具新增可指定的平台参数，仅该用例明确使用 `darwin`；其余用例保留宿主平台，未削弱 Linux 回退验证，也没有改动产品实现。定向 9 项通过，原失败日志保留为 `observer-focused.log`，修复结果为 `observer-fixed.log`。

最终验证：修复后完整 `npm test` 退出 0，Electron 套件 4,293 通过、21 平台跳过、0 失败（4,314 项）；前置架构/lint、类型、打包、播放夹具/构建及备份烟测全部通过。`npm run test:ui` 通过；`npm run pages:build:offline` 通过，28 页和 2,045 个本地引用检查成功。最终日志为 `npm-test-fixed.log`、`ui.log`、`pages.log`；首轮失败日志未覆盖。修改后 `git diff --check` 通过。
