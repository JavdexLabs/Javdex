# 服务端实现与合同

核对基线：2026-09-19，`76a871e` / workspace `0.7.1`。本页集中维护当前架构、功能接线及合同导航；部署步骤见 [操作说明](SERVER_MODE.md)，进度与验证边界见 [当前状态](SERVER_MODE_NEXT_STEPS.md)。

权威实现是 TypeScript，而不是本文件：

- IPC 去向：[`packages/contracts/src/inventory/ipcDisposition.ts`](../packages/contracts/src/inventory/ipcDisposition.ts)
- 管理用例元数据：[`packages/contracts/src/manage/operations.ts`](../packages/contracts/src/manage/operations.ts)
- 管理输入 schema：[`packages/contracts/src/manage/inputs.ts`](../packages/contracts/src/manage/inputs.ts)
- 桌面端口：[`apps/desktop/src/main/application/catalogBackend.ts`](../apps/desktop/src/main/application/catalogBackend.ts)

字段级请求以输入 schema 为准，权限、版本依赖和完成边界以 operations 为准；不手工复制完整端点表。原 S01 清点及研究背景保留在 [历史归档](archive/server-mode/README.md)。

## 工程默认（可实测后调整，不得静默截断）

限额来源：[protocol/limits.ts](../packages/contracts/src/protocol/limits.ts)。

| 限额 | 值 |
|---|---|
| JSON 请求 | 1 MiB UTF-8 |
| 分页 | 默认 50，最大 200 |
| 直接 ID 数组 | 最大 200；更大选择先建服务端 target list |
| 图片上传流 | 每图 32 MiB |
| 已存资源读取 | 仍为现有 64 MiB 编码上限 |
| 像素预算 | 现有 64M 像素 |
| 领取凭据 / 计划 | 10 分钟 |
| 播放凭据 | 12 小时固定 |
| 未消费上传 | 24 小时 |
| 迁库授权 / 包体积 | 10 分钟 / 最大 512 MiB |
| 秘密 | ≥32 字节系统安全随机；只存摘要 |

本地 `VIDEO_LIST` 已有每页 200 条上限，与管理分页上限对齐。现有刮削批次 IPC 可带最多 10000 个 ID；远程管理改为 target list，不把该 IPC 上限搬上 HTTP。

## 合同分层

| 层 | 位置 | 调用方 |
|---|---|---|
| 桌面 API | 现有 `*IpcContract.ts` + `desktop/session|capabilities|settings` | renderer / preload |
| 后端端口 | `apps/desktop/src/main/application/catalogBackend.ts` | 桌面 application / workflows |
| HTTP 管理 | `manage/operations.ts` + `manage/inputs.ts` | RemoteCatalogBackend、server |
| HTTP 浏览 | `webTypes.ts` / `browser/dto.ts` | 只读网页；独立白名单 |

页面只提供业务目标、原版本和用户选择。writer token、HTTP 头、任意服务地址不进入 renderer。本地适配器直接调 library，不创建 localhost HTTP，也不模拟 writer token。

## 通用包络

查询：`serverId`、`catalogId`、`input`。

修改：`operationId`、`serverId`、`catalogId`、`writerEpoch`、`expectedVersions`、`input`。

预览提交另加 `planId` + `planDigest`。版本键仅为 `V/R/A/F/P/L/C/G/Q`；未知键拒绝。

成功短写回执含 `operationId`、结果 ID/计数、变更后版本。任务受理回 `operationId + taskId`。错误为 `StructuredError`（code / message / 受控 details / recovery）。桌面 IPC 的兼容投影与 HTTP 错误包络分层处理，不能把旧 S01 的迁移步骤当成当前待办。

## 无 IPC 祖先的新用例

| 用例 | 权限 | 事务/任务 |
|---|---|---|
| `handshake.get` | 公开握手 | 无资料写入 |
| `writer.claim` / `claimStatus` | 领取凭据 | 领取与 epoch 切换同事务 |
| `writer.handoffBegin` / `recoverIssue` | 当前 writer / 部署侧恢复（环回限制） | 签发一次性令牌；不是立即撤销旧 writer |
| `uploads.create` / `inspect` | 管理写/读 | 上传完成 ≠ 业务受理 |
| `play.grant` | 管理读 | 12 小时资源凭据 |
| `tasks.*` / `operations.get` / `targetLists.*` | 读或写 | 取消只到安全边界 |
| `migration.*` | 独立迁移授权 | 启用/放弃同一决策点 |

二进制 PUT `/manage/v1/uploads/:id` 不是 JSON 用例；JSON 只允许 purpose 与 contentType。

## 图片与路径

正式图片引用是 `{kind:'upload', uploadId}`、`{kind:'asset', assetId}` 或 `{kind:'clear'}`。桌面另有不透明 `desktopTemp` handle，renderer 不能指定主机路径。远程根添加使用 `mountSelectionId`，不能提交任意宿主路径。详情 DTO 使用根名称 + 相对路径；绝对路径不作为可执行票据返回。

## 设置拆分

`SETTINGS_GET/UPDATE` 拆成此电脑（模式、地址、播放器、代理、模型、窗口）与当前资料库（overview、网页配对）。`SETTINGS_LIBRARY_PATH_*` 是旧全局路径清理，远程禁用；目录管理走 `libraries.*`。加密与资产目录搬迁远程禁用。

## IPC 去向摘要

| 去向 | 含义 |
|---|---|
| `manageQuery` / `manageMutation` / `catalogTask` | 正式资料在当前 CatalogBackend |
| `desktopRetain` | 插件、模型、OS、更新等留在此电脑 |
| `desktopWorkflow` | 桌面采集/计算，正式提交走管理用例 |
| `desktopEvent` | 非 HTTP 写；由任务轮询在桌面投影 |
| `remoteUnavailable` | 远程明确禁用并给原因 |
| `compatMerged` | `VIDEO_UPDATE` → `videos.edit` |

IPC 去向以 inventory 及其覆盖检查为准。兼容入口不要求一对一 HTTP 路由。

## 宿主职责与代码导航

| 边界 | 当前职责与实现入口 |
|---|---|
| Node 宿主 | [runtime.ts](../apps/server/src/runtime.ts) 装配数据库、worker、图片与 HTTP；[config.ts](../apps/server/src/config.ts) / [index.ts](../apps/server/src/index.ts) 负责配置和 CLI |
| HTTP | [manage.ts](../packages/http/src/manage.ts) 校验管理面；[manageDispatch.ts](../apps/server/src/manageDispatch.ts) 分派授权与业务；[server.ts](../packages/http/src/server.ts) 提供浏览静态资源、会话和 Range |
| 共享业务 | [catalog](../packages/library/src/catalog/) 承担权威资料读写；[catalogVideoCommands.ts](../packages/library/src/catalog/catalogVideoCommands.ts)、[catalogScrapeCommands.ts](../packages/library/src/catalog/catalogScrapeCommands.ts) 共用版本、事务与回执；[catalogFileMaintenance.ts](../packages/library/src/catalog/catalogFileMaintenance.ts) 共用文件维护生命周期 |
| 双后端 | [CatalogBackend](../apps/desktop/src/main/application/catalogBackend.ts) 为桌面端口；[本地适配器](../apps/desktop/src/main/backends/local/localCatalogBackend.ts) 直调 library，[远程适配器](../apps/desktop/src/main/backends/remote/remoteCatalogBackend.ts) 调管理 HTTP 并归一化返回值 |
| 桌面启动与工作存储 | [createDesktopRuntime.ts](../apps/desktop/src/main/bootstrap/createDesktopRuntime.ts) 在开库前选择模式；[workStore.ts](../apps/desktop/src/main/desktop/workStore.ts) 保存桌面工作记录，远程不打开本机权威 library.db |
| 桌面采集 | 插件、Playwright、模型和交互留在桌面；[catalogRemoteScrape.ts](../apps/desktop/src/main/services/catalogRemoteScrape.ts) 上传候选图片并提交，[catalogRemoteBatch.ts](../apps/desktop/src/main/services/catalogRemoteBatch.ts) 冻结远程批量目标 |
| writer / 回执 | [catalogWriter.ts](../packages/library/src/catalog/catalogWriter.ts) 管身份与交接，[catalogOperations.ts](../packages/library/src/catalog/catalogOperations.ts) 管幂等回执；忙时拒绝，不排队 |
| 图片 / 播放 | [catalogUploads.ts](../packages/library/src/catalog/catalogUploads.ts)、[catalogImageApply.ts](../packages/library/src/catalog/catalogImageApply.ts)、[catalogPlay.ts](../packages/library/src/catalog/catalogPlay.ts)；上传成功不等于正式应用，播放有独立限时凭据 |
| 迁库 | [catalogMigration.ts](../packages/library/src/catalog/catalogMigration.ts) / [catalogMigrationState.ts](../packages/library/src/catalog/catalogMigrationState.ts)；离线包、目标空库与人工切换，不做双端许可协调 |

## 已接线的功能补齐（C1–C7）

以下是当前实现，不是待决定清单；测试入口表示覆盖位置，不表示完整 GUI 或故障验收已完成。

| 编号 | 现行行为 | 主要实现 / 定向测试 |
|---|---|---|
| C1 远程重命名 | `files.renamePreview` 在服务端解析资源及活文件指纹，提交校验版本与根保护；桌面不操作服务端绝对路径，保留改名后重新识别 | [catalogFileMaintenance.ts](../packages/library/src/catalog/catalogFileMaintenance.ts)、[scanHandlers.ts](../apps/desktop/src/main/ipc/scanHandlers.ts)、[维护测试](../packages/library/src/catalog/catalogFileMaintenance.test.ts) |
| C2 队列定位 | `pendingScan.queuePage` 传递 anchor，失效锚点沿用本地回退语义 | [manageCatalogRemainder.ts](../apps/server/src/manageCatalogRemainder.ts)、[C1–C7 集成测试](../apps/server/src/manageCatalogC1C7.test.ts) |
| C3 精确存在查询 | `pendingAudit.presence` 按媒体库和指定 group/identity/scrape IDs 查询，不再组合列表求交 | 同上 |
| C4 审计筛选 | `scans.auditPage` 传递 section/outcome/attention | [manageCatalogMaintenance.ts](../apps/server/src/manageCatalogMaintenance.ts)、[C1–C7 集成测试](../apps/server/src/manageCatalogC1C7.test.ts) |
| C5 来源查询 | `videos.sources` 分页返回真实来源；空结果是未匹配，非法响应是查询失败 | [catalogVideoSources.ts](../packages/library/src/catalog/catalogVideoSources.ts)、[匹配适配](../apps/desktop/src/main/services/playlistImport/playlistImportCatalogLookup.ts)、[来源测试](../packages/library/src/catalog/catalogVideoSources.test.ts) |
| C6 单条/批量刮削 | 桌面采集，服务端正式应用或持有待确认；原版本提交，工作记录按 catalog 隔离 | [远程刮削](../apps/desktop/src/main/services/catalogRemoteScrape.ts)、[批量适配](../apps/desktop/src/main/services/catalogRemoteBatch.ts)、[刮削测试](../apps/desktop/src/main/services/catalogRemoteScrape.test.ts)、[批量测试](../apps/desktop/src/main/services/catalogRemoteBatch.test.ts) |
| C7 清单影片链接 | `playlists.applyImport.videoLinks` 与清单应用一并写入并去重，不扩大自动建片或追加清单范围 | [catalogPlaylistImport.ts](../packages/library/src/catalog/catalogPlaylistImport.ts)、[应用适配](../apps/desktop/src/main/services/playlistImport/playlistImportCatalogApply.ts)、[清单测试](../packages/library/src/catalog/catalogPlaylistImport.test.ts) |

C6 的最终语义集中如下，不再采用旧实施记录中的中间状态：

- `targetLists.create` 接受互斥的 ids / videoFilter / actressFilter，启动时冻结目标与版本；分页 entries 保留已删除占位，队列报告不存在且不缩减总数。直接已选 ID 上限 200，更大范围使用筛选。
- `targetLists.count` 只读计数，不创建目标记录。`scrape.fields` 在权威宿主判断 fillEmpty（含头像可用性与来源），不通过 DTO 近似判断。
- 取消停止桌面采集，不撤回服务端已受理写入。断线后的受理结果按 operationId 查询，不靠重新生成操作号猜测。
- main 合并后的预登录会话贯穿远程单条/批量采集；远程图片获取传来源 referer。服务器仍不运行插件或 Playwright。

## main 0.7.1 合同对齐

`videos.importResource` 的 url 可选，支持仅资料、最多 20 条 resources 及相关 links；每项资源仍由严格 schema 校验。见 [inputs.ts](../packages/contracts/src/manage/inputs.ts)、[合同测试](../packages/contracts/src/manage/schemas.test.ts) 与共享 [videoMaintenanceService.ts](../packages/library/src/catalog/videoMaintenanceService.ts)。客户端和服务端必须同版本；新增字段不意味着兼容旧客户端。

远程媒体库设置将桌面 `expectedRevision` 转成 HTTP 信封中的 L/C 版本；不把桌面兼容字段送入严格 HTTP 输入，也不以刷新后的版本覆盖用户提交的旧版本。添加来源目录的 IPC 接受互斥的本机路径或服务端挂载名称，远程只接受后者。

## 扫描与 NFO 的版本边界

影片 V 保护正式元数据，文件维护 R 由资源定位、指纹等状态生成摘要。扫描刷新 STRM 目标会使旧文件维护版本失效；仅新增/刷新资源、不改影片元数据时，不额外递增 V。

桌面与服务端共用 [libraryLocalNfoScanService.ts](../packages/library/src/nfo/libraryLocalNfoScanService.ts)、NFO 来源解析与图片交割。正式应用 NFO 时，在元数据和审计同一事务中递增 V；待确认候选和跳过不递增。候选确认同时交割封面、样张和演员头像；NFO 导出写文件而不修改影片资料，因此不递增 V。

远程 `manageBrowserPairing` 在可用会话中开放；冻结、断开及权限错误时禁用。现有 `browser.*` 管理接口承接配对和设备管理，浏览 Cookie 不能替代 writer 凭据。

## 保留的边界与限制

- 首版为局域网、单 writer、无资料库同步。网页只读账号/Cookie 不授予管理、管理图片或授权播放权限；桌面主进程保存秘密。
- 服务端使用固定挂载标记保护离线/卸载，不识别换卷，不提供已绑定挂载目录重绑；本机物理目录身份仍遵循 ADR-0024。
- 远程不能打开服务端本机文件夹、选择桌面目录当服务端根、重绑本地根、加密图片或搬迁图片目录。正式图片为明文；无转码、无任意 URL 代理。
- 能力按会话状态控制，见 [desktopCapabilities.ts](../apps/desktop/src/main/application/desktopCapabilities.ts)。当前远程 `manageBrowserPairing` 能力为不可用；有服务端接口不等于所有桌面 UI 动作均开放。冻结时不可编辑，但保留迁库能力，仍需 migration Bearer。
- 工作存储准备未完成、凭据失效、版本不符或断线，不自动回退本地权威库。桌面工具可保留可用状态，正式查询/提交仍受远程会话约束。
- 完整验收缺口和暂缓范围只维护在 [当前状态](SERVER_MODE_NEXT_STEPS.md)，不以“接口存在”替代验收。

清单分页的管理输入保留桌面使用的 `search`、`videoId`、`locale`，并沿用有界分页；远程导入界面关闭且禁用“自动创建无资源影片”，未匹配条目跳过，避免默认提交宿主不支持的选项。
