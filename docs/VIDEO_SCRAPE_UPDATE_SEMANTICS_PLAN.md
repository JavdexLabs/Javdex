# 影片刮削三种更新方式修复方案

## 目标

让影片刮削的 15 个可选字段在“空字段补齐”“有值覆盖”“覆盖更新”下具有一致、可预测的语义，并让字段预判、资源下载、数据库写入、成功状态、批量日志和测试使用同一套判断。

本次不修改插件返回契约，不新增数据库表或持久化更新模式，也不改变手动评分、影片文件和播放数据。

## 已确认的规则

### 三种更新方式

- **空字段补齐**：仅在当前字段为空且刮削返回可用值时写入；当前有值或刮削无值时保留。
- **有值覆盖**：刮削返回可用值时整体替换当前字段；刮削无值时保留。
- **覆盖更新**：刮削结果是权威结果；有值时整体替换，无值时清空。

### 站点边界

来源链接和站点评分按实际字段来源站点独立维护：

- 直接插件以插件名为来源。
- 组合插件以该字段映射的实际插件名为来源，不使用组合名称冒充来源。
- 补齐、覆盖或清空一个站点的记录不得影响其他站点。

### 集合字段

女优、男优、刮削标签和样张分别是独立的整体集合，不执行新旧并集合并：

- 女优和男优分别判断是否为空、分别替换或清空。
- 标签只处理 `origin = 'scraped'` 的刮削标签，手动标签始终保留。
- 样张按整组替换，不混入旧批次或其他站点的图片。

### 图片字段

- 站点没有返回图片属于“无值”。
- 站点返回了图片 URL，但下载失败、文件丢失或图片不可读属于“资源不可用”，不得当成无值清空旧资源。
- 封面必须下载成可用本地图片后才能写入。
- 样张必须全部下载成可用本地图片后才能整组写入；任意一张失败时整组不写入。
- 当前路径不存在或文件不可读时，封面/样张在“空字段补齐”中视为空。

### 应用结果

- 空字段补齐或有值覆盖没有任何可写入内容时返回“跳过”，不修改 `scraped_status`、`last_scraped_at`、`updated_at`。
- 覆盖更新的空结果代表权威清空，属于成功应用。
- 多字段任务只要至少一个字段成功应用，整次任务算成功；资源不可用字段作为警告返回。
- 匹配成功、字段成功应用和资源下载成功是三个不同状态，不得互相代替。

## 字段语义矩阵

| 字段 | 当前值判定 | 刮削值判定 | 空字段补齐 | 有值覆盖 | 覆盖更新 |
|---|---|---|---|---|---|
| 标题 | `title` 非空 | `title` 非空 | 空时写入 | 有返回时写入 | 写入或清空；同步 `original_title` |
| 简介 | `summary` 非空 | `summary` 非空 | 空时写入 | 有返回时写入 | 写入或清空 |
| 封面 | 本地文件存在且为可读图片 | URL 已下载为可读本地图片 | 无可用封面时写入 | 下载成功时替换 | 未返回 URL 时清空；下载失败时保留并警告 |
| 发行日期 | `release_date` 非空 | 合法日期 | 空时写入 | 有返回时写入 | 写入或清空 |
| 制作商 | `maker` 非空 | `maker` 非空 | 空时写入 | 有返回时写入 | 写入或清空 |
| 发行商 | `publisher` 非空 | `publisher` 非空 | 空时写入 | 有返回时写入 | 写入或清空 |
| 系列 | `series` 非空 | `series` 非空 | 空时写入 | 有返回时写入 | 写入或清空 |
| 导演 | `director` 非空 | `director` 非空 | 空时写入 | 有返回时写入 | 写入或清空 |
| 时长 | `duration_seconds` 非空 | 有限非负数 | 空时写入 | 有返回时写入 | 写入或清空 |
| 女优 | 当前女演员集合非空 | 返回女演员集合非空 | 女优为空时整体写入 | 有返回时整体替换 | 整体替换或清空 |
| 男优 | 当前男演员集合非空 | 返回男演员集合非空 | 男优为空时整体写入 | 有返回时整体替换 | 整体替换或清空 |
| 标签 | 当前刮削标签集合非空 | 返回标签集合非空 | 刮削标签为空时整体写入 | 有返回时整体替换 | 整体替换或清空；手动标签不变 |
| 来源链接 | 当前来源站点的 URL 非空 | `sourceUrl` 非空 | 该站点为空时写入 | 有返回时更新该站点 | 更新或删除该站点记录 |
| 站点评分 | 当前评分来源站点存在有效均分 | 返回有效均分 | 该站点为空时写入 | 有返回时更新该站点 | 更新或删除该站点评分 |
| 样张 | 当前整组均为可用本地图片 | 全部 URL 下载成功且图片可读 | 无可用样张时整体写入 | 全部可用时整体替换 | 未返回 URL 时清空；下载失败时保留并警告 |

## 设计

### 1. 建立统一写入计划

在 `src/main/db/videoRepo.ts` 增加只读的 `planVideoScrapeResult`，由它生成每个字段的最终处置。计划至少包含：

```ts
type VideoScrapeImpactAction = 'preserve' | 'set' | 'replace' | 'clear'

type VideoScrapeImpactReason =
  | 'replace'
  | 'fillEmpty'
  | 'replaceIfPresent'
  | 'existingValue'
  | 'noValue'
  | 'resourceUnavailable'

interface VideoScrapeFieldImpact {
  field: VideoScrapeField
  action: VideoScrapeImpactAction
  reason: VideoScrapeImpactReason
  currentValue: unknown
  nextValue: unknown
  sourceName?: string
}

interface VideoScrapeApplicationPlan {
  effectiveFields: VideoScrapeField[]
  impacts: VideoScrapeFieldImpact[]
  shouldApply: boolean
  warnings: string[]
}
```

`resolveEffectiveScrapeFields` 和正式写入必须复用计划所依赖的同一套“字段是否为空”函数，不能分别维护另一套条件。

计划阶段只读数据库和文件状态，不写数据库、不删除资源。覆盖更新即使最终值为空，也生成 `clear` 动作并令 `shouldApply = true`；补齐/有值覆盖只有存在可用刮削值时才令 `shouldApply = true`。

### 2. 显式传递字段来源

在 `src/main/scrapers/scraperManager.ts` 增加字段来源解析器：

```ts
interface VideoScrapeFieldSources {
  source: string
  rating: string
}
```

- 直接插件的两个来源均为实际插件名。
- 组合插件分别读取 `fieldPluginMap.source`、`fieldPluginMap.rating`。
- `scrapeVideo` 在计算有效字段前解析来源，并把来源上下文传给预判和写入计划。
- `upsertVideoExternalId`、`deleteVideoExternalId`、`upsertVideoExternalStats`、`deleteVideoExternalStats` 都只操作传入来源。

来源链接仅在 `sourceUrl` 非空时 upsert；覆盖更新无 URL 时删除该来源记录；补齐/有值覆盖无 URL 时不写入。评分采用相同规则，并以有效 `ratingAverage` 作为“有值”标准。

### 3. 修正字段空值判定

在 `src/main/db/videoRepo.ts` 调整快照与判定：

- 分别统计女性、男性演员数量，移除共用 `castCount`。
- 封面用 `isUsableImageAsset(cover_path)` 判断，不再只看路径字符串。
- 样张按每条本地资源的可用性判断；远程 URL 或失效本地路径不算已完成的本地样张集合。
- 来源链接按当前 `sourceName` 查询非空 URL。
- 站点评分按当前 `ratingSourceName` 查询有效均分。
- 标签继续只统计刮削标签。

批量任务的 `missingFields` 目标筛选必须与上述规则一致。标量和关系字段继续使用 SQL；封面/样张文件健康状态在候选查询后使用缓存的图片检查结果过滤，`listVideosForBatchScrape` 与 `countVideosForBatchScrape` 复用同一目标解析结果，避免列表数量与实际目标不一致。

### 4. 图片资源先验证、后提交

在 `MediaAssetStore`（`src/main/services/mediaAssetStore.ts` 及其内部 download/filesystem adapter）和 `src/main/scrapers/scraperManager.ts` 调整下载流程：

- `downloadCover`、`downloadSamples` 在落盘前用 `isUsableImageBuffer` 校验响应，HTML、空响应和损坏图片均视为失败。
- 封面 URL 存在但下载失败时，向计划传入 `resourceUnavailable`。
- 样张只要有一个 URL 下载失败或文件不可用，就删除本次已经下载的临时样张，并把整个字段标为 `resourceUnavailable`。
- 未被计划采用的新下载文件必须清理，不能成为孤立资源。

数据库资源行改为事务内替换、事务成功后删除旧文件：

- 将现有会在事务内删除文件的 `replaceVideoAssets` 拆成“替换资源行并返回旧路径”和“提交后删除旧文件”。
- 更新封面时同步替换 `video_assets` 中 `type = 'cover'` 的记录。
- 清空封面时删除封面资源行；替换封面时不留下指向已删除文件的旧行。
- 样张采用相同的提交后清理流程，并同步清除指向被替换样张的 `poster_path`。

### 5. 按计划写入并返回真实结果

重构 `applyScrapeResult`：

1. 创建计划。
2. `shouldApply = false` 时不启动写事务，返回 `{ applied: false, warnings }`。
3. 事务内只执行 impact 指定的动作。
4. 至少一个字段应用后才更新 `scraped_status = 1`、`last_scraped_at` 和 `updated_at`。
5. 事务成功后清理被替换资源和未采用的临时资源。
6. 事务失败时删除本次创建但未提交的新资源，旧资源保持可用。

建议将返回值从 `boolean` 改为：

```ts
interface ApplyVideoScrapeResult {
  applied: boolean
  warnings: string[]
}
```

### 6. 贯通单次与批量反馈

修改以下调用链：

- `src/shared/videoTypes.ts` 与 `src/shared/scrapeTypes.ts`
  - `VideoScrapeOneResult` 增加 `warnings: string[]`。
  - 修正 `applied` 注释，使其适用于三种更新方式。
- `src/main/scrapers/scraperManager.ts`
  - `ScrapeOutcome` 携带 `warnings`，`skipped` 由 `applied` 决定。
- `src/main/ipc/scrapeHandlers.ts`
  - 向渲染进程返回 `applied` 和 `warnings`。
- `src/main/services/videoBatchScrapeQueue.ts`
  - 无应用且无警告：`跳过：所选字段无可写入内容`。
  - 无应用但有资源警告：`跳过：资源不可用，已保留原数据`。
  - 部分应用且有警告：成功计数不变，日志说明哪些图片字段未应用。
- `src/renderer/src/pages/DetailPage.tsx`、`LibraryPage.tsx`
  - 成功且无警告显示普通成功提示。
  - 成功但有警告显示“已更新，部分图片未应用”。
  - 跳过显示“所选字段无可写入内容”；有资源警告时附带简短原因。

不新增新的批量日志级别，带警告的成功/跳过使用现有 `info`，避免扩大持久化任务格式。

## 实施顺序

### 步骤一：写入计划与标量字段

- 新增影片快照、impact 和计划函数。
- 先覆盖标题、简介、发行日期、制作商、发行商、系列、导演、时长。
- 改造 `applyScrapeResult` 返回结构和成功状态，但暂不改变图片与站点字段。
- 为八个标量字段建立三模式参数化测试。

### 步骤二：集合字段

- 女优、男优改成独立计数与独立计划。
- 标签保留手动来源，仅整体替换刮削来源。
- 样张接入集合 impact，暂沿用现有下载输入。
- 增加空集合、非空集合、不同性别和手动标签保护测试。

### 步骤三：站点字段

- 增加真实字段来源解析。
- 来源链接和评分改为按站点查询、写入和删除。
- 修正批量缺失字段筛选的站点上下文。
- 增加直接插件、组合插件、已有其他站点数据和当前站点空记录测试。

### 步骤四：图片资源原子性

- 增加图片响应校验。
- 封面、样张接入 `resourceUnavailable`。
- 资源行事务化替换，文件提交后清理。
- 清理未采用的新下载文件和历史封面资源行。
- 增加下载失败、损坏文件、部分样张失败、事务回滚和旧文件保留测试。

### 步骤五：反馈与全量回归

- 贯通 warnings、单次提示和批量日志。
- 补齐 15 字段 × 3 模式矩阵测试。
- 运行类型检查、相关定向测试和全量测试。

## 测试方案

### 参数化语义测试

在 `src/main/db/videoRepo.test.ts` 为每个字段至少覆盖：

1. 当前为空、刮削有值。
2. 当前有值、刮削有值。
3. 当前有值、刮削无值。
4. 当前为空、刮削无值。
5. 三种更新方式下的最终值、`applied`、状态和时间。

集合字段额外覆盖：

- 只有女优时男优仍为空，反之亦然。
- 有值覆盖执行整体替换而不是合并。
- 覆盖更新空数组清空集合。
- 手动标签在任何模式下均保留。

站点字段额外覆盖：

- 其他站点已有记录不阻止当前站点空字段补齐。
- 有值覆盖无返回值时保留当前站点记录。
- 覆盖更新无返回值时只删除当前站点记录。
- 组合插件按字段实际插件名保存来源。

图片字段额外覆盖：

- 当前路径不存在或文件不可读时视为空。
- 封面有 URL 但下载失败时保留旧封面。
- 样张部分下载失败时保留完整旧集合。
- 替换和清空后无失效 `video_assets` 行。
- 数据库事务失败时旧文件仍存在，新临时文件被清理。

### 调用链测试

- 为 `scraperManager` 增加资源成功、无返回值和下载失败测试。
- 为批量队列增加成功、跳过、部分警告三种日志测试。
- 保留并更新现有 `videoRepo.resolveEffectiveScrapeFields` 测试，删除“任意演员阻止两个性别补齐”的旧断言。

### 验证命令

```text
npm run typecheck
node scripts/run-electron-tests.mjs src/main/db/videoRepo.test.ts
node scripts/run-electron-tests.mjs src/main/scrapers/scraperManager.test.ts
node scripts/run-electron-tests.mjs src/main/services/videoBatchScrapeQueue.test.ts
npm test
```

## 验收标准

- 15 个影片字段均通过三种更新方式的参数化测试。
- 女优存在时可单独补齐男优，男优存在时可单独补齐女优。
- 不同站点的来源链接和评分互不阻塞、互不清除。
- 覆盖更新只有在站点确实没有返回图片时才清空图片字段；下载失败不丢失旧资源。
- 样张不会部分替换，封面和样张不留下失效资源行或孤立新文件。
- 空字段补齐和有值覆盖没有可写内容时返回跳过，刮削状态和时间不变。
- 单次提示、批量日志和数据库实际结果一致。
- 不修改未选择字段、手动标签、手动评分、影片文件及其他站点元数据。
- 类型检查、定向测试和全量测试全部通过。

## 提交拆分建议

1. `refactor: plan video scrape field updates`
2. `fix: align video collection and site metadata updates`
3. `fix: make video image scrape writes atomic`
4. `test: cover video scrape update mode matrix`

每个提交都必须保持类型检查和已有测试通过；最后一个提交完成全量回归。
