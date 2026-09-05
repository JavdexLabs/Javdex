# NFO 导出图片的消费端规范核查

核查日期：2026-09-05。范围：电影本地图片与 NFO 图片引用；本次仅研究，没有在这些播放器内执行导入测试。

## 结论

把完整横版封套直接当作 poster，不能保证在竖版电影卡片中正常显示。建议将导出海报与原始封面分开：横图另生成 2:3 竖版海报，同时保留横图；原图已为竖版时只输出海报。2:3 有多个官方来源支持，但“裁右侧”是本产品针对封套布局的策略，不是播放器规范。

横版封面也不能直接等同于 fanart。Kodi 的 landscape 是带文字的横版浏览图，fanart 是背景图；两者规范比例均为 16:9。完整封套常常不是 16:9，因此“原比例保存为 landscape”是保留原图的兼容折中，不能称为严格遵循画幅规范。若以后要求所有横图严格 16:9，需要额外决定留边或裁切策略。来源：[Kodi Artwork types](https://kodi.wiki/view/Artwork_types)。

## 消费端对照

`stem` 表示视频文件名去掉扩展名；以下选取有证据的名称，不是完整别名列表。

| 消费端 | 竖版海报 | 横版浏览图 | 背景图 | 依据与限制 |
| --- | --- | --- | --- | --- |
| Plex | `stem.jpg`；独立电影目录中的 `poster.jpg` | 未找到电影独立 `landscape` / `thumb` 本地类型的官方保证 | `stem-fanart.jpg`；独立目录中的 `fanart.jpg` / `background.jpg` | [电影本地资源](https://support.plex.tv/articles/200220677-local-media-assets-movies/)列出海报 1:1.5、背景 16:9；不要把电视剧集缩略图支持推到电影横版封面 |
| Kodi | `stem-poster.jpg` | `stem-landscape.jpg` | `stem-fanart.jpg` | [来源设置](https://kodi.wiki/index.php?title=Adding_video_sources)规定是否使用独立电影目录会影响短名称/长名称查找；[图片类型](https://kodi.wiki/view/Artwork_types)给出 poster 2:3、landscape 16:9 |
| Jellyfin | `poster.jpg` / `stem-poster.jpg` | `landscape.jpg` / `thumb.jpg`，也可使用视频名前缀 | `fanart.jpg` / `backdrop.jpg`，可使用视频名前缀 | [Movies](https://jellyfin.org/docs/general/server/media/movies/)将 poster 映射 Primary，将 landscape/thumb 映射 Thumb，将 fanart 映射 Backdrop；Thumb 用于首页或缩略图浏览 |
| Emby | `stem-poster.jpg` / `poster.jpg` | `stem-landscape.jpg` / `stem-thumb.jpg` | `fanart.jpg` / `backdrop.jpg` | [Movie Naming](https://emby.media/support/articles/Movie-Naming.html?q=movie)明确 Thumb 别名；不在独立目录的电影应使用包含视频名的形式；[图片类型](https://support.emby.media/support/articles/Image-Editing.html)区分 Primary、Thumb、Backdrop |
| Infuse | `stem.jpg` | 官方覆盖指南未给出电影独立 landscape 文件名 | `stem-fanart.jpg` | [覆盖图片和元数据](https://support.firecore.com/hc/en-us/articles/4405042929559-Overriding-Artwork-and-Metadata)推荐海报 1:1.5，并列明这两种电影图片名；本地覆盖需要开启相关选项，UPnP/DLNA 不适用 |

不要为同一兼容目标同时写多份同内容的 `poster`、`cover`、`folder`：名称越多越容易让消费端选到旧图。按现有导出 Profile 的已验证名称输出竖版海报即可；横图优先考虑通用的 `landscape` 名称，而不是再作为备用 poster。

## NFO XML 引用

### Kodi

电影 NFO 文档明确列出 `<thumb aspect="poster">`、`<thumb aspect="landscape">` 以及 `<fanart><thumb>…</thumb></fanart>`。使用本地图片时，文档说明无需依赖 NFO 中的图片标签。`<thumb>` 是 XML 元素名，不能由此推导电影本地横图应命名为 `thumb.jpg`；Kodi 图片类型正文将视频库的该本地类型主要限定为剧集图片。来源：[NFO files/Movies](https://kodi.wiki/view/NFO_files/Movies)、[Artwork types](https://kodi.wiki/view/Artwork_types)。

因此通用/Kodi 输出可表达三个独立角色，但本地文件名仍是重要消费入口。相对引用是否在每个客户端与版本中按同样方式解析，不能仅凭 XML 格式相似作保证。

### Jellyfin

[官方 NFO 文档](https://jellyfin.org/docs/general/server/metadata/nfo/)说明支持图片路径/URL，同一 artwork 类型只使用第一个 thumb，NFO 图片优先于远端提供器和目录图片。

另核查了 [BaseNfoParser.cs](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs) 的 `FetchThumbNode` 与 `GetImageType`：`landscape` 映射 Thumb；`fanart` 映射 Backdrop；未知 aspect（包括 `thumb`）默认 Primary。它还使用 `UriKind.Absolute` 解析地址，普通相对文件名可能被忽略。因此不宜新增 `<thumb aspect="thumb">`，也不能依赖相对 NFO 引用替代本地标准命名。源码为核查日的 master，不代表全部已发布版本。

### Plex

Plex 已有官方 NFO Agent。官方指南要求 Plex Media Server 1.43.1 或更新版本，并选择 Plex NFO Movie；电影示例包含 `<thumb aspect="poster">` 和 fanart，且本地图片优先于远程图片 URL。故不能沿用“Plex 不支持 NFO”的旧说法。来源：[Using NFO Metadata Files with Plex](https://support.plex.tv/articles/using-nfo-metadata-files-with-plex/)（页面标注更新于 2026-07-14）。

但该文档的“poster 或其他 artwork URL”并未给出独立 movie landscape 类型、相对路径解析、任意 aspect 的完整契约。当前有证据保障的是标准本地海报/背景命名，不能承诺 Plex 会展示额外保存的横版封套。Plex 本地图片支持与是否选择 NFO Agent 是两个不同问题。

### Emby / Infuse

Emby 官方人员在 [NFO 本地图片路径讨论](https://emby.media/community/topic/78541-can-i-only-use-local-images-path-within-nfo-files-for-posterfanartactors-thumb/)中说明当时不读取 NFO 图片路径，最后一次相关答复为 2024-08-28；这只能作为历史兼容边界，不能证明所有未来版本均不支持。本轮未找到更新的官方正向契约，应以标准本地命名作为兼容依据。

Infuse 的[官方指南](https://support.firecore.com/hc/en-us/articles/4405042929559-Overriding-Artwork-and-Metadata)说明电影 NFO 常见元数据标签支持，但未提供所有 artwork aspect 与相对图片路径的契约；它明确列出的本地海报和背景文件名应优先使用。通过 Plex/Emby/Jellyfin 连接时，不能把直接文件分享的覆盖规则自动等同于服务端图库图片行为。

## 对本项目方案的约束

1. 根据实际图片方向决定输出；2:3 海报不要通过拉伸实现。原图已是竖图时是否保持非 2:3 原比例，是“保留原图”的产品选择，不能承诺所有客户端不再裁切。
2. 横图生成竖版海报后，不要仍将横图写为其他 poster 候选，也不要覆盖已有独立背景图。保留横图用 landscape 角色最贴近通用消费者的语义，但完整封套原比例与标准 16:9 的差异应写清楚。
3. 通用/Kodi、Jellyfin、Emby 可优先采用 `stem-landscape`；Plex/Infuse 可保存同名横图供保留或其他软件消费，但不承诺本客户端使用它。
4. 旧导出可能已经生成了横版 poster；默认跳过策略不会修复它。再次导出需在预览中明确旧 poster 将被覆盖，并在消费端刷新/重新选择图片。不能暗中删除全部旧图片来强制更新。
5. 实测应分别覆盖新导入和覆盖旧 poster、独立目录和同目录多电影、横图与竖图、NFO 图片引用与标准命名兜底。文档研究不替代消费端导入验证。
