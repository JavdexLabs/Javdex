# NFO 格式与消费端来源

以下保留 2026-09-04 对固定上游源码、字段与文件布局的核查；已落地的架构候选、实施顺序和完成清单不再重复维护。当前输入、输出与限制见 [NFO 参考](../../website/src/content/docs/reference/nfo.md)，合成样例范围见 [fixture 说明](../../test-fixtures/nfo/README.md)。

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
