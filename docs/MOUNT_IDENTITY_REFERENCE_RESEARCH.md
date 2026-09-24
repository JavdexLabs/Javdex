# 开源项目的挂载离线与根目录身份处理

> 状态：研究，未实施。日期：2026-09-12。
>
> 对应《服务端模式可行性研究》的第一个缺口：挂载离线、空挂载及同路径换目录。以下区分已核查实现与针对 Javdex 的建议，不改变 ADR-0024。

## 结论

核查 Syncthing、Immich、Jellyfin、Kodi 的官方文档和发布版本源码后，最明确的共同点是：**先避免把存储异常当作文件删除，再决定是否清理目录记录。**

标记文件已有成熟实践，但“标记存在”通常是可用性检查，不是不可复制的物理卷身份。所核查的根访问/清理路径，没有把跨重启的 `deviceId + inode` 一致作为共同前提；这不等于这些项目在其它功能中完全不使用 inode。

因此不能声称“其它成熟项目都做了强物理身份绑定”，也不能声称“用了标记就能识别所有换卷”。Javdex 现有 ADR 对替换目录的要求比这些可用性检查更强。

## 核查基线

通过各官方 GitHub 仓库的 latest release API 查询发布版本，再解析标签对应 commit；源码链接固定到 commit，避免后续主分支变化影响结论。

| 项目 | 发布版本 | 核查 commit |
|---|---|---|
| Syncthing | v2.1.5 | `2ca95cf1498104113fdfde46df4107f2450a0f71` |
| Immich | v3.2.0 | `1b6098c9dbfffe978bec2d414606ed7a4c8e019a` |
| Jellyfin | v12.0 | `6c073e19ddf604b2369c638716164fdab4c952dc` |
| Kodi | 21.3-Omega | `a3a448d26b8d560a65655dab2cd122994dc4e146` |

本次为文档与源码核查，没有启动这四个完整产品做故障注入。下文场景推导不等于端到端实测，也不保证覆盖产品所有后台清理入口。讨论帖只用于定位问题，不作为最终行为依据。

## Syncthing：标记缺失时停止同步

官方 FAQ 明确说明 `.stfolder` 用于区分目录正常存在与 USB 拔出、文件系统卸载等情况。标记缺失时停止该目录同步，标记恢复后才继续；恢复后缺失文件仍可能被解释为删除。只读目录可配置一个确定会存在的文件或目录作为 `Marker Name`。[官方 FAQ](https://docs.syncthing.net/users/faq#i-am-seeing-the-error-message-folder-marker-missing-what-do-i-do)

源码中的 `CheckPath` 检查根目录及配置的标记是否存在。当前创建流程还会在 `.stfolder` 内写入包含 folder ID 和创建时间的说明文件，但 **`CheckPath` 没有读取并比对这个 ID**，所以不能把说明文件解释成强身份验证。见 [FolderConfiguration](https://github.com/syncthing/syncthing/blob/2ca95cf1498104113fdfde46df4107f2450a0f71/lib/config/folderconfiguration.go#L156-L246)。

检查也不只发生在启动时：同步前会检查目录健康，扫描更新批次提交前也会重新检查，发现错误便停止提交该批次。这里指具体的扫描更新回调，不是声称任意文件操作都具有同一个原子保护。见 [folder 健康检查](https://github.com/syncthing/syncthing/blob/2ca95cf1498104113fdfde46df4107f2450a0f71/lib/model/folder.go#L375-L425)、[扫描批次](https://github.com/syncthing/syncthing/blob/2ca95cf1498104113fdfde46df4107f2450a0f71/lib/model/folder.go#L591-L607)。

**对 Javdex 的价值：**标记缺失时冻结处理；在扫描提交边界重查，而不只做一次启动检查。限制是默认标记仅证明存在：另一个目录只要也有 `.stfolder`，该检查本身就不能分辨。

## Immich：自管存储与外部目录使用不同机制

### 自管存储

Immich 在 `upload`、`library`、`thumbs`、`encoded-video`、`profile`、`backups` 等内部存储目录使用 `.immich`。启动时创建初始标记、验证可读及可写；检查失败默认阻止启动。官方也提供忽略检查的逃生配置，不能将其作为正常部署方式。[System Integrity](https://docs.immich.app/administration/system-integrity/)

源码把每个目录已经初始化的状态保存在数据库 `mountChecks` 中，因此已初始化目录的标记后来消失时，不会每次启动都自动补建。标记写入内容是时间戳，读检查并不将它与数据库中的唯一卷 ID 对比；写检查会覆盖时间戳。见 [StorageService](https://github.com/immich-app/immich/blob/1b6098c9dbfffe978bec2d414606ed7a4c8e019a/server/src/services/storage.service.ts#L47-L95)、[标记读写](https://github.com/immich-app/immich/blob/1b6098c9dbfffe978bec2d414606ed7a4c8e019a/server/src/services/storage.service.ts#L155-L196)。

这适合借鉴到 Javdex 的 `/data/media_assets`：应用曾经使用过的图片卷消失时，不能在空挂载上悄悄重新初始化。它不是所有外部媒体目录都带唯一身份的证据。

### 外部目录

外部图库扫描使用导入路径与文件状态。已存在资产的同步把 `stat` 失败转换成不可访问状态，再设置 `isOffline`，部分分支还设置 `deletedAt`；恢复可访问时，符合条件的记录会恢复在线。该路径将找不到文件与权限错误都纳入不可访问情况。见 [LibraryService](https://github.com/immich-app/immich/blob/1b6098c9dbfffe978bec2d414606ed7a4c8e019a/server/src/services/library.service.ts#L475-L610)。

官方外部图库文档说明，磁盘文件删除后重扫会进入回收站，保留期限结束会失去相应的库内元数据。外部文件发现流程另外会校验导入路径，无有效路径时跳过；不能据此认为所有既有资产同步都受同一标记保护。[外部图库文档](https://docs.immich.app/features/libraries/)、[外部路径校验](https://github.com/immich-app/immich/blob/1b6098c9dbfffe978bec2d414606ed7a4c8e019a/server/src/services/library.service.ts#L613-L651)

**对 Javdex 的价值：**借鉴“数据库记住已初始化标记”，避免异常时自动重建。外部资源 `offline` 状态可借鉴，但不能照搬为“无法访问即启动删除倒计时”；这不符合 Javdex 对离线媒体库保留归属的合同。

## Jellyfin：跳过空的或不可访问的顶层媒体目录

核查版本的 `Folder.IsLibraryFolderAccessible` 对顶层媒体目录做保护，无法访问或为空时跳过验证。在子项处理的相应分支中保留已有条目，使其不被当作扫描后消失的项。见 [Folder.cs](https://github.com/jellyfin/jellyfin/blob/6c073e19ddf604b2369c638716164fdab4c952dc/MediaBrowser.Controller/Entities/Folder.cs#L377-L470)。

这里的 `DirectoryService.IsAccessible` 实际依据是枚举目录项后调用 `.Any()`，不是校验卷 UUID、目录标记或历史 inode。见 [DirectoryService.cs](https://github.com/jellyfin/jellyfin/blob/6c073e19ddf604b2369c638716164fdab4c952dc/MediaBrowser.Controller/Providers/DirectoryService.cs#L181-L184)。

由此可以推导：空挂载有机会被挡住，但换成另一个非空目录无法仅靠这一判断识别；真正清空了最后一项的目录也会触发保守的空目录处理。它是有意减少误清理的启发式保护，不能作为完整挂载身份方案。这里描述所核查入口，不能推导所有异常或子目录场景都安全。

**对 Javdex 的价值：**空目录/异常扫描应该有清理保护；但 Javdex 若已有强身份标记，就不必永远把“合法空目录”当作离线。空目录保护适合作为额外防线。

## Kodi：来源不可用时，把清理决策留给用户

Kodi 的资料库清理先找可能缺失的文件，再确认所属来源是否存在。在 `CleanMediaType` 中，来源缺失或不再属于有效来源时，静默模式默认保留媒体记录；交互模式询问用户如何处理该来源中的项目。见 [VideoDatabase.cpp](https://github.com/xbmc/xbmc/blob/a3a448d26b8d560a65655dab2cd122994dc4e146/xbmc/video/VideoDatabase.cpp#L10407-L10472)。官方操作说明也展示了 unavailable source 下的 Keep/Remove 选择。[Kodi Wiki](https://kodi.wiki/view/Updating_or_removing_videos)

这个清理流程主要改变数据库中的媒体记录，并不意味着它会删除离线磁盘上的源文件。其判定仍依赖来源路径是否存在：如果空挂载点本身存在，不能单靠这条规则知道挂载出了问题；换成另一个可访问目录同样没有物理身份保证。

**对 Javdex 的价值：**后台维护遇到不确定来源默认保留，明确清理通过用户确认完成。相比把保留期当作删除授权，更符合家用 NAS 的长时间离线情况。

## 对照与场景推导

下表只概括上述核查机制，不能当作四个产品的完整安全保证：

| 机制 | 整个根不可访问 | 挂载变成可访问空目录 | 换成另一个可访问非空目录 |
|---|---|---|---|
| Syncthing 默认标记 | 目录健康检查阻止同步 | 缺标记则阻止同步 | 只要有同名标记，该检查不能分辨 |
| Immich 自管存储标记 | 启动检查默认失败 | 已初始化而缺标记，默认失败 | 标记可读写时，该检查不比较唯一卷身份 |
| Jellyfin 所核查顶层目录检查 | 跳过/中止相应验证路径 | 无目录项时跳过 | 存在目录项不能证明仍是原目录 |
| Kodi 所核查来源清理检查 | 静默保留，交互询问 | 路径存在时可能进入普通缺失清理 | 来源存在不能证明仍是原目录 |

Immich 外部图库没有放进“自管存储标记”一行；它有独立的不可访问/回收站处理，上面已经说明。

## 用户确认的第一版范围

用户于 2026-09-12 确认第一版只处理路径卸载，不处理更换挂载目录。因此以上换卷和强身份比较属于研究背景，不作为第一版要求。

采用固定可读标记、数据库初始化记录和对应根的离线状态：首次添加时创建标记，只读挂载由管理员预置；初始化后缺失不自动补建。扫描开始、结果提交和缺失清理前复核，异常时停止对应根的扫描与文件维护，保留归属与资料；原路径标记恢复可读后自动恢复。

标记必须放在实际挂载的存储内；独立挂载的子目录单独注册为根。第一版不引入随机目录 UUID、绑定版本或显式重绑，也不要求服务端跨重启保持相同 inode。另一个目录带有相同可读标记时将被视为可用，这是已确认的范围边界。

本地模式的 ADR-0024 和现有 guard 保持不变。服务端仍需保留路径包含、符号链接逃逸防护、普通文件检查、打开后描述符校验和写入父目录检查；实施时补充服务端范围的决策记录。

这一组合主要借鉴 Syncthing 的标记与提交前检查、Immich 的初始化记录、Kodi 的后台保留策略。上述机制的卸载保护仍需在 Javdex 的扫描和清理流程中做故障验证；本次仅更新设计，没有实现生产代码。
