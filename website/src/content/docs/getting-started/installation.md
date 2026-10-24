---
title: 桌面端安装与系统配置
description: 针对 Windows、macOS 与 Linux 系统的桌面客户端安装、系统权限放行与音视频/AI 依赖配置指南。
---

Javdex 桌面端支持 64 位 Windows、macOS（Apple Silicon 与 Intel 芯片）以及主流 Linux 发行版。

在开始安装前，请先前往 [下载中心](/Javdex/download/) 获取对应操作系统的最新安装包。

---

## Windows 安装与配置

### 1. 安装包选择
- **向导安装包 (`Javdex-Setup-0.9.1-x64.exe`)【推荐】**：
  - 基于 NSIS 打包，支持自由选择安装路径，自动创建开始菜单和桌面快捷方式，支持完整卸载。
- **免安装绿色压缩包 (`Javdex-Setup-0.9.1-x64.zip`)**：
  - 解压至任意英文路径文件夹后，双击运行内部的 `Javdex.exe` 即可使用。适合便携携带或多版本测试。

### 2. Windows Defender SmartScreen 安全提示
由于开源版本暂未购买昂贵的商业数字证书（Authenticode），Windows SmartScreen 可能会在首次运行时弹出蓝色提示框阻断：
1. 点击弹窗上的 **“更多信息（More info）”**。
2. 点击出现的 **“仍要运行（Run anyway）”** 按钮即可正常启动。

### 3. 播放器图形渲染与 GPU 驱动
- Javdex 的内置播放器使用 `libmpv` 解码，通过 Canvas 显示。默认自动模式优先 GPU；图形初始化、自检或可检测运行故障后受控恢复到 CPU。在“此电脑”中选择自动／GPU／CPU 兼容模式，重新打开影片后应用。
- 若需使用本地 AI 实时字幕加速，Windows 的 NVIDIA 运行库使用 **CUDA 12.4**，新增 Linux x64 构建使用 **CUDA 12.8**，需要相容驱动；也可选择驱动支持的 **Vulkan** 后端。加速运行库由应用按需下载，不需要安装完整 CUDA 开发工具包。

---

## macOS 安装与配置

### 1. 架构选择（Apple Silicon vs Intel）
- **Apple Silicon 芯片 (`Javdex-0.9.1-arm64.dmg`)**：适用于配备 M1 / M2 / M3 / M4 系列芯片的 Mac 电脑。
- **Intel 芯片 (`Javdex-0.9.1-x64.dmg`)**：适用于搭载 Intel 处理器的传统 Mac 电脑。

双击打开下载的 DMG 磁盘映像文件，将 `Javdex.app` 拖入系统的 `Applications`（应用程序）文件夹中即可完成安装。

### 2. Gatekeeper 隔离属性与“已损坏”提示解除
macOS 安装包采用 Ad-hoc 签名且未向 Apple 提交公证（Notarization）。首次打开时，系统可能会提示：
> “Javdex 已损坏，打不开。您应该将它移到废纸篓。” 或 “无法打开，因为 Apple 无法检查其是否包含恶意软件。”

此时请打开终端（Terminal），执行以下命令移除系统的下载隔离属性：

```bash
xattr -dr com.apple.quarantine /Applications/Javdex.app
```

执行后即可正常双击启动 Javdex。

### 3. 系统版本与 AI 运行库要求
- **内置原生播放**：支持 **macOS 12.0+ (Monterey 及更高版本)**。
- **本地 AI 字幕与模型推理**：必须使用 **macOS 13.3+ (Ventura 及更高版本)**（内核版本 `Darwin >= 22.4`）。
  - `whisper-cli` 和 `ffmpeg`／`ffprobe` 从 Javdex Runtime 固定发行按需下载，不再随主安装包携带；首次准备需要联网，并校验下载摘要。支持时可选择 Metal 加速，实际使用情况以应用诊断为准，CPU 仍可使用。

---

## Linux 安装与配置

### 1. 软件包格式选择
- **AppImage 格式 (`Javdex-0.9.1-x86_64.AppImage`)**：
  - 通用可执行镜像，适用于几乎所有 Linux 发行版。
  - 下载后赋予可执行权限即可启动：
    ```bash
    chmod +x Javdex-0.9.1-x86_64.AppImage
    ./Javdex-0.9.1-x86_64.AppImage
    ```
- **DEB 软件包 (`Javdex-0.9.1-amd64.deb`)**：
  - 适用于 Ubuntu、Debian、Linux Mint 等系统。
  - 安装命令：
    ```bash
    sudo dpkg -i Javdex-0.9.1-amd64.deb
    # 若有缺失依赖，可运行修复：
    sudo apt-get install -f
    ```

### 2. X11、XWayland 与原生 Wayland 播放

两类显示后端均通过隔离播放进程向 Canvas 输出画面，不再要求原生窗口嵌入。通常按桌面会话启动；需要明确选择时使用 `--javdex-x11` 或 `--javdex-wayland`，也可使用对应 Ozone 参数。

默认自动模式优先使用 GPU，图形路径不可用时可恢复到 CPU。手动 GPU 模式会明确报告故障；手动 CPU 使用软件解码和绘制，保留实际显示尺寸，但高分辨率素材可能明显丢帧。`--javdex-cpu` 只强制视频 CPU；`--javdex-software` 同时关闭界面硬件加速。

### 3. 本地 AI 实时字幕系统依赖
若计划在 Linux 上运行本地 AI 日中字幕，宿主机需满足：
1. **glibc 运行时版本**：要求 `glibc >= 2.38`（可通过 `ldd --version` 检查）。
2. **GCC C++ 运行时**：安装 GCC 14 兼容的 `libstdc++6`。

运行库从 Javdex Runtime 按需下载，POSIX 工具使用应用可直接解压的 gzip 归档，无需另装 `xz-utils`。
