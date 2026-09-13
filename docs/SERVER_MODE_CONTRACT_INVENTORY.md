# S01 合同清点

权威实现是 TypeScript，而不是本文件：

- IPC 282 项去向：[`packages/contracts/src/inventory/ipcDisposition.ts`](../packages/contracts/src/inventory/ipcDisposition.ts)
- 管理用例元数据：[`packages/contracts/src/manage/operations.ts`](../packages/contracts/src/manage/operations.ts)
- 管理输入 schema：[`packages/contracts/src/manage/inputs.ts`](../packages/contracts/src/manage/inputs.ts)
- 桌面端口：[`apps/desktop/src/main/application/catalogBackend.ts`](../apps/desktop/src/main/application/catalogBackend.ts)

本文件记录 S01 冻结时的工程决定、协议包络、以及“没有 IPC 祖先”的新用例。字段级请求形状以 schema 为准；不知道如何处理的字段不得标冻结。

## 工程默认（可实测后调整，不得静默截断）

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
| 秘密 | ≥32 字节系统安全随机；只存摘要 |

本地 `VIDEO_LIST` 已有 200 页上限，与管理分页上限对齐。现有刮削批次 IPC 可带最多 10000 个 ID；远程管理改为 target list，不把该 IPC 上限搬上 HTTP。

## 三层合同

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

成功短写回执含 `operationId`、结果 ID/计数、变更后版本。任务受理回 `operationId + taskId`。错误为 `StructuredError`（code / message / 受控 details / recovery）。现有 IPC `IpcResponse.error: string` 在 S02D 再替换，S01 不改 handler。

## 无 IPC 祖先的新用例

| 用例 | 权限 | 事务/任务 |
|---|---|---|
| `handshake.get` | 公开握手 | 无资料写入 |
| `writer.claim` / `claimStatus` / `handoffBegin` / `recoverIssue` | 领取或当前 writer | 领取与 epoch 切换同事务 |
| `uploads.create` / `inspect` | 管理写/读 | 上传完成 ≠ 业务受理 |
| `play.grant` | 管理读 | 12 小时资源凭据 |
| `tasks.*` / `operations.get` / `targetLists.*` | 读或写 | 取消只到安全边界 |
| `migration.*` | 独立迁移授权 | 启用/放弃同一决策点 |

二进制 PUT `/uploads/:id` 不是 JSON 用例；JSON 只允许 purpose 与 contentType。

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

282 项均有去向。兼容入口不要求一对一 HTTP 路由。
