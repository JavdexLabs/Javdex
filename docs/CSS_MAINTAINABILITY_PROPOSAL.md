# CSS 可维护性架构方案

> 状态：已接受  
> 调研日期：2026-08-11  
> 适用范围：Javdex Electron renderer（React + electron-vite/Vite）

## 决策摘要

**推荐采用“原生 CSS Modules + React 视觉原语 + 少量全局基础样式”的渐进架构。**

- 新增或迁移的组件样式使用 `ComponentName.module.css`，由对应 TSX 组件直接导入。
- 全局 CSS 只保留主题 token、reset、`html/body/#root`、应用壳层和迁移期 legacy 样式。
- 优先使用 Electron 现有 Chromium 支持的原生 CSS nesting，但最多嵌套两层；它只改善书写，不承担作用域隔离。
- **本轮明确不引入 Less 或 Sass。** 新增和迁移样式统一使用 `.module.css`；只有后续出现明确的参数化 mixin、循环或编译期计算需求，才重新评估只为 CSS Modules 引入 SCSS，即 `.module.scss`。
- 暂不切换 Lightning CSS；Vite 5 将完整 Lightning CSS transformer 标为实验能力，而且该模式不支持 CSS 预处理器。[Vite 5.4.21 Lightning CSS](https://github.com/vitejs/vite/blob/v5.4.21/docs/guide/features.md#lightning-css)
- 样式边界由 React primitive 的 props 定义。`variant`、`size`、`tone`、`chrome` 等外观语义不能继续依赖调用方拼接全局 class。

核心理由：Javdex 当前的主要问题是**全局选择器耦合和隐式样式接口**，不是缺少变量、嵌套或文件导入语法。预处理器能改善源码组织，却不会自动把编译后的选择器局部化。

### 关于 SCSS 的正式决定

本轮 CSS 架构改造不安装 `sass` 或 `sass-embedded`，不新增 `.scss` 文件，也不配置 Sass preprocessor options。目标技术栈固定为：

```text
CSS Modules             负责选择器所有权
React primitive props   负责跨组件视觉接口
CSS custom properties   负责主题与运行时 token
Native CSS nesting      负责局部规则的可读性
Stylelint               负责复杂度与新增债务约束
```

SCSS 不是迁移终点，也不作为阶段 0 的基础设施。它仅是未来有量化证据时可以单独决策的可选增强；即便未来引入，也只能使用 `.module.scss`，不能恢复全局 SCSS 架构。

## 当前基线

仓库实际安装版本为 Vite `5.4.21`、electron-vite `2.3.0`、React `18.3.1`、Electron `33.x`。electron-vite 将 `renderer` 声明为 Vite 配置并交给 Vite 合并处理，因此 CSS 能力应配置在 `electron.vite.config.ts` 的 `renderer` 节点，而不需要 Electron 专用 CSS 插件。[electron-vite v2.3.0 source](https://github.com/alex8088/electron-vite/blob/v2.3.0/src/config.ts#L1124-L1136)

当前未提交 CSS 拆分后的静态基线：

| 指标 | 当前值 |
|---|---:|
| CSS 文件 | 18 |
| CSS rules | 2,567 |
| declarations | 10,118 |
| unique classes | 1,476 |
| 在多个 CSS 文件中定义的 class | 175 |
| descendant selectors | 941 |
| `!important` | 12 |
| 硬编码颜色声明 | 150 |
| CSS custom properties 定义 | 150 |
| 使用 `className` 的 TSX | 119 / 146 |
| `className` 赋值 | 1,751 |
| 原始 `btn`/variant class 使用 | 375 次，分布于 61 个 TSX |
| 全局 `is-*` 状态 class 使用 | 67 |

当前没有直接依赖 `sass`、`less`、`postcss`、`lightningcss` 或 Stylelint；`postcss` 仅由 Vite 传递安装。仓库也没有 PostCSS/Stylelint 配置，`tsconfig.web.json` 尚未包含 `vite/client` 类型，已有 `assets.d.ts` 只声明了 PNG。引入 CSS Modules 前应补齐 Vite client types，并确认或合并重复的 asset module 声明。

这些数据说明：

1. 按功能拆文件已经解决单文件导航问题，但 175 个跨文件重复 class 与 941 个后代选择器仍使级联关系依赖全局上下文。
2. 项目已有 150 个 CSS custom properties，继续新增 Less/Sass 变量的边际收益有限；运行时主题仍必须依靠 CSS custom properties。
3. 375 次按钮 class 拼接表明共享视觉原语尚未成为稳定接口。先建立 `Button`、`Modal`、`IconButton` 等 props seam，比批量转换语法更有效。
4. `Modal` 目前通过检查 `className` 是否包含 `modal--plugin-dev-code` 推断 shellless 行为。样式字符串已经参与组件行为，应先改为显式 `chrome="shellless"`（或等价 prop），再迁移样式。
5. `scripts/run-electron-tests.mjs` 使用 Electron-as-Node、`--import tsx` 并直接导入 TSX。组件一旦直接导入 `.module.css`/`.module.scss`，测试运行时就需要 style module loader/stub；Vite 构建支持本身不能覆盖这条测试路径。

## 候选方案比较

| 方案 | 当前仓库接入要求 | 是否隔离选择器 | 优点 | 主要代价 | 迁移风险 | 结论 |
|---|---|---|---|---|---|---|
| **CSS Modules** | Vite 原生支持 `.module.css`；补充 `vite/client` 类型引用；先为 Electron-as-Node 测试添加 style loader/stub | **是，class 与 animation 默认 local** | 零新增 CSS 编译依赖；依赖关系与组件导入关系一致；迁移可逐组件进行 | 要同步修改 CSS 与 JSX；动态 class 需显式映射 | 基础设施低；单组件迁移中 | **采用** |
| Sass/SCSS（全局） | 安装 `sass-embedded` 或 `sass`；使用 `.scss` | 否 | `@use`、mixin、函数、循环、嵌套能力完整 | 引入新语言和编译器；可能制造深嵌套、`@extend` 和过度抽象 | 全量转换高 | 不采用 |
| Less（全局） | 安装 `less`；使用 `.less` | 否 | Vite 直接支持；变量、mixin、命名空间与嵌套成熟 | 与现有 custom properties 重叠；编译后仍是全局 CSS | 全量转换高 | 不采用 |
| **SCSS Modules** | CSS Modules 的全部前置项，加 `sass-embedded`/`sass`；使用 `.module.scss` | **是** | 同时获得局部作用域和 Sass 表达能力 | 迁移面与工具链都更大；目前缺少必须使用 Sass 的证据 | 中 | 有需求时再采用 |
| PostCSS + standards nesting | 直接使用原生 nesting 时零依赖；若需转译，显式安装 `postcss` 与 `postcss-nesting` 并添加配置 | 否 | 接近未来标准；Vite 自动读取 PostCSS 配置 | 只改变语法；复杂 selector list 会改变/放大 specificity | 低至中 | 仅作语法增强 |
| Vite Lightning CSS transformer | 安装 `lightningcss`，设置 `renderer.css.transformer = 'lightningcss'`，CSS Modules 配置改放 `css.lightningcss.cssModules` | 可配置 | 一体化转换、CSS Modules 和压缩 | Vite 5 中是实验选项；完整 transformer 与预处理器不兼容 | 高 | 暂不采用 |

Vite 5.4.21 已原生识别 `.module.css`，也支持 `.module.scss`、`.module.less`。[Vite 5.4.21 CSS Modules](https://github.com/vitejs/vite/blob/v5.4.21/docs/guide/features.md#css-modules) 预处理器不需要 Vite 插件，但必须安装对应编译器。[Vite 5.4.21 preprocessors](https://github.com/vitejs/vite/blob/v5.4.21/docs/guide/features.md#css-pre-processors) Vite 也会自动应用项目中的 PostCSS 配置。[Vite 5.4.21 PostCSS](https://github.com/vitejs/vite/blob/v5.4.21/docs/guide/features.md#postcss)

Electron 33 使用 Chromium 130，而完整的宽松 CSS nesting 语法从 Chromium 120 起可用，因此 Javdex 的当前 renderer 可直接使用标准 nesting。[Electron 33 release](https://www.electronjs.org/blog/electron-33-0) [Chrome CSS nesting update](https://developer.chrome.com/blog/css-nesting-relaxed-syntax-update)

如果未来需要为不同 renderer target 转译 nesting，应选择遵循 CSSWG nesting 规范的 `postcss-nesting`，而不是模拟 Sass 语义的 `postcss-nested`；两者不是可互换的语法。[PostCSS Nesting](https://github.com/csstools/postcss-plugins/tree/main/plugins/postcss-nesting) 项目配置直接 import 插件时，应将 `postcss` 与 `postcss-nesting` 都声明为直接 devDependencies，不依赖 Vite 当前的传递依赖。

### 为什么预处理器本身不解决全局耦合

Sass 和 Less 的嵌套都会展开为普通选择器。例如 `.card { .title {} }` 最终仍是全局 `.card .title`。Sass 官方还特别提醒，嵌套越深越难判断生成的 CSS，并建议保持浅层。[Sass style rules](https://sass-lang.com/documentation/style-rules/)

Sass 的 `@use` 会隔离 Sass **成员**（变量、函数、mixin），但模块加载产生的 CSS 仍会进入编译输出；它不是 CSS selector scope。[Sass `@use`](https://sass-lang.com/documentation/at-rules/use/) Less 的 namespace 也用于组织 mixin，而不是把最终 DOM class 自动哈希或局部化。[Less mixin namespaces](https://lesscss.org/features/#mixins-feature-namespaces)

CSS Modules 的 class 与 animation name 默认局部化，并通过 JS import 返回 local-to-global 映射，这才直接切断同名 class 的跨组件碰撞。[CSS Modules](https://github.com/css-modules/css-modules) [CSS Modules local scope](https://github.com/css-modules/css-modules/blob/master/docs/local-scope.md)

Vite 5 自带的 CSS Modules 类型是只读字符串索引，因此能识别模块默认导入，却不能在默认配置下把 `styles.classTypo` 判为类型错误。[Vite 5 client types](https://github.com/vitejs/vite/blob/v5.4.21/packages/vite/client.d.ts#L3-L40) 不能把 CSS Modules 宣传为完整 class-name type safety；应由命名检查、未使用 selector 检查和组件测试补足。

因此正确组合是：

```text
CSS Modules             负责选择器所有权
React primitive props   负责跨组件视觉接口
CSS custom properties   负责主题与运行时 token
Native nesting          负责局部规则的可读性
Global CSS              只负责真正全局的基础层
```

## 目标架构

### 文件所有权

```text
src/renderer/src/
├── styles.css                       # token、reset、document/root 基础样式
├── styles/
│   ├── global.css                   # 唯一全局 side-effect import 清单
│   └── ...                          # 迁移期现有 legacy 功能文件
├── components/
│   ├── Modal.tsx
│   ├── Modal.module.css
│   ├── Button.tsx
│   └── Button.module.css
└── pages/
    ├── LibraryPage.tsx
    └── LibraryPage.module.css
```

- `main.tsx` 最终只 side-effect import 一个 `styles/global.css`；Vite 会内联 CSS `@import` 并处理 URL rebasing。[Vite CSS `@import`](https://github.com/vitejs/vite/blob/v5.4.21/docs/guide/features.md#import-inlining-and-rebasing)
- 组件和页面自己 import 同名 `.module.css`，不由 `main.tsx` 统一导入。
- 当前拆分出的功能 CSS 先作为 legacy 保留，不进行一次性目录搬迁或语法转换。
- 一个 class 只能有一个 owner。跨组件共享视觉规则应提升为 React primitive，而不是复制 selector 或跨文件覆盖。

### React primitive 是跨组件样式接口

优先建立或收紧以下接口：

```tsx
<Button variant="primary" size="sm" />
<IconButton tone="danger" size="sm" />
<Modal chrome="shellless" size="xl" />
<EmptyState density="compact" surface="panel" />
```

- `variant`、`size`、`tone`、`density`、`chrome` 是有限联合类型。
- `className` 只作为调用方布局 hook，不承载组件内部 variant 或行为判断。
- 不通过 `className.includes(...)`、正则或 selector 名称推断行为。
- 避免通用 `slotClassNames`；只有无法由语义 prop 表达且有两个以上真实调用场景时才开放 slot。
- 测试使用 role、accessible name 或稳定 `data-testid`，不能依赖 CSS Modules 生成名。

### 命名约定

- 文件：`PascalCase.module.css`，与 owner TSX 同目录、同基名。
- module local：camelCase，优先语义短名，如 `.root`、`.header`、`.actions`、`.selected`。
- 不在 CSS Modules 内继续使用 BEM 前缀；文件作用域已经提供 namespace。
- 交互状态优先使用 `aria-*` 或 `data-state`，其次才是 local module class；禁止新增全局 `.is-*`。
- 全局契约 class 在迁移期保持现名；新增全局 class 必须在设计文档中说明为何不能局部化。
- 组件私有 custom property 使用 `--_name`；跨组件 token 继续使用现有 `--surface-*`、`--text-*`、`--control-*` 等语义命名。

### Selector 与复用约定

- nesting 最大两层，selector 最多三个 compound selectors。
- module selector 不能穿透另一个 React 组件的内部 DOM；需要控制时通过 props、slot 或 custom property。
- `:global(...)` 只允许用于迁移桥接，并附带 owner/移除条件。CSS Modules 官方支持该 escape hatch，但它重新引入全局耦合。[CSS Modules composition/global](https://github.com/css-modules/css-modules/blob/master/docs/composition.md#exceptions)
- 不使用跨文件 `composes` 解决主题或 variant。CSS Modules 官方说明跨文件 composition 的应用顺序未定义；共享视觉模式应由 React primitive 组合。[CSS Modules composition dependencies](https://github.com/css-modules/css-modules/blob/master/docs/composition.md#dependencies)
- 不使用 Sass `@extend`；如后续采用 SCSS，只允许 `@use`，不用已弃用的 Sass `@import`。[Sass `@import` deprecation](https://sass-lang.com/documentation/at-rules/import/)
- 新颜色先映射到语义 token，不能直接在 feature/module 文件加入 hex、rgb、hsl 或命名色。

## 分阶段迁移

### 阶段 0：建立安全网

1. 先独立提交并稳定当前 CSS 纯拆分，保留可回退基线。
2. 新增 `src/renderer/src/vite-env.d.ts`，引用 `vite/client`。Vite 5 的 client types 声明了 `.module.css`、`.module.scss` 和 `.module.less` 默认导出。[Vite 5 client types](https://github.com/vitejs/vite/blob/v5.4.21/packages/vite/client.d.ts#L3-L40)
3. 为 Electron-as-Node 测试注册 style module loader/stub：普通 CSS 返回空副作用模块，CSS Modules 默认导出一个可按 key 返回稳定字符串的 class map。先用一个 fixture 验证直接导入含 `.module.css` 的 TSX 测试能运行。
4. 用 `styles/global.css` 固化全局导入顺序，`main.tsx` 只保留一个全局样式入口。
5. 加入 CSS 指标脚本与 Stylelint，但 legacy 先采用 baseline/non-regression，不一次性豁免数百条规则。

### 阶段 1：先修接口，再迁移 primitive

1. 将 `Modal` 的 shellless 判断改成显式 prop，并为现有调用补齐类型与测试。
2. 建立统一 `Button` primitive，收口 `variant`、`size`、disabled 与 focus 行为；逐步替代 61 个 TSX 中的原始 `.btn*` 拼接。
3. 选择 `IconButton`、`EmptyState`、`Toast` 等 owner 清晰的小组件做 CSS Modules pilot。
4. 每迁移一个 primitive，就从 legacy CSS 删除对应 selector，禁止双写。

### 阶段 2：按纵向功能切片迁移

按“一个组件/页面 + 对应 CSS + 测试/截图”原子提交，建议顺序：

1. 无 portal、无跨页 override 的叶子组件。
2. 设置页 panel 与表单 primitive。
3. 媒体卡片、分类卡片及筛选组件。
4. Modal 内容组件和 plugin development 工作区。
5. Library/Detail 等页面布局最后迁移。

不按现有大 CSS 文件批量改成 `.module.css`；那只会把一个全局依赖图一次性转成大量 JSX 改动，难以定位视觉回归。

### 阶段 3：清理全局级联

1. 删除已无 owner 的 legacy selector 与重复定义。
2. 将硬编码颜色收敛到主题/语义 token 文件。
3. 将全局 `.is-*` 状态替换为 props、ARIA/data attributes 或 local class。
4. 当大多数 app CSS 都有明确 owner 后，再评估 cascade layers，例如 `reset, tokens, base, legacy, components, utilities, overrides`。层顺序由首次声明决定，且未分层样式在普通声明中高于显式 layer，因此不能只给部分文件随意加 layer。[CSS Cascade Layers](https://drafts.csswg.org/css-cascade-5/#layer-order)

### 阶段 4：有证据时才启用 SCSS Modules

只有出现以下至少一类重复需求时才引入 `sass-embedded`/`sass`：

- 三个以上 owner 需要同一参数化 mixin，且 React primitive/custom property 无法合理表达。
- 需要编译期 map、loop 或稳定的数学/颜色函数。
- 普通 CSS 导致可验证的大量重复，而不是仅因个人语法偏好。

即便启用，也只新增 `.module.scss`；主题值仍使用 CSS custom properties，禁止把运行时 token 复制为 Sass 常量。Vite 5.4.21 推荐 `sass-embedded` 配合 `renderer.css.preprocessorOptions.scss.api = 'modern-compiler'`。[Vite 5.4.21 preprocessor options](https://github.com/vitejs/vite/blob/v5.4.21/docs/config/shared-options.md#css-preprocessoroptions)

## Guardrails

建议在 `check:css` 中逐步启用：

- `max-nesting-depth: 2`。[Stylelint rule](https://stylelint.io/user-guide/rules/max-nesting-depth/)
- `selector-max-compound-selectors: 3`。[Stylelint rule](https://stylelint.io/user-guide/rules/selector-max-compound-selectors/)
- 对 plain CSS 使用 `selector-max-specificity: "0,3,0"`；legacy 采用 allowlist，不允许新增 ID selector。[Stylelint rule](https://stylelint.io/user-guide/rules/selector-max-specificity/)
- 对 CSS Modules 启用 `declaration-no-important`；现有 12 处只允许减少。[Stylelint rule](https://stylelint.io/user-guide/rules/declaration-no-important/)
- 自定义检查：禁止 feature/module 文件新增硬编码颜色。
- 自定义检查：禁止 `main.tsx` 或任意 feature 直接 side-effect import 全局 CSS；唯一入口为 `styles/global.css`。
- 自定义检查：`:global`、新增全局 class、跨文件重复 selector 必须命中显式 allowlist。
- 自定义检查：禁止组件逻辑读取或解析 `className` 来决定行为。

原生 nesting 与 Sass/Less nesting 都可能隐藏 specificity。CSS nesting 规范规定 `&` 的 specificity 取父 selector list 中最大值，复杂 selector list 应保持展开写法或拆成独立规则。[CSS Nesting specification](https://drafts.csswg.org/css-nesting/#nest-selector)

## 验收指标

### 基础设施完成条件

- Electron-as-Node 测试能直接加载导入 `.module.css` 的 TSX。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。
- CSS Modules pilot 在开发 HMR 与生产构建中均正常。
- 当前 CSS 拆分前后的关键页面截图基线无非预期变化。

### 迁移过程指标

| 指标 | 基线 | 第一阶段目标 | 最终目标 |
|---|---:|---:|---:|
| 通过 class 字符串推断组件行为 | ≥ 1 | **0** | 0 |
| 原始 `btn`/variant class occurrences | 375 | ≤ 200 | 仅 `Button` owner 内存在 |
| 全局 `is-*` 使用 | 67 | 不增加 | **0** |
| 跨 CSS 文件重复 class | 175 | 不增加 | ≤ 20 个有文档的全局契约 |
| descendant selectors | 941 | 不增加 | 较基线下降 ≥ 50% |
| `!important` | 12 | 不增加；module 为 0 | ≤ 5 个有说明的全局例外 |
| 硬编码颜色声明 | 150 | 不增加 | feature/module 为 0，整体下降 ≥ 80% |
| 新增/迁移组件采用 CSS Modules | 0% | 100% | 100% |

补充质量门槛：

- 单个 `.module.css` 建议不超过 400 行；超过时先检查组件职责，而不是机械拆文件。
- 迁移后的组件不得在 legacy CSS 留下同名 selector。
- 生产 CSS 体积相对当前基线增长不超过 5%；若增长，必须解释是功能增长还是 selector/hash 重复。
- 每个纵向切片至少覆盖默认、hover/focus、disabled、窄窗口和当前主题组合中的相关状态。

## 最终选择

选择 **CSS Modules（plain CSS）**，不是 Less；也不立即选择 Sass。它以最小工具链变化直接处理当前最严重的 global-selector coupling，并能沿组件边界渐进迁移。

SCSS Modules 保留为以后可兼容升级，而不是当前架构前提。这样即使永远不引入预处理器，Javdex 也能先获得明确的样式所有权、稳定的 React 视觉接口和可执行的非回归约束。
