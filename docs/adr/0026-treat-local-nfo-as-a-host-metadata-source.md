---
status: accepted
---

# 将本地 NFO 作为主进程影片元数据来源

Javdex 通过统一 `VideoMetadataSource` 接口承载网络刮削与本地 NFO，但本地 NFO 是拥有受控文件能力的主进程内置 Adapter，而不是获得本地文件权限的普通 `.avscraper` 插件，也不是 scanner 中的 XML 特判。来源只生成候选与临时证据，最终仍由既有待确认和字段应用流程决定；NFO 导入与导出都是一次性文件交换，不持久保存 NFO 关联或同步状态。这样增加了一个来源 seam 和受控本地资产交割层，但把路径安全、候选歧义、字段应用与未来扩展保持在可测试的单一边界内。

网络插件由 `WebScraperSourceAdapter` 保持现有 descriptor、代理、延迟、精确番号过滤、候选与浏览器生命周期语义；`VideoMetadataCandidateStager` 只接收显式的远程 URL 或主进程能力票据，并通过 `MediaAssetStore` 完成唯一候选交割和待确认暂存。renderer、共享 IPC 类型与普通插件都不能导入这些主进程实现，也不能取得本地绝对路径。
