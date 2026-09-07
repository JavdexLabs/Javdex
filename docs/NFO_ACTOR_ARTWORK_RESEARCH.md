# NFO 演员头像导出价值与兼容边界

调研日期：2026-09-05。依据官方文档、官方团队说明及固定版本源码；本次未在消费端实机导入。本文不把“读取演员姓名”或“支持远程头像 URL”当作“支持当前本地相对路径头像”的证明。

实现更新：已将头像导出文件名中的普通空格替换为下划线，同步 NFO 引用，保留原姓名和默认关闭设置；增加兼容性说明，并验证新头像实际导出后回读、旧文件名回读与空格/下划线名称碰撞。下文“当前实现”保留调研时描述，现行行为见 [兼容性说明](NFO_COMPATIBILITY.md#演员头像)。本次仍未进行消费端实机显示验证。

## 结论

建议保留默认关闭的演员头像导出。它对本地备份、Javdex 迁移及 Kodi / Emby 本地头像有实际用途，价值比没有统一展示语义的样张更明确。但当前 `.actors/<演员名>.jpg/png` 和 NFO 相对路径不能承诺所有播放器直接显示；应补齐 Kodi 的空格转下划线命名，界面说明支持边界，无须新增同步系统或各播放器私有演员数据库导出。

## 各消费者

| 消费者 | 已核实事实 | 当前导出的判断 |
| --- | --- | --- |
| Kodi | 官方规定 `.actors/<FirstName>_<LastName>.jpg`；21.3-Omega 的 `FetchActorThumbs` 枚举 `.png/.jpg/.tbn`，将演员名中的普通空格替换成 `_`，按去扩展名后的文件名精确匹配；找不到再尝试 NFO thumb URL。 | `.actors` 是明确支持的用途。当前文件名保留空格，带空格的演员名不满足目录发现约定；不能靠未验证的相对 URL 回退掩盖。 |
| Emby | 官方团队说明 4.8 起原生只读电影/剧集目录下的 `.actors`；同演员全库共享一张图，先扫描到的图会被共享。首次扫描或完整元数据刷新读取，普通扫描不持续监视目录。 | 有实际用途。官方说明没有在文字中完整规定命名归一化和相对 XML 路径，不应宣称所有特殊名字已验证。旧库补文件后可能需要完整元数据刷新。 |
| Jellyfin | 10.11.10 的 NFO XML 扩展解析器把 `actor/thumb` 原样赋给 `PersonInfo.ImageUrl`；LibraryManager 在该演员尚无主图时直接将它作为主图路径保存。 | 这条已检查链路没有相对媒体目录解析；当前 `.actors/name.jpg` 的显示不能保证。本次未核实独立 `.actors` 发现路径，不将“解析到了 thumb”写成“头像已成功载入”。 |
| Plex | 当前官方 NFO Agent 文档明确读取 `actor/thumb` 图片 URL，示例使用 HTTPS。 | 演员图片字段本身有价值，但官方没有明确保证当前 `.actors` 目录发现和相对 thumb；不要沿用“Plex 完全不支持 NFO”的旧结论，也不要反向推定已支持这一本地布局。 |
| Infuse | 官方说明支持电影 XML/NFO；官方示例含演员姓名、角色、TMDB ID 和 HTTPS thumb。 | 可以确认示例有演员头像字段，不能确认当前本地 `.actors` 相对路径；通过 Jellyfin/Emby 连接时与直接 SMB/NFO 模式应分别验证。 |

来源：

- [Kodi 官方演员图片规范](https://kodi.wiki/view/Artwork_types#actor)。
- [Kodi 21.3-Omega FetchActorThumbs 源码](https://github.com/xbmc/xbmc/blob/21.3-Omega/xbmc/video/VideoInfoScanner.cpp#L2211-L2243)。
- [Emby Team 关于 4.8 原生支持与刷新行为的说明](https://emby.media/community/topic/115978-media-actors-folder-import-export-standalone-plugin/page/2/)（Luke，2023-11-06、2024-02-29）。
- [Jellyfin 10.11.10 演员 XML 解析](https://github.com/jellyfin/jellyfin/blob/v10.11.10/MediaBrowser.Controller/Extensions/XmlReaderExtensions.cs#L74-L141)，[人物图片写入](https://github.com/jellyfin/jellyfin/blob/v10.11.10/Emby.Server.Implementations/Library/LibraryManager.cs#L2836-L2902)。
- [Plex 官方 NFO Agent 文档](https://support.plex.tv/articles/using-nfo-metadata-files-with-plex/)。
- [Infuse 官方本地元数据说明](https://support.firecore.com/hc/en-us/articles/4405042929559-Overriding-Artwork-and-Metadata)，[官方电影 NFO 示例](https://files.firecore.com/samples/sample-movie.nfo)。

## Javdex 当前实现与产品建议

主任务核对了当前实现：选项默认关闭；不勾选时仍导出演员名单，只省略头像文件和头像引用。导出的是当前演员头像，同目录同源头像去重，冲突不写且去掉引用，跨影片目录会有副本。自身导入优先解析本地 thumb 引用，之后兼容 `.actors/原名` 与空格转下划线名称。因此，头像文件可用于自身迁移，不只是无消费者的附件。

建议保留现有选项，说明为“供支持本地演员头像的软件使用，也用于备份和迁移”。将文件名普通空格统一为下划线，并保持 NFO 引用一致，继续保留原姓名字段及导入旧文件名兼容。文件名非法字符归一化后的同名冲突仍需按现有机制处理。对于 Plex、Infuse 和当前 Jellyfin 相对路径链路，先标明兼容性未验证，后续有实际目标版本时用隔离媒体目录验证。

无需为头像引入新裁剪 UI、人物身份合并系统或全库全局头像目录。头像的导出价值与演员名单应分开判断，不能为减少图片导出而删掉演员关系。
