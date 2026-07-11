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

## Token Model

主题原始值仍由 `--bg-*`、`--text-*`、`--accent` 提供；组件应优先使用下面的语义层：

- Surfaces: `--surface-base`、`--surface-panel`、`--surface-elevated`、`--surface-control`、`--surface-control-hover`、`--surface-selected`
- Text: `--text-primary`、`--text-secondary`、`--text-muted`、`--text-accent`
- Borders: `--border-subtle`、`--border-strong`、`--border-accent`
- Controls: `--control-h-sm`、`--control-h-md`、`--control-h-lg`、`--control-pad-x`
- Focus: `--focus-outline`、`--focus-ring`
- Motion: `--motion-fast`、`--motion-med`

## Component Rules

- Toolbar: search on the left, global actions on the right, result count stable and right aligned.
- Filter popover: grouped fields, short labels, reset/apply actions at the bottom, selected filters mirrored as removable chips.
- Cards: 8px radius maximum for repeated media/facet cards, hover may change border/elevation but must not resize layout.
- Buttons: primary only for committing or starting major actions; ghost for low-emphasis actions; danger never filled unless destructive confirmation is explicit.
- Modals: 12px radius, max-height constrained to viewport, actions aligned to the end.
- Scroll containers: use `scrollbar-gutter: stable` for scrollable panes, lists, logs, code blocks, and popovers. Avoid `stable both-edges` inside dense panels because it creates unnecessary left/right whitespace; reserve it only for rare centered layouts that truly need symmetric gutters. Pair stable gutters with fixed min/max dimensions so loading, filtering, or expanding content never changes the container width. When a scroll container contains bordered cards, sections, logs, or code blocks, keep only a small inner gap between content and the scrollbar track so the thumb never visually covers borders.
- Text areas: multiline text inputs must reserve a stable scrollbar gutter by default. The readable text column must not rewrap or become narrower when the user types enough content to make the textarea scroll.
- Empty/loading states: concise, centered, and task-oriented; no decorative hero treatment.
- Empty height: `fill` inside fixed-height panes; `compact` (~140px via `--empty-inline-min-h`) inside scrolling detail sections such as samples/gallery.

## Reference Basis

- Fluent 2: semantic alias tokens and theme flexibility.
- Material color roles: role-based surface/accent mapping.
- Carbon data table guidance: toolbar as the home for search, filtering, display settings, and global actions.
- WCAG 2.2: visible focus, contrast, and target-size constraints.
