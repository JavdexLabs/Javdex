---
title: "已有部署首次采用托管更新"
description: "Javdex 0.9.0 · 已有部署首次采用托管更新"
---

使用目标正式 Release 发布说明链接的同源码版本 [Compose](https://github.com/JavdexLabs/Javdex/blob/main/deploy/docker-compose.example.yml) 和 [业务 JSON 配置](https://github.com/JavdexLabs/Javdex/blob/main/deploy/javdex-server.example.json)，无需下载部署附件或单独公钥。需要 Docker；Compose 部署还需 Compose 插件。官方镜像支持 Linux amd64/arm64，内部固定运行环境为 `node22-bookworm-v1`。Node、init、OpenSSL 和文件锁工具随镜像提供。

- `/data`：正式资料库，业务默认 UID/GID 1000/1000。
- `/media`：原视频挂载，不纳入每次升级快照。
- `/program`：必须保留的独立程序卷，含当前/上一版完整程序、更新状态、TLS 配对凭据、暂存和最近一次升级前完整快照。
- HTTPS 8096 是统一业务、播放与更新入口，仅向可信局域网或私有网络开放；不再映射 8097 或内部 8098。
- `JAVDEX_PUBLIC_URL` 配置桌面能访问的 HTTPS 根地址，例如 `https://192.168.1.10:8096`。它不是 Docker daemon 地址。

从正式 0.8.0（schema 19）首次采用 0.9.0 时：

1. 确认目标正式 Release 已提供同版本桌面、双架构镜像、两个 `.javdex-update` 和校验和；仅修改文档或出现预发布不能视为正式版可用。
2. 完成或取消维护任务，正常停止原服务，完整备份资料、图片、部署配置与原镜像，并另行备份桌面数据目录。新程序卷首次启动会直接采用 0.9.0 种子并迁移数据库，不为这次基础部署变更自动生成托管升级快照。
3. 在原 Compose 项目中采用新示例的管理入口、`javdex-program:/program`、统一 8096 端口与 `JAVDEX_PUBLIC_URL`，保留原数据/图片卷、媒体挂载及权限。原 HTTP 地址改为 HTTPS。不要因更换部署目录或 Compose 项目名而意外创建空数据卷。
4. 将 `.env` 设为 `JAVDEX_VERSION=0.9.0`，执行 `docker compose -f docker-compose.example.yml pull` 和 `docker compose -f docker-compose.example.yml up -d`，查看日志并确认实际业务版本与 schema 21；已有设备凭据随资料保留，无需为升级重新认主。
5. 桌面同步升级到 0.9.0。由管理员运行 `pair`，在原管理电脑保存统一地址、证书和设备授权后重启；其他电脑分别使用新生成的配对信息。旧凭据仍保留，可在可信设备列表撤销。仅全部设备遗失时才用 `pair-recover` 撤销全部旧授权。普通业务连接要求同版本。

已有托管 `/program` 的部署须保留程序卷：采用支持镜像自动升级的管理器后，镜像业务版本更高时会自动备份、安装和验证；相同或更旧则保留程序卷当前业务，不降级。失败重试和待处理任务的边界见 [通过镜像升级](/Javdex/server/update/#通过镜像升级)。旧桌面不能为旧镜像增加更新能力；未发布宿主机助手的状态目录或镜像归档没有兼容迁移入口。

首次初始化程序卷必须使用空的专用目录/卷；已初始化的托管程序卷应原样保留，不能与资料或图片互相包含，持久日志需可靠的本地 fsync 存储。图片目录只能在资料目录内或与资料目录独立，不能反向包含资料目录，避免恢复目标重叠。不要执行 `docker compose down -v`；只备份 `/data` 不能恢复配对凭据和发行选择。首次启动将镜像发行包复制到程序卷；此后较新镜像通过事务升级，不直接覆盖当前发行目录。

schema 21 不能交给 0.8.0 业务程序。开发快照即使标为 schema 20，也可能因结构不完整而被拒绝；应恢复受支持的升级前完整备份，不能手改 SQLite `user_version` 或桌面模型文档版本。基础镜像首次切换的回退依靠管理员事先保存的备份与匹配旧程序；后续托管更新的自动恢复边界见下文。
