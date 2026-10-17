---
title: "Docker Compose 部署"
description: "Javdex 0.9.0 · Docker Compose 部署"
---

发布流程为 `ghcr.io/javdexlabs/javdex-server` 生成 Linux amd64 和 arm64 镜像，Docker 自动选择架构。部署只需要 Docker 与 Compose 插件，无需安装 Node.js、npm 或编译源码。以下以固定版本 `0.9.0` 为例，以[正式 Release](https://github.com/JavdexLabs/Javdex/releases/tag/v0.9.0)的实际发布状态为准，不使用滚动标签。新程序卷从镜像初始化业务；已有程序卷在镜像业务版本更高时自动升级，相同或更旧时保留当前业务，因此基础镜像标签不能代替实际业务版本检查。

1. 确认目标 Release 可用后，从其发布说明中的对应源码版本链接保存 `deploy/docker-compose.example.yml` 和 `deploy/javdex-server.example.json`，放在同一个目录（保留文件名）。它们不是 Release 附件；不要混用其他分支的示例。在该目录创建 `.env`，填写基础镜像版本号（不含 `v`）；首次部署应与桌面安装包一致：

   ```dotenv
   JAVDEX_VERSION=0.9.0
   ```

2. 编辑 [Compose 示例](https://github.com/JavdexLabs/Javdex/blob/main/deploy/docker-compose.example.yml) 和 [服务配置](https://github.com/JavdexLabs/Javdex/blob/main/deploy/javdex-server.example.json)：
   - 将 `JAVDEX_WEB_PASSWORD` 替换为独立的 12–128 字符密码。
   - 将 `/absolute/path/to/media` 替换为 NAS 上真实媒体目录；这是宿主机路径，容器内统一使用 `/media`。
   - 将 `JAVDEX_PUBLIC_URL` 替换为桌面和浏览器能访问的 HTTPS 根地址，例如 `https://NAS实际IP:8096`。只映射 8096；业务、播放与更新共用此地址，仅向可信局域网或私有网络开放。业务子进程的 8098 仅监听容器回环，不映射到宿主机；统一模式不需要额外填写 `accessHosts`。
   - **服务端媒体库目录必须具备读写权限**。媒体卷使用 `:rw` 挂载，并确保宿主机/NAS 的文件权限允许容器内 `node` 用户读写所选目录及其内容；具体要求见下文[媒体目录权限](/Javdex/reference/server/#媒体目录权限)。
   - 通过 `JAVDEX_SERVER_UID`、`JAVDEX_SERVER_GID` 设置业务子进程身份，默认均为 `1000`。NAS 使用 ACL 授权其他组时，按[业务身份与附加组](/Javdex/reference/server/#业务身份与附加组)配置；仅设置 Compose `group_add` 不会传入托管业务子进程。修改身份前同时检查已有 `/data` 和图片目录的访问权限。
   - `/data` 使用持久数据卷，数据库与图片都保存在其中；不要将 SQLite 数据卷放在 SMB/NFS 共享上。
   - `/program` 使用独立持久卷，保存业务发行选择、更新凭据、任务日志。不要与数据或图片目录互相包含，也不要用 Compose 的 `user:` 覆盖管理进程身份；管理器以容器内 root 启动非 root 业务子进程。

3. 在配置文件所在目录拉取并启动，再查看启动日志：

   ```bash
   docker compose -f docker-compose.example.yml pull
   docker compose -f docker-compose.example.yml up -d
   docker compose -f docker-compose.example.yml logs --tail=50 javdex
   ```

4. 在服务机器上获取一次性令牌：

   ```bash
   docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js token --config /config/server.json
   ```

   在同版本桌面应用打开“设置 → 存储与导出 → 资料库连接”，选择远程资料库，填写 HTTPS 地址并粘贴一次性令牌，点击“完成授权”并重启。令牌有效期 10 分钟；网络中断后在同一电脑粘贴原令牌重试。添加其他电脑时仍运行 `token`，已有电脑继续可用。首次自动保存证书；自签名证书变化需确认，合法公开 HTTPS 证书无需确认。

   桌面按配对指纹验证自签证书，不会全局关闭 TLS 校验。浏览器首次访问可能提示证书不受信任，需由管理员核对并信任证书；网页密码登录仍独立于桌面配对，首次认主前不能浏览资料。

5. 在桌面创建媒体库，在“来源与扫描 → 添加目录”中选择服务端挂载 **`library`**（对应示例 `mediaMounts` 的键）或其中的子目录，然后启动扫描。不要选择桌面电脑的文件夹。
6. 其他设备在浏览器打开同一地址，用配置中的账号密码登录；或在连接服务端的桌面中开启网页配对并批准新设备。远程桌面默认用内置播放器读取服务端授权的原文件流，在此电脑解码；也可在“资料库连接 → 播放器”选择支持网络播放的外部程序。播放运行库和平台要求见 [播放影片](/Javdex/guide/playback/)。网页仍按浏览器原生播放能力选择资源，不支持的文件可下载；服务端不转码。

关闭桌面不会关闭容器。示例已配置 `restart: unless-stopped`，Docker 启动后会恢复非手动停止的容器。服务配置修改后重新创建容器；密码不要提交到公开仓库。完成一次配对后，资料管理与托管更新均已授权，无需另配更新地址。后续可通过已配对入口安装签名 `.javdex-update`，或更换含更高业务版本的基础镜像自动升级；管理器、Node 与系统更新仍须管理员更换基础镜像。

## 连接失败时

| 现象 | 先检查 |
|---|---|
| 浏览器返回 403 | 访问地址是否与 `JAVDEX_PUBLIC_URL` 完全一致，是否来自可信局域网 |
| 连接超时 | 容器是否运行、端口是否映射、防火墙是否允许同网设备访问 |
| 提示尚未认主 | 是否已在桌面领取写入凭据；网页登录不能代替认主 |
| 桌面提示版本不符 | 桌面安装包与服务端是否来自同一源码版本 |
| 添加目录、扫描或导出提示权限不足 | 媒体卷是否为 `:rw`，宿主机/NAS 权限是否允许服务进程读写所选目录及其子目录；详见[媒体目录权限](/Javdex/reference/server/#媒体目录权限) |
| 扫描找不到文件 | 宿主机挂载路径、挂载名称及服务进程是否能访问实际文件 |
| 桌面能浏览但不能播放 | 先查看播放错误详情，检查业务进程是否有权读取实际影片；图片与资料可访问不代表媒体目录可访问，再检查播放授权、网络及客户端解码 |
| 网页能浏览但不能播放 | 先检查媒体请求状态和服务端文件权限；成功返回媒体数据后，再检查浏览器是否支持视频编码。当前不转码，不支持的文件可下载 |
