---
status: accepted
---

# Shared 刮削类型分区与类型卫生

## Context

`packages/contracts/src/scrapeTypes.ts` 曾聚合影片刮削、演员刮削、插件包描述符与头像 auto-crop IPC 形状，并被数十处跨层 importer 依赖。同时存在若干错位类型（如 `ActressDetail` 落在 library、`TagListItem` 挂在 app IPC）与平行状态词表（列表筛选 vs 批量刮削状态）。

## Decision

1. **刮削类型分区**（窄 import 优先，barrel 兼容）：
   - `videoScrapeTypes` — 影片结果、字段、批量/重匹配
   - `actressScrapeTypes` — 演员结果、字段、批量、disposition/impact
   - `scraperPluginTypes` — kind/source/delay/descriptor/package/composite
   - `actressAvatarCropTypes` — auto-crop request/response
   - `scrapeTypes` — 薄 re-export，供跨域或过渡调用

2. **依赖方向**：plugin 可依赖 video/actress 的 field 联合；crop 不依赖 plugin；conflict 只依赖 actress scrape 类型。避免 actress scrape ↔ plugin 的类型环（`ActressScrapePluginRef.source` 使用与 `ScraperPluginSource` 结构兼容的字面量联合）。

3. **实体归位**：`ActressDetail` 属于 `actressTypes`；`TagListItem` 与 `SortDir` 属于 `commonTypes`。

4. **演员累计刮削状态词表**：`ActressScrapeStatusFilter` 为权威 id 集合；`ActressListStatusFilter` 与 `ActressBatchScrapeStatus` 均为其别名。三态中文标签以 `ACTRESS_SCRAPE_STATUS_LABELS` 为单一来源；列表的「全部状态」与批量的「全部」保留各自 all 文案。不改变影片 numeric `ScrapedStatus` 或 rematch 词表。

5. **字段中文标签**：UI/声明字段以 `VIDEO_SCRAPE_FIELD_OPTIONS` / `ACTRESS_SCRAPE_FIELD_OPTIONS` 为准；`scrapeFieldPromptDocs` 的短标签从 OPTIONS 派生，仅保留返回键别名与 agent 长文案。

## Consequences

- 单域调用方可只依赖对应分区文件，降低 IDE/review 噪声。
- 跨域模块（IPC 契约、Settings、plugin-dev）可显式多 import 或继续使用 barrel。
- 序列化载荷与 IPC channel 不变；本 ADR 只约束 TypeScript 模块边界与标签来源。
