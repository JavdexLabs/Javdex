# NFO 导入、导出兼容性调研与最小 Interface 方案

> 状态：设计建议，尚未实现
>
> 调研日期：2026-09-04
>
> 范围：影片 NFO 与影片同目录图片资产；不包含电视剧、字幕导入、影片文件移动或重命名
>
> 名词说明：本文将需求中的 “jefflin” 按 **Jellyfin** 理解；若实际指其他产品，需要另行补充目标。

## 结论先行

用户提出的产品拆分基本合理，但实现方式需要加一个重要限定：

1. **导入在产品上表现为内置影片刮削来源**，与 JavDB、JavLibrary 等来源一起选择、批量执行并复用待确认与字段覆盖策略。
2. **导入不应实现成普通 `.avscraper` 沙箱插件**。当前插件 Interface 只有番号和网络能力，没有影片资源路径与本地文件权限，也不能安全表达本地图片资产。它应是主进程内的 `LocalNfoMetadataSourceAdapter`，通过新的影片元数据来源 seam 接入既有刮削 apply 流程。
3. **导出是独立功能和独立 Module**。导出面向媒体资源目录产生外部文件，具有目标 profile、覆盖、权限、原子写入和预览等副作用；把它塞进刮削插件会混淆方向、权限和失败语义。
4. 推荐的最小公共 Interface 一共 **3 个入口**：
   - 来源侧：`VideoMetadataSource.collect(...)`
   - 导出侧：`NfoExportModule.plan(...)`
   - 导出侧：`NfoExportModule.apply(...)`
5. XML 解析、方言识别和 profile 渲染放进一个私有 `NfoArtifactCodec` Module。它不是可替换 seam，不需要为每一种工具或消费者建类；方言和导出 profile 应主要是数据映射。
6. Agent 适合解释歧义、建议映射、组织批处理和生成新 profile 草案；**不适合**成为 XML 解析器、路径仲裁器或文件写入器。确定性解析、身份校验、路径约束和写入必须留在主进程 Module。
7. 导入必须从**扫描发现阶段**接入，而不是等文件名已经成功识别出番号后才运行。这样 NFO 中的 `num/uniqueid/id` 才能救回“文件名无法识别、但 sidecar 完整”的资源。
8. Plex 只兼容 `plex-nfo-1.43.1+`：目标是新版官方 NFO Agent，不为默认 Plex Movie Agent 或仅 Local Assets 的媒体库提供独立 profile。

推荐结构：

```text
Sandbox scraper ─┐
Composite source ├─ WebScraperSourceAdapter ─┐
Local NFO ───────── LocalNfoSourceAdapter ────┤
                                               ▼
                              VideoMetadataSource.collect
                                               │
                              现有候选/待确认/apply 流程

Javdex catalog + selected resources
                 │
                 ▼
       NfoExportModule.plan ── preview / warnings / hashes
                 │
                 ▼ explicit apply
       NfoExportModule.apply ── atomic sidecar writes
```

## 1. 一手来源调研

### 1.1 GitHub 上常见 JAV 元数据工具的实际约定

下表只记录在项目源码、默认配置或项目自带样例中可以确认的行为；没有从实现中确认的能力会明确标注。

| 工具 | 可确认的 NFO 行为 | 默认或可配置的文件/图片约定 | 对 Javdex 导入的含义 |
|---|---|---|---|
| Movie_Data_Capture | 写入 `<movie>`，常见字段包括 `title/originaltitle/sorttitle`、`plot/outline`、`runtime`、`director`、`actor`、`maker`、`label`、`num`、三种发布日期标签、`tag/genre`、评分和 `trailer`。模式 3 会把 NFO 命名为与原视频完全同名的 sidecar。[写入实现](https://github.com/mvdctop/Movie_Data_Capture/blob/6bad088683265d36fb1109b67a4df2bf1deb9d39/core.py#L315-L463) | 图片可以是 `poster.*`、`thumb.*`、`fanart.*`，也可以带番号前缀；支持 `extrafanart` 和 Kodi `.actors` 目录。[资产实现](https://github.com/mvdctop/Movie_Data_Capture/blob/6bad088683265d36fb1109b67a4df2bf1deb9d39/core.py#L877-L935) | 要识别 `num/maker/label/release` 等 JAV 扩展标签；不能只实现最小 Kodi 字段。精确视频同名 NFO 必须是最高优先级候选。 |
| MDCx | 同一个 Module 同时包含 NFO writer 与 reader。writer 可输出通用字段和 `num`、`maker/label`、`publisher`、`series`、`originalplot` 等 JAV 字段。[writer](https://github.com/sqzw-x/mdcx/blob/58e3f930f2e864fceb8a53ceef818716e2a6413d/mdcx/core/nfo.py#L25-L324) | reader 只从 `file_path.with_suffix(".nfo")` 读取精确同名 sidecar；本地封面优先查 `<stem>-poster.jpg`，再查 `poster.jpg`，thumb/fanart 采用同类规则。[reader](https://github.com/sqzw-x/mdcx/blob/58e3f930f2e864fceb8a53ceef818716e2a6413d/mdcx/core/nfo.py#L326-L505) | `movie.nfo` 不能作为唯一导入约定；需要精确同名 sidecar 和本地图片 fallback。MDCx 的 reader 优先级可以作为兼容 fixture，而不是直接照搬全部字段语义。 |
| Javinizer | 项目 README 给出完整 `<movie>` 样例，包含 `id`、`premiered`、评分、`set`、`genre`、`actor/name/altname/thumb/role` 等。[官方输出样例](https://github.com/javinizer/Javinizer/blob/0c1cc4127f23d624e22baffa6aee7b0350f439bb/README.md#L216-L284) | 默认每个影片生成 `<ID>.nfo`，视频为 `<ID>.*`，封面 `folder.*`，横图 `fanart.*`，预告片 `<ID>-trailer.*`，剧照在 `extrafanart/`，演员图在 `.actors/`。[默认设置](https://github.com/javinizer/Javinizer/blob/0c1cc4127f23d624e22baffa6aee7b0350f439bb/src/Javinizer/jvSettings.json#L50-L95)；[官方目录示例](https://github.com/javinizer/Javinizer/blob/0c1cc4127f23d624e22baffa6aee7b0350f439bb/README.md#L166-L214) | `id` 需要作为番号候选；演员别名/角色要安全降级。需要兼容 `folder.*`、`.actors/`、`extrafanart/`。该项目仓库已归档，因此只承诺兼容已验证的输出，不依赖其继续演进。[官方仓库状态](https://github.com/javinizer/Javinizer) |
| JavSP | writer 以 Kodi Movie NFO 为目标，写入 `title/originaltitle`、`rating`、`plot`、`runtime`、`uniqueid type="num"/"cid"`、`genre/tag`、结构化 `set/name`、`director`、`premiered`、`studio`、`trailer` 和 `actor`。[NFO writer](https://github.com/Yuukiy/JavSP/blob/c4cfe61188234dd24c75b53b42b054327fef3e58/javsp/nfo.py#L10-L114) | 默认视频 basename 为 `{num}`，NFO basename 为 `movie`，封面为 `poster`，横图为 `fanart`，并可生成额外剧照。[默认配置](https://github.com/Yuukiy/JavSP/blob/c4cfe61188234dd24c75b53b42b054327fef3e58/config.yml#L70-L148) | 要支持 `movie.nfo`、`uniqueid type="num"` 和结构化 `<set><name>`。从已检查的主流程确认了写出，没有确认到一个可作为稳定承诺的通用 NFO importer，因此本文不宣称 JavSP 具备反向导入能力。 |

这四个项目共同证明两件事：

- “Kodi 风格 `<movie>` XML” 是交集，但 JAV 语义依赖 `num`、`maker/label/publisher`、`series/set` 等多种扩展和回退。
- 文件树比 XML 标签更不统一：同一个影片可能使用 `<videoStem>.nfo`、`<ID>.nfo` 或 `movie.nfo`；封面可能是 `<stem>-poster`、`poster` 或 `folder`。

因此，不应该按工具名实现四套完整 parser。更深的 Module 应先完成 **sidecar discovery → 安全 XML 归一化 → 方言提示下的字段优先级 → 本地资产发现**，把工具差异局部化在规则表和 fixture 中。

### 1.2 Jellyfin、Emby、Plex 的消费约定

#### Jellyfin

- Jellyfin 官方说明其可读写本地 NFO；影片可使用 `movie.nfo`、`VIDEO_TS.nfo` 或与影片同名的 `.nfo`。它支持 `title/originaltitle/plot/runtime/studio/director/actor/premiered/releasedate/genre/tag/uniqueid/thumb/fanart` 等常用标签，并说明本地路径或 URL 图片优先于远程图片提供者。[Jellyfin NFO 文档](https://jellyfin.org/docs/general/server/metadata/nfo/)
- 官方建议每部影片使用独立目录；同名 NFO、`cover.png`、`backdrop.jpg` 等本地资产均在其目录结构示例中。[Jellyfin 影片组织文档](https://jellyfin.org/docs/general/server/media/movies/)

#### Emby

- Emby 官方 `NfoMetadata` 实现会先找与影片精确同名的 `.nfo`，在非 mixed folder 中也会找 `movie.nfo`；DVD/BDMV 还有 `VIDEO_TS.nfo`、`index.nfo` 等分支。[MovieNfoSaver/GetMovieNfo](https://github.com/MediaBrowser/NfoMetadata/blob/965f602939810b845a08548fe96ff10667762633/NfoMetadata/Savers/MovieNfoSaver.cs#L27-L158)
- 同一官方实现的 parser/saver 处理 `uniqueid`、`studio`、`actor`、`premiered/releasedate`、`genre/tag`、poster/fanart 等字段。[BaseNfoParser](https://github.com/MediaBrowser/NfoMetadata/blob/965f602939810b845a08548fe96ff10667762633/NfoMetadata/Parsers/BaseNfoParser.cs#L340-L750)；[BaseNfoSaver](https://github.com/MediaBrowser/NfoMetadata/blob/965f602939810b845a08548fe96ff10667762633/NfoMetadata/Savers/BaseNfoSaver.cs#L605-L910)
- Emby 官方影片命名说明推荐每片独立目录，并列出 `poster/folder/cover/default/movie` 等主图名称及 backdrop/fanart/background/art 等背景图名称。[Emby Movie Naming](https://emby.media/support/articles/Movie-Naming.html)

#### Plex

- Plex Media Server 1.43.1 起提供官方 `Plex NFO Movie` / `Plex NFO Series` Agent。它不是默认 Plex Movie Agent 的隐式能力：建库或改库时必须明确选择 NFO Agent。影片要求独立目录，接受 `movie.nfo` 或与影片文件精确同名的 NFO，并支持官方表中列出的 Kodi/XBMC 兼容字段，如结构化 ratings、`premiered`、`studio`、结构化 `set`、`uniqueid/id`、导演、演员、thumb 和 fanart。[Plex NFO Metadata](https://support.plex.tv/articles/using-nfo-metadata-files-with-plex/)
- 官方同时说明，使用 NFO Agent 的媒体库不能使用 Plex 的“同步观看状态与评分”。这必须在导出 profile 的说明里明确展示，不能把它包装成对现有 Plex 媒体库零成本的兼容。
- 默认 Plex Movie Agent 不在本方案兼容范围内；用户必须切换到官方 NFO Agent，Javdex 不提供仅面向 Local Assets 的降级 profile。
- Plex 官方示例和支持字段表并不完全等价。例如示例中可能出现但表格未作稳定承诺的标签，应放入带版本号的 smoke fixture 验证后再启用，不能仅凭“看起来像 Kodi”推断支持。

### 1.3 目标兼容矩阵

“兼容”不能只用一个开关表达；下表区分文本元数据、身份、图片和用户状态。Emby 的完整公开标签合同不如 Jellyfin/Plex 明确，因此采用 Kodi 保守子集并用固定版本 smoke test 锁定。

| 能力 | Jellyfin | Emby | Plex NFO Agent 1.43.1+ |
|---|---|---|---|
| 读取影片 NFO | 官方支持，且本地 NFO 优先 | 支持 Kodi 风格 NFO | 官方支持，但必须选 NFO Agent |
| 精确同名 `.nfo` | 支持 | 支持 | 支持 |
| `movie.nfo` | 支持 | 非 mixed folder 支持 | 支持，要求一片一目录 |
| `uniqueid` / `id` | 支持 | 保守兼容 | 支持；关系到 Plex GUID |
| `ratings` | 支持 | 需按版本验证 | 支持 |
| `genre` / `tag` | 两者均明确支持 | 需按版本验证 | 只启用官方表明确支持且 smoke 通过的字段 |
| 本地 poster / fanart | 支持；每种 artwork 只取一张 | 支持多种传统命名 | NFO Agent 支持；本地资产优先 |
| 用户观看状态/个人评分 | NFO 可涉及但有单用户约束；默认不导出 | 默认不导出 | NFO Agent 会影响 Plex 的同步能力；默认不导出 |

### 1.4 其他值得兼容的消费端

兼容目标需要区分两个概念：

- **导出 profile**：输出字段或文件命名确实不同，需要用户选择。
- **兼容验证目标**：可以直接消费现有 Kodi/通用输出，只需用固定版本的 fixture、真机或集成测试确认，不应增加一个重复的 UI 选项。

按当前维护状态、Javdex 用户场景、官方 NFO 合同清晰度和实现成本，建议如下：

| 目标 | 优先级 | 官方能力与差异 | 产品建议 |
|---|---:|---|---|
| Kodi | P0 | Kodi 是当前事实上的 NFO 基线，官方推荐 `<VideoFileName>.nfo`，图片使用 `<stem>-poster` / `<stem>-fanart`，并完整定义 typed `uniqueid`、结构化 ratings/set 和 actor。LibreELEC、CoreELEC、OSMC 都随 Kodi 格式覆盖。[Kodi Movie NFO](https://kodi.wiki/view/NFO_files/Movies)；[Kodi Artwork](https://kodi.wiki/view/Movie_artwork) | 将 `portable-v1` 明确标注为“通用 / Kodi”，不另写 serializer。Kodi 应成为所有其他 profile 的共同基线和 golden fixture。 |
| Infuse | P0/P1 | Infuse 原生读取与视频精确同名的 NFO；海报是 `<stem>.jpg`，背景是 `<stem>-fanart.jpg`。官方只承诺常用标签，并明确本地 NFO/图片需要启用相应偏好；UPnP/DLNA 连接不支持本地覆盖。[Infuse Local Metadata](https://support.firecore.com/hc/en-us/articles/4405042929559-Overriding-Artwork-and-Metadata) | **值得增加 `infuse-current` overlay**：复用 Kodi XML 核心，仅收窄字段并改资产命名。它是新增候选中唯一值得直接展示为导出目标的。 |
| VidHub | P1 | 面向 NAS、WebDAV、网盘及 Apple/Android TV，官方已给出同名 NFO 和 `-poster/-backdrop/-clearlogo/-fanart` 命名，但没有公开稳定的标签级 schema。[VidHub NFO 指南](https://okaapps.com/blog/66d6bfb9bbd93f236a27ae4e) | 先作为“通用 / Kodi”的兼容验证目标；采集真实输出并做字段黑盒测试后，再决定是否需要 overlay。 |
| Nova Video Player | P1 | Android/Android TV 项目仍活跃，官方说明遵循 Kodi NFO，但当前解析器只覆盖较旧子集，并且本地/USB 存储受 Android 文件权限影响；网络共享路径更可靠。[Nova FAQ](https://github.com/nova-video-player/aos-AVP/blob/nova/faq/faq.md)；[Nova NFO parser](https://github.com/nova-video-player/aos-MediaLib/blob/v6.4/src/com/archos/mediascraper/NfoParser.java) | 先做兼容 fixture，不增加 UI profile。若验证发现现代 `ratings/premiered` 丢失，再加小型 `nova-v6.4` alias overlay，而不是复制完整格式。 |
| Zidoo Home Theater | P1/P2 | 官方更新说明宣称读取 Kodi 风格 NFO，但没有稳定、完整的字段合同；设备和 NAS 用户与 Javdex 有一定重合。[Zidoo Support](https://www.zidoo.tv/Support/downloadList/target/rRwtRFydZ4xKKmVViAFMcQ%3D%3D.html) | 使用通用 / Kodi profile 做真机验证和兼容徽章；在获得可固定的字段合同前不新增 profile。 |
| Stash + nfoSceneParser | P1/P2 | Stash 本身是成人媒体管理器，官方 CommunityScripts 的插件会读取同名 Kodi Movie NFO，映射 title/plot/studio/actor/tag/date/set/uniqueid，并支持本地图片；这与 Javdex 用户场景高度相关，但能力属于插件而非 Stash 核心。[nfoSceneParser](https://github.com/stashapp/CommunityScripts/blob/main/plugins/nfoSceneParser/README.md) | 值得加入集成 fixture 和迁移说明。首期复用通用 / Kodi 输出；只有需要 Stash 的 `<url>` 或 scene/group 特有语义时才增加独立 Adapter。 |
| Serviio | P2 | 官方支持 XBMC NFO，查找 `movie.nfo` 或 `<video_file_name>.nfo`，本地海报也兼容传统命名。[Serviio Metadata Extraction](https://serviio.org/contact/12-metadata-extraction) | 通用 / Kodi profile 已基本覆盖；只做低成本 fixture，不增加产品选项。 |
| tinyMediaManager | 工具链 | 它是 NFO 管理/迁移工具，不是播放服务器；可导入其他工具 NFO，也可输出 Kodi、Emby、Jellyfin 等格式。[tinyMediaManager Features](https://www.tinymediamanager.org/features/) | 不作为导出目标；把它作为 round-trip 互操作测试和人工诊断工具。 |

暂不建议兼容：

- **Dune HD My Collection**：官方虽会利用 NFO 帮助识别，但影片描述和图片仍以 Dune 数据库为准，不能可靠承载 Javdex 的自定义 JAV 元数据。[Dune My Collection](https://dune-hd.com/support/mycollection/)
- **Universal Media Server**：当前重点是 DLNA/UPnP 传输，没有可作为稳定合同的官方影片 NFO reader；“项目活跃”不等于适合作为 NFO 消费端。
- **MediaPortal、Mezzmo、JRiver**：存在 NFO 或 Kodi 兼容路径，但用户覆盖、公开合同和新增收益不足。若后续收到实际用户样本，可先纳入通用 profile fixture，而不是预先增加 profile。
- **VLC、mpv、IINA**：没有影片媒体库级 NFO 消费合同。

产品已确认公开导出目标保持为：

1. 通用 / Kodi
2. Jellyfin
3. Emby
4. Plex NFO Agent（PMS 1.43.1+）
5. Infuse

VidHub、Nova、Zidoo、Stash 和 Serviio 作为上述 profile 的“已验证兼容对象”展示，不占用新的导出选项。后续只有在 golden/smoke test 证明输出确有差异时，才升级为独立 overlay。

### 1.5 导出的共同最小布局

三个目标消费者都能接受影片精确同名 NFO；它也不会像多个影片共处一个目录时的 `movie.nfo` 那样发生碰撞。因此推荐默认输出：

```text
ABC-123.mp4
ABC-123.nfo
ABC-123-poster.jpg        # 有可导出的封面时
ABC-123-fanart.jpg        # 只有真正的背景图时；不要用竖版封面伪造
ABC-123-trailer.mp4       # 有本地预告片且用户选择包含时
extrafanart/              # 可选；仅输出剧照，不把它们声明成主背景图
```

产品已确定 V1 只输出资源精确同名 NFO，不提供 `movie.nfo`、独立导出目录或文件整理。V1 同时必须支持样张导出；图片命名由 profile 控制，并需要在多影片共享目录时避免碰撞。

## 2. Javdex 当前架构约束

### 2.1 领域与数据流

[`CONTEXT.md`](../CONTEXT.md) 把影片定义为全局目录实体，把媒体库中的实际文件定义为资源/成员关系；影片业务身份由发行商、番号和发行日期共同参与。这意味着：

- NFO 是从某个**物理资源**发现的，但应用的是全局影片元数据。
- 导出目标必须是明确的资源或媒体库范围，不能只给 `videoId` 后随意选择一个文件夹。
- NFO 番号与当前影片番号不一致时，必须进入无匹配或待确认/身份冲突流程，不能静默改写全局影片。

### 2.2 当前插件 Interface 不具备本地导入能力

当前事实：

- [`docs/SCRAPER_PLUGIN_FORMAT.md`](./SCRAPER_PLUGIN_FORMAT.md) 的影片插件入口是 `parseVideo(ctx)`，插件只拿到 `ctx.code`；文档明确没有 `ctx.target`、`ctx.sourceUrl` 等目标上下文。
- 普通插件运行在沙箱中，没有 Node `fs`、`require` 或任意本地文件访问能力。内置 `serviceBinding` 目前也是受信任绑定而非用户插件 API。
- [`apps/desktop/src/main/scrapers/BaseScraper.ts`](../apps/desktop/src/main/scrapers/BaseScraper.ts) 的 Interface 只有 `parseTask(code, proxyUrl?)`，没有 `videoId`、资源 ID 或资源路径。
- [`packages/contracts/src/videoScrapeTypes.ts`](../packages/contracts/src/videoScrapeTypes.ts) 的 `ScrapeResult` 以 `coverUrl`、`sampleImageUrls` 和演员 `avatarUrl` 表达图片，没有本地资产引用。
- [`apps/desktop/src/main/services/videoScrapeApplyService.ts`](../apps/desktop/src/main/services/videoScrapeApplyService.ts) 的 delivery 通过 `fetcher(url)` 下载这些图片；[`apps/desktop/src/main/services/mediaAssetStore.ts`](../apps/desktop/src/main/services/mediaAssetStore.ts) 负责暂存、落盘和数据库变更协调。

所以，直接新增一个读取 NFO 的 `.avscraper` 会被迫做出至少一种错误选择：

1. 给所有插件开放文件系统；
2. 把任意本地路径伪装成 URL；
3. 把影片资源路径泄漏给沙箱；
4. 在插件外部先读文件，再用特例把结果塞回 manager。

前三种扩大权限并破坏安全边界，第四种形成浅而分散的 special case。正确 seam 是“影片元数据来源”，不是“远程脚本插件”。

### 2.3 可以复用的深度

[`apps/desktop/src/main/scrapers/scraperManager.ts`](../apps/desktop/src/main/scrapers/scraperManager.ts) 已承担多个重要不变量：番号归一化、候选收集、待确认暂存、字段选择、身份冲突和调用 apply。[`apps/desktop/src/main/services/videoScrapeApplyService.ts`](../apps/desktop/src/main/services/videoScrapeApplyService.ts) 又把字段覆盖、分类实体解析、图片下载与数据库事务集中在一个 Module 内。

NFO importer 应复用这些机制，而不是另写一条“解析 XML 后直接 update database”的旁路。最有价值的重构是让 manager 从 `VideoMetadataSource` 收集候选，而不是直接依赖 `BaseScraper`。

## 3. 字段归一化与兼容规则

### 3.1 Sidecar discovery

按以下顺序查找；命中多个且内容不同要产生 `ambiguous-sidecar`，不能合并：

1. 与目标资源精确同名的 `<videoStem>.nfo`。
2. 只有在目录内全部影片文件都归属于同一个规范化番号时（允许同番号分段/版本），才考虑共享 `movie.nfo`。
3. V1 不处理 `VIDEO_TS/BDMV` 目录资源；等扫描器能把目录媒体建模为一个 resource 后，再加入 `VIDEO_TS.nfo`、`BDMV/index.nfo`。

目录存在多个规范化番号时，`movie.nfo` 记为歧义并跳过。精确同名与 `movie.nfo` 内容相同可视作重复；内容不同则精确同名优先，但必须带 warning，避免用户不知道另一个 sidecar 被忽略。

发现顺序应位于扫描器的“资源建档/身份识别”阶段：先把视频或 STRM 与邻近 sidecar 配对，再综合 NFO 身份和文件名身份。NFO 不是影片资源，也不增加独立顶层统计；每个扫描文件继续只有一个主要结果，NFO 只作为已导入、已跳过、普通警告或多候选待确认等附加处置。坏 NFO 不把正常新增资源计入异常，只有身份冲突和多候选进入“异常与待办”。同一全局影片在两个媒体库有两个物理资源时，两份 NFO 具有各自的来源证据，不能因 `videoId` 相同而折叠。

产品已确定：文件名与 NFO 只要给出不同规范化番号，就不得自动选择任一方。扫描应将两份证据持久化为“待确认资源身份”，在用户决定前不建立影片资源或媒体库成员，也不应用 NFO 元数据；源文件确认缺失时才可由安全扫描清理该未决项。

同一次扫描为同一影片首次发现多个身份一致的资源时，资源先正常建档，再收集每份唯一有效 NFO。只有一份候选时按既定空字段补齐自动应用；多份候选复用待确认影片刮削结果；单个坏 NFO 只产生普通 warning，不阻塞其它候选或资源导入。目标影片已刮削成功时跳过全部元数据候选。

### 3.2 XML 字段到 `ScrapeResult` 的建议映射

| Javdex 字段 | NFO 读取优先级 | 规则与损失 |
|---|---|---|
| `code` | `num` → `uniqueid[type=num]` → `id` → 当前影片 code | 所有候选都经现有番号归一化；显式 NFO code 与目标不一致时返回身份不匹配，不允许用当前 code 掩盖。JavSP 使用 `uniqueid[type=num]`，Javinizer 样例使用 `id`，MDC/MDCx 使用 `num`。 |
| `title` | `title` → `originaltitle` | 当前模型没有单独 original title；两者不同且只能保留一个时产生 lossy warning。 |
| `summary` | `plot` → `outline` → `originalplot` | 不拼接重复文本；MDCx 的 `originalplot` 仅作为最后回退。 |
| `releaseDate` | `premiered` → `releasedate` → `release` | 严格解析日期；只接受可归一化到 ISO 日期的值。 |
| `durationSeconds` | `runtime` | 这些工具按分钟写 runtime；转换为秒。小数或带单位文本只在明确、无歧义时解析。 |
| `maker` | `maker` → `studio` | JAV 扩展优先；通用 NFO 的 studio 作为回退。 |
| `publisher` | `publisher` → `label` | 不从 studio 推断 publisher，避免把制作商复制成发行商。 |
| `series` | `series` → `set/name` → 标量 `set` | 支持 JavSP/Plex 的结构化 set 与 MDC/Javinizer 的标量 set。 |
| `director` | 第一个非空 `director` | 当前 `ScrapeResult` 只能表达一个导演；更多导演产生 lossy warning，未来扩展数据模型后再保留全部。 |
| `actresses` | `actor/name`，结合显式性别、现有名称归属、已知方言与头像 | 显式性别优先；名称已匹配现有演员时沿用其性别；已验证的 MDC/MDCx/Javinizer/JavSP 方言缺少性别时按女优导入且不警告；未知方言且无法匹配时也按女优导入，但产生普通 warning。Adapter 必须显式给出 gender，避免依赖当前 apply 对省略 gender 的隐式默认行为。 |
| `tags` | `tag` 与 `genre` 的稳定并集 | trim、大小写不敏感去重，保留第一次出现的展示形式。 |
| `ratingAverage/count` | 带 `name/max/value/votes` 的 `ratings/rating` → 方言明确时的标量 `rating` | 统一归一到 Javdex 现有量表；只有显式 `max` 或已验证方言才换算。MDC 同时写 0–10 标量和 `max=5` 的 jdb rating，不能把二者重复导入。[MDC rating writer](https://github.com/mvdctop/Movie_Data_Capture/blob/6bad088683265d36fb1109b67a4df2bf1deb9d39/core.py#L426-L458) |
| `sourceUrl` | 无通用映射 | 不从任意 `id` 伪造网站 URL。若未来某方言有明确来源 URL 标签，再作为 profile 扩展。 |

默认不导入 `userrating`、`playcount`、`watched`、`lastplayed`。这些是用户状态，不是影片目录元数据；Jellyfin 官方也明确说明用户数据导入与单一用户绑定。[Jellyfin NFO 文档](https://jellyfin.org/docs/general/server/metadata/nfo/)

评分必须进入现有的外部站点评分/统计语义，不得写入 Javdex 的个人评分字段。未知标签、无法表达的多导演/演员角色等信息只在当次候选与 warning 中用于诊断，不持久保存资源级 NFO provenance/source snapshot；不得把未知 XML 原样混入全局影片字段，也不得在导出时盲目回放到其他消费者。

产品已确定按媒体库提供默认开启的“自动导入本地 NFO”扫描配置。自动导入只在影片资源首次发现时运行，不持久保存 NFO 路径、时间、fingerprint 或处理状态；已有资源后来新增或修改 NFO 都不会触发自动同步，只能手动重新导入。自动应用资格只看影片累计刮削状态：`未刮削`或`刮削失败`允许尝试，`刮削成功`自动跳过元数据应用；新建影片自然属于未刮削。已刮削影片仍允许使用 NFO 番号识别和归属首次发现的新资源，只跳过标题、演员、图片等元数据应用。扫描触发的自动应用固定使用“空字段补齐 + 全部受支持字段”，只有实际写入至少一个字段才提升累计状态为成功；手动选择本地 NFO 时仍可显式使用其它既有更新模式。

### 3.3 本地资产

资产发现优先级：

- 海报：NFO 中明确的本地 poster/thumb 引用 → `<stem>-poster.*` → `poster.*` → `folder.*` → `cover.*`。
- 背景/剧照：NFO 中明确的本地 fanart 引用 → `<stem>-fanart.*` → `fanart.*` → `backdrop.*` → `background.*`，再加 `extrafanart/` 内按文件名自然排序；V1 全部作为样张候选，不自动写入 `poster_path` 或改变详情背景，并避免重复主 fanart。
- 演员：NFO actor thumb 的安全本地引用或 URL；之后尝试 `.actors/<safe-name>.*`，兼容 Javinizer 的空格转下划线命名。

所有本地引用必须解析到资源目录内。`..` 穿越、绝对路径跳出来源根、符号链接逃逸或设备路径必须拒绝。本地文件先由 host Adapter 验证并暂存为 opaque asset ref，不能把原始路径交给 renderer 或沙箱。NFO 中的远程图片 URL 一律忽略并产生普通 warning；自动扫描与手动导入遵循同一规则，V1 不联网下载 NFO 图片。

### 3.4 导出字段

推荐默认输出一个保守的 Kodi-compatible 子集：

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>...</title>
  <plot>...</plot>
  <premiered>2026-09-04</premiered>
  <runtime>120</runtime>
  <studio>...</studio>
  <director>...</director>
  <set><name>...</name></set>
  <uniqueid type="num" default="true">ABC-123</uniqueid>
  <id>ABC-123</id>
  <num>ABC-123</num>
  <genre>...</genre>
  <tag>...</tag>
  <actor><name>...</name></actor>
  <ratings>
    <rating name="javdex" max="5" default="true">
      <value>4.3</value>
      <votes>123</votes>
    </rating>
  </ratings>
</movie>
```

三个番号标签看似重复，但分别覆盖 JavSP/Plex/Kodi 风格的 `uniqueid`、Javinizer 的 `id` 与 MDC/MDCx 的 `num`；消费者会忽略未知标签。profile 可关闭冗余标签，但 portable profile 应保留。

其他规则：

- Javdex 内部时长为秒，NFO runtime 写整数分钟，并采用固定舍入规则；同一输入反复导出必须字节稳定。
- 只导出外部评分到 `<ratings>`；默认不把 Javdex 个人评分写入通用 `<rating>`，避免媒体服务器把个人偏好显示成社区评分。
- Javdex 当前的 `cover_path` 作为目标消费者的 poster 候选并默认导出。`poster_path` 是用户选择的详情背景，引用有效图片时默认导出为 fanart；没有 `poster_path` 时不拿竖版封面或任意样张伪造 fanart。
- 样张通过默认关闭的显式开关复制到 `extrafanart/`，命名为 `<videoStem>-001.<ext>` 等稳定序号；profile 支持时写入相对引用，不支持时仍可复制但必须提示兼容性限制。
- 演员名默认写入 NFO；复制全局演员头像到每个影片目录是默认关闭的独立选项，避免文件膨胀。
- 导出只写 sidecar/资产，不移动、重命名或删除媒体文件。
- JPEG、PNG 在 profile 支持时保留原始编码；WebP 或 profile 不支持的格式以固定参数转换为 JPEG，文件扩展名必须匹配实际编码。图片统一经 `MediaAssetStore` 读取，单图转换失败不阻止其它计划项。

## 4. 三种 radically different 的最小 Interface

### 方案 A：来源 seam + 独立导出 Module（推荐）

#### Interface

来源侧只有一个入口：

```ts
interface VideoMetadataSource {
  collect(
    target: VideoMetadataTarget,
    request: CollectMetadataRequest
  ): Promise<MetadataCandidateBatch>
}

interface VideoMetadataTarget {
  videoId: number
  code: string
  resource: {
    resourceId: number
    absolutePath: string // 仅主进程内部类型
  } | null
}

interface MetadataCandidateBatch {
  candidates: Array<{
    result: ScrapeResult
    assets: CandidateAssets // remote refs 或 host-issued staged refs
    provenance: MetadataProvenance
  }>
  warnings: MetadataWarning[]
}
```

候选资产应使用显式联合类型，不能继续假设所有图片都是 URL：

```ts
type MetadataAssetRef =
  | { kind: 'remote'; url: string }
  | {
      kind: 'managed-root-file'
      libraryId: number
      rootId: number
      relativePath: string
      fingerprint: string
    }
```

`managed-root-file` 只是一张由 host 验证过的能力票据；renderer、插件和 Agent 都看不到真实绝对路径。

两个 Adapter 证明这个 seam 不是假设性抽象：

- `WebScraperSourceAdapter` 包装现有 `BaseScraper.parseTask`、代理、组合来源和远程资产。
- `LocalNfoSourceAdapter` 使用资源路径、私有 `NfoArtifactCodec` 和 host asset staging。

手动调用 `LocalNfoSourceAdapter` 时，target 是全局影片而非用户预先选择的单条资源。Adapter 收集该影片在所有媒体库中的本地视频与 STRM 源文件锚点，对同一物理 NFO 去重，并为每份唯一 NFO 产生独立候选；多份候选复用现有待确认影片刮削结果，不跨 NFO 合并字段或图片。

导出侧两个入口：

```ts
interface NfoExportModule {
  plan(request: NfoExportRequest): Promise<NfoExportPlan>
  apply(plan: NfoExportPlan, expectedRevision: string): Promise<NfoExportReport>
}
```

`plan` 解析资源选择、生成确定性 XML/资产清单、标记 create/replace/skip/conflict，并计算影片快照与目标文件指纹；`apply` 重新验证 revision 与路径后原子写入。

#### depth 与 locality

- Module 把“来源如何得到候选”的大量复杂性藏在一个 `collect` 后面，Interface 很小而功能很深。
- 文件系统、XML 方言和本地图片规则只存在于 `LocalNfoSourceAdapter` 与私有 codec，locality 好。
- 既有候选、待确认、字段覆盖和身份冲突仍在一个地方执行，不复制业务规则。
- 导出副作用与刮削 apply 分离，失败模式清晰。

#### 成本

- 需要把 `scraperManager` 从直接调用 `BaseScraper` 调整为依赖 `VideoMetadataSource`。
- 候选资产需要从 URL-only 扩展为 remote/staged 两类受控引用；这是必要的模型修正，不是 NFO 特例。

### 方案 B：Codec 中心，manager 特判本地 NFO

两个入口：

```ts
interface NfoArtifactModule {
  parse(input: NfoParseInput): Promise<NfoParseResult>
  render(snapshot: VideoSnapshot, profile: NfoProfile): Promise<ArtifactSet>
}
```

扫描/刮削逻辑在调用前检查 NFO，然后把 parse 结果转换成 `ScrapeResult`；导出直接调用 render。

#### 优点

- 初始改动小；导入和导出共享 XML 归一化模型。
- XML 与 profile 测试简单。

#### 缺点

- “什么时候找 NFO、如何选资源、怎样进待确认、怎样暂存图片”会散落在扫描器、scraper manager 和导出调用方，locality 变差。
- codec 只隐藏 XML 语法，没有隐藏完整业务复杂性，depth 不足。
- manager 永久持有一个 `if localNfo` special case，未来再加 embedded metadata、JSON sidecar 时继续膨胀。

结论：适合原型，不适合作为长期 seam。

### 方案 C：单一传输命令/Job Module

一个入口：

```ts
interface NfoTransferModule {
  run(command: NfoTransferCommand): Promise<NfoTransferResult>
}

type NfoTransferCommand =
  | { type: 'preview-import'; resourceId: number }
  | { type: 'apply-import'; previewId: string; revision: string }
  | { type: 'preview-export'; selection: ExportSelection; profile: NfoProfile }
  | { type: 'apply-export'; planId: string; revision: string }
```

#### 优点

- 表面 Interface 最小；统一进度、取消、日志和持久化 job。
- 对超大批量导入/导出比较自然。

#### 缺点

- 一个 discriminated union 同时承载两种方向、两套身份语义和两套副作用，Module 内部容易成为浅的工作流总管。
- 现有刮削流程被旁路或重复实现；产品上“导入是一个来源”的一致性丢失。
- 测试需要构造庞大命令状态，调用方只为一个操作也要理解整个协议。

结论：如果未来所有媒体维护都迁移到持久化 job 平台，可重新考虑；当前不推荐。

### 4.1 选择

选择 **方案 A**，并在其内部使用方案 B 的 codec 思想，但不把 codec 暴露为跨模块 public seam：

```text
public seam: VideoMetadataSource.collect
  adapters: WebScraperSourceAdapter, LocalNfoSourceAdapter
  private Module: NfoArtifactCodec.parse/normalize

public Module: NfoExportModule.plan/apply
  private Module: NfoArtifactCodec.render
  profile data: portable-v1, jellyfin-current, emby-kodi-conservative,
                plex-nfo-1.43.1+, infuse-current
```

不要为 `MDC`、`MDCx`、`Javinizer`、`JavSP` 各建一个 importer class；它们不是不同 I/O mechanism，只是同一 XML/文件树中的方言规则。也不要为 Jellyfin/Emby/Plex 各建 exporter class；profile 是数据差异，单一 renderer 足够。

## 5. 推荐 Interface 的不变量

### 5.1 导入

1. `collect` 不修改数据库、不改写源目录，只产生候选、暂存资产和 warnings。
2. 每个候选都必须带已归一化 code；显式 NFO code 与目标不一致不能自动应用。
3. 所有最终字段仍由现有字段选择、update mode、分类实体解析与 identity conflict 流程决定。
4. 本地路径永远不出主进程；候选只能持有 host-issued staged ref。
5. 同一资源、同一 sidecar 内容、同一配置必须产生排序稳定、内容稳定的候选。
6. XML 禁用 DTD、外部实体和网络解析，并限制文件大小、节点深度、节点数与单字段长度。
7. sidecar/资产必须位于媒体资源目录或明确授权的媒体库根内；符号链接解析后的真实路径也要复核。
8. 解析部分成功不能伪装成完全成功；所有被丢弃、截断、歧义和不支持字段都进入结构化 warning。
9. Adapter 必须按已确认的 NFO 演员性别归属规则显式给出 gender，不能依赖 apply 的默认 female 行为。
10. local NFO source 不发起网络请求、不参与网络重试；远程图片 URL 只产生普通 warning。

### 5.2 导出

1. `plan` 无写入副作用；`apply` 只执行 plan 中列出的文件。
2. 导出计划必须绑定影片 snapshot revision、资源真实路径和每个已存在目标文件的 hash/mtime；任一变化返回 `stale-plan`。
3. 所有写入先落到同目录临时文件，再 rename/replace；失败时清理临时文件并保留原文件。
4. 默认 collision policy 为 `skip` 或 `review`；`replace` 必须显式选择，批量覆盖前必须有计划摘要。
5. 输出为 UTF-8、固定元素顺序、固定换行和稳定排序；同一 snapshot/profile 的重复导出幂等。
6. 只向所选资源目录导出，不因为全局影片属于多个媒体库而写入所有副本。
7. 不导出凭空推断的数据；无法表达的 Javdex 字段进入 plan warning。
8. 导出不移动、重命名、删除媒体文件；图片复制也不能删除已有用户资产。
9. 个人评分、观看状态等用户数据默认排除，必须单独 opt-in 且 profile 明确支持。
10. 只有本地文件资源和具有本地 source-file anchor 的 STRM 可以直接写 sidecar。直链、网页、磁力、ed2k 等没有本地锚点的资源必须跳过，或由用户显式选择独立导出目录；不能由 Module 猜路径。
11. 同一全局影片在多个媒体库中的资源分别计划、分别导出；不能因全局元数据共享就写入未选中的副本。
12. V1 不持久保存导出 manifest，也不推断文件所有权；已有文件默认跳过，只有用户在生成计划前显式选择覆盖时才列为 replace，apply 仍须复核目标 hash/mtime。

导出 Module 还需要一个比当前“验证已存在根内文件”更窄的新 Interface：授权在某个已验证媒体资源旁创建特定 sidecar sibling。实现使用同目录临时文件、flush/fsync、rename 和仅存在于当次任务内存中的输出 hash ledger。单个文件可以原子替换，但一组 NFO/图片不能伪装成跨文件系统事务；批量报告必须允许 partial success，但 V1 不保存 checkpoint、不后台重试或恢复任务。

产品已决定把 NFO 导出保持为一次性快照：不新增持久化 export UID，不保存 NFO 与影片关联，也不建立增量同步。导出不得暴露数据库自增 ID，只使用现有番号和消费者明确支持的现有站点身份。只有不同全局影片具有相同规范化番号且导出到同一物理目录时，计划才提示目标软件可能错误合并；位于不同目录时不告警。各 profile 必须说明 `uniqueid/id/num` 策略和潜在损失，不能宣称完全无损。若 Plex NFO Agent 的固定版本 smoke test 证明跨目录仍会合并，必须把它作为兼容性缺陷重新决策。

## 6. 错误模式

| 错误码 | 阶段 | 处理语义 |
|---|---|---|
| `nfo-not-found` | import collect | 正常路径，不产生 warning、异常或待办，也不重试。 |
| `ambiguous-sidecar` | import collect | 精确同名优先但要求 review；不能静默合并两份 XML。 |
| `invalid-xml` | import collect | 结构化失败；记录普通 warning。文件名有效时仍正常建立资源且扫描不自动重试；不向 renderer 日志展示敏感绝对路径。 |
| `unsafe-xml` | import collect | DTD、外部实体、超限结构等立即拒绝该 NFO 并记录普通 warning，不阻止依靠有效文件名建立资源。 |
| `identity-mismatch` | import collect/apply | 作为候选冲突或待确认，不改 code。 |
| `unsupported-dialect` | import collect | 可产生部分候选与 warnings；关键身份字段无法确定时为无匹配。 |
| `unsafe-path` | import/export | 路径穿越、root escape、符号链接逃逸立即拒绝。 |
| `asset-invalid` | import collect | 跳过单个资产并 warning；元数据候选仍可使用。 |
| `destination-collision` | export plan | 计划中标成 skip/replace/review，不在 apply 时临时猜测。 |
| `stale-plan` | export apply | 影片、资源或目标文件已变化，要求重新 plan。 |
| `permission-denied` / `disk-full` | export apply | 终止 apply、回滚临时文件；报告已完成和未触碰项。 |
| `partial-write-rolled-back` | export apply | 明确报告回滚；若操作系统导致无法恢复，列出人工处理路径。 |

## 7. 依赖分类与测试 seam

按 `codebase-design` 的依赖分类：

| 依赖 | 类别 | 处理 |
|---|---|---|
| XML tokenization、字段映射、profile 渲染、稳定排序 | in-process dependency | 直接使用可信库并做纯函数测试；不要为 parser 库包一层无信息的 Interface。 |
| 文件发现、真实路径校验、hash、原子写入 | local-substitutable dependency | 抽出窄的 `NfoFileStore`，测试替换为 temp directory 实现；生产仍使用真实文件系统。 |
| Javdex repository/query、资源选择 | local-substitutable dependency | 使用临时测试数据库或已有 repository fixture。 |
| `mediaAssetStore` 暂存/提交/回滚 | local-substitutable dependency | 通过现有 Module seam 注入，验证成功与强制失败。 |
| Agent/LLM | true external dependency | 完全可选的 Adapter；核心导入导出测试不依赖模型。 |

Interface 应围绕业务边界建，不要围绕每个底层函数建。尤其不需要 `IXmlParser`、`IPathJoiner`、`IRatingNormalizer` 之类一实现 Interface；它们降低 locality 且没有可替换价值。

## 8. Fixture 与验证策略

### 8.1 方言 fixtures

fixture 只保留自建的最小 XML/目录树，不提交第三方影片描述、图片或完整样例，避免版权和隐私问题。每个 fixture 在注释中固定上面调研所用 commit：

1. `mdc/`
   - `<stem>.nfo`
   - `num/maker/label/release` 三组日期、actor、poster/thumb/fanart
   - 同时包含标量 0–10 rating 和 `ratings[name=jdb,max=5]`
2. `mdcx/`
   - 精确同名 NFO
   - `publisher/label`、`series/set`、`originalplot/plot`
   - `<stem>-poster.jpg` 与 `poster.jpg` 同时存在，验证优先级
3. `javinizer/`
   - `<ID>.nfo` 与 `<ID>.mp4`
   - `id`、actor altname/role
   - `folder.jpg`、`fanart.jpg`、`.actors/Name_With_Underscores.jpg`、`extrafanart/fanart1.jpg`
4. `javsp/`
   - `movie.nfo` + 单一逻辑影片目录
   - `uniqueid[type=num/cid]`、结构化 `set/name`
   - `poster.jpg`、`fanart.jpg`

### 8.2 安全与冲突 fixtures

- XML 外部实体、DTD、指数实体扩张、超深节点、超大字段。
- `../outside.jpg`、绝对路径、UNC/device path、目录内 symlink 指向 root 外。
- `<stem>.nfo` 与 `movie.nfo` 内容冲突。
- NFO code 与当前影片 code 不一致。
- 两个影片共用目录但只有一个 `movie.nfo`。
- 无效图片、损坏图片、远程图片 URL 被忽略并产生普通 warning。
- 多导演、无 gender actor、重复 tag/genre、不同 rating max。

### 8.3 导出 golden fixtures

- `portable-v1`（通用 / Kodi）、`jellyfin-current`、`emby-kodi-conservative`、`plex-nfo-1.43.1+`、`infuse-current` 五个 profile 的 XML 与目录树 golden。
- VidHub、Nova、Zidoo、Stash nfoSceneParser、Serviio 使用通用 / Kodi 输出做版本固定的消费端 smoke fixture，不复制 renderer。
- 同一输入连续 render 两次必须字节相同。
- `portable` 输出再由 importer 读取，除明确列出的 lossy 字段外应得到等价归一化模型。
- 每个 target 至少做一次实际服务端 smoke test，记录版本号；源码/文档兼容不等于已验证所有 UI 展示行为。
- 覆盖 plan 后 snapshot 变化、目标文件变化、权限失败、磁盘写失败、原子 rename 失败和回滚。

测试应从 `VideoMetadataSource.collect` 与 `NfoExportModule.plan/apply` 调用，而不是直接只测内部 helper，这样重构内部算法时合同仍有效。

## 9. Agent 的适用边界

> 产品决定：以下能力全部延期。V1 不实现任何 NFO 相关 Agent 工具、UI 或模型依赖；本节仅保留后续设计边界。

### 9.1 适合交给 Agent

- 对未知 NFO 展示“识别到哪些字段、哪些字段被忽略、为什么需要确认”。
- 在批量导入前归纳冲突类型，建议用户选择 fill-empty、replace-present 或逐项确认。
- 对一组脱敏 fixture 聚类方言，并生成新的映射/profile **草案和测试草案**。
- 调用确定性工具生成导出 plan，再把覆盖数量、风险和不可表达字段解释给用户。
- 在用户明确批准后，调用 host Module 执行已冻结的 plan。

### 9.2 不应交给 Agent

- 直接解析生产 XML 并把模型输出当作最终元数据。
- 猜测番号身份、绕过业务 identity 或自动解决跨影片冲突。
- 接收任意绝对路径、遍历目录或直接写文件。
- 自由决定覆盖现有 NFO/图片。
- 在没有 profile 和测试的情况下即兴生成消费者 XML。
- 作为扫描主路径的必需依赖；离线、无模型或模型失败时 NFO 功能必须完整可用。

### 9.3 建议给 Agent 的工具

工具应以领域 ID 为输入，不接受任意路径：

```ts
inspect_nfo_import({ videoId, resourceId })
// -> normalized preview, provenance, warnings, conflicts

plan_nfo_export({ resourceIds, profile, collisionPolicy, options })
// -> planId/revision, create/replace/skip counts, warnings

apply_nfo_export({ planId, expectedRevision })
// -> deterministic report; stale plans are rejected
```

`inspect_nfo_import` 是只读工具；真正应用仍走已有刮削候选确认工具。`apply_nfo_export` 必须只消费 host 已生成的 plan，而不能让 Agent 提交任意路径与 XML。这样 Agent 是 true external Adapter，而不是核心 Module 的一部分。

## 10. 建议的 V1 产品范围

### 导入

- 在影片刮削来源列表中显示“本地 NFO（内置）”。
- 在媒体库扫描配置中提供默认开启的“自动导入本地 NFO”；只对累计状态为未刮削或刮削失败的影片自动应用，已刮削成功影片跳过元数据应用。
- 扫描开关只控制新资源首次发现时的自动读取；无论开关状态如何，本地 NFO 都可用于单片、批量、组合和默认影片元数据来源。
- 本地 poster/folder/cover 导入为影片封面；fanart/extrafanart 导入为样张且不自动设为详情背景；演员图片只为空头像补齐。
- NFO 远程图片 URL 在自动与手动导入中均直接忽略并记录普通 warning；V1 不下载远程图片。
- 支持单文件资源目录中的 `<stem>.nfo`，以及单一逻辑影片目录的 `movie.nfo`。
- 兼容本报告列出的 MDC、MDCx、Javinizer、JavSP 字段和本地资产命名。
- 默认字段策略使用现有 fill-empty；用户可选择其他已有 update mode。
- 手动导入读取目标影片在所有媒体库中的全部本地锚点；多份唯一 NFO 形成多候选确认，不要求用户预先选择资源。
- 本地 NFO 无匹配时允许继续其他网络来源；NFO identity 冲突必须待确认。
- 不支持 VIDEO_TS/BDMV、用户观看状态和自动重命名。

### 导出

- V1 只在 `设置 → 存储` 增加一个“NFO 导出”模块；不在影片详情、媒体库列表或刮削插件设置中增加入口。
- 导出范围按一个或多个媒体库选择，覆盖其中全部本地视频与 STRM 源文件锚点；同一影片的不同物理资源分别导出，无本地锚点的链接资源跳过。
- 默认“通用 / Kodi” profile，另有 Jellyfin、Emby、Plex NFO Agent、Infuse；profile 主要表达标签与图片命名差异，不复制 exporter 类。
- Plex 在 UI 中只有“Plex NFO Agent（PMS 1.43.1+）”一个目标，并明确提示必须在 Plex 媒体库中选择对应 Agent；默认 Plex Movie Agent 不受支持。
- Infuse profile 使用同名 NFO、`<stem>.jpg` 海报与 `<stem>-fanart.jpg` 背景，并提示 UPnP/DLNA 连接不支持本地 metadata override。
- 必须先预览 plan，展示新建、覆盖、跳过、warning 数量。
- 正式导出通过遮盖页面的阻塞式进度弹窗运行；任务结束或用户明确终止前不能关闭弹窗、导航或执行其它应用操作。终止后不再开始新文件，已开始的单文件原子写入完成后展示部分报告；任务不后台化、不持久化、不恢复。
- 默认精确同名 sidecar，默认不覆盖，默认不复制演员头像、不导出个人状态。
- V1 支持样张导出。
- 只导出到用户选中的现有影片资源旁，不创建新的媒体库或整理目录。

## 11. 实施顺序

1. 先提交 fixtures、安全 parser 与私有 `NfoArtifactCodec`，不接 UI。
2. 提取 `VideoMetadataSource` seam，并用 `WebScraperSourceAdapter` 保持现有行为完全不变。
3. 加入 `LocalNfoSourceAdapter`，接入候选暂存、待确认和 apply；完成 MDC/MDCx/Javinizer/JavSP contract tests。
4. 实现 `NfoExportModule.plan/apply` 与 portable profile，完成原子写入和 collision tests。
5. 加 Jellyfin、Emby、Plex NFO Agent、Infuse profiles 与实际消费端 smoke test 记录；同时验证 VidHub、Nova、Zidoo、Stash、Serviio 是否可直接复用通用 / Kodi 输出。
6. Agent 集成移出 V1，作为后续独立项目；本次只保持确定性 Module seam，不实现任何工具或 UI。

## 12. 最终判断

- **“导入做成内置影片刮削插件”在产品概念上成立，在现有沙箱技术概念上不成立。** 应将“插件”改称更宽的“元数据来源”，用 host-owned Adapter 接入。
- **“导出作为单独功能”是正确方向。** 它有独立的目标 profile、写入权限、碰撞与原子性语义，应由专门 Module 承担。
- 最小而足够深的 Interface 是：来源 1 个入口，导出 2 个入口；XML codec 保持私有。
- 兼容性应由固定 commit 的一手 fixture 和消费者 golden/smoke test 保证，而不是靠工具名称判断方言。
- Agent 的价值在处理歧义和编排，而不是替代确定性的 XML、身份、路径和写入规则。
