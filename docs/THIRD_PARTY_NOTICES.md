# 第三方说明

本文记录 Javdex 功能直接对接或随应用分发、且需要单独披露的第三方项目。各项目名称和商标归其权利人所有；列出项目不表示存在从属、合作或背书关系。

## 项目许可与历史声明

当前 Javdex 源码整体采用 GPL-3.0-or-later，完整许可见 [LICENSE](../LICENSE)，项目授权和无保证声明见 [NOTICE](../NOTICE)。此前按 MIT 发布的代码保留原版权及许可声明，原文见 [Javdex MIT 声明](../LICENSES/Javdex-MIT.txt)；既有版本的授权不追溯改写。

第三方代码、模型与图标仍按各自许可分发，不因 Javdex 采用 GPL 而改写其声明。官网图标声明保留在 `website/assets/LUCIDE-LICENSE.txt`、`website/assets/platforms/LICENSE.txt`，随桌面使用的模型声明保留在 `apps/desktop/src/renderer/public/models/LICENSE-APACHE-2.0.txt`。

内置播放开发分支使用 libmpv 和 FFmpeg。最终运行库的版本、构建选项、全部间接依赖及对应源码/构建资料仍须逐项审核；项目许可切换不是运行库合规或安装验收证明。上游规则见 [mpv Copyright](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright) 与 [FFmpeg 官方说明](https://ffmpeg.org/legal.html)，实际输入合同见 [开发指南](DEVELOPMENT.md#内置播放运行库开发分支)。

## node-gyp 延迟加载钩子

Windows 原生播放 addon 的开发构建复用已安装的 [node-gyp](https://github.com/nodejs/node-gyp) 中 `src/win_delay_load_hook.cc`，将 Electron 导出的 Node 符号解析到当前可执行文件；不复制修改上游源码。该钩子采用 MIT，原声明保留于 [node-gyp MIT 声明](../LICENSES/node-gyp-MIT.txt)，随项目许可材料打包。正式运行库仍须记录实际使用的 node-gyp 版本、钩子源码与构建资料。

## 本地 AI 运行库

- whisper.cpp b5130 与 llama.cpp b11435：MIT；固定下载地址、大小、SHA-256 见 [资产清单](../apps/desktop/src/main/player/aiSubtitles/runtimeManifest.ts)。各系统的资产独立，不能用 Windows ZIP 代替 POSIX 运行库。安装保留上游许可文件，模型许可与运行库许可分别记录。
- macOS 随应用分发固定源码构建的 whisper-cli、FFmpeg／ffprobe；来源与摘要见 [源码清单](../scripts/ai-runtime-sources.json)，构建步骤见 [构建器](../scripts/ai-runtime-build.mjs)。FFmpeg 8.1.3 为 LGPL-2.1-or-later 静态构建，不启用 GPL／nonfree／自动探测外部编解码依赖；bundle 内附 `COPYING.LGPLv2.1`、`SOURCE.txt` 和完整构建来源清单。
- Windows／Linux 的 FFmpeg 按需下载 BtbN 固定日期 LGPL shared 发布资产，保留包中的许可文件，不能把 macOS 自建工具的 LGPL 版本用于判断这些上游包的全部间接依赖许可。

分发 macOS 工具时应一并提供对应 Javdex 源码版本中的构建器、固定源码清单及可获得的完整对应源码，不以二进制哈希代替许可义务。源资料和构建来源不是正式分发验收证明；播放器 libmpv 的许可／来源闭包仍独立检查。

## MetaTube

连接与使用步骤见 [MetaTube 配置指南](METATUBE_SETUP.md)。

- 上游项目：[`metatube-community/metatube-sdk-go`](https://github.com/metatube-community/metatube-sdk-go)
- 许可：Apache License 2.0
- Javdex 集成：内置影片插件仅作为用户自建 `metatube-server` 的 REST 客户端。Javdex 不嵌入、下载、启动或分发 MetaTube Go 服务端、Provider 模块或数据库。
- 数据边界：用户配置服务端后，Javdex 才会向该地址发送影片番号并读取影片元数据。Token 保存在 Javdex 主进程的独立凭证文件中；MetaTube 原生 `/v1/images` 路由为公开路由，因此生成的封面和样张 URL 不携带 Token。
- 字段约定：MetaTube 的 `actors` 全部按女性演员导入；`label` 近似映射为 Javdex 的发行方。该语义差异同时在插件说明与设置界面披露。

Javdex 中的 MetaTube 适配代码为本项目实现；上述说明用于标明所对接 API、上游来源和许可边界。
