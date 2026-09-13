# 服务端模式：部署、认主与迁库

桌面日常操作见 [使用指南](USER_GUIDE.md)。局域网只读网页见 [LAN_WEB.md](LAN_WEB.md)。本页说明独立 Node 宿主、桌面远程模式、认主与整库迁移。第一版范围仍以 [执行计划](SERVER_MODE_EXECUTION_PLAN.md) 为准；本环境尚未用 Docker 镜像或安装包烟测替代源码验证。

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

双向整库迁移只接受空目标。视频文件不复制，只按挂载映射改写定位。CLI `migrate-auth` 签发独立 migration Bearer（不是 writer）。源在 start 后冻结；目标 enable 与 abandon 互斥。启用成功后源保持冻结备份，除非操作者再对源调用 abandon。加密图片会阻止迁入；孤立 `uploads/` 不会成为目标封面。丢响应或重启后以 `migration.status` 为准，不要重复猜测 enable/abandon。

## 更新与恢复限制

先停服务，备份 `dataDir` 与 `imagesDir`，再换同版本产物。版本不符时桌面不会写入远程。冻结中的源库不能领取 writer。图片拷贝失败时资料库可能已启用但封面缺失，需按备份恢复，当前没有自动整笔回滚。
