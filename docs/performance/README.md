# 性能工作与证据索引

大媒体库性能材料以 2026-09 的审计为历史基线。部分批次已经落地，但完整 15 个工作包／42 项风险仍未全部验收，不能将历史“当前 schema 18”当作现行 schema；实际结构以共享数据库迁移为准。

## 桌面播放

- [Linux 播放优化核查与设备接续清单](linux-playback-optimization-opportunities-2026-10-26.md)：对照 Windows 直接硬解和 Mac video 消费者，核对 DMA-BUF、CPU 复制及轮询成本；已记录 Linux 设备上的执行顺序、采样口径与验证要求，实际优化待执行。
- [macOS CPU Canvas 与 video 对照](macos-cpu-video-comparison-2026-10-26.md)：真实软件宿主的配对采样、内存转移、禁用 GPU 与故障接管检查；总体 CPU 接近；后续正式接入见 [Mac CPU video 记录](../reviews/macos-cpu-video-integration-2026-10-26.md)。
- [macOS video 消费者接入](../reviews/macos-video-consumer-integration-2026-10-26.md)：Electron 44.9.3、Mac GPU video／CPU Canvas、正常应用测试与钥匙串隔离边界。
- [macOS 视频合成消费原型验证](macos-video-consumer-prototype-2026-10-26.md)：接入前的独立 Electron 44.9.3 原型、43.8.1 崩溃前置条件及短时 CPU 配对；这些测量不冒充正常应用性能对照。
- [macOS 内置播放拷贝核查与优化方向](macos-playback-optimization-plan.md)：基于 `7e522df2` 的源码核查，区分 IOSurface 引用共享、缓存复制、绘制和 CPU 读回；后续实测见原型记录。

## 剩余范围

[优化计划的完整待办矩阵](large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)统一列出已实现和保留工作，[读查询隔离清单](large-library-read-worker-plan.md)保留原生终止、WAL、端到端与目标平台限制。这些材料不是自动继续执行的授权；后续应先对照最新代码重新确认缺口，不照抄旧批次顺序。

## 实施与测量

- [实施记录](large-library-implementation-status.md)按批次追溯实际修改；[高频查询与扫描收尾](large-library-high-frequency-cleanup-results.md)记录 DF 范围。
- [主审计](large-library-performance-audit.md)、[后台审计](large-library-background-audit.md)、[UI 审计](large-library-ui-audit.md)保留发现的原始上下文，不因后续局部改动而追溯改写数字。
- [连续浏览](desktop-continuous-browsing.md)等专项报告说明相应功能及其测量边界。
- [原始结果与复跑](large-library-results/README.md)保存合成夹具、JSON、批次 review 和 manifest。原始数据、失败记录及基准脚本不随计划清理删除，也不将一次本机 SQL 测量推广为全部平台表现。
