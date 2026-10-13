# 服务端与更新执行程序部署研究

核查日期：2026-10-13。依据官方文档、官方源码及当前 Javdex 实现；以下区分来源事实与设计建议。未部署或执行更新。

后续实施：用户已确认单容器方案，开发实现由 [ADR-0031](adr/0031-manage-server-releases-inside-one-container.md) 收束，操作说明见 [服务端更新](SERVER_UPDATE.md)。下文“尚未实施”描述保留为研究时的历史边界，不代表新实现已完成真实 Linux 容器验收。

## 来源事实

### Nextcloud AIO：控制器随首次部署交付

- **首次安装**：管理员先安装 Docker，再用官方命令或 Compose 启动 `mastercontainer`，在其 Web 界面完成首次配置。它通过 Docker socket 创建、管理其他服务容器；用户无需另装宿主机更新助手。[官方安装说明](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#how-to-use-this)、[工作原理](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#how-does-it-work)
- **业务容器更新**：界面发现更新后，管理员点击 `Stop containers`，随后 `Start and update containers`；如果 mastercontainer 也有更新，先在停止业务后更新它。官方建议更新前备份；首次备份后可启用每日备份及自动更新。[官方更新流程](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#how-to-update-the-containers)、[备份与自动更新](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#backup)
- **mastercontainer 自身更新**：控制器按需创建/启动 `nextcloud-aio-watchtower`；其目标固定为 `nextcloud-aio-mastercontainer`，执行 `watchtower --run-once`。更新器是 AIO 管理的执行容器，用户无需单独安装它。[启动执行器](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/php/src/Controller/DockerController.php#L278-L294)、[执行容器定义](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/php/containers.json#L619-L640)、[一次性执行脚本](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/Containers/watchtower/start.sh#L23-L27)
- **管理权限**：官方安装挂载 Docker socket（`:ro`），供控制器管理服务。依据 Docker 官方文档，默认 rootful Docker 的控制权可用于修改宿主。因此，不能把 sidecar 或 socket 的 `:ro` 挂载视为只读 Docker API 权限保证；这是权限推论，不是 AIO 宣称的安全隔离。[AIO 安装命令](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#how-to-use-this)、[Docker daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)
- **恢复与离线边界**：Borg 备份包含数据库、文件及配置，外部存储默认不包含；界面提供 `Restore selected backup`。这证明有备份恢复入口，不能推导为“所有升级失败都会自动还原全部数据”。AIO 明确不支持离线/隔离网运行。[备份范围](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#what-is-getting-backed-up-by-aios-backup-solution)、[恢复入口](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#backup)、[离线限制](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#can-i-run-aio-offline-or-in-an-airgapped-system)

### Immich：管理员用 Compose 更新，无须专用助手

- **安装与更新**：下载官方 Compose 和 `.env` 模板、配置并 `docker compose up -d`。更新时阅读发布说明，必要时修改 `IMMICH_VERSION`/Compose，再执行 `docker compose pull`、`docker compose up -d`；没有要求专用更新守护程序。镜像或配置变化时，Compose 会重建容器并保留挂载卷；保留卷不等于恢复数据。[Immich 安装](https://docs.immich.app/install/docker-compose/)、[Immich 更新](https://docs.immich.app/install/upgrading/)、[Compose up 官方说明](https://docs.docker.com/reference/cli/docker/compose/up/)
- **回退边界**：官方不支持降级，即使在同一 minor 版本内。自动数据库备份不含照片、视频；当前文档支持数据库恢复失败后自动回退，但并非升级失败后自动回滚应用及全部数据。[版本政策](https://docs.immich.app/install/upgrading/#versioning-policy)、[备份范围](https://docs.immich.app/administration/backup-and-restore/#automatic-database-backups)、[恢复失败回退](https://docs.immich.app/administration/backup-and-restore/#restore-process)

### Portainer：可选的独立管理平台

- 选用时先部署 Portainer Server 容器，是额外选择的通用管理平台。Git 栈使用 `Pull and redeploy`，可选强制重拉镜像；Web Editor 栈修改 Compose 后点击 `Update the stack`，可能中断服务。`Version` 切换的是栈文件历史版本，不代表数据恢复。[官方安装](https://docs.portainer.io/start/install-ce/server/docker/linux)、[官方栈更新](https://docs.portainer.io/user/docker/stacks/edit)

### Jellyfin、Plex：其他更新形态

- **Jellyfin**：Docker 更新为停旧容器、拉新镜像、创建新容器；降级需还原备份。Podman 可采用平台的 auto-update，更新执行由部署工具承担。[官方升级说明](https://jellyfin.org/docs/general/testing/upgrades/)、[官方容器安装说明](https://jellyfin.org/docs/general/installation/container/)
- **Plex**：官方镜像 `public`/`beta` 标签在启动或重启时下载、安装对应 PMS；`latest` 和固定版本标签行为不同，不能概括为“所有镜像重启即升级”。[官方镜像标签说明](https://github.com/plexinc/pms-docker#tags)

## 对 Javdex 的建议（设计推论，未实施）

任务背景：未发布方案为业务 Docker 容器加宿主机 Node 22 / HTTPS 8097 助手，负责签名校验、备份、换容器、验证、恢复；现需用户准备 Node/OpenSSL/flock/systemd 并手配配置。目标仍是客户端点更新、上传离线包，允许停机；旧正式 0.8 没有远程更新能力。

历史代码核查：当时未提交的助手依赖 Node 22、Docker CLI/Compose、OpenSSL、flock，存在 loopback `serverUrl` 约束、宿主 bind 快照路径及宿主项目锁/配置路径。因此容器化不只是添加 Dockerfile，必须处理路径、网络和跨容器锁。该未发布执行器已删除，未保留可核验的冻结源码，不再用当前文件链接充当旧实现证据；现行实现改为[管理入口](../apps/server/src/updater/index.ts)、[进程监督](../apps/server/src/updater/supervisor.ts)与[进程部署](../apps/server/src/updater/processDeployment.ts)，见[部署说明](SERVER_UPDATE.md)。

1. **运行独立，交付统一**：评估一套官方 Compose（业务容器＋可选择启用的更新管理容器）或统一安装器，让用户不必另装 Node、手配 systemd；同时保留普通 Docker/NAS 手动更新。独立执行组件不等于用户必须分开安装。[AIO 工作原理](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#how-does-it-work)、[Immich 手动更新](https://docs.immich.app/install/upgrading/)
2. **先完成首次部署，再提供客户端更新**：按任务背景，旧 0.8 需管理员一次部署变更，布置业务停机后仍能工作的执行器；路径/网络/锁适配、执行器自更新和离线包流程需另行设计、验证。AIO 明确不支持离线，不能直接作为该需求已获满足的证据。[AIO 离线限制](https://github.com/nextcloud/all-in-one/blob/da7cf9d795cc5b09034225ede1ac000061d82437/readme.md#can-i-run-aio-offline-or-in-an-airgapped-system)
3. **按范围承诺恢复**：分别说明镜像回退、数据库恢复、媒体恢复的自动与人工边界。成熟软件并不都实现全数据自动回滚，不能用“已有备份”或“可换旧镜像”代替这一承诺。[Immich 版本政策](https://docs.immich.app/install/upgrading/#versioning-policy)、[Jellyfin 降级与备份](https://jellyfin.org/docs/general/testing/upgrades/)

## 资料局限

- AIO 源码固定到核查时 `main` 提交 `da7cf9d795cc5b09034225ede1ac000061d82437`，未逐版本验证已发布镜像；在线文档可能后续变化。
- 结论限上述官方流程，不覆盖所有发行包、NAS 或社区部署；未实测升级/故障恢复，未核实 Immich/Portainer 有与 Javdex 相同的客户端更新包上传能力。
- 本轮仅新增研究记录；以上建议尚未实施，未修改部署代码、执行部署、提交或推送。

## 单容器常驻管理父进程：官方资料补充核查

核查日期：2026-10-13。本节结合 Docker / Node 官方文档与 Javdex 当前源码评估单容器方案；未运行或验收该方案。

### 官方证据

- **多进程允许**：Docker 推荐每个容器一个服务以分离职责，但明确允许多个进程，并给出 wrapper 和 `supervisord` 示例；“推荐单职责”不能解释成禁止多进程。[Docker 多进程说明](https://docs.docker.com/engine/containers/multi-service_container/)
- **PID 1 与回收**：主进程负责管理其启动的进程；`--init` 插入小型 init 作为 PID 1，转发信号并回收僵尸进程。它提供 init 职责，不能据此假定业务子进程会自动重启。[Docker 多进程说明](https://docs.docker.com/engine/containers/multi-service_container/)、[docker run：init](https://docs.docker.com/reference/cli/docker/container/run/#specify-an-init-process)
- **停止信号**：Linux 对 PID 1 的默认信号行为有特殊处理；未编写相应处理逻辑时，不能假定其会响应 `SIGTERM` 退出。容器默认停止信号为镜像指定值或 `SIGTERM`，超时后强制 `SIGKILL`。[docker run：PID 1、停止信号与超时](https://docs.docker.com/reference/cli/docker/container/run/)
- **Docker restart 范围**：容器随根进程退出而结束，`--restart` 围绕容器退出/停止生效；具体行为取决于策略，人工停止也有例外。它不是任意业务子进程的独立重启策略。[docker run：进程退出](https://docs.docker.com/reference/cli/docker/container/run/#detached-mode--d---detach)、[restart](https://docs.docker.com/reference/cli/docker/container/run/#restart-policies---restart)
- **原生依赖边界**：Node-API 提供跨 Node 版本的 ABI 稳定性；取得该保证要求仅使用 Node-API，并另查外部库兼容性。Node C++、V8、libuv API 没有跨 Node 主版本的同等保证；不能泛化为所有 `.node` 模块跨版本通用。[Node-API：ABI 稳定性的边界](https://nodejs.org/api/n-api.html#implications-of-abi-stability)

### 对给定方案的推论（设计条件，尚未实测）

- **总体可行性**：一个容器可同时承载常驻 HTTP 更新管理父进程和业务 Node 子进程；父进程独立停启业务。该方案具备官方进程模型依据，具体 Javdex 适配仍待实现与验证。
- **生命周期**：可采用 `init(PID 1) → 管理父进程 → 业务 Node/worker`；父进程处理停止信号、向业务进程树传递退出请求、等待退出与回收，并协调超时终止。仅加 `--init` 不等于完成这套监督逻辑。
- **崩溃恢复**：容器内监督器可以处理业务崩溃、限制重启频率，并区分计划停机与意外退出；父进程存活时更新端口可以继续服务。父进程/容器退出后的恢复交给 Docker restart，二者管理层级不同。
- **业务更新包**：采用签名的完整发行目录，包含 JS、worker、Web 和目标 Linux 架构原生依赖；校验签名、内容及兼容条件后，停止旧业务、切换版本、启动并检查新业务。完整包与签名是本方案要求，不是 Docker 文档提供的更新能力。
- **兼容检查**：发行包应声明并验证支持的 Node 运行时/原生 ABI 或 Node-API 条件、Linux 架构、libc 类型及外部动态库要求。即使使用 Node-API，也不能由其 ABI 保证推出 glibc/musl、不同架构或任意系统库可以互换。
- **持久化**：版本目录、当前指针、快照和更新日志应放入命名卷或明确的 bind 挂载；在独立版本目录准备发行包，切换当前指针，并记录阶段以支持中断后恢复。这是设计建议，单靠指针切换不能保证数据库恢复一致性。
- **恢复承诺**：保留旧发行目录可支持程序回退；数据库迁移后的恢复需配套快照与明确恢复范围。业务启动失败、更新中断与恢复失败的处理仍需实测，不能承诺切回旧代码即完成数据回滚。
- **外壳维护**：固定镜像中的管理器、Node、glibc 和 OS 基础环境仍需定期换镜像。另行把 Node 运行时纳入签名包可以扩大更新范围，但仍需匹配系统库；业务包不承担 OS 基础环境更新，不能据此长期冻结基础镜像。

### 结论与验证边界

“只留一个容器”可以作为候选架构：更新时保持管理父进程和 HTTP 端口存活，只替换业务发行目录与子进程；这些操作不需要 Docker socket 或 Docker-in-Docker。
这一结论是官方进程模型与 Node 兼容约束下的设计推论，不代表现有 Javdex 已实现或该组合已通过验证。

后续最小验证应覆盖：信号贯穿父子进程与 worker、僵尸回收、计划停机期间端口可用、业务崩溃监督、目标架构原生依赖加载，以及更新中断后的指针/快照/日志恢复。
本轮仅追加本节，保留原文；未修改实现、启动应用或容器，也未提交或推送。

### Javdex 源码结论与方案收束

- **发行目录可作为启动单位**：[构建脚本](../scripts/server-build.mjs) 已打包 `index.js`、`webCatalogWorker.js` 与 Web；[应用版本](../apps/server/src/appVersion.ts)、[runtime](../apps/server/src/runtime.ts) 的 worker 和[入口](../apps/server/src/index.ts)的 `defaultStaticRoot` 相对发行目录读取，现有停机流程排空 HTTP、worker、SQLite。这些结论支持进一步验证发行目录子进程模型。
- **包内容仍需补齐**：`better-sqlite3`、`sharp` 仍为 external，当前由镜像执行 `npm install`；应用发行包必须另行交付与外壳运行时兼容的目标 Linux 架构原生依赖，现有 JS/Web 打包结果本身不足以充当完整包。
- **执行器与合同需要改造**：现有更新 manifest 绑定 Docker digest/`imageId`，`dockerDeployment` 依赖 `docker exec/run/compose` 完成备份、停机与切换。单容器方案需改为进程/文件执行和发行包合同，不能仅把现有助手移进业务容器。
- **复用范围按语义评估**：客户端流程、签名思想、续传、持久任务、待验证屏障及提交前快照恢复语义可以作为复用基础；不承诺现有 manager 原封不动复用。
- **两层更新**：应用发行包更新通过业务停机、切换目录、重新启动完成，并非热更新；固定运行外壳镜像更新承担管理器及固定 Node/OS 环境升级。以上属于方案论证，未改实现、未实测或验收。
