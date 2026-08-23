# 刮削插件格式

定义 Javdex **刮削插件**的包结构、沙箱 API 与返回契约。手写插件、导出/导入包、以及插件开发 Agent 产出的代码，均须符合本文。

> 使用 **插件开发 Agent** 辅助编写时，见 [`PLUGIN_DEV_AGENT.md`](./PLUGIN_DEV_AGENT.md)。本文只描述插件本身，不描述 Agent 工具与工作流。

## 插件类型

| `kind` | 入口函数 | 用途 |
|--------|----------|------|
| `video` | `parseVideo(ctx)` | 影片元数据刮削 |
| `actress` | `parseActress(ctx)` | 演员资料刮削 |

内置插件位于 `src/main/bundled-plugins/`（如 JavDB、JavLibrary、Xslist、Gfriends 等），以 `plugin.json` + 入口脚本形式随应用分发。

## 包与安装形态

### 导入包（`.avscraper.json`）

用户通过 **设置 → 刮削插件** 导入的单文件 JSON，推荐命名 `{name}.{kind}.avscraper.json`：

```json
{
  "schemaVersion": 1,
  "kind": "video",
  "name": "Example Site",
  "version": "1.0.0",
  "description": "刮削 example.com 影片详情",
  "author": "optional",
  "homepage": "https://example.com",
  "supportedFields": ["title", "maker", "cover", "rating"],
  "code": "module.exports = { async parseVideo(ctx) { return null } }"
}
```

规则：

- `schemaVersion` 必须为 `1`
- `kind` 为 `video` 或 `actress`
- `code` 为 CommonJS 字符串，导入时校验并写入安装目录
- `supportedFields` 声明本插件支持的刮削字段 id（见下文），不是返回对象键。影片中 `coverUrl → cover`、`durationSeconds → duration`、`sourceUrl → source`，`actresses` 按 `gender` 对应 `actressesFemale` / `actressesMale`。演员映射独立定义；`mainName` 是运行身份键、`sourceUrl` 是可选调试键，二者都不属于演员 `supportedFields`。**未声明的字段即使代码返回也会被忽略**
- 内置插件名称为保留名称；同名用户插件会被拒绝安装。编辑内置插件时应另存为不同名称的自定义插件

### 安装目录（导入后 / Agent 安装后）

```text
app.getPath('userData')/scraper_plugins/{video|actress}/{plugin-name}/
  plugin.json    # 元数据 + supportedFields + entry
  index.cjs      # 入口脚本（默认 entry 名）
```

### 沙箱限制

插件在 Worker 沙箱中运行。禁止使用 `require`、`import`、Node 文件系统、应用内部模块。仅可使用 `ctx` 提供的 `fetchPage`、`fetchBuffer`、`browser`、`cheerio` 与 `helpers`。

兼容别名：`parseTask` 仍可作为 `parseVideo` / `parseActress` 的旧名被加载。

## 影片插件 `parseVideo(ctx)`

### `ctx` 字段

| 成员 | 说明 |
|------|------|
| `ctx.code` | 待刮削番号 |
| `ctx.proxyUrl` | 当前刮削代理（可能为空） |
| `ctx.fetchPage(url, options?): Promise<string>` | 拉取并直接返回页面 HTML 字符串，不返回 `{ html, url }` 对象，也不包含最终 URL。`url` 必须是绝对 `http:` / `https:`；相对路径和 `//host/...` 须先用 `ctx.helpers.absoluteUrl(href, base)` 解析，否则会抛 `Invalid URL`。`options`: `readySelector`、`timeoutMs`、`settleWhenText`（`RegExp`）。`timeoutMs` 只计算正常页面加载时间；Cloudflare 人工验证暂停该计时，并使用独立的 3 分钟验证上限。 |
| `ctx.fetchBuffer(url, options?)` | 拉取二进制（如图片）；持久缓存选项见下文 |
| `ctx.cheerio` | Cheerio 模块；**每个 HTML 须先 `const $ = ctx.cheerio.load(html)`**，沙箱内无全局 `$` |
| `ctx.browser` | 见下方浏览器辅助 |
| `ctx.helpers.absoluteUrl(href, baseUrl)` | 解析相对链接 |
| `ctx.helpers.normalizeDate(text)` | 规范为 `YYYY-MM-DD`；仅年月时归为 `YYYY-MM-01` |
| `ctx.helpers.normalizeText(text)` | 折叠空白 |
| `ctx.helpers.unique(values)` | 去重字符串数组 |

影片沙箱不存在 `ctx.url`、`ctx.pageUrl`、`ctx.taskUrl`、`ctx.target` 或 `ctx.sourceUrl`。开发浏览器的当前 URL 也不会注入插件；插件必须从 `ctx.code` 自行定位详情页。

标准 HTML 解析方式：

```js
const html = await ctx.fetchPage(ctx.helpers.absoluteUrl(href, searchUrl))
const $ = ctx.cheerio.load(html)
```

浏览器开发 observation 的 `pageFacts.links.href` 已按当前页 resolve，供继续浏览。cheerio 读到的是 HTML 原始属性；两者不同时 observation 会另给 `rawHref`。不要把已 resolve 的 href 直接传给 `fetchPage`。

### 受信内置服务绑定

应用打包目录中的特定内置插件可由 Javdex 声明 `serviceBinding`。目前唯一绑定为影片插件 MetaTube：

```json
{
  "kind": "video",
  "name": "MetaTube",
  "serviceBinding": "metatube"
}
```

这不是用户插件 API。`.avscraper.json` 或用户插件安装目录中出现 `serviceBinding` 会被主进程拒绝；绑定插件也不可导出、读取代码或交给插件开发 Agent 调试。普通插件的 `ctx.service` 为 `undefined`。

受信绑定插件额外获得：

```js
const payload = await ctx.service.getJson('/v1/movies/search', {
  query: { q: ctx.code, fallback: true }
})
const imageUrl = ctx.service.publicUrl('/v1/images/primary/provider/id', {
  quality: 90
})
```

- `getJson(relativePath, { query })` 仅接受配置 origin 和反向代理 base path 内的相对路径。主进程负责可选 Bearer Token、代理、同源重定向、超时、2 MiB 响应上限和错误分类；Token 不进入 Worker。
- `publicUrl(relativePath, query)` 只生成同一服务范围内的公开 URL，不添加 Token，适合 MetaTube 的公开图片路由。
- 用户每次开始刮削时，主进程快照地址、代理和 Token；任务运行中修改配置不会改变该任务的连接参数。
- 服务地址必须由用户配置。未配置的绑定插件不会进入可执行插件列表，也不能成为默认源或组合字段源。

### 共享浏览器窗口

`ctx.fetchPage` 与 `ctx.browser.*` 共用独立 Electron scraper helper 里的唯一页面。一次刮削从解析到图片下载持有同一独占租约，代理在租约建立时冻结；Cookie、Cloudflare clearance、本地存储和图片响应缓存不会被其他任务串扰。跨任务冲突立即返回 `SCRAPE_BROWSER_BUSY`，不会排队或改写当前页面。

租约内部的 `fetchPage` 仍按顺序执行，因此 `Promise.all(urls.map(ctx.fetchPage))` 不会让单页 target 并发导航；总耗时仍接近各页之和。helper 使用 Electron 内置 Chromium和既有 `Partitions/scraper` profile，不要求系统浏览器或 Playwright 浏览器下载。

`ctx.browser.*` 保持既有返回契约，但一串 `click` / `type` / `snapshot` 仍依赖页面在调用之间保持不动，所以动作序列必须顺序 `await`，且不可与 `fetchPage` 交叉。

### `ctx.fetchBuffer` 持久缓存

设计决定见 [ADR-0001](./adr/0001-integrate-gfriends-as-actress-avatar-source.md)。

大体积、低频更新的远程资源可请求由主进程管理的插件级持久缓存：

```js
const body = await ctx.fetchBuffer(url, {
  cache: {
    mode: 'persistent',
    maxAgeMs: 24 * 60 * 60 * 1000,
    staleIfError: true
  }
})
```

- 不传 `cache` 时保持现有一次性拉取语义。
- 缓存按插件与规范化 URL 隔离，插件不能指定磁盘路径。
- 主进程强制限制单项与单插件总容量，防止插件无限占用磁盘。
- 超过 `maxAgeMs` 后优先使用 `ETag` 条件请求；`304` 保留原内容，成功的新内容以原子方式替换。
- `staleIfError: true` 表示更新失败时返回最后一次成功内容；没有旧内容时仍抛出原始网络错误。
- 代理、请求校验和 HTTP(S) 限制与普通 `fetchBuffer` 相同。

### `ctx.browser`

用于动态页面或需交互的站点（与 Agent 开发时的 `browser_*` 工具底层均走主进程 `scrapeBrowser`）：

| 方法 | 说明 |
|------|------|
| `snapshot(options?)` | 页面快照 |
| `html()` | 当前 HTML |
| `url()` | 当前 URL |
| `inspect(options?)` | 结构探查 |
| `click(selector)` / `type(selector, text, options?)` / `press(key)` | 交互 |
| `waitForSelector(selector, options?)` / `wait(timeoutMs)` | 等待；`waitForSelector` 与 `fetchPage` 一样会暂停 Cloudflare 验证期间的页面计时 |

### `supportedFields`（video）

字段 id 与 `src/shared/scrapeTypes.ts` 中 `VideoScrapeField` 一致：

`title`、`summary`、`cover`、`releaseDate`、`maker`、`publisher`、`series`、`director`、`duration`、`actressesFemale`、`actressesMale`、`tags`、`source`、`rating`、`samples`

### 返回值

影片插件可返回以下三种值：

- `null` 或空数组：未匹配。
- 单个对象：兼容旧插件的单结果形式；`code` 建议提供，省略时主进程使用本次查询番号。
- 对象数组：搜索结果第一页上番号规范化后完全相等的条目必须全部抓取详情；多于一条时返回全部候选。普通模糊搜索列表、标题包含、前缀匹配和第二页都不是多候选契约的触发条件。未匹配返回 `null` 或空数组，不得返回相似目标。数组中每个对象都必须提供非空 `code`，任一项无效或任一条完全匹配详情失败都会拒绝整次插件结果，不得用其余详情凑成不完整集合。

候选对象除 `code` 外的字段均为可选，但须与 `supportedFields` 一致：

```js
{
  code: 'IPX-535',           // 建议大写规范化
  title: '...',
  summary: '...',
  coverUrl: 'https://...',
  releaseDate: 'YYYY-MM-DD',
  maker: '...',
  publisher: '...',
  series: '...',
  director: '...',
  durationSeconds: 7200,
  sourceUrl: 'https://...',  // 详情页 URL
  ratingAverage: 4.2,        // 5 分制，(0, 5]，最多 1 位小数
  ratingCount: 100,            // 仅在与 ratingAverage 同时有效时返回
  sampleImageUrls: ['https://...'],
  actresses: [{ name: '...', avatarUrl: '...', gender: 'female' | 'male' }],
  tags: ['...']
}
```

数组示例：

```js
[
  { code: 'IPX-535', title: '版本 A', sourceUrl: 'https://example.test/a' },
  { code: 'IPX-535', title: '版本 B', sourceUrl: 'https://example.test/b' }
]
```

主进程会将查询番号与候选 `code` 分别执行去空格、转大写规范化，只保留精确相等的候选；不接受前缀、包含或模糊匹配。被过滤的候选会生成警告。随后按规范化后的 `sourceUrl` 去重；是否显式包含尾部 `/` 会保留为不同来源。多个有效候选不会自动选择，而是进入“待确认”中心。

日期必须为合法 `YYYY-MM-DD`，禁止 `YYYY-MM-00`。

### 推荐抓取策略

- **直连详情页**：仅当 URL 可由番号可靠推导，或搜索 URL 会跳转到详情页时使用；须用选择器与番号/标题证明命中。
- **搜索进详情**：搜索页只用于定位第一页全部番号完全匹配的详情链接；用 `ctx.helpers.absoluteUrl(href, searchUrl)` 解析链接后再抓详情页，并将 `sourceUrl` 设为详情页 URL。规范化后与查询番号逐字符相等的条目必须全部抓取；多于一条返回数组，任一条详情失败则整次失败。不要用模糊匹配、标题包含、第一条回退或第二页补位。

## 演员插件 `parseActress(ctx)`

### `ctx` 字段

| 成员 | 说明 |
|------|------|
| `ctx.mainName` | 主名 |
| `ctx.aliases` | 别名数组 |
| 其余 | 与影片相同：`proxyUrl`、`fetchPage`、`fetchBuffer`、`cheerio`、`browser`、`helpers` |

演员沙箱同样不存在 `ctx.url`、`ctx.pageUrl`、`ctx.taskUrl`、`ctx.target` 或 `ctx.sourceUrl`。插件必须从 `ctx.mainName` / `ctx.aliases` 自行搜索资料页。

### `supportedFields`（actress）

`avatar`、`gallery`、`birthDate`、`nameZh`、`nameEn`、`debutDate`、`heightCm`、`measurements`、`cupSize`、`bloodType`、`zodiac`、`nationality`、`profileSummary`、`aliases`

（`measurements` 对应返回 `bustCm` / `waistCm` / `hipCm`。）

演员结果键与字段 id 的映射为：`avatarUrl → avatar`、`galleryImageUrls → gallery`、`bustCm/waistCm/hipCm → measurements`，其余可声明结果键与字段 id 同名。`mainName` 和 `sourceUrl` 是运行/调试信息，不参与生产字段投影，也不得写入 `supportedFields`。

### 返回值

```js
{
  mainName: ctx.mainName,
  nameZh: '...',
  nameEn: '...',
  avatarUrl: 'https://...',
  birthDate: 'YYYY-MM-DD',
  debutDate: 'YYYY-MM-DD',
  heightCm: 160,
  bustCm: 84,
  waistCm: 59,
  hipCm: 88,
  cupSize: 'E',
  bloodType: 'A',
  zodiac: 'Leo',
  nationality: 'Japan',
  profileSummary: '...',
  galleryImageUrls: ['https://...'],
  aliases: ['...'],
  sourceUrl: 'https://...' // 可选调试来源，不是 supportedFields
}
```

### 推荐抓取策略

- **直连资料页**：URL 可由名称/slug 可靠推导时使用。
- **搜索进资料页**：依次尝试 `mainName` 与各 `alias`；搜索页仅用于找资料链接。
- **动态搜索**：若结果通过 AJAX 更新而 URL 不变，用 `fetchPage` 复现对应请求（可从站点脚本或开发浏览的 `recentRequests` 还原 method/URL），勿把未变化的 URL 当作失败。插件开发助手按四档确认搜索入口，生产实现同样优先 `fetchPage`，能直连请求时不要把浏览器点选流程写入插件。
- **头像专用来源**：只提供头像的演员头像源应仅声明 `avatar`，不返回别名或其他资料，也不据此改变演员身份；未精确命中时返回 `null`。

## 组合刮削器

**设置 → 刮削插件 → 新增组合** 可创建 `composite` 来源的影片或演员刮削器：为每个字段指定不同的内置或用户插件。组合配置保存在 `settings.json` 的 `compositeScrapers` 中，**没有**独立的 `parseVideo` / `parseActress` 实现。

演员组合刮削按字段源隔离故障：单个来源失败时记录警告并继续应用其他来源；只有所有已请求来源都失败时整次失败。见 [ADR-0001](./adr/0001-integrate-gfriends-as-actress-avatar-source.md)。

## 插件管理（UI）

导入 / 导出 / 删除自定义包、设置默认插件、配置 per-plugin 延迟、编辑内置插件副本——均在 **设置 → 刮削插件**。开发新插件见 [`PLUGIN_DEV_AGENT.md`](./PLUGIN_DEV_AGENT.md)。
