---
title: 服务端开始使用
description: 使用单个 Docker 容器，把资料库放在 NAS 或常开设备上。
---

服务端保存正式资料和图片，扫描已配置的媒体目录，并向局域网浏览器提供只读访问。桌面关闭后，服务端扫描和网页访问仍可继续。

资料管理使用同版本桌面应用。刮削插件、AI、浏览器会话和采集草稿仍在桌面运行；服务端不提供网页编辑后台、无人值守云端刮削或视频转码。

## 首次部署

1. 核对[目标 Beta.4 Release](https://github.com/JavdexLabs/Javdex/releases/tag/v0.9.0-beta.4)的实际产物，准备 Docker 与 Compose 插件；[默认下载](/Javdex/download/)仍只跟随正式版。
2. 按 [Docker Compose 部署](/Javdex/server/deploy/)保存同版本示例，设置数据卷、媒体挂载和账号。
3. 按[配对说明](/Javdex/server/pairing/)在服务端运行 `pair`，在桌面粘贴一次性信息，一次保存统一地址、证书与资料管理／更新授权。
4. 重启桌面，再创建媒体库并扫描；添加其他电脑时重新生成一份配对信息。

已有 0.8.0 部署先读[首次采用托管更新](/Javdex/server/adoption/)，不要把后续升级包当作旧容器的安装器。

## 部署前必须了解

- 独立持久保存 `/data`、`/program` 和媒体挂载；不要运行 `docker compose down -v`。
- 媒体目录需要业务进程可读写，`/data` 可写不表示媒体目录可写。详见[存储与权限](/Javdex/reference/server/)。
- 新部署的业务、播放与更新共用一个 HTTPS 地址和每台电脑独立的可信设备授权；只在可信局域网或私有网络开放。旧双端口部署的独立授权流程见[配对说明](/Javdex/server/pairing/)。
- 更新会中断访问与播放，并非不停机热更新。先了解[恢复边界](/Javdex/server/recovery/)。

## 使用之后

[升级文件与两层更新](/Javdex/server/update/) · [备份与恢复](/Javdex/guide/backup/) · [网络与凭据](/Javdex/reference/server/) · [源码构建](/Javdex/developers/server/)
