# 测试检视与清理（2026-09-27）

## 范围与判定

基线为 `a5dd262`。盘点全部 485 个 `*.test.*` 文件：桌面主进程 174、渲染端 153、服务端 8、contracts 18、http 1、library 128、脚本 3。检查测试入口/CI 引用、测试与断言结构、无运行时断言文件、跳过条件、源码读取、重复测试体及独立烟测脚本的调用方；对命中的候选逐项核对被测实现与替代覆盖。

删除依据是断言不能验证声称的行为、只锁定实现写法，或被更完整的同路径测试包含。测试短小、执行较慢、名字相似或存在平台跳过，本身不是删除理由。旧版本迁移、故障回滚、安全边界及不同宿主的端到端验证继续保留。

## 已清理

| 对象 | 处理与依据 | 保留的行为覆盖 |
|---|---|---|
| 11 个 renderer 源码/样式测试文件 | 删除 21 个只匹配 JSX 字面量、固定 CSS 值、文案、图标或“最近新增 7 个输入框”的用例 | `MediaLibraryCreateModal.test.tsx`、`MediaLibrarySettingsTabs.test.tsx`、`VideoLibraryMembershipBadges.test.tsx`、`VideoResourceImportModal.test.tsx`、`HomePage.test.tsx`、`PlaylistDetailPage.interaction.test.tsx` 等交互测试，以及 CSS/UI 架构检查；不把这些检查当作视觉验收 |
| `PlaylistImportContext.test.ts` | 13 个源码/样式匹配替换为 5 个真实组件行为测试，改为 `.test.tsx` | 本地/远程默认选项与提交、归档库排除、取消确认及失败后保持打开、身份版本更新后清除旧选择、外链交给宿主、完成后查询失效/单次通知/关闭并跳转 |
| `AgentMetadataActivityFeed.test.tsx` | 移除固定高度等 CSS 声明复制，保留长内容完整显示的运行时断言 | 思考流展开/收起/完成转换、长文本内容 |
| `test/cssDeclarations.ts` | 删除不再被任何测试使用的样式读取工具 | 虚拟列表几何约束测试独立保留 |
| `browser/dto.test.ts` | 删除“手写安全 DTO 再验证其安全”和空会话常量的 2 个用例 | 禁止字段检查移至真实 `catalog.browse/detail` 输出；凭据检查移至真实远程连接后的 session 输出 |
| `catalogBackend.types.test.ts` | 改名 `.typecheck.ts`，保留全部类型断言与 `@ts-expect-error` | `typecheck:node` 继续检查，运行时不再把空模块计为一次通过 |
| `scrapeUaProfile.test.ts` | 删除只重复调用 reset 且断言“不抛错”的用例，不能证明缓存被清空 | UA 净化与平台映射测试保留 |
| `migrationsV18.test.ts` | 删除不完整 schema 18 fixture 的 18→19 表存在性检查 | `migrationsV19.test.ts` 用完整旧结构覆盖相同 4 张表、空库、外键检查及失败回滚 |
| `createDesktopRuntime.test.ts` / 服务端 `runtime.test.ts` | 删除对实现文件中函数名、导入字符串的匹配；保留运行时重建测试 | 原生窗口重建测试与 `createDesktopRuntime.isolation.test.ts` 的真实数据库/文件描述符隔离验证 |
| `ipcDisposition.test.ts` | 删除必须恰好 296 个 IPC 的断言，保留非空与完整集合一致性 | 新增/删除声明时仍检查每个通道都有对应归属及合法管理接口 |
| 两个平台相关用例 | Windows 备份路径用例和大小写不敏感文件系统用例明确跳过原因 | 支持的平台照常执行，不再提前返回却计为通过 |
| `scrapeBrowserHelperMenu.test.ts` | 改名 `scrapeBrowserHelperBanner.test.ts`；删去无法证明“宿主不注入页面”的 HTML 字符串检查 | 保留 HTML 转义/动作链接与登录确认不被未完成导航阻塞的行为回归 |

删除的 11 个 renderer 文件：`DetailPageLayout`、`HomePageLayout`、`MediaLibrarySettingsPageStyle`、`PlaylistDetailPage.test.ts`、`MediaLibraryCreateModalStyle`、`videoResourceImportLayout`、`FormPrimitivesStyle`、`MediaLibraryNavStyle`、`DetailLibraryContextStyle`、`RecentInputStyleContract`、`AgentMetadataCollectorContext.test.ts`。删除记录均可通过 Git 恢复。

## 明确保留

- `libraryScanAuditLayout.test.ts` 的 CSS/虚拟化行高关系：实际跨模块尺寸约束，错配会使滚动定位错误。
- prompts、插件包和序列化输出中的文本断言：这些字符串本身就是产品对模型/插件/调用方的输出，不等同于读取实现源码来猜测行为。
- scanner 与 library 的相近用例：分别验证编排接线、事务原子性、数据结构和分页资源释放；不是同一个测试的复制。
- schema 旧版本升级及逐阶段故障回滚：旧版本不是失效功能，仍是受支持升级路径的输入。
- Node/Electron、真实网络/文件系统/数据库及独立安装包烟测：宿主与产物边界不同。测试文件名相似、断言少或只被手工入口引用不构成删除依据。
- 三个脚本测试均有现存入口，服务端 8 个测试文件均被 `server:test` 纳入。没有通过缩小 runner 发现范围消除失败。
- Docker、Linux mount/netns/fsync、mpv 及多平台安装验收脚本保留。本次只改测试与文档，没有把 macOS 单元测试结果作为容器或全平台 GUI 验收。

## 验证

基线 `npm test` 的 Electron 测试：3316 项，3315 通过、1 跳过、0 失败。基线 `server:test`：常规 47 项（43 通过、4 平台/能力跳过），双后端 7 项（5 通过、2 Linux 专用跳过）。

清理后自动化测试文件从 485 个降至 472 个，测试入口与发现范围不变。当前 macOS 环境验证结果：

| 检查 | 结果 |
|---|---|
| `npm test`（包含 pretest） | 退出码 0；架构边界、lint、CSS/UI 检查、类型检查、打包运行时检查均通过；Electron 测试 3282 项，3280 通过、2 跳过、0 失败 |
| `npm run server:test` | 退出码 0；常规 46 项，42 通过、4 跳过；双后端 7 项，5 通过、2 跳过；0 失败 |
| `node --test scripts/release-metadata.test.mjs` | 3 项全部通过 |
| `git diff --check` | 通过 |

Electron 比基线多出的跳过项是原先在非 Windows 环境中途返回、却被记为通过的 Windows 路径映射用例，并非新增未通过测试。新清单导入测试使用真实 React 组件与查询缓存、模拟宿主 API，验证组件行为，不代表原生窗口或真实网站 GUI 验收。

独立冒烟脚本本次核对入口、依赖与现有实现，没有运行 Docker、安装包、mpv 或完整 GUI 验收。`catalog-worker-asar-smoke.ts` 的无 `operation` 请求仍是当前 worker 支持的标签查询分支，保留其合成 ASAR/原生 SQLite 边界验证；不把普通 worker 集成测试当作它的等价替代。
