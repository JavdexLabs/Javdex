# UI Component Contracts

本项目是高密度本地媒体库工具。组件规范的目标是让页面保持安静、紧凑、稳定，并让搜索、筛选、编辑、维护这些高频动作在各页面中表现一致。

## Layout Surfaces

- `Layout`：全局桌面壳，包含侧边导航、主内容区和全局覆盖层；样式归入 `Layout.module.css`，不输出旧 `app-shell` 类。背景状态通过自身 data 属性选择，背景表面仍以语义变量传递给页面。
- `ListPage`：列表面的根容器，内部通常包含 `PageHeader` 和 `ListSurface`。
- `DetailPane`：详情面的根容器；嵌套详情打开时传 `stacked`，由组件隐藏底层交互。
- `DetailPaneOverlay`：详情内的下一层覆盖详情，与 `DetailPane` 配合使用。
- `ScrollViewport`：页面滚动边界。自带滚动视口的虚拟列表或固定高度内容使用 `variant="fill"`，普通详情使用 `variant="scroll"`。`PageContent` 负责默认内容留白，`ScrollRegion` 承载滚动区和浮动回顶按钮。
- `ClassificationDetailSurface`：导演、系列、机构详情共用的滚动内容间距与关联影片标题；外层仍使用 `ListPage`，不叠加旧的 `organization-detail-page` 类。

页面组件组合这些既有原语，不在页面根部临时创造滚动或定位模型。设置工作区的布局与排版由 `SettingsWorkspaceShell.module.css` 持有，不再使用旧 `scroll-body-inner--settings` 类。背景图通过应用壳提供的 `--list-page-background`、`--page-header-background` 和 `--page-header-border` 传递，不穿透组件内部 class。

侧栏主导航与媒体库导航共用 `SidebarNavRow` / `SidebarNavLink` / `SidebarNavIcon` / `SidebarNavLabel`。原语只持有视觉和原生属性／ref；目标、query 记忆、点击拦截、离开保护和徽标回调由调用方保留。`active` 仅补充列表根的视觉选中，原生 `aria-current` 仍由 NavLink 的路由匹配决定；`reserveBadgeSpace` 明确预留徽标位置，不从 class 推断业务。媒体库的颜色、警告及截断由自身 Module 和布局入口持有。

`AppBrand` 与 `NavIcon` 自己管理品牌／图标样式及响应式字号。`AppBackgroundLayer` 持有背景及淡入动画，调用方只传图片，不再传全局动画类；横竖图判断、contain 几何和 ResizeObserver 动态计算保持原实现。系统减少动画偏好仍属于 document reset，不拆进功能组件。全局 `selectable-text` / `copyable-text` 是文档文本选择契约，不作为功能布局桥接。

`PluginDevPanel` 通过显式 `presentation="settings"` 使用嵌入设置页的无边框、紧凑字号及双栏布局，默认 `standalone` 保留独立面板布局。设置页调用方必须传入该语义；不通过祖先的 class／data 标记推断展示模式。工作区宽度仍由既有 `settings-workspace` 容器查询响应，两种模式的响应式优先级均由面板 Module 持有。

`FloatingLayer` 自己持有固定定位与交互层级，忽略调用方 inline style 的 position／zIndex；测量得到的 top／left、可见状态及调用方动态宽度继续保留。弹层基准使用 `--layer-overlay`，嵌套深度由交互 Module 配合 `--layer-step` 决定，Toast 使用 `--layer-toast`；不能靠追加更大的硬编码数字解决遮挡。虚拟网格的内层全宽归各自 Module，清除 react-window 提供的 inline width；视口清除 inline overflow 后使用自身滚动策略。计算高度、单元坐标和与行高／列步长共用的间距仍由几何计算持有，不在 CSS 复制常量。头像裁剪视口的宽高由 Module 使用 `--avatar-view-size`，绑定共享 `AVATAR_VIEW_SIZE`，避免视觉与导出算法尺寸分叉。

交互层统一通过 `useInteractionLayer` 注册，由 `InteractionLayerOwner` 传递父子所有权（React portal 保留所有权，但不改变密度的 DOM 继承）。Escape 只交给最上层，已处理或输入法组合中的按键不再次关闭父层；忙碌/不可关闭弹窗仍消费 Escape。模态层拥有背景 inert、Tab 顺序、返回焦点和计数式滚动锁；portaled 子菜单插入其触发按钮之后，但尊重显式负 tabIndex。非模态浮层因 blur/Tab 关闭时，不抢回用户已经移动到其他控件的焦点。图片预览与播放观看层共用 `OverlayHistoryProvider` 的唯一临时历史写入器，每层独立 token；普通确认弹窗不写返回栈。NFO 前台任务保留卸载保护、显式停止与全局快捷键禁用策略；其错误详情等子层继承父任务的快捷键拦截，Escape 仍只关闭最上层。

`className` / `bodyClassName` 是布局插槽，不是视觉 variant 或业务状态输入；按钮/输入的外观由自身 Module 与显式 variant/density 决定。全局 token 只承载共享语义；只被一个 Module 消费的功能变量归该 Module 的实际作用域，portaled 区域必须在自身根上声明。CSS 架构检查阻止单所有者 classification/organization 变量重新进入全局。

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

- `Button variant="primary"`：只用于提交、播放、开始主要任务。
- `Button variant="ghost"`：用于详情页维护动作或低强调动作。
- `Button variant="danger"`：用于破坏性动作；真正执行前必须有确认。
- 小型按钮使用 `Button size="sm"`，目标尺寸仍需满足最小点击区域；不要使用已移除的 `.btn-sm`。
- 纯图标按钮优先使用 `IconButton`，并提供可访问名称。
- Button 的视觉由自身 Module 持有，不输出旧 `btn` 类。设置壳传递 `--workspace-button-font-size`／`--workspace-button-min-height` 保留 12px／32px 的实际密度；独立按钮仍采用原有默认或小尺寸。工具栏显式控制高度，文字按钮的最小高度消费同一密度变量，图标按钮不受文字密度影响。不要用全局类或祖先选择器恢复这条桥接。
- 相邻的执行动作使用 `SegmentedActions` / `SegmentedAction`，通过 `size="sm"` 保留原有 24px 紧凑动作尺寸，不拼接旧 `btn-segment`。普通命令不添加 pressed 状态；切换型命令由调用方明确传 `aria-pressed`。选项筛选仍使用 `SegmentedControl` / `SegmentedOption`，不把两类业务交互混成一个隐式选择模型。
- IconButton 自己持有外框、尺寸、tone 和 glyph 样式，调用方提供可访问名称、原生属性和布局 class，不依赖旧 `icon-btn` 桥接。

不要用临时符号代替可复用图标控件；确实需要文字命令时，按钮文案应短、明确。

## Popovers And Modals

- 跨设置概览、插件连接及删除确认的警告/信息条使用 `NoticeBanner`；`tone` 决定语义配色，`NoticeBannerCopy` 和 `NoticeBannerActions` 承载文案与操作。调用方只保留自身的图标和特殊布局，不重新定义通知外框。
- 筛选使用 popover，按字段分组，底部放重置/应用或关闭动作。
- 列表筛选弹层使用 `FilterPanelAnchor` 定位、`FilterPanelShell` 承载外框、`FilterPanelContent` 管理标题/滚动内容/操作栏；两列字段用 `FilterFields` 与 `FilterField`。筛选选择框用 `SelectControl variant="filter"`，文本输入用 `TextInput variant="filter"`，避免页面选择器穿透控件内部样式。
- 阻塞式确认、编辑表单、批量任务配置使用 modal。
- 实体编辑弹窗使用 `EditForm` 和 `EditFormFields` 管理表单栈与双列字段网格；需要较大间距时选 `relaxed`，已有自定义布局用 `custom`。跨两列的保留旧名复选项使用 `EditFormCheckRow`，不要恢复旧全局布局类。
- `EditFormField` 负责直接子级的输入宽度与 textarea 最小高度、行高；嵌套控件（如 `ClassificationPicker`、带单位输入）由其自身 Module 保证内部输入宽度，不通过父级全局 class 穿透。
- 单行与多行编辑分别使用 `TextInput`／`TextArea`，保留原生属性、ref 和事件；视觉及焦点由共享输入 Module 持有，不再使用旧 `text-input` 类。字号默认 13px；迁自旧设置输入的调用方显式传 `density="workspace"`，由设置壳的 `--workspace-input-font-size` 保留原有 12px 密度，壳外回退 13px。已有默认／筛选输入不自动继承该变体，避免改变当前有效字号。`TextArea` 自己持有稳定滚动槽；宽度、最小高度和行高仍由表单布局负责。
- 编辑表单中的封面/头像区使用 `EditFormSection variant="media"` 保留 10px 上下内边距；普通分区使用默认变体，不再给 Modal 添加 `modal-entity-edit` 功能类。
- `ImageImportField` 自己管理横向/纵向布局、宽/方预览、占位与操作区；调用方只传 `layout`、`previewShape`、当前图片和动作，不再依赖全局 `image-import-*` class 或静态 inline 布局样式。
- `VideoResourceImportModal` 使用共享 `TextInput`；链接／大小行、读取反馈及提交错误由自身 Module 管理，不依赖全局资源导入或整宽控件 class。保留单条、媒体库添加、编辑、STRM 和远程模式的既有资格与提交语义。
- `DetailPage` 的修正番号、本地资源标签输入使用共享 `TextInput`；操作提示、可复制路径及整宽控件由页面 Module 持有。合并、拆分、移除及最后资源确认沿用原有领域行为，不恢复已经无效的旧表单 class。`DetailIconButton` 自己定义忙碌动画，不依赖全局 keyframe。
- modal 最大高度受视口约束，内部内容允许滚动。
- danger modal 只在确认动作上体现危险，不把整个弹窗做成高饱和警告样式。
- 分类合并和导演选择的文本候选使用 `ClassificationChoiceList` / `ClassificationChoiceRow`；调用方提供 option/radio 语义、名称、说明及选中值，候选圆点与列表外框由原语持有。分类候选空态使用 `ClassificationChoiceEmpty`，不依赖全局候选 class 穿透 `EmptyState`；带头像的连续演员候选保持独立布局。
- 分类删除与机构角色移除使用 `ClassificationDeleteNotice` 管理影响预览的加载提示、可复制正文及错误；领域风险和保留说明仍由调用方提供。不要恢复已无样式的旧确认内容／安全说明 class。
- 编辑表单的 `Modal.onConfirm` 返回实际提交 Promise，不使用 `void save()` 截断；失败需抛出给 Modal，才能在原表单保留错误及草稿。业务冲突的专用处理流程可以先消费对应错误。
- Modal 在提交期间锁定重复确认、取消、Esc 和遮罩关闭；自定义 actions 仍由调用方传入 `busy` 并禁用操作。切换编辑对象应通过 key 创建新会话，避免旧提交污染新草稿。
- Modal 的 chrome、size、说明和各内容区由自身 Module 持有，不输出旧 `modal-*` 类；说明保留原有 `aria-describedby`，调用方布局使用 `className` / `bodyClassName` 或 `data-modal-part` 插槽，不用 CSS 类推断提交和关闭行为。`AppFormSection` 的标题、说明和操作布局也归自身 Module，不恢复旧 `app-form-section-*`。
- 默认确认按钮保留固定文案；共享 `Button` 从空闲起传 `busy={false}` 可预留稳定指示槽，忙碌时禁用并设置 `aria-busy`，减少动态效果时不旋转。

## Cards And Media Items

- 媒体卡片是重复信息单元，圆角最大 8px。
- 导演、系列和机构详情的资料卡统一使用 `ClassificationProfile`；页面提供领域字段，组件负责标题、图片裁切、别名、简介、链接及隐私模式样式。
- 导演、系列和机构列表卡片统一使用 `FacetCard`；页面提供封面、名称、数量和打开详情行为，卡片按分类决定封面裁切并自行处理隐私遮罩。
- 别名与插件字段 chip 的移除操作统一使用 `ChipRemoveButton`；别名随父 chip 悬停/聚焦显示，插件字段保持常驻，勿在页面重复实现按钮样式。
- hover 可以改变边框、阴影或轻微位移，但不能造成网格重新排布。
- 封面、标题、番号、状态是主视觉，装饰性元素应保持克制。
- 长标题、路径、标签必须有截断、换行或稳定宽度策略。
- 卡片、封面、头像、画廊缩略图和预览图默认不可复制选中，避免拖拽/点击时误选图片或 UI 文案。
- 桌面 `ImagePreviewLightbox` 自己管理预览壳、工具栏、缩放、滑动及缩略图样式；滑动宽度读取显式 stage ref，不依赖 CSS 类名。调用方通过既有 `navigationStatus` / `toolbarActions` 插槽提供状态与命令，保留有界图片窗口、全局计数及跨页回调；只读 data 标记用于测试定位，不作为业务状态来源。
- 分类主图编辑器自己管理预览和候选封面的隐私遮罩；只读取根节点的隐私范围契约，不恢复全局图片 class。遮罩不得拦截来源按钮、状态或图片选择交互。

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
- 提交失败优先留在对应表单，详情折叠且正文可选择复制；全局错误 Toast 不自动消失，相同错误去重，提供完整详情、复制和手动关闭。成功及普通信息提示仍自动消失。

### Empty height model

按**父容器是否有固定可视高度**选择变体，不要一律拉满或一律很小。

| 场景 | 父容器特征 | 变体 | 高度行为 | 例子 |
|------|------------|------|----------|------|
| 固定面板 | flex/grid 子项有明确可用高度（`flex:1` + `min-height:0`） | `fill` | 铺满父级初始可视高度 | Agent「对话」「结果」空状态 |
| 滚动详情区块 | 页面本身会滚动，空状态只是其中一个 section | `compact` | 固定带高 `--empty-inline-min-h`（140px），与样张空状态一致 | 影片样张、演员写真、详情内「暂无关联影片」 |
| 整页/列表主区 | `scroll-body` 内整页无数据 | `page` | 可占满滚动视口 | 媒体库/演员列表无结果 |
| 弹层列表 | modal 内列表区 | `modal` | 跟随弹层内容区伸缩 | 选清单、合并演员 |

规则：

1. **固定高度父容器 → 铺满。** Agent 对话日志、结果面板这类右侧工作区，空状态必须用 `EmptyState variant="fill"`，让首屏不出现「上面一小块空、下面大片死白」。
2. **会滚动的详情区块 → 中等带高。** 样张/写真等 section 空状态用 `compact` +（可选）`sample-empty`，高度对齐样张空状态（`--empty-inline-min-h: 140px`）。禁止让这类空状态 `min-height: 100%` 撑满整个详情滚动区。
3. **不要把「铺满」规则套到所有 EmptyState。** 仅 `page`（整页）或 `fill`（固定面板）可以占满父级；`compact` 永远是内容带，不是视口填充。
4. **新增空状态先问父容器。** 若父级是固定高度工作区，选 `fill`；若父级在长页面里只是一块内容，选 `compact`。

EmptyState 的图标、标题和说明由自身 Module 管理；特殊说明布局走已有 `descriptionClassName`，不恢复旧 `empty-state-*`。只读 `data-empty-variant` / `data-empty-part` 供检查定位，不作为业务状态来源。

## Workbench And Decision Panes

需要“左侧队列 + 右侧工作区”的页面（插件管理、待确认收件箱）使用 `components/workbench` 的 `WorkbenchShell`、`WorkbenchMain`、`WorkbenchRail`、`WorkbenchRailHeader`、`WorkbenchTabs`、`WorkbenchStatusPill`，不要另建一套壳层。

工作台原语的样式由 `Workbench.module.css` 持有；调用方通过已有 `className`／`tabClassName` 定制自身布局，不依赖旧全局 workbench 类。页签选中样式读取 `aria-selected`，保留 roving focus、方向键和 Home／End 跳过禁用项的行为。只读 `data-workbench-part` 供自动化定位，不作为业务状态来源。

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
- 新增或重构的组件样式写在同名 `ComponentName.module.css`，由组件自己导入；全局 CSS 只保留 token、reset 和 document 基础契约，应用壳层也由自身 Module 持有，不恢复 legacy 功能表。`npm run check:css-architecture` 以基线方式拦截全局 class 增长及 className／classList 行为推断，详见 `CSS_MODULE_MIGRATION.md`；最初方案见 `CSS_MAINTAINABILITY_PROPOSAL.md`。
- 跨组件共享的视觉规则提升为 React 原语（props seam），不要靠调用方拼接全局 class。
- Web `ResourceList` 的卡片、选中态、动作及统一反馈由 `ResourceCard.module.css` 持有，复制兼容文本框使用同模块的静态 class。`ImagePreview.module.css` 仅在局部 root 下覆写 YARL 已知部件；第三方原表导入限定在预览适配器，不允许其他 Web Module 借 `:global` 穿透应用宿主。预览的键盘隔离使用独立 `web-image-preview` 标记，不读取样式类名。
- Web `WebButton`／`WebChipLink`／`WebTextInput` 持有共用控件样式，保留原生属性与 ref，不强制把 button 默认类型改成非提交；`variant`／`appearance` 只表达实际视觉差异。`WebBrand` 自持品牌样式，登录与顶栏复用而不额外包裹。`Login`／`PairLogin` 自持页面样式；`LoginForm` 共享字段、记住设备行、说明和提交布局，不靠父页面穿透配对子组件。触屏尺寸与焦点须检查实际计算结果，不以 CSS 声明或截图初态代替按压／禁用状态验收。
- Web 浏览壳、搜索、侧栏、范围弹层、影片卡片和网格分别由 `WebLibraryShell`、`WebSearch`、`WebSidebar`、`WebCollectionPicker`、`WebVideoCard`、`WebVideoGrid` 持有同名 Module。壳只组织原生区域与内容槽，不加载数据或管理路由；范围选择先关闭弹层，不变项不导航，URL 与切换焦点策略仍由调用方持有。卡片转发原生 anchor 属性和 ref，网格的单 Tab 入口与 onFocus 必须到达实际 anchor。焦点及测试定位用独立 `data-web-*` 标记或原生区域语义，不读取 CSS 类名；侧栏活动项显式使用 data-active，避免把无效范围参数误当成“全部”。
- `WebHomeDiscovery` 持有首页布局及原有请求／重试／焦点逻辑；刷新保留已有网格，进入详情只隐藏、不重载首页。`WebStatus` 持有统一提示布局，没有 retry 时为 status，有 retry 时为 alert；样式迁移不改变状态播报、重试入口或加载资格。
- `WebBrowseHeading`、`WebBrowseSort`、`WebChipRow`、`WebPagination` 持有结果标题布局、排序、chip 行与分页的同名 Module。加载中的总量用破折号，零结果仍显示 0；排序保留空值默认和未知参数不选中的语义。chip 行在结果筛选与详情标签间复用，applied 只增加非空行底部间距，并转发原生 div 属性／事件／ref。分页仅表达受控页号及边界禁用，URL、筛选清除与 page 重置仍由列表控制器处理；焦点和脚本定位用独立标记，不借助样式 class。
- `WebDetailPage` 持有详情、原生播放器、封面回退、资料与剧照布局；`WebCastMember` 自持演员卡片，父页面只持有演员网格布局。主资源选择、明确切换资源、默认暂停、播放重试、预览历史与焦点恢复保持原有业务，不在样式迁移中另建控制层。`WebText tone="muted|danger|eyebrow"` 复用文本语义，仍输出唯一原生 p 并转发属性／事件／ref；调用方通过 className 表达自己的位置／尺寸，详情资源说明用局部 resourceNote，不穿透子组件的文本类。方向键排除跳到内容入口使用 data-web-skip，Tab 仍可到达它；行为代码不读取 Module 生成名或旧 skip 类。
- 选中、就绪这类状态优先用 `aria-*` 或 `data-*` 属性选择器表达，不新增全局 `.is-*`。

## Migration Checklist

### Settings forms

- 功能启用/关闭统一使用 `Switch` / `SettingsSwitchRow`，多项勾选使用 `Checkbox`。控件形态不决定保存时机；需一起提交的字段使用草稿和 `SettingsFormActions`，Switch 也在保存后生效。迁移、加解密等任务使用动作按钮和 `ConfirmModal`。
- 多行开关外框使用 `SettingsToggleList`，紧凑间距传 `compact`；特殊外框通过显式 `className` 调整。防窥范围行的横向留白通过 `--settings-switch-row-pad-x` 传给行自身，不穿透旧全局 class。`SettingsCard.headerClassName` 只定制标题区布局，不传到卡片 DOM。
- 外观设置的主题选项使用 `ThemeChoice`，概览色块复用 `ThemeSwatch`。局部 `data-theme` 仅选择预览 palette，预览角色在自身 Module 绑定；应用主题仍由 `applyTheme` 设置根节点。主题键盘选择和保存时机由调用方保留，不复制每个主题的硬编码颜色规则。
- 图标、颜色等带标题的选项组使用 `AppFormChoiceGroup`；标签与内容间距由组件维护，禁止依赖 fieldset 外层 gap。
- `SettingsFormActions` 默认用于内容底部并保留 16px 间距，标题旁的操作必须指定 `placement="header"`。页面不额外补偿操作栏的顶部间距。
- `useSettingsDraft` 保留未提交输入，只同步未编辑的字段。服务器刷新与本地修改同一字段时展示冲突提示；规范化保存值使用 `accept(saved, submitted)`，保留保存期间继续输入的内容。
- 草稿表单通过 `useSettingsFormGuard` 登记 dirty、busy、保存和放弃处理。分类、子页签、作用域切换及返回操作统一提供继续编辑、放弃、保存后离开；组件内关闭弹窗也使用此入口。
- 保存状态属于实际提交组；串行保存的互斥与版本号由命令入口的 ref 管理，不用过时渲染闭包里的 busy 值阻止后续组。
- 测试连接说明使用的是当前草稿还是已保存值。代理测试使用当前输入；模型测试使用已保存连接，连接有草稿时要求先保存。
- `SettingsWorkspaceShell` 持有工作区布局、排版及密度变量，负责分类导航、子页签和内容面板，不重复显示分类大标题、简介或笼统的“全局设置”。子页签数据统一来自 `settingsRoutes.ts`；保留面板的无障碍名称与页签关联。状态文字与步进单位由自己的 Module 消费 caption 密度；卡片标题布局使用已有 `headerClassName`，不依赖属性选择器穿透旧 class。作用域仍按 DOM 继承，不新增 React 上下文改变 portal 的密度。
- 设置页空态使用 `SettingsEmptyPanel` 的 `plain`、`dashed`、`compact` 变体；特殊容器用本组件的 `className`，说明内容排版用 `descriptionClassName` 传入调用方 Module 类，不依赖 `settings-empty-panel` 全局选择器。
- 内容卡片标题负责分组；具体媒体库名称、切换器、状态与操作保留。作用范围、生效时机及操作提示紧邻对应设置或按钮，不再集中放在页面顶部。

### General

新建或重构页面时，按下面清单检查：

- 列表页根节点使用 `ListPage`。
- 详情页根节点使用 `DetailPane`，嵌套详情使用 `DetailPaneOverlay`。
- 列表与详情共用路由时，由 `ListDetailShell` 保留列表挂载和滚动状态，并承载详情叠层；背景图模式通过应用壳的语义变量调整叠层表面。
- 列表页 toolbar 使用 `ListToolbar`。
- 改变结果集的筛选状态写入 URL query。
- 已应用筛选使用 `AppliedFilterBar`，但搜索词只保留在搜索框内。
- 可滚动详情使用 `ScrollViewport variant="scroll"`（通常由 `DetailScrollBody` 组合）。
- 自带滚动视口的虚拟列表或固定填充列表使用 `ListSurface variant="fill"`；依附外部滚动容器的连续网格使用 `variant="scroll"`。
- 破坏性操作进入确认 modal。
- 静态视觉值进入 CSS class 和语义 token，并写在组件同名 `.module.css` 中。
- 主从工作台复用 `components/workbench`；待确认类决定复用 `PendingDecisionParts`。
- 动态尺寸、位置、进度、变换才允许 inline style。
- 新增可复制内容时添加可选中语义；新增交互卡片/图片时保持不可选中。
- 空状态按父容器选型：固定高度面板用 `fill`，滚动详情区块用 `compact`（约 140px），整页无数据用 `page`。


## 桌面连续浏览组件

- `useContinuousPage` 适配 `items / total / offset` 和仅提供 `hasMore` 的既有接口。最多保留三页；后者只预留下一页空间，读到末页后确定总量。禁止累计追加所有历史页。
- `ContinuousGrid` 用于规则网格与固定高度候选行，`ContinuousPosterGrid` 复用海报卡片及封面比例。详情使用已有外层滚动容器（可通过 `scrollRef` 明确指定）；候选弹窗使用固定高度独立视口。焦点留白、滚动条占位和状态色沿用语义 token。
- 虚拟候选卡片通过自身 CSS Module class 获得布局、选中、禁用和焦点样式，不能依赖网格的直接子 button 选择器；候选实际位于虚拟单元内。分页验收按可见单元和接口页大小检查，不要求一页所有条目同时存在于 DOM。
- 搜索/对象会话隔离请求。页失败不移除其他页或占位高度；重试只读当前保留窗口。关闭候选弹窗后旧请求不更新新会话。
- 选择状态存储稳定 ID；完整名称、修订及业务资格在确认时通过现有后端读取验证。已选项与确认区不属于虚拟候选 DOM；不能从当前候选页反推全部选择。
- 方向键按行列移动，遇到未加载目标先读取再聚焦；Tab 只遍历已存在的交互控件。文本输入保留编辑按键。回收焦点所在页时保留焦点单元容器；数据重新进入窗口后再恢复交互目标。
- 待确认处理、扫描历史和审计保持显式分页。演员写真主列表、候选与预览，本轮保持原实现。
- 演员画廊和头像写真来源共用 `GalleryPagination`，沿用每页 60 项、上一页／下一页及全局页码；头像来源使用紧凑按钮并隐藏总量，画廊显示总量。查询、异步会话与图片预览仍由各自 hook 管理，分页原语不加载资料。

### 侧栏与窄窗刮削字段

`Layout` 的浏览导航中段独立滚动，品牌及底部待确认／设置入口不随中段被挤出视口；保留焦点留白和滚动槽。媒体库原有内部列表滚动契约保持不变。

`ScrapeFieldsModal` 在 760px 以下改为纵向自然高度内容，任务配置区不参与压缩，由共享 Modal 正文承担滚动，操作栏保持可达。鼠标验收必须实际点击写入字段，不得以强制点击或键盘操作替代遮挡检查。


## 备份与恢复设置

操作记录的终态行提供红色 danger“删除记录”按钮；下载中禁用，未结束和 recoveryRequired 不提供。点击后使用共享 Modal 二次确认并获取删除范围，默认只删记录。共享 Checkbox 明确选择清理 Javdex 托管的备份和临时文件，展示所在设备、目录及预计释放空间；不得删除原始备份和手动另存副本。恢复前的保护备份单独提示，恢复记录不连带清理它，仍被恢复任务使用时禁止文件清理。确认按钮随选择显示“删除记录”或“删除记录及备份”。加载和错误留在确认框中，不扩张历史行；取消后保留该行错误供重试。成功后移除该行并关闭其选中详情，文件清理失败则保留记录。

当前会话的资料库类型、实际地址与可操作状态显示在页首，不读取连接草稿。创建和恢复入口合为紧凑操作卡，未加密及不含原视频的说明常显，完整范围折叠。进行中的任务使用自然高度卡片，阶段进度原位更新，计数与耗时并排，摘要折叠；结束后归入历史记录并展开结果，若用户正在查看其他记录则保留其展开状态。历史记录使用两行紧凑布局，每页最多五条。“展开详情 / 收起详情”使用同一按钮和方向图标，关联 aria-expanded 与详情区域；详情在原行下方展开，记录位置、总数和操作按钮不因查看而改变。一次展开一条，路径可复制换行，缺失图片清单独立限高滚动，不预留空白。历史详情与当前任务、恢复向导使用独立状态，查看历史不能替换任务卡或重置目录选择。

错误只显示在对应操作或记录旁，不为正常状态预留反馈空白；历史行折叠时仍显示简短失败状态，完整错误使用原有详情展开。只读路径提示按错误路径所在设备处理，本机另存失败不能指向服务端。用户取消使用中性状态，不能重试已取消的传输。仅上传待续传及已生成备份的下载失败提供重试。未知大小不显示为“下载 0 MiB”。轮询失败保留上次结果并提示状态暂不可确认；轮询不得重新展开终态详情，也不得滚动页面。

旧版本备份在临时副本中升级后，准备恢复步骤显示来源与目标数据库版本及原包未修改的说明；目录与数量使用升级后的结果，仍须单独核对和确认覆盖。

目录映射行同时显示来源、选择状态和目标或舍弃关联的影响；已选择使用语义强调边框、底色和勾选图标，不仅靠说明文字区分。“仅保留资料”可再次点击撤销，也可重新选择目录。步骤面板统一裁切内层背景以保留完整圆角，正文与操作栏保留焦点留白。

缺失图片预检使用“核对缺失图片”步骤，数量常显，路径清单折叠且限高滚动；显式确认后才继续。备份记录及恢复预览持续显示省略数量和清单。失败或取消任务不占用导出运行状态。

运行中的备份与恢复必须显示忙碌指示、阶段说明和已用时间；快照细分为数据库复制、图片复制/解密、引用整理及校验，按真实阶段计数展示进度，不把文件尚未生成显示为 0 MiB。超过 30 秒没有新进度仅提示可能停滞，不判定失败；轮询失败在步骤内展示，恢复连接后清除。

“存储与导出”页签固定为资料库连接、图片资源、备份与恢复、导出影片资料。`BackupSettingsPanel` 沿用 `SettingsCard` 和共享按钮；明确显示当前作用目标、内容范围及未加密说明。恢复使用共享 Modal 的独立三步向导（核对来源、对应目录、确认恢复），固定标题、步骤条及操作栏，中间独立滚动，路径允许换行且预留滚动槽及焦点空间。“稍后继续”保留本次目录选择，最终覆盖需勾选确认，提交成功后关闭向导并在页内展示任务阶段；提交阶段不提供取消。

本地目录使用系统选择器，服务端使用 `RemoteRootPicker` 的挂载/子目录选择；该选择器的标题和确认文字可由调用方指定。每个目录未选择前不能进入确认。舍弃关联必须显式选择，展示移除数量并保留影片资料。仅完成检查不代表视频可播放。

操作记录来自持久任务状态；实际上传、打包、校验、目标备份、提交和下载分别展示。提交阶段不提供取消；失败保留原因和重试/重启处理提示。资料库身份变化后清空查询缓存并重建页面，关闭旧身份的弹窗和草稿界面。

### 资料库连接设置

当前连接使用紧凑状态栏，读取实际会话；技术身份信息折叠。连接与播放器使用独立卡片、独立草稿和保存操作；“应用连接”只保存模式与地址，播放器保存提交默认播放方式、程序路径与本机续播开关，离开保护覆盖两组草稿。播放器卡片在本地和远程模式均显示，播放方式保存仅影响下一次播放；选择内置仍保留外部程序路径。续播默认关闭，保存开启从下一次播放生效，保存关闭立即停止当前会话记录但不删除旧进度。清除全部本机进度使用共享危险确认 Modal，不随开关自动执行。播放器直接展示路径，“使用系统默认播放器”仅将系统关联程序填入草稿，保存或取消后清除提示；读取期间保留按钮文字，等尺寸图标切换为忙碌状态，并设置 aria-busy，避免操作区宽度变化。远程会话在连接卡片底部提供本机资料导入提示卡片：说明从本地转向服务端的适用场景、连接与写入授权前提，以及“存储与导出 → 备份与恢复 → 从本机资料库导入”的操作路径；简述替换目标、自动备份、源库保留及不上传原视频，并提供前往备份与恢复按钮。卡片自然高度，窄屏按钮换行。

开发中的内置播放由应用壳持有单一 `PlaybackPanel`，原生解码器不随页面或展示形态卸载。展开播放器占满应用窗口；收起后的底栏只占主内容区，左侧导航保持可用。续播选择区与非全屏设置面板位于画面外；Windows renderer 全屏控件与设置面板覆盖视频，显隐不改变画面尺寸。全屏顶部与底部分别按指针位置唤出标题栏与控制栏，暂停不自动唤出；打开设置时固定显示两者，关闭后恢复分区触发。共享 Modal 打开时原生画面避让，取消后恢复同一会话。错误动作面只展示 main 提供的受控原因，提供同资源重试、显式外部打开与关闭；不把原始网络／文件错误放入 Toast。详情成功打开不再额外用成功 Toast 覆盖播放控制区。

可见且非空的全局 Toast stack、下拉菜单与浮层显式标记为原生画面遮挡面；Windows renderer 控件模式仅裁剪与视频相交的矩形，其他适配隐藏相交的原生视图，消失后恢复同一会话，不暂停或重开内核。视觉遮挡与键盘所有权分别判定：播放器的非模态子菜单可持有 Escape，播放器仍是活动模态；新的共享 Modal 则使播放器避让。Toast 同时声明保留交互的反馈 surface，由共享模态背景 inert 逻辑排除其子树及必要祖先，普通背景仍保持 inert；Toast 按钮追加到当前模态的 Tab 顺序。反馈不注册新的交互层、不抢焦点、不取得 Escape 或滚动锁所有权，关闭／查看详情继续使用真实按钮，不允许点击穿透到播放设置。

轨道菜单同时展示可用标题、语言、编码与文件声道提示，不以标题覆盖其它字段。`channelCountHint` 是受限容器标记，不是设备输出；菜单旁明确说明。纯文本字幕可调字号，ASS/图像字幕禁用；选轨、外挂字幕和章节定位继续使用同一会话，保留暂停意图，不绕过主进程来源权限。

Windows 新适配通过 `rendererFullscreenControls` 能力使用 HTML 全屏控件，原生视频的 Tab 请求交回 renderer；隐藏的标题栏与控制栏不进入辅助技术和 Tab 顺序，键盘交接先显示控件再聚焦。macOS 及旧适配的全屏由原生视频区域和控件持有焦点／AX 名称，HTML 视频占位不重复进入辅助技术与 Tab。方向键优先调整当前滑杆，不同时触发影片快进。原生到 HTML 的聚焦请求只存在于当前会话，不持久化；停止、错误及退出全屏须同时归还系统 responder 和 DOM 焦点。macOS 基本系统 AX、双向 Tab 与正常详情触发按钮返回已有真实 GUI 验证，但完整读屏和跨平台验收尚未完成，不能由这些结构约定推断全部验收通过。

播放观看历史由稳定应用壳按已提交的会话展示事件管理，不按组件 mount/cleanup 或每个时钟 tick 写入。选项／全屏／展开依次响应系统返回；展开返回收起，底栏不拦截普通页面返回。显式停止或收起一次消费自身和子层的条目，迟到的旧 popstate 不关闭新打开的观看层。待选择的续播可收起但保持暂停与继续／从头选择，不绕过选择直接播放或进入全屏。设置和插件离开保护共用一个 Router blocker，只在真正变更业务路由时确认；不再各自插入历史 trap。macOS 快捷键与设置草稿共存已实测，现代触控板手势及物理返回键仍待验收。细节见 [返回历史合同](ROUTING_DESIGN.md#overlay-history)。

连接测试在地址下方固定单行反馈区原位替换帮助、测试中和结果摘要；长内容截断，完整结果与资料库身份通过“查看详情”弹窗展示。重复测试不清空上次结果，不插入额外段落，按钮文案保持“测试连接”，避免卡片高度及输入框宽度跳动。

### 设置页异步反馈组件

`SettingsFeedback` 在一个小按钮高度内呈现说明或状态，文本单行截断，长结果通过默认带边框的“查看详情”按钮打开共享 Modal；详情不可用时保持横向位置且移出键盘顺序。`SettingsFormActions` 将保存错误和冲突放入同一状态行，保留取消按钮的横向占位。`SettingsActionLabel` 使用 CSS 重叠网格按最长文案占位，不改变实际可访问名称。备份入口、播放器检测、MetaTube 服务测试、模型测试及授权反馈复用反馈行；用户主动展开的任务详情与新生成的数据列表仍允许自然增高。
