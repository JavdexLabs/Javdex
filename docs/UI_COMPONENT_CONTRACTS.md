# UI Component Contracts

本项目是高密度本地媒体库工具。组件规范的目标是让页面保持安静、紧凑、稳定，并让搜索、筛选、编辑、维护这些高频动作在各页面中表现一致。

## Layout Surfaces

- `app-shell`: 全局桌面壳，包含侧边导航、主内容区和全局覆盖层。
- `list-page`: 列表面的根容器，内部通常包含 `topbar` 和 `scroll-body`。
- `detail-pane`: 详情面的根容器，可在嵌套详情打开时追加 `detail-pane--stacked`。
- `detail-pane-overlay`: 详情内的下一层覆盖详情。
- `scroll-body`: 页面滚动边界。自带滚动视口的虚拟列表或固定高度内容使用 `scroll-body--fill`，普通详情使用 `scroll-body--scroll`。

页面组件应该组合这些既有 surface class，不要在页面根部临时创造新的滚动或定位模型。

## Toolbar

所有列表页工具栏遵循同一结构：

- 左侧：搜索框或当前列表标题。
- 右侧：筛选、排序、显示模式、批量动作入口和稳定结果数。
- 结果数右对齐，并使用固定宽度策略避免刷新时跳动。
- 搜索输入保持常驻；复杂筛选放进 popover。
- toolbar 控件默认高度为 `--control-h-md` 或页面定义的 `--toolbar-control-h`。
- `ListToolbar` 统一搜索、筛选、文本按钮和排序组的外框高度（默认 36px）；紧凑排序在顶栏中也跟随此高度。文本按钮通过 `data-ui="button"` 匹配，不依赖已经移除的 `.btn-sm` 类。筛选浮层内部控件独立保留自己的尺寸。

推荐使用 `ListToolbar` 组合工具栏内容。页面只提供业务控件，不重复写 toolbar 结构。

卡片列表进入上下文选择模式时是“搜索输入保持常驻”的例外：

- 用 `SelectionToolbar` 临时替换 `ListToolbar`，显示选择数量、批量动作和取消选择。
- 选择模式内点击卡片切换选择，不进入详情；退出选择模式后恢复原工具栏。
- 搜索、筛选或排序改变结果集时清空选择；取消批量弹窗不清空选择。
- 选择期间隐藏 applied-filter chips 与列表维护提示，避免同一工具栏区域出现两套上下文；退出选择后按原 query 恢复。

## Applied Filters

正常浏览模式下，已生效筛选必须显示为可移除 chip；上下文选择模式可暂时隐藏，退出后按原 query 恢复：

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

## Workbench And Decision Panes

需要“左侧队列 + 右侧工作区”的页面（插件管理、待确认收件箱）使用 `components/workbench` 的 `WorkbenchShell`、`WorkbenchMain`、`WorkbenchRail`、`WorkbenchRailHeader`、`WorkbenchTabs`、`WorkbenchStatusPill`，不要另建一套壳层。

待确认收件箱在此之上再收敛决定流程。三类领域（扫描资源、影片刮削、演员名称冲突）共用 `PendingDecisionParts` 的原语：

- `PendingWorkspace`：展示对象、待办动作、原因与状态，并按 `alert` / `tabs` / `confirm` / `overlays` 插槽组织外框。modal 走 `overlays`，避免被工作区的 `overflow: hidden` 裁掉。
- `PendingStep`：分步引导。每个领域的顺序都是“先选择，再预览影响”。
- `PendingImpact*`：影响预览。值变化用 `PendingImpactRow`（旧值 → 新值 + 动作），只有归属或写入目标时用 `PendingImpactPair`。
- `PendingConfirmBar`：底部只保留一条常驻确认栏，同时说明本次改动的摘要与作用范围。低频操作通过 `secondary` 插槽中的 `PendingSecondaryActions` 收进“更多处理”浮层，主操作保留在右侧。
- 番号冲突使用 `PendingChoice` 展示具体番号和来源；先选择、再预览、最后显式确认，不通过多个并列按钮直接提交。
- 媒体库筛选仅在扫描分类显示并生效，切换到其他分类时清除该筛选。
- 待确认页顶部采用局部两行布局：标题与当前结果数一行，`WorkbenchTabs` 分类与媒体库筛选一行。筛选使用独立定宽容器，不放入分类项内部；窄容器下筛选整体换行、分类单行横向滚动。该工作区不套用列表搜索工具栏的左右分隔结构。
- 分类数量为零时隐藏徽标；空状态文案对应当前分类和媒体库范围，指定媒体库无结果时提供“查看所有媒体库”。

新增待确认领域时扩展这些原语，不要在单个 pane 内复制工作区骨架或影响预览布局。

## Styling Rules

- 组件样式优先使用 `--surface-*`、`--text-*`、`--border-*`、`--control-*`、`--focus-*`、`--motion-*`。
- 页面中避免 hardcoded 颜色、阴影、圆角和间距。
- inline style 仅用于真实动态值，例如虚拟列表定位、进度条宽度、图片缩放变换。
- 可复用视觉模式应沉淀为 class，而不是散落在 JSX 中。
- 新增或重构的组件样式写在同名 `ComponentName.module.css`，由组件自己导入；全局 CSS 只保留 token、reset、应用壳层和迁移期 legacy 样式。`npm run check:css-architecture` 以基线方式拦截全局 class 增长，详见 `CSS_MAINTAINABILITY_PROPOSAL.md`。
- 跨组件共享的视觉规则提升为 React 原语（props seam），不要靠调用方拼接全局 class。
- 选中、就绪这类状态优先用 `aria-*` 或 `data-*` 属性选择器表达，不新增全局 `.is-*`。

## Migration Checklist

### Settings forms

- 功能启用/关闭统一使用 `Switch` / `SettingsSwitchRow`，多项勾选使用 `Checkbox`。控件形态不决定保存时机；需一起提交的字段使用草稿和 `SettingsFormActions`，Switch 也在保存后生效。迁移、加解密等任务使用动作按钮和 `ConfirmModal`。
- 图标、颜色等带标题的选项组使用 `AppFormChoiceGroup`；标签与内容间距由组件维护，禁止依赖 fieldset 外层 gap。
- `SettingsFormActions` 默认用于内容底部并保留 16px 间距，标题旁的操作必须指定 `placement="header"`。页面不额外补偿操作栏的顶部间距。
- `useSettingsDraft` 保留未提交输入，只同步未编辑的字段。服务器刷新与本地修改同一字段时展示冲突提示；规范化保存值使用 `accept(saved, submitted)`，保留保存期间继续输入的内容。
- 草稿表单通过 `useSettingsFormGuard` 登记 dirty、busy、保存和放弃处理。分类、子页签、作用域切换及返回操作统一提供继续编辑、放弃、保存后离开；组件内关闭弹窗也使用此入口。
- 保存状态属于实际提交组；串行保存的互斥与版本号由命令入口的 ref 管理，不用过时渲染闭包里的 busy 值阻止后续组。
- 测试连接说明使用的是当前草稿还是已保存值。代理测试使用当前输入；模型测试使用已保存连接，连接有草稿时要求先保存。
- `SettingsWorkspaceShell` 只负责分类导航、子页签和内容面板，不重复显示分类大标题、简介或笼统的“全局设置”。子页签数据统一来自 `settingsRoutes.ts`；保留面板的无障碍名称与页签关联。
- 内容卡片标题负责分组；具体媒体库名称、切换器、状态与操作保留。作用范围、生效时机及操作提示紧邻对应设置或按钮，不再集中放在页面顶部。

### General

新建或重构页面时，按下面清单检查：

- 列表页根节点使用 `list-page`。
- 详情页根节点使用 `detail-pane`。
- 列表页 toolbar 使用 `ListToolbar`。
- 改变结果集的筛选状态写入 URL query。
- 已应用筛选使用 `AppliedFilterBar`，但搜索词只保留在搜索框内。
- 可滚动详情使用 `scroll-body--scroll`。
- 自带滚动视口的虚拟列表或固定填充列表使用 `scroll-body--fill`；依附外部滚动容器的连续网格使用 `scroll-body--scroll`。
- 破坏性操作进入确认 modal。
- 静态视觉值进入 CSS class 和语义 token，并写在组件同名 `.module.css` 中。
- 主从工作台复用 `components/workbench`；待确认类决定复用 `PendingDecisionParts`。
- 动态尺寸、位置、进度、变换才允许 inline style。
- 新增可复制内容时添加可选中语义；新增交互卡片/图片时保持不可选中。
- 空状态按父容器选型：固定高度面板用 `fill`，滚动详情区块用 `compact`（约 140px），整页无数据用 `page`。


## 桌面连续浏览组件

- `useContinuousPage` 适配 `items / total / offset` 和仅提供 `hasMore` 的既有接口。最多保留三页；后者只预留下一页空间，读到末页后确定总量。禁止累计追加所有历史页。
- `ContinuousGrid` 用于规则网格与固定高度候选行，`ContinuousPosterGrid` 复用海报卡片及封面比例。详情使用已有外层滚动容器（可通过 `scrollRef` 明确指定）；候选弹窗使用固定高度独立视口。焦点留白、滚动条占位和状态色沿用语义 token。
- 搜索/对象会话隔离请求。页失败不移除其他页或占位高度；重试只读当前保留窗口。关闭候选弹窗后旧请求不更新新会话。
- 选择状态存储稳定 ID；完整名称、修订及业务资格在确认时通过现有后端读取验证。已选项与确认区不属于虚拟候选 DOM；不能从当前候选页反推全部选择。
- 方向键按行列移动，遇到未加载目标先读取再聚焦；Tab 只遍历已存在的交互控件。文本输入保留编辑按键。回收焦点所在页时保留焦点单元容器；数据重新进入窗口后再恢复交互目标。
- 待确认处理、扫描历史和审计保持显式分页。演员写真主列表、候选与预览，本轮保持原实现。
