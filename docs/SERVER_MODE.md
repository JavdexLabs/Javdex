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

桌面在“此电脑”中选择远程地址后重启生效。远程模式只使用桌面设置、凭据与 `desktop-work.db`，不打开原 `library.db`。工作记录未复制完成时拒绝远程启动。

## 迁库

双向整库迁移只接受空目标。视频文件不复制，只按挂载映射改写定位。CLI `migrate-auth` 签发独立 migration Bearer（不是 writer）。源在 start 后冻结；目标 enable 与 abandon 互斥。启用成功后源保持冻结备份，除非操作者再对源调用 abandon。源端加密图片在 start/导出时自动解密到迁移包（明文进目标）；解密使用当前 LibraryHost 机器密钥（hostname + 用户名 + userDataPath）及源 `imagesDir` 路径别名，不改源正式图。缺少别名或密钥不匹配时 start 失败并解冻。目标 enable 在 ATTACH 提交后若拷图失败（`EACCES`/`ENOSPC` 等）会回滚启用状态并尽量删除已拷文件，不留下安静的 `enabled` 半状态。孤立 `uploads/` 不会成为目标封面。丢响应或重启后以 `migration.status` 为准，不要重复猜测 enable/abandon。

桌面远程模式的 `migrateCatalog` 与本地同一入口；远程走现有 HTTP migration，不打开本机 `library.db`。调用仍需要 CLI `migrate-auth` 签发的 migration Bearer。

## 更新与恢复限制

先停服务，备份 `dataDir` 与 `imagesDir`，再换同版本产物。版本不符时桌面不会写入远程。冻结中的源库不能领取 writer。

## 当前实现限制（本阶段已确认补齐）

> 2026-09-14：用户已逐项确认 C1–C7 全部补齐，C6 包含单条和批量刮削，采集仍在桌面执行。该决定覆盖此前“不扩合同”的限制；以下列表描述尚未补齐的当前代码行为，不代表目标范围。实施顺序见 [阶段性推进计划](SERVER_MODE_NEXT_STEPS.md)。当前阶段不做全面自动化/完整 GUI 验收、故障测试、跨平台安装或 0.8 发布候选，E1/E2 仅保留历史说明。

- **C1** 远程 `FILE_RENAME` 仍 UNSUPPORTED（冻结 IPC 无 `resourceId`，不扩 resourceId 合同）
- **C2** `pendingScan.queuePage` 远程不支持 IPC `anchor`，仅本地队列页保留
- **C3** 冻结 `pendingAudit.presence` 保持空输入的目录级计数；桌面适配器本地包装 / 远程用 `libraries.get` 与 pending list 求交
- **C4** 远程 `scans.auditPage` 仅 `{libraryId}` + page，无 section/attention
- **C5** 无细粒度远程 `video_sources` 匹配 API，远程 sources 可为空
- **C6** 远程刮削单条不支持；刮削仍仅本地模式
- **C7** 远程 `playlists.applyImport` 不写 per-video `video_links`
- **E1** 单容器 `server:smoke` 已通过（#107）。Docker 两端迁库见 `server:smoke:migration` / 执行计划 S13。Linux 同版本 `deb`/`AppImage` + 镜像安装见 `smoke:same-version-install` / 执行计划 S14。不是 Windows/macOS 安装包，也不是完整 GUI 产品流
- **E2** 第一版发布路径已解锁：S14 剩余门闩通过后可升 0.8、写 CHANGELOG、准备合并 main。不得在剩余门闩通过前宣称 S13/S14 完成；本文件不授权自动合并 main，也不在本阶段升版本或写 CHANGELOG
