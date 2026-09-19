# 服务端模式：当前状态与后续范围

核对日期：2026-09-19。代码基线：`76a871e`，已将 `origin/main` 的 `e3cec0d` 合入服务端分支；workspace 版本为 `0.7.1`。这是源码实现状态，不是服务端已发布声明。

**独立 Node 宿主、桌面远程模式及 C1–C7 功能已实现；S13 全面验收与 S14 发布准备仍未完成。** 继续工作从本页开始，无需重新执行历史 S00–S12 或已经完成的 T0–T7。

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
| 服务端 NFO 资料导入 | 当前仅做 NFO 身份检查，不应用 sidecar 标题、演员或图片；如需完整导入，应另行定义功能范围，不能把桌面导入能力当作服务端已支持 |
| 完整远程 GUI：单条/批量采集、待确认、清单匹配、真实挂载重命名、取消与部分提交 | 已有接线及定向测试，仍缺完整产品流验收 |
| 变更后协议的故障与恢复验收 | 旧 waitingMaintenance、双端迁库许可的历史结果不能覆盖现行“忙时拒绝 / 人工切换”协议 |
| 同源码版本的安装与发布 | 历史 0.7.0 Linux 结果不代表当前 0.7.1，也不代表 Windows/macOS；版本和发布目标需在启动发布工作时重新确定 |

已确认暂缓的范围：全面自动化与完整 GUI 验收、M/D 全矩阵关闭、跨平台安装部署、进程崩溃/磁盘/挂载/网络等故障注入、版本升级和发布。上述事项保留为后续缺口，不自动转成本阶段执行任务；暂缓不表示通过。

## 扫描/NFO 版本保护核对（2026-09-19，工作区改动）

已定位并修复桌面 `localNfoScanService` 的版本缺口：NFO 正式应用绕过 catalog 刮削命令，过去修改资料却不递增 V。现在在应用与扫描审计的同一事务内递增；审计回调失败一起回滚。仅生成待确认候选或跳过导入不递增 V。

定向核对区分三种行为：

- 桌面 NFO 实际应用标量或关联资料后，旧 V 经两宿主共用的 `catalogVideoCommands.edit` 提交得到 `VERSION_CONFLICT`；刷新后的编辑可成功，同号重试不重复写入。
- 服务端 `libraryLocalNfoScanService` 仅检查身份、不应用 sidecar 元数据；NFO XML 导出也不改正式影片资料。历史 M03 的导出后 V 不变不是资料导入覆盖的证明，也不是漏增版本。
- 扫描新增/刷新的是媒体库资源；已有影片未改正式元数据时不强行递增 V。真实 STRM 目标刷新会改变文件维护 R 摘要，旧 R 被拒绝；未变化扫描保持版本，元数据编辑仍可继续。

回归入口：[NFO 事务与旧编辑保护](../apps/desktop/src/main/services/localNfoScanTransaction.test.ts)、[扫描版本边界](../packages/library/src/scan/scanCatalogVersions.test.ts)。本次不新增服务端 NFO 元数据导入，也不据此关闭完整 M03 / S13 验收。

## 验证证据与适用范围

合并提交 `76a871e` 的本地 macOS 验证记录：

- `npm run typecheck` 与服务端 TypeScript 检查通过。
- `npm run pretest` 的边界、lint 和 UI 静态检查通过。
- 301 项定向 Electron 回归、17 项服务端/合同测试、8 项打包测试通过。
- 桌面/Web 构建、服务端打包及生产依赖闭包检查通过。

这些结果不包含完整 GUI、Docker 容器、平台安装或故障注入；也不是全量 Electron 测试结果。此前文档聚合仅做文档差异、链接及代码入口核对。

本次扫描/NFO 修复：5 个定向测试文件共 93 项通过、0 失败、0 跳过（NFO 事务、扫描器、扫描版本边界、影片命令及文件维护）；桌面/Web/服务端类型、改动文件 ESLint、library/desktop/metadata-source/server 边界检查通过。测试在 macOS Electron-as-Node 下执行，未运行完整 GUI、容器或故障注入验收。

历史 S13/S14 的 Docker、迁库、mpv、Linux 安装和故障测试保留在 [原执行记录](archive/server-mode/SERVER_MODE_EXECUTION_PLAN.md)，按其中的提交、日期和环境理解。

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
| `npm run server:smoke:migration` | Docker 多宿主迁库，含图片错误回滚故障场景；属暂缓验收范围 |
| `npm run smoke:same-version-install` | 同提交 Linux 桌面包与服务镜像；需 Docker、`out/server` 和 `dist/` Linux 产物 |

容器 smoke 只在按仓库 `.cursor` 配置启动、Docker daemon 就绪的 Cloud 环境执行，先确认 `docker version` / `docker info`。缺少环境或产物应失败，不替换成假通过；具体约束见根 [AGENTS.md](../AGENTS.md)。
