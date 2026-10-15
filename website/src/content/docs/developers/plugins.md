---
title: 刮削插件开发
description: 插件产物规范与应用内开发助手使用不同文档合同。
---

## 先区分两个入口

- 编写或导入刮削插件：阅读仓库的 [SCRAPER_PLUGIN_FORMAT.md](https://github.com/JavdexLabs/Javdex/blob/main/docs/SCRAPER_PLUGIN_FORMAT.md)，按插件包格式、字段能力和沙箱 `ctx` 合同实现。
- 使用应用内插件开发助手、MCP 或开发工作区：阅读 [PLUGIN_DEV_AGENT.md](https://github.com/JavdexLabs/Javdex/blob/main/docs/PLUGIN_DEV_AGENT.md)。它描述开发流程，不替代插件产物规范。

规范正文在仓库单独维护，本站不复制第二份接口定义。不要把桌面主进程权限、任意文件访问或服务端写库能力当作插件沙箱能力。

## 在应用中使用

普通插件配置和组合来源见[刮削指南](/Javdex/guide/scraping/)；MetaTube 是独立的服务连接，配置见 [MetaTube](/Javdex/reference/metatube/)。开发助手使用云端模型用途，不由本地字幕模型自动提供能力。
