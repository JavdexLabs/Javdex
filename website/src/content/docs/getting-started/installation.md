---
title: 桌面端安装与系统配置
description: 针对 Windows、macOS 与 Linux 系统的桌面客户端安装、系统权限放行与音视频/AI 依赖配置指南。
---

Javdex 桌面端支持 64 位 Windows、macOS（Apple Silicon 与 Intel 芯片）以及主流 Linux 发行版。

在开始安装前，请先前往 [下载中心](/Javdex/download/) 获取对应操作系统的最新安装包。

---

## Windows 安装与配置

### 1. 安装包选择
- **向导安装包 (`Javdex-Setup-0.9.0-x64.exe`)【推荐】**：
  - 基于 NSIS 打包，支持自由选择安装路径，自动创建开始菜单和桌面快捷方式，支持完整卸载。
- **免安装绿色压缩包 (`Javdex-Setup-0.9.0-x64.zip`)**：
  - 解压至任意英文路径文件夹后，双击运行内部的 `Javdex.exe` 即可使用。适合便携携带或多版本测试。

### 2. Windows Defender SmartScreen 安全提示
由于开源版本暂未购买昂贵的商业数字证书（Authenticode），Windows SmartScreen 可能会在首次运行时弹出蓝色提示框阻断：
1. 点击弹窗上的 **“更多信息（More info）”**。
2. 点击出现的 **“仍要运行（Run anyway）”** 按钮即可正常启动。

### 3. 播放器图形渲染与 GPU 驱动
- Javdex 的内置播放器使用 `libmpv` 原生引擎。程序会在检测到内置播放运行库时自动注入 `--disable-direct-composition` 参数，以确保在多数 Windows 显卡驱动下窗口嵌入稳定无黑屏。
- 若需使用本地 AI 实时字幕加速，建议将 NVIDIA 显卡驱动升级至支持 **CUDA 12.4** 的版本，或确认显卡驱动支持 **Vulkan**。

---

## macOS 安装与配置

### 1. 架构选择（Apple Silicon vs Intel）
- **Apple Silicon 芯片 (`Javdex-0.9.0-arm64.dmg`)**：适用于配备 M1 / M2 / M3 / M4 系列芯片的 Mac 电脑。
- **Intel 芯片 (`Javdex-0.9.0-x64.dmg`)**：适用于搭载 Intel 处理器的传统 Mac 电脑。

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
  - macOS 安装包内已预先捆绑并完成安全签名的 `whisper-cli`（原生集成 Metal 硬件加速）与 `ffmpeg`/`ffprobe`。启动 AI 字幕时无需手动配置外部环境，Metal 加速会自动生效。

---

## Linux 安装与配置

### 1. 软件包格式选择
- **AppImage 格式 (`Javdex-0.9.0-x86_64.AppImage`)**：
  - 通用可执行镜像，适用于几乎所有 Linux 发行版。
  - 下载后赋予可执行权限即可启动：
    ```bash
    chmod +x Javdex-0.9.0-x86_64.AppImage
    ./Javdex-0.9.0-x86_64.AppImage
    ```
- **DEB 软件包 (`Javdex-0.9.0-amd64.deb`)**：
  - 适用于 Ubuntu、Debian、Linux Mint 等系统。
  - 安装命令：
    ```bash
    sudo dpkg -i Javdex-0.9.0-amd64.deb
    # 若有缺失依赖，可运行修复：
    sudo apt-get install -f
    ```

### 2. 内置原生播放的关键要求：X11 与 `--javdex-x11` 参数
Linux 下的 `libmpv` 原生窗口嵌入由独立的后台子进程 `playback-helper` 驱动：
- **显示服务要求**：当前内置原生播放**必须运行在 X11 或 XWayland 显示服务下**（环境变量 `DISPLAY` 必须有效）。
- **启动参数要求**：
  - 若需要使用内置播放器播放视频，启动 Javdex 时必须附带参数：
    ```bash
    javdex --javdex-x11
    # 或者使用等效的 Ozone 参数：
    javdex --ozone-platform=x11
    ```
  - :::caution[纯原生 Wayland 限制]
    如果在未启用 XWayland 的纯 Wayland 环境下启动且未传递 `--javdex-x11`，打开内置播放器时系统会检测并拦截，提示“Linux 内置播放需要 X11 环境”并引导切换为外部播放器（如 VLC、MPV）。
    :::

### 3. 本地 AI 实时字幕系统依赖
若计划在 Linux 上运行本地 AI 日中字幕，宿主机需满足：
1. **glibc 运行时版本**：要求 `glibc >= 2.38`（可通过 `ldd --version` 检查）。
2. **GCC C++ 运行时**：安装 GCC 14 兼容的 `libstdc++6`。

运行库从 Javdex Runtime 按需下载，POSIX 工具使用应用可直接解压的 gzip 归档，无需另装 `xz-utils`。
