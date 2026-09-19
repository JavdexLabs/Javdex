# 服务端模式：当前状态与后续范围

核对日期：2026-09-19。代码基线：`76a871e`，已将 `origin/main` 的 `e3cec0d` 合入服务端分支；workspace 版本为 `0.7.1`。这是源码实现状态，不是服务端已发布声明。

**独立 Node 宿主、桌面远程模式及 C1–C7 功能已实现；S13 全面验收与 S14 发布准备仍未完成。** 继续工作从本页开始，无需重新执行历史 S00–S12 或已经完成的 T0–T7。

## 当前执行范围（2026-09-19 用户更新）

**本次原 1–5 已完成。** 用户最终确认第 5 项以 **macOS arm64 + Linux arm64** 收尾；Windows、macOS x64 及其他平台列为后续事项，不阻塞本次验收。第 6 项仍不执行，历史 S13/S14 全矩阵不因此宣告完成。最终产物与证据见本文末尾。

用户已明确启动原建议的 1–5：提交既有成果；补齐服务端 NFO 元数据导入并开放远程网页配对；完整远程 GUI 验收；现行协议的故障恢复验收；同提交安装部署验收。该决定覆盖本文原先的暂缓范围。第 6 项（版本发布、合并与发布操作）仍不执行。完成后按实际提交、平台和命令更新结果；无法执行的验收保留未完成状态。

- 已提交：文档整理 `99953b1`；NFO 版本修复 `c0d9655`。
- 已提交：服务端 NFO 完整导入与远程配对 `dd72ab3`。
- 按用户后续要求，容器验收使用本机 Colima / Docker（Linux arm64），不再限定 Cloud 会话。
- 已提交：远程媒体库版本映射和按挂载名称添加目录 `ebbae81`。
- 已验证原第 3 项的主要 GUI 流程与第 4 项定向恢复条件；macOS/Linux arm64 安装及保留数据替换已通过。最终 arm64 产物核对通过；用户已确认以这两个目标平台收尾，其他平台列为后续事项。历史结果不代替本轮。

## 文档入口与维护职责

| 需要了解什么 | 唯一维护入口 |
|---|---|
| 配置、构建启动、认主、迁库、更新 | [部署与操作](SERVER_MODE.md) |
| 宿主边界、代码入口、管理合同、已实现功能与限制 | [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md) |
| 当前进度、剩余问题、验证范围 | 本页 |
| 已接受的根身份、浏览授权和桌面隔离决策 | [ADR-0029](adr/0029-server-mode-extends-root-and-web-isolation.md) |
| 早期研究、阶段要求、旧测试结果与 C1–C7 实施过程 | [历史归档索引](archive/server-mode/README.md) |

字段、限额与能力以代码为准；功能变化更新实现与合同，操作变化更新部署说明，验证结果在本页注明提交与环境。历史记录不继续追加现行待办，也不以历史测试通过推断新代码通过。日常桌面操作和只读网页仍分别维护在 [使用指南](USER_GUIDE.md) 与 [LAN Web](LAN_WEB.md)。

## 当前进度

| 范围 | 代码现状 | 完成边界 |
|---|---|---|
| S00–S01 工作区与合同 | npm workspaces、共享 DTO/schema、IPC 去向已落地 | 合同持续随功能更新，不再称“不可扩展的冻结合同” |
| S02/S02D 共享业务与双后端 | LibraryHost、CatalogBackend、本地/远程适配、桌面工作存储已接线；影片写入、刮削与文件维护共用命令/编排 | 仍有宿主装配与单例入口；完整 D01–D07 架构验收未闭合 |
| S03–S06 服务基础 | 浏览/管理 HTTP 分离、Node 入口、Dockerfile、writer、版本与回执、图片上传应用已实现 | 构建通过不等于部署验收完成 |
| S07–S11 桌面远程功能 | 会话、管理、扫描/NFO、桌面采集、远程图片与授权播放已接线 | C1–C7 均已补齐，详见实现与合同；完整 GUI 流程未验收 |
| S12 迁库 | 双向离线包、空目标校验、图片解密/导入保护、人工启用和源恢复 | 已取消双端启用许可，不按旧协议继续实施 |
| S13 验收 | 存在定向与历史集成证据 | M01–M15 / D01–D07 未全闭合 |
| S14 发布 | 部署文档、构建脚本、历史 Linux 安装烟测已有 | 当前候选版安装、跨平台产物及发布流程未完成 |

2026-09-17 已完成的取舍继续有效：writer 忙时拒绝并重试；迁库使用离线包与人工切换；保留改名后重新识别；保留批量启动时冻结目标版本。模式切换仍须重启。背景见 [C1–C7 记录](archive/server-mode/C1_C7_IMPLEMENTATION_LOG.md) 与 [Issue #113](https://github.com/JavdexLabs/Javdex/issues/113)。

2026-09-19 合入 main 后，远程采集沿用桌面预登录会话，图片下载传递来源 referer；管理端 `videos.importResource` 接受仅资料导入、多资源及相关链接。对应入口见实现与合同，不再沿用 0.7.0 的分析基线。

## 剩余问题与下一步

当前没有尚未实施的 C1–C7 任务。后续功能工作先定位具体缺口，再更新合同、共享业务和宿主接线；不要把历史矩阵中的旧限制重新当成待开发功能。

| 当前事项 | 状态与后续处理 |
|---|---|
| 服务端 NFO 导入与远程配对 | 功能及真实 Node、GUI 验收通过，详见下方证据 |
| 原建议中的远程 GUI 主流程 | 编辑冲突、扫描/改名、单条/批量刮削、候选与图片交付、清单导入、播放、取消/重连均有实际证据；模型传输使用夹具，不评估外部模型质量 |
| 现行协议定向故障恢复 | 55 项 Linux 回归与 Docker 双宿主迁库故障验收通过；不声明历史 M/D 全矩阵关闭 |
| 安装及保留数据更新 | macOS/Linux arm64 安装与同版本候选替换已通过；最终 arm64 产物核对通过；Windows/macOS x64 按用户确认列为后续事项 |
| 发布、推送、合并 main、升级版本号 | 原第 6 项明确不执行 |

原 1–5 的实际范围以本页“范围复核”及用户原指令为准，不把历史全矩阵自动扩展为本次额外门槛。下方保留各轮证据及明确的未覆盖边界。

## 扫描/NFO 版本保护核对（2026-09-19，工作区改动）

已定位并修复桌面 `localNfoScanService` 的版本缺口：NFO 正式应用绕过 catalog 刮削命令，过去修改资料却不递增 V。现在在应用与扫描审计的同一事务内递增；审计回调失败一起回滚。仅生成待确认候选或跳过导入不递增 V。

定向核对区分三种行为：

- 桌面 NFO 实际应用标量或关联资料后，旧 V 经两宿主共用的 `catalogVideoCommands.edit` 提交得到 `VERSION_CONFLICT`；刷新后的编辑可成功，同号重试不重复写入。
- 服务端与桌面共用 NFO 导入，实现相同的 V 保护。真实 Node 扫描测试覆盖直接导入和多候选确认后的旧版本拒绝；XML 导出不改正式影片资料。
- 扫描新增/刷新的是媒体库资源；已有影片未改正式元数据时不强行递增 V。真实 STRM 目标刷新会改变文件维护 R 摘要，旧 R 被拒绝；未变化扫描保持版本，元数据编辑仍可继续。

回归入口：[NFO 事务与旧编辑保护](../apps/desktop/src/main/services/localNfoScanTransaction.test.ts)、[扫描版本边界](../packages/library/src/scan/scanCatalogVersions.test.ts)。服务端导入已经补齐；这些定向证据不单独关闭完整 M03 / S13 验收。

## 验证证据与适用范围

合并提交 `76a871e` 的本地 macOS 验证记录：

- `npm run typecheck` 与服务端 TypeScript 检查通过。
- `npm run pretest` 的边界、lint 和 UI 静态检查通过。
- 301 项定向 Electron 回归、17 项服务端/合同测试、8 项打包测试通过。
- 桌面/Web 构建、服务端打包及生产依赖闭包检查通过。

这些结果不包含完整 GUI、Docker 容器、平台安装或故障注入；也不是全量 Electron 测试结果。此前文档聚合仅做文档差异、链接及代码入口核对。

本次扫描/NFO 修复：5 个定向测试文件共 93 项通过、0 失败、0 跳过（NFO 事务、扫描器、扫描版本边界、影片命令及文件维护）；桌面/Web/服务端类型、改动文件 ESLint、library/desktop/metadata-source/server 边界检查通过。测试在 macOS Electron-as-Node 下执行，未运行完整 GUI、容器或故障注入验收。

历史 S13/S14 的 Docker、迁库、mpv、Linux 安装和故障测试保留在 [原执行记录](archive/server-mode/SERVER_MODE_EXECUTION_PLAN.md)，按其中的提交、日期和环境理解。

## 本轮新增验收证据（持续更新）

功能提交 `dd72ab3`，版本仍为 `0.7.1`：

| 验证 | 本轮结果与边界 |
|---|---|
| 静态与构建 | `typecheck`、服务端类型、`pretest`、桌面/Web 与 server build 通过 |
| NFO / 配对回归 | 29 项 Electron 定向测试通过；额外 107 项 NFO 来源、交割与资产回归通过 |
| 真实 Node 服务端 | 26 项宿主可执行 runtime 用例通过，包含 NFO 直接/待确认导入的标题、封面、样张、头像及旧 V 拒绝；此命令明确排除 Linux 挂载与 mpv 项 |
| 双宿主离线迁库 | `migrationHosts.e2e.test.ts` 5 项通过 |
| 双后端扫描与故障 | `dualBackendScan.e2e.test.ts` 5 项通过、2 项 Linux 专属故障跳过；修正审计过滤条件和失败后的连接清理 |
| 桌面进程隔离 | 6 项通过；macOS 用真实 `lsof`，Linux 用 `/proc`，避免在 macOS 上得到空结果而误判 |
| Node 生产安装 | `server:smoke:node` 通过；独立生产依赖、SQLite/WAL、HTTP/Range、会话、认主门槛、图片应用/重启、SIGTERM |
| 真实远程桌面 + 本地容器 | `server-remote-desktop-smoke.mjs` 通过：GUI 认主、按挂载名添加目录、启动扫描、查看 NFO 标题/简介/封面、真实文件改名后导入、桌面沙箱单条采集、多候选选择并应用、配对、重启保留、撤销；未创建本机权威 `library.db`。NFO 配置通过实际 IPC 设置，目录添加/扫描/配对通过界面操作 |
| macOS 安装 | 两架构 DMG 已构建；arm64 从 DMG 复制到隔离目录后，上述远程 GUI 流程通过。钥匙串授权由操作者在系统提示完成；x64 启动返回系统错误 -86（本机无 Rosetta），不计通过；含 `ebbae81` 的 arm64 最终安装副本已通过 NFO、真实文件重命名、认主、配对、重启和撤销 GUI 验收 |
| Linux 服务端完整测试 | 当前源码 `server:test` 共 55 项通过、0 失败、0 跳过（runtime 43、双宿主迁库 5、双后端扫描 7）；包含真实 mpv、bind mount/umount、SIGKILL、EIO、网络命名空间断网及窗口关闭 |
| Docker 生产与迁库故障 | `server:smoke`、`server:smoke:migration` 通过；双宿主离线包、启用/放弃竞争、正式图片与 EACCES/ENOSPC 回滚均真实执行。故障目录使用原生 Linux 存储和共享挂载传播；没有放宽 FUSE/SQLite 检查 |
| Linux 同版本安装 | 当前源码桌面/Web/server build 和 Electron 原生依赖构建通过；arm64 deb 打包与 `smoke:same-version-install` 通过（解包校验、Xvfb 存活检查与同版本 Docker 镜像，随后在同一隔离容器安装 gnome-keyring/DBus 并用 apt 正式安装 deb；`/opt/Javdex/javdex` 的 NFO、采集、待确认、终止、改名、配对与重启 GUI 均通过）。容器中的源码副本没有 Git 远端元数据，打包显式传入当前仓库主页；Electron 下载中断后使用已安装的相同 43.4.1 运行时；容器缺少 xz，deb 改用构建参数 `deb.compression=gz` |
| 远程目录修复回归 | 11 项 IPC/HTTP 合同测试、`typecheck`、`pretest` 通过；显式旧版本仍保留并交由服务端拒绝 |

Windows/macOS x64 安装仍未闭合；macOS/Linux arm64 保留数据更新已补齐，见末尾。上述证据不代表 S13/S14 全矩阵完成；未改版本、发布、推送或合并 main。

## 后续验证命令

从仓库根目录运行；按改动选检查，不要求每次全部执行。`npm ci` 后仅桌面测试/打包需要 `npm run setup:desktop`；服务端专用环境不要先切换原生模块到 Electron ABI。

| 命令 | 用途与环境要求 |
|---|---|
| `npm run typecheck` | 桌面主进程与 renderer/Web 类型 |
| `npx tsc --noEmit -p tsconfig.server.json --composite false` | Node 服务端类型 |
| `npm run pretest` | 工作区/架构边界及 lint |
| `npm run server:build` | Web + `out/server` + 生产依赖闭包 |
| `npm run server:test` | 服务端测试集；先查看脚本和用例依赖，不等同于普通静态检查 |
| `npm run server:smoke:node` | 宿主 Node 生产检查，不能替代容器验收 |
| `npm run server:smoke` | Docker 生产镜像检查，需先构建 `out/server` |
| `npm run server:smoke:migration` | Docker 多宿主迁库，含图片错误回滚故障场景 |
| `npm run smoke:same-version-install` | 同提交 Linux 桌面包与服务镜像；需 Docker、`out/server` 和 `dist/` Linux 产物 |

本轮依用户要求使用本地 Colima 的 Linux 容器验收，先确认 `docker version` / `docker info`。Cloud 会话仍按仓库 `.cursor` 配置启动。缺少环境或产物应失败，不替换成假通过；具体约束见根 [AGENTS.md](../AGENTS.md)。

### 本轮 GUI 复现入口

先构建桌面与服务端，并通过 `server:smoke` 生成 `javdex-server:smoke` 镜像。以下命令创建独立测试配置、资料库、媒体文件和确定性的测试插件，不读取用户资料库；结束后删除测试容器，截图保留在输出的临时 evidence 目录：

```sh
JAVDEX_REMOTE_SMOKE_NFO=1 JAVDEX_REMOTE_SMOKE_RENAME=1 JAVDEX_REMOTE_SMOKE_SCRAPE=1 JAVDEX_REMOTE_SMOKE_PENDING=1 node scripts/server-remote-desktop-smoke.mjs
```

`JAVDEX_DESKTOP_EXECUTABLE` 可指向实际安装的桌面程序，`JAVDEX_REMOTE_SMOKE_PORT` 可覆盖默认 18095，`JAVDEX_WEB_QA_OUTPUT` 可指定截图目录。Linux Xvfb 隔离容器可显式使用 `JAVDEX_REMOTE_SMOKE_NO_SANDBOX=1`；这仅是测试进程参数，不改变产品打包配置，也不会绕过安全凭据存储检查。

本轮故障测试适配已提交为 `d3c15b5`。

2026-09-19 后续实测补充：`JAVDEX_REMOTE_SMOKE_BATCH=1` 验证 GUI 选择两部影片并批量提交，两部服务端标题均更新；再加 `JAVDEX_REMOTE_SMOKE_CANCEL=1` 使用每项延迟 8 秒的确定性沙箱插件，在首项提交后通过设置页终止。任务进入 `cancelled` 后继续等待 9 秒，确认只有一部更新、另一部标题及影片集合保持原状。两种场景均通过，不能用批量成功代替中途终止证据。

Windows 无运行宿主，macOS x64 无 Rosetta，相关安装验收保持未完成。Linux 密钥环与沙箱运行条件已补齐，当前实测不再以缺少环境为阻塞。最终版本发布、推送和合并 main 仍不执行。

Linux GUI 补充环境：使用 `dbus-run-session`、`XDG_CURRENT_DESKTOP=GNOME`、临时测试密钥环和 Xvfb。容器中的非 root Chromium 子进程需 root 所有且模式为 4755 的 `chrome-sandbox`；正式 deb 的安装脚本以 root 探测 user namespace，当前容器探测结果与非 root 运行条件不一致，因此在容器安装目录显式配置该权限。最终 `/opt/Javdex/javdex` 验收未显式设置烟测脚本的 `JAVDEX_REMOTE_SMOKE_NO_SANDBOX`，未绕过 writer 安全存储；Playwright 仍可能附加自动化启动参数，该结果不用于证明 Chromium 的全部安全配置。该结果针对本机 Colima Linux arm64 测试环境，不推断所有 Linux 桌面发行版或其他架构通过。

## 交付范围复核（本轮进行中）

| 原执行项 | 当前证据 | 尚未闭合 |
|---|---|---|
| 1. 提交既有成果 | 文档整理 `99953b1`、NFO 版本修复 `c0d9655` 分开提交 | 无 |
| 2. 首版 NFO 与远程网页配对 | `dd72ab3`，真实 Node 元数据/图片/待确认回归和 macOS/Linux GUI | 无已知功能缺口 |
| 3. 真实远程 GUI 主流程 | NFO、单条/批量采集、待确认、文件改名、终止与部分提交、配对、清单唯一已有影片复用及结果页已通过 | 编辑冲突、点击播放及真实 mpv 解码、桌面采集封面和样图交割均已通过；仍不以夹具结果证明外部模型质量；模型传输是夹具，不作为真实模型质量证据 |
| 4. 现行协议恢复与故障 | 本轮真实测试覆盖忙时拒绝/重试、丢响应回执、迁库启用/放弃、图片 EACCES/ENOSPC 回滚、卸载后保留数据，55 项 Linux 回归与 Docker 迁库通过 | 原建议指定的重点已覆盖；历史全矩阵和整机断电不是该项定向验证的完成声明 |
| 5. 同版本安装部署 | `9c2942c` 之前的 macOS arm64 DMG 与 Linux arm64 deb 已验证 | 包含清单修复的 Linux deb 已安装并通过完整脚本；macOS 新 DMG 已通过 NFO、单条/批量刮削、候选确认、改名、认主、配对、重启和撤销复测；Windows 与 macOS x64 缺运行环境 |

清单列表修复 `b60ece1`：管理合同保留搜索/影片筛选/语言参数，远程界面禁用自动建片。15 项合同和界面结构回归、类型与 pretest 通过。随后真实流程又发现详情/元数据/影片分页漏接排序和资源筛选，修复 `56fb293` 已通过 HTTP 合同回归及桌面/Web/server 类型检查，修改文件 lint 通过。清单模型使用本地确定性 HTTP 夹具，浏览器提取和远程 catalog 匹配/写入均为真实链路；该验收不评估模型生成策略或外部站点变化。

### 清单 GUI 验收补充

`JAVDEX_REMOTE_SMOKE_PLAYLIST=1` 验证单页清单复用既有 `GUI-901`，同时检查服务端影片 ID 与清单成员一致、该番号仍只有一条影片，并从完成界面的“查看清单”打开真实结果页。连同 NFO、配对、重启、撤销整条脚本退出 0。服务端使用生产 Docker 镜像，桌面使用包含 `56fb293` 的 Linux arm64 打包目录。

`remote-playlist-fixture.mjs` 只固定模型 HTTP 响应（打开页面、读取快照、提交 selector 检查点）；不替换浏览器提取、影片匹配、管理 HTTP 或资料库写入。为保持产品对本机/内网来源的拒绝，夹具在隔离 Colima VM 的 loopback 上绑定文档测试地址 `198.51.100.2/32`，设置 `JAVDEX_PLAYLIST_FIXTURE_HOST=198.51.100.2`；这是测试网络布置，不是产品允许内网来源的变更。结束该组验证后移除测试地址。真实站点、模型推理质量和身份冲突人工选择不由这个单页用例证明。

### 最终候选复测（`56fb293` 功能代码，`26c2476` 验收脚本）

- Linux arm64 最终 deb 经 `dpkg -i` 安装到 `/opt/Javdex` 后，以真实 Docker 服务运行完整 GUI 脚本：NFO、单条采集、多候选、批量中途终止/保留部分结果、实际文件改名、清单复用及结果页、网页配对、重启和撤销均退出 0。密钥环、沙箱和固定模型传输边界同上。
- 最终源码 `server:test` 再次通过 43 + 5 + 7 = 55 项，0 失败、0 跳过。桌面/Web/server 类型、pretest、定向合同检查通过。
- 产物版本仍为 `0.7.1`。最终 deb SHA-256：`0d3cd7b9997517e8e3e15b30580da4d9d187e4bae1fba849b88843ab0a7ac87e`。新 arm64 DMG SHA-256：`bebcc1e846d93946f87a8a23b55fb3b8fa4da39d2270cc59ed089aaa9729e03b`，已从 DMG 复制至隔离安装目录；操作者完成系统钥匙串授权后，使用同一安装二进制重新运行，NFO、单条/批量刮削、多候选确认、实际文件改名、认主、配对、重启及撤销全部通过（退出 0）。日志 `/tmp/javdex-final-mac-all-gui.log`，截图目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-remote-desktop-CeduDc/evidence`。这次未运行 macOS 清单导入及取消分支；对应证据来自上面的 Linux 最终安装测试。
- 已移除本轮 Linux 夹具测试地址。没有发布、推送、升级版本或合并 main。

范围校准：以上 1–5 依据本任务中“后续事项及建议顺序”的原始列表，不把历史 S13 M/D 全部扩展场景额外改成这次定向可靠性验证的门槛，也不以本次通过宣称全部 S13/S14 已完成。原第 5 项还要求目标平台升级检查，不能仅凭首次安装计为完成。

### 最终 macOS 安装副本：编辑冲突恢复

同一最终 DMG 安装二进制运行 `JAVDEX_REMOTE_SMOKE_NFO=1 JAVDEX_REMOTE_SMOKE_EDIT_CONFLICT=1`，脚本退出 0。GUI 打开编辑表单后，通过真实桌面管理 API 提交一次竞争修改，再点击旧表单的保存：界面显示版本冲突，旧草稿保留，服务端仍是竞争修改结果。取消并刷新后重新编辑、保存成功。未模拟版本验证或 catalog 写入。

证据日志 `/tmp/javdex-final-edit-conflict-gui.log`，冲突截图目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-remote-desktop-O0zA5S/evidence`。测试脚本同时再次通过认主、配对、重启与撤销；新增脚本语法检查和 `git diff --check` 通过。

### GUI 播放与刮削图片交付

真实 MP4 用例暴露服务端 `videos.get` 未投影资源展示字段，远程详情页在 `display_locator.trim()` 崩溃。HTTP 回归先失败（期望文件名，实际 undefined），修复后通过：统一详情展示字段、相对路径及解析时长，移除原始定位/身份字段；无归属影片走文件名回退。既有 STRM 用例无法覆盖这一分支。

Linux 最终已安装桌面 `/opt/Javdex/javdex` 配合更新后的生产 Docker 服务，在 `NFO=1 PLAY=1 EDIT_CONFLICT=1 SCRAPE=1 IMAGES=1` 下通过：GUI 点击播放启动真实 mpv，读取服务端 grant 并解码 160×90 视频；GUI 沙箱插件采集新的 32×24 封面和样图，上传正式资源并在详情页显示；服务端/桌面重启后资源记录保留，浏览端实际读取的新封面尺寸正确。mpv 包装脚本仅固定无窗口输出、帧数和日志，不替代解码器或服务端网络请求。

日志 `/tmp/javdex-linux-play-images-final.log`；证据位于 Linux 容器 `/var/tmp/javdex-acceptance/javdex-remote-desktop-tj9liP/evidence`。服务端回归 43 + 5 项通过，另在 Xvfb 下完整补跑双后端 7 项，均 0 失败、0 跳过；日志 `/tmp/javdex-resource-server-test.log`、`/tmp/javdex-resource-dual-backend.log`（前一日志包含首次无 DISPLAY 导致的两项跳过，以后一日志补齐）。类型检查、修改文件 lint 和脚本语法检查通过。

### 服务端保留数据升级

使用真实旧镜像 `02856b068cad`（清单修复后候选）创建资料、刮削图片和网页配对，正常 `docker stop` 后移除旧容器；新镜像 `3f5e95646f23`（资源详情投影修复）接管相同的命名 `/data` 与 `/media` 卷。已安装桌面保留原 userData，能够继续使用写入凭据；浏览会话仍可用；影片、封面、样图记录及实际封面文件保持，最后通过 GUI 撤销配对。版本号均为 `0.7.1`，这是本次候选之间的同版本更新验收，不是跨发布版本数据库迁移声明。

脚本 `JAVDEX_REMOTE_SMOKE_BASE_IMAGE=02856b068cad JAVDEX_REMOTE_SMOKE_UPGRADE_IMAGE=javdex-server:smoke`，配合 `NFO=1 SCRAPE=1 IMAGES=1` 退出 0。日志 `/tmp/javdex-server-upgrade-gui.log`，证据 `/var/tmp/javdex-acceptance/javdex-remote-desktop-m703dm/evidence`。首次强制删除旧容器的探查未在等待期内就绪，不计通过；上述通过仅证明正常停机升级。桌面安装包保留 userData 的替换检查随后已补齐（见下节），Windows/macOS x64 环境仍缺。

### 桌面保留数据替换验收

两平台均在旧应用中创建远程连接、NFO 影片、刮削封面/样图和浏览配对，退出应用后替换程序，保持同一隔离 userData 与钥匙串，再重新启动。检查 `this-computer.json` 原样保留、影片列表内容及 ID 不变、写入凭据无需重新认主、图片仍可读取、原浏览会话有效并可在 GUI 撤销。列表 `readRevision` 含进程身份，重启会变化，故比较持久内容而非该临时标记。

- Linux arm64：用此前保存的已解包安装副本重新封装旧 deb（应用内容不改），先 `dpkg -i` 安装，再在测试中用当前最终 deb 替换。旧 ASAR SHA-256 `2af1252b70f7c7749a5a9787a2de6c524275aabd4b3a611f12541142c6ac2e39`，新 ASAR `c41716752d501c54bef70817c2ed3a30d688d504e221d3037ab1cd05499fb704`；新 deb 仍为 `0d3cd7b9997517e8e3e15b30580da4d9d187e4bae1fba849b88843ab0a7ac87e`。日志 `/tmp/javdex-desktop-upgrade-gui.log`，证据 `/var/tmp/javdex-acceptance/javdex-remote-desktop-SOTw98/evidence`，含 dpkg 安装日志。
- macOS arm64：将先前 DMG 安装副本复制到隔离程序目录，测试中替换为最终 DMG 的应用副本（两者均已完成安装验证）。旧 ASAR SHA-256 `b84405ba89ee60e31f3e4358bc2afebf6508b5372ced9ab381e28caf6decf298`，新 ASAR `8800387a48a2d9090f169c95eece6a2ab744abd1336bbe74a53cc0af8faaacfa`。日志 `/tmp/javdex-mac-upgrade-gui.log`，证据 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-remote-desktop-NMrwJm/evidence`。

两条脚本均退出 0。可通过 `JAVDEX_REMOTE_SMOKE_DESKTOP_UPGRADE_DEB`（仅隔离 Linux 容器）或 `JAVDEX_REMOTE_SMOKE_DESKTOP_UPGRADE_APP`（macOS 隔离副本）复跑。两端版本号仍为 0.7.1；这证明本次候选间替换保留数据，不代表跨发布版本迁移或自动更新器验收。

### 当前最终产物（覆盖前文候选哈希）

功能代码包含 `40860d0`，桌面/Web 与 Node 宿主重新构建，版本仍为 `0.7.1`。前文旧哈希保留为历史验收证据，交付应使用此处最终文件：

| 产物 | SHA-256 / 镜像 ID | 当前证据 |
|---|---|---|
| `dist/Javdex-0.7.1-arm64.dmg` | `1d97b3ee3f67373ad90f51d2568c857ae5bd78bfb197119b934e44c8d2bfef56` | DMG 挂载后复制安装；从上一候选替换升级，设置/凭据/资料/图片保留，配对撤销成功 |
| `dist/Javdex-0.7.1-arm64.deb` | `859dd8528db83ad6dff329f6701c1af19fac0c2554efc3c10c249ef436baec2a` | dpkg 替换安装成功，保留同一 userData；完整远程 GUI 流程及图片重启验证通过 |
| `javdex-server:smoke` | `3f5e95646f23` | 生产 Docker 构建；保留数据镜像替换及最新同版本安装烟测通过 |

Linux 完整脚本包括 NFO、播放/真实 mpv 解码、编辑冲突、单条图片采集、候选确认、批量部分提交后取消、实际改名、清单匹配/结果页、桌面替换升级、配对/重启/撤销。macOS 本次脚本包括 NFO、编辑冲突、单条图片采集、桌面替换升级、配对/重启/撤销。原 macOS 30 秒首次窗口等待曾超时；延长测试等待到 180 秒后同一产物通过，不将前次超时记为通过或据此声称产品修复。

最终日志：`/tmp/javdex-final-candidate-linux-upgrade.log`、`/tmp/javdex-final-candidate-mac-upgrade.log`、`/tmp/javdex-final-candidate-install-smoke.log`；三项均退出 0。Linux 截图/播放器日志：`/var/tmp/javdex-acceptance/javdex-remote-desktop-yNJqwk/evidence`；macOS：`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-remote-desktop-RMXIkU/evidence`。Linux 测试地址已移除。

当前完成边界：原 1–5 在用户确认的范围内全部完成。第 5 项目标平台为 macOS arm64 与 Linux arm64，已完成构建、安装及同版本候选替换保留数据检查。Windows/macOS x64 尚无运行验收证据，按用户决定列为后续事项。没有修改版本号、发布、推送或合并 main。
