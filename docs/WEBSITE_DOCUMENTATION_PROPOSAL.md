# Javdex 官网文档站改造方案

调研与访问日期：2026-10-15。仓库基线：`dev` / `a7a8cc2`。用户已确认采用 Starlight 并执行，实施计划与本地验收见第 9 节；前八节保留选型依据。外部依据限于官方文档、维护者源码和发布包元数据；另查看了 Tauri 首页与 Immich 快速开始页的浏览器画面，用于理解导航和阅读布局，不构成完整视觉或无障碍审计。

## 1. 初步结论与现有约束

当前方案方向为 **Astro Starlight 优先**：文档导航与本地全文搜索已有默认实现，既能承载阅读型文档，也能把现有产品介绍保留为独立页面。主要代价是引入 Astro、适配既有 Markdown，以及跟随仍处于 0.x 的 Starlight 升级。**VitePress 稳定版是备选**，尤其适合优先直接复用 Markdown 的路线，但中文分词需要单独落实。确需同时维护多个软件版本文档时，再评估 **Docusaurus**；**Fumadocs** 更适合需要深度 React 定制的文档产品，当前需求不足以抵消其宿主框架与静态导出配置成本。以上排序是基于下文事实的判断，不是性能实测排名。

仓库对方案的约束：

- 当前官网是 `website/` 内的 HTML、CSS、JavaScript；产品代码使用 React，并不意味着官网已有可直接迁移的 React 页面。[官网说明](../website/README.md)、[依赖与工作区](../package.json)。
- 既有地址是 `https://javdexlabs.github.io/Javdex/`；部署应继续支持大小写一致的 `/Javdex/` 子路径。现有 Pages 工作流使用 Node 22、发布 `dist-pages`，尚无依赖安装步骤，且只监听部分文档素材。[页面源文件](../website/index.html)、[Pages 工作流](../.github/workflows/pages.yml)。
- 六个下载入口由最新实际正式 Release 生成，保留 `release.json`、发布事件重建和 CI 缺包失败的合同。现有浏览器脚本通过 `./release.json` 取清单，产品页改到子目录后必须重新处理其地址；不能用 `package.json` 版本替代正式发布状态。[构建脚本](../website/scripts/build.mjs)、[浏览器脚本](../website/app.js)。
- 当前 `docs/` 有 206 篇 Markdown，其中 `performance/` 102 篇、`adr/` 31 篇、`reviews/` 10 篇；这些工程材料不应自动成为用户文档侧栏与搜索结果。首期建议整理约 20–30 篇任务型页面，而不是发布整个目录。
- 本地版本已准备为 0.9.0，不等于正式 Release 已发布。文档适用版本和实际下载版本须分开判断；站点改造不应触发软件发布或覆盖历史资产。

## 2. 成熟开源项目可以借鉴什么

| 项目与第一方证据 | 观察到的组织方式 | 对 Javdex 的启发（设计判断） |
| --- | --- | --- |
| [Jellyfin 文档](https://jellyfin.org/docs/)；其[官网仓库依赖](https://github.com/jellyfin/jellyfin.org/blob/master/package.json)声明 Docusaurus | 入口区分安装、安装后配置、管理、服务端、客户端和贡献；安装继续按平台展开 | 把“安装并开始使用”和“管理服务端”分开，让桌面用户先找到自己的路径 |
| [Immich 快速开始](https://docs.immich.app/overview/quick-start/)；其[文档包](https://github.com/immich-app/immich/blob/main/docs/package.json)声明 Docusaurus | 文档首页落到 Quick start，侧栏区分 Install、Features、Administration、Developer、Guides、FAQ；另有产品官网入口 | 文档入口直接帮助用户完成首次使用，功能介绍和详细参考分别承担自己的职责 |
| [Tauri v2 官网](https://v2.tauri.app/)；其[依赖](https://github.com/tauri-apps/tauri-docs/blob/v2/package.json)与[配置](https://github.com/tauri-apps/tauri-docs/blob/v2/astro.config.mjs)明确使用 Astro Starlight | 顶层分 Guides、References、Blog、Releases；产品介绍与开始入口共存，并链接独立 v1 文档站 | 用任务指南与参考资料两条阅读路径组织内容；产品页可以继续保留。独立旧版站是其发布策略，不能推导出 Starlight 内建版本快照 |

这些实例证明了组织方式和实际采用的工具；不能据此宣称某框架中文搜索更好、速度更快或部署到 Javdex 后即可正常工作。

## 3. 四个候选框架比较

### 静态托管、中文搜索与内容复用

| 候选 | GitHub Pages `/Javdex/` | 中文本地全文搜索 | 既有 Markdown 复用 |
| --- | --- | --- | --- |
| VitePress | 静态构建，设置 `base: '/Javdex/'`；可沿用 Pages Actions。[稳定版部署](https://vuejs.github.io/vitepress/v1/guide/deploy) | 内建 MiniSearch 本地索引；支持 `miniSearch.options.tokenize`。MiniSearch 默认按空白和标点切词，因此中文界面翻译不等于中文分词已解决；建议验证统一的中文 tokenizer 或另接 Pagefind。[稳定版搜索](https://vuejs.github.io/vitepress/v1/reference/default-theme-search)、[MiniSearch 维护者说明](https://github.com/lucaong/minisearch#tokenization) | 原生 `.md`，有 `<!--@include: ... -->` 内容包含功能。适合从既有资料组合站点页面，但仍需核对链接、图片、标题层级与路由。[Markdown 包含](https://vuejs.github.io/vitepress/v1/guide/markdown#importing-markdown-files) |
| Astro Starlight | 静态输出；配置 `site` 和 `base: '/Javdex'`。手写站内链接仍须处理 base。[Astro Pages 部署](https://docs.astro.build/en/guides/deploy/github/) | 默认集成 Pagefind。Pagefind 对中文有专用分词，但需 extended 发行包并正确标记 `zh-*` 页面语言；应核对实际安装产物，而不是只验证搜索框出现。[Starlight 搜索](https://starlight.astro.build/guides/site-search/)、[Pagefind 中文分词](https://pagefind.app/docs/multilingual/#specialized-languages) | 支持 Markdown/MDX 内容页；每页要求 `title` frontmatter。现有无 frontmatter 的文档不能无适配整目录接入，宜通过发布映射生成带元数据的站点内容。[页面](https://starlight.astro.build/guides/pages/)、[标题要求](https://starlight.astro.build/reference/frontmatter/#title-required) |
| Docusaurus | 输出静态文件；配置 `url`、`baseUrl: '/Javdex/'`，明确尾斜杠策略。[部署](https://docusaurus.io/docs/deployment) | 官方首选集成 Algolia；本地搜索由社区维护。可选 `@easyops-cn/docusaurus-search-local`，其维护者明确支持 `language: ['en', 'zh']` 与中文词典，需承担插件兼容性验证。[官方搜索边界](https://docusaurus.io/docs/search)、[插件源码与用法](https://github.com/easyops-cn/docusaurus-search-local) | 支持 Markdown/MDX；默认连 `.md` 也按 MDX 处理。官方提供 `markdown.format: 'detect'` 区分两者，但 CommonMark 支持仍标为实验性；需先抽查现有 HTML、尖括号和花括号语法。[Markdown 格式](https://docusaurus.io/docs/markdown-features#mdx-vs-commonmark) |
| Fumadocs | 本文以 Next.js 路线评估：显式 `output: 'export'`、`basePath: '/Javdex'`，生成动态文档路由的静态参数，处理尾斜杠及静态图片约束。它也支持其他 React 宿主，不能把 Next.js 当成唯一选择。[静态构建](https://www.fumadocs.dev/docs/deploying/static)、[Next.js basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)、[静态导出约束](https://nextjs.org/docs/app/guides/static-exports) | 当前内置搜索使用 ZBSearch，官方说明默认 multilingual 分词支持中文。纯静态模式须导出搜索索引（`staticGET`），并切换静态搜索客户端；浏览器需下载索引。[当前搜索说明](https://www.fumadocs.dev/docs/headless/search/orama) | Fumadocs MDX 可编译 `.md`/`.mdx`，支持集合及内容包含；需接内容源、页面树和 React 页面。[内容源](https://www.fumadocs.dev/docs/mdx)、[包含功能源码](https://github.com/fuma-nama/fumadocs/blob/main/apps/docs/content/docs/mdx/include.mdx) |

Fumadocs 搜索文档 URL 仍包含 `orama`，但本次访问正文及稳定包依赖已为 ZBSearch；不应沿用旧资料中“默认搜索不支持中文”的结论。四者均有纯静态路线，均不需要为线上文档运行 Javdex 服务端；构建阶段仍依赖 Node 与各自工具链。

### 产品页、技术栈与版本维护

| 候选 | 保留现有产品页与 React/Vue 关系 | 版本管理及构建维护代价（定性判断） |
| --- | --- | --- |
| VitePress | 内建 Home 页面、主题扩展和 `layout: false`；深度定制走 Vue。可以改造现有 HTML/CSS，但需管理全局样式、导航生命周期与脚本初始化。[布局](https://vuejs.github.io/vitepress/v1/reference/default-theme-layout) | Vite/Vue 工具链；发布多个版本需要自行约定目录、导航或多次构建，不能把导航下拉当成版本快照能力。[路由](https://vuejs.github.io/vitepress/v1/guide/routing)、[CLI](https://vuejs.github.io/vitepress/v1/reference/cli) |
| Astro Starlight | `template: splash` 或独立 `.astro`/HTML 路由可承载产品页；不强制加入 React/Vue。需要 React 交互时可另加官方集成。[页面](https://starlight.astro.build/guides/pages/)、[splash](https://starlight.astro.build/reference/frontmatter/#template)、[React 集成](https://docs.astro.build/en/guides/integrations-guide/react/) | Astro 以静态 HTML 与按需交互为设计基础，但 Starlight 搜索等仍有客户端 JavaScript；不是“零 JS”承诺。多版本可用社区 `starlight-versions` 或独立构建，增加维护面。[架构](https://docs.astro.build/en/concepts/islands/)、[官方插件目录](https://starlight.astro.build/resources/plugins/#community-plugins) |
| Docusaurus | 自定义产品页用 React，符合现有 React 经验；官网原始 HTML 仍需迁移为组件或独立静态页面。[自定义页面](https://docusaurus.io/docs/creating-pages) | 内建版本命令会复制文档与侧栏，适合多条维护线；也意味着旧版内容维护量增加。需维护 React、主题、插件及客户端运行代码。[版本机制](https://docusaurus.io/docs/versioning) |
| Fumadocs | React 布局组件自由度高，`HomeLayout` 可共享导航与搜索。适合交互丰富的站点，但自由度意味着更多页面和内容源代码。[HomeLayout](https://www.fumadocs.dev/docs/ui/layouts/home-layout) | 可按版本文件夹与 root type 组织，或独立部署整站版本；并非 Docusaurus 式自动快照。Next.js 路线还需持续核对服务端功能是否满足静态导出要求。[版本组织](https://www.fumadocs.dev/docs/navigation#versioning) |

没有安装候选项目或测量产物，因此不提供包体积、构建耗时或“最快/最轻”的数值排序。

### Node 与发布渠道核对

| 调研时的发布线 | 已核实要求与 Javdex 的关系 |
| --- | --- |
| VitePress `1.6.4` | 稳定版文档要求 Node 18+；Javdex 的 Node 22 可覆盖该门槛。官网主入口当前展示 `2.0.0-alpha.20`，本次以独立的 **v1 稳定文档**为准，不混用 alpha 的 Node 要求或功能。[稳定入门](https://vuejs.github.io/vitepress/v1/guide/getting-started)、[发布包](https://registry.npmjs.org/vitepress/1.6.4) |
| Starlight `0.42.6` / Astro `7.3.8` | Starlight 的 Astro peer 为 `^7.2.10`，Astro 要求 Node `>=22.12.0`；不能只写“Node 22 任意小版本”。Starlight 虽为 npm 默认发布渠道，官方仍称其为 beta，需锁定版本并审核升级。[Starlight 发布包](https://registry.npmjs.org/@astrojs/starlight/0.42.6)、[Astro 发布包](https://registry.npmjs.org/astro/7.3.8)、[官方更新说明](https://starlight.astro.build/getting-started/#updating-starlight) |
| Docusaurus `3.10.2` | Node 20+；支持 React 18 或 19，已有 React 18 经验可延续。[安装要求](https://docusaurus.io/docs/installation)、[发布包](https://registry.npmjs.org/@docusaurus/core/3.10.2) |
| Fumadocs Core/UI `16.17.3`，以 Next.js `16.4.1` 为宿主 | Next.js 自身要求 Node `>=20.9.0`；Fumadocs 当前声明 Next 16、React `^19.2.0`。这不是对全部间接依赖最低 Node 的证明；若采用，建议网站使用独立依赖边界和经锁文件验证的 Node 22 环境，避免牵动应用 React 18。[Core 发布包](https://registry.npmjs.org/fumadocs-core/16.17.3)、[UI 发布包](https://registry.npmjs.org/fumadocs-ui/16.17.3)、[Next.js 发布包](https://registry.npmjs.org/next/16.4.1) |

这里记录的是访问日的发布包与宿主门槛，实施前应重新锁定兼容组合；不建议仅因文档站需求升级整个应用运行环境。

## 4. 推荐信息架构与页面设计

建议根路径改为文档门户，现有官网成为 `/product/` 产品介绍页，下载独立为 `/download/`。以下路径均相对当前站点前缀 `/Javdex/`，不是更换域名，也不是部署到域名根路径。

```text
/                       文档门户：搜索 + 按任务开始
├── product/            产品介绍：现有文案、真实截图与能力边界
├── download/           正式版下载：桌面、服务端、源码与校验
├── start/              安装 → 选择本地/远程 → 第一个媒体库
├── guide/              扫描、刮削、整理、清单、播放、AI、备份
├── server/             Docker 部署、挂载权限、连接授权、更新与恢复
├── reference/          NFO/STRM、配置说明、兼容性与数据位置
├── developers/         从源码运行、构建、插件开发与贡献
├── releases/           更新日志、升级说明与重大变化
└── help/               按症状排障、FAQ、反馈问题
```

顶栏只保留“使用指南、服务端、开发、下载”，另有产品介绍、搜索、主题和 GitHub 入口；不把每个侧栏分组都做成顶层菜单。文档页的左侧目录承载细分任务。

### 文档门户

首页不再重复完整营销长页，也不直接打开长达数百行的使用指南。主区域是一句产品说明、搜索和三个清晰入口：

1. **在这台电脑使用**：下载 → 创建媒体库 → 扫描 → 补齐资料 → 播放。
2. **部署到 NAS / 服务端**：部署条件 → 单容器与挂载 → 首次配对 → 远程管理。
3. **升级已有安装**：选择原版本 → 完整备份 → 桌面/服务端升级 → 核对与恢复。

下面提供高频任务，例如配置刮削来源、导入 NFO、管理本地模型、解决待确认资源和恢复备份。首次路径先完成基础功能，不把 AI 配置列为开始使用的必经步骤。

### 文档正文与交互

- 桌面采用左侧导航、中央正文、右侧页内目录；手机折叠侧栏，页内目录在正文顶部展开，避免三栏挤压。
- 保留面包屑、上一页/下一页、编辑此页、问题反馈。适用版本写在内容元数据中；“最近修改”不能冒充“已在该版本验证”。
- 安装命令、文件路径与配置提供复制；系统差异使用平台标签，关键步骤使用编号。升级、写权限、删除与恢复的风险提示紧邻操作，不藏在页尾 FAQ。
- 页面明确区分“本机独立数据”“远程资料库”“浏览器能力”，特别是本机续播、最近播放、模型执行与服务端不转码的边界，不能照搬 Jellyfin 的功能承诺。
- 保留真实软件截图；沿用当前网站浅中性色、蓝色强调及品牌图标，补齐深色主题。网站 token 与[界面设计原则](UI_DESIGN_GUIDELINES.md)语义一致，但不导入桌面整份 CSS。
- 产品页保留宽幅叙事、截图和下载按钮，不显示文档侧栏；共享顶栏与页脚。迁移为站点布局，不长期用 iframe 嵌旧网页，也不让旧全局样式污染文档正文。

### 下载中心

普通用户先选 Windows、macOS 或 Linux，再选架构和安装方式；保留现有六种桌面产物，不因改站删减发行包。服务端区分别说明 Docker 首次部署和两个架构的 `.javdex-update` 后续升级文件。总播放源码包与 SHA256 校验放在“源码与校验”次级区域，普通安装步骤不要求下载。

产品页、下载中心和文档中的版本卡片都消费同一份构建期生成的 Release 清单。扩展清单时明确 schema 或可选字段，不为每个页面再写一套文件名匹配。对于历史正式版不存在的新格式，显示“不适用”或引导对应版本说明，不能虚构升级文件。

## 5. 内容来源与维护边界

### 单一正文来源

建议迁移后的公开文档正文以 `website/src/content/docs/` 为唯一维护位置，普通说明优先 `.md`，确需组件才用 `.mdx`。在 native Starlight 内容结构上补少量元数据（标题、适用范围、适用版本、导航顺序），避免长期维护自制 Markdown 切段/转换平台。使用 `website/src/pages/` 承载独立产品和下载页面。

只迁移明确选中的内容；`docs/` 继续承载架构、合同、评审、性能记录与历史材料，不因网站迁移删除工程证据。迁移中逐页转移正文并更新引用，已迁移的旧文件改为短入口/索引，必要时保留旧章节标题作为链接入口，不并行维护两份完整指南。同步修改根 README、DEVELOPMENT 索引及 AGENTS 的文档职责说明。

| 现有来源 | 迁移方向 | 需要保持的职责 |
| --- | --- | --- |
| [USER_GUIDE.md](USER_GUIDE.md) | `start/`、`guide/`、`help/` | 按单个任务拆分；首次使用只给最短可行路径 |
| [SERVER_MODE.md](SERVER_MODE.md)、[SERVER_UPDATE.md](SERVER_UPDATE.md) | `server/` | 部署、配对、升级/中断、备份与人工恢复不能省略 |
| [METATUBE_SETUP.md](METATUBE_SETUP.md)、[NFO_COMPATIBILITY.md](NFO_COMPATIBILITY.md) | `guide/`、`reference/` | 用户操作与格式/兼容限制分开呈现，互相链接 |
| [DEVELOPMENT.md](DEVELOPMENT.md)、[SCRAPER_PLUGIN_FORMAT.md](SCRAPER_PLUGIN_FORMAT.md) | `developers/` 的公开部分 | 工程运行/插件说明可发布；内部验收档案留在仓库 |
| [CHANGELOG.md](../CHANGELOG.md)、正式版发布说明 | `releases/` | 从原始记录生成索引或直接链接，不再手抄一份更新日志 |
| `performance/`、`reviews/`、`adr/`、`archive/` | 保持仓库材料 | 不自动复制或索引；有公开价值时另写面向读者的说明 |

每页应回答：适用于谁、需要什么、如何操作、如何判断成功、失败去哪处理。功能开发完成时同步改对应任务页，而不是往 README 追加实现日志。

### 版本与语言

首期只维护简体中文与一套当前正式版文档，预留未来语言路由，不生成空的英文镜像。历史版本保留发布说明和升级指南；只有确需并行维护不兼容版本时才增加完整版本快照，不为每个 patch 或 Beta 复制全站。

现阶段 0.9.0 文档与实际已发布的下载可能不同步：新站适合在 0.9.0 正式发布后切换；若提前上线，必须用可见的待发布提示区分 0.9.0 功能与实际下载版本。生产文档适用版本由独立配置与发布清单核对，不读取应用 `package.json` 就宣称“当前正式版”。Release API 不可用时，CI 保持失败而非悄悄部署错误版本；本地预览可用离线兜底。

## 6. 技术落地与迁移顺序

网站保持同仓库、独立依赖与构建边界，可作为 npm workspace 接入根命令；不导入 Electron、数据库或应用运行代码。不需要新增线上 Node 服务、数据库、CMS、账号系统或搜索服务。Astro 静态输出仍交付 `dist-pages`，保留现有 Pages 部署环境。

建议只新增三个小职责：内容与导航配置、Release 清单生成器、下载展示组件。文档主体由 Starlight 负责，不自写路由、搜索框、侧栏框架。依赖采用经验证的兼容组合和锁文件；Starlight 0.x/beta 升级单独评审，不自动跟随框架大版本。

| 阶段 | 工作范围 | 进入下一阶段的条件 |
| --- | --- | --- |
| 1. 内容清单与小样 | 确定 URL 映射；用开始使用、服务端更新、本地模型三类实际内容验证 Starlight | 中文搜索、MD/图片转换、深层路由刷新及 `/Javdex/` base 通过；未通过先修正或评估 VitePress |
| 2. 用户文档迁移 | 建门户，拆分首批约 20–30 篇任务页；整理侧栏与交叉链接 | 本地开始使用、NAS 部署、0.8→0.9 升级三条阅读路径均有闭环，关键警告与能力边界保留 |
| 3. 产品与下载整合 | 产品页迁到 `/product/`，统一下载中心、Release 清单、品牌导航与元信息 | 六桌面入口及可适用的服务端/源码链接均来自实际 Release，产品页和文档不重复维护下载规则 |
| 4. 部署切换与回归 | 增加网站依赖安装、文档及锁文件触发；校验并切换 Pages | 下列验收通过，线上抽查完成；仅部署网站，不额外触发软件 Release 或覆盖资产 |

### 旧地址与部署

- 保持现有域名与 `/Javdex/` 大小写；页面、资源、搜索索引和 `release.json` 通过统一 base-aware URL 帮助函数引用，避免 `/product/` 下的 `./release.json` 404。
- 根地址的 `#download` 映射到下载页，`#product`、`#workflow`、`#nfo` 映射到产品页相应章节。片段不发送给服务器，采用页面端显式映射并保留无 JavaScript 可见的导航入口，不能假称服务器 301 已处理。
- 普通旧路径使用静态跳转页/提示链接和明确映射。更新 canonical、站点地图、社交卡片和 README 入口；GitHub 源文件链接不等于站内页面链接，分别校验。
- 保留 Pages 对正式发布的重建；文档内容、网站配置、依赖锁文件和引用素材的变化也必须触发。网站 CI 增加必要依赖安装与独立检查，不运行 Electron rebuild、截图采集或桌面打包。
- 切换失败可重新部署前一版网站产物或对应源码；不为回退文档修改软件标签、Release 资产或用户数据。

## 7. 验收与非目标

1. 中文搜索：查询“刮削、待确认、最近播放、备份恢复、字幕、模型下载、NFO、MetaTube、Docker、.javdex-update”，检查标题/正文/锚点命中；“千问/Qwen”等常见别称要有可搜索的正文提示。不承诺拼音或自动繁简转换。网络检查确认查询不发给外部搜索服务。
2. 内容可信：逐条核对三条首次/升级路径、平台差异、版本标识及恢复警告；评审和性能档案不出现在站点搜索结果。
3. 链接完整：内部页面、章节、图片、README 来源链接、旧锚点和新路径均有检查；直接访问并刷新深层 URL 正常，404 页可以回到首页或搜索。
4. 交互可用：桌面与手机无横向溢出；浅深主题、键盘焦点、搜索关闭后焦点恢复、平台标签、代码复制、无结果提示和图片说明可用。
5. 发布一致：文档适用版本、下载显示版本及实际 Release 来源明确；清单缺包继续阻断 CI。Beta 不被误选为默认正式版，不能把构建成功当成线上已更新。
6. 维护隔离：只改一处正文即可更新站点；只改网站文档不需构建桌面/服务端；依赖锁定与受控升级可复现。

首期不做 AI 问答、在线 CMS、多版本全量快照、多语言全文翻译或全套 API 自动文档。优先使用户能找得到、读得懂、按步骤完成任务。

## 8. 已确认的范围

建议按“Starlight + 文档门户 + 独立产品页/下载页 + 简体中文当前版 + GitHub Pages”推进，先完成阶段 1 再批量迁移。主要取舍是是否接受 Starlight 官方仍称 beta 的维护状态；若坚持仅用 1.x 稳定文档框架，则改选 VitePress 1.x 并验证中文分词，不需要改变上述信息架构。

## 9. 执行计划与本地验收（2026-10-15）

1. 接入 Starlight：精确锁定 Starlight 0.42.6、Astro 7.3.8，独立网站工作区，使用中文界面、Pagefind、主题、显式导航与当前位置。
2. 迁移内容：34 篇公开文档，覆盖本机开始使用、远程部署、升级恢复及功能/参考/开发入口；保留五份旧文档的章节索引，正文只在网站内容目录维护。工程档案不复制到站点。
3. 整合产品与下载：原官网主体和截图交互迁入 `/product/`，CSS 限制在产品区域；`/download/` 统一消费正式 Release 清单，保留六桌面入口与按版本适用的升级/源码/校验材料。
4. 验证与交付：Pages 安装网站依赖后构建，另增 PR/dev 离线验证；均不触发软件发行。上线需另行提交、推送并通过远程 Pages 部署，当前没有执行这些外部写入。

本地已通过：

- `pages:test`：13 项测试，覆盖正式版选择、历史正式版、缺包、混入其他版本、重复/非法资产、离线/失败、导航与旧文档源链接。
- 在线及离线构建：生成 38 个 HTML 页面（含三个定制页、34 篇文档与 404）；生成简体中文搜索索引，产品页和 404 不进入搜索。
- 站内页面、图片、资源和章节锚点检查；构建时同时检查 `/Javdex/` base、语言、站点地图、静态标记和工程材料排除。
- 在独立临时目录使用锁文件仅安装网站依赖，完成离线构建；不依赖原工作区的 Electron 或其他应用构建产物。
- 应用 `typecheck`、完整 `pretest`（含工作区/模块边界、TypeScript/CSS lint、CSS 架构与 UI 控件检查）通过；界面验证使用本地预览，不接触正常应用用户资料。
- 浏览器验证：中文“刮削”“备份恢复”“最近播放”“模型下载”和 `.javdex-update` 检索命中；无结果中文反馈、命令复制成功、搜索关闭焦点返回、深浅主题、390px 窄屏正文、目录展开、产品截图切换、预览与 Escape 焦点返回，以及旧 `#download` 跳转均已检查。
- 实际正式清单读取到 v0.8.0、六个桌面包；文档适用 0.9.0 时显示版本差异，不伪造 0.9.0 已发布或对应新格式升级包。

构建中定位并修正了工作区 Cookie 解析冲突：Astro 直接导入其 Cookie 2 正常，而预渲染产物中的裸 `cookie` 导入解析到应用的旧版。仅在网站 Vite 配置中定位 Astro 的正确实现；没有升级应用 Cookie 使用方。真实静态构建及独立安装构建均已回归通过。

已知工具链提示：Starlight 缺省 404 会产生一次找不到可选 `docs/404` 的框架警告，但实际 404 已生成且链接检查通过。npm audit 当前报告 13 条告警（含 3 high、10 moderate），锁文件包含现有应用依赖与新增构建依赖；网站独立安装也涉及其中的 YAML、图片、HTTP 缓存和 CSS 解析工具。没有执行 `npm audit fix --force` 或升级应用 Sharp。生产部署仅上传静态 HTML/JS/CSS/搜索索引，不运行这些 Node 解析器或共享缓存服务；这不等于依赖告警已经修复，后续应单独安排经验证的工具链更新。

当前改动仍在 `dev` 工作区；未提交、推送、发布软件版本或部署线上网站。
