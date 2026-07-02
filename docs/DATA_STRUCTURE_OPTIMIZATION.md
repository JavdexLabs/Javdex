# Data Structure Optimization Notes

本文档用于先沉淀数据结构现状、优化诉求和执行方案。代码优化只有在本文档完善并确认后再开始执行。

## Collaboration Rules

- 先记录，后改代码。
- 每一轮新增需求先落到本文档的 `Requirement Backlog` 或 `Decisions`。
- 数据迁移、字段重命名、拆表、索引调整都需要在 `Execution Plan` 中明确影响范围。
- 执行代码优化前，需要先确认：
  - 目标 schema。
  - 迁移策略。
  - 兼容旧库数据的方式。
  - 需要调整的 repo、service、IPC、renderer 查询类型。

## Current Storage Overview

当前项目使用两类本地存储：

- SQLite：媒体库主体数据、元数据、演员、标签、分类维度和关系表。
- JSON 文件：应用配置，路径为 `app.getPath('userData')/settings.json`。

SQLite 初始化入口：

- `src/main/db/database.ts`
- `src/main/db/schema.ts`
- `src/main/db/migrations.ts`

当前数据库版本：

- `PRAGMA user_version = 3`

## Current Tables

### videos

中心视频表，保存文件路径、番号、刮削元数据和列表筛选字段。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | No | auto | Primary key, autoincrement |
| `code` | `TEXT` | No | - | Unique video code / 番号 |
| `title` | `TEXT` | Yes | `NULL` | Scraped or manually edited title |
| `summary` | `TEXT` | Yes | `NULL` | Synopsis |
| `file_path` | `TEXT` | No | - | Absolute local video file path |
| `file_size` | `INTEGER` | Yes | `NULL` | File size in bytes |
| `cover_path` | `TEXT` | Yes | `NULL` | Relative asset path for cover |
| `rating` | `INTEGER` | No | `0` | User rating, currently clamped in repo to 0-5 |
| `release_date` | `TEXT` | Yes | `NULL` | Release date string |
| `studio` | `TEXT` | Yes | `NULL` | Studio facet value |
| `series` | `TEXT` | Yes | `NULL` | Series facet value |
| `director` | `TEXT` | Yes | `NULL` | Director facet value |
| `scraped_status` | `INTEGER` | No | `0` | `0` = unscraped, `1` = scraped, `2` = failed |
| `add_time` | `DATETIME` | No | `CURRENT_TIMESTAMP` | Import time |

Indexes:

- `idx_videos_code` on `videos(code)`
- `idx_videos_file_path` unique on `videos(file_path)`
- `idx_videos_add_time` on `videos(add_time)`
- `idx_videos_release_date` on `videos(release_date)`
- `idx_videos_rating` on `videos(rating)`
- `idx_videos_scraped_status` on `videos(scraped_status)`
- `idx_videos_studio` on `videos(studio)`
- `idx_videos_series` on `videos(series)`
- `idx_videos_director` on `videos(director)`

### actresses

演员主体表。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | No | auto | Primary key, autoincrement |
| `main_name` | `TEXT` | No | - | Unique canonical actress name |
| `avatar_path` | `TEXT` | Yes | `NULL` | Relative asset path for avatar |
| `birthday` | `TEXT` | Yes | `NULL` | Birthday string |
| `measurements` | `TEXT` | Yes | `NULL` | Measurements text |
| `gender` | `TEXT` | Yes | `NULL` | Check constraint: `female` or `male` |

Unique constraints:

- `main_name` is unique.

### actress_aliases

演员别名表。一个演员可以有多个别名，别名全局唯一。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | No | auto | Primary key, autoincrement |
| `actress_id` | `INTEGER` | No | - | References `actresses(id)` |
| `alias_name` | `TEXT` | No | - | Unique alias |

Foreign keys:

- `actress_id` -> `actresses(id)` with `ON DELETE CASCADE`

Indexes:

- `idx_aliases_name` on `actress_aliases(alias_name)`

### video_actress

视频和演员的多对多关系表。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `video_id` | `INTEGER` | No | - | References `videos(id)` |
| `actress_id` | `INTEGER` | No | - | References `actresses(id)` |

Primary key:

- Composite primary key: (`video_id`, `actress_id`)

Foreign keys:

- `video_id` -> `videos(id)` with `ON DELETE CASCADE`
- `actress_id` -> `actresses(id)` with `ON DELETE CASCADE`

Indexes:

- `idx_video_actress_actress_id` on `video_actress(actress_id)`

### tags

标签表。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | No | auto | Primary key, autoincrement |
| `name` | `TEXT` | No | - | Unique tag name |

Unique constraints:

- `name` is unique.

### video_tag

视频和标签的多对多关系表。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `video_id` | `INTEGER` | No | - | References `videos(id)` |
| `tag_id` | `INTEGER` | No | - | References `tags(id)` |

Primary key:

- Composite primary key: (`video_id`, `tag_id`)

Foreign keys:

- `video_id` -> `videos(id)` with `ON DELETE CASCADE`
- `tag_id` -> `tags(id)` with `ON DELETE CASCADE`

Indexes:

- `idx_video_tag_tag_id` on `video_tag(tag_id)`

### facet_entries

片商、系列、导演的注册表。它让分类值在没有任何视频引用时仍可出现在管理入口中，方便手动删除。

| Field | Type | Nullable | Default | Constraint / Meaning |
| --- | --- | --- | --- | --- |
| `type` | `TEXT` | No | - | Check constraint: `studio`, `series`, or `director` |
| `value` | `TEXT` | No | - | Facet display value |

Primary key:

- Composite primary key: (`type`, `value`)

## Current Relationships

```text
videos.id
  ├─< video_actress.video_id >─ actresses.id
  │                              └─< actress_aliases.actress_id
  └─< video_tag.video_id     >─ tags.id

videos.studio   -> facet_entries(type = 'studio', value)
videos.series   -> facet_entries(type = 'series', value)
videos.director -> facet_entries(type = 'director', value)
```

Notes:

- `video_actress` and `video_tag` use composite primary keys to prevent duplicate relations.
- Deleting a video cascades its actress/tag relation rows.
- Deleting an actress cascades aliases and video relation rows at the database level, but application logic currently prevents deleting actresses that still have linked videos.
- Deleting a tag would cascade `video_tag` rows if tag deletion is introduced later.
- `facet_entries` is not enforced by a foreign key; it is a registry maintained by application logic.

## Current Non-SQLite Data

### settings.json

Stored under `app.getPath('userData')/settings.json`.

| Field | Type | Meaning |
| --- | --- | --- |
| `libraryPaths` | `string[]` | Library folders to scan |
| `proxyUrl` | `string` | Optional HTTP/HTTPS proxy |
| `defaultScraper` | `string` | Default video scraper plugin |
| `defaultActressScraper` | `string` | Default actress scraper plugin |
| `batchDelayMinMs` | `number` | Min delay for batch scraping |
| `batchDelayMaxMs` | `number` | Max delay for batch scraping |
| `theme` | `graphite \| warm \| slate \| light` | UI theme |
| `assetEncryption` | `boolean` | Whether cover/avatar assets are encrypted on disk |

### File Assets

The database stores relative asset paths only:

- `videos.cover_path`
- `actresses.avatar_path`

Actual cover/avatar files are managed by asset services on disk.

## Current Query Shapes

### Video list query

Backed by `VideoQuery`:

| Parameter | Meaning |
| --- | --- |
| `search` | Search code, title, or actress main name |
| `scrapedStatus` | `0`, `1`, `2`, or `all` |
| `minRating` | Minimum rating |
| `year` | Release year or `all` |
| `actressId` | Filter by linked actress |
| `tagId` | Filter by single tag |
| `tagIds` | Multi-tag AND filter |
| `studio` | Exact studio value |
| `series` | Exact series value |
| `director` | Exact director value |
| `codePrefix` | Prefix match such as `MUKD-` |
| `sortBy` | `add_time`, `release_date`, `rating`, or `code` |
| `sortDir` | `asc` or `desc` |
| `limit` | Page size |
| `offset` | Offset pagination position |

### Video detail

`VideoDetail` is composed from:

- one `videos` row
- linked `actresses`
- linked `tags`

### Actress detail

`ActressDetail` is composed from:

- one `actresses` row
- aliases from `actress_aliases`
- linked videos through `video_actress`

## Current Data Lifecycle

### Import / Scan

- Scanner parses a video code from filename.
- New files insert into `videos` with `scraped_status = 0`.
- If a code already exists at a different path, service logic can relocate or merge records.
- If a known file path disappears or leaves configured library paths, scan logic can purge stale records.

### Scrape

- Video scrape updates scalar fields on `videos`.
- Actress names are upserted into `actresses`.
- Tags are upserted into `tags`.
- Relations are replaced in `video_actress` and `video_tag`.
- `studio`, `series`, `director` are also registered into `facet_entries`.
- On success, `scraped_status` becomes `1`; failures become `2`.

### Manual Edit

- Video scalar metadata can be edited.
- Tags and actresses, when supplied, replace existing relations.
- Actress profile fields and aliases can be edited.
- Cover/avatar file changes update only relative asset paths in SQLite.

## Known Design Characteristics

- The current model is normalized for actors and tags.
- Studio, series, and director are currently denormalized columns on `videos`, with a separate lightweight registry table.
- Date fields are stored as `TEXT`, not strict date types.
- Status fields are integers without database-level check constraints.
- Rating is clamped in application code, not by a database check constraint.
- Search currently relies on `LIKE` and relational subqueries, not FTS.
- Video pagination currently uses `limit` + `offset`.
- Asset storage is path-based, not blob-based.

## Reference Detail Page Field Gaps

The two reference AV detail pages expose several metadata groups that the current structure only partially supports.

### Already Covered

| Reference field | Current structure | Notes |
| --- | --- | --- |
| Code / identifier | `videos.code` | Covered. |
| Title | `videos.title` | Covered. |
| Release date | `videos.release_date` | Covered, but stored as free `TEXT`. |
| Director | `videos.director` | Covered as denormalized text. |
| Series | `videos.series` | Covered as denormalized text. |
| Categories / genres | `tags` + `video_tag` | Covered as generic tags. |
| Actresses | `actresses` + `video_actress` | Covered. |
| Cover | `videos.cover_path` | Covered for primary cover only. |
| User local rating | `videos.rating` | Covered as private local rating only. |

### Missing Or Under-modeled

| Reference field | Suggested data shape | Suggested location | Why |
| --- | --- | --- | --- |
| Duration / length | `duration_minutes INTEGER` or `duration_seconds INTEGER` | `videos` | Stable core video metadata; useful for filtering and display. Prefer seconds for precision, minutes for simpler AV metadata. |
| Maker / producer / 制作商 | `maker TEXT` | `videos` | User decided maker/片商 are the same concept and should remain a text field on `videos`. |
| Publisher / 发行商 | `publisher TEXT` | `videos` | User decided to keep publisher as a separate text field on `videos`. |
| External site URL | `source_url TEXT` or relation row | Prefer `video_external_ids` table | A video can appear on multiple scraper sites. |
| External site code/id | `source`, `external_id`, `external_code` | Prefer `video_external_ids` table | Needed to dedupe and re-scrape reliably across JavDB/JavLibrary/etc. |
| Site average rating | `rating_average REAL` | Prefer `video_external_stats` table | Different from private `videos.rating`; source-specific and changes over time. |
| Site rating count | `rating_count INTEGER` | Prefer `video_external_stats` table | Same reason as above. |
| Want count / 想看 | Do not store | Dropped | User decided not to keep source popularity counters. |
| Watched count / 看过 | Do not store | Dropped | User decided not to keep source popularity counters. |
| Owned count / 已拥有 / 存入清单 | Do not store | Dropped | User decided not to keep source popularity counters. |
| Trailer / preview video | `asset_type = trailer` or `trailer_url` | Prefer media asset table | Can be remote URL or local cached asset; not a scalar video field long-term. |
| Sample images / screenshots | ordered asset rows | Prefer media asset table | Multiple images, ordering, remote URL, local path, cache status. |
| Full-size package image variants | ordered asset rows with role | Prefer media asset table | Cover, poster, fanart, gallery images should be distinguishable. |
| Original scraped title | `original_title TEXT` | `videos` or scrape snapshot | Useful if local title is manually edited. |
| Normalized/search title | generated/search table | FTS/search layer | Useful for search, but not necessarily a hand-edited field. |
| Runtime scrape timestamp | `last_scraped_at TEXT` | `videos` or scrape history | Needed to know data freshness. |
| Source language/site | `source`, `locale` | External mapping/scrape history | Helps when multiple scrapers disagree. |

### Recommended Direct Additions To `videos`

These fields are stable enough to live on the main `videos` row:

| Field | Type | Reason |
| --- | --- | --- |
| `duration_seconds` | `INTEGER` nullable | Core detail-page metadata and useful for filtering/sorting. |
| `original_title` | `TEXT` nullable | Preserve scraped/original title separately from user-edited display title. |
| `maker` | `TEXT` nullable | Maker/片商 as text on the main video row. |
| `publisher` | `TEXT` nullable | Publisher/发行商 as text on the main video row. |
| `last_scraped_at` | `TEXT` nullable | Track freshness of current metadata. |
| `updated_at` | `TEXT` nullable | Useful once manual edits and migrations grow. |

Fields to consider, but not yet decided:

| Field | Type | Question |
| --- | --- | --- |
| `content_id` | `TEXT` nullable | Some sites have product IDs distinct from display code; do we need both? |

### Recommended Separate Tables

These should probably not be added directly to `videos`.

#### `video_external_ids`

Maps one local video to one or more scraper/source records.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key |
| `video_id` | `INTEGER` | References `videos(id)` |
| `source` | `TEXT` | Scraper/site name, e.g. `javdb`, `javlibrary` |
| `external_id` | `TEXT` | Site-specific id if available |
| `external_code` | `TEXT` | Site-specific code/display id |
| `url` | `TEXT` | Detail page URL |
| `title` | `TEXT` | Source title snapshot |
| `fetched_at` | `TEXT` | Last fetch time for this source row |

Suggested unique key:

- (`source`, `external_id`) when `external_id` exists.
- Fallback unique key may be (`source`, `external_code`, `url`) depending on scraper quality.

#### `video_external_stats`

Stores source-specific public rating snapshots only. Source popularity counters such as want/watched/owned are intentionally not stored.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key |
| `video_id` | `INTEGER` | References `videos(id)` |
| `source` | `TEXT` | Scraper/site name |
| `rating_average` | `REAL` | Public average score from source |
| `rating_count` | `INTEGER` | Number of public ratings |
| `fetched_at` | `TEXT` | Stats fetch time |

#### `video_assets`

Stores trailer, gallery screenshots, covers and other media assets.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key |
| `video_id` | `INTEGER` | References `videos(id)` |
| `type` | `TEXT` | `cover`, `poster`, `sample`, `trailer`, etc. |
| `position` | `INTEGER` | Display order |
| `remote_url` | `TEXT` | Original source URL |
| `local_path` | `TEXT` | Cached relative asset path |
| `width` | `INTEGER` | Optional image/video width |
| `height` | `INTEGER` | Optional image/video height |
| `duration_seconds` | `INTEGER` | Optional trailer duration |
| `is_primary` | `INTEGER` | Whether this is the primary asset of its type |
| `created_at` | `TEXT` | Import/cache time |

`videos.cover_path` can remain as a fast primary-cover shortcut, or later be replaced by `video_assets(type = 'cover', is_primary = 1)`.

## Reference Actress Profile Field Gaps

The reference actress profile page exposes identity, profile, tags, gallery and similarity data. The current `actresses` model only covers a small subset.

### Already Covered

| Reference field | Current structure | Notes |
| --- | --- | --- |
| Main name | `actresses.main_name` | Covered, but currently a single canonical text field. |
| Aliases | `actress_aliases.alias_name` | Covered as plain aliases, without language/type/source metadata. |
| Avatar | `actresses.avatar_path` | Covered for one primary avatar only. |
| Birthday | `actresses.birthday` | Covered, but stored as free `TEXT`. |
| Measurements | `actresses.measurements` | Covered only as a combined text value. |
| Gender | `actresses.gender` | Covered. |
| Linked videos | `video_actress` | Covered. |

### Missing Or Under-modeled

| Reference field | Suggested data shape | Suggested location | Why |
| --- | --- | --- | --- |
| Display name with age | computed from name + birthday | Do not store age | Age changes over time; compute from `birth_date`. |
| Japanese/native name | typed name row or scalar | Prefer `actress_names` table | One actress may have native, romanized, English, Chinese and former names. |
| Romanized name | typed name row or scalar | Prefer `actress_names` table | Current aliases cannot distinguish language/type. |
| Former/stage names | typed name rows | Prefer improved alias/name table | Needed to avoid duplicate identities. |
| Profile tags | `actress_tags` + relation table | Separate tables | Tags like ranking/rising/classic/persona are many-to-many and may be source-specific. |
| Debut date | `debut_date TEXT` | `actresses` | Stable one-person metadata; useful for filtering. |
| Zodiac | `zodiac TEXT` | Consider `actresses` | Can be derived from birthday, but source pages expose it as display metadata. |
| Blood type | `blood_type TEXT` | `actresses` | Stable profile metadata. |
| Height | `height_cm INTEGER` | `actresses` | Structured field is better than embedding in `measurements`. |
| Bust / waist / hip | `bust_cm`, `waist_cm`, `hip_cm` | `actresses` | Enables filtering/sorting and normalized display. |
| Cup size | `cup_size TEXT` | `actresses` | Common profile metadata, not covered by current combined measurements. |
| Nationality | `nationality TEXT` or country code | `actresses` | Stable profile metadata. |
| Profile summary / bio | `profile_summary TEXT` | `actresses` | Current model has no actress biography field. |
| Gallery/profile photos | ordered asset rows | Prefer `actress_gallery_assets` | Multiple images do not fit in one avatar field; keep separate from avatar. |
| Similar actresses | Do not store | Dropped | User decided not to keep similar actress relations. |
| External profile URL/id | Do not add new storage | Dropped | User decided external IDs/source mapping for actresses should keep current behavior. |
| Source scrape timestamp | `last_scraped_at` or source row timestamp | `actresses` plus source table | Needed to track freshness. |

### Recommended Direct Additions To `actresses`

These fields are stable enough to live on the main `actresses` row:

| Field | Type | Reason |
| --- | --- | --- |
| `birth_date` | `TEXT` nullable | Prefer normalized ISO date naming over `birthday`; age should be computed. |
| `debut_date` | `TEXT` nullable | Stable profile metadata from reference pages. |
| `height_cm` | `INTEGER` nullable | Structured body profile field. |
| `bust_cm` | `INTEGER` nullable | Structured body profile field. |
| `waist_cm` | `INTEGER` nullable | Structured body profile field. |
| `hip_cm` | `INTEGER` nullable | Structured body profile field. |
| `cup_size` | `TEXT` nullable | Common profile metadata. |
| `blood_type` | `TEXT` nullable | Common profile metadata. |
| `nationality` | `TEXT` nullable | Common profile metadata. |
| `profile_summary` | `TEXT` nullable | Actress biography/description. |
| `last_scraped_at` | `TEXT` nullable | Track metadata freshness. |
| `updated_at` | `TEXT` nullable | Track local edits/migrations. |

Compatibility note:

- Existing `birthday` can be migrated toward `birth_date`.
- Existing `measurements` is only a legacy migration source. The target schema should not keep measurements as one combined string; use structured numeric fields instead.
- Do not store `age`; calculate it from `birth_date` at render time.

Fields to consider, but not yet decided:

| Field | Type | Question |
| --- | --- | --- |
| `zodiac` | `TEXT` nullable | Store source text or derive from birth date? |
| `name_native` / `name_romaji` | `TEXT` nullable | Easier UI, but less flexible than `actress_names`. |
| `status` | `TEXT` nullable | Do we need active/retired/unknown? |
| `country_code` | `TEXT` nullable | Better than free-text nationality if filtering matters. |

### Recommended Separate Actress Tables

#### `actress_names`

Replaces or extends simple aliases with typed, source-aware names.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key |
| `actress_id` | `INTEGER` | References `actresses(id)` |
| `name` | `TEXT` | Name value |
| `type` | `TEXT` | `main`, `alias`, `former`, `native`, `romaji`, `english`, etc. |
| `locale` | `TEXT` | Optional locale such as `ja`, `en`, `zh` |
| `source` | `TEXT` | Optional scraper/source name |
| `is_primary` | `INTEGER` | Whether this is the preferred display name for that type/locale |

Potential migration:

- `actresses.main_name` can stay as the fast display name.
- Existing `actress_aliases` rows can be copied into `actress_names(type = 'alias')`.
- `actress_aliases` can be kept for compatibility or retired after repo/UI migration.

#### `actress_tags`

Stores tag definitions used for actress profile labels.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key |
| `name` | `TEXT` | Tag text |
| `source` | `TEXT` | Optional source/site |
| `category` | `TEXT` | Optional category such as `ranking`, `style`, `status` |

#### `actress_tag`

Many-to-many relation between actresses and profile tags.

| Field | Type | Meaning |
| --- | --- | --- |
| `actress_id` | `INTEGER` | References `actresses(id)` |
| `tag_id` | `INTEGER` | References `actress_tags(id)` |

Suggested primary key:

- (`actress_id`, `tag_id`)

#### `actress_gallery_assets`

Stores actress gallery/profile photos only. Avatar remains separate via `actresses.avatar_path` and optional avatar source metadata.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key |
| `actress_id` | `INTEGER` | References `actresses(id)` |
| `type` | `TEXT` | `profile`, `gallery`, etc.; not `avatar` |
| `position` | `INTEGER` | Display order |
| `remote_url` | `TEXT` | Original source URL |
| `local_path` | `TEXT` | Cached relative asset path |
| `width` | `INTEGER` | Optional image width |
| `height` | `INTEGER` | Optional image height |
| `created_at` | `TEXT` | Import/cache time |

Avatar storage decision:

- Keep primary avatar as `actresses.avatar_path`.
- If avatar source tracking is needed, add avatar-specific fields/table separately; do not mix avatar rows with gallery rows.
- Do not create `actress_relations`; similar/related actress sections are out of scope.

#### `actress_external_ids` Dropped

Do not add this table. The user decided external IDs/source mappings for actresses, maker, publisher, series and director should keep current behavior.

If future scraper work needs source hints, revisit this as a separate requirement instead of adding it in the current schema optimization pass.

## Pruning Inventory

本节列出“目前可能要存的全部信息项”，用于后续精简。这里不是最终 schema，先作为取舍清单。

Decision status:

- `Keep`: 确认保留。
- `Drop`: 确认不存。
- `Later`: 暂缓，不进入第一轮 schema。
- `TBD`: 待决定。

### Video Core

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 本地视频 ID | `videos.id` | `videos` | Keep | 内部主键。 |
| 番号 / 识别码 | `videos.code` | `videos` | Keep | 核心字段，唯一。 |
| 当前显示标题 | `videos.title` | `videos` | Keep | 可由刮削或手动编辑。 |
| 原始刮削标题 | `videos.original_title` | `videos` | Keep | 用于保留来源标题，避免手动改名后丢失。 |
| 简介 | `videos.summary` | `videos` | Keep | 详情页展示字段，可较长。 |
| 发行日期 | `videos.release_date` | `videos` | Keep | 建议后续统一 ISO 日期。 |
| 时长 | `videos.duration_seconds` | `videos` | Keep | 参考页都有，建议保留。 |
| 本地评分 | `videos.rating` | `videos` | Keep | 私有评分，不等于站点评分。 |
| 刮削状态 | `videos.scraped_status` | `videos` | Keep | 未刮削/成功/失败。 |
| 导入时间 | `videos.add_time` | `videos` | Keep | 当前已有。 |
| 更新时间 | `videos.updated_at` | `videos` | Keep | 本地编辑、迁移、重刮削后更新。 |
| 最后刮削时间 | `videos.last_scraped_at` | `videos` | Keep | 判断元数据新鲜度。 |

### Video File

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 视频文件路径 | `videos.file_path` | `videos` | Keep | 当前唯一。 |
| 视频文件大小 | `videos.file_size` | `videos` | Keep | 当前已有。 |
| 文件最后发现时间 | `last_seen_at` | `videos` or file table | TBD | 扫描清理、移动检测更可靠。 |
| 文件 hash | `file_hash` | file table | Later | 可用于去重，但扫描成本高。 |
| 多文件版本 | video file/version table | none | Drop | 用户决定不支持同一番号多文件版本。 |

### Video People And Categories

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 演员列表 | `video_actress` | relation table | Keep | 当前已有。 |
| 视频标签/类别 | `video_tag` | relation table | Keep | 当前已有。 |
| 手动标签 vs 刮削标签来源 | tag source/type | `tags` or relation table | Keep | 用户决定要区分手动标签和刮削标签。 |
| 导演 | `videos.director` | `videos` | Keep | 保持为 `videos` 上的文本字段。 |
| 系列 | `videos.series` | `videos` | Keep | 保持为 `videos` 上的文本字段。 |
| 片商/工作室 | migrate to `videos.maker` | `videos` | Keep | 片商与制作商视为同一概念，目标字段使用 `maker`。 |
| 制作商 | `videos.maker` | `videos` | Keep | 作为 `videos` 上的文本字段。 |
| 发行商/厂牌 | `videos.publisher` | `videos` | Keep | 作为 `videos` 上的文本字段。 |

### Video Assets

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 主封面 | `videos.cover_path` | `videos` shortcut | Keep | 当前已有。 |
| 封面来源 URL | `remote_url` | `video_assets` | Keep | 下载到本地后仍可保留来源 URL 作为来源信息。 |
| 海报/封面变体 | `type = poster/cover` | `video_assets` | Keep | 多图不适合塞主表，资源下载到本地。 |
| 样张截图 | `type = sample` | `video_assets` | Keep | 下载到本地 asset 缓存，多张有顺序。 |
| 预告片 URL/缓存 | `type = trailer` | `video_assets` | Keep | 预告片下载到本地 asset 缓存。 |
| 资源宽高 | `width`, `height` | `video_assets` | Later | 对瀑布流/预览布局有帮助。 |
| 资源排序 | `position` | `video_assets` | Keep | 样张、图库需要。 |

### Video External Source And Public Stats

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 来源站点 | `source` | `video_external_ids` | TBD | JavDB/JavLibrary 等。 |
| 来源页面 URL | `url` | `video_external_ids` | TBD | 支持重刮削。 |
| 来源外部 ID | `external_id` | `video_external_ids` | TBD | 比标题/番号更稳定时使用。 |
| 来源显示番号 | `external_code` | `video_external_ids` | TBD | 站点自己的 code。 |
| 来源标题快照 | `title` | `video_external_ids` | TBD | 多来源对照。 |
| 站点平均评分 | `rating_average` | `video_external_stats` | Keep | 需要长期缓存，按来源分别保存。 |
| 站点评价人数 | `rating_count` | `video_external_stats` | Keep | 需要长期缓存，按来源分别保存。 |
| 想看人数 | `want_count` | none | Drop | 用户决定不保存站点热度计数。 |
| 看过人数 | `watched_count` | none | Drop | 用户决定不保存站点热度计数。 |
| 拥有/收藏人数 | `owned_count` | none | Drop | 用户决定不保存站点热度计数。 |
| 来源抓取时间 | `fetched_at` | source/stat table | Keep | 判断来源数据新鲜度。 |

### Local User Video State

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 是否想看 | user video state | none | Drop | 用户决定不保存本地视频状态。 |
| 是否看过 | user video state | none | Drop | 用户决定不保存本地视频状态。 |
| 是否拥有 | user video state | none | Drop | 本地库存在即可表达本地拥有，不另存状态。 |
| 是否收藏 | user video state | none | Drop | 用户决定不保存本地视频状态。 |
| 是否隐藏 | user video state | none | Drop | 用户决定不保存本地视频状态。 |
| 播放进度 | playback table | none | Drop | 用户决定不保存播放进度。 |
| 播放次数 | playback table | none | Drop | 用户决定不保存播放历史统计。 |
| 上次播放时间 | playback table | none | Drop | 用户决定不保存播放历史统计。 |

### Actress Core

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 演员 ID | `actresses.id` | `actresses` | Keep | 内部主键。 |
| 主显示名 | `actresses.main_name` | `actresses` | Keep | 当前唯一。 |
| 性别 | `actresses.gender` | `actresses` | Keep | 当前已有。 |
| 主头像 | `actresses.avatar_path` | `actresses` shortcut | Keep | 当前已有。 |
| 生日 | `birth_date` | `actresses` | Keep | 旧 `birthday` 迁移为 `birth_date`。 |
| 年龄 | computed | not stored | Drop | 不建议存，按生日计算。 |
| 出道日期 | `debut_date` | `actresses` | Keep | 参考页字段。 |
| 身高 | `height_cm` | `actresses` | Keep | 结构化身体信息。 |
| 三围原始文本 | `measurements` | none | Drop | 目标 schema 不保留三围字符串；旧值仅用于迁移解析。 |
| 胸围 | `bust_cm` | `actresses` | Keep | 使用厘米数值字段存储。 |
| 腰围 | `waist_cm` | `actresses` | Keep | 使用厘米数值字段存储。 |
| 臀围 | `hip_cm` | `actresses` | Keep | 使用厘米数值字段存储。 |
| 罩杯 | `cup_size` | `actresses` | Keep | 用户决定保留。 |
| 血型 | `blood_type` | `actresses` | Keep | 参考页字段。 |
| 星座 | `zodiac` | `actresses` or computed | Keep | 可存来源文本，也可按生日算，具体方式作为实现细节。 |
| 国籍 | `nationality` or `country_code` | `actresses` | Keep | 参考页字段，具体用自由文本还是国家码作为实现细节。 |
| 简介 | `profile_summary` | `actresses` | Keep | 参考页字段。 |
| 最后刮削时间 | `last_scraped_at` | `actresses` | Keep | 演员资料新鲜度。 |
| 更新时间 | `updated_at` | `actresses` | Keep | 本地编辑/迁移时间。 |

### Actress Names And Identity

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 普通别名 | `actress_aliases.alias_name` | current alias table | Keep | 当前已有。 |
| 本名/艺名/旧名 | `type` on name row | `actress_names` | Keep | 用户决定使用 typed name 模型。 |
| 日文名/原文名 | `type = native` | `actress_names` | Keep | 用户决定使用 typed name 模型。 |
| 罗马音/英文名 | `type = romaji/english` | `actress_names` | Keep | 用户决定使用 typed name 模型。 |
| 中文名 | `type = zh` | `actress_names` | Keep | 用户决定使用 typed name 模型。 |
| 名称来源站点 | `source` | `actress_names` | Keep | 多来源不一致时有用。 |

### Actress Tags, Assets, Relations

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 演员标签 | `actress_tags` + `actress_tag` | separate tables | Keep | 用户决定单独建演员标签表，不和视频标签共用。 |
| 标签分类 | `category` | `actress_tags` | Keep | 如排名、风格、状态。 |
| 演员写真/图库 | `actress_gallery_assets` | separate table | Keep | 和头像分开保存，多图、有顺序。 |
| 头像来源 URL | avatar-specific source metadata | avatar storage | TBD | 头像和写真分开；是否追踪头像远程 URL 待定。 |
| 相似演员 | `actress_relations` | none | Drop | 用户决定不保存相似演员。 |
| 相似度分数 | `score` | none | Drop | 不保存相似演员，因此不需要相似度。 |

### Actress External Source

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 来源站点 | `source` | none | Drop | 用户决定演员外部 ID/来源映射保持现状，不新增表。 |
| 来源 profile URL | `url` | none | Drop | 用户决定演员外部 ID/来源映射保持现状，不新增表。 |
| 来源外部 ID | `external_id` | none | Drop | 用户决定演员外部 ID/来源映射保持现状，不新增表。 |
| 来源显示名快照 | `display_name` | none | Drop | 用户决定演员外部 ID/来源映射保持现状，不新增表。 |
| 来源抓取时间 | `fetched_at` | none | Drop | 用户决定演员外部 ID/来源映射保持现状，不新增表。 |

### App Settings

| Info | Current / proposed field | Suggested owner | Status | Notes |
| --- | --- | --- | --- | --- |
| 媒体库目录 | `libraryPaths` | `settings.json` | Keep | 当前配置。 |
| 代理地址 | `proxyUrl` | `settings.json` | Keep | 当前配置。 |
| 默认视频刮削器 | `defaultScraper` | `settings.json` | Keep | 当前配置。 |
| 默认演员刮削器 | `defaultActressScraper` | `settings.json` | Keep | 当前配置。 |
| 批量刮削延迟 | `batchDelayMinMs`, `batchDelayMaxMs` | `settings.json` | Keep | 当前配置。 |
| 主题 | `theme` | `settings.json` | Keep | 当前配置。 |
| 资源加密开关 | `assetEncryption` | `settings.json` | Keep | 当前配置。 |

## Requirement Backlog

This section records user requirements before implementation. New items should be added here first.

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| DSO-001 | Summarize current tables, fields, indexes, and relationships into this local file. | Done | Initial baseline document. |
| DSO-002 | Optimize current data structure after the document is complete. | Pending | Wait for detailed requirements and confirmation before code changes. |
| DSO-003 | Compare classic AV detail pages and identify missing video metadata fields. | Done | See `Reference Detail Page Field Gaps`. |
| DSO-004 | Decide which page-derived fields belong directly on `videos` versus separate relation/stat/asset tables. | Done | Direct fields include duration/original title/maker/publisher/freshness; stats/assets use separate tables. |
| DSO-005 | Compare classic actress profile pages and identify missing actress metadata fields. | Done | See `Reference Actress Profile Field Gaps`. |
| DSO-006 | Decide whether to keep simple `actress_aliases` or replace/extend it with typed `actress_names`. | Done | Use typed `actress_names`; existing aliases can be migrated. |
| DSO-007 | List all current candidate information items so the user can prune them. | Done | See `Pruning Inventory`. |
| DSO-008 | Apply first pruning decisions: drop source popularity counters, local user video state, playback history and actress similarity; separate actress avatar from gallery photos. | Done | Reflected in `Pruning Inventory` and `Decisions`. |
| DSO-009 | Store actress measurements as structured numeric fields instead of one string. | Done | Target schema uses `bust_cm`, `waist_cm`, `hip_cm`; legacy `measurements` is dropped after migration. |
| DSO-010 | Resolve remaining high-level schema questions. | Done | See DEC-006 through DEC-019. |

## Candidate Optimization Topics

These are not approved changes yet. They are prompts for discussion.

| Topic | Possible Direction | Tradeoff / Question |
| --- | --- | --- |
| Facets | Keep `series` and `director` as text fields on `videos`; migrate `studio`/片商 concept to `maker`; add `publisher`. | User chose text fields over normalized facet/entity tables. |
| Dates | Standardize `release_date`, `add_time`, and future timestamps. | Need decide string format, timezone policy, and migration validation. |
| Status fields | Add database `CHECK` constraints for `scraped_status`, `rating`, and similar enum-like fields. | Safer data, but migration must handle existing invalid rows if any. |
| Search | Add FTS table for title, code, summary, actress names, tags. | Faster search, but requires sync triggers or service-level maintenance. |
| Pagination | Move large lists from offset pagination to cursor/keyset pagination. | Better for very large libraries, but API and UI state need adjustment. |
| Assets | Add explicit asset table for covers/avatars with type, owner, encryption state, hash, and path. | Better cleanup and migration tracking, but more schema complexity. |
| File identity | Track file hash, inode-like metadata, or last seen time. | Improves moved/deleted file handling, but scan cost may increase. |
| Audit fields | Add `created_at`, `updated_at`, `last_scraped_at`, `last_seen_at`. | Improves sync/debuggability, requires update discipline. |
| Scrape history | Dropped. Keep only latest metadata. | User decided not to store scrape history. |
| Tags | Add source/type so manual tags and scraped tags can be distinguished. | User decided tags must distinguish manual vs scraped origin. |
| Actress identity | Add typed names, but do not add external IDs beyond current behavior. | User decided to use typed names and keep external ID behavior unchanged. |
| Maker / publisher model | Keep `maker` and `publisher` as text fields on `videos`; maker and 片商 are the same concept. | No maker/publisher entity tables. |
| External source mapping | Add `video_external_ids` for source URL/code/id/title snapshots. | Enables reliable re-scrape and multiple source support. |
| Public source rating | Add `video_external_stats` for site average rating and rating count only, stored per source. | Source want/watched/owned counters are dropped. |
| Gallery / trailer assets | Add `video_assets` for sample images, posters and trailer local cache paths. | Assets should be downloaded to local storage; remote URL can be retained as source metadata. |
| Actress structured profile | Add `birth_date`, `debut_date`, `bust_cm`, `waist_cm`, `hip_cm`, cup, blood type, nationality, summary and audit fields. | Better filtering/display; do not keep combined `measurements` as target storage. |
| Actress typed names | Add `actress_names`. | User decided to use typed names for native/romaji/Chinese/former/alias names. |
| Actress profile tags | Add `actress_tags` and `actress_tag`. | User decided actress labels should use separate tables. |
| Actress gallery assets | Add `actress_gallery_assets`; keep avatar separate from gallery photos. | Multiple profile photos do not fit in `avatar_path`; avatar and gallery must not be mixed. |
| Actress similarity | Dropped. Do not add `actress_relations`. | User decided not to store similar actress data. |
| Actress source mapping | Dropped. Keep current behavior and do not add `actress_external_ids`. | User decided external IDs for actresses/facets should remain as-is. |

## Decisions

| ID | Decision | Impact |
| --- | --- | --- |
| DEC-001 | Do not store source want/watched/owned counts. | `video_external_stats` should only keep source rating data such as average rating and rating count, if those are retained. |
| DEC-002 | Do not store local video state such as want, watched, owned, favorite, hidden, playback progress, play count or last played time. | No local user video state table and no playback history table in the target schema. |
| DEC-003 | Do not store similar/related actress data. | Do not create `actress_relations`; remove similar actress fields from the target schema. |
| DEC-004 | Actress avatar and actress gallery/photos must be stored separately. | Keep primary avatar via `actresses.avatar_path`; use a separate gallery/photo structure such as `actress_gallery_assets` for profile photos. |
| DEC-005 | Actress measurements must be stored as structured numeric fields, not a single string. | Use `bust_cm`, `waist_cm`, `hip_cm`; treat current `actresses.measurements` as legacy migration input only. |
| DEC-006 | Keep `series`, `director`, maker and publisher as text fields on `videos`, not normalized entity tables. | Avoid new entity tables for these dimensions. Existing `studio`/片商 concept should map to maker. |
| DEC-007 | Store only the latest metadata, not scrape history. | Do not add scrape attempt/history tables in the target schema. |
| DEC-008 | Distinguish manual tags from scraped tags. | Add source/type/origin information for video tags or tag relations. |
| DEC-009 | Keep external ID behavior for actresses, maker, publisher, series and director as-is. | Do not add new external ID tables for these entities. |
| DEC-010 | Do not support multiple file versions for the same video/code. | Keep one file path per `videos` row; do not add video file/version tables. |
| DEC-011 | Keep app settings in `settings.json`. | Do not migrate settings into SQLite. |
| DEC-012 | Treat maker and 片商 as the same concept; keep maker and publisher as the two production/company fields. | Target fields are `maker` and `publisher`; do not keep a separate label/studio concept beyond migration compatibility. |
| DEC-013 | Store source public rating and rating count long-term, separated by source. | Add/keep `video_external_stats` with `source`, `rating_average`, `rating_count`, `fetched_at`; do not store source popularity counters. |
| DEC-014 | Download sample images, covers/posters and trailers to local asset storage. | `video_assets` should store local cached paths; remote URLs may be retained as source metadata. |
| DEC-015 | Rename actress birthday target field to `birth_date`. | Migrate existing `birthday` into `birth_date`; age remains computed. |
| DEC-016 | Keep `cup_size`. | `actresses.cup_size` is part of the target schema. |
| DEC-017 | Use a typed actress name model. | Add `actress_names` for alias/native/romaji/English/Chinese/former names instead of relying only on simple aliases. |
| DEC-018 | Use separate actress tag tables. | Add `actress_tags` and `actress_tag`; do not share video `tags` for actress profile labels. |
| DEC-019 | Keep video assets and actress gallery assets as separate tables. | Use `video_assets` for video cover/sample/trailer assets and `actress_gallery_assets` for actress photos; avatar remains separate. |
| DEC-020 | Migrate `studio` to `maker` conservatively. | Add `maker` and `publisher`; backfill `maker` from `studio`; new code reads/writes `maker`; keep `studio` as a legacy compatibility column for now. |
| DEC-021 | Store video tag origin on the `video_tag` relation. | Use relation-level origin/source metadata so the same tag can be manual on one video and scraped on another. |
| DEC-022 | Use normalized text dates and UTC timestamps. | Date-only fields use `YYYY-MM-DD`; timestamp fields use ISO 8601 UTC strings. |
| DEC-023 | Add `video_external_ids` for video source mappings only. | Store source, external id/code, URL, title snapshot and fetched time for video re-scrape; do not add external ID tables for actresses or facets. |
| DEC-024 | Keep `remote_url` for downloaded assets. | Store local cached paths for display and retain remote URLs for source tracking/re-download. |
| DEC-025 | Track avatar source separately from gallery photos. | Keep primary avatar on `actresses.avatar_path` and add `avatar_remote_url`; gallery/profile photos remain in `actress_gallery_assets`. |

## Resolved Questions

- Source want/watched/owned counts are dropped.
- Local video state and playback history are dropped.
- Similar actress relations are dropped.
- Actress avatar and actress gallery/photos are separate storage concerns.
- Actress measurements are stored as structured numeric fields; combined `measurements` text is not part of the target schema.
- `series`, `director`, maker and publisher remain text fields on `videos`.
- Only latest metadata is stored; scrape history is out of scope.
- Manual and scraped tags must be distinguishable.
- No new external ID tables for actresses, maker, publisher, series or director.
- Multiple file versions per video/code are out of scope.
- Settings remain in `settings.json`.
- Maker and 片商 are the same concept; keep maker and publisher.
- Source rating average/count is cached per source.
- Video media assets are downloaded to local storage.
- Actress birthday target field is `birth_date`.
- `cup_size` is kept.
- Actress names use typed rows.
- Actress profile tags use separate tables.
- Video assets and actress gallery assets use separate tables.
- `studio` is migrated to `maker` with a legacy compatibility column.
- Video tag origin/source lives on `video_tag`.
- Dates use `YYYY-MM-DD`; timestamps use ISO 8601 UTC.
- `video_external_ids` is added for videos only.
- Downloaded assets retain `remote_url`.
- Actress avatar source uses `avatar_remote_url`, separate from gallery photos.

## Open Questions

No high-level product/data-shape questions remain open after DEC-001 through DEC-025.

Implementation details resolved:

- `nationality` remains a free-text field for now.
- `zodiac` is stored as source text; it can be computed from `birth_date` later if needed.
- Asset `width` / `height` fields are present and nullable; capture can be deferred by scraper/source capability.

## Execution Plan

Implemented in schema version 3.

1. Target schema changes: add video maker/publisher/assets/external source tables, structured actress profile fields, typed actress names, actress tags and gallery asset tables.
2. Migration steps: add nullable columns, recreate `facet_entries` check constraint, backfill `maker` from legacy `studio`, backfill `birth_date` from `birthday`, parse legacy `measurements`, and seed facet/name rows.
3. Repo/service changes: read/write new video and actress fields, preserve manual vs scraped tag origin, persist source rating/external IDs, and delete/remap new asset rows with existing asset lifecycle.
4. Scraper changes: map maker/publisher/duration/source rating fields into the new schema while retaining `studio` only as legacy compatibility.
5. Shared/IPC type changes: expose new video, actress, asset, tag-origin and facet types through shared contracts.
6. Renderer changes: switch facet navigation/querying to maker/publisher/series/director and expose structured actress profile fields in detail/edit views.
7. Verification: run typecheck, migration/repo/service tests, encoding check and production build.
