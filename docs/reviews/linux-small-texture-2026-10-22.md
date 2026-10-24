# Linux 小尺寸 DMA-BUF 导入修复（2026-10-22）

本轮优先处理原 64×64 自检异常；RSS 长测排查按用户要求暂停。保留前一轮 CPU HDR 转 SDR 修复、旧包、CPU 回退和全部工作区改动，未改系统设置/驱动、未新增系统包、未推送或发布。

## 定位证据

环境：NVIDIA RTX 4080 / 595.99.02 / `renderD129`，Intel UHD 770 为 `renderD128`；GNOME Wayland 上的 XWayland。不是其他 NVIDIA 驱动或原生 Xorg 的普遍结论。

使用同一个 GBM DMA-BUF：NVIDIA EGL 写入固定 RGBA `[64,191,128,255]` 并完成 GPU 工作，然后分别读取原生 EGL、随包 ANGLE/Vulkan 和直接 Vulkan。后两项在独立进程中导入同一 FD、尺寸、stride 和 modifier；不经过 Electron、Canvas、视频解码或应用调度。

64×64、stride 256 的结果：

| modifier | 分块高度 | 原生 EGL | ANGLE/Vulkan 正确像素 | 直接 Vulkan 正确像素 |
|---|---:|---|---:|---:|
| `0x0300000000606015` | 256 行 | 正确 | 1024 / 4096 | 1024 / 4096 |
| `0x0300000000606014` | 128 行 | 正确 | 2048 / 4096 | 未单独测 |
| `0x0300000000606013` | 64 行 | 正确 | 4096 / 4096 | 4096 / 4096 |

原 helper 从 Vulkan 广告列表里选择第一个能分配的 modifier；该列表顺序在本机把 256 行 block 放在前面。过大的 block 在 GBM/EGL 与 Vulkan 导入时产生不同的像素布局解释，且调用返回成功。直接 Vulkan 已复现，因此排除 Electron、Canvas 或 ANGLE 独有问题；尚不能从闭源驱动外部断言 GBM/EGL 和 Vulkan 中具体哪个内部函数出错。

对照矩阵含 10 种尺寸 × 7 个 modifier，覆盖宽高独立变化；较大尺寸（如 640×360）原 modifier 正常。线性 modifier 在本机虽被 Vulkan 广告，但 GBM 渲染分配失败，这些项单独记录，未算通过。

Linux DRM 的 NVIDIA modifier 定义用低 4 位表示 block 的 GOB 高度对数，generation 决定每个 GOB 为 4 或 8 行。依据为本机 `/usr/include/libdrm/drm_fourcc.h` 的 `DRM_FORMAT_MOD_NVIDIA_BLOCK_LINEAR_2D` 注释。Vulkan 的 [显式 modifier 导入合同](https://docs.vulkan.org/refpages/latest/refpages/source/VkImageDrmFormatModifierExplicitCreateInfoEXT.html)要求结合 modifier 和 plane layout 验证图像；广告支持不等于应用可以省略真实像素验证。

原始程序与输出：`out/linux-small-texture/` 中的 `layout-matrix.py`、`angle-readback.py`、`vulkan-readback.cpp`、`matrix.json`、`direct-vulkan-*.log`。这些是本地诊断，不是新增产品 IPC。

## 修复

`linuxDmaBuf.h` 增加小型、无驱动依赖的布局选择函数；`linuxDmaBufPlayback.cpp` 只在 Vulkan consumer modifier 协商分支中使用：对已知 NVIDIA block-linear 布局，跳过 block 高于实际图像的候选（最小单 GOB 允许不足一块的图像），继续选择驱动实际广告且 GBM 能分配的 modifier。

不修改分配后导出的 modifier、不伪造 stride、不填大图裁剪、不禁用 GPU，也不强制所有尺寸线性布局。640×360 及正常大画面仍可使用原 256 行 block。其他 vendor、线性、未知 layout 保持原行为；Wayland 无 Vulkan 协商的分支及 CPU runtime 不变。未知布局仍由已有自检和 CPU 回退保护，不能宣称任意新 modifier 已验证。

`linuxDmaBuf.test.cpp` 覆盖高度边界、最小 GOB、旧 generation、未知 generation、其他 vendor 与线性布局。原生测试通过。

独立实际 helper（含 libmpv 视频渲染）在 64×64 请求尺寸下，旧 helper 的三帧 ANGLE/EGL 完整 RGBA SHA-256 全部不一致；新 helper 选择 `...6013`，三帧完整像素哈希全部一致。证据 `old-helper-64-frames.log` / `new-helper-64-frames.log`。此外修复策略在 1、7、17、33、63、65、127、129、255、257 像素方形下全像素通过，见 `odd-sizes.json`。

生产自检仍保留 640×360 及严格来源/色值校验；本轮通过额外小尺寸视频帧验证修复，不将扩大自检尺寸再宣称为根因修复。

## 实际包验证

验收脚本可设置 `JAVDEX_ACCEPTANCE_NATIVE_SIZE=64x64`，通过仅测试进程的 main inspector 钩子覆盖 helper viewport。产品协议/API 不增加调试入口；报告记录该设置并断言实际 Canvas 像素尺寸，防止仅测了缩小窗口却仍使用大纹理。

重用已授权的 Ubuntu 22.04 隔离环境构建 GPU helper，未新增包。旧 GPU runtime 完整保存在 `out/linux-portable-runtime.before-small-texture-20261022`；CPU runtime 未替换。

新产物位于 `dist/linux-small-texture-fix/`：

- AppImage：188,126,858 字节；SHA-256 `f1dc77799d7050a1363fdbc009aa813a9a25d75f0305030ca76b0168c208f600`。
- deb：165,214,020 字节；本轮未安装 deb。
- 集成包校验通过：95 个文件与本地运行库匹配，GPU 36 个、CPU 38 个 ELF 闭包及源码归档检查通过，ANGLE 补丁来源一致。见 `out/linux-small-texture/package-check.json`。
- 原生布局/协议/lease 测试、33 项构建与打包测试、61 项共享纹理/设备/回退测试通过。本轮未重跑全仓测试；此前全仓结果不作为本次新代码的执行记录。

实际 AppImage 对照：

| 包 / 模式 | 实际纹理 | 结果 |
|---|---|---|
| 旧包 / XWayland GPU | 64×64 | SDR 灰阶误差 255，异常黑块复现 |
| 新包 / XWayland GPU | 64×64 | SDR limited/full、HDR10→SDR、HLG→SDR 四项通过 |
| 新包 / Wayland GPU | 64×64 | 同上四项通过 |
| 新包 / XWayland GPU | 32×32 | 同上四项通过 |

新包 SDR 灰阶最大误差 1/255；截图按 `object-fit: contain` 的真实内容区域映射到 Canvas 像素中心，屏幕与 Canvas 一致性校验通过。证据目录 `*-mapped/report.json`。早期截图脚本错误地使用整个元素框（含黑边）采样，失败记录仍保留；已修正坐标，未放宽色差阈值。最初在自检前强制小尺寸的一次旧包运行出现自检超时，不能用作像素证据；最终钩子保留正常自检，只在通过后设置小视频纹理。

新包 XWayland GPU 64×64 连续播放 65 秒，计时阶段不读回像素，结束后检查真实 Canvas 为 64×64 且有彩色输出，报告丢帧增量 0。用户对“Javdex 64×64 GPU 修复验收”画面、异常黑块和音画大致同步的问题答复“正常”。该确认是定性观察，不是音频时差测量。见 `tiny64-motion/report.json`、`end.png`。

正常尺寸 XWayland GPU / nvdec-copy 1080p30 连续 65 秒通过，丢帧增量 0；暂停/恢复、三次跳转、外挂字幕、两次窗口缩放、停止重开通过，字幕和重开截图已检查。证据 `controls-x11/`。

Wayland GPU / nvdec-copy 同样完成 65 秒，丢帧增量 0，暂停恢复、三次跳转、字幕、缩放、重开均通过，字幕截图已检查。证据 `controls-wayland/`。

用户在测试中将 AppImage 移至 `/home/nut/桌面/Javdex-0.9.0-x86_64.AppImage`；再次核对 SHA-256 与上列值一致。一次后续测试因原路径不存在而未启动（`fallback-x11.log`），不计为产品失败或通过。回退复测使用桌面同一份包：注入自检黑帧后以 `DISPLAY_SELF_TEST_FAILED` 自动进入 CPU，并检查彩色像素通过；注入 GPU 进程退出后以 `GPU_PROCESS_EXITED` 恢复到 CPU，保留暂停位置、字幕、音量、倍速，恢复播放和停止重开通过。证据 `fallback-probe-x11/`、`fallback-runtime-x11/`。最终 `git diff --check` 通过。

## 验证边界

本次修复与实际画面验收限于上述本机驱动组合；没有 AMD、其他 NVIDIA 版本或原生 Xorg 机器的实测。64×64 和奇数尺寸结果不代表已遍历全部分辨率/格式。CPU 自动回退保留，原生 HDR 输出与 GPU helper RSS 增长仍是独立未完成事项。本轮修改未提交；不推送、合并或发布。

启动新包：

```sh
/home/nut/桌面/Javdex-0.9.0-x86_64.AppImage --javdex-x11
# 或 --javdex-wayland
```

普通启动不会强制 64×64；小尺寸只由验收脚本通过独立测试配置施加。
