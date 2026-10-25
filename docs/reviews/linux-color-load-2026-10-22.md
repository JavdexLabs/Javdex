# Linux 色彩与高分辨率播放验收（2026-10-22）

本地基线 `17c69ea` 上的未发布修改；不代表公开 0.9.0。保留旧包及 `out/linux-software-runtime.before-color-20261022`，未修改系统设置或增加系统包。用户暂无其他机器，跨机器矩阵仍待完成。

本机为 Ubuntu 26.04.1 / GNOME Wayland；X11 测试实际是 XWayland。当前 DRM 映射为 Intel UHD 770（8086:4680）`renderD128`、NVIDIA RTX 4080（10de:2704）`renderD129`。本机结果不外推其他显卡或原生 Xorg。

## 产物与根因

新包：`dist/linux-color-sdr-fix/Javdex-0.9.0-x86_64.AppImage`，SHA-256 `7e7e47817bbddf96131bc249788df4540ce7eed3e967934816388412feec54da`，同目录有 deb。GPU helper/ANGLE 保持原有修复；CPU helper 在原获准 Ubuntu 22.04 隔离环境重建，使用原有 FFmpeg 9.0.2 / libmpv 和依赖闭包，没有新增运行库。

旧 CPU 软件渲染器使用 legacy `sws_scale`，YUV→RGB 不等于 HDR→SDR。独立 PQ 灰阶输入在 CPU 输出为 `[0,16,38,77,112,130,167,192]`，基本就是 PQ 编码值乘 255；高光未转换至 SDR 白。`mpvCore.h` 的 CPU 专用初始化增加 FFmpeg frame API `scale` 的 perceptual BT.709 转换。GPU 路径不变。

代码依据：固定源码包内 FFmpeg `libavfilter/vf_scale.c`、`libswscale/graph.c`、`libswscale/cms.c` 和 mpv `video/sws_utils.c`、`video/out/libmpv_sw.c`。外部说明：[FFmpeg scale](https://ffmpeg.org/ffmpeg-filters.html#scale)、[mpv tone mapping](https://mpv.io/manual/stable/#options-tone-mapping)。CPU 使用 FFmpeg perceptual 曲线，GPU 保留 mpv 曲线，不能宣称像素一致。

## 色彩矩阵

`out/linux-color-fixtures-v3` 为当前参考夹具（以实际目录 manifest 为准）：1280×720、HEVC lossless 10-bit、12 秒。SDR full/limited BT.709 的参考灰阶为 `[0,.02,.08,.22,.5,.75,.94,1]`；HDR10 和 HLG 中性灰阶为 `[0,.1,1,10,50,100,400,1000]` cd/m²。HDR10 带 BT.2020 1000-nit mastering metadata；HLG 中性参考使用 nominal 1000-nit display、gamma 1.2。色块用于色相检查，不把 HLG 彩色色块视作精确绝对亮度测量。

新包 Wayland/XWayland × GPU/CPU × SDR limited/full/HDR10/HLG 共 16 项自动通过，证据 `out/linux-color-final-{wayland,x11}-{gpu,cpu}/report.json` 及 PNG。先截图再 Canvas 读回，避免读回影响首次截图。SDR 灰阶和原色误差不超过 3/255；截图与 Canvas 灰阶偏差不超过 4/255。HDR 检查黑位、递增灰阶、峰值与原色色相，不声称物理显示器校准。

Wayland HDR10 实测灰阶：GPU `[2,8,23,65,135,184,249,255]`，CPU `[0,9,24,63,115,142,205,255]`。400-nit 色块差 44/255：修复了把 HDR 编码直接显示的错误，但 GPU→CPU 回退仍可能改变高光亮度。统一 tone curve、复杂宽色域内容/动态元数据、原生 HDR 输出另行验证。

## 缺依赖与设备隔离

- 隐藏宿主 `libva.so.2`：`out/linux-color-missing-vaapi-verified`，Auto 在真实 GPU helper 初始化失败后回退 CPU，65 秒、mpv 丢帧增量 0，截图及 Canvas 有图。原因 `GPU_INITIALIZATION_FAILED`。
- 使用 bubblewrap 最小 `/dev` 隐藏 GPU 设备，正常应用启动参数：`out/linux-color-no-devices`，Auto→CPU，原因 `DRM_RENDER_NODE_UNAVAILABLE`，65 秒、丢帧增量 0，最终窗口截图已人工（agent）查看，有彩条和图形。Chromium 软件合成，无应用 GPU 设备访问。
- 先前额外 `--disable-gpu` 的实验截图超时，用户没找到指定窗口，不算画面通过。早期缺库夹具未正确绑定 `/dev` 导致启动错误，也不算产品失败或通过。失败目录保留。

上述隔离仍使用宿主 GNOME、音频服务及其余用户态库，不能代替干净发行版/真正无 GPU 桌面。也未覆盖 AMD、原生 Xorg、KDE Wayland 或其他驱动版本。

## 性能方法与边界

4K 测试使用 3840×2160 输入，Wayland Canvas 为 2070×1060，XWayland 为 2760×1487（后者 devicePixelRatio=2），而非 4K 显示器原生扫描输出；两者输出像素负载不同，不能用这组结果归因显示后端性能差异。H.264/HEVC Main10 为 60 fps，AV1 为 30 fps。每项连续 65 秒，一次只运行一项，不与编码/构建并行。运行中只读状态和 `/proc`，结束后才截图/Canvas 读回。GPU 实际解码器、丢帧、进程 CPU ticks/RSS/FD 均见逐秒 report。RSS 是各进程驻留量，不把共享页重复相加后的数值称为独占内存。

用户对当前 Wayland GPU 4K 窗口反馈“正常”；这不能扩展成所有矩阵单元的人眼确认，也不抹去 mpv 记录的丢帧。丢帧计数不是物理扫描输出帧率。



## 后续优先项

1. 先定位 GPU helper 五分钟内持续 RSS 增长，区分缓存/分配器保留与泄漏；随后对 4K60 建立分阶段耗时剖析：先固定相同物理输出尺寸，再做 NVDEC-copy / VAAPI-copy 对照、解码→上传、helper 渲染、CPU 缩放/IPC、消费端等待。不要仅增大提前量，也不要把 mpv drop count 当作全部显示丢帧。
2. 比较同一 HDR 内容在 GPU 与 CPU 回退前后的 tone curve，选择明确的共同 SDR 目标与色调映射策略；当前修复只保证 CPU 不再直接显示 HDR 编码值。
3. 有可用环境后补干净 Ubuntu/Fedora、纯 Intel、AMD、原生 Xorg、KDE Wayland；缺库隔离不能取代它们。原生 HDR、数小时播放与 4K 原生显示分辨率仍需独立验收。

## 4K 测量结果

每行 65 秒，GPU 均实际使用 `nvdec-copy`，CPU 均 `no`。表中 CPU 为整个测试进程树平均使用的逻辑核心数（100 ticks/s）；不是宿主 CPU 总利用率。

| 后端 | 模式 | 输入 | mpv 丢帧增量 | CPU 核心 | helper 峰值 RSS MiB |
|---|---|---|---:|---:|---:|
| wayland | cpu | av1-4k30 | 1 | 2.48 | 374.5 |
| wayland | cpu | h264-4k60 | 931 | 2.84 | 531.8 |
| wayland | cpu | hevc-main10-4k60 | 1053 | 4.16 | 873.8 |
| wayland | gpu | av1-4k30 | 0 | 0.94 | 451.1 |
| wayland | gpu | h264-4k60 | 371 | 1.35 | 602.1 |
| wayland | gpu | hevc-main10-4k60 | 181 | 1.4 | 599.0 |
| x11 | cpu | av1-4k30 | 3 | 3.56 | 403.9 |
| x11 | cpu | h264-4k60 | 1389 | 3.8 | 564.0 |
| x11 | cpu | hevc-main10-4k60 | 1895 | 5.51 | 903.1 |
| x11 | gpu | av1-4k30 | 0 | 0.96 | 456.9 |
| x11 | gpu | h264-4k60 | 288 | 1.47 | 538.8 |
| x11 | gpu | hevc-main10-4k60 | 183 | 1.41 | 603.7 |

全部有最终截图及彩色 Canvas，状态为 measured，不能将其读成“满帧通过”。输入帧率、输出像素负载、编码复杂度均影响结果。GPU/CPU 的 4K60 均需继续剖析，而不是直接扩大现有自适应提前量。证据：`out/linux-load-{wayland,x11}-{gpu,cpu}-*/report.json`；汇总 `out/linux-color-build/load-summary.json`。

## 五分钟连续播放

Wayland GPU（1080p30，NVDEC-copy）连续 300 秒，mpv 丢帧增量 0，最终截图有正常图形；整个进程树平均 0.70 个逻辑核心。helper FD 固定 171，但 RSS 随时间从 368.7 MiB 增到 414.4 MiB；第 60/120/180/240/300 秒分别为 377.2/386.8/396.0/405.3/414.4 MiB。后段仍增长，**不判定内存稳定通过，也尚无证据确定泄漏根因**。后续需区分缓存、分配器/驱动保留和真正未释放对象；GPU RSS 趋势应优先复测。证据 `out/linux-load-long-wayland-gpu/report.json`。

本轮 5 分钟仅是延长测试，不等于数小时稳定性验收。

XWayland CPU（1080p30）连续 300 秒，mpv 丢帧增量 1，平均 2.4 个逻辑核心；helper RSS 211.7→220.1 MiB，峰值 220.1 MiB，FD 范围 [13, 13]。最终截图与 Canvas 输出正常。证据 `out/linux-load-long-x11-cpu/report.json`。

## 回归与构建验证

- CPU helper 原生构建、运行库依赖闭包与内置 smoke 通过；GPU 运行库未更换。源码归档中的 `mpvCore.h` 与当前工作区字节一致。
- 桌面生产构建、AppImage/deb 打包通过。AppImage 188126839 bytes（179.4 MiB），deb 165213752 bytes（157.6 MiB）；deb 仅构建，未执行系统安装。
- `check-linux-integrated-appimage.mjs` 通过：95 个文件匹配、GPU/CPU ELF 闭包及 ANGLE 来源身份有效。证据 `out/linux-color-build/package-check.json`。
- 35 项 native/build/reference 针对测试、173 项播放相关 Electron 测试通过。
- 新包 CPU 的 Wayland/XWayland 操作回归通过：暂停/恢复、2→6→1 秒跳转、外部字幕、音量/倍速、两种窗口尺寸、停止与重开；字幕截图已查看。证据 `out/linux-color-controls-{wayland,x11}`。本轮未重新声称这些操作在 HDR 复杂字幕或所有 GPU 上都覆盖。
- 新增参考公式测试接入 `test:playback:fixtures`。完整测试结果另见下方最终记录。

运行新包：从项目根执行 `./dist/linux-color-sdr-fix/Javdex-0.9.0-x86_64.AppImage`，可附加 `--javdex-wayland` / `--javdex-x11` / `--javdex-cpu`。自动化全部使用独立测试资料库，不修改用户媒体或正常资料库。

最终 `npm test` 退出 0，包含 lint/架构检查、类型检查、打包、播放夹具/构建及备份 smoke；Electron 部分 4274 项测试：4254 通过、0 失败、20 跳过。日志 `out/linux-color-build/full-tests.log`。`git diff --check` 与新增脚本语法检查通过。工作区改动未提交，未推送/合并/发布。
