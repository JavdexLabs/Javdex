# 主流软件 Intel Mac 支持调查（2026-10-24）

## 范围与结论

调查问题：主流软件是否仍维护面向 Intel／x86_64 Mac 的版本，以及这对 Javdex 停止支持的决策有什么意义。

核查日期：2026-10-24。依据为厂商当前安装说明、系统要求、发布目录及官方公告；这是公开支持政策调查，没有逐个下载安装或 Intel 真机测试。样本按浏览器、办公、开发、创作、媒体与本地 AI 选取，不是市场份额统计，也不能推出 Javdex 用户架构占比。

结论：Intel Mac 尚未被主流桌面软件普遍放弃。浏览器、办公、开发工具和媒体播放器中仍有大量持续支持；部分图形与 AI 软件已经退出，或明确划定退出版本。应区分「当前支持」「旧分支维护」「后续版本已宣布退出」和「程序支持但特定加速不可用」。

## 逐项证据

| 软件 | Intel Mac 状态 | 一手证据与边界 |
| --- | --- | --- |
| Google Chrome | 仍支持 | [官方 Mac 部署说明](https://support.google.com/chrome/a/answer/9020580?hl=en)推荐 x86 与 ARM 的 Universal PKG；[系统要求](https://support.google.com/chrome/a/answer/7100626?hl=en)为 macOS 13+。这是架构与系统要求的组合证据，不能把旧 macOS 停更等同停止 Intel。 |
| Firefox | 仍支持，一级平台 | [Mozilla 支持平台文档](https://firefox-source-docs.mozilla.org/build/buildsystem/supported-configurations.html)明确 macOS 10.15+ 的 x86-64 与 AArch64 都属于 Tier-1，接受持续集成与回归检查。 |
| Microsoft 365／Office | 仍支持 | [微软原生支持说明](https://support.microsoft.com/en-us/office/lifecycle/microsoft-365-office-2021-and-office-2019-support-for-apple-silicon)明确安装及更新包包含 Intel 与 Apple Silicon 的 Universal binary；[系统要求](https://support.microsoft.com/en-us/office/system-requirements/system-requirements-for-microsoft-365-for-business-education-and-government-use)仍列 Intel，支持窗口按最近三个 macOS 大版本滚动，并非所有旧 Intel 机型都能继续更新。 |
| Visual Studio Code | 仍支持 | [2026-10-21 安装文档](https://code.visualstudio.com/docs/setup/mac)明确支持 Intel 与 Apple Silicon，提供 Universal、Intel、Apple Silicon 构建；[下载页](https://code.visualstudio.com/download)要求 macOS 12+。不与已退役的 Visual Studio for Mac 混淆。 |
| JetBrains IntelliJ IDEA | 仍支持 | [2026.2 安装说明](https://www.jetbrains.com/help/idea/installation-guide.html)列 x86_64／arm64、macOS 15／26，并明确 Intel 与 Apple Silicon 独立磁盘映像。以 IDEA 为样本，不将结论无条件扩展至 JetBrains 全部新产品。 |
| Docker Desktop | 仍支持 | [官方安装页](https://docs.docker.com/desktop/setup/install/mac-install/)仍提供 Mac with Intel chip 的当前下载入口与独立要求；macOS 支持窗口为当前及前两个大版本。提供 Intel 应用不意味着 Apple Silicon 专有虚拟化功能完全对等。 |
| Adobe Photoshop | 27.x 仍支持 | [系统要求](https://helpx.adobe.com/photoshop/desktop/get-started/technical-requirements-installation/adobe-photoshop-on-desktop-technical-requirements.html)的 27.x 及后续版本栏明确多核 Intel 或 Apple Silicon；列 macOS 14／15／26，Intel 有 AVX2 等硬件限制，推荐 Apple Silicon。 |
| Adobe Premiere | 26.x 支持；27.0 起停止，已公告 | [26.0–26.5 系统要求](https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/adobe-premiere-pro-technical-requirements.html)仍列第八代以上 Intel、AVX2、macOS 14+；[2026-07-27 官方社区公告](https://community.adobe.com/announcements-504/important-notice-end-of-support-for-intel-based-macs-in-upcoming-v27-releases-1634129?lang=fr)明确 Premiere、After Effects、Media Encoder、Audition 从 27.0 起要求 M1+，26.x 可继续安装并按标准周期获得安全更新。本调查不单凭该公告判定 27.0 是否已经正式发布。 |
| Blender | 最新主线已停止；旧 LTS 仍维护 | [当前系统要求](https://www.blender.org/download/requirements/)明确 5.0+ 仅 Apple Silicon，4.5 LTS 为最后 Intel 版；[官方退出公告](https://devtalk.blender.org/t/deprecation-and-removal-of-macos-intel-builds-in-blender-5-0/38835)说明 4.5 LTS 维护至 2027，退出原因包括图形驱动问题及维护成本。自行编译新版本不等于官方支持。 |
| VLC | 当前发布仍提供 Intel | [官方最新 macOS 发布目录](https://download.videolan.org/vlc/last/macosx/)的 3.0.24（2026-09-21）包含 intel64、arm64 与 universal 安装包。证明当前发行仍有 Intel 产物，不承诺所有老系统／显卡上的全部功能。 |
| IINA | 仍支持 | [官方网站](https://iina.io/)当前 1.5.0 明确常规要求 macOS 12，而 Intel 为 macOS 11。作为 Mac 原生播放器，比单纯本地 AI 产品更接近 Javdex 的媒体使用场景。 |
| OBS Studio | 当前发布仍提供 Intel | [官方下载页](https://obsproject.com/download)当前 32.2.2 同时提供 Intel／x86_64 与 Apple Silicon／arm64，要求 macOS 13+。不代表所有编码器和设备支持完全一致。 |
| Ollama | 支持 Intel，但仅 CPU | [官方 macOS 文档](https://docs.ollama.com/macos)要求 macOS 14+，Apple M 系列支持 CPU／GPU，x86 为 CPU only。说明可以将应用支持与本地 AI 加速能力分别管理。 |
| LM Studio | 不支持 Intel | [官方系统要求](https://lmstudio.ai/docs/app/system-requirements)要求 Apple Silicon、macOS 14+，明确当前不支持 Intel Mac。这是当前不支持的证据，不据此推断从哪个历史版本开始停止。 |

### 未作确定分类的条目

- Microsoft Edge：[官方系统政策](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems)说明 151+ 要求 macOS 13+；本次抓取的下载页没有给出足够明确的当前 Intel 架构内容，未仅凭最低 macOS 版本将其计入「已验证仍支持」。
- DaVinci Resolve、Steam：本次没有完成当前版本与架构的双重核对，不填入推测状态。

### Adobe 文档冲突

[2026-09-29 通用兼容性页](https://helpx.adobe.com/download-install/apps/system-requirements/apps-compatibility-mac-apple-silicon.html)仍声称会继续支持 Intel 且无停止计划，但 Premiere 等四款的专门 27.0 公告已给出明确退出规则。本调查采用产品、版本更具体的公告；不能将通用页解读成所有 Adobe 应用都永不退出，也不能把 Premiere 的计划扩展到 Photoshop。

## 对 Javdex 的决策意义

1. **不能以「主流软件都不支持了」作为立即退出的事实依据。** 当前样本中仍有多类持续维护的产品，尤其 IINA、VLC、OBS 与媒体应用直接相关。
2. **可以以实际维护成本决定退出。** Blender 的官方理由是驱动问题与维护代价，说明项目可以根据自身能力划定支持边界，不必等所有大厂退出。
3. **本地 AI 能力与整个桌面版支持适合分开决策。** Ollama 的 Intel CPU-only 策略是现成例子。Javdex 的模型运行库缺少某项 GPU 后端，并不能单独证明媒体管理与播放也必须停止支持。
4. **先确认自己的证据。** 评估 Intel 下载需求／用户反馈、真机验证能力、原生依赖与打包成本、架构专属问题；没有这些数据，无法量化退出会影响多少 Javdex 用户。本调查未审计 Javdex 当前完整依赖链。
5. **如果决定退出，应明确版本和旧版政策。** 公告最后支持版本、旧版本是否继续修复、安全维护期限与下载位置，并检查自动更新不会把 ARM 安装包推给 Intel 用户。「旧版仍能下载」不等于「仍维护」。

补充：[Electron 当前平台说明](https://github.com/electron/electron/blob/main/README.md)仍列 macOS Ventura+ 的 64-bit Intel 与 Apple Silicon 二进制。因此尚无证据表明 Electron 基础框架现在已经强迫 Javdex 停止 Intel；这也不替代 Javdex 自身固定版本、原生模块和安装包的兼容性验收。

本记录仅调研公开政策，未修改 Javdex 的平台支持范围、下载页面、打包设置或自动更新逻辑。
