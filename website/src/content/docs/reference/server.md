---
title: "网络、版本与存储权限"
description: "Javdex 0.9.0-beta.7 · 网络、版本与存储权限"
---

服务端必须配置 HTTPS 格式的 `JAVDEX_PUBLIC_URL`。公共入口在同一端口（默认 8096）支持 HTTP 和 HTTPS：HTTPS 提供全部功能；HTTP 仅提供网页、网页登录与配对、只读浏览、图片及浏览器播放和下载。桌面客户端的连接、授权、资料管理、原文件播放及更新仍强制 HTTPS，HTTP 不开放这些接口。业务进程仅监听容器回环 8098，不能发布该内部端口；未配置公共地址或仍配置独立更新入口时启动会报错。

同一主机的 HTTP 和 HTTPS 网页共用登录 Cookie 与会话，跨协议仍保持登录，退出或撤销授权会同时失效。Web Cookie 保留 `HttpOnly`、`SameSite=Strict` 和有效期，不设置 `Secure`；不迁移已有 Cookie。入口仍只用于可信局域网，HTTP 流量未加密，不要映射公网。桌面首次自动保存证书；合法公开证书更换无需确认，自签名证书变化需用户确认。浏览器通过 HTTPS 访问时需单独信任自签证书。可信客户端凭据与网页 Cookie、播放 grant 各自隔离，不写入日志或分享链接。

同端口双协议需要包含本次实现的基础镜像；环境版本保持 1，不提供旧 Beta 管理器兼容。业务 `.javdex-update` 不能更新镜像内的管理器。只需发布公共端口一次，`JAVDEX_PUBLIC_URL` 继续填写 HTTPS 地址，网页访问入口会同时列出同端口的 HTTP 和 HTTPS 地址。

`play.grant` 生成的资源地址固定有效 12 小时，持有者在期限内可读取对应资源。它是能力链接，不是永久媒体地址；不要转发到群聊、公开播放器列表或外部索引。需要立即收回时应撤销相关访问条件或停止服务，不能只等待网页退出。

## 版本

桌面应用、实际运行的服务端业务程序与其网页包必须来自同一源码版本。基础镜像标签只标识运行外壳及初始化种子；以业务握手/更新状态显示的版本为准。握手发现应用版本不一致时，桌面进入版本不符状态，不打开本机权威库，也不自动改连其他地址；已保存的统一设备授权仍可调用跨业务版本的更新协议。

0.8.0 正式资料库为 schema 19，0.9.0-beta.4 首次打开时迁移至 schema 21。模型管理文档版本 4 属于桌面配置，不是数据库 schema 或服务端更新协议版本；模型与凭据配置仍保存在桌面，不随服务端备份转移。升级前另行备份桌面数据目录。

## 存储与进程

- `dataDir`：绝对路径，存放 `library.db`、任务、备份与恢复暂存。不要与 `imagesDir` 设成同一目录。
- `imagesDir`：正式图片目录（默认 `{dataDir}/media_assets`）。
- 桌面远程模式下，“存储与导出 → 图片资源”只读显示服务端当前目录。更改 `imagesDir` 前先迁移现有图片并备份，随后重启服务；切换桌面模式不会移动或覆盖本机图片。
- `mediaMounts`：配置文件中的挂载名 → 绝对目录。扫描与 NFO 只使用这些目录。媒体库来源目录必须满足下述读写权限要求。
- 以专用 UID/GID 运行进程；数据目录与挂载应对该用户可读写。不要用桌面用户数据目录充当服务 `dataDir`。
- 同一 `dataDir` 同时只允许一个宿主进程。

## 媒体目录权限

**服务端媒体库的来源目录必须允许服务进程读写，包括实际使用的子目录及文件。** 即使只计划扫描和播放，首次添加来源目录也需要创建 `.javdex-root` 标记；重命名媒体文件、导出 NFO 和配套图片还会写入媒体目录。部署时不要将媒体库来源配置为只读目录。

- **Docker 挂载权限**：媒体卷使用读写挂载（示例为 `/absolute/path/to/media:/media:rw`），不能设为 `:ro` 或 `read_only: true`。配置文件 `/config/server.json` 的只读挂载可以保留。
- **宿主机文件权限**：读写挂载不会自动授予文件系统权限。还需在宿主机或 NAS 上，让业务进程的 UID/GID 拥有所选目录及其内容的读写权限；业务默认为 `node`（1000/1000），托管镜像由容器内 root 管理进程启动该非 root 子进程，可通过 `JAVDEX_SERVER_UID/GID` 调整。Linux 目录还需要进入/遍历权限（`x`），上级目录也必须可遍历；网络共享需同时检查共享权限和 ACL。
- **分别检查数据与媒体目录**：`/data` 可写并不代表 `/media` 可写。使用挂载下的子目录创建媒体库或恢复目录映射时，也需检查该子目录的权限。

### 业务身份与附加组

容器入口是 root 管理器，实际扫描、播放和资料读写由非 root 业务子进程执行。Compose 的 `user:` 不能代替业务身份配置；`group_add` 只设置容器进程的组，托管管理器降权派生业务时不会自动保留这些附加组。

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `JAVDEX_SERVER_UID` | `1000` | 业务用户 ID，不能为 `0` |
| `JAVDEX_SERVER_GID` | `1000` | 业务主组 ID |
| `JAVDEX_SERVER_GROUPS` | 空 | 显式业务附加组，以逗号分隔数字 GID，最多 64 项；启动和令牌命令使用同一身份 |

`JAVDEX_SERVER_GROUPS` 是本次源码修复新增的配置，需使用包含该修复的**基础镜像**；已发布的 `0.9.0-beta.4` 管理器不支持它。只上传业务 `.javdex-update` 无法更新管理器。修复后的管理器默认清空附加组，仅应用显式配置的组，不自动继承 root 管理进程的组。

例如 `/data` 已由 UID `1000` 持有，而媒体 ACL 授权给 GID `101`，使用包含修复的镜像时可在 Compose 的 `environment` 中设置：

```yaml
JAVDEX_SERVER_UID: "1000"
JAVDEX_SERVER_GID: "1000"
JAVDEX_SERVER_GROUPS: "101"
```

`101` 只是示例，必须替换为 NAS 实际授权组；优先使用只授权所需媒体目录的专用组。已发布 Beta.4 可将 `JAVDEX_SERVER_GID` 设为该授权组作为兼容办法，但需确认改变主组后 `/data` 和图片目录仍可访问。无需为了此问题更换证书或放宽整个媒体目录的权限。修改环境变量后在部署目录执行 `docker compose up -d` 重建容器，保留数据及程序卷；不要使用 `down -v`。

### 排查实际业务进程权限

`docker exec ... id` 显示的是新进程的身份，Docker 可能向它注入 `group_add`；它能读取文件并不证明常驻业务进程也能读取。应检查业务 PID 的 `Uid`、`Gid` 和 `Groups`，其中 `Uid`/`Gid` 四列包含真实、有效、保存和文件系统身份，`Groups` 是附加组。

下面使用默认 `/program` 路径；如修改了 `JAVDEX_RUNTIME_DIR`，相应替换路径。将 `<容器名>` 替换为实际容器名：

```bash
docker exec -u 0 <容器名> node -e 'const fs=require("fs"); const {pid}=JSON.parse(fs.readFileSync("/program/state/business-instance.json","utf8")); console.log("business PID",pid); console.log(fs.readFileSync("/proc/"+pid+"/status","utf8").split("\n").filter(x=>/^(Name|Uid|Gid|Groups):/.test(x)).join("\n"));'
```

若要复现读取问题，使用镜像内 `setpriv` 显式指定同样的 UID、主 GID 和附加组。下面以业务 `1000:1000`、无附加组为例，只检查目录及读取 16 字节，不修改媒体：

```bash
docker exec -u 0 <容器名> setpriv --reuid=1000 --regid=1000 --clear-groups -- node -e 'const fs=require("fs"); console.log({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()}); console.log(fs.readdirSync("/media").length); const fd=fs.openSync("/media/实际影片.mp4","r"); try{console.log("read bytes",fs.readSync(fd,Buffer.alloc(16),0,16,0))}finally{fs.closeSync(fd)}'
```

业务有附加组时，将 `--clear-groups` 替换为实际的 `--groups=101,100`。目录需要读取和遍历权限，文件需要读取权限；`EACCES`/`EPERM` 应核对业务身份、NAS ACL 和共享权限。文件缺失、根目录物理身份变化应分别检查原文件和原挂载。`ls` 显示的 `777` 不能代替 ACL 检查。最终从实际业务接口确认播放授权成功且 Range 请求返回 `206`，再验证客户端画面与扫描。
