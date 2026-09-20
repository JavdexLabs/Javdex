# 架构优化方案：共享用例、合同与工作存储

状态：实施中，P1–P3 已落地并完成定向验证，P0 存储核对仍在推进；P4/P5 未完成。日期：2026-09-20。重构前代码基线：`dd13789`。

本方案来自本次架构评估中用户明确选定的三项，目标是在不删减业务能力的前提下，减少本地/远程行为漂移、重复合同映射及隐式数据库路由。它是仓库内的实施设计，不替代 GitHub Issue/PRD；本次未创建外部工单。后续“执行架构优化方案”目标已启动；实施证据和未完成项见第 11 节。

## 1. 范围与不变条件

| 纳入本次优化 | 预期结果 |
|---|---|
| 本地/远程共享业务实现 | 同一用例只有一个业务编排所有者；宿主只处理授权、传输与环境资源 |
| 合同权威定义与真实往返验证 | 共享业务字段不再多处手写；复杂 DTO 的实际返回可验证 |
| 工作数据库显式依赖 | 保留旧记录迁移，移除运行时 SQL 改写与数据库方法替换 |

必须保持：

- 本地 SQLite 与远程管理 HTTP 两种模式，以及重启生效的模式切换。
- 远程模式不得打开本机权威 `library.db`，失败不得回退本地写入。
- 浏览 Cookie 与管理凭据分离；renderer 不接触长期凭据或可执行的服务器绝对路径。
- 现有版本检查、持久回执、目标快照、候选确认、图片交付与安全取消语义。
- 本地和远程现有功能差异仍显式保留，例如清单导入的本地追加/自动建片能力与远程限制；不能用“统一实现”削减本地能力或扩大远程权限。
- Agent 运行、草稿、审批、工具记录、正常恢复与现有冷恢复能力不因存储重构减少。
- 现有支持的数据库升级路径、影片 ID、资料、图片及工作记录不丢失。

不纳入：通用命令框架、依赖注入容器、全量代码生成、强制本地走 HTTP、全仓目录重排、版本升级、发布和合并操作。已有服务端验收是基线，不自动证明重构后的行为。

## 2. 问题与实施入口

| 问题 | 当前证据 | 主要入口 |
|---|---|---|
| 同一用例在两个宿主重复组织 | 演员本地编辑直调维护逻辑；HTTP 另行组织版本校验、图片应用及结果 | [本地后端](../apps/desktop/src/main/backends/local/localCatalogBackend.ts)、[服务端处理器](../apps/server/src/manageCatalogHandlers.ts) |
| 查询投影维护在宿主 | 本地 `videoQueryService` 与服务端 `projectRemoteVideoDetail` 各自构造展示 DTO；此前远程缺 `display_locator` 已实际触发崩溃 | [本地查询](../apps/desktop/src/main/services/videoQueryService.ts)、[服务端处理器](../apps/server/src/manageCatalogHandlers.ts) |
| 合同映射多且运行时验证有限 | HTTP 输入已有 schema 推导，但桌面扩展、结果映射与分派仍手工维护；复杂 HTTP 返回最终经过类型断言 | [输入映射](../apps/desktop/src/main/application/catalogOperationInputs.ts)、[结果映射](../apps/desktop/src/main/application/catalogOperationResults.ts)、[远程结果适配](../apps/desktop/src/main/backends/remote/catalogRemoteResults.ts) |
| 工作表路由隐式 | `prepare/exec` 被替换，SQL 中表名按全局前缀正则改写为 `work.*` | [工作记录迁移](../apps/desktop/src/main/desktop/agentWorkCopy.ts)、[宿主状态](../packages/library/src/runtime/host.ts) |
| 两类存储存在应用流程耦合 | 草稿读取、正式资料写入与草稿完成记录在同一流程中出现，不能机械替换连接 | [草稿应用](../packages/library/src/catalog/catalogAgentMetadata.ts)、[草稿仓储](../packages/library/src/db/agentMetadataDraftRepo.ts)、[桌面草稿流程](../apps/desktop/src/main/services/agentMetadata/draftService.ts) |

## 3. 目标结构

```text
renderer → IPC 宿主适配 → CatalogBackend
                         ├─ 本地适配 → 共享业务用例 → catalog 数据库/资产存储
                         └─ HTTP 客户端 → Node 授权/传输适配 → 同一共享业务用例

桌面 composition root
  ├─ catalog：仅本地模式打开；远程模式使用 CatalogBackend
  └─ workStore：工作记录、Agent 运行与桌面草稿模块显式使用
```

共享用例放在 `packages/library`，业务 DTO/schema 放在 `packages/contracts`。共享包不得反向依赖 `apps/desktop`；Electron 文件选择、安全存储、用户交互和 Node HTTP 鉴权继续留在宿主。

“共享”不要求两端传输包络完全相同，也不要求抹平功能差异。规范化输入、领域规则、结果投影应共享；路径解析、权限和传输封装分别负责。

## 4. 轨道 A：共享业务用例

### A1. 先统一影片详情投影

1. 提取一个纯详情投影 Module，统一主资源时长、资源展示字段、空值及结果结构。
2. 宿主提供已经处理的定位展示数据或有限的定位格式化函数。本地允许显示本机路径；远程仍只显示挂载内相对路径或文件名，并遮蔽外链敏感部分。
3. 本地查询及 HTTP `videos.get` 均调用同一投影；继续单独通过资源 ID/定位摘要签发播放凭据，不把展示路径当执行路径。
4. 将两个宿主的重复字段拼装删除，而不是保留旧实现再加一层包装。

验收：同一夹具两端 DTO 字段一致，允许的差异仅为明确的路径展示策略；覆盖本地文件、STRM、外链、无资源、无媒体库归属、多资源及主资源时长。远程不能泄漏原始定位/身份字段。

### A2. 再统一演员编辑

1. 以现有维护逻辑为基础抽取具体的演员编辑用例，集中身份规则、版本处理、资料写入、正式图片应用与结果构造。
2. 本地文件与远程上传引用先在宿主侧转为受控资源输入；不能让共享用例根据 `mode` 猜测路径来自哪里。
3. Node 宿主保留 writer 认证和 HTTP 输入校验；本地宿主保留本地调用准备。业务版本检查只保留一处，事务和回执的所有者须明确，避免嵌套重复提交/重复增版本。
4. 先记录现有 IPC 哪些调用没有显式版本，再设计向后兼容的内部接线；不得仅把远程必填字段搬到本地，导致原有编辑流程失效，也不得静默删去远程版本保护。

验收：普通编辑、身份冲突、陈旧版本、替换/清除头像、图片应用失败、重复 operationId 和结果包络均有对应测试；正常编辑的 revision 只递增一次。

### A3. 最后整理清单导入的最终应用

1. 浏览、Agent 证据、页面枚举与暂存仍归桌面导入流程；正式 catalog 写入归共享用例。
2. 对照 [导入 Repository](../apps/desktop/src/main/services/playlistImport/playlistImportRepository.ts)、[远程应用桥接](../apps/desktop/src/main/services/playlistImport/playlistImportCatalogApply.ts) 与 [共享应用](../packages/library/src/catalog/catalogPlaylistImport.ts)，列出本地新建/追加、自动建片、已有影片复用、相关链接和远程限制矩阵。
3. 优先统一两端共同支持的“已有影片创建新清单”提交路径，再把本地特有步骤放进明确的用例分支；权限由宿主提供的固定能力决定，不能信任 renderer 自报能力。
4. 保留原子应用、顺序去重、过期匹配检查和回执重试。不要让 Repository 同时拥有第二条正式 catalog 写入路径。

验收：共同路径两端产物一致；本地追加/自动建片仍可用，远程仍按既有限制拒绝；重复提交不新建第二份清单，失败不留下半份清单。

## 5. 轨道 B：合同权威定义与往返测试

### B1. 随每个用例整理合同，不先重写全量协议

- 复用已有 `MANAGE_OPERATION_INPUTS` 与 `z.input/z.output` 推导，明确默认值应用前的传输输入和应用后的业务输入。
- 将 A1–A3 的纯业务 DTO、字段 schema、错误和结果定义集中到 contracts；涉及数据库或宿主实现的类型先投影为纯 DTO，不把 library 类型依赖带进 contracts。
- 桌面路径、临时文件 handle、HTTP 上传引用、writer 包络仍分别定义；这些是真实差异，不应通过一个充满可选字段的大类型混在一起。
- `CatalogOperationResults` 只映射权威结果类型；IPC 返回的 boolean/ID 兼容形状仍由最外层适配。HTTP 内部需要 receipt/version 时不为了 IPC 简洁丢弃它们。
- 每个迁移用例同步删去旧重复定义，列明临时兼容入口及其剩余调用者。完成后不保留新旧两份权威字段表。

### B2. 验证真实 JSON，而不只验证 TypeScript

对影片详情、演员详情/编辑结果、清单详情/分页这几组新增或共用结果 schema：

1. 服务端分派结果必须静态满足权威结果类型；远程客户端在 JSON 入口执行相应运行时解析，不用类型断言代替验证。
2. 保持现有错误映射策略；缺字段或错误类型应形成可诊断的失败，不能伪造成功或随意补空字符串掩盖问题。
3. 有限展示层兼容必须显式记录，例如可选字段的默认值；不顺带承诺跨版本客户端兼容。
4. 暂不覆盖每一个简单标量操作，也不新增通用 schema 编译器或生成器。

核心测试链：`真实 HTTP → JSON → RemoteCatalogBackend → 公共业务结果`，与本地后端相同夹具结果比较。覆盖筛选/排序、分页、日期/空值、缺字段、错误类型和版本冲突；路径脱敏差异单独断言。新增字段必须能被这条测试链观察到。

## 6. 轨道 C：显式工作存储

### C1. 先做存储归属清单和提交关系核对

以 `AGENT_WORK_TABLES` 为初始清单，逐项记录读取者、写入者、事务连接、图片目录及清理责任；同时查找未通过该常量访问的草稿/TEMP 表。区分：

- 桌面 Agent 运行、日志、审批、工具记录、草稿与临时导入状态。
- 正式 catalog 资料、版本和操作回执。
- 已有 Node 管理入口实际读取的草稿数据：先查清它与桌面草稿的关系，不因表名相同就移动或删表。

交付是一张调用者与存储归属表，以及现有跨存储写入顺序的测试。迁移前必须覆盖本地与远程，不凭“工作表都在 workStore”假设直接改连接。

### C2. 显式注入已有具体仓储

- 从 `createDesktopRuntime` / composition root 将 `workStore.database` 或具体仓储传给 Agent 运行与草稿模块。
- 利用 `AgentRunStore`、`AgentMetadataDraftRepo` 已有的构造器接缝，不另建数据库抽象框架。
- 去掉桌面工作记录路径隐式回退 `getDb()` 的依赖；测试也提供明确的隔离工作库。
- 资料库 Module 不应为了读取桌面工作记录而修改其数据库实例行为。
- 共享草稿底层存储若有多个真实宿主，保持显式连接实例，不通过进程全局前缀选择归属。

### C3. 保留一次性迁移，收掉运行时兼容

- 保留旧库到工作库的复制、`copying/ready` 状态和失败重试；迁移完成前不得误入远程模式。
- 复制中断可重试；已进入正常运行的目标工作库不得被旧源记录反向覆盖。首次复制与正常启动必须有明确分界。
- 校验关键 ID、记录内容、外键关系及加密内容可读取，不只核对行数。
- 仅一次性迁移阶段可以显式使用 `ATTACH`。正常运行删除 `wrapCatalogSqlForAgentPrefix`、`qualifyAgentSql`、全局前缀及 `prepare/exec` 替换。
- 不在同一改动删除用户旧源数据，不为删除兼容层擅改已发布 schema 历史；是否需要新的工作库 schema 版本，依据 C1 结果决定。

### C4. 不把两个独立提交误称为原子事务

正式资料写入与桌面草稿完成状态必须有明确的中断恢复策略。优先复用现有 operationId/持久回执：

1. 桌面先保存本次应用对应的稳定 operationId、目标 catalog 身份和不可变提交内容关联。
2. 共享用例提交正式资料、版本及 catalog 回执。
3. 桌面依据已确认回执标记草稿完成，再执行可重试的暂存资源清理。
4. 若第 2 步后进程退出，第 3 步重启后通过同一 operationId 查询回执；不重新生成操作号、不重复应用元数据。
5. 回执未知、拒绝、服务不可达分别按既有恢复语义处理；不能一律标记成功，也不能提前删除恢复所需图片。

这是待落地验证的具体提交设计，不是对当前跨库事务能力的声明。SQLite WAL 下不能仅凭 `ATTACH` 宣称跨数据库掉电原子性。若现有调用存在必须同库原子提交的额外不变量，先在 C1 定位并调整用例，不能为移除改写器牺牲正确性，也不引入通用分布式事务框架。

## 7. 分阶段交付顺序

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| P0 | 记录 A1–A3 行为矩阵、C1 存储归属；补关键特征测试 | 正常路径与两端差异均有可运行证据；跨库不变量明确 |
| P1 | A1 + 对应 B1/B2：详情投影和复杂 DTO 往返 | 两端共用投影；真实文件远程详情/播放不回归；重复字段定义删除 |
| P2 | A2 + 对应 B1/B2：演员编辑共享用例 | 本地/HTTP 共用业务编排；版本、图片和错误矩阵通过 |
| P3 | A3 + 对应 B1/B2：清单正式应用 | 保留能力差异；公共提交路径唯一；原子性及幂等通过 |
| P4 | C2–C4：显式仓储、迁移及恢复 | 正常运行无 SQL 改写；旧记录迁移与中断恢复通过 |
| P5 | 集成、删除剩余临时兼容、更新实现文档 | 原行为矩阵完整通过，边界检查和代表性 GUI 验证通过 |

每阶段独立可审查、可验证；不同时重写所有操作。C1 的调查可以提前，但连接切换不得先于对应草稿提交/恢复测试。单纯把旧实现换成同名转发函数不算阶段完成。

## 8. 验收矩阵与执行环境

| 范围 | 必须验证 |
|---|---|
| 业务一致性 | 同一夹具的本地/远程共同结果；明确保留的能力差异；身份冲突和权限拒绝 |
| 合同 | 真实 HTTP 往返、字段缺失/错误类型拒绝、筛选排序透传、无路径/凭据泄漏 |
| 编辑与图片 | 陈旧版本拒绝、单次增版本、图片失败不留下错误正式引用、重复提交复用回执 |
| 工作库迁移 | 无旧库、待复制、复制中断、复制重试、ready 后不覆盖新记录、损坏拒绝 |
| 隔离 | 远程不打开本机 catalog；重启和模式切换后工作记录仍从指定工作库读取 |
| 草稿应用 | catalog 提交前失败、提交后工作状态写入前退出、状态完成后清理失败、断线后查回执、重复恢复 |
| 功能回归 | 编辑/合并相关入口、清单本地追加及远程创建、Agent 草稿应用/丢弃、运行恢复/审批记录 |

优先扩展现有测试入口：`videoQueryService.test.ts`、`localCatalogBackend.test.ts`、`apps/server/src/runtime.test.ts`、`catalogPlaylistImport.test.ts`、`createDesktopRuntime.test.ts`、`createDesktopRuntime.isolation.test.ts`、`agentRunStore.test.ts`、`agentMetadataDraftRepo.test.ts` 与桌面草稿测试。新增测试名和位置在实施阶段按真实接缝确定，不用读取源码字符串来代替行为验证。

阶段内运行受影响的定向测试；最终运行根目录 `npm run typecheck`、`npm run pretest`、`npm run server:test` 及受影响的 Electron 测试集，构建桌面/Web/Node。Node 与 Electron 的 better-sqlite3 ABI 准备必须串行或使用独立目录，不能在同一 node_modules 并发 rebuild。需要桌面原生测试时先 `npm run setup:desktop`；服务端只使用 Node ABI。Linux GUI 使用可运行的显示/密钥环环境。

集成验收采用本次已确认的平台：macOS arm64 与 Linux arm64；真实 Node HTTP 与本地 Docker 验证共享逻辑、图片和中断恢复，桌面 GUI 验证关键入口。只有影响打包、启动或存储迁移时才追加相关安装/升级复测；不能用构建或旧日志替代新改动的验证。

## 9. 回退与完成判定

- P1–P3 保持外部合同兼容，可按独立变更回退代码；不保留永久的运行时新旧分支开关。
- P4 操作真实数据前保留隔离备份，并用相同来源副本验证迁移。若引入新工作库格式，只允许明确支持的回退路径；不能直接让旧程序打开不兼容文件。
- 数据恢复依赖实际回执和记录校验，不通过降低 schema 版本或盲目重复制解决。
- 完成时更新 [服务端实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)、[开发指南](DEVELOPMENT.md) 及受影响的存储/Agent 文档。若提交顺序或恢复语义改变了已有 ADR 承诺，补充或修订相应 ADR 后再宣称完成。
- 量化记录迁移用例数、删除的重复投影/编排、剩余兼容入口和测试结果；不预设删行比例，不以文件数量减少代替正确性。
- 各阶段按实际证据更新状态；不得将方案或旧验收记录当作实施完成。本方案未授权发布、推送或合并操作。

## 10. 其他建议：保留待定

下列事项不随本方案执行，也不是本方案完成的门槛：

- 缩减清单导入能力（匹配已有影片、取消自动建片/动态滚动等）。
- 缩减演员名称冲突处理选项。
- 取消 Agent 历史冷恢复或精简模型配置概念。
- 将应用内迁库改成单向运维工具。
- 将插件开发移到外部编辑器或 Agent。
- 改变全局影片身份、多媒体库共享资料及资源归属模型。
- 全面拆分大型页面/Repository，或清理与本次三点无关的所有转发文件。

这些建议需要单独评估产品价值和兼容成本，未经新的范围决定不得借本次重构实施。

## 11. 实施记录（2026-09-20）

### 行为基线与当前差异

| 用例 | 本地 | 远程 | 本次保留或收拢的规则 |
|---|---|---|---|
| 影片详情 | 显示本机资源路径；本地读取无写入 | 只显示挂载内相对路径/文件名 | 共用主资源时长、外链遮蔽和展示 DTO；原始 locator/resource_key/source_identity 不进入详情 |
| 演员编辑 | 旧 IPC 仅传 ID/fields；头像含本地文件、base64、裁剪包 | HTTP 要求 A 版本；头像为上传/清除引用 | 不强迫旧 IPC 补版本；显式提供的陈旧版本仍应拒绝；头像传输形式分离 |
| 清单正式应用 | 新建/追加，匹配复用、自动建片、跨库归属、来源/详情链接 | 新建清单、已有影片、最多 200 个 ID | 不削减本地能力、不放宽远程权限；最终正式写入应只有一个业务所有者 |

演员的 `trg_actresses_revision_after_update` 会为未显式修改 revision 的 UPDATE 增版本。重构前资料与头像独立更新；P2 已将编辑中的资料和准备好的头像收拢到一次 UPDATE，仍由触发器增版本，未额外 bump。清单本地 `PlaylistImportRepository.apply` 与远程 `catalogPlaylistImport` 已共同调用 `playlistImportWrite`；浏览证据、匹配预览与任务统计仍由桌面流程负责。

### 工作存储归属核对（C1，连接切换尚未执行）

| 表/状态 | 当前所有者与调用者 | 拆连接必须保留的关系 |
|---|---|---|
| `agent_runs`、`agent_resource_cleanup` | `AgentRunStore`；运行状态、清理队列 | 运行恢复和待清理记录均从指定 workStore 读取；清理失败可重试 |
| `agent_operations`、`agent_product_journal` | `AgentRunStore`；操作及产品事件 | 操作顺序、幂等 ID 与运行归属不能因迁移改变 |
| `agent_execution_history`、`agent_tool_ledger` | `AgentRunStore`；执行/工具历史 | 正常恢复、冷恢复与加密历史内容仍可读 |
| `agent_approvals`、`agent_artifacts` | `AgentRunStore`；审批/产物 | ID 和外键关系与运行记录一并保留 |
| `agent_metadata_drafts`、`agent_metadata_draft_resources` | `AgentMetadataDraftRepo`；桌面草稿、共享 `catalogAgentMetadata` 应用/丢弃 | catalog 写入与 workStore 完成标记分成可恢复步骤；不能把 Node 当前草稿入口误删 |
| 清单导入 TEMP 表 | `PlaylistImportRepository`；浏览证据、计划、结果 | 当前本地 TEMP 状态与正式写入同事务，远程经 operationId 桥接；拆开后须补稳定提交及恢复语义 |
| 正式资料、aggregate version、`catalog_operation_receipts` | catalog | 回执与正式资料同库提交，workStore 不成为权威资料库 |

还发现四类跨存储读写，必须在 P4 接线时同时处理，不能只替换两个仓储构造参数：

- `videoLifecycleRepo` 的删除预览包含 Agent 草稿/资源，硬删除还删除关联草稿；预览过期检查和草稿清理不能失效。
- `videoPendingScrapeService`、`actressIdentityConflictWorkflow` 的图片清理同时查询待确认资源与就绪草稿资源，防止误删仍被草稿使用的图片。
- `catalogImageRefs` 扫描草稿资源引用，迁库正式图片清单与垃圾回收需明确区分当前 catalog 草稿和桌面工作资源。
- `catalogMigrationApply` 清理目的 catalog 的旧 Agent 表；它不能通过隐式 SQL 路由误删正在使用的桌面 workStore。

迁移状态仍采用 copying/ready；现有复制仅核对行数，内容/外键/加密校验及 ready 后不覆盖的强化验证留在 P4。此表记录已查到的调用关系，不宣称跨库原子性或连接改造已完成。

### P1：影片详情投影与合同

已落地：

- 新增 `packages/library/src/catalog/videoDetailProjection.ts`，删除本地与服务端重复拼装；宿主只提供资源路径展示策略。
- `packages/contracts/src/catalogDetailSchemas.ts` 成为影片详情及依赖记录的字段权威定义，现有导出类型从 schema 推导；旧 import 路径保留类型别名，未保留第二份字段表。
- `ScopedStoredVideoDetail` 移至 contracts，Repo 仅兼容转导出。
- `catalogRemoteResult` 对 `videos.get` 的实际 JSON 解析；缺必填字段、错误类型和详情资源中泄漏的原始字段明确拒绝，错误仅报告字段位置。现有 optional 字段不新增默认值。
- 演员详情及编辑结果已在 P2 接入运行时 schema；清单详情及导入结果在 P3 接入，其余标量操作维持已有转换。

验证证据：

- Electron 定向集（详情、远程结果适配、HTTP 合同）：13 项通过，无跳过。
- Linux Node `runtime.test.ts`：31 项通过，无跳过。新增测试使用真实服务端 JSON，经 `RemoteCatalogBackend` 与本地投影比较；代理分别删除字段、改错类型、注入原始路径，客户端全部拒绝。
- 上述测试同时覆盖相对路径、主资源时长、null、隐藏/无归属详情、重连隔离；既有定向测试保留外链和 STRM 脱敏、无资源、多资源、元数据时长优先级。
- 根 `npm run typecheck` 和独立服务端 TypeScript 检查通过；定向 ESLint 通过。

### P2：演员编辑与详情合同

已落地：

- `catalogActressEdit.ts` 统一版本保护、图片准备、资料写入及持久回执；本地、HTTP 均调用该用例，删除 HTTP 独立编排、不再使用的 `commitImage` 包装及维护服务的旧编辑转发入口。
- 图片资源先准备，资料与头像引用在同一条演员 UPDATE 中写入；保留触发器的单次 revision 递增。媒体文件变更协调覆盖整个回执事务，失败恢复旧图片。
- 本地旧 IPC 可继续不传 A，但显式传入的陈旧 A 必须拒绝；HTTP 仍要求 A。重复 operationId 返回原回执，HTTP 原请求摘要形状保持不变。
- `actressEditContract.ts` 集中资料编辑字段及结果定义；管理 schema 扩展上传引用，本地类型扩展路径/base64/裁剪包。修正 CatalogBackend 的编辑类型只接受本地图像输入的问题，两个宿主各自准备受控图片输入。
- 演员详情、metadata、profile 共用 contracts schema；远程解析实际 JSON；编辑结果先验证 A 版本再适配为旧 IPC boolean。

验证证据：

- Electron 演员仓储、图像应用、本地后端、远程合同及新增编辑用例组成的初始回归集 120 项通过；随后新增上传失败回滚、结果版本验证和本地适配器重放测试，定向集分别 12 项、5 项通过。
- 真实 Linux Node runtime 集 32 项通过。新增 HTTP 上传头像并编辑资料、重复提交、日期/null、演员详情三种读取与本地结果比较、陈旧版本拒绝及清除头像；每次编辑只增一次 revision。
- 故障测试确认名称冲突和无效图片不改变旧资料/旧图片、不产生成功回执；上传后的身份冲突保留可重试上传。
- 根类型检查、独立服务端类型检查、全仓 pretest 及新增测试 lint 通过。这些是阶段检查，尚不代替 P5 的构建、平台 GUI 与迁移验收。

### P3：清单正式应用与分页合同

已落地：

- `playlistImportWrite.ts` 是清单导入正式写入的共同所有者：新建/追加清单、新建/复用影片、目标归属、相关链接、成员顺序及去重均在同一事务内完成。
- 删除桌面 Repository 和远程用例重复的正式 SQL 编排。桌面保留匹配快照校验、来源证据、任务统计及 TEMP 完成标记；远程保留版本、上传和权限要求。桌面现有原子事务与幂等键、远程持久回执均保留。
- 明确保留归属差异：本地复用保留已有媒体库归属；远程导入确保加入指定媒体库。策略由宿主固定提供，不在 HTTP 输入中开放。远程仍只允许新建清单、已有影片，且拒绝重复 ID 与超限数组。
- `playlistImportCommit.ts` 集中共享提交输入及 HTTP 导入结果；`catalogPlaylistImport` 输入从现有管理 schema 推导，桌面结果映射不再手写第二份导入结果字段。
- `playlistSchemas.ts` 集中详情、metadata、列表/影片分页的字段；远程 JSON 入口执行校验。真实往返发现旧类型遗漏 `generation/revision`，已补入权威合同以保留实际返回的版本。

验证证据：

- 清单 Repository、Module、RunDriver、共享写入、管理应用及远程合同的回归集 94 项通过；远程结果负例定向集 7 项通过，无跳过。
- 新增共享写入测试覆盖顺序去重、明确的归属差异、本地追加/自动建片/链接去重，以及后续条目失败时清单、影片、归属、链接全部回滚。既有 Repository 测试继续覆盖过期预览及重复提交。
- Linux Node runtime 集 33 项通过，无跳过。清单详情、排序、筛选、分页、日期/null 与本地读取一致；真实远程导入、重复操作号、版本冲突和重复 ID 拒绝通过。
- 根类型检查、独立服务端类型检查、定向 lint 与全仓 pretest 通过。

未完成：P0 的跨存储提交失败特征测试、P4 显式工作库及恢复、P5 全量集成与平台 GUI/升级验证。既有平台验收不算本次重构验收。
