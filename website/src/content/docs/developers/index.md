---
title: 开发与扩展
description: 从仓库开发入口开始；文档站构建不依赖 Electron。
---

Javdex 使用 npm workspaces。桌面应用、局域网 Web、服务端和共享模块在同一个仓库；文档站是独立的 `@javdex/website` 工作区。

## 从源码开发

环境、启动、数据库迁移与完整构建命令以仓库的 [DEVELOPMENT.md](https://github.com/JavdexLabs/Javdex/blob/main/docs/DEVELOPMENT.md) 为准。按任务选择构建，不要为仅运行服务端或文档站重建 Electron 原生依赖。

- [服务端源码构建与配置](/Javdex/developers/server/)
- [刮削插件开发](/Javdex/developers/plugins/)
- [发布与签名验证](/Javdex/developers/releases/)
- [网站开发与内容维护](https://github.com/JavdexLabs/Javdex/blob/main/website/README.md)

## 贡献之前

先阅读仓库 [AGENTS.md](https://github.com/JavdexLabs/Javdex/blob/main/AGENTS.md) 与对应模块合同。报告问题时提供复现步骤、系统和版本，提交日志前移除令牌与私人路径。

性能记录、架构决策和评审结果保留在仓库；自动化通过并不等于完整平台 GUI、硬解或生产部署验收通过。
