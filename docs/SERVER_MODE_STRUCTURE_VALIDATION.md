# Monorepo 结构准备验证记录

本记录仅验证目录、工作区与现有桌面/Web 构建行为，不能作为服务端功能验收。执行交接见 [S00–S14 计划](SERVER_MODE_EXECUTION_PLAN.md)。代码基线 `cac9f6982eaef6afc34f86f9a51486f8ff10dd2b`，当前分支 `codex/server-mode-feasibility`，验证平台 Windows、Node `22.22.1`。

## 已完成的结构工作

- main/preload/renderer/MCP 移入 `apps/desktop/src`；浏览页面移入 `apps/web/src`。
- 原 shared 的浏览器安全代码移入 `packages/contracts/src`；Node 路径/根/源资源身份工具移入 `packages/library/src`。
- 现有共用 Checkbox 及 CSS 移入 `packages/ui/src`，两端改为引用该组件，没有修改外观或交互。
- 添加私有 npm workspace 清单；server/http 尚为预留工作区，未创建假的成功构建或服务入口。
- 更新配置、别名、测试发现、架构检查、研究探针、性能脚本及文档路径。394 个原测试文件完整保留，没有以删除测试规避目录迁移问题。
- 根输出和桌面打包位置保留；安装与 Electron rebuild 分开。release workflow 在桌面测试/打包前显式准备原生模块。
- lockfile 仅通过 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` 更新，未升级外部依赖。当前共享 node_modules junction 的目标没有执行安装或重建。

## 验证结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | Node、桌面 renderer、browser 全部通过 |
| workspace 版本与依赖边界 | 通过；网页/共享生产代码不导入桌面或 Node 后端 |
| 现有领域/图片/元数据/分类/Agent 边界 | 通过 |
| TypeScript/CSS lint、CSS 架构、UI 控件 | 通过；保持原规则和债务基线，未提高容许上限 |
| `npm run build` | Electron main/preload/renderer 和 Web 生产构建通过；MediaPipe 与打包 Pi 运行时资源检查通过 |
| `npm run build -w @javdex/web` | 从 workspace 入口构建成功，产物仍在根 `out/web` |
| `node scripts/run-electron-tests.mjs` | 2921 项测试：2916 通过、0 失败、5 跳过；358 suites，约 113 秒 |
| `npm run test:packaging` | 8 项通过、0 失败 |
| 测试发现与交接链接 | 原/新测试文件数 394/394；交接及工作区文档无失效本地链接，执行文件无残留旧根源码路径 |
| `git diff --check` | 通过 |
| `npm run check:encoding` | 仍失败于基线已有的 `scanCodeCounts.test.ts`、`scanNfoWorkset.test.ts`，现位于 `apps/desktop/src/main/scanner`；未关闭检查或清洗无关测试 |

5 个跳过项来自既有平台条件：符号链接逃逸、Windows 不适用的两项 POSIX 权限/模式测试，以及两项目录同步失败测试。它们未被本轮新设为跳过；Linux/真实文件系统行为仍需后续验收。

完整运行日志留在当前工作区忽略的 `out/workspace-build.log`、`out/workspace-tests.log`、`out/workspace-pretest.log`、`out/workspace-web-command.log`、`out/workspace-encoding.log`，不作为必须跨检出携带的源码。未运行安装包安装、真实 Docker 服务、NAS 卸载或播放器验收；独立服务端和业务抽离均尚未完成。

## 接手注意

本次变更包含源码移动和新文件，统一纳入交接提交。接手使用 `origin/codex/server-mode-feasibility` 中包含本记录的交接提交，并核对交接提示的提交哈希；不要只检出原研究基线。S01 开始实施之前复核当前状态，不能把此记录当未来变更后的测试结果。后续计划新增 S02D 与 D01–D07 仅为文档设计，未计入上述结构准备验收结果。
