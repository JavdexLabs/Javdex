# NFO 演员头像兼容性来源

以下是 2026-09-05 的消费端核查；表中的兼容判断针对当时含空格的旧文件名布局，不是当前导出配置。空格转下划线已落地，现行行为见 [NFO 参考](../../website/src/content/docs/reference/nfo.md#演员头像)。本次来源核查未在消费端实机导入，不能从解析姓名或远程 thumb 推定本地相对头像已显示。

## 各消费者

| 消费者 | 已核实事实 | 核查时布局的判断 |
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
