# 工程文档索引

公开使用说明以 [文档站源码](../website/src/content/docs) 为唯一正文来源；本目录维护开发合同、架构决策和验证记录。产品变化见 [CHANGELOG](../CHANGELOG.md)，领域术语见 [CONTEXT](../CONTEXT.md)。

## 当前开发合同

| 工作内容 | 入口 |
| --- | --- |
| 本地启动、测试与打包 | [开发指南](DEVELOPMENT.md) |
| 版本、签名与发布 | [发布规范](VERSIONING_AND_RELEASE.md) |
| UI 与交互 | [设计规范](UI_DESIGN_GUIDELINES.md)、[组件契约](UI_COMPONENT_CONTRACTS.md)、[路由与共享返回](ROUTING_DESIGN.md) |
| 资料与媒体库 | [多媒体库设计](MULTI_LIBRARY_DESIGN.md)、[领域上下文](../CONTEXT.md) |
| 服务端与远程桌面 | [当前状态](SERVER_MODE_NEXT_STEPS.md)、[实现与合同](SERVER_MODE_CONTRACT_INVENTORY.md) |
| 内置播放与本地 AI | [内置播放](BUILTIN_PLAYBACK.md)、[Linux 兼容播放与改进计划](LINUX_COMPATIBLE_PLAYBACK.md)、[AI 字幕与本地推理](AI_SUBTITLES_IMPLEMENTATION.md)、[智能头像构图](SMART_AVATAR_CROP.md) |
| 刮削与 Agent | [插件格式](SCRAPER_PLUGIN_FORMAT.md)、[影片更新语义](VIDEO_SCRAPE_UPDATES.md)、[插件开发 Agent](PLUGIN_DEV_AGENT.md)、[外部清单导入](PLAYLIST_IMPORT.md) |
| 网页与文档站 | [局域网 Web](LAN_WEB.md)、[移动端规范](MOBILE_WEB_GUIDELINES.md)、[网站维护](../website/README.md) |
| 模型与第三方来源 | [云端模型目录](CLOUD_MODEL_CATALOG.md)、[第三方声明](THIRD_PARTY_NOTICES.md)、[来源依据](references/README.md) |
| Issue 与领域文档约定 | [Issue](agents/issue-tracker.md)、[标签](agents/triage-labels.md)、[领域文档](agents/domain.md) |

## 决策与证据

- [ADR](adr) 保存架构选择及其理由；现行实现以相应合同和代码为准。
- [三平台播放统一与接续方案](adr/0033-unify-desktop-playback-capabilities.md)已确认目标，等待 Mac CPU 播放开发完成并推送；本机先整合最新实现，再启动统一改造。
- [发布与评审记录](reviews/README.md) 保存原始发布、0.9.0 整套替换、回归及来源证据，不将历史通过次数当作新版本结论。
- [性能工作索引](performance/README.md) 区分已实施批次、原始基准与仍未完成的工作；不能因文档清理关闭未验证项。
- [服务端历史](archive/server-mode/README.md)、[本地 AI 历史](archive/local-ai/implementation-and-validation-2026-10.md)及[播放平台历史](archive/playback/platform-validation-2026-10.md)只用于追溯，不是当前操作步骤。

## 维护规则

功能落地后，将仍有效的行为与约束并入对应合同或用户指南，删除重复的选型、执行步骤和完成清单；原文由 Git 历史保留。未完成的计划须明确剩余范围，不能批量改成“已完成”。

许可和固定来源、真实验收、失败及性能原始结果继续保留，并注明日期、源码和平台。公开文档、工程合同、ADR 与历史证据各自维护，不复制第二套产品说明；历史文档中的旧命令不构成继续执行、发布或覆盖资产的授权。
