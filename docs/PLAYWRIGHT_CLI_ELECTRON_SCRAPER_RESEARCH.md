# `@playwright/cli` 复用 Electron 刮削窗口方案研究

> 调研日期：2026-08-21
>
> 实测环境：Javdex `Electron 43.4.1 / Chromium 150.0.7871.224`；`@playwright/cli 0.1.18 / playwright-core 1.63.0-alpha-2026-08-05`；补充验证 `playwright 1.62.1` 内置 CLI。
>
> 目标：复用 Javdex 已有 Electron 刮削窗口和 `persist:scraper` 会话，获得 Playwright CLI 的 ARIA snapshot/ref/交互能力，同时不下载另一套 Chromium。

## 结论

**协议上可行，且“不下载另一套浏览器”可以实现。**`playwright-cli attach --cdp=http://127.0.0.1:<port>` 能控制已经运行的 Electron renderer；本地 PoC 已成功完成 snapshot、find、click、eval、reload 和 detach。Playwright 官方也把 CDP endpoint 列为 Electron app 的连接方式。[Playwright 连接现有浏览器](https://github.com/microsoft/playwright.dev/blob/main/mcp/configuration/browser-extension.mdx#connect-via-cdp-endpoint) · [CLI attach](https://github.com/microsoft/playwright-cli/blob/ca196c297169a494ee5517584883eada60dc8d0e/skills/playwright-cli/references/session-management.md#attach-via-cdp-endpoint)

但**不建议在 Javdex 当前主 Electron 进程上永久打开 CDP，然后把原始 CLI 交给 Agent**。原因不是功能，而是边界：remote debugging 是进程级入口，同一端点同时暴露主 UI 和刮削窗口；CLI 只支持 tab index，不能按 Electron `TargetID` 锁定窗口；不同 attach 中默认 tab 还会变化。

推荐生产拓扑是：

```text
Pi Agent
   │ 受限 browser wrapper / Skill
   ▼
Playwright adapter
   │ CDP，loopback 固定随机端口
   ▼
独立 Electron scraper helper 进程
   ├─ 只创建一个刮削 BrowserWindow
   ├─ 独占持久 scraper profile
   ├─ 保留 Cloudflare 可见接管
   └─ 不包含 Javdex 主 UI renderer
```

这个 helper 仍使用 Javdex 已打包的 Electron/Chromium，不下载新浏览器；变化只是把现有刮削 `BrowserWindow` 的所有权从主进程移到专用 Electron 进程。

如果先做低成本实验，可以在开发开关下让 CLI 接当前主进程，但必须由宿主私下绑定 target、禁止 tab/storage/run-code 等命令，并且绝不能把首次自动 snapshot 直接送给模型。

## 官方支持边界

### 可直接使用的部分

- Electron 正式支持在 `app.ready` 之前设置 `remote-debugging-port`，通过 HTTP 开启 CDP。[Electron command-line switches](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)
- Playwright CLI 正式支持 `attach --cdp=<HTTP endpoint>`，`detach` 不关闭外部浏览器。[CLI session management](https://github.com/microsoft/playwright-cli/blob/ca196c297169a494ee5517584883eada60dc8d0e/skills/playwright-cli/references/session-management.md#attaching-to-a-running-browser)
- CLI 底层调用 `chromium.connectOverCDP(..., { noDefaults: true })`，不会启动 Playwright 浏览器。[Playwright CLI browser factory](https://github.com/microsoft/playwright/blob/5f58876dc84d69008907e75d818baf55b0f78dc1/packages/playwright-core/src/tools/mcp/browserFactory.ts#L90-L100)
- Electron 可通过 `webContents.getOrCreateDevToolsTargetId()` 得到某个窗口的精确 CDP TargetID。[Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetorcreatedevtoolstargetid)

### 不能依赖的部分

- `connectOverCDP` 只支持 Chromium，并被 Playwright 明确标为比 Playwright protocol “低保真”；由外部程序启动的 Chromium 参数不同，部分高级能力可能失效。[BrowserType.connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- CLI 的 `tab-list/tab-select` 只暴露数字 index，不暴露 TargetID。[CLI tabs 实现](https://github.com/microsoft/playwright/blob/5f58876dc84d69008907e75d818baf55b0f78dc1/packages/playwright-core/src/tools/backend/tabs.ts#L33-L74)
- Playwright `_electron` 公开 API 只有 `electron.launch()`，不能连接已经运行的 ElectronApplication；相关 connect-existing 请求已关闭为 not planned。[Playwright Electron API](https://playwright.dev/docs/api/class-electron) · [Playwright #10369](https://github.com/microsoft/playwright/issues/10369)
- Playwright Extension 的正式前提是 Chrome/Edge/Chromium，Electron 又明确不保证任意 Chrome 扩展兼容；因此不应以 `attach --extension` 代替 CDP。[Playwright Extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md) · [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions)

## 本地 PoC 结果

PoC 启动一个 Electron 43.4.1 进程，创建两个窗口：默认 session 的 `Main Secret` 和独立持久 session 的 `Scrape Target`。刮削窗口同时挂载 Electron 自己的 `webContents.debugger`，模拟 Javdex 当前 Network/Page stealth 与响应体捕获。

| 验证项 | 结果 |
|---|---|
| `attach --cdp=http://127.0.0.1:19223` | 成功 |
| `/json/list` | 同时列出主窗口和刮削窗口；id 与 Electron TargetID 一致 |
| CLI ARIA snapshot | 成功，紧凑输出 `發行商 → MILK → /makers/MILK` |
| `find "發行商"` | 成功，只返回相关节点及上下文 |
| `click` 后再 snapshot/eval | 成功，按钮状态从 `Probe` 变为 `Clicked` |
| CLI reload 刮削页 | 成功 |
| 现有 `webContents.debugger` | 始终保持 attached；reload 后仍收到 `Network.requestWillBeSent` |
| `detach` | Electron 进程和窗口继续运行 |
| 直接连接 `ws://.../devtools/page/<targetId>` | 失败：`Target.createTarget: Not supported` |
| 默认 current tab | 不稳定；不同 attach 分别落到刮削窗口和主窗口 |
| 浏览器下载 | 没有新增 `chromium-* / firefox-* / webkit-*` 二进制目录；只生成数 KB CLI daemon/session 元数据 |
| `playwright 1.62.1` 内置 `playwright cli` | 同样成功 attach/tab-list/detach |

PoC 还直接证明了权限风险：CLI 可 `tab-select` 到主窗口并读出主 renderer 的页面内容。remote debugging endpoint 因此不能被视为“刮削窗口能力”。Chrome 官方也警告，打开 remote debugging port 后，本机任意应用都可连接并控制浏览器。[Chrome DevTools MCP 安全警告](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2ce42f873877673deedacca4fe5bfda22cede6a6/README.md#connecting-to-a-running-chrome-instance)

## 为什么不能直接接当前主进程

### 1. CDP 是进程级，不是窗口级

当前 Javdex 主窗口与 [`scrapeBrowser`](../src/main/scrapers/scrapeBrowser.ts) 的隐藏刮削窗口属于同一 Electron browser process。开启 `remote-debugging-port` 后，`/json/list` 会列出两个 renderer。`persist:scraper` 只隔离 cookie/storage，不隔离 CDP target 权限。

即使 Agent 只看到一个 `browser` wrapper，本机其他进程仍可连接裸端口；如果直接把 endpoint 或完整 CLI 给 Pi，页面 prompt injection 也可能诱导模型切换 tab、读取 storage 或执行 `run-code`。

### 2. CLI 没有 target pinning

Electron 有精确 TargetID，CLI 没有 `--target-id`。它在 attach 后自动选择一个 current tab，并立即生成首次 snapshot。PoC 已观察到 current tab 在不同 attach 中从刮削窗口变成主窗口，因此下面做法都不可靠：

- 假设 scraper 永远是 tab 0；
- 用 title/URL 作为唯一身份；
- 直接把 page websocket 当 browser endpoint；
- attach 后先把自动 snapshot 返回 Agent，再做校验。

同进程实验若必须进行，宿主至少要给刮削文档和所有后续导航注入不可猜测 nonce，私下遍历 tabs 找到 nonce，丢弃 attach 的首次输出；每个动作前后重新核对 nonce/TargetID，目标消失立即 fail closed。但这只是降低误操作，不消除裸端口暴露。

### 3. 开关不能按窗口动态启停

Electron 要求在 `ready` 事件前追加 remote debugging switch。[Electron switches](https://www.electronjs.org/docs/latest/api/command-line-switches) 当前 Javdex 进入插件开发页时应用已经 ready，所以无法只给之后创建的刮削窗口临时打开 CDP。

同主进程只能三选一：

1. 应用全生命周期开放端口；
2. 进入插件开发前重启整个 Javdex；
3. 把刮削窗口移入可按需启动/退出的专用 Electron helper。

第三项边界最清晰。

### 4. `port=0` 会增加反自动化信号

Electron 43 实测 `remote-debugging-port=0` 会选取空闲端口，并在 `userData/DevToolsActivePort` 写入实际端口和 browser websocket；但 Electron 官方只承诺整数 port，没有把 `0` 和文件路径定义为 Electron 稳定契约。

更重要的是，Chromium 在 `remote-debugging-port=0` 时会启用 `AutomationControlled`；PoC 中两个页面的 `navigator.webdriver` 都是 `true`，固定端口则为 `false`。[Chromium runtime feature source](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/content/child/runtime_features.cc)

Javdex 已经专门隐藏 `navigator.webdriver` 并修正 UA client hints 以降低 Cloudflare 误判，所以生产 helper 应由父进程先选择一个空闲的**固定随机端口**，关闭占位 socket 后启动 helper；若竞争失败就更换端口重试。不要以 `port=0` 作为默认。

## 推荐生产设计

### A. 独立 scraper helper

把当前 `ScrapeBrowser` 拆成 client/server：

- 主进程保留稳定的 `ScrapeBrowserPort`；现有刮削、插件沙箱、Cloudflare handoff 调用点不感知进程变化。
- helper 是一个最小 Electron entry，只创建刮削 `BrowserWindow`，不加载 Javdex renderer。
- helper 独占一个明确的 scraper profile 目录；普通刮削与插件开发不能同时由两个进程打开它。
- 普通元数据刮削启动无 CDP helper；插件开发启动带 loopback CDP 的 helper。切换时先有序关闭旧 helper，再以同一 profile 重启，继续复用 clearance cookie。
- helper 拒绝 `window.open`/popup；如果确实需要多页，必须由宿主显式建页并纳入 target registry。
- 父子间只传 typed RPC：navigate、snapshot、interaction、status、challenge、close；不把 CDP endpoint、cookie 或 nonce写进 Agent workspace。

这样 remote debugging 仍有本机端口风险，但能控制的只有刮削资料和 scraper session，不再包含媒体库主 UI。

### B. Playwright 层的两阶段选择

**Spike 阶段：使用用户提出的 `@playwright/cli@0.1.18`。**它最容易复现直接 Pi 的 Skill 体验，适合与当前 browser tool 做 MissAV A/B。但必须 pin 精确版本；该包仍是 0.1.x，并固定依赖 Playwright 1.63 alpha。[v0.1.18 package](https://github.com/microsoft/playwright-cli/blob/ca196c297169a494ee5517584883eada60dc8d0e/package.json)

**发布阶段优先评估 `playwright@1.62.x` 内置 CLI或直接 `playwright-core` adapter。**Playwright 1.62 已正式把 `playwright-cli` 集成进稳定包，可通过 `npx playwright cli` 使用；本地 1.62.1 已通过同一 Electron attach PoC。[Playwright 1.62 release notes](https://playwright.dev/docs/release-notes#version-162)

如果继续原样使用独立 `@playwright/cli`，还要处理打包态 daemon：CLI 会用 `process.execPath` 再启动 detached daemon。开发机 Node 正常；用 Electron 可执行文件配合 `ELECTRON_RUN_AS_NODE=1` 时，外层 CLI 能运行，但内层 daemon 因 Electron argv 识别产生参数错误。开发态可用 preload shim 绕过，然而 Electron 明确禁止打包应用使用任意 `NODE_OPTIONS=--require`。[Electron environment variables](https://www.electronjs.org/docs/latest/api/environment-variables#node_options)

因此发布路径应在下面两项中选择：

1. 用 Electron `utilityProcess` 承载直接 Playwright API，保留 CLI 相同的 snapshot/ref/find 领域接口；这是最少隐式进程、最容易取消和打包的方案。
2. 如果“Agent 必须执行原始 CLI 命令”是硬要求，预先由宿主管理一个定制 CLI daemon entry，或额外打包独立 Node runtime；两者都要接受更多供应链与跨平台测试成本。

不要依赖用户机器已有 Node。

### C. Agent 可见能力

无论后端最终是 CLI 还是直接 API，Agent 只应看到与 Playwright CLI 接近的窄表面：

- 允许：`snapshot`、`find`、受限页面 `eval`、`click`、`fill/type`、`press`、`goto/reload`、必要的 screenshot。
- 宿主管理：attach/detach、tab 选择、target 校验、超时、取消、artifact、输出上限和 Cloudflare handoff。
- 禁止：`tab-new/tab-select/tab-close`、cookie/storage、upload、route、`run-code`、任意 config/endpoint、关闭外部 Electron browser。
- snapshot/ref 绑定 document revision；导航后旧 ref 必须失效。
- CLI 自动写出的完整 snapshot/console 放到 `.javdex/browser` 或宿主 artifact store；普通模型结果仍有硬字节上限。

这能获得 Playwright CLI 的高信息密度，但不继承它的完整权限面。

## 不下载浏览器的依赖与打包条件

可明确做到“不下载另一个 Chromium”，条件是：

- 只走 `attach/connectOverCDP`，永远不调用 `open`、`install-browser` 或 `npx playwright install`；Playwright 的浏览器安装本来就是独立命令。[Playwright browser install](https://playwright.dev/docs/browsers#install-browsers)
- 不依赖会自动安装二进制的 `@playwright/browser-*` 包。
- 将 Playwright JS 作为生产依赖打包。当前 npm 元数据显示，CLI + `playwright` + `playwright-core` 解包约 19 MB；直接 `playwright-core` 约 14 MB，远小于另一套浏览器。
- 打包验证不能只看 npm install 成功：需断言用户缓存和 app resources 中没有新增 `chromium-* / firefox-* / webkit-*`，并在断网环境执行 attach/snapshot。
- Electron 43 自带 Node 24，满足当前 Playwright core 的 Node >=20 要求；若未来关闭 `runAsNode` fuse，原始 CLI client 方案会失效，而 `utilityProcess + API` 仍是推荐替代。[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode)
- CLI 工作目录和输出目录必须是真实可写目录，不能是 ASAR 内部；ASAR 是只读的，也不能作为 cwd。[Electron ASAR](https://www.electronjs.org/docs/latest/tutorial/asar-archives)

## 对当前 Javdex 的具体影响

可以保留的现有能力：

- `persist:scraper` 的登录/Cloudflare cookie 语义；
- 当前 UA、client hints、`navigator.webdriver` stealth；
- `webContents.debugger` 的 Network/Page 监听和图片响应体缓存；PoC 已证明它与外部 Playwright CDP client 在 Electron 43 上可同时工作；
- Cloudflare challenge 时显示同一个刮削窗口让用户接管；
- PluginDeveloper 的 artifact、输出预算、取消和会话生命周期。

可以逐步替换的自研部分：

- 固定大 `inspect` 报告作为默认观察；
- CSS selector-only 的交互；
- 页面全文前缀截断；
- 为 Agent 重复实现 ARIA/ref/find/auto-wait。

必须新增的边界：

- `ScrapeBrowserPort` 的跨进程实现；
- helper profile 单拥有者与 crash recovery；
- CDP fixed-random-port handshake 与 loopback probe；
- 精确 target/document revision gate；
- Playwright version capability probe；
- helper/adapter/Agent run 三者的统一取消与回收。

## 建议实施顺序

1. **开发态同进程 A/B spike**：只在显式环境开关下启用固定端口；用宿主 nonce 绑定 scraper target；复现 5 次 MissAV create，不改生产默认。
2. **验证信息密度**：要求首次详情页 snapshot/find 在 2 次 browser call 内给出番号、标题、封面和主要标签；到首次代码修改不超过 4 次 browser call。
3. **抽取 scraper helper**：先保持旧 BrowserPort 行为完全一致，只改变进程所有权和 profile 生命周期。
4. **将 Playwright 接 helper**：先使用 CLI 验证；通过后决定保留 CLI daemon还是换直接 API adapter。
5. **移除旧低层观察主路径**：保留少量 HTML/网络诊断作为降级，不再默认把完整页面报告交给模型。
6. **三平台打包验收**：macOS arm64/x64、Windows x64、Linux；断网、无系统 Node、无 Playwright browser cache 环境均能 attach。

## 验收门槛

- Agent 永远无法观察 Javdex 主 UI target。
- 关闭/崩溃 scraper target 后，下一动作 fail closed，不能自动切到其他 page。
- CDP 只监听 loopback；helper 退出后端口立即消失。
- helper 使用固定随机端口，页面 `navigator.webdriver === false`；stealth 仍通过回归。
- Playwright attach/reload 期间，现有 Electron debugger 的 Network/Page 事件持续工作；发生 detach 时立即中止并重建，而不是静默降级。
- Cloudflare 手动验证完成后，同一 scraper profile 可继续使用。
- 不下载或打包 Playwright 浏览器二进制。
- snapshot/ref/click/find 的普通输出满足现有 3–5 KB 预算；完整 artifact 不进入模型上下文。
- 同一页面与操作脚本用直接 Pi + Browser Skill、CLI adapter、旧 browser tool 各跑 5 次；CLI/helper 的成功率不得低于直接 Pi，browser calls/tokens 至少下降 30%。
- Electron 或 Playwright 升级必须运行 CDP attach、target isolation、debugger coexistence、packaged daemon/utility process 和 Cloudflare smoke tests。

## 最终建议

`@playwright/cli` 很适合证明高信息密度浏览器体验，也确实可以复用 Electron 刮削窗口且不下载浏览器。真正需要避免的是把“可连接”误当成“已隔离”。

正式方案应采用：

> **专用 Electron scraper helper + loopback 固定随机 CDP + Playwright 窄 Adapter + Pi Skill。**

CLI 可以作为第一阶段实现和体验基线；长期内核优先使用稳定 Playwright 包或直接 API，以获得精确 Page 生命周期、可靠取消和更简单的 Electron 打包。这样既保留 Pi 原生浏览能力的效率，又不会把 Javdex 主 renderer、cookie/storage 和完整 Playwright 权限面交给 Agent。
