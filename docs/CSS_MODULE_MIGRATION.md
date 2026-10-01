# 页面级 CSS Module 全量迁移

目标：全部页面和关联组件的功能样式拥有明确的 CSS Module owner，移除迁移期全局功能样式；不能仅以页面已经 import module 判断完成。保留主题 token、reset、document 基础和有明确理由的第三方样式契约。桌面及 Web 页面均在范围内。保留现有未提交的业务与 UI 改动，不自动提交、推送或发布。

## 完成标准

- 页面专属及关联组件样式全部局部化；共享模式由 React 原语和语义 props 提供，不复制 CSS，不建立一个巨型共享 module。
- 每个迁移项同步删除旧规则及覆盖项；无遗留全局 class、动态拼接遗漏、靠 :global 保留功能样式的假迁移。
- 主题、密度、滚动、焦点、虚拟列表几何和业务行为不改变。静态 inline style 迁入 module，真正动态值保留。
- 最终全局样式逐条分类审计；原有 CSS 架构约束只收紧，不抬高债务基线。检查覆盖桌面、Web 及共享 UI。
- 类型、lint、架构检查、完整测试及生产构建通过；各页面相关状态在 1440×900 / 1000×640、浅深主题验证，Web 补充移动端规范要求。记录真实验证范围，不用组件测试代替整页视觉验收。

## 执行顺序与页面清单

按共享依赖先行、页面纵向收口的顺序推进。每批记录迁入 owner、删除旧规则、遗留依赖和验证，未完成项始终保留。

| 批次 | 页面／关联组件 | 状态 |
| --- | --- | --- |
| 0 | 全量清单、全局规则引用检查、生产 CSS 基线 | 清单／源码审计已完成 |
| 1 | HomePage、GlobalSearchPage；列表壳、计数、卡片和空状态 | 源码已收口 |
| 2 | LibraryPage、ActressesPage、PlaylistsPage；选择工具栏、筛选、排序和列表 | 源码已收口 |
| 3 | FacetListPage、DirectorListPage、SeriesListPage、OrganizationListPage | 源码已收口 |
| 4 | DetailPage、ActressDetailPage、PlaylistDetailPage、DirectorDetailPage、SeriesDetailPage、OrganizationDetailPage；详情、图片与编辑弹窗 | 源码已收口 |
| 5 | PendingCenterPage、PendingScanPane、PendingScrapePane、PendingResourceIdentityPane、PendingActressConflictPane、ConflictMergeActressesModal | 源码已收口 |
| 6 | SettingsPage、MediaLibrarySettingsPage/Tabs/Dialogs、RemoteRootPicker；所有设置 panel 与日志 | 源码已收口 |
| 7 | 插件管理与开发工作区、Agent 对话／结果／预览及独立覆盖层 | 源码已收口 |
| 8 | Layout 与剩余共享组件；移除 legacy 桥接、更新组件契约 | 源码已收口 |
| 9 | Web 所有路由页面、图片预览与共享 UI；移动端回检 | 源码已收口，模拟浏览器回归通过 |
| 10 | 全局残留逐条审计、完整回归、生产 CSS 体积及页面视觉验收 | 已完成；组件矩阵及无排除的 59 入口整页矩阵通过 |

本计划已完成。用户确认纳入的原有三层演员路由也已修复；完整测试、生产构建和不排除入口的整页矩阵均取得通过终态。此结论限定于本计划记录的源码审计和合成数据浏览器验收，不表示所有历史业务缺陷、真实资料库或跨平台原生 GUI 均已验收。截图差异和历史失败保留在下文。

## 起点

桌面 `styles/` 共约 13026 行（包括导入清单），另有根 styles.css；Web 尚有 styles.css 和 image-preview.css。已有 module 的页面仍可能依赖全局 class 和跨文件覆盖，不能直接打勾。当前工作区前序优化与架构改动均保留。

## 当前状态与验收边界（2026-10-01）

迁移阶段单列的八项待办现已按用户“全部修复”的要求闭环，详见文末最新回检；下文历史阶段的“未修复／单列后续”仅保留当时证据，不代表当前状态。横屏字号项为验收工具误判纠正，真实设备与跨平台边界继续保留。

- 桌面、Web 与共享 UI 的功能样式源码已收口。整仓清单全局 class 候选 26→2，全部是 document 文本选择 class（`selectable-text` / `copyable-text`）；Web 为 0。当前拉取远程改动后共 262 个 TSX 生产消费者，没有未定义字面类。全局规则、关联 owner、动态类辅助器及 imperative 样式职责已核对，详情见下文；这些源码证据仍不是全量视觉完成证明。
- 图片预览、分类图片隐私桥接、外观设置、资源导入弹窗、共享工作台、`DetailPage` 操作弹窗及设置工作区的专属样式已收口。28 个生产调用方的 68 处旧文本／多行输入已迁入共享原语；设置壳、Button、caption 和单位的排版密度归入各自 Module，删除 `workspaces.css` 及旧类。刮削字段分段动作已归入共享原语，桌面旧按钮类字面引用清零；共享 Modal、EmptyState、IconButton、表单分区和代码编辑器不再输出无效的旧全局类。Layout、共享侧栏导航、品牌、背景及开发工作区展示模式已归入各自 Module，删除无消费者的 hint 表及响应式桥接表。Web 浏览壳、首页和详情也已收口；视觉闭环覆盖关联组件及实际设置入口，不因页面直接引用为零而跳过关联组件，也不把设置壳检查等同于全部设置页面验收。
- 冲突候选按钮原本依赖已失效的直接子节点选择器。用户要求全部修复后，候选显式使用局部 class，恢复卡片布局与交互状态；旧 `actress-picker-ui.mjs` 改为虚拟连续滚动验收，四组通过。原始失败与本轮修复分别记录于文末。
- 刮削字段弹窗原有 640/480px 指针遮挡已修复：窄窗纵向正文自然高度、任务配置区不压缩。定向矩阵取消旧窄窗键盘替代分支，四档宽度均实际点击字段操作，八组通过，不使用强制点击。
- 12 个活动媒体库、640px 窗高时维护区超出首屏的问题已修复：浏览导航中段独立滚动，底部维护区保留在视口内。八组应用壳定向检查明确断言维护区底边不超出视口，不把自动滚动后的可点击当作始终可见。
- 开发工作区的 4 条 `:global` 及 1 条原始宿主属性穿透已改为显式 presentation；设置壳不再输出该宿主标记。桌面剩余 2 条 Module global 选择器属于 document 根隐私范围契约；Web 图片预览另有 10 条规则，只在局部 root 下覆写 YARL 已知部件，并由专用检查约束。不能据 global 函数数量代替全部祖先依赖审计。
- Web 的资源卡片、统一反馈及图片预览已归同名 Module，删除 `image-preview.css`；固定复制文本框也已移除 imperative inline。登录／配对、品牌／基础控件以及浏览壳、搜索、侧栏、范围弹层、影片卡片和网格已收口到各自 Module。首页布局、统一状态提示、结果标题／排序／chip 行／分页，以及详情主体、播放器／剧照、演员与共用文本全部局部化，24 个剩余全局功能类清零。Web 已纳入 Module stylelint 和独立 CSS 债务基线，桌面基线不变。
- 49 处 JSX inline 候选已按下表核对职责。固定定位／层级和网格整宽已局部化；头像共享尺寸绑定 CSS 变量；与虚拟行高共用的间距保留几何单一来源。候选数量未下降不代表没有收口，也不以纯字面对象数为零宣称动态闭包。imperative 样式另行核对：仅保留 Modal／图片预览的运行时 body 滚动锁，以及 scrollbarWidth 工具的短命、不可见测量节点；后者测量系统滚动条，完成即移除，不是展示给用户的静态功能 UI。
- 修正测试 HTML 主题初始化时序、增加文字颜色断言后，完整组件矩阵退出 0：928 组、2784 张截图、8 组新增颜色记录。既有布局／计算样式记录与前次相同；2648 张 RGB 相同、136 张不同，无尺寸变化，不能宣称全部像素一致。用户确认纳入三层演员路由修复后，真实 App／路由完整整页矩阵退出 0：59 个入口、712 组、1212 张截图，skippedSurfaces 为空。修复前失败及部分矩阵记录仍保留；组件矩阵与整页验收分别记录，不互相替代。其它独立业务问题未因此修复。

### Inline 候选职责核对（49 处）

仅覆盖当前清单的实际 JSX style 输出；不替代未来新增样式、未识别动态构造器及整仓最终审计。

| owner／调用方 | 处数 | 保留理由或本批处理 |
| --- | ---: | --- |
| ActressAvatarEditor、AppearanceSettingsPanel | 4 | 3 处实际图片裁切位置／尺寸；视口通过 CSS 变量绑定共享裁剪尺寸，宽高声明归 Module |
| ActressGalleryPanel、GalleryImageTile | 3 | 瀑布流总高／单元几何及其 style 转发；影片样张调用不传几何 style |
| AppBackgroundLayer | 3 | contain 图框及两侧渐隐位置来自图片／视口测量 |
| AssetCryptoOverlay、PluginCard、PluginDevConversation、BatchSettingsPanel、SettingsOverviewPanel | 8 | 进度、上下文及刮削覆盖率的实时百分比／flexGrow |
| ClassificationPicker、FloatingLayer、SelectControl | 3 | 测量宽度、浮层坐标／可见状态和随视口变化的菜单位置／可用高度；固定定位与层级归 Module |
| ContinuousGrid | 2 | 数据总量决定的占位总高、空忙／错态最小几何及可见单元定位；不在 CSS 复制计算边界 |
| VirtualActressGrid、VirtualPosterGrid、VirtualGridViewport | 9 | react-window 样式转发与实际行高／坐标；width／overflow 的 undefined 是清除上游样式的适配，不是视觉声明。单元 paddingBottom 与布局函数共用 GAP／ACTRESS_GRID_GAP，保留一个数值来源 |
| LibraryScanAuditPanel | 3 | react-window 渲染行的 style 转发链，非静态布局 |
| ImagePreviewLightbox | 3 | 手势位移、平移及缩放 |
| PosterCard | 1 | 由虚拟网格布局计算的 thumbHeight；普通卡片使用自身比例 |
| StarRating | 2 | 调用方公开 size 参数，非固定字号重复 |
| MediaLibraryNav、ScopedPosterCard、VideoLibraryMembershipBadges、GlobalSearchPage、HomePage、LibraryPage、MediaLibrarySettingsPage | 8 | 用户可选媒体库身份颜色的语义 CSS 变量，不含布局 |

`PluginDevMediaTargetPicker.module.css` 的两条 `:global(:root:where(...))` 只读取 document 上的防窥范围；局部 poster 负责图片滤镜及不拦截指针的遮罩。它们不依赖宿主功能 class，不应改成面板状态副本；真实目标选择夹具既有防窥断言继续保留。

## 批次记录

- 已收口列表计数徽标：12 处使用 ResultCount 的宽度／稳定布局语义，删除 navigation-controls.css 中 5 个旧全局 class。保留原先级联最终生效的 margin-left:auto，不照搬已被覆盖的 margin-left:0。其他页面依赖尚未迁完。
- 新增只读 `node scripts/css-module-inventory.mjs`，`--json` 输出全量 owner／引用候选。覆盖桌面、Web 和共享 UI；结果包含动态表达式待审计项，不以直接引用为零判定完成。
- 当前桌面 CSS 架构指标：globalClassCount 1152 → 1147，其余债务指标未增加；类型检查、ResultCount 样式检查、ResultCount 与首页 3 项测试通过。
- 下一批：收口 ListSurface／页面壳和剩余计数旁提示，继续首页、全局搜索关联组件闭包审计；同时建立生产 CSS 体积与页面截图基线，再推进大面积样式迁移。

### 列表基础布局批次

- 新增 ListPage、PageHeader、ScrollViewport、PageContent、ScrollRegion 的同名 CSS Module；替换全部基础布局 class 调用，删除旧定义。DetailScrollBody、SettingsWorkspaceShell 复用新的视口；专用详情／设置样式仍待迁移。
- 背景图模式改由壳层传递 custom properties；EmptyState 的直接父布局契约收回自己的 module。分类列表测试从依赖全局 class 改为语义 data 属性。
- 全局 class 1147 → 1139，跨文件重复 142 → 139，后代选择器 804 → 802；类型、定向 lint、stylelint 和 CSS 架构检查通过。布局迁移页面回归 36 项通过。
- 新增 `node scripts/css-module-migration.mjs`：真实 HomePage／GlobalSearchPage，合成空资料库，两种尺寸×两主题共 8 项通过；检查视口尺寸、滚动模式、稳定滚动槽和横向溢出，保留截图。当前仅覆盖空态，不代表有数据、错误、背景图和全部子组件验收。
- 实际截图：`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Dr4502`。首页／全局搜索直接全局 class 引用为零，关联组件闭包尚未清零，不标整页完成。
- 首次生产构建通过（PageHeader 迁移之前、布局迁移之后）：renderer CSS 523977 bytes，gzip 73623 bytes，作为后续大批迁移体积对比点。日志 `/tmp/javdex-css-module-build.log`，最终仍需重建验证。
- 清单脚本修正：只从 className 字符串／模板字面量收集候选，避免将 `styles.content` 误记为全局 `.content`。
- 下一步继续 ListToolbar 搜索控件、海报／虚拟网格和首页关联组件迁移；扩展浏览器夹具至有数据、搜索、焦点与背景图，再推进剩余页面。

### 搜索控件批次

- 新增 SearchInput + 同名 module，统一默认、工具栏、紧凑布局及整宽／尾部辅助内容；ListToolbar、ClassificationMergeModal、MergeActressModal、PendingActressConflictPane 已迁入。
- 删除 search-input、merge-actress-search 及分类／冲突弹窗穿透搜索框的旧规则；移除工具栏无消费者的标题标签规则和无样式标记。工具栏根部桥接仍为 SelectControl、mode-toggle 保留，下一批需移除，不能标完成。
- 桌面全局 class 1139 → 1136，重复 class 139 → 138，后代选择器 802 → 800。类型、定向 lint、stylelint、CSS 架构检查通过；相关交互 27 项及 SearchInput 原生语义 1 项通过。
- 八张空态截图与上一批逐字节一致。浏览器夹具增加输入关键词→无结果→保留草稿与焦点检查，8 组通过；输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-3RU4l4`。
- 下一步：SelectControl／分段按钮所有权及工具栏剩余桥接，然后海报卡片／虚拟网格；仍需有数据、背景图、禁用／弹层状态及跨页面完整验收。

### 分段按钮批次

- SegmentedControl／SegmentedOption 拥有独立 module，演员列表性别筛选、演员编辑性别、外观设置封面模式全部接入；三种布局通过 variant 表达，选中状态使用 aria-pressed。
- 删除全部 mode-toggle／stretch 旧规则及工具栏、设置页覆盖；原 #fff 换成已有 text-on-accent token。全局 class 1136 → 1134，重复 class 138 → 137，后代选择器 800 → 790，硬编码颜色声明 166 → 165。
- 类型、定向 lint、stylelint、CSS 架构检查与新增控件测试通过；既有媒体库显示控制测试通过（不把它算作外观设置整页验收）。
- 浏览器夹具增加三种分段布局、选中切换和禁用检查；合计 12 组通过，工具栏高度保持 36px。实际控件截图 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-W2keNg`。本批没有外观设置整页有数据验收，仍列后续任务。
- SelectControl 尚有约 48 处选择器关联，涉及表单、工具栏、设置页和 portal；下一批需连同尺寸覆盖一起迁移，不能直接删除 topbar-toolbar 的最后桥接。

### SelectControl：portal 菜单

- 已将菜单、选项及展开方向迁入 SelectControl.module.css；选中使用 aria-selected，高亮使用 data-active，方向使用 data-placement，删除原 app-select-menu／option 全局规则。
- 全局 class 1134 → 1130，全局状态选择器计数 88 → 83；类型、lint、stylelint、CSS 架构检查通过，清单、网络、组合配置、模型设置相关回归 13 项通过。
- 浏览器控件夹具验证向下／向上展开、禁用选项、选择值、选后关闭、Escape 后焦点保持及视口内定位，两种尺寸×两主题通过；连同首页／搜索共 12 组。截图 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-eqcD1C`。
- **SelectControl 尚未整体完成**：trigger 的 select/app-select-button 及外部尺寸／注意状态覆盖仍待迁移；不能将已有 module 当作完成证据。下一步需区分冗余 width:100% 与真正的 toolbar/filter/attention 覆盖，改为明确接口后删除桥接。

### 虚拟海报网格

- VirtualPosterGrid 的加载区、视口、单元盒模型及容器高度迁入同名 Module；卡片高度通过已有 className 接口传递，不再穿透 poster-card。删除无消费者的 poster-grid 规则及横版覆盖。动态虚拟定位、计算尺寸与 GAP 保留在运行时。
- 实测发现 react-window 内联 overflow 会覆盖 module；增加内部视口适配，仅移除库的 overflow shorthand，保留动态布局，由 module 统一控制纵向滚动和稳定滚动槽。
- 全局 class 1130 → 1127，后代选择器 790 → 789。类型、定向 ESLint、stylelint、diff 检查通过；媒体库选择回归 5 项通过。
- 浏览器矩阵扩为 16 项：新增 200 条合成影片的网格，在两种尺寸和主题验证虚拟化、12px 行间距、视口高度、无横向溢出、卡片选择及滚动换页；查看窄窗浅色截图。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-b5rcvy`。尚未覆盖网格横版封面与跨库徽标，不能据此标记完整页面完成。
- 后续仍需迁移 PosterCard 本体及共享卡片交互规则，并完成 SelectControl trigger 和页面依赖闭包。

### PosterCard：信息区与操作菜单

- 徽标、资源类型条、元数据文字、编辑图标和菜单迁入 PosterCard.module.css；状态徽标和危险菜单项改用 data 属性。删除对应全局规则，包括隐私模式下的徽标层级分支。覆盖图片的固定对比色集中为 media 语义 token，保留原色值，不随周边主题改变可读性。
- 全局 class 1127 → 1115，跨文件重复 137 → 136。类型检查、定向 lint/stylelint、CSS 架构检查、diff 检查及媒体库选择回归 5 项通过。
- 16 项浏览器矩阵通过，网格场景额外验证编辑按钮保持 26px、编辑回调、功能菜单删除回调及执行后关闭（仅合成数据回调，不触碰用户资料）。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-98ErbN`。
- PosterCard 仍未整体完成：卡片根节点、封面裁切、与详情共用的缺图占位及与演员卡片共用的选择/悬停行为尚待收口。不得仅因已有同名 module 标记整卡或页面完成。

### PosterCard：封面与缺图占位

- 封面比例、固定高度变体、竖图在横版中居中、隐私模糊和遮罩迁入 PosterCard.module.css；使用 data-mode/data-fixed/data-tall，删除原 poster-thumb 与 cover 组合规则及无调用方的头像候选覆盖。
- 新增 CoverPlaceholder 原语，由卡片和详情共用，删除 poster-placeholder 全局规则；文本色使用与旧值等价的 text-muted 语义 token。
- 全局 class 1115 → 1110，跨文件重复 136 → 132，后代选择器 789 → 786。类型、定向 ESLint/stylelint、CSS 架构、diff 检查及媒体库 5 项回归通过。
- 浏览器矩阵扩至 20 项，通过合成封面验证纵横比例、固定 180px、高竖图 contain 和隐私过滤/遮罩。比例断言按数值等待稳定，不依赖浏览器对 CSS 分数的字符串序列化。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Sas5ff`。
- 仍待迁移卡片根节点和与演员卡片共用的选择/悬停样式，整页尚未收口。

### 海报卡片根节点与共享选择按钮

- PosterCard 根节点、选择态和操作显隐迁入自身 Module，组件不再直接使用任何旧全局 class。新增 CardSelectionButton，由海报和演员卡片共同使用；父卡片通过局部 custom properties 传递操作显隐，按钮负责 aria-pressed、强制显示与键盘焦点样式。删除旧 poster-card / poster-hover-control / poster-select-toggle 规则及演员卡片穿透覆盖。
- 演员卡片已有 Module 仅承接显隐，布局等仍待迁移。PosterCard 的 MediaTileActionButton 子依赖仍为 legacy，不能标记完整依赖闭包完成。
- 浏览器和现有远程冒烟、性能脚本的海报定位从旧 class 改为 data-video-card；后两者仅同步定位器，没有执行涉及服务端/真实资料的操作。
- 全局 class 1110 → 1105，跨文件重复 132 → 130，后代选择器 786 → 780，全局状态选择器 83 → 77。类型、定向 ESLint/stylelint、CSS 架构与 diff 检查通过；媒体库 5 项回归通过。
- 20 项浏览器矩阵通过，新增演员选择按钮键盘聚焦可见、空格选择和 aria-pressed 验证；海报选择、菜单、滚动和封面测试继续通过。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-PT8qxS`。

### 演员卡片本体

- ActressCardTile 布局、文字、选中态、头像容器、头像尺寸及删除操作显隐全部归入自身 Module；移除该组件的全局 class 调用，网格不再穿透 actress-card-wrap。ActressStatusBadge 支持 className，由调用方传入局部状态边框样式。
- 保留详情页仍使用的 actress-name 规则；ActressAvatar、ActressStatusBadge 的旧桥接以及 MediaTileActionButton 依赖尚未全部收口，不能将演员页面标为完成。
- 全局 class 1105 → 1100，跨文件重复 130 → 129。类型、定向 lint/stylelint、CSS 架构和 diff 检查通过。演员详情 6 项交互回归通过。
- 浏览器 20 项矩阵通过，补验 72px 头像、删除按钮距顶部/右侧 6px 及键盘选择。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-LaZxup`。

### 演员虚拟网格与共享滚动视口

- VirtualActressGrid 全部直接旧 class 迁入同名 Module，计算定位/尺寸仍保留运行时；box-sizing 从静态 inline style 移入 module。
- 提取 VirtualGridViewport 供演员与海报网格共用，内部移除 react-window 内联 overflow shorthand，以 module 管理纵向滚动及 stable gutter。删除原演员视口的 !important 覆盖。
- 全局 class 1100 → 1096，important 12 → 11。类型、定向 ESLint/stylelint、CSS 架构、diff 检查通过；媒体库选择和演员详情 11 项回归通过。
- 浏览器矩阵扩至 24 项，新增 200 条演员网格验证：虚拟化、视口填充、12px 行间距、选择、滚动回收以及无横向溢出。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-t24Wxo`。仍需后续按整页核对工具栏、加载/错误态及共享子组件闭包。

### 媒体缩略图操作按钮

- MediaTileActionButton 的外观、删除/移除语义、焦点/按下态迁入同名 Module。样张、写真和导入预览通过 data-media-tile 标明显隐容器，移除穿透业务 class 的共享规则；海报和演员卡片继续由自己的局部 class 控制显隐和位置。删除无调用方的 facet 操作按钮覆盖。
- ActressStatusBadge 无剩余全局消费者，移除其旧 class 桥接。头像等其他子依赖仍待清理。
- 全局 class 1096 → 1093，跨文件重复 129 → 127，后代选择器 780 → 774。阴影原色值提升为语义 token；未调整架构债务基线。
- 类型、定向 lint/stylelint、CSS 架构、diff 检查通过；写真/图片导入 5 项回归通过。24 项浏览器矩阵通过，额外验证媒体按钮默认隐藏、父容器悬停显示、键盘聚焦显示。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-SLTwJx`。

### 演员人脸扫描弹窗与无消费者规则

- ActressFaceScanModal 全部直接 class 迁入同名 Module，保留原生 progress、取消状态及错误文本可复制能力。删除专用进度旧规则，保留其他组件仍使用的通用 hint。
- 搜索桌面调用方后删除无消费者的 actress-grid、playlist-video-grid 及横版覆盖；未删除仍有使用方的虚拟网格或首页网格。
- 全局 class 1093 → 1088，后代选择器 774 → 772。类型、定向 lint/stylelint、CSS 架构及 diff 检查通过。
- 浏览器矩阵扩至 28 项，新增扫描弹窗在两尺寸/主题下的视口边界、8px 进度条、当前演员提示和取消后禁用按钮验证。未运行真实模型或操作用户图片。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-3QREg7`。

### 图片资源迁移遮罩

- AssetCryptoOverlay 的遮罩、面板、说明与进度样式全部迁入同名 Module。核对 progress-track/fill/stats 无其他调用方后删除旧规则；进度宽度继续使用运行时数值。
- 遮罩底色和进度槽提升为语义 token，保留原有颜色/透明度。全局 class 1088 → 1083，跨文件重复 127 → 126，后代选择器 772 → 770。
- 类型、定向 ESLint/stylelint、CSS 架构及 diff 检查通过。浏览器矩阵扩至 32 项，用模拟进度事件验证加密/解密/迁移三种文案、全屏遮罩、计数更新及完成后移除；未操作真实文件。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-HBCgvq`。

### 图片导入弹窗

- ImageImportModal 专用壳、页签、拖拽区、URL 面板、队列和缩略图迁入同名 Module。Modal body 通过已有 bodyClassName 接口传入；页签使用 aria-selected，拖拽使用 data-dragging。删除旧专用规则及已无匹配目标的 btn/empty-state 穿透规则，不重新激活旧死规则。
- 通用 text-input 基础样式仍未迁移，不能宣称弹窗依赖闭包已完成。
- 全局 class 1083 → 1067，后代选择器 770 → 765。类型、定向 ESLint/stylelint、CSS 架构和 diff 检查通过；部分导入失败保留/重试测试通过。
- 浏览器矩阵扩至 36 项，通过合成图片验证链接页签、加载预览、队列操作、键盘移除、提交按钮资格及两尺寸/主题布局边界。预览 API 使用本地模拟数据，不访问实际 URL。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-osyPQr`。

### 列表批量选择工具栏

- SelectionToolbar 的外框、计数、动作区、清除按钮和窄窗规则归入原有 Module，移除全部 selection-toolbar 全局 class。对 IconButton 使用 data-ui 契约，不再依赖 icon-btn 桥接。
- 全局 class 1067 → 1063，跨文件重复 126 → 125。类型、定向 lint/stylelint、CSS 架构和 diff 检查通过；媒体库、分类、清单列表 34 项回归通过。
- 浏览器矩阵扩至 40 项，新增36px工具栏、28px按钮、禁用操作、批量动作和取消选择回调验证。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-kQC7l6`。列表页仍有筛选、排序和详情依赖待迁移，未标整页完成。

### 列表排序控件

- SortSwitch 外框、字段按钮、方向按钮、紧凑和窄窗变体迁入同名 Module。选中样式使用 aria-pressed，紧凑变体使用 data-compact；删除全部 sort-switch 全局规则。
- 全局 class 1063 → 1058，跨文件重复 125 → 123，全局状态选择器 75 → 74。类型、定向 lint/stylelint、CSS 架构及 diff 检查通过；分类列表 24 项回归通过。
- 浏览器 40 项矩阵通过，在选择工具栏场景中补验紧凑排序36px高度、方向按钮32px宽度、字段选中和方向切换。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-x3u4Bu`。小于760px的断点仍需最终窄窗验收覆盖。

### 窄窗断点补验

- 测试脚本新增 640×640 的浅色/深色排序工具栏与图片导入弹窗场景，矩阵共44项通过。验证紧凑排序仍采用9px字段留白且不横向溢出；图片导入宽度为视口减48px，URL输入与加载按钮在680px断点下上下排列，弹窗保持视口内。
- 已查看640px浅色图片导入截图；本轮还执行全量 `npm run lint:css`，所有桌面及共享 UI Module 通过。未将局部视觉验收当作整页或全项目验收。
- 结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-vzPQWm`。当前排序/导入两个断点的缺失证据已补齐，其他页面继续按清单迁移。

### 列表筛选触发按钮

- 新增 FilterTrigger，同一接口承接 LibraryPage 与 ActressesPage 的按钮引用、展开/生效状态和点击回调；箭头与状态底色由同名 Module 负责。删除 library-filter-btn/list-filter-btn 两套旧规则及旧 chevron 类，保留尚未迁移的定位容器与弹层。
- 全局 class 1058 → 1048，全局状态选择器 74 → 72。类型、定向 lint/stylelint、CSS 架构、diff 检查及媒体库5项回归通过。
- 浏览器44项矩阵通过，在工具栏场景中补验筛选 aria-expanded 切换和箭头旋转，覆盖640px窄窗及两主题。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-yNwaas`。筛选弹层仍未收口，页面不标完成。

### 已迁移资源筛选的旧规则清理

- 核对实际 LibraryFilterPopover 已使用 VideoResourceFilterFieldset 及共享 Checkbox；全仓库非CSS源码无 library-resource-filter 消费者。删除其旧 fieldset/grid/option/hint 及14px原生checkbox覆盖，不另建替代实现。
- 全局 class 1048 → 1044，后代选择器 764 → 762。CSS 架构和 diff 检查通过，资源筛选OR语义测试通过。
- 浏览器44项矩阵通过，新增实际 VideoResourceFilterFieldset 的勾选/撤销验证，覆盖两主题和640px窄窗。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-DT8MiU`。共享筛选弹层壳和SelectControl触发器仍待迁移。

### 标签筛选组件

- TagFilter 专用布局、标签云、候选列表、已选chip和弹窗迁入同名 Module；标签云选择使用 aria-selected，测试从旧 class 转向 role/data-tag-id。chip 基础外观收回自身，不再依赖影片详情的 tag-chip 全局样式。无调用方的 tag-picker-empty 同步删除。
- 搜索框仍使用 text-input/library-filter-input，依赖闭包未完成。未改动分页、最多100项、AND筛选或请求隔离逻辑。
- 全局 class 1044 → 1026，跨文件重复 123 → 122。类型、定向 lint/stylelint、CSS 架构、diff 检查通过；TagFilter 5项交互回归通过。
- 浏览器44项矩阵通过，新增实际标签云的选择态及无匹配搜索验证，数据来自模拟标签接口。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Ua5yBX`。默认弹出候选布局仍需后续视觉验收，不能以紧凑变体代替。

### 筛选弹层公共内容布局

- 新增 FilterPanelContent，由媒体库和演员筛选共同使用，统一标题、滚动区、底部重置/完成操作及演员变体的底部留白。业务状态、关闭监听与外层定位仍由原组件维护。
- 删除旧 head/title/body/footer 规则及 actress modifier；全局 class 1026 → 1021，后代选择器 762 → 761。输入控件与外层 shell 的旧规则仍在，不能标完整弹层迁移。
- 类型、定向 lint/stylelint、CSS 架构、diff 检查及10项标签/媒体库回归通过。浏览器44项矩阵通过，在两主题和640px场景补验实际演员筛选弹层的宽度、自然高度及重置/完成操作。结果目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-c16Nyf`。

### 筛选字段与媒体库标签区

- 两个筛选弹层的两列字段网格、字段标签和跨列规则由 FilterPanelContent 的 FilterFields／FilterField 统一管理；媒体库专属标签区归入 LibraryFilterPopover.module.css。删除对应旧全局规则，全局 class 1021 → 1014。
- 类型检查、定向 ESLint/stylelint、CSS 架构及 diff 检查通过；标签和媒体库回归 10 项通过。浏览器矩阵 44 项通过，新增实际媒体库弹层的字段网格、番号前缀输入、标签选择与重置检查，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-wPepQu`。
- 外层定位和输入控件仍由全局 legacy 规则控制；SelectControl trigger 尚未迁移，不能把筛选弹层或页面标为完成。

### 筛选弹层外框

- 两个筛选弹层的定位、尺寸、滚动裁切、表面与入场动画迁入 FilterPanelContent.module.css 的共享 FilterPanelShell；旧外框和动画规则已删除。临时 `library-filter-popover` class 仍供输入框的遗留级联规则使用，后续要随输入控件迁移一并移除。
- 类型、定向 ESLint/stylelint、CSS 架构和44项浏览器矩阵通过；查看了1000×640浅色媒体库筛选截图，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Xu5sCU`。整体弹层仍未完成依赖闭包。

### 筛选页旧规则清理与结果数提示

- 确认 `filter-label`、`code-prefix-input`、`filter-chips-row`、`filter-chips-clear` 无 JSX 调用后删除。媒体库和演员列表计数的刷新提示改为 ResultCount 的 `fetching` 属性，由同名 Module 管理低强调外观；删除全局 `library-fetch-hint`。
- 桌面全局 class 1014 → 1009；类型、定向 ESLint/stylelint、CSS 架构和 diff 检查通过，ResultCount 与媒体库选择回归 6 项通过。还需完整页面与 Web 验收，整体迁移持续进行。

### 媒体库与演员筛选定位容器

- FilterPanelAnchor 负责弹层的相对定位，LibraryPage 和 ActressesPage 改用共享组件；PageHeader 自身持有相对定位。删除 `library-filter-anchor` 与 `library-header` 全局规则。两页直接旧类继续减少，但筛选输入及其他子组件仍未收口。
- 全局 class 1009 → 1007；类型、定向 ESLint/stylelint、CSS 架构检查及44项浏览器矩阵通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-VheRkK`。

### 演员列表待确认入口

- 将 `actress-conflict-entry` 移入 ActressesPage.module.css，删除 conflict-review.css 中的旧规则。LibraryPage 与 ActressesPage 目前直接 JSX 全局 class 引用均为零；这仅是页面本体指标，关联组件仍有遗留依赖。
- 桌面全局 class 1007 → 1006；类型、定向 ESLint/stylelint、CSS 架构和 diff 检查通过。浏览器44项矩阵额外验证待确认入口在两主题及不同尺寸下的文字、边框与背景计算色，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-3PMF9q`；真实页面状态与整页视觉仍需后续验收。

### SelectControl 触发器基础样式

- 将触发器根容器、按钮交互、展开/禁用态和选中文字的基础规则移入 SelectControl.module.css；删除相应全局定义。`select`、`app-select`、`app-select-button` 等 HTML 过渡 class 仍用于现存页面/筛选/设置覆盖，待各 owner 迁入后删除，不能视作组件闭包完成。
- 桌面全局 class 1006 → 1005，全局状态 class 72 → 70；类型、定向 ESLint/stylelint、CSS 架构通过。浏览器44项矩阵通过，包含选择器展开、禁用、键盘及筛选；设置/待确认相关回归 9 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-6pWYk0`。

### 两个筛选弹层的输入规则

- SelectControl 增加 `variant="filter"`，专用尺寸、表面及交互态归入自己的 Module；媒体库编号前缀文本框归入 LibraryFilterPopover.module.css。两个弹层不再带 `library-filter-popover`/`library-filter-input` 过渡类，TagFilter 也删除无效的同名过渡标记；删除对 SelectControl 内部按钮的全局穿透规则。
- 桌面全局 class 1005 → 1001，后代选择器 761 → 757。类型、定向 ESLint/stylelint、CSS 架构检查及44项浏览器矩阵通过；核看1000×640浅色截图，筛选按钮保留旧版无箭头外观。结果 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-tnJXb3`。通用 SelectControl 及其他页面覆盖尚需迁移。

### SelectControl 通用按钮与弹层点击契约

- 确认 ListToolbar 内已没有 select 调用后，删除无效的 `topbar-toolbar` 过渡类及对应规则。SelectControl 的共享 `.select` 基础外观、箭头、hover/focus/disabled 状态移入自己的 Module；`select` HTML 类暂用于多个页面的尺寸和关注态覆盖。
- 移除失效的 `app-select`、`app-select-button`、`is-open`、`is-disabled` 过渡类及对应全局宽度覆盖。门户菜单改用 `data-select-control-menu` 提供稳定的“属于父弹层”判断；浏览器矩阵新增在演员/媒体库筛选弹层内选择条目并确认父弹层仍打开的交互验证。
- 桌面全局 class 1001 → 999，后代选择器 757 → 751。类型、定向 ESLint/stylelint、CSS 架构及浏览器44项矩阵通过；选择器样式增加计算属性检查，设置/清单关联回归21项通过。结果 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-hbtDDE`。其他外部 `.select` 覆盖仍待迁移。

### SelectControl 旧类闭包

- 清理插件、编辑表单及资源表单中已由 SelectControl 自身保证的 `width: 100%`、`min-width: 0` 和盒模型覆盖；删去无效的 scrape-site 触发按钮 flex 规则。插件配置关注态仅用于文本输入，选择器不会位于该状态内；其焦点覆盖与 SelectControl 本身相同，移除选择器分支。
- 设置工作区通过继承的 `--select-control-font-size` 提供12px字体，SelectControl 默认仍为13px；删除最后的全局 `.select` 后代规则和 HTML 过渡类。Portal 菜单用 `data-select-control-menu` 保持父弹层点击契约，浏览器中验证选择后弹层不关闭。
- 桌面全局 class 999 → 998、跨文件重复 121 → 119、后代选择器 751 → 741。类型检查、全部 Module stylelint、定向 ESLint、CSS 架构及44项浏览器矩阵通过；设置选择器计算字体12px、普通选择器13px，结果 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-NRG4Pa`。其他页面级 legacy 样式和完整视觉验收仍待处理。

### 标签搜索与媒体库文本输入

- 新增 TextInput 及同名 Module，承接通用文本框基础状态和筛选弹层34px变体。TagFilter 两种搜索框与 LibraryFilterPopover 番号前缀改用该原语，不再直接依赖全局 `text-input`；旧全局基础规则继续服务其他未迁移调用方。
- 类型、定向 ESLint/stylelint、CSS 架构通过，标签/媒体库回归10项及浏览器44项通过。1000×640/1000×900浅色关键截图与改动前逐像素一致；输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-LsovxC`。桌面全局 class 维持998，依赖调用数减少。
- 本阶段桌面及 Web 生产构建通过；当前 renderer CSS 为 523498 bytes，gzip 74399 bytes。此前构建基线较早且工作区还有其他改动，不据此单独归因体积变化；最终迁移完成后仍须统一重建对比。

### 播放清单列表卡片与候选行

- 新增 `PlaylistCover`、`PlaylistCard`、`PlaylistPickerRow` 及各自 Module。列表卡片、详情封面和两个候选选择器共用封面 owner；列表卡片的选中态、计数徽标及隐私遮罩层级归入卡片 Module。两个选择器共用候选行 owner，保留可点击目标与带操作按钮两种语义。测试定位改为 `data-playlist-card`／`data-playlist-picker-row`，不依赖生成类名。
- 删除对应全局卡片、封面、候选行规则与无调用方的旧清单网格／候选列表／详情元数据规则。桌面全局 class 998 → 980，后代选择器 741 → 734；直接的 `PlaylistsPage` JSX 已无全局功能 class，但 `PlaylistVideoPicker` 的弹窗容器、搜索栏和 `PlaylistDetailPage` 等仍未迁移，整页未完成。
- 类型、局部 Module stylelint、定向 ESLint、CSS 架构、清单列表与选择器 11 项交互测试通过；浏览器合成数据矩阵增至 48 项，覆盖卡片/候选行尺寸、选中、缺图、隐私遮罩与徽标层级，两尺寸×两主题截图位于 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-EXScLd`。本批生产构建通过，renderer CSS 523036 bytes，gzip 74432 bytes；其他工作区改动并存，不归因体积变化。
- 下一步迁 `PlaylistDetailPage` 及编辑组件，再补真实整页、窄屏和 Web 验收。不得把本批组件夹具视为整页验收。

### 播放清单选择弹窗

- `PlaylistVideoPicker` 的 body、候选面板、搜索栏及移出按钮样式归入同名 Module；搜索输入改用 `TextInput`。通过 `Modal.bodyClassName` 和 `bodyOverflow` 传递局部布局，不再依赖 `.modal--playlist-picker .modal-body` 等跨组件全局选择器。窄窗布局与按钮扩展规则也归入自身 Module。
- 实测旧样式的 body 右内边距受 `Modal` 样式层叠影响，实际为 `--scrollbar-safe-pad + --focus-ring-space`，迁移时保留这一实际效果。三种宽度（1440／1000／640）×两主题的弹窗截图与迁移前逐字节一致，浏览器矩阵 54 项通过，并验证移出按钮悬停色，结果 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Il1BQ8`；类型、全量 Module stylelint、定向 ESLint、清单相关 11 项交互测试和生产构建通过。当前 renderer CSS 522783 bytes，gzip 74410 bytes；体积变化不单独归因于本批。
- `PlaylistDestinationPicker` 的搜索输入也改用 `TextInput`，宽度由自身 Module 保持；相应 6 项交互、类型与局部 lint 通过。桌面全局 class 980 → 975、跨文件重复 118 → 117、后代选择器 734 → 730。当前仍有 `PlaylistDetailPage` 和其他清单弹窗未迁移；整页完成状态不变。

### 播放清单详情主体

- `PlaylistDetailPage` 的封面区网格、标题/元数据/简介、操作区及影片区工具栏归入页面 Module；旧的 `playlist-detail-*`、`playlist-section-*` 规则和窄屏覆盖已删除。旧 `.playlist-detail-empty-desc` 实际被更高优先级的简介文字规则覆盖，本批保留原生效的次要文字色。共享 `detail-pane`、`section-title` 和所依赖的影片网格、筛选弹层等尚需后续纵向收口。
- 类型、定向 ESLint、全量 Module stylelint、CSS 架构、详情页 10 项交互测试与桌面/Web 生产构建通过；浏览器矩阵扩至 60 项，新增详情页三种宽度×两主题的合成空清单状态，核查宽/窄网格列数、章节标题间距及无横向溢出，截图 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-k8eQE7`。当前 renderer CSS 522661 bytes，gzip 74444 bytes；不把体积变化单独归因于本批。这不涵盖真实有影片/错误/编辑态的整页视觉验收。
- 清掉已无调用方的 `.page-title` 与失效的旧注释；桌面全局 class 975 → 965、跨文件重复 117 → 112、后代选择器 730 → 726。`PlaylistDetailPage` 尚有共享全局样式和关联组件，批次 4 保持进行中。

### 详情章节标题与叠层容器

- 新增 `DetailSectionTitle` 及同名 Module，为影片详情、资源、标签和样张区块提供紧凑的语义 `h2`；有右侧动作的区块用 `grow` 保持原 flex 布局。清单详情的带分隔线标题归回页面 Module，删除全局 `.section-title` 及两条父级覆盖。标题夹具在 1440／1000／640、深浅主题的 6 张截图与迁移前逐字节一致；清单标题显式使用 `--text-primary`，修正浅色窄窗中标题文字不稳定可见的问题。标签与清单相关 17 项交互测试通过。
- 新增 `DetailPane`／`DetailPaneOverlay` 及同名 Module，六个详情页统一使用组件的 `stacked` 接口；旧 `.detail-pane*` 全局规则移除。背景图模式由应用壳传递两个 overlay 语义变量，不再从壳层穿透组件 class。普通／背景模式的 12 张叠层截图和清单详情 6 张截图均与迁移前逐字节一致；演员及清单详情 16 项交互测试通过。组件契约文档已同步。
- 桌面全局 class 965 → 961，后代选择器 726 → 723；浏览器矩阵现为 72 项，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-aFmB3n`。类型、全量 Module stylelint、定向 ESLint、CSS 架构及桌面/Web 生产构建通过；renderer CSS 522538 bytes，gzip 74376 bytes。`PlaylistDetailPage` 直接 JSX 全局类引用已清零，但关联组件闭包及真实完整状态验收仍未完成，不能标整页完成。

### 详情滚动内容容器

- `DetailScrollBody` 的内容区、三档宽度下的内边距、背景图模式表面和容器查询名称迁入同名 Module，删除全局 `.scroll-body-inner--detail` 及跨文件父级覆盖。详情内紧凑空状态通过继承的语义变量保持透明表面和细边框；样张空状态同样通过变量保留详情专属透明背景，不再使用祖先 class 选择器。
- 新增详情滚动夹具；1440／1000／640 三种宽度 × 两主题 × 普通／背景模式的 12 张截图与迁移前逐字节一致，浏览器矩阵共 78 项通过。全量 Module stylelint、Web 类型、CSS 架构、diff 检查及桌面/Web 生产构建通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Vnr1ei`。
- 桌面全局 class 961 → 960、跨文件重复 112 → 111、后代选择器 723 → 720。详情页与 Web 的其他关联组件及真实整页状态仍未完成迁移与验收。

### 列表与详情路由外壳

- `ListDetailShell` 的根容器、保留挂载的列表、详情叠层和立即隐藏状态迁入同名 Module；背景图模式改由应用壳传递表面与描边语义变量。删除 `.list-detail-shell*` 全局规则，路由匹配逻辑与 `Outlet` 层级保持不变。
- 新增路由外壳浏览器夹具；1440／1000／640 三种宽度 × 两主题 × 普通／背景模式的 12 张截图与迁移前逐字节一致，浏览器矩阵共 84 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-KFQ4my`。分类列表与清单详情 34 项交互测试通过，含嵌套详情往返后保留列表状态。
- 桌面全局 class 960 → 956、后代选择器 720 → 717。完整类型检查、全量 Module stylelint、CSS 架构、diff 检查及桌面/Web 生产构建通过；当前 renderer CSS 522480 bytes。剩余页面与关联组件仍在迁移，不能把外壳夹具视为真实整页验收。

### 影片样张与演员写真图库

- 新增 `GalleryImageTile` 及同名 Module，集中两处图库图片条目的边框、悬停/焦点、禁用和分类型隐私遮罩；预览、分页、删除及尺寸计算仍由各图库 owner 管理。影片样张的等宽列归入 `VideoSampleGallery.module.css`，演员写真工具栏和绝对定位画布归入 `ActressGalleryPanel.module.css`。删除 `.sample-masonry*`、`.actress-gallery-masonry*`、工具栏及对应隐私全局选择器。
- 样张/写真空状态改用 `EmptyState variant="gallery"`。视觉基线暴露旧 `.sample-empty` 与 `.compact` 的层叠：实际默认背景/边框由 compact 规则胜出，因此新变体保留真实生效值；详情滚动区继续从父容器继承透明背景与细边框变量。删除旧 `.sample-empty`。
- 三种宽度 × 两主题的普通图库截图与旧实现逐字节一致；详情滚动的普通／背景模式 12 张截图也一致。隐私模式的旧截图有渲染前后混杂，不能用于逐字节结论；现用样张/写真分别启用的计算样式断言、绘制稳定等待和实图目检确认两类模糊/遮罩。浏览器矩阵 90 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-1fGjpj`；样张缩略图、演员写真分页/预览/删除和演员详情共 13 项交互测试通过。
- 桌面全局 class 956 → 945、跨文件重复 111 → 108、后代选择器 717 → 714；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，当前 renderer CSS 522860 bytes。剩余详情页关联样式和真实整页验收继续保持未完成。

### 演员资料卡片

- `ActressProfileMeta` 的资料网格、卡片表面、标题、键值对、别名布局和摘要文字迁入同名 Module；背景图模式通过应用壳的卡片语义变量传递，不再使用 `.app-shell--with-background .actress-profile-*` 跨组件选择器。状态颜色及别名 chip 的共享旧类暂留，待后续状态/芯片 owner 收口。
- 三种宽度 × 两主题的普通资料组件截图与迁移前逐字节一致；背景模式用边框计算色变化断言、稳定绘制等待和实图核查。旧背景截图有部分在类名切换后、绘制前采集，不作为逐字节基线。浏览器矩阵 96 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-cWl6Ep`；演员资料与详情交互 8 项通过。
- 桌面全局 class 945 → 936、跨文件重复 108 → 107、后代选择器 714 → 707；完整类型检查、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，当前 renderer CSS 522570 bytes。演员详情页头、页签、状态 chip 与关联面板仍待迁移；不能标整页完成。

### 演员详情页头、页签与资料徽标

- `ActressDetailPage` 的资料区布局、三列页头、标题/副标题、操作栏定位及页签迁入页面 Module；选中态改用现有 `aria-selected`。删除相应 `entity-browsing.css` 规则、已空的 `detail-surfaces.css` 及其导入，并清掉无调用方的演员图库导入弹窗旧类。
- 新增 `DetailInfoChip` 和同名 Module，统一演员统计与别名徽标的基础玻璃表面及两种文字语义；删除两套旧全局规则和无调用方的 `glass-chip`。影片标签的全局 chip 样式暂留，待标签组件纵向收口。
- 页头夹具覆盖 1440／1000／640／480 四种宽度、深浅主题、默认/写真选中/背景模式的 24 张截图，迁移前后逐字节一致；浏览器矩阵 104 项通过，最新输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-0uVv1r`。演员资料及详情 8 项交互测试、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查和桌面/Web 生产构建通过，当前 renderer CSS 522570 bytes。
- 桌面全局 class 936 → 924、跨文件重复 107 → 103、后代选择器 707 → 705。头像 `detail-avatar-*` 与共享 `detail-title` 仍是直接全局依赖；动态导入夹具显示头像 110px，但生产 CSS 中 `ActressAvatar` 的 110px 规则先于全局 `detail-avatar-lg` 的 160px 规则，真实构建应以 160px 生效。后续迁移头像需用真实页面核验，不把夹具的 110px 当作产品基线。演员详情关联组件闭包和整页验收仍未完成。

### 演员详情头像

- `ActressAvatar` 增加 `size="detail"` 语义变体，由自身 Module 明确提供 160×160px／48px；`ActressDetailPage.module.css` 接管预览光标、焦点和头像悬停边框。删除 `detail-avatar-frame*`／`detail-avatar-lg` 全局规则，其他头像仍使用 110×110px／30px 的标准尺寸。
- 迁移前使用生产 CSS 在浏览器核实详情头像为 160×160px／48px；迁移后重新构建并核实标准／详情分别为 110×110px／30px、160×160px／48px。动态导入夹具旧图的 110px 是导入顺序差异，不能拿来要求生产详情缩小。浅色主题演员标题原本缺少明确文字色，本批在页面 Module 指定 `--text-primary` 并加入计算色断言，已目检修正后的浅色截图。
- 浏览器矩阵 104 项（含头像悬停边框和预览光标断言）、演员详情与头像编辑相关 12 项测试、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过；最新截图输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-lPJs8H`，renderer CSS 522810 bytes。桌面全局 class 924 → 921。共享 `detail-title`、其他关联组件和真实整页状态仍待收口。

### 详情主标题

- 影片与演员详情共用的主标题排版迁入 `DetailTitle.module.css`；影片的两行截断、标题容器和状态徽标布局分别交由共享标题变体及 `DetailPage.module.css` 管理。原全局 `detail-title*` 规则和两个容器断点规则删除，演员页仍由页面 Module 指定专属 28px 标题尺寸。
- 新增影片标题夹具，覆盖 1440／1000／640／480 四种宽度和深浅主题，并断言两行截断、容器断点字号、语义文字色及无横向溢出。迁移后浏览器矩阵 112 项通过，最新截图输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-OdjJiB`。旧浅色截图有在主题过渡中间采集的帧，不能用于逐字节结论；深色影片标题和演员页头旧/新截图一致，浅色以稳定绘制后的截图和计算样式核对。
- 桌面全局 class 921 → 918、后代选择器 705 → 704；演员详情交互 6 项、完整类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过。其他影片详情关联全局样式与演员详情关联组件仍待迁移，真实整页状态验收也未完成。

### 影片详情页头与封面

- `DetailPage.module.css` 接管影片详情 hero 布局、番号文字、封面比例与裁切、预览悬停/焦点、信息区和窄容器断点；隐私模式的封面模糊及遮罩也归入这个 owner。删除 `media-details.css` 中对应的旧规则与 `library-content.css` 中跨文件 `.detail-cover` 覆盖；无调用方的竖版 `.detail-cover.portrait` 分支不再保留。
- 扩展影片夹具至真实 hero 结构，覆盖横版/竖版封面、预览光标和悬停边框、隐私模糊/遮罩、四档宽度和两种主题。迁移后浏览器矩阵 112 项通过；基线默认态 8 张截图逐字节一致。竖版/隐私截图部分差异来自基线点击后的鼠标悬停边框，已在新夹具固定鼠标位置并单独断言悬停态；不能把这些差异认作整页视觉零差异。最终截图输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-vS1m8b`。
- 桌面全局 class 918 → 909、跨文件重复 103 → 102、后代选择器 704 → 699；完整类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查、影片控制器 12 项测试及桌面/Web 生产构建通过，renderer CSS 522779 bytes。影片详情剩余元数据、资源、弹窗等全局样式和真实整页验收仍待继续。

### 影片资源列表

- `VideoDetailMeta` 的资源区容器、本地/链接资源行、名称、徽标、事实、路径和操作按钮尺寸迁入同名 Module；删除 `media-details.css` 中对应的全局类及无调用方的主资源透明背景、旧 `detail-meta-item` 规则。共享操作菜单与 `IconButton` 的旧类暂留，待共享控件迁移；删除记录数据从不产生的 `path` 分支及其旧全局规则。
- 在夹具中覆盖本地文件、网页链接、展开完整链接和操作菜单，四种宽度×两主题。迁移前后 24 张资源区截图中 22 张逐字节一致；两张浅色展开态按钮绘制略有差异，目检无布局变化。首次迁移发现资源区整体上移 18px：旧 `.detail-meta-section` 的零外边距被后声明的 `.detail-section` 覆盖，Module 现明确保留真实生效的 18px。浏览器矩阵 120 项通过，最终截图输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-6tNCau`。
- 桌面全局 class 909 → 894、后代选择器 699 → 692；资源交互 4 项、完整类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 521858 bytes。`VideoDetailMeta` 的主元数据与维护记录、共享状态徽标及菜单仍有全局依赖，不能标记组件或页面完成。

### 影片主元数据与维护记录

- `VideoDetailMeta.module.css` 接管主元数据两列/窄屏单列布局、键值文字及维护记录行；`MetaLink` 拥有独立 Module，影片番号、组织/导演/系列链接和设置入口不再依赖全局 `meta-val/meta-link`。设置入口提示语迁入 `DetailPage.module.css`，删除原先散落在 `settings-overview.css` 的跨页面规则。无调用方的 `meta-val--path`、`detail-subtitle` 和 `detail-meta-grid` 旧规则也一并移除。
- 新增真实主元数据/维护记录夹具，覆盖 1440／1000／640／480 四种宽度、深浅主题和链接悬停；迁移前后主元数据和影片标题截图逐字节一致。随后扩充的设置入口夹具另行断言链接左右 4px 间距与 11px 字号。浏览器矩阵 128 项通过，最终截图输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-azR7AV`。
- 桌面全局 class 894 → 883、后代选择器保持 692；主元数据/资源交互 8 项、完整类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 521599 bytes。共享状态徽标、详情操作栏/菜单和其他影片页关联组件仍待收口；真实整页验收未完成。

### 共享刮削状态徽标

- 新增 `ScrapeStatusBadge` 及同名 Module，按 `status` 语义提供未刮削/成功/失败状态，并按使用位置保留 `span` 或 `dd`；`PendingScrapeBadge` 保留待确认按钮及悬停/焦点反馈。影片标题、影片维护记录和演员资料卡片全部接入，删除 `media-details.css` 的 `detail-meta-status*` 全局规则与演员资料的旧 class 映射。卡片角落的 `ActressStatusBadge` 是另一种定位与文案契约，未混用。
- 迁移前后四档宽度×深浅主题的影片标题、维护记录、演员资料和演员页头截图逐字节一致；浏览器矩阵 128 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-069p4g`。新增语义测试验证 `span/dd` 元素、状态属性及待确认按钮行为，相关测试 11 项通过。
- 桌面全局 class 883 → 879、后代选择器保持 692；完整类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查和桌面/Web 生产构建通过，renderer CSS 521553 bytes。详情操作栏与菜单等全局样式仍待迁移，整页及关联组件闭包未完成。

### 详情操作栏容器与动作组

- `DetailActionBar.module.css` 接管悬浮/内联操作栏、主按钮和图标动作组；删除 `media-details.css` 的 `detail-actions*`、`detail-play-btn` 与无其他调用方的 `detail-action-group*` 全局规则。背景图模式沿用应用壳的语义变量传递，保留原来的玻璃表面和边框计算值；菜单及共享图标按钮的旧类暂留，待下批按共享控件 owner 收口。
- 新增悬浮/内联操作栏夹具，覆盖主按钮、菜单打开、Escape 关闭和背景图模式，四档宽度×深浅主题；迁移前后该夹具与演员页头截图逐字节一致。浏览器矩阵 136 项通过，最终输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-9Yn2Cg`。
- 桌面全局 class 879 → 874、后代选择器 692 → 688；完整类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 521057 bytes。共享菜单、图标按钮和影片详情其余关联组件仍待迁移；真实整页验收未完成。

### 详情操作菜单与图标按钮

- 新增 `DetailMenu` 和同名 Module，将操作栏及本地/链接资源行共用的菜单锚点、面板、菜单项、危险项和分隔线收敛到一个 owner；原有打开/关闭、点击外部及 Escape 行为仍由调用方管理。`DetailIconButton` 和同名 Module 承接详情动作按钮的普通/紧凑尺寸与交互状态，样张、资源标题按钮使用紧凑变体；删除 `media-details.css` 中对应全局规则。
- 四档宽度×深浅主题浏览器矩阵 136 项通过，操作栏 24 张、演员页头 24 张与图库 12 张截图和上批基线逐字节一致。资源区 24 张中 20 张一致，3 张只有约 20 个像素差异，另 1 张为点击菜单后按钮悬停背景的绘制时序差异；目检菜单布局与内容一致。输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-ZohKq1`。
- 桌面全局 class 874 → 868、跨文件重复 102 → 101、后代选择器 688 → 685；资源相关 8 项交互测试、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查和桌面/Web 生产构建通过，renderer CSS 520842 bytes。通用 `IconButton` 的其他旧全局类与详情页其余关联样式尚未迁移；真实整页验收仍未完成。

### 影片详情区块与演员条目

- 新增 `DetailSection` 和同名 Module，影片页面、资源区、样张和标签面板共用区块外框、标题行、计数及操作区；原 `detail-section*` 规则与没有额外效果的背景模式覆盖已删除。演员条目、头像尺寸、焦点态及剧情简介由 `DetailPage.module.css` 接管，删除 `actress-row-avatars`、`actress-mini`、`actress-name` 和 `summary-text` 全局规则；`VideoDetailMeta` 中重复的区块外观规则也移除。
- 新增演员条目/简介夹具，四档宽度×深浅主题覆盖默认与键盘焦点。默认 8 张截图与迁移前逐字节一致；基线的焦点截图拍在头像边框 150ms 过渡期间，不用于逐字节判定，现以等待过渡完成后的语义边框色断言校验。原有详情标题 6 张、图库 12 张及操作栏 24 张截图一致；资源区展开链接的 4 张仍有约 20 像素的按钮绘制时序差异。浏览器矩阵共 144 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-gEuvzp`。
- 桌面全局 class 868 → 859、跨文件重复 101 → 100、后代选择器 685 → 683；相关交互 23 项、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 520447 bytes。`VideoTagPanel` 的标签、弹窗等样式和影片详情其他关联弹窗仍待迁移，真实整页验收未完成。

### 影片标签面板与候选弹窗

- `VideoTagPanel.module.css` 接管详情标签 chip、手动标签移除按钮、添加按钮、候选弹窗的尺寸/内容/滚动区与候选 chip；输入改用 `TextInput`，弹窗通过 `Modal.className` 与 `bodyClassName` 传入局部样式。删除 `media-details.css` 中所有影片标签专用规则及无调用方的旧标题/操作类。别名编辑器和插件字段标签仍共用的移除按钮旧规则保留，待其各自迁移；没有误删这两类调用方。
- 增加实际 `VideoTagPanel` 的默认、手动标签悬停与添加弹窗夹具，覆盖四档宽度×深浅主题。迁移前后 24 张截图中 23 张逐字节一致；剩余 1 张差异仅在弹窗遮罩下方标签悬停过渡区域。首次比对发现使用 `bodyOverflow="hidden"` 会取消 Modal 原有的稳定滚动槽，使弹窗内容宽 10px；已移除该 prop，并由局部样式保留 hidden overflow，复验尺寸一致。浏览器矩阵共 152 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-h33C6M`。
- 桌面全局 class 859 → 833、后代选择器 683 → 673；标签面板 7 项交互测试、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 520049 bytes。影片详情其他关联弹窗与真实整页验收尚未完成。

### 影片评分与跨详情相关链接

- `VideoDetailRatings.module.css` 接管影片详情评分及外部评分状态，删除 `library-content.css` 中相应全局规则；评分色改由 `--rating-filled` 与文字 token 混合，不保留硬编码颜色。`RelatedLinksList.module.css` 接管链接容器和链接外观，影片详情通过 `selectable` 保留可选中文本；导演、系列、机构详情的重复链接 JSX 改为复用同一组件，并删除 `entity-browsing.css` 的 `organization-links` 旧规则。
- 四档宽度 × 深浅主题 × 默认／仅本地评分状态的评分与链接夹具截图共 16 张，迁移前后逐字节一致；链接点击回调、评分悬停光标、外部分数隐藏和无横向溢出断言通过。完整浏览器矩阵 160 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-b0rk2X`。资源区与标签面板的少量旧有绘制时序差异仍在，不计为本批回归。
- 桌面全局 class 833 → 824、后代选择器 673 → 672、硬编码颜色声明 161 → 160；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构检查和桌面/Web 生产构建通过，renderer CSS 520239 bytes。影片与实体详情仍有其他关联组件和弹窗的全局样式依赖；真实整页验收尚未完成。

### 相关链接编辑器与分类资料弹窗

- `RelatedLinksEditor.module.css` 接管相关链接的行网格、操作组、按钮尺寸和 680px 以下双行布局；输入改用现有 `TextInput`。导演、系列、机构编辑弹窗删除各自重复的链接表单，统一复用 `RelatedLinksEditor`；机构/系列原有“移除链接”无障碍名称由 `removeVerb` 保留。`entity-browsing.css` 中五个链接编辑全局类及窄屏覆盖已移除。
- 四档宽度 × 深浅主题的编辑器夹具覆盖初始、上移后添加、再删除，含可访问按钮和无横向溢出断言；浏览器矩阵 168 项通过，迁移前基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-gZOz6Z`，最终输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-KhyB9W`。初始态 8 张截图逐字节一致；操作后截图受焦点边框过渡与图标绘制时序影响，不用作逐字节结论，目检网格和控件位置一致。新增单元测试覆盖编辑、排序、添加、移除、忙碌禁用；关联导入弹窗合计 5 项测试通过。
- 桌面全局 class 824 → 819、后代选择器维持 672；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 520167 bytes。其余分类详情资料区、分类弹窗外框和其他页面样式仍待迁移；本批夹具不等于三个真实弹窗的完整验收。

### 导演、系列、机构资料卡

- 新增 `ClassificationProfile` 及同名 Module，三个详情页共用资料网格、图片区、主名、元信息、别名、简介和相关链接；`kind` 仅表达导演竖图与系列封面裁切的差异，具体字段仍由页面提供。图片隐私模糊规则从 `library-content.css` 移入组件 Module；`entity-browsing.css` 的资料卡旧规则及窄屏覆盖全部删除。标题与可复制正文由组件本地样式表达，不再调用全局 `selectable-text`。
- 三类资料 × 四档宽度 × 深浅主题 × 普通/隐私模式的 48 张夹具截图中，深色主题 24 张与旧版逐字节一致；浅色主题有 8 张一致，其余差异限定在标题绘制颜色或隐私图片模糊区域，没有卡片几何变化。新版标题显式使用 `--text-primary`，并断言实际计算色；还核查图片 `contain/cover`、导演 3:4 与其他 1.49:1 比例、隐私滤镜及无横向溢出。完整浏览器矩阵 192 项通过，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-xKpAVO`，最终输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-PAGSgo`。单元测试覆盖无图、无元信息和空简介。
- 桌面全局 class 819 → 809、跨文件重复 100 → 99、后代选择器 672 → 670；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查与桌面/Web 生产构建通过，renderer CSS 520171 bytes。三个详情页外层与关联弹窗仍有全局规则；夹具不代替真实整页验收。

### 分类详情滚动内容与关联影片标题

- `ClassificationDetailSurface` 及同名 Module 承接导演、系列、机构详情的滚动内容纵向布局和“关联影片”标题。三个页面仍由既有 `ListPage` 管理外壳；其自身已含 `min-height: 0`，删除重复的 `organization-detail-page` 类。原 `organization-detail-scroll-inner`、`organization-video-heading` 全局规则同步删除，空/错误状态继续使用普通 `ListSurface`。
- 四档宽度 × 深浅主题的顶部及滚到底部共 16 张布局截图与迁移前逐字节一致；检查 14px 区块间距、标题顶部留白、滚动能力与无横向溢出。浏览器矩阵 200 项通过，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-o8oHQQ`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-awOKEc`。
- 桌面全局 class 809 → 806，其余 CSS 架构指标未增加；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 520099 bytes。三类详情页的其他关联弹窗与真实整页状态仍未全部迁移或验收。

### 分类列表卡片

- 新增 `FacetCard` 及同名 Module，机构、系列、导演列表共用卡片结构；机构封面维持 contain，系列/导演封面维持 cover，系列归属副标题及无图占位仍由页面提供。卡片交互、隐私模糊和遮罩归入组件样式，删除 `entity-browsing.css` 的旧卡片规则、无调用方的 `facet-grid`，以及 `library-content.css` 中跨文件的卡片隐私规则。列表测试改用语义 `data-facet-card` 定位，不再依赖旧全局 class。
- 四档宽度 × 深浅主题 × 普通/隐私模式共 16 张卡片截图，迁移前后 13 张逐字节一致；其余 3 张差异均只在浅色主题标题的 1508 个像素，基线拍在主题颜色过渡期间。夹具现等待过渡结束并断言卡片文字继承页面计算色；封面裁切、遮罩、点击和横向溢出检查通过。浏览器矩阵 208 项通过，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-U7uUVW`，最终输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-hlGGCx`。
- 桌面全局 class 806 → 797、跨文件重复 99 → 98、后代选择器维持 670；分类列表交互 24 项、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 520186 bytes。三个真实列表的完整有数据页面、空/错误状态和关联弹窗仍需验收；批次 3 未完成。

### 分类编辑别名与共享移除按钮

- `AliasTagEditor.module.css` 接管别名容器、输入、chip、提升主名和焦点样式；新增 `ChipRemoveButton` 及同名 Module，统一别名的悬停显示和插件字段标签的常驻显示。迁移时保留插件 chip 在悬停/聚焦后增加按钮左间距及提高透明度、禁用常驻按钮维持原有透明度的级联结果；删除 `entity-editors.css`、`media-details.css` 和 `plugin-development-shell.css` 中对应的旧规则，没有复制两套移除按钮 CSS。插件字段选择业务逻辑未改。
- 别名编辑器与插件字段标签各覆盖四档宽度 × 深浅主题 × 默认/悬停，共 32 张目标截图，最终与各自旧版基线逐字节一致；浏览器矩阵 224 项通过，包含别名提升/移除/键盘添加和字段移除检查。别名基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-hoY0su`，插件基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-bQ0FQS`，最终输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-bB8UB2`。
- 桌面全局 class 797 → 790、跨文件重复 98 → 95、后代选择器 670 → 667；相关交互/状态测试 28 项、完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 520006 bytes。分类编辑弹窗的表单网格、输入及其他旧全局规则仍未收口，真实完整弹窗验收也未完成；批次 3/4 继续进行。

### 实体编辑表单栈与字段网格

- `FormPrimitives` 增加 `EditForm`、`EditFormFields`、`EditFormLabelNote`，对应样式归入同名 Module；导演、系列、机构、演员、影片元数据、清单编辑、影片资源导入、清单导入设置及影片合并弹窗的调用方全部迁入。资源导入及清单设置的较宽松间距用 `relaxed` 语义，资源导入的自定义库导入双栏仍由其原有页面 Module 管理。删除 `entity-edit-form`、`entity-edit-fields`、`entity-edit-label-note`、`video-resource-import-grid` 全局规则及不再使用的 `setupForm` 局部覆盖。
- 四档宽度 × 深浅主题 × 默认/输入焦点共 16 张表单夹具截图与旧版逐字节一致；验证宽窗双列、560px 以下单列和无横向溢出。浏览器矩阵 232 项通过，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-m9z4Rt`，最终输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-WJZm0n`。资源导入/清单导入及分类列表等相关测试 34 项通过。
- 桌面全局 class 790 → 786，重复及后代选择器未增加；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 520059 bytes。当时尚未迁移的 `modal-entity-edit` 跨组件覆盖、`entity-edit-field` 输入样式、全宽复选行和分类选择器错误提示需分批收口；夹具不代替各真实弹窗的完整视觉验收。

### 分类候选错误提示

- `ClassificationPicker` 增加可选 `error` 文案并在组件内以 `role="alert"` 呈现；系列、机构候选字段和系列编辑弹窗改为传入错误状态。原有文案、请求与选择流程不变，样式归入 `ClassificationPicker.module.css`，删除 `classification-picker-error` 全局规则。
- 四档宽度 × 深浅主题共 8 张错误提示夹具截图与旧版逐字节一致；浏览器矩阵 240 项通过，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-uDaUQi`，迁移后输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-T5OzN7`。
- 桌面全局 class 786 → 785，其他 CSS 架构债务指标未增加；类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查、选择器 12 项测试与桌面/Web 生产构建通过，renderer CSS 520053 bytes。旧 `modal-entity-edit` 跨组件覆盖、`entity-edit-field` 输入样式及全宽复选行仍待迁移；真实分类编辑弹窗的完整视觉验收仍待进行。

### 编辑复选行与演员身体数据后缀

- 导演、系列、机构编辑弹窗的“将旧主名保留为别名”改用 `EditFormCheckRow`，由 `FormPrimitives.module.css` 明确跨满两列、保持 24px 点击高度。迁移前旧 `entity-edit-field--full` 没有有效样式，实际 `grid-column` 为 `auto`，导致复选行占一列并错位排放后续字段；这批有意修正该布局。
- 演员身高与三围的 `cm` 后缀归入 `EditActressModal.module.css`，删除 `entity-edit-input-suffix`、`entity-edit-input-unit` 全局规则。四档宽度 × 深浅主题的 8 个表单夹具状态通过：复选行跨列、点击切换与后缀宽度、右侧内距、单位定位均通过。480px 单列的后缀裁片与旧版逐字节一致；其余宽度因复选行修正后字段从左列移至右列，裁片像素原点不同，但外观与计算尺寸一致。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-oS39Ez`，完整矩阵输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-LEVWmT`（240 项通过），后缀计算值专项输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-SiYkpR`（8 项通过）。
- 桌面全局 class 785 → 783、后代选择器 667 → 666，其他架构指标未增加。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、分类列表 26 项测试和桌面/Web 生产构建通过。`entity-edit-field` 输入桥接和 `modal-entity-edit` 跨组件覆盖仍待迁移，完整真实弹窗视觉验收未完成。

### 实体编辑字段输入桥接

- `EditFormField` 的直接子级 input/textarea 宽度及 textarea 最小高度、行高、纵向调整改由 `FormPrimitives.module.css` 管理；嵌套的 `ClassificationPicker` 输入宽度归其自身 Module。演员单位输入和资源导入嵌套控件各保留已有局部或专属宽度规则。删除 `entity-edit-field .text-input` 全局规则，并移除 `FormPrimitives` 中无 CSS 消费者的旧字段、标签、提示及分区基础类。服务端桌面冒烟脚本改用 `data-edit-form-field` 稳定定位，脚本本轮未实际运行。
- 四档宽度 × 深浅主题的表单夹具新增真实候选框：主名、简介、候选框的宽度、最小高度、textarea 的 resize/行高等计算值 8/8 与旧版完全一致；8 张默认截图逐字节一致，焦点截图中 5 张一致、3 张仅有 1–2 个边缘像素差异。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-bmLYrS`，专项输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-S8cg41`；完整浏览器矩阵 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-nRs8sr`，240 项通过。
- 桌面全局 class 783 → 782、后代选择器 666 → 663，其他架构债务指标未增加；类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、资源导入/候选框 20 项测试及桌面/Web 生产构建通过，renderer CSS 520205 bytes。编辑媒体区和 `modal-entity-edit` 跨组件覆盖仍待迁移；完整真实弹窗视觉验收尚未完成。

### 实体编辑媒体分区与弹窗空覆盖

- 导演、系列、机构、演员、影片及清单编辑弹窗不再传入无自身样式的 `modal-entity-edit` 类。头像根容器 `gap: 0` 已是默认值；`avatar-cover-picker-title` 无渲染调用方；非横向的 embedded 图片字段在当前弹窗中不存在。删除这些跨组件覆盖及无消费者的封面标题规则。
- 三处封面/头像分区改用 `EditFormSection variant="media"`。生产 bundle 中旧 `entity-edit-section--media` 规则位于 Module 后，实际生效上下内边距为 10px；开发夹具初始加载顺序相反，因此专项夹具在组件加载完后重放旧文件，按生产顺序建立基线。横向图片字段已有 `align-self: stretch`，删除冗余 `width: 100%` 覆盖。
- 四档宽度 × 深浅主题共 8 个媒体分区状态的计算值和截图与生产顺序基线逐字节一致：10px 上下内边距、图片字段宽度、横/窄窗方向均保持。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-8fHLzu`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-PTSrId`；完整浏览器矩阵 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-XUslrp`，248 项通过。
- 桌面全局 class 782 → 778、后代选择器 663 → 659，其他架构债务指标未增加；类型、全量 Module stylelint、定向 ESLint、CSS 架构、头像编辑/资源导入 9 项测试及桌面/Web 生产构建通过，renderer CSS 519701 bytes。旧全局文件中的头像编辑器与图片导入字段本体仍待迁移；真实完整弹窗视觉验收尚未完成。

### 图片导入字段本体

- `ImageImportField` 的容器、横向/纵向布局、宽/方预览、占位纹理、说明、操作区及静态标签留白全部迁入 `ImageImportField.module.css`；删除对应 `image-import-*` 全局规则及无当前调用方的 `.form-grid .image-import-field` 覆盖。文件选择与 blob URL 清理逻辑未改动，调用方 API 不变。
- 四档宽度 × 深浅主题新增宽封面空状态、方形图片预览和纵向图片预览夹具。8/8 布局尺寸、方向和 `object-fit` 计算值与旧版一致；7/8 默认截图逐字节一致，480px 浅色占位纹理区域仅差 1 个色阶的栅格像素。媒体分区集成夹具 8/8 截图仍与旧版逐字节一致。合成图片文件选择、预览出现、取消后恢复占位与路径回调检查通过，不访问用户文件或网络。旧版基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-2O77XR`，迁移后专项 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-DMWUFy`，完整矩阵 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-qr9jDb`，256 项通过。
- 桌面全局 class 778 → 769、后代选择器 659 → 657，其他架构债务指标未增加；完整类型、全量 Module stylelint、定向 ESLint、CSS 架构、diff 检查和桌面/Web 生产构建通过，renderer CSS 519691 bytes。头像编辑器本体及真实完整弹窗视觉验收继续待办。

### 演员头像编辑器

- `ActressAvatarEditor` 的裁剪圆窗、来源标签与面板、横向候选列表、选择状态、缩放与智能构图操作区迁入同名 CSS Module；删除 `entity-editors.css` 中对应全局规则及没有渲染调用方的旧封面选择器。写真分页仍由 `ActressGalleryPanel` 共用，保留原全局分页样式。组件测试由旧 class 字符串定位改为语义 `data-avatar-crop`，裁剪业务逻辑不变。
- 新增真实组件浏览器夹具，覆盖 1440/1000/640/480px、深浅主题的当前头像、编辑裁剪、封面/写真空状态和本地来源切换；8 个专项用例与完整矩阵 264 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-AQsCEL`，未发现横向页面溢出。480px 缩放操作区沿用旧布局，仍较拥挤；头像候选有数据、拖拽与真实编辑弹窗仍待整体验收，不将该夹具视作完整 UI 验收。
- 定向组件测试 6 项、类型检查、Module stylelint、定向 ESLint、CSS 架构检查及桌面/Web 生产构建通过。旧全局 class 769 → 734；其他页面仍需按计划迁移。

### 遗留编辑网格清理

- 演员“三围”唯一使用的 `inline-field-row` 迁入 `EditActressModal.module.css`；`form-grid`、`inline-check` 及旧演员头像编辑行在全部源码中已无调用方，连同相关全局覆盖删除。真正使用中的刮削配置弹窗规则仍留待后续独立迁移。
- 扩充表单夹具为真实三列输入，迁移前后四档宽度 × 深浅主题的 8 张默认截图及 8 张后缀裁片逐字节一致；焦点态 5/8 逐字节一致，其余 3 张目视无布局差异。三列列数、8px 间距和无横向溢出检查通过。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-QigSRU`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-XZA05v`。
- 桌面全局 class 734 → 727、跨文件重复 95 → 92、后代选择器 657 → 646；完整浏览器矩阵 264 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-YLkJaK`。类型、Module stylelint、定向 ESLint、CSS 架构、diff 检查及桌面/Web 生产构建通过，renderer CSS 517870 bytes。

### 刮削配置弹窗

- `ScrapeFieldsModal` 的窗口尺寸、摘要、配置列、目标范围、缺失字段筛选、更新方式、开关行和写入字段面板迁入同名 CSS Module；移除 `entity-editors.css` 中这一组全局规则。`Modal` 为头部、主体和操作栏增加只读 `data-modal-part` 结构标记，供弹窗局部样式覆盖，不靠全局 Modal class 或 `:global` 穿透。
- 真实弹窗夹具覆盖四档宽度与深浅主题；迁移前后 8 张默认截图及 4 张宽窗缺失筛选态截图逐字节一致。宽窗验证范围切换、缺失字段警告、全不选后确认禁用；窄窗只记录截图与结构，因为迁移前 640px 已存在配置列与字段列表重叠、字段列表截获按钮点击的问题。此旧问题不作为迁移验收通过项，后续需单独修正并补交互验证。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-feC5mR`，迁移后专项 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-PiiA5h`。
- 桌面全局 class 727 → 662、跨文件重复 92 → 85、后代选择器 646 → 639、important 声明 10 → 5；弹窗业务行为未改。完整浏览器矩阵 272 项、类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、Modal 3 项测试及桌面/Web 生产构建通过，renderer CSS 约 517.06 kB。真实应用的整页视觉验收仍未完成。

### 批量任务按钮操作区

- `BatchTaskControls` 按钮形态的行布局、尺寸、忙碌动画及 500px 设置容器内拉伸迁入同名 CSS Module；删除 `settings-overview.css`、`workspaces.css` 对旧 `batch-action-row--compact` 的规则，并移除仅剩无消费者规则的 `entity-editors.css` 及导入。图标形态和 `SettingsOverviewPanel` 的详情按钮也共用该 Module，删除原全局图标规则；保留图标语义与调用方行为。
- 旧全局导入顺序使实际按钮间距为 10px，虽然紧凑规则写了 8px；Module 按最终生效值保留 10px。四档宽度 × 深浅主题的 8 张按钮与图标夹具截图迁移前后逐字节一致，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-u5KOSV`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-UNVOLP`。
- 图标形态及详情按钮增加夹具后，四档宽度 × 深浅主题新增 8 张基线与迁移后截图逐字节一致：基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-xtfToK`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Awk8O4`。
- 桌面全局 class 662 → 654、跨文件重复 85 → 84、后代选择器 639 → 638；删除已经没有意义的浏览器夹具旧 CSS 顺序重放。最终浏览器矩阵 280 项通过，含按钮／图标忙碌态，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-C22eTG`；类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 约 516.76 kB。真实设置页的完整视觉验收仍待进行。

### 设置概览刮削覆盖率

- `SettingsOverviewPanel` 内的 `ScrapeCoverageBlock` 把标题、摘要、覆盖率条和三种区段颜色迁入 `SettingsOverviewPanel.module.css`。两个现有调用方都在媒体卡片内，原全局父级覆盖使顶部外边距实际为 0，Module 按该生效值保留。工作区字体规则中的该块例外一并收口，删除无渲染调用方的旧图例和圆点规则。
- 真实覆盖率块夹具包含有失败数与无失败数两种状态。1440/1000/640/480px × 深浅主题的 8 张截图迁移前后逐字节一致；顶部外边距 0、进度条 8px、标题行 11px/15.95px 计算值不变。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-72oXIe`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-WMW90G`。
- 桌面全局 class 654 → 641、跨文件重复 84 → 82、后代选择器 638 → 636；完整浏览器矩阵 288 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-G0FoIw`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 约 515.95 kB。设置概览的其他状态卡、媒体卡和布局仍是全局样式，不能将整页标记完成。

### 设置概览状态卡

- `SettingsStatusCard` 的网格、普通与需关注状态、插件名两行截断、说明堆叠、悬停/键盘焦点及主题样本尺寸归入 `SettingsOverviewPanel.module.css`。主题样本值以显式 `valueVariant="theme"` 表达，不再由全局 `:has()` 从子节点推断；保留共享主题样本的颜色类。940px 命名容器内的网格最小列宽也迁入 Module，删除对应全局规则。原黑色悬停阴影保持值不变，在语义 token 中集中定义。
- 真实状态卡夹具涵盖普通、需关注、长插件名、双行说明和主题样本。1440/1000/640/480px × 深浅主题的 8 张默认态截图逐字节一致；8 张悬停态中 6 张逐字节一致，另外 2 张各有 1 个栅格像素差异，未见布局差异。点击回调、键盘焦点、网格列宽及无横向溢出检查通过。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-3B1gIP`，迁移后专项 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Pium1n`。
- 桌面全局 class 641 → 630、跨文件重复 82 → 80、后代选择器 636 → 635；稳定状态下完整浏览器矩阵 296 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-u0OlLp`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查及桌面/Web 生产构建通过，renderer CSS 约 515.77 kB。原有设置概览测试依赖已删除的 class 定位，改用只读结构标记后 1 项通过；状态卡虽完成迁移，设置概览页面整体仍有全局规则。

### 设置概览批量任务状态区

- `BatchOverviewStatus` 的空闲／运行／不可恢复布局、进度条、状态文字与操作计数迁入 `SettingsOverviewPanel.module.css`；动态进度宽度仍由运行时提供。旧 `.is-idle`、`.is-active` 及跨节点状态覆盖改为局部状态 class。`BatchSettingsPanel` 仍使用的 `.batch-task-unrecoverable` 提示规则保留。
- 新增真实状态区夹具，覆盖空闲但有待确认、运行中及暂停不可恢复三种状态，并验证待确认和详情回调。四档宽度 × 深浅主题的 8 张截图与迁移前逐字节一致；基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-npOUQO`，清理后的专项输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-2WYaNH`。
- 旧状态行和批量任务卡已无渲染调用方，连同设置工作区字体覆盖一并删除；共享策略卡／Agent 工具卡规则保持。桌面全局 class 630 → 613、跨文件重复 80 → 76、后代选择器 635 → 617；完整浏览器矩阵 304 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-H9WKOG`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、设置概览 LAN 状态 1 项测试及桌面/Web 生产构建通过，renderer CSS 约 512.86 kB。设置概览媒体卡与其他布局仍待迁移。

### 设置概览媒体卡

- `SettingsOverviewPanel` 的影片/演员媒体卡网格、卡片容器、标题、空态文字、操作按钮行及说明文字归入同名 Module；740px 设置工作区容器内改为单列的规则也一起迁入。共享 `settings-overview-panel`/`settings-overview-panel-head` 仍被 `AppUpdatePanel` 使用，保留全局，不借本批穿透迁移。
- 浏览器夹具改为挂载真实设置概览页面，以合成统计数据分别覆盖有数据与空数据两态。1440/1000/640/480px × 深浅主题共 16 组，卡片布局计算值、按钮回调及无横向溢出检查通过；14 张截图逐字节一致，640px 深色的两张截图分别有 10 与 82 个零散栅格像素差异，布局计算值完全相同。有数据基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-vQ7ib7`，空数据基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-fZ6UXF`，迁移后分别为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-WhlIiP` 与 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-oKXEB1`。
- 桌面全局 class 613 → 606、跨文件重复 76 → 75、后代选择器 617 → 613；完整浏览器矩阵 320 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-hlRRu2`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、设置概览 LAN 状态 1 项测试及桌面/Web 生产构建通过，renderer CSS 约 513.21 kB。整页中状态面板外壳、Agent 工具等仍待迁移，本批不能标记设置概览整页完成。

### 设置面板外壳与 Agent 工具

- `SettingsOverviewPanel` 与 `AppUpdatePanel` 共用 `SettingsPanel`/`SettingsPanelHead`/`SettingsPanelTitle` 及同名 Module；标题用显式组件标记，避免共享 `h3` 后代选择器误覆盖版本说明中的 Markdown 标题。概览根布局及 Agent 工具卡片归入概览 Module；删除旧全局面板、Agent 工具和无渲染调用方的策略卡规则、工作区覆盖。版本更新的业务内容样式仍留在全局，下一批迁移。
- 真实概览有数据/空数据与状态卡夹具的 32 张默认截图中 31 张与上批逐字节一致；480px 深色空数据一张仅有 82 个零散栅格像素差异，布局计算值全部一致。新增真实 `AppUpdatePanel` 夹具，四档宽度 × 深浅主题 8 组验证面板边框、按钮、版本状态切换及无横向溢出；目视检查 480px 深色布局，但没有迁移前版本更新截图基线，不宣称它逐像素不变。完整浏览器矩阵 328 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Xg0Sjc`。
- 桌面全局 class 606 → 593、跨文件重复 75 → 70、后代选择器 613 → 606；类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、设置概览 LAN 状态测试及桌面/Web 生产构建通过，renderer CSS 约 511.67 kB。概览页通知条、版本更新内容及其他设置页仍未完成，继续按计划迁移。

### 版本更新面板内容

- `AppUpdatePanel` 的版本元数据、可用版本卡、忽略态、操作区、更新说明和窄窗排版迁入自己的 CSS Module，删除 `settings-overview.css` 内全部 `app-update-*` 全局规则。共享面板外壳继续使用 `SettingsPanel`，正文 Markdown 标题只受本面板 Module 约束。
- 真实面板夹具四档宽度 × 深浅主题，迁移前后 8 张普通态截图中 7 张逐字节一致；1440px 浅色主题一张的版本名由原先低对比浅色字改为 `--text-primary`，其余内容无像素差异。新增“暂不提醒”及展开 Markdown 说明的 8 组检查：忽略按钮隐藏、说明标题可见、版本名与面板标题文字颜色一致，未发现横向溢出。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-p0z8HG`，迁移后完整矩阵输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-G1A6I4`。
- 桌面全局 class 593 → 584、跨文件重复维持 70、后代选择器 606 → 607（显式版本名颜色规则增加一项）；完整浏览器矩阵 336 项、类型、Module stylelint、定向 ESLint、CSS 架构及桌面/Web 生产构建通过，renderer CSS 约 511.70 kB。设置概览通知条与其他设置页仍有全局规则，尚未达到全量迁移目标。

### 跨页面通知条

- 新增共享 `NoticeBanner` 及同名 Module，统一警告/信息外框、文案与操作区。`SettingsOverviewPanel` 的通知列表归入本页面 Module；`PluginDevConnectionModal` 的连接错误和 `ActressDeleteModal` 的高风险警告改用同一组件。删除 `settings-overview.css` 中全部 `settings-notice-*` 规则和工作区字体覆盖；演员删除弹窗特有图标、对齐和文案伸缩归入自己的 Module，删除 `conflict-review.css` 的旧穿透规则。组件契约同步记录。
- 为三个实际调用场景新增浏览器夹具，分别覆盖 1440/1000/640/480px × 深浅主题。概览警告/信息及动作、连接错误、演员删除警告共 24 张迁移前后截图全部逐字节一致，动作回调和页面无横向溢出检查通过。基线依次为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-ZmKR5b`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-BL8Uae`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-3QEJXd`；迁移后专项输出依次为 `r5k9zc`、`Jsdiln`、`8FLeTy`（同一临时目录前缀）。
- 桌面全局 class 584 → 577、跨文件重复 70 → 69、后代选择器 607 → 606；完整浏览器矩阵 360 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-yn3wID`。类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、演员删除确认模型 3 项、设置概览 LAN 1 项及桌面/Web 生产构建通过，renderer CSS 约 511.68 kB。剩余设置页及全局样式仍需继续迁移。

### 设置概览遗留规则与工作区外壳

- 全仓源码确认无调用方后，删除旧概览指标卡、指标网格、英雄提示、策略列和主题样本的全局规则及其工作区响应式覆盖；保留实际仍在使用的批量任务提示。`SettingsWorkspaceShell` 的概览页根布局与底部内边距归入同名 Module，删除 `settings-overview.css` 和根 `styles.css` 中的旧外壳规则。导航、标签和设置内容仍依赖全局样式，外壳迁入不代表整页完成。
- 新增真实 `SettingsWorkspaceShell` 夹具，内嵌版本更新面板，四档宽度 × 深浅主题 8 张迁移前后截图及全部布局计算值逐字节一致；验证分类导航回调与无横向溢出。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-xtfiQF`，迁移后专项输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-2nz7Hd`。
- 桌面全局 class 577 → 567、跨文件重复 69 → 64、后代选择器维持 606；完整浏览器矩阵 368 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Q9Hg4a`。类型、Module stylelint、定向 ESLint、CSS 架构及桌面/Web 生产构建通过，renderer CSS 约 509.56 kB。剩余设置、插件开发、待确认中心、Web 页面与全局残留审计继续列为未完成。

### 设置工作区分类导航与内容栈

- `SettingsWorkspaceShell` 独占的分类导航、活动态、滚动区、内容栈及 500px 容器下的滚动槽归入同名 Module；删除 `settings-overview.css`、根 `styles.css` 和 `workspaces.css` 中相应全局规则。活动视觉状态使用外壳的 `activeGroup` 输出 `data-active`，不依赖 `NavLink` 在测试路由下可能覆写的 `aria-current`；后者仍保留用于可访问语义。已无作用的“末尾设置卡 margin”规则随迁移删除，因为共享卡本身已是 `margin-bottom: 0`。
- 真实外壳夹具四档宽度 × 深浅主题，8 张迁移前后截图与布局计算值逐字节一致；补充活动标签 `data-active` 与非透明边框断言、分类点击回调及无横向溢出检查。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-2nz7Hd`，迁移后专项输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-W4qIvi`。
- 桌面全局 class 567 → 561、跨文件重复 64 → 61、后代选择器 606 → 603、全局状态 class 52 → 51；完整浏览器矩阵 368 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-GAYhgj`。类型、Module stylelint、定向 ESLint、CSS 架构及桌面/Web 生产构建通过，renderer CSS 约 509.39 kB。设置页内具体 panel、插件页与 Web 仍在后续范围，不能将批次 6 或全局目标标记完成。

### 批量任务详情面板

- `BatchSettingsPanel` 的卡片根、操作栏、统计、进度、日志及 500px 容器响应规则迁入同名 CSS Module；删除设置概览、弹窗覆盖和工作区中的对应全局规则。日志行改由只读 `data-batch-log-line` 定位测试，批量任务行为与共享 `SettingsCard`、`SettingsStatusPill` API 不变。
- 新增真实批量详情弹窗夹具，覆盖无任务、运行中和暂停不可恢复三态。1440/1000/640/480px × 深浅主题共 24 张迁移前后 RGB 截图逐像素一致，动作回调、进度条、日志与无横向页面溢出检查通过。三态基线依次为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-kxs86i`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-u8PIZ0`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-yu3mva`，修正卡片内边距后的专项输出依次为 `6ngLYi`、`EStttm`、`mnPnlE`（同一临时目录前缀）。480px 运行态原本就有统计区文字拥挤，本批按原样保留，不把它记作已修复。
- 桌面全局 class 561 → 544、跨文件重复 61 → 52、后代选择器 603 → 595；修正后的完整浏览器矩阵 392 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-TPH48B`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、批量详情组件测试及桌面/Web 生产构建通过，renderer CSS 约 509.08 kB。共享 `SettingsEmptyPanel` 的 batch 空态变体仍依赖全局规则，需随该共享组件后续迁移；设置页和全部页面的迁移目标尚未完成。

### 跨页面设置空态

- `SettingsEmptyPanel` 的通用、虚线和紧凑样式迁入 `SettingsPrimitives.module.css`，`BatchSettingsPanel` 与 `PluginsSettingsPanel` 分别接管批量日志和插件空态的专属样式。`EmptyState` 为说明容器提供 `descriptionClassName` 显式入口，避免跨组件全局后代选择器；组件契约同步记录。删除 `settings-overview.css`、`feedback-overlays.css`、`settings-plugins.css` 和 `workspaces.css` 中的旧空态类。媒体库来源空态的 86px 最小高度原本被高优先级全局规则覆盖，移除该无效声明后保持原有 38px 呈现。
- 新增六种空态组合夹具，覆盖普通、虚线、紧凑、媒体库来源、插件及批量日志。1440/1000/640/480px × 深浅主题的 8 张 RGB 截图及所有计算布局值与迁移前一致；基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-I4Ttyh`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-4hs0NO`。批量详情空态另与旧版基线的 8 张截图逐像素一致，专项输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-EkaW4J`。
- 桌面全局 class 544 → 537、跨文件重复 52 → 47、后代选择器 595 → 592；完整浏览器矩阵 400 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-DkydsC`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、设置原语与批量详情组件测试及桌面/Web 生产构建通过，renderer CSS 约 507.94 kB。插件设置页其余规则与其他页面的全局残留仍未迁完。

### 插件管理面板与插件卡片

- `PluginsSettingsPanel` 的卡片外壳、搜索／排序工具栏、网格及窄窗响应归入自己的 Module；删除始终未启用的卡片滚动选项与规则。`PluginCard` 的卡片结构、默认态、悬停／焦点、字段覆盖条、操作按钮和浮层菜单归入同名 Module，来源改用只读 `data-source`。删除无渲染调用方的旧列表式插件布局。来源徽标还被插件配置弹窗和开发工作区共用，暂保留 `settings-plugins.css` 中的该组全局规则，后续应提升为共享原语再删除。
- 真实面板夹具覆盖空列表与内置、用户、组合插件三卡，含搜索、清空、导入、卡片悬停、菜单打开及导出回调。四档宽度 × 深浅主题下，最终空态 8 张中 6 张、三卡默认／悬停／菜单 24 张中 20 张与基线 RGB 逐像素一致；差异仅在部分浅色截图的面板标题字色和菜单触发图标的焦点色，布局计算值相同。标题原本未显式指定颜色，基线在不同截图间已出现深浅不一致，本批未把它当成已解决的对比度问题。空态基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-1HmNuC`，卡片悬停／菜单基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-o17pBN`，最终矩阵输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-5Am5K7`。
- 桌面全局 class 537 → 495、跨文件重复维持 47、后代选择器 592 → 583；完整浏览器矩阵 416 项通过。类型、全量 Module stylelint、定向 ESLint、CSS 架构、MetaTube 配置及设置原语组件测试、桌面/Web 生产构建通过，renderer CSS 约 505.07 kB。插件配置弹窗、开发工作区和其他页面仍需继续迁移。

### 插件来源徽标

- 新增 `PluginSourceBadge` 与同名 CSS Module，插件卡片、插件配置弹窗和开发工作区三个调用点统一使用显式 `source` 属性。删除 `settings-plugins.css` 的最后一组全局徽标规则及开发工作区重复的字号覆盖；模型标签仍沿用原有 user 色调，不改变业务语义。插件配置弹窗及开发工作区其余样式尚未迁移。
- 三种来源及模型标签加入插件设置夹具；四档宽度 × 深浅主题的默认、悬停、菜单 24 张迁移前后 RGB 截图中 23 张逐像素一致，唯一差异位于此前已存在不稳定的 480px 浅色面板标题，与徽标无关。专项基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-RSts0J`，迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-wZHBaY`。
- 桌面全局 class 495 → 490，跨文件重复及后代选择器均未增加。完整浏览器矩阵 416 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-uH512T`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、插件配置与开发工作区组件测试、桌面/Web 生产构建通过，renderer CSS 约 504.98 kB。剩余页面迁移仍需继续。

### 插件配置弹窗

- `PluginConfigModal` 的表单壳、基本资料、服务连接、访问间隔、预登入与字段徽标全部归入同名 CSS Module；删除 `feedback-overlays.css` 中整组 `plugin-config-*` 全局规则及开发工作区样式表内已无其他调用方的 `plugin-edit-form` 桥接。`SettingsNumberStepper` 增加 `fill` 属性，由共享原语自身处理整宽数字输入，不再由弹窗穿透其内部 class。预登入列表的局部样式也由弹窗持有；其他页面仍使用原全局列表样式。
- 真实弹窗夹具覆盖内置 MetaTube 服务配置（含连接测试）与可编辑用户插件（含预登入开关），四档宽度 × 深浅主题，迁移前后默认及交互后共 32 张 RGB 截图逐像素一致。基线分别为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-f8kFL2` 与 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-ORadNm`；迁移后专项输出分别为 `q4Y0XT` 与 `KjSPd1`（同一临时目录前缀）。夹具还验证弹窗视口边界、无页面横向溢出及支持字段列表；迁移前截图只覆盖滚动容器首屏，不能据此宣称下半部逐像素相同。480px 下访问间隔控件原有拥挤，本批保留原样，未当作修复。
- 桌面全局 class 490 → 457、跨文件重复 47 → 45、后代选择器 583 → 580；完整浏览器矩阵 432 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-0tOR3U`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、MetaTube 配置及设置原语 12 项组件测试、桌面/Web 生产构建通过，renderer CSS 约 504.69 kB。组合插件弹窗已拥有自己的 CSS Module；开发工作区及其他设置页面仍未迁完。

### 插件开发配置栏与字段标签

- `PluginDevConfigRail` 的栏位壳、提示、输入控件、模式徽标、滚动区、元数据行和底部操作栏归入同名 CSS Module；`PluginDevFieldTags` 的标签列表、删除与添加控件归入自己的 Module。字段标签通过显式 `className` 接收配置栏间距，删除两者间的全局后代选择器。旧 `plugin-edit-control`、字段标签及配置栏规则从全局样式表移除；无源码调用方的旧编辑摘要、字段切换和高级选项规则也一并删除。配置栏提示测试改用只读 data 属性定位。
- 新建、调试和独立字段标签三类真实组件夹具，各覆盖四档宽度 × 深浅主题的默认、滚动后或悬停状态。迁移前后共 48 张 RGB 截图逐像素一致；基线分别为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-kIf5xK`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-cqSvGH`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-jScYX3`，迁移后分别为 `BjWI0O`、`YUD3dP`、`DQ5cDd`（同一临时目录前缀）。夹具验证稳定滚动槽、操作回调和无页面横向溢出；不把这三个组件夹具当作开发工作区整页验收。
- 桌面全局 class 457 → 421、跨文件重复 45 → 43、后代选择器 580 → 568；完整浏览器矩阵 448 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-4wBxZf`。类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、配置栏/对话组件测试及桌面/Web 生产构建通过，renderer CSS 约 500.86 kB。开发工作区目标选择弹窗、Agent 会话、预览与结果面板仍有大量全局规则，继续列为未完成。

### 插件开发目标选择弹窗

- `PluginDevMediaTargetPicker` 的弹窗高度、滚动区、目标行、选中态、封面及错误/空态迁入同名 CSS Module；通过 `Modal.bodyClassName` 设置主体留白，演员头像继续使用组件入口，不再依赖全局后代类。封面的隐私遮罩规则从 `library-content.css` 收回弹窗 Module；删除无调用方的旧分页规则。
- 新增真实影片/演员目标夹具，四档宽度 × 深浅主题，迁移前后默认、选中、空态合计 48 张 RGB 截图逐像素一致。影片基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-qlX3XT`、迁移后 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-t3ejlX`；演员基线 `JX6VIB`、迁移后 `d23qjq`（同一临时目录前缀）。另为影片封面隐私模式增加了计算样式断言和截图；夹具中的封面是合成测试图，不代表真实资源加载验收。
- 桌面全局 class 421 → 406、跨文件重复 43 → 42、后代选择器 568 → 566。完整浏览器矩阵 464 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-2SyJTo`；影片隐私态专项 8 项另行通过。目标选择弹窗组件测试 9 项、类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查及桌面/Web 生产构建通过，renderer CSS 约 500.23 kB。插件开发工作区其他组件和全部页面仍未迁完。

### 插件开发 Agent 对话区

- `PluginDevConversation` 的消息、工具结果、运行标签、滚动日志和输入操作栏归入已有同名 CSS Module。工具状态及类别改为显式 `data-*`，测试使用只读日志标记，不再依赖全局 class。新建共享 `PluginDevAgentEmpty`，由对话和结果面板复用；移除无调用方的旧时间线、聊天面板和工具样式。Agent rail、结果面板其他桥接及工作区壳仍待迁移。
- 真实对话组件夹具覆盖运行中与空态、工具详情展开和输入发送，四档宽度 × 深浅主题。迁移前后共 32 张 RGB 截图逐像素一致；运行态基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-igR99Z`、迁移后 `eoQtKN`，空态基线 `ztsbNW`、迁移后 `VskeSZ`（同一临时目录前缀）。旧空态的 6px gap 声明实际上被共享 `EmptyState` 覆盖，迁移时按原有 10px 呈现保留，没有把无效声明复制成视觉变化。
- 桌面全局 class 406 → 370、跨文件重复 42 → 41、后代选择器 566 → 561、全局状态 class 43 → 37。完整浏览器矩阵 480 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-XBmFXs`；对话及结果面板测试 11 项、类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查及桌面/Web 生产构建通过，renderer CSS 约 496.94 kB。整页和全量迁移目标仍未完成。

### 插件开发 Agent 栏与代码查看

- `PluginDevAgentRail` 的栏位、页签和滚动布局迁入专属 Module；`PluginDevResultPanel` 的折叠结果详情归入原有 Module。配置栏剩余文本框规则也收回自身 Module。共享 `WorkbenchTabs` 增加调用方可传入的页签 class，避免让 Agent 栏穿透共享组件。清除已核对无调用方的旧工作区、验证及时间线规则。
- JavaScript 高亮器改为接收调用方的局部 class 映射，`CodeEditor` 与 `PluginDevCodeModal` 复用同一套 Module 样式；代码查看弹窗的容器、工具栏和内容样式迁入其 Module。开发类型切换按钮的布局规则也归入 `PluginDevPanel`。旧 `plugin-development-workbench.css` 最后几处状态文字调用改用语义 `StatusText` 后，移除该全局样式表及导入；原有文本标签语义和错误描述 id 保持。
- Agent 栏 24 张、配置栏 32 张、代码弹窗 16 张、开发类型切换 16 张及批量设置运行态 8 张专项截图迁移前后逐像素一致。代码编辑器 16 张中有 6 张存在少量焦点/光标相关像素差异，目视布局与高亮一致，不宣称逐像素相同。专项基线依次为 `U5uku7`、`qUgfVi`/`rxzFMn`、`fgDxzT`、`rIXMhd`、`mA8mza`，迁移后为 `7M24RJ`、`oUEMH7`/`ofyJ7E`、`IUTkMw`、`hd7yH6`、`ukGXb6`（同一系统临时目录前缀）。
- 桌面全局 class 370 → 316、跨文件重复 41 → 35、后代选择器 561 → 546、全局状态 class 37 → 33。完整浏览器矩阵 512 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-3tw6x6`；定向组件/高亮测试 9 项、类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 约 488.58 kB。开发工作区壳、工具栏、共享表单和其他页面仍有全局规则，整仓迁移尚未完成。

### 插件开发工作区壳与共享表单字段

- `PluginDevPanel` 的工作区壳、面包屑、工具栏、状态徽标、图标按钮及双栏布局迁入同名 CSS Module；运行态改用 `data-status`，设置页内的布局覆写通过 `SettingsPluginDevShell` 提供的显式上下文标记连接。940/740px 容器断点一并迁入 Module，移除全局表中已无调用方的工作区规则。
- 共享 `AppFormField` 已自带局部样式，移除其残留的 `settings-form-*` 全局类。其余旧行、URL 操作输入等规则核对后均无渲染调用方，删除整个 `plugin-development-shell.css` 及导入。字段的实际生效间距为 8px，与 Module 的语义间距一致，不复制无效的旧 6px 声明。
- 设置页内和独立壳两组工作区夹具各覆盖四档宽度 × 深浅主题及运行/焦点态，迁移前基线分别为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-SpIn90`、`/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-FELTVm`；迁移后稳定态输出分别为 `zbeh3p`、`WSdMvA`（同一前缀）。两组共 8 张深色默认态截图逐像素一致；旧交互截图存在点击后的状态/主题过渡时序差异，不能用作逐像素不变的证据。测试现已等待状态和颜色稳定，并检查布局、主题文字颜色和无横向溢出。
- `AppFormField` 四档宽度 × 深浅主题的默认与输入后共 16 张截图迁移前后逐像素一致；基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-FWjDkk`，迁移后 `jZouS3`。本批桌面全局 class 316 → 279、跨文件重复 35 → 31、后代选择器 546 → 530；完整浏览器矩阵 536 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-JTUFDg`。开发工作区组件测试 2 项、类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 约 484.06 kB。其他页面全局规则仍待继续迁移。

### 设置入口与批量详情弹窗壳

- 设置加载文字和批量详情弹窗的尺寸、标题及主体布局迁入 `SettingsPage.module.css`；开发助手设置入口布局归入 `SettingsWorkspaceShell`，返回链接归入 `PluginDevPanel`。删除全局设置、工作区和弹窗表中的对应规则；开发助手入口不再依赖全局组合选择器提供宽度与留白。
- 加载态 8 张、批量详情空/运行/暂停态 24 张、设置页内与独立开发助手壳 48 张专项截图迁移前后逐字节一致。加载基线/迁移后为 `hhpPUv`/`IoWVKO`；批量详情为 `w1dtKn`/`WWY3jJ`、`PmSm7P`/`V0FCPl`、`d2sCAh`/`xfeCbj`；开发助手壳为 `DAygth`/`BZjsBX`、`EZ6oOX`/`ByVNZ6`（统一系统临时目录前缀）。工作区壳夹具只验证外层布局与状态，不代表完整 Agent GUI 验收。
- 桌面全局 class 279 → 272、跨文件重复 31 → 26、后代选择器 530 → 531。完整浏览器矩阵 544 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-kkkAPg`；相关组件测试 3 项、类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查、diff 检查及桌面/Web 生产构建通过，renderer CSS 约 484.07 kB。其他设置组件与页面仍有全局残留，全量迁移尚未完成。

### 演员冲突处理与合并弹窗

- `PendingActressConflictPane` 的归属卡片、来源列表／详情、影响摘要、其他演员选择器及名称编辑／替代主名表单归入自身 Module；头像尺寸通过 `ActressAvatar.className` 明确传入，编辑输入复用 `TextInput`。选中态使用 `data-selected` 或已有 `aria-pressed`，其他演员卡片提供只读定位标记。`ConflictMergeActressesModal` 的字段组、演员卡片和最终主名选择归入新 Module；选择与提交业务不变。
- 核对并删除未被渲染的旧“已选演员”、禁用样式分支、非法名称色类和候选分页规则。`ActressDeleteModal` 的确认内容和错误规则收回自身 Module 后，删除整个 `conflict-review.css` 及导入。原确认段落的 `margin: 0` 被共享 Modal 覆盖，迁移不重新激活该声明，保留原有间距。
- 新增真实冲突 pane 夹具，覆盖拟定归属、来源资料／历史声明、其他演员选择与焦点、返回名称编辑及替代主名错误。四档宽度 × 深浅主题，共 72 张截图，66 张与基线逐字节相同；其余 6 张只有焦点边缘 1～21 个像素不同，不宣称全部逐像素一致。基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-Ixf5TE`，迁移后 `730DpA`。夹具未覆盖暂存资源图片、真实远程请求或完整待确认队列，不当作全流程验收。
- 合并弹窗普通／阻止合并两态共 24 张截图迁移前后逐字节一致；基线 `S2hmYS`/`fZ1JBU`，迁移后 `wJf2Fz`/`jetzsl`。检查显式保留档案和最终主名选择、确认资格及提交参数。演员删除弹窗 8 张截图也与基线相同，基线 `l69ILE`，最终输出 `dFfI7U`（以上均使用同一系统临时目录前缀）。
- 本批桌面全局 class 272 → 239、跨文件重复 26 → 25、后代选择器 531 → 530、全局状态 class 28 → 19。冲突交互／状态测试 31 项和删除确认模型测试 3 项、类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查及桌面/Web 生产构建通过，renderer CSS 约 482.25 kB。完整扩展浏览器矩阵 568 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-jgc1L5`；最终 diff 检查通过。全量目标仍未完成。

### 分类合并、导演候选与演员合并

- `ClassificationMergeModal` 的预览卡片、合并方向、搜索区、合并规则及错误样式归入同名 Module。分类合并和 `DirectorScrapeChoiceModal` 共用 `ClassificationChoices`：列表外框、候选按钮、装饰圆点、截断文案和空态由一个 Module 管理，调用方通过原有 option/radio 语义和 `selected` 表达选中，保留原生按钮、焦点与提交逻辑。没有将演员头像／虚拟列表强行并入该共享抽象。
- `MergeActressModal` 的预览卡片、头像尺寸、独立滚动区、连续候选列表和主名方案全部归入同名 Module；状态使用 `data-*` 和已有 `aria-selected`。空态及头像通过显式 class 入口定制，不穿透其他组件的全局类。保留原有错误颜色（`--danger`），避免语义混色 token 在迁移中改变外观，后续 token 审计再统一。
- 删除 `entity-browsing.css` 与 `library-content.css` 中对应旧规则，以及已无调用方的旧行式列表、分页、说明、内联链接和标签禁用规则。两张表仍有分类删除错误、演员画廊分页、图片隐私和提示样式，不能整表删除。旧 `merge-actress-ui.mjs` 仅同步只读布局定位器，仍依赖已移除的显式分页，未运行也未计为通过。
- 真实弹窗加合成数据夹具覆盖四档宽度（1440/1000/640/480px）× 深浅主题的默认／选中／提交失败、空列表、读取失败及导演忙碌状态，56 组专项检查通过。分类合并普通、空、读取失败基线分别为 `fAyujF`、`jvuGV7`、`SqP8tP`，迁移后为 `CRWg8a`、`HGJGZX`、`mPIKag`；导演候选为 `XQsWom` / `IAQtMB`；演员合并普通、空、读取失败为 `KSYdmX`、`iVXzlN`、`VyWFH1` / `DAxyCC`、`rtos6Y`、`XVrw1a`。均使用 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-` 前缀。共 104 张截图，103 张逐字节一致；演员读取失败的 1440px 深色截图有 10 个焦点边缘像素差异，不宣称全部逐像素相同。夹具使用真实组件但没有真实资料库或远程请求，不代表整页／全流程验收。
- 桌面全局 class 239 → 173、跨文件重复 25 → 21、全局状态 class 19 → 12；后代选择器 530 → 533，新增项均局部于 Module 的内容或显式 class 入口。相关交互／状态测试 9 项、类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件检查及桌面/Web 生产构建通过，renderer CSS 约 481.74 kB。完整扩展浏览器矩阵 624 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-WVDmtg`；最终 diff 检查通过。全量迁移仍未完成。

### 分类删除确认与演员画廊分页

- 导演／系列删除和机构删除／角色移除接入共享 `ClassificationDeleteNotice`，影响检查的加载提示、可复制正文及错误样式由同名 Module 持有。无法移除最后角色的提示复用 `ClassificationDeleteError`。领域文案、资格和命令仍由原有调用方及 hook 管理；不改业务行为。现有 `StatusText` 的危险色与原删除错误色不同，本批不强行复用，避免更改外观。
- 删除已无样式定义的旧确认容器与安全说明 class；旧错误的 `margin: 0` 被 Modal 段落规则覆盖，迁移时不重新激活，保留实际呈现间距。
- 演员画廊和头像写真来源统一接入 `GalleryPagination` 与同名 Module，保留每页 60 项、前后页资格、画廊总量文字及头像小按钮／隐藏总量变体。查询、版本及预览会话仍由原 hook 管理，原语不读取资料。删除 `entity-browsing.css` 的最后两组规则及全局导入，源码和脚本中无对应旧 class 残留。
- 新增九种真实调用方夹具，覆盖导演／系列删除、完整删除机构、移除角色、最后角色阻止、影响读取失败／加载和两处画廊翻页。四档宽度 × 深浅主题的 72 组专项检查通过，迁移前后 152 张截图逐字节一致。删除各态基线依次为 `tZm1WQ`、`03Ayts`、`0VCD6F`、`PSjinF`、`2LWv2G`、`D51Yca`、`iPeWNe`，迁移后为 `GDwS11`、`YyITq7`、`47Ln5E`、`Hz9mmW`、`XJ0fSj`、`0B01S1`、`DOsg1A`；画廊与头像分页为 `15g4fk` / `t6mut6`、`x9a9sv` / `45AGPl`。统一使用系统临时目录 `javdex-css-modules-` 前缀。分页夹具使用合成资产路径，检查页面及按钮布局、页码、查询偏移和边界，不证明真实图片资源加载；删除调用也仅作用于合成回调。
- 删除与两处画廊交互测试 16 项、共享分页测试 3 项通过；类型、Module stylelint、定向 ESLint、CSS 架构、UI 控件和桌面/Web 生产构建通过，renderer CSS 约 481.74 kB。桌面全局 class 173 → 171，其余架构债务指标未增加。完整扩展浏览器矩阵 696 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-jXbzDB`；最终 diff 检查通过。整仓目标尚未完成。

### 图片预览与分类图片隐私样式

- `ImagePreviewLightbox` 的覆盖壳、自动隐藏工具栏、背景选择、缩放／平移、切图滑动、缩略图及拖动状态归入同名 Module；状态使用显式 data 或已有 aria 属性。图标按钮覆写只引用本组件局部 class，不再依赖 `IconButton` 的全局桥接。保留动态变换、计时器及既有提交／跨页回调；stage 宽度通过 ref 获取，删除功能代码对旧全局 class 的查询。
- `ClassificationImageModal` 的预览／候选封面隐私规则归入自身 Module，移除两处全局图片桥接；根隐私属性仍是既有显示契约，遮罩不拦截控件。删除全局表中无渲染调用方的旧 `card-interactive` 和 `sample-import-*` 规则。`library-content.css` 仍有 hint，`media-details.css` 仍有资源编辑规则，不能整表删除。
- 新增三类真实预览组件夹具（普通多图、有界图片窗口、无本地路径），四档宽度 × 深浅主题共 24 组交互检查，覆盖工具栏初始隐藏、键盘缩放／还原、真实指针平移、边缘命中区滑动、完整 stage 宽度、未加载页边界、缩略图拖动／选中、加载禁用、背景保存和关闭。合成 SVG 全尺寸图片实际完成加载，但不代表 media 协议或真实资料库验收。168 张截图中 161 张与基线逐字节一致，其余 7 张只有顶栏小范围像素不同（52～177 像素），不宣称全部逐像素相同。基线普通／有界／缺失路径依次为 `9LcLqt`、`dBFIfl`、`7GYq6G`，迁移后为 `hkacWw`、`Nbolab`、`ivZmyw`（统一系统临时目录 `javdex-css-modules-` 前缀）。
- 分类图片实际编辑器夹具扩展至四档宽度、导演／机构图片裁切、深浅主题及 covers-only 隐私模式，检查预览和候选图滤镜、放大、遮罩及可操作性；原媒体编辑隐藏／请求隔离、封面分页重试和保存检查仍保留。36 张截图迁移前后逐字节一致，基线 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-image-editor-ui-eLzvFa/results`，迁移后 `javdex-image-editor-ui-U3dKtd/results`。夹具 IPC 与图片为合成数据；修正夹具的对象切换等待，未更改业务行为。旧 `actress-detail-ui.mjs` 仅同步预览定位器，其其他旧分页／头像选择器仍失效，未运行或计为通过。
- 手势／历史标记、缩略图入口、演员画廊和分类主图交互测试合计 17 项通过；类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件及桌面/Web 生产构建通过，renderer CSS 约 480.43 kB。桌面全局 class 171 → 130、跨文件重复 21 → 20、后代选择器 533 → 527、全局状态 class 12 → 7、硬编码颜色声明 158 → 157。完整扩展浏览器矩阵 720 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-njKHq7`；最终 diff 检查通过。整仓迁移仍未完成。

### 外观设置、主题预览与共享开关列表

- 外观设置的主题网格、头像构图预览／检测状态、批量构图进度／操作、封面比例行及防窥范围样式全部收回 `AppearanceSettingsPanel.module.css`。运行状态改用显式 data／aria 属性，动态裁切坐标仍由构图模型计算；保存、隐私串行提交和批量命令保持不变。
- 使用共享 `ThemeChoice`／`ThemeSwatch` 管理主题选项与概览色块，直接复用既有主题 palette 并在局部定义预览角色，删除重复的四主题硬编码颜色。共享 `SettingsToggleList` 接入外观、媒体库扫描、网页访问及刮削字段弹窗的十处外框；紧凑间距用 `compact`，防窥行留白通过 custom property 由 `SettingsSwitchRow` 自身管理。卡片提供 `headerClassName`，不穿透旧标题区全局类。接口按实际共享消费者收口，没有增加新的业务配置。
- 删除 `settings-tools.css` 全部功能规则及旧开关列表相邻覆盖、无调用方 checkbox 规则和空媒体查询；该文件暂仅保留 document 级 reduced-motion reset，最终全局审计时统一归位。头像预览的固定底色移至语义 token，色值不变。设置壳字体／密度、共享输入及部分共享卡片桥接仍列后续，不因此标记整页闭包或整仓完成。
- 新增真实外观设置夹具，覆盖四档宽度（1440/1000/640/480px）× 深浅主题的主题键盘选择、构图草稿／保存、预览 ready/pending/error、隐私范围展开／收起、批量确认／运行／停止中／结束及查看日志。真实 bundled 样图完成加载，但人脸几何、检测失败和批量状态为合成测试适配，不证明实际检测 worker、资料库批量处理或全流程 GUI 验收。
- 目视发现夹具固定高度网格压缩了隐私卡片，修正夹具为自然高度 grid track，并增加七项范围完整容纳在卡片内的几何检查。用隔离 Vite adapter 加载迁移前的外观源码／CSS 和行桥接，重新建立相同修正夹具的基线，未回写生产文件。基线 24 组通过，目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-appearance-baseline-rJQpEB`；迁移后 ready/pending/error 为同一系统临时目录下 `javdex-css-modules-9wxdNX`、`5fR612`、`utA0cZ`（后两者同此前缀）。112 张截图 RGB 像素全部一致，包含隐私范围完整展开；不沿用原夹具被压缩画面的验证结论。
- 设置概览和刮削字段弹窗额外 20 张截图 RGB 像素一致；基线 `wYxxmu`／`BrvJ2B`，迁移后 `DxpVV1`／`eH06w3`（同一 `javdex-css-modules-` 临时目录前缀）。相关组件／构图和实际调用方测试合计 30 项通过；类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件及桌面/Web 生产构建通过，renderer CSS 约 478.67 kB。桌面全局 class 130 → 89、跨文件重复 20 → 16、后代选择器 527 → 511、全局状态 class 7 → 3、硬编码颜色声明 157 → 125。完整扩展浏览器矩阵 744 项通过，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-vpXPGO`；最终 diff 检查通过。整仓迁移仍未完成，继续资源导入、共享工作台、应用壳及输入／设置密度桥接。

### 资源导入弹窗与共享工作台

- `VideoResourceImportModal` 的链接／大小行、读取反馈及提交错误收回原有 Module，所有文本／数字输入接入共享 `TextInput`，显式传入整宽和弹性布局 class。仅迁移样式所有权；目标匹配、STRM 只读资格、远程手动大小、保存和读取逻辑保持不变。删除 `media-details.css` 对应规则；该表仍有 `DetailPage` 的提示、路径和整宽控件三类规则，暂不删除整表。
- 工作台的壳、工具栏、主区、rail、标题、状态及页签归入 `Workbench.module.css`，删除旧 `workbench.css` 及全局导入。实际共享原语持有样式，调用方保留已有 `className`／`tabClassName` 接口；页签通过原 `aria-selected` 表达选中。测试使用只读 part 标记和可访问角色，键盘方向键、Home／End 和禁用跳过不依赖类名。
- 新增真实资源导入弹窗的五类合成数据夹具：单条添加、媒体库添加、链接编辑、STRM 编辑、远程添加。四档宽度 × 深浅主题共 40 组检查，覆盖目标选择、添加链接、大小读取中／成功／失败、保存中／失败／重试及提交参数。IPC 回调是隔离合成数据，不访问用户资料库、真实链接或远程服务，不代表全流程 GUI 验收。
- 资源五类专项基线依次为 `tholJF`、`MyXRhb`、`UfhXf0`、`qgtClV`、`cWSYJS`，迁移后为 `sBIy04`、`CUVbIz`、`jQOfGG`、`ArIRCx`、`74hFxg`；296 张截图中 288 张 RGB 像素一致，其余 8 张各有 2～69 个输入／候选焦点及过渡像素差异。所有目录统一使用 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-` 前缀。实际查看窄窗布局和反馈，不宣称全部逐像素一致。
- 工作台六类调用方（设置内／独立开发壳、Agent 栏、创建／调试配置栏、演员冲突 pane）48 组专项检查通过。基线分别为 `W5jkRf`、`R7pKuw`、`JThc7n`、`IlqUSP`、`zBsrKK`、`VjVFfe`，迁移后为 `WHlXE8`、`maEnK0`、`l2bNF1`、`ipmyYM`、`GHAFMF`、`cGt582`（同一前缀）。176 张截图中 162 张 RGB 像素一致；其中 3 张旧 Agent 结果基线仍保留切换前的页签高亮，不作为不变证据，其余 11 张只有 1～21 个焦点边缘像素不同。浏览器脚本补充等待页签颜色稳定及真实键盘切换／焦点检查。尚未新增完整 `PendingCenterPage` 队列夹具，不把共享原语和 pane 检查当作该整页验收。
- 资源、共享表单及工作台组件测试 13 项，类型、全量 Module stylelint、定向 ESLint、CSS 架构、UI 控件及桌面/Web 生产构建通过。桌面全局 class 89 → 74、跨文件重复 16 → 15、后代选择器 511 → 508、全局状态 class 3 → 0；硬编码颜色声明 125 和 `!important` 4 均未增加。renderer CSS 478706 bytes，gzip 71686 bytes；模块化命名使体积略增约 32 bytes，不以体积下降为完成依据。完整回归终态另行记录。
- 首次全量单元测试 3326 项中 3322 通过、2 跳过、2 失败。单独稳定复现并探针确认：机构合并测试的 `findAllByProps({ role: 'option' })` 同时选中共享候选原语及其原生按钮，实际一个候选被重复计数。仅改为原生按钮角色定位，不增加等待时间、不改业务；原提交方向及失败后保留表单两项测试已通过，临时探针清除。共享原语迁移时需要同步审计 TestRenderer 的组件节点和宿主节点重复匹配。
- 修正定位器后重新执行全量 `run-electron-tests`：3326 项中 3324 通过、2 跳过、0 失败，终态退出码 0；全量 TypeScript ESLint 及再次类型检查通过。未将首次失败运行计为通过，也未以定向两项通过代替全量重跑。
- 完整扩展浏览器矩阵 784 项通过（含资源导入 40 项和新增页签稳定颜色／键盘焦点检查），终态退出码 0，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-k1yldB`。打包配置测试额外 8 项、最终脚本语法及 diff 检查通过。整仓迁移尚未完成；继续详情操作弹窗、应用壳、共享输入／设置密度桥接及 Web，不自动提交或推送。

### 影片详情操作弹窗与无消费者旧规则清理

- `DetailPage` 的操作提示、可复制资源路径和整宽控件收回自身 Module，修正番号及本地资源标签输入接入共享 `TextInput`。合并、拆分、移除与最后资源确认保持原有提交、草稿及资格判断；仅删除无样式的旧 form-field／choice-row／modal-path-hint 标记，不重新激活旧布局。删除 `media-details.css` 的最后三类规则及全局导入。
- 全源码引用审计确认 `settings-overview.css` 和 `feedback-overlays.css` 的功能 class 已无消费者，删除两表及导入；`workspaces.css` 删除对应无效字体和容器覆盖，仍保留实际使用的设置状态／单位文字与输入、按钮密度桥接。`DetailIconButton` 是最后一个依赖全局 spin 的消费者，转为自身 Module keyframe 后才删除全局动画，补充真实组件忙碌禁用及局部 animationName 检查。
- 新增实际 `DetailPage` 路由夹具，使用隔离合成影片、媒体库、资源和命令回调，经真实工具栏／资源菜单打开弹窗。普通三资源、最后本地文件、最后 STRM 三类 × 四档宽度 × 深浅主题共 24 组检查，覆盖修正输入、合并选择／禁用、标签保存失败／重试、拆分、移除及保留元数据参数、忙碌、错误详情和长路径。夹具不访问真实文件、资料库或远程服务，不证明文件删除、合并后端或全流程 GUI 验收。
- 基线采集前修正夹具 API 初始化顺序、媒体库默认刮削配置、选择框可访问定位和默认折叠错误详情的测试预期；失败运行未计入验收，未改生产行为。普通／最后本地／最后 STRM 基线依次为 `KvF1SG`、`i2zkzh`、`Of4uLE`，迁移后为 `aJVnMO`、`Dt1v5h`、`5m7CNE`；184 张截图中 181 张 RGB 像素一致，余 3 张各有 7 个背景边缘像素差异。目视复核窄窗标签错误及合并选择布局，未宣称全部逐像素一致。
- 设置状态、概览、内置插件配置额外 48 张截图 RGB 像素一致，基线分别为 `r3L8Qo`、`i3C9oY`、`1lbsVT`，迁移后为 `3bwVQB`、`QuSeMR`、`WJN1GD`。详情操作栏基线 `DzO80x`，迁移后 `TkYUhP`；原 24 张截图中 19 张一致，余 5 张差异仅位于“更多”按钮 36px 方框内，菜单截图尚未等待按钮过渡稳定，不作为逐像素不变证据；新增 8 张忙碌截图与局部动画断言通过。所有目录统一使用系统临时目录 `javdex-css-modules-` 前缀。
- 生命周期／资源控制器、Modal 和资源导入测试 18 项通过；类型、全量 TypeScript ESLint、Module stylelint、CSS 架构、UI 控件及桌面／Web 生产构建通过。桌面全局 class 74 → 48、跨文件重复 15 → 6、后代选择器 508 → 478；全局状态 class 0、硬编码颜色声明 125 和 `!important` 4 均未增加。renderer CSS 471935 bytes，gzip 70708 bytes。完整扩展浏览器矩阵和全量单元测试终态见下文。
- 桌面／共享 UI 的 CSS 架构债务基线收紧至本批实际指标（文件数量仅记录，不作上限）；不再沿用允许 1334 个全局 class 的初始上限。Web 仍待独立迁移并纳入最终架构检查，不把当前检查当作整仓完成证明。
- 全量单元测试终态：3326 项中 3324 通过、2 跳过、0 失败，退出码 0；打包配置测试额外 8 项通过。工作区及资料库、HTTP、服务端、桌面、领域和 Agent 边界检查通过。下一批先收口共享文本／多行输入调用方和设置密度，再处理刮削字段分段动作、应用壳与 Web；保留尚未完成的整页状态、移动端和全局逐条审计。
- 下一批引用审计：28 个桌面 TSX 消费者仍有 68 处 `text-input`（其中 8 个文件含 textarea）。迁移需核对实际祖先与级联：旧设置壳只覆盖 legacy `.text-input`，不覆盖已经迁入的 `TextInput`，不能简单给所有新控件施加统一 12px 字号而改变当前有效密度。多行输入另保留原生 props、稳定滚动槽与编辑表单直接子级的高度契约。
- 完整扩展浏览器矩阵终态：808 项通过、退出码 0，含新增实际详情页三类场景的 24 项和详情按钮局部动画检查；输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-JHn8pl`，共 2140 张截图。验证范围仍为真实组件／路由搭配合成数据，不等同真实资料库、远程服务或完整应用 GUI 验收。最终脚本语法及 diff 检查通过。整仓迁移目标继续保持进行中，未提交、推送或发布。

### 共享文本／多行输入与显式设置密度

- 28 个生产 TSX 调用方的 68 处旧 `text-input` 全部接入 `TextInput`／新增 `TextArea`，包括实体编辑、图片导入、分类选择、媒体库配置、插件开发与设置表单。逐项 AST 比较确认原生属性、ref、事件回调与业务表达式保持不变；调用方保留自身布局 class。七处浏览器夹具输入同步迁入。生产 TSX 已无旧类消费者，测试中仅保留“不含旧类”的负向断言。
- 多行输入直接输出原生 textarea，复用单行输入的视觉 Module，自己持有 `overflow-y: auto` 和 stable gutter；不引入表单状态或另建重复视觉规则。迁移调用方显式传 `density="workspace"`，设置壳提供 12px custom property、壳外回退 13px。原有默认／筛选 TextInput 不自动继承这一变体，保留迁移前有效字号；设置壳其余文字／按钮密度桥接仍待迁移。
- 删除全局输入外观、hover／focus／disabled 和设置输入穿透规则；审计后删除无消费者的 search-row、sr-only、active-toggle 规则。保留仍有消费者的分段动作和 document 级 textarea 基础规则，不把这一批当作全局审计闭包。架构基线收紧至实际指标：桌面全局 class 48 → 44、跨文件重复 6 → 5、后代选择器 478 → 477，其余债务指标不增加。
- 新增六类实际编辑弹窗及设置密度上下文夹具，覆盖四档宽度 × 深浅主题共 56 组：空表单、输入、多行长文本、稳定滚动槽、提交中禁用、错误折叠／键盘展开、失败后保留草稿与重试。合成提交仅作用于隔离回调，不读写用户资料或调用真实后端。基线导演／设置导演／系列／机构／清单／影片／演员依次为 `UXoeRV`、`dnE4gW`、`Gbzt9s`、`xuecoE`、`bJFPIi`、`gFnZHR`、`9ywY6B`；最终迁移后为 `2B5SiO`、`bv5Thn`、`tjKlmJ`、`t8RCSk`、`UOd0Ia`、`0bKf4J`、`hgZTSm`，统一系统临时目录 `javdex-css-modules-` 前缀。
- 初次截图比较发现夹具静态导入顺序使全局 focus-visible 再增加 outline；共享输入的 focus 规则现在明确持有 outline，仅保留原有 border／box-shadow 焦点效果，并补充实际 computed-style 断言。修正后 392 张专项截图中 363 张 RGB 像素一致，余 29 张各差 1～26 个边缘像素；目视复核窄窗编辑及错误呈现，未宣称全部逐像素一致。前一轮带额外外框的结果不计为通过的不变证据。
- 输入原生语义、分类选择、图片导入、媒体库创建及 Modal 交互共 22 项测试通过。首次全量运行在数据库隔离测试的 macOS lsof 退出码断言失败（不是检测到资料库描述符）；不修改该测试或业务代码，隔离六项及完整重跑均通过。完整重跑终态：3329 项中 3327 通过、2 跳过、0 失败，退出码 0，不以定向通过替代全量重跑。
- 桌面／Web 生产构建通过；初次 renderer CSS 470846 bytes，gzip 70493 bytes。矩阵结束后仅清除旧样式表空白和失效注释，PostCSS 语义 AST 比较确认规则／声明完全一致；重新生产构建后的最终 CSS 470668 bytes，gzip 70425 bytes。
- 完整扩展浏览器矩阵终态：864 组通过、退出码 0，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-vU6xDB`，2532 张截图。原有 2140 张中 2080 张 RGB 像素一致，余 60 张并非都只是少数像素：35 张各不超过 100 个不同像素，25 张较大。目视及差异区域复核包含封面隐私滤镜过渡、尚未加载的合成缩略图、开关动画、代码编辑器焦点边框及底层标签 hover 等状态差异；旧快照未统一等待这些状态稳定，不将它们全部计为视觉不变证据。最终基线闭包仍需补充字体／图片加载和交互过渡稳定等待，而不能只增加任意截图延时或取消正确性断言。
- 全量 TypeScript ESLint、Module stylelint、类型、CSS 架构、UI 控件、编码及工作区／领域／服务端／桌面架构边界检查通过；打包配置额外 8 项通过，最终脚本语法及 diff 检查通过。验证仍是实际组件／路由与合成数据，不是用户资料库、远程服务或跨平台完整 GUI 验收。整仓迁移尚未完成，继续设置壳、分段动作、应用壳与 Web；未提交、推送或发布。

### 设置壳、共享按钮与说明密度

- `SettingsWorkspaceShell` 与 `SettingsPluginDevShell` 的根布局、容器和排版 token 归入壳的 Module，移除 `scroll-body-inner--settings` 桥接。壳只提供 CSS custom properties，不新增 React 上下文或扩展业务接口；共享 Button、状态 pill、数字单位各自消费对应密度变量，壳外和 portal 维持原有回退。Button 不再输出全局 `btn`，原生属性、ref、busy 和禁用行为保持。文字按钮的局部尺寸覆写同步保留设置页的 12px／32px 密度，不改变图标按钮。
- 媒体库的添加目录／扫描操作通过明确 className 入口表达布局；存储 panel 通过 `SettingsCard.headerClassName` 定位自身标题，不再依赖属性选择器穿透旧类。删除共享 SettingsPrimitives 中无样式必要的旧类及无实际调用方的存储标题开关规则。删除 `workspaces.css` 及导入，更新共享组件契约。
- 新增三类实际组件夹具：设置壳内／独立密度和媒体库来源／扫描／存储 panel，覆盖四档宽度 × 深浅主题共 24 组。检查字号、最小高度、说明行高、布局几何、无横向溢出、原生输入编辑、键盘保存、忙碌禁用、失败保留草稿和重试；来源和存储回调仅记录合成动作，不访问真实文件或资料库。布局规则首次迁入时发现根规则排列在变体之后，会覆盖概览的底部留白；最终已将根规则放在变体之前，并补充 `padding-bottom: 0` 的实际样式断言，不把该中间结果计为最终验收。
- 有效基线设置壳／独立／panel 依次为 `nGPWhN`、`nVQHyF`、`MxTrrr`，最终迁移后为 `Kpljsp`、`LJGmhz`、`p8obOs`，统一使用系统临时目录 `javdex-css-modules-` 前缀。24 组样式指标前后相同；72 张截图中 57 张 RGB 像素一致，余 15 张各差 1～60 个边缘像素，不宣称全部逐像素相同。目视复核 480px 浅色的失败／重试布局及实际来源／存储 panel。
- 相关共享组件、设置壳和媒体库／存储测试 19 项通过；完整单元测试终态为 3332 项中 3330 通过、2 跳过、0 失败，退出码 0。类型、全量 TypeScript ESLint、Module stylelint、CSS 架构、UI 控件、编码和工作区／领域／服务端／桌面边界检查通过；打包配置额外 8 项通过。桌面／Web 生产构建通过，最终 renderer CSS 470913 bytes，gzip 70399 bytes。
- 桌面全局 class 44 → 39、跨文件重复 5 → 4、后代选择器 477 → 472、旧按钮类字面引用 2 → 1；全局状态 class 0、硬编码颜色声明 125 和 `!important` 4 均未增加，架构基线继续收紧。剩余旧按钮调用为刮削字段分段动作，不通过放宽基线掩盖。
- 完整扩展浏览器矩阵终态：888 组通过、退出码 0，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-lyIQ38`，共 2604 张截图。与前一批共同的 2532 张中 2441 张 RGB 像素一致；余 91 张中 68 张差异不超过 100 像素，23 张较大，没有图片尺寸变化。复核发现旧插件配置截图的开关还在切换前／过渡中、封面和合成资源加载等状态差异；未把这些全部计为视觉不变证据，最终稳定基线闭包仍需完善。此矩阵依然不是完整应用 GUI 或跨平台验收。
- 只读迁移清单新增未定义字面类、多行／动态 inline style、Module 内 `:global` 完整选择器及行号；仅遍历 class 表达式的输出分支，不把条件比较、Module 键和动态模板碎片误判为类。新增 5 项清单测试通过。当前有 49 处内联样式候选（没有纯字面对象候选，但仍需人工区分动态／转发职责），以及 6 条 Module global 选择器：2 条 document 隐私契约与 4 条开发工作区宿主桥接；后者仍需显式化，不据清单数量宣称闭包。下一批继续分段动作、剩余共享组件／死标记、应用壳与 Web，最终逐条审计所有全局规则。未提交、推送或发布，整仓目标继续进行中。

### 刮削分段动作与共享外观旧类收口

- 刮削字段弹窗四处相邻按钮组（包含逐字段组生成的动作）接入 `SegmentedActions` / `SegmentedAction`。原有全选、清空、按写入字段等命令保持原生按钮，不强加 toggle／radio 模型；缺失筛选切换由调用方明确传 `aria-pressed`，保留原有颜色、字重、分隔线、焦点及 24px 紧凑尺寸。缺失筛选 panel 状态改用显式 data 属性，原有资格、回调和最终参数不变。共享选项型 SegmentedControl 保持独立，不扩大其语义接口。
- 删除 `navigation-controls.css` 及导入；其中两条 search cancel／textarea document 默认归入根 reset，功能分段按钮规则不再留在全局表。审计全仓选择器与功能代码引用后，移除 Modal 的旧尺寸、外框、内容区和 hint 桥接，以及 EmptyState、IconButton、AppFormSection、CodeEditor 的无效旧类。Modal 描述 id、原生事件／ref 和既有 `data-modal-part` 保持，EmptyState 使用只读 data 标记定位说明。删除无定义的更新图标旋转标记与影片列表路径提示类，不重新激活旧无效样式或修改业务。
- 新增实际共享外观夹具，覆盖带说明／subtitle 的 Modal、表单标题与动作、图标按钮、空态和禁用代码编辑器；四档宽度 × 深浅主题共 8 组，保留说明的实际字号、行高、颜色与 margin，并核对键盘刷新及确认／取消回调。基线 `kaqXha`，迁移后 `3MVwwI`，8 张截图 RGB 像素一致。新增原语及共享外观原生语义测试 7 项；连同 Modal 和媒体库创建回归共 13 项通过。
- 扩展原有刮削弹窗夹具至全部宽度的写入字段清空／分组全选、缺失筛选清空／按写入字段、确认资格和提交参数；基线 `eMa6h9`，迁移后 `70qJiz`，8 组通过。32 张截图中 27 张 RGB 像素一致，余 5 张包含筛选切换的过渡状态，不能全部作为视觉不变证据；目视复核 1000px 深色的默认及切换布局。后续快照已等待字体和有限动画完成，再核对切换的 aria 状态与字重；未通过任意延时或删除正确性断言掩盖问题。窄窗指针拦截仍列独立待办，本夹具窄窗只验证原生键盘操作。上述目录均使用系统临时目录 `javdex-css-modules-` 前缀。
- 桌面全局 class 39 → 37、后代选择器 472 → 465、旧按钮类字面引用 1 → 0；跨文件重复 4、全局状态 class 0、硬编码颜色声明 125 和 `!important` 4 均未增加，架构基线继续收紧。全量单测终态：3339 项中 3337 通过、2 跳过、0 失败，退出码 0；打包配置额外 8 项通过。类型、全量 TypeScript ESLint、Module stylelint、UI 控件、编码、工作区／领域／服务端／桌面边界和生产构建通过，renderer CSS 470815 bytes，gzip 70357 bytes。
- 迁移清单进一步识别导航 className 回调的输出分支，不把条件和嵌套辅助函数误判为 class；新增回归后清单测试共 6 项通过。应用壳与媒体库导航的真实全局引用仍在清单中，不能因使用回调就遗漏。当前全范围全局 class 候选 122、inline style 候选 49、Module global 选择器 6，全部待最终审计。整仓目标仍在推进，未提交、推送或发布。
- 完整扩展浏览器矩阵终态：896 组通过、退出码 0，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-mp2MGw`，2632 张截图。新增共享外观 8 张仍与基线 RGB 像素一致；分段动作 24px 等样式指标前后相同，全部八组资格／参数检查通过。稳定等待后的 32 张分段截图与旧未稳定基线比较仅 12 张一致，余 20 张中 6 张不超过 100 个不同像素，不能延用前一次 27 张一致的数字来描述最终结果，也不将旧过渡快照当成不变证明。
- 与前一批比较其他共同快照时，排除已扩展交互步骤的刮削弹窗场景：2592 张中 2489 张 RGB 像素一致；余 103 张中 87 张不超过 100 个不同像素，16 张较大，没有尺寸变化。历史图片加载／隐私滤镜和焦点、开关／按钮过渡基线仍不足以支持全量视觉不变声明，最终稳定基线闭包继续保留。此矩阵仍是实际组件／路由配合合成数据，不代表真实资料库、完整 Electron GUI 或跨平台验收。最终脚本语法、清单测试和 diff 检查通过；下一批继续应用壳、未使用全局表、开发工作区宿主桥接和 Web，再完成 inline／全局逐条审计。

### 应用壳、共享侧栏导航、品牌与背景

- Layout 的壳层／侧栏／主内容／徽标与背景表面变量归入自身 Module。主导航与媒体库共用 SidebarNav 原语，保留 NavLink 原生目标、ref、aria-current 和调用方的路由／query 记忆、离开保护与点击逻辑；显式 active 只补充列表根的视觉选中，reserveBadgeSpace 保留 44px 徽标占位。媒体库图标颜色、警告点、36px 项高和长名称截断保持原实现。AppBrand 与 NavIcon 持有自己的视觉／响应式规则，不输出旧品牌或导航 SVG 类。
- AppBackgroundLayer 自行持有淡入动画，不再让唯一调用方传全局动画类；图片横竖判断、contain 宽度、渐隐位置和 ResizeObserver 动态计算不变。原有暗罩渐变整体提升为 document 语义 token，数值不变，不在 Module 增加硬编码颜色。删除 shell.css、无消费者的 library-content.css，减少动画的 document reset 从 settings-tools.css 归入根表并删除空功能表；全局入口只导入 token／reset。
- 按 codebase-design 收敛共享视觉的归属，不新建路由／业务适配层。桌面全局 class 37 → 2、跨文件重复 4 → 0，余下 selectable-text / copyable-text 为 document 文本选择契约。后代选择器 465、硬编码颜色声明 125、重要声明 4、状态类／旧按钮类／行为 class 推断 0 均未增加，基线收紧。全范围清单仍有 90 个全局类候选、49 个 inline 候选和 6 个 Module global 选择器；Web 及开发工作区／静态内联审计尚未完成。Web 的 app-shell 字面类此前被桌面同名规则掩盖为有 owner，本次清单正确显示未定义；Web 不导入桌面 CSS，留待该批清理。
- 新增独立 HTML 入口的实际 Layout 夹具，避免改动旧夹具的依赖导入顺序。四档宽度 × 深浅主题 8 组，覆盖长媒体库名称、归档过滤、键盘返回库列表保留 query、徽标／分类路由、横竖背景与 contain 几何、防窥及图片预览期间隐藏背景、清除背景、新建媒体库 portal／取消、空／错／加载媒体库及徽标。请求与图片均为隔离合成数据，不读取用户资料库或连接远程服务。有效迁移前基线 IiDMWA，修正数值后的迁移后 BJ1Whv；共 72 张快照，69 张 RGB 一致，3 张不同（两张初态文本／添加按钮较大差异，一张 28 像素），尺寸及实际样式指标一致，不能宣称全部逐像素不变。后续夹具增加 body／正文主题实际颜色等待，不靠任意延时。目录统一为系统临时目录 javdex-css-modules- 前缀。
- 自动提取规则初轮误将声明中的小数识别为选择器片段；逐项复查并修正字距、图片滤镜及暗罩值后重新执行回检，不把初轮 9JRsz0 计为视觉验收。只读 HEAD 的 32 条相同壳规则作为声明结构补充对照（非未提交工作区视觉基线），在类名／动画名及渐变 token 映射后无声明差异。
- 原语／媒体库创建定向 6 项通过；完整单测终态 3342 项中 3340 通过、2 跳过、0 失败，退出码 0。类型、全量 TypeScript ESLint、Module stylelint、CSS 架构、UI 控件、编码和工作区／领域／HTTP／服务端／桌面边界通过；清单 6 项、打包配置 8 项通过。桌面／Web 生产构建通过，renderer CSS 470936 bytes，gzip 70435 bytes。lint 的注释格式问题已修正后重跑，不以失败轮次计为通过。
- 完整矩阵首轮 UXVvzU 在旧 DetailPane 夹具切换已移除的 app-shell--with-background 类时超时，未计验收。六个孤立子组件夹具改为从隐藏的实际 Module 壳节点读取背景状态前后变化的语义变量，再传入测试宿主；不复制变量声明、不改变宿主 flex／height／overflow 几何，不为测试在生产代码恢复全局类。实际壳另有完整独立夹具。修正后 DetailPane 6 组、DetailActionBar 8 组通过；完整矩阵重跑终态为 904 组通过、退出码 0，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-AqnbXD`，共 2704 张截图。
- 独立布局待办：迁移前后，12 个活动媒体库、640px 窗高时，底部设置链接下沿均为约 794.8px，超出首屏；900px 高时为 878px。保留现状，不把脚本 scrollIntoView 后可点击宣称为维护区始终可见。后续需单独评估侧栏的纵向空间／滚动策略，与旧刮削弹窗窄窗指针拦截问题一并保留。整仓目标继续进行中，未提交、推送或发布。
- 最终矩阵中的应用壳 72 张与 IiDMWA 基线相比，69 张 RGB 一致、3 张不同（2 张各 28 像素，1 张初态文本／按钮较大差异），没有尺寸变化；八组样式指标前后完全相同。其余共同的 2632 张与前一轮 mp2MGw 比较，2523 张 RGB 一致、109 张不同（83 张不超过 100 像素、26 张较大），没有尺寸变化。差异涉及旧图片加载／隐私滤镜、文字焦点与反馈等未统一稳定的基线；不把全部差异归为像素噪声或全部当作已证实无回归。最终稳定视觉基线闭包继续保留。实际组件／路由和合成数据矩阵不等同真实资料库、完整 Electron GUI 或跨平台验收；最终脚本语法、CSS 架构及 diff 检查通过。

### 开发工作区显式展示模式与几何样式归属

- 按 codebase-design 将展示选择交给调用方、内部视觉交给面板：`PluginDevPanel` 新增可选 presentation（默认 standalone），设置页唯一生产调用显式传 settings。5 处宿主穿透改为局部 class，保留双 class 的既有优先级和两个容器断点；删除设置壳宿主标记及未定义的 modal--plugin-dev-leave 类，不改变离开保护／导航／Agent 业务。Module global 候选 6 → 2，余下为上述 document 隐私契约。
- FloatingLayer 的 position:fixed／z-index:1200 归入自身 Module，并清除调用方 inline 覆盖，保留测量坐标、可见状态、延迟外部点击监听及 Portal。审计四个生产调用方，原有 caller Module 没有冲突定位／层级声明。虚拟网格的 width:100% 归 Module，仍清除 react-window 的 inline width；适配器中的 undefined 不计静态视觉债务。行高／步长和底部间距共用算法常量，保留单一来源。头像视口的宽高改为使用共享 AVATAR_VIEW_SIZE 绑定的变量，实测预览／编辑均为 180×180。
- 新增独立 HTML 入口的实际 PluginDevPanel 夹具，不把拼装工作台示例当作实际面板验收。设置／独立模式、四档宽度和深浅主题共 16 组，验证模型就绪提示、网址输入后动作资格、插件类型切换、固定连接弹窗与 Esc、面包屑导航到 /settings/overview/status。API 均为合成数据，不启动真实模型或安装插件。有效迁移前基线 OD2HY8／SKkGC8，迁移后 1Q7W6E／0eby3A，尺寸及样式指标逐组完全一致；64 张中 59 张 RGB 一致，另外 5 张差异为 1／37／1／36／3 像素，无尺寸变化，不宣称全部逐像素相同。
- 浮层几何与上游 style 覆盖独立 8 组通过（9TfziE）：验证固定定位、1200 层级、动态宽度、可见状态、caller class 和 Portal，内部／忽略项／锚点点击不关闭、外部点击关闭并可重开、滚动及 resize 后重新定位，以及虚拟视口的 hidden／auto 滚动策略与稳定槽。另一次只读运行实测所有八组 window.scrollY=60、浮层 top 153→93，确认不是无实际位移的假滚动检查；该运行缺少完整 Vite 扫描 alias 导致预扫描警告，实际几何入口不依赖这些合同模块且断言退出码为 0。
- 头像编辑 8 组、影片／演员虚拟网格各 4 组通过。网格断言移除 inline width 后仍等于视口 clientWidth，实际卡片底部间距为 12；选中、动作、滚动行为保留。基线 zOPtoM／5NAgdT／tH87h6，对应迁移后 1eeymf／oCE8un／tyIWhp；头像 24 张中 23 张 RGB 一致，1 张本地页签截图不同 5818 像素，查看前后图片确认页签高亮过渡未稳定，头像尺寸／布局相同。两个网格各 4 张中各 3 张一致，剩余分别 23／31 像素。旧夹具的主题／焦点／过渡等待仍需最终统一稳定，不把这些差异全部归为已排除的回归。
- 新增实际展示模式切换组件测试；定向 5 项通过。完整单测终态 3343 项，3341 通过、2 跳过、0 失败，退出码 0。类型、全量 TS ESLint、Module stylelint、CSS 架构、UI 控件、工作区／领域／HTTP／服务端／桌面边界、编码、打包 8 项及清单 6 项通过。CSS 后代选择器 465→461，基线只收紧；其他债务指标不增加。桌面／Web 生产构建通过，renderer CSS 471064 bytes／gzip 70468 bytes。
- Web 下一批基线准备：读取移动端规范后，以当前未迁移 Web 产物运行 check-mobile-web.mjs；320×844、390×844、844×390 触控模拟和 1280×800 桌面，以及密码登录／配对状态、真实键盘浏览路径通过，临时测试视频由脚本清理、浏览器及服务关闭。不代表手机真机或完整 Electron GUI 验收。整仓目标继续进行中，未提交、推送或发布。
- 完整浏览器矩阵终态 928 组通过、退出码 0，输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-css-modules-WvhI0x`，共 2784 张截图。与前一批 AqnbXD 的共同 2704 张比较，2619 张 RGB 一致；其余 85 张中 71 张不超过 100 像素、14 张较大，无尺寸变化。较大差异仍涉及既有图片加载／隐私滤镜、编辑器和文本焦点／反馈，未将其全部解释成无回归证据；最终稳定视觉闭包继续保留。
- 全量终态后只补强测试，不改生产源码：浮层加入 scrollY=60 及 top 同步移动 60px 的断言，8 组重跑通过（UmxrMW）。头像快照等待字体、实际有限动画完成和双帧，确认本地页签 aria-selected；追加首轮曾在“编辑中”已出现、缩放控件尚不可见时失败，改为等待控件实际可见而非任意延时，最终 8 组通过（YLnEGE）。这些定向终态是快照等待增强后的验证，不冒充又跑了一轮全量矩阵。最终脚本语法、CSS 架构及 diff 检查通过；浏览器和服务均已关闭。

### Web 资源卡片、反馈与图片预览

- 按 codebase-design 沿已有独立 owner 收口，不把 Web 全局表整体改名为大 Module，也不增加业务适配层。`ResourceList`／内部卡片的列表、选中、元数据、动作和统一反馈归 `ResourceCard.module.css`；保留原 props、资源选择、复制版本隔离和焦点恢复。选中由显式 data 属性表达。复制兼容路径的固定文本框从 imperative cssText 改为本模块 class；这处原本不在 JSX inline 清单内，因此 49 个候选数量不变不代表漏迁。
- `ImagePreview.module.css` 持有预览器主题变量、安全区、48px 控件及窄屏切图位置；7 条 `:global` 规则仅引用局部 root 下的 YARL 已知部件。删除旧 `image-preview.css`，保留第三方原样式；导航隔离改为独立 `web-image-preview` ID，不用功能 class 识别预览。预览历史、关闭来源、缩放／切图、Tab 隔离及 lazy loading 不变。移动端检查同步改为可访问名称、role 和资源 article 定位，不恢复旧类或依赖生成 hash。
- 新增实际 Web 构建入口的合成 API 检查 `web-style-ownership-check.mjs`，四种规范视口覆盖长名称／同名资源归属、卡片尺寸、原生兼容复制及临时节点清理、手工复制／说明／焦点恢复、安全剪贴板完成竞争、选中、鼠标 hover／active，以及横图／竖图／图片失败、预览快捷键隔离和关闭恢复。系统剪贴板不写入，数据不访问用户资料库。快照等待字体、实际有限动画和双帧；不靠任意延时。
- 迁移前基线 `y3ifma` 有 28 张；首轮 `X5YD1w` 发现四种视口的复制按钮焦点边框变透明（各 204 个像素差异），其余相同。补上 Module 的明确按钮 focus-visible 规则，解决全局 native focus 与局部动作样式的加载顺序差异；未将其解释成噪声。最终构建 `exY44s` 的共同 28 张 RGB、截图尺寸及计算样式指标全部一致，另有 4 张新增选中态，不冒充也有迁移前像素基线。查看窄屏复制失败与桌面选中态截图。目录统一为 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-web-style-` 前缀。只读声明结构对照保留 34 个原资源选择器片段及全部原预览片段；不把声明对照替代交互验收。
- Module stylelint 和 CSS 架构检查扩展到 Web。Web 使用独立非增长基线，桌面既有阈值不变；第三方原表导入限定两个精确路径和预览 owner，global 选择器限定精确文件、局部 root 及已知部件。策略新增 3 项测试，拒绝无根 vendor、未知部件和应用宿主穿透。Web 全局 class 88→69，整仓清单 90→71；Web 后代选择器 93→94（新增明确按钮焦点规则），重要声明 3、硬编码颜色 16 均不增加，两个新 Module 无硬编码颜色。桌面仍为 2 个 document class／461 个后代选择器；整仓 Module global 候选 2→9 是新增的 7 条受约束 vendor 规则，不是宿主桥接复活。
- 新增资源原生语义／统一说明测试 2 项；完整单测终态 3345 项，3343 通过、2 跳过、0 失败，退出码 0。类型、全量 TS ESLint、全量 Module stylelint、CSS 架构、UI 控件、编码和所有工作区／领域／HTTP／服务端／桌面边界检查通过；清单／Web 策略／打包合计 17 项通过。首轮类型检查的测试 Node 声明／完整合同数据，以及 stylelint 的相邻规则排序已修正，失败轮次不计通过。
- 桌面和 Web 生产构建通过。renderer CSS 471064 bytes／gzip 70468 bytes，与上一批相同；Web 主 CSS 20354 bytes／gzip 4890 bytes，预览 CSS 7410 bytes／gzip 1835 bytes。最终产物再次通过四种视口的完整移动端检查及真实键盘路径、密码登录／配对状态、资源作用域／主资源不可用／显式备用选择检查。浏览器及本机服务均关闭；本批没有重跑桌面 928 组视觉矩阵，不宣称手机真机、真实资料库或完整跨平台 GUI 验收。下一批继续 Web 登录／配对与基础控件，随后浏览壳、首页和详情主体；最终稳定整仓视觉闭包仍未完成。未提交、推送或发布。

### Web 登录／配对、品牌与共用控件

- 按 codebase-design 的实际复用关系拆分 `Login`、`PairLogin`、`LoginForm`、`WebBrand`、`WebButton` 和 `WebTextInput`，分别持有同名 Module；没有把全局表改名为大共享模块。登录业务从入口原样移到 `Login.tsx`，共享字段、记住设备、说明和提交布局通过原语表达。所有 Web 自有按钮及文本输入接入原语，保留原生 props、ref、表单隐式提交、链接路由及 caller 布局 class；配对轮询、退避、取消和恢复不改。
- 删除对应全局功能规则与响应式覆盖。Web 全局 class 69→57、后代选择器 94→90，重要声明 3、硬编码颜色 16、状态类／旧按钮类／行为 class 推断 0 不增加；债务基线只收紧。整仓清单全局 class 71→59、inline 候选仍为 49。第三方预览按钮不使用 Web 原语：原先依赖的对齐、禁用、hover 与按压样式归预览 Module，受约束 vendor global 规则 7→10，整仓候选 9→12；没有新增应用宿主穿透，策略测试拒绝非按钮部件借用这些状态。
- 新增 `web-login-style-check.mjs`，真实构建配合合成 API，四种规范视口覆盖配对申请／取消、密码字段、记住设备参数、忙碌、错误保留与重试成功；不使用个人账号或批准真实设备。配对倒计时仅在截图中遮罩其自身段落，指标只归一化剩余秒数字，保留该段落实际几何；不冒充未遮罩的逐像素对比，也不冻结时钟干扰轮询。
- 登录基线 `J2ArQQ` 与首轮迁移后 `ywYXQD` 的 24 张 RGB 截图、尺寸和全部计算样式指标一致。资源／预览基线 `aF91nE` 与复跑 `1NtcH5` 的 32 张及全部指标一致；中间 `iYFC0H` 有一张 9 个边缘像素差异，记录保留，不把中间轮次说成全部相同。查看窄屏登录错误及桌面资源选中截图。目录统一使用本机临时路径中的 `javdex-web-login-`／`javdex-web-style-` 前缀。
- 额外优先级审计新增资源标题按钮的实际按下断言，首轮发现背景仍透明（旧按压态应为 selected），不以初态截图通过掩盖该回归。调整共用按钮的局部按压选择器到三层 class/state 权重，不依赖全局恢复或 important；保留禁用／主按钮分支，最终复验单独记录。
- 最终构建的登录 `kcboF3`、资源／预览 `nBbwKj` 四组均通过；与本批迁移前基线的 24／32 张 RGB 截图、尺寸及全部计算样式指标一致，资源标题按压新增断言通过。完整移动端脚本的四种视口及真实键盘路径、密码登录／配对状态通过；资源范围、主资源不可用及显式备用选择检查通过。两份最终证据目录与上述前缀一致，浏览器及服务均已关闭。
- 新增原语测试 3 项，验证原生属性／refs／隐式表单提交、表单 label／checkbox／alert／提交动作及品牌根节点。首轮品牌测试因 Node 不能导入 PNG 失败：测试资源 loader 仅把静态 PNG 暴露为 URL 字符串，新增 2 项 loader 行为测试，未知资源仍交回原 loader；这不替代真实浏览器图片渲染。定向原语及资源共 5 项通过，清单／vendor 策略／loader／打包共 19 项通过。失败轮次均不计通过。
- 历史基线曾记录 844×390 登录字号 13px；2026-10-01 回检确认是 fullPage 截图将触控仿真从 true／1 重置为 false／0，生产 coarse-pointer 规则原本已是 16px。最新脚本改为视口截图并验证仿真未变化，所有触控视口的登录／配对输入均检查至少 16px，生产 CSS 未改。真机仍未验收。
- 完整单测最终终态 3348 项、3346 通过、2 跳过、0 失败，退出码 0，日志 `/tmp/javdex-web-login-module-final-tests.log`。类型、全量 TS ESLint、全量 Module stylelint、UI／CSS、工作区和全部领域／HTTP／服务端／桌面边界、编码检查通过；新增测试及最终 TSX 格式清理后另跑 Web ESLint／browser 类型／脚本语法与 diff 检查通过。桌面／Web 生产构建通过：renderer CSS 471064 bytes／gzip 70468 bytes（不变），Web 主 CSS 21283 bytes／gzip 5011 bytes，预览 CSS 7737 bytes／gzip 1911 bytes。Web Module 的独立 class 名及预览按钮显式继承增加少量产物，不以全局类下降冒充包体下降。服务端真实认证恢复冒烟仅同步 locator 并检查语法，本批未启动其所需服务，不记作已执行。
- 浏览壳、首页、详情主体和卡片网格，以及最终整仓稳定视觉闭包仍未完成。桌面 928 组矩阵本批未重跑，不宣称手机真机、真实资料库或完整跨平台 GUI 验收。未提交、推送或发布。

### Web 浏览壳、搜索、范围、侧栏与影片网格

- 按真实 owner 拆分 `WebLibraryShell`、`WebSearch`、`WebSidebar`、`WebCollectionPicker`、`WebVideoCard`、`WebVideoGrid` 和各自 Module；DOM 区域顺序、搜索提交与清除顺序、原生 dialog、卡片 href／事件／ref、网格单 Tab 入口、URL 与来源滚动记忆保持原样。范围不变项只关闭弹层，不导航；调用方保留指针切换与加载焦点策略。删除旧 app-shell／search-submit 等无定义标记及未使用 Poster large 分支；行为和脚本定位使用独立 data-web 标记，不读取样式类。
- 删除全部对应全局规则与响应式覆盖。Web 全局 class 57→34，整仓清单 59→36；后代选择器 90、重要声明 3、硬编码颜色 16 不增加，桌面基线不变。卡片叠层原色值仅移为语义 token，未改变视觉值；49 个 inline 和 12 条有明确范围的 Module global 候选不变，最终全局闭包尚未完成。
- 新增实际入口浏览夹具 `web-browse-style-check.mjs`，六档视口覆盖长名称、懒加载／缺失／失败封面、搜索、单 Tab 网格、范围确认／Esc、长侧栏滚动及只读说明、空结果和失败重试。有效迁移前基线 bxGj6t，迁移后 sNbsPE，以及最终重建后的 4QATuX；三者 54 组布局／计算样式记录完全一致。首轮 42／54 张 RGB 相同，另外 12 张差 2–85 像素；最终轮 35／54 张相同，另外 19 张差 1–85 像素，无尺寸变化。已核看空结果和长名称范围弹层，差异定位集中在搜索边框／图标；不宣称全部截图逐像素一致。
- 新增原生卡片／grid 与浏览部件测试 7 项，含不变范围不导航及原生属性／ref；与既有控件和资源测试共 12 项通过。完整单测首轮 3355 项中 3352 通过、1 失败、2 跳过：运行时隔离测试的外部 lsof 命令返回非零，并非发现 library.db 句柄。单独重跑该文件 6 项通过；未修改隔离测试或放宽断言，根因未确认。完整重跑终态 3355 项、3353 通过、2 跳过、0 失败，退出码 0，日志 `/tmp/javdex-web-browse-module-final-tests.log`；首轮失败日志保留，不以重跑覆盖失败事实。
- 完整类型、TS ESLint、Module stylelint、CSS／UI／编码和全部工作区／领域／HTTP／服务端／桌面边界检查通过；清单／策略／loader／打包共 19 项及 14 个修改脚本语法检查通过。桌面／Web 重建通过：renderer CSS 471064 bytes／gzip 70468 bytes（不变），Web 主 CSS 22378 bytes／gzip 5144 bytes，预览 CSS 7737 bytes／gzip 1911 bytes。独立 Module 类名增大少量产物，不用全局类减少冒充包体减少。
- 四档移动端及真实键盘路径、密码／配对、资源作用域回归通过；资源夹具 32 组指标相同、31 张 RGB 相同（另一张 9 像素差），登录夹具 24 张和指标一致。浏览器及临时服务已关闭。本批没有重跑桌面 928 组矩阵或启动服务端认证恢复冒烟，不宣称真机、真实资料库或跨平台 GUI 验收。下一批：首页、统一状态、结果标题／排序／筛选／分页，然后详情和演员；最终整仓稳定视觉闭包仍待完成。未提交、推送或发布。

### Web 首页布局与统一状态提示

- 将原私有首页完整移到 `WebHomeDiscovery`，布局归同名 Module；异步请求、保留旧网格、busy 资格、重试焦点、未授权与 abort 逻辑不变。统一加载／空态／重试提示由 `WebStatus` 与同名 Module 持有，保留原生 status／alert 区分。首页辅助 muted 文案仍待共用文本原语迁移，不因布局局部化就标关联闭包完成。
- Web 全局 class 34→31、整仓清单 36→33，其他债务指标不增加。3 项新增测试覆盖两张网格刷新保留、busy 拒绝重复操作、错误恢复、detail 隐藏不重载、未授权及卸载后迟到结果；完整测试终态 3358 项、3356 通过、2 跳过、0 失败，日志 `/tmp/javdex-web-home-module-final-tests.log`。不修改隔离测试或生产运行时，上一批 lsof 偶发失败仍保留记录。
- 六档浏览夹具 uXuM3E 与本批前基线 4QATuX 的 54 组布局／样式记录一致；40 张 RGB 一致，余 14 张差 1–85 像素，无尺寸变化。已核看 390px 首页布局；四档移动端、真实键盘与登录／配对路径通过。browser 类型、Web ESLint、全量 Module stylelint、CSS／UI／编码、脚本语法与 diff 检查通过，Web 重建主 CSS 22394 bytes／gzip 5146 bytes、预览 CSS 7737 bytes／gzip 1911 bytes；桌面源码和产物不变，不冒充重新执行桌面视觉矩阵。

### Web 结果标题、排序、chip 行与分页

- 按实际职责新增 `WebBrowseHeading`、`WebBrowseSort`、`WebChipRow`、`WebPagination` 与同名 Module，删除全局布局及响应式规则。标题总量区分加载与零结果；排序保留空值默认、未知参数无选中；chip 行同时用于结果筛选和详情标签，原生 div 属性／事件／ref 直达唯一节点；分页保留受控页号及原生边界禁用。筛选清除、page 重置、URL／历史／滚动及加载焦点仍在原列表控制器，未另建路由状态。
- Web 全局 class 31→24、整仓清单 33→26，CSS 文件 21；后代选择器 90、重要声明 3、硬编码颜色 16 和其他债务指标不增加。共用 eyebrow／muted 文本和详情主体仍未收口，不以标题布局 Module 代替整页完成。行为和测试用 data-web-sort／filter-chips／pagination 标记，不保留无消费者旧 class。
- 新增 4 项测试覆盖 loading／零总量、搜索说明、未知排序、chip 原生转发与页号边界。完整单测终态 3362 项、3360 通过、2 跳过、0 失败，退出码 0，日志 `/tmp/javdex-web-browse-controls-final-tests.log`。完整类型、全仓 TypeScript ESLint、全量 Module stylelint、CSS／UI／编码和工作区／领域／HTTP／服务端／桌面边界检查通过；清单／策略／loader／打包 19 项及相关脚本语法检查通过。样式格式错误经 formatter 修正后重跑，不计首轮失败为通过。
- 最终 Web 重建后六档浏览 Q8lxG9 与批次前 uXuM3E 的 54 组布局／计算样式记录完全一致；34 张 RGB 一致，余 20 张差 2–85 像素，无尺寸变化。格式整理前 ze2sZ6 同样指标一致、40 张 RGB 一致，余 14 张差 2–85 像素。已核看 1000×640 长名称范围结果，标题换行、数量、排序与 chip 正常；少量搜索边缘差异继续如实保留，不声称全部像素不变。
- 四档移动端、真实键盘路径及登录／配对状态通过；资源与预览 GDdnQ4 的 32 组指标与前一批一致，31 张 RGB 一致、另一张 9 像素差；最终资源作用域／主资源不可用／明确备用选择检查通过。浏览器与临时服务已关闭。最终 Web 主 CSS 22591 bytes／gzip 5175 bytes，预览 CSS 7737 bytes／gzip 1911 bytes；桌面源码和产物未改变，本批不重复冒充桌面 GUI／928 组视觉验收。
- 下一批完成详情主体、播放器／剧照、演员及实际共享文本，再逐条审计全局规则、所有关联 owner 和 inline 分类，并完成整仓稳定视觉闭包。全部页面迁移目标保持进行中；未提交、推送或发布。

### Web 详情、演员与共享文本；源码闭包审计

- 按 codebase-design 将详情原私有组件完整迁入 `WebDetailPage`，演员卡片归 `WebCastMember`，实际复用文本归 `WebText` 与各自 Module。原生 p／anchor／video DOM、refs、属性、暂停默认、媒体库主资源隔离、明确备用选择、读取／播放重试、预览按需加载与历史恢复保持原实现。资源说明通过调用方局部 resourceNote 保留旧优先级，不用父模块穿透 muted。删除全部 24 个剩余 Web 全局功能类及响应式规则，黑色播放器背景提升为原值不变的 surface-player token。
- 整仓清单全局 class 26→2，Web 24→0、CSS 文件 21→24；后代选择器 90、重要声明 3、硬编码颜色 16 不增加，桌面 181 个 CSS 文件／2 个 document 类的债务基线不变。260 个 TSX 生产消费者无未定义字面类，49 个 JSX inline 和 12 个受约束 global 选择器已逐项分类，不以此代替视觉验收。
- 全局表逐条核对：桌面根 20 条规则只含主题／语义变量、document 几何／排版、元素基础、选择文本、焦点、滚动条和减少动态效果；global.css 仅导入此表。Web 根 24 条只含主题／视口变量、document／元素基础、焦点、原生表单触控字号及减少动态效果，没有功能 class。共享 UI 无全局表。2 条根隐私契约及 10 条局部 YARL 适配规则保留既有检查；没有借属性祖先恢复开发工作区宿主桥接。
- 关联 owner 核对包括不直接 import Module 的页面：分类列表组合 ListPage／PageHeader／ListToolbar／ListSurface／ContinuousGrid／FacetCard；分类详情组合 ClassificationDetailSurface／ClassificationProfile／ContinuousPosterGrid 及独立编辑／合并／图片弹窗；清单列表组合相同列表原语与 PlaylistCard；资源身份待办组合 PendingDecisionParts。分流页 FacetListPage 自身不持有视觉规则。动态 class 辅助器只组合局部 Module，CodeHighlight 由同名 Module 提供纯映射；不为“每页一个 Module”添加空文件。
- imperative 审计发现方向键候选循环仍读取旧 skip 样式类，已统一为已有 data-web-skip；补充明确拒绝读取 classList 的导航回归及真实 Shift+Tab／Tab 可达、ArrowUp 不选辅助入口的检查。架构检查也覆盖 classList.contains／item，不放宽零债务基线。新测试桩缺少 body.matches 及新增键盘步骤未恢复品牌入口的首轮失败经修正后复跑，未计为通过。
- 新增详情／演员／文本测试 6 项、导航测试 1 项；最新完整单测终态 3369 项中 3367 通过、2 跳过、0 失败，退出码 0，日志 `/tmp/javdex-css-final-audit-tests.log`。完整类型、全仓 TS ESLint、Module stylelint、CSS／UI／编码及工作区／领域／HTTP／服务端／桌面边界通过；清单／策略／loader／打包 19 项通过。桌面／Web 最终构建通过，renderer CSS 471064 bytes／gzip 70468 bytes，Web 主 CSS 22986 bytes／gzip 5255 bytes，预览 CSS 7737 bytes／gzip 1911 bytes。
- 新增实际 Web 详情夹具，六档视口覆盖加载、原生暂停、长资料、演员焦点／按压、不可用主资源、空资料／资源、播放错误和读取重试，共 51 组。迁移前 C0pq9Y、迁移后 5qixXG 及未遮罩最终构建 zHpQ1s 的全部布局／计算样式记录完全一致。早期 fullPage video 遮罩错位覆盖播放器下方内容，因此撤销其逐像素证明资格，不再使用遮罩。未遮罩重复基线 JdBV7b／jKgU2m 的 51 组指标一致，38 张 RGB 相同、11 张差异限于原生视频控件／加载动画，另 2 张分别为搜索图标 29 像素及边缘 1 像素；这些是同一最终样式的重复稳定性记录，不冒充有效的迁移前后未遮罩图片。已核看横屏焦点整页截图，标题／资料和剧照未被测试遮罩隐去。上述详情目录使用系统临时目录 javdex-web-detail- 前缀。
- 六档浏览 VQQJV9 与上一批 Q8lxG9 的 54 组布局／样式记录一致，36 张 RGB 相同，另外 18 张差 2–50 像素；资源 5ZUkPO 的 32 张及指标与 GDdnQ4 相同；登录 D8rOqp 与 M5Mrji 的指标一致，22 张 RGB 相同、2 张各差 1 像素。目录使用对应 javdex-web-browse-／javdex-web-style-／javdex-web-login- 前缀。最终构建的四档移动端、真实键盘及密码／配对、资源范围／主资源不可用／明确备用选择回归通过，未连接真实账户／资料库／远程服务。
- 剩余：统一桌面实际夹具的字体／可见图片／有限动画等待，复跑完整矩阵并核对旧非稳定基线差异；有效的迁移前后未遮罩详情图片证据不足这一限制明确保留。源码已收口不等于全部目标完成；尚不宣称真机、真实资料库、完整 Electron GUI 或跨平台验收，未提交、推送或发布。

### 稳定截图等待的诊断与回归

- `stable-screenshot.mjs` 统一实际夹具的字体、实际可见图片及有限动画等待，保留原截图参数，不注入 CSS、不取消交互过渡、不等待故意挂起的业务请求。每个等待阶段有 5 秒失败边界，超时不能作为成功截图继续执行。
- 首轮完整矩阵 v4Hjco 在头像写真分页等待挂起，主动终止，不计为通过。按 diagnosing-bugs 缩小到 `JAVDEX_CSS_FIXTURE=avatarGalleryPaging node scripts/css-module-migration.mjs`，加上等待边界后明确报出一张 lazy 图片。只看窗口坐标的旧判定漏掉了横向写真条的祖先裁剪：图片 x=1428 仍与 1440px 窗口相交，但滚动区右沿为 735，浏览器不会开始加载它。不是生产页面新增死锁，不修改头像布局或图片加载策略。
- 原生 Chrome 最小回归保留同样滚动区、图片坐标、lazy 属性和 media 地址，修复前约 5.6 秒报相同超时；修复为 IntersectionObserver 的真实裁剪交集后通过，不强制加载被裁剪的图片。另测真正可见图片在合成响应完成前不能截图，防止简单跳过所有图片等待。`node --test scripts/stable-screenshot.test.mjs` 共 4 项通过；实际头像写真分页八组重跑通过，输出 poRo9c。临时祖先诊断已移除，仅保留有限、明确的阶段失败消息。
- 完整稳定矩阵终态已取得：退出码 0、928 组通过、2784 张 PNG，日志 `/tmp/javdex-css-stable-matrix-final.log`，输出目录 W7KVkP（系统临时目录 javdex-css-modules- 前缀）。与 WvhI0x 的 928 组记录逐项相同；全部图片尺寸相同，2386 张 RGB 相同、398 张存在差异。不是所有差异均已完成分类，也不是全部实际页面入口已通过，不因此将全量目标标为完成。

### 实际入口整页验收与 Module 导出键审计

- TypeScript AST 对照实际 PostCSS Module 导出，检查 206 个生产消费者的 2725 个静态键引用，读取 200 个实际 Module，没有缺失键。另有 12 处动态键引用；逐项核对 ActressStatusBadge、Button、EmptyState、Modal、NoticeBanner、PluginSourceBadge、ScrollViewport、StatusText、Toast、PluginDevResultPanel 和 WebText 的受限值及 CSS 导出，包含 Modal 的 md、插件来源 composite 及安装态 not-installed 的静态映射。此项补充字面全局 class 清单，不以类型声明允许任意键就宣称正确。
- 按 codebase-design 使用现有 preload Interface 作为隔离 seam，新增 `desktop-whole-page-style-check.mjs` 与独立 whole-pages 入口。直接运行生产 App、QueryProvider、真实 hash 路由与全部上下文，不变换生产源码、不用假页面壳、不调用真实 Electron IPC 或个人资料库。合成读取数据由显式 API 提供；未知读取和任何未授权写操作均抛错并记录，生产 hook 捕获异常也不能让验收静默通过。
- 132 组完整入口矩阵通过，输出 bxaeYA（系统临时目录 javdex-whole-pages- 前缀）、244 张原始截图；覆盖 1440×900／1000×640 × graphite／light。媒体库、演员、清单、导演、系列、制作商及发行商各验证有数据、空、加载、读取失败四态；有数据态另验证真实列表滚动与 stable 槽、无 document 滚动、键盘可见焦点、搜索词进入 URL、空结果和清空恢复。28 组实际列表滚动及焦点记录保存在 results.json。另覆盖待确认空队列、设置概览、外观、影片插件空列表、媒体库来源空目录的真实设置入口；不把这些代表状态称为全部设置子页及待确认有数据验收。
- 待确认实际入口补充加载及读取失败，独立 12 组通过，输出 FvPzWo；其中四组空队列与上述 132 组重叠，不简单相加宣称 144 个不同场景。整页夹具首轮因搜索框 role／名称、可见标签及合成查询 all 条件写错而失败，已按真实组件契约修正；失败不计入通过。后续依赖预编译在外观入口首次导入 MediaPipe 时重启，导致动态 App 模块请求失效，完整矩阵明确失败。夹具显式预编译这一延迟依赖后完整通过，未删除 pageerror 断言或改生产依赖；MediaPipe 原依赖的动态 import 分析警告仍可见，不代表头像模型推理通过。
- 最新完整复跑包含待确认的新增状态，140 组通过、252 张 PNG，退出码 0，输出 Zq4Ks0、日志 `/tmp/javdex-whole-page-final-140.log`。28 组列表滚动／焦点记录仍在，所有状态保留无未知 API 调用、无浏览器异常、无外层溢出的断言。已核看 1000px 的媒体库来源、分类列表滚动和待确认加载整页截图；尚未检查的详情和设置子入口仍保留，不据此标记全部页面验收完成。
- 旧基线的大差异已核看封面防窥与插件预登入开关：旧截图分别停在图片滤镜及 switch 过渡中，新截图到达既有目标状态。当前稳定重复记录：covers 4／4 张 RGB 相同；pluginConfigUser 21／24 张相同，另外 3 张分别差 2／88／2 像素；pluginDevTargetActress 24／24、pluginDevTargetVideo 32／32、playlistCards 4／4 张相同。目录依次 IT7nSd、z7ilQs、z0fnt2、ertGYb、hioL22。这些只支持对应状态的稳定性，不能冒充其余 398 张差异已全部核清。
- 按 diagnosing-bugs 缩小整页搜索失败到清单单页：回顶的连续网格 onAnchor 在输入之后 replace 同一个 `/playlists`，location key 改变，旧上下文草稿被清空。临时路由日志证明输入曾为 fixture-no-match，随后同路径导航使其为空；日志已移除。等待回顶两帧稳定后的清单 16 组通过。保留 `JAVDEX_WHOLE_PAGE=playlists JAVDEX_WHOLE_PAGE_RAPID_INPUT=1 node scripts/desktop-whole-page-style-check.mjs` 的快速输入复现，仍以超时／非零退出失败，明确不将其称为修复或验收通过。生产滚动／路由行为未改变，独立问题记入 UI 后续清单。
- 本批只修改验收脚本和文档；CSS／UI／编码检查、脚本语法、diff 检查及清单／策略／loader／稳定截图 15 项测试通过。沿用此前生产源码的完整 3369 项测试及最终构建证据，不冒充再次运行。目标仍进行中：补齐剩余实际详情与设置／开发工作区入口及待确认有数据状态，核清剩余旧非稳定基线差异；不重做已完成的源码迁移，不宣称真实资料库、真机、原生 Electron 或跨平台全部验收。未提交、推送或发布。

### 详情与常规设置入口扩展

- whole-pages 夹具新增影片、演员、清单、导演、系列、制作商与发行商七类真实详情路由，每类覆盖正常、记录不存在、读取加载及读取失败四态。影片详情和演员 Profile 的合成返回值先由正式 Zod 合同校验；关联影片仍由实际分页 hook／连续网格读取，未用假详情布局代替。正常态检查返回按钮可见键盘焦点、真实详情滚动槽与返回原列表；滚动及返回继续走生产组件，不直接调用测试 router helper。
- 新增常规设置子入口后覆盖 SETTINGS_GROUPS 中全部 19 个 tab 的代表读取状态：概览，媒体库来源／常规／刮削／显示／维护，影片／演员插件，模型用途／提供商／高级，外观，连接／图片／备份／NFO，网页／代理及关于。这不是所有子页操作过程、远程模式或插件开发工作区的全流程验收；本地连接本来不显示远程播放器配置，不因测试断言而修改业务显示条件。
- 只补显式 thisComputer.get、备份 list、NFO options／订阅及模型用途的合成读取合同。备份 control 只允许 list，其它动作失败；其它未知读写仍由严格代理抛错。首两轮扩展因合成 SettingsSnapshot 漏了 llmSecretStorage，以及错把仅远程可见的“播放器程序”当作本地准备条件而失败；按正式字段和实际条件修正夹具／断言，未隐藏浏览器异常或删除未知 API 检查。
- 初轮完整扩展矩阵退出 0：312 组、508 张 PNG，输出 x2Utod，34 个实际入口，其中 112 组详情与 76 组常规设置代表状态。沿用 1440×900／1000×640 × graphite／light、无外层滚动或横向溢出约束。随后进一步增加关联影片实际渲染、详情焦点边界和返回截图后 URL 仍正确的断言，最新版本另行完整复跑，不用旧运行冒充增强断言已通过。
- diagnosing-bugs 流程发现独立的快速返回竞争：演员关联影片已滚动时点击返回，路由记录为 `/actresses/1 → /actresses → /actresses/1`。连续网格 scroll 的帧回调仍可通过 useRelatedVideoOffset 的旧 setter 覆盖返回导航；回顶稳定后返回的 16 组通过，但快速路径重复失败。保留 `JAVDEX_WHOLE_PAGE=actressDetail JAVDEX_WHOLE_PAGE_RAPID_RETURN=1 node scripts/desktop-whole-page-style-check.mjs`，移除临时路由日志后仍实际非零退出。记入 UI 后续待办，未在 CSS 保持行为任务中改生产路由，不把稳定路径叫作故障修复。
- 稳定组件重复补充：controls 4 组退出 0，输出 dJTyeY，8 张图中 4 张 RGB 相同，其余分别 14／28／14／28 个像素不同；nativeEditorActress 8 组退出 0，输出 fvXRO7，56 张中 45 张相同，余 11 张差 1–101 像素。对照仍为 W7KVkP；不能据此宣称所有旧非稳定基线差异已分类。
- 增强后的完整复跑终态为退出 0、312 组、508 张 PNG，输出 KODqmG，日志 `/tmp/javdex-whole-final-details-settings.log`；56 组真实滚动与 56 组焦点记录存入 results.json。已核看窄窗口 NFO、模型用途、导演详情、清单返回及系列读取错误的整页截图。CSS 架构、UI 控件、编码检查、脚本语法、diff 检查以及既有四类脚本 15 项测试通过；生产源码本批未改变，完整 3369 项测试／构建证据继续沿用前批，不声称重复跑过。
- 错误截图另外发现系列 Toast 中的 `undefined`：分页 hook 以字符串传出错误，导演／系列 onError 却按 Error 读取 message。布局矩阵检查的是错误区域、尺寸、API 和浏览器异常，不涵盖所有反馈合同，因此 312 组通过不意味着这个问题已修复。新增独立 `JAVDEX_WHOLE_PAGE_ERROR_TEXT=1` 严格消息检查，并记入 UI 待办；不修改生产分页或错误呈现来伪造通过。
- 严格系列错误检查终态退出 1，1440px graphite 错误态确实检测到一条 undefined，missing error message 断言失败；日志 `/tmp/javdex-whole-series-error-contract.log`。快速返回最终复现同样退出 1，日志 `/tmp/javdex-whole-actress-rapid-return-final.log`；临时调试记录已移除，所有本批验收进程均已结束。两条红色复现与正常布局矩阵分别保留。
- 全量目标仍进行中：剩余插件开发工作区、待确认有数据／选中内容、其它详情栈上下文和剩余旧非稳定基线差异仍需核查；常规设置本轮只验证代表读取状态。无真实资料库、原生 Electron 或跨平台全流程验收结论，未提交、推送或发布。

### 插件开发与选中待确认详情扩展

- 插件开发直接进入真实 `/settings/plugin-dev`，不再仅依赖独立组件宿主。合成恢复快照包含 waiting_user 会话、冻结模型、插件代码和 12 条长中文消息；另测无恢复会话／未配置模型、挂起读取和模型配置读取失败。快照错误在生产实现中为 best-effort，错误态断言的是实际模型配置错误提示，不声称恢复快照本身有独立错误横幅。
- 扫描资源归属、番号身份、影片候选及演员名称冲突各新增 16 组（两种尺寸 × 两主题 × 正常／记录消失／详情加载／详情失败），队列读取始终就绪，状态只作用于选中详情，避免把整个收件箱的加载误算为详情加载。合成数据包含八份长路径资源、文件名与 NFO 不同番号、四份影片候选及演员现有归属冲突；不读取私人资料库或访问外部网站。
- 正常态额外验证可见键盘焦点。扫描逐项分配并切换主资源，确认按钮从禁用到启用，撤销一项又禁用；番号两种选择、候选选择及影响预览走实际组件。丢弃预览只打开并以 Escape 取消，不点击确认写入。演员按可访问名称选择现有归属，检查摘要及来源详情 tab。插件开发验证真实消息滚动、代码预览、连接弹窗、结果 tab 和仅本地反馈草稿，未发送 Agent 请求或安装插件。
- 首轮交互验收因直接找被“更多处理”折叠的动作、以及把演员首个单选项误当作现有归属而失败。根据生产菜单和名称定位修正测试后，五个入口均独立退出 0、各 16 组；不修改生产 UI 或放宽未知 API／浏览器异常检查来通过。fixture 只补显式读取合同以及合成会话卸载清理 no-op；其它未知 API 继续抛错，不提供业务确认、运行 Agent 或安装方法。
- 最终完整矩阵退出 0：392 组、652 张 PNG、39 个实际入口，输出 `1LSTlG`（系统临时目录 javdex-whole-pages- 前缀），日志 `/tmp/javdex-whole-final-pending-plugin.log`；results.json 含 76 组焦点及 60 组显式滚动记录。扫描分配会自然滚动到末项，但不把这种自动定位冒充独立滚动槽记录。各状态仍断言 document 无外层滚动／横向溢出、侧栏尺寸、无未知 API 及浏览器异常。已核看窄窗插件开发消息、扫描末项／固定确认区、番号取消弹窗、演员来源详情及候选读取失败的原始整页截图。
- 稳定组件重复补充：appearanceReady 八组退出 0，输出 `G1Dvbb`，80 张全部与 W7KVkP 的 RGB 相同；actressAvatarEditor 八组退出 0，输出 `p8EvK3`，24 张全部相同；videoResources 八组退出 0，输出 `QjdKXx`，24 张中 21 张相同，余三张差 8／16／26 个像素。旧外观页代表截图的差异位于头像预览清晰度；旧头像 local 截图仍高亮“写真”，当前与重复图已高亮“本地”，旧图不能作为已稳定到目标 tab 的证明。影片资源旧菜单代表图未完成触发按钮悬停着色，当前图达到目标着色。这里只记录已检查的差异及重复证据，不概括其余 398 张旧差异已全部核清。
- 本批只改验收脚本与记录。CSS 架构、UI 控件、编码、Node／JSX 语法、diff 检查及既有四类脚本 15 项测试退出 0；生产源码未改，完整 3369 项测试及最终构建沿用前批，未重新运行。目标仍进行中：补充其它详情栈上下文，核清剩余旧基线差异；独立业务问题继续单列待办，不为 CSS 迁移改变原业务。此处不宣称所有 Agent 运行状态、真实资料库、原生 Electron 或跨平台全流程验收。未提交、推送或发布。

### 详情叠层、截图重复与最新完整回归

- 整页夹具增加首页、搜索、待确认、演员、清单及四类分类上下文的影片／演员叠层，以及媒体库影片后的演员和待确认直接演员入口，共 20 个入口。只让最上层目标的读取进入正常／加载／消失／失败状态；父层保持就绪。断言实际层数、父层隐藏及不拦截指针、返回后的父节点仍为同一实例；搜索返回分别核对保留 q、影片返回列表清除 lib、演员返回影片保留 lib。所有未定义 API 仍抛错，未引入业务写入。
- 默认完整运行仍非零退出：`stackActress-actress`（`/actresses/1/1/actress/2`）期望三层，实际只有一层。当前 HEAD 的路由逻辑已有此问题，严格复现日志 `/tmp/javdex-whole-stack-actress-chain-final-red.log`；后续业务待办见 UI_CONSISTENCY_FOLLOWUP.md。没有调低层数断言。显式使用 `JAVDEX_WHOLE_PAGE_SKIP=stackActress-actress` 的部分矩阵退出 0，输出 `E3AyVe`，696 组／58 入口／1184 PNG，包含 304 组叠层、152 组焦点、136 组显式滚动记录，输出列明 skippedSurfaces。不能写成全部 59 个入口通过。已核看 1000px 浅色演员上层、深色返回影片、首页影片失败和主题文字截图。
- 待确认直接演员入口首次在侧栏可见等待超时，无未知 API／浏览器异常；两次独立复跑各 16 组通过。原因尚未确定，不能声称修复了该一次性失败；完整部分矩阵另行通过。
- 原 398 张旧差异均已找到稳定重复截图，重复图相对 W7KVkP 为 320 张 RGB 相同、78 张不同；这 78 张每张差异不超过 177 像素，最大通道差 33。54 张最大通道差不超过 8。这里只证明重复差异范围有限，不将所有原因概括为抗锯齿。标签删除悬停／焦点、代码编辑焦点、头像 tab／图片解码及资源触发悬停的代表差异另有截图证据。新增有效重复组为 68 组／154 PNG 和 208 组／908 PNG；曾误写 `JAVDEX_CSS_FIXTURE=library` 得到零结果，不计通过，现已增加非空及请求项全部被执行的断言，错误选择实际退出 1。整页入口也在启动前校验筛选／排除名称。
- 进一步核看会话反馈、媒体资源迁移及媒体库筛选的大幅旧差异代表图：会话旧图保留输入焦点边框，新图在点击发送后已移走焦点；筛选旧图保留重置前的标签强调着色，新图已到 aria-selected=false 的目标状态；资源迁移浅色旧图标题仍为过浅继承色。提前主题初始化后，插件区标题与关联链接排序箭头也恢复深色，分别对照了前后原图。这里只记录已观察状态，不将未定位的边缘像素解释为同一原因。
- 原比较还漏检了分类资料卡首帧文字：旧基线与 W7KVkP 都可能把浅色卡片文字继承为深色主题文字，几何记录相同无法检出。新增 body／资料卡颜色必须等于当前 `--text-primary` 的断言后连续非零退出；祖先探针未发现显式颜色覆盖。只将测试 HTML 的主题赋值提前到模块／样式初始化之前，断言恢复 8 组通过，最终清除探针后输出 `0d2ZeB`，日志 `/tmp/javdex-css-classification-early-theme-final.log`。生产 CSS 未加补偿颜色，截图助手未注入样式或关闭动画。完整组件矩阵随后重新执行，证据如下，不沿用旧“稳定”结论。
- 本轮重新运行 `npm test` 退出 0：3369 项，3367 通过、2 跳过、0 失败，日志 `/tmp/javdex-css-goal-final-tests.log`。全仓 lint、生产构建、各架构边界、UI 控件、编码检查及四类验收脚本 15 项测试退出 0。构建 CSS 为桌面 471064 字节／gzip 70468、Web 22986／5255、图片预览 7737／1911，与前次一致。最新源码清单仍为 260 个消费者、未定义字面类 0；桌面全局只保留两个文本选择合同，Web 全局功能类 0。上述不等同于真实资料库、原生 Electron、跨平台安装或全部业务流程验收。未提交、推送或发布。

### 本轮收尾与下一步边界

- 最新完整组件矩阵终态退出 0：`aO38WS`，928 组／2784 PNG，日志 `/tmp/javdex-css-goal-final-stable-matrix.log`。与 W7KVkP 对比时仅去掉新增 colors 字段，其余 928 组记录逐项相同；8 组浅深主题的 body／资料卡继承色均符合 token。2648 张 RGB 相同、136 张不同，无图片尺寸变化。最大差异是四档浅色分类卡各 1734 像素及插件区标题 867 像素，原图已核对为主题初始化修正；关联链接箭头也已核看。预览器四张差 177／201 像素，最大通道差 5；其余差异不超过 101 像素，不概括为全部抗锯齿或逐像素通过。
- 生产样式所有权迁移没有待迁页面；主题／reset／document 契约、动态几何、第三方局部适配属于明确保留项。所列组件、Web 浏览器及整页代表路径的检查范围均有记录，不继续用不断扩张的矩阵代替明确的业务修复决策。
- 上述三层演员失败及部分矩阵是用户确认纳入修复前的历史终态；纳入后的完整闭环见下一节。快速返回／搜索竞争和错误字符串合同继续作为独立待办，不将单项纳入解释为全部业务修复授权。不自动提交、推送或发布。

### 用户确认纳入三层演员路由后的最终闭环（2026-10-01）

- 修复前重跑真实 App 的三层演员入口仍退出 1（期望三层，实际一层）；新增真实演员页交互回归也因只读取末层演员 2 而失败。修复将实例角色交给路由声明：九处影片内演员入口显式传 `fromVideo`；演员列表父层读取自身 `id` 并保留 Outlet，末层读取 `actressId`，待确认直接演员仍使用入口参数。没有改变 URL、导航 helper 或 CSS。路由约定同步到 ROUTING_DESIGN.md。
- 演员页 7 项交互测试通过，覆盖两个独立演员身份、父／末层状态、返回 URL 的偏移及同一父节点保留。真实 App 定向 16 组通过后，整页脚本追加父／末层 profile ID 必须分别为 1／2 的断言，重新运行完整矩阵，未降低原有层数、父层不可交互、返回保留和未知 API／异常检查。
- `node scripts/desktop-whole-page-style-check.mjs` 退出 0，输出 `Ptkvyn`：59 个入口、712 组、1212 PNG、320 组叠层、156 组焦点及 140 组显式滚动记录；`skippedSurfaces: []`。三层演员的 16 组均记录 `detailDepth: 3` 与 `actressIds: [1, 2]`。已核看 1000px 浅色演员、返回影片及错误态截图。日志 `/tmp/javdex-actress-stack-whole-final.log`；目录 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-whole-pages-Ptkvyn`。
- 最新 `npm test` 退出 0：3370 项，3368 通过、2 跳过、0 失败；包含全仓 lint、类型、打包规则与架构边界检查，日志 `/tmp/javdex-actress-stack-final-tests.log`。`npm run build` 退出 0，日志 `/tmp/javdex-actress-stack-final-build.log`；桌面 CSS 471064 字节／gzip 70468，Web 主 CSS 22986／5255，预览 CSS 7737／1911，与本轮路由修复前相同。编码、整仓 diff 及整页脚本语法检查通过。
- 最终源码清单再次核对：260 个消费者、未定义字面类 0，桌面仅两个 document 文本选择 class、Web 全局功能类 0；49 个 JSX 动态样式候选及 12 条受约束 Module global 选择器仍符合上文已逐项记录的保留职责。没有新增生产样式；此前完成的 928 组组件矩阵证据继续有效，本次只重新运行受路由修复影响的完整整页矩阵，不声称组件矩阵又重跑了一次。
- 完成条件逐项闭环：页面及关联 owner 已收口，旧功能规则已删除，主题／布局／滚动／焦点及动态几何证据已记录，最终全局审计与非增长 CSS 约束通过，完整测试／构建及桌面和 Web 浏览器验收均有终态。剩余独立业务缺陷、窄窗历史问题及真机／跨平台边界见 UI_CONSISTENCY_FOLLOWUP.md 和上文；它们不是尚未迁入 Module 的页面，也没有被本结论冒称解决。未提交、推送或发布。

### 用户要求全部修复后的八项待办回检（2026-10-01）

- 修复范围与逐项处理见 [UI_CONSISTENCY_FOLLOWUP.md](UI_CONSISTENCY_FOLLOWUP.md#八项待办修复2026-10-01用户要求全部修复)。此轮是独立业务／布局修复，不要求原缺陷的行为或截图保持不变；不抬高 CSS 债务基线，不改变列表接口与路由结构。
- 修复前重跑八项检查均取得失败证据：清单搜索 `/tmp/javdex-all-fixes-playlist-red.log`、快速返回 `return-red.log`、错误文案 `error-red.log`、刮削字段 `scrape-red.log`、侧栏 `shell-red.log`、候选样式 `conflict-red.log`、旧选择器验收 `picker-red.log`（后七项同为 `/tmp/javdex-all-fixes-` 前缀）。横屏字号的 `web-red.log` 由追加观察确认是截图重置触控仿真，探测日志 `/tmp/javdex-all-fixes-web-pointer-probe.log`；临时探针已移除，没有为仿真问题添加生产补偿样式。
- 搜索与生命周期定向测试经历两轮红色复现：相同偏移无效 replace、真实分页滚动清空待提交草稿、卸载后回调以及旧 writer 覆盖新 query，分别加入回归保护。第一轮严格全矩阵又发现导演列表同类草稿问题，日志 `/tmp/javdex-all-fixes-whole-final.log`；共享分类 hook 修复后，三个分类真实页面测试红转绿，分类文件 27 项全部通过（`/tmp/javdex-all-fixes-classification-green.log`）。没有跳过该入口或恢复等待回顶稳定的分支。
- 全部开启严格检查重新运行：`JAVDEX_WHOLE_PAGE_RAPID_INPUT=1 JAVDEX_WHOLE_PAGE_RAPID_RETURN=1 JAVDEX_WHOLE_PAGE_ERROR_TEXT=1 node scripts/desktop-whole-page-style-check.mjs`，退出 0，59 入口／712 组／1212 PNG，`skippedSurfaces: []`；156 组焦点、140 组显式滚动记录。输出 `/var/folders/h4/zxrt6zwx6dv1n16kwxzltqgh0000gn/T/javdex-whole-pages-CzfTe9`，日志 `/tmp/javdex-all-fixes-whole-confirm.log`。原未知 API、异常、几何、叠层和返回保留断言不变。
- 三项布局定向矩阵退出 0：`JAVDEX_CSS_FIXTURE=actressConflict,scrapeFieldsModal,appShell node scripts/css-module-migration.mjs`，24 组（四档宽度 × 两主题 × 三夹具），输出 `javdex-css-modules-lAO2ms`；日志 `/tmp/javdex-all-fixes-desktop-ui-green.log`。480／640px 实际鼠标点击不再被配置区拦截；侧栏底边明确不超出视口；候选 computed display 必须为 flex。规则顺序的 stylelint 失败随后修正，不改变这些几何和交互行为。没有重新执行全部 928 组组件矩阵，不沿用旧像素一致性结论冒称本轮布局不变。
- 新演员选择器脚本四组退出 0，覆盖虚拟 DOM 有界、接口页大小 40、偏移 0／40／80、跨页选择、重开保留选中、后页失败保留旧候选及重试、搜索、迟到读取隔离、真实键盘方向导航和焦点态。输出 `javdex-picker-evidence-r9a6jh`，日志 `/tmp/javdex-all-fixes-picker-confirm.log`。新键盘断言首轮因程序 focus 仍处于鼠标模式而失败，改为先 Tab／Shift+Tab 进入键盘模式，不删焦点断言或修改生产焦点 CSS。
- 登录四档视口／24 张视口截图退出 0，所有触控输入均至少 16px，且每次截图前后触控点数不变；输出 `javdex-web-login-rOBNbN`，日志 `/tmp/javdex-all-fixes-web-green.log`。`npm run web:check:mobile` 四档视口、真实键盘浏览及密码／配对流程退出 0，日志 `/tmp/javdex-all-fixes-mobile-final.log`。生产 Web CSS 未修改，不声称真机验证。
- 最终源代码生产构建 `npm run build` 退出 0，日志 `/tmp/javdex-all-fixes-build-confirm.log`。已核看窄窗刮削字段、侧栏维护、候选选中及系列错误反馈截图。原生 Electron／真实资料库、手机真机和 Windows／Linux GUI 不在本轮证据范围；未提交、推送或发布。
- 最新完整 `npm test` 退出 0：3378 项，3376 通过、2 跳过、0 失败；含全仓 TS／CSS lint、node／web／browser 类型、打包规则、工作区／领域边界及 UI／CSS 检查。日志 `/tmp/javdex-all-fixes-tests-confirm.log`。相关五文件定向测试 30 项及分类文件 27 项通过，验收工具四类测试 15 项通过；编码、脚本语法与整仓 diff 检查通过。第一轮完整检查在 stylelint 失败而终止，未计作通过；规则顺序修正后的以上整轮终态才是最终证据。
- 最终样式规则顺序修正后，三项布局矩阵再次退出 0，24 组全部通过；输出 `javdex-css-modules-HnQyEN`，日志 `/tmp/javdex-all-fixes-desktop-ui-confirm.log`。末轮文档更新后的编码及整仓 diff 检查通过。

### 同步远程 dev 后的冲突整合（2026-10-01）

- dev 快进到 `0604f65`（`feat: improve ratings, built-in playlists and membership cleanup`）。先以含未跟踪文件的 stash 保存本地工作，再恢复；备份 `73fad7e1b68bd4204b9fc887c7a1e2ac9f05c232` 保留，未自动提交或推送。七个内容冲突及 SortSwitch.module.css 的同名新增碰撞已处理；482 个无交叉本地路径按备份逐字节／删除状态核对，无损失。
- 保留远程的默认评分选择／删除撤销、外部评分排序、内置“我喜欢／稍后观看”和资源变更后的自动空归属清理。继续使用本地 CSS Module、编辑忙碌保护与异步详情控制器，不恢复远程已停用的“手动移出媒体库”。内置清单按钮显隐／定位由海报 owner 显式传入；排序“更多”使用 trigger 样式槽，未新增全局类或穿透选择器。
- 资源移动的 `sourceMembershipRemoved` 纳入共享运行时结果校验；删除或移动导致当前归属消失时，详情控制器通知并退出，保留会话失效／迟到回调隔离。相关控制器和远程结果解析的定向 27 项测试通过。类型检查、CSS 非增长约束和生产构建通过。
- 合成编辑夹具补齐正式 `external_stats`，增加默认评分切换、删除撤销和保存载荷检查；海报夹具增加两种内置清单的加入／移出、26px 按钮定位及菜单编辑，排序增加“更多”的值／方向／强调色检查。八个组件夹具 52 组退出 0，输出 `javdex-css-modules-MHgUwc`，日志 `/tmp/javdex-dev-sync-ui-final.log`。此前缺字段及颜色字符串格式断言的失败不计通过，没有添加生产容错或放宽几何／交互断言。
- 实际 App 的媒体库、清单详情和首页影片叠层各 16 组、合计 48 组退出 0；启用快速输入、快速返回和错误文案检查，保留未知 API／浏览器异常及布局断言。输出分别 `javdex-whole-pages-JGpETc`、`vcnfCc`、`0jOb7F`，日志 `/tmp/javdex-dev-sync-page-{library,playlistDetail,stackVideo-home}.log`。这是定向整页验收，不声称远程同步后重新运行了全部 712 组。
- 首次全量测试 3399 项中 3396 通过、2 跳过、1 失败：macOS 隔离用例的父进程 `lsof` 返回状态 1，而子进程此前报告无资料库句柄。日志 `/tmp/javdex-dev-sync-full-tests.log`。隔离文件随后两次定向运行均为 6／6 通过（`isolation.log`、`isolation-repeat.log`，同为 `/tmp/javdex-dev-sync-` 前缀）；尚未稳定复现，不改业务代码或弱化“不打开本地资料库”的断言，不将重跑通过称为已修复竞态。最终全量重跑终态另行记录。
- 最终完整 `npm test` 退出 0：3399 项、3397 通过、2 跳过、0 失败，日志 `/tmp/javdex-dev-sync-full-tests-confirm.log`；含全仓 lint、类型、打包规则与领域／UI／CSS 边界检查。首次隔离检查失败证据继续保留。补充验收脚本／边界测试 7 项、编码、脚本语法和整仓 diff 检查通过；已核看窄窗默认评分编辑及内置清单海报截图。Git 未解决项与暂存区均为空，HEAD 与 origin/dev 均为 `0604f65`，本地改动维持未提交状态。没有运行真实资料库、手机真机或 Windows／Linux 原生 GUI 验收，没有推送或发布。

## 未提交代码审查验证（2026-10-01）

用户明确授权完整检视、修复并提交推送全部未提交代码；历史阶段“不自动提交／推送”的记录不再是本阶段限制，版本发布仍未授权。基线 `0604f65`；两轴审查、修复原因及后端验证调整见 [UI 回检记录](UI_CONSISTENCY_FOLLOWUP.md#未提交代码完整审查2026-10-01)。没有恢复远程已停用的手动移出媒体库。

- 新增回归先保留失败：父／末层演员分页互相归零、程序性滚动恢复写回前一页，以及清单按钮指针不可达和主图错误裁切。演员 125／10 与 10／125 的真实页面回归及导航契约通过；3／8 列滚动恢复回归覆盖像素取整及跨页行。临时 history trace 已删除，正式测试仍断言初始与返回偏移保留，不放宽目标页码或跳过目标行。
- 最终完整 `npm test` 退出 0：3403 项、3401 通过、2 项平台相关跳过、0 失败，日志 `/tmp/javdex-review-final-confirm-tests.log`；包含全仓 TS／CSS lint、node／web／browser 类型检查、打包规则及所有工作区／领域／UI／CSS 边界。首轮 3399 项通过不代替修复后的终态；中间新增测试夹具的 TypeScript 返回类型错误已修正，其失败运行 `/tmp/javdex-review-final-tests.log` 不计通过。
- `npm run server:test` 退出 0：53 项、47 通过、6 项真实挂载／mpv／Linux 环境跳过、0 失败，日志 `/tmp/javdex-uncommitted-review-server-final.log`。验证来源查询、移动后自动清理来源成员、删除和旧手动移出拒绝；最初旧移出成功断言导致的失败不计通过。清单身份／查询／远程契约定向 73 项通过，日志 `/tmp/javdex-uncommitted-review-backend.log`。
- `npm run build` 与 `npm run server:build` 均退出 0，服务端生产依赖闭包有效；日志 `/tmp/javdex-review-final-build.log`、`/tmp/javdex-review-server-build.log`。没有生成安装包或运行 Docker 安装验收。
- 最终真实 App 整页矩阵：59 入口、712 组，开启 `JAVDEX_WHOLE_PAGE_RAPID_INPUT=1`、`JAVDEX_WHOLE_PAGE_RAPID_RETURN=1`、`JAVDEX_WHOLE_PAGE_ERROR_TEXT=1`，退出 0，`skippedSurfaces: []`。输出 `javdex-whole-pages-4HhLsM`，日志 `/tmp/javdex-review-final-whole.log`。末层演员作品数与父层不同并保留非零父层偏移，16 组定向复验输出 `javdex-whole-pages-hDKPa1`，日志 `/tmp/javdex-review-actress-browser-final.log`。
- `node scripts/standards-p2-ui-check.mjs` 退出 0，1440／1000／480px、浅深主题共 12 组；鼠标实际点击清单移除按钮、实际滚轮到达分类主图长错误末尾、草稿重试成功，输出 `javdex-standards-p2-KEJjkT`，日志 `/tmp/javdex-review-standards-final.log`。已核看按钮与错误末尾截图；没有强制点击或 DOM click。
- 冻结修复后的生产代码，完整重新运行 `node scripts/css-module-migration.mjs`，退出 0：928 组组件检查、2796 张截图，输出 `javdex-css-modules-hFMj5d`，日志 `/tmp/javdex-review-final-components.log`。本轮不是仅沿用旧矩阵；与 712 组整页矩阵分开记录，不宣称全部截图像素相同或跨平台原生 GUI 已验收。
- Web 移动端检查及键盘浏览、密码／配对流程通过，日志 `/tmp/javdex-uncommitted-review-mobile.log`；登录 4 视口、浏览与详情各 6 视口、资源与预览 4 视口的定向样式矩阵均退出 0，日志为 `/tmp/javdex-uncommitted-review-web-{login,browse,detail,resources}.log`。属于模拟浏览器，不等同于手机真机。
- 最终源码清单 262 个生产消费者、未定义字面类 0；桌面全局仅两个 document 文本选择 class、Web 全局功能类 0，49 个动态 inline 候选和 12 条受约束 Module global 保留职责不变。未抬高 CSS 债务基线。临时输出在系统临时目录，不入 Git；原远程同步备份 stash 保留。真实资料库、原生跨平台 GUI、跨平台安装与故障测试未执行。
