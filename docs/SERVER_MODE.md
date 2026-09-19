# 服务端模式：部署、认主与迁库

本页维护当前部署与操作方式。实现、合同和功能边界见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)，进度与验证结果见 [当前状态](SERVER_MODE_NEXT_STEPS.md)。桌面日常操作见 [使用指南](USER_GUIDE.md)，只读网页见 [LAN Web](LAN_WEB.md)。

当前代码基线为 `76a871e` / `0.7.1`；服务端阶段性实现完成，完整验收与发布准备尚未完成。历史容器或 Linux 安装烟测不代表当前版本已验收。

## 版本

桌面应用、服务镜像与网页包必须来自同一源码版本。握手发现应用版本不一致时，桌面进入版本不符状态，不打开本机权威库，也不自动改连其他地址。

## 存储与进程

- `dataDir`：绝对路径，存放 `library.db`、任务与迁库暂存。不要与 `imagesDir` 设成同一目录。
- `imagesDir`：正式图片目录（默认 `{dataDir}/media_assets`）。
- `mediaMounts`：只读配置里的挂载名 → 绝对目录。扫描与 NFO 只使用这些目录。
- 以专用 UID/GID 运行进程；数据目录与挂载应对该用户可读写。不要用桌面用户数据目录充当服务 `dataDir`。
- 同一 `dataDir` 同时只允许一个宿主进程。

## 构建与配置

从仓库根目录构建：

```bash
npm ci
npm run server:build
```

产物为 `out/server`，包含网页和服务端入口。独立部署时在产物目录安装生产依赖后，以 `node index.js start --config /etc/javdex/server.json` 启动；不需要 Electron rebuild。仓库的 Dockerfile 同样使用该产物，镜像内以 `node` 用户运行，不会替你生成配置或挂载媒体目录。

配置示例（目录及地址替换为服务机器实际值）：

```json
{
  "listenHost": "0.0.0.0",
  "port": 8096,
  "accessHosts": ["192.168.1.10"],
  "dataDir": "/data/javdex",
  "imagesDir": "/data/javdex/media_assets",
  "mediaMounts": { "media": "/media/videos" },
  "web": { "username": "viewer" }
}
```

此示例需通过环境变量 `JAVDEX_WEB_PASSWORD` 提供网页密码，或在 web 中配置 `passwordHash`。`accessHosts` 填客户端访问的主机名/IP，不是监听地址。`staticRoot` 可省略，CLI 默认使用产物旁的 web 目录；手动指定时必须是含 index.html 的绝对目录。

环境覆盖项为 `JAVDEX_DATA_DIR`、`JAVDEX_IMAGES_DIR`、`JAVDEX_STATIC_ROOT`、`JAVDEX_LISTEN_HOST`、`JAVDEX_LISTEN_PORT`、`JAVDEX_ACCESS_HOSTS`（逗号分隔）、`JAVDEX_WEB_USERNAME`、`JAVDEX_WEB_PASSWORD`。配置文件仍为必需；字段及默认值以 [config.ts](../apps/server/src/config.ts) 为准。日常部署使用固定端口；端口 0 仅用于需要系统分配端口的场景。

## 启动与认主

配置文件经 `--config` 或 `JAVDEX_SERVER_CONFIG` 提供。安装了 `javdex-server` 命令时使用下列形式；运行构建产物时将命令名替换为 `node /部署目录/index.js`，Docker 中使用镜像的 Node 入口：

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

## 功能与使用边界

远程资料管理、文件重命名、待确认队列定位与精确查询、审计筛选、来源匹配、单条/批量刮削及清单影片链接已接线。刮削插件、浏览器登录和网络采集仍在桌面运行；服务端保存权威资料和正式图片。批量直接选择最多 200 个 ID，更大范围用筛选；取消采集不会撤回已经受理的写入。

服务端扫描启用“自动导入本地 NFO”后，使用与桌面相同的来源解析、候选暂存和资料应用流程，支持标题、演员及挂载目录内的封面、样张、演员头像。多候选按现有策略进入待确认；正式应用递增影片版本，旧编辑须刷新后重试。图片只通过已授权根目录能力读取，不接受 NFO 中的远程图片作为下载授权。NFO 导出仍支持 XML。

远程桌面连接且取得写入权限后，可在“网页访问”中开启配对、核对并批准/拒绝配对码，管理已配对设备。服务端地址、端口和登录配置仍由部署配置管理；会话断开或资料库冻结时隐藏操作控件。网页配对只授予浏览权限，不授予管理 API 权限。

远程不支持本机文件夹操作、根重绑、图片加密或资产目录搬迁。服务端首版无转码，挂载使用固定标记保护，不识别换卷。能力细节和代码入口统一见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)。
