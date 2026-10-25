# Linux NVDEC / Intel VA-API 补齐（2026-10-22）

本轮在 `b8de3bc` 与已有本地修改上补齐 NVIDIA NVDEC 构建，并完成 Intel VA-API 驱动与加载 ABI 修正。保留 GPU 显示、目标时间调度和 CPU 自动回退。未提交、推送、合并或发布；旧包仍在 `dist/linux-x64-pruned/`，旧 GPU runtime 在 `out/linux-portable-runtime/linux-x64.before-hwdecode-20261022/`。

## 改动和依据

- `build/playback-sources.json` 固定官方 `nv-codec-headers` 12.1.14.0 的下载地址、长度、SHA-256 和许可证文件。Linux GPU 构建显式启用 FFmpeg CUDA/NVDEC 与 mpv CUDA，关闭 NVENC。无需 CUDA Toolkit，不分发 NVIDIA 驱动。CPU 构建显式禁用这些硬解接口。
- `scripts/playback-source-build.mjs` 保持 `hwdec=auto-copy` 的应用策略。mpv CUDA interop 编译选项必须启用以满足其 GL 路径的 `cuda_gl_fn` 链接；这不等于应用启用了零拷贝解码。对应构建计划测试覆盖 GPU / CPU 的差异。
- `scripts/linux-portable-runtime.mjs` 新增 `host-vaapi-cxx-v1` manifest 策略：GPU 使用宿主 libva、libva-drm、libva-x11、libstdc++、libgcc；校验器禁止在新 GPU runtime 内覆盖这些宿主 ABI。旧 manifest 继续按旧策略校验，CPU 的依赖闭包不变。
- 诊断依据：旧包私有 libva API 1.14 无法加载当前 Intel iHD 驱动的新版入口；改用宿主 libva 后 H.264 / HEVC 硬解成功。新版 Intel GMM 亦需要宿主 C++ ABI，不能被私有旧 C++ 库覆盖。
- 经用户授权安装 Intel 用户态驱动及 GMM。先装自由功能版后，AV1 探测仍拒绝 profile；改用完整功能版后 AV1 进入 `vaapi-copy`。最终新增 `intel-media-va-driver-non-free 26.1.2+ds1-1`、`libigdgmm12 22.9.0+ds1-1`，自由功能版已被替换。未更换内核、NVIDIA 驱动、用户组或系统安全设置。
- `scripts/linux-codec-acceptance.mjs` 增加活动硬解器逐秒断言，以及仅验收进程可用的强制解码器钩子。没有增加产品任意命令接口；当前 Intel 对照指定本机已核对的 `renderD128`。

上游依据：[nv-codec-headers 12.1.14.0](https://github.com/FFmpeg/nv-codec-headers/tree/n12.1.14.0)（Linux 驱动最低 530.41.03），[Intel media-driver 功能矩阵](https://github.com/intel/media-driver#media-features)。这只说明 API/驱动要求，具体编码仍受硬件支持范围限制。

## 产物与证据

Ubuntu 22.04 隔离目录内构建；宿主未增加编译工具。新包目录 `dist/linux-hwdecode/`：

| 包 | 字节 | MiB | SHA-256 |
| --- | ---: | ---: | --- |
| AppImage | 184723852 | 176.17 | `d53e692547ebb8da40a5ef1dddb1408f349086edbe7b9422933c048cf22a2897` |
| deb | 161945740 | 154.44 | `305c9e6107cc796514471e30bea8d1368fb588839002bba3f57a63c22ccf5dbd` |

AppImage 比前包增加 82,133 字节，deb 减少 883,496 字节。不同容器的压缩结果不同。`SOURCES.txt` 指向对应 GPU、CPU、ANGLE 源码档案；不把源码档案塞进安装包。

- 43 项构建计划、运行库闭包和打包测试通过。
- AppImage 运行时、95 个应用构建文件、GPU/CPU manifest、ELF 依赖闭包、对应源码包摘要、ANGLE 与目标平台二进制过滤校验通过。
- deb 解包后的应用代码、GPU/CPU runtime、ANGLE 与 AppImage 输入一致；未执行系统安装。
- CPU runtime 与 ANGLE 相比上一包逐文件相同。
- 新包 libmpv / FFmpeg 为 0.41.0 / 9.0.2，实际加载查询的硬件 API 为 `cuda`、`vaapi`。
- helper 时钟合同测试通过（14 帧，11 帧带目标时间）；此项本身不算 GUI 画面验收。

原始日志与构建证据：`../evidence/linux-hwdecode/`；真实包逐秒状态、媒体摘要、截图：`out/linux-codec-acceptance/{nvdec-wayland,vaapi-wayland,nvdec-x11,vaapi-x11}/`。均为本地忽略产物，迁移时需另外保存。

## 实际画面矩阵

每格均为最终 AppImage，并逐秒断言活动解码器与 GPU 模式不回退。已逐张复核前后截图，彩条、移动图形与计时正常；所有记录的 `droppedFrames` 为 0，这不是最终扫描输出零丢帧的保证。

| 路径 | H.264 | HEVC Main10 | AV1 | 活动解码器 |
| --- | --- | --- | --- | --- |
| NVIDIA / Wayland | 65 秒 | 8 秒 | 8 秒 | `nvdec-copy` |
| Intel / Wayland | 65 秒 | 8 秒 | 8 秒 | `vaapi-copy` |
| NVIDIA / XWayland | 65 秒 | 8 秒 | 8 秒 | `nvdec-copy` |
| Intel / XWayland | 10 秒 | 8 秒 | 8 秒 | `vaapi-copy` |

CPU 手动模式在 Wayland 下复测三种编码（H.264 10 秒、HEVC / AV1 各 8 秒），活动硬解器为 `no`，截图正常。另通过不存在的 `renderD199` 注入 GPU 初始化失败，确认 `playbackMode=cpu`、`playbackFallback=true`，截图正常、helper 未打开 DRM 节点。对应记录为 `hwdecode-cpu/` 与 `auto-hwdecode-*`。

原有 MJPEG + PCM 样片另做 Wayland GPU 回归：65 秒持续播放、SRT 字幕、暂停保持位置、暂停时跳转至 20 秒、恢复、1100×750 / 1600×1000 窗口缩放、停止后重开均通过，截图已复核。渲染提交回执平均 29.95 fps、P95 间隔 46.77 ms；回执不等于扫描输出。此项验证通用播放控件，未单独覆盖每种硬解器的暂停/跳转组合。证据 `bench-hwdecode-*`。

用户另确认 NVIDIA / XWayland 测试窗口“画面顺畅，能听到测试音”。本轮未让用户判断精确音画同步。

## 验收边界

本机 Intel UHD 770（i915 / renderD128）与 RTX 4080（NVIDIA 595.84 / renderD129），GNOME Wayland；X11 通过 XWayland。Intel 测试验证 Intel 解码加当前 GPU 显示链路，不代表已覆盖 Intel 单显卡桌面。

H.264 样片为 1080p30 8-bit、HEVC 为 1080p30 Main10 SDR、AV1 为 1080p30 8-bit。硬解是否启用由实际 `hardwareDecoder` 判定，画面另看截图与末尾像素检查；持续音测试不能证明精确音画同步。截图会增加少量读回开销，不等同于零干扰的最终合成测量。

AMD、纯 Intel 桌面、原生 Xorg、无硬件 GPU 的桌面、其他发行版、HDR / 色彩管理、4K60、特殊 profile 与精确音画同步仍待验证。硬解不可用时仍可软件解码；GPU 显示不可用时仍保留 CPU helper 回退。GPU 模式仍依赖宿主正常的图形/VA-API 库与厂商驱动，不能承诺所有 Linux 环境。
