# ADR-0006：媒体资源存储边界

Javdex 将 SQLite 中保存的**媒体资源引用**视为指向**媒体资源**的相对路径，而不是文件操作能力。数据库 Repo 只查询或更新这些引用；图片是否可读、尺寸、指纹、加密读写、导入、删除、启动建目录与布局路径由主进程的 `MediaAssetStore` 负责。清单封面、影片封面/样张与演员头像/写真均通过该模块导入与补偿。

## 公开面与私有实现

- 应用服务、启动路径（`index`）、远程拉图、资源迁移与测试只能依赖 `MediaAssetStore`（`mediaAssetStore.ts`）。
- 实现拆为 store 内部 adapter（非对外 port）：`mediaAssetStore/filesystem.ts`、`mediaAssetStore/inspection.ts`、`mediaAssetStore/download.ts`（含刮削暂存），以及纯字节辅助 `imageBytes.ts`。除 `mediaAssetStore.ts` 与该目录内模块互引外不得 import。旧名 `assetService` / `mediaAssetStoreFs` 已退役。
- 这些内部模块只有一套生产实现；测试通过公开面与临时媒体根验证，不引入第二套可替换 adapter。
- 窄 bootstrap / 布局 API：`ensureReady()`、`rootPath()`、`subdirPath(kind)`；出图与检验使用已有 `readForServe`、`readImageDimensions` 等。迁移可保留稳定子目录名知识，但必须经上述 API 解析绝对路径。
- `assetCrypto` 等编码算法库可独立存在；单文件加解密**改写**（`encryptStoredAsset` / `decryptStoredAsset` / `listStoredImageAssetRels`）属于 `MediaAssetStore`。批量编排、进度与跨表 `remapAssetPath` 留在 `assetMigration` / settings 用例，不进入 store，也不使用 `coordinateDatabaseChange`。

## 写入时序

资源写入遵循以下顺序：先创建新资源，再提交引用它的数据库事务；事务失败时删除本次新建资源。标记为废弃的路径（含同一次编排里先创建后丢弃的新文件，以及被替换的旧文件）只在根编排提交成功后尽力删除；清理失败不得回滚已提交的数据，并应保留具体路径用于日志或界面诊断。应用服务通过 `coordinateDatabaseChange`（同步或异步）编排该时序。影片刮削将**下载**与**写库/交割**分成两次编排：下载失败由第一段补偿；写库失败则显式清理已下载路径，避免「影片行已提交、媒体账本又 rollback」；演员头像 adopt 使用 `coordinateDatabaseChangeIsolated`。冲突确认中的 storeScraped / staging / formalize 同属对应编排。可单独或从属于更大共享用例的辅助路径使用 `runInCoordinatedChange`（有活跃编排则加入，否则自开根编排）。显式嵌套编排进入独立的 AsyncLocalStorage 上下文并链接父账本，成功时把 created 与 obsolete 一并提升到父编排，旧文件删除推迟到根编排提交；因此调用方在未 await 嵌套异步编排前继续登记资源，仍记在当前编排而非子编排。与当前异步链无关的调用自成根编排。Repo 的资源写命令返回新引用和待清理旧路径，不在事务内删除文件。

### 清理模式

媒体文件清理只有两种合法模式，不要混用语义：

1. **编排内 obsolete（默认）** — 在 `coordinateDatabaseChange` / `runInCoordinatedChange` 内调用 `deleteBestEffort`：路径记入当前账本，只在**根编排成功提交后**才尽力删除。用于替换封面/头像、刮削交割、清单更新等「先写库、再删旧文件」路径。
2. **提交后即时清理** — 数据库事务**已经提交**且本次没有配对的新建资源需要补偿时，在无活跃编排（或明确不依赖其 rollback）下直接 `deleteBestEffort`。用于扫描器 purge、默认演员合并清理，以及 conflict 里 `deferCleanup: true` 后由外层在大事务成功后再删的路径。

第一种保证「库失败则旧文件仍在」；第二种表示「库已不再引用这些路径」。批量加解密迁移通过 store 的单文件改写原语变形文件，由 migration 层负责进度与 DB remap。

## 查询与根目录

普通列表和详情查询不得探测文件系统。需要按资源健康状态筛选时，Repo 返回路径候选，应用模块通过 `MediaAssetStore` 检查后再分页或形成任务清单。无人脸检测继续只在用户进入该筛选时扫描完整候选集。

所有存储路径解析必须限制在媒体资源根目录内；明文与加密资源共享同一边界。影片源文件不属于 `MediaAssetStore`，删除软链接时仍只删除链接本身，不跟随删除链接目标。
