# 服务端模式：当前状态与后续范围

核对日期：2026-09-19。代码基线：`76a871e`，已将 `origin/main` 的 `e3cec0d` 合入服务端分支；workspace 版本为 `0.7.1`。这是源码实现状态，不是服务端已发布声明。

**独立 Node 宿主、桌面远程模式及 C1–C7 功能已实现；S13 全面验收与 S14 发布准备仍未完成。** 继续工作从本页开始，无需重新执行历史 S00–S12 或已经完成的 T0–T7。

## 当前执行范围（2026-09-19 用户更新）

用户已明确启动原建议的 1–5：提交既有成果；补齐服务端 NFO 元数据导入并开放远程网页配对；完整远程 GUI 验收；现行协议的故障恢复验收；同提交安装部署验收。该决定覆盖本文原先的暂缓范围。第 6 项（版本发布、合并与发布操作）仍不执行。完成后按实际提交、平台和命令更新结果；无法执行的验收保留未完成状态。

- 已提交：文档整理 `99953b1`；NFO 版本修复 `c0d9655`。
- 已提交：服务端 NFO 完整导入与远程配对 `dd72ab3`。
- 按用户后续要求，容器验收使用本机 Colima / Docker（Linux arm64），不再限定 Cloud 会话。
- 已提交：远程媒体库版本映射和按挂载名称添加目录 `ebbae81`。
- 正在执行：完整 GUI 与同版本安装验收；现行 Linux 服务端、容器及迁库故障验收已通过，范围见下表。历史结果不代替本轮。

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

| 尚未闭合的事项 | 后续处理方式 |
|---|---|
| 服务端 NFO 资料导入与远程配对 | 代码已接线；真实 Node 直接/待确认导入及浏览配对测试通过，完整产品流验收继续推进 |
| 完整远程 GUI | 已通过单条采集、待确认应用、真实服务端文件改名、NFO 导入和配对；批量采集、取消与部分提交已通过；清单匹配仍待验证 |
| 变更后协议的故障与恢复验收 | 本轮 55 项 Linux 测试与 Docker 双宿主迁库故障验收通过；旧 waitingMaintenance、双端迁库许可的历史结果不作为现行协议证据 |
| 同源码版本的安装与发布 | 历史 0.7.0 Linux 结果不代表当前 0.7.1，也不代表 Windows/macOS；版本和发布目标需在启动发布工作时重新确定 |

此前暂缓、现已获准执行的范围（发布除外）：全面自动化与完整 GUI 验收、M/D 全矩阵关闭、跨平台安装部署、进程崩溃/磁盘/挂载/网络等故障注入、版本升级和发布。当前授权以本页顶部为准；版本升级和发布仍不执行。

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

远程清单匹配 GUI 及 Windows/macOS x64 安装仍未闭合。上述证据不代表 S13/S14 全矩阵完成；未改版本、发布、推送或合并 main。

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

Linux GUI 补充环境：使用 `dbus-run-session`、`XDG_CURRENT_DESKTOP=GNOME`、临时测试密钥环和 Xvfb。容器中的非 root Chromium 子进程需 root 所有且模式为 4755 的 `chrome-sandbox`；正式 deb 的安装脚本以 root 探测 user namespace，当前容器探测结果与非 root 运行条件不一致，因此在容器安装目录显式配置该权限。最终 `/opt/Javdex/javdex` 验收未传 `--no-sandbox`，也未绕过 writer 安全存储。该结果针对本机 Colima Linux arm64 测试环境，不推断所有 Linux 桌面发行版或其他架构通过。
