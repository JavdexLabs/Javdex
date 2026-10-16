---
title: 版本与升级
description: 区分文档适用版本、实际正式下载与历史发布记录。
---

本站正文面向 0.9.0-beta.7。实际最新正式版以[下载中心](/Javdex/download/)和 GitHub Release 为准；版本号已写入源码不代表安装包、镜像和升级文件已经发布。

Beta.7 是预发布，手动下载见[对应 Release](https://github.com/JavdexLabs/Javdex/releases/tag/v0.9.0-beta.7)，以页面实际状态为准。最新正式版仍是 0.8.0。Beta.1–5 采用本版运行环境兼容检查须更换 Beta.6 基础镜像，保留数据、图片与 `/program`；单独业务升级文件不能更新管理器。升级不自动备份或回退资料，schema 21 的回退须恢复升级前完整备份。

## 升级入口

- [0.8.0 → 0.9.0-beta.7 升级指南](/Javdex/releases/upgrade/)
- [服务端首次采用托管更新](/Javdex/server/adoption/)
- [服务端后续升级与配对](/Javdex/server/pairing/)
- [停服安装与恢复边界](/Javdex/server/recovery/)

## 版本记录

完整[更新日志](https://github.com/JavdexLabs/Javdex/blob/main/CHANGELOG.md)和 [0.9.0-beta.7 发布说明](https://github.com/JavdexLabs/Javdex/blob/main/.github/release-notes/v0.9.0-beta.7.md)在仓库单独维护。已发布文件见 [GitHub Releases](https://github.com/JavdexLabs/Javdex/releases)。

下载默认只跟随正式版，不把预发布当作最新稳定版。不要用旧程序打开升级后的数据库；回退须恢复升级前完整备份及对应旧程序。
