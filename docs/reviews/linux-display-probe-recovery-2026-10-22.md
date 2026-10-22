# Linux 画面自检、硬解操作与 CPU 恢复验证（2026-10-22）

源码基线：本地提交 `257af93`，其后工作区的合成画面自检、诊断与恢复改动。未推送或发布。旧包 `dist/linux-hwdecode/`、64×64 自检失败包 `dist/linux-playback-self-test/` 均保留。

## XWayland 自检失败定位

64×64 固定色块在实际 NVIDIA helper 的独立 EGL 读回中，25 个样点全部非黑且不透明；元数据为 stride 256、allocation 65536、modifier 216172782120099861。相同版本在 XWayland / ANGLE Vulkan 的 Canvas 读回，五个 RGBA 样点为：

```text
[64,191,128,255], [0,0,0,255], [0,0,0,255], [64,191,128,255], [0,0,0,255]
```

Wayland 的微小色块正常。将合成自检改为 640×360 后，XWayland 五个位置全部为 `[64,191,128,255]`，常规尺寸视频与字幕可见。保留原严格颜色与来源验证；部分黑块仍判失败。证据将问题缩小到小尺寸 DMA-BUF 在该 XWayland ANGLE/Vulkan 消费路径的布局/读回兼容性，尚未定位至某一驱动或 ANGLE 内部函数。此次规避该尺寸，不声称修复驱动对任意小纹理的导入。

自检只读自产合成色块，不读媒体内容来判断健康；不将黑色影片误判为坏帧。单次读回会影响同步与 Canvas 行为；通过并不证明最终物理显示或后续所有尺寸、modifier 均正常。

原始证据位于任务目录 `evidence/linux-playback-self-test/`；GUI 报告位于仓库 `out/linux-codec-acceptance/`。`helper-probe.log` 保存独立 producer 检查；`probe-x11-debug` 保存 64×64 失败；`probe-x11-wide` 保存 640×360 对照及字幕/窗口操作截图。

## 产物

- AppImage：`dist/linux-playback-self-test-wide/Javdex-0.9.0-x86_64.AppImage`，184708409 bytes，SHA-256 `cb8521a00f2bad428fab970ddbeaf562c9f80402f5baaa00985c44687c05a251`。
- deb：同目录 `Javdex-0.9.0-amd64.deb`，161947352 bytes，SHA-256 `6dd5539a72ed12e03418fcc0486fed4dd6332347a65b5ea5b7400b27dcef04e3`。
- AppImage 解包、GPU/CPU 运行库闭包和来源校验通过；deb 解包后 191 个应用/播放/ANGLE 文件与打包目录逐个一致。未在宿主安装 deb。
- 本轮 53 个自检/调度/恢复相关测试、完整类型检查和针对性 ESLint 通过。此前其他播放、UI 和打包测试证据保留在同一 evidence 目录。

## 验收边界

本轮核对环境：Ubuntu GNOME Wayland、内核 `7.0.0-38-generic`、NVIDIA 驱动 `595.99.02`；Intel `8086:4680` 为 renderD128，NVIDIA `10de:2704` 为 renderD129。本轮未安装或更新驱动。X11 测试由 XWayland 提供，不代表原生 Xorg。NVIDIA RTX 4080 渲染与 NVDEC；Intel UHD 770 的 VA-API 解码测试仍由 NVIDIA 消费显示。其他显卡、纯 Intel 桌面、HDR、4K60 以及长期稳定性未覆盖。人工反馈的提示音/闪块“粗略同步”不等于仪器测量音画偏差。

先前最后一次 X11 人工确认已由用户撤回，不计入验收；修复包的重新确认见下文最终结果。

## 测试工具修正与保留的失败

旧脚本将异步 IPC Promise 直接作为 `page.waitForFunction` 的谓词返回值。当前安装的 Playwright 在其轮询实现中先执行 `const success = predicate()`，Promise 对象为真后停止轮询，因此即使 Promise 最终结果为 false 也没有继续等状态。此问题造成超时回退在约一秒时就被提前断言，以及重开阶段的偶发空硬解状态。

脚本改用 Node 侧有截止时间的轮询，每次 `await page.evaluate(...snapshot())` 后再判断状态；停止、启动、重开和 CPU 恢复均使用这一方法。原 `wide-probe-timeout-recovery` 的过早断言、`wide-nvdec-wayland` 的 HEVC 重开失败保留，修正后的 `verified-*` 报告单独生成，不覆盖失败证据。旧脚本每秒读取后的明确断言和截图仍是有效观察，但其等待条件本身不计为成功证据。

## 改动范围与启动

- `apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp`：单次 640×360 固定色块，沿用正常 buffer lease 与释放同步。
- main/preload 的 `linuxSharedTexture.ts` 及测试：按真实 Canvas 读回验证固定颜色；校验来源、序号和绑定，限制超时与样本字段。
- `linuxPlaybackBridge.ts`、`linuxPlaybackFallback.ts`、`nativePlayback.ts`、`playbackSession.ts` 和共享播放合同：固定错误分类、CPU 恢复期限、硬解/显示诊断。
- `PlaybackPanel.tsx`：显示当前解码方式、画面检查和 CPU 回退原因。
- `scripts/linux-codec-{fixtures,acceptance}.mjs`：有声闪块、字幕、操作验收、隔离故障注入和正确的异步状态等待。测试 hook 不进入产品 IPC/API。

从仓库目录启动新包的 XWayland 模式：

```bash
./dist/linux-playback-self-test-wide/Javdex-0.9.0-x86_64.AppImage --javdex-x11
```

省略 `--javdex-x11` 使用既有默认显示选择；`--javdex-wayland` 可显式验证原生 Wayland。启动兼容逻辑与既有 CPU 回退保留，未改宿主设置、驱动、权限或用户媒体。

## 最终结果

同一新包完成 20 个自动用例，修正等待逻辑后的报告均为 `passed-automated`，对应截图已经检查：

| 范围 | 结果 |
| --- | --- |
| Wayland 与 XWayland × NVDEC/VA-API × H.264/HEVC Main10/AV1 | 12 个用例；暂停恢复、2/6/1 秒跳转、字幕、音量/倍速、窗口缩放及重开通过 |
| 注入错误色块回执 | 自动切 CPU、继续播放；诊断为 DISPLAY_SELF_TEST_FAILED |
| 丢弃色块回执 | 等待约 8 秒后自动切 CPU；诊断为 DISPLAY_SELF_TEST_TIMEOUT |
| 运行中注入 GPU 退出通知 | 暂停在 1 秒、外部字幕、音量 37、1.25× 倍速均恢复到 CPU；恢复播放及再次重开 GPU 通过 |
| 纯黑合成影片 | GPU 模式继续播放，没有误触发 CPU 回退 |
| 强制软件解码、GPU 显示 | 保留 GPU 显示，未将软件解码误判为显示故障 |
| 手动 CPU × 三种编码 | 3 个用例均有实际彩条画面并正常推进 |

故障注入仅发生在隔离验收进程：回执替换/丢弃以及模拟 Electron `child-process-gone` 通知，不是杀死真实 GPU 进程，也不声称覆盖驱动崩溃后的全部 Chromium 恢复行为。

同一最终包另有 Wayland 与 XWayland NVDEC H.264 各 65 秒逐秒观察；两者采样的播放器丢帧统计均从 0 到 0。HEVC Main10/AV1 为短片功能测试，未作为 60 秒或 4K60 性能证明。逐帧物理扫描输出没有测量。

人工最终确认：标题为“Javdex X11 自检修复验收（640×360 新包）”的独立窗口，用户明确回复“画面顺畅，提示音与闪块大致同步”。这次确认有效，之前撤回的 X11 回复不计入。窗口使用隔离资料库、GPU 模式，实际 NVDEC 解码，自检状态 passed；测试片自然结束后重新播放，手动暂停不被覆盖。保留窗口供继续查看。

全部自动结果索引：任务目录 `evidence/linux-playback-self-test/final-matrix.json`；新窗口身份与最新状态：仓库 `out/linux-codec-acceptance/wide-x11-human/`。本报告与修改一并保存为 `257af93` 之后的本地基线；未推送、合并或发布。

## 提交前完整审查

审查覆盖本次所有产品代码、协议/资源生命周期、单次回退及状态恢复、诊断字段、UI、验收脚本、测试和文档。9 个修改的产品源码文件与已验收包的构建输入逐字节一致；本轮未再修改产品行为，未重复打包。新增审查修正仅包括验收脚本拒绝空/非法用例数量与过短/非法时长，防止“零用例通过”；协议测试补充错误自检尺寸和 CPU 通道不等待 GPU 自检。28 个共享纹理测试及四项非法 CLI 参数检查通过。

完整 `npm test` 已执行。架构边界、全量 ESLint/CSS 检查、类型检查、打包/原生构建合同与备份 smoke 单元测试阶段通过；Electron 测试结果为 **4219 项，4187 通过、12 失败、20 跳过**，不能标记全套全绿。

将失败的 11 个测试文件放到 `git archive 257af93` 的隔离源码副本、使用相同依赖和测试启动方式重新运行，复现 **相同的 12 项失败**（该子集 23 项，11 通过、12 失败）。涉及远程分类图、刮削工作流、目录图像操作/恢复/上传与媒体缩略图等；没有本次播放修改涉及的文件。失败集合逐项一致，说明本机该基线已有测试问题；尚未确定其底层原因，不凭 Sharp 警告就断言根因。没有忽略或改写这些失败测试。

本次播放、自检、回退与 UI 用例未发现新增失败，前述 20 个真实包用例和用户画面确认保留。验证结论限于已覆盖范围，不承诺其他平台无回归。完整日志、基线失败列表、对比和产品源码对照保存在任务目录 `evidence/linux-baseline-review/`；隔离旧源码在仓库 `out/review-baseline-257af93/`。
