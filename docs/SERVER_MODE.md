# 服务端模式：部署、认主与迁库

桌面日常操作见 [使用指南](USER_GUIDE.md)。局域网只读网页见 [LAN_WEB.md](LAN_WEB.md)。本页说明独立 Node 宿主、桌面远程模式、认主与整库迁移。第一版范围仍以 [执行计划](SERVER_MODE_EXECUTION_PLAN.md) 为准。单容器生产镜像 `server:smoke` 已通过（#107：bind + writer.claim + restart）。Docker 两端迁库烟测见 `server:smoke:migration` / 执行计划 S13。Linux 同版本桌面包 + 镜像安装烟测见 `smoke:same-version-install` / 执行计划 S14。这些烟测不能替代完整源码验收，不得据此宣称 S13 / S14 / M–D 矩阵完成。

## 版本

桌面应用、服务镜像与网页包必须来自同一源码版本。握手发现应用版本不一致时，桌面进入版本不符状态，不打开本机权威库，也不自动改连其他地址。

## 存储与进程

- `dataDir`：绝对路径，存放 `library.db`、任务与迁库暂存。不要与 `imagesDir` 设成同一目录。
- `imagesDir`：正式图片目录（默认 `{dataDir}/media_assets`）。
- `mediaMounts`：只读配置里的挂载名 → 绝对目录。扫描与 NFO 只使用这些目录。
- 以专用 UID/GID 运行进程；数据目录与挂载应对该用户可读写。不要用桌面用户数据目录充当服务 `dataDir`。
- 同一 `dataDir` 同时只允许一个宿主进程。

## 启动与认主

配置文件经 `--config` 或 `JAVDEX_SERVER_CONFIG` 提供。命令：

```bash
javdex-server start --config /etc/javdex/server.json
javdex-server bind --config /etc/javdex/server.json
javdex-server recover --config /etc/javdex/server.json
javdex-server migrate-auth --config /etc/javdex/server.json
```

`bind` 在尚未认主时签发一次性令牌；桌面用该令牌领取 writer，秘密只存在本机安全存储。`recover` 在丢失 writer 秘密后签发恢复令牌。`JAVDEX_BOOTSTRAP_TOKEN` 仅用于首次启动写入引导令牌，不是 occupancy 文件。网页账号使用 `web.passwordHash` 或环境变量 `JAVDEX_WEB_PASSWORD`；Cookie 不能调用管理接口。

交接/恢复领取遇到扫描、维护任务或未完成的文件操作时返回 `MAINTENANCE_BUSY`。请求不排队、不占用交接资格，也不消耗一次性令牌；操作者应完成或取消任务后重试（令牌过期需重新签发）。原 writer 在交接成功前保持有效，新维护任务不会因一次失败的交接而被禁止。成功领取仍是原子操作，同一成功 claim 的重试不增加写入代次。`writer.status.maintenanceBusy` 表示当前有维护任务，不表示有人排队。

桌面在“此电脑”中选择远程地址后重启生效。远程模式只使用桌面设置、凭据与 `desktop-work.db`，不打开原 `library.db`。工作记录未复制完成时拒绝远程启动。

## 迁库

迁库采用离线包和人工切换，不做双端协调；本地→服务端及服务端→本地均保留。目标必须是未认主的空资料库；仅有清单、标签或分类资料也不算空库。视频文件不复制，只按挂载映射改写定位。CLI `migrate-auth` 签发独立 migration Bearer（不是 writer）。

1. 在源端 `migration.preview` 确认映射和预检，调用 `migration.start` 冻结写入并导出包。完成后停止使用源库，保留其数据库与正式图片作为冻结备份。
2. 人工复制 `{dataDir}/migration-packages/{migrationId}.tar.gz` 到目标，或使用迁移凭据上传到 `PUT /manage/v1/migration/packages/:migrationId`；随后在目标调用 `migration.start` 校验并暂存。源端此时可以完全离线，无需网络可达或签发启用许可。
3. 确认源库已停用，在目标调用 `migration.enable`，输入除 `migrationId` / `digest` 外必须包含 `confirmSourceStopped: true`。启用生成新的 catalogId；操作者重新认主并人工切换桌面连接，不自动切换或回退。

`migration.status` 只返回本端的 `role`（source/target）、`phase` 和摘要，不再返回推测的 `sourcePhase` / `targetPhase`；`migration.allowEnable` 已移除。目标 `enable` 与 `abandon` 仍是互斥本端终态，重复启用只回放结果。导出期间或目标暂存未处理时不能开始另一迁移。

放弃目标暂存可在目标调用 `migration.abandon`。恢复已冻结的源库则必须先停用目标，并在源端调用 `migration.abandon` 时传 `confirmTargetStopped: true`。这些确认是操作者声明，不是跨端验证。目标已产生的新数据不会自动回流旧库；不能把恢复旧库当作无损回退，也不能同时写入两个副本。

源端加密图片在导出时自动解密到迁移包（明文进目标）；解密使用当前 LibraryHost 机器密钥及源图片路径别名，不改源正式图。图片校验、路径映射和导入失败保护保留；孤立 `uploads/` 不会成为目标封面。丢响应后查询本端 `migration.status`，不要猜测启用结果。旧版双端状态会按本端角色读取，旧源启用许可只解释为源仍冻结，不自动解冻。

桌面远程模式的 `migrateCatalog` 与本地同一入口；远程走现有 HTTP migration，不打开本机 `library.db`。调用仍需要 CLI `migrate-auth` 签发的 migration Bearer。

## 更新与恢复限制

先停服务，备份 `dataDir` 与 `imagesDir`，再换同版本产物。版本不符时桌面不会写入远程。冻结中的源库不能领取 writer。

## 当前实现限制（本阶段已确认补齐）

> 2026-09-14：用户已逐项确认 C1–C7 全部补齐，C6 包含单条和批量刮削，采集仍在桌面执行。该决定覆盖此前“不扩合同”的限制。实施顺序见 [阶段性推进计划](SERVER_MODE_NEXT_STEPS.md)。当前阶段不做全面自动化/完整 GUI 验收、故障测试、跨平台安装或 0.8 发布候选，E1/E2 仅保留历史说明。

- **C1** 远程 `FILE_RENAME` 经 `files.renamePreview` 在服务端解析资源编号与活文件指纹；桌面只发送根相对路径，绝对路径被拒绝
- **C2** `pendingScan.queuePage` 已转发 IPC `anchor`；失效锚点回落到首页，与本地队列语义一致
- **C3** `pendingAudit.presence` 按媒体库和指定 group/identity/scrape ids 精确返回存在项，不再做目录级计数或 list 求交
- **C4** 远程 `scans.auditPage` 保留 `section`/`outcome`/`attention`
- **C5** 远程 `videos.sources` 按 codes/videoIds/source+identity 分页返回唯一影片及其来源；空结果表示未匹配，无效响应当查询失败。清单匹配不再用空 sources 代替
- **C6** 远程单条与批量刮削已接线：桌面运行插件/Playwright 采集，服务端持有正式资料并接收 `applyScrapeCandidate` / 待确认提交。批量启动时冻结 ids 或筛选条件；分页 `entries` 对已删除 id 占位，桌面队列保留该项与总数并报告不存在，不静默过滤。远程已选 ID 上限 200，更大范围用 `videoFilter`/`actressFilter`。取消只停止桌面采集，不回滚已受理写入。远程 `fillEmpty` 经 `scrape.fields` 调用权威宿主的本地同款字段判断（含头像可用性及按来源判断）。count 经只读 `targetLists.count`，不创建冻结目标记录。尚未做完整 GUI/故障验收
- **C7** 远程 `playlists.applyImport` 按本地语义写入 per-video `video_links`（INSERT OR IGNORE 去重），不扩大自动建片或追加到已有清单
- **E1** 单容器 `server:smoke` 已通过（#107）。Docker 两端迁库见 `server:smoke:migration` / 执行计划 S13。Linux 同版本 `deb`/`AppImage` + 镜像安装见 `smoke:same-version-install` / 执行计划 S14。不是 Windows/macOS 安装包，也不是完整 GUI 产品流
- **E2** 第一版发布路径已解锁：S14 剩余门闩通过后可升 0.8、写 CHANGELOG、准备合并 main。不得在剩余门闩通过前宣称 S13/S14 完成；本文件不授权自动合并 main，也不在本阶段升版本或写 CHANGELOG
