# UI Component Contracts

本项目是高密度本地媒体库工具。组件规范的目标是让页面保持安静、紧凑、稳定，并让搜索、筛选、编辑、维护这些高频动作在各页面中表现一致。

## Layout Surfaces

- `app-shell`: 全局桌面壳，包含侧边导航、主内容区和全局覆盖层。
- `list-page`: 列表面的根容器，内部通常包含 `topbar` 和 `scroll-body`。
- `detail-pane`: 详情面的根容器，可在嵌套详情打开时追加 `detail-pane--stacked`。
- `detail-pane-overlay`: 详情内的下一层覆盖详情。
- `scroll-body`: 页面滚动边界。列表虚拟化或固定高度内容使用 `scroll-body--fill`，普通详情使用 `scroll-body--scroll`。

页面组件应该组合这些既有 surface class，不要在页面根部临时创造新的滚动或定位模型。

## Toolbar

所有列表页工具栏遵循同一结构：

- 左侧：搜索框或当前列表标题。
- 右侧：筛选、排序、显示模式、批量动作入口和稳定结果数。
- 结果数右对齐，并使用固定宽度策略避免刷新时跳动。
- 搜索输入保持常驻；复杂筛选放进 popover。
- toolbar 控件默认高度为 `--control-h-md` 或页面定义的 `--toolbar-control-h`。

推荐使用 `ListToolbar` 组合工具栏内容。页面只提供业务控件，不重复写 toolbar 结构。

## Applied Filters

已生效筛选必须显示为可移除 chip：

- 每个 chip 只移除一个条件。
- 提供“清除全部”动作。
- 搜索词不进入筛选 chip；搜索框本身就是搜索词的编辑与撤销入口。
- 状态、年份、番号前缀、标签、性别、非默认排序等筛选条件算作已应用条件。
- chip 文案使用用户可理解的领域词，不暴露 query key。

推荐使用 `AppliedFilterBar`。页面负责生成筛选项数组，组件负责布局和交互外壳。该组件是通用列表组件，不应使用 `library-*` 这类页面专属 class 命名。

## Buttons

- `btn-primary`: 只用于提交、播放、开始主要任务。
- `btn-ghost`: 用于详情页维护动作或低强调动作。
- `btn-danger`: 用于破坏性动作；真正执行前必须有确认。
- 小型按钮使用 `btn-sm`，目标尺寸仍需满足最小点击区域。
- 纯图标按钮优先使用 `IconButton`，并提供可访问名称。

不要用临时符号代替可复用图标控件；确实需要文字命令时，按钮文案应短、明确。

## Popovers And Modals

- 筛选使用 popover，按字段分组，底部放重置/应用或关闭动作。
- 阻塞式确认、编辑表单、批量任务配置使用 modal。
- modal 最大高度受视口约束，内部内容允许滚动。
- danger modal 只在确认动作上体现危险，不把整个弹窗做成高饱和警告样式。

## Cards And Media Items

- 媒体卡片是重复信息单元，圆角最大 8px。
- hover 可以改变边框、阴影或轻微位移，但不能造成网格重新排布。
- 封面、标题、番号、状态是主视觉，装饰性元素应保持克制。
- 长标题、路径、标签必须有截断、换行或稳定宽度策略。
- 卡片、封面、头像、画廊缩略图和预览图默认不可复制选中，避免拖拽/点击时误选图片或 UI 文案。

## Selection And Copy

应用采用“交互外壳不可选、内容文本显式可选”的策略：

- 默认不可选：导航、按钮、toolbar、tabs、chips、cards、menus、badges、图标、图片、封面、头像、画廊和状态文案。
- 默认可选：`input`、`textarea`、`contenteditable`、详情标题、元数据值、剧情简介、弹窗正文、文件路径、扫描结果路径，以及显式标记为 `.selectable-text` 或 `.copyable-text` 的内容。
- 图片应同时禁用浏览器拖拽 ghost，除非某个交互明确需要拖拽图片。
- 不用 `user-select: none` 包裹整段正文或表单内容；如果必须禁用，内部可复制文本需要重新 opt-in。

## Empty, Loading, Error

- 空状态保持简短、任务导向，不使用营销式 hero。
- loading 状态使用现有 spinner 和短文本。
- 错误通过 toast 或页面内短提示表达，避免在列表面插入大块解释文本。

### Empty height model

按**父容器是否有固定可视高度**选择变体，不要一律拉满或一律很小。

| 场景 | 父容器特征 | 变体 | 高度行为 | 例子 |
|------|------------|------|----------|------|
| 固定面板 | flex/grid 子项有明确可用高度（`flex:1` + `min-height:0`） | `fill` | 铺满父级初始可视高度 | Agent「对话」「结果」空状态 |
| 滚动详情区块 | 页面本身会滚动，空状态只是其中一个 section | `compact` | 固定带高 `--empty-inline-min-h`（140px），与样张空状态一致 | 影片样张、演员写真、详情内「暂无关联影片」 |
| 整页/列表主区 | `scroll-body` 内整页无数据 | `page` | 可占满滚动视口 | 媒体库/演员列表无结果 |
| 弹层列表 | modal 内列表区 | `modal` | 跟随弹层内容区伸缩 | 选清单、合并演员 |

规则：

1. **固定高度父容器 → 铺满。** Agent 对话日志、结果面板这类右侧工作区，空状态必须用 `empty-state--fill`，让首屏不出现「上面一小块空、下面大片死白」。
2. **会滚动的详情区块 → 中等带高。** 样张/写真等 section 空状态用 `compact` +（可选）`sample-empty`，高度对齐样张空状态（`--empty-inline-min-h: 140px`）。禁止让这类空状态 `min-height: 100%` 撑满整个详情滚动区。
3. **不要把「铺满」规则套到所有 `.empty-state`。** 仅 `page`（整页）或 `fill`（固定面板）可以占满父级；`compact` 永远是内容带，不是视口填充。
4. **新增空状态先问父容器。** 若父级是固定高度工作区，选 `fill`；若父级在长页面里只是一块内容，选 `compact`。

## Styling Rules

- 组件样式优先使用 `--surface-*`、`--text-*`、`--border-*`、`--control-*`、`--focus-*`、`--motion-*`。
- 页面中避免 hardcoded 颜色、阴影、圆角和间距。
- inline style 仅用于真实动态值，例如虚拟列表定位、进度条宽度、图片缩放变换。
- 可复用视觉模式应沉淀为 class，而不是散落在 JSX 中。

## Migration Checklist

新建或重构页面时，按下面清单检查：

- 列表页根节点使用 `list-page`。
- 详情页根节点使用 `detail-pane`。
- 列表页 toolbar 使用 `ListToolbar`。
- 改变结果集的筛选状态写入 URL query。
- 已应用筛选使用 `AppliedFilterBar`，但搜索词只保留在搜索框内。
- 可滚动详情使用 `scroll-body--scroll`。
- 虚拟列表或固定填充列表使用 `scroll-body--fill`。
- 破坏性操作进入确认 modal。
- 静态视觉值进入 CSS class 和语义 token。
- 动态尺寸、位置、进度、变换才允许 inline style。
- 新增可复制内容时添加可选中语义；新增交互卡片/图片时保持不可选中。
- 空状态按父容器选型：固定高度面板用 `fill`，滚动详情区块用 `compact`（约 140px），整页无数据用 `page`。
