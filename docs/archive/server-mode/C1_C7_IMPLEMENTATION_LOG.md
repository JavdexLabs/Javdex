# C1–C7 阶段实现与架构收敛记录

> 历史归档：截至 2026-09-17 的原推进计划及实施记录。条目中的旧限制可能已由后文修正；现状以 [当前状态](../../SERVER_MODE_NEXT_STEPS.md) 和 [实现与合同](../../SERVER_MODE_CONTRACT_INVENTORY.md) 为准。

更新时间：2026-09-17。当前分析基线：`main` / `origin/main` 的 `7675404`（0.7.0）；服务端分支 HEAD 为 `3d860cb`，本轮优化在其现有工作区改动之上进行。

本文件是当前阶段的工作入口；[原执行计划](SERVER_MODE_EXECUTION_PLAN.md) 保留 S00–S14 历史要求与证据，[部署说明](../../SERVER_MODE.md) 记录当前产品行为。用户已在本轮逐项确认：C1–C7 全部补齐，C6 包括单条及批量刮削；此次决定覆盖历史“接受限制、不扩合同”的记录。当前交付是可执行计划；T0–T7 已完成（阶段性实现完成，不是 S13/S14）。

## 本阶段范围

### 0.7.0 基线后的架构收敛

业务取舍结论记录在 [Issue #113](https://github.com/JavdexLabs/Javdex/issues/113)。2026-09-17 用户批准并实施：① writer 忙时拒绝并重试；② 离线包迁库与人工切换替代双宿主协同。用户明确决定③ 重命名与重发现拆分、④ 批量目标延后读取版本不做，不再作为后续待办：保留改名后重新识别和批量启动时冻结版本的现有行为。四项取舍均已决策完毕。运行模式切换已经要求重启，不重复安排。

取舍落地：移除交接持久排队及其对扫描/NFO/文件维护的阻挡；忙时不消耗令牌。迁库移除 `migration.allowEnable`，状态收敛为本端 `role` / `phase`；启用目标须 `confirmSourceStopped: true`，恢复源须 `confirmTargetStopped: true`。保留空目标校验、正式图片/解密/映射、导入回滚和源冻结备份。完整操作说明见 [部署与迁库](../../SERVER_MODE.md)。

两项取舍验证：37 项相关常规测试通过（31 项合同/交接/空目标/旧状态/迁入首次扫描测试，加 6 项按名称筛选的迁库功能测试）。包含关闭源数据库后的 local→server / server→local 离线导入，无伪造本地 serverId；Node 与 renderer/browser 类型、改动文件 lint、library/server/desktop 边界及服务端依赖闭包检查通过。既有故障测试仅同步新合同，没有执行；未做完整 GUI、安装、发布验收。

本轮实施四项不改变 C1–C7 范围的优化：

1. `CatalogBackend` 使用按操作索引的输入/输出合同，明确桌面专用参数；远程适配器负责 wire 返回值归一化，共用方法表覆盖未配置后端。
2. `catalogVideoCommands` 和 `catalogScrapeCommands` 集中影片常见写入、刮削提交/替换/确认的版本校验、事务及回执，两种宿主只传执行上下文和投影结果。尚无版本参数的旧本地 IPC 保留兼容；已提供版本必须校验，远程不放宽。
3. 桌面候选刮削流程共享编排，保留本地资料处理与远程图片上传/正式提交的必要差异；单条、批量仍走既有任务与检查点语义。
4. `executeCatalogFileMaintenance` 负责文件维护的执行、版本与 journal/回执收尾；宿主不再分别编排 rename/import 生命周期。

验证限于类型、静态边界、相关定向功能测试。完整 GUI、安装/发布及故障注入仍不在本阶段内。

2026-09-17 本轮验证：Node、renderer/browser 类型检查、TypeScript lint、library/server/desktop/metadata-source 边界及服务端生产依赖闭包检查通过；13 个相关测试文件组合运行共 75 项通过，另有 1 项 HTTP 适配集成测试通过，覆盖强类型合同、远程结果适配与本机路径隔离、候选编排、双宿主写入回执、文件维护及相关 IPC/C1–C7 回归。不据此宣称完整远程 GUI 或发布验收完成。

推进顺序：**P0 逐项确认 C1–C7 → P1 核对实现缺口 → P2 补齐确认的功能并交接。**

用户明确本阶段不做：

- 全面自动化验收与完整 GUI 验收，不推进 M01–M15 / D01–D07 全矩阵关闭。
- 跨平台安装、打包与部署验收。
- 0.8 发布候选、版本升级、CHANGELOG 发布条目及发布操作。
- 故障测试，包括进程崩溃、磁盘错误、断电、挂载卸载、断网/丢包和恢复故障注入；不安排已有故障测试重跑。

此前拟定的 P3–P6 从当前推进链中移除，未来是否安排由用户另行决定。它们不是本阶段完成条件；暂不做不等于通过，S13/S14 仍未完成。本阶段不请求安装机器、签名材料或故障实验环境。

后续功能改动只做与改动直接相关的常规检查（例如类型、静态边界和必要定向功能检查），不扩展成全量自动化、GUI、安装或故障验收。当前整理计划只检查文档差异和链接。

## 当前实现概况

| 原阶段 | 当前状态 | 本阶段处理 |
|---|---|---|
| S00–S01 | 结构已准备、合同已冻结 | 核对需要扩展的合同，不重做结构迁移 |
| S02/S02D | 主要业务已抽离、双后端已接线，仍有单例和桌面特有入口 | 核对保留入口与共享业务边界 |
| S03–S06 | HTTP、Node/Docker、writer/幂等/版本、图片交割已实现 | 保持现有实现，处理与本阶段功能直接相关的缺口 |
| S07–S11 | 远程会话、管理、扫描维护、部分桌面工具、图片与播放已实现 | 按 C1–C7 新决定补功能 |
| S12 | 双向迁库与图片解密/恢复已实现 | 可核对代码语义，不安排故障或整库验收 |
| S13 | 验收矩阵尚未闭合 | 本阶段不推进 |
| S14 | 部分文档与 Linux 产物有历史记录 | 本阶段不推进发布与安装 |

前一轮核对已通过 workspace、library、HTTP、server 和 desktop 架构边界检查。历史 Docker、迁库、故障、mpv、Linux 安装烟测仅留作原计划中的证据，不因此触发本阶段重跑或宣称当前代码已验收。

## P0：逐项重新确认 C1–C7

状态：已完成。2026-09-14 用户逐项确认全部补齐。

| 编号 | 当前限制/行为 | 本轮需决定 | 状态 |
|---|---|---|---|
| C1 | 远程不能重命名服务端影片文件；现有 IPC 缺资源标识 | 补齐远程文件重命名 | 已确认 |
| C2 | 远程待确认扫描队列缺 anchor，不能按指定条目定位队列页 | 补齐按指定条目定位 | 已确认 |
| C3 | 远程按媒体库/影片计算待确认状态依赖多次组合查询，冻结接口仅目录级计数 | 增加按媒体库和影片 ID 的精确查询接口 | 已确认 |
| C4 | 远程审计分页不支持 section/attention 条件 | 补齐远程审计筛选 | 已确认 |
| C5 | 无细粒度 video_sources 查询，远程匹配来源可为空 | 补齐远程来源查询与匹配 | 已确认 |
| C6 | 当前记录为普通刮削仅支持本地模式 | 补齐单条和批量刮削 | 已确认 |
| C7 | 远程清单导入不写每部影片的 video_links | 补齐影片关联链接写入 | 已确认 |

C6 已包含批量，实施清单包含冻结目标 targetListId、分页、已删除项占位及逐项提交结果；不以三个独立编辑请求代替批量刮削接线。

所有远程刮削选项均保持“桌面运行插件/Playwright 和采集，服务端持有正式资料并接收应用”，不新增服务器执行刮削器。C3 将由服务端直接返回指定媒体库和影片的待确认状态，替换远程适配器现有的组合查询。

上述决定已同步 SERVER_MODE.md。功能实现前仍按当前代码报告不支持/受限，不提前将 capability 标为可用。

## P1：核对并形成实现清单

依赖：P0 已完成。产出直接维护在本文件，不另建完整验收矩阵。

1. 对用户选定的功能，列出实际 UI/IPC、CatalogBackend、本地/远程适配、HTTP schema 和 library 业务入口，区分缺接口、缺实现、缺接线。
2. 核对共享合同的改动范围及本地兼容方式；合同冻结记录不能阻止用户此次明确要求的扩展，但未经确认不扩大功能。
3. 核对远程不支持入口是否在触及本地权威库前明确拒绝，UI 原因是否准确。保留限制不等于允许绕到本地库。
4. 核对两个已有文档语义疑点：扫描/NFO 真正改资料后的旧版本拒绝，以及迁库源解冻是否依据目标持久放弃。这里只做代码/已有证据检查，不执行故障测试；发现问题记录具体影响和实现修复建议。
5. 按依赖拆小实施单元，列清楚变更文件、完成行为和必要的定向常规检查。纯粹缺验收证据的项记录为后续，不自动转换成本阶段测试任务。

完成条件：每个选定功能都有具体实现任务；排除项有明确决定；没有把暂缓的验收、安装或发布重新夹带进功能任务。

## P2：补齐确认的功能

依赖：P0/P1 完成，用户要求开始实施后执行。按共享合同 → library/HTTP → 远程适配 → 桌面入口/提示的依赖顺序推进。

- 同一共享合同由一个负责人协调，桌面与服务端按不共享文件的任务并行。
- 选定支持的功能通过 CatalogBackend 访问权威资料；保留限制的入口明确拒绝并说明原因。
- 保持版本冲突、持久 operationId、writer 隔离及图片应用的一致性；不以功能补齐为由绕开已有业务保护。
- 只运行与本次改动直接相关的常规检查，不运行上文暂缓的完整验收与故障测试。
- 每项交接记录实现结果、变更文件、实际检查与未验证部分，同步当前产品行为文档。

完成条件：本轮确认要做的功能实现完成，保留的限制准确记录，常规定向检查结果可查。结果称为“阶段性实现完成”，不称 S13/S14 完成或可发布。

## 交接记录

当前已完成：旧计划过时入口修正、当前阶段范围调整、C1–C7 逐项确认、首轮入口核对与实施单元拆分、T0–T7。此阶段不自动合并 main，不宣称 S13/S14 完成。

## 已确认的实施单元与依赖

顺序为 T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7。T2 与 T3 在各自合同确定后可以并行。

| 单元 | 对应范围 | 实现内容与入口 | 完成行为 | 状态 |
|---|---|---|---|---|
| T0 合同整理 | C1–C7 | 核对 `packages/contracts/src/manage/`、`application/catalogBackend.ts` 及本地/远程后端；逐单元补 DTO、输入 schema、版本依赖、错误和能力定义，并更新合同清点 | 明确每项缺口，字段贯穿调用链；不要求先完成全部合同才做简单功能 | 已完成 |
| T1 精确查询与分页 | C2/C3/C4 | `manageCatalogRemainder.ts` 的 queuePage/presence、`manageCatalogMaintenance.ts` 的 auditPage、`remoteCatalogBackend.ts`、`ipc/scanHandlers.ts`；复用 library 的队列定位与审计读取 | 指定条目定位有效；按媒体库/影片 IDs 返回真实状态；section/attention 不再被剥离；空页及失效锚点沿用本地语义 | 已完成 |
| T2 远程文件重命名 | C1 | 复用已有 `files.rename`/library 维护实现，补桌面资源标识及服务端生成预览/指纹的路径，接入现有文件操作入口 | 用户可重命名服务端资源；预览与提交均基于服务端活文件、资源版本及根保护，桌面不访问服务端绝对路径 | 已完成 |
| T3 来源查询与匹配 | C5 | 增加受限、可分页的来源查询；接入 `playlistImportCatalogLookup.ts` 和相关采集匹配端口 | 匹配使用服务端真实来源信息，不以空 sources 代替、不回查本地 library.db；区别来源缺失与查询失败 | 已完成 |
| T4 清单关联链接 | C7，依赖 T3 | 扩展 `playlists.applyImport`、`manageCatalogScrape.ts`、`catalogPlaylistImport.ts`、`playlistImportCatalogApply.ts` | 按本地已有语义写影片关联链接，与清单应用共同保持事务/幂等；URL 校验及去重不退化，不顺带扩大自动建片/append 等其它范围 | 已完成 |
| T5 单条远程刮削 | C6，依赖 T3 | 核对 `ipc/scrapeHandlers.ts`、`scrapeJobController.ts`、应用工作流与后端 apply；覆盖现有影片/演员入口 | 桌面采集与选择 → 服务端图片暂存 → 带原版本提交；支持候选与待确认处理，工作记录按 catalog 隔离；正式资料不写本地库 | 已完成 |
| T6 批量远程刮削 | C6，依赖 T5 | 扩展已有 targetLists 的实际目标选择与分页合同，接入现有批次 start/进度/取消；复用既有冻结槽位组件 | 启动时冻结选中/筛选目标，后新增目标不混入；删除项占位；成功、冲突、待确认及结果待核实分项准确；取消采集不伪称已受理提交撤销 | 已完成 |
| T7 阶段交接 | 全部 | 按实现结果同步本计划、SERVER_MODE、合同清点与相关操作说明，清理已失效的限制描述 | C1–C7 每项列清实现文件、常规定向检查和未验证范围；只报告阶段实现结果 | 已完成 |

实施前在相关文件中继续核对已有本地语义；简单接口/模块选择自主决定。仅遇到删除行为、权限、来源匹配规则或其它用户可见语义需要改变时，再就具体取舍询问用户。T1–T7 不引入全量验收、故障注入、跨平台安装或发布任务。

## 实施记录

### T0 合同

实现：`packages/contracts/src/manage/` 与 `ipcDisposition.ts`。检查：`packages/contracts/src/manage/schemas.test.ts`、`packages/contracts/src/inventory/ipcDisposition.test.ts`。未验证：桌面/服务端接线。

### T1 精确查询与分页（C2/C3/C4）

实现：服务端 `pendingScan.queuePage`/`pendingAudit.presence`/`pendingVideoScrapes.existingIds|page`/`scans.auditPage` 转发锚点与筛选；远程适配器不再剥离 `anchor`/`section`/`attention`，presence 改为精确查询；`PENDING_VIDEO_SCRAPE_EXISTING_IDS` 走 catalog backend。

检查：`apps/server/src/manageCatalogC1C7.test.ts`（queue 定位、presence 精确集合、scrape ids、无快照时 audit 保留 section）；既有 `scanHandlers.test.ts` 路由断言。未验证：真实扫描审计快照筛选、GUI 待确认队列跳转。

### T2 远程文件重命名（C1）

实现：`previewRenameCatalogFile` / 可选 `resourceId` 的 `files.rename`；远程 IPC 先 preview 再提交，拒绝绝对路径，不打开本地根目录。

检查：`catalogFileMaintenance.test.ts`、`manageCatalogC1C7.test.ts` T2、`scanHandlers.test.ts` 远程 rename 路由。未验证：真实挂载上的 renameAndImport 端到端、GUI 文件操作。

### T3 来源查询与匹配（C5）

实现：`listCatalogVideoSources`、`videos.sources`、catalog `listVideoSources`；清单 ingest 用该查询填 sources，并在详情 checkpoint 时 ingest source identity。空 items 为未匹配；非法 payload 当查询失败。

检查：`catalogVideoSources.test.ts`、`playlistImportCatalogLookup.test.ts`、`manageCatalogC1C7.test.ts` T3。未验证：真实采集站点详情匹配、GUI 清单导入。

### T4 清单关联链接（C7）

实现：`appendRelatedLinks` + `playlists.applyImport.videoLinks`；远程 apply 在 `save_detail_links` 时带上每条详情 URL；重复 URL INSERT OR IGNORE。

检查：`catalogPlaylistImport.test.ts`、catalog apply 测试断言 videoLinks。未验证：完整远程清单导入 GUI。

### T5 单条远程刮削（C6）

实现：桌面 `collectVideoScrape`/`collectActressScrape` 只采集；远程路径经 `catalogRemoteScrape` 用 catalog `videos.get`/`actresses.get` 取正式资料，上传图片后 `applyScrapeCandidate`；业务身份/名称冲突改为 `pendingVideoScrapes.replace`/`actressConflicts.submit`。服务端 apply 在消费上传前检查冲突并要求影片待确认 Q；演员待确认 Q 仅在提供时校验。工作记录仍在桌面 `desktop-work.db`。远程 `fillEmpty` 按详情 DTO 近似，头像以路径存在视为已填。批量目标解析仍走本地库，见 T6。

检查：`catalogScrapeApply.test.ts`、`manageCatalogC1C7.test.ts` T5、`catalogRemoteScrape.test.ts`、`scrapeCatalogBinding.test.ts`、`scrapeJobController.test.ts`。未验证：真实插件/Playwright 远程采集、GUI 刮削、待确认确认后的端到端图片交割。

### T6 批量远程刮削（C6）

实现：`targetLists.create` 支持 ids / videoFilter / actressFilter（互斥）；digest 对 ids 与筛选载荷哈希，命名 kind 仍按评估结果哈希。分页返回 `entries`（含已删除占位）。远程批次 start/count 经 catalog 冻结目标，不再 `listVideosForBatchScrape` / 本地 membership。已选 ID 超过 200 拒绝。取消只停桌面采集。count 会留下 `catalog_settings` 中的 target-list 孤儿记录。

检查：`catalogTargetLists.test.ts`、`catalogRemoteBatch.test.ts`、`manageCatalogC1C7.test.ts` T6、`checkpointedSequentialBatchQueue.test.ts` 异步 resolve、`videoBatchScrapeQueue.test.ts`。未验证：真实远程批量 GUI、FrozenTargetSlot 窗口与刮削进度联调、取消后的部分提交现场。

### T7 阶段交接

实现：同步本计划、`SERVER_MODE.md` C1–C7 产品行为、合同清点扩展说明、`USER_GUIDE.md` 远程刮削操作句。不升版本、不写 CHANGELOG、不合并 main。

检查：定向类型/边界/功能测试见 T0–T6 各节。未验证：全面自动化/GUI 验收、故障测试、跨平台安装、0.8 RC。S13/S14 仍未完成。

### C6 收尾修正（2026-09-14，本地工作树）

- 保留已删除的冻结目标及其标签，进入原有逐项失败结果与队列总数，不在构建队列时过滤。
- 新增只读 `targetLists.count`，与创建列表共用筛选/摘要校验但不写 catalog_settings；既有历史目标记录未删除。
- 新增 `scrape.fields`，在权威宿主复用本地字段判断，替换远程 DTO 近似及“任意来源存在就跳过”的错误判断；头像检查沿用实际可用图片判断。
- 远程影片批次生成说明文字不再调用本地 getMediaLibrary；媒体库显示采用已有编号回退。
- 修复 scrapeBrowser 的 SVG outerHTML 类型声明兼容问题，保持浏览器中的原 HTML 序列化行为。
- 修正既有 rename 测试的 macOS 临时目录别名夹具，以真实根路径写入资源定位。
- 验证：主进程/服务端类型、workspace/desktop/server/library 边界检查通过；相关定向测试 35 项通过，0 失败、0 跳过（7 个文件，Electron-as-Node；包含新增只读计数、权威字段判断、删除目标保留及合同检查）。未运行全面自动化、GUI、故障、安装或发布流程。上述旧 T5/T6 记录中的 DTO 近似、计数孤立记录及过滤行为已由此修正。
