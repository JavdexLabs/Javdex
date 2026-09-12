# 服务端管理合同与验收研究

> 状态：方案细化，未实施。主方案及已确认产品边界见 [服务端模式可行性研究](SERVER_MODE_FEASIBILITY_RESEARCH.md)。
>
> 本轮依据用户“简单问题直接决定”的授权确定下列技术细节；它们不是现有 API。研究基线仍为 `cac9f6982eaef6afc34f86f9a51486f8ff10dd2b`。后续经用户授权已调整源码目录，当前引用为新路径，schema 与业务行为保持基线；结构现状及实施步骤见 [执行计划](SERVER_MODE_EXECUTION_PLAN.md)。

## 覆盖依据与边界

核对源为 [`ipc-channels.ts`](../packages/contracts/src/ipc-channels.ts)、[`ipc/index.ts`](../apps/desktop/src/main/ipc/index.ts) 及各 handler / 类型合同。声明共 282 项、37 个前缀，包含请求、推送事件、桌面工具和兼容入口；数量是源文件清点结果，不表示 282 个可调用 HTTP 端点，也不是逐入口功能验收已通过。

下表的版本符号定义在后文。所有服务端管理查询都需要当前管理授权；网页继续使用独立的只读授权和可见范围。桌面留存的 Agent、刮削与模型配置不得为远程模式打开原本地资料库；若原实现把工作记录放在同一 SQLite 中，需拆出桌面工作记录存储。这是运行时边界要求，不是复制权威资料库。

| 入口组与证据 | 远程模式的归属和必要字段 | 版本与完成边界 |
|---|---|---|
| `HOME_*`、影片列表/详情/年份、`TAG_*`；[影片 handler](../apps/desktop/src/main/ipc/videoHandlers.ts) | 服务端管理查询；显式 `scope`、媒体库 ID、筛选排序与分页。保留全局、隐藏、归档等合法管理范围；标签查询不能接受任意 SQL | 详情带相应版本；分页带查询快照版本，见下文 |
| 影片编辑、评分、清空资料、标记刮削成功、番号纠正、手动标签 | 服务端；目标 ID、操作专用字段和预期版本。番号纠正的待确认清理选择必须显式提交；不把通用 object 原样透传 | `V`；同一影片资料及其关联更新同事务。已有业务身份冲突继续拒绝，不自动合并 |
| 封面、样张；[影片合同](../packages/contracts/src/videoIpcContract.ts) | 桌面取图或选图；服务端接收 `uploadId` 或当前对象允许使用的 `assetId`。旧 `posterPath`、桌面临时路径和未经授权的全局图片 ID 不能直接作为远程输入 | `V`；图片引用、上传消费与资料回执同数据库事务，文件阶段按恢复协议 |
| 资源查询、导入、编辑、设主、移除、拆分 | 服务端；显式媒体库、影片和资源 ID。外部资源允许经过校验的目标链接；本地文件用根和相对定位，不能提交桌面绝对路径。移除最后资源的处理选择沿用现有合同 | `R` 与 `L`；创建/拆分涉及影片时再复核 `V` 和身份约束；主资源与资源集合一并更新 |
| `VIDEO_RESOURCE_CHECK`；[链接检查服务](../apps/desktop/src/main/services/videoResourceLinkService.ts) | 该入口会发出网络 HEAD 请求，留在桌面执行；结果仅是当前桌面网络的提示，不作为服务端允许入库或播放的证明 | 无业务写入；服务端保存链接时仍独立校验格式与去重 |
| 移出媒体库、跨库移动资源、全局删除、影片合并 | 服务端生成影响预览，再由显式用例提交；返回各媒体库归属、清单影响、资源/文件影响，不能只有布尔值 | 全部受影响的 `V/R/L/P` 和 `planId`；数据库合并是原子业务用例，文件删除不能伪装成可整体回滚 |
| 演员查询、编辑、图库、头像、删除、合并；[演员 handler](../apps/desktop/src/main/ipc/actressHandlers.ts) | 服务端读写；图库/头像上传同图片合同。查询用于测试或裁切也必须经管理授权，不沿用网页图片范围 | `A`；合并、删关联还覆盖受影响的 `V` 和冲突记录。批量删除须保留已有单用例事务边界 |
| 演员名称冲突队列、校验、解决、丢弃 | 服务端权威待确认数据；提交冲突记录 ID、`Q`、明确分配选择及涉及演员版本 | 整份冲突解决同事务；相关名称变化后拒绝旧选择。迁移阻塞类别明确包含待确认演员刮削/名称冲突 |
| 机构、导演、系列、分类图片；[分类 handler](../apps/desktop/src/main/ipc/facetHandlers.ts) | 服务端；保留机构角色、别名、系列所属机构和唯一身份规则，图片使用受控引用 | `F`；删除/角色移除/合并复核关联范围和预览；发行商合并造成影片身份冲突时仍拒绝 |
| 清单查询、创建、编辑、成员加入/移除；[清单 handler](../apps/desktop/src/main/ipc/playlistHandlers.ts) | 服务端；清单是全局资料，不因当前媒体库筛选而丢失跨库引用。封面与相关链接仍按清单业务规则处理 | `P`；清单元数据与有序成员共用一个版本；影片删除/合并导致成员变化时同样递增 |
| 媒体库、配置、根、归档/恢复/删除；[媒体库 handler](../apps/desktop/src/main/ipc/mediaLibraryHandlers.ts) | 服务端；添加根使用部署允许范围内的选择结果，名称/规则与物理定位分开。服务端首版不开放更换已绑定挂载目录/重绑接口；本地根迁移入口保留本地行为 | `L/C/G`；跨库根重叠等条件在最终事务与文件 guard 边界复核，不能只检查预览 |
| 扫描启动/取消、审计、文件重命名/手动导入；[扫描 handler](../apps/desktop/src/main/ipc/scanHandlers.ts) | 服务端任务及受限文件选择；审计分页查询也需管理授权。历史路径用于显示，不得反过来作为可执行文件票据 | 扫描使用任务及提交批次规则；单文件维护带 `G/R` 和预览。远程审计定位改为根名称与相对路径 |
| 待确认扫描组、资源身份、队列及 presence | 服务端；ID、待确认版本、完整用户分配。STRM 提交前还须重读源文件并比对快照 | `Q`、有关 `V/R/G`；整组确认同事务，变更后拒绝原提交，不部分处理 |
| NFO 选项、偏好、计划、开始、终止、进度；[NFO handler](../apps/desktop/src/main/ipc/nfoExportHandlers.ts) | 服务端生成计划和执行文件操作；桌面展示和确认。预览不是 GET 查询，因为可能占用维护资源 | `C`、计划涉及的 `V/R/G`；计划有效期 10 分钟、重启失效；开始返回任务 ID |
| 影片/演员单次、批量刮削和重匹配；[刮削 handler](../apps/desktop/src/main/ipc/scrapeHandlers.ts) | 插件、网络访问、候选与批次调度在桌面；服务端提供目标查询、暂存上传和逐项应用。批次暂停/取消管理桌面采集，不撤销已受理的服务端提交 | 采集前记下 `V/A`，提交携带原版本。不能在提交前偷偷刷新版本后覆盖；每项固定操作编号 |
| 待确认影片刮削查询/确认/丢弃 | 服务端持有元数据及关联图片；桌面只保留选择状态 | `Q` 和 `V`；确认或丢弃与图片引用/回收状态原子协调 |
| 头像自动裁切、face manifest、裁切请求/结果 | 图片通过管理接口获取，人脸模型和裁切计算留在桌面；来源图片摘要/版本必须随候选结果返回 | `A` 与来源图片版本；过期结果不能覆盖新头像，正式裁切图片经上传提交 |
| `LIBRARY_CURATOR_*`、`LLM_TRANSLATE_TO_CHINESE` | 模型调用与对话在桌面；资料库助手通过固定管理查询工具读取当前资料库，不能直连服务器 SQLite 或开放任意 SQL | 只读助手无业务提交；翻译结果属于编辑草稿，保存时再检查目标版本 |
| `AGENT_METADATA_*`；[资料采集 handler](../apps/desktop/src/main/ipc/agentMetadataHandlers.ts) | 启动/恢复/采集/工作快照在桌面；正式计划/应用由服务端根据当前身份复核，桌面传结构化候选、图片上传 ID 和选择 | `V/A/F/Q` 按目标选择；对话状态不等于已提交待确认记录，也不跨 catalog 自动应用 |
| `PLAYLIST_IMPORT_*`；[清单导入 handler](../apps/desktop/src/main/ipc/playlistImportHandlers.ts) | 外站访问与交互会话在桌面；目标检索、身份判定及最终清单写入在服务端。保留现有身份选择和清单来源链接选项 | `P/L`、已选影片版本及身份依赖；一个最终应用计划按现有业务原子边界提交，不按页面项拆成无保护请求 |
| 插件列表、包导入/导出/安装/测试/开发、模型发现/测试、代理测试、应用更新、普通外链 | 留在桌面；远程模式只更换领域查询/提交依赖，不远程执行插件或把密钥上传服务器 | 桌面设置/工作状态；应用更新检查只负责桌面版本，不能借管理 API 更新容器 |
| `SETTINGS_*`、`WEB_ACCESS_*`；[设置 handler](../apps/desktop/src/main/ipc/settingsHandlers.ts) | 按主方案拆为“此电脑/当前服务器”。网页配对/撤销/设备管理在服务端，版本与状态 DTO 不含秘密 | `C` 和设备/配对记录版本；关闭网页访问只关闭浏览入口，管理 HTTP 仍工作。监听端口、对外地址和允许挂载范围由部署配置管理 |
| `PLAYER_*`、`EXTERNAL_LINK_OPEN` | 桌面启动程序；服务端仅签发已授权本地影片播放地址。远程 reveal 统一不执行桌面文件定位 | 播放按主方案资源定位版本；系统打开结果不等于媒体播放完成 |
| `ASSET_CRYPTO_*`、`ASSET_STORAGE_RELOCATE` | 用户已确认首版服务端只存未加密图片；远程模式隐藏加密及桌面资产目录迁移动作。服务端资产位置由数据卷配置决定，迁库前源端须完成实际资产解密 | 本地模式原功能保留；远程管理接口不提供宿主绑定密钥、加密切换或在线搬动 `/data` 的能力 |

事件入口须逐项识别方向：`*_PROGRESS`、状态变化事件不是可写 HTTP 用例；头像裁切结果虽属事件回复，也不能绕过服务端正式应用校验。原本同一个 IPC 横跨网络采集和数据库提交时，必须拆为桌面工作和服务器用例，不因一个入口归入“桌面”就允许其继续写本地库。

## 版本归属与请求字段（本轮确定）

本文规定服务端管理合同；它不是 renderer/preload 直接使用的全部桌面合同。桌面用例、领域后端端口与 HTTP DTO 的分层、字段映射和错误跨 IPC 规则，以 [执行计划](SERVER_MODE_EXECUTION_PLAN.md) 的“桌面目标架构与实施约束”为准。页面提供业务目标、原始版本和选择；身份/epoch/认证由主进程及 remote 适配器绑定。本地适配器直接调用 library，保持业务语义但不模拟 HTTP 握手。

第一版使用保守的聚合版本，不为评分、标题等每个字段增加独立版本。冲突后刷新并重新确认；允许少量保守拒绝以避免隐式覆盖。**主键 ID 与版本共同定位当前内容，ID 不替代版本。**

| 符号 | 版本范围 | 必须递增的变化 |
|---|---|---|
| `V` | 一部影片的共享资料 | 字段、评分、演员/分类/标签关联、正式图片、相关链接、刮削状态及业务身份改变 |
| `R` | `(libraryId, videoId)` 的成员与资源集合 | 固定/隐藏等成员状态，资源增加/删除/编辑、目标更新、主资源变化及成员移入/移出；成员删除重建不得复用旧版本标识 |
| `A` | 一位演员资料 | 名称与别名、简介、正式头像/图库、状态、合并/删除；仅关联影片标题变化不批量更新所有演员版本 |
| `F` | 单个机构/导演/系列 | 字段、别名、角色、所属机构、正式图片和合并/删除 |
| `P` | 一份清单 | 元数据、封面、相关链接、有序影片引用、影片合并/删除造成的成员调整 |
| `L/C/G` | 媒体库状态 / 可独立保存的配置记录 / 根目录绑定配置 | 名称或归档状态、相应规则设置、根配置或绑定变化。在线性还需实时 guard；不能用某个旧 `G` 证明当前文件可用 |
| `Q` | 单份待确认记录或原子确认组 | 候选更新、源文件快照变化、身份选择所依据的数据变化、确认或丢弃；删除后旧 ID/version 只能失效 |

这些符号是新合同的设计标签，不宣称现有数据库已经有对应列。版本的实现需保证对象删除重建后旧请求不会发生 ABA 误匹配，可使用不复用的对象代次和递增 revision。多实体操作由服务端建立完整依赖集，不能让客户端故意少传某些版本而跳过检查。

直接提交的通用包络固定包含：`operationId`、`serverId`、`catalogId`、`writerEpoch`、该用例要求的 `expectedVersions`、用例专用 `input`。输入使用白名单结构，缺失与显式清空有不同含义；拒绝未知字段、重复目标和非法枚举。每种用例独立决定 ID、数量和字符串长度限制，不接受无限数组或通用字段字典。

示例：修改影片资料需要 `videoId + V + fields`；设主资源需要 `libraryId + videoId + resourceId + R`；向清单加入影片需要 `playlistId + P + videoId` 并在事务内复核影片仍存在；演员名称冲突解决需要 `conflictId + Q + choices`，由服务器复核所有涉及的演员与名称归属。版本仅覆盖语义依赖，加入清单不因影片评分更新而无故失败。

预览类提交使用 `planId`、计划摘要及明确的用户选择，加上通用身份与操作编号。计划在服务端保存全部依赖版本、影响范围、根/文件检查依据，执行时重新验证；不接受客户端自报的影响数量。全局影片删除、合并等预览还要核验关联集合有无新增引用，单看已有记录的版本不够。

创建时没有目标旧版本，仍须事务内检查业务唯一约束、依赖对象和用户选择。查询时“没有匹配影片”不能当作创建时永久成立的事实。若执行时出现新的完整身份匹配，返回冲突要求重新确认，不能自动换成另一部影片。

短用例成功返回 `operationId`、业务结果 ID/计数及变更后的版本；任务受理返回 `operationId + taskId`。详情 DTO 使用受控图片引用和根名称/相对定位；源端绝对路径仅可存在于受控迁移描述与历史报告，不返回可执行路径。浏览 DTO 不复用管理 DTO 的“删几个字段”投影，继续独立白名单。

## 批量、错误与连接中断（本轮确定）

批量不统一改成一种事务模型：合并、整组身份分配、单次清单最终应用等既有原子用例保持原子；独立影片/演员的批量采集与应用逐项形成操作回执。扫描和 NFO 等已有批次文件任务保持真实部分结果和审计，取消不能撤销已提交项。

独立批量操作遇到单项版本冲突时标记该项“待刷新”，继续其它独立项；不得自动强制覆盖冲突项。相互依赖的项必须作为一个用例或明确依赖顺序执行，不能套用“继续下一项”。鉴权失效、身份变化、资料库冻结或服务不可达时停止发起后续提交；已经受理的任务另行查询，不重复启动。最终显示成功、冲突、失败、取消、未开始、结果待核实各类数量，不能只显示笼统“完成”。

业务错误合同采用稳定 `code`、简短 `message`、受控 `details`、`operationId`（如已建立）和恢复动作；不返回 SQL、堆栈、令牌或任意磁盘路径。

| 错误码（拟定） | 桌面处理 |
|---|---|
| `VERSION_CONFLICT` / `IDENTITY_CONFLICT` | 保留本地草稿供查看，刷新相关资料并要求重新确认；修改后用新编号提交 |
| `WRITER_REVOKED` / `AUTH_REQUIRED` | 停止管理读写及新任务提交，显示重新绑定入口；不拿网页会话重试 |
| `INSTANCE_MISMATCH` / `CATALOG_MISMATCH` / `VERSION_MISMATCH` | 停止目标访问和自动重放，显示两端身份或版本；不回退本地库 |
| `OPERATION_KEY_REUSED` | 拒绝，保留原回执；客户端不能通过自动换编号掩盖同一请求的程序错误 |
| `PLAN_EXPIRED` / `PLAN_STALE` | 重新生成预览，原确认无效 |
| `ROOT_OFFLINE` / `READ_ONLY_MOUNT` / `FILE_CHANGED` | 保留资源记录，显示对应根或文件问题；不改成缺失资源清理 |
| `CATALOG_FROZEN` / `MAINTENANCE_BUSY` | 显示状态；解除前不自动排入无期限队列 |
| `UPLOAD_NOT_READY` / `UPLOAD_EXPIRED` | 未受理应用不得改资料；确认原操作未提交后重传图片，再以新内容及新编号发起 |
| `RECOVERY_REQUIRED` | 显示已有结果与需核实部分，阻止盲目重放 |
| `INVALID_INPUT` / `LIMIT_EXCEEDED` | 显示具体字段或数量问题，不按网络错误自动重试 |

没有收到业务响应时，不能由 HTTP 超时推断失败。主进程在发出修改前持久保存最小“结果核实记录”：目标身份、操作编号、请求摘要、目标 ID、创建时间，不保存图片或可自动执行的完整写请求。这不是上传队列或离线同步；桌面重启后仅查询结果，无法恢复的草稿由用户重新准备。未核实的操作继续阻止迁移和模式切换。

## 查询分页、进度和桌面工具隔离（本轮确定）

首版进度传输采用分页状态轮询，不增加 WebSocket/SSE 连接恢复协议。桌面有活动服务端任务时默认每 2 秒查询，失败退避至最长 30 秒；恢复连接立即刷新状态。服务端状态带 `taskRevision` 和单调进度序号，终态不因迟到响应倒退。桌面既有 IPC 事件可由主进程根据远程状态生成，但不是服务端任意事件转发。

列表在一次查询响应内使用一致读；分页游标绑定身份、规范化查询/排序、稳定 ID 次序及数据视图版本。数据变化使后续页无法维持原视图时明确返回需刷新，不能悄悄拼接新旧两组分页。首版不为跨多次 HTTP 的列表持有长 SQLite 事务；活跃扫描下允许提示列表已更新，写入版本校验独立于列表游标。

服务端为页大小、筛选数组、批量目标和请求体设置明确上限。超过单请求范围的“全部目标”先在服务端生成有界、可分页的目标清单，不能先给桌面返回无限 ID 数组。目标清单冻结的是本次选择，不冻结后续实体修改，各项提交仍需复核原版本。批次过程中新增的匹配对象不偷偷加入本次任务。

Agent 和清单导入的工作记录按 `serverId/catalogId` 隔离。尚未提交的候选不得在更换资料库后显示为当前目标可直接应用的结果；只读助手工具不得读取原本地资料库补充远程结果。前台清单导入退出时停止桌面采集；若服务端已受理最终应用，退出只停止等待界面，不能宣称应用已撤销。

## 可执行验收规格（只制定步骤，本轮未运行）

测试一律使用独立资料目录和合成数据；真实播放另用获准测试媒体。客户端、服务器应用版本固定一致，记录代码版本、镜像摘要、操作编号及故障位置。程序终止与真实掉电是不同实验，不以一个替代另一个。

| 编号 | 安排与操作 | 验收结果 |
|---|---|---|
| M01 管理范围 | 建活动/归档两库，含隐藏成员、无成员影片、独立演员、清单与待确认图片；分别用网页和管理凭据读取 | 管理端覆盖允许资料；网页不能取得管理对象/图片，网页 Cookie 调管理用例失败 |
| M02 字段边界 | 以封面设置和手动文件导入为入口，提交桌面路径、其它对象资产 ID、逃逸相对路径和未知字段 | 服务端明确拒绝；无文件访问或业务变更，错误不泄露内部路径 |
| M03 编辑冲突 | 两个页面读同一 `V`，页面一改评分，页面二保存旧标题；再让扫描/NFO 修改同目标 | 陈旧保存均被拒绝；刷新后显式提交成功；原成功请求重试返回原回执 |
| M04 关联竞争 | 获取全局删除预览后，在另一入口新增媒体库成员或清单引用，再提交旧计划 | 旧计划失效，不漏删、误删或忽略新引用；重建计划显示新影响 |
| M05 受理边界 | 分别在上传完毕、短事务提交前/后、任务入队前/后断开响应或终止进程 | 未受理不改资料；已受理返回同一结果/任务；每次成功副作用只有一次 |
| M06 接管竞争 | 将旧请求暂停于 I/O 后并领取新 writer；同时分别安排已受理扫描、排队维护和新维护请求 | 旧未受理提交失败；已受理任务按规则继续；交接等待不能被新维护穿越 |
| M07 批量部分结果 | 三个独立目标中一个版本过期，一个成功，一个在响应前断线；重连后查询并重试 | 分项结果准确，成功项不重复执行，不确定项先查回执，冲突项不自动覆盖 |
| M08 真挂载卸载 | 对可控制的测试挂载，分别在枚举后、每批清理前、文件维护前卸载；再挂回原位置 | 该根离线并保留记录；此前已提交批次审计准确；重新挂载恢复，不自动补建丢失标记 |
| M09 预览与停服 | 创建 NFO/删除预览，等待过期或重启后尝试提交；关闭网页访问 | 旧计划不可用、占用资源释放；网页不可浏览，管理连接和任务查询仍可用 |
| M10 桌面隔离 | 远程模式启动采集、助手、裁切和清单导入；观察本地库文件、扫描、恢复及网页监听 | 本地权威库不被打开/写入或启动后台任务；仅桌面工作记录改变，服务器接收显式应用 |
| M11 分页与目标清单 | 读取第一页后插入/删除/改排序字段，再取下一页；启动批次后新增匹配目标 | 页结果一致或明确要求刷新，不悄悄拼接；新目标不加入已确认批次 |
| M12 迁移语义 | 准备重复目标 STRM、未映射本地资源、开启无资源自动清理的媒体库及各类待确认项 | 待确认项/STRM 转换冲突阻止发起；处理后迁移保留影片，按已确认规则关闭目标受影响库清理设置；首次扫描仍保留成员 |
| M13 启用取消竞争 | 目标已校验时并发发送取消和启用，分别丢弃两种响应并重启两端 | 目标只有启用或已放弃一个终态；源端只在目标持久放弃后解冻，迟到许可不复活迁移 |
| M14 图片与恢复 | 以各类正式图片、孤立暂存及已加密存量进行迁移预检；在引用提交与文件清理边界终止 | 加密残留阻止迁入；正式引用不丢图；孤立文件可恢复清理，不能被误作正式资产 |
| M15 播放 | 固定 mpv 版本，用真实 MP4/MKV 重复拖动、暂停、短断线、服务重启、凭据到期/接管 | 按主方案允许读取和撤销；记录实际成功/失败，不以 HTTP 200 或进程启动作为播放通过 |

每项证据至少保存初始数据摘要、请求/任务/计划 ID、故障发生点、终态、数据库与文件差异；凭据脱敏。M01–M15 是必需的行为场景，不是只写 15 个测试即可覆盖全部实现。功能实现后还须对实际改动运行本地业务回归；当前仅文档细化，不运行或增加实施测试。

## 本轮结论与剩余工作

管理用例的归属、聚合版本、批量结果、错误恢复和验收行为已有首版规则。还需在实施准备时为各独立用例落实精确字段类型与限额、版本影响表和文件恢复记录格式；不得把现有 IPC 参数直接改成网络请求就认为合同已经完成。正式开发须由用户另行明确授权。

## IPC 声明清点

以下为当前源文件的完整前缀清点，每项声明恰好计入一个组；归属与拆分规则以本文覆盖表为准。兼容入口可以共用同一服务端用例，事件应映射为状态读取或桌面内事件，不要求一对一建立路由。

| 前缀 | 声明数 | 当前声明（含请求与事件） |
|---|---:|---|
| `actress` | 26 | `ACTRESS_LIST`、`ACTRESS_LIST_PAGE`、`ACTRESS_PICKER_PAGE`、`ACTRESS_AVATAR_CROP_TARGETS`、`ACTRESS_AVATAR_CROP_COUNT`、`ACTRESS_TEST_TARGET_PAGE`、`ACTRESS_TEST_TARGET_GET`、`ACTRESS_PICKER_GET`、`ACTRESS_MERGE_CANDIDATES`、`ACTRESS_FACE_SCAN_MANIFEST`、`ACTRESS_GALLERY_PAGE`、`ACTRESS_PROFILE`、`ACTRESS_METADATA`、`ACTRESS_VIDEO_PAGE`、`ACTRESS_GET`、`ACTRESS_AVATAR_SOURCE_INFO`、`ACTRESS_EDIT`、`ACTRESS_DELETE`、`ACTRESS_DELETE_BATCH`、`ACTRESS_DELETE_PREVIEW`、`ACTRESS_CLEAR_META`、`ACTRESS_GALLERY_IMPORT`、`ACTRESS_GALLERY_DELETE`、`ACTRESS_POSTER_SET`、`ACTRESS_MERGE`、`ACTRESS_MARK_SCRAPE_SUCCESS` |
| `actressConflict` | 9 | `ACTRESS_CONFLICT_LIST`、`ACTRESS_CONFLICT_QUEUE_PAGE`、`ACTRESS_CONFLICT_GET`、`ACTRESS_CONFLICT_COUNT`、`ACTRESS_CONFLICT_SUMMARY`、`ACTRESS_CONFLICT_INSPECT_NAME`、`ACTRESS_CONFLICT_DISCARD`、`ACTRESS_CONFLICT_VALIDATE_ILLEGAL`、`ACTRESS_CONFLICT_RESOLVE` |
| `actressScrape` | 16 | `ACTRESS_SCRAPER_LIST`、`ACTRESS_SCRAPER_PLUGIN_DETAILS`、`ACTRESS_SCRAPER_PLUGIN_EXPORT`、`ACTRESS_SCRAPER_PLUGIN_PACKAGE`、`ACTRESS_SCRAPER_PLUGIN_UPDATE`、`ACTRESS_SCRAPER_PLUGIN_DELETE`、`ACTRESS_SCRAPER_COMPOSITE_CREATE`、`ACTRESS_SCRAPER_COMPOSITE_UPDATE`、`ACTRESS_SCRAPER_COMPOSITE_DELETE`、`ACTRESS_SCRAPE_ONE`、`ACTRESS_SCRAPE_BATCH_COUNT`、`ACTRESS_SCRAPE_BATCH_START`、`ACTRESS_SCRAPE_BATCH_CANCEL`、`ACTRESS_SCRAPE_BATCH_PROGRESS`、`ACTRESS_AVATAR_AUTO_CROP_REQUEST`、`ACTRESS_AVATAR_AUTO_CROP_RESULT` |
| `agentMetadata` | 9 | `AGENT_METADATA_START`、`AGENT_METADATA_RESUME`、`AGENT_METADATA_CANCEL`、`AGENT_METADATA_SNAPSHOT`、`AGENT_METADATA_FIND_READY`、`AGENT_METADATA_PLAN`、`AGENT_METADATA_APPLY`、`AGENT_METADATA_DISCARD`、`AGENT_METADATA_SNAPSHOT_CHANGED` |
| `appUpdate` | 6 | `APP_UPDATE_GET_STATE`、`APP_UPDATE_CHECK`、`APP_UPDATE_OPEN_RELEASE`、`APP_UPDATE_OPEN_PROJECT_PAGE`、`APP_UPDATE_IGNORE_VERSION`、`APP_UPDATE_STATE_CHANGED` |
| `asset` | 1 | `ASSET_FETCH_REMOTE_IMAGE` |
| `assetCrypto` | 2 | `ASSET_CRYPTO_SET`、`ASSET_CRYPTO_PROGRESS` |
| `assetStorage` | 1 | `ASSET_STORAGE_RELOCATE` |
| `avatarAutoCropBatch` | 3 | `AVATAR_AUTO_CROP_BATCH_BEGIN`、`AVATAR_AUTO_CROP_BATCH_TARGETS`、`AVATAR_AUTO_CROP_BATCH_END` |
| `batchScrape` | 4 | `BATCH_SCRAPE_STATE`、`BATCH_SCRAPE_PAUSE`、`BATCH_SCRAPE_RESUME`、`BATCH_SCRAPE_DISCARD` |
| `classificationImage` | 3 | `CLASSIFICATION_IMAGE_PAGE`、`CLASSIFICATION_IMAGE_CANDIDATES`、`CLASSIFICATION_IMAGE_SET` |
| `director` | 9 | `DIRECTOR_PAGE`、`DIRECTOR_LIST`、`DIRECTOR_GET`、`DIRECTOR_OPTIONS`、`DIRECTOR_CREATE`、`DIRECTOR_UPDATE`、`DIRECTOR_MERGE`、`DIRECTOR_DELETE_PREVIEW`、`DIRECTOR_DELETE` |
| `externalLink` | 1 | `EXTERNAL_LINK_OPEN` |
| `file` | 2 | `FILE_RENAME`、`FILE_IMPORT_MANUAL` |
| `home` | 2 | `HOME_LOAD`、`HOME_SEARCH` |
| `libraryCurator` | 4 | `LIBRARY_CURATOR_START`、`LIBRARY_CURATOR_MESSAGE`、`LIBRARY_CURATOR_CANCEL`、`LIBRARY_CURATOR_SNAPSHOT` |
| `llm` | 1 | `LLM_TRANSLATE_TO_CHINESE` |
| `mediaLibrary` | 15 | `MEDIA_LIBRARY_LIST`、`MEDIA_LIBRARY_GET`、`MEDIA_LIBRARY_CREATE`、`MEDIA_LIBRARY_UPDATE`、`MEDIA_LIBRARY_CONFIG_UPDATE`、`MEDIA_LIBRARY_ROOT_ADD`、`MEDIA_LIBRARY_ROOT_UPDATE`、`MEDIA_LIBRARY_ROOT_REMOVE`、`MEDIA_LIBRARY_ROOT_REMOVE_CANCEL`、`MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW`、`MEDIA_LIBRARY_ROOT_MIGRATE`、`MEDIA_LIBRARY_ARCHIVE`、`MEDIA_LIBRARY_RESTORE`、`MEDIA_LIBRARY_DELETE_PREVIEW`、`MEDIA_LIBRARY_DELETE` |
| `nfoExport` | 8 | `NFO_EXPORT_GET_OPTIONS`、`NFO_EXPORT_UPDATE_PREFERENCES`、`NFO_EXPORT_PLAN`、`NFO_EXPORT_DISCARD_PLAN`、`NFO_EXPORT_START`、`NFO_EXPORT_TERMINATE`、`NFO_EXPORT_PROGRESS`、`NFO_EXPORT_STATE` |
| `organization` | 12 | `ORGANIZATION_LIST`、`ORGANIZATION_PAGE`、`ORGANIZATION_GET`、`ORGANIZATION_OPTIONS`、`ORGANIZATION_MERGE_OPTIONS`、`ORGANIZATION_CREATE`、`ORGANIZATION_UPDATE`、`ORGANIZATION_MERGE`、`ORGANIZATION_ROLE_REMOVE_PREVIEW`、`ORGANIZATION_ROLE_REMOVE`、`ORGANIZATION_DELETE_PREVIEW`、`ORGANIZATION_DELETE` |
| `pendingAudit` | 1 | `PENDING_AUDIT_PRESENCE` |
| `pendingResourceIdentity` | 3 | `PENDING_RESOURCE_IDENTITY_GET`、`PENDING_RESOURCE_IDENTITY_LIST`、`PENDING_RESOURCE_IDENTITY_RESOLVE` |
| `pendingScan` | 3 | `PENDING_SCAN_GET`、`PENDING_SCAN_LIST`、`PENDING_SCAN_RESOLVE` |
| `pendingScanQueue` | 2 | `PENDING_SCAN_QUEUE_PAGE`、`PENDING_SCAN_QUEUE_COUNT` |
| `pendingVideoScrape` | 7 | `PENDING_VIDEO_SCRAPE_COUNT`、`PENDING_VIDEO_SCRAPE_EXISTING_IDS`、`PENDING_VIDEO_SCRAPE_PAGE`、`PENDING_VIDEO_SCRAPE_GET`、`PENDING_VIDEO_SCRAPE_LIST`、`PENDING_VIDEO_SCRAPE_CONFIRM`、`PENDING_VIDEO_SCRAPE_DISCARD` |
| `player` | 4 | `PLAYER_PLAY`、`PLAYER_REVEAL`、`PLAYER_OPEN_RESOURCE`、`PLAYER_REVEAL_RESOURCE` |
| `playlist` | 12 | `PLAYLIST_LIST`、`PLAYLIST_LIST_PAGE`、`PLAYLIST_GET`、`PLAYLIST_GET_PAGE`、`PLAYLIST_METADATA`、`PLAYLIST_VIDEO_PAGE`、`PLAYLIST_CREATE`、`PLAYLIST_UPDATE`、`PLAYLIST_DELETE`、`PLAYLIST_LIST_FOR_VIDEO`、`PLAYLIST_ADD_VIDEO`、`PLAYLIST_REMOVE_VIDEO` |
| `playlistImport` | 4 | `PLAYLIST_IMPORT_START`、`PLAYLIST_IMPORT_SNAPSHOT`、`PLAYLIST_IMPORT_CONTROL`、`PLAYLIST_IMPORT_SNAPSHOT_CHANGED` |
| `plugin` | 1 | `PLUGIN_IMPORT` |
| `pluginDev` | 11 | `PLUGIN_DEV_AGENT_START`、`PLUGIN_DEV_AGENT_MESSAGE`、`PLUGIN_DEV_AGENT_CANCEL`、`PLUGIN_DEV_AGENT_RELEASE_BROWSER`、`PLUGIN_DEV_AGENT_SNAPSHOT`、`PLUGIN_DEV_AGENT_CLEAR_HISTORY`、`PLUGIN_DEV_AGENT_DISCARD_UNRECOVERABLE`、`PLUGIN_DEV_AGENT_EVENT`、`PLUGIN_DEV_AGENT_EXPORT_WORK_LOG`、`PLUGIN_DEV_DRY_RUN`、`PLUGIN_DEV_INSTALL` |
| `scan` | 10 | `SCAN_RUN`、`SCAN_CANCEL`、`SCAN_LATEST_GET`、`SCAN_AUDIT_GET`、`SCAN_AUDIT_HEADER`、`SCAN_AUDIT_PAGE`、`SCAN_AUDIT_VIEW_PAGE`、`SCAN_AUDIT_REVEAL_FILE`、`SCAN_PROGRESS`、`SCAN_STATE_CHANGED` |
| `scrape` | 25 | `SCRAPE_ONE`、`SCRAPE_BATCH_START`、`SCRAPE_BATCH_CANCEL`、`SCRAPE_BATCH_PROGRESS`、`SCRAPE_VIDEO_BATCH_START`、`SCRAPE_VIDEO_BATCH_CANCEL`、`SCRAPE_VIDEO_BATCH_PROGRESS`、`SCRAPE_VIDEO_BATCH_COUNT`、`SCRAPE_REMATCH_BATCH_START`、`SCRAPE_REMATCH_BATCH_CANCEL`、`SCRAPE_REMATCH_BATCH_PROGRESS`、`SCRAPE_REMATCH_COUNT`、`SCRAPER_LIST`、`SCRAPER_PLUGIN_DETAILS`、`SCRAPER_PLUGIN_EXPORT`、`SCRAPER_PLUGIN_PACKAGE`、`SCRAPER_PLUGIN_UPDATE`、`SCRAPER_PLUGIN_DELETE`、`SCRAPER_SERVICE_CONFIG_GET`、`SCRAPER_SERVICE_CONFIG_SAVE`、`SCRAPER_SERVICE_CONFIG_TEST`、`SCRAPER_SERVICE_CONFIG_CLEAR`、`SCRAPER_COMPOSITE_CREATE`、`SCRAPER_COMPOSITE_UPDATE`、`SCRAPER_COMPOSITE_DELETE` |
| `series` | 9 | `SERIES_LIST`、`SERIES_PAGE`、`SERIES_GET`、`SERIES_OPTIONS`、`SERIES_CREATE`、`SERIES_UPDATE`、`SERIES_MERGE`、`SERIES_DELETE_PREVIEW`、`SERIES_DELETE` |
| `settings` | 12 | `SETTINGS_GET`、`SETTINGS_UPDATE`、`SETTINGS_PICK_FOLDER`、`SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW`、`SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM`、`SETTINGS_MODEL_MANAGEMENT_GET`、`SETTINGS_MODEL_MANAGEMENT_APPLY`、`SETTINGS_MODEL_MANAGEMENT_DISCOVER_MODELS`、`SETTINGS_MODEL_MANAGEMENT_TEST_MODEL`、`SETTINGS_RECOVERY_REVEAL_BACKUP`、`SETTINGS_PROXY_TEST`、`SETTINGS_OVERVIEW_STATS` |
| `tag` | 5 | `TAG_LIST`、`TAG_LIST_MANUAL`、`TAG_LABELS`、`TAG_FILTER_OPTIONS`、`TAG_MANUAL_OPTIONS` |
| `video` | 30 | `VIDEO_LIST`、`VIDEO_GET`、`VIDEO_UPDATE`、`VIDEO_EDIT`、`VIDEO_CLEAR_META`、`VIDEO_MARK_SCRAPE_SUCCESS`、`VIDEO_SET_RATING`、`VIDEO_CORRECT_IMPORT`、`VIDEO_YEARS`、`VIDEO_SAMPLE_IMPORT`、`VIDEO_SAMPLE_DELETE`、`VIDEO_POSTER_SET`、`VIDEO_MANUAL_TAG_ADD`、`VIDEO_MANUAL_TAG_ADD_EXISTING`、`VIDEO_MANUAL_TAG_REMOVE`、`VIDEO_RESOURCE_IMPORT`、`VIDEO_RESOURCE_GET`、`VIDEO_RESOURCE_CHECK`、`VIDEO_RESOURCE_UPDATE`、`VIDEO_RESOURCE_UPDATE_LOCAL_LABEL`、`VIDEO_RESOURCE_SET_PRIMARY`、`VIDEO_RESOURCE_REMOVE`、`VIDEO_REMOVE_FROM_LIBRARY_PREVIEW`、`VIDEO_REMOVE_FROM_LIBRARY`、`VIDEO_RESOURCE_MOVE_PREVIEW`、`VIDEO_RESOURCE_MOVE`、`VIDEO_DELETE_GLOBAL_PREVIEW`、`VIDEO_DELETE_GLOBAL`、`VIDEO_MERGE`、`VIDEO_RESOURCE_SPLIT` |
| `webAccess` | 9 | `WEB_ACCESS_PAIR_OPEN`、`WEB_ACCESS_PAIR_INSPECT`、`WEB_ACCESS_PAIR_DECIDE`、`WEB_ACCESS_DEVICE_REMOVE`、`WEB_ACCESS_DEVICE_RENAME`、`WEB_ACCESS_DEVICE_RESET`、`WEB_ACCESS_STATUS`、`WEB_ACCESS_APPLY`、`WEB_ACCESS_REVOKE` |
