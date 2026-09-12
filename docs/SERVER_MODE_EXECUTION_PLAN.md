# 服务端模式执行与 Agent 交接计划

> 状态：S00 结构准备已实施；S01 合同已冻结（见 [合同清点](SERVER_MODE_CONTRACT_INVENTORY.md)）。桌面架构重构及服务端产品功能待实施。用户本轮要求将桌面架构并入计划，本轮仅更新文档。此文件是本次用户要求的本地执行交接材料，不替代 GitHub Issues 中的正式 PRD/任务记录，也不代表已发布工单。
>
> 起点：远程分支 `origin/codex/server-mode-feasibility` 中包含本文件及 S00 结构调整的交接提交。原研究代码基线为 `cac9f6982eaef6afc34f86f9a51486f8ff10dd2b`，不能从该旧基线直接开工。接手先 fetch 并核对交接提交，再从该提交建立实施分支；具体提交哈希随交接提示提供。

## 给接手 Agent 的执行指令

执行本文件 S01–S14（包括新增必需阶段 S02D），先核对 S00 的现状与验证记录。用户已确定产品边界并准备交由其他 Agent 实施；不要把之前“方案研究期间不得改代码”误解为用户发起实施任务后仍禁止开发。仅在用户将本文件交给你并要求执行时开始实施，单纯阅读或讨论不构成实施授权。

简单工程问题自主决定并记录；涉及删除/迁移语义、权限、功能范围或与已确认选择冲突时，说明具体取舍让用户决定。不能为赶进度省略回迁、待确认保护、图片恢复或文件维护。单阶段完成不等于第一版完成。遇到真实阻塞报告证据和剩余工作，不用 mock Electron、内存数据库或模拟播放器掩盖失败。

先读根 `AGENTS.md`、`CONTEXT.md`、[主方案](SERVER_MODE_FEASIBILITY_RESEARCH.md)、[管理合同与验收](SERVER_MODE_API_RESEARCH.md)。按正在修改的领域读取现有 ADR 和相应 UI/插件文档，不要求通读所有 docs。主方案“已撤回实验”只提供历史证据，不存在可直接依赖的 V17 上传实现；原数据库当前仍为 schema 16。

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
| `packages/library` | 已移入 Node 路径/根/资源身份工具、catalog SQLite、图片存储、公网图片 HTTP、扫描辅助与编排、扫描审计读取、分类查询/维护/主图、演员查询/冲突/图库/维护、标签查询、清单维护、影片维护/生命周期、本地根护栏、NFO 编解码/导出资料与 sidecar 票据 | Electron 封面导出、刮削应用、catalog 查询 worker 入口仍待抽离 |
| `packages/ui` | 现有 Checkbox 与 CSS，桌面/Web 已引用 | 不预先扩大共享 UI 范围 |
| `packages/http` | 私有 workspace 和职责说明 | HTTP 源码尚未抽离，无可运行入口 |
| `apps/server` | 私有 workspace 和职责说明 | 服务启动、构建、Docker 均未实施，无占位成功脚本 |

根 `package.json` 暂保留桌面打包 metadata 和已有运行依赖，产物仍为 `out/main`、`out/preload`、`out/renderer`、`out/web`。workspace 脚本通过根命令执行，避免 cwd 改变破坏 worker/图片/打包资源位置。根安装不再隐式 Electron rebuild；桌面环境显式运行 `npm run setup:desktop`。根仍有 Electron 开发依赖，不能把整份根安装作为独立服务端生产安装。

`npm run check:workspaces` 检查版本一致和网页/共享模块边界；它不声称已验证独立服务器。现有边界、类型、测试发现、构建配置与研究探针已适配目录。后续移动用例时继续更新脚本和可点击文档链接，禁止保留第二份旧源码或用目录链接模拟迁移。

## 实施状态

| 阶段 | 状态 | 记录 |
|---|---|---|
| S00 | 已完成（交接提交 `f706402`） | [结构准备验证记录](SERVER_MODE_STRUCTURE_VALIDATION.md) |
| S01 | 合同已冻结 | [合同清点](SERVER_MODE_CONTRACT_INVENTORY.md)。282 项 IPC 均有去向；管理用例均有 Zod schema。验证：`npx tsx --test packages/contracts/src/inventory/ipcDisposition.test.ts packages/contracts/src/manage/schemas.test.ts packages/contracts/src/browser/dto.test.ts`（13 通过）；`npm run typecheck`；`npm run check:workspaces`。未实现业务、未改 schema 16、未接线 IPC。剩余：S02D 替换字符串 IPC 错误；管理结果 DTO 在接入后端时从现有领域类型投影 |
| S02 | 进行中（library 已含 db、图片、公网图片 HTTP、扫描编排、扫描审计读取、分类查询/维护/主图、演员查询/冲突/图库/维护、标签查询、清单维护、影片维护/生命周期、NFO、维护闸门与路径清理） | schema 16。`getDb()` 单例仍保留。剩余：Electron NFO 封面导出、刮削应用、catalog 查询 worker 入口仍在 desktop；S02D 未开始 |
| S03–S14 | 未开始 | 含必需阶段 S02D |

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
- 验证：`npm run typecheck:node`；library / actress / classification / media-asset / workspace 边界通过。相关测试 233 项全部通过（host、public HTTP、分类主图、演员维护/冲突、影片维护/生命周期、链接探测、无资源清理、facet IPC、scanner）。
- 未做：Electron NFO 封面导出、刮削应用（metadata-sources）、catalog 查询 worker 入口、`videoQueryService`、`mediaLibraryService` 的刮削插件检查、待确认资源身份（本地 NFO）仍在 desktop；S02D 未开始。

### S02D：先完成桌面本地后端重构

依 S01 的端口把 IPC 的本地调用搬到 application 和 LocalCatalogBackend，以 S02 的 library 工厂替代业务 singleton。先迁移查询、普通编辑和图片，再迁移预览/任务，最后逐个处理 Agent/采集工作流的依赖注入。保留现有 UI 页面和清晰的业务入口，不一次性重命名整个 preload API。

完成独立桌面设置/workStore 的升级准备、轻量 bootstrap、local 运行时生命周期、media/播放器能力接口。只建立 remote 工厂接口与未配置状态，不伪装服务端已经存在；测试未选择 local 时不访问它。S05 才实现的版本/回执字段须预留正确合同，不能用固定 revision 或随机伪 serverId 糊弄本地行为；真正的业务版本由 library 在相应阶段持久实现。

交付边界检查和 D01–D03/D06 可在本地完成的部分，完整原业务测试与构建通过后才进入 S03。不能为了提前宣布全合同完成而跳过 S05/S07 的真实远程验证。此阶段不新增远程产品功能，也不改已经确认的本地根保护、图片加密、播放器和只读网页行为。

### S03：抽离 HTTP，保持本地网页

从 `apps/desktop/src/main/web` 拆出纯 HTTP、认证存储、浏览 DTO 和静态文件服务到 `packages/http`；桌面的 webAccess 生命周期和本机设置适配留桌面。禁止 http 导入 desktop 或 server 入口；只依赖 contracts、library 的公开接口与标准 Node 能力。

浏览和管理路由注册分别启用，本地模式不因复用模块而新增管理网络面。分别投影图片范围，维持 Host/Origin/配对/Range 等现有防护。公开访问 authority 与容器监听地址分开传入，不默认相信代理头或任何私网 Host。

验收：原网页测试和网页构建通过；真实纯 Node 可加载 HTTP 与查询 worker，不能使用 Electron stub。基线研究探针原本预期 MODULE_NOT_FOUND；此阶段完成后更新其断言与文档，保留“修复前/后”的明确证据。

### S04：独立 Node 运行和 Linux 镜像

在 `apps/server` 新增真实入口、构建配置、生产依赖清单、Dockerfile 与部署示例；从 root 运行依赖中明确分离服务器所需闭包。必须证明服务器的生产安装不包含 Electron、插件运行时、Playwright；使用 Linux Node 的原生包，不复用桌面 node_modules 或 Electron rebuild。

先以 Linux amd64/glibc、Node 22 建立验证目标；其它架构不先宣称支持。SQLite 所在 `/data` 要求本地文件系统，图片位于数据卷，媒体通过单独挂载；UID/GID、权限、磁盘空间、数据目录单实例占用必须检查。允许挂载目录来自部署配置，禁止管理员在 UI 输入任意宿主路径绕过边界。

启动按配置校验 → 数据库升级/恢复 → 任务恢复 → HTTP 就绪执行；升级失败不报告 ready。SIGTERM 后停止新写入、收敛任务、关闭 worker/HTTP/数据库。提供不泄露资料的 live/ready 状态。首次未认主不允许资料浏览。

新增根级 `server:build`、`server:test`、`server:smoke` 明确命令，失败返回非零。容器 smoke 使用临时卷、真实 SQLite/WAL、图片、worker、HTTP、Range、会话与重启持久化；不能只有 /health 通过。

### S05：身份、写入版本、认主与安全重试

依主方案实现 serverId/catalogId/epoch 生命周期、版本一致握手、候选凭据预保存领取流程和一次性部署命令。网页授权与 writer 分离；领取、终态记录和 epoch 切换原子化。安全凭据存储不可用时不退回普通设置文件。

在当前真实 schema 之后新增经过审查的迁移；不得照搬已撤回实验的 V17，也不能覆盖基线对历史开发 V17/18 的拒绝判断。测试从官方升级基线、schema 16 与新建空库产生相同结构，失败事务回滚、禁止降级。

实现操作编号/摘要持久回执、聚合版本、正式入队边界；最终提交再次校验 epoch。先贯通影片编辑，再推广。事务内先鉴权和查旧回执，再判断 revision，保证成功重试不被自身版本改变拒绝。查询回执仍需当前授权。回执生命周期、批量部分结果及错误恢复按管理合同执行。

同步让 LocalCatalogBackend 使用 library 中真实的业务 revision 与提交结果；不可长期保留“本地忽略 expectedRevision”的旁路。本地无需远程 writer 协议，业务冲突与图片原子提交语义仍应一致。S02D 中仅定义、尚无持久实现的合同项必须在本阶段补齐，再进行双后端一致性验证。

### S06：图片上传、提交和恢复

上传参数只允许用途/内容，不允许落盘路径；流式限制字节、格式、像素与解码预算，服务器计算摘要并绑定身份/epoch。上传记录先于文件写入持久化；完成上传不等于业务受理。

正式资源引用、上传 consumed 状态和短操作回执同数据库事务；文件写入、替换、旧图清理有持久恢复记录。恢复器可重复运行，不能删除任何正式引用图片，待确认图片有独立引用保护。覆盖封面、样张、头像源/裁切/图库、分类与清单图片，不只实现封面示例。

未引用上传初值 24 小时过期；按服务器时间回收、受理中的消费须防止与 GC 竞争，正式待确认不按普通上传 TTL 清理。上传写入中断必须释放文件句柄、磁盘空间和并发占用。注入写文件前/后、引用提交前/后、旧图删除前/后的进程退出；分清进程退出测试和断电验证。

### S07：接入远程后端与最小闭环

在 S02D 的装配和端口基础上实现 RemoteCatalogBackend，映射 S01 的 manage 合同，接入 S05 的身份/认证/回执和 S06 的图片交割。模式选择、IPC 用例和 LocalCatalogBackend 应已存在，不在本阶段另建一套远程页面、通用 IPC 代理或有全局可变模式的 service locator。禁止 renderer 持有 writer token 或直接请求任意服务器地址。

实现 DesktopSession、版本/身份失败页、模式切换重启、generation 与缓存隔离、最小结果核实日志和旧请求取消。复用 S02D 的独立 workStore；不得在 remote 构造/重连/恢复过程中补开旧业务库。remote 自己处理协议身份和认证，页面只提供业务目标、原版本和用户选择。远程错误不自动本地回退；模式切换前处理未保存编辑、活跃桌面工作和结果不明提交。

验收门槛：管理隐藏/归档对象可见、网页不可见；影片编辑和封面上传可保存；丢响应后不重复；切回本地仍能打开原库。完成 D01–D07 的最小真实双后端闭环，未覆盖的大批次/维护细节在 S09/S10 补全并最终在 S13 验收。监测本地数据库和后台任务，证明远程模式没有偷偷打开原库。

### S08：完整管理功能

按 S01 清单逐组实现：影片资料/评分/标签、资源与成员、演员及冲突、机构/导演/系列、分类图片、清单及有序成员、所有待确认、媒体库/配置/根管理、网页配对设备管理。复用同一领域规则与 schema，不编写第二套影片身份判定。

预览完整记录关联依赖，删除/合并执行前检测新增引用；外部图片先桌面采集，路径输入替换为受控资产/根定位。根目录重绑、桌面 reveal、远程图片加密/数据目录在线搬迁按明确范围禁用，附合适原因，不留下能失败或误操作的按钮。

每组提供本地/远程相同业务结果测试和管理/网页权限差异测试。清单矩阵逐行标记实现位置、测试位置、限制；没有对应证据的行不得标完成。

### S09：挂载、扫描、NFO 与持久维护任务

实现 `.javdex-root` 初始化状态和可读检查；标记必须在实际挂载内。扫描开始、每次结果提交和每批缺失清理复核；取消/失败保留已提交批次及真实审计。符号链接、普通文件、打开后描述符、父目录写入检查继续存在。

任务持久状态至少区分排队、执行、取消请求、成功、失败、已取消、需要检查。取消请求不直接标已取消；只在安全边界确认。扫描重启可新建一次重新枚举，不伪造原扫描续跑成功；文件维护恢复须逐项核对而不自动从头执行。

计划保存/失效/释放资源，10 分钟超时和重启后失效；交接等待阻止新维护穿越。NFO、重命名、删除复用文件能力保护；只读挂载允许读取扫描、不允许维护写入。真实测试挂载卸载与普通文件缺失分别测试，不能仅用删除标记模拟全部挂载语义。

### S10：桌面采集、Agent 和批次

插件、浏览器、模型密钥、头像计算保持桌面；只读资料库助手通过固定管理查询工具，网络资料采集与清单导入使用目标查询、候选选择及服务器应用接口。不得让 Agent 工具直接访问服务器 SQL 或沿用原本地业务 singleton。

复用 S02D 建立的 application/workflows 协调流程，只注入当前后端和桌面能力；不要按 local/remote 复制两份刮削或导入控制器。工作记录、候选图片和进度标明所属上下文与执行端，窗口重建只恢复订阅，不重新启动已有任务。新增工作流依赖也纳入 D06 边界检查。

批次开始取得固定目标及原始版本，采集结束提交仍使用该版本；不能悄悄刷新 revision 来绕过冲突。每项独立操作编号，暂停/取消停止新的桌面工作；已受理服务器提交继续并查询结果。桌面退出后不承诺未上传候选自动续传；只保存隔离的工作记录。

头像裁切回传来源版本/摘要，过期结果不得覆盖新图片。清单最终应用保持身份与有序成员的原子边界。每项错误、未开始及不确定数量明确；依赖项不得当作独立批次继续。

### S11：管理图片与真实播放

实现 media 主进程代理管理图片、临时缓存、版本化引用、旧 catalog 请求取消。正式/独立/待确认图片依授权范围获取；失败显示占位，不持久同步远程图片库。

播放器设置程序路径，参数数组启动，禁止 shell 拼接。资源专用 token 只允许目标 HEAD/GET/Range，12 小时固定期限；到期/接管/资源定位改变后拒绝新请求并按主方案关闭旧流。普通标题修改不终止播放；外部直链直接交播放器，不带 Javdex 凭据。

以具体 mpv 二进制和测试媒体验收首播、拖动、暂停后续播、短断线、服务重启、撤销/过期。记录真实播放结果而不是只断言 HTTP 状态或进程启动。失败必须修复或请求用户作出兼容范围取舍，不能默默取消远程播放。

### S12：双向整库迁移

按主方案第 7–9 节实现持久迁移协议、空目标独占、预检/冻结/快照/暂存校验/启用或放弃。版本、待确认、结果不明操作、活动任务、加密存量、磁盘空间和目标授权先校验，冻结后重算影响；结果变化回预览。

建立逐表/逐资产转换清单：正式对象、成员、资源键、源身份、STRM 来源、主资源、根、设置、权威图片、审计、任务历史、凭据/操作记录。禁止全库路径字符串替换。快照考虑 WAL 和图片同一冻结窗口。

按根可选映射；无映射删除目标本地资源、STRM 转普通链接且冲突阻塞、取消目标根配置、受影响库关闭无资源自动清理。映射错误不能降级成不映射；Windows 路径按源平台解析，目标重建身份并检验大小写/别名冲突。待确认不导入，未识别/扫描活跃快照不跨端执行。

数据包 manifest 至少含格式/应用/schema 版本、源平台与身份、migrationId、数据/图片数量和摘要、映射摘要；验证 ZIP/归档路径逃逸、符号链接、重复条目、大小上限及解包空间。凭据不进入包。

源端持久“允许启用”后才发许可；目标同一个持久决策点选择 active 或 abandoned。只有目标永久 abandoned 才允许源解冻；删除暂存文件不删除终态。断网、迟到许可、两端重启、启用响应丢失全部有验收。启用新 catalog 和重置授权后，源端保留冻结备份；回迁从当前目标重新执行。

### S13：完整验收

执行管理研究 M01–M15 及本文件 D01–D07，所有核心阶段做 Linux Node 与桌面本地回归；已确认范围不得通过跳过用例获得绿灯。增加真实 Docker 两端状态/文件检查、目标启用与取消竞态、数据库磁盘不足、读写权限变化、文件操作恢复核对。测试必须有足够空间、隔离数据，不能使用用户真实媒体库做破坏性故障注入。

证明服务端依赖图与镜像生产安装没有 Electron/Playwright/Agent 运行时，网页包没有 Node/数据库代码；打包后的 worker、图片、网页路径可用。只验证源码 tsx 不能替代正式镜像和安装包验证。

输出验收矩阵，每项记录 commit、环境、步骤、预期/实际、日志与未覆盖部分。已知基线编码检查问题需单独记录，不能通过全局关闭检查解决。失败但未修复的核心条目意味着计划尚未完成。

### S14：发布准备与收尾

补充服务端适用的 ADR，明确与 0024/0027 的扩展边界；保留本地原合同。更新开发、用户、迁移、部署、恢复及版本发布文档，不把实施细节堆到 README。根和所有 workspace 使用统一版本，桌面产物/服务镜像/Web 来自同一源码版本。

说明 setup、UID/GID、存储要求、绑定/恢复命令、更新时序、版本不符、旧库冻结备份及恢复限制。发布前真实安装包与镜像烟测，完成用户要求的评审流程；本文件本身不授权自动公开发布。

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
