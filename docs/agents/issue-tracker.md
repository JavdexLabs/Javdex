# Issue 跟踪器：GitHub

本仓库的 Issue 与 PRD 记录在 GitHub Issues 中。所有操作使用 `gh` CLI。

## 约定

- **创建 Issue**：`gh issue create --title "..." --body "..."`
- **读取 Issue**：`gh issue view <number> --comments`，同时读取标签；需要过滤评论时使用 `jq`
- **列出 Issue**：使用 `gh issue list --state open --json number,title,body,labels,comments`，按需添加 `--label` 和 `--state`
- **评论 Issue**：`gh issue comment <number> --body "..."`
- **添加或移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭 Issue**：`gh issue close <number> --comment "..."`

在仓库目录中运行时，由 `gh` 根据 `git remote -v` 自动识别 `JavdexLabs/Javdex`。

## 是否将 Pull Request 纳入分类队列

**否。**

如以后希望把外部 PR 当作功能请求处理，可将此项改为“是”。届时 `triage` 技能会使用相同的标签和状态处理 PR。

GitHub 的 Issue 和 PR 共享编号空间，因此 `#42` 可能指其中任何一种。需要判断时，先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 当技能要求“发布到 Issue 跟踪器”

创建一个 GitHub Issue。

## 当技能要求“获取相关工单”

运行 `gh issue view <number> --comments`。

## Wayfinder 操作

`wayfinder` 使用一个 Issue 作为路线图，并用子 Issue 表示具体任务。

- **路线图**：添加 `wayfinder:map` 标签，正文记录 Notes、Decisions-so-far 和 Fog
- **子任务**：优先使用 GitHub 子 Issue；不可用时，在路线图正文中维护任务清单，并在子任务顶部写入 `Part of #<map>`
- **类型标签**：使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`
- **阻塞关系**：优先使用 GitHub 原生 Issue dependencies；不可用时，在子任务顶部写入 `Blocked by: #<n>`
- **领取任务**：`gh issue edit <n> --add-assignee @me`
- **完成任务**：评论结果、关闭子 Issue，并在路线图的 Decisions-so-far 中追加上下文链接
