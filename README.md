<p align="center">
  <a href="https://javdexlabs.github.io/Javdex/">
    <img src="resources/icon.png" width="112" height="112" alt="Javdex">
  </a>
</p>

<h1 align="center">Javdex</h1>

<p align="center">
  <strong>把散落各处的影片文件，整理成有封面、有资料、能直接播放的私人影片库。</strong>
</p>

<p align="center">
  以番号为核心 · 本地优先 · Windows / macOS / Linux · 可选 NAS 部署
</p>

<p align="center">
  <a href="https://github.com/JavdexLabs/Javdex/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/JavdexLabs/Javdex?display_name=tag&sort=semver&label=release&color=367766"></a>
  <a href="https://github.com/JavdexLabs/Javdex/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/JavdexLabs/Javdex/total?color=367766"></a>
  <a href="LICENSE"><img alt="GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-2f3432"></a>
</p>

<p align="center">
  <a href="https://javdexlabs.github.io/Javdex/download/"><strong>下载</strong></a>
  &nbsp;·&nbsp;
  <a href="https://javdexlabs.github.io/Javdex/getting-started/quickstart/">5 分钟上手</a>
  &nbsp;·&nbsp;
  <a href="https://javdexlabs.github.io/Javdex/">使用文档</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <img src="docs/images/library.webp" alt="媒体库：竖版封面浏览、搜索、筛选与排序" width="1200">
</p>

<p align="center"><sub>截图来自当前版本，影片、人物与图片均为虚构演示资料。</sub></p>

## 为什么选择 Javdex

- **扫描即建库**：选好目录，自动识别文件名中的番号，跳过样片和预告；本地视频、STRM、直链、网页、Magnet、ED2K 都能挂到同一部影片下。
- **一键补齐资料**：通过刮削插件获取标题、封面、样张、演员与标签，支持批量处理和按字段选择来源；不确定的结果进入“待确认”，不会静默覆盖。
- **内置原生播放**：基于 libmpv，支持音轨、字幕、倍速、续播和底部迷你播放器；也可随时改用外部播放器。
- **本地 AI 日中字幕**：边看边为日语对白生成中文字幕，模型在本机推理，不上传音频。
- **沿着演员和系列探索**：演员、厂商、导演、系列各有资料页；本地人脸检测自动裁切头像。
- **已有资料直接复用**：导入 MDC、MDCx、Javinizer、JavSP 生成的 NFO；也可导出给 Kodi、Jellyfin、Emby、Plex、Infuse。
- **放到 NAS 常驻运行**：单个 Docker 容器持续扫描，多台电脑授权连接，手机、平板和电视用浏览器即可浏览播放。

<p align="center">
  <img src="docs/images/video-detail.webp" alt="影片详情：封面、主题背景、评分、演员、简介和关联资源" width="1000" loading="lazy">
</p>

## 下载

从 [下载中心](https://javdexlabs.github.io/Javdex/download/) 或 [GitHub Releases](https://github.com/JavdexLabs/Javdex/releases/latest) 获取安装包：

| 平台 | 安装包 |
|---|---|
| Windows（x64） | EXE 安装版 · ZIP 免安装版 |
| macOS | Apple Silicon DMG · Intel DMG |
| Linux（x86_64） | AppImage · DEB |
| 服务端（x86_64 / ARM64） | Docker 镜像 `ghcr.io/javdexlabs/javdex-server` |

> [!NOTE]
> 安装包尚未进行商业代码签名，首次运行时系统可能显示安全提示，处理方式见 [安装与系统配置](https://javdexlabs.github.io/Javdex/getting-started/installation/)。请只从官网或 GitHub Releases 下载。

## 快速开始

1. **创建媒体库**：打开“设置 → 媒体库”，新建媒体库并选择影片所在目录。
2. **扫描影片**：创建时勾选立即扫描，或稍后在媒体库设置中手动扫描。
3. **补齐资料**：在“设置 → 刮削来源”选择来源，对影片执行单部或批量刮削。
4. **开始观看**：浏览影片与演员，加入收藏或稍后观看，点开即用内置播放器播放。

详细步骤见 [5 分钟首次建库指南](https://javdexlabs.github.io/Javdex/getting-started/quickstart/)。

## 选择使用方式

| 方式 | 适合 | 起步 |
|---|---|---|
| **桌面本地** | 一台电脑上扫描、整理和播放，无需部署任何服务 | 安装后直接使用 |
| **服务端 + 桌面** | NAS 或常开电脑持续扫描，多台电脑连接同一资料库 | [部署服务端](https://javdexlabs.github.io/Javdex/server/deploy/) |
| **浏览器访问** | 手机、平板、电视只读浏览与播放，免装客户端 | [局域网访问](https://javdexlabs.github.io/Javdex/guides/lan-web-access/) |

两种资料库可通过“备份与恢复”互相导入。各模式的能力边界见 [选择运行模式](https://javdexlabs.github.io/Javdex/getting-started/choose-mode/)。

> [!IMPORTANT]
> 从 0.8.0 升级前请完整备份数据与图片目录。新版首次启动会升级数据库，升级后的数据不能再交给旧版打开；服务端还需增加 `/program` 程序卷。请按 [升级与兼容性](https://javdexlabs.github.io/Javdex/operations/upgrade-and-compatibility/) 操作。

## 文档

| 我想…… | 查看 |
|---|---|
| 了解产品与核心概念 | [产品定位与架构总览](https://javdexlabs.github.io/Javdex/getting-started/overview/) |
| 管理媒体库、处理待确认 | [媒体库与扫描](https://javdexlabs.github.io/Javdex/guides/library-and-scanning/) · [待确认与整理](https://javdexlabs.github.io/Javdex/guides/pending-and-curation/) |
| 配置刮削来源、连接 MetaTube | [元数据刮削](https://javdexlabs.github.io/Javdex/guides/metadata-scraping/) |
| 播放影片、生成 AI 字幕 | [内置播放器](https://javdexlabs.github.io/Javdex/guides/playback/) · [AI 字幕与本地模型](https://javdexlabs.github.io/Javdex/guides/ai-subtitles-and-models/) |
| 导入或导出 NFO | [NFO 迁移与导出](https://javdexlabs.github.io/Javdex/guides/nfo-migration-and-export/) |
| 部署、连接和更新服务端 | [部署](https://javdexlabs.github.io/Javdex/server/deploy/) · [远程连接](https://javdexlabs.github.io/Javdex/server/remote-connection/) · [托管更新](https://javdexlabs.github.io/Javdex/server/managed-updates/) |
| 备份、迁移或排查问题 | [备份与迁移](https://javdexlabs.github.io/Javdex/operations/backup-and-migration/) · [常见问题排查](https://javdexlabs.github.io/Javdex/operations/troubleshooting/) |
| 开发插件或参与贡献 | [插件与开发助手](https://javdexlabs.github.io/Javdex/plugins/overview-and-agent/) · [开发指南](docs/DEVELOPMENT.md) |

## 反馈与参与

- 遇到问题或有功能建议：[提交 Issue](https://github.com/JavdexLabs/Javdex/issues/new)
- 已有计划与讨论：[Issues](https://github.com/JavdexLabs/Javdex/issues)
- 从源码运行与打包：[开发指南](docs/DEVELOPMENT.md)

## 声明

Javdex 只管理你已有的影片文件、手动添加的资源链接与影片资料，不提供、托管或分发任何媒体内容。使用第三方资料来源时，请遵守所在地法律法规及目标网站条款。

本地优先指资料保存在你自己的设备上。联网刮削会访问对应来源；通过 API 执行的 AI 功能会把任务所需内容发送给你配置的模型服务；本地字幕、本地翻译与人脸检测不上传内容。

## License

Javdex 源码按 [GPL-3.0-or-later](LICENSE) 发布，项目声明见 [NOTICE](NOTICE)。此前按 MIT 发布的版本保留原授权，见 [历史 MIT 声明](LICENSES/Javdex-MIT.txt)。第三方代码、模型与图标遵循各自许可，见 [第三方说明](docs/THIRD_PARTY_NOTICES.md)。

Copyright (c) 2026 Javdex
