# 高信息密度 Agent 浏览器开源工具调研

> 调研日期：2026-08-21
> 目标：寻找能够复现“直接 Pi + Browser Skill”体验的成熟开源实现，重点考察页面端按需投影、ARIA/ref、批处理、差量观察、持久会话、Electron 接入、上下文控制和安全边界。
> 关联分析：[复现直接 Pi 浏览器 Skill 高信息密度体验](./PI_BROWSER_HIGH_DENSITY_RESEARCH.md)

## 结论

有可用的开源工具，不应继续从零自研 accessibility tree、ref、会话守护进程和大部分浏览器操作层。但目前没有一个同时满足“公开稳定 API、原生 Pi 接入、Electron 内嵌、页面端安全代码执行、snapshot diff、字段事实投影”的完整 1.0 方案。

建议采用以下顺序：

1. **默认 PoC：微软官方 `@playwright/cli` v0.1.18。**它明确以 coding agent 和低 token 为目标，已有 snapshot/ref、局部 `find`、页面端 `eval`、命名会话、持久 profile、CDP attach、结构化 JSON 和超量输出落盘。它最适合当前 TypeScript/Electron 技术栈，也最接近 public Pi Browser Skill 的“由主模型写一次页面查询，只返回任务所需结果”。[官方 README](https://github.com/microsoft/playwright-cli/blob/2f85a94b7b885dbf4a5d34462f253a8746a690c9/README.md) · [v0.1.18 release](https://github.com/microsoft/playwright-cli/releases/tag/v0.1.18)
2. **正式 A/B 对照：`vercel-labs/agent-browser` v0.34.0。**它比 Playwright CLI 多出原生 snapshot diff、batch、compact/depth/selector 过滤、`--max-output`、持久 daemon 和 CDP tab pinning，是能力最完整的候选；代价是 Rust 原生二进制打包、快速变化的 0.x 接口和额外的跨平台升级面。[README](https://github.com/vercel-labs/agent-browser/blob/b041bd4c9e71b0b1ea0727a9d9deb1e661615050/README.md) · [v0.34.0 changelog](https://github.com/vercel-labs/agent-browser/blob/b041bd4c9e71b0b1ea0727a9d9deb1e661615050/CHANGELOG.md#0340)
3. **Pi 原生封装参考：`pi-agent-browser-native`。**它已经把 `agent-browser` 包成 Pi 原生工具，做了正文优先压缩、spill file、ref 防护、snapshot diff、Electron 生命周期和大量测试；而且其 Pi peer dependency 与 Javdex 当前的 `@earendil-works/pi-* 0.84.x` 同系列。但 npm 版仍是 0.3.0，仓库主干是 0.5.0，适合快速验证和借鉴，不宜现在成为不可替换的产品内核。[仓库](https://github.com/fitchmultz/pi-agent-browser-native/tree/fc051c4542fdad78b5a84b72919ee73966d8e71f) · [Electron 设计](https://github.com/fitchmultz/pi-agent-browser-native/blob/fc051c4542fdad78b5a84b72919ee73966d8e71f/docs/ELECTRON.md)

一句话判断：

> 先用 Playwright CLI 替换自研浏览器“数据面”，保留 Javdex 自己的权限、会话和产品 UI；同时用 agent-browser 做同任务 A/B。不要再让第二个 LLM/Agent 负责理解页面。

## 评估标准

本次不是比较谁能“打开网页”，而是比较谁能解决当前插件开发助手的真实瓶颈：

- 一次浏览器调用能否只返回目标字段、候选链接或可操作控件，而非大段通用页面报告；
- 是否支持 accessibility snapshot 和可复用的临时 ref；
- 是否能搜索或局部读取大 snapshot；
- 是否能在页面上下文中执行主模型生成的只读投影；
- 是否支持批量动作、操作后状态或 snapshot diff；
- 会话、cookie、tab 和 browser process 是否可稳定复用；
- 是否能把完整输出留在文件/宿主，避免全部注入模型；
- 是否会引入第二个语义模型或第二套 Agent loop；
- 能否通过窄 Adapter 接入，而不是把 bash、MCP 全工具面或宿主 RCE 暴露给 Pi。

## 候选矩阵

| 工具 | 当前成熟度 | 高信息密度能力 | 接入代价 | 结论 |
|---|---|---|---|---|
| [`@playwright/cli`](https://github.com/microsoft/playwright-cli) | 微软官方；v0.1.18；Apache-2.0；Node ≥18；底层暂绑定 Playwright 1.63 alpha | ARIA snapshot/ref、subtree/depth、`find` 上下文片段、页面 `eval`、raw/JSON、输出落盘 | Node 子进程；需做窄 Pi Adapter；没有一等 snapshot diff | **默认 PoC** |
| [`agent-browser`](https://github.com/vercel-labs/agent-browser) | v0.34.0；Apache-2.0；活跃但仍是 0.x | compact snapshot/ref、selector/depth、read、batch、snapshot diff、max output、持久 daemon | Rust 原生二进制、Chrome 安装、跨平台打包和快速升级 | **最强 A/B 候选** |
| [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) | 社区项目；npm 0.3.0、主干 0.5.0；MIT | 对 agent-browser 再做正文优先、spill、diff、Pi artifact、ref/session 防护、Electron 管理 | 与当前 Pi 版本贴合，但版本和维护主体较年轻 | **原型/设计参考** |
| [`playwright-mcp`](https://github.com/microsoft/playwright-mcp) | 微软官方；v0.0.79；Apache-2.0 | snapshot/ref、`find`、page eval、CDP、持久 profile、结构化工具 | Pi 本身无 MCP；工具 schema 较多；`run_code_unsafe` 是宿主 RCE | CLI 已覆盖核心需求，**不优先** |
| [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Chrome 官方；v1.7.0；Apache-2.0 | a11y snapshot/UID、page evaluate、network/console/performance、CLI | 全量工具面很大；`--slim` 只有 navigation/script/screenshot，不含 snapshot；无一等 diff | **故障诊断补充** |
| [`Stagehand`](https://github.com/browserbase/stagehand) v4 | 官方 SDK v4.0.2；MIT | trimmed a11y tree、batch、Playwright-shaped API；仓库内有原生 Pi 三工具 facade | facade 包是 private，依赖 `experimentalBatch`；`act/observe/extract` 会引入第二模型 | **优秀架构样板，不是现成依赖** |
| [`browser-use`](https://github.com/browser-use/browser-use) | 活跃；MIT；Python ≥3.11 | 完整 browser agent、DOM/CDP、会话和自动化 | 自带 Agent loop 和 LLM，Python sidecar，重复 Pi 的职责 | **排除主链路** |
| [`badlogic/pi-skills/browser-tools`](https://github.com/badlogic/pi-skills/tree/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools) | 简单脚本集；MIT；无正式 releases | 任意页面 JS 投影、单次 IIFE 批量读取，正是直接 Pi 快的主要原因 | 依赖 bash、固定 CDP、无 ref/diff/output cap/产品级安全边界 | **体验基准，不作生产依赖** |

“成熟度”需要分层理解：Playwright、Puppeteer、CDP 本身成熟；面向 coding agent 的 CLI/Skill 外壳大多仍是 0.x。它们已经可用于产品 PoC，但必须固定版本并隔离在 Adapter 后，不能让上游命令和结果 schema 直接成为 Javdex 的长期领域接口。

## 1. Playwright CLI：最适合先接入

### 为什么它最贴近目标

Playwright CLI 官方明确说明：coding agent 更适合 CLI + Skill，因为 CLI 不需要把大型 tool schema 和完整 accessibility tree常驻上下文；MCP 更适合专门、长时的浏览器 Agent loop。[官方比较](https://github.com/microsoft/playwright-cli/blob/2f85a94b7b885dbf4a5d34462f253a8746a690c9/README.md#playwright-cli-vs-playwright-mcp)

它已经提供当前准备自研的多数基础能力：

- `snapshot` 生成带操作 ref 的 ARIA 状态，并可限定 subtree 或 depth；
- `find` 只返回匹配节点及少量上下文，不需要把整棵树交给模型；
- `eval` 在页面/元素上下文执行 JavaScript，主模型可一次提取 label/value、JSON-LD、metadata、链接路由和 selector 线索；
- 命名 session、内存 profile、持久 profile、storage state 和 CDP attach 已经内建；
- snapshot 默认写入 artifact 文件，普通命令只返回页面身份和链接；
- `--raw` 与 `--json` 便于宿主做稳定投影；v0.1.18 的 JSON 已包含结构化 snapshot；
- v0.1.14 加入 `--output-max-size`，超出响应预算的内容可落盘。[CLI Skill](https://github.com/microsoft/playwright-cli/blob/2f85a94b7b885dbf4a5d34462f253a8746a690c9/skills/playwright-cli/SKILL.md) · [v0.1.14 release](https://github.com/microsoft/playwright-cli/releases/tag/v0.1.14)

这与 public Pi Skill 的高密度路径一致：主模型先看紧凑结构，然后自己写一个页面端投影，一次返回当前任务需要的 JSON。区别是 Playwright CLI 补上了 session、ref、find、artifact 和稳定错误码。

### 明确限制

- CLI 本身仍是 v0.1.x，而且 [`package.json`](https://github.com/microsoft/playwright-cli/blob/2f85a94b7b885dbf4a5d34462f253a8746a690c9/package.json) 当前绑定 Playwright `1.63.0-alpha-2026-08-05`，必须 pin 精确版本。
- 公开命令没有一等 snapshot diff；官方 Skill 的示例是 `--raw snapshot` 两次后交给外部 `diff`。Javdex 可以在 Adapter 内做规范化 diff，不需要再自研整套 AX/ref 采集。[Skill raw-output 示例](https://github.com/microsoft/playwright-cli/blob/2f85a94b7b885dbf4a5d34462f253a8746a690c9/skills/playwright-cli/SKILL.md#raw-output)
- `run-code` 会在 Playwright server 进程执行任意 JavaScript；对应 MCP 工具甚至直接标注为 RCE-equivalent。不能把它暴露给插件开发 Agent。[Playwright MCP tool contract](https://github.com/microsoft/playwright-mcp/blob/16cf228d7b02c07f800ec3423f471ec2a42d22a9/README.md#core-automation)
- `eval` 只解决页面端观察/DOM 操作，跨导航批处理仍应由宿主的 typed action array 完成，不能以 host `run-code` 代替。

### 推荐用法

Javdex 不需要给 Pi bash，也不需要接整个 MCP。宿主只需 spawn 固定版本 CLI，并暴露三个 Pi-native 能力：

```ts
type BrowserTool =
  | { op: 'snapshot'; scope?: string; depth?: number; find?: string }
  | { op: 'run'; projection?: string; actions?: BrowserAction[] }
  | { op: 'screenshot'; fullPage?: boolean }
```

- `projection` 只进入浏览器页面上下文，返回 JSON，禁止 Node、文件、进程和任意网络 API；
- `actions` 是宿主 allowlist 的导航、click、fill、press、wait 数组；
- snapshot 原文件只进 artifact store，Agent 只看到 `find` 片段、字段事实或有限 ref；
- 所有结果由宿主统一做字节上限、Unicode 安全截断、secret redaction 和 revision 标记。

## 2. agent-browser：能力最完整，但工程代价更高

`agent-browser` 的核心 Skill 声称 interactive compact snapshot 通常只需约 200–400 tokens；它用 `@eN` ref 完成后续交互。[官方 core Skill](https://github.com/vercel-labs/agent-browser/blob/b041bd4c9e71b0b1ea0727a9d9deb1e661615050/skill-data/core/SKILL.md)

它原生覆盖了更多目标能力：

- `snapshot -i --urls -c -d 5 -s "#main"` 可组合交互、URL、compact、depth 和 selector；
- `batch` 一次发送多条命令；
- `diff snapshot` 支持当前状态与上次 snapshot 或指定 baseline 比较；
- `read` 可读当前渲染 DOM，也会优先 markdown/`llms.txt`；
- 后台 daemon、命名 session、profile、restore 和自动保存；
- v0.34 新增共享 CDP 浏览器下的 session-to-tab 固定和 `--pin-tab`；
- MCP 有小型 `core` profile，但对当前 Pi 仍建议直接使用 CLI/daemon Adapter；
- domain allowlist、content boundary、action policy、确认机制和 output cap 已内建。[README command reference](https://github.com/vercel-labs/agent-browser/blob/b041bd4c9e71b0b1ea0727a9d9deb1e661615050/README.md#commands)

它的主要风险不是功能，而是供应和边界：

- npm 包只是启动/分发入口，核心是按平台发布的 Rust binary；Electron 发布需要验证 macOS arm64/x64、Windows x64 和 Linux 包含、签名、更新与 Chrome 下载；
- v0.34 仍是 pre-1.0，近期持续加入 MCP、插件协议、stream、sandbox、tab pin 等大能力，升级面明显大于 Playwright CLI；
- CDP attach、真实 profile、restore 与 domain containment 之间存在组合限制，不能把上游配置选项直接交给模型；
- 上游仍有 stale ref 和部分 batch 参数问题需要在选定版本上做回归，不应直接让它承担 install/finish 的正确性门禁。

因此它非常适合做实际对照。如果相同 MissAV 任务中，原生 diff + batch 能显著少于 Playwright CLI 的 browser calls/bytes，再接受二进制打包成本；否则优先选官方 Node 方案。

## 3. pi-agent-browser-native：与当前 Pi 最贴近的现成封装

该项目不是另一个浏览器引擎，而是 `agent-browser` 的 Pi-native wrapper。它解决的正是嵌入式 Pi 常见问题：

- 一个 native tool 代替 Agent 手写 shell quoting；
- 主内容优先和高价值控件补偿；
- snapshot filter/diff 和完整 ref map 分离；
- 大输出写 spill file，不塞进模型；
- stale ref、URL/session 漂移和恢复 guidance；
- screenshot/download 变成 Pi artifact；
- Electron discover → launch → CDP attach → probe → cleanup 的完整生命周期。[README](https://github.com/fitchmultz/pi-agent-browser-native/blob/fc051c4542fdad78b5a84b72919ee73966d8e71f/README.md) · [Electron guide](https://github.com/fitchmultz/pi-agent-browser-native/blob/fc051c4542fdad78b5a84b72919ee73966d8e71f/docs/ELECTRON.md)

它也恰好使用 `@earendil-works/pi-* 0.84.0` 开发依赖，而 Javdex 当前是 `0.84.2`，所以可快速做独立 Pi dogfood。问题是仓库与 npm 发布存在版本差，API 仍快速演进，且 wrapper 暴露的 agent-browser 命令面比插件开发实际需要的大。

建议：

- 用它在仓库外/实验开关下快速复现一次直接 Pi 体验；
- 复用其 output shaping、spill、ref/session guard 和 Electron 测试思路；
- 产品内仍以 Javdex 自己的窄 `BrowserAdapter` 包住上游，不直接继承它的整个工具 schema。

## 4. Stagehand v4：官方 Pi 三工具架构样板

Stagehand v4 仓库内已经有一个非常接近目标形状的 Pi extension：只注册 `run`、`snapshot`、`screenshot` 三个 native tools；文档明确说 Pi 不内建 MCP，所以直接注册 extension tools。[Pi facade README](https://github.com/browserbase/stagehand/blob/beec7ed92a12c409bc782d7f117c481a5c198656/packages/integrations/pi/README.md) · [extension source](https://github.com/browserbase/stagehand/blob/beec7ed92a12c409bc782d7f117c481a5c198656/packages/integrations/pi/extensions/stagehand.ts)

其中：

- `snapshot` 返回裁剪后的 accessibility tree 和可操作 ID；
- `run` 既可消费 snapshot ID actions，也可执行 Playwright-shaped browser workflow；
- 代码在 Stagehand browser extension/service worker 一侧运行，而不是在 Pi 进程运行；
- facade 的 local browser 模式在不配置模型时也可使用，不必调用第二个 LLM；
- 它强制 snapshot ID 在导航后失效，并把一组动作放入一次 batch。[facade tools](https://github.com/browserbase/stagehand/blob/beec7ed92a12c409bc782d7f117c481a5c198656/packages/integrations/core/src/facade/tools.ts) · [config](https://github.com/browserbase/stagehand/blob/beec7ed92a12c409bc782d7f117c481a5c198656/packages/integrations/core/src/facade/config.ts)

这是很好的 Interface 样板，但目前 `@browserbasehq/stagehand-integrations` 标记为 `private`，未发布到 npm，且实现依赖 `experimentalBatch`。所以不应 fork 私有 facade 当稳定依赖。Stagehand 的 `act/observe/extract` 也会调用配置的模型；若用于主链路，会重新引入当前希望消除的第二模型成本与理解偏差。[Stagehand README](https://github.com/browserbase/stagehand/blob/beec7ed92a12c409bc782d7f117c481a5c198656/README.md)

可借鉴其三点：三工具 surface、页面/浏览器侧代码执行、导航即失效的 ref lifecycle。

## 5. 其他候选为何不作为默认

### Playwright MCP

能力与 Playwright CLI 大量重合，而且 Pi 设计上没有内建 MCP，需要再加 MCP client/bridge。当前 v0.0.79 已有 `browser_find`、snapshot depth/boxes、page eval、CDP、persistent/isolated profile，但工具面和 schema 明显比 CLI 大。[README](https://github.com/microsoft/playwright-mcp/blob/16cf228d7b02c07f800ec3423f471ec2a42d22a9/README.md) · [package](https://github.com/microsoft/playwright-mcp/blob/16cf228d7b02c07f800ec3423f471ec2a42d22a9/package.json)

如果未来 Javdex 建立统一 MCP Host，它可以成为 Adapter 后端之一；当前没有必要为了浏览器单独引入协议层。

### Chrome DevTools MCP / CLI

Chrome 官方项目已经到 v1.7.0，维护和 CDP 调试能力强，支持 a11y snapshot、UID、evaluate、network、console、performance 和连接现有可调试 Chrome。[README](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2ce42f873877673deedacca4fe5bfda22cede6a6/README.md) · [v1.7.0 changelog](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2ce42f873877673deedacca4fe5bfda22cede6a6/CHANGELOG.md#170)

但它的重点是 DevTools，不是字段调查的信息密度。全量模式工具很多；`--slim` 虽只暴露 navigation、script execution、screenshot 三个工具，却不包含 accessibility snapshot。它适合在插件运行异常时按需挂载 network/console Adapter，不适合作为日常 create loop 的默认 surface。[slim option](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2ce42f873877673deedacca4fe5bfda22cede6a6/README.md#configuration)

### browser-use

browser-use 是一个完整自治浏览器 Agent，官方示例要求给它 LLM，内部自己执行 observe → think → act loop；Python 集成和云版还围绕独立 task/session/judge 运行。[README](https://github.com/browser-use/browser-use/blob/85ddbfedf609166b2d2c76c3d80506649fee82a9/README.md)

这会重新制造当前架构问题：Pi 已经是主 Agent，再加入 browser-use 就有两个规划器、两套上下文和两种停止条件。它适合独立浏览器自动化产品，不适合做 Javdex 的薄 Browser Adapter。

### public Pi browser-tools

它是最重要的行为基线。Skill 直接要求主模型用 `browser-eval.js` 执行 IIFE，一次完成 DOM 检查、结构化字段提取或批量交互，而不是反复调用固定 `inspect`。[Skill efficiency guide](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools/SKILL.md#efficiency-guide)

它也说明为什么当前 Javdex 慢：直接 Pi 可以让模型定义返回 schema；Javdex 先替模型生成一个固定、冗长、顺序错误的页面报告，再裁掉最有价值的后半部分。

但该 Skill 只是脚本集，没有正式 release、稳定 ref、diff、统一输出上限或产品权限模型。应把它作为 A/B 的体验黄金样本，而不是复制 bash 和任意权限。

## 针对 Javdex 的推荐架构

```text
Pi Agent 0.84.x
  └─ Javdex browser native tool（窄、稳定、版本化）
       └─ BrowserAdapter
            ├─ PlaywrightCliAdapter（首选 PoC）
            ├─ AgentBrowserAdapter（A/B）
            └─ FixtureAdapter（回放测试）
                 └─ dedicated headed Chromium session
```

关键决定：

1. **Pi 直接理解页面。**浏览器工具只提供 snapshot/ref、页面端 projection、typed actions 和 screenshot；不做字段语义裁决，不调用第二个 verifier/Agent。
2. **复用 CLI 数据面，不暴露 CLI 权限面。**Pi 不获得 bash，也不获得 Playwright `run-code`、cookie dump、文件系统或完整 agent-browser 命令表。
3. **默认使用独立 headed Chromium。**不要为复用当前 Electron `BrowserWindow` 而在整个 Javdex Electron 进程开启公开 remote-debugging port；Chrome 官方也明确警告本地任意进程可通过该端口控制浏览器。[Chrome DevTools MCP security warning](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2ce42f873877673deedacca4fe5bfda22cede6a6/README.md#connecting-to-a-running-chrome-instance)
4. **Cloudflare 由产品做明确 handoff。**检测 challenge 后暂停 Pi，显示 headed browser 或 live view，让用户完成验证；完成后复用原 session。不要让底层浏览器工具在宿主超时之后继续隐式等待。
5. **页面端 projection 是一等能力。**允许模型一次返回 `{identity, labeledRows, jsonLd, metadata, candidates}`；结果限 8 KB，完整 raw/snapshot 写 artifact。代码只能在页面隔离世界或受限 worker 中执行。
6. **install/finish 不依赖浏览器工具的“正确”判断。**浏览器负责证据，Pi 负责开发，`plugin_check` 只做确定性的 schema、目标身份、sourceUrl、类型和最小样例检查。

这比继续实现一个自研 Browser Investigation Module 更合理：Javdex 只保留真正产品特有的部分——权限、Cloudflare handoff、artifact、插件字段 projection、UI、取消和审计；ARIA/ref/session/diff 尽量委托给上游。

## 建议的 A/B Spike

不先做大规模迁移。给两种 Adapter 各 1–2 天，实现相同窄接口，然后用固定 fixture 和真实 MissAV 各跑 5 次。

### Adapter A：Playwright CLI 0.1.18

- 固定 npm 和 Playwright 版本；
- 只开放 `open/goto/snapshot/find/eval/click/fill/press/close` 的宿主映射；
- 禁用 `run-code`、storage/cookie、文件和任意配置参数；
- snapshot 保存 artifact，普通结果只返回 `find`/projection/refs；
- Adapter 自己计算 normalized snapshot diff。

### Adapter B：agent-browser 0.34.0

- 固定平台 binary checksum；
- 使用命名 session、`--pin-tab`、compact/depth/max-output；
- 使用原生 `batch` 和 `diff snapshot`；
- 先限制为插件开发专用 host/domain 和页面端 eval；
- 验证 stale ref、abort、daemon crash、Chrome upgrade 和 app packaging。

### 选择指标

| 指标 | 建议门槛 |
|---|---:|
| 到拿到番号、标题、封面、主要标签行 | ≤ 2 browser calls |
| 到第一次修改插件代码 | ≤ 4 browser calls |
| browser 普通结果总量 | 首次 ≤ 6 KB，后续平均 ≤ 3 KB |
| 整体读取 raw artifact | 0 次 |
| 同页无变化重复 full snapshot | 0 次 |
| 首次 `plugin_check` | ≤ 8 个模型 turns |
| 五次最终正确率 | 不低于直接 Pi + public Browser Skill 基线 |
| 进程/会话泄漏 | 0 |
| challenge 手工接管后恢复 | 100% |

同时记录 p50/p95 总时长、primary uncached/cache-read/output/reasoning、浏览器 calls/bytes、到第一次 edit/check 的时间，以及每次工具返回中被下一步实际使用的字段比例。

### 决策规则

- 如果 Playwright CLI 能在 4 次浏览器调用内开始写代码，且正确率达到基线，选它：官方、Node、打包和升级面更小。
- 只有当 agent-browser 在 browser calls、模型 tokens 或成功率上有显著优势（建议至少 30%），再接受 Rust binary 和 daemon 的产品复杂度。
- 无论选哪一个，上层 `BrowserAdapter` 与 Pi tool schema保持自有、窄且版本化，确保以后可以替换后端。

## 最终判断

最成熟的可用组合不是一个“全能浏览器 Agent”，而是：

> **Playwright/agent-browser 负责成熟的浏览器数据面，Pi 继续作为唯一推理主体，Javdex 只提供窄权限 Adapter 和产品工作流。**

这能直接解决当前问题中的四个根因：固定低密度报告、反复浏览器 turns、第二模型语义偏差、浏览器结果挤爆上下文。真正值得自研的只剩插件领域 projection、权限与 UI，而不是通用浏览器自动化。
