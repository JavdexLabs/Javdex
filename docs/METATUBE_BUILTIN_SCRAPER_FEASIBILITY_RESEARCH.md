# MetaTube 作为内置影片刮削插件的可行性研究

> 研究日期：2026-08-16
> 研究范围：MetaTube 官方组织的一手仓库与 Javdex 当前插件运行时；不依赖第三方教程、非官方 SDK 或线上公共 MetaTube 实例。
> 上游源码基线：`metatube-sdk-go` `6a5e6128c725187aeaf921d48ed7d9cd9f30671b`、`jellyfin-plugin-metatube` `f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2`、官方文档仓库 `d4d12af806619a91248b5d7d1abeb692a7ec1b80`。

## 1. 结论

**可行，建议实施，但应把它定义为“连接用户自建 `metatube-server` 的内置影片插件”，而不是把 Go SDK 编译或嵌入 Electron。**

MetaTube 的 Go 仓库同时包含刮削引擎、数据模型和 HTTP 服务端入口；服务端公开稳定的 `/v1` REST 路由。Javdex 可以在用户配置服务端地址后，通过 HTTP 搜索、拉取详情，并把结果转换成现有 `ScrapeResult`。这条路径无需把 Go 运行时、数据库或 MetaTube 二进制随 Javdex 分发，平台和许可风险都较低。

但它**不能只靠新增一个 `src/main/bundled-plugins/video/MetaTube/index.cjs` 完成**。当前插件沙箱没有每插件服务配置，也不能为 JSON 请求设置 `Authorization: Bearer ...`；若服务端设置 Token，现有 `ctx.fetchPage` / `ctx.fetchBuffer` 无法完成鉴权。因此完整方案必须先补一个受控的“已配置服务”能力，再实现 MetaTube 字段适配。

推荐首发范围：

- 内置影片插件 `MetaTube`，默认显示为“未配置”，不可设为默认源、不可加入组合、不可发起刮削。
- 用户至少配置 `serverUrl` 后才成为可用；`token` 可选，因为 MetaTube 服务端 Token 本身可不启用。
- 通过 `/v1/movies/search` 搜索，再通过 `/v1/movies/:provider/:id` 拉完整详情。
- 首发支持影片字段：`title`、`summary`、`cover`、`releaseDate`、`maker`、`publisher`、`series`、`director`、`duration`、`actressesFemale`、`tags`、`source`、`rating`、`samples`；不声明 `actressesMale`。
- 不在本次顺带新增 MetaTube 演员资料插件。上游确有演员搜索/详情能力，可作为后续独立工作。

## 2. 需要先澄清的产品定位

### 2.1 “SDK”实际同时是服务端源码

仓库 README 把项目称为 Go SDK，并列出 REST API、20+ provider、图片处理和数据库能力（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/README.md#L9-L45)）。同一仓库的 `cmd/server/main.go` 创建路由并直接 `ListenAndServe`（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/cmd/server/main.go#L20-L34)），Makefile 将该产物命名为 `metatube-server`（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/Makefile#L1-L4)）。

因此 Javdex 的正确依赖边界是：

```text
Javdex 内置 MetaTube 插件
        │ HTTPS/HTTP + JSON
        ▼
用户配置的 metatube-server
        │ MetaTube provider / DB / image pipeline
        ▼
各元数据来源
```

Javdex 不负责启动、更新或维护用户的 MetaTube 服务端；只负责验证地址、调用 v1 API、映射结果和给出可诊断错误。

### 2.2 必须由用户配置地址后才能使用

官方客户端本身也把 `Server` 与可选 `Token` 当作配置项；配置说明明确要求完整服务端 URL，并建议 HTTPS（[固定源码](https://github.com/metatube-community/jellyfin-plugin-metatube/blob/f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2/Jellyfin.Plugin.MetaTube/Configuration/PluginConfiguration.cs#L23-L34)）。官方文档同样要求先输入服务端 URL 与 Token，再启用 MetaTube（[固定源码](https://github.com/metatube-community/metatube-community.github.io/blob/d4d12af806619a91248b5d7d1abeb692a7ec1b80/docs/README.md#L41-L48)）。

这与需求完全一致：插件可以随应用内置，但 `serverUrl` 为空时必须是不可执行状态，而不能偷偷带一个公共默认服务。

官方免费后端列表当前也已明确下线，并建议自行搭建后端（[固定文档源码](https://github.com/metatube-community/metatube-community.github.io/blob/d4d12af806619a91248b5d7d1abeb692a7ec1b80/docs/wiki/free-servers.md#L1-L10)）。因此不提供默认地址不只是安全选择，也符合上游当前的实际运营方式。

## 3. 上游 HTTP 契约核查

### 3.1 路由与鉴权

服务端路由集中定义在 `route/route.go`：

- 无鉴权系统信息：`GET /`、`GET /v1/modules`、`GET /v1/providers`。
- 公共图片与翻译：`GET /v1/images/primary/:provider/:id`、`thumb`、`backdrop`、`GET /v1/translate`。
- 受保护数据：`GET /v1/db/version`、`GET /v1/actors/search`、`GET /v1/actors/:provider/:id`、`GET /v1/movies/search`、`GET /v1/movies/:provider/:id`、`GET /v1/reviews/:provider/:id`。

固定证据见[路由注册](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/route.go#L33-L80)。

服务端通过 `-token` / `TOKEN` 接收访问密钥；只有值非空时才启用验证器（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/cmd/cmd.go#L39-L57)、[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/cmd/cmd.go#L105-L110)）。启用后只接受精确的 `Authorization: Bearer <token>`（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/auth.go#L13-L27)）。

结论：

- `serverUrl` 必填；`token` 可空。
- Token 不能放 query string，也不能交给普通插件代码自行拼接。
- 连接测试应调用受保护且不触发外站刮削的 `GET /v1/db/version`；该路由只返回数据库版本（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/database.go#L11-L23)），适合验证 Token。

### 3.2 通用响应与错误

JSON 成功响应形如 `{ "data": ... }`，失败响应形如 `{ "error": { "code", "message" } }`；服务端的统一封装定义见[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/route.go#L147-L169)，错误模型见[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/errors/errors.go#L9-L48)。官方 Jellyfin 客户端也按这一 envelope 反序列化，并在非 2xx 时读取 `error.code/message`（[固定源码](https://github.com/metatube-community/jellyfin-plugin-metatube/blob/f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2/Jellyfin.Plugin.MetaTube/ApiClient.cs#L211-L245)）。

适配器应把错误分为：

- `401`：Token 缺失或错误，提示回到 MetaTube 配置。
- `404`（搜索）：视为未匹配，返回 `[]`，不是插件故障。服务端搜索结果为空时明确返回 404（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/search.go#L74-L95)）。
- `400`：地址/API 参数或上游输入问题，显示服务端 message。
- `429`、`5xx`、连接失败、超时：可重试的服务端/网络故障，不伪装成“未找到”。
- 2xx 但 envelope、字段或类型不合法：API 不兼容，包含服务端版本和路径的诊断错误，但不得打印 Token。

### 3.3 影片搜索与详情

搜索接口：

```http
GET {server}/v1/movies/search?q={code}&provider=&fallback=true
Authorization: Bearer {token}   # 仅配置 token 时
Accept: application/json
```

`q` 必填；`provider` 为空表示搜索全部 provider；`fallback` 默认 `true`（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/search.go#L21-L65)）。全 provider 搜索由服务端并发执行、忽略单 provider 错误，然后按番号相似度与 provider 优先级排序（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/movie.go#L90-L145)、[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/movie.go#L148-L198)）。

搜索结果只是详情子集：`id`、`number`、`title`、`provider`、`homepage`、缩略图/封面、`score`、`actors`、`release_date`（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/model/movie.go#L13-L33)）。

对精确候选再请求详情：

```http
GET {server}/v1/movies/{provider}/{id}?lazy=true
Authorization: Bearer {token}
```

详情路由默认 `lazy=true`，优先复用服务端数据库缓存（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/info.go#L28-L65)、[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/movie.go#L210-L240)）。

不能直接采用搜索排序第一项。MetaTube 的搜索是相关性搜索，而 Javdex 的插件契约要求候选番号精确相等。适配器必须先做受控番号等价判断，再拉取详情；多个 provider 的精确结果全部返回，让现有待确认中心选择。

### 3.4 影片数据模型

完整 `MovieInfo` 提供：

- 身份：`id`、`number`、`provider`、`homepage`。
- 文本：`title`、`summary`、`director`、`maker`、`label`、`series`、`genres`、`actors`。
- 媒体：`thumb_url`、`big_thumb_url`、`cover_url`、`big_cover_url`、`preview_images`、两种预告片 URL。
- 数值/日期：`score`、`runtime`、`release_date`。

固定定义见[上游模型](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/model/movie.go#L71-L113)。`runtime` 是分钟：上游公共解析器明确把时长转换成分钟整数（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/common/parser/parse.go#L68-L71)），FANZA provider 也把秒数除以 60 后写入该字段（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/provider/fanza/fanza.go#L181-L187)）。官方客户端把 MetaTube `score` 乘 2 后写入 Jellyfin 的 10 分制评分，证明 MetaTube 分值按 5 分制使用（[固定源码](https://github.com/metatube-community/jellyfin-plugin-metatube/blob/f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2/Jellyfin.Plugin.MetaTube/Providers/MovieProvider.cs#L142-L145)）。

### 3.5 演员能力

服务端有独立的 `actors/search` 与 `actors/:provider/:id`。演员详情包括姓名、别名、简介、爱好、特长、血型、罩杯、三围、国籍、身高、图片、生日和出道日期（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/model/actor.go#L10-L66)）。演员全 provider 搜索也由服务端并发完成，并按 provider 优先级排序（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/actor.go#L107-L141)）。

不过影片的 `actors` 只是姓名数组，没有性别、演员 provider/id 或头像。官方 Jellyfin 插件也只能把这些姓名统一作为一般 `Actor`，需要额外逐名搜索才尝试补图（[固定源码](https://github.com/metatube-community/jellyfin-plugin-metatube/blob/f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2/Jellyfin.Plugin.MetaTube/Providers/MovieProvider.cs#L181-L195)、[固定源码](https://github.com/metatube-community/jellyfin-plugin-metatube/blob/f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2/Jellyfin.Plugin.MetaTube/Providers/MovieProvider.cs#L261-L291)）。

所以影片插件首发建议：

- 将非空 `actors` 名称映射为 `actresses`，显式标记 `gender: "female"`，只声明 `actressesFemale`。
- 不声明 `actressesMale`，也不为每部影片逐演员二次搜索头像，避免错误性别和 N+1 请求。
- 在插件说明中明确“MetaTube 影片演员字段不带性别，当前按女优导入”。若产品不接受这个假设，应从首发 supportedFields 去掉 `actressesFemale`，但这不影响其余字段的可行性。

独立 MetaTube 演员插件技术上可行，但姓名语言拆分、三围字符串解析、精确身份选择需要另一轮产品规则，不纳入当前影片插件实现。

### 3.6 图片能力

图片 API 是公共路由，即使服务端启用 MetaTube Token 也不需要 Bearer；上游还给整个公共路由组设置了 180 天 shared-cache TTL（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/route.go#L42-L55)、[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/cache.go#L10-L14)）。因此 Token 只保护元数据私有路由，不能把图片端点视为秘密资源。可用端点：

- `/v1/images/primary/:provider/:id`
- `/v1/images/thumb/:provider/:id`
- `/v1/images/backdrop/:provider/:id`

它们可接收 `url`、`ratio`、`pos`、`auto`、`badge`、`quality` 参数，并统一输出 JPEG（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/image.go#L27-L38)、[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/image.go#L82-L140)）。官方客户端对 `preview_images` 也是把原图 URL 作为 `url` 参数交给这些服务端图片路由（[固定源码](https://github.com/metatube-community/jellyfin-plugin-metatube/blob/f7c1f336fc2bd3b35b82af7c6e69da09a196e3d2/Jellyfin.Plugin.MetaTube/Providers/MovieImageProvider.cs#L38-L83)）。

Javdex 不宜直接下载 `cover_url` / `preview_images` 的原始来源，因为这些地址可能需要 provider 特定 Referer、Cookie、代理或区域网络。推荐始终返回配置服务端下的图片代理 URL：

- 封面：`{base}/v1/images/primary/{provider}/{id}?quality=90`
- 样张：对每个 `preview_images[i]` 构造 `.../images/primary/{provider}/{id}?url=...&ratio=0&pos=0&auto=false&quality=90`

图片引擎在非法/极小 ratio 时跳过裁切，因此 `ratio=0` 可保持样张原始宽高比（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/imageutil/crop.go#L14-L24)）；服务端仍负责使用对应 provider 的抓取器下载图片（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/image.go#L78-L100)）。

兼容限制：如果用户在反向代理层给 `/v1/images/*` 额外加了 Basic/OAuth 鉴权，Javdex 的普通图片暂存请求不会自动满足该额外鉴权。首发应声明只支持 MetaTube 自身 Bearer Token 模式；连接测试可顺便探测一条图片 URL，但不能保证每部影片图片都存在。

### 3.7 超时、重试与服务器负载

MetaTube 引擎默认单次外部请求超时为 1 分钟（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/engine.go#L20-L23)），服务端参数允许通过 `REQUEST_TIMEOUT` 修改且小于 1 秒的值会被忽略（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/cmd/cmd.go#L47-L57)、[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/cmd/cmd.go#L72-L78)）。其抓取客户端对可重试网络错误最多重试 3 次，间隔 1–3 秒（[固定源码](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/common/fetch/fetch.go#L66-L99)）。

Javdex 当前整个插件执行上限为 5 分钟（[`scraperPluginSandbox.ts`](../src/main/scrapers/scraperPluginSandbox.ts#L13-L15)）。建议 MetaTube JSON 客户端每请求默认 75 秒、连接测试 10 秒、整个插件仍受 5 分钟总上限约束；不要在 Javdex 对普通 5xx 再做多轮自动重试，以免和服务端重试叠加。只可对连接建立失败做最多一次、带短抖动的重试，批量任务继续使用现有 per-plugin delay。

## 4. 与 Javdex 当前插件系统的差距

### 4.1 已有契约可承接的数据

Javdex 影片插件支持单结果或多候选，并具备标题、简介、封面、日期、制作/发行、系列、导演、时长、男女演员、标签、来源、5 分制评分与样张字段；完整契约见[`SCRAPER_PLUGIN_FORMAT.md`](./SCRAPER_PLUGIN_FORMAT.md#影片插件-parsevideoctx)和[`videoScrapeTypes.ts`](../src/shared/videoScrapeTypes.ts)。这与 MetaTube `MovieInfo` 的主体数据高度重合。

现有候选处理会按番号精确匹配、按 `sourceUrl` 去重，并让多个有效候选进入待确认中心（[`scraperManager.ts`](../src/main/scrapers/scraperManager.ts#L111-L138)）。这正适合 MetaTube 同一番号来自多个 provider 的情况。

### 4.2 当前阻塞点

1. **无 per-plugin 服务配置。** `AppSettings` 目前只有刮削代理、默认插件、延迟与组合配置，没有服务端 URL/Token（[`settingsTypes.ts`](../src/shared/settingsTypes.ts#L54-L132)）。`ScraperPluginDescriptor` 也没有 `requiresConfiguration`、`configured` 或配置摘要（[`scraperPluginTypes.ts`](../src/shared/scraperPluginTypes.ts#L24-L62)）。
2. **Token 无法发送。** `ctx.fetchPage` 选项只有等待/超时；`ctx.fetchBuffer` 选项只有持久缓存（[`scraperPluginSandbox.ts`](../src/main/scrapers/scraperPluginSandbox.ts#L16-L28)）。Worker RPC 不接受调用方 headers（[`scraperPluginSandbox.ts`](../src/main/scrapers/scraperPluginSandbox.ts#L290-L312)）。
3. **配置没有进入 Worker。** `SandboxWorkerData` 只含插件代码、代理和任务字段（[`scraperPluginSandbox.ts`](../src/main/scrapers/scraperPluginSandbox.ts#L30-L42)），`parseVideo(ctx)` 也只拿到番号、代理、抓取器、浏览器和 helpers（[`scraperPluginSandbox.ts`](../src/main/scrapers/scraperPluginSandbox.ts#L590-L600)）。
4. **内置插件与用户插件共用同一沙箱包装。** `loadBundledVideoScrapers()` 同样实例化 `UserVideoScraper`（[`scraperPluginService.ts`](../src/main/scrapers/scraperPluginService.ts#L46-L60)、[`scraperPluginService.ts`](../src/main/scrapers/scraperPluginService.ts#L103-L116)），所以不能假设内置插件可直接 `require` Node HTTP 客户端。
5. **UI 不知道“已安装但不可用”。** 当前插件卡片/默认源/组合源只依赖描述符与字段覆盖，没有服务连接状态。

### 4.3 不推荐的捷径

- **把 Token 放 URL query：** 上游鉴权不会读取 query，且会泄露到日志、来源链接和截图。
- **开放通用 `ctx.fetch(url, { headers })` 并把 Token 传入 Worker：** 用户插件或导出的内置副本可把秘密发往任意主机；跨域重定向也可能带出 Authorization。
- **直接让 `fetchPage` 打开 JSON：** Token 仍无法设置，浏览器会把 JSON 包装为页面 DOM，错误和大小限制也不明确。
- **随 Javdex 分发/拉起 Go 服务端：** 显著扩大安装包、更新、端口、数据库、进程生命周期和跨平台支持范围，不符合“用户配置自定义服务端地址”的目标。
- **把一个公共 MetaTube 地址写成默认值：** 违背需求，也把可用性、流量、内容与隐私责任转移给未知第三方。

## 5. 推荐字段映射

| Javdex 字段 | MetaTube 字段/路径 | 规则与完整度 |
|---|---|---|
| `code` | `number` | 先做受控等价判断；通过后返回本次 `ctx.code` 的大写 trim 形式，确保通过 Javdex 精确候选过滤。不得让模糊搜索结果冒充精确结果。 |
| `title` | `title` | 直接映射，空值省略。 |
| `summary` | `summary` | 直接映射，空值省略。 |
| `coverUrl` | `/v1/images/primary/{provider}/{id}` | 使用用户配置服务端的公共图片路由，不直接使用原站 `cover_url`。 |
| `releaseDate` | `release_date` | 只接受合法 `YYYY-MM-DD`；过滤零值/非法日期。 |
| `maker` | `maker` | 直接映射。 |
| `publisher` | `label` | 语义近似：MetaTube `label` 更接近厂牌/发行标签；须在插件描述和测试中记录该映射。 |
| `series` | `series` | 直接映射。 |
| `director` | `director` | 直接映射。 |
| `durationSeconds` | `runtime` | `runtime` 为分钟；只接受正有限整数并乘 60；建议拒绝超过 10,080 分钟（7 天）的异常值。 |
| `actresses` | `actors` | 首发仅 `actressesFemale`；去空、去重，显式 `gender: "female"`。不补头像，不声明男演员。 |
| `tags` | `genres` | 去空、保持上游次序并去重。 |
| `sourceUrl` | `homepage` | 原数据来源详情页；只接受 HTTP(S)。 |
| `ratingAverage` | `score` | MetaTube 已为 5 分制，直接保留到 1 位小数；只接受 `(0, 5]`。 |
| `ratingCount` | 无 | 不返回。MetaTube `MovieInfo` 没有评分人数。 |
| `sampleImageUrls` | `preview_images` 经 `/v1/images/primary/...?...ratio=0` | 每张样图都走 MetaTube 图片代理，保持原始比例；过滤空/非 HTTP(S) 原图地址并限制数量。 |

额外边界：

- `preview_video_url` / `preview_video_hls_url` 暂无 Javdex 刮削字段，不映射。
- 搜索结果必须至少有非空 `id`、`provider`、`number`；详情必须通过 envelope 和类型校验。
- 候选详情请求保留 MetaTube 搜索排序；相同 `{provider,id}` 去重。
- 建议 `MAX_EXACT_CANDIDATES = 20`、`MAX_SAMPLE_IMAGES = 40`、JSON body 上限 2 MiB。超过候选/响应上限应报兼容/服务异常，不静默截断；样张可明确截到上限并产生 warning（若当前插件 warning 通道不支持，应记录到待确认 warning 的后续改造项）。

## 6. 推荐的运行时设计

### 6.1 采用“受信内置服务桥”，不要给普通插件任意请求头

建议给内置 manifest 增加仅应用内认可的服务绑定，例如：

```json
{
  "schemaVersion": 1,
  "kind": "video",
  "name": "MetaTube",
  "serviceId": "metatube",
  "requiresConfiguration": true,
  "editable": false,
  "exportable": false
}
```

`serviceId` 只允许出现在应用打包的 manifest；用户导入包不能声明它。主进程识别服务绑定后，为 Worker 提供：

```js
ctx.service.baseUrl                 // 非秘密、规范化后的 URL
ctx.service.getJson(path, options)  // 只允许相对路径，主进程自动加同源 Bearer
ctx.service.publicUrl(path, query)  // 只构造同一 baseUrl 下的公共资源 URL
```

Token 永不进入 Worker。`getJson` 在主进程读取秘密，手动处理重定向，只向配置 base origin 发送 Authorization；跨 origin 重定向直接拒绝。这样既保留 `plugin.json + index.cjs` 的内置插件形态，也不会把一个危险的通用 headers API 开给所有用户插件。

如果团队不接受扩展沙箱 API，次选方案是实现主进程原生 `MetaTubeVideoScraper implements BaseScraper`，只把它作为 builtin descriptor 暴露。该方案改动较集中，但会绕开现有 bundled plugin 的可编辑/导出/验证模型，长期一致性较差。

### 6.2 配置与秘密存储

公开设置建议：

```ts
interface MetaTubeServicePublicConfig {
  serverUrl: string
  hasToken: boolean
  useScrapeProxy: boolean
}
```

- `settings.json` 只保存规范化 `serverUrl`、`useScrapeProxy` 与非秘密状态。
- Token 复用 `llmSecretStore` 的 Electron `safeStorage` 模式，新增按 `serviceId` 隔离的 scraper service secret store；不要明文进入 `settings.json`。
- 渲染进程只收到 `hasToken`，读取不到 Token；更新接口使用“留空保持、显式清除”的语义。
- 所有日志、IPC 错误和测试快照必须把 Authorization/Token 脱敏。

`useScrapeProxy` 建议默认 `false`：MetaTube 经常部署在本机/LAN，而服务端自身负责访问外部 provider 的代理。用户确实需要通过 Javdex 代理访问远端 MetaTube 服务时再开启。

### 6.3 URL 与网络策略

- 仅接受 `http:` / `https:`，拒绝用户名密码、query、fragment、控制字符。
- 保留可选反向代理 path prefix；所有 API path 必须通过单一 `joinServiceUrl` 构造并有单元测试。
- `https:` 推荐；只有 loopback、`.local` 或明确确认的私网地址允许无警告 HTTP。公网 HTTP 保存时显示 Token 明文传输警告。
- 不允许忽略 TLS 证书错误；首发不提供 `allowInsecureTls`。
- 允许用户配置私网/loopback 是功能要求，因此不能套用“仅公网 URL”的 SSRF 规则；作为补偿，只允许用户明确保存的 origin，拒绝调用时更换 host、scheme、port。
- JSON 请求手动重定向，最多 3 次；跨 origin 拒绝，降级到 HTTP 拒绝。
- 连接/读取分别限时，总请求上限 75 秒；body 流式计数，超过 2 MiB 中止。
- `Accept: application/json`；Content-Type 非 JSON 时仍可尝试解析一次，但错误中标记类型不符，避免某些反向代理配置造成误判。

### 6.4 可用状态与连接测试

配置状态不是“最近一次连接成功”的永久缓存，而是：

- `unconfigured`：`serverUrl` 为空；插件不可选、运行直接返回本地可操作错误。
- `configured`：URL 语法有效；允许使用，即使服务当前离线。
- UI 的瞬时测试结果：成功时展示服务版本、DB 版本、movie provider 数量；失败时展示 401/超时/非 MetaTube 服务等原因。

连接测试顺序：

1. `GET /`，确认 `data.app` 与 `data.version` 存在。
2. `GET /v1/providers`，确认 `data.movie_providers` 为对象且至少一个 provider。
3. `GET /v1/db/version`，用可选 Bearer 验证 Token 和受保护路由。

插件列表继续显示 MetaTube，但 `unconfigured` 时默认按钮与组合字段源选项禁用，并显示“配置服务端”主操作。清除配置时若 MetaTube 正被设为默认或组合引用，应阻止清除并列出引用，或由用户确认后原子切回有效默认；不能留下后台才发现的失效引用。

### 6.5 影片解析流程

```text
parseVideo(ctx)
  ├─ 未配置 → 本地错误（不发网络请求）
  ├─ GET /v1/movies/search?q={code}&fallback=true
  │    ├─ 404 → []
  │    └─ 校验 envelope / 搜索 DTO
  ├─ 受控番号等价过滤 + {provider,id} 去重
  ├─ 0 个精确项 → []
  ├─ 并发上限 4：GET /v1/movies/{provider}/{id}?lazy=true
  ├─ 校验详情 DTO并映射字段/图片代理 URL
  └─ 返回对象数组，交给 Javdex 现有候选确认
```

番号等价规则必须保守且可测试。建议：大写、Unicode NFKC、去首尾空白，然后只忽略 ASCII 空格、`-`、`_` 的差异；不得做前缀、包含或编辑距离匹配。匹配成功后返回原查询番号而不是上游变体，从而符合 Javdex 当前只做 `trim().toUpperCase()` 的精确过滤。

## 7. 安全、隐私与兼容风险

| 风险 | 影响 | 缓解/验收 |
|---|---|---|
| 公网 HTTP + Token | Token 与成人视频查询可被窃听/篡改 | HTTPS 默认推荐；公网 HTTP 二次确认；不支持跳过 TLS。 |
| Token 泄漏到插件/日志/重定向 | 凭证外泄 | Token 仅主进程 secret store；Worker 只发相对 path；同源 Authorization；日志脱敏。 |
| 用户地址指向恶意服务 | 恶意 JSON、大响应、内部网络访问、恶意图片 URL | 用户明确配置 origin；JSON schema/大小/数量/超时限制；所有持久化图片 URL重写为该服务的 `/v1/images`，不直接信任任意下载 host。 |
| 私网 URL 与 SSRF 策略冲突 | 过严会使自建服务不可用，过松会扩大攻击面 | 只允许用户保存的 origin；不让插件动态选择主机；IPC 仅设置页可修改。 |
| API v1 漂移 | 字段或 envelope 变化导致刮削失败 | 固定 v1 contract fixture；连接测试展示版本；未知字段容忍、已知字段严格；错误标记版本；跟踪官方 route/model 变更。 |
| 反向代理 path prefix | 错误 join 导致 `/v1` 404 | 单一 URL join helper；覆盖带/不带尾斜杠与 prefix 测试。 |
| 反向代理额外图片鉴权 | metadata 成功但图片暂存失败 | 首发只承诺 MetaTube 自带 Token；配置页写清 `/v1/images/*` 需可访问；错误分开提示。 |
| 原生图片路由公开、长期共享缓存且可代理任意 `url` | MetaTube Token 不能保护图片；共享缓存可能保留内容；公网服务还可能被滥用为服务端请求/资源消耗入口 | 这是由公开路由分组、180 天 shared-cache 配置、图片 `url` 参数和服务端 Fetch 调用推导出的风险（[路由](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/route.go#L42-L55)、[缓存](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/cache.go#L10-L14)、[处理](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/route/image.go#L82-L119)、[取图](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/engine/image.go#L78-L100)）；建议用户以防火墙/VPN/受控反向代理限制服务暴露，Javdex 只把该服务自身详情响应中的已校验 HTTP(S) 图片 URL 交回图片接口，并限制 URL 长度和样张数量。 |
| MetaTube 全源搜索耗时 | 单次刮削接近分钟，批量叠加 | 使用 `lazy=true`；详情并发上限 4；Javdex 75 秒/请求、5 分钟总限；保留批量 delay；不重复重试。 |
| 多 provider 同番号 | 自动取首项可能选错 | 返回全部精确候选，复用待确认中心；保留 MetaTube 排序。 |
| `actors` 无性别 | 男演员误归为女优 | 首发只声明 `actressesFemale` 并公开假设；不声明男演员；必要时产品选择取消该字段。 |
| `label` 与 `publisher` 非完全同义 | 发行方语义偏差 | 映射写入插件说明；用官方 fixture 与真实服务抽样验收；有争议时从 supportedFields 移除 `publisher`。 |
| 全局代理访问 LAN 服务 | 连接失败或绕路 | `useScrapeProxy` 独立开关，默认 direct；服务端对外抓取代理由 MetaTube 自己配置。 |
| 服务端缓存/隐私 | 用户查询和抓取结果可写入其 MetaTube DB | 配置页说明数据由用户指定服务端处理；Javdex 不向第三方默认实例发送。 |

## 8. 许可与维护状态

### 8.1 许可

`metatube-sdk-go` README 和 LICENSE 都是 Apache-2.0（[固定 README](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/README.md#L62-L64)、[固定 LICENSE](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/LICENSE#L1-L5)）。官方二进制发布仓库也声明为 Apache-2.0（[固定 LICENSE](https://github.com/metatube-community/metatube-server-releases/blob/70ebe74c7592a93825ee7a70c75ea06a3dabdb28/LICENSE#L1-L5)）。

推荐实现只重写 HTTP 客户端与 DTO，不复制或链接 Go 代码，也不分发 MetaTube 二进制；通常不会把 Javdex 变成其派生作品。仍应：

- 在内置插件主页/第三方说明中链接官方仓库和 Apache-2.0。
- 只做描述性使用 `MetaTube` 名称和来源说明；Apache-2.0 第 6 节不授予商标使用权，除描述作品来源所需的合理使用外（[固定 LICENSE](https://github.com/metatube-community/metatube-sdk-go/blob/6a5e6128c725187aeaf921d48ed7d9cd9f30671b/LICENSE#L138-L141)）。
- 不复制官方 Jellyfin 插件实现；其仓库是 MIT，但官方文档另列有非商业等附加使用说明（[固定文档源码](https://github.com/metatube-community/metatube-community.github.io/blob/d4d12af806619a91248b5d7d1abeb692a7ec1b80/docs/README_ZH.md#L82-L90)）。当前方案无需依赖或分发该插件代码。
- 各 metadata provider 的站点条款、内容权利与用户所在地法律不在 Apache 软件许可覆盖范围内；产品文档应保留用户自行合规的提示。

这不是法律意见；正式发布前可做一次依赖/商标合规复核。

### 8.2 维护状态

截至研究日：

- `metatube-sdk-go` 最新正式 tag 为 `v1.4.0`，对应 `c0e053f8c4ac58ebfb2794d52ed90640d9b1509b`，2026-03-19 打 tag（[官方 Tags](https://github.com/metatube-community/metatube-sdk-go/tags)）；SDK 仓库的 [Releases 页面](https://github.com/metatube-community/metatube-sdk-go/releases) 当前没有 Release 条目。
- 官方服务端二进制 `v1.4.0` 于 2026-03-23 发布并标为 latest（[官方 release](https://github.com/metatube-community/metatube-server-releases/releases/tag/v1.4.0)）。
- SDK 主分支在 release 后仍有 provider 修复、依赖升级和工作流维护，当前研究基线最新提交为 2026-07-12 的 [`6a5e612`](https://github.com/metatube-community/metatube-sdk-go/commit/6a5e6128c725187aeaf921d48ed7d9cd9f30671b)。因此项目仍有维护活动。

风险在于仓库没有一份可机器校验的 OpenAPI 文档，也没有在源码中声明 `/v1` 的向后兼容政策。Javdex 应以官方 `v1.4.0` 为最低验收基线，并用 route/model fixture 保护兼容；不要根据仓库名“SDK”假设 Go 类型就是长期 wire contract。

## 9. 完整执行计划

### Phase 0 — 固化上游契约与产品决策

1. 在实现 issue/PRD 中确认产品名称为“MetaTube（自定义服务端）”，无默认公共实例。
2. 确认首发是否接受“`actors` 统一按女优导入”。默认建议接受并在描述中披露；若不接受，移除 `actressesFemale` supportedField。
3. 确认 `label → publisher` 的语义映射；若产品更看重严格语义，可不声明 `publisher`。
4. 以 v1.4.0 固化最小 JSON fixtures：根响应、providers、DB version、电影搜索、电影详情、401、404、5xx、畸形 envelope。
5. 记录兼容基线：只承诺 `/v1` 与上述字段；未知字段忽略，必需字段缺失报 API 不兼容。

交付物：契约 fixture、字段映射决策、验收用自建服务信息（Token/无 Token 各一个）。

### Phase 1 — 服务配置、秘密与 IPC

1. 在 `src/shared/settingsTypes.ts` 增加非秘密 MetaTube 服务配置，并在 `DEFAULT_SETTINGS` 中默认空地址、无 Token、direct 访问。
2. 在 `src/main/settings/settingsStore.ts` 增加严格 normalize：trim URL、只允许 HTTP(S)、拒绝 credentials/query/fragment，不把 Token 纳入普通设置。
3. 新增 scraper service secret store，复用 `llmSecretStore.ts` 的 `safeStorage`、原子写和迁移错误模式；key 采用稳定 `serviceId=metatube`。
4. 在 shared IPC contract 增加：读取公开配置、更新配置、测试连接、清除 Token；renderer 只拿 `hasToken`。
5. 主进程实现 `MetaTubeConnectionTestService`，按 `/` → `/v1/providers` → `/v1/db/version` 执行，返回版本/provider 数量和结构化错误。
6. 对 Token 保存/清除、safeStorage unavailable、旧 settings 无字段、URL 规范化、401/404/超时写单测。

完成标准：应用重启后地址与 Token 可用；Token 不出现在 settings、IPC read、日志或测试快照中。

### Phase 2 — 受控服务 HTTP 客户端与沙箱桥

1. 实现 main-process `ConfiguredServiceHttpClient`：相对 path、同源、手动 redirect、Authorization 注入、proxy 开关、超时、body 上限、JSON envelope 解析与错误分类。
2. 拒绝跨 origin/HTTPS→HTTP 重定向；Authorization 只在最终确认同源后设置。
3. 给 bundled manifest parser 增加内置专用 `serviceId` / `requiresConfiguration` / editable/exportable 标志；用户包 normalize 不接受服务绑定。
4. 扩展 `SandboxWorkerData` 只传非秘密 base URL/serviceId；新增 `serviceGetJson` RPC。Token 由主进程在 RPC handler 内读取，绝不进入 Worker。
5. Worker 暴露 `ctx.service.getJson()` 与 `ctx.service.publicUrl()`；未绑定服务的普通插件没有该对象。
6. 更新 `docs/SCRAPER_PLUGIN_FORMAT.md`，明确该能力是受信内置插件专用，不是用户插件 API。
7. 写安全测试：恶意绝对 URL、`//evil`、路径穿越、跨域 redirect、降级 redirect、超大 body、慢响应、Token 日志脱敏、用户 manifest 伪造 `serviceId`。

完成标准：可信 MetaTube 插件能访问同源受保护 JSON；任意用户插件无法获取 Token或让主进程把 Token 发到另一 origin。

### Phase 3 — MetaTube 内置影片插件

1. 新增 `src/main/bundled-plugins/video/MetaTube/plugin.json`，声明推荐 supportedFields、官方 homepage、`serviceId: metatube`、requiresConfiguration。
2. 新增 `index.cjs`：
   - 规范化查询番号。
   - 调 `/v1/movies/search`；404 返回 `[]`。
   - 校验、精确等价过滤与 `{provider,id}` 去重。
   - 详情请求并发上限 4，保留搜索顺序。
   - 映射所有已确认字段；构造同源图片代理 URL。
   - 过滤空值、非法日期、非正或超过 10,080 分钟的 runtime、越界 score、非法 homepage/preview URL。
   - 多候选返回数组；单候选也可返回数组以保持一致。
3. 新增纯函数级测试覆盖：标准番号、分隔符差异、模糊结果拒绝、多个 provider、重复 provider/id、详情 404/5xx、字段空值、5 分制、分钟转秒、label 映射、样图 URL 编码、非法 URL、候选/样张上限。
4. 新增假服务集成测试：搜索 → 详情 → Javdex 精确候选 → 图片暂存 → pending scrape；验证 Token 只发往私有 JSON route。
5. 验证组合刮削：配置后可作为任一支持字段来源，未配置时不可选。

完成标准：Token/无 Token fixture 都能得到符合 `ScrapeResult` 的候选；模糊结果永不写入；多 provider 进入待确认。

### Phase 4 — 设置 UI 与可用性门禁

1. 扩展 `ScraperPluginDescriptor`：`requiresConfiguration`、`configured`、`configurationLabel`（不得含秘密）、可选 disabledReason。
2. MetaTube 插件卡显示：未配置/已配置、服务 host、Token 已设置与否、配置、测试连接；使用现有语义 token 和密集工具型样式。
3. 配置弹窗字段：服务端地址、Token（password，留空保持）、使用 Javdex 刮削代理、测试连接、保存/取消；公网 HTTP 显示显著但非阻塞的安全确认。
4. 所有入口统一门禁：设置默认、组合字段源、单片刮削、批量刮削、扫描后自动刮削。不要只在按钮层禁用，主进程运行前还要再次检查。
5. 处理清除配置与既有引用：列出默认/组合引用并要求原子修复，避免保存半失效状态。
6. 更新无障碍：label、错误关联、密码显隐、测试中状态、键盘焦点与 screen reader 文本。

完成标准：新用户看得到内置插件但不能误用；配置有效地址后无需重启即刻可选；配置丢失/清除不会启动网络任务。

### Phase 5 — 端到端 QA、文档与发布

1. 用官方 v1.4.0 Docker/二进制分别测试：
   - localhost HTTP、无 Token；
   - localhost/LAN HTTP、有 Token；
   - HTTPS 反向代理、有 Token；
   - 带 path prefix 的反向代理；
   - 错 Token、离线、慢服务、无 movie provider；
   - `/v1/images/*` 被额外代理鉴权时的清晰失败提示。
2. 抽样番号至少覆盖普通 JAV、FC2、无码日期型番号、多个 provider 同番号、无评分/无演员/无样张。
3. 验证单片、批量、组合、待确认、取消、重启恢复、代理开关和资产暂存。
4. 检查所有日志、异常、崩溃报告、pending `plugin_config_json` 都不含 Token；pending 只记录服务 host/版本/字段等非秘密审计信息。
5. 更新 README/CHANGELOG/插件格式文档：部署责任、HTTPS、Token、图片代理限制、演员性别假设、MetaTube 官方仓库与 Apache-2.0 链接。
6. 发布说明注明“不内置服务端、不提供公共服务、需要用户自建兼容 v1 服务”。

完成标准：上述矩阵通过；无高危凭证/跨域问题；升级现有用户 settings 无回归；没有配置 MetaTube 的用户不会产生任何网络请求。

## 10. 建议测试清单

### 单元测试

- `normalizeMetaTubeServerUrl`：尾斜杠、prefix、IPv4/IPv6、localhost、HTTPS、用户名密码、fragment、非法 scheme。
- `joinServiceUrl`：不能被 `/absolute`、`//host`、编码斜杠或 dot segment 换 origin。
- `equivalentVideoCode`：大小写/NFKC/空格/`-`/`_`；明确拒绝前缀、包含、编辑距离和数字不同。
- envelope/DTO：data、error、null、错误类型、未知字段、超大数组。
- mapping：所有字段、0/空值、非法日期、runtime × 60、score 边界和 1 位小数、演员去重、样图编码。
- secret store：保存、覆盖、留空保持、显式清除、加密不可用、原子写失败。
- descriptor availability：未配置、已配置、默认/组合门禁。

### HTTP/安全集成测试

- Tokenless 服务不要求 Token；Token 服务收到正确 Bearer。
- 401、404、429、500、HTML 错误页、断连、超时、body 超限。
- 同源 redirect 可按策略处理；跨域与 HTTPS 降级被拒绝且目标服务未收到 Authorization。
- `useScrapeProxy=false` 不走代理；true 才走现有刮削代理。
- 图片 URL 永远以配置 base origin 为主机，不把 Token拼入 URL。

### 业务集成测试

- 搜索只有模糊项 → 无结果。
- 一个精确项 → 单一 pending candidate/正常应用。
- 多 provider 精确项 → 顺序稳定、进入待确认。
- 详情候选部分失败 → 建议整次失败并保留上游错误，避免静默只剩错误 provider；若产品选择“部分成功”，必须生成显著 warning。
- 评分无 count 时仍可写 average。
- 样张任一暂存失败遵循 Javdex 现有整组放弃规则。
- 未配置状态从 UI、IPC、manager 三层都阻止执行。

## 11. 验收标准（Definition of Done）

- MetaTube 随应用显示为内置影片插件，初始未配置且不可使用。
- 用户配置有效自定义服务端 URL 后可用；Token 为空和 Bearer Token 两种服务均通过。
- Token 受系统安全存储保护，不出现在设置、渲染进程 read API、插件 Worker、URL、日志、pending 记录或导出包。
- 搜索只接受保守番号等价候选，多 provider 不自动选第一项。
- 推荐 supportedFields 的映射和图片暂存通过契约测试；不返回 `actressesMale` 与 `ratingCount`。
- `/v1` 不兼容、401、404、超时、离线和图片代理失败都能区分并给出可操作错误。
- 普通用户插件没有任意 header/secret 能力；跨 origin 不发送 Authorization。
- 现有 JavDB/JavLibrary、演员插件、用户插件、组合与批量刮削测试无回归。
- 文档清楚说明用户自行部署服务、HTTPS 建议、v1.4.0 基线、演员性别假设、额外反向代理图片鉴权不在首发支持范围。

## 12. 最终建议

按上述 Phase 0–5 实施。技术可行性不是问题，真正需要谨慎的是**配置/秘密边界和候选语义**：只要 Token 保留在主进程、服务调用被锁定到用户配置 origin、MetaTube 的相关性搜索在适配层再次做严格番号过滤，这个内置插件就能复用 Javdex 现有候选、字段、组合、批量和资产管线，并保持较小的上游耦合面。
