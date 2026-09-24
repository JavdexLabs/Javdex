# 服务端模式历史归档

这些文件保留方案演进、已接受的取舍及真实验证证据，不能作为现行 API 或待办清单。当前工作从 [当前状态](../../SERVER_MODE_NEXT_STEPS.md) 开始，部署操作见 [服务端模式](../../SERVER_MODE.md)，代码导航见 [实现与合同](../../SERVER_MODE_CONTRACT_INVENTORY.md)。

| 历史文档 | 用途 |
|---|---|
| [可行性研究](SERVER_MODE_FEASIBILITY_RESEARCH.md) | 2026-09-12 基线的架构论证、撤回实验和产品边界讨论 |
| [管理合同与验收研究](SERVER_MODE_API_RESEARCH.md) | 实施前 IPC 分类、协议设计和 M01–M15 验收要求 |
| [结构准备验证](SERVER_MODE_STRUCTURE_VALIDATION.md) | S00 目录搬迁的 Windows 验证；“server/http 预留”仅指当时 |
| [S00–S14 原执行计划与证据](SERVER_MODE_EXECUTION_PLAN.md) | 阶段要求、D01–D07、历史实现记录与验收矩阵 |
| [C1–C7 实施与架构收敛](C1_C7_IMPLEMENTATION_LOG.md) | 2026-09-14 至 09-17 补齐功能、收尾修正及协议简化的过程 |

阅读时注意后续覆盖关系：

- “远程刮削/重命名/精确查询/来源/清单链接不可用”已由 C1–C7 实现覆盖。
- T5 的 DTO 近似 fillEmpty、T6 的 count 创建孤立记录，已由后续 `scrape.fields` 和只读 `targetLists.count` 修正。
- 持久 `waitingMaintenance` 与阻挡新维护任务已被忙时 `MAINTENANCE_BUSY` 拒绝并重试替代。
- 双端迁库状态和 `migration.allowEnable` 已被本端 role/phase、离线包及人工停用确认替代。
- “0.8 发布”“合并 main”等是历史计划，不能视为当前发布决定或操作授权。
- 测试结果只证明记录中的提交和环境；旧 M/D 矩阵中的剩余项不全部仍是实现缺口，S13/S14 也未因此完成。

归档保留原文中的代码路径与阶段上下文；已迁移的 Markdown 链接尽量指向现有代码，查找历史实现可结合文中提交使用 Git。
