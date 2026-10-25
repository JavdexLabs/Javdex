# Javdex 官网与文档站

Astro Starlight 站点，独立工作区 `@javdex/website`。站点根路径是文档门户；原官网迁到 `/product/`，安装包与服务端升级统一在 `/download/`。GitHub Pages 继续使用 `https://javdexlabs.github.io/Javdex/`。

## 安装、构建与预览

从仓库根目录运行，使用 Node 22.12+。只改网站时无需安装或重建 Electron：

```sh
npm ci --workspace @javdex/website --include-workspace-root=false
npm run pages:test
npm run pages:build:offline
npm run pages:preview
```

打开 `http://127.0.0.1:4319/Javdex/`。预览命令只服务已生成产物；修改后重新构建，或使用 `npm run pages:dev` 热更新。正式清单构建使用 `npm run pages:build`，构建结束自动执行 `pages:check`，也可单独运行该检查。

离线清单不虚构版本、发布日期或资产；下载按钮回到 GitHub 正式 Release。离线验证不等于最新正式下载或线上部署已验收。Starlight、Astro 直接依赖精确锁定，升级应单独验证。Astro 的 Cookie 2 在网站构建中独立解析，不能通过升级应用的旧 Cookie 使用方来解决网站依赖问题。

## 内容与页面

- `src/content/docs/`：公开文档唯一正文来源，普通页面用 Markdown 与标题 frontmatter；仅这里的内容生成文档与搜索。
- `src/pages/`：门户、产品、下载等定制页面，共用 Starlight 顶栏、搜索和主题。
- `src/components/ProductContent.html`：原产品页主体；`src/styles/product.css` 通过 CSS scope 限制在产品页，交互位于 `src/scripts/product.js`。
- `site.config.mjs`：站点前缀、文档适用版本、显式导航与旧首页锚点映射。
- `assets/screenshots/`：真实软件截图；只复制最终截图，不发布 artwork 原图。
- `docs/` 中性能、评审、ADR 与历史材料不复制到网站。

`docs/USER_GUIDE.md`、`SERVER_MODE.md`、`SERVER_UPDATE.md`、`METATUBE_SETUP.md`、`NFO_COMPATIBILITY.md` 保留旧章节与源码链接索引，更新正文应改网站对应页面。更新日志、插件产物规范与工程开发合同继续在仓库单独维护，网站只提供入口。不要复制第二份完整正文。

新页面需显式加入 `site.config.mjs` 导航。站内链接保留 `/Javdex/` 前缀；Astro 页面通过 `sitePath()` 生成地址。直接刷新深层页面必须可用，不能依赖开发服务器的 SPA fallback。文档页显示中文页内目录，移动端折叠导航；搜索索引由构建后的 Pagefind 生成，开发预览的搜索能力以构建产物为准。

## 正式版下载与版本提示

`scripts/release.mjs` 在构建时读取 GitHub `releases/latest`；拒绝 draft、prerelease 和带预发布后缀的版本。CI 网络错误、缺桌面包及新版本缺升级材料均使构建失败，不从 `package.json` 推测已发布版本。

同一份 schema 1 清单写入生成目录与公开 `release.json`：保留六桌面 `downloads`，通过可选 `extras` 提供两个 `.javdex-update`、一份播放总源码与 SHA256SUMS。历史正式版未提供新格式时不捏造链接。产品页不另写下载匹配逻辑，统一跳转下载中心。

`contentVersion` 表示文档适用版本；清单是实际下载版本。不一致或离线时显示明显提示。更新到新的正式版文档时修改内容与适用版本配置，不能因为改了应用版本就隐去提示。

## 旧地址与部署

旧根页 `#download` 跳到下载中心，`#product`、`#workflow`、`#nfo` 跳到产品页对应章节；不支持脚本时，首页仍保留可见链接。片段不发送到服务器，这不是 HTTP 301。

`.github/workflows/website.yml` 对 PR 和 dev 网站改动做离线验证，不部署。`.github/workflows/pages.yml` 从默认分支读取内容，安装网站依赖、核验清单、构建并部署 `dist-pages/`；正式 Release 和成功的 Release 工作流仍可触发重建。不修改软件标签、Release 附件或镜像。回退网站通过重新部署旧提交，不回退业务数据库。

## 产品截图与素材

截图全部来自应用真实渲染，演示人物、影片与封面为虚构资料。截图生成与网站构建分开，普通改文档不要启动 Electron 或读取用户资料。

```sh
npm run build
node website/scripts/capture.mjs
python website/scripts/optimize-assets.py
```

截图脚本仅使用 `output/playwright/website-product-profile` 隔离目录。README 配图使用 `capture.mjs --readme` 与 `optimize-assets.py --readme`，写入 `docs/images/`；网站截图写入 `assets/screenshots/`。压缩需要 Pillow，不在网站构建时安装。

仓库分享预览图使用 `node website/scripts/capture.mjs --social` 与 `node website/scripts/social-preview.mjs`：在上述隔离目录的 `social/` 子目录生成虚构演示库，用官方图标和真实应用截图排版，输出 `docs/images/social-preview.png`（1280×640、小于 1 MB）及 `out/marketing/` 中的高清原图。上传仓库 Social preview 是独立操作，生成文件不会修改 GitHub 设置。

保留 `assets/LUCIDE-LICENSE.txt` 与平台图标的许可/声明；品牌图标由 `build/icon-1024.png` 缩小生成。封面和背景来源见 `assets/artwork/README.md`，原始素材不进入发布站点。

## 验证边界

`pages:test` 检查下载清单、正式版选择、缺包、离线与旧地址合同；`pages:check` 核对构建 HTML 的本地页面、图片、章节锚点、中文语言、索引、站点地图与公开范围。浏览器还需检查中文搜索、键盘焦点、代码复制、产品页切换/截图预览，以及桌面、窄屏、深浅主题。构建成功不等于线上已更新，页面验收不等于应用播放器/硬件解码验收。
