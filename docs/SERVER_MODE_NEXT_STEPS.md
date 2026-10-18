# 服务端模式当前状态与后续范围

0.9.0 已正式发布，资料库 schema 21、桌面云端模型文档格式 4。原始发行与随后一次授权的整套替换分别保留在[发布记录索引](reviews/README.md)，当前公开源码和 CI 证据见 [Whisper Vulkan 迁移审计](reviews/whisper-vulkan-runtime-migration.md)。

独立 Node 宿主、桌面远程模式、C1–C7、备份恢复和单容器托管更新均已落地，不再作为待实施计划。当前部署和用户操作以文档站为准；历史 S13 全矩阵及未覆盖平台仍保留原范围，发布成功不等于所有 GUI、硬件或故障场景已经验收。

## 托管更新与升级边界

官方容器入口是常驻管理进程，监督非 root 业务子进程。桌面通过统一 HTTPS 地址和设备配对提供当前客户端版本的在线准备、单文件离线续传和停服确认。`/program` 持久保存当前/上一版业务、发行选择、配对凭据、任务日志；升级不创建资料库备份，安装开始后失败或中断保持维护并要求人工恢复，提交后只继续激活。重要资料先使用与当前服务端版本一致的客户端，通过现有备份功能保存。无需宿主机助手或 Docker socket；管理器、Node 与系统维护仍通过替换镜像完成。合同入口见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md#托管更新)，决策见 [ADR-0031](adr/0031-manage-server-releases-inside-one-container.md)。

- 0.8.0 镜像没有托管更新能力。首次采用 0.9.0 须先正常停服、完整备份并更换基础镜像，增加独立 `/program`，配置统一 HTTPS 入口；空程序卷直接采用镜像种子，首次数据库迁移不自动生成托管升级快照。
- 已有托管程序卷时，同运行环境的较新镜像业务版本在启动时复用停服、安装、验证与提交事务，不复制整库或自动回退资料；相同或更旧版本不替换。失败按镜像发行摘要记录，不随重启反复尝试，也不覆盖已准备的客户端任务。首次空卷仍须人工备份已有旧资料库。`token` 通过 `/opt/javdex-manager/index.js` 生成一次性令牌，桌面填写统一 HTTPS 地址并授权。宿主合成进程测试不等于双架构 Docker 验收。
- 在线检查固定读取当前客户端版本的 Release tag（含预发布）；在线及离线安装目标均须与客户端版本完全一致。不兼容旧管理器。SemVer 同版本/降级、错误架构、未知签名、过期清单、运行环境不符及不受支持的 schema 路径继续被拒绝，旧分离格式没有兼容入口。
- 正式 0.8.0 为 schema 19，0.9.0 为 schema 21。未发布/不完整开发快照仍被迁移守卫拒绝；回退须恢复升级前完整备份和匹配程序，不能手改 `user_version` 或清空程序卷。模型管理文档版本 4 是桌面配置格式，不能当作数据库版本或服务端协议版本。

## 当前功能与后续范围

| 范围 | 代码现状与后续边界 |
|---|---|
| 远程资料与 C1–C7 | 已接线；重命名、队列定位、精确查询、审计、来源、单条/批量采集及清单链接以 [合同](SERVER_MODE_CONTRACT_INVENTORY.md) 为准，没有待实施的 C1–C7 任务 |
| Agent 与工作存储 | 插件、模型、浏览器会话、草稿和运行记录留在桌面；服务端仅做权威预览、正式应用或待确认存储，不部署 Agent runtime |
| 资料库转移 | 统一使用桌面备份恢复/本机导入；旧 `migrate-auth`、`migration.*`、专用迁库包已移除，不再计划其 UI 或兼容入口 |
| 恢复与升级 | 现行备份恢复、托管更新恢复需分别验收；历史迁库脚本的通过数量不可沿用 |
| 架构与完整矩阵 | 仍有宿主装配与单例入口，历史 S13 的 M01–M15 / D01–D07 未因定向测试自动闭合；按实际缺口继续验证 |
| 跨平台证据 | 正常发布 CI 与独立安装／GUI／硬件验收分别记录；当前公开软件未另做独立产物下载验收，不以源码构建或历史候选结果补足该阶段 |
| 固定产品边界 | 可信局域网、多可信设备同权限、无资料库同步、服务端无转码；远程不提供本机目录操作、根重绑、图片加密或目录搬迁 |

## 验证入口与证据边界

从仓库根目录按改动运行。`npm ci` 不隐式准备 Electron；服务端专用检查不要先执行 `setup:desktop`，桌面测试/打包则需要它。下表是验证入口，不是本次执行结果。

| 命令 | 用途与环境要求 |
|---|---|
| `npm run typecheck` / `npx tsc --noEmit -p tsconfig.server.json --composite false` | 桌面/Web 与服务端类型 |
| `npm run pretest` / `npm test` | 静态检查与桌面测试；后者先准备桌面原生依赖 |
| `npm run server:build` | Web、`out/server`、`out/updater` 与生产依赖闭包 |
| `npm run server:test` / `npm run server:updater:test` | 真实查询 worker、业务隔离与更新安全/恢复测试；跳过项不计通过 |
| `npm run test:ui:server-update` | 更新配对、确认、进度与错误界面；需要浏览器 |
| `npm run server:smoke:node` | 宿主 Node 生产检查，不替代容器验收 |
| `npm run server:smoke` | Docker 生产镜像检查，先构建 `out/server` 与 `out/updater` |
| `npm run server:updater:smoke` | Linux Docker、真实原生依赖与 schema 19→21 合成签名更新、较新镜像升级及同／旧版保留、统一 HTTPS 配对与单设备撤销；先构建，不是实际发布附件或线上更新验证 |
| `npm run server:smoke:backup` | 独立 Docker 容器/卷验证双向恢复及桌面导入；先构建桌面导出 worker 和服务端镜像 |
| `npm run smoke:same-version-install` | 同提交 Linux 桌面包与服务镜像；需 Docker、`out/server` 和 `dist/` Linux 产物 |

Linux amd64/arm64 更新烟测已在 PR 与 Release 工作流中配置，最终运行状态须单独核对。缺少 Linux、Docker 或产物应失败，宿主合成测试不冒充容器验收。Cloud Docker 与构建前置条件见根 [AGENTS.md](../AGENTS.md)。0.9.0 的实际 Release CI、双架构容器和 Windows 测试见 [迁移发布审计](reviews/whisper-vulkan-runtime-migration.md)，不将历史通过次数或托管 CPU 烟测推广为完整 GUI、物理 GPU 或独立产物验收。

## 文档入口

当前操作见 [部署说明](SERVER_MODE.md) 与 [服务端更新](SERVER_UPDATE.md)，合同与代码导航见 [实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md)，正式发布与同版本替换见 [发布记录索引](reviews/README.md)，早期阶段要求与证据见 [历史归档索引](archive/server-mode/README.md)。审计与归档中的版本、旧命令、授权和环境仅适用于各自记录，不能解释为本次发布授权或验收结论。

早期 PR #115、旧迁库与平台实施记录见 [早期实施与验证](archive/server-mode/POST_IMPLEMENTATION_VERIFICATION.md)。其中旧命令不用于当前部署，也不构成继续发布的授权。
