# 性能工作与证据索引

性能材料以 2026-09 的大媒体库审计为历史基线。部分批次已经落地，但完整 15 个工作包／42 项风险仍未全部验收，不能将历史“当前 schema 18”当作现行 schema；实际结构以共享数据库迁移为准。

## 剩余范围

[优化计划的完整待办矩阵](large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)统一列出已实现和保留工作，[读查询隔离清单](large-library-read-worker-plan.md)保留原生终止、WAL、端到端与目标平台限制。这些材料不是自动继续执行的授权；后续应先对照最新代码重新确认缺口，不照抄旧批次顺序。

## 实施与测量

- [实施记录](large-library-implementation-status.md)按批次追溯实际修改；[高频查询与扫描收尾](large-library-high-frequency-cleanup-results.md)记录 DF 范围。
- [主审计](large-library-performance-audit.md)、[后台审计](large-library-background-audit.md)、[UI 审计](large-library-ui-audit.md)保留发现的原始上下文，不因后续局部改动而追溯改写数字。
- [连续浏览](desktop-continuous-browsing.md)等专项报告说明相应功能及其测量边界。
- [原始结果与复跑](large-library-results/README.md)保存合成夹具、JSON、批次 review 和 manifest。原始数据、失败记录及基准脚本不随计划清理删除，也不将一次本机 SQL 测量推广为全部平台表现。
