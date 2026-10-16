---
title: "数据保存在哪里"
description: "Javdex 0.9.0-beta.7 · 数据保存在哪里"
---

应用使用系统的 Javdex 用户数据目录，与安装目录分开。默认目录结构如下，`userData` 表示实际应用数据目录，并非需要手动创建的文件夹：

```text
userData/
  desktop-work.db              # 此电脑的 Agent 运行记录、候选草稿和恢复状态
  data/library.db              # 影片、演员等资料数据库
  settings.json                # 应用设置
  this-computer.json           # 此电脑的连接、播放方式、音量与续播选项
  recent-playback.json         # 此电脑按资料库隔离的最近播放历史
  playback-progress.json       # 此电脑的内置播放续播位置
  local-models.json            # 本地模型保存位置、下载来源与用途选择
  scraper-service-secrets.json  # 刮削服务凭证
  local-ai/                    # 模型与共享运行依赖，标准 Windows 安装另存于 LOCALAPPDATA
  cache/                      # AI 字幕缓存和任务临时文件
  media_assets/                # 默认图片目录，可在应用中迁移
    covers/
    avatars/
    actress_gallery/
    samples/
    playlist_covers/
```

`desktop-work.db` 自 0.8.0 起独立保存 Agent 状态；尚未完成旧资料拆分的桌面首次启动时，会将原 `library.db` 中的 Agent 状态单向复制到工作库。只使用本机资料库的安装也执行此步骤，之后的运行记录与草稿不会复制回 `library.db`。只保存 `library.db` 或应用内资料库备份，会漏掉这些工作记录；不能把它们当作完整桌面备份。

这只是主要文件示意，应用还会保存插件、云端模型配置和任务数据等文件。需要手动备份时，先完全退出应用，再保存整个用户数据目录、自定义图片目录及实际本地模型目录；标准 Windows 安装的模型与推理缓存位于 `%LOCALAPPDATA%\Javdex`，也须单独考虑。备份中应同时包含 `desktop-work.db` 与 `data/library.db`，原始视频另行保存。系统保护的服务凭证迁移后可能需要重新配置。

联网刮削、AI、更新检查和打开外部链接会访问各自的服务；本地保存资料不意味着所有功能都离线执行。
