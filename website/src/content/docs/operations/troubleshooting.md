---
title: 常见问题与故障排查
description: 汇总 Javdex 常见报错与排查指南：操作系统安全放行、Linux X11 播放、Docker /data 本地文件系统要求、TLS 证书指纹冲突及 AI 模型显存回退。
---

本文档基于 Javdex 源码中的错误码与运行环境检查逻辑，汇总了安装、内置播放、本地 AI 字幕、Docker 服务端部署与元数据刮削中最常见的问题与排查方案。

---

## 安装与启动问题

### 1. Windows 启动安装包时弹出 SmartScreen “Windows 已保护你的电脑”
- **原因**：开源发行包暂未进行商业 Authenticode 代码签名。
- **解决方式**：点击弹窗中的 **“更多信息（More info）”**，随后点击 **“仍要运行（Run anyway）”** 即可正常安装。请始终从官方 GitHub Releases 或本站下载中心获取安装包并核对 `SHA256SUMS.txt`。

### 2. macOS 提示“Javdex 已损坏，打不开”或“无法验证开发者”
- **原因**：macOS DMG 采用 Ad-hoc 签名（`identity: '-'`）且未经过 Apple 公证，系统自动为下载文件附加了 `com.apple.quarantine` 隔离扩展属性。
- **解决方式**：将 `Javdex.app` 拖入 `/Applications` 后，打开终端（Terminal）运行：
  ```bash
  xattr -dr com.apple.quarantine /Applications/Javdex.app
  ```
  完成后即可正常双击打开。

---

### 3. 图形驱动故障导致主界面无法显示

以下启动保护为当前源码新增功能，尚未包含在已发布的 `0.9.1-beta.1` 安装包中。

Windows、macOS 和 Linux 使用相同规则：首次显示主窗口前，若检测到明确的 GPU 进程启动故障，最多自动重启一次，暂时使用软件界面与 CPU 视频。恢复后的提示可继续使用、重新尝试 GPU 或查看启动日志。再次失败会停止自动重试并显示日志位置；普通初始化错误不会被当作显卡故障切换。

也可以完全退出应用后，在启动命令末尾添加 `--javdex-software`，手动使用兼容模式。它同时影响界面与视频；`--javdex-cpu` 仅强制视频使用 CPU。启动日志通常位于用户数据目录的 `logs/startup.log`，以错误提示中的实际路径为准。此模式不能修复缺失运行库或不受支持的系统版本。

## 内置播放与本地 AI 字幕问题

### 1. Linux 下点击内置播放提示“需要 X11 / XWayland 环境”
- **原因**：Linux 平台的 `libmpv` 原生渲染视口通过独立子进程 `playback-helper` 实现 X11 窗口嵌入（`apps/desktop/src/main/player/playbackDisplay.ts`）。在未开启 XWayland 的纯 Wayland 会话或未指定 X11 Ozone 平台时无法嵌入窗口。
- **解决方式**：
  1. 确保当前桌面环境存在有效的 `DISPLAY` 环境变量（X11 或 XWayland）。
  2. 完全退出 Javdex 后，通过命令行附带 `--javdex-x11`（或 `--ozone-platform=x11`）重新启动：
     ```bash
     javdex --javdex-x11
     ```
  3. 若坚持使用纯原生 Wayland，可在播放报错卡片上直接点击 **“改用外部播放器”**（调用系统安装的 mpv 或 VLC）。

### 2. 本地 AI 日中字幕在 macOS 或 Linux 上提示系统环境不支持
- **原因**：`runtimeInstaller.ts` 在启动本地 AI 运行库前会检查宿主系统基线：
  - **macOS**：本地 AI 字幕与本地模型翻译要求 **macOS 13.3+（Ventura，`Darwin >= 22.4`）**（普通内置视频播放仅需 macOS 12.0+）。
  - **Linux**：要求 **`glibc >= 2.38`**、GCC 14 兼容的 `libstdc++6`。
- **解决方式**：
  - Linux 用户可通过 `ldd --version` 核对 glibc 版本，并检查 GCC C++ 运行库版本。工具从 Javdex Runtime 按需下载，不需要额外安装 `xz-utils`。

### 3. 开启 CUDA / Vulkan 加速后为什么实际回退到了 CPU 推理？

GPU 运行库未安装、驱动不兼容、设备不可用或显存预算不足都可能触发 CPU 回退。“已检测到显卡”只代表枚举成功，应以所选模型下方的实际验证结果为准。

- 在“设置 → AI 服务 → 本地模型”安装对应的 GPU 加速支持，再点击“重新检测并验证”。Linux 的 CUDA 运行依赖随可选运行库下载，无需安装完整开发工具包；Vulkan 仍需要系统的加载器和厂商驱动。
- 查看该模型显示的回退原因。可以选择更小的模型或量化精度、关闭其他占用显存的程序后再试。
- 文本引擎可只将部分层放在 GPU；显存预算不足不一定意味着完全不能加速。语音和文本分别验证，不能将其中一个成功当作另一个已通过。

---

## Docker 服务端部署与远程连接问题

### 1. 容器启动立即退出，报错 `/data 必须位于本地文件系统`
- **原因**：`apps/server/src/filesystem.ts` 在启动时调用 `statfs` 校验 `/data` 挂载点。若检测到文件系统魔数为 **NFS (`0x6969`)、CIFS (`0xff534d42`)、SMB (`0x517b`)、FUSE (`0x65735546`) 或 9P (`0x1021997`)**，程序会主动拒绝启动，防止网络文件锁缺陷损坏 SQLite WAL 数据库。
- **解决方式**：将 `/data` 与 `/program` 挂载在宿主机或 NAS 的本地物理磁盘存储池（ext4 / btrfs / ZFS / XFS）上；只有存放电影的 `/media/*` 目录才可以使用远程挂载。

### 2. 服务端添加媒体库报错无法写入 `.javdex-root`
- **原因**：容器内业务进程默认以 `UID 1000` / `GID 1000` 运行，且每个媒体库根目录必须可写以创建 `.javdex-root` 身份标记文件。
- **解决方式**：
  1. 检查 `docker-compose.yml` 中媒体目录是否以 `:rw`（读写）而非 `:ro` 挂载。
  2. 将 `JAVDEX_SERVER_UID` 与 `JAVDEX_SERVER_GID` 环境变量设置为宿主机上拥有该媒体目录读写权限的实际 UID/GID。

### 3. 桌面端连接远程服务端报错 `JAVDEX_CERTIFICATE_MISMATCH`（证书指纹不匹配）
- **原因**：桌面端首次连接服务端时会通过 TOFU（Trust On First Use）机制将 `/program/state/tls/` 中的自签名证书 SHA-256 指纹固定在本地 `server-certificates.bin` 中。如果服务端删除或重建了 `/program` 卷，新生成的证书指纹与本地记录不一致，客户端会自动阻断请求以防御中间人攻击。
- **解决方式**：如果确认是你本人重建了服务端容器，在桌面端“设置 -> 存储 -> 资料库模式”中点击断开/忘记旧连接，重新签发一次性 Token 配对即可更新信任指纹。

### 4. 服务端所有接口返回 `503` 且状态显示 `recoveryRequired`
- **原因**：服务端在升级进入 `installing`、`verifying` 或 `activating` 阶段后发生异常中断。为保护可能已迁移至新 Schema 的 `/data/library.db`，管理器锁定在维护态，拒绝自动降级回退。
- **解决方式**：参见 [服务端托管更新与维护恢复](/Javdex/server/managed-updates/#recoveryrequired-维护态人工恢复步骤)，核查容器日志与磁盘空间后，使用升级前备份还原或使用对应目标版本的 Docker 镜像完成恢复。

---

## 扫描与刮削问题

### 1. 为什么文件夹里的部分视频扫描后没有出现在媒体库？
- **排查清单**：
  1. **检查文件扩展名**：确认属于支持的 12 种视频格式（`.mp4`, `.mkv`, `.avi`, `.wmv`, `.mov`, `.flv`, `.webm`, `.ts`, `.m4v`, `.rmvb`, `.mpg`, `.mpeg`）或 `.strm` 文件（$\le 64\text{ KiB}$）。
  2. **检查时长过滤门槛**：默认跳过时长 `< 30 分钟` 的本地视频（记为 `short-video`）。若是短视频合集，可在该媒体库设置中调低“最小导入时长”。
  3. **检查目录名与文件名排除词**：位于 `sample`、`samples`、`trailers`、`extras`、`subtitles`、`extrafanart` 等目录，或文件名含 `trailer`、`sample`、`preview`、`宣传`、`预告` 的文件会被自动忽略。
  4. **查看“待办中心 (`/pending`)”与“未识别文件”**：若存在同番号多文件冲突或 NFO 番号不一致，文件会挂起在左侧“待办中心”；若文件名完全不含可识别的番号，可在媒体库扫描审计报告的 `unrecognized` 列表中查看并手动改名。

### 2. 插件刮削报错超时或被站点 Cloudflare 盾牌拦截
- **解决方式**：
  1. 前往 **“设置 -> 网络”**，配置可用的本地 HTTP/HTTPS 代理（如 `http://127.0.0.1:7890`）并点击“测试连接”。
  2. 若目标站点要求登录或触发了 Cloudflare 验证，在“设置 -> 刮削插件”中点击对应插件的预登录/辅助浏览器入口，在弹出的 Chromium 窗口中完成一次验证，会话会自动保存在本机 `Partitions/scraper/` 分区中复用。
  3. 批量刮削大量影片时，建议保持默认的 `3000ms ~ 5000ms` 随机延迟，或部署自建 `MetaTube` 服务端实现零延迟稳定刮削。
