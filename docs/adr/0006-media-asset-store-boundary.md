# ADR-0006：媒体资源存储边界

Javdex 将 SQLite 中保存的**媒体资源引用**视为指向**媒体资源**的相对路径，而不是文件操作能力。数据库 Repo 只查询或更新这些引用；图片是否可读、尺寸、指纹、加密读写、导入、删除、启动建目录与布局路径由主进程的 `MediaAssetStore` 负责。清单封面、影片封面/样张与演员头像/写真均通过该模块导入与补偿。

## 公开面与私有实现

- 应用服务、启动路径（`index`）、远程拉图、资源迁移与测试只能依赖 `MediaAssetStore`（`mediaAssetStore.ts`）。
- 实现拆为 store 内部 adapter（非对外 port）：`mediaAssetStore/filesystem.ts`、`mediaAssetStore/inspection.ts`、`mediaAssetStore/download.ts`（含刮削暂存），以及纯字节辅助 `imageBytes.ts`。除 `mediaAssetStore.ts` 与该目录内模块互引外不得 import。旧名 `assetService` / `mediaAssetStoreFs` 已退役。
- 这些内部模块只有一套生产实现；测试通过公开面与临时媒体根验证，不引入第二套可替换 adapter。
- 窄 bootstrap / 布局 API：`ensureReady()`、`rootPath()`、`subdirPath(kind)`；出图与检验使用已有 `readForServe`、`readImageDimensions` 等。迁移可保留稳定子目录名知识，但必须经上述 API 解析绝对路径。
- `assetCrypto` 等编码支撑可独立存在，不在本 ADR 的私有化范围内。

## 写入时序

资源写入遵循以下顺序：先创建新资源，再提交引用它的数据库事务；事务失败时删除本次新建资源。旧资源只在数据库提交成功后尽力删除，清理失败不得回滚已提交的数据，并应保留具体路径用于日志或界面诊断。应用服务通过 `coordinateDatabaseChange` / `coordinateDatabaseChangeAsync` 编排该时序。Repo 的资源写命令返回新引用和待清理旧路径，不在事务内删除文件。

## 查询与根目录

普通列表和详情查询不得探测文件系统。需要按资源健康状态筛选时，Repo 返回路径候选，应用模块通过 `MediaAssetStore` 检查后再分页或形成任务清单。无人脸检测继续只在用户进入该筛选时扫描完整候选集。

所有存储路径解析必须限制在媒体资源根目录内；明文与加密资源共享同一边界。影片源文件不属于 `MediaAssetStore`，删除软链接时仍只删除链接本身，不跟随删除链接目标。
