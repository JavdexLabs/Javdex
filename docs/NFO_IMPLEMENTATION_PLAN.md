# NFO 导入与导出执行计划

> 状态：三个里程碑均已实现并验收
>
> 依据：[NFO 导入、导出兼容性调研](./NFO_IMPORT_EXPORT_RESEARCH.md)

## 实施状态

- [x] 里程碑 1：影片元数据来源基础
- [x] 里程碑 2：本地 NFO 一次性导入（数据库 schema 15）
- [x] 里程碑 3：NFO 前台导出

里程碑 2 已按本计划接入内置 `local-nfo` 来源、首次发现扫描预检、身份待确认、既有影片候选流程、扫描审计 schema 2 和媒体库级默认开启开关。实现不保存 NFO 路径、摘要、时间戳或同步关联；普通 `.avscraper` 包格式未变化。里程碑 3 已交付五个 profile、不可变 plan、前台阻塞执行、逐项报告和设置偏好；Jellyfin、Emby、Plex NFO Agent、Stash 与 Serviio 有固定版本消费端证据，Infuse、VidHub、Nova 与 Zidoo 按已确认决策只保留公开格式合同，不要求专有客户端或设备端 smoke。

## 已确认决策

### 1. 产品与领域定位

- 统一使用领域术语“影片元数据来源”。
- “本地 NFO”是内置影片元数据来源，在 UI 中可与网络来源并列。
- 元数据来源只产出可复核候选及来源证据，不直接改变影片资料。
- 本地 NFO 不作为普通 `.avscraper` 沙箱插件实现，也不扩大普通插件的本地文件权限。

### 2. 交付拆分

整个项目拆成三个可独立合并、独立验收的里程碑：

1. **影片元数据来源基础**：提取统一来源接口，以 Adapter 保持现有网络刮削行为不变。
2. **本地 NFO 导入**：完成扫描配对、候选生成、待确认、字段应用与本地图片交割。
3. **NFO 导出**：先完成“通用 / Kodi”，再增加 Jellyfin、Emby、Plex NFO Agent 与 Infuse profile。

每个里程碑必须独立通过测试和代码检视后，才能进入下一阶段。

### 3. 扫描配置与自动应用范围

- 在每个媒体库的扫描配置中增加“自动导入本地 NFO”开关，默认开启。
- 建议 UI 描述：`扫描时读取影片旁的 NFO。仅用于尚未刮削成功的影片；已刮削成功的影片会自动跳过。`
- 自动应用资格只依据影片的累计刮削状态：`未刮削`与`刮削失败`允许尝试，`刮削成功`跳过。新建影片自然属于`未刮削`。
- 状态属于全局影片，不属于媒体库成员；同一影片在其它媒体库已经刮削成功时，新加入的资源也不得触发 NFO 元数据覆盖。
- “跳过已刮削影片”只跳过元数据应用，不跳过身份识别。即使影片已刮削成功，扫描器仍可使用 NFO 番号识别文件并将资源归入正确影片。

### 4. 文件名与 NFO 身份冲突

- 文件名与 NFO 得到的规范化番号相同时正常继续；只有一方能提供番号时采用该方。
- 两方番号不同时禁止自动选择、禁止创建或归属影片资源、禁止应用 NFO 元数据。
- 冲突持久化为“待确认资源身份”，同时保留文件名与 NFO 两份身份依据，跨重启保留。
- 用户明确选择采用其中一份身份后才能继续资源归属；后续扫描不得擅自替用户改选。
- 源文件在安全扫描中确认缺失时，对应待确认资源身份可以清理。
- 未解决的待办在重扫时刷新发生变化的文件指纹与 STRM 目标快照并递增 revision，保留原有两份身份依据，仍须用户明确选择。

### 5. 自动应用字段策略

- 扫描触发的本地 NFO 自动导入固定使用现有“空字段补齐”模式，并选择全部受支持字段。
- 自动导入不得覆盖既有单值字段或整体集合字段；已有手动资料同样受保护。
- 至少实际应用一个受支持字段后，才按既有规则把累计刮削状态提升为成功并记录成功时间。
- NFO 没有可应用内容时属于跳过，不改变累计刮削状态和时间。
- 用户从影片刮削界面手动选择“本地 NFO”时，可以显式选择现有的其它更新模式，包括覆盖。

### 6. Sidecar 查找与 `movie.nfo`

- 第一优先级是与影片资源精确同名的 `<videoStem>.nfo`。
- 只有目录内全部影片文件都归属于同一个规范化番号时，才允许它们共享 `movie.nfo`；同番号的 CD1/CD2 或不同清晰度版本视为同一逻辑影片。
- 目录中存在多个规范化番号时，`movie.nfo` 记为歧义并跳过，不自动套用到任意影片。
- 精确同名 NFO 与 `movie.nfo` 同时存在时采用精确同名文件；内容不同时在扫描审计明细中记录 warning。
- V1 不支持 `VIDEO_TS.nfo`、`BDMV/index.nfo` 等目录媒体 sidecar。

### 7. 本地图片导入

- NFO 明确引用或按兼容命名发现的 `poster`、`folder`、`cover` 等竖版图片，作为影片封面候选。
- `fanart` 与 `extrafanart` 作为影片样张候选导入，不自动写入 `poster_path`，也不自动改变详情页背景。
- 样张优先按影片 stem 读取 `javdex-samples` 备份附件；存在新备份时不混入背景或旧目录副本。没有新备份时兼容 NFO 明确的本地引用和旧 `extrafanart`；同目录有多个影片身份时不采用通用背景名或其它影片图片，单影片目录保留传统命名兼容。
- `actor/thumb` 与 `.actors` 图片复用现有演员头像交割规则，只为空头像补齐。
- 所有图片仍受“空字段补齐”模式和现有媒体资源写入不变量约束，不替换既有封面、样张或演员头像。
- V1 不新增独立背景图字段。

### 8. 远程图片规则

- 本地 NFO 只导入经过路径边界校验的本地图片。
- NFO 中的远程图片 URL 直接忽略，并在候选或扫描审计明细中记录普通 warning。
- 自动扫描与用户手动选择“本地 NFO”使用完全相同的资产规则，手动操作也不下载远程图片。
- V1 不提供远程图片子开关；后续出现明确需求时再统一增加支持。

### 9. 演员性别映射

按以下顺序确定 NFO `<actor>` 的性别：

1. NFO 明确提供性别时按声明处理。
2. 名称已匹配现有演员时沿用该演员的性别。
3. 已验证的 MDC、MDCx、Javinizer、JavSP 方言中，仍未声明性别的演员按女优导入，不产生 warning。
4. 无法识别方言且无法匹配现有演员时同样按女优导入，但产生普通 warning。

`LocalNfoSourceAdapter` 必须显式给出最终性别，不能依赖现有 apply 层“缺失性别默认女优”的隐式兼容行为。V1 不新增性别待定演员模型。

### 10. 一次性导入，而非同步

- 本地 NFO 是一次性元数据导入，不是持续同步来源。
- 没有 NFO 是正常情况；扫描完全沿用现有文件名识别与导入流程，不记录 warning、异常或待办。
- 自动导入只在影片资源首次发现时运行；已有资源后来新增 NFO，不触发自动导入。
- 不持久保存 NFO 路径、时间、fingerprint 或“已处理”状态，不监视 NFO 或相邻图片的后续出现与变化，也不按变更自动更新影片资料。
- 用户需要重新读取 NFO 时，从影片刮削界面手动选择“本地 NFO”再次导入。

### 11. NFO 缺失与失败隔离

- 没有 NFO 是普通扫描路径，不产生 warning、异常或待办。
- NFO 文件存在但 XML 无效、不可读、不安全或本地图片损坏时，只记录普通扫描 warning。
- 文件名能够识别时，坏 NFO 不阻止建立或归属影片资源，也不阻止整次扫描及安全清理。
- 资源一旦正常建立，扫描不会自动重试该 NFO；用户修复后可以手动选择“本地 NFO”重新导入。
- 文件名也无法识别时，不建立资源，源文件继续留在无法识别/异常清单；后续扫描仍按尚未导入的新文件处理。
- 文件名与有效 NFO 身份冲突不属于可忽略失败，仍进入“待确认资源身份”。

### 12. 手动导入的资源范围与多候选

- 用户从影片刮削界面选择“本地 NFO”时，读取该全局影片在所有媒体库中的全部可用本地视频与 STRM 源文件锚点。
- 同一个物理 NFO 被多个分段或版本资源引用时只读取一次；不同物理 NFO 即使内容相同也保留各自来源证据。
- 每份唯一 NFO 产生一个独立元数据候选，不把多份 NFO 的字段或图片合并为一个结果。
- 只有一份有效候选时沿用现有单候选应用流程；存在多份有效候选时，复用现有待确认影片刮削结果和候选选择 UI。
- 没有本地锚点或没有 NFO 时返回正常“未找到”，不改变影片资料。

### 13. 扫描中的多 NFO 候选

- 同一次扫描首次发现、且身份一致地归属于同一影片的多个资源，先正常建立全部影片资源。
- 对这些资源旁的物理 NFO 去重后收集有效候选；一份有效候选自动按空字段补齐应用。
- 多份有效候选创建现有“待确认影片刮削结果”，不合并字段、不自动任选一份。
- 单份无效 NFO 只产生普通 warning，不妨碍其它有效 NFO 候选，也不回滚已确认安全的资源导入。
- 目标影片累计状态已经刮削成功时，跳过全部 NFO 元数据候选，不创建待确认结果。

### 14. 扫描开关与普通来源配置

- 媒体库扫描配置中的“自动导入本地 NFO”只控制新资源首次发现时的自动读取。
- 关闭该开关后，扫描不读取 NFO 身份或元数据；文件名识别与其它扫描行为保持不变。
- 无论开关是否关闭，“本地 NFO”都可用于影片详情手动刮削、批量刮削、组合来源和默认影片元数据来源。
- 手动、批量与组合操作使用用户当次选择的字段和更新模式；扫描自动导入始终固定为“空字段补齐 + 全部受支持字段”。
- 扫描自动导入不读取、触发或回退到默认网络刮削来源。

### 15. 导出产品入口

- V1 只提供一个导出入口：`设置 → 存储 → NFO 导出`。
- 存储页面中的 NFO 导出模块承载导出范围、目标 profile、选项、计划预览与执行结果。
- V1 不在影片详情、媒体库列表批量操作、刮削插件设置或其它页面增加导出入口。
- 后续 Agent 工具同样调用底层导出 plan/apply Module，不绕过该模块的确定性规则。

### 16. 导出范围

- 用户在 NFO 导出模块中选择一个或多个媒体库，不提供逐影片选择。
- 导出所选媒体库中全部具有本地文件锚点的影片资源；本地视频和具有本地源文件的 STRM 都属于有效目标。
- 同一全局影片在不同媒体库、不同目录或同一媒体库内有多份资源时，每份资源分别形成导出目标。
- HTTP 直链、网页、Magnet、ED2K 等没有本地锚点的资源自动跳过并单独计数，Module 不猜测独立导出目录。
- 执行前的计划摘要至少展示影片数、资源数、新建、覆盖、跳过、冲突与 warning 数量。

### 17. 输出位置与基础命名

- V1 所有 NFO 和导出图片都写在目标资源旁，不支持独立导出目录。
- NFO 始终与本地视频或 STRM 源文件精确同名：`<videoStem>.nfo`。
- 通用布局的封面和背景分别为 `<videoStem>-poster.<ext>` 与 `<videoStem>-fanart.<ext>`；profile 可以覆盖图片命名，例如 Infuse 封面使用 `<videoStem>.<ext>`。
- V1 不输出 `movie.nfo`，不移动、重命名、整理或删除影片文件。
- V1 必须支持影片样张导出；默认开关、目录和文件名遵循第 18 节。

### 18. 样张导出

- 提供“附带样张文件（备份/迁移）”开关，默认关闭。
- 开启后写入资源目录下的 `javdex-samples/`，文件名为 `<videoStem>-001.<ext>`、`<videoStem>-002.<ext>`，按 Javdex 当前样张顺序稳定编号。使用独立目录避免消费者自动当作背景读取。
- stem 前缀保证多个影片共享同一目录时互不碰撞。
- 所有 profile 都不在 NFO 中引用样张；`fanart` 只表示独立详情背景。界面说明这是样张文件备份/迁移，不承诺播放器画廊；Javdex 可回读附件，也保留旧导出目录的读取兼容。
- 预览单独展示样张文件数与预计写入体积。

### 19. 碰撞与覆盖

- 默认碰撞策略为“跳过已有文件”。
- 用户可在生成计划前显式选择“覆盖已有文件”，但执行前必须查看计划摘要。
- 覆盖只作用于计划明确列出的 NFO、封面、fanart 与样张，不删除或改写其它文件。
- `plan` 记录来源修订、目标真实路径及已有目标文件 hash/mtime；`apply` 重新校验，发生变化的项返回 `stale-plan`，不按旧计划覆盖。
- V1 不持久保存导出 manifest，也不尝试判断现有文件是否由 Javdex 创建；不存在静默安全更新路径。
- 单项冲突、权限或写入失败不回滚其它已经原子完成的文件；报告必须逐项列出成功、跳过、冲突和失败。

### 20. 默认导出内容

- NFO 文本始终属于导出计划。
- “导出影片封面”默认开启。
- “导出详情背景”默认开启；只有 `poster_path` 指向有效图片时才导出为 fanart，没有独立背景时不使用封面或样张伪造。
- “导出样张”默认关闭，遵循第 18 节规则。
- “导出演员头像”提供开关且默认关闭，避免每部影片重复复制全局演员资源。
- 演员头像文件名按 Kodi `.actors` 约定将普通空格替换为下划线，NFO 保留原姓名并引用实际文件；名称归一化冲突继续拦截。界面说明用途及 Plex / Infuse / Jellyfin 本地头像兼容性尚未验证，旧文件名仍可回读。
- Javdex 个人评分、观看状态、播放次数和最近播放时间不进入 V1，也不提供导出开关。

### 21. 导出 Profile

V1 公开提供五个 profile：

1. `portable-v1`：UI 显示“通用 / Kodi”，作为默认 profile。
2. `jellyfin-current`：Jellyfin 当前稳定版本。
3. `emby-kodi-conservative`：Emby 可验证的 Kodi 保守子集。
4. `plex-nfo-1.43.1+`：只兼容 Plex 官方 NFO Agent，并在 UI 明确要求 PMS 1.43.1+；默认 Plex Movie Agent 不受支持。
5. `infuse-current`：使用 Infuse 所需的同名封面和本地 metadata 规则。

Stash nfoSceneParser 与 Serviio 作为“通用 / Kodi”的固定版本消费端验证对象，不增加独立 UI profile。Infuse、VidHub、Nova 与 Zidoo 属于专有客户端或设备端消费者，只保留基于公开文档/解析器的格式合同，不纳入 V1 实机验收门槛。profile 只有在字段或图片命名确实不同且通过 golden 格式合同时才能独立存在；纳入实机验收的消费者还必须通过对应 smoke。

### 22. 一次性导出，不建立关联

- NFO 导出是当前影片资料与所选资源的一次性快照，不是持续同步功能。
- 不新增或持久保存 NFO 专用影片 UID，不暴露数据库自增 ID。
- 不保存 NFO 文件与 Javdex 影片的关联、导出 manifest、上次导出位置或后续增量更新状态。
- profile 使用现有番号及消费者明确支持的现有站点身份字段。
- 只有不同全局影片具有相同规范化番号且导出目标位于同一物理目录时，计划才产生 warning；同番号影片位于不同目录时不告警。V1 不伪造额外身份来规避消费者合并。

### 23. Agent 不进入 V1

- V1 不实现任何 NFO 相关 Agent 工具、Agent UI、提示词或模型调用。
- NFO 导入、候选确认、导出计划、执行与错误报告必须在无模型、离线状态下完整可用。
- 核心 Module 保持确定性接口，以便后续项目再增加受控 Agent 工具，但后续能力不计入本次范围或验收。

### 24. 扫描统计与审计展示

- 不新增 NFO 顶层统计卡片或独立扫描模块。
- 每个扫描文件继续只有一个主要结果：新增、更新、待确认、跳过或异常。
- NFO 作为次要处置标记展示：已导入、已跳过、普通警告、多候选待确认。
- 没有 NFO 时不显示标记，也不产生任何计数。
- 坏 NFO 但资源正常建立时，主要结果仍为新增或更新；普通 warning 只在文件明细中展示，不增加异常计数。
- 文件名/NFO 身份冲突和多 NFO 候选进入现有“异常与待办”，并可从扫描审计明细进入对应处理流程。

### 25. 导出图片编码

- JPEG、PNG 在目标 profile 明确支持时保留原格式与原始字节，不做无意义重编码。
- WebP 或目标 profile 不支持的图片格式转换为 JPEG；使用固定质量参数、不放大图片，并保证同一输入重复转换的结果稳定。
- 输出扩展名必须与实际图片编码一致，profile 的文件命名先决定 basename，再由实际编码决定扩展名。
- 所有导出图片通过 `MediaAssetStore` 公开面读取，兼容明文与加密媒体资源；导出模块不自行解析存储路径。
- 单张图片读取或转换失败只使该图片计划项失败，不阻止 NFO 与其它图片执行。

### 26. 导出偏好与临时状态

- 持久记住用户上次选择的媒体库、profile，以及封面、背景、样张、演员头像开关。
- “覆盖已有文件”属于危险选项，不持久化；每次进入模块或完成一次导出后恢复为“跳过已有文件”。
- 导出计划、展开后的文件列表和执行结果不跨应用重启保存。
- 已删除或当前不可用的媒体库从保存选择中移除，不自动改选其它媒体库。

### 27. 前台任务生命周期

- 正式导出是绑定 `设置 → 存储 → NFO 导出` 模块的前台任务，并通过遮盖页面的阻塞式进度弹窗展示。
- 弹窗不能通过点击遮罩、按 Esc、切换设置页签或应用内导航关闭；任务结束或用户明确点击“终止任务”前，不允许进行其它应用操作。
- 用户终止后不再开始新的文件项；已经开始的单文件原子写入允许完成，以免留下半文件。
- 已成功文件保留，未执行项不触碰；终止完成后弹窗展示部分完成报告，用户确认后才关闭。
- 应用进程退出时请求终止；不转入后台继续。
- 任务、进度和结果不持久化、不自动恢复，也不发送操作系统通知。

### 28. 与扫描和资源维护互斥

- 从生成可执行计划到正式导出完成或终止，复用现有进程级 `maintenanceTaskGate` 资源维护锁。
- 已有扫描或资源维护任务运行时不能开始导出；导出运行时不能开始手动扫描、自动扫描、来源目录迁移/移除或媒体库归档/删除。
- 自动扫描因锁忙而延期到后续调度周期，不记录为扫描失败。
- 导出完成、失败、终止及异常退出路径都必须释放 lease，并有测试锁定。
- V1 不新增逐媒体库锁。

### 29. V1 明确排除项

- `VIDEO_TS`、`BDMV` 等目录媒体及其 NFO。
- 电视剧、季、分集 NFO。
- 字幕导入或导出。
- 影片文件移动、重命名、目录整理或清理。
- 观看状态、播放次数和个人评分。
- NFO 持续同步、导出关联与增量更新。
- 任何 Agent 工具、UI 或模型调用。

V1 只处理本地视频文件与 STRM 源文件对应的影片 NFO、现有影片元数据字段及已确认范围内的图片资产。

### 30. 导入兼容性合同

V1 必须通过以下固定输入合同：

- Movie_Data_Capture（固定调研 commit 的最小自建 fixture）。
- MDCx（固定调研 commit 的最小自建 fixture）。
- Javinizer（固定调研 commit 的最小自建 fixture）。
- JavSP（固定调研 commit 的最小自建 fixture）。
- Javdex 五个导出 profile 的 round-trip fixture。

fixture 只包含自建最小 XML、空白占位图片和目录结构，不复制第三方影片描述或图片。未知但合法的 Kodi 风格 NFO 尽力读取通用字段；未知标签忽略并记录普通 warning，不承诺无损兼容或追随第三方未来任意版本。

### 31. 独立提交与验收

三个里程碑分别实现、提交、检视和验收，不合并成一个大改动：

1. 影片元数据来源基础：只做 seam 与现有网络 Adapter，保持现有行为不变。
2. 本地 NFO 导入：扫描、候选、待确认、配置、审计与兼容 fixtures。
3. NFO 导出：存储页模块、五个 profile、计划/执行、阻塞进度弹窗和文件写入。

每个里程碑必须通过其合同测试、项目全量测试、生产构建与代码检视，才能进入下一里程碑。

## 32. 目标架构与模块边界

### 32.1 影片元数据来源

新增主进程内部 `VideoMetadataSource` 接口，统一表达“按番号或影片收集候选”，但不改变 renderer 当前使用的 `ScrapeResult` 展示合同：

```ts
interface VideoMetadataSource {
  readonly descriptor: VideoMetadataSourceDescriptor
  collect(request: VideoMetadataSourceRequest): Promise<MetadataCandidateBatch>
}
```

- `WebScraperSourceAdapter` 包装现有 `BaseScraper.parseTask`、代理、组合来源和候选过滤。
- `LocalNfoSourceAdapter` 负责查找 sidecar、调用私有 codec、生成候选和本地资产能力票据。
- `scraperManager` 继续负责候选选择、待确认与应用编排，不再直接假设来源一定是 `.avscraper`。
- 现有 IPC 方法与 `scraperName` 参数在里程碑 1 保持兼容；内部先把它解析为稳定 source id。renderer 在里程碑 2 才显示“本地 NFO（内置）”。
- 组合来源按字段调用来源接口；本地 NFO 因而自然可以参与组合，而无需复制一套组合逻辑。

### 32.2 候选资产交割

新增只存在于主进程的 `VideoMetadataCandidate`，把字段结果与图片交割分开：

```ts
interface VideoMetadataCandidate {
  result: ScrapeResult
  assets: MetadataAssetRef[]
  evidence: MetadataEvidence
}

type MetadataAssetRef =
  | { kind: 'remote-url'; url: string }
  | { kind: 'managed-root-file'; capability: ManagedRootFileCapability }
```

- web Adapter 将现有 `coverUrl`、`sampleImageUrls`、`avatarUrl` 转成 `remote-url`。
- NFO Adapter 只返回经过媒体库根目录与 realpath 复核的 `managed-root-file` 能力票据。
- 新增 `videoMetadataCandidateStager` 统一把两种资产交给 `MediaAssetStore` 暂存；`videoScrapeApplyService` 只消费已交割资产，不再自己假设所有图片都要联网下载。
- renderer、普通插件、IPC、待确认 JSON 都不能看到本地绝对路径；待确认仓库只保存现有 staged path。
- 能力票据与 NFO evidence 仅在当次收集/计划内存中存在，不作为 NFO 关联持久化。

### 32.3 NFO 私有模块

- `NfoArtifactCodec`：受限 XML 解析、方言归一化、profile 渲染与稳定排序；对外不暴露 XML DOM。
- `NfoSidecarLocator`：精确同名、`movie.nfo` 歧义、本地图片发现和物理文件去重。
- `NfoFileStore`：根目录授权、realpath 校验、限额读取、目标 sibling 授权、hash/mtime 和同目录原子写入。
- `LocalNfoSourceAdapter`：组合 codec、locator、演员性别归属与候选资产，不拥有字段应用规则。
- `NfoExportModule`：只公开 `plan(request)` 与 `apply(plan, signal, onProgress)`；profile 是数据，不为五个消费者复制 exporter class。
- `NfoExportTaskController`：持有进程级任务状态、终止信号、进度事件及 `maintenanceTaskGate` lease；不持久化任务。

### 32.4 明确禁止的依赖方向

- scanner 不解析 XML、不直接写影片元数据，只调用本地 NFO source 与既有 apply/pending 服务。
- codec 不访问数据库、不操作 UI、不调用网络。
- export renderer 不自行读取 Javdex 媒体存储路径，只通过 repository snapshot 与 `MediaAssetStore.readBytes` 取得内容。
- renderer 不能提交任意输出路径或 XML；只能提交共享合同定义的库选择、profile、资产开关与碰撞策略。
- V1 不增加任何 Agent 依赖或工具声明。

## 33. 数据与迁移计划

### 33.1 里程碑 1

无数据库迁移、无设置迁移。所有既有 `.avscraper`、组合来源和 IPC 输入输出必须保持兼容。

### 33.2 里程碑 2：数据库 V15

把 `CURRENT_SCHEMA_VERSION` 从 14 提升到 15，并同时更新 fresh schema 与 V14→V15 migration：

1. `media_library_configs` 增加：
   - `auto_import_local_nfo INTEGER NOT NULL DEFAULT 1`
   - `CHECK(auto_import_local_nfo IN (0, 1))`
   - 对全部既有媒体库迁移为开启，符合产品默认值。
2. 新建 `pending_resource_identities`，每条记录只保存解决冲突所需的资源快照：
   - 媒体库、根目录、源文件、local/STRM 类型与安全的 STRM target snapshot；
   - 文件名规范化番号与 NFO 规范化番号；
   - 文件 fingerprint、revision、创建/更新时间；
   - 不保存 NFO 路径、NFO 内容、NFO hash、mtime 或“已处理”状态。
3. 同一媒体库同一源文件最多一个未决身份；源文件经安全扫描确认缺失时删除。
4. 用户解决时重新授权并复核源文件 fingerprint。身份选择按持久化候选执行；只有当前 NFO 仍安全可读且番号仍与选择一致时才顺带应用当下 NFO 元数据，否则只完成资源归属并给普通 warning。
5. 待确认中心把该表投影为 `scan` 领域的新 `resource-identity` item，不建立半成品影片、资源或成员。

迁移测试必须覆盖 fresh V15、真实 V14 fixture 升级、默认值、约束、外键、重复升级与 rollback-on-error。数据库升级前沿用应用现有备份策略；V15 数据库不承诺被旧版二进制重新打开。

### 33.3 里程碑 3：设置而非数据库

新增经校验的 `NfoExportPreferences` 到现有 settings store：

- `libraryIds: number[]`
- `profileId: NfoExportProfileId`，默认 `portable-v1`
- `includeCover: true`
- `includeFanart: true`
- `includeSamples: false`
- `includeActorAvatars: false`

读取时去重并移除不存在或不可用的媒体库 id，不自动补选其它媒体库。“覆盖已有文件”仅保存在当前组件状态，进入页面与每次任务完成后恢复为 `skip`。计划、文件明细、任务进度和报告不写 settings 或数据库。

## 34. 里程碑 1：影片元数据来源基础

### 34.1 实现任务

1. 在 `src/main/metadata-sources/` 建立来源接口、descriptor、registry、web Adapter 与候选资产模型。
2. 把 `scraperManager` 中 `BaseScraper` 的直接调用收敛到 web Adapter；保留现有 plugin descriptor 校验、精确番号过滤、URL 去重、代理、延迟控制和浏览器关闭语义。
3. 把单候选与多候选的图片处理统一到 `videoMetadataCandidateStager`：
   - 单候选仍通过 `videoScrapeApplyService` 应用；
   - 多候选仍写入 `pendingVideoScrapeRepo`；
   - staged asset 生命周期、失败清理与事务边界不变。
4. 让 composite orchestration 通过 source registry 获取每个字段来源，同时保留当前首候选合成及多候选待确认行为。
5. 保留 `listScraperPlugins`、`getScraper` 等必要兼容入口，新增内部 source catalog；里程碑 1 不改 UI 文案和已安装插件格式。
6. 更新边界检查，禁止 scanner、renderer 或普通插件直接导入 metadata-source 内部资产实现。

### 34.2 重点文件

- `src/main/scrapers/scraperManager.ts`
- `src/main/scrapers/compositeScrapeRun.ts`
- `src/main/services/videoScrapeApplyService.ts`
- `src/main/services/mediaAssetStore.ts`
- `src/shared/videoScrapeTypes.ts`（仅保留 IPC/renderer 需要的公共形状）
- 新增 `src/main/metadata-sources/*`
- `scripts/check-media-asset-store-boundaries.mjs` 及新的 source boundary check

### 34.3 验收条件

- 同一输入下，单插件、组合来源、批量刮削、单候选、多候选、身份冲突、字段选择、更新模式、警告和失败状态与改造前一致。
- 现有 `.avscraper` 包、descriptor、配置与开发助手无需修改。
- 没有 NFO UI、数据库或行为进入本里程碑。
- 新增 contract tests 锁定 remote asset 交割、staging cleanup、pending replacement 和 composite source routing。
- `npm test`、`npm run build`、代码检视全部通过后单独提交并验收。

## 35. 里程碑 2：本地 NFO 导入

### 35.1 XML 与 sidecar 基础

1. 引入固定版本的 `fast-xml-parser` 并锁入 package lock；关闭 entity processing，codec 仍要在解析前显式拒绝 DTD、ENTITY 与外部实体，不能把安全性只委托给依赖默认值，也不允许网络解析。
2. 首期安全上限固定为：单个 NFO 2 MiB、最大深度 64、最大节点数 50,000、单字段归一化后 256 KiB；超限视为 unsafe XML 普通 warning。
3. 输出统一 UTF-8、LF、固定标签顺序与稳定集合排序；解析与渲染都通过私有 normalized model。
4. 实现 MDC、MDCx、Javinizer、JavSP 方言识别、字段映射、演员性别规则、未知标签 warning 与本地图片规则。
5. `NfoSidecarLocator` 按第 6–8 节实现 exact stem、受限 `movie.nfo`、realpath 边界和物理 NFO 去重。

### 35.2 扫描接入

扫描保持“收集文件 → 预判新资源 → 逐项归属 → 安全清理”的主流程，增加两个窄阶段：

1. **新资源身份预检**：只对尚无正式资源、无普通待确认组、无身份待确认记录的文件，在开关开启时读取 NFO identity。先建立目录级影片索引，确保 `movie.nfo` 判定不会依赖扫描顺序。
2. **元数据候选收敛**：资源归属完成后，按 `videoId` 聚合本次首次发现资源的唯一有效 NFO；一份候选自动 `fillEmpty`，多份候选进入现有待确认影片刮削结果。

具体规则：

- 有效身份采用“文件名、NFO 一致或仅一方有效”；不一致写 `pending_resource_identities` 并停止该资源导入。
- 无 NFO 立即走原扫描路径，不产生 marker 或额外计数。
- 坏 NFO 只给当前文件 secondary warning；文件名有效时资源照常导入。
- 已有正式资源在最前面的 existing-resource 分支直接跳过 NFO 收集，保证一次性语义。
- 累计状态 1 只使用 identity，不收集/应用元数据；状态 0/2 才进入候选收敛。
- 扫描结束前处理候选，之后再执行现有离线目录与资源清理，避免 NFO 失败改变维护安全性。

### 35.3 审计与待确认

- `LibraryScanFileAuditEntry` 各主要 outcome 增加可选 `nfo` secondary disposition：`imported | skipped | warning | pending-candidate | identity-conflict`，并带受限 warning code/message。
- 扫描 summary 与顶层 metric 不新增 NFO 计数；audit schema 升到 2，读取器继续兼容 schema 1。
- 身份冲突在待确认中心沿用 scan 分类，但使用专门的双候选 pane；用户只能选择文件名身份、NFO 身份或丢弃当前待办，不能输入任意番号。
- 多 NFO 候选继续使用 `pendingVideoScrapeRepo` 与现有候选选择 UI；来源显示“本地 NFO 1/2”，不持久显示绝对路径。

### 35.4 手动、批量、组合与默认来源

- source catalog 新增稳定 id `local-nfo`，显示“本地 NFO（内置）”，声明支持第 5 节的全部字段。
- 手动调用按第 12 节查询全局影片所有媒体库的本地锚点；无 NFO 返回普通 no-match，不把累计状态改成失败。
- 批量、组合和默认来源同样使用 no-match-as-skip；不会回退网络来源，除非组合配置明确把相应字段交给其它来源。
- 手动/批量使用用户选择的字段和 mode；scan source 固定 `fillEmpty + ALL_VIDEO_SCRAPE_FIELDS`。

### 35.5 配置 UI

- 在 `MediaLibrarySettingsTabs.tsx` 的“扫描设置 → 资源归属”之后增加 `SettingsSwitchRow`：
  - 标题：`自动导入本地 NFO`
  - 描述：`扫描时读取影片旁的 NFO。仅用于尚未刮削成功的影片；已刮削成功的影片会自动跳过。`
- 复用 `updateConfigImmediately`，变更立即生效，无保存按钮。
- 媒体库创建页不增加额外步骤；新库使用数据库默认开启。

### 35.6 重点文件

- `src/main/scanner/scanner.ts`
- `src/main/scanner/libraryScanAuditStore.ts`
- `src/main/db/mediaLibraryRepo.ts`
- `src/main/db/pendingScanRepo.ts` 与新增 identity repo/service
- `src/main/db/schema.ts`、`src/main/db/migrations.ts`
- `src/main/services/videoPendingScrapeService.ts`
- `src/main/services/videoScrapeApplyService.ts`
- `src/main/services/mediaLibraryRootFileGuard.ts`
- `src/shared/mediaLibraryTypes.ts`、`src/shared/libraryTypes.ts`、IPC contracts
- `src/renderer/src/pages/MediaLibrarySettingsTabs.tsx`
- `src/renderer/src/pages/PendingCenterPage.tsx` 及 scan panes
- 新增 `src/main/nfo/*` 与 `src/main/metadata-sources/localNfoSourceAdapter.ts`

### 35.7 验收条件

- 四种第三方 fixture 与五种 Javdex round-trip fixture 通过。
- exact stem、`movie.nfo`、多影片目录、CD/版本、坏 XML、unsafe XML、越界路径、symlink escape、远程图片、演员性别和多候选均有合同测试。
- 扫描开关开/关、首次发现、既有资源、status 0/1/2、文件名无番号、身份冲突、STRM 与多库全局影片均有集成测试。
- no NFO 和 bad NFO 不改变原扫描安全清理结果；身份待办跨重启且不会建立半成品记录。
- 手动、批量、组合、默认来源与 scan 使用同一资产规则。
- `npm test`、`npm run build`、代码检视全部通过后单独提交并验收。

## 36. 里程碑 3：NFO 导出

### 36.1 计划阶段

`NfoExportModule.plan` 在取得 `maintenanceTaskGate` lease 与 `MediaAssetStore` 稳定读取 lease 后完成以下工作：

1. 校验所选媒体库仍存在且可用，查询全部本地视频与本地 STRM 锚点。
2. 每份物理资源生成一个 export target；按真实目录 + 目标文件名去重，普通链接单独计为 skipped-no-anchor。
3. 用影片字段、关系、站点统计、资产路径、资源锚点及媒体库 revision 生成 source snapshot hash；图片内容 hash 独立保存在对应资产项中，避免单张图片读取失败使其它文件失效。
4. profile renderer 生成稳定 XML；资产项通过 `MediaAssetStore.readBytes` 读取，计划记录源 hash、目标 realpath、existing hash/mtime、action 与预计字节数。
5. 检测同一目录内不同全局影片的同番号 warning、目标路径碰撞、无 fanart、无头像及 profile 不能表示的字段；样张作为附件统一处理，不再设置 profile 样张引用能力。
6. 返回只读摘要和可展开文件明细，不写磁盘。

计划对象只保存在主进程任务控制器内；renderer 获得 opaque `planId` 与安全摘要，不能篡改文件清单。用户修改任何选项、离开模块、重新生成或取消预览都丢弃旧 plan 并释放两项 lease。

### 36.2 执行阶段

- `apply` 逐项复核 source snapshot、目标 realpath 与 existing hash/mtime；图片只在自身写入前读取并核对该项 source hash。变化项报告 `stale-plan`，单张读取或转换失败不会使其它文件失效。
- 每个文件使用同目录临时文件、flush/fsync、原子 rename/replace；失败清理临时文件，不回滚其它已完成文件。
- JPEG/PNG 在 profile 支持时保留原字节；WebP/不支持格式使用 Electron 已有图片解码能力以固定 JPEG quality 转换，不放大，扩展名由输出字节确定。
- 默认 skip existing；replace 只执行 plan 明列项目，不删除未列文件。
- 终止信号只阻止开始下一文件，当前单文件原子写入完成后报告 cancelled-partial。
- `finally` 无条件释放 gate 与稳定读取 lease，并清理 plan、临时文件与任务状态。

### 36.3 IPC 与前台任务

新增独立 `nfoExport` typed contract，而不是塞入通用 settings update：

- `getOptions()` / `updatePreferences()`
- `plan(request)` / `discardPlan(planId)`
- `start(planId)` / `terminate(taskId)`
- `onProgress(event)` / `onStateChanged(event)`

同一时刻最多一项导出任务。`maintenanceTaskGate` 增加仅用于诊断和错误文案的 `nfo-export` kind，但仍是同一把进程级互斥锁。`MediaAssetStore` 增加窄的稳定读取 lease：导出持有时拒绝资源存储迁移，迁移运行时拒绝生成导出计划，避免加密/路径迁移与导出读取竞争。应用退出钩子请求 terminate 并等待当前原子文件写完；不恢复任务、不发系统通知。

### 36.4 存储页 UI

- 在 `StorageSettingsPanel` 的资源存储模块后增加独立 `NfoExportPanel`，沿用 settings primitives 与语义 token。
- 第一步选择媒体库、profile、封面/背景/样张/演员头像和本次碰撞策略；“生成预览”只调用 plan。
- 第二步展示影片、资源、文件、新建、覆盖、跳过、冲突、warning、样张数与预计体积；用户确认后才开始。
- 执行后打开遮盖整个页面的阻塞式 `NfoExportProgressModal`；禁用 backdrop、Esc、设置页签、导航与其它操作。
- 弹窗只提供“终止任务”；结束后同一弹窗切换为完成/部分完成报告，用户确认后才关闭。
- overwrite 不回填偏好；每次结束恢复 skip。

### 36.5 Profile 交付顺序

在同一里程碑内按以下小步完成并各自保留 golden：

1. `portable-v1`：先打通 plan/apply、通用 XML 与图片布局。
2. `jellyfin-current`、`emby-kodi-conservative`。
3. `plex-nfo-1.43.1+`，明确 UI 警示只支持官方 NFO Agent。
4. `infuse-current`，以公开本地 metadata 合同和 golden 验收，不要求专有客户端 smoke。
5. 用通用输出记录 Stash nfoSceneParser 与 Serviio 的固定版本 smoke 结果；VidHub、Nova 与 Zidoo 只记录公开格式合同，不新增 profile。

### 36.6 重点文件

- 新增 `src/main/nfo/export/*`
- 新增 `src/shared/nfoExportTypes.ts` 与 typed IPC contract
- `src/main/services/maintenanceTaskGate.ts`
- `src/main/services/mediaAssetStore.ts`
- `src/main/ipc/*`、`src/preload/index.ts`
- `src/shared/settingsTypes.ts`、`src/main/settings/settingsStore.ts`
- `src/renderer/src/components/settings/StorageSettingsPanel.tsx`
- 新增 `NfoExportPanel`、preview、blocking progress modal 及 CSS module

### 36.7 验收条件

- 五个 profile 的 XML/目录树 golden 与 round-trip 均通过；输出稳定且不含数据库 ID、个人评分或观看状态。
- plan 无写入；skip/replace/stale、只读目录、磁盘写入失败、图片解密/转换失败、终止、进程退出与 gate lease 释放均有测试。
- 多媒体库、多资源、同番号不同目录、同目录冲突、STRM、本地链接跳过、样张和演员头像均有集成测试。
- modal 无法通过 Esc、遮罩或导航绕过；终止后保留已完成文件并展示逐项报告。
- Jellyfin、Emby、Plex NFO Agent、Stash nfoSceneParser 与 Serviio 的固定版本消费端证据写入兼容性文档。
- Infuse、VidHub、Nova 与 Zidoo 不要求专有客户端或设备端 smoke；兼容性文档必须明确其证据仅为公开格式合同，不得写成实机验证通过。
- `npm test`、`npm run build`、代码检视全部通过后单独提交并验收。

## 37. 测试资产与测试矩阵

### 37.1 Fixture 目录

- `test/fixtures/nfo/import/mdc/`
- `test/fixtures/nfo/import/mdcx/`
- `test/fixtures/nfo/import/javinizer/`
- `test/fixtures/nfo/import/javsp/`
- `test/fixtures/nfo/import/generic-kodi/`
- `test/fixtures/nfo/export/<profile>/`

只提交自建最小 XML、空白小图片与目录树；fixture README 固定来源工具版本/commit 与支持范围，不复制第三方影片文案或图片。

### 37.2 自动化层次

1. codec 纯函数：解析、方言、escape、stable output、limits。
2. file-store temp directory：realpath、symlink、hash/mtime、atomic write、collision。
3. source contract：web 与 local 产生相同候选/资产语义。
4. repository/migration：配置、identity pending、清理与 revision。
5. scanner integration：首次发现、状态门、候选聚合、审计、清理隔离。
6. scrape integration：单片、批量、组合、默认来源、多候选。
7. export plan/apply：profile golden、stale、partial、cancel、gate。
8. renderer：设置开关即时保存、计划预览、阻塞 modal 与报告。
9. full suite + production build。

### 37.3 性能与安全门槛

- 没有 NFO 的首次发现复用本次扫描已收集的目录索引，不为每个视频重新遍历目录或解析无关 XML；索引不跨扫描缓存，既有资源不触发 NFO I/O。
- 同一扫描内 NFO 与图片按 realpath 去重；大样张不在候选间复制 Buffer，先暂存后引用。
- plan 以流式 hash/复制处理图片，不把一次导出的全部资产同时读入内存。
- 2 MiB XML 与结构限制在进入 DOM 前/解析时执行；任何超限都不得导致整次扫描或应用崩溃。
- 目标路径与本地图片路径都要在 lexical path 和 realpath 两层校验，Windows 设备路径、UNC 边界和符号链接逃逸均有测试。

## 38. 文档同步

为避免后续代码检视按旧文档回退，每个里程碑提交必须同步对应文档：

- 里程碑 1：`CONTEXT.md`、ADR-0026、来源接口注释；说明本地 NFO 不是普通插件。
- 里程碑 2：本计划、兼容 fixture README、扫描审计合同；如普通 `.avscraper` 格式未变化，不改 `SCRAPER_PLUGIN_FORMAT.md`。
- 里程碑 3：新增 `docs/NFO_COMPATIBILITY.md`，记录 profile 版本、字段/图片差异、smoke 结果与已知限制；同步 README/CHANGELOG 的真实已交付能力。
- `docs/NFO_IMPORT_EXPORT_RESEARCH.md` 保留为证据与调研背景，本计划作为实施规范；两者冲突时，以本计划中已确认的产品决策为准。

## 39. 提交、发布与回滚

### 39.1 提交边界

1. `feat(metadata-source): introduce source and asset delivery seams`
2. `feat(nfo-import): add one-shot local NFO source`
3. `feat(nfo-export): add planned foreground export`

每项可以在内部拆成测试/实现小提交，但合并与验收边界必须保持三项独立。不得把 V15 migration 提前放进里程碑 1，也不得把导出 UI 混入导入里程碑。

### 39.2 发布门槛

- 里程碑 1 可作为纯内部重构发布。
- 里程碑 2 首次引入 V15；发布说明必须写明默认开启的一次性导入、无 NFO 为常态、不会覆盖已刮削影片。
- 里程碑 3 只有在五个 profile 的 golden、Jellyfin/Emby/Plex NFO Agent 的服务器 smoke 和 Stash/Serviio 的通用输出消费端验证完成后才能公开全部 profile。Infuse、VidHub、Nova 与 Zidoo 的专有客户端或设备端 smoke 不属于发布门槛，但对外证据必须标为格式合同。

### 39.3 失败回滚

- source seam 可通过 web Adapter 兼容层回退，不改变插件数据。
- NFO 自动导入出现问题时可按媒体库关闭开关；已正确写入的资料不自动反向删除。身份待办可以显式丢弃，不能后台猜测解决。
- 导出只写媒体目录旁的计划文件；默认 skip existing，partial report 是唯一恢复依据。因为不保存 manifest，V1 不提供自动撤销或自动重试。
- 任一模块故障不得扩大到扫描安全清理、普通网络刮削或媒体资源存储迁移。

## 40. 最终完成定义

只有同时满足以下条件，本方案才算完成：

- 三个里程碑分别提交、检视、验收，且前一里程碑已接受才开始下一项。
- 本地 NFO 导入是一次性、默认开启、无 NFO 无噪音、已刮削影片不被覆盖。
- 多身份与多候选都由既有待确认中心承载，不生成半成品正式记录。
- 导出只从设置 → 存储发起，先计划后执行，阻塞前台、可明确终止、无后台与无同步关系。
- 五个 profile 的证据等级必须如实标注：纳入 smoke 的消费者需有固定版本读回证据；Infuse、VidHub、Nova 与 Zidoo 只声明公开格式合同。
- V1 完全不包含 Agent 能力。
- 项目全量测试、生产构建、边界检查与文档一致性检视通过。

## 待确认决策

- 无。产品范围、执行边界与三个里程碑均已闭合。
