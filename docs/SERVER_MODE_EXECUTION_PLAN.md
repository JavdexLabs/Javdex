# 服务端模式执行与 Agent 交接计划

> 状态：S00 结构准备已实施；S01 合同已冻结（见 [合同清点](SERVER_MODE_CONTRACT_INVENTORY.md)）。桌面架构重构及服务端产品功能待实施。用户本轮要求将桌面架构并入计划，本轮仅更新文档。此文件是本次用户要求的本地执行交接材料，不替代 GitHub Issues 中的正式 PRD/任务记录，也不代表已发布工单。
>
> 起点：远程分支 `origin/codex/server-mode-feasibility` 中包含本文件及 S00 结构调整的交接提交。原研究代码基线为 `cac9f6982eaef6afc34f86f9a51486f8ff10dd2b`，不能从该旧基线直接开工。接手先 fetch 并核对交接提交，再从该提交建立实施分支；具体提交哈希随交接提示提供。

## 给接手 Agent 的执行指令

执行本文件 S01–S14（包括新增必需阶段 S02D），先核对 S00 的现状与验证记录。用户已确定产品边界并准备交由其他 Agent 实施；不要把之前“方案研究期间不得改代码”误解为用户发起实施任务后仍禁止开发。仅在用户将本文件交给你并要求执行时开始实施，单纯阅读或讨论不构成实施授权。

简单工程问题自主决定并记录；涉及删除/迁移语义、权限、功能范围或与已确认选择冲突时，说明具体取舍让用户决定。不能为赶进度省略回迁、待确认保护、图片恢复或文件维护。单阶段完成不等于第一版完成。遇到真实阻塞报告证据和剩余工作，不用 mock Electron、内存数据库或模拟播放器掩盖失败。

先读根 `AGENTS.md`、`CONTEXT.md`、[主方案](SERVER_MODE_FEASIBILITY_RESEARCH.md)、[管理合同与验收](SERVER_MODE_API_RESEARCH.md)。按正在修改的领域读取现有 ADR 和相应 UI/插件文档，不要求通读所有 docs。主方案“已撤回实验”只提供历史证据，不存在可直接依赖的 V17 上传实现；正式 schema 17 只含身份/writer/回执与影片 `generation`/`revision`，图片交割仍是 S06。

## 已确认、不可自行改变的范围

1. 单仓库，desktop/web/server 三个应用，共享 contracts/library/http；ui 仅用于真实共用的纯展示组件。桌面和服务器同应用版本；网页与宿主产物配套发布。
2. 桌面保留本地模式；远程模式重启生效，不打开原本地权威数据库或运行其扫描/恢复/Web。插件、Playwright、模型、采集、裁切、助手工作记录在桌面；正式资料查询与提交在服务端。
3. 服务端固定标记保护仅处理原挂载卸载，不识别换卷、不支持更换已绑定挂载目录。离线保留数据，不补建已初始化但丢失的标记。本地模式仍执行 ADR-0024。
4. 同端口浏览与管理分权；网页只读，管理凭据不能被网页 Cookie 替代。关闭浏览入口不关闭管理接口。服务端不代理任意 URL、不执行桌面插件、不转码、不默认公网部署。
5. 单 writer：版本冲突拒绝、持久幂等回执、writerEpoch 最终提交隔离。首次绑定/正常交接/部署端恢复均为一次性凭据；没有账号系统或长期恢复密码。接管等文件维护结束或安全取消；已受理任务继续。
6. 图片先上传暂存，再统一应用；不做桌面持久上传队列或断点续传。服务端第一版只存未加密图片；迁移前在源端解密并检查真实存量。
7. `media://` 经桌面主进程取管理图片，凭据不交 renderer。远程播放首验 mpv、原文件 HTTP/Range、资源专用凭据 12 小时固定有效期；网页/本地播放沿既有合同。
8. 本地与服务端双向整库迁移，只到空目标。原视频文件由用户准备，不搬运。路径映射可全部省略；目标移除相应本地文件资源，保留影片、成员、隐藏、资料与图片；源库/磁盘文件不改。
9. 不映射 STRM 源目录时转普通链接；规范化目标冲突阻止发起迁移，不自动合并/丢弃。目标受影响媒体库关闭“自动移除无资源成员”，不自动固定成员；预览说明设置改变。
10. 存在待确认刮削（含演员冲突）、扫描组、资源身份、未结束预览或结果不明操作时，禁止发起迁移。正式冻结后再次检查。启用与取消在目标端持久互斥；结果不明时源端不解冻。
11. 迁移后新 catalog 身份、设备重新授权；目标启用后源端冻结备份，不自动回退。恢复旧快照不能直接接受旧请求。第一版不跨版本兼容、合库或自动同步。
12. 桌面采用统一用例层和本地/远程资料库后端，主进程在启动时装配。页面不选择 SQLite/HTTP；IPC 不直接调用数据库或业务单例；桌面采集/系统能力和权威资料库业务分开。同一管理界面渐进适配，不重写两份页面，不让本地模式通过 HTTP 调用自己。

## S00：本次结构准备的真实状态

本次结果及限制见 [结构准备验证记录](SERVER_MODE_STRUCTURE_VALIDATION.md)。

| 工作区 | 当前已有内容 | 尚未完成 |
|---|---|---|
| `apps/desktop` | 原 main/preload/renderer/MCP 已物理迁移 | 旧 main 内仍含业务、数据库、HTTP 和单例，远程后端尚未接入 |
| `apps/web` | 现有只读页面及资源已迁移，可单独构建 | 新服务器宿主适配与部署验证 |
| `packages/contracts` | 原 shared 的类型与纯工具，保留 `@shared/*` 兼容别名 | 正式远程读/写 DTO、输入 schema 与协议分组 |
| `packages/library` | 已移入 Node 路径/根/资源身份工具、catalog SQLite、图片存储、公网图片 HTTP、扫描辅助与编排/调度、扫描审计读取、分类查询/维护/主图、演员查询/冲突/图库/维护、标签查询、清单与媒体库维护、影片维护/生命周期、资源迁移、待确认资源身份、本地根护栏、NFO 编解码/导出资料与 sidecar 票据 | Electron 封面导出、刮削应用、catalog 查询 worker 入口仍待抽离 |
| `packages/ui` | 现有 Checkbox 与 CSS，桌面/Web 已引用 | 不预先扩大共享 UI 范围 |
| `packages/http` | 局域网浏览 HTTP、配对/会话、浏览 DTO、Range/静态文件 | 管理 HTTP 面尚未实现；由服务器宿主单独注册 |
| `apps/server` | 私有 workspace 和职责说明 | 服务启动、构建、Docker 均未实施，无占位成功脚本 |

根 `package.json` 暂保留桌面打包 metadata 和已有运行依赖，产物仍为 `out/main`、`out/preload`、`out/renderer`、`out/web`。workspace 脚本通过根命令执行，避免 cwd 改变破坏 worker/图片/打包资源位置。根安装不再隐式 Electron rebuild；桌面环境显式运行 `npm run setup:desktop`。根仍有 Electron 开发依赖，不能把整份根安装作为独立服务端生产安装。

`npm run check:workspaces` 检查版本一致和网页/共享模块边界；它不声称已验证独立服务器。现有边界、类型、测试发现、构建配置与研究探针已适配目录。后续移动用例时继续更新脚本和可点击文档链接，禁止保留第二份旧源码或用目录链接模拟迁移。

## 实施状态

| 阶段 | 状态 | 记录 |
|---|---|---|
| S00 | 已完成（交接提交 `f706402`） | [结构准备验证记录](SERVER_MODE_STRUCTURE_VALIDATION.md) |
| S01 | 合同已冻结 | [合同清点](SERVER_MODE_CONTRACT_INVENTORY.md)。282 项 IPC 均有去向；管理用例均有 Zod schema。验证：`npx tsx --test packages/contracts/src/inventory/ipcDisposition.test.ts packages/contracts/src/manage/schemas.test.ts packages/contracts/src/browser/dto.test.ts`（13 通过）；`npm run typecheck`；`npm run check:workspaces`。未实现业务、未改 schema 16、未接线 IPC。剩余：管理结果 DTO 在接入后端时从现有领域类型投影 |
| S02 | 进行中（library 已含 db、图片、公网图片 HTTP、扫描编排/调度、扫描审计读取、分类查询/维护/主图、演员查询/冲突/图库/维护、标签查询、清单与媒体库维护、影片维护/生命周期、资源迁移、待确认资源身份、NFO、维护闸门与路径清理、刮削确认/候选应用/清单 applyImport/目标列表/Agent findReady·apply·discard） | schema 已到 19。`getDb()` 单例仍保留。剩余：Electron NFO 封面导出、catalog 查询 worker 入口仍在 desktop；采集/deliver 仍桌面 |
| S02D | 本地架构门槛已验证；刮削确认/Agent apply/player/SCAN_RUN 已走 CatalogBackend。本地 Electron NFO 封面导出仍桌面；采集 Playwright/plan 仍桌面单例，但远程 start/匹配/apply 不再打开 `library.db` | 见本文件 S02D 实施记录 |
| S03 | 局域网浏览 HTTP 已抽到 `packages/http`；管理面未装配；纯 Node 可加载 | 见本文件 S03 实施记录 |
| S04 | Node 宿主、生产闭包与 Linux 镜像定义已落地；Node 生产烟测已完成。容器烟测在后续 Docker-in-Docker Cloud Agent 会话 `server:smoke` exit 0（见 S13 记录）；不得用 `server:smoke:node` 冒充镜像验收 | 见本文件 S04 实施记录 |
| S05 | 身份/writer/回执与影片版本已落地；本地 `videos.edit` 强制 `expectedVersions`；管理 HTTP 仅 Node 宿主装配 | 见本文件 S05 实施记录 |
| S06 | 正式 schema 18 上传表、流式 PUT、全用途 apply 与崩溃恢复已落地；生产烟测含 upload/apply/restart | 见本文件 S06 实施记录 |
| S07 | 最小双后端闭环与会话/认主/失败 UI 已落地；完整管理面与 D02/D07/M 全矩阵仍待 S08–S13 | 见本文件 S07 实施记录 |
| S08 | 管理浏览/编辑、资源/生命周期、分类合并删除、待确认与网页配对已落地；扫描/NFO/任务/根维护与刮削确认仍待 S09/S10 | 见本文件 S08 实施记录 |
| S09 | 挂载标记、扫描/审计、XML NFO、持久任务与文件维护已落地；刮削确认/清单导入已交 S10 | 见本文件 S09 实施记录 |
| S10 | 刮削确认/候选应用、清单 applyImport、命名目标列表与 Agent findReady/apply/discard 已落地；采集/Playwright/裁切 UI 与远程 start/plan 仍桌面，但远程匹配/apply 走 CatalogBackend | 见本文件 S10 实施记录 |
| S11 | play.grant、Range 原文件流、manage 图片 GET、media:// 代理、远程 mpv 与按 catalog 隔离的临时磁盘 LRU 已落地 | 见本文件 S11 实施记录 |
| S12 | 双向整库迁移协议/library/HTTP 已落地；M12 首次扫描与 M14 孤立暂存在 S13 补齐 | 见本文件 S12 实施记录 |
| S13 | 进行中：D01 `/proc`、D03 SIGKILL 复制窗、D02 双后端扫描/NFO/presence、M10 远程采集/助手/裁切/清单 start+匹配+真实 Node HTTP apply、D04 任务进度 generation 门闩、迟到 HTTP 交付与 in-flight abort、D05 窗口 binder 与真实 BrowserWindow 关闭/重建、M13/M15 mpv、全量 Electron 3056 通过；单容器 `server:smoke` 已通过；Docker 两端迁库烟测见 `server:smoke:migration`。安装包未做。不得宣称 M01–M15 / D01–D07 全部完成 | 见本文件 S13 实施记录 |
| S14 | 进行中：ADR-0029、操作文档与用户/开发入口已写；同版本安装包与镜像烟测未做 | 见本文件 S14 实施记录 |

## 阶段顺序与工作分配

推荐执行顺序：S01 → S02 → **S02D（桌面本地后端重构）** → S03 → S04 → S05 → S06 → S07 → S08 → S09 → S10 → S11 → S12 → S13 → S14。S02D 是新增的必需阶段，不改动原阶段编号，不能推迟到远程接入时才处理。若由多个 Agent 工作，只有明确不共享写入文件的任务才并行；S01/S02/S02D 的共享合同和装配入口必须有一个负责人，不能多 Agent 各建一份同名抽象。

每阶段先提交一个可审查的改动单元并写明验证；是否建立 commit/PR 按用户交接时要求执行。本文件不要求自动发布消息、Issue 或 PR。若用户要求进入工单流程，遵守 `docs/agents/issue-tracker.md`，以本文件各阶段生成任务。

| 阶段 | 依赖 | 交付重点 | 完成门槛 |
|---|---|---|---|
| S01 合同冻结 | S00 | 桌面用例/后端接口与网络合同分别定义；逐用例、DTO、错误、版本依赖 | 282 项声明全部有明确去向，UI 不依赖 HTTP，无通用 IPC 网络转发 |
| S02 业务抽离 | S01 | library 的显式运行时装配 | 本地原业务回归通过，生产 library 无 Electron/桌面导入 |
| S02D 桌面架构 | S02 | 用例层、本地后端、启动/关闭装配、工作存储隔离 | 本地模式经新接口回归通过；D01–D03/D06 的本地部分通过 |
| S03 HTTP 抽离 | S02/S02D | http 包、独立浏览/管理边界 | 本地只读网页合同不变，Node 可加载真实 HTTP 图 |
| S04 Node/Docker | S03 | 独立安装、入口、镜像、持久卷、生命周期 | Linux 真实 SQLite/图片/worker/Web 及重启通过 |
| S05 授权与操作 | S04 | 握手、认主、交接、幂等、版本基础 | M01/M03/M05/M06 相关协议用例通过 |
| S06 图片交割 | S05 | 暂存上传、正式应用、崩溃清理 | M02/M05/M14，无丢失正式图片 |
| S07 桌面远程后端 | S02D/S05/S06 | 实现既定后端接口、凭据、模式与缓存 | 编辑/封面闭环、M10/D01–D07，无本地权威库后台写入 |
| S08 完整管理 | S07 | 影片/演员/分类/清单/待确认/设置 | S01 每个管理用例都有实现与验证对应项 |
| S09 挂载与维护 | S08 | guard、扫描、NFO、持久任务、审计 | M04/M06/M08/M09，部分结果真实 |
| S10 桌面采集工具 | S08/S09 | 插件、Agent、清单导入、裁切远程应用 | 工作留桌面、正式资料在服务端，M07/M10/M11 |
| S11 图片与播放 | S07/S09 | media 协议、原文件播放、撤销 | M15 实际播放器验证及管理图片范围 |
| S12 双向迁库 | S06/S08–S11 | 快照、转换、可选映射、启用恢复 | M12/M13/M14 及往返完整性 |
| S13 全面验收 | S01–S12（含 S02D） | M01–M15、D01–D07、打包、真实故障测试 | 无被跳过而声称完成的核心场景 |
| S14 发布准备 | S13 | 文档、ADR、同版本产物和升级指南 | 所有范围可用，风险/验证矩阵完整 |

## 各阶段执行步骤

### 桌面目标架构与实施约束（适用于 S01/S02D/S07/S10）

本节为本轮确定的架构细节，尚未改代码。现状依据为 [appMain](../apps/desktop/src/main/appMain.ts)、[影片 IPC](../apps/desktop/src/main/ipc/videoHandlers.ts)、[IPC 注册](../apps/desktop/src/main/ipc/index.ts)、[IPC 错误处理](../apps/desktop/src/main/ipc/shared.ts)。当前主启动直接导入本地数据库与后台服务，影片修改直接使用单例，IPC 将多数失败压成字符串；这些不能直接作为远程适配基础。

目标调用链：renderer → preload/IPC → 桌面 application/workflow → CatalogBackend；LocalCatalogBackend → library，RemoteCatalogBackend → 管理 API。桌面系统能力由 application/workflow 显式协调，不能混入 library 或让服务端调用 Electron。

目标目录（为未来规划，当前不批量搬迁这些子目录）：

```text
apps/desktop/src/main/
  bootstrap/       模式读取、工厂装配、启动/停止
  ipc/             可信调用者及参数验证、桌面 DTO 映射
  application/     桌面用例、端口定义、错误及上下文
  backends/local/  本地 library 适配
  backends/remote/ 管理 HTTP 客户端、认证、传输及结果核实
  desktop/         窗口、凭据、文件选择、播放器、桌面设置
  workflows/      采集、裁切、Agent、清单导入的桌面协调
```

按真实依赖逐项迁移，不为目录名称重写成熟的插件/Agent 内部实现。已有领域模块可以保持内部文件布局，由 desktop/workflows 的装配调用；迁移完成后禁止通过 re-export 将旧业务 singleton 重新暴露给 IPC。

#### 三层合同与接口所有权

- **桌面 API** 在 contracts 的 desktop 分组定义，服务 renderer/preload，保留现有业务命名并渐进转换返回值。包含界面需要的稳定数据、上下文、能力和结构化错误，不包含 writer token、HTTP headers、任意服务地址或服务器 SQL。
- **后端端口** 由桌面 application 定义，以 queries、videos、actresses、classifications、playlists、libraries、assets、tasks 等领域小接口组合成 `CatalogBackend`。接口按用例而非 CRUD 表操作划分；合并、确认待办等是完整调用。统一 Promise 返回，调用方不能依赖本地同步执行的偶然行为。
- **HTTP 合同** 在 contracts 的 manage/browser 分组定义，由 remote 适配器映射。HTTP 用例可与后端方法对应或组合，但不要求逐 IPC 建路由。本地适配器直接调用 library，不创建 localhost HTTP，也不模拟 writer token/网络握手。

server 不依赖 desktop 的端口定义；它通过 HTTP 合同调用 library 业务。可复用的纯数据类型放 contracts，Electron 能力接口留 desktop。接口使用普通 TypeScript 加显式工厂注入即可，首版不增加 DI 容器、全局 service locator、动态插件式后端注册或万能方法分发器。

UI 提供用户读到的原版本和明确选择；主进程捕获当前身份并创建操作编号，remote 适配器附加 epoch/凭据/网络包络。页面不能伪造授权身份，适配器也不能悄悄读取最新 revision 替换用户的原版本。结构化错误跨 IPC 保留 code、受控 details 和恢复动作，不能靠解析中文字符串决定重试。

#### 桌面用例与流程的边界

普通查询/编辑的 application 方法可以很薄，负责上下文、输入映射和错误转换；不要复制后端业务校验。刮削、裁切、图片导入和播放由 workflow 协调桌面能力与后端，所有正式业务应用仍交当前 CatalogBackend。

刮削统一流程为：读取目标及原版本 → 桌面采集/选择 → 后端暂存图片 → 后端提交候选及原版本 → 记录业务结果。图片阶段通过后端适配：本地从受信任临时文件导入，远程流式上传；临时文件使用主进程持有的不透明句柄，renderer 不可指定任意主机路径。后端返回的暂存引用只在当前后端上下文有效。

播放器依赖桌面启动能力和后端生成的播放描述；本地描述可由主进程内部携带经过 guard 的文件定位，远程描述是资源专用播放地址。两种描述不作为无约束路径/URL 返回 renderer。UI 的资源展示字段、根相对位置和可用动作由统一 DTO 提供。

IPC 注册改为接收 application、desktop services 与窗口事件接口，不只注入查询而继续硬编码修改单例。Agent/清单导入工具也要使用同一注入端口，不能通过隐藏的 repository 导入绕开后端。日志和故障定位保留调用链 ID，不能把令牌或完整播放地址写入工作日志。

#### 启动、设置与工作存储

bootstrap 先读取独立桌面设置和模式，选择一种装配，再注册用例/IPC 并打开主窗口。本地工厂显式创建数据库、恢复器、扫描、图片和可选网页；远程工厂只创建连接、凭据、后端和桌面工作流。两种工厂可以打入同一安装包，但导入未选中的工厂不得打开数据库、读取本地业务设置或启动后台任务。

保留 Electron 需要在 ready 前执行的协议注册/应用身份配置；其实现只依赖桌面壳，不导入本地资料库。启动失败按已创建资源逆序释放，保留可显示错误的桌面壳，不自动启动另一种模式。连接失败时仍可修改此电脑设置、重试或按已确认流程切回本地。

桌面设置（模式、地址、窗口、播放器等）、安全凭据存储、桌面工作记录、当前权威资料库配置分别拥有存储接口。工作记录可用独立桌面 SQLite，但不得重新连接本地 `library.db`；workStore 不是权威库缓存，更不是待确认资料的另一份主库。

若旧版工作记录混在本地业务库，S02D 在本地升级准备阶段执行可重复的复制/校验/切换，先结束或安全取消活跃工作，再复制记录与版本，成功后写完成标记；不得先删源记录。后续桌面工作只读写 workStore，原记录留作不再调度的历史。远程模式启动不临时打开旧库做补迁；遇到未完成准备状态时明确提示回到本地完成准备，不静默丢弃历史或自动重放旧工作。

本地后端上下文身份持久、与路径字符串分开；远程身份沿主方案 serverId/catalogId。正式迁库只迁权威数据，workStore/桌面配置/凭据不进入迁库包。

#### 会话上下文、能力与状态

每个启动后的后端具有不可变模式和资料库身份；同实例重连产生新的连接 generation，用于丢弃迟到响应，不生成新 catalog。模式变化仍通过重启，首版不实现运行中热插拔后端。

查询键、工作记录和图片引用绑定 catalog 身份与具体 scope/libraryId；请求捕获 generation，旧连接迟到的数据不能覆盖新连接状态。普通重连重新读取当前状态，不自动覆盖未保存草稿，不自动提交离线编辑。

统一 `DesktopSession` 快照描述启动中、可用、断线、授权失效、版本不符、需要恢复等连接状态；资料库冻结是独立的写入限制，不等于无法读取。错误页和普通页面共享该状态来源，不各自判断网络是否正常。

能力以明确的可用动作及原因提供（例如本地定位、服务端目录选择、图片加密），不向页面暴露底层实现策略。能力只指导 UI，执行时主进程/后端仍鉴权和复核。管理桌面丢失授权后不得继续把旧查询缓存作为可操作的已授权资料。

第一版复用现有 React 查询/状态方案，不新增通用全局状态框架。关闭自动重试 mutation；读请求可以有界退避，写请求按原 operationId 核实。用户点击“重试”不能默默产生新的修改编号。

#### 取消、窗口关闭与进度

HTTP 等待取消与业务任务取消分别表示：AbortSignal 只停止当前等待/读请求，不能宣称服务端事务已回滚；取消服务端任务须显式请求并等其安全边界确认。全局关闭时停止桌面采集和新提交，取消读取/轮询/图片请求；已受理远程任务继续，未核实操作保存最小回执查询记录供重启恢复。

主窗口隐藏到托盘不是退出。真正窗口销毁/renderer 崩溃时，按已有前台工作流规则停止采集、释放无主预览，但不把远程已受理应用标成取消。macOS 重建窗口不能重复注册后台任务、IPC 或订阅；取消订阅与 dispose 必须可重复调用。

进度快照区分 `desktop` 与 `catalog` 工作所有者、目标身份、taskId、revision 及真实终态；页面使用统一模型。本地事件与远程轮询由各自适配器转换，不能因“本地发事件”与“远程收 HTTP”维护两套任务 UI。

#### 架构验收 D01–D07（均待实施验证）

| 编号 | 操作 | 必须证明的结果 |
|---|---|---|
| D01 启动隔离 | 远程正常、断线、版本不符启动；监测本地数据库打开入口、后台注册和文件访问 | 三种情况均不打开本地权威库/启动其扫描恢复/Web；只允许桌面配置、凭据及 workStore 访问 |
| D02 业务合同 | 同一套影片查询/修改、成员设主、预览确认用例分别用真实本地后端和真实远程后端运行 | 业务结果/错误/版本含义一致，无依赖同步执行或本地 HTTP 的特殊分支；文件保护策略按模式区分 |
| D03 工作存储升级 | 旧记录复制中断、完成标记前崩溃、重复启动、准备未完成时远程启动 | 原记录保留、不会双份调度；成功记录只由 workStore 管理；远程不偷开源库补迁 |
| D04 迟到响应 | 断线后重连，让旧查询/进度/图片请求最后返回 | 旧 generation 不覆盖新状态；草稿不被自动提交或替换；catalog 不同的记录不能混入 |
| D05 取消与退出 | 提交后取消等待，任务运行中关闭/重建窗口，随后重新连接 | 无重复 IPC/订阅/任务；远程已受理工作继续；结果不明可按原操作编号查明 |
| D06 边界检查 | 对生产依赖图检查 renderer/preload、IPC、application/workflow、backend、library | renderer/preload 无管理 HTTP/凭据；IPC 无 repository/业务 singleton；workflow 不绕后端；library/http 不依赖 desktop |
| D07 能力与错误 | 本地/远程切换、离线、接管、冻结、冲突和不支持的文件动作 | 能力有明确原因；不可用动作不能仅靠按钮隐藏保护；错误码完整跨 IPC，冻结可读，授权失效停止管理访问 |

单元测试可以用 fake 后端验证装配和错误分支，但 D01/D02 与端到端完成证据必须包含真实本地数据库及真实远程服务；不能用只返回固定结果的 mock 宣布两种模式等价。

### S01：把研究规则变成正式合同

以 [管理清点](SERVER_MODE_API_RESEARCH.md) 为底表，为每个请求/事件建立状态：桌面保留、管理查询、管理修改、后台任务、不可用于远程、兼容入口合并。补充尚不存在的握手、上传、任务状态、操作回执、迁移控制用例。清点不能只计数，每条必须能找到处理模块或明确的禁用原因。

在 `packages/contracts` 区分 browser/manage/desktop 合同；保留只读 DTO 白名单，不从数据库 row 推导网络 DTO。管理用例使用专用 schema，公用包络包含 operationId、预期实例/catalog/epoch、必需聚合版本。先定义列表/详情、影片编辑、图片上传/应用、任务与错误，再逐组补全。

同时冻结本节桌面目标架构的后端小接口、桌面能力接口、Session/Task/Error 模型；明确原 IPC 哪些参数/结果可保留，哪些路径/布尔值/错误字符串须转换。先定义纯类型与工厂边界，不将 remote HTTP 客户端写进 renderer，也不要求 S01 提前实现 writer 的持久协议。

首版技术限额基线：普通 JSON 请求 1 MiB、分页每页默认 50/最大 200、直接批量 ID 最多 200；超过时使用服务端目标清单，不扩大请求上限。图片沿现有图片类型/像素预算验证，并增加流式字节上限（初值每图 32 MiB）；这些数值是可调整工程默认，必须实测合理性并记录，不能静默截断输入。计划过期 10 分钟、领取凭据 10 分钟、播放 12 小时按主方案执行。秘密使用系统安全随机源，至少 32 随机字节；只保存摘要，避免把低熵口令直接散列当管理 token。

交付一份逐用例的请求/响应/版本/事务/错误表和实际 TypeScript/schema 定义；为业务边界编写有意义的 schema 与越权测试。完成门槛：不知道某字段该如何处理时，该项不能标“已冻结”；但不需要在 S01 提前实现业务。

### S02：抽离共享资料库后端

源区域为 `apps/desktop/src/main/db`、`services`、`scanner`、`nfo` 和图片存储模块；按依赖图逐块移入 `packages/library`，不要整目录搬迁后反向依赖 desktop。Electron app 路径、settings 单例、safeStorage、窗口事件、播放器、插件/Agent 装配留在 desktop。

引入最少的明确依赖接口：资料目录与数据库打开、图片读写/协调、设置读写、事件/时钟、根保护策略。数据库迁移和正式资料用例只有一套；根保护/图片加密由宿主选择适配策略。移除导入即初始化数据库、读取 Electron app 或开启扫描的副作用，统一由入口创建并关闭。

桌面本地模式先使用新装配替换原单例路径，保持功能。Node 的查询 worker 源也进入共享区域；入口路径由宿主显式提供，不能依靠 `app.getAppPath()`。新增静态导入图检查，禁止 library → desktop、Electron、Playwright；测试可以使用明确隔离的桌面集成夹具，不把测试例外变成生产例外。

验收：现有数据库迁移、图片交割、扫描/NFO、影片和演员维护回归；本地根 ADR-0024 不退化。没有新增产品 schema 时保持版本 16。

**S02 实施记录（db 切片）**

- 范围：目录数据库、迁移、repo 与测试迁入 `packages/library/src/db`；`libraryScanAuditValidation` 与 `strmParser` 因被 db 生产代码依赖而一并迁入 `packages/library/src/scan`；v0.6.2 schema 16 升级夹具迁入 `packages/library/src/testFixtures`。桌面测试对业务服务的引用改为明确的 `apps/desktop/src/main` 夹具路径，不把测试例外写进生产边界。
- 工程默认：本切片保留 `initDatabaseAtPath` / `getDb()` 进程单例，避免把连接注入扩散到全部 repo 调用点；S02D 由 `LocalCatalogBackend` 装配并注入。根级 `better-sqlite3` 仍由桌面安装闭包持有，服务器安装闭包是 S04。
- 验证：`npm run typecheck`；`npm run pretest`（含 `check:library-boundaries`）；`npm run test:packaging` 8 通过；全量 Electron 测试 2934 项、2933 通过、0 失败、1 跳过（Linux 上仅保留既有平台跳过项）。
- 未做：scanner 编排、NFO、图片存储、catalog application services 仍在 desktop；未改 schema 16；未接线 IPC；未实现远程后端。

**S02 实施记录（宿主注入切片）**

- 范围：新增 `packages/library/src/runtime/host.ts`；扫描审计 JSON 兼容层迁入 library 并通过 `resolveLibraryUserDataPath()` 取目录，不再导入 Electron。桌面 `configureDesktopLibraryRuntime()` 在 `app.whenReady` 注入 userData 与 `nativeImage` 尺寸解码，并把 catalog 查询 worker 入口从 `app.getAppPath()` 改为显式配置。`assetStoragePaths` / `assetCrypto` / `mediaAssetStore/imageBytes` 改为走宿主，不再直接 `app.getPath` 或 `nativeImage`。查询 worker 源文件仍在 desktop，因为它还依赖尚未抽离的 IPC schema / 审计 / 分类查询服务。
- 工程默认：Electron 测试通过 `scripts/register-library-test-host.ts` 注入解码器；`JAVDEX_TEST_USER_DATA` 覆盖路径，未设置时测试宿主使用临时目录。生产未配置宿主且无测试覆盖时失败，不静默回退。
- 未做：当时 mediaAssetStore 仍在 desktop。

**S02 实施记录（图片存储切片）**

- 范围：将 `mediaAssetStore` 及其路径/加密/别名/缓存辅助迁入 `packages/library`。生产 library 仍不导入 Electron 或 settingsStore；加密开关与自定义资料目录继续由桌面宿主从 `getSettings()` 注入。桌面/NFO/Web/刮削改为 `@library/mediaAssetStore`；`scripts/test-nfo-cover-artwork.cjs` 改为加载 library 路径并在原生 Electron 进程里调用 `configureDesktopLibraryTestRuntime()`。
- 验证：`npm run typecheck:node`；`npm run typecheck:web`；`check:library-boundaries` / `check:media-asset-store-boundaries` / `check:actress-boundaries` 通过。原生封面导出测试（真实 Electron codec + 加密 asset store）通过。全量 Electron 测试 2938 项、2937 通过、0 失败、1 跳过（Linux 既有平台跳过）；`npm run pretest`；`npm run test:packaging` 8 通过。默认测试超时 180s 不够跑完全套，本切片用 `JAVDEX_TEST_TIMEOUT_MS=360000`。
- 未做：scanner 编排、NFO 导出（仍用 nativeImage/窗口护栏）、catalog 业务服务仍在 desktop。未改 schema 16。

**S02 实施记录（扫描辅助与根护栏切片）**

- 范围：将 Node-only 扫描辅助（番号解析、时长探测、路径匹配、文件清单/计数/清理页、STRM 重定位索引）和 ADR-0024 本地根文件护栏迁入 `packages/library/src/scan`。桌面 IPC 仍经 `ipcPathGuards` 再导出 `assertMediaLibraryRootFile`，不让 handler 直接导入 `@library/scan`。
- 工程默认：当前护栏是本地模式策略，继续走 SQLite 根身份 + 实时路径校验；服务端不同挂载策略仍由后续宿主选择，本切片不改产品语义。
- 验证：`npm run typecheck:node`；library / actress / metadata-source / workspace 边界通过。迁出模块及根护栏相关测试 91 项全部通过（IPC path guards、LocalNfoSourceAdapter、NFO sidecar、番号/时长/清单/计数/STRM）。全量 Electron 测试 2938 项、2937 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）；`npm run pretest`。一次全量跑中 `useInfiniteVideoList` 未 settle，单独重跑通过，判定为既有时序 flake，与本切片无关。
- 未做：`scanner.ts` / `scanCoordinator.ts` / `scanNfoWorkset.ts` 仍在 desktop，因为它们还依赖 NFO 适配器、进度发布、维护闸门和路径清理服务。

**S02 实施记录（NFO 编解码与导出资料切片）**

- 范围：将 Node-only 的 NFO 编解码、目录影片身份、导出安全文案、导出 profile 渲染和 SQLite 导出投影迁入 `packages/library/src/nfo`。Electron 封面编解码、窗口护栏、任务控制器和 sidecar 文件票据仍在 desktop。
- 工程默认：`nfoExportRepository` 仍是 `getDb()` 单例；IPC 暂时直接引用 library 导出资料，S02D 再收到 application 层。未改 schema 16。
- 验证：`npm run typecheck:node`；library / actress / metadata-source / workspace 边界通过。NFO codec/profile/repository/safety、sidecar、export module/controller、native artwork 与 LocalNfoSourceAdapter 测试通过。全量 Electron 测试 2938 项、2937 通过、0 失败、1 跳过。
- 未做：`nfoFileStore` / `nfoSidecarLocator` 仍依赖 metadata-sources 的 `ManagedRootFileCapability`；`nfoExportModule` 仍使用 `nativeImage`。

**S02 实施记录（NFO sidecar 票据切片）**

- 范围：将 `ManagedRootFileCapability`、`nfoFileStore` 和 `nfoSidecarLocator` 迁入 `packages/library/src/nfo`。桌面 metadata-sources 继续再导出该能力类型，供刮削候选引用。
- 工程默认：能力票据仍是进程内 WeakMap，路径不进入 IPC/候选 JSON。授权函数由调用方注入（本地 ADR-0024 护栏）。
- 验证：`npm run typecheck:node`；library / actress / metadata-source / workspace 边界通过。sidecar locator、LocalNfoSourceAdapter、export module、scanner NFO directory identity 与 codec 测试 64 项、63 通过、0 失败、1 跳过（Windows 路径别名）。全量 Electron 测试 2938 项、2937 通过、0 失败、1 跳过。
- 未做：`nfoExportModule` 仍使用 `nativeImage` 与窗口护栏；`localNfoSourceAdapter` / `scanNfoWorkset` / scanner 编排仍在 desktop。

**S02 实施记录（扫描 NFO workset 切片）**

- 范围：将 `LocalNfoAnchor` / `LocalNfoIdentityInspection` 放到 `packages/library/src/nfo/localNfoTypes.ts`；将 `scanNfoWorkset` 迁入 `packages/library/src/scan`。桌面 local NFO adapter 再导出这些类型，避免打断现有 metadata-sources 入口。
- 验证：`npm run typecheck:node`；library / metadata-source 边界通过。scanNfoWorkset、scanner NFO 集成、LocalNfoSourceAdapter 与 directory cache 测试 60 项全部通过。全量 Electron 测试 2938 项、2937 通过、0 失败、1 跳过。
- 未做：`scanner.ts` / `scanCoordinator.ts` 仍在 desktop；`localNfoScanService` 仍依赖刮削应用服务。

**S02 实施记录（维护闸门与路径清理切片）**

- 范围：将 `maintenanceTaskGate`、`progressPublisher` 和 `libraryPathCleanupService` 迁入 `packages/library/src/scan`。路径清理改为直接引用 `@shared/videoResourcePromotion`，不再经过 desktop 再导出。
- 工程默认：维护闸门仍是进程单例，S02D 由 LocalCatalogBackend 装配。IPC/scanHandlers 暂时直接引用 library 闸门，S02D 再收到 application。
- 验证：`npm run typecheck:node`；library / actress 边界通过。progress publisher、路径清理、scan coordinator、cooperative cleanup 与 NFO export controller 测试 77 项全部通过。全量 Electron 测试 2938 项、2937 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）。
- 未做：当时 `scanner.ts` / `scanCoordinator.ts` 仍在 desktop。

**S02 实施记录（扫描编排切片）**

- 范围：将 `scanner.ts` / `scanCoordinator.ts` 迁入 `packages/library/src/scan`。本地 NFO apply 通过 `nfoScanPort` 由桌面注入（实现仍依赖刮削应用服务，留在 desktop）。`scanCoordinator` 改为直接引用 `@shared/videoResourcePromotion`。桌面 `scanner/` 仅再导出并在导入时配置 NFO 端口，供 IPC/测试兼容。
- 工程默认：扫描编排仍使用 `getDb()` 与维护闸门进程单例；S02D 由 LocalCatalogBackend 装配。未改 schema 16。
- 验证：`npm run typecheck:node`；library / actress / metadata-source / workspace 边界通过。扫描编排及相关测试 277 项全部通过（nfoScanPort、scanner、coordinator、cooperative cleanup、path cleanup、pending identity、local NFO transaction）。全量 Electron 测试 2940 项、2939 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`；新增 2 项为 `nfoScanPort`）。
- 未做：当时 `nfoExportModule` 仍使用 `nativeImage` 与窗口护栏；catalog 业务服务仍在 desktop；S02D 未开始。

**S02 实施记录（扫描审计读取切片）**

- 范围：将扫描审计只读投影（policy/header/index/view/session/path permission/request）迁入 `packages/library/src/scan`。桌面 `services/scanAudit*` 再导出以保持 IPC 与 catalog worker 入口兼容。
- 工程默认：审计读取预算不变；catalog 查询 worker 源文件仍在 desktop（仍依赖 IPC schema 与网页查询）。未改 schema 16。
- 验证：`npm run typecheck:node`；library / workspace 边界通过。扫描审计读取及相关测试 97 项全部通过（path permission、header/index/view/session、entries read、scanHandlers、coordinator entries、catalog worker）。全量 Electron 测试（与后续分类/清单切片同一轮）2940 项、2939 通过、0 失败、1 跳过。
- 未做：当时 Electron NFO 封面导出、其余 catalog 业务服务仍在 desktop；S02D 未开始。

**S02 实施记录（分类/标签只读查询切片）**

- 范围：将 `classificationQueryService`、`classificationListPage`、`classificationImagePage` 和 `tagQueryService` 迁入 `packages/library/src/catalog`。桌面再导出以保持 IPC / catalog worker 兼容。依赖 IPC schema 或维护写入的分类分页测试仍留在 desktop。
- 工程默认：查询仍走 `getDb()` 单例。未改 schema 16。
- 验证：`npm run typecheck:node`；library / classification / workspace 边界通过。分类/标签查询及相关测试 71 项全部通过（tag cache、list/image pages、facet IPC、catalog worker、director/org/series query+merge）。全量 Electron 测试 2940 项、2939 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）。
- 未做：当时分类维护/合并/图片写入、影片/演员业务服务、Electron NFO 导出仍在 desktop；S02D 未开始。

**S02 实施记录（清单维护切片）**

- 范围：将 `playlistService`（创建/更新/删除及封面交割）迁入 `packages/library/src/catalog`。桌面再导出供 IPC 使用。清单查询仍直接走 `playlistRepo`（S02D 再收到 application）。
- 工程默认：封面写入仍经 `mediaAssetStore.coordinateDatabaseChange`。未改 schema 16。
- 验证：`npm run typecheck:node`；library 边界通过。playlistService 测试 2 项全部通过。全量 Electron 测试 2940 项、2939 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）。
- 未做：当时影片/演员/分类维护服务、Electron NFO 导出、catalogReadWorker 入口仍在 desktop；S02D 未开始。

**S02 实施记录（分类维护切片）**

- 范围：将分类资料维护、合并、删除及 profile/name/link persistence 迁入 `packages/library/src/catalog`。`classificationImageService` 仍留 desktop，因为它依赖 `remoteImageFetch`（settings 代理）。桌面再导出以保持 facet IPC 兼容。
- 工程默认：维护仍走 `getDb()` 与 `mediaAssetStore`。未改 schema 16。
- 验证：`npm run typecheck:node`；library / classification / actress 边界通过。分类维护及相关测试 199 项全部通过（query/maintenance、merge、deletion、facet IPC、video scrape apply、video maintenance）。全量 Electron 测试 2940 项、2939 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）。
- 未做：当时影片/演员维护、分类远程图片导入、Electron NFO 导出、catalogReadWorker 入口仍在 desktop；S02D 未开始。

**S02 实施记录（演员查询与冲突切片）**

- 范围：将 `actressQueryService`、`actressAssetService` 和 `actressIdentityConflictWorkflow` 迁入 `packages/library/src/catalog`。`actressGalleryService` / `actressMaintenanceService` 仍留 desktop（远程图依赖 settings 代理）。桌面再导出以保持 actress IPC 兼容。
- 工程默认：查询与冲突处理仍走 `getDb()`。未改 schema 16。
- 验证：`npm run typecheck:node`；library / actress 边界通过。演员查询、冲突工作流和维护测试 82 项全部通过。全量 Electron 测试 2940 项、2939 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）。
- 未做：影片维护、演员图库远程导入、分类远程图片导入、Electron NFO 导出仍在 desktop；S02D 未开始。

**S02 实施记录（公网图片 HTTP 与 catalog 写入切片）**

- 范围：`LibraryHost` 增加 `http.scrapeProxyUrl()`，桌面从 `getSettings()` 注入，library 不再读取 settingsStore。将 `publicHttpUrl` / `publicHttpFetch` 迁入 `packages/library/src/net`，将 `remoteImageFetch`、分类主图、演员图库/维护、影片维护/生命周期、链接探测、无资源清理、本地文件可用性与待删除恢复迁入 library。桌面保留薄再导出以保持 IPC / `check-actress-boundaries` 缝兼容。
- 工程默认：刮削代理为空字符串表示直连；未配置宿主时不抛错、不回读桌面设置。未改 schema 16。`getDb()` 与维护闸门仍是进程单例。
- 验证：`npm run typecheck:node`；library / actress / classification / media-asset / workspace 边界通过。相关测试 233 项全部通过（host、public HTTP、分类主图、演员维护/冲突、影片维护/生命周期、链接探测、无资源清理、facet IPC、scanner）。全量 Electron 测试 2942 项、2941 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`；相对上一轮 +2 为 host 刮削代理测试）。
- 未做：Electron NFO 封面导出、刮削应用（metadata-sources）、catalog 查询 worker 入口、`videoQueryService`、`mediaLibraryService` 的刮削插件检查、待确认资源身份（本地 NFO）仍在 desktop；S02D 未开始。

**S02 实施记录（扫描调度、媒体库与资源迁移切片）**

- 范围：将自动扫描调度、分类身份解析、媒体库维护、遗留媒体库 bootstrap、待确认资源身份、图片加密迁移与图片目录搬迁迁入 library。桌面媒体库再导出装配刮削插件可运行检查，避免 library 导入 desktop scrapers。待确认资源身份默认走 `nfoScanPort`，不再直接依赖 desktop `localNfoScanService`。
- 工程默认：未配置 NFO 端口时待确认身份解析要求调用方注入 `nfoService`（测试）或由 desktop scanner 再导出配置端口。未改 schema 16。
- 验证：`npm run typecheck:node`；library / actress / metadata-source / workspace 边界通过。相关测试 139 项全部通过（scheduler、asset migration/location、legacy bootstrap、media-library service、pending identity、path cleanup、scanner）。全量 Electron 测试 2942 项、2941 通过、0 失败、1 跳过（`JAVDEX_TEST_TIMEOUT_MS=360000`）。
- 未做：Electron NFO 封面导出、刮削应用、catalog 查询 worker 入口、`videoQueryService` 仍在 desktop；S02D 未开始。

### S02D：先完成桌面本地后端重构

依 S01 的端口把 IPC 的本地调用搬到 application 和 LocalCatalogBackend，以 S02 的 library 工厂替代业务 singleton。先迁移查询、普通编辑和图片，再迁移预览/任务，最后逐个处理 Agent/采集工作流的依赖注入。保留现有 UI 页面和清晰的业务入口，不一次性重命名整个 preload API。

完成独立桌面设置/workStore 的升级准备、轻量 bootstrap、local 运行时生命周期、media/播放器能力接口。只建立 remote 工厂接口与未配置状态，不伪装服务端已经存在；测试未选择 local 时不访问它。S05 才实现的版本/回执字段须预留正确合同，不能用固定 revision 或随机伪 serverId 糊弄本地行为；真正的业务版本由 library 在相应阶段持久实现。

交付边界检查和 D01–D03/D06 可在本地完成的部分，完整原业务测试与构建通过后才进入 S03。不能为了提前宣布全合同完成而跳过 S05/S07 的真实远程验证。此阶段不新增远程产品功能，也不改已经确认的本地根保护、图片加密、播放器和只读网页行为。

**S02D 实施记录（本地后端与 workStore 起步）**

- 范围：新增独立 `this-computer.json` 设置、稳定本地 catalog 身份文件、SQLite `workStore`（含可重复 copy/ready 标记）、未配置远程工厂（不打开 `library.db`）、`LocalCatalogBackend` 的影片查询/编辑/评分/清元数据接入，以及 `createDesktopRuntime` 按模式装配（远程在 workStore `copying` 时拒绝启动）。IPC 仍走原服务单例，尚未替换字符串错误。
- 工程默认：未配置远程的 session 为 `disconnected`，能力一律拒绝；本地身份为 userData 目录上的 UUID，不是路径字符串。workStore 复制中断保持 `copying`，`idle`（无需复制）和 `ready` 允许远程启动，`copying` 必须回本地。影片封面上传引用仍标 `UNSUPPORTED_CAPABILITY`，等 S06。未改 schema 16，未伪造 serverId/revision。
- 验证：`npm run typecheck:node`；S02D 脚手架测试 7 项 + bootstrap 3 项全部通过。
- 未做：IPC 改为注入 CatalogBackend、结构化 `IpcResponse.error`、workStore 从 `library.db` 复制 agent 工作记录、bootstrap 接入 `appMain`、D01 远程三种启动的真实进程监测、D06 生产依赖图检查。S02 剩余 Electron NFO 导出、刮削应用、catalog worker 入口仍在 desktop。

**S02D 实施记录（IPC、本地 runtime、agent 工作复制）**

- 范围：`IpcResponse.error` 改为结构化错误并在 preload 抛出 `DesktopIpcError`；影片/演员/分类/清单/媒体库 IPC 改为注入 `CatalogBackend`；`appMain` 按 this-computer 模式装配 runtime。本地打开 `library.db`、恢复中断扫描、把 `agent_*` 表可重复复制进 `desktop-work.db` 后 ATTACH 为 `work`，catalog SQL 通过 `qualifyAgentSql` 写 workStore；远程在 copy 未完成或本地库仍待复制时拒绝启动且不打开原库。`registerIpcHandlers` 接收后端与桌面端口。新增 `check:desktop-architecture`（D06 本地部分：catalog IPC 不得导入 repo/业务单例；renderer/preload 不得导入 library/http）。
- 工程默认：S05 的 `expectedVersions` 本地仍未强制；封面/样张/图库上传引用仍 `UNSUPPORTED_CAPABILITY`（S06）；刮削应用、NFO、扫描/待确认、browser/tasks/migration 仍未接入 CatalogBackend。`agent_metadata_drafts` 随 agent 表复制，草稿应用与 catalog 删除仍走 writer 连接上的 ATTACH 事务。SQLite 不对 ATTACH 库强制外键；`AgentRunStore` 在本地/远程都改用 workStore 作为 main 连接。远程三种真实进程监测（D01 全项）和双后端 D02 仍待 S07。MODE_PREP_REQUIRED 在 `app.whenReady` 中仍会抛错而不是打开桌面错误页。未改 schema 16。
- 验证（提交 `deb4210`，Linux Node 22.14 / Electron-as-Node）：
  - `npm run check:desktop-architecture` 通过
  - `npm run pretest` 通过（含 D06 本地图检查、actress/library 边界、lint、CSS/UI 检查）
  - `npm run typecheck` 通过
  - `npm run test:packaging` 8 通过 / 0 失败
  - 定向 Electron：`JAVDEX_TEST_TIMEOUT_MS=180000 node scripts/run-electron-tests.mjs`（errors / host / workStore / createDesktopRuntime / localCatalogBackend / typedIpcAdapter / mediaLibraryHandlers / facetHandlers / catalogHighFrequencyWorker）**64 通过 / 0 失败**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2959 tests / 2958 pass / 0 fail / 1 skip**（Linux 上跳过 Windows 路径别名用例）
  - `npm run desktop:build` 通过；`npm run web:build` 通过
  - D01 本地部分：`createDesktopRuntime` 远程不调用 `initDatabaseAtPath` / `getDb()`；`copying` 或本地库未复制完成时抛 `MODE_PREP_REQUIRED` 且不断开 library.db
  - D03：本地启动把 `agent_runs` 复制进 `desktop-work.db`，源行保留，后续 `INSERT` 只进 `work.agent_runs`
  - D06 本地部分：catalog IPC 不得 value-import `@library/db|catalog` 或 `services/`；renderer/preload 不得 import library/http/server
- 未做：RemoteCatalogBackend；scan/scrape/pluginDev/agent/player/nfo/settings/assets IPC 仍允许直接使用 library/服务单例（D06 白名单）；Electron NFO 导出与刮削应用仍在 desktop。D01 远程三种真实进程监测与 D02 双后端仍待 S07。

**S02D 实施记录（SCAN_RUN 与远程 NFO IPC）**

- 范围：`IPC.SCAN_RUN` / `SCAN_LATEST_GET` 改为 `CatalogBackend.libraries.runScan|latestScan`。本地等待 `scanCoordinator` 完成事件以保持 renderer 的 `ScanCompletionResult` 合同；远程轮询 `tasks.get`。远程 NFO IPC 走 `backend.nfo.*` 并用任务终态合成 `finished` 事件；本地 NFO 仍用 `nfoExportTaskController`（Electron 封面编码）。采集 start/plan 仍桌面单例。
- 工程默认：冻结 `scans.run` 只有 `libraryId`，IPC 可选 `rootIds` 不再传入后端（界面本来只传 libraryId）。远程 `SCAN_CANCEL` 在本地 coordinator 未命中时按 taskId 取消。未改 schema。
- 验证：见 S13 记录 `3c9ed03`；`scanHandlers` 含后端路径单测。
- 未做：SCAN_AUDIT / FILE_* / pending 解析 IPC 仍触达 library 单例；本地 Electron NFO 封面导出未迁入 CatalogBackend。

### S03：抽离 HTTP，保持本地网页

从 `apps/desktop/src/main/web` 拆出纯 HTTP、认证存储、浏览 DTO 和静态文件服务到 `packages/http`；桌面的 webAccess 生命周期和本机设置适配留桌面。禁止 http 导入 desktop 或 server 入口；只依赖 contracts、library 的公开接口与标准 Node 能力。

浏览和管理路由注册分别启用，本地模式不因复用模块而新增管理网络面。分别投影图片范围，维持 Host/Origin/配对/Range 等现有防护。公开访问 authority 与容器监听地址分开传入，不默认相信代理头或任何私网 Host。

验收：原网页测试和网页构建通过；真实纯 Node 可加载 HTTP 与查询 worker，不能使用 Electron stub。基线研究探针原本预期 MODULE_NOT_FOUND；此阶段完成后更新其断言与文档，保留“修复前/后”的明确证据。

**S03 实施记录（局域网浏览 HTTP 抽离）**

- 范围：将 `http`/`auth`/`catalog`/`catalogQueryReader`/`catalogQueryRequest`/`catalogWorkerAdapter`/`WebServer` 迁入 `packages/http`。桌面 `webAccess` 仍负责 Electron 生命周期、`userData` 会话文件和本地装配，并显式注入 `listenHost` 与 `accessHosts`。`createManageHttpServer()` 存在以便本地浏览拒绝装配管理面。新增 `check:http-boundaries` 与纯 Node `check:http-node-load`（挂入 pretest）。研究探针改为断言 `packages/http` 可加载，文档保留修复前 `MODULE_NOT_FOUND` 证据。
- 工程默认：未传入 `accessHosts` 时仍回退到本机局域网地址列表（桌面 LAN 浏览兼容）；请求不读取 `X-Forwarded-*`。管理 HTTP 路由未实现（S04/S05）。桌面 catalog-read worker 入口因 IPC/扫描审计仍留 desktop；S03 纯 Node 加载的是浏览用 `WebCatalogQueryReader`。未改 schema 16。
- 验证（提交 `457b81e`，Linux Node 22.14）：
  - `npm run check:http-boundaries` 通过
  - `npm run check:http-node-load` 通过（`process.execPath` 为 `node`，`process.versions.electron` 为空，加载 `WebServer`/`WebCatalog`/`WebCatalogQueryReader`，并对空库执行 `collections()`）
  - `npm run pretest` 通过
  - `npm run typecheck` 通过
  - `npm run test:packaging` 8 通过
  - 网页相关 Electron 测试：59 通过 / 0 失败
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2960 tests / 2959 pass / 0 fail / 1 skip**
  - `npm run desktop:build` 通过；`npm run web:build` 通过
  - 本环境无 Docker，未复跑容器探针；探针源码已改为成功加载断言
- 未做：S04 独立 Node/Docker 入口；管理 HTTP；RemoteCatalogBackend。

### S04：独立 Node 运行和 Linux 镜像

在 `apps/server` 新增真实入口、构建配置、生产依赖清单、Dockerfile 与部署示例；从 root 运行依赖中明确分离服务器所需闭包。必须证明服务器的生产安装不包含 Electron、插件运行时、Playwright；使用 Linux Node 的原生包，不复用桌面 node_modules 或 Electron rebuild。

先以 Linux amd64/glibc、Node 22 建立验证目标；其它架构不先宣称支持。SQLite 所在 `/data` 要求本地文件系统，图片位于数据卷，媒体通过单独挂载；UID/GID、权限、磁盘空间、数据目录单实例占用必须检查。允许挂载目录来自部署配置，禁止管理员在 UI 输入任意宿主路径绕过边界。

启动按配置校验 → 数据库升级/恢复 → 任务恢复 → HTTP 就绪执行；升级失败不报告 ready。SIGTERM 后停止新写入、收敛任务、关闭 worker/HTTP/数据库。提供不泄露资料的 live/ready 状态。首次未认主不允许资料浏览。

新增根级 `server:build`、`server:test`、`server:smoke` 明确命令，失败返回非零。容器 smoke 使用临时卷、真实 SQLite/WAL、图片、worker、HTTP、Range、会话与重启持久化；不能只有 /health 通过。

**S04 实施记录（独立 Node 运行和 Linux 镜像）**

- 范围：`apps/server` 真实入口 `start`/`bind`；JSON+env 配置（绝对 `dataDir`、端口 0 或 1024–65535）；本地文件系统/磁盘/单实例锁检查；sharp 原生编解码；浏览 HTTP 在未认主时 503；可选 `/live` `/ready`（桌面 webAccess 不注入，保持 404）；生产 `server:build` 只把 `better-sqlite3`/`sharp` 留在闭包外；Dockerfile 仅复制 `out/server`。`createManageHttpServer()` 仍拒绝由浏览面装配。
- 工程默认：`apps/server/package.json` 不设 `"type": "module"`（tsx 源码测试走 CJS，避免与 library 双份 `getDb()`）；生产 `out/server/package.json` 为 ESM。占用文件 `instance-bind.json` 只是部署占位，**不是** writer token / `serverId` / 恢复密码，S05 必须换成身份协议。服务端 v1 明文图片。未改 schema 16。管理 HTTP 未装配。
- 验证（提交 `17559f1`，Linux Node 22.14 / amd64 glibc）：
  - `npm run server:test` **9 通过 / 0 失败**
  - 定向 Electron：`webServer.test.ts` + `catalogWorkerHttp.test.ts` **26 通过 / 0 失败**（桌面 `/live` `/ready` 仍 404）
  - `npm run server:build` 通过；`check:server-production-closure` 通过
  - `npm run server:smoke:node` **PASS**：隔离目录 `npm install --omit=dev`，`node_modules` 无 electron/playwright；真实 SQLite/WAL、HTTP、Range 206、会话跨 SIGTERM、未 bind 拒绝浏览、认主后演员行持久
  - `npm run server:smoke` **EXIT 1**：`docker is not available`（按设计非零，未伪装容器成功）
  - `npm run typecheck` 通过
  - `npm run pretest` 通过（含 `check:server-boundaries`）
  - `npm run test:packaging` **8 通过 / 0 失败**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2962 tests / 2961 pass / 0 fail / 1 skip**
  - `npm run desktop:build` 通过（`server:build` 已含 `web:build`）
- 未做（当时）：Docker 镜像/容器烟测（该会话无 `docker`）；管理 HTTP；writer/`serverId`/`catalogId`/epoch；RemoteCatalogBackend。下一阶段不得把占用文件当认主完成。后续 Docker-in-Docker 会话的单容器 `server:smoke` 见 S13，仍不是 S04 当时的完成证据。

### S05：身份、写入版本、认主与安全重试

依主方案实现 serverId/catalogId/epoch 生命周期、版本一致握手、候选凭据预保存领取流程和一次性部署命令。网页授权与 writer 分离；领取、终态记录和 epoch 切换原子化。安全凭据存储不可用时不退回普通设置文件。

在当前真实 schema 之后新增经过审查的迁移；不得照搬已撤回实验的 V17，也不能覆盖基线对历史开发 V17/18 的拒绝判断。测试从官方升级基线、schema 16 与新建空库产生相同结构，失败事务回滚、禁止降级。

实现操作编号/摘要持久回执、聚合版本、正式入队边界；最终提交再次校验 epoch。先贯通影片编辑，再推广。事务内先鉴权和查旧回执，再判断 revision，保证成功重试不被自身版本改变拒绝。查询回执仍需当前授权。回执生命周期、批量部分结果及错误恢复按管理合同执行。

同步让 LocalCatalogBackend 使用 library 中真实的业务 revision 与提交结果；不可长期保留“本地忽略 expectedRevision”的旁路。本地无需远程 writer 协议，业务冲突与图片原子提交语义仍应一致。S02D 中仅定义、尚无持久实现的合同项必须在本阶段补齐，再进行双后端一致性验证。

**S05 实施记录（身份、写入版本、认主与安全重试）**

- 范围：正式 schema 17 增加 `catalog_identity` / `catalog_writer_credentials` / `catalog_one_time_tokens` / `catalog_writer_claims` / `catalog_operation_receipts`，以及 `videos.generation`/`revision`（无 revision 触发器；仅 `editVideoRecord` 最终 `updated_at` 更新显式 `revision + 1`）。`hasOfficialSchema17` 要求五张协议表；`videos` 存在时才要求 generation/revision，避免无 videos 的 V14 夹具被误判。未发布实验 V17（缺 `catalog_identity`）与 V18 仍拒绝且不改写。library 实现握手、一次性令牌、领取（含维护等待不消耗令牌）、writer 鉴权、`commitCatalogMutation` 幂等回执与 `assertExpectedVideoVersion`。Node 宿主注册 `/manage/v1`（JSON 1 MiB）；桌面 LAN 浏览省略 `manage` 保持 404。CLI `bind`/`recover` 向 stdout 打印一次性明文，库内只存摘要；`JAVDEX_BOOTSTRAP_TOKEN` 仅未认主时有效。本地 `videos.edit` 走同一回执/版本路径（`writerEpoch: 0`）；页面经 `expectedVideoVersion` 提交 GET 读到的 V。writer 秘密写入加密 `writer-secrets.json`，安全存储不可用时拒绝，不回退 `this-computer.json`。
- 工程默认：浏览门闸改为 `writerEpoch > 0`，不再使用 `instance-bind.json`。浏览器 Cookie 不进入 manage dispatch。`writer.recoverIssue` 合同为 `publicHandshake`，本阶段 HTTP 仅环回签发；部署恢复以 CLI 为准。**需用户决定**：是否允许局域网签发恢复令牌。`VIDEO_UPDATE` 兼容入口不带 V，会 `INVALID_INPUT`。`setRating` 等其它 V 变更尚未强制 `expectedVersions`、亦不递增 revision。封面/样张上传引用仍 `UNSUPPORTED_CAPABILITY`（S06）。生产 ESM 包为 bundled CJS（undici）注入 `createRequire`。本地 catalogId 为 UUID；`catalog_id` 长度检查为 36。
- 验证（Linux Node 22.14 / amd64 glibc；实现提交 `2e53f87` `8d6a8ef` `b0daef8`，后续修复见同分支）：
  - `npm run server:test` **9 通过 / 0 失败**（含握手、认主后浏览、Cookie 不能管、`videos.edit` 冲突、环回外 recover 拒绝）
  - 定向 Electron：migrations V14–V17、writer/operations、local backend、writerCredentialStore、webServer、createDesktopRuntime、high-frequency worker **58 通过 / 0 失败**
  - `npm run typecheck` 通过
  - `npm run pretest` 通过
  - `npm run test:packaging` **8 通过**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2973 tests / 2972 pass / 0 fail / 1 skip**
  - `npm run server:build` 通过；`check:server-production-closure` 通过
  - `npm run server:smoke:node` **PASS**：隔离生产安装、SQLite/WAL、HTTP、Range 206、会话跨 SIGTERM、writer claim 后门闸、Cookie 不能授权 manage
  - `npm run server:smoke` **EXIT 1**：`docker is not available`（按设计非零）
  - `npm run desktop:build` 通过
- 未做：S06 上传表与图片交割；S07 RemoteCatalogBackend 与 D01–D07 远程监测；M01 管理/网页对象范围对照（网页 Cookie 调 manage 已拒绝）；M03 评分后改标题（`setRating` 尚未纳入 V）；M05 上传/任务入队边界；M06 已受理扫描穿越（交接等待已覆盖 running scan）。Docker 容器烟测仍缺。下一阶段不得把 mock 或研究探针当作真实部署/回放证据。

### S06：图片上传、提交和恢复

上传参数只允许用途/内容，不允许落盘路径；流式限制字节、格式、像素与解码预算，服务器计算摘要并绑定身份/epoch。上传记录先于文件写入持久化；完成上传不等于业务受理。

正式资源引用、上传 consumed 状态和短操作回执同数据库事务；文件写入、替换、旧图清理有持久恢复记录。恢复器可重复运行，不能删除任何正式引用图片，待确认图片有独立引用保护。覆盖封面、样张、头像源/裁切/图库、分类与清单图片，不只实现封面示例。

未引用上传初值 24 小时过期；按服务器时间回收、受理中的消费须防止与 GC 竞争，正式待确认不按普通上传 TTL 清理。上传写入中断必须释放文件句柄、磁盘空间和并发占用。注入写文件前/后、引用提交前/后、旧图删除前/后的进程退出；分清进程退出测试和断电验证。

**S06 实施记录（上传、apply、崩溃恢复）**

- 范围：正式 schema 18 增加 `catalog_image_uploads` / `catalog_image_file_jobs`，以及 actresses/organizations/directors/series/playlists 的 `generation`/`revision`（不改写冻结的 V8 CREATE；新库 CREATE 后 ALTER）。`hasOfficialSchema18` 要求上传表与 job 表；未发布实验 V17（缺 identity）与未发布 18（`user_version=18` 但缺上传表）拒绝且不改写。本环境 SQLite 会把 `ALTER TABLE ADD COLUMN` 内联进 `sqlite_master` CREATE SQL，V16 等值检查对 A/F/P 表与 `videos` 一样排除列清单比较。library：槽位行先于字节；PUT 流 32 MiB、内容类型必须与申请一致、`inspectServedImage` 64M 像素预算；用途 `videoCover` / `videoSample` / `actressAvatar` / `actressGallery` / `classificationImage` / `playlistCover` / `pendingScrapeStaging`。`commitManageImageMutation` 在回执事务后跑 promote journal 与 file jobs；未提交 promote 的目标文件可被回收，正式引用与已 consumed 的 pending-scrape 路径永不删除。崩溃点 `JAVDEX_IMAGE_CRASH`：`afterPersistUploadRow` / `beforeWriteFile` / `afterWriteFile` / `beforeRefCommit` / `afterRefCommit` / `beforeOldDelete` / `afterOldDelete`，子进程 `process.exit(75)`。Node 宿主 PUT `/manage/v1/uploads/:uuid`（Bearer、版本头、Origin）；JSON `uploads.create`/`inspect`、`videos.edit`（cover ref，`bumpRevision: false` 再走 `editVideoRecord`）、`videos.setPoster`（upload→`cover_path`，本片 sample asset→`poster_path`，clear 清 poster）、`videos.importSamples`、`actresses.setPoster`/`importGallery`/`applyCrop`、`classificationImages.set`、`playlists.create`/`update`。桌面 LAN 浏览仍无 manage。catalog 图片 I/O 只走公开 `mediaAssetStore`（含 `writeAtomic` / `inspectServedImage` 再导出），不 import 私有 filesystem/pixelBudget。
- 工程默认：暂存目录是 imagesDir 下的 `uploads/`，不进入 `ASSET_MEDIA_SUBDIRS`；刮削待确认独立 `.pending_scrape_staging/`。服务端 v1 `assetEncryption: () => false`，只存明文图。外键资产 ID、桌面路径字段（`posterPath`/`coverSourcePath`）与未知字段拒绝（M02）。Cookie 不能 PUT。本地 `videos.edit.cover` 走同一 apply；本地 `setPoster`/`importSamples` 仍用受信任本机文件/URL 入口（产品：本地文件导入、远程流式上传）。24h TTL 按服务器时间过期未消费槽位。
- 验证（Linux Node 22.14 / amd64 glibc；实现提交 `9ad2f76` `703f96f` `47fe77b`，后续修复 `d02f56b` `4b5788d` `755a5f5`，生产烟测 `0f6658f`）：
  - `npm run server:test` **11 通过 / 0 失败**（含 create→PUT→inspect→`videos.setPoster` 封面、重启后正式文件仍在且浏览可取图；Cookie 不能 PUT；拒绝桌面路径/未知字段/外键 sample）
  - 定向 Electron：migrations V16–V18、uploads/apply/recovery/crash **24 通过 / 0 失败**；S05/S02D 回归 writer/operations/local backend/credentials/webServer/createDesktopRuntime **36 通过 / 0 失败**
  - `npm run typecheck` 通过；`npm run pretest` 通过（含 `check:media-asset-store-boundaries`）
  - `npm run test:packaging` **8 通过**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2985 tests / 2984 pass / 0 fail / 1 skip**
  - `npm run server:build` 通过；`check:server-production-closure` 通过
  - `npm run server:smoke:node` **PASS**：隔离生产安装、SQLite/WAL、HTTP、Range 206、会话跨 SIGTERM、writer claim 后门闸、Cookie 不能 PUT、videoCover 上传/apply 后重启仍可浏览正式封面
  - `npm run server:smoke` **EXIT 1**：`docker is not available`（按设计非零）
  - `npm run desktop:build` 通过
- 未做：S07 RemoteCatalogBackend（桌面远程编辑/封面闭环、D01–D07 远程监测）；本地 `assets.createUpload` 仍 `UNSUPPORTED_CAPABILITY`；M14 迁库图片解密/存量检查（S12）；M05 任务入队（S08/S09）；M03 `setRating` 仍不递增 revision。崩溃注入覆盖进程退出，不是断电/fsync 失败。Docker 容器烟测仍缺。下一阶段不得把 mock 或研究探针当作真实部署/回放证据。

### S07：接入远程后端与最小闭环

在 S02D 的装配和端口基础上实现 RemoteCatalogBackend，映射 S01 的 manage 合同，接入 S05 的身份/认证/回执和 S06 的图片交割。模式选择、IPC 用例和 LocalCatalogBackend 应已存在，不在本阶段另建一套远程页面、通用 IPC 代理或有全局可变模式的 service locator。禁止 renderer 持有 writer token 或直接请求任意服务器地址。

实现 DesktopSession、版本/身份失败页、模式切换重启、generation 与缓存隔离、最小结果核实日志和旧请求取消。复用 S02D 的独立 workStore；不得在 remote 构造/重连/恢复过程中补开旧业务库。remote 自己处理协议身份和认证，页面只提供业务目标、原版本和用户选择。远程错误不自动本地回退；模式切换前处理未保存编辑、活跃桌面工作和结果不明提交。

验收门槛：管理隐藏/归档对象可见、网页不可见；影片编辑和封面上传可保存；丢响应后不重复；切回本地仍能打开原库。完成 D01–D07 的最小真实双后端闭环，未覆盖的大批次/维护细节在 S09/S10 补全并最终在 S13 验收。监测本地数据库和后台任务，证明远程模式没有偷偷打开原库。

**S07 实施记录（RemoteCatalogBackend 最小闭环）**

- 范围：新增 `packages/http/src/manageClient.ts`（Bearer、版本头、Origin；不带 Cookie）。`createRemoteCatalogBackend` 只走 manage HTTP，不 import SQLite/Electron。已实现 `videos.list`/`videos.get`/`videos.edit`、`uploads.create`/`inspect`/`putUpload`、`videos.setPoster`/`importSamples`、`playlists.create`/`update`、`classificationImages.set`、`operations.get`。其余端口仍 `UNSUPPORTED_CAPABILITY`。握手后比对 `appVersion`，不一致则 `versionMismatch`。`createDesktopRuntime` 远程模式读取 `remoteBaseUrl` 与 `writer-secrets.json`，不打开 `library.db`；无 URL 时仍用未配置占位后端。Node 宿主增加 `videos.list`。
- 工程默认：本地 `setPoster`/`importSamples`/`assets.createUpload` 仍走本机文件入口。远程未认主或缺少 secret 为 `disconnected`/`recoveryRequired`，不自动领取。超时默认 15s。
- 验证（Linux Node 22.14；提交 `b909965`）：
  - `npm run server:test` **14 通过 / 0 失败**（含 RemoteCatalogBackend 改标题、同 operationId 重试、videoCover PUT/apply 落盘、VERSION_MISMATCH）
  - Electron `createDesktopRuntime` **7 通过**：远程不打开本地库；切回本地仍能读到远程期间未改的 actress 行
  - `npm run typecheck`；`npm run pretest`；`npm run test:packaging` **8 通过**
  - 全量 Electron：**2986 tests / 2985 pass / 0 fail / 1 skip**
- 当时未做：renderer 版本/身份失败页；重连 generation 与迟到响应（D04）；取消/关窗（D05）；完整管理查询面（S08）；M01 隐藏/归档管理可见对照；writer 领取 UI；D07 全能力矩阵。

**S07 实施记录（会话、认主、失败 UI 与 D01/D04/D05）**

- 范围：桌面会话合同（`DesktopSessionSnapshot`、`DesktopWriterClaimRequest`；renderer 不得收到 writer secret）。新增 IPC `DESKTOP_SESSION_GET` / `CHANGED` / `RECONNECT` / `THIS_COMPUTER_*` / `WRITER_CLAIM`。`createDesktopRuntime` 在打开窗口前对已配置远程做 `reconnect()` 握手。`RemoteCatalogBackend` 可变 `generation`、AbortController 集合、`claimWriter` 在主进程生成 secret 并 POST `writer.claim`。失败态：`disconnected` / `versionMismatch` / `recoveryRequired` / `frozen`。`DesktopSessionOverlay` 阻断非设置页；冻结为横幅；资料库连接在设置 `network/mode`（`settingsPath('network')` 默认仍是 web）。`videos.get` 对隐藏影片回退 `getVideoDetail`；`libraries.list({ includeArchived })` 管理可见。QueryClient 在 `catalogId`/`generation` 变化时清空（D04）。
- 工程默认：本机模式 `claimWriter` 为 `UNSUPPORTED_CAPABILITY`。远程 URL 仅 http(s)、拒绝 userinfo。未完成 workStore 复制时不打开 `library.db`（`modePrepRequired`）。`writer.recoverIssue` 仍仅环回。`setRating` 仍不递增 revision（M03，未悄悄改 V）。
- 验证（Linux Node 22.14；提交 `473e559` `97ed837` `caa55bb`）：
  - `npm run typecheck`；`npm run pretest`（含 D06 桌面架构边界）
  - `npm run server:test` **18 通过 / 0 失败**（M01 get+归档库、claim 不回传 secret、reconnect/dispose 中止在途查询）
  - 定向 Electron：createDesktopRuntime / session IPC / overlay / capabilities / local backend 通过
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2994 tests / 2993 pass / 0 fail / 1 skip**
  - `npm run test:packaging` **8 通过**
- 未做：S08 完整管理查询/写入面；D02 同一影片在真实本地后端与真实远程 Node 宿主对照（本阶段仅有远程 HTTP）；D07 全能力矩阵；M01 独立演员/清单/待确认图/无成员影片。Docker 容器烟测仍缺。不得把 mock 当远程闭环证据。

### S08：完整管理功能

按 S01 清单逐组实现：影片资料/评分/标签、资源与成员、演员及冲突、机构/导演/系列、分类图片、清单及有序成员、所有待确认、媒体库/配置/根管理、网页配对设备管理。复用同一领域规则与 schema，不编写第二套影片身份判定。

预览完整记录关联依赖，删除/合并执行前检测新增引用；外部图片先桌面采集，路径输入替换为受控资产/根定位。根目录重绑、桌面 reveal、远程图片加密/数据目录在线搬迁按明确范围禁用，附合适原因，不留下能失败或误操作的按钮。

每组提供本地/远程相同业务结果测试和管理/网页权限差异测试。清单矩阵逐行标记实现位置、测试位置、限制；没有对应证据的行不得标完成。

**S08 实施记录（管理查询/写入面与网页配对）**

- 范围：Node 宿主 `dispatchCatalogManage` 覆盖影片浏览/评分/标签、资源导入与生命周期预览/提交、演员读写与冲突（`inspectName` 仅冻结 `{ name }`）、机构/导演/系列合并删除（提交时重算影响摘要，无 10 分钟持久计划表）、清单成员、待确认扫描/资源身份/影片刮削查询与丢弃、媒体库 CRUD/归档、网页配对。`RemoteCatalogBackend` 映射上述端口；评分/清资料/标记刮削成功/手动标签 IPC 带 `expectedVersions`。关闭浏览入口只 404 浏览路由，`/manage/v1`、`/live`、`/ready` 仍可用；`browser-surface.json` 持久化。远程设置页同一 `webAccess` IPC 改走 CatalogBackend，隐藏端口/账号/密码。
- 工程默认：`pendingVideoScrapes.confirm` / `videos.applyScrapeCandidate` / `playlists.applyImport` 仍 `UNSUPPORTED_CAPABILITY`（S10）。扫描/NFO/任务/根增删改/文件维护仍 S09。分类删除 HTTP 要 `planId`+`planDigest`，预览 digest 为当前影响 SHA-256，不是独立计划行。`library_video_memberships` 无 R 版本，资源操作有影片时只断言 V。`setRating` 仍不递增 V（M03）。`actressConflicts.inspectName` 冻结 schema 无 `actressId`，与本地 `inspectConflictName({ actressId, name })` 不完全等价（需产品决定是否改合同）。`pendingResourceIdentity.resolve` 先做文件/NFO IO 再写回执，崩溃窗口仍在。远程 IPC「重置浏览器授权」（无 id）映射 `browser.revokeSessions`；冻结 HTTP `browser.deviceReset` 仍按 `deviceId` 删除单台。浏览操作用例元数据声明 C，本阶段不虚构 catalog 级 C 聚合。分页 HTTP 上限 200，领域页函数多数上限 100，待确认页在 handler 内截到 100。
- 验证（Linux Node 22.14 / amd64 glibc；实现提交 `5d3b743` `a865b97`）：
  - `npx tsc --noEmit`：`tsconfig.server.json` / `tsconfig.node.json` / `tsconfig.web.json` 通过
  - `npm run server:test` **19 通过 / 0 失败**（含真实 Node 宿主 local+remote 浏览/评分/标签/机构/清单/链接资源/导演删除/inspectName/待确认；关闭浏览后 login 404、manage search 200、配对窗口、`browser-surface.json`；Cookie 不能 manage）
  - 定向 Electron：IPC 版本包络、LocalCatalogBackend、VideoTagPanel、WebAccessPanel、pairing/webServer **72 通过 / 0 失败**
  - `npm run pretest` 通过（含 D06 桌面架构与 server 生产边界）
  - `npm run test:packaging` **8 通过**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2994 tests / 2993 pass / 0 fail / 1 skip**
- 未做：S01 全表每一行都有独立证据（缺扫描/NFO/任务/根/刮削确认/迁库/播放授权）；D02 尚未用 Electron 本地后端对照同一 Node 宿主（本阶段 in-process `createLocalCatalogBackend` vs HTTP）；D07 全能力矩阵；M01 独立待确认图/无成员影片；真实 Docker/部署/mpv。不得把 mock 当完成证据。需用户决定：是否给 `inspectName` 增加 `actressId`；浏览写是否要真正的 catalog C；远程「重置全部设备」是否应保持与本机 `resetDevices` 文件级重建一致。

### S09：挂载、扫描、NFO 与持久维护任务

实现 `.javdex-root` 初始化状态和可读检查；标记必须在实际挂载内。扫描开始、每次结果提交和每批缺失清理复核；取消/失败保留已提交批次及真实审计。符号链接、普通文件、打开后描述符、父目录写入检查继续存在。

任务持久状态至少区分排队、执行、取消请求、成功、失败、已取消、需要检查。取消请求不直接标已取消；只在安全边界确认。扫描重启可新建一次重新枚举，不伪造原扫描续跑成功；文件维护恢复须逐项核对而不自动从头执行。

计划保存/失效/释放资源，10 分钟超时和重启后失效；交接等待阻止新维护穿越。NFO、重命名、删除复用文件能力保护；只读挂载允许读取扫描、不允许维护写入。真实测试挂载卸载与普通文件缺失分别测试，不能仅用删除标记模拟全部挂载语义。

**S09 实施记录（挂载标记、扫描、XML NFO、持久任务）**

- 范围：正式 schema **19**（`catalog_tasks` / `catalog_maintenance_plans` / `catalog_settings` / `catalog_root_markers`）。服务端 `libraries.addRoot` 只接受 `mountSelectionId`（`config.mediaMounts` 键），在实际挂载内写入普通文件 `.javdex-root`，丢失的已初始化标记不补建。`scans.run` 走 `acceptCatalogTask` + 持久快照（queued/running/cancelRequested/succeeded/failed/cancelled/needsInspection）；取消只在协调器安全边界确认。NFO 计划 10 分钟 TTL、重启丢弃；服务端导出只写 XML，跳过封面/fanart/样张/头像。`files.rename` / `files.importManual` 用根相对路径；只读父目录拒绝维护写入。`RemoteCatalogBackend` / 本地 `CatalogBackend` 映射上述端口；本地 `addRoot` 仍用受信任本机路径。重启 `recoverCatalogMaintenance` 丢弃计划并把未结束任务标失败/needsInspection，不伪造续跑。
- 工程默认与升级：
  - 未发布 `user_version=19` 且缺任务表的库拒绝迁移。本地 ADR-0024 根没有 `catalog_root_markers` 行，不跑服务端标记检查。
  - `scans.run` 声明 G，无根 generation 列，只要求包络含 G，不虚构聚合。
  - `libraries.updateRoot` / `cancelRootRemoval` 冻结 versions 为 G，领域仍要 L；HTTP **同时要求 L**（需产品确认是否改合同）。
  - `files.rename` / `libraries.removeRoot` digest 为当前影响 SHA-256，不是 10 分钟计划行（NFO 使用计划表）。
  - `files.rename` 先改文件再写回执；崩溃后指纹变化会 `VERSION_CONFLICT`。
  - `libraries.removeRoot` 冻结 completion 为 task：无数据则同步删除，有数据走 `pending_removal` 作业，不另开 `catalog_tasks`。
  - 服务端扫描配置了 NFO **身份检查**；sidecar 资料应用仍在桌面/S10。桌面 `SCAN_RUN` / Electron NFO IPC 仍走原协调器与 `nfoExportTaskController`（S02D 剩余）。
  - `targetLists.*` / `play.grant` / 刮削确认仍后续阶段。无冻结 list-mounts HTTP。
- 验证（Linux Node 22.14 / amd64 glibc；实现 `7ce0bba`，修复 `7e9b67f` `8acf0e9`）：
  - `npx tsc --noEmit`：`tsconfig.server.json` / `tsconfig.node.json` / `tsconfig.web.json` / `tsconfig.browser.json` 通过
  - `npm run server:test` **20 通过 / 0 失败**（真实挂载 `ABC-001.mp4` 扫描导入、XML-only NFO、错误 digest 拒绝重命名、删除标记≠卸载目录、`MAINTENANCE_BUSY` 重叠扫描、幂等 `scans.run`）
  - 定向 Electron：migrations V14–V19、catalogWriter、LocalCatalogBackend、createDesktopRuntime **58 通过 / 0 失败**
  - `npm run pretest` 通过（含 D06 与 server 生产边界）
  - `npm run test:packaging` **8 通过**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2997 tests / 2996 pass / 0 fail / 1 skip**
- 未做：S10 刮削确认/清单导入/Agent 远程应用；S11 media+mpv；S12 迁库；D02 尚未用 Electron 本地后端对照同一 Node 宿主的扫描/NFO（本阶段 in-process `latestScan` + HTTP）；D07 全能力矩阵；M04/M06/M08/M09 其余故障注入与 Docker 真实部署。扫描时 sidecar 元数据不在 Node 上 apply。不得把 mock 当完成证据。需用户决定：updateRoot/cancelRootRemoval 是否继续强制 L；removeRoot 是否必须变成 catalog task。

### S10：桌面采集、Agent 和批次

插件、浏览器、模型密钥、头像计算保持桌面；只读资料库助手通过固定管理查询工具，网络资料采集与清单导入使用目标查询、候选选择及服务器应用接口。不得让 Agent 工具直接访问服务器 SQL 或沿用原本地业务 singleton。

复用 S02D 建立的 application/workflows 协调流程，只注入当前后端和桌面能力；不要按 local/remote 复制两份刮削或导入控制器。工作记录、候选图片和进度标明所属上下文与执行端，窗口重建只恢复订阅，不重新启动已有任务。新增工作流依赖也纳入 D06 边界检查。

批次开始取得固定目标及原始版本，采集结束提交仍使用该版本；不能悄悄刷新 revision 来绕过冲突。每项独立操作编号，暂停/取消停止新的桌面工作；已受理服务器提交继续并查询结果。桌面退出后不承诺未上传候选自动续传；只保存隔离的工作记录。

头像裁切回传来源版本/摘要，过期结果不得覆盖新图片。清单最终应用保持身份与有序成员的原子边界。每项错误、未开始及不确定数量明确；依赖项不得当作独立批次继续。

**S10 实施记录（刮削确认、候选应用、清单导入、目标列表、Agent apply）**

- 范围：插件、Playwright、候选采集、裁切 UI、清单 TEMP 会话与 Agent start/plan 留桌面。正式确认/应用进入 library + 管理 HTTP：`pendingVideoScrapes.confirm`、`videos.applyScrapeCandidate`、`actresses.applyScrapeCandidate`、`playlists.applyImport`、`targetLists.create|page`、`agentMetadata.findReady|apply|discard`。桌面 IPC 确认/丢弃/计数/分页走 `CatalogBackend`；`SCRAPE_ONE` / 批次采集仍 `scrapeJobController`。成功应用影片刮削后由 catalog 包装显式 `videos.revision + 1`（`applyScrapeResult` 本身不 bump，以免改既有刮削测试）。本地 `actresses.applyCrop` 走 `applyActressCropRef`。目标列表写入 schema 19 的 `catalog_settings` 键 `target-list:<uuid>`，不升 schema 20。
- 工程默认与升级：
  - 冻结 `targetLists.create` 仅 `{kind, filterDigest}`，无筛选载荷。本阶段只支持命名 kind（`videos.status:{all|0|1|2}`、`videos.library:{id}.status:…`、`actresses.status:{all|unscraped|success|failed}`）。自定义 `VideoBatchScrapeFilter` 无法从 digest 还原；桌面批次仍用本地 `resolveVideoBatchTargets`，未先 `targetLists.create`。
  - 冻结 `playlists.applyImport.videoIds` 上限 200，且只创建清单并挂已有影片（不自动建片、不追加）。桌面清单导入 IPC 仍走 TEMP + `playlistImportRepository.apply`（可建片、可超过 200）。切到冻结 HTTP 会丢掉该原子边界，保持本地 repository。
  - 冻结 `playlists.applyImport` versions P/L/V：新建清单无 P；HTTP/本地要求 L；若带 V 只断言**第一部**影片。
  - 冻结 `videos.applyScrapeCandidate` 声明 Q，但直达应用没有 pending 行：若已有 pending 则拒绝，要求走 confirm/discard；直达路径不要求 Q。
  - 冻结 `actresses.applyScrapeCandidate` versions A、Q；HTTP/本地不要求 Q。
  - 冻结 `agentMetadata.apply` versions V、A、F、Q；实现断言 V 或 A 以及 Q，**不断言 F**。`findReady` 查询不要求版本。无冻结 `pendingVideoScrapes.create` / Agent draft-create HTTP；远程采集不能把 pending/draft 写到服务器。
  - `pendingVideoScrapes.existingIds`：HTTP 空输入返回全部影片 id；IPC 仍接受 id 列表。
  - 渲染器裁切仍 `actresses.edit({ avatar })`；HTTP/本地 `actresses.applyCrop` 已接线但页面未切换。
  - `applyAgentMetadataDraft` 不重建桌面 review token，也不复制 `draftService` 的 route-to-pending。
  - 无冻结 list-mounts；`play.grant` 仍 S11。sidecar 扫描资料应用仍桌面。
- 验证（Linux Node 22.14 / amd64 glibc；实现 `72a966e`，修复 `4ffe0b8`）：
  - `npx tsc --noEmit`：`tsconfig.server.json` / `tsconfig.node.json` / `tsconfig.web.json` / `tsconfig.browser.json` 通过
  - `npm run server:test` **21 通过 / 0 失败**（真实 staged PNG 确认封面、直达刮削改标题、演员候选+upload poster+过期 crop digest 409、Agent findReady/apply/discard、清单有序成员、目标列表 + 过期 digest 409、local vs remote `pageTargetList`）
  - 定向 Electron：videoScrapeApplyService、localCatalogBackend、createDesktopRuntime、scrapeJobController、draftService **112 通过 / 0 失败**
  - `npm run pretest` 通过（含 D06 与 server 生产边界）
  - `npm run test:packaging` **8 通过**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **2997 tests / 2996 pass / 0 fail / 1 skip**
- 未做：S11 media+mpv；S12 迁库；远程 Agent start/plan 与清单导入 IPC；桌面批次冻结目标列表；渲染器 crop 切 `applyCrop`；pending/draft create HTTP；D02 Electron 本地后端对照同一 Node 宿主；D07 全能力矩阵；M07/M10/M11 真实远程采集隔离与分页拼接；Docker 真实部署。不得把 mock 当完成证据。需用户决定：是否给 `targetLists.create` 增加筛选载荷或 `targetListId` 批次入口；清单导入是否允许 >200 / 自动建片；直达 `applyScrapeCandidate` 是否应要求 Q；Agent apply 是否断言 F；`inspectName` 是否增加 `actressId`（仍为既有升级）。

### S11：管理图片与真实播放

实现 media 主进程代理管理图片、临时缓存、版本化引用、旧 catalog 请求取消。正式/独立/待确认图片依授权范围获取；失败显示占位，不持久同步远程图片库。

播放器设置程序路径，参数数组启动，禁止 shell 拼接。资源专用 token 只允许目标 HEAD/GET/Range，12 小时固定期限；到期/接管/资源定位改变后拒绝新请求并按主方案关闭旧流。普通标题修改不终止播放；外部直链直接交播放器，不带 Javdex 凭据。

以具体 mpv 二进制和测试媒体验收首播、拖动、暂停后续播、短断线、服务重启、撤销/过期。记录真实播放结果而不是只断言 HTTP 状态或进程启动。失败必须修复或请求用户作出兼容范围取舍，不能默默取消远程播放。

**S11 实施记录（管理图片、play.grant、真实 mpv）**

- 范围：`play.grant` 签发 12 小时资源专用 token，流式面为 `GET|HEAD /play/v1/:grantId?t=`（Range via `sendFile`）。凭据写入 schema 19 `catalog_settings`（`play-grant:` / `play-token:`），不升 schema 20。Cookie 不能授权播放或管理图片。`GET|HEAD /manage/v1/assets/<relpath>` 用管理 Bearer + 应用版本，前缀白名单 `covers`/`avatars`/`actress_gallery`/`samples`/`playlist_covers`/`uploads`/刮削暂存。远程 `media://` 由主进程带 Bearer 代理；本地仍读 `mediaAssetStore`。远程本地影片：`grantPlayback` 后 `spawn(绝对路径, [playbackHandle], { shell: false })`。直链 HTTP(S) 把源 URL 交给播放器，不签发 Javdex grant；web/magnet/ed2k `openExternal`。远程 reveal 明确拒绝。播放器路径是此电脑设置 `playerPath`（资料库连接面板文本框，无新 IPC）。writer 代次前进时事务内 `revokeAllPlayGrants`，提交后 `closePlayStreams`。标题修改不终止 grant。`PLAYER_OPEN_RESOURCE` 增加可选 `videoId` 以满足冻结 `videos.getResource({ libraryId, videoId, resourceId })`；IPC 键数仍 288。
- 工程默认与升级：
  - 冻结 `play.grant` versions R、G 写在查询包络上，查询无 `expectedVersions`。实现用 `locatorRevision`（kind/locator/source_identity/root_id/size_bytes/file_mtime_ms 的 sha256）做定位检查；G 由 catalogId/鉴权覆盖。不虚构 `library_video_memberships` 的 R 聚合。
  - `videos.getResource` 仍返回绝对 `locator`（S08 既有展示定位泄漏）；本阶段只附加 `locatorRevision`，不静默删 locator。
  - 无冻结 manage-image GET 路径；本阶段增加二进制 `GET /manage/v1/assets/...` 作为 `PUT /uploads/:id` 的姊妹面。无冻结 play-stream HTTP；使用 `/play/v1/` 而不是 `/manage/v1`。
  - 本地 `assets.grantPlayback` 仍 `UNSUPPORTED_CAPABILITY`；本地播放仍走受保护文件句柄 / `shell.openPath`。
  - 图片临时缓存：进行中的 `AbortSignal`（catalog 切换/后端 `trackSignal`）会取消 in-flight 远程读取。远程 `readImage` 在 `userData/remote-image-cache/<catalogHash>/` 做按 catalog 隔离的临时磁盘 LRU（默认 512 项 / 256 MiB）；命中跳过第二次 GET，中止的读取不写入。失败返回占位/404/503，不持久同步远程图库，不断网当完整图库。
  - 服务端 v1 明文图片。Play HTTP 无效/过期 token 一律 404，不泄露 grant 是否存在。
- 验证（Linux Node 22.14 / amd64 glibc；实现 `8a00ab9`，e2e 路径修复 `443d9ee`）：
  - `npx tsc --noEmit`：`tsconfig.server.json` / `tsconfig.node.json` / `tsconfig.web.json` / `tsconfig.browser.json` 通过
  - `npm run server:test` **22 通过 / 0 失败**（12h grant、Range 206 `0123`/`4567`、cookie≠auth、过期 digest 409、改标题仍 206、manage PNG GET、cookie 图片 401、编码遍历 400、remote `grantPlayback`/`readImage`、handoff 后旧流 404、过期 inspect `AUTH_REQUIRED`）
  - 定向 Electron：playerService、mediaProtocol、catalogPlay、catalogManageImages、catalogWriter、ipcDisposition、this-computer settings **32 通过 / 0 失败**
  - `npm run pretest` 通过
  - `npm run test:packaging` **8 通过**
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=360000 node scripts/run-electron-tests.mjs` **3003 tests / 3002 pass / 0 fail / 1 skip**
  - M15 真实播放（本环境 apt 安装 `/usr/bin/mpv` 0.37.0；ffmpeg 生成 4s H.264 AAC `testsrc` 320×240）：mpv `--vo=null --ao=null`、参数数组、`shell: false`。IPC 观测 `time-pos` 从 0.000→0.333（duration 4.023）；pause 保持；resume 再前进；`seek 2.2 absolute` 落到 2.200。MKV grant `video/x-matroska` 同样解码到 `time-pos` 0.333。停服后 grant 仍在 `catalog_settings`；换端口重启 HEAD 200，mpv `loadfile` 再播 `time-pos` 0.125。writer handoff 后 HEAD 404，mpv 日志 `HTTP error 404 Not Found`。mpv 打开并软件解码 `h264 320x240 24.000fps` + `aac`，`VO: [null] 320x240 yuv420p`。这不是只断言进程启动。
- 未做：S12 迁库；S13 全矩阵/Docker/安装包烟测；S14 文档与 ADR；远程 Agent start/plan 与清单导入 IPC；桌面 `SCAN_RUN`/NFO IPC 仍桌面单例；`videos.getResource` 仍带绝对 locator。不得把 mock 当完成证据。需用户决定：`play.grant` 查询是否应断言 R；manage 图片是否必须改成 JSON op；play 流是否必须挂在 `/manage/v1`；`PLAYER_OPEN_RESOURCE` 是否永久保持两参数；`videos.getResource` 是否去掉绝对 locator。

### S12：双向整库迁移

按主方案第 7–9 节实现持久迁移协议、空目标独占、预检/冻结/快照/暂存校验/启用或放弃。版本、待确认、结果不明操作、活动任务、加密存量、磁盘空间和目标授权先校验，冻结后重算影响；结果变化回预览。

建立逐表/逐资产转换清单：正式对象、成员、资源键、源身份、STRM 来源、主资源、根、设置、权威图片、审计、任务历史、凭据/操作记录。禁止全库路径字符串替换。快照考虑 WAL 和图片同一冻结窗口。

按根可选映射；无映射删除目标本地资源、STRM 转普通链接且冲突阻塞、取消目标根配置、受影响库关闭无资源自动清理。映射错误不能降级成不映射；Windows 路径按源平台解析，目标重建身份并检验大小写/别名冲突。待确认不导入，未识别/扫描活跃快照不跨端执行。

数据包 manifest 至少含格式/应用/schema 版本、源平台与身份、migrationId、数据/图片数量和摘要、映射摘要；验证 ZIP/归档路径逃逸、符号链接、重复条目、大小上限及解包空间。凭据不进入包。

源端持久“允许启用”后才发许可；目标同一个持久决策点选择 active 或 abandoned。只有目标永久 abandoned 才允许源解冻；删除暂存文件不删除终态。断网、迟到许可、两端重启、启用响应丢失全部有验收。启用新 catalog 和重置授权后，源端保留冻结备份；回迁从当前目标重新执行。

**S12 实施记录（双向整库迁移）**

- 范围：冻结 ops `migration.preview|start|status|allowEnable|enable|abandon`，auth class `migration`（独立于 writer Bearer；Cookie 不能授权）。无冻结签发 HTTP；CLI `migrate-auth` → `issueMigrationToken` / `issueCatalogMigrationToken`。一次性凭据首次成功 `authenticateMigration` 转为同 secret 的 recovery（无冻结 `migration.claim`）。状态写入 schema 19 `catalog_settings`（`migration-auth` / `migration-state` / `migration-final:<uuid>`），不升 schema 20。源端 preview 计算影响并持久 prepare；start 冻结后重算 digest，导出 gzip+ustar（`manifest.json`、`catalog/library.db`、官方图片相对路径），完成态为 catalog task。目标必须空库且 `writerEpoch=0`；preview 只校验挂载不持久冲突 digest。start 解包到 `{userData}/migration-staging/{id}/`，在拷贝上做转换，phase=`ready`。enable 在 ATTACH 后 `BEGIN IMMEDIATE` 拷入 live：新 `catalogId`、保留目标 `serverId`、`writerEpoch=0`、解冻；abandon 写永久终态、拒绝迟到 enable、删暂存不删 final。包上限 `MIGRATION_PACKAGE_MAX_BYTES` 512 MiB。凭据/一次性令牌/writer/pending/扫描组/未识别/Agent 工作/play-grant 不进包。`claimWriter` 在 frozen 时 `CATALOG_FROZEN`。`PUT /manage/v1/migration/packages/:uuid` 为冻结 JSON 之外的二进制姊妹面。本地/远程 `CatalogBackend.migration` 均接线；远程用 `migrationSecret`，不走 writer 包络 / `ensureConnected`。
- 转换：映射错误 `INVALID_INPUT`，不降级为不映射。未映射本地资源删除；未映射 STRM 转普通链接（`strm_source_path`/`source_identity`/`root_id` 置空）；规范化 `(library_id, kind, locator)` 冲突阻塞 start。映射根用源平台 `path.win32|posix` 相对化再在目标 `path.join`；目标 `resolveMediaLibraryRootIdentity` 检查大小写/别名。省略未映射根行。受影响库关闭 `remove_resource_less_memberships`（ADR-0028 例外）。主资源按 ADR-0014 kind 序重选。`AVPK\x01` 加密存量进入 `pendingBlockers` 并阻止 start/import。
- 工程默认与升级：
  - 冻结无签发 migration token 的 HTTP op。实现只用 CLI。源端 HTTP 也需要该凭据，因此允许在非空资料库签发（研究表述偏“空目标 staging”）。
  - 冻结无 PUT 包路径。增加 `PUT /manage/v1/migration/packages/:uuid`，与 uploads 同级。
  - 冻结 `migration.abandon` 摘要写“目标永久放弃后源才解冻”，但源 HTTP 没有目标证明回执。实现：持有 migration 凭据的协调者在源调用 abandon 即解冻（须先目标 abandon）。启用成功后源保持冻结备份；happy-path 测试不断言启用后再 abandon。
  - 目标 preview 不持久独占状态。目标 start 以包内 manifest（`previewDigest`、mappings）自洽。
  - SQLite `ATTACH` 不能在事务内执行：先 ATTACH 再 `BEGIN IMMEDIATE`。
  - enable 事务提交后再拷图片；拷图失败时库已启用、图可能缺失。
  - `start` 同步打包/解包后直接返回 succeeded task，不是后台队列。
  - 回迁是启用后的当前目标作为新源重新跑一遍，不是自动反向包。
- 验证（Linux Node 22.14 / amd64 glibc；实现 `f817eca`，补测 `a88760e`）：
  - `npx tsc --noEmit`：`tsconfig.server.json` / `tsconfig.node.json` 通过
  - `npm run server:test` **24 通过 / 0 失败**（CLI token、cookie/writer ≠ migration、PUT 包 cookie/writer 401、token PUT 200、source start 冻结、`videos.list` writer 403 `CATALOG_FROZEN`、remote `migration.status`）
  - 定向 Electron：`catalogMigration` / `catalogMigrationArchive` / `catalogWriter` **14 通过 / 0 失败**（STRM 转普通链接、未映射本地删除并关自动清理、封面文件随迁、新 catalogId / 保留目标 serverId / epoch 0、迟到 enable `AUTH_REQUIRED`、源未启用可 abandon 解冻、pending+加密阻止冻结、归档逃逸/重复/超限）
  - `npm run pretest` 通过
  - 未跑本阶段全量 Electron / Docker 两端真实部署
- 未做：M12 启用后对目标做真实首次扫描以证明无资源成员仍保留（S13 `e05c165` 已补）；M14 孤立暂存在引用/清理边界的注入（S13 `e05c165` 已补）；加密存量仅预检计数，无源端解密流程；断网/响应丢失/两端重启的完整矩阵（S13 `5a5a0fc` 覆盖启用后两端重启，不是丢响应后再重启）；Docker 两端状态与文件检查。S13 全矩阵；S14 ADR/用户迁移文档；磁盘 LRU；S02D 采集 start/plan 仍桌面单例，本地 Electron NFO 封面导出仍走 `nfoExportTaskController`。不得把 mock 当完成证据。需用户决定：是否增加冻结的 migration 签发 HTTP op；PUT 包是否必须改成 JSON op 或沿用 uploads；源 abandon 是否必须携带目标终态证明而不能仅凭协调者声明；enable 图片拷贝失败是否必须整笔回滚；非空库签发 migrate-auth 是否收窄为空目标。

### S13：完整验收

执行管理研究 M01–M15 及本文件 D01–D07，所有核心阶段做 Linux Node 与桌面本地回归；已确认范围不得通过跳过用例获得绿灯。增加真实 Docker 两端状态/文件检查、目标启用与取消竞态、数据库磁盘不足、读写权限变化、文件操作恢复核对。测试必须有足够空间、隔离数据，不能使用用户真实媒体库做破坏性故障注入。

证明服务端依赖图与镜像生产安装没有 Electron/Playwright/Agent 运行时，网页包没有 Node/数据库代码；打包后的 worker、图片、网页路径可用。只验证源码 tsx 不能替代正式镜像和安装包验证。

输出验收矩阵，每项记录 commit、环境、步骤、预期/实际、日志与未覆盖部分。已知基线编码检查问题需单独记录，不能通过全局关闭检查解决。失败但未修复的核心条目意味着计划尚未完成。

**S13 实施记录（进行中）**

- 早期 Cloud Agent 会话无 `docker`（`command not found`），容器烟测按设计非零，不能用 `server:smoke:node` 冒充镜像验收。用户删除阻挡的个人 Environment “Javdex” 后，本会话（`bc-ea15dce7-e037-5983-9443-6c3d73044e82`）从仓库 `.cursor/Dockerfile` + `.cursor/environment.json` 启动：`docker version` / `docker info` 成功（Engine 28.5.2，fuse-overlayfs）。`environment-info.build.resolution` 为 `no_finished_builds`（即时启动，不是预构建 snapshot），但镜像含 Docker CE，daemon 已就绪。
- `npm run server:build` **EXIT 0**：写出 `out/server`（version `0.7.0`，依赖仅 better-sqlite3/sharp）。
- 首次 `npm run server:smoke` **EXIT 1**（未伪装）：镜像 `javdex-server:smoke` 构建并启动成功；未认主 `/api/collections` 503 正确；`docker exec bind` 后仍 503。原因是 S05 后 `bind` 只签发一次性令牌，浏览门闸要 `writer.claim` 把 `writerEpoch` 升到 >0。`server:smoke:node` 已含 handshake→bind→claim，容器脚本当时没有。
- 补上 claim 后 `npm run server:smoke` **EXIT 0**：`PASS: Docker image, volume SQLite, bind gate, session restart`。覆盖临时卷 SQLite、`/live` `/ready`、未认主 503、handshake `notBound`、容器内 `bind`、宿主 `writer.claim`、认主后 collections 200、restart 后 session 与 `library.db`。这是单容器生产镜像烟测，不是安装包烟测。
- 本轮新增 `scripts/server-migration-smoke.mjs` / `npm run server:smoke:migration`：两个 `javdex-server:smoke` 容器，源与空目标各用独立 `dataDir` 与 `imagesDir` 卷；源夹具按 `migrationHosts.e2e.test.ts` 写入番号 + 正式封面；两端 `docker exec migrate-auth`；宿主经 manage HTTP 走 preview → source start → PUT 包 → target start → enable。断言两端 `migration.status`（源 `frozen` / 目标 `enabled`）、目标正式图文件、源封面仍在（冻结备份）、目标新 `catalogId`。拷图 `EACCES` 回滚仍以既有单测为准，本烟测不重复。enable/abandon 竞态仍见 `migrationHosts.e2e.test.ts`。
- 已用两个独立 OS 进程（各自 `getDb()`）做源→空目标 HTTP 迁库，并在目标 `ready` 后并发 `enable`/`abandon`：终态互斥，迟到 enable 在 abandoned 时 401 `AUTH_REQUIRED`。启用成功后 SIGTERM 两端再拉起：源仍 `frozen`，目标仍 `enabled`。第三例在 `ready` 后丢弃 enable/abandon HTTP 响应再 SIGTERM，拉起后以 `migration.status` 为准，终态仍互斥（`e700e3f`）。不是 Docker 两端。
- M12：启用后对目标 `library.db` 做真实 `scanCoordinator.run`。未映射孤儿片无本地资源、自动清理关闭时成员保留；把 `remove_resource_less_memberships` 改回 1 再扫才会删成员（`e05c165`）。
- S02D：`SCAN_RUN` / `SCAN_LATEST_GET` / 远程 NFO / `FILE_IMPORT_MANUAL` / `PENDING_SCAN_RESOLVE` / `PENDING_RESOURCE_IDENTITY_RESOLVE` / `PENDING_SCAN_GET|LIST|QUEUE` / `PENDING_RESOURCE_IDENTITY_GET|LIST` / `PENDING_AUDIT_PRESENCE` / `SCAN_AUDIT_GET` / `SCAN_AUDIT_HEADER` / 远程 `SCAN_AUDIT_PAGE` / 远程 `SCAN_AUDIT_VIEW_PAGE` 走 `CatalogBackend`。本地 PAGE/VIEW 仍走 `catalogReadService` worker，保留 snapshot 身份、section 与 attention。冻结 `scans.auditPage` 无 section/attention，远程 HTTP 会剥掉；冻结 `scans.auditViewPage` 无 IPC `anchor`，远程同样剥掉。待确认解析在本地后端与服务端 HTTP 都传入 `fs.existsSync` 主资源回退（helper 在 `scan/accessiblePrimaryResource.ts`，不进 db 模块）。本地队列页仍带 IPC `anchor`；远程冻结 `pendingScan.queuePage` 无该字段，HTTP 映射会剥掉。本地 Electron NFO 封面导出仍走 `nfoExportTaskController`。采集 Playwright/plan 仍桌面单例：远程 `agentMetadataCollection.start` 经 CatalogBackend 描述目标；`libraryCurator` 概览经 `catalog.overviewStats`；远程裁切快照经 `actresses.listPage`；清单导入 start 经 `libraries.get`/`playlists.get`，远程匹配经 `videos.list`/`videos.get`，远程 apply 经 `playlists.applyImport`，远程会话写 workStore。远程 `FILE_RENAME` 因 IPC 无 `resourceId` 且 digest 必须指纹服务端活文件而拒绝；未识别路径仍走桌面 `renameAndImport`。冻结 `pendingAudit.presence` 仍是空输入的目录级计数；桌面 IPC 是 libraryId+ids，本地包装 `getPendingAuditPresence`，远程用 `libraries.get` 加 pending list 求交，不调用冻结 presence。远程 `SCAN_RUN` / NFO 轮询 `tasks.get`。
- M14：源库 `uploads/` 孤立暂存不进包、不成为目标封面；目标磁盘上再放一份无引用 uploads 文件后 `recoverCatalogImages` 删除且不改正式 `cover_path`。正式封面随迁。源端加密图在 start/导出时自动解密到迁移包（源正式图与别名不变）；缺别名则 start 失败并解冻。`chmod 000` / tmpfs `ENOSPC` 后 enable 回滚为 `ready`、目标保持空库、已拷文件尽量删除，可在恢复权限后重试 enable。
- 远程图片临时磁盘 LRU：`userData/remote-image-cache/<catalogHash>/`，按 catalog 隔离；第二次 `readImage` 不打 HTTP；中止的 GET 不落盘。
- D03：workStore 已复制行但 `prepStatus=copying` 时远程仍 `modePrepRequired` 且不 `getDb()`；回到本地才 `markReady`，源 `agent_runs` 仍在。OS 级 `SIGKILL`：子进程 `beginCopy` 后、`copyAgentWorkTables` 前被杀，`prepStatus` 保持 `copying`、目标 `agent_runs` 为 0、源行仍在；远程仍 `modePrepRequired`，回本地后复制完成（`933797f`）。
- D05：`createWindow` 不注册 IPC；远程 runtime dispose 后再装配仍不打开 `library.db`。主窗口重建调用已注册的 `bindMainWindow` binders（清单导入/刮削 renderer 生命周期用 WeakSet 去重），不二次注册 IPC（`870ddf2`）。`6be92a7` 用原生 Electron（非 `ELECTRON_RUN_AS_NODE`）关闭后再建 `BrowserWindow`：新 `webContents` 只绑定一次，`ipcMain.handle` 次数不变。不是任务进行中关窗的完整 GUI 产品流。
- D07：本地/远程 available/frozen/断线/版本不符/恢复/authInvalid/modePrepRequired 的能力原因已枚举。远程 `migrateCatalog` 在 available/frozen 与本地同一入口（`available`）；远程走现有 HTTP migration，不打开 `library.db`。`manageBrowserPairing` 仍 `unsupportedOnServer`。
- M15：真实 `/usr/bin/mpv` 0.37.0 + ffmpeg `testsrc` H.264/AAC 播放 Range grant：`closePlayStreams` 后同一 handle 再 `loadfile` 可续播；把 `play-grant` `expiresAt` 写成过去后 `HEAD 404` 且 mpv 日志含 HTTP 404；`seek 2.2 absolute` 落到 ≥2.05；MKV 同样解码；writer handoff 后 seek/`HEAD` 404（`e9ee433`）。
- M10：已连接远程 + `chmod 000` 本地 `library.db` 后，子进程绑定 CatalogBackend 并启动采集（空 URL）、助手概览、裁切快照、清单导入 start、`videos.list` 匹配 ingest、`playlists.applyImport`：`/proc/<pid>/fd` 无 `library.db`，`getDb()` 仍是 `Database not initialised`，失败路径也不是打开本地库（`5401689` / `3152bf1` / `86a82b5` / `bc019ee` / `2dd1e54`）。远程匹配写入 memory lookup，workStore snapshot 不再 JOIN `videos`。远程 apply 走冻结 `playlists.applyImport` 与持久 `operationId`；启动即拒绝 append 与自动建片；`>200` 在 prepare 时拒绝。Handshake 形 `videos.list` 不能当成空页。`8fc3d9a` 另用独立 Node 宿主：扫描出 ABC-001 后 `ingestCodes` + `applyPlaylistImportThroughCatalog` 经真实 manage HTTP 建清单，父进程 `chmod 000` 本地 `library.db` 后 `/proc` 无该库、`getDb()` 仍未初始化。刮削单条仍可走本地队列。无冻结 `video_sources` API，远程 sources 为空。冻结 applyImport 不写 per-video `video_links`。
- D04：`waitForCatalogTask` 按 generation / catalogId / taskId / taskRevision / progressSeq 应用 `tasks.get` 快照，终态不回绕；重连 generation 丢弃旧成功快照；失败退避至 30s；`SCAN_CANCEL` / `NFO_EXPORT_TERMINATE` 中止本地等待（`870ddf2`）。`8fc3d9a` 对真实 Node 宿主 `tasks.get`：HTTP 响应已返回后 `reconnect()` 推进 generation，再把该快照交给 `waitForCatalogTask`，旧 generation 不应用，后续 poll 才应用终态。`cb13f72` 另在真实 `tasks.get` 已受理后卡住响应，再 `reconnect()` 中止 in-flight fetch：3s 内完成，不等待 8s 服务端 stall。不是掐断 TCP/WAN 丢包的物理断线。
- 验证（Linux Node 22.14 / amd64 glibc；另见 `3c9f97b` / `5589d42` / `83d6cf2` / `65c3e1c` / `5ebff2d` / `4822fb6` / `1bac323` / `4c79d67` / `e187266` / `6ad4b84` / `156c1a8` / `5699eae` / `8d3d8f4` / `544e099` / `747ab75` / `933797f` / `e9ee433` / `5401689` / `3152bf1` / `86a82b5` / `870ddf2` / `bc019ee` / `2dd1e54` / `8fc3d9a` / `cb13f72` / `6be92a7`）：
  - `npx tsc --noEmit -p tsconfig.server.json --composite false` 通过
  - `npx tsc --noEmit -p tsconfig.node.json --composite false` 通过
  - 定向：`ELECTRON_RUN_AS_NODE= TSX_TSCONFIG_PATH=tsconfig.server.json node --require ./scripts/register-test-paths.cjs --import tsx --test apps/server/src/dualBackendScan.e2e.test.ts` **1 通过**（含 live HTTP reconnect、in-flight abort 与远程清单 apply）
  - 定向 Electron：`createDesktopRuntime.isolation` **5 通过**（含 D03 SIGKILL 与 M10 六探针）；`createDesktopRuntime` **12 通过**；`catalogTaskProgress` **8 通过**；`mainWindowBindings` **1 通过**；`mainWindowBindings.native` **1 通过**（真实 BrowserWindow）；清单 lookup/apply/module/repository/driver 与 `scanHandlers` 远程 SCAN_RUN 取消均通过
  - 全量 Electron：`JAVDEX_TEST_TIMEOUT_MS=900000 node scripts/run-electron-tests.mjs` **3057 tests / 3056 pass / 0 fail / 1 skip**（`2dd1e54` 工作树；本轮未重跑全量）
  - `npm run server:smoke` **EXIT 0**（本会话 Docker Engine 28.5.2；见上条单容器证据）
  - `npm run server:smoke:migration`：本轮新增 Docker 两端迁库烟测（源/目标各 `dataDir`+`imagesDir` 卷；CLI `migrate-auth`；manage HTTP preview/start/PUT/enable；两端 `migration.status`；目标正式图文件与源冻结备份）。运行证据见本轮提交后的验证记录；未通过前不得记为 EXIT 0。
  - 未跑安装包
- 产品已锁定并落地（本轮）：`setRating` 递增 V；enable 拷图失败整笔回滚；远程 `migrateCatalog` 能力放开并走原 HTTP migration；源端加密图在迁库导出时自动解密。已接受且本版不扩合同的限制见 [SERVER_MODE.md](SERVER_MODE.md) C1–C7。E2 已改为解锁第一版发布路径（S14 剩余门闩通过后可升 0.8 / 写 CHANGELOG / 准备合并 main）；本轮仍不升版本、不写 CHANGELOG、不合并 main。单容器 `server:smoke` 已通过（#107），不是安装包。
- 未做：同版本桌面安装包烟测；远程 FILE_RENAME（C1）；D04 物理掐断 TCP/WAN 后再重连；D05 任务进行中的完整 GUI 关窗产品流；完整 M01–M15 / D01–D07。不得把 mock 当完成证据。不得宣称 S13/S14 或 M/D 矩阵已全部完成。

S13 验收矩阵（核心项；“部分”表示有真实证据但未覆盖该编号的全部安排）：

| 编号 | 状态 | 证据 | 环境 | 剩余 |
|---|---|---|---|---|
| M01 管理范围 | 部分 | S08 `runtime.test.ts` 隐藏/归档管理可见、网页不可见，Cookie 不能调 manage | Linux Node 22.14 in-process 宿主 | 独立演员/清单/待确认图/无成员影片未在同一用例一次铺齐 |
| M02 字段边界 | 部分 | S08 拒绝桌面路径、未知字段、外库 sample id | 同上 | 手动导入逃逸相对路径的独立注入仍薄 |
| M03 编辑冲突 | 部分 | S05/S08 `expectedVersions` 冲突拒绝与回执；`setRating` 递增 V，评分后用评分前 V 改标题得 `VERSION_CONFLICT`；S09 首次扫描与 XML NFO 都不 bump V，随后用该 V 改 ABC-001 标题成功 | Linux Node 22.14 in-process 宿主 `runtime.test.ts`；本地 `localCatalogBackend.test.ts` | 扫描/NFO 是否纳入 V 仍按既有语义 |
| M04 关联竞争 | 部分 | S09 删除预览/计划过期；S10 预览 deleteGlobal 后加入清单或新增媒体库成员再提交旧 digest 得 409，影片仍在 | 同上 | 预览后只改资源集合但不改成员的独立注入未再单列 |
| M05 受理边界 | 部分 | S06 上传/apply/重启；S09 任务入队 | 同上 | 短事务提交前断响应的断电级注入未做 |
| M06 接管竞争 | 部分 | S05/S09 交接等待挡住新扫描 | 同上 | 旧请求暂停于 I/O 再领取的完整时序未做 |
| M07 批量部分结果 | 部分 | S10 目标列表冻结 | 同上 | 三目标过期/成功/断线分页拼接未做 |
| M08 真挂载卸载 | 部分 | S09 标记 vs 卸载 | 同上 | 枚举后/每批清理前真实卸载未做 |
| M09 预览与停服 | 部分 | S09 NFO 计划与关浏览 | 同上 | 过期后再提交、停网页后管理仍可用已有部分证据 |
| M10 桌面隔离 | 部分 | 远程 start 采集/助手概览/裁切快照/清单导入，以及 matching ingest 与 applyImport，chmod 000 后 `/proc` 无 `library.db`；`8fc3d9a` 对真实 Node 宿主 ingest+apply 建清单 | Electron-as-Node isolation + `dualBackendScan.e2e.test.ts` | 刮削单条仍可走本地队列；无冻结 `video_sources`；apply 不写 per-video links |
| M11 分页与目标清单 | 部分 | S10 `targetLists`；limit=1 取第一页后插入新片或删除已冻结 id，offset=1 与完整 page 仍是冻结快照 | Node 宿主 `runtime.test.ts` | UI 对已删除冻结 id 的占位展示未再铺 |
| M12 迁移语义 | 部分 | S12 转换 + S13 首次真实扫描保留无资源成员 | Electron-as-Node `catalogMigrationAcceptance` | STRM 规范化冲突的 HTTP 两端用例未再跑 |
| M13 启用取消竞争 | 部分 | 两进程并发 enable/abandon；启用后两端重启；丢弃 enable/abandon 响应后再重启；256k tmpfs `ENOSPC` / `chmod 000` `EACCES` 后 enable 回滚 `ready`；Docker 两端成功 enable 路径见 `server:smoke:migration` | `migrationHosts.e2e.test.ts` 3 例；`catalogMigration.test.ts`；`scripts/server-migration-smoke.mjs` | 竞态/回滚仍非 Docker；安装包未做 |
| M14 图片与恢复 | 部分 | 源端导出自动解密到包（源正式图不变）；缺别名 start 失败并解冻；正式封面随迁；孤立 uploads 不进包且恢复删除；拷图 `EACCES`/`ENOSPC` 后 enable 回滚 | Electron-as-Node `catalogMigration.test.ts` | 目标仍拒绝包内残留密文 |
| M15 播放 | 部分 | S11 HTTP Range + S13 真实 mpv：断流后续播、过期 404、seek 2.2、MKV、handoff 后 404 | 本机 `/usr/bin/mpv` 0.37.0；ffmpeg 6.1.1 | 非环回 WAN 丢包未做 |
| D01 启动隔离 | 部分 | S07 远程不 `getDb()`；断线/版本不符/缺凭据/已连接 available 及 M10 六探针子进程 `/proc/<pid>/fd` 均无 `library.db`，且 `chmod 000` 后仍能启动 | `createDesktopRuntime.isolation.test.ts` | 刮削单条队列仍可 `getDb()` |
| D02 业务合同 | 部分 | LocalCatalogBackend 与 RemoteCatalogBackend 对同一夹具扫描/NFO 计划，并在扫描后读取 audit header/page/view 与 IPC 形状 `pendingAuditPresence`；同用例含 live HTTP 任务重连与远程清单 apply | `dualBackendScan.e2e.test.ts`（独立 `node --test` 进程） | 非 Electron IPC NFO 封面编码；非 Docker |
| D03 工作存储升级 | 部分 | 复制已写入但未 `markReady` 时远程拒绝补开原库；OS `SIGKILL` 落在 `copying` 窗内，源行保留，回本地才 `markReady` | `createDesktopRuntime.test.ts`；`createDesktopRuntime.isolation.test.ts` | 复制 SQL 事务中途杀进程的更窄窗口未再铺 |
| D04 迟到响应 | 部分 | S07 generation 丢弃迟到查询；中止的图片 GET 不写入磁盘缓存；`waitForCatalogTask` 拒绝旧 generation/revision/progressSeq 与终态回绕，并中止本地 SCAN/NFO 等待；`8fc3d9a` 真实 Node `tasks.get` HTTP 完成后 reconnect，迟到快照不应用；`cb13f72` 已受理的 in-flight `tasks.get` 在 reconnect 时中止，3s 内完成 | 远程后端 + `catalogTaskProgress.test.ts` + `scanHandlers.test.ts` + `dualBackendScan.e2e.test.ts` | 物理掐断 TCP/WAN 后再重连未做 |
| D05 取消与退出 | 部分 | S07 dispose/abort；`createWindow` 不注册 IPC；远程 runtime 重建不打开 `library.db`；重建窗口只重绑 binders；`6be92a7` 原生 Electron 关闭后再建 `BrowserWindow`，新 webContents 绑定一次且 IPC handle 不加倍 | Electron-as-Node bootstrap + `mainWindowBindings.test.ts` + `mainWindowBindings.native.test.ts` | 任务进行中的完整 GUI 关窗产品流未做 |
| D06 边界检查 | 部分 | pretest 生产依赖图；FILE_IMPORT / pending resolve+get/list/queue/presence / SCAN_AUDIT GET+HEADER+远程 PAGE/VIEW 走 CatalogBackend | 仓库脚本 + `scanHandlers.test.ts` | 远程 FILE_RENAME 仍拒绝；冻结 queuePage 无 IPC anchor；冻结 auditPage 无 section/attention；冻结 presence 仍是目录级计数 |
| D07 能力与错误 | 部分 | 本地/远程各会话态能力原因已枚举；远程 available/frozen 允许 `migrateCatalog` | `desktopCapabilities.test.ts` | UI 全动作未再铺；迁库调用仍需 CLI migration Bearer |

### S14：发布准备与收尾

补充服务端适用的 ADR，明确与 0024/0027 的扩展边界；保留本地原合同。更新开发、用户、迁移、部署、恢复及版本发布文档，不把实施细节堆到 README。根和所有 workspace 使用统一版本，桌面产物/服务镜像/Web 来自同一源码版本。

说明 setup、UID/GID、存储要求、绑定/恢复命令、更新时序、版本不符、旧库冻结备份及恢复限制。发布前真实安装包与镜像烟测，完成用户要求的评审流程；本文件本身不授权自动公开发布。

**S14 实施记录（进行中）**

- 范围：[ADR-0029](adr/0029-server-mode-extends-root-and-web-isolation.md) 写明服务端扩展 ADR-0024/0027、本机原合同不变、Cookie 不能授权 manage/play/管理图片。操作页 [SERVER_MODE.md](SERVER_MODE.md) 写 dataDir/imagesDir/挂载、UID、`start|bind|recover|migrate-auth`、源端导出自动解密、enable 拷图失败回滚，以及 C1–C7 已知限制。E2 已解锁第一版发布路径，仍须 S14 剩余门闩（含安装包烟测与 CHANGELOG）通过后才升 0.8 / 准备合并 main。单容器 `server:smoke` 已通过（#107）；Docker 两端迁库见 S13 `server:smoke:migration`。[USER_GUIDE.md](USER_GUIDE.md) 增加“资料库连接”入口。[DEVELOPMENT.md](DEVELOPMENT.md) 索引改为实施中而非“可行性未实施”。[VERSIONING_AND_RELEASE.md](VERSIONING_AND_RELEASE.md) 增加桌面/服务/网页同版本约束。
- 验证：文档提交；`npm run server:build` 写出 `out/server`（version `0.7.0`，依赖仅 better-sqlite3/sharp，无 electron import）；`npm run test:packaging` **8 通过**（先前记录）；后续 Docker-in-Docker 会话 `server:smoke` **EXIT 0**（单容器 bind+claim+restart，见 S13）。`server:smoke:node` 仍只是宿主进程检查。
- 未做：同版本桌面安装包 + 服务镜像真实安装与图片烟测；CHANGELOG 发布条目（当前仍为 0.7.0）；自动公开发布（本文件不授权）。S13 剩余矩阵见上一节。不得宣称 S13/S14 完成。

## 接手环境与验证命令

普通新检出（在仓库根目录）：

```powershell
npm ci
npm run setup:desktop
npm run check:workspaces
npm run typecheck
npm run pretest
npm run build
npm run test:packaging
$env:JAVDEX_TEST_TIMEOUT_MS = '900000'
node scripts/run-electron-tests.mjs
```

特定领域测试用移动后的真实路径，例如 `node scripts/run-electron-tests.mjs packages/library/src/db/migrationsV16.test.ts`；后续 S02 移动该文件时更新命令。S04 建立的 server 命令须写入根 scripts 并在 Docker/CI 实际运行后才可作为完成依据。

当前工作区的 `node_modules` 是指向 `D:/Project/JavdexLabs/Javdex/node_modules` 的已有 junction。本次没有在其目标执行安装或重建；只更新仓库 lockfile。接手不要在这个共享依赖目录上运行会破坏其它任务的重建；需要独立依赖时使用新的真实检出。不要复制 Electron node_modules 到容器。

## 每个阶段的交付格式

必须包含：阶段编号和实际完成范围、涉及的用例/文件、schema 是否变化、验证命令及结果、失败/未覆盖项、下一阶段前提。维护本文件的阶段状态和验收矩阵，不能只写“已完成”。如果上下文中断，下一位 Agent 先检查工作树和阶段记录，不重复撤回已确认实现，也不把历史撤回实验当当前代码。

可以直接交给下一位 Agent 的提示：

> 请实施 `docs/SERVER_MODE_EXECUTION_PLAN.md`，以远程交接分支及指定交接提交为起点，创建实施分支。先核对 S00 和已有检查结果，从 S01 开始按依赖阶段推进，包含 S02 后的必需阶段 S02D（桌面本地后端重构）；允许修改代码、测试和文档，简单技术细节自主决定。产品取舍遵守主方案和已确认事项，遇到冲突问我。不得省略阶段或把研究探针通过当正式产品验收；最终覆盖 M01–M15 及 D01–D07，每阶段记录证据，完整范围完成前不要宣称第一版完成。
