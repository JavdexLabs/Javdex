# UI Design Guidelines

本项目是高密度本地媒体库工具，界面目标不是营销展示，而是帮助用户快速扫描、过滤、编辑和维护大量条目。设计上采用“安静、紧凑、可预期”的桌面工具风格。

## Design Principles

1. 内容优先。海报、番号、标题、演员、标签和状态是主视觉，装饰只用于区分层级。
2. 渐进筛选。搜索保持常驻，复杂筛选放入弹层，已应用条件必须以 chip 呈现并可单项撤销。
3. 语义 token 优先。组件引用 `--surface-*`、`--text-*`、`--control-*`、`--focus-*` 等语义变量，不直接使用主题色阶。
4. 密度可控。列表页控件默认 36px，高频小按钮不低于 32px，所有可点击目标满足 WCAG 2.2 的 24px 最小目标尺寸。
5. 状态显性。hover、active、selected、disabled、focus-visible 都需要有独立视觉状态，键盘焦点不能只依赖默认 outline。
6. 长文本安全。标题、路径、标签、按钮文字必须允许截断、换行或拥有稳定尺寸，避免挤压相邻控件。
7. 选中克制。交互控件、图片、卡片和导航默认不可选中；详情文本、元数据、路径、输入框等明确可复制内容必须可选中。
8. 滚动稳定。任何会在交互中出现或消失纵向滚动条的容器，都必须预留滚动槽，避免内容宽度变化造成页面、弹窗或卡片跳动。
9. 主题克制。每个主题必须保持中性色为主体、强调色为点缀；避免整套界面被单一色相统治，尤其避免大面积紫蓝渐变、棕橙、深蓝或米色倾向。
10. 空状态高度看父容器。固定高度面板内的空状态应铺满可用高度；会随页面正常滚动的区块空状态只用中等固定带高，避免把详情页撑出大片空白。
11. 布局稳定。同一视口与任务上下文中，弹窗外框、操作入口及重复条目的尺寸和位置应可预期；加载、反馈、焦点和状态更新不得造成非必要跳动。用户主动增删内容、页面详情展开及响应式重排可以改变正文结构，弹窗仍保持外框稳定。

## Token Model

主题原始值仍由 `--bg-*`、`--text-*`、`--accent` 提供；组件应优先使用下面的语义层：

- Surfaces: `--surface-base`、`--surface-panel`、`--surface-elevated`、`--surface-control`、`--surface-control-hover`、`--surface-selected`
- Text: `--text-primary`、`--text-secondary`、`--text-muted`、`--text-accent`
- Borders: `--border-subtle`、`--border-strong`、`--border-accent`
- Controls: `--control-h-sm`、`--control-h-md`、`--control-h-lg`、`--control-pad-x`
- Focus: `--focus-outline`、`--focus-ring`
- Motion: `--motion-fast`、`--motion-med`

## Component Rules

### Form spacing and controls

- 桌面界面以指针操作为主：点击普通按钮、卡片和选择项时不出现键盘式焦点环；通过 Tab、方向键进入可操作控件时，焦点必须可见。外层选择卡片只在内部控件 `:focus-visible` 时画焦点环，选中状态独立于焦点状态。输入框及组合输入激活时继续显示本节规定的边框与外晕，下拉框展开状态继续可见。
- 纯展示内容不加入 Tab 顺序；可操作控件和需要键盘滚动的具名区域保留正确的焦点与语义。弹窗、菜单、下拉框保留进入、约束和关闭后的焦点恢复；不通过全局 CSS 或强制 blur 隐藏键盘焦点。快捷键必须有明确作用范围、可见的鼠标等价操作，并避开文本输入、中文输入法及系统组合键。

- 启用/关闭某个功能统一使用 `Switch`；带标题和说明的设置行使用 `SettingsSwitchRow`。多项勾选（字段、文件、媒体库、导出内容）及本次操作的确认项使用 `Checkbox`。不要在业务组件内另写裸 `input[type=checkbox]` 或开关外观。
- 控件形态与生效时机分开：需要保存的 Switch 只修改草稿，组内显示保存状态与操作栏；即时设置才直接保存。创建向导中的选项在创建时生效。
- 标签至控件使用 `--form-label-gap`（8px），同组字段使用 `--form-field-gap`（12px），分组使用 `--form-section-gap`（16px），内容至底部操作栏至少 `--form-actions-gap`（16px）。间距由共享组件负责，页面不要再叠加补偿 margin。
- `fieldset/legend` 不能仅依赖外层 grid/flex 的 gap；一组选择项使用 `AppFormChoiceGroup`，由 legend 的底部留白保证标题与内容分离。
- 底部保存栏使用 `SettingsFormActions` 默认 footer；位于卡片标题右侧的使用 `placement="header"`，不继承底部留白。状态与操作组成无外框的紧凑保存条，使用细分隔线与无框撤销图标，撤销按钮提供可访问名称，保存中、失败与冲突不改变外框宽度。错误与冲突默认仅展示短摘要，用户主动展开后在保存操作条紧邻下方显示四角圆角错误卡片，包含明细与可复制的技术详情，不再打开第二层弹窗。
- Checkbox 可见方框统一 16px，点击范围由外层 label 提供，至少 24px；Switch 保持共享组件尺寸，页面不得通过宽高覆盖成另一种控件。
- 文本、搜索、密码、数值、多行及选择输入激活时，统一将原有单层边框改为强调色，并添加柔和外晕；不再叠加独立 outline 形成双重描边。鼠标与键盘聚焦使用同一输入样式，边框宽度与控件尺寸保持不变。组合输入（别名、代码编辑器、数值步进器）的外框负责焦点提示，内层输入不重复描边；按钮、导航、复选框及滑杆保留各自焦点规则。
- `npm run check:ui-controls` 检查业务组件中的裸复选框和自制开关；合入前同时完成 CSS Module 检查及常用/窄窗口视觉验证。

### Other components

- Settings information hierarchy: 常用操作和直接影响保持可见；当前路径、版本、数量与生效状态使用可读值或状态标签；校验规则、完整操作流程、平台限制及文件示例按需展开。每组最多保留一条简短导语，同一影响不在标题、字段和底部重复解释。删除范围、覆盖目标、权限前提等做决定所需的信息不能藏入说明折叠区。
- Settings composition: 同级分组使用统一卡片标题和间距；普通操作使用设置行，只读信息使用值行，开关组在卡片内采用平铺行与细分隔线，避免卡片套卡片。说明折叠统一使用方向图标和可键盘访问的标题，不为说明文字单独制造醒目的大面板。
- Settings navigation: 分类标签负责定位，内容标题负责分组；内容区不再重复分类名称与概括性简介。有子页签时紧接导航，无子页签时直接展示内容。作用范围和生效提示放在对应操作旁，保留具体对象名称及无障碍关联。
- 内部导航链接（包括侧栏、设置分类、首页入口和操作提示中的跳转）必须显式设置 `draggable={false}`，禁止浏览器原生链接拖拽；保持点击和键盘导航行为。需要拖拽排序的控件单独实现，不依赖链接原生拖拽。
- Toolbar: normal browsing mode keeps search on the left, global actions on the right, and the result count stable and right aligned. Contextual card-selection mode may temporarily replace this row with `SelectionToolbar`.
- Filter popover: grouped fields, short labels, reset/apply actions at the bottom, selected filters mirrored as removable chips.
- Cards: 8px radius maximum for repeated media/facet cards, hover may change border/elevation but must not resize layout.
- Buttons: primary only for committing or starting major actions; ghost for low-emphasis actions; danger never filled unless destructive confirmation is explicit.
- Modals: 12px radius, 同一次打开期间保持外框宽高和位置稳定，尺寸受视口约束；正文内部滚动，操作栏末端对齐。具体规则见下方 Layout stability。
- Scroll containers: use `scrollbar-gutter: stable` for scrollable panes, lists, logs, code blocks, and popovers. Avoid `stable both-edges` inside dense panels because it creates unnecessary left/right whitespace; reserve it only for rare centered layouts that truly need symmetric gutters. Pair stable gutters with fixed min/max dimensions so loading, filtering, or expanding content never changes the container width. When a scroll container contains bordered cards, sections, logs, or code blocks, keep only a small inner gap between content and the scrollbar track so the thumb never visually covers borders.
- Text areas: multiline text inputs must reserve a stable scrollbar gutter by default. The readable text column must not rewrap or become narrower when the user types enough content to make the textarea scroll.
- Focus clipping: scroll/clip containers around form controls must reserve `--focus-ring-space` on every edge. Shared form modals provide this space with padding and compensating margins; custom body styles must preserve it. Do not remove scrolling or replace the outer focus ring to hide clipping.
- Empty/loading states: concise, centered, and task-oriented; no decorative hero treatment.
- Empty height: `fill` inside fixed-height panes; `compact` (~140px via `--empty-inline-min-h`) inside scrolling detail sections such as samples/gallery.

### Layout stability

- 稳定要求适用于页面、弹窗、浮层、工具栏、表单、卡片和列表，不限于设置页。空闲、加载、成功、失败、禁用、选中、hover 和 focus 的切换不得改变控件外框、重复条目行高或相邻操作位置；边框、阴影和图标变化不能挤占额外布局空间。
- 弹窗按用途选择紧凑或较大的稳定尺寸，同一次打开期间不随加载、错误、切换页签/步骤及展开/收起详情重新计算外框高度或居中位置。简单确认框保持紧凑；包含多步骤、动态列表或可展开设置的弹窗使用明确的高度与视口上限，新增内容在正文内滚动，不通过撑高外框展示。
- 弹窗标题和关闭按钮固定在外框内；设有全局底部操作栏时，操作栏也保持可见和位置稳定。分组保存按钮可随所属正文滚动，但状态变化不得移动该组操作。窗口尺寸、系统缩放或用户显式调整窗口变化时允许响应式重排，所有操作仍须可达。
- 工具栏的搜索、排序、结果数与动作区保持稳定占位；表单反馈复用紧凑状态区。相同类型的折叠列表行保持一致高度，完整错误与长明细放到详情中。长标题、路径或翻译文案不得挤压相邻按钮，截断时提供可访问的完整内容入口。
- 图片、封面和异步预览在加载前确定宽高或宽高比；空态、加载占位和真实内容沿用所在面板的布局。刷新时保留已有内容，不卸载整个表单或列表，避免丢失草稿、滚动位置和键盘焦点。滚动条出现或消失不得改变内容宽度。
- 稳定不等于大面积留白。按钮空闲时不为忙碌图标留空，使用覆盖式忙碌提示保持尺寸；错误反馈只占紧凑状态区，长内容按需展开或限高滚动。不得为所有潜在内容预留最大高度，也不得裁掉必要信息或隐藏操作来维持尺寸。
- 普通页面中的主动增删条目、展开详情、改变运行模式及初次加载真实内容可以改变正文高度，不固定整个页面来阻止这些有意义的结构变化；这种变化不得隐式重置滚动或焦点。弹窗正文发生相同变化时仍遵守外框稳定规则。
- 验收在同一视口比较变化前后的外框、标题、关闭按钮、操作栏、控件和重复行边界，同时检查滚动与焦点。覆盖加载/重试、成功/失败、长文本、展开/收起、页签/步骤切换，以及 1440×900、1000×640、浅色/深色主题和减少动态效果偏好。

### Async feedback

- 测试、检测、保存、刷新和轮询遵循上述通用布局稳定要求；在相同窗口与内容结构下，按钮宽度、输入框宽度、卡片高度及后续内容位置不能因空闲、忙碌、成功或失败反复变化。
- 帮助、进度摘要和结果优先在同一个紧凑反馈行原位替换。不得先删除上次结果，再重新插入；刷新时保留已加载内容，直到新结果可用。保留旧结果时必须标明正在更新，不能将旧成功误报为本次成功。
- 不为可能出现的错误预留大块空白。普通操作反馈最多预留一行控件高度；长错误、身份信息和技术细节放入可键盘访问的详情弹窗或用户主动展开的区域，不能仅依赖 hover/title，也不能只截断而不提供完整内容。
- 加载按钮保持动作文案和原有尺寸，空闲时不为加载图标预留额外空白；忙碌提示覆盖在内容中央，原内容只在视觉上隐藏，继续撑住布局并保留可访问名称。必须切换阶段文案时，使用 `SettingsActionLabel` 按最长状态文案占位；隐藏占位内容不可产生重复可访问名称，不可进入 Tab 顺序。
- 保存错误复用保存栏的状态位置；取消操作与详情入口在状态变化时保持控件布局。用禁用、aria-busy 和可见状态说明表达忙碌，禁止通过整个表单卸载/重建表达刷新。
- 初次加载到真实内容、首次生成任务/预览、改变运行模式，以及用户主动展开详情按上述结构变化规则处理；弹窗只改变内部正文。任务阶段内的数值、计时和状态更新应稳定，必要时使用等宽数字与限高滚动。
- 验收覆盖 1440×900 与 1000×640、长中文错误与路径、空闲→忙碌→成功/失败→再次执行，比较按钮与卡片边界、后续内容位置、滚动位置及键盘焦点；同时检查浅色/深色主题和减少动态效果偏好。

## Reference Basis

- Fluent 2: semantic alias tokens and theme flexibility.
- Material color roles: role-based surface/accent mapping.
- Carbon data table guidance: toolbar as the home for search, filtering, display settings, and global actions.
- WCAG 2.2: visible focus, contrast, and target-size constraints.
