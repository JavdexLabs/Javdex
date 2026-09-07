# NFO 导出兼容性

本文记录 Javdex 一次性 NFO 导出的公开 profile、固定验证基线和已知边界。导出入口位于“设置 → 存储与导出 → 导出影片资料”；它生成当前资料的旁路文件快照，不建立同步关系。操作步骤见 [使用指南](USER_GUIDE.md#利用本地-nfo-导入与导出资料)。

> 发布状态：五个 profile 的 XML golden 与格式合同自动化已经通过；Jellyfin、Emby、Plex NFO Agent、Stash 与 Serviio 的固定版本消费端 smoke 已完成。按产品决策，Infuse、VidHub、Nova 与 Zidoo 不要求专有客户端或设备端 smoke，其证据等级明确标为公开格式合同。

## Profile 与输出差异

| Profile | 基线 | XML 策略 | 图片布局 |
|---|---|---|---|
| `portable-v1` | Kodi 通用电影 NFO 子集 | `uniqueid/id/num`、常用影片字段、`tag`、演员及可选本地图片引用 | `<stem>-poster`、`<stem>-fanart`；可选样张文件 `javdex-samples/<stem>-NNN` |
| `jellyfin-current` | Jellyfin Server 10.11.11 | Kodi 电影字段，标签写为 `genre`，保留结构化 ratings 与站点身份 | 通用布局 |
| `emby-kodi-conservative` | Emby Server 4.9.5.0；`NfoMetadata` commit `965f6029` | 只写 Emby/Kodi 都有稳定证据的保守子集；不写 ratings 和额外站点身份 | 通用布局 |
| `plex-nfo-1.43.1+` | Plex Media Server 1.43.1+ 官方 NFO Agent | 官方表列出的 Kodi/XBMC 字段、set、identity 与 IMDb/TMDb/TVDb ratings；其它评分来源不写入并在计划中提示 | 通用布局；样张仍可复制但不写 NFO 引用 |
| `infuse-current` | Infuse 8.5.3 | 收窄的常用本地 metadata 字段 | 封面 `<stem>.<ext>`，背景 `<stem>-fanart.<ext>`；样张不写 NFO 引用 |

Plex profile 只面向官方 NFO Agent，不支持默认 Plex Movie Agent；使用该 Agent 的库不能使用 Plex 的观看状态与评分同步。Infuse 必须启用本地 metadata，UPnP/DLNA 连接不支持本地覆盖。

## 演员头像

选项默认关闭，演员名单始终导出。勾选后，将当前演员头像保存到 `.actors/<演员名>.<ext>`，文件名中的普通空格替换为下划线，继续处理文件名非法字符；例如 `Alice Smith` 写为 `Alice_Smith.jpg`。NFO 姓名保持原文，`actor/thumb` 指向实际文件。归一化后同名冲突按既有机制拦截，相关头像不写入且不引用；同目录相同头像去重，跨影片目录会保存副本。

该布局面向 Javdex 回读和 Kodi / Emby 本地演员头像。Emby 旧库可能需要完整元数据刷新；Plex、Infuse、Jellyfin 对当前本地相对路径的兼容性尚未实机验证，不能承诺显示。依据见 [头像研究](NFO_ACTOR_ARTWORK_RESEARCH.md)。Javdex 保留原文件名和下划线文件名的导入兼容，优先读取 NFO 明确引用；新导出不自动删除此前含空格的头像文件。

## 附带样张文件（备份/迁移）

所有 profile 的样张选项默认关闭，勾选后将文件写入 `javdex-samples/<stem>-NNN.<ext>`。NFO 不引用样张，`fanart` 仅引用独立详情背景；不承诺播放器样张画廊。独立目录避免像旧 `extrafanart` 一样被播放器自动当成共享背景读取。

Javdex 导入时优先按影片文件名前缀读取此目录中的样张，保持自然编号顺序，不混入背景或旧目录副本。无新备份样张时继续兼容旧 `extrafanart` 和 NFO 图片引用。新导出不会迁移或删除旧文件；若播放器仍显示旧样张背景，需要自行检查以前的 `extrafanart` 文件及旧 NFO/图片缓存。此次是图片附件功能，不是完整资料库备份或同步。

## 封面导出更新（2026-09-05）

勾选影片封面后，JPEG/PNG 横图先校正 EXIF 方向，再从右侧裁剪最大整数 2:3 海报，完整原图以 `<stem>-landscape.<ext>` 保留。已有竖图保留原比例，只导出海报；正方形保留并提示。PNG 海报继续使用 PNG，JPEG 使用 JPEG；不放大、不拉伸，不修改数据库或原资产。详情背景仍独立使用 `fanart`。

通用/Kodi、Jellyfin 和 Emby profile 增加 `aspect="landscape"` 引用；Plex 与 Infuse 沿用其 poster 合同，保留的完整横图不代表消费者一定独立展示。Kodi 推荐 16:9 landscape，而封套保留原比例。当前 Electron 43.4.1 的 nativeImage 实测不能解码 WebP：与损坏图片一样在规划阶段标为不可用，不写错误 poster 引用；未来运行时能解码时沿用 JPEG 转码。裁剪失败但横图可读取时仍保留横图。

本次通过合成图片的真实 Electron 编解码、八种 EXIF 方向、加密资产、不可变计划与 XML golden 回归验证。下方消费端 smoke 属于此前版本，**未重新验证此次新增双图在消费端的显示效果**。旧横版 poster 需显式选择覆盖并刷新消费者图片缓存；默认跳过不会更新它。

## 固定版本消费端 smoke

2026-09-05 在 Apple Silicon / Colima 中，以本页 golden NFO 和自建测试媒体执行了固定版本消费验证。Jellyfin、Emby、Plex 与 Serviio 使用隔离服务器媒体库，以扫描后的 API 或索引日志读回为准；Stash 则直接执行固定 commit 的生产 `NfoParser`，证据等级在对应行单独说明。

| 消费端 | 固定构建 | 结果 | 实际读回合同 |
|---|---|---|---|
| Jellyfin | 10.11.11；官方 arm64 镜像 `sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db` | 通过 | `MovieNfoProvider` 读取同名 NFO；标题、原标题、简介、首映日、类型、厂牌、演员、导演、`num`/IMDb identity 与默认结构化评分均由 API 读回。媒体时长按消费者规则由实际视频覆盖 NFO。 |
| Emby | 4.9.5.0；官方 arm64 镜像 `sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a` | 通过 | 同名 NFO 的标题、原标题、简介、首映日、类型、厂牌、演员、导演与主 identity 均由 API 读回；保守 profile 未写入的 ratings 和外部站点 identity 没有意外出现。媒体时长由实际视频覆盖 NFO。 |
| Plex NFO Agent | PMS 1.43.3.10896-cb3ebc72d；官方 arm64 镜像 `sha256:d9396113418e56a1d3e3c1b8ce3f34cf271b19af3df05d5a76b8d950313a5661` | 通过 | 在未认领的隔离库中，以官方 1.43.1.10512-0703a193b NFO provider 定义启用当前稳定版自带解析器；API 读回标题、原标题、简介、厂牌、首映日、类型、导演、演员、海报、背景、`num`/IMDb identity 与 IMDb 结构化评分。`set` 被解析为 collection tag 并关联影片；JavDB 评分来源不会被该解析器接纳，因此 profile 只写受支持来源并对省略字段告警。 |
| Stash `nfoSceneParser` | CommunityScripts commit `be7e8b482f25801d9190e9d29723f21eb35edc3b` | 通过 | 直接执行该 commit 的 `NfoParser` 解析通用 golden，读回标题/简介、厂牌、日期、导演、演员、标签、系列、评分与主 identity；插件按其既有优先级选择 `originaltitle` 作为 scene title。 |
| Serviio | 2.5 rev `9dd1f958000596969f215c26a29e3ccf0e5233fc`；官方 Linux 包 MD5 `f2f0df3acfef6f093984dcf5bc6303ed` | 通过 | 配置 `descriptiveMetadataExtractor=XBMC`、关闭网络描述 metadata 后扫描只读媒体目录；REST `library-status` 和索引日志均读回 NFO 标题 `Title & More`。 |

Jellyfin、Emby、Plex 与 Serviio 的扫描都关闭网络 metadata provider，以确认读回值来自本地 NFO；媒体目录以只读方式挂载，验证过程没有回写或修改 fixture。Plex 当前未认领镜像隐藏可选 NFO agent group，因此测试只在临时数据库中注入同一官方预览构建的 provider 定义；解析和读回均由固定的当前稳定版 PMS 二进制完成，未连接用户账号或修改真实 Plex 资料库。

## 专有客户端与设备端格式合同

以下对象不属于 V1 实机验收门槛，也不标记为消费端 smoke 通过。它们用于约束 profile 的字段与命名，不承诺对应版本的 UI 展示或扫描缓存行为。

| 消费端 | 合同基线 | 证据等级 | 已固定合同 |
|---|---|---|---|
| Infuse | 8.5.3；官方 Local Metadata 文档 | 公开格式合同 | `infuse-current` 使用同名封面、同名 NFO 和收窄的本地 metadata 字段；未在 Infuse 客户端运行。 |
| VidHub | 官方同名 NFO 与传统本地图片约定 | 公开格式合同 | 使用 `portable-v1` 的 exact-stem NFO 和通用图片命名；未在 VidHub 客户端运行。 |
| Nova | 6.4.37 所引用 MediaLib commit `fba68119be9b704bfa0cad78f7ca8422df0e5cfb` | 固定源码格式合同 | `portable-v1` 保持在该 Kodi parser 子集内；未在 Android runtime 运行。 |
| Zidoo | 公开 Kodi NFO 约定（2026-09-05 核对） | 公开格式合同 | 使用 `portable-v1` 的 Kodi 电影字段与通用图片布局；未在 Zidoo 设备运行。 |

## 自动化证据

- `nfoExportProfiles.test.ts` 固定五份完整 XML golden，并对每份输出做独立 XML 解析和 Javdex importer round-trip。
- `nfoExportModule.test.ts` 固定 exact-stem NFO、通用/Infuse 图片名、样张、演员头像和 NFO 相对引用的目录合同。
- 各消费端公开格式所需字段和命名统一由 `nfoExportProfiles.test.ts` 的完整 golden 与 profile 差异断言约束，不再另设重复的输出子集测试；这些检查不是消费端 smoke。
- 通用 profile 以 VidHub 的同名 NFO/传统图片约定、Nova 6.4.37 的 Kodi parser 子集、Stash CommunityScripts `nfoSceneParser` 的 Kodi Movie 映射、Zidoo 的 Kodi NFO 约定和 Serviio XBMC NFO 约定为格式目标。

上述自动化是可重复的格式合同验证，不冒充各消费端 UI 的端到端测试；只有“固定版本消费端 smoke”一节明确标为“通过”的真实消费端导入才构成固定版本 smoke 证据。具体客户端的扫描缓存、库设置和 UI 展示仍由对应产品版本决定。

## 内容与安全边界

- NFO 不包含 Javdex 数据库自增 ID、个人评分、观看状态、播放次数或最近播放时间。
- 只使用影片番号和已有站点身份；不生成持久 export UID 或 manifest。
- JPEG/PNG 保留原始编码；WebP 转为固定质量 JPEG，不放大图片。
- 图片只经 `MediaAssetStore` 公共读取面读取，明文与加密资产使用同一导出路径。
- 默认跳过已有文件；覆盖只作用于不可变计划列出的文件。执行会重新校验来源快照、媒体根边界和目标 hash/mtime。
- 单项失败不回滚已经原子完成的文件；终止只发生在文件项之间。

## 已知限制

- V1 不输出 `movie.nfo`、目录媒体 NFO、用户状态、独立导出目录或后台任务。
- 同一全局影片的每个本地资源分别导出；普通 HTTP、网页、Magnet、ED2K 等无本地锚点资源会跳过。
- 不保存 NFO 关联或上次导出状态，因此没有自动撤销、恢复、增量更新或静默安全覆盖。
- 消费端可能缓存旧 metadata；需要在目标产品中按其文档刷新或重新扫描。

证据来源：[Jellyfin NFO](https://jellyfin.org/docs/general/server/metadata/nfo/)、[Emby NfoMetadata](https://github.com/MediaBrowser/NfoMetadata/tree/965f602939810b845a08548fe96ff10667762633)、[Plex NFO Metadata](https://support.plex.tv/articles/using-nfo-metadata-files-with-plex/)、[Infuse Local Metadata](https://support.firecore.com/hc/en-us/articles/4405042929559-Overriding-Artwork-and-Metadata)、[Nova NFO parser](https://github.com/nova-video-player/aos-MediaLib/blob/v6.4/src/com/archos/mediascraper/NfoParser.java)、[Stash nfoSceneParser](https://github.com/stashapp/CommunityScripts/tree/main/plugins/nfoSceneParser)。基线核对日期：2026-09-05。
