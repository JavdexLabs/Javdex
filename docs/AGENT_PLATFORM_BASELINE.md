# Agent 平台迁移基线与验证记录

- 冻结日期：2026-08-20
- legacy 基点：`dev`（Electron `33.2.0`、`better-sqlite3` `11.5.x`）
- 目标：用可重复 fixture 比较领域正确性，并把真实 provider/安装器数据与本地推测分开。

## 已冻结的基线

| 项目 | legacy 基线 | 验证方式 |
|---|---:|---|
| 全量测试 | 1157 pass / 0 fail | 迁移前 `npm test` |
| 插件工具 | 18 个 | `toolExecutor.test.ts` 的 create/debug/finish/install/wait 与逐工具 fixture |
| 测试时长 | 约 9.6 秒（Electron tests） | 本机一次完整运行，仅作回归参考 |
| `package-lock.json` | 约 440 KiB | `wc -c`，不等同安装器体积 |

冻结的领域 invariant：初始 debug dry-run、dry-run 后自动 verify、已有代码最小修改、finish 必须通过当前代码的 dry-run/verify、install gate、challenge wait/resume、cancel、完整工作日志，以及 18 个工具的 schema/结果规则。

## 新平台自动门禁

- `AgentExecution`：同一 run 十次 operation 只 open 一次 RuntimeSession；正常恢复不读 ExecutionHistory；typed checkpoint corruption 每 generation 只重建一次。
- `PiRuntimeAdapter`：真实 Pi `0.84.2` + faux HTTP stream；十次 warm turn、custom allowlist、durable tool-result barrier、稳定 affinity、零 builtin/discovery。
- `ToolHost`：permission、approval permit、resource lock、AbortSignal、redaction、ledger、terminal fail-closed 与 uncertain write。
- `AgentRunStore`：schema 14、加密 recovery frame、hash integrity、幂等 operation、rebuild generation。
- 架构静态检查：Pi import locality、禁止 legacy loop/compression/provider tool-chat、禁止 `PI_CACHE_RETENTION`。

## 真实 canary 与发布 guardrail

真实 provider 的 cacheRead、成本、首 token/settled p50/p95 需要受支持模型的有效凭据和稳定网络；仓库测试不伪造这些结论。发布候选应对固定脱敏任务集记录：

- 总输入成本不高于 legacy 中位数 10%；
- 首 token 与 settled p95 不高于 legacy 15%；
- cacheRead/cacheWrite/uncachedInput 与 nullable missedCost；
- 成功率、工具错误率、审批正确性不退化。

Windows x64/arm64 安装、卸载、自动更新与真实安装器增量必须在对应 runner/设备执行。macOS 本机构建和依赖清单只证明当前平台可打包，不替代 Windows 签名与安装验证。
