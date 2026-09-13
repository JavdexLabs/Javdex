---
status: accepted
---

# 服务端模式扩展 ADR-0024 与 ADR-0027，不改本地原合同

独立 Node 宿主与桌面远程模式是对本地资料库合同的显式扩展，不是放宽本机守卫。

## 与 [ADR-0024](0024-preserve-media-library-root-identity-continuity.md)

本机模式继续按物理目录身份绑定根目录：换卷、同路径替换目录、普通路径编辑都不能悄悄继承原根；取消未完成的路径移除只停用根并保留身份。服务端第一版只用固定挂载标记保护原挂载的卸载与离线，不识别换卷，也不支持更换已绑定挂载目录；离线保留数据，不补建已初始化但丢失的标记。本地根没有 `catalog_root_markers` 行时，不跑服务端标记检查。整库迁移只改写目标环境的挂载选择，目标若是本机模式仍须重新建立 ADR-0024 身份，不能把服务端简化标记策略带回本地。

## 与 [ADR-0027](0027-isolate-read-only-lan-web-access.md)

浏览器只读合同保持：网页仍不能调用桌面 IPC，Cookie 不能授权管理 HTTP、播放授权 GET 或管理图片 GET。服务端新增独立凭据的管理 HTTP 与播放授权，由桌面主进程持有 writer / migration secret，renderer 不得持有。局域网浏览仍走既有只读账号与配对；管理面与浏览面分离。服务端第一版明文图片、无转码、无任意 URL 代理。

## 桌面双模式

同一套管理 UI 经 `CatalogBackend` 访问本机 SQLite 或远程 manage HTTP。远程启动不得打开本机 `library.db`、不得恢复其扫描、不得启动本机网页服务。插件、Playwright、模型、采集 start/plan 与 Electron NFO 封面编码留在桌面。模式切换重启生效，失败不自动回退本地权威库。
