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
- `supportedFields` 声明本插件支持的刮削字段 id（见下文）；**未声明的字段即使代码返回也会被忽略**
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
| `ctx.fetchPage(url, options?)` | 拉取页面 HTML；`options`: `readySelector`、`timeoutMs`、`settleWhenText`（`RegExp`）。`timeoutMs` 只计算正常页面加载时间；Cloudflare 人工验证暂停该计时，并使用独立的 3 分钟验证上限。 |
| `ctx.fetchBuffer(url, options?)` | 拉取二进制（如图片）；持久缓存选项见下文 |
| `ctx.cheerio` | Cheerio 模块；**每个 HTML 须先 `const $ = ctx.cheerio.load(html)`**，沙箱内无全局 `$` |
| `ctx.browser` | 见下方浏览器辅助 |
| `ctx.helpers.absoluteUrl(href, baseUrl)` | 解析相对链接 |
| `ctx.helpers.normalizeDate(text)` | 规范为 `YYYY-MM-DD`；仅年月时归为 `YYYY-MM-01` |
| `ctx.helpers.normalizeText(text)` | 折叠空白 |
| `ctx.helpers.unique(values)` | 去重字符串数组 |

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

字段 id 与 `src/shared/types.ts` 中 `VideoScrapeField` 一致：

`title`、`summary`、`cover`、`releaseDate`、`maker`、`publisher`、`series`、`director`、`duration`、`actressesFemale`、`actressesMale`、`tags`、`source`、`rating`、`samples`

### 返回值

返回 `null` 表示未匹配；否则返回对象（字段均为可选，但须与 `supportedFields` 一致）：

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

日期必须为合法 `YYYY-MM-DD`，禁止 `YYYY-MM-00`。

### 推荐抓取策略

- **直连详情页**：仅当 URL 可由番号可靠推导，或搜索 URL 会跳转到详情页时使用；须用选择器与番号/标题证明命中。
- **搜索进详情**：搜索页只用于定位详情链接；用 `ctx.helpers.absoluteUrl(href, searchUrl)` 解析链接后再抓详情页，并将 `sourceUrl` 设为详情页 URL。

## 演员插件 `parseActress(ctx)`

### `ctx` 字段

| 成员 | 说明 |
|------|------|
| `ctx.mainName` | 主名 |
| `ctx.aliases` | 别名数组 |
| 其余 | 与影片相同：`proxyUrl`、`fetchPage`、`fetchBuffer`、`cheerio`、`browser`、`helpers` |

### `supportedFields`（actress）

`avatar`、`gallery`、`birthDate`、`nameZh`、`nameEn`、`debutDate`、`heightCm`、`measurements`、`cupSize`、`bloodType`、`zodiac`、`nationality`、`profileSummary`、`aliases`

（`measurements` 对应返回 `bustCm` / `waistCm` / `hipCm`。）

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
  aliases: ['...']
}
```

### 推荐抓取策略

- **直连资料页**：URL 可由名称/slug 可靠推导时使用。
- **搜索进资料页**：依次尝试 `mainName` 与各 `alias`；搜索页仅用于找资料链接。
- **动态搜索**：若结果通过 AJAX 更新而 URL 不变，用 `fetchPage` 复现对应请求，勿把未变化的 URL 当作失败。
- **头像专用来源**：只提供头像的演员头像源应仅声明 `avatar`，不返回别名或其他资料，也不据此改变演员身份；未精确命中时返回 `null`。

## 组合刮削器

**设置 → 刮削插件 → 新增组合** 可创建 `composite` 来源的影片或演员刮削器：为每个字段指定不同的内置或用户插件。组合配置保存在 `settings.json` 的 `compositeScrapers` 中，**没有**独立的 `parseVideo` / `parseActress` 实现。

演员组合刮削按字段源隔离故障：单个来源失败时记录警告并继续应用其他来源；只有所有已请求来源都失败时整次失败。见 [ADR-0001](./adr/0001-integrate-gfriends-as-actress-avatar-source.md)。

## 插件管理（UI）

导入 / 导出 / 删除自定义包、设置默认插件、配置 per-plugin 延迟、编辑内置插件副本——均在 **设置 → 刮削插件**。开发新插件见 [`PLUGIN_DEV_AGENT.md`](./PLUGIN_DEV_AGENT.md)。
