# NFO 样张导出的消费端核查

核查日期：2026-09-05。本次依据官方文档与固定版本源码，未执行消费端实机导入。范围为影片图片，不包括预告片、视频花絮、章节缩略图。

实现更新：已接受收窄方案。新导出统一使用默认关闭的“附带样张文件（备份/迁移）”，写入 `javdex-samples`，不再在 NFO 中作为背景引用；Javdex 优先回读该目录，继续兼容旧格式。以下外部核查描述变更前的 `extrafanart` 输出，供理解决策；现行行为见 [兼容性说明](NFO_COMPATIBILITY.md#附带样张文件备份迁移)。

## 结论

样张导出有有限价值，但当前不能承诺“在其他软件的样张画廊中展示”。这些格式主要表达额外背景图；能够读取图片与提供样张画廊是两回事。当前最明确可消费现有目录格式的是 Jellyfin，其次是支持旧式 extrafanart 的 Kodi 皮肤。Plex 支持多背景，但现有导出命名没有采用它文档规定的形式；Infuse 没有查到本地多样张导入契约。Emby 支持多背景，但当前样张名超出官方列明的命名形式。

建议保留可选导出、默认关闭，并准确标注“样张（兼容软件中可能作为额外背景）”。Plex、Infuse 若仍保留该选项，应明确只是复制图片，不能用“支持 NFO 样张引用”暗示会显示。产品优先补齐 Javdex 自身可回读的闭环，不应为了使文件被识别而无提示地把全部样张当作默认背景。

## 当前 Javdex 输出

`stem` 是视频文件名去掉扩展名。

- 图片保存为 `extrafanart/stem-001.jpg` 等，序号补零；实际扩展名由源图片/转换策略决定。
- portable、Jellyfin、Emby 将样张加入 `<fanart><thumb>…</thumb></fanart>`，与详情背景合并。
- Plex、Infuse 复制图片但不添加样张 NFO 引用，并产生提示。

代码依据：[nfoExportModule.ts](../src/main/nfo/export/nfoExportModule.ts) 的 `includeSamples` 分支及 [nfoExportProfiles.ts](../src/main/nfo/export/nfoExportProfiles.ts) 的 `supportsSampleReferences`、fanart 渲染逻辑。当前标志最多表示“导出器写入引用”，不能视作消费端完整支持证据。

## 消费端对照

| 消费端 | 当前产物的证据 | 图片语义与限制 |
| --- | --- | --- |
| Kodi | 官方说明旧式 `extrafanart` 由支持它的皮肤直接读目录，文件名通常不重要 | 额外背景/皮肤幻灯片；该旧目录方式不把图片加入 Kodi 图片库。现代方式推荐 `fanart1`、`fanart2` 等，序号不补零；不能保证默认皮肤显示样张 |
| Jellyfin | v10.11.10 源码读取 `extrafanart` 中所有非空受支持图片，当前 `stem-001` 可被此路径接纳 | 全部成为 Backdrop，并非独立 Screenshot/样张类型；同一目录多影片有共享图片风险。NFO 中多个相对引用不会建立完整图片集 |
| Emby | 官方支持 Backdrop 与 `extrafanart/fanartX.ext` | 可由部分客户端轮换背景；当前 `stem-001.ext` 不在文档保证内，不能直接断言所有版本不支持，也不能宣称已验证 |
| Plex | 官方支持多个 `stem-fanart-N.ext`，或独立电影目录下 `fanart-N.ext` | 当前 `extrafanart/stem-001.ext` 无官方保证；多背景通常用于选择背景、部分幻灯片场景，非样张画廊 |
| Infuse | 官方本地覆盖说明电影海报、单个 `stem-fanart`、logo | 未查到 extrafanart 或多样张画廊的本地文件契约；不能把单背景支持推导为样张支持 |

### Kodi：支持有条件，且旧格式正被替代

[Artwork types](https://kodi.wiki/view/Artwork_types) 明确区分 `fanart#` 与旧 `extrafanart`，后者依赖皮肤直接访问文件夹。多背景是否轮换同样依赖皮肤。建议背景为 16:9；普通样张可能不满足这一画幅。[Movie artwork](https://kodi.wiki/view/Movie_artwork) 页面标注适用于 v20，规定普通电影本地图片使用 `stem-arttype.ext`。[电影 NFO](https://kodi.wiki/view/NFO_files/Movies) 允许 fanart 下多个 thumb，但这表达可用背景，不等于保证样张画廊。此处不对所有 Kodi 版本的相对路径解析作额外保证。

### Jellyfin：目录有效，NFO 不是多图闭环

[Movies 官方文档](https://jellyfin.org/docs/general/server/media/movies/) 将 extrafanart 映射为 Backdrop，并将 Screenshot 列为已弃用、官方客户端未使用的类型。

固定版本 [v10.11.10 LocalImageProvider.cs](https://github.com/jellyfin/jellyfin/blob/v10.11.10/MediaBrowser.LocalMetadata/Images/LocalImageProvider.cs#L286) 的 `PopulateBackdropsFromExtraFanart` 枚举目录中受支持扩展名的非空图片，不按影片名前缀筛选。因此当前 `stem-001` 的名称本身不是阻碍；若不同影片同目录共享 extrafanart，前缀也不能阻止消费端将其一起视为背景。这是由源码得出的风险判断，未实机复现。

[NFO 官方文档](https://jellyfin.org/docs/general/server/metadata/nfo/#image-paths-and-urls-in-nfo-files) 明确同类型只使用首个 thumb。[v10.11.10 BaseNfoParser.cs](https://github.com/jellyfin/jellyfin/blob/v10.11.10/MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs#L572) 对 fanart 只读取首个 thumb，`FetchThumbNode` 要求绝对 URI/路径；导出的普通相对路径会被该解析分支拒绝。由此，现有多图可消费性来自图片目录扫描，不能归功于多个 NFO 引用。

### Emby：多背景有正式用途，当前命名需验证

[Movie Naming](https://emby.media/support/articles/Movie-Naming.html) 列出 `extrafanart/fanartX.ext` 和多个编号 backdrop/fanart/background 的形式；混合影片目录只保证使用影片名前缀的规定形式。[Image Editing and Image Types](https://support.emby.media/support/articles/Image-Editing.html) 说明背景在其他图文后方显示，许多客户端能轮换多张背景。本文未取得当前 Emby 闭源服务器的多 thumb 与相对路径解析契约，不用历史开源实现代替当前版本结论。

### Plex：能用多背景，但要采用其识别规则

[Local Media Assets – Movies](https://support.plex.tv/articles/200220677-local-media-assets-movies/)（页面标注 2025-11-19 更新）给出多个编号背景的形式及本地资源开关；当前 extrafanart 子目录不在其命名契约中。[NFO 官方指南](https://support.plex.tv/articles/using-nfo-metadata-files-with-plex/) 要求 PMS 1.43.1+ 与相应 NFO Agent，并将 fanart 定义为背景 URL(s)。这不能保证当前没有样张引用的 Plex profile 会加载样张，也不能保证将本地相对引用补上就解决问题。

### Infuse：只证实单背景覆盖

[Overriding Artwork and Metadata](https://support.firecore.com/hc/en-us/articles/4405042929559-Overriding-Artwork-and-Metadata)（2026-03-31 更新）规定 `stem-fanart.jpg` 用于详情页和 Up Next，未给出多个样张、extrafanart 或样张画廊规则。[Library Scanning & Indexing](https://support.firecore.com/hc/en-us/articles/27862264977047-Library-Scanning-Indexing) 说明本地扫描设置不适用于连接 Emby/Jellyfin/Plex 的场景；连接这些服务时还需区分服务端图片与 Infuse 直接扫描文件。

## Javdex 自身回读验证与修复

使用实际 `renderNfoExportDocument` 输出五种 profile，再通过 `LocalNfoSourceAdapter.collect` 读取。构造“独立背景 + 本影片样张 + 同目录其他影片样张”：修复前 portable/Jellyfin/Emby 通过，Plex/Infuse 仅收到背景，漏掉本影片样张。原因是两种 profile 不写样张引用，而导入器在存在背景引用时停止补查 `extrafanart`。

现已修复为：保留显式引用，并补查本影片文件名前缀的样张；有显式引用时不读取无归属前缀的目录图片，物理文件仍去重。五种格式的回归全部通过，连同既有导入/profile 与扫描回归共 77 项通过，Node 类型检查和变更文件 ESLint 通过。证据见 [localNfoSourceAdapter.test.ts](../src/main/metadata-sources/localNfoSourceAdapter.test.ts)。这验证的是样张候选回读，并不等于所有消费端的显示验证。

另一个独立条件是自动导入只作用于首次发现的资源，并按补空字段策略处理；全局已刮削成功的影片直接跳过。所以在原库导出后再次扫描，或新建媒体库但复用同一全局已刮削影片，均不能用来证明旁路图片不可识别。这个规则此次未改变，见 [localNfoScanService.ts](../src/main/services/localNfoScanService.ts) 与扫描回归。

## 建议的产品边界

1. 保留用户主动选择的样张文件导出，默认不选。用于备份/迁移时有价值，但当前导出不应被描述成完整备份。
2. 导出 UI 显示各 profile 的真实能力：额外背景兼容、仅文件复制、未验证；不新增大量开关或逐软件图片处理框架。
3. 优先修复 Javdex 自身样张回读；明确样张归属、顺序和背景与样张区别，不仅测试“文件已写出”。
4. 外部兼容后续按软件补齐有限方案：Kodi 使用现代编号 fanart 需相应皮肤；Jellyfin/Emby 的共享 extrafanart 必须考虑同目录多影片；Plex 可改用官方编号背景命名但应明确这是背景转换；Infuse 暂不承诺多图消费。
5. 在真实消费端验证前，测试与文案分别声明“文件/解析契约验证”和“客户端展示验证”，避免把前者作为后者的证据。
